import { describe, it, expect } from "vitest";
import {
  productStock,
  productLowVariants,
  isProductLow,
  variantLabel,
  applyVariantDelta,
  addVariantStock,
  removeVariantStock,
  normalizeProduct,
  mergeProductGroup,
  buildSeedProducts,
  recomputeStock,
  blankVariant,
} from "./products.js";

const prod = (variants) =>
  normalizeProduct({ id: "p1", name: "Kurti", subcategory: "Kurtis", sellingPrice: 649, variants });

describe("productStock", () => {
  it("sums every variant's stock", () => {
    expect(
      productStock(
        prod([
          { size: "M", stockQty: 3 },
          { size: "L", stockQty: 5 },
        ])
      )
    ).toBe(8);
  });
  it("falls back to a legacy flat stock when there are no variants", () => {
    expect(productStock({ stock: 4 })).toBe(4);
  });
});

describe("low-stock at the variant level", () => {
  it("flags a product when ANY variant is at/below its own threshold", () => {
    const p = prod([
      { size: "M", stockQty: 10, lowAt: 2 },
      { size: "L", stockQty: 1, lowAt: 2 },
    ]);
    expect(isProductLow(p)).toBe(true);
    expect(productLowVariants(p).map((v) => v.size)).toEqual(["L"]);
  });
  it("is not low when all variants are above threshold", () => {
    expect(isProductLow(prod([{ size: "M", stockQty: 10, lowAt: 2 }]))).toBe(false);
  });
});

describe("applyVariantDelta / add / remove", () => {
  const p = prod([
    { id: "v1", size: "M", stockQty: 5 },
    { id: "v2", size: "L", stockQty: 5 },
  ]);
  it("adds and removes stock for the right variant and refreshes the cached total", () => {
    const after = removeVariantStock(p, "v1", 2);
    expect(after.variants.find((v) => v.id === "v1").stockQty).toBe(3);
    expect(after.variants.find((v) => v.id === "v2").stockQty).toBe(5);
    expect(after.stock).toBe(8);
  });
  it("clamps stock at zero (never negative) — the oversell guard", () => {
    expect(removeVariantStock(p, "v1", 99).variants.find((v) => v.id === "v1").stockQty).toBe(0);
  });
  it("composes sequential deltas correctly (mirrors two concurrent sales in one transaction)", () => {
    // Two sales of the same variant, applied one after another, must not lose either decrement.
    let x = applyVariantDelta(p, "v1", -2);
    x = applyVariantDelta(x, "v1", -2);
    expect(x.variants.find((v) => v.id === "v1").stockQty).toBe(1);
  });
  it("addVariantStock always adds (ignores sign)", () => {
    expect(addVariantStock(p, "v2", 3).variants.find((v) => v.id === "v2").stockQty).toBe(8);
  });
});

describe("normalizeProduct", () => {
  it("derives the group from the subcategory and caches total stock", () => {
    const p = normalizeProduct({
      name: "Heels",
      subcategory: "Heels",
      sellingPrice: 799,
      variants: [{ size: "6", stockQty: 2 }],
    });
    expect(p.category).toBe("Footwear");
    expect(p.stock).toBe(2);
    expect(p.version).toBe(1);
  });
  it("maps legacy buyPrice/sellPrice to purchase/selling and defaults MRP", () => {
    const p = normalizeProduct({ name: "X", subcategory: "Tops", buyPrice: 100, sellPrice: 200 });
    expect(p.purchasePrice).toBe(100);
    expect(p.sellingPrice).toBe(200);
    expect(p.mrp).toBe(200);
    expect(Array.isArray(p.variants)).toBe(true);
  });
  it("coerces bad stock/lowAt to non-negative numbers", () => {
    const p = normalizeProduct({
      name: "X",
      subcategory: "Tops",
      variants: [{ size: "M", stockQty: -5, lowAt: "3" }],
    });
    expect(p.variants[0].stockQty).toBe(0);
    expect(p.variants[0].lowAt).toBe(3);
  });
});

describe("mergeProductGroup", () => {
  it("pools variants and keeps the most complete metadata", () => {
    const a = normalizeProduct({
      id: "a",
      name: "Kurti",
      subcategory: "Kurtis",
      sellingPrice: 649,
      createdAt: "2026-01-01",
      variants: [{ size: "M", stockQty: 3 }],
    });
    const b = normalizeProduct({
      id: "b",
      name: "Kurti",
      subcategory: "Kurtis",
      sellingPrice: 649,
      brand: "Biba",
      createdAt: "2026-02-01",
      variants: [{ size: "L", stockQty: 4 }],
    });
    const merged = mergeProductGroup([a, b]);
    expect(merged.id).toBe("a"); // oldest id kept
    expect(merged.brand).toBe("Biba");
    expect(productStock(merged)).toBe(7);
  });
});

describe("buildSeedProducts", () => {
  const seeds = buildSeedProducts("2026-07-04");
  it("creates ~15 products, all at ZERO stock (seed is display-only until restocked)", () => {
    expect(seeds.length).toBeGreaterThanOrEqual(15);
    for (const p of seeds) expect(productStock(p)).toBe(0);
  });
  it("gives every seed product at least one variant and a valid group", () => {
    for (const p of seeds) {
      expect(p.variants.length).toBeGreaterThan(0);
      expect(["Clothing", "Footwear", "Accessories"]).toContain(p.category);
    }
  });
});

describe("variantLabel", () => {
  it("formats size + colour, or a dash when empty", () => {
    expect(variantLabel({ size: "M", color: "Maroon" })).toBe("M · Maroon");
    expect(variantLabel({ size: "", color: "" })).toBe("—");
  });
});

describe("recomputeStock", () => {
  it("stamps the cached total onto the product", () => {
    expect(recomputeStock({ variants: [{ stockQty: 2 }, { stockQty: 3 }] }).stock).toBe(5);
  });
});

describe("blankVariant", () => {
  it("returns a fresh variant with a default low threshold", () => {
    const v = blankVariant();
    expect(v.stockQty).toBe(0);
    expect(v.lowAt).toBeGreaterThan(0);
  });
});
