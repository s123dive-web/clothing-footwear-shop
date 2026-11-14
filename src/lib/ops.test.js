import { describe, it, expect } from "vitest";
import {
  applyPatchToMap,
  applyOpsToMap,
  applyStockOp,
  pruneLedger,
  stockByProduct,
  overlayPendingStock,
  recordSaleOp,
  amendSaleOp,
  voidSaleOp,
  LEDGER_MAX,
  LEDGER_KEEP_MS,
} from "./ops.js";

const product = (over = {}) => ({
  id: "p1",
  name: "Kurti",
  sellingPrice: 500,
  purchasePrice: 300,
  version: 3,
  variants: [
    { id: "v1", size: "M", color: "Red", stockQty: 5, lowAt: 2 },
    { id: "v2", size: "L", color: "Red", stockQty: 5, lowAt: 2 },
  ],
  ...over,
});
const qty = (p, vid) => p.variants.find((v) => v.id === vid).stockQty;

describe("applyPatchToMap", () => {
  it("adds, replaces and deletes whole records of the slice", () => {
    const map = { a: { id: "a", n: 1 }, b: { id: "b", n: 2 } };
    const out = applyPatchToMap("sales", map, {
      "sales/a": null,
      "sales/b": { id: "b", n: 9 },
      "sales/c": { id: "c", n: 3 },
    });
    expect(out).toEqual({ b: { id: "b", n: 9 }, c: { id: "c", n: 3 } });
    expect(map).toEqual({ a: { id: "a", n: 1 }, b: { id: "b", n: 2 } }); // input untouched
  });

  it("sets and removes single fields without mutating the original record", () => {
    const rec = { id: "a", paid: 100, paidMode: "Cash" };
    const out = applyPatchToMap(
      "sales",
      { a: rec },
      { "sales/a/paid": 300, "sales/a/paidMode": null }
    );
    expect(out.a).toEqual({ id: "a", paid: 300 });
    expect(rec).toEqual({ id: "a", paid: 100, paidMode: "Cash" });
  });

  it("ignores other slices and field patches for records it does not have", () => {
    const map = { a: { id: "a" } };
    expect(applyPatchToMap("sales", map, { "expenses/x": { id: "x" }, "sales/zz/paid": 5 })).toBe(
      map
    );
    expect(applyPatchToMap("sales", map, undefined)).toBe(map);
  });

  it("applyOpsToMap applies ops oldest first (later ops win)", () => {
    const ops = [
      { id: "1", patch: { "sales/a": { id: "a", total: 1 } } },
      { id: "2", patch: { "sales/a/total": 2 } },
      { id: "3", stock: [{ productId: "p", variantId: "v", delta: -1 }] }, // no patch
    ];
    expect(applyOpsToMap("sales", {}, ops)).toEqual({ a: { id: "a", total: 2 } });
  });
});

describe("applyStockOp (idempotent stock transaction body)", () => {
  it("applies the deltas once, bumps the version and records the op in the ledger", () => {
    const next = applyStockOp(
      product(),
      "op1",
      [{ variantId: "v1", delta: -2 }],
      1000,
      "2026-01-02"
    );
    expect(qty(next, "v1")).toBe(3);
    expect(qty(next, "v2")).toBe(5);
    expect(next.stock).toBe(8);
    expect(next.version).toBe(4);
    expect(next.updatedAt).toBe("2026-01-02");
    expect(next.appliedOps).toEqual({ op1: 1000 });
  });

  it("is a no-op the second time the same op arrives", () => {
    const once = applyStockOp(product(), "op1", [{ variantId: "v1", delta: -2 }], 1000);
    expect(applyStockOp(once, "op1", [{ variantId: "v1", delta: -2 }], 2000)).toBeUndefined();
  });

  it("keeps earlier ledger entries when a different op is applied", () => {
    const a = applyStockOp(product(), "op1", [{ variantId: "v1", delta: -1 }], 1000);
    const b = applyStockOp(a, "op2", [{ variantId: "v1", delta: -1 }], 2000);
    expect(qty(b, "v1")).toBe(3);
    expect(b.appliedOps).toEqual({ op1: 1000, op2: 2000 });
  });

  it("leaves a deleted product deleted and never drives stock below zero", () => {
    expect(applyStockOp(null, "op1", [{ variantId: "v1", delta: -1 }], 1)).toBeNull();
    const next = applyStockOp(product(), "op1", [{ variantId: "v1", delta: -99 }], 1);
    expect(qty(next, "v1")).toBe(0);
  });

  it("loads a record written before the ledger existed (no appliedOps)", () => {
    const legacy = product();
    expect(legacy.appliedOps).toBeUndefined();
    expect(applyStockOp(legacy, "op1", [{ variantId: "v2", delta: 1 }], 5).appliedOps).toEqual({
      op1: 5,
    });
  });

  it("prunes only old entries, and only once the ledger is large", () => {
    const now = LEDGER_KEEP_MS * 3;
    const small = { a: 1, b: now };
    expect(pruneLedger(small, now)).toBe(small);
    const big = {};
    for (let i = 0; i <= LEDGER_MAX; i++) big["old" + i] = 1;
    big.fresh = now - 1000;
    expect(pruneLedger(big, now)).toEqual({ fresh: now - 1000 });
  });
});

