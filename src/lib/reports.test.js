import { describe, it, expect } from "vitest";
import { salesByCategory, topSizes, inventoryValue, deadStock } from "./stats.js";

const sales = [
  {
    date: "2026-07-01",
    lines: [
      {
        name: "Kurti",
        subcategory: "Kurtis",
        size: "M",
        qty: 2,
        price: 649,
        buyPrice: 380,
        amount: 1298,
      },
      {
        name: "Sandal",
        subcategory: "Sandals",
        size: "6",
        qty: 1,
        price: 499,
        buyPrice: 260,
        amount: 499,
      },
    ],
  },
  {
    date: "2026-07-02",
    lines: [
      {
        name: "Kurti",
        subcategory: "Kurtis",
        size: "L",
        qty: 1,
        price: 649,
        buyPrice: 380,
        amount: 649,
      },
      {
        name: "Kurti",
        subcategory: "Kurtis",
        size: "M",
        qty: 3,
        price: 649,
        buyPrice: 380,
        amount: 1947,
      },
    ],
  },
];

describe("salesByCategory", () => {
  it("rolls revenue / units / profit up by subcategory, biggest first", () => {
    const rows = salesByCategory(sales);
    const kurtis = rows.find((r) => r.name === "Kurtis");
    const sandals = rows.find((r) => r.name === "Sandals");
    expect(kurtis.qty).toBe(6);
    expect(kurtis.revenue).toBe(3894);
    expect(kurtis.profit).toBe((649 - 380) * 6);
    expect(sandals.revenue).toBe(499);
    expect(rows[0].name).toBe("Kurtis"); // sorted by revenue desc
  });
});

describe("topSizes", () => {
  it("ranks sizes by units sold and skips lines with no size", () => {
    const rows = topSizes(sales);
    expect(rows[0]).toMatchObject({ size: "M", qty: 5 }); // 2 + 3
    const l = rows.find((r) => r.size === "L");
    expect(l.qty).toBe(1);
  });
});

describe("inventoryValue (apparel product/variant shape)", () => {
  it("uses purchase/selling price × summed variant stock", () => {
    const items = [
      { purchasePrice: 100, sellingPrice: 200, variants: [{ stockQty: 2 }, { stockQty: 3 }] },
      { purchasePrice: 50, sellingPrice: 90, variants: [{ stockQty: 0 }] },
    ];
    const v = inventoryValue(items);
    expect(v.cost).toBe(500); // 100 * 5
    expect(v.retail).toBe(1000); // 200 * 5
    expect(v.units).toBe(5);
    expect(v.outOfStock).toBe(1);
    expect(v.count).toBe(2);
  });
});

describe("deadStock", () => {
  it("lists in-stock products that never sold, valued at cost", () => {
    const items = [
      { name: "Kurti", purchasePrice: 380, variants: [{ stockQty: 4 }] }, // sold → excluded
      { name: "Dupatta", purchasePrice: 120, subcategory: "Dupattas", variants: [{ stockQty: 5 }] }, // never sold
    ];
    const dead = deadStock(items, sales);
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ name: "Dupatta", stock: 5, value: 600 });
  });
});
