import { describe, it, expect, vi } from "vitest";

// sync.js imports `db` from ./firebase.js (which would spin up the real Firebase SDK)
// and live functions from firebase/database. The logic under test here is pure, so we
// stub both — the tests never touch the network.
vi.mock("./firebase.js", () => ({ db: {} }));
vi.mock("firebase/database", () => ({
  ref: vi.fn(),
  onValue: vi.fn(),
  set: vi.fn(),
  update: vi.fn(),
}));

const { toMap, mapToArray, isLegacyShape, buildSliceUpdate, mergeRemote, sanitize } =
  await import("./sync.js");

describe("toMap", () => {
  it("returns {} for null/undefined", () => {
    expect(toMap(null)).toEqual({});
    expect(toMap(undefined)).toEqual({});
  });

  it("keys a legacy array by record id (as a string)", () => {
    expect(
      toMap([
        { id: 7, name: "A" },
        { id: "x", name: "B" },
      ])
    ).toEqual({
      7: { id: 7, name: "A" },
      x: { id: "x", name: "B" },
    });
  });

  it("re-keys an object by the record's own id, not the wrapper key", () => {
    expect(toMap({ 0: { id: "a", n: 1 }, 1: { id: "b", n: 2 } })).toEqual({
      a: { id: "a", n: 1 },
      b: { id: "b", n: 2 },
    });
  });

  it("drops entries without an id", () => {
    expect(toMap([{ name: "no id" }, null, { id: "ok" }])).toEqual({ ok: { id: "ok" } });
  });
});

