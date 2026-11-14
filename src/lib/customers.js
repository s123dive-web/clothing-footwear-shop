// Customer ledger: everything known about each named customer, from the bills. Pure.
const num = (v) => Number(v) || 0;
const r2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;
export const customerKey = (name) =>
  String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
export const outstandingOfSale = (s) =>
  s.payment === "Udhari" ? Math.max(0, r2(num(s.total) - num(s.paid))) : 0;

// → [{ key, name, mobile, bills, total, outstanding, lastDate, sales: [...] }]
// Biggest outstanding first, then most recent. Bills without a customer name are not listed.
export function customerLedger(sales) {
  const by = new Map();
  for (const s of sales || []) {
    const key = customerKey(s.customer);
    if (!key) continue;
    let c = by.get(key);
    if (!c)
      by.set(
        key,
        (c = {
          key,
          name: s.customer.trim(),
          mobile: "",
          bills: 0,
          total: 0,
          outstanding: 0,
          lastDate: "",
          sales: [],
        })
      );
    c.bills += 1;
    c.total += num(s.total);
    c.outstanding += outstandingOfSale(s);
    if ((s.date || "") >= c.lastDate) {
      c.lastDate = s.date || "";
      c.name = s.customer.trim(); // latest spelling
      if ((s.mobile || "").trim()) c.mobile = s.mobile.trim();
    } else if (!c.mobile && (s.mobile || "").trim()) c.mobile = s.mobile.trim();
    c.sales.push(s);
  }
  const out = [...by.values()];
  for (const c of out) {
    c.total = r2(c.total);
    c.outstanding = r2(c.outstanding);
    c.sales.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }
  return out.sort((a, b) => b.outstanding - a.outstanding || (a.lastDate < b.lastDate ? 1 : -1));
}

// The WhatsApp payment reminder for a customer with outstanding credit.
export function reminderText(customer, { shop = "", upiId = "", money = (n) => String(n) } = {}) {
  const due = customer.sales.filter((s) => outstandingOfSale(s) > 0);
  const lines = [
    `Namaste ${customer.name},`,
    `This is a gentle reminder from ${shop || "our shop"}.`,
    `Your outstanding balance is *${money(customer.outstanding)}*` +
      (due.length
        ? ` (${due.length} bill${due.length === 1 ? "" : "s"}, oldest ${due[due.length - 1].date}).`
        : "."),
  ];
  if (upiId) lines.push(`You can pay by UPI: ${upiId}`);
  lines.push("Thank you! 🙏");
  return lines.join("\n");
}
