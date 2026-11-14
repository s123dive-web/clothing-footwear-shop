import { describe, it, expect } from "vitest";
import {
  matchCode,
  labelCode,
  canEncode,
  code128Values,
  code128Modules,
  code128Svg,
  labelsHtml,
  CODE128_PATTERNS,
} from "./barcode.js";

const items = [
  {
    id: "p1",
    name: "Kurti",
    code: "KRT-01",
    sellingPrice: 500,
    variants: [
      { id: "va", size: "M", color: "Red", sku: "KRT-M-RED" },
      { id: "vb", size: "L", color: "Red", sku: "" },
    ],
  },
  { id: "p2", name: "Clip", code: "CLIP9", variants: [{ id: "vc", size: "", color: "" }] },
];

describe("matchCode", () => {
  it("finds a variant by its SKU, case-insensitively and ignoring spaces around it", () => {
    expect(matchCode(items, " krt-m-red ")).toMatchObject({
      product: { id: "p1" },
      variant: { id: "va" },
    });
  });
  it("finds a variant by the generated label code V<id>", () => {
    expect(matchCode(items, "Vvb")).toMatchObject({ product: { id: "p1" }, variant: { id: "vb" } });
    expect(labelCode(items[0], items[0].variants[1])).toBe("Vvb");
    expect(labelCode(items[0], items[0].variants[0])).toBe("KRT-M-RED");
  });
  it("a product code matches the product: straight to its only variant, else the picker", () => {
    expect(matchCode(items, "clip9")).toMatchObject({
      product: { id: "p2" },
      variant: { id: "vc" },
    });
    expect(matchCode(items, "KRT-01")).toMatchObject({ product: { id: "p1" }, variant: null });
  });
  it("returns null for an unknown or empty code", () => {
    expect(matchCode(items, "nope")).toBeNull();
    expect(matchCode(items, "  ")).toBeNull();
    expect(matchCode([], "x")).toBeNull();
  });
});

describe("Code 128", () => {
  it("has the 107 standard patterns: 11 modules each, 13 for stop, all different", () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    const width = (p) => [...p].reduce((a, d) => a + Number(d), 0);
    CODE128_PATTERNS.slice(0, 106).forEach((p, i) => {
      expect(p, "symbol " + i).toMatch(/^[1-4]{6}$/);
      expect(width(p), "symbol " + i).toBe(11);
    });
    expect(width(CODE128_PATTERNS[106])).toBe(13);
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
  });
  it("computes the weighted mod-103 checksum (start B)", () => {
    // 104 + 48·1 + 42·2 + 42·3 + 17·4 + 18·5 + 19·6 + 35·7 = 879; 879 mod 103 = 55
    expect(code128Values("PJJ123C")).toEqual([104, 48, 42, 42, 17, 18, 19, 35, 55, 106]);
    expect(code128Values("A")).toEqual([104, 33, (104 + 33) % 103, 106]);
  });
  it("draws start + data + check + stop as bars and spaces", () => {
    const m = code128Modules("A");
    expect(m).toHaveLength(11 * 3 + 13);
    expect(m.startsWith("11010010000")).toBe(true); // Start B = 211214
    expect(m.endsWith("1100011101011")).toBe(true); // Stop = 2331112
  });
  it("refuses text it cannot encode", () => {
    expect(canEncode("KRT-M-RED")).toBe(true);
    expect(canEncode("")).toBe(false);
    expect(canEncode("कुर्ती")).toBe(false);
    expect(() => code128Values("कुर्ती")).toThrow();
  });
  it("produces an SVG with a quiet zone and one rect per bar", () => {
    const svg = code128Svg("AB", { module: 2, height: 30 });
    expect(svg).toContain('viewBox="0 0 ' + (11 * 4 + 13 + 20) * 2 + ' 30"');
    expect(svg.match(/<rect x=/g).length).toBe(3 * 4 + 4); // 3 bars per symbol ×4, 4 in stop
  });
});

describe("labelsHtml", () => {
  it("one label per variant with name, size · colour, price, barcode and code", () => {
    const html = labelsHtml(items[0], { money: (n) => "₹" + n, shop: "Vijay <Shop>" });
    expect(html.match(/class="lbl"/g)).toHaveLength(2);
    expect(html).toContain("Vijay &lt;Shop&gt;");
    expect(html).toContain("M · Red");
    expect(html).toContain("₹500");
    expect(html).toContain(">KRT-M-RED<");
    expect(html).toContain(">Vvb<");
    expect(html.match(/<svg/g)).toHaveLength(2);
  });
});
