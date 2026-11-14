// GST on a bill (feature "gstInvoice"). Shelf prices are TAX-INCLUSIVE, so the tax is split
// OUT of what the customer paid: taxable = amount ÷ (1 + rate), tax = amount − taxable, and for
// a sale within the state the tax is half CGST, half SGST. Pure.
const num = (v) => Number(v) || 0;
const r2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

export const GST_RATES = [0, 5, 12, 18, 28];

// → { rows: [{ rate, taxable, cgst, sgst, tax, total }], taxable, cgst, sgst, tax, total, hasGst }
// One row per GST rate present on the bill (highest first). A bill-level discount is spread
// over the lines in proportion to their amounts before the tax is worked out. Each row's
// taxable + cgst + sgst adds up to exactly what was paid for that rate.
export function gstSplit(sale) {
  const lines = (sale && sale.lines) || [];
  const gross = lines.reduce((a, l) => a + num(l.amount), 0);
  const discount = Math.min(Math.max(0, num(sale && sale.discount)), Math.max(0, gross));
  const factor = gross > 0 ? (gross - discount) / gross : 1;
  const by = new Map();
  for (const l of lines) {
    const rate = num(l.gstRate);
    by.set(rate, (by.get(rate) || 0) + num(l.amount) * factor);
  }
  const rows = [...by.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([rate, paid]) => {
      const total = r2(paid);
      const taxable = r2(total / (1 + rate / 100));
      const tax = r2(total - taxable);
      const cgst = r2(tax / 2);
      const sgst = r2(tax - cgst); // the odd paisa goes to SGST so the two always sum to `tax`
      return { rate, taxable, cgst, sgst, tax, total };
    });
  const sum = (k) => r2(rows.reduce((a, r) => a + r[k], 0));
  return {
    rows,
    taxable: sum("taxable"),
    cgst: sum("cgst"),
    sgst: sum("sgst"),
    tax: sum("tax"),
    total: sum("total"),
    hasGst: rows.some((r) => r.rate > 0),
  };
}

// A GST invoice is printed only when the shop has a GSTIN and the bill has a taxed line.
export const isGstInvoice = (sale, config) =>
  !!(config && String(config.gstin || "").trim()) &&
  ((sale && sale.lines) || []).some((l) => num(l.gstRate) > 0);
