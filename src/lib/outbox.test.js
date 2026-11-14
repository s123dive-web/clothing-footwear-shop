import { describe, it, expect, vi } from "vitest";
import { createOutbox } from "./outbox.js";
import { memoryBackend, journal } from "./localdb.js";
import { applyStockOp, stockByProduct, applyPatchToMap } from "./ops.js";

// A tiny stand-in for the server: `patch` writes are absolute sets into `sales`, `stock` deltas
// go through the same ledger-guarded transaction body the real app uses (applyStockOp).
function fakeServer() {
  const state = {
    sales: {},
    items: {
      p1: { id: "p1", name: "Kurti", sellingPrice: 500, variants: [{ id: "v1", stockQty: 10 }] },
    },
    sends: [],
  };
  const apply = (op) => {
    state.sends.push(op.id);
    state.sales = applyPatchToMap("sales", state.sales, op.patch);
    for (const [pid, lines] of stockByProduct(op.stock)) {
      const next = applyStockOp(state.items[pid], op.id, lines, 1000, "2026-01-01");
      if (next !== undefined) state.items[pid] = next;
    }
  };
  return { state, apply };
}
const stockOf = (srv) => srv.state.items.p1.variants[0].stockQty;
const saleOp = (n) => ({
  id: "op" + n,
  patch: { ["sales/s" + n]: { id: "s" + n, total: 100 * n } },
  stock: [{ productId: "p1", variantId: "v1", delta: -1 }],
});
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("outbox", () => {
  it("persists an op before sending it, and removes it only on server ack", async () => {
    const store = memoryBackend();
    const order = [];
    const putOp = store.putOp.bind(store);
    store.putOp = async (op) => {
      await putOp(op);
      order.push("persist:" + op.id);
    };
    let ack;
    const send = vi.fn((op) => {
      order.push("send:" + op.id);
      return new Promise((r) => (ack = r));
    });
    const ob = createOutbox({ store, send });
    await ob.start();
    ob.enqueue(saleOp(1));
    expect(ob.pending().map((o) => o.id)).toEqual(["op1"]); // visible synchronously
    await ob.settled();
    expect(order).toEqual(["persist:op1", "send:op1"]); // write-ahead
    expect((await store.loadOutbox()).map((o) => o.id)).toEqual(["op1"]); // still queued: no ack

    ack();
    await tick();
    expect(ob.pending()).toEqual([]);
    expect(await store.loadOutbox()).toEqual([]);
  });

  it("issues ops in the order they were enqueued", async () => {
    const store = memoryBackend();
    const sent = [];
    const ob = createOutbox({ store, send: async (op) => void sent.push(op.id) });
    await ob.start();
    ob.enqueue(saleOp(1));
    ob.enqueue(saleOp(2));
    ob.enqueue(saleOp(3));
    await ob.settled();
    expect(sent).toEqual(["op1", "op2", "op3"]);
  });

  it("replays what a previous session left behind, oldest first", async () => {
    const store = memoryBackend();
    // Session 1: offline — sends never resolve; then the tab dies.
    const a = createOutbox({ store, send: () => new Promise(() => {}) });
    await a.start();
    a.enqueue(saleOp(1));
    a.enqueue(saleOp(2));
    await a.settled();
    a.stop();

    // Session 2: online.
    const srv = fakeServer();
    const b = createOutbox({ store, send: async (op) => srv.apply(op) });
    const pending = await b.start();
    expect(pending.map((o) => o.id)).toEqual(["op1", "op2"]); // available before the first merge
    await b.settled();
    await tick();
    expect(Object.keys(srv.state.sales)).toEqual(["s1", "s2"]);
    expect(stockOf(srv)).toBe(8);
    expect(await store.loadOutbox()).toEqual([]);
  });

  it("is idempotent: replaying an op the server already applied changes nothing", async () => {
    const store = memoryBackend();
    const srv = fakeServer();
    // Session 1: the server APPLIES the op but the ack never arrives (connection dropped).
    const a = createOutbox({
      store,
      send: (op) => {
        srv.apply(op);
        return new Promise(() => {});
      },
    });
    await a.start();
    a.enqueue(saleOp(1));
    await a.settled();
    a.stop();
    expect(stockOf(srv)).toBe(9);

    // Session 2 replays it.
    const b = createOutbox({ store, send: async (op) => srv.apply(op) });
    await b.start();
    await b.settled();
    await tick();
    expect(srv.state.sends).toEqual(["op1", "op1"]); // really was sent twice …
    expect(stockOf(srv)).toBe(9); // … but stock was decremented once
    expect(Object.keys(srv.state.sales)).toEqual(["s1"]);
    expect(await store.loadOutbox()).toEqual([]);
  });

  it("survives a crash in the middle of a replay", async () => {
    const store = memoryBackend();
    const a = createOutbox({ store, send: () => new Promise(() => {}) });
    await a.start();
    [1, 2, 3].forEach((n) => a.enqueue(saleOp(n)));
    await a.settled();
    a.stop();

    // Replay #1: op1 is acked, op2 is applied by the server but the ack is lost, op3 is never
    // sent — and then the app is killed.
    const srv = fakeServer();
    const b = createOutbox({
      store,
      send: (op) => {
        if (op.id === "op1") return Promise.resolve(srv.apply(op));
        if (op.id === "op2") srv.apply(op);
        return new Promise(() => {});
      },
    });
    await b.start();
    await b.settled();
    await tick();
    b.stop();
    expect((await store.loadOutbox()).map((o) => o.id)).toEqual(["op2", "op3"]);
    expect(stockOf(srv)).toBe(8);

    // Replay #2 finishes the job without double-applying op2.
    const c = createOutbox({ store, send: async (op) => srv.apply(op) });
    await c.start();
    await c.settled();
    await tick();
    expect(Object.keys(srv.state.sales).sort()).toEqual(["s1", "s2", "s3"]);
    expect(stockOf(srv)).toBe(7);
    expect(await store.loadOutbox()).toEqual([]);
  });

  it("keeps a failed op queued, reports it, and retries with backoff", async () => {
    const store = memoryBackend();
    const timers = [];
    let fail = true;
    const errors = [];
    const send = vi.fn(async () => {
      if (fail) throw Object.assign(new Error("denied"), { code: "PERMISSION_DENIED" });
    });
    const ob = createOutbox({
      store,
      send,
      onError: (op, err) => errors.push([op.id, err.code]),
      setTimer: (fn, ms) => timers.push({ fn, ms }) && timers.length,
      clearTimer: () => {},
      backoff: [10, 20],
    });
    await ob.start();
    ob.enqueue(saleOp(1));
    await ob.settled();
    await tick();
    expect(errors).toEqual([["op1", "PERMISSION_DENIED"]]);
    expect(ob.pending()[0]).toMatchObject({ id: "op1", attempts: 1, error: "PERMISSION_DENIED" });
    expect(ob.failed().map((o) => o.id)).toEqual(["op1"]);
    expect((await store.loadOutbox()).map((o) => o.id)).toEqual(["op1"]); // never dropped
    expect(timers[0].ms).toBe(10);

    fail = false;
    timers[0].fn(); // backoff timer fires
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(ob.pending()).toEqual([]);
    expect(await store.loadOutbox()).toEqual([]);
  });

  it("retryNow re-sends failed ops immediately and never double-sends one in flight", async () => {
    const store = memoryBackend();
    let mode = "fail";
    const send = vi.fn(() =>
      mode === "fail" ? Promise.reject(new Error("x")) : new Promise(() => {})
    );
    const ob = createOutbox({ store, send, setTimer: () => 1, clearTimer: () => {} });
    await ob.start();
    ob.enqueue(saleOp(1));
    await ob.settled();
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    mode = "hang";
    ob.retryNow();
    ob.retryNow(); // already in flight → ignored
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("still sends when the op cannot be persisted", async () => {
    const store = memoryBackend();
    store.putOp = async () => {
      throw new Error("disk full");
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const sent = [];
    const ob = createOutbox({ store, send: async (op) => void sent.push(op.id) });
    await ob.start();
    ob.enqueue(saleOp(1));
    await ob.settled();
    expect(sent).toEqual(["op1"]);
    err.mockRestore();
  });

  it("tells the listener about every change to the pending list", async () => {
    const store = memoryBackend();
    const counts = [];
    const ob = createOutbox({
      store,
      send: async () => {},
      onChange: (ops) => counts.push(ops.length),
    });
    await ob.start();
    ob.enqueue(saleOp(1));
    await ob.settled();
    await tick();
    expect(counts).toEqual([0, 1, 0]);
  });

  describe("journal: the instant between saving a bill and IndexedDB committing it", () => {
    // A store whose IndexedDB write never finishes — as when the tab is reloaded or killed a
    // few milliseconds after the sale — but with a working synchronous journal.
    const storage = () => {
      const m = new Map();
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
      };
    };

    it("an op journalled but never persisted is recovered and delivered on the next start", async () => {
      const ls = storage();
      const idb = memoryBackend();
      const dying = { ...idb, ...journal(ls), putOp: () => new Promise(() => {}) };
      const a = createOutbox({ store: dying, send: () => new Promise(() => {}) });
      await a.start();
      a.enqueue(saleOp(1));
      a.enqueue(saleOp(2));
      a.stop(); // tab dies: nothing reached IndexedDB
      expect(await idb.loadOutbox()).toEqual([]);

      const srv = fakeServer();
      const next = { ...idb, ...journal(ls) };
      const b = createOutbox({ store: next, send: async (op) => srv.apply(op) });
      const pending = await b.start();
      expect(pending.map((o) => o.id)).toEqual(["op1", "op2"]);
      await b.settled();
      await tick();
      expect(Object.keys(srv.state.sales)).toEqual(["s1", "s2"]);
      expect(stockOf(srv)).toBe(8);
      expect(journal(ls).journalLoad()).toEqual([]);
      expect(await idb.loadOutbox()).toEqual([]);
    });

    it("the journal entry is dropped as soon as IndexedDB has the op", async () => {
      const ls = storage();
      const store = { ...memoryBackend(), ...journal(ls) };
      const ob = createOutbox({ store, send: () => new Promise(() => {}) });
      await ob.start();
      ob.enqueue(saleOp(1));
      expect(
        journal(ls)
          .journalLoad()
          .map((o) => o.id)
      ).toEqual(["op1"]); // synchronously there
      await ob.settled();
      expect(journal(ls).journalLoad()).toEqual([]);
      expect((await store.loadOutbox()).map((o) => o.id)).toEqual(["op1"]);
    });

    it("an op present in both places is replayed once, not twice", async () => {
      const ls = storage();
      const idb = memoryBackend();
      await idb.putOp({ ...saleOp(1), seq: 1 });
      journal(ls).journalAdd({ ...saleOp(1), seq: 1 });
      const sent = [];
      const ob = createOutbox({
        store: { ...idb, ...journal(ls) },
        send: async (op) => void sent.push(op.id),
      });
      await ob.start();
      await ob.settled();
      await tick();
      expect(sent).toEqual(["op1"]);
    });

    it("a very large op is not journalled (it would not fit) but is still stored and sent", async () => {
      const ls = storage();
      const store = { ...memoryBackend(), ...journal(ls) };
      const sent = [];
      const ob = createOutbox({ store, send: async (op) => void sent.push(op.id) });
      await ob.start();
      ob.enqueue({ id: "big", patch: { "sales/x": { id: "x", pad: "y".repeat(300_000) } } });
      expect(journal(ls).journalLoad()).toEqual([]);
      await ob.settled();
      expect(sent).toEqual(["big"]);
    });
  });
});
