// Bill numbers: sequential per Indian financial year (1 April – 31 March), e.g. "2026-27/0001".
//
// The next number lives in the cloud at shop/meta/billCounters/<fy> and is handed out by a
// transaction, so two devices can never get the same number. A bill made offline carries a
// provisional number until the device is back online and the real one is allocated.
//
// Counter node shape: { next: <number to hand out next>, recent: { <saleId>: <n> } }
// `recent` makes allocation idempotent: asking again for the same bill returns the number it
// already got (no gap, no duplicate) even if the first answer was lost.

export const RECENT_KEEP = 60;

// "2026-11-14" → "2026-27";  "2027-03-31" → "2026-27";  "2027-04-01" → "2027-28"
export function fyLabel(date) {
  const [y, m] = String(date).split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export const formatBillNo = (fy, n) => `${fy}/${String(n).padStart(4, "0")}`;

// Shown on a bill that has not been numbered yet (made offline / number still in flight).
export const provisionalNo = (now = Date.now()) => "P-" + now.toString(36).toUpperCase().slice(-6);

// Transaction body. Returns { node, n }: the counter node to store and this bill's number.
export function allocateInCounter(node, saleId) {
  const cur = node && typeof node === "object" ? node : {};
  const recent = { ...(cur.recent || {}) };
  if (recent[saleId]) return { node: cur, n: recent[saleId], reused: true };
  const n = Math.max(1, Number(cur.next) || 1);
  recent[saleId] = n;
  // keep only the newest RECENT_KEEP allocations
  const ids = Object.keys(recent).sort((a, b) => recent[a] - recent[b]);
  for (const id of ids.slice(0, Math.max(0, ids.length - RECENT_KEEP))) delete recent[id];
  return { node: { next: n + 1, recent }, n, reused: false };
}

// Bills waiting for a real number, oldest first (so numbers follow the order bills were made).
export function unnumbered(sales) {
  return (sales || [])
    .filter((s) => s && s.billNoProv && !s.billNo)
    .sort(
      (a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id))
    );
}

// What to print / show for a bill: its number, a provisional one, or "".
export const billNoText = (s) =>
  s && s.billNo ? s.billNo : s && s.billNoProv ? `${s.billNoProv} (provisional)` : "";
