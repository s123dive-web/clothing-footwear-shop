import { describe, it, expect } from "vitest";
import {
  DEFAULT_SHOP_CONFIG,
  normalizeConfig,
  validateConfig,
  footwearSizes,
} from "./shopConfig.js";

describe("normalizeConfig", () => {
  it("fills defaults for a null/partial config", () => {
    const c = normalizeConfig(null);
    expect(c.name).toBe(DEFAULT_SHOP_CONFIG.name);
    expect(c.currency).toBe("₹");
    expect(c.footwearSizeMin).toBe(3);
    expect(c.footwearSizeMax).toBe(9);
  });
  it("keeps provided values and coerces the footwear range", () => {
    const c = normalizeConfig({
      name: "Riya Collection",
      currency: "Rs",
      footwearSizeMin: "5",
      footwearSizeMax: "8",
    });
    expect(c.name).toBe("Riya Collection");
    expect(c.currency).toBe("Rs");
    expect(c.footwearSizeMin).toBe(5);
    expect(c.footwearSizeMax).toBe(8);
  });
  it("orders a reversed footwear range", () => {
    const c = normalizeConfig({ footwearSizeMin: 9, footwearSizeMax: 3 });
    expect(c.footwearSizeMin).toBe(3);
    expect(c.footwearSizeMax).toBe(9);
  });
  it("falls back to defaults for blank name/currency", () => {
    const c = normalizeConfig({ name: "   ", currency: "  " });
    expect(c.name).toBe(DEFAULT_SHOP_CONFIG.name);
    expect(c.currency).toBe("₹");
  });
});

describe("validateConfig", () => {
  it("passes a valid config", () => {
    expect(
      validateConfig({ name: "Shop", currency: "₹", footwearSizeMin: 3, footwearSizeMax: 9 })
    ).toBe("");
  });
  it("requires a name", () => {
    expect(
      validateConfig({ name: "", currency: "₹", footwearSizeMin: 3, footwearSizeMax: 9 })
    ).toMatch(/name/i);
  });
  it("rejects a bad email but allows a blank one", () => {
    expect(
      validateConfig({
        name: "S",
        currency: "₹",
        email: "nope",
        footwearSizeMin: 3,
        footwearSizeMax: 9,
      })
    ).toMatch(/email/i);
    expect(
      validateConfig({
        name: "S",
        currency: "₹",
        email: "",
        footwearSizeMin: 3,
        footwearSizeMax: 9,
      })
    ).toBe("");
  });
  it("rejects an inverted size range", () => {
    expect(
      validateConfig({ name: "S", currency: "₹", footwearSizeMin: 9, footwearSizeMax: 3 })
    ).toMatch(/size range/i);
  });
});

describe("footwearSizes", () => {
  it("expands the configured range inclusively", () => {
    expect(footwearSizes({ footwearSizeMin: 4, footwearSizeMax: 7 })).toEqual(["4", "5", "6", "7"]);
  });
});
