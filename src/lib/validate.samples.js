// Sample records used by BOTH validate.test.js (the JavaScript checks) and e2e/rules.spec.js
// (the real `.validate` rules in the emulator), so the two can never drift apart unnoticed.
const line = {
  name: "Kurti",
  qty: 2,
  price: 500,
  buyPrice: 300,
  amount: 1000,
  size: "M",
  color: "Red",
  productId: "p1",
  variantId: "v1",
};

export const VALID_SALES = [
  {
    id: "a1",
    date: "2026-11-14",
    time: "10:00 am",
    lines: [line],
    total: 1000,
    profit: 400,
    payment: "UPI",
  },
  // credit bill with part payment and a repayment ledger
  {
    id: "a2",
    date: "2026-11-14",
    time: "11:00 am",
    lines: [line],
    total: 1000,
    profit: 400,
    payment: "Udhari",
    customer: "Asha",
    mobile: "9876543210",
    paid: 300,
    paidMode: "Cash",
    payments: [{ id: "x", date: "2026-11-15", time: "9:00 am", amount: 100, mode: "UPI" }],
  },
  // discount
  {
    id: "a3",
    date: "2026-11-14",
    time: "12:00 pm",
    lines: [line],
    subtotal: 1000,
    discount: 100,
    discountPct: 10,
    total: 900,
    profit: 300,
    payment: "Cash",
  },
  // misc line, zero-value bill, legacy bill without buyPrice
  {
    id: "a4",
    date: "2026-05-01",
    time: "x",
    lines: [{ name: "Misc item", qty: 1, price: 0, amount: 0, misc: true }],
    total: 0,
    profit: 0,
    payment: "Cash",
  },
  // split bill: fractional quantities
  {
    id: "a5",
    date: "2026-11-13",
    time: "10:00 am (split 1/2)",
    lines: [{ ...line, qty: 0.5, amount: 250 }],
    total: 250,
    profit: 100,
    payment: "UPI",
  },
  // return bill (feature "returns"): negative totals and quantities
  {
    id: "a6",
    type: "return",
    refOf: "a1",
    date: "2026-11-14",
    time: "1:00 pm (return)",
    lines: [{ ...line, qty: -1, amount: -500 }],
    total: -500,
    profit: -200,
    payment: "Cash",
  },
  // numbered bill, exchange credit, GST line
  {
    id: "a7",
    date: "2026-11-14",
    time: "2:00 pm",
    lines: [{ ...line, gstRate: 5, hsn: "6204", returned: 1 }],
    total: 1000,
    profit: 400,
    payment: "Cash",
    billNo: "2026-27/0007",
    createdAt: 1794641038904,
    creditUsed: 500,
    creditOf: "a6",
  },
  // a legacy record whose id was stored as a number
  {
    id: 7,
    date: "2026-06-01",
    time: "x",
    lines: [line],
    total: 1000,
    profit: 400,
    payment: "Cash",
  },
];

export const INVALID_SALES = [
  { date: "2026-11-14", total: 1000, lines: [line] }, // no id
  { id: "b2", total: 1000, lines: [line] }, // no date
  { id: "b3", date: "14-11-2026", total: 1000, lines: [line] }, // wrong date format
  { id: "b4", date: "2026-11-14", lines: [line] }, // no total
  { id: "b5", date: "2026-11-14", total: "1000", lines: [line] }, // total as text
  { id: "b6", date: "2026-11-14", total: 1000, profit: "400", lines: [line] }, // profit as text
  { id: "b7", date: "2026-11-14", total: 1000, paid: -5, lines: [line] }, // negative paid
  { id: "b8", date: "2026-11-14", total: 1000, lines: [{ ...line, qty: "2" }] }, // qty as text
  { id: "b9", date: "2026-11-14", total: 1000, lines: [{ ...line, amount: "1000" }] }, // amount as text
  { id: "b10", date: "2026-11-14", total: 1000, discount: -1, lines: [line] }, // negative discount
];

const variant = { id: "v1", size: "M", color: "Red", sku: "", stockQty: 5, lowAt: 2 };
export const VALID_ITEMS = [
  {
    id: "p1",
    name: "Kurti",
    brand: "",
    category: "Clothing",
    subcategory: "Kurtis",
    code: "",
    purchasePrice: 300,
    sellingPrice: 500,
    mrp: 500,
    discountPct: 0,
    supplier: "",
    imageUrl: "",
    notes: "",
    icon: "👚",
    variants: [variant, { ...variant, id: "v2", size: "L", stockQty: 0 }],
    stock: 5,
    createdAt: "2026-11-14",
    updatedAt: "2026-11-14",
    version: 2,
  },
  // ledger of applied stock ops, GST details
  {
    id: "p2",
    name: "Saree",
    sellingPrice: 900,
    purchasePrice: 0,
    variants: [variant],
    stock: 5,
    appliedOps: { op1: 1794641038904 },
    hsn: "5407",
    gstRate: 5,
  },
  // legacy product: flat stock, no variants
  { id: "p3", name: "Old clip", sellingPrice: 20, stock: 12 },
];

export const INVALID_ITEMS = [
  {
    id: "q1",
    name: "Kurti",
    sellingPrice: 500,
    variants: [{ ...variant, stockQty: -1 }],
    stock: 0,
  }, // negative stock
  {
    id: "q2",
    name: "Kurti",
    sellingPrice: 500,
    variants: [{ ...variant, stockQty: "5" }],
    stock: 5,
  }, // stock as text
  { id: "q3", name: "Kurti", sellingPrice: "500", variants: [variant], stock: 5 }, // price as text
  { id: "q4", sellingPrice: 500, variants: [variant], stock: 5 }, // no name
  { name: "Kurti", sellingPrice: 500, variants: [variant], stock: 5 }, // no id
  { id: "q6", name: "Kurti", sellingPrice: 500, variants: [variant], stock: -3 }, // negative cached stock
  { id: "q7", name: "Kurti", purchasePrice: -1, sellingPrice: 500, variants: [variant], stock: 5 }, // negative cost
];
