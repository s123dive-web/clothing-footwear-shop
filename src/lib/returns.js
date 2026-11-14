// Returns & exchange (feature "returns"). Pure.
//
// A return is stored as its own bill in shop/sales — `type: "return"`, `refOf: <original id>`,
// lines with NEGATIVE qty and amount, and a negative total/profit. Because every report sums
// `total`, `profit` and line quantities, returns net themselves off everywhere without the
// reports needing to know about them. The original bill's lines get an optional `returned`
// count so the same unit cannot be returned twice.
const num = (v) => Number(v) || 0;
const r2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

export const isReturn = (s) => !!s && s.type === "return";
export const returnableQty = (l) => Math.max(0, num(l.qty) - num(l.returned));
export const hasReturns = (s) => ((s && s.lines) || []).some((l) => num(l.returned) > 0);
export const canReturn = (s) =>
  !!s && !isReturn(s) && (s.lines || []).some((l) => returnableQty(l) > 0);

// What the customer actually paid per unit of a line, after the bill-level discount.
export function unitPaid(orig, line) {
  const gross = (orig.lines || []).reduce((a, l) => a + num(l.amount), 0);
  const factor = gross > 0 ? (gross - Math.min(num(orig.discount), gross)) / gross : 1;
  return num(line.qty) ? (num(line.amount) / num(line.qty)) * factor : 0;
}

// picks: { <line index>: <qty to return> }. mode: "Cash" | "UPI" | "Credit" (credit against a
// new bill). Returns { ret, lines, refund } or throws if nothing valid was picked.
export function buildReturn(orig, picks, { id, date, time, mode }) {
  const lines = [];
  let refund = 0;
  let profit = 0;
  const newLines = (orig.lines || []).map((l, i) => {
    const q = Math.min(Math.max(0, Math.floor(num(picks[i]))), returnableQty(l));
    if (!q) return l;
    const amount = r2(unitPaid(orig, l) * q);
    refund += amount;
    profit += amount - num(l.buyPrice) * q;
    const keep = {};
    for (const k of [
      "name",
      "price",
      "buyPrice",
      "size",
      "color",
      "category",
      "subcategory",
      "productId",
      "variantId",
      "misc",
      "gstRate",
      "hsn",
    ])
      if (l[k] !== undefined) keep[k] = l[k];
    lines.push({ ...keep, qty: -q, amount: -amount });
    return { ...l, returned: num(l.returned) + q };
  });
  if (!lines.length) throw new Error("Nothing to return.");
  const ret = {
    id,
    type: "return",
    refOf: orig.id,
    date,
    time: `${time} (return)`,
    lines,
    total: -r2(refund),
    profit: -r2(profit),
    payment: mode,
    ...(orig.customer ? { customer: orig.customer } : {}),
    ...(orig.mobile ? { mobile: orig.mobile } : {}),
    ...(orig.billNo ? { refBillNo: orig.billNo } : {}),
  };
  return { ret, lines: newLines, refund: r2(refund) };
}

// Exchange credit applied to a new bill: never more than the bill, never more than the credit.
export const creditToUse = (credit, billTotal) =>
  r2(Math.max(0, Math.min(num(credit), num(billTotal))));
