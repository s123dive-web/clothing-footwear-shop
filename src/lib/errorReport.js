// Error reports the owner can read from another device: crashes (ErrorBoundary, uncaught
// errors) and sync failures are written to shop/meta/errors/<id>, newest ERRORS_KEEP kept.
// The record-building and trimming logic is pure; `createReporter` wires it to a writer.
export const ERRORS_KEEP = 50;
const MAX_PER_SESSION = 15;
const SAME_WITHIN_MS = 60000;
const cut = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) + "…" : t;
};

// → the record stored for one error. Never contains shop data, only what went wrong and where.
export function buildReport(
  kind,
  error,
  extra = {},
  { now = Date.now(), device = "", user = "", version = "" } = {}
) {
  const e = error && typeof error === "object" ? error : { message: String(error) };
  const rec = {
    at: now,
    kind, // "crash" | "sync"
    message: cut(e.code ? `${e.code}: ${e.message || ""}` : e.message || String(error), 500),
    device: cut(device, 160),
  };
  if (e.stack) rec.stack = cut(e.stack, 2000);
  if (user) rec.user = cut(user, 120);
  if (version) rec.version = cut(version, 40);
  for (const [k, v] of Object.entries(extra || {})) if (v != null && v !== "") rec[k] = cut(v, 600);
  return rec;
}

// ids to delete so that only the newest `keep` reports remain.
export function trimPlan(reports, keep = ERRORS_KEEP) {
  const ids = Object.keys(reports || {}).sort(
    (a, b) => (reports[b].at || 0) - (reports[a].at || 0)
  );
  return ids.slice(keep);
}

// write(id, record) → Promise. Returns report(kind, error, extra): fire-and-forget, throttled,
// de-duplicated, and it never throws (an error reporter must not cause errors).
export function createReporter({ write, context = () => ({}), newId, now = () => Date.now() }) {
  let sent = 0;
  const recent = new Map(); // message → last time
  return function report(kind, error, extra) {
    try {
      const rec = buildReport(kind, error, extra, { now: now(), ...context() });
      const key = kind + "|" + rec.message;
      if (sent >= MAX_PER_SESSION) return false;
      if (recent.has(key) && rec.at - recent.get(key) < SAME_WITHIN_MS) return false;
      recent.set(key, rec.at);
      sent += 1;
      Promise.resolve(write(newId(), rec)).catch(() => {});
      return true;
    } catch {
      return false;
    }
  };
}
