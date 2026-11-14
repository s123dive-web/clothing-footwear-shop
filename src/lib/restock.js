// Restock suggestions: how fast each size/colour sells and how long its stock will last. Pure.
const num = (v) => Number(v) || 0;

const addDays = (date, n) => {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
};

// Units sold per "productId|variantId" in the `days` days up to and including `today`.
export function soldByVariant(sales, today, days) {
  const from = addDays(today, -(days - 1));
  const m = new Map();
  for (const s of sales || []) {
    if (!s.date || s.date < from || s.date > today) continue;
    for (const l of s.lines || []) {
      if (l.misc || !l.productId || !l.variantId) continue;
      const k = l.productId + "|" + l.variantId;
      m.set(k, (m.get(k) || 0) + num(l.qty)); // a return line has a negative qty → nets off
    }
  }
  return m;
}

// → one row per variant that sold in the window OR is at/below its low-stock level:
// { productId, variantId, name, size, color, stock, sold, perDay, daysLeft, suggest, fast }
// `cover` = how many days of sales the suggested order should cover.
export function restockSuggestions(items, sales, today, { days = 30, cover = 30 } = {}) {
  const sold = soldByVariant(sales, today, days);
  const rows = [];
  for (const p of items || []) {
    for (const v of p.variants || []) {
      const units = Math.max(0, sold.get(p.id + "|" + v.id) || 0);
      const stock = num(v.stockQty);
      const low = stock <= num(v.lowAt);
      if (!units && !low) continue;
      const perDay = units / days;
      const daysLeft = perDay > 0 ? stock / perDay : Infinity;
      rows.push({
        productId: p.id,
        variantId: v.id,
        name: p.name,
        size: v.size || "",
        color: v.color || "",
        stock,
        sold: units,
        perDay: Math.round(perDay * 100) / 100,
        daysLeft: Number.isFinite(daysLeft) ? Math.round(daysLeft * 10) / 10 : null,
        suggest: Math.max(0, Math.ceil(perDay * cover - stock)),
        low,
      });
    }
  }
  // "Fast" = the top quarter of sellers in this list (at least 1 unit a week).
  const rates = rows
    .map((r) => r.perDay)
    .filter((x) => x > 0)
    .sort((a, b) => b - a);
  const cut = rates.length ? Math.max(rates[Math.floor((rates.length - 1) / 4)], 1 / 7) : Infinity;
  for (const r of rows) r.fast = r.perDay >= cut;
  // Most urgent first: runs out soonest; never-selling low stock goes last.
  return rows.sort(
    (a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) || b.sold - a.sold
  );
}

// Units sold per size across all products in the window, best first: [{ size, qty }]
export function fastSizes(sales, today, days = 30) {
  const from = addDays(today, -(days - 1));
  const m = new Map();
  for (const s of sales || []) {
    if (!s.date || s.date < from || s.date > today) continue;
    for (const l of s.lines || []) {
      if (l.misc || !l.size) continue;
      m.set(l.size, (m.get(l.size) || 0) + num(l.qty));
    }
  }
  return [...m.entries()]
    .map(([size, qty]) => ({ size, qty }))
    .filter((r) => r.qty > 0)
    .sort((a, b) => b.qty - a.qty);
}
