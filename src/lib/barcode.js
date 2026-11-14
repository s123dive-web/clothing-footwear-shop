// Barcodes (feature "barcode"): matching a scanned code to a product/variant, and drawing
// Code 128 barcodes for printable labels. Pure — the camera lives in ui/BarcodeScanner.jsx.

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------
const norm = (s) =>
  String(s ?? "")
    .trim()
    .toLowerCase();

// The code printed on a variant's label: its own SKU if it has one, else "V<variant id>".
export const labelCode = (product, variant) =>
  String(variant.sku || "").trim() || "V" + String(variant.id);

// → { product, variant } (variant null = product matched by its item code and has several
// variants, so the size/colour picker should open), or null when nothing matches.
export function matchCode(items, code) {
  const c = norm(code);
  if (!c) return null;
  for (const p of items || [])
    for (const v of p.variants || [])
      if (norm(v.sku) === c || norm("V" + v.id) === c) return { product: p, variant: v };
  for (const p of items || []) {
    if (norm(p.code) !== c) continue;
    const vs = p.variants || [];
    return { product: p, variant: vs.length === 1 ? vs[0] : null };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Code 128 (code set B: all printable ASCII)
// ---------------------------------------------------------------------------------------------
// Bar/space module widths for symbol values 0–105, then the stop pattern (106).
const PATTERNS = (
  "212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 " +
  "122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 " +
  "321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 " +
  "211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 " +
  "213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 " +
  "121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 " +
  "241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 " +
  "412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 " +
  "211214 211232 2331112"
).split(" ");
const START_B = 104;
const STOP = 106;

export const CODE128_PATTERNS = PATTERNS;

// Can this text be drawn? (printable ASCII only, and not absurdly long for a label)
export const canEncode = (text) => /^[\x20-\x7e]{1,40}$/.test(String(text));

// The symbol values for `text`: start B, data, checksum, stop.
export function code128Values(text) {
  const s = String(text);
  if (!canEncode(s)) throw new Error("Code 128-B cannot encode: " + s);
  const data = [...s].map((ch) => ch.charCodeAt(0) - 32);
  const check = (START_B + data.reduce((a, v, i) => a + v * (i + 1), 0)) % 103;
  return [START_B, ...data, check, STOP];
}

// Module string: "1" = bar, "0" = space (no quiet zone).
export function code128Modules(text) {
  let out = "";
  for (const v of code128Values(text)) {
    const p = PATTERNS[v];
    for (let i = 0; i < p.length; i++) out += (i % 2 === 0 ? "1" : "0").repeat(Number(p[i]));
  }
  return out;
}

// A self-contained SVG barcode with a 10-module quiet zone each side.
export function code128Svg(text, { height = 40, module = 2 } = {}) {
  const m = code128Modules(text);
  const quiet = 10;
  const w = (m.length + quiet * 2) * module;
  let rects = "";
  for (let i = 0; i < m.length;) {
    if (m[i] === "0") {
      i++;
      continue;
    }
    let j = i;
    while (j < m.length && m[j] === "1") j++;
    rects += `<rect x="${(i + quiet) * module}" y="0" width="${(j - i) * module}" height="${height}"/>`;
    i = j;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${height}" viewBox="0 0 ${w} ${height}" shape-rendering="crispEdges"><rect width="${w}" height="${height}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}

// ---------------------------------------------------------------------------------------------
// Labels: one per variant — name, size · colour, price, barcode, code.
// ---------------------------------------------------------------------------------------------
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

export function labelsHtml(product, { money = (n) => String(n), shop = "" } = {}) {
  const labels = (product.variants || [])
    .map((v) => {
      const code = labelCode(product, v);
      const variant = [v.size, v.color].filter(Boolean).join(" · ");
      return `<div class="lbl">${shop ? `<div class="shop">${esc(shop)}</div>` : ""}<div class="nm">${esc(product.name)}</div><div class="vr">${esc(variant)}</div><div class="pr">${esc(money(product.sellingPrice))}</div>${canEncode(code) ? code128Svg(code, { height: 34, module: 1 }) : ""}<div class="cd">${esc(code)}</div></div>`;
    })
    .join("");
  return `<style>body{font-family:Arial,sans-serif;margin:0;padding:6px}.lbl{display:inline-block;width:46mm;box-sizing:border-box;border:1px dashed #999;padding:4px;margin:2px;text-align:center;vertical-align:top;page-break-inside:avoid}.shop{font-size:8px}.nm{font-size:11px;font-weight:bold}.vr{font-size:11px}.pr{font-size:14px;font-weight:bold;margin:2px 0}.cd{font-size:9px;letter-spacing:1px}svg{max-width:100%;height:34px}</style>${labels}`;
}
