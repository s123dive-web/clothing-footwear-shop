// Record validation — the SAME checks as the `.validate` rules in database.rules.json, in
// JavaScript. Two uses:
//   • Admin → "Check data against rules": find stored records the rules would refuse to
//     re-write, BEFORE the rules are deployed;
//   • e2e/rules.spec.js runs these and the real rules over the same samples to prove they agree.
// Keep the two in step: change one, change the other.
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isStr = (v) => typeof v === "string";
const has = (o, k) => o != null && o[k] !== undefined && o[k] !== null;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// → list of problems ([] = valid)
export function saleProblems(s) {
  const p = [];
  if (!s || typeof s !== "object") return ["not a record"];
  if (!has(s, "id")) p.push("missing id");
  if (!has(s, "date")) p.push("missing date");
  else if (!isStr(s.date) || !DATE.test(s.date)) p.push("date is not YYYY-MM-DD");
  if (!has(s, "total")) p.push("missing total");
  else if (!isNum(s.total)) p.push("total is not a number");
  if (has(s, "profit") && !isNum(s.profit)) p.push("profit is not a number");
  if (has(s, "paid") && !(isNum(s.paid) && s.paid >= 0)) p.push("paid is not a number ≥ 0");
  if (has(s, "payment") && !isStr(s.payment)) p.push("payment is not text");
  if (has(s, "discount") && !(isNum(s.discount) && s.discount >= 0))
    p.push("discount is not a number ≥ 0");
  const lines = Array.isArray(s.lines) ? s.lines : s.lines ? Object.values(s.lines) : [];
  lines.forEach((l, i) => {
    if (!l || typeof l !== "object") return p.push(`line ${i + 1} is not a record`);
    if (has(l, "qty") && !isNum(l.qty)) p.push(`line ${i + 1}: qty is not a number`);
    if (has(l, "amount") && !isNum(l.amount)) p.push(`line ${i + 1}: amount is not a number`);
    if (has(l, "price") && !isNum(l.price)) p.push(`line ${i + 1}: price is not a number`);
  });
  return p;
}

export function itemProblems(it) {
  const p = [];
  if (!it || typeof it !== "object") return ["not a record"];
  if (!has(it, "id")) p.push("missing id");
  if (!has(it, "name")) p.push("missing name");
  else if (!isStr(it.name)) p.push("name is not text");
  for (const k of ["sellingPrice", "purchasePrice", "mrp", "stock"])
    if (has(it, k) && !(isNum(it[k]) && it[k] >= 0)) p.push(`${k} is not a number ≥ 0`);
  const vs = Array.isArray(it.variants)
    ? it.variants
    : it.variants
      ? Object.values(it.variants)
      : [];
  vs.forEach((v, i) => {
    if (!v || typeof v !== "object") return p.push(`variant ${i + 1} is not a record`);
    if (has(v, "stockQty") && !(isNum(v.stockQty) && v.stockQty >= 0))
      p.push(`variant ${i + 1}: stock is not a number ≥ 0`);
    if (has(v, "lowAt") && !(isNum(v.lowAt) && v.lowAt >= 0))
      p.push(`variant ${i + 1}: low-stock level is not a number ≥ 0`);
  });
  return p;
}

// → [{ slice, id, label, problems }] for every stored record the rules would refuse.
export function auditData({ items = [], sales = [] }) {
  const out = [];
  for (const it of items) {
    const problems = itemProblems(it);
    if (problems.length)
      out.push({
        slice: "items",
        id: it && it.id,
        label: (it && it.name) || "(no name)",
        problems,
      });
  }
  for (const s of sales) {
    const problems = saleProblems(s);
    if (problems.length)
      out.push({
        slice: "sales",
        id: s && s.id,
        label: `${(s && s.date) || "(no date)"} · ${s && s.total}`,
        problems,
      });
  }
  return out;
}
