import { describe, it, expect } from "vitest";
import { waNumber, waLink, receiptText } from "./whatsapp.js";

describe("waNumber", () => {
  it("accepts the usual ways a 10-digit Indian mobile is typed", () => {
    for (const m of [
      "9876543210",
      "+91 98765 43210",
      "098765-43210",
      "919876543210",
      " 98765 43210 ",
    ])
      expect(waNumber(m)).toBe("919876543210");
  });
  it("rejects anything that is not a mobile number", () => {
    for (const m of ["", null, "12345", "1234567890", "98765432101234", "abc"])
      expect(waNumber(m)).toBe("");
  });
});

describe("waLink", () => {
  it("builds https://wa.me/91<mobile>?text=…, url-encoded", () => {
    expect(waLink("98765 43210", "Total: ₹500\nThanks & visit again")).toBe(
      "https://wa.me/919876543210?text=Total%3A%20%E2%82%B9500%0AThanks%20%26%20visit%20again"
    );
  });
  it("opens the contact picker when there is no usable number", () => {
    expect(waLink("", "hi")).toBe("https://wa.me/?text=hi");
  });
});

describe("receiptText", () => {
  const config = {
    name: "Vijay Shop",
    address: "Main Road",
    phone: "02012345",
    gstin: "",
    upiId: "shop@upi",
    receiptFooter: "Thank you!",
  };
  const sale = {
    id: "s1",
    date: "2026-11-14",
    time: "10:30 am",
    billNo: "2026-27/0042",
    payment: "Udhari",
    paid: 300,
    subtotal: 1100,
    discount: 100,
    total: 1000,
    lines: [
      { name: "Kurti", qty: 2, amount: 1000, size: "M", color: "Red" },
      { name: "Bag", qty: 1, amount: 100 },
    ],
  };
  const money = (n) => "₹" + n;
  it("is a readable plain-text bill with shop, lines, totals and balance", () => {
    expect(receiptText(sale, config, { money })).toBe(
      [
        "*Vijay Shop*",
        "Main Road",
        "☎ 02012345",
        "2026-11-14 10:30 am · Bill no: 2026-27/0042",
        "",
        "Kurti (Size M · Red) × 2 = ₹1000",
        "Bag × 1 = ₹100",
        "",
        "Subtotal: ₹1100",
        "Discount: −₹100",
        "*TOTAL: ₹1000*",
        "Paid via Udhari",
        "Paid now: ₹300",
        "Balance due: ₹700",
        "UPI: shop@upi",
        "",
        "Thank you!",
      ].join("\n")
    );
  });
  it("omits optional parts that are not there", () => {
    const text = receiptText(
      {
        date: "2026-11-14",
        total: 50,
        payment: "Cash",
        lines: [{ name: "Clip", qty: 1, amount: 50 }],
      },
      { name: "Shop" },
      { money }
    );
    expect(text).toBe("*Shop*\n2026-11-14\n\nClip × 1 = ₹50\n\n*TOTAL: ₹50*\nPaid via Cash");
  });
});
