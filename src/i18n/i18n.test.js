import { describe, it, expect } from "vitest";
import { STRINGS, LANGS } from "./strings.js";
import { translate } from "./index.jsx";

const placeholders = (s) => (s.match(/\{\w+\}/g) || []).sort().join(",");

describe("strings table", () => {
  it("offers English, Hindi and Marathi", () => {
    expect(LANGS.map((l) => l[0])).toEqual(["en", "hi", "mr"]);
  });
  it("every string exists in every language, non-empty", () => {
    const keys = Object.keys(STRINGS.en);
    expect(keys.length).toBeGreaterThan(100);
    for (const lang of ["hi", "mr"]) {
      for (const k of keys) {
        expect(typeof STRINGS[lang][k], `${lang}: ${k}`).toBe("string");
        expect(STRINGS[lang][k].trim().length, `${lang}: ${k}`).toBeGreaterThan(0);
      }
      expect(Object.keys(STRINGS[lang]).sort()).toEqual([...keys].sort());
    }
  });
  it("translations keep exactly the same {placeholders} as the English text", () => {
    for (const lang of ["hi", "mr"])
      for (const k of Object.keys(STRINGS.en))
        expect(placeholders(STRINGS[lang][k]), `${lang}: ${k}`).toBe(placeholders(k));
  });
  it("Hindi and Marathi are written in Devanagari", () => {
    for (const lang of ["hi", "mr"]) {
      const all = Object.values(STRINGS[lang]).join(" ");
      expect(/[ऀ-ॿ]/.test(all)).toBe(true);
    }
  });
});

describe("translate", () => {
  it("English is the identity and fills placeholders", () => {
    expect(translate("en", "Complete sale · {amount}", { amount: "₹500" })).toBe(
      "Complete sale · ₹500"
    );
  });
  it("translates and fills placeholders", () => {
    expect(translate("hi", "Complete sale · {amount}", { amount: "₹500" })).toBe(
      "बिक्री पूरी करें · ₹500"
    );
    expect(translate("mr", "Total")).toBe("एकूण");
  });
  it("falls back to the English text for an unknown string or language", () => {
    expect(translate("hi", "Some untranslated label")).toBe("Some untranslated label");
    expect(translate("xx", "Total")).toBe("Total");
  });
  it("leaves a placeholder alone when no value is given", () => {
    expect(translate("en", "{n} in stock")).toBe("{n} in stock");
  });
});