describe("stockByProduct / overlayPendingStock", () => {
  it("groups lines per product and drops incomplete or zero lines", () => {
    const m = stockByProduct([
      { productId: "p1", variantId: "v1", delta: -1 },
      { productId: "p1", variantId: "v2", delta: -2 },
      { productId: "p2", variantId: "v9", delta: 3 },
      { productId: "p2", variantId: "v9", delta: 0 },
      { variantId: "v1", delta: -1 },
    ]);
    expect([...m.keys()]).toEqual(["p1", "p2"]);
    expect(m.get("p1")).toHaveLength(2);
    expect(m.get("p2")).toEqual([{ variantId: "v9", delta: 3 }]);
  });

  it("shows pending stock changes the cloud record does not reflect yet", () => {
    const items = [product()];
    const ops = [{ id: "op1", stock: [{ productId: "p1", variantId: "v1", delta: -2 }] }];
    const shown = overlayPendingStock(items, ops);
    expect(qty(shown[0], "v1")).toBe(3);
    expect(shown[0].stock).toBe(8);
    expect(qty(items[0], "v1")).toBe(5); // raw data untouched
  });

  it("does not count an op twice once the record's ledger contains it", () => {
    const applied = applyStockOp(product(), "op1", [{ variantId: "v1", delta: -2 }], 1);
    const ops = [{ id: "op1", stock: [{ productId: "p1", variantId: "v1", delta: -2 }] }];
    const shown = overlayPendingStock([applied], ops);
    expect(qty(shown[0], "v1")).toBe(3);
  });

  it("returns the same array when there is nothing to overlay", () => {
    const items = [product()];
    expect(overlayPendingStock(items, [])).toBe(items);
    expect(overlayPendingStock(items, [{ id: "x", patch: { "sales/a": null } }])).toBe(items);
  });
});

describe("sale ops carry the bill change and the stock change together", () => {
  const sale = {
    id: "s1",
    date: "2026-01-02",
    total: 1500,
    lines: [
      { name: "Kurti", qty: 2, productId: "p1", variantId: "v1" },
      { name: "Kurti", qty: 1, productId: "p1", variantId: "v2" },
      { name: "Bag", qty: 4, misc: true },
      { name: "Legacy line", qty: 3 },
    ],
  };

  it("recordSaleOp: writes the bill and removes its quantities from stock", () => {
    const op = recordSaleOp(sale);
    expect(op.patch).toEqual({ "sales/s1": sale });
    expect(op.stock).toEqual([
      { productId: "p1", variantId: "v1", delta: -2 },
      { productId: "p1", variantId: "v2", delta: -1 },
    ]);
  });

  it("voidSaleOp: deletes the bill and puts its quantities back", () => {
    const op = voidSaleOp(sale);
    expect(op.patch).toEqual({ "sales/s1": null });
    expect(op.stock).toEqual([
      { productId: "p1", variantId: "v1", delta: 2 },
      { productId: "p1", variantId: "v2", delta: 1 },
    ]);
  });

  it("amendSaleOp: field-level bill diff + net stock difference only", () => {
    const next = {
      ...sale,
      total: 1000,
      lines: [
        { name: "Kurti", qty: 1, productId: "p1", variantId: "v1" }, // 2 → 1
        { name: "Kurti", qty: 1, productId: "p1", variantId: "v2" }, // unchanged
        { name: "Bag", qty: 4, misc: true },
      ],
    };
    const op = amendSaleOp(sale, next);
    expect(Object.keys(op.patch).sort()).toEqual(["sales/s1/lines", "sales/s1/total"]);
    expect(op.stock).toEqual([{ productId: "p1", variantId: "v1", delta: 1 }]);
  });

  it("amendSaleOp: a removed field becomes a null in the patch; no stock change → no stock", () => {
    const prev = {
      id: "s2",
      payment: "Udhari",
      paid: 100,
      lines: [{ name: "x", qty: 1, misc: true }],
    };
    const next = { id: "s2", payment: "Cash", lines: prev.lines };
    const op = amendSaleOp(prev, next);
    expect(op.patch).toEqual({ "sales/s2/payment": "Cash", "sales/s2/paid": null });
    expect(op.stock).toEqual([]);
  });

  it("record then void nets to zero stock through the ledger-guarded transaction", () => {
    let p = product();
    const rec = recordSaleOp(sale);
    const del = voidSaleOp(sale);
    p = applyStockOp(p, "opA", stockByProduct(rec.stock).get("p1"), 1);
    p = applyStockOp(p, "opB", stockByProduct(del.stock).get("p1"), 2);
    expect(qty(p, "v1")).toBe(5);
    expect(qty(p, "v2")).toBe(5);
  });
});
