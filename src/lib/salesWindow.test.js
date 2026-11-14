import { describe, it, expect } from "vitest";
import {
  windowStart,
  monthStart,
  prevDay,
  unionSales,
  looksKeyedById,
  monthlyTotals,
  mergeMonthly,
} from "./salesWindow.js";

describe("windowStart", () => {
  it("is the first day of the month N months back (always ≥ ~90 days for N = 3)", () => {
    expect(windowStart("2026-11-14", 3)).toBe("2026-08-01");
    expect(windowStart("2026-11-01", 3)).toBe("2026-08-01");
    expect(windowStart("2026-03-31", 3)).toBe("2025-12-01");
  });
  it("wraps across the year boundary", () => {
    expect(windowStart("2027-01-10", 3)).toBe("2026-10-01");
    expect(windowStart("2027-02-28", 14)).toBe("2025-12-01");
  });
  it("0 or less means no window", () => {
    expect(windowStart("2026-11-14", 0)).toBeNull();
    expect(windowStart("2026-11-14", -1)).toBeNull();
  });
});

describe("date helpers", () => {
  it("monthStart", () => expect(monthStart("2026-08-19")).toBe("2026-08-01"));
  it("prevDay crosses month, year and leap day", () => {
    expect(prevDay("2026-08-01")).toBe("2026-07-31");
    expect(prevDay("2027-01-01")).toBe("2026-12-31");
    expect(prevDay("2028-03-01")).toBe("2028-02-29");
  });
});

describe("unionSales", () => {
  it("merges the three sources; live data beats a static older copy", () => {
    const u = unionSales({
      older: { a: { id: "a", total: 1 }, b: { id: "b", total: 1 } },
      udhari: { b: { id: "b", total: 2 }, c: { id: "c", total: 2 } },
      recent: { c: { id: "c", total: 3 }, d: { id: "d", total: 3 } },
    });
    expect(u).toEqual({
      a: { id: "a", total: 1 },
      b: { id: "b", total: 2 },
      c: { id: "c", total: 3 },
      d: { id: "d", total: 3 },
    });
  });
  it("tolerates missing sources", () => expect(unionSales({})).toEqual({}));
});

describe("looksKeyedById", () => {
  it("accepts empty and properly keyed data", () => {
    expect(looksKeyedById(null)).toBe(true);
    expect(looksKeyedById({ a: { id: "a" }, 7: { id: 7 } })).toBe(true);
  });
  it("rejects legacy arrays, numeric keys and junk nodes", () => {
    expect(looksKeyedById([{ id: "a" }])).toBe(false);
    expect(looksKeyedById({ 0: { id: "a" } })).toBe(false);
    expect(looksKeyedById({ a: { paid: 5 } })).toBe(false);
  });
});

describe("monthly totals", () => {
  const sales = [
    { id: "1", date: "2026-05-03", total: 100, profit: 40 },
    { id: "2", date: "2026-05-20", total: 50, profit: 10 },
    { id: "3", date: "2026-09-01", total: 30, profit: 5 },
    { id: "4", total: 999 }, // no date → ignored
  ];
  it("sums revenue, profit and bill count per month (array or map)", () => {
    const want = {
      "2026-05": { revenue: 150, profit: 50, bills: 2 },
      "2026-09": { revenue: 30, profit: 5, bills: 1 },
    };
    expect(monthlyTotals(sales)).toEqual(want);
    expect(monthlyTotals({ x: sales[0], y: sales[1], z: sales[2] })).toEqual(want);
  });
  it("mergeMonthly: loaded months from sales, earlier months from the saved summary", () => {
    const older = { "2026-05": { revenue: 7000, profit: 2000, bills: 70 } };
    const out = mergeMonthly(["2026-05", "2026-06", "2026-09"], sales, older, "2026-08-01");
    expect(out["2026-05"]).toEqual(older["2026-05"]); // before the window → summary
    expect(out["2026-06"]).toEqual({ revenue: 0, profit: 0, bills: 0 });
    expect(out["2026-09"]).toEqual({ revenue: 30, profit: 5, bills: 1 });
  });
  it("mergeMonthly: with everything loaded (coverFrom null) the summary is not used", () => {
    const out = mergeMonthly(
      ["2026-05"],
      sales,
      { "2026-05": { revenue: 1, profit: 1, bills: 1 } },
      null
    );
    expect(out["2026-05"]).toEqual({ revenue: 150, profit: 50, bills: 2 });
  });
});
