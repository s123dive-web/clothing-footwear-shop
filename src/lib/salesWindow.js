// Sales "window": the app keeps only RECENT bills in memory and subscribed live, and loads
// older ones on demand, instead of holding every bill ever made.
//
// What is loaded at any time is the union of three sources:
//   recent — live query: bills dated on/after the window start (first day of the month,
//            SALES_WINDOW_MONTHS months back → always at least ~90 days)
//   udhari — live query: every Udhari (credit) bill of any age, so an old unpaid bill is never
//            missing from the credit book
//   older  — one-shot fetches the user asked for (Sales History "load older", Reports, Admin,
//            backup). Static until the next reload.
//
// Pure helpers only — the Firebase queries live in sync.js and the wiring in StoreManager.

// 0 turns the window off: everything is subscribed live, exactly as before Phase 2.
export const SALES_WINDOW_MONTHS = 3;

const pad = (n) => String(n).padStart(2, "0");

// First day of the month `months` before `today`'s month. ("2026-11-14", 3) → "2026-08-01"
export function windowStart(today, months = SALES_WINDOW_MONTHS) {
  if (!months || months <= 0) return null;
  let [y, m] = today.split("-").map(Number);
  m -= months;
  while (m < 1) {
    m += 12;
    y -= 1;
  }
  return `${y}-${pad(m)}-01`;
}

export const monthStart = (date) => String(date).slice(0, 7) + "-01";

// The day before a YYYY-MM-DD date (calendar-correct, no time zones involved).
export function prevDay(date) {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - 1));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// Live data wins over a static older fetch of the same bill.
export function unionSales({ recent, udhari, older }) {
  return { ...(older || {}), ...(udhari || {}), ...(recent || {}) };
}

// True when a raw `shop/sales` value is already a map keyed by each record's own id. A
// windowed (partial) view must NEVER be written back as the whole slice, so if the stored data
// is still in a legacy shape the caller falls back to the full subscription and lets the
// existing one-time migration run on complete data.
export function looksKeyedById(val) {
  if (val == null) return true;
  if (Array.isArray(val) || typeof val !== "object") return false;
  return Object.keys(val).every((k) => val[k] && String(val[k].id) === k);
}

// { "YYYY-MM": { revenue, profit, bills } } for a list (or map) of sales.
export function monthlyTotals(sales) {
  const out = {};
  const list = Array.isArray(sales) ? sales : Object.values(sales || {});
  for (const s of list) {
    const k = String((s && s.date) || "").slice(0, 7);
    if (k.length !== 7) continue;
    const t = out[k] || (out[k] = { revenue: 0, profit: 0, bills: 0 });
    t.revenue += Number(s.total) || 0;
    t.profit += Number(s.profit) || 0;
    t.bills += 1;
  }
  return out;
}

// Monthly totals for the given month keys: months the loaded sales cover (>= `coverFrom`, or all
// when it is null) are computed from the sales; earlier months come from the saved summary.
export function mergeMonthly(keys, sales, olderMonthly, coverFrom) {
  const live = monthlyTotals(sales);
  const cover = coverFrom ? coverFrom.slice(0, 7) : "";
  const zero = { revenue: 0, profit: 0, bills: 0 };
  const out = {};
  for (const k of keys) out[k] = (k >= cover ? live[k] : (olderMonthly || {})[k]) || zero;
  return out;
}
