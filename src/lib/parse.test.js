import { describe, it, expect } from "vitest";
import { parseRawText, parseTextToMatrix } from "./parse.js";

// A run of NUL / control bytes - what text extracted from a real binary file looks like.
// Built from char codes so the source file itself stays plain text.
const BINARY_SAMPLE =
  String.fromCharCode(0, 1, 2, 0, 3, 0, 4) + " garbage " + String.fromCharCode(0, 0, 0);

// Rupee sign, built from its code point to keep this source file pure ASCII.
const RUPEE = String.fromCharCode(0x20b9);

describe("parseTextToMatrix", () => {
  it("splits comma-delimited lines", () => {
    expect(parseTextToMatrix("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("detects tab delimiter (TSV)", () => {
    expect(parseTextToMatrix("name\tqty\nTea\t5")).toEqual([
      ["name", "qty"],
      ["Tea", "5"],
    ]);
  });

  it("honours quoted fields containing the delimiter", () => {
    expect(parseTextToMatrix('"Lays, Magic",20')).toEqual([["Lays, Magic", "20"]]);
  });

  it("peels trailing numbers off a delimiter-less line", () => {
    expect(parseTextToMatrix("Parle-G 24 8 10")).toEqual([["Parle-G", "24", "8", "10"]]);
  });
});

describe("parseRawText - headered tables", () => {
  it("maps name/qty/price columns by header", () => {
    const rows = parseRawText("name,qty,price\nApple,3,10");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Apple", qty: 3, unit: "pc", sellPrice: 10 });
  });

  it("maps buy and sell columns distinctly", () => {
    const rows = parseRawText("item,quantity,cost,mrp\nSugar 1kg,4,40,48");
    expect(rows[0]).toMatchObject({ name: "Sugar 1kg", qty: 4, buyPrice: 40, sellPrice: 48 });
  });

  it("strips currency symbols and thousands separators from numbers", () => {
    // TSV so the comma thousands-separator doesn't collide with the field delimiter.
    const rows = parseRawText("name\tprice\nGhee\t" + RUPEE + "1,250");
    expect(rows[0].sellPrice).toBe(1250);
  });

  it("respects an explicit qty of 0 (catalogue at zero stock)", () => {
    const rows = parseRawText("name,qty\nNew Item,0");
    expect(rows[0].qty).toBe(0);
  });

  it("defaults a blank qty to 1", () => {
    const rows = parseRawText("name,qty,price\nMilk,,25");
    expect(rows[0].qty).toBe(1);
  });

  it("normalises unit aliases", () => {
    const rows = parseRawText("name,qty,unit\nRice,2,kgs");
    expect(rows[0].unit).toBe("kg");
  });

  it("parses a day-first expiry to ISO", () => {
    const rows = parseRawText("name,expiry\nCurd,31/12/2026");
    expect(rows[0].expiry).toBe("2026-12-31");
  });
});

describe("parseRawText - headerless inference", () => {
  it("infers qty/buy/sell from three trailing numbers", () => {
    const rows = parseRawText("Parle-G 24 8 10");
    expect(rows[0]).toMatchObject({
      name: "Parle-G",
      qty: 24,
      buyPrice: 8,
      sellPrice: 10,
      amount: 10,
      unit: "pc",
    });
  });

  it("treats a single trailing number as quantity", () => {
    const rows = parseRawText("Notebook 12");
    expect(rows[0]).toMatchObject({ name: "Notebook", qty: 12 });
  });

  it("ignores a row that is only numbers (no name)", () => {
    expect(parseRawText("10 20 30")).toEqual([]);
  });
});

describe("parseRawText - JSON inputs", () => {
  it("parses a bare array of objects", () => {
    const rows = parseRawText('[{"name":"Milk","qty":2,"price":25}]');
    expect(rows[0]).toMatchObject({ name: "Milk", qty: 2, sellPrice: 25 });
  });

  it("pulls the records out of a backup-style wrapper object", () => {
    const rows = parseRawText('{"items":[{"name":"Rice","qty":1}],"sales":[]}');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Rice");
  });
});

describe("parseRawText - edge cases", () => {
  it("returns [] for empty input", () => {
    expect(parseRawText("")).toEqual([]);
    expect(parseRawText("   ")).toEqual([]);
  });

  it("rejects binary/unreadable content", () => {
    expect(() => parseRawText(BINARY_SAMPLE)).toThrow();
  });
});
