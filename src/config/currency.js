// Shared, mutable currency symbol so both the React app and the pure stats helpers
// format money with the shop's configured symbol without threading it through every call.
// The shop-config subscription calls setCurrencySymbol() once config loads; until then it
// defaults to the Indian Rupee (₹), which is the common case for this app.
export const CURRENCY = { symbol: "₹" };

export const setCurrencySymbol = (s) => {
  const t = (s == null ? "" : String(s)).trim();
  CURRENCY.symbol = t || "₹";
};
