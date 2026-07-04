// Flexible data parser for the "Raw Data Record" tab.
// Turns an uploaded file (csv / tsv / txt / xls / xlsx / json / pdf) or pasted
// text into a normalised list of rows the app can map to inventory or sales:
//   { name, qty, unit, buyPrice, sellPrice, amount, expiry }
// The goal is to accept messy, real-world data: with or without headers, any
// common delimiter, currency symbols, nested JSON backups, etc.
// Everything runs in the browser. PDF text extraction is best-effort.
import * as XLSX from "xlsx";

// Loose unit aliases → canonical unit. Lets columnar data say "pcs", "grams", etc.
const UNIT_ALIASES = {
  pc: "pc",
  pcs: "pc",
  piece: "pc",
  pieces: "pc",
  nos: "pc",
  no: "pc",
  unit: "pc",
  units: "pc",
  kg: "kg",
  kgs: "kg",
  kilo: "kg",
  kilos: "kg",
  kilogram: "kg",
  kilograms: "kg",
  g: "g",
  gm: "g",
  gms: "g",
  gram: "g",
  grams: "g",
  l: "L",
  ltr: "L",
  litre: "L",
  litres: "L",
  liter: "L",
  liters: "L",
  ml: "ml",
  packet: "packet",
  packets: "packet",
  pkt: "packet",
  pkts: "packet",
  pack: "packet",
  packs: "packet",
  dozen: "dozen",
  doz: "dozen",
  dz: "dozen",
  box: "box",
  boxes: "box",
  carton: "box",
  cartons: "box",
  ctn: "box",
};

// Header keyword → field. Order matters (more specific first).
const HEADER_RULES = [
  ["amount", /\b(amount|total|value|net|line\s*total|subtotal)\b/i],
  ["buyPrice", /\b(buy|cost|purchase|wholesale|cp|landing)\b/i],
  ["sellPrice", /\b(sell|sale|mrp|price|selling|rate|sp|unit\s*price)\b/i],
  ["qty", /\b(qty|quantity|nos|units?|pcs|count|stock|balance|on\s*hand|onhand)\b/i],
  ["unit", /\b(unit|uom|measure|packing|pack)\b/i],
  [
    "expiry",
    /\b(expiry|expiration|expires?|exp\.?\s*date|exp|best\s*before|bb|use\s*by|valid\s*(?:till|until|upto))\b/i,
  ],
  ["date", /\b(date|paid\s*on|spent\s*on|txn|posted|entry\s*date|expense\s*date)\b/i],
  ["name", /\b(name|item|product|description|particular|goods|details?|title|sku|expense|head)\b/i],
];

const canonUnit = (s) => UNIT_ALIASES[String(s).trim().toLowerCase()] || "";
const isUnitToken = (s) => !!UNIT_ALIASES[String(s).trim().toLowerCase()];

// Lenient number for header-mapped columns (we already trust the column).
const toNum = (v) => {
  if (v == null) return 0;
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

// Strict: is this cell, on its own, essentially a number? Used to decide whether
// an unlabelled cell is a value or part of the item name. Accepts currency
// symbols, thousands separators, a trailing "%" or "/-", but rejects anything
// with letters mixed in ("100g" stays part of the name).
function numericVal(c) {
  const s = String(c ?? "").trim();
  if (!/\d/.test(s)) return { ok: false, n: 0 };
  const core = s.replace(/[₹$€£,%\s]/g, "").replace(/\/-?$/, "");
  if (/^-?\d+(\.\d+)?$/.test(core)) return { ok: true, n: Number(core) };
  return { ok: false, n: 0 };
}

// Date-like token (used to spot an expiry in unlabelled/headerless rows).
const DATE_RE = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})$/;
const pad2 = (n) => String(n).padStart(2, "0");
const isoFromParts = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

