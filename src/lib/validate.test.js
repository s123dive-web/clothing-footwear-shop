import { describe, it, expect } from "vitest";
import { saleProblems, itemProblems, auditData } from "./validate.js";
import { VALID_SALES, INVALID_SALES, VALID_ITEMS, INVALID_ITEMS } from "./validate.samples.js";

describe("saleProblems", () => {
  it("accepts every shape of bill the app writes", () => {
    for (const s of VALID_SALES) expect(saleProblems(s), JSON.stringify(s)).toEqual([]);
  });
  it("refuses bills with missing or wrongly-typed core fields", () => {
    for (const s of INVALID_SALES)
      expect(saleProblems(s).length, JSON.stringify(s)).toBeGreaterThan(0);
  });
  it("says what is wrong", () => {
    expect(saleProblems({ id: "x", date: "14/11/2026", total: "500" })).toEqual([
      "date is not YYYY-MM-DD",
      "total is not a number",
    ]);
  });
});

describe("itemProblems", () => {
  it("accepts every shape of product the app writes", () => {
    for (const it of VALID_ITEMS) expect(itemProblems(it), JSON.stringify(it)).toEqual([]);
  });
  it("refuses negative or non-numeric stock and prices, and nameless products", () => {
    for (const it of INVALID_ITEMS)
      expect(itemProblems(it).length, JSON.stringify(it)).toBeGreaterThan(0);
  });
});

describe("auditData", () => {
  it("lists only the records with problems", () => {
    const report = auditData({
      items: [...VALID_ITEMS, INVALID_ITEMS[0]],
      sales: [...VALID_SALES, INVALID_SALES[0]],
    });
    expect(report.map((r) => r.slice)).toEqual(["items", "sales"]);
    expect(report[0].problems.length).toBeGreaterThan(0);
  });
  it("is empty for clean data", () =>
    expect(auditData({ items: VALID_ITEMS, sales: VALID_SALES })).toEqual([]));
});
