// Day close: what the shop took today, by how it was paid, and how much cash should be in
// the drawer. Pure — the screen (screens/DayClose.jsx) only displays this.
const num = (v) => Number(v) || 0;
const r2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

// Money actually received for one Udhari bill, as [{ date, amount, mode }]: the part paid at
// billing (dated with the bill) and every later repayment from its `payments` ledger.
export function udhariReceipts(sale) {
  const ledger = Array.isArray(sale.payments) ? sale.payments : [];
  const later = ledger.reduce((a, p) => a + num(p.amount), 0);
  const atBilling = Math.max(0, r2(num(sale.paid) - later));
  const out = [];
  if (atBilling > 0)
    out.push({
      date: sale.date,
      amount: atBilling,
      // `paidMode` is overwritten by later repayments; with a ledger the original mode is not
      // recorded, so cash is assumed.
      mode: ledger.length ? "Cash" : sale.paidMode || "Cash",
    });
  for (const p of ledger)
    out.push({ date: p.date || sale.date, amount: num(p.amount), mode: p.mode || "Cash" });
  return out;
}

export function dayTotals(sales, expenses, date) {
  const t = {
    date,
    bills: 0,
    revenue: 0, // everything billed today (incl. credit)
    cashSales: 0, // Cash bills
    upiSales: 0, // UPI bills
    udhariBilled: 0, // credit bills made today (full value)
    udhariCashIn: 0, // credit collected today in cash (today's bills + old bills repaid today)
    udhariUpiIn: 0,
    creditUsed: 0, // exchange credit applied to today's bills (no money changed hands)
    expenses: 0,
  };
  for (const s of sales || []) {
    if (s.date === date) {
      t.bills += 1;
      t.revenue += num(s.total);
      const net = num(s.total) - num(s.creditUsed);
      t.creditUsed += num(s.creditUsed);
      if (s.payment === "Cash") t.cashSales += net;
      else if (s.payment === "UPI") t.upiSales += net;
      else if (s.payment === "Udhari") t.udhariBilled += num(s.total);
    }
    if (s.payment === "Udhari") {
      for (const p of udhariReceipts(s)) {
        if (p.date !== date) continue;
        if (p.mode === "UPI") t.udhariUpiIn += p.amount;
        else t.udhariCashIn += p.amount;
      }
    }
  }
  for (const e of expenses || []) if (e.date === date) t.expenses += num(e.amount);
  for (const k of Object.keys(t)) if (typeof t[k] === "number" && k !== "bills") t[k] = r2(t[k]);
  t.cashIn = r2(t.cashSales + t.udhariCashIn);
  t.upiIn = r2(t.upiSales + t.udhariUpiIn);
  t.udhariOutstandingToday = r2(t.udhariBilled - 0); // informational: credit given today
  return t;
}

// Cash that should be in the drawer: opening float + cash received − expenses paid from it.
export function expectedCash(totals, { opening = 0, expensesFromDrawer = true } = {}) {
  return r2(num(opening) + totals.cashIn - (expensesFromDrawer ? totals.expenses : 0));
}

export function closeSummaryText(totals, close, { shop = "", money = (n) => String(n) } = {}) {
  const lines = [
    `*${shop ? shop + " — " : ""}Day close ${totals.date}*`,
    `Bills: ${totals.bills} · Billed: ${money(totals.revenue)}`,
    `Cash: ${money(totals.cashIn)} · UPI: ${money(totals.upiIn)}`,
    `Udhari given: ${money(totals.udhariBilled)}`,
    `Expenses: ${money(totals.expenses)}`,
  ];
  if (close) {
    lines.push(`Expected cash: ${money(close.expected)}`);
    if (close.counted != null) {
      const d = r2(close.counted - close.expected);
      lines.push(`Counted cash: ${money(close.counted)}`);
      lines.push(
        d === 0 ? "Cash matches ✅" : d > 0 ? `Over by ${money(d)}` : `Short by ${money(-d)}`
      );
    }
  }
  return lines.join("\n");
}
