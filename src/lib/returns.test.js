import { describe, it, expect } from "vitest";
import {
  buildReturn,
  returnableQty,
  canReturn,
  hasReturns,
  isReturn,
  unitPaid,
  creditToUse,
} from "./returns.js";
import {
  recordSaleOp,
  voidSaleOp,
  amendSaleOp,
  returnSaleOp,
  applyStockOp,
  stockByProduct,
} from "./ops.js";
import { dayTotals } from "./dayClose.js";

const orig = {
  id: "s1",
  date: "2026-11-10",
  time: "10:00 am",
  payment: "Cash",
  customer: "Asha",
  billNo: "2026-27/0009",
  total: 1500,
  profit: 600,
  lines: [
    {
      name: "Kurti",
      qty: 3,
      price: 500,
      buyPrice: 300,
      amount: 1500,
      size: "M",
      color: "Red",
      productId: "p1",
      variantId: "v1",
    },
  ],
};
const opts = { id: "r1", date: "2026-11-14", time: "11:00 am", mode: "Cash" };

describe("buildReturn", () => {
  it("creates a negative bill for the returned units and marks them on the original", () => {
    const { ret, lines, refund } = buildReturn(orig, { 0: 1 }, opts);
    expect(refund).toBe(500);
    expect(ret).toMatchObject({
      id: "r1",
      type: "return",
      refOf: "s1",
      refBillNo: "2026-27/0009",
      date: "2026-11-14",
      total: -500,
      profit: -200,
      payment: "Cash",
      customer: "Asha",
    });
    expect(ret.lines).toEqual([
      {
        name: "Kurti",
        price: 500,
        buyPrice: 300,
        size: "M",
        color: "Red",
        productId: "p1",
        variantId: "v1",
        qty: -1,
        amount: -500,
      },
    ]);
    expect(lines[0].returned).toBe(1);
    expect(orig.lines[0].returned).toBeUndefined(); // input untouched
  });
  it("never returns more than is left to return", () => {
    const once = buildReturn(orig, { 0: 2 }, opts);
    const after = { ...orig, lines: once.lines };
    expect(returnableQty(after.lines[0])).toBe(1);
    const twice = buildReturn(after, { 0: 5 }, { ...opts, id: "r2" });
    expect(twice.ret.lines[0].qty).toBe(-1);
    expect(twice.lines[0].returned).toBe(3);
    expect(canReturn({ ...orig, lines: twice.lines })).toBe(false);
    expect(() => buildReturn({ ...orig, lines: twice.lines }, { 0: 1 }, opts)).toThrow();
  });
  it("refunds what was actually paid when the bill had a discount", () => {
    const disc = { ...orig, subtotal: 1500, discount: 150, total: 1350 }; // 10% off
    expect(unitPaid(disc, disc.lines[0])).toBe(450);
    const { ret } = buildReturn(disc, { 0: 2 }, opts);
    expect(ret.total).toBe(-900);
    expect(ret.profit).toBe(-300); // 900 − 2 × 300 cost
  });
  it("helpers", () => {
    const { ret, lines } = buildReturn(orig, { 0: 1 }, opts);
    expect(isReturn(ret)).toBe(true);
    expect(isReturn(orig)).toBe(false);
    expect(canReturn(ret)).toBe(false);
    expect(hasReturns({ ...orig, lines })).toBe(true);
    expect(hasReturns(orig)).toBe(false);
    expect(creditToUse(500, 300)).toBe(300);
    expect(creditToUse(500, 800)).toBe(500);
    expect(creditToUse(0, 800)).toBe(0);
  });
});

describe("returns and stock stay consistent through the outbox ops", () => {
  const product = () => ({
    id: "p1",
    name: "Kurti",
    variants: [{ id: "v1", size: "M", stockQty: 10 }],
  });
  const apply = (p, opId, parts) => {
    const lines = stockByProduct(parts.stock).get("p1");
    return lines ? applyStockOp(p, opId, lines, 1) : p;
  };
  const qty = (p) => p.variants[0].stockQty;

  it("sale −3, return +1: stock ends 2 down; the op also carries both bill changes", () => {
    let p = apply(product(), "a", recordSaleOp(orig));
    expect(qty(p)).toBe(7);
    const { ret, lines } = buildReturn(orig, { 0: 1 }, opts);
    const op = returnSaleOp(orig, ret, lines);
    expect(Object.keys(op.patch).sort()).toEqual(["sales/r1", "sales/s1/lines"]);
    expect(op.stock).toEqual([{ productId: "p1", variantId: "v1", delta: 1 }]);
    p = apply(p, "b", op);
    expect(qty(p)).toBe(8);
  });
  it("deleting the original after a partial return restocks only what is still out", () => {
    const { lines } = buildReturn(orig, { 0: 1 }, opts);
    const after = { ...orig, lines };
    expect(voidSaleOp(after).stock).toEqual([{ productId: "p1", variantId: "v1", delta: 2 }]);
  });
  it("editing the original's quantity after a return accounts for the returned unit", () => {
    const { lines } = buildReturn(orig, { 0: 1 }, opts);
    const after = { ...orig, lines };
    const edited = { ...after, lines: [{ ...after.lines[0], qty: 2 }] }; // 3 → 2 sold, 1 returned
    expect(amendSaleOp(after, edited).stock).toEqual([
      { productId: "p1", variantId: "v1", delta: 1 },
    ]);
  });
  it("ordinary bills (no `returned`, positive qty) behave exactly as before", () => {
    expect(recordSaleOp(orig).stock).toEqual([{ productId: "p1", variantId: "v1", delta: -3 }]);
    expect(voidSaleOp(orig).stock).toEqual([{ productId: "p1", variantId: "v1", delta: 3 }]);
  });
});

describe("returns show as net sales in the day's totals", () => {
  it("a cash refund reduces revenue and cash; a credit note reduces revenue only", () => {
    const D = "2026-11-14";
    const sale = { ...orig, date: D };
    const cashRet = buildReturn(sale, { 0: 1 }, { ...opts, date: D }).ret;
    const creditRet = buildReturn(
      sale,
      { 0: 1 },
      { ...opts, id: "r2", date: D, mode: "Credit" }
    ).ret;
    const t = dayTotals([sale, cashRet, creditRet], [], D);
    expect(t.revenue).toBe(500); // 1,500 − 500 − 500
    expect(t.cashIn).toBe(1000); // 1,500 − 500 refunded in cash
  });
});
