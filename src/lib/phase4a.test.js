import { describe, it, expect } from "vitest";
import { dayTotals, expectedCash, udhariReceipts, closeSummaryText } from "./dayClose.js";
import { backupStatus } from "./backupReminder.js";
import { customerLedger, reminderText, customerKey } from "./customers.js";
import { restockSuggestions, soldByVariant, fastSizes } from "./restock.js";

const D = "2026-11-14";
const sales = [
  { id: "1", date: D, payment: "Cash", total: 500 },
  { id: "2", date: D, payment: "UPI", total: 1200 },
  {
    id: "3",
    date: D,
    payment: "Udhari",
    total: 1000,
    paid: 300,
    paidMode: "UPI",
    customer: "Sunita",
    mobile: "9876543210",
  },
  // old credit bill: 100 at billing, then 400 repaid TODAY in cash
  {
    id: "4",
    date: "2026-10-01",
    payment: "Udhari",
    total: 900,
    paid: 500,
    paidMode: "Cash",
    customer: "sunita ",
    payments: [{ date: D, amount: 400, mode: "Cash" }],
  },
  { id: "5", date: "2026-11-13", payment: "Cash", total: 9999 },
  { id: "6", date: D, payment: "Cash", total: 800, creditUsed: 300 }, // exchange: only 500 cash
];
const expenses = [
  { date: D, amount: 150 },
  { date: "2026-11-13", amount: 70 },
];

describe("day close", () => {
  it("udhariReceipts splits the at-billing part from later repayments", () => {
    expect(udhariReceipts(sales[2])).toEqual([{ date: D, amount: 300, mode: "UPI" }]);
    expect(udhariReceipts(sales[3])).toEqual([
      { date: "2026-10-01", amount: 100, mode: "Cash" },
      { date: D, amount: 400, mode: "Cash" },
    ]);
    expect(udhariReceipts({ payment: "Udhari", total: 50 })).toEqual([]);
  });
  it("totals the day by payment mode, including credit collected today", () => {
    const t = dayTotals(sales, expenses, D);
    expect(t).toMatchObject({
      bills: 4,
      revenue: 3500,
      cashSales: 1000, // 500 + (800 − 300 credit)
      upiSales: 1200,
      udhariBilled: 1000,
      udhariCashIn: 400,
      udhariUpiIn: 300,
      creditUsed: 300,
      expenses: 150,
      cashIn: 1400,
      upiIn: 1500,
    });
  });
  it("expected cash = opening + cash in − expenses", () => {
    const t = dayTotals(sales, expenses, D);
    expect(expectedCash(t, { opening: 1000 })).toBe(2250);
    expect(expectedCash(t, { opening: 1000, expensesFromDrawer: false })).toBe(2400);
  });
  it("an empty day is all zeros", () => {
    expect(dayTotals([], [], D)).toMatchObject({
      bills: 0,
      revenue: 0,
      cashIn: 0,
      upiIn: 0,
      expenses: 0,
    });
  });
  it("summary text says whether the cash matches", () => {
    const t = dayTotals(sales, expenses, D);
    const money = (n) => "₹" + n;
    expect(
      closeSummaryText(t, { expected: 2250, counted: 2250 }, { shop: "Shop", money })
    ).toContain("Cash matches");
    expect(closeSummaryText(t, { expected: 2250, counted: 2200 }, { money })).toContain(
      "Short by ₹50"
    );
    expect(closeSummaryText(t, { expected: 2250, counted: 2300 }, { money })).toContain(
      "Over by ₹50"
    );
  });
});

describe("backup reminder", () => {
  const now = Date.UTC(2026, 10, 14, 12);
  const day = 86400000;
  it("never backed up is due", () =>
    expect(backupStatus(null, now)).toMatchObject({ due: true, text: "Last backup: never" }));
  it("counts whole days", () => {
    expect(backupStatus(now - 1000, now)).toMatchObject({
      days: 0,
      due: false,
      text: "Last backup: today",
    });
    expect(backupStatus(now - day, now).text).toBe("Last backup: yesterday");
    expect(backupStatus(now - 6 * day, now)).toMatchObject({ days: 6, due: false });
    expect(backupStatus(now - 7 * day, now)).toMatchObject({
      days: 7,
      due: true,
      text: "Last backup: 7 days ago",
    });
  });
});

