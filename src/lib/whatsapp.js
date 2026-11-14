// "Send on WhatsApp": a wa.me link with a plain-text bill. No API key, nothing is sent by the
// app itself — the link opens WhatsApp with the message ready and the shopkeeper presses send.
import { billNoText } from "./billNumbers.js";

const identity = (key, vars) =>
  vars ? key.replace(/\{(\w+)\}/g, (m, n) => (n in vars ? String(vars[n]) : m)) : key;

// Indian mobile → the digits wa.me wants ("919876543210"), or "" if it does not look like one.
export function waNumber(mobile) {
  let d = String(mobile || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? "91" + d : "";
}

// With no (valid) mobile the link opens WhatsApp's contact picker instead.
export function waLink(mobile, text) {
  const n = waNumber(mobile);
  return `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
}

export function receiptText(sale, config, { t = identity, money = (n) => String(n) } = {}) {
  const out = [];
  out.push(`*${config.name}*`);
  if (config.address) out.push(config.address);
  if (config.phone) out.push(`☎ ${config.phone}`);
  if (config.gstin) out.push(`GSTIN: ${config.gstin}`);
  const no = billNoText(sale);
  out.push(
    `${sale.date} ${sale.time || ""}`.trim() + (no ? ` · ${t("Bill no: {no}", { no })}` : "")
  );
  out.push("");
  for (const l of sale.lines || []) {
    const v = [l.size ? t("Size {size}", { size: l.size }) : "", l.color || ""]
      .filter(Boolean)
      .join(" · ");
    out.push(`${l.name}${v ? ` (${v})` : ""} × ${l.qty} = ${money(l.amount)}`);
  }
  out.push("");
  if (sale.discount > 0) {
    out.push(
      `${t("Subtotal")}: ${money(sale.subtotal != null ? sale.subtotal : (sale.total || 0) + sale.discount)}`
    );
    out.push(`${t("Discount")}: −${money(sale.discount)}`);
  }
  out.push(`*${t("TOTAL")}: ${money(sale.total)}*`);
  if (sale.payment) out.push(t("Paid via {mode}", { mode: t(sale.payment) }));
  if (sale.payment === "Udhari") {
    out.push(t("Paid now: {amount}", { amount: money(sale.paid || 0) }));
    out.push(
      t("Balance due: {amount}", {
        amount: money(Math.max(0, (sale.total || 0) - (sale.paid || 0))),
      })
    );
  }
  if (config.upiId) out.push(`UPI: ${config.upiId}`);
  if (config.receiptFooter) out.push("", config.receiptFooter);
  return out.join("\n");
}