// Normalise an expiry value (ISO string, d/m/y, JS Date, month-name, or Excel serial)
// to a local "YYYY-MM-DD"; returns "" when it isn't a recognisable date. Day-first by
// default (Indian convention), swapping to month-first only when the parts force it.
function toDateStr(v) {
  if (v == null || v === "") return "";
  if (v instanceof Date)
    return isNaN(v) ? "" : isoFromParts(v.getFullYear(), v.getMonth() + 1, v.getDate());
  const s = String(v).trim();
  if (!s) return "";
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/); // YYYY-MM-DD / YYYY/M/D
  if (m) return isoFromParts(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/); // D-M-Y
  if (m) {
    const a = +m[1],
      b = +m[2];
    const y = m[3].length === 2 ? "20" + m[3] : m[3];
    if (b > 12 && a <= 12) return isoFromParts(+y, a, b); // a=month, b=day
    return isoFromParts(+y, b, a); // a=day, b=month
  }
  if (/^\d+(\.\d+)?$/.test(s)) {
    // Excel serial date (days since 1899-12-30)
    const n = Number(s);
    if (n > 59 && n < 60000) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
      return isoFromParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    return "";
  }
  const t = Date.parse(s); // month-name forms like "Dec 2026" / "31 Dec 2026"
  if (!isNaN(t)) {
    const d = new Date(t);
    return isoFromParts(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  return "";
}

// Normalise a header label so word-boundary rules also catch camelCase and
// snake/kebab keys: "buyPrice" → "buy Price", "sell_price" → "sell price".
const normHeader = (cell) =>
  String(cell ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ");

function mapHeaderIndices(cells) {
  const idx = {
    name: -1,
    qty: -1,
    unit: -1,
    buyPrice: -1,
    sellPrice: -1,
    amount: -1,
    expiry: -1,
    date: -1,
  };
  cells.forEach((cell, i) => {
    const c = normHeader(cell);
    for (const [field, re] of HEADER_RULES) {
      if (idx[field] === -1 && re.test(c)) {
        idx[field] = i;
        break;
      }
    }
  });
  return idx;
}

// A row is a header only if it names at least one known field AND has no cell
// that is purely a number (real headers don't carry bare values).
function looksLikeHeader(cells) {
  const text = cells.map((c) => String(c ?? "").trim()).filter((c) => c !== "");
  if (!text.length) return false;
  const anyName = HEADER_RULES.some(([, re]) => text.some((c) => re.test(normHeader(c))));
  const numericCells = text.filter((c) => numericVal(c).ok).length;
  return anyName && numericCells === 0;
}

// Infer a row with no header: pull out a unit token and the numeric cells, treat
// the rest as the name, then assign numbers by how many there are:
//   1 → qty | 2 → qty, price | 3 → qty, buy, sell | 4+ → qty, buy, sell, amount
function inferRow(cells) {
  const parts = (cells || []).map((c) => String(c ?? "").trim()).filter((c) => c !== "");
  if (!parts.length) return null;
  let unit = "",
    expiry = "";
  const textCells = [];
  const nums = [];
  for (const c of parts) {
    if (!unit && isUnitToken(c)) {
      unit = canonUnit(c);
      continue;
    }
    if (!expiry && DATE_RE.test(c)) {
      expiry = toDateStr(c);
      continue;
    }
    const v = numericVal(c);
    if (v.ok) nums.push(v.n);
    else textCells.push(c);
  }
  const name = textCells.join(" ").trim();
  if (!name) return null; // numbers with no label aren't a usable item

  let qty = 1,
    buyPrice = "",
    sellPrice = "",
    amount = "";
  if (nums.length === 1) {
    qty = nums[0];
  } else if (nums.length === 2) {
    qty = nums[0];
    sellPrice = nums[1];
    amount = nums[1];
  } else if (nums.length === 3) {
    qty = nums[0];
    buyPrice = nums[1];
    sellPrice = nums[2];
    amount = nums[2];
  } else if (nums.length >= 4) {
    qty = nums[0];
    buyPrice = nums[1];
    sellPrice = nums[2];
    amount = nums[3];
  }
  return {
    name,
    qty: qty || 1,
    unit: unit || "pc",
    buyPrice,
    sellPrice,
    amount,
    expiry,
    date: expiry,
  };
}

// Core: given a header row + data rows, produce normalised rows.
function coreMap(headerCells, dataRows, hasHeader) {
  if (!hasHeader) {
    const out = [];
    for (const row of dataRows) {
      const r = inferRow(row);
      if (r) out.push(r);
    }
    return out;
  }
  const idx = mapHeaderIndices(headerCells);
  const out = [];
  for (const row of dataRows) {
    if (!row || row.every((c) => String(c ?? "").trim() === "")) continue;
    const name = String((idx.name >= 0 ? row[idx.name] : row[0]) ?? "").trim();
    if (!name) continue;
    const rawUnit = idx.unit >= 0 ? String(row[idx.unit] ?? "").trim() : "";
    // A blank qty cell defaults to 1, but an explicit "0" is respected (e.g. importing a
    // catalogue at zero stock) rather than being bumped to 1.
    const qtyCell = idx.qty >= 0 ? String(row[idx.qty] ?? "").trim() : "";
    out.push({
      name,
      qty: idx.qty < 0 || qtyCell === "" ? 1 : toNum(row[idx.qty]),
      unit: canonUnit(rawUnit) || "pc",
      buyPrice: idx.buyPrice >= 0 ? toNum(row[idx.buyPrice]) : "",
      sellPrice: idx.sellPrice >= 0 ? toNum(row[idx.sellPrice]) : "",
      amount: idx.amount >= 0 ? toNum(row[idx.amount]) : "",
      expiry: idx.expiry >= 0 ? toDateStr(row[idx.expiry]) : "",
      date:
        idx.date >= 0
          ? toDateStr(row[idx.date])
          : idx.expiry >= 0
            ? toDateStr(row[idx.expiry])
            : "",
    });
  }
  return out;
}

function matrixToRows(matrix) {
  const rows = (matrix || []).filter(
    (r) => Array.isArray(r) && r.some((c) => String(c ?? "").trim() !== "")
  );
  if (!rows.length) return [];
  const hasHeader = looksLikeHeader(rows[0]);
  return coreMap(hasHeader ? rows[0] : null, hasHeader ? rows.slice(1) : rows, hasHeader);
}

// Array of plain objects (from JSON) → rows.
function objectsToRows(arr) {
  const objs = (arr || []).filter((o) => o && typeof o === "object" && !Array.isArray(o));
  if (!objs.length) return [];
  const header = Array.from(new Set(objs.flatMap((o) => Object.keys(o))));
  const data = objs.map((o) => header.map((k) => o[k]));
  return coreMap(header, data, true);
}

// Pull the most likely list of records out of arbitrary parsed JSON. Handles a
// bare array of objects, an array of arrays, and wrapper objects such as the
// app's own backup ({ items: [...], sales: [...] }) or { data: [...] }.
function jsonToRows(j) {
  if (Array.isArray(j)) {
    if (j.length && j.every((x) => Array.isArray(x))) return matrixToRows(j);
    return objectsToRows(j);
  }
  if (j && typeof j === "object") {
    const arrKeys = Object.keys(j).filter(
      (k) =>
        Array.isArray(j[k]) && j[k].some((o) => o && typeof o === "object" && !Array.isArray(o))
    );
    if (arrKeys.length) {
      const preferred = [
        "items",
        "products",
        "inventory",
        "stock",
        "rows",
        "data",
        "records",
        "lines",
      ];
      const key = preferred.find((p) => arrKeys.includes(p)) || arrKeys[0];
      return objectsToRows(j[key]);
    }
    return objectsToRows([j]); // a single record object
  }
  return [];
}

function detectDelimiter(line) {
  const counts = {
    "\t": (line.match(/\t/g) || []).length,
    ";": (line.match(/;/g) || []).length,
    ",": (line.match(/,/g) || []).length,
    "|": (line.match(/\|/g) || []).length,
  };
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : null;
}

function splitCsvLine(line, delim) {
  // Minimal quoted-field handling for comma/semicolon CSV.
  const out = [];
  let cur = "",
    inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

// Split one delimiter-less line into cells. Prefer runs of 2+ spaces (printed /
// PDF columns); failing that, peel trailing numeric tokens off so single-space
// data like "Parle-G 24 8 10" still becomes [name, 24, 8, 10].
function splitColumnarLine(line) {
  const multi = line
    .split(/\s{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (multi.length > 1) return multi;
  const m = line.match(/^(.*?\S)((?:\s+[₹$€£]?-?[\d.,]+%?(?:\/-?)?){1,4})\s*$/);
  if (m) {
    const nums = m[2].trim().split(/\s+/);
    return [m[1].trim(), ...nums];
  }
  return [line.trim()];
}

export function parseTextToMatrix(text) {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (!lines.length) return [];
  // Pick a delimiter from whichever line shows one (header line may have none).
  const delim = lines.map(detectDelimiter).find(Boolean) || null;
  if (delim) return lines.map((l) => splitCsvLine(l, delim));
  return lines.map(splitColumnarLine);
}

// Heuristic: text extracted from a binary file (e.g. a .docx/.png renamed or force-picked)
// is full of NUL / control bytes. Reject it clearly instead of emitting garbage rows.
function looksBinary(text) {
  const sample = text.slice(0, 2000);
  if (!sample) return false;
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0 || c < 9 || (c > 13 && c < 32)) bad++;
  }
  return bad / sample.length > 0.05;
}

// Parse pasted text (JSON or delimited/columnar).
export function parseRawText(text) {
  const t = (text || "").trim();
  if (!t) return [];
  if (looksBinary(text)) throw new Error("binary or unreadable file");
  if (t[0] === "[" || t[0] === "{") {
    try {
      return jsonToRows(JSON.parse(t));
    } catch {
      /* fall through to delimited parsing */
    }
  }
  return matrixToRows(parseTextToMatrix(t));
}

async function pdfToText(file) {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  let text = "";
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // Reconstruct lines from text items by their y-position.
    const byLine = new Map();
    content.items.forEach((it) => {
      const y = Math.round(it.transform[5]);
      if (!byLine.has(y)) byLine.set(y, []);
      byLine.get(y).push(it.str);
    });
    [...byLine.entries()]
      .sort((a, b) => b[0] - a[0])
      .forEach(([, parts]) => {
        text += parts.join("  ").trim() + "\n";
      });
  }
  return text;
}

// Main entry: parse any uploaded file into normalised rows.
export async function parseFile(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (ext === "json") {
    return jsonToRows(JSON.parse(await file.text()));
  }
  if (ext === "xlsx" || ext === "xls") {
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: true });
    return matrixToRows(matrix);
  }
  if (ext === "pdf") {
    return matrixToRows(parseTextToMatrix(await pdfToText(file)));
  }
  // csv / tsv / txt / unknown → our own tolerant delimited/columnar parser, which
  // also recognises JSON pasted into a .txt file.
  return parseRawText(await file.text());
}