describe("customer ledger", () => {
  it("groups bills by name (case / spacing-insensitive) and sums outstanding", () => {
    const [c, ...rest] = customerLedger(sales);
    expect(rest).toEqual([]);
    expect(c).toMatchObject({
      key: "sunita",
      name: "Sunita",
      mobile: "9876543210",
      bills: 2,
      total: 1900,
      outstanding: 1100,
      lastDate: D,
    });
    expect(c.sales.map((s) => s.id)).toEqual(["3", "4"]);
    expect(customerKey("  Sunita   Devi ")).toBe("sunita devi");
  });
  it("orders by outstanding, then recency; ignores unnamed bills", () => {
    const list = customerLedger([
      { id: "a", date: "2026-11-01", customer: "Asha", payment: "Cash", total: 100 },
      { id: "b", date: "2026-11-02", customer: "Bina", payment: "Udhari", total: 100, paid: 0 },
      { id: "c", date: "2026-11-03", customer: "Chitra", payment: "UPI", total: 100 },
      { id: "d", date: "2026-11-04", payment: "Cash", total: 100 },
    ]);
    expect(list.map((c) => c.name)).toEqual(["Bina", "Chitra", "Asha"]);
  });
  it("writes a payment reminder", () => {
    const [c] = customerLedger(sales);
    const text = reminderText(c, { shop: "Vijay Shop", upiId: "shop@upi", money: (n) => "₹" + n });
    expect(text).toContain("Namaste Sunita");
    expect(text).toContain("*₹1100* (2 bills, oldest 2026-10-01)");
    expect(text).toContain("UPI: shop@upi");
  });
});

describe("restock suggestions", () => {
  const items = [
    {
      id: "p1",
      name: "Kurti",
      variants: [
        { id: "m", size: "M", color: "Red", stockQty: 3, lowAt: 2 },
        { id: "l", size: "L", color: "Red", stockQty: 40, lowAt: 2 },
        { id: "xl", size: "XL", color: "Red", stockQty: 1, lowAt: 2 }, // low, never sold
        { id: "s", size: "S", color: "Red", stockQty: 10, lowAt: 2 }, // healthy, never sold → not listed
      ],
    },
  ];
  const line = (variantId, qty, size) => ({ name: "Kurti", productId: "p1", variantId, qty, size });
  const rs = [
    { date: "2026-11-10", lines: [line("m", 20, "M"), line("l", 2, "L")] },
    { date: "2026-11-14", lines: [line("m", 10, "M"), { name: "Bag", qty: 5, misc: true }] },
    { date: "2026-11-12", lines: [line("m", -3, "M")] }, // a return nets off
    { date: "2026-09-01", lines: [line("m", 500, "M")] }, // outside the window
  ];
  it("counts units sold per variant inside the window only", () => {
    const m = soldByVariant(rs, D, 30);
    expect(m.get("p1|m")).toBe(27);
    expect(m.get("p1|l")).toBe(2);
  });
  it("computes rate, days of stock left and a suggested order; most urgent first", () => {
    const rows = restockSuggestions(items, rs, D, { days: 30, cover: 30 });
    expect(rows.map((r) => r.size)).toEqual(["M", "L", "XL"]);
    expect(rows[0]).toMatchObject({
      sold: 27,
      perDay: 0.9,
      daysLeft: 3.3,
      suggest: 24,
      fast: true,
    });
    expect(rows[1]).toMatchObject({ sold: 2, daysLeft: 600, suggest: 0, fast: false });
    expect(rows[2]).toMatchObject({ sold: 0, daysLeft: null, suggest: 0, low: true });
  });
  it("ranks sizes by units sold", () => {
    expect(fastSizes(rs, D, 30)).toEqual([
      { size: "M", qty: 27 },
      { size: "L", qty: 2 },
    ]);
  });
});
