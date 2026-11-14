// What to tell the shopkeeper about syncing — from the connection state and the outbox.
// Pure, so the wording is unit-tested.
const BILL_LABELS = new Set(["sale", "sale-edit", "sale-delete"]);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// → { tone: "ok" | "pending" | "offline" | "error", text, short, bills, others, failed }
export function syncSummary(online, ops = []) {
  const bills = ops.filter((o) => BILL_LABELS.has(o.label)).length;
  const others = ops.length - bills;
  const failed = ops.filter((o) => o.error).length;
  const what =
    bills && others
      ? `${plural(bills, "bill")} + ${plural(others, "other change")}`
      : bills
        ? plural(bills, "bill")
        : plural(others, "change");
  const base = { bills, others, failed };

  if (!online) {
    return ops.length
      ? {
          ...base,
          tone: "offline",
          text: `Offline · ${what} waiting to sync`,
          short: `${ops.length} waiting`,
        }
      : { ...base, tone: "offline", text: "Offline · saved on this device", short: "Offline" };
  }
  if (failed) {
    return {
      ...base,
      tone: "error",
      text: `${plural(failed, "change")} not synced — tap to retry`,
      short: `${failed} not synced`,
    };
  }
  if (ops.length) {
    return {
      ...base,
      tone: "pending",
      text: `Online · syncing ${what}…`,
      short: `Syncing ${ops.length}`,
    };
  }
  return { ...base, tone: "ok", text: "Online · syncing live", short: "Synced" };
}
