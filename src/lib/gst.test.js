import { describe, it, expect } from "vitest";
import { gstSplit, isGstInvoice } from "./gst.js";

describe("gstSplit (tax-inclusive)", () => {
  it("splits the tax out of the price: ₹1,050 at 5% = ₹1,000 + ₹25 CGST + ₹25 SGST", () => {
    const g = gstSplit({ lines: [{ amount: 1050, gstRate: 5 }] });
    expect(g.rows).toEqual([{ rate: 5, taxable: 1000, cgst: 25, sgst: 25, tax: 50, total: 1050 }]);
    expect(g).toMatchObject({
      taxable: 1000,
      cgst: 25,
      sgst: 25,
      tax: 50,
      total: 1050,
      hasGst: true,
    });
  });
  it("groups lines by rate, highest first, and keeps untaxed lines in a 0% row", () => {
    const g = gstSplit({
      lines: [
        { amount: 1120, gstRate: 12 },
        { amount: 525, gstRate: 5 },
        { amount: 525, gstRate: 5 },
        { amount: 200 },
      ],
    });
    expect(g.rows.map((r) => [r.rate, r.taxable, r.tax])).toEqual([
      [12, 1000, 120],
      [5, 1000, 50],
      [0, 200, 0],
    ]);
    expect(g.total).toBe(2370);
  });
  it("every row adds up exactly, even when the tax is an odd number of paise", () => {
    const g = gstSplit({
      lines: [
        { amount: 999, gstRate: 5 },
        { amount: 333.33, gstRate: 18 },
      ],
    });
    for (const r of g.rows) {
      expect(Math.round((r.taxable + r.cgst + r.sgst) * 100)).toBe(Math.round(r.total * 100));
      expect(Math.round((r.cgst + r.sgst) * 100)).toBe(Math.round(r.tax * 100));
    }
    expect(g.rows[1]).toMatchObject({
      rate: 5,
      taxable: 951.43,
      tax: 47.57,
      cgst: 23.79,
      sgst: 23.78,
    });
  });
  it("spreads a bill discount over the lines before taxing", () => {
    // ₹2,100 of 5% goods with ₹210 off → ₹1,890 paid → ₹1,800 taxable + ₹90 tax
    const g = gstSplit({
      discount: 210,
      lines: [
        { amount: 1050, gstRate: 5 },
        { amount: 1050, gstRate: 5 },
      ],
    });
    expect(g.rows).toEqual([{ rate: 5, taxable: 1800, cgst: 45, sgst: 45, tax: 90, total: 1890 }]);
  });
  it("an old bill with no GST fields has no tax", () => {
    const g = gstSplit({ lines: [{ amount: 500 }, { amount: 300 }] });
    expect(g).toMatchObject({ tax: 0, hasGst: false, total: 800 });
    expect(gstSplit({}).rows).toEqual([]);
  });
});

describe("isGstInvoice", () => {
  const taxed = { lines: [{ amount: 105, gstRate: 5 }] };
  it("needs both a GSTIN and a taxed line", () => {
    expect(isGstInvoice(taxed, { gstin: "27ABCDE1234F1Z5" })).toBe(true);
    expect(isGstInvoice(taxed, { gstin: "  " })).toBe(false);
    expect(isGstInvoice({ lines: [{ amount: 100 }] }, { gstin: "27ABCDE1234F1Z5" })).toBe(false);
  });
});
