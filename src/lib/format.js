import { CURRENCY } from "../config/currency.js";

// ---------- helpers ----------
// Format money with the shop's configured currency symbol (defaults to ₹).
export const INR = (n) =>
  CURRENCY.symbol + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
// Round money to 2 decimals so bill totals don't drift (e.g. 0.1 + 0.2 = 0.30000004).
// A non-numeric input collapses to 0 rather than poisoning a total with NaN.
export const money = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round((v + Number.EPSILON) * 100) / 100 : 0;
};
// Local calendar date as YYYY-MM-DD. MUST be local, not toISOString() (which is UTC)
// — otherwise early-morning sales in IST get filed under the previous day.
export const dateStr = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const todayStr = () => dateStr(new Date());
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