describe("mapToArray", () => {
  it("sorts items by name", () => {
    const map = { 2: { id: "2", name: "Banana" }, 1: { id: "1", name: "Apple" } };
    expect(mapToArray("items", map).map((i) => i.name)).toEqual(["Apple", "Banana"]);
  });

  it("sorts sales by date then id", () => {
    const map = {
      b: { id: "b", date: "2026-01-02" },
      a: { id: "a", date: "2026-01-01" },
      c: { id: "c", date: "2026-01-02" },
    };
    expect(mapToArray("sales", map).map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("returns logs newest-first by `at`", () => {
    const map = { a: { id: "a", at: 100 }, b: { id: "b", at: 300 }, c: { id: "c", at: 200 } };
    expect(mapToArray("logs", map).map((l) => l.id)).toEqual(["b", "c", "a"]);
  });
});

describe("isLegacyShape", () => {
  it("is false for empty/null", () => {
    expect(isLegacyShape(null, {})).toBe(false);
  });

  it("is true for a stored array (legacy)", () => {
    const arr = [{ id: "a" }];
    expect(isLegacyShape(arr, toMap(arr))).toBe(true);
  });

  it("is true when stored keys are not the record ids (numeric-indexed)", () => {
    const val = { 0: { id: "a" }, 1: { id: "b" } };
    expect(isLegacyShape(val, toMap(val))).toBe(true);
  });

  it("is false when already keyed by id", () => {
    const val = { a: { id: "a" }, b: { id: "b" } };
    expect(isLegacyShape(val, toMap(val))).toBe(false);
  });
});

describe("buildSliceUpdate", () => {
  it("writes a whole node for a brand-new record", () => {
    const { updates, changed } = buildSliceUpdate({}, [{ id: "a", name: "X" }]);
    expect(changed).toBe(true);
    expect(updates).toEqual({ a: { id: "a", name: "X" } });
  });

  it("writes only the changed field of an existing record", () => {
    const prev = { a: { id: "a", name: "X", stock: 1 } };
    const { updates } = buildSliceUpdate(prev, [{ id: "a", name: "X", stock: 5 }]);
    expect(updates).toEqual({ "a/stock": 5 });
  });

  it("nulls a field removed locally", () => {
    const prev = { a: { id: "a", name: "X", note: "hi" } };
    const { updates } = buildSliceUpdate(prev, [{ id: "a", name: "X" }]);
    expect(updates).toEqual({ "a/note": null });
  });

  it("nulls a whole record deleted locally", () => {
    const prev = { a: { id: "a" }, b: { id: "b" } };
    const { updates } = buildSliceUpdate(prev, [{ id: "a" }]);
    expect(updates).toEqual({ b: null });
  });

  it("reports no change when nothing differs (loop-safe echo)", () => {
    const prev = { a: { id: "a", name: "X" } };
    const { changed, updates } = buildSliceUpdate(prev, [{ id: "a", name: "X" }]);
    expect(changed).toBe(false);
    expect(updates).toEqual({});
  });

  it("skips records with no id", () => {
    const { updates, changed } = buildSliceUpdate({}, [{ name: "no id" }]);
    expect(changed).toBe(false);
    expect(updates).toEqual({});
  });
});

describe("mergeRemote (3-way)", () => {
  it("accepts a remote-added record", () => {
    const result = mergeRemote({}, { a: { id: "a" } }, {});
    expect(result).toEqual({ a: { id: "a" } });
  });

  it("preserves a local-only add not yet in the cloud", () => {
    const base = {};
    const theirs = {};
    const ours = { a: { id: "a", name: "local" } };
    expect(mergeRemote(base, theirs, ours)).toEqual({ a: { id: "a", name: "local" } });
  });

  it("lets the cloud win when both added the same id", () => {
    const base = {};
    const theirs = { a: { id: "a", name: "remote" } };
    const ours = { a: { id: "a", name: "local" } };
    expect(mergeRemote(base, theirs, ours).a.name).toBe("remote");
  });

  it("respects a remote deletion", () => {
    const base = { a: { id: "a" } };
    const theirs = {}; // remote deleted it
    const ours = { a: { id: "a" } };
    expect(mergeRemote(base, theirs, ours)).toEqual({});
  });

  it("applies a local field edit on top of the remote record", () => {
    const base = { a: { id: "a", stock: 1, name: "X" } };
    const theirs = { a: { id: "a", stock: 1, name: "X" } };
    const ours = { a: { id: "a", stock: 9, name: "X" } }; // edited stock locally
    expect(mergeRemote(base, theirs, ours).a).toEqual({ id: "a", stock: 9, name: "X" });
  });

  it("merges a local edit with a remote edit on a different field", () => {
    const base = { a: { id: "a", stock: 1, name: "X" } };
    const theirs = { a: { id: "a", stock: 1, name: "Renamed" } }; // remote changed name
    const ours = { a: { id: "a", stock: 9, name: "X" } }; // we changed stock
    expect(mergeRemote(base, theirs, ours).a).toEqual({ id: "a", stock: 9, name: "Renamed" });
  });

  it("honours a local deletion when the cloud record is unchanged", () => {
    const base = { a: { id: "a", n: 1 } };
    const theirs = { a: { id: "a", n: 1 } };
    const ours = {}; // deleted locally
    expect(mergeRemote(base, theirs, ours)).toEqual({});
  });

  it("keeps a record the cloud changed even though we deleted it locally", () => {
    const base = { a: { id: "a", n: 1 } };
    const theirs = { a: { id: "a", n: 2 } }; // cloud changed it meanwhile
    const ours = {}; // deleted locally
    expect(mergeRemote(base, theirs, ours)).toEqual({ a: { id: "a", n: 2 } });
  });

  it("removes a field deleted locally from the merged record", () => {
    const base = { a: { id: "a", note: "x", n: 1 } };
    const theirs = { a: { id: "a", note: "x", n: 1 } };
    const ours = { a: { id: "a", n: 1 } }; // note removed locally
    expect(mergeRemote(base, theirs, ours).a).toEqual({ id: "a", n: 1 });
  });
});

describe("sanitize", () => {
  it("drops undefined and deep-clones", () => {
    const src = { a: 1, b: undefined, c: { d: 2 } };
    const out = sanitize(src);
    expect(out).toEqual({ a: 1, c: { d: 2 } });
    expect(out.c).not.toBe(src.c);
  });

  it("maps null/undefined input to null", () => {
    expect(sanitize(undefined)).toBe(null);
  });
});
