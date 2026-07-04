import { describe, it, expect } from "vitest";
import {
  GROUPS,
  SUBCATEGORIES_BY_GROUP,
  ALL_SUBCATEGORIES,
  groupForSubcategory,
  CLOTHING_SIZES,
  sizesForProduct,
  footwearSizeRange,
  guessSubcategory,
  subcatIcon,
  SEED_PRODUCTS,
} from "./catalog.js";

describe("taxonomy", () => {
  it("has the three top-level groups", () => {
    expect(GROUPS).toEqual(["Clothing", "Footwear", "Accessories"]);
  });
  it("maps subcategories back to their group", () => {
    expect(groupForSubcategory("Kurtis")).toBe("Clothing");
    expect(groupForSubcategory("Sandals")).toBe("Footwear");
    expect(groupForSubcategory("Handbags")).toBe("Accessories");
    expect(groupForSubcategory("Nonsense")).toBe("Clothing"); // safe default
  });
  it("ALL_SUBCATEGORIES covers every group's subcategories", () => {
    const flat = GROUPS.flatMap((g) => SUBCATEGORIES_BY_GROUP[g]);
    expect(ALL_SUBCATEGORIES).toEqual(flat);
    expect(ALL_SUBCATEGORIES).toContain("Kurtis");
    expect(ALL_SUBCATEGORIES).toContain("Bellies/Ballerinas");
  });
});

describe("sizesForProduct", () => {
  const cfg = { footwearSizeMin: 3, footwearSizeMax: 9 };
  it("uses labelled clothing sizes for clothing", () => {
    expect(sizesForProduct({ category: "Clothing", subcategory: "Kurtis" }, cfg)).toEqual(
      CLOTHING_SIZES
    );
  });
  it("uses the configured numeric range for footwear", () => {
    expect(sizesForProduct({ category: "Footwear", subcategory: "Heels" }, cfg)).toEqual([
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]);
  });
  it("respects a custom footwear range", () => {
    expect(footwearSizeRange({ footwearSizeMin: 4, footwearSizeMax: 6 })).toEqual(["4", "5", "6"]);
  });
  it("uses Free Size for accessories", () => {
    expect(sizesForProduct({ category: "Accessories", subcategory: "Handbags" }, cfg)).toEqual([
      "Free Size",
    ]);
  });
});

describe("guessSubcategory", () => {
  it("guesses from keywords in the product name", () => {
    expect(guessSubcategory("Cotton Printed Kurti")).toBe("Kurtis");
    expect(guessSubcategory("Banarasi Saree")).toBe("Sarees");
    expect(guessSubcategory("Block Heel Sandal")).toBe("Sandals");
    expect(guessSubcategory("Running Sneaker")).toBe("Sports Shoes");
    expect(guessSubcategory("Sling Handbag")).toBe("Handbags");
  });
  it("returns null when nothing matches", () => {
    expect(guessSubcategory("zzz")).toBe(null);
    expect(guessSubcategory("")).toBe(null);
  });
});

describe("subcatIcon", () => {
  it("returns an emoji for known subcategories and a group/default fallback", () => {
    expect(subcatIcon("Sarees")).toBeTruthy();
    expect(subcatIcon("Unknown", "Footwear")).toBeTruthy();
    expect(subcatIcon("Unknown", "Unknown")).toBe("🛍️");
  });
});

describe("SEED_PRODUCTS", () => {
  it("has ~15 realistic ladies items with valid subcategories", () => {
    expect(SEED_PRODUCTS.length).toBeGreaterThanOrEqual(15);
    for (const s of SEED_PRODUCTS) {
      expect(ALL_SUBCATEGORIES).toContain(s.subcategory);
      expect(s.sellingPrice).toBeGreaterThan(0);
    }
  });
});
