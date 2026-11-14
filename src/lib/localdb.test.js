import { describe, it, expect } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { openLocalDb, memoryBackend, createCacheWriter } from "./localdb.js";

const backends = {
  indexedDB: () => openLocalDb({ indexedDB: new IDBFactory(), name: "t" }),
  memory: async () => memoryBackend(),
};

for (const [name, open] of Object.entries(backends)) {
  describe(`local db (${name})`, () => {
    it("stores cache records per slice and removes deleted ones", async () => {
      const db = await open();
      await db.writeCache(
        "sales",
        [
          { id: "a", n: 1 },
          { id: "b", n: 2 },
        ],
        []
      );
      await db.writeCache("items", [{ id: "a", name: "same id, other slice" }], []);
      await db.writeCache("sales", [{ id: "b", n: 3 }], ["a"]);
      const cache = await db.loadCache();
      expect(cache.sales).toEqual([{ id: "b", n: 3 }]);
      expect(cache.items).toEqual([{ id: "a", name: "same id, other slice" }]);
    });

    it("keeps outbox ops in sequence order until they are removed", async () => {
      const db = await open();
      await db.putOp({ id: "z", seq: 2 });
      await db.putOp({ id: "a", seq: 3 });
      await db.putOp({ id: "m", seq: 1 });
      expect((await db.loadOutbox()).map((o) => o.id)).toEqual(["m", "z", "a"]);
      await db.removeOp("z");
      expect((await db.loadOutbox()).map((o) => o.id)).toEqual(["m", "a"]);
    });

    it("has a small key/value store", async () => {
      const db = await open();
      expect(await db.kvGet("k")).toBeUndefined();
      await db.kvSet("k", { v: 1 });
      expect(await db.kvGet("k")).toEqual({ v: 1 });
    });
  });
}

describe("openLocalDb", () => {
  it("persists across re-opening the same database (durable)", async () => {
    const idb = new IDBFactory();
    const a = await openLocalDb({ indexedDB: idb, name: "t" });
    expect(a.durable).toBe(true);
    await a.putOp({ id: "op1", seq: 1, patch: { "sales/s1": { id: "s1" } } });
    await a.writeCache("sales", [{ id: "s1" }], []);
    a.close();
    const b = await openLocalDb({ indexedDB: idb, name: "t" });
    expect((await b.loadOutbox())[0].patch).toEqual({ "sales/s1": { id: "s1" } });
    expect((await b.loadCache()).sales).toEqual([{ id: "s1" }]);
  });

  it("falls back to a memory store when IndexedDB is missing or broken", async () => {
    expect((await openLocalDb({ indexedDB: undefined })).durable).toBe(false);
    const broken = {
      open() {
        throw new Error("SecurityError");
      },
    };
    const err = console.error;
    console.error = () => {};
    expect((await openLocalDb({ indexedDB: broken })).durable).toBe(false);
    console.error = err;
  });
});

describe("createCacheWriter (incremental writes)", () => {
  const spy = () => {
    const db = memoryBackend();
    const calls = [];
    const write = db.writeCache.bind(db);
    db.writeCache = async (slice, puts, deletes) => {
      calls.push({ slice, puts: puts.map((p) => p.id), deletes });
      return write(slice, puts, deletes);
    };
    return { db, calls };
  };

  it("writes only records that are new or changed, and deletes removed ones", async () => {
    const { db, calls } = spy();
    const w = createCacheWriter(db);
    const a = { id: "a", n: 1 };
    const b = { id: "b", n: 1 };
    expect(await w.write("sales", [a, b])).toEqual({ puts: 2, deletes: 0 });
    // same objects → nothing; equal-but-new object → nothing; changed → 1 put; removed → 1 delete
    expect(await w.write("sales", [a, b])).toEqual({ puts: 0, deletes: 0 });
    expect(await w.write("sales", [{ id: "a", n: 1 }, b])).toEqual({ puts: 0, deletes: 0 });
    expect(await w.write("sales", [{ id: "a", n: 2 }])).toEqual({ puts: 1, deletes: 1 });
    expect(calls[calls.length - 1]).toEqual({ slice: "sales", puts: ["a"], deletes: ["b"] });
    expect((await db.loadCache()).sales).toEqual([{ id: "a", n: 2 }]);
  });

  it("prime() marks what is already on disk so the first write is a no-op", async () => {
    const { db } = spy();
    const w = createCacheWriter(db);
    const arr = [{ id: "a", n: 1 }];
    w.prime("sales", arr);
    expect(await w.write("sales", arr)).toEqual({ puts: 0, deletes: 0 });
    expect(await w.write("sales", [])).toEqual({ puts: 0, deletes: 1 });
  });

  it("handles a dataset far beyond the old 5 MB localStorage limit", async () => {
    const db = await openLocalDb({ indexedDB: new IDBFactory(), name: "big" });
    const w = createCacheWriter(db);
    const big = Array.from({ length: 700 }, (_, i) => ({ id: "s" + i, pad: "x".repeat(10_000) }));
    expect(JSON.stringify(big).length).toBeGreaterThan(6_000_000);
    await w.write("sales", big);
    expect((await db.loadCache()).sales).toHaveLength(700);
  });
});
