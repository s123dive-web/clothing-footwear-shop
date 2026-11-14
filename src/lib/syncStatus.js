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

// The same message in the selected language. `t` is the i18n translate function.
export function syncText(sum, t) {
  const n = (count, one, many) => t(count === 1 ? one : many, { n: count });
  const bills = sum.bills ? n(sum.bills, "{n} bill", "{n} bills") : "";
  const what =
    sum.bills && sum.others
      ? t("{a} + {b}", { a: bills, b: n(sum.others, "{n} other change", "{n} other changes") })
      : sum.bills
        ? bills
        : n(sum.others, "{n} change", "{n} changes");
  if (sum.tone === "ok") return t("Online · syncing live");
  if (sum.tone === "offline")
    return sum.bills + sum.others
      ? t("Offline · {what} waiting to sync", { what })
      : t("Offline · saved on this device");
  if (sum.tone === "error")
    return t("{what} not synced — tap to retry", {
      what: n(sum.failed, "{n} change", "{n} changes"),
    });
  return t("Online · syncing {what}…", { what });
}
