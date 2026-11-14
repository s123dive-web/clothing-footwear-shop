// Phase 4 features. Every one is OFF by default (src/config/features.js); these tests switch a
// feature on for the test browser only (enableFeatures) and check it, and first of all check
// that with nothing switched on the app shows none of them.
import { test, expect } from "@playwright/test";
import {
  resetEmulator,
  login,
  gotoTab,
  addProduct,
  addToCart,
  completeBtn,
  records,
  eventually,
  dbGet,
  dbPut,
  enableFeatures,
  receiptHtml,
  blockDatabase,
  unblockDatabase,
  todayStr,
} from "./helpers.js";

const KURTI = {
  name: "Feature Kurti",
  price: 500,
  cost: 300,
  variants: [
    { size: "M", color: "Red", stock: 9 },
    { size: "L", color: "Red", stock: 9 },
  ],
};
const fy = () => {
  const [y, m] = todayStr().split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
};

test.beforeEach(async () => {
  await resetEmulator();
});

async function shopWithProduct(page) {
  await login(page);
  await addProduct(page, KURTI);
  await gotoTab(page, "Billing (POS)");
}
async function sell(page, variant = "M · Red", qty = 1) {
  await addToCart(page, KURTI.name, variant, qty);
  await completeBtn(page).click();
  await expect(page.getByText(/Bill saved|Saved on this device/).last()).toBeVisible();
}

test("with no flag switched on, none of the Phase 4 features is visible or writes data", async ({
  page,
}) => {
  await shopWithProduct(page);
  await page.getByLabel("Mobile").fill("9876543210");
  await sell(page);
  await expect(page.getByText("Send on WhatsApp")).toHaveCount(0);
  const [sale] = await eventually(async () => {
    const s = await records("sales");
    expect(s).toHaveLength(1);
    return s;
  });
  expect(Object.keys(sale).sort()).toEqual(
    ["date", "id", "lines", "mobile", "payment", "profit", "time", "total"].sort()
  );
  expect(Object.keys(sale.lines[0]).sort()).toEqual(
    [
      "amount",
      "buyPrice",
      "category",
      "color",
      "name",
      "price",
      "productId",
      "qty",
      "size",
      "subcategory",
      "variantId",
    ].sort()
  );
  const nav = page.locator("nav.nav");
  for (const tab of ["Day Close", "Customers", "Restock"])
    await expect(nav.getByRole("button", { name: tab })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "📷 Scan barcode" })).toHaveCount(0);
  await expect(page.getByText(/Exchange credit/)).toHaveCount(0);
  await gotoTab(page, "Sales History");
  await page
    .locator("main div")
    .filter({ hasText: /·\s*1 item/ })
    .last()
    .click();
  await expect(page.getByRole("button", { name: "↩ Return / exchange" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /WhatsApp/ })).toHaveCount(0);
  await gotoTab(page, "Inventory");
  await expect(page.getByRole("button", { name: "🏷 Labels" })).toHaveCount(0);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByLabel("HSN code")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByText(/Last backup/)).toHaveCount(0);
  await gotoTab(page, "Settings");
  await expect(page.getByText("Payment & receipt paper")).toHaveCount(0);
  await gotoTab(page, "Admin");
  await expect(page.getByText("Staff accounts")).toHaveCount(0);
  expect(await dbGet("shop/meta")).toEqual({ seeded: true });
  expect(await dbGet("shop/users")).toBeNull();
  expect(await dbGet("shop/dayCloses")).toBeNull();
});

test("paymentSettings: UPI ID and paper width are saved and used on the receipt", async ({
  page,
}) => {
  await enableFeatures(page, ["paymentSettings"]);
  await shopWithProduct(page);
  await gotoTab(page, "Settings");
  await page.getByLabel("UPI ID (printed under the QR)").fill("vijayshop@upi");
  await page.getByLabel("Receipt paper width").selectOption("58");
  await page.getByRole("button", { name: /Save/ }).first().click();
  await expect(page.getByText("Settings saved")).toBeVisible();
  await eventually(async () =>
    expect(await dbGet("shop/shopConfig")).toMatchObject({
      upiId: "vijayshop@upi",
      receiptWidth: 58,
    })
  );

  await gotoTab(page, "Billing (POS)");
  await sell(page);
  const html = await receiptHtml(page, () =>
    page.getByRole("button", { name: /Print last receipt/ }).click()
  );
  expect(html).toContain("vijayshop@upi");
  expect(html).toContain("@page{size:58mm auto");
});

test("billNumbers: sequential per financial year, printed, searchable", async ({ page }) => {
  await enableFeatures(page, ["billNumbers"]);
  await shopWithProduct(page);
  await sell(page);
  await sell(page, "L · Red");
  await eventually(async () => {
    const nos = (await records("sales")).map((s) => s.billNo).sort();
    expect(nos).toEqual([`${fy()}/0001`, `${fy()}/0002`]);
  });
  const sales = await records("sales");
  expect(sales.every((s) => !("billNoProv" in s))).toBe(true);
  expect((await dbGet(`shop/meta/billCounters/${fy()}`)).next).toBe(3);

  const html = await receiptHtml(page, () =>
    page.getByRole("button", { name: /Print last receipt/ }).click()
  );
  expect(html).toContain(`Bill no: ${fy()}/0002`);

  await gotoTab(page, "Sales History");
  await expect(page.getByText(`#${fy()}/0001`)).toBeVisible();
  await page.getByPlaceholder(/Search bills/).fill(`${fy()}/0002`);
  await expect(page.getByText(`#${fy()}/0002`)).toBeVisible();
  await expect(page.getByText(`#${fy()}/0001`)).toHaveCount(0);
});

test("billNumbers: an offline bill is provisional, then gets the next real number", async ({
  page,
}) => {
  await enableFeatures(page, ["billNumbers"]);
  await shopWithProduct(page);
  await sell(page); // 0001, online
  await eventually(async () => expect((await records("sales"))[0].billNo).toBe(`${fy()}/0001`));

  await page.waitForTimeout(1000);
  await blockDatabase(page);
  await page.reload();
  await gotoTab(page, "Billing (POS)");
  await sell(page, "L · Red");
  const html = await receiptHtml(page, () =>
    page.getByRole("button", { name: /Print last receipt/ }).click()
  );
  expect(html).toMatch(/Bill no: P-[0-9A-Z]{6} \(provisional\)/);

  await unblockDatabase(page);
  await page.reload();
  await eventually(async () => {
    const nos = (await records("sales")).map((s) => s.billNo).sort();
    expect(nos).toEqual([`${fy()}/0001`, `${fy()}/0002`]);
  });
});

test("whatsappReceipt: a wa.me link with the plain-text bill", async ({ page }) => {
  await enableFeatures(page, ["whatsappReceipt"]);
  await shopWithProduct(page);
  await page.getByLabel("Mobile").fill("98765 43210");
  await sell(page, "M · Red", 2);
  const link = page.getByRole("link", { name: /Send on WhatsApp/ });
  await expect(link).toHaveAttribute("target", "_blank");
  const href = await link.getAttribute("href");
  expect(href.startsWith("https://wa.me/919876543210?text=")).toBe(true);
  const text = decodeURIComponent(href.split("?text=")[1]);
  expect(text).toContain(`${KURTI.name} (Size M · Red) × 2 = ₹1,000`);
  expect(text).toContain("*TOTAL: ₹1,000*");
  expect(text).toContain("Paid via UPI");

  await gotoTab(page, "Sales History");
  await page
    .locator("main div")
    .filter({ hasText: /·\s*1 item/ })
    .last()
    .click();
  await expect(page.getByRole("link", { name: /WhatsApp/ })).toHaveAttribute(
    "href",
    /^https:\/\/wa\.me\/919876543210\?text=/
  );
});

test("dayClose: totals by payment mode, expected vs counted cash, saved and summarised", async ({
  page,
}) => {
  await enableFeatures(page, ["dayClose"]);
  await dbPut("shop/expenses/x1", { id: "x1", date: todayStr(), desc: "Tea", amount: 50 });
  await shopWithProduct(page);
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await sell(page, "M · Red", 2); // ₹1,000 cash
  await page.getByRole("button", { name: "UPI", exact: true }).click();
  await sell(page, "L · Red", 1); // ₹500 UPI
  await page.getByRole("button", { name: "Udhari", exact: true }).click();
  await page.getByLabel("Customer name").fill("Credit Lady");
  await page.getByLabel("Amount paid now").fill("200");
  await sell(page, "L · Red", 1); // ₹500 credit, ₹200 cash now

  await gotoTab(page, "Day Close");
  await expect(page.getByRole("heading", { level: 1, name: "Day Close" })).toBeVisible();
  const main = page.locator("main");
  await expect(main).toContainText("Cash received₹1,200"); // 1,000 + 200
  await expect(main).toContainText("UPI received₹500");
  await expect(main).toContainText("Udhari given₹500");
  await page.getByLabel("Opening cash (float)").fill("300");
  // expected = 300 + 1,200 − 50 expenses
  await expect(main).toContainText("Expected in drawer₹1,450");
  await page.getByLabel("Cash counted").fill("1400");
  await expect(page.getByRole("status").filter({ hasText: "Short by ₹50" })).toBeVisible();
  await page.getByRole("button", { name: "Close the day" }).click();
  await expect(page.getByText(/Day closed — short by ₹50/)).toBeVisible();
  await eventually(async () =>
    expect(await dbGet("shop/dayCloses/" + todayStr())).toMatchObject({
      date: todayStr(),
      opening: 300,
      expected: 1450,
      counted: 1400,
      diff: -50,
    })
  );
  await expect(page.getByLabel("Daily summary text")).toContainText("Short by ₹50");
  await expect(page.getByRole("link", { name: /Send on WhatsApp/ })).toHaveAttribute(
    "href",
    /^https:\/\/wa\.me\/\?text=/
  );
  // A second device opening the same day sees the saved close.
  await page.reload();
  await gotoTab(page, "Day Close");
  await expect(page.getByLabel("Cash counted")).toHaveValue("1400");
  await expect(page.getByRole("button", { name: "Update day close" })).toBeVisible();
});

test("backupReminder: Dashboard says when the last backup was and offers one", async ({ page }) => {
  await enableFeatures(page, ["backupReminder"]);
  await dbPut("shop/meta/lastBackupAt", Date.now() - 9 * 86400000);
  await login(page);
  await expect(page.getByText(/Last backup: 9 days ago — weekly backup is due/)).toBeVisible();
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Back up now" }).click();
  await dl;
  await expect(page.getByText("💾 Last backup: today")).toBeVisible();
  expect(Date.now() - (await dbGet("shop/meta/lastBackupAt"))).toBeLessThan(60000);
});

test("customerLedger: purchases, outstanding and a WhatsApp reminder per customer", async ({
  page,
}) => {
  await enableFeatures(page, ["customerLedger"]);
  await shopWithProduct(page);
  await page.getByRole("button", { name: "Udhari", exact: true }).click();
  await page.getByLabel("Customer name").fill("Meena Tai");
  await page.getByLabel("Mobile").fill("9876543210");
  await page.getByLabel("Amount paid now").fill("100");
  await sell(page, "M · Red", 2); // ₹1,000, ₹900 due
  // (in Udhari mode there are two "Cash" buttons — the first is the payment mode)
  await page.getByRole("button", { name: "Cash", exact: true }).first().click();
  await page.getByLabel("Customer name").fill("meena tai");
  await sell(page, "L · Red", 1); // ₹500 cash, same customer (different capitalisation)

  await gotoTab(page, "Customers");
  const main = page.locator("main");
  await expect(main).toContainText("Outstanding₹900");
  const row = page.getByRole("button", { name: /meena tai/i });
  await expect(row).toContainText("2 bills");
  await expect(row).toContainText("₹1,500");
  await expect(row).toContainText("₹900 due");
  await row.click();
  const link = page.getByRole("link", { name: /Send payment reminder/ });
  const href = await link.getAttribute("href");
  expect(href.startsWith("https://wa.me/919876543210?text=")).toBe(true);
  expect(decodeURIComponent(href)).toContain("outstanding balance is *₹900*");
});

test("restockSuggestions: sell-through, days of stock left and a suggested order", async ({
  page,
}) => {
  await enableFeatures(page, ["restockSuggestions"]);
  await shopWithProduct(page);
  await sell(page, "M · Red", 6); // 9 → 3 left; 6 sold in 30 days = 0.2/day → 15 days left
  await gotoTab(page, "Restock");
  const row = page.getByRole("row", { name: /Feature Kurti.*M · Red/ });
  await expect(row).toContainText("fast");
  const cells = await row.getByRole("cell").allInnerTexts();
  expect(cells.slice(2)).toEqual(["3", "6", "0.2", "15", "+3"]); // stock, sold, /day, days, order
  await expect(page.getByText("M · 6 sold")).toBeVisible();
  await expect(page.getByRole("row", { name: /L · Red/ })).toHaveCount(0); // healthy, unsold
});

test("gstInvoice: HSN + rate per product, CGST/SGST split on the receipt when a GSTIN is set", async ({
  page,
}) => {
  await enableFeatures(page, ["gstInvoice"]);
  await dbPut("shop/shopConfig", { name: "GST Shop", gstin: "27ABCDE1234F1Z5" });
  await login(page);
  await addProduct(page, KURTI);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Edit product" });
  await form.getByLabel("HSN code").fill("6204");
  await form.getByLabel("GST rate (price includes GST)").selectOption("5");
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Product updated")).toBeVisible();
  await eventually(async () =>
    expect((await records("items"))[0]).toMatchObject({ hsn: "6204", gstRate: 5 })
  );

  await gotoTab(page, "Billing (POS)");
  await sell(page, "M · Red", 2); // ₹1,000 including 5% GST
  const [sale] = await eventually(async () => {
    const s = await records("sales");
    expect(s).toHaveLength(1);
    return s;
  });
  expect(sale.lines[0]).toMatchObject({ gstRate: 5, hsn: "6204", amount: 1000 });
  expect(sale.total).toBe(1000); // the customer pays the same — tax is inside the price

  const html = await receiptHtml(page, () =>
    page.getByRole("button", { name: /Print last receipt/ }).click()
  );
  expect(html).toContain("TAX INVOICE");
  expect(html).toContain("GSTIN: 27ABCDE1234F1Z5");
  expect(html).toContain("HSN 6204 · GST 5%");
  expect(html).toMatch(
    /<td>5%<\/td><td class="r">₹952\.38<\/td><td class="r">₹23\.81<\/td><td class="r">₹23\.81<\/td>/
  );
  expect(html).toContain("Prices include GST");
});

test("returns: refund a unit — stock comes back, a negative return bill nets the sales", async ({
  page,
}) => {
  await enableFeatures(page, ["returns"]);
  await shopWithProduct(page);
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await sell(page, "M · Red", 3); // ₹1,500; M stock 9 → 6
  await eventually(async () => expect((await records("items"))[0].variants[0].stockQty).toBe(6));

  await gotoTab(page, "Sales History");
  await page
    .locator("main div")
    .filter({ hasText: /·\s*1 item/ })
    .last()
    .click();
  await page.getByRole("button", { name: "↩ Return / exchange" }).click();
  const dlg = page.getByRole("dialog", { name: "Return / exchange" });
  await expect(dlg.getByRole("button", { name: "Confirm return" })).toBeDisabled();
  await dlg.getByRole("button", { name: "Return one more " + KURTI.name }).click();
  await expect(dlg.getByText("Refund: ₹500")).toBeVisible();
  await dlg.getByRole("button", { name: "Confirm return" }).click();
  await expect(page.getByText(/Return saved — refund ₹500 by Cash/)).toBeVisible();

  await eventually(async () => {
    const sales = await records("sales");
    expect(sales).toHaveLength(2);
    const ret = sales.find((s) => s.type === "return");
    const orig = sales.find((s) => s.type !== "return");
    expect(ret).toMatchObject({ refOf: orig.id, total: -500, profit: -200, payment: "Cash" });
    expect(ret.lines[0]).toMatchObject({ qty: -1, amount: -500, size: "M", color: "Red" });
    expect(orig.lines[0].returned).toBe(1);
    expect(orig.total).toBe(1500); // the original bill itself is unchanged
    expect((await records("items"))[0].variants[0].stockQty).toBe(7); // exact variant restocked
  });
  // Net sales: the day's total in Sales History is 1,500 − 500.
  await expect(page.getByText("· 2 bills")).toBeVisible();
  await expect(page.locator("main")).toContainText("₹1,000");
  await expect(page.getByText("↩ RETURN", { exact: true })).toBeVisible();

  // The bill is now locked against delete, and only 2 units can still be returned.
  await page.getByRole("button", { name: "🗑 Delete" }).first().click();
  await expect(page.getByText(/cannot be edited|has returns against it/).first()).toBeVisible();
  expect(await records("sales")).toHaveLength(2);
});

test("returns: exchange — credit from the return is used on a new bill", async ({ page }) => {
  await enableFeatures(page, ["returns"]);
  await shopWithProduct(page);
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await sell(page, "M · Red", 1); // ₹500
  await gotoTab(page, "Sales History");
  await page
    .locator("main div")
    .filter({ hasText: /·\s*1 item/ })
    .last()
    .click();
  await page.getByRole("button", { name: "↩ Return / exchange" }).click();
  const dlg = page.getByRole("dialog", { name: "Return / exchange" });
  await dlg.getByRole("button", { name: "Return one more " + KURTI.name }).click();
  await dlg.getByRole("button", { name: "Credit on new bill" }).click();
  await dlg.getByRole("button", { name: "Confirm return" }).click();
  await expect(page.getByText(/₹500 exchange credit is ready in Billing/)).toBeVisible();

  // The customer takes two of the other size instead: ₹1,000 − ₹500 credit = ₹500 to collect.
  await gotoTab(page, "Billing (POS)");
  await addToCart(page, KURTI.name, "L · Red", 2);
  await expect(page.getByText("Credit used ₹500 · To collect ₹500")).toBeVisible();
  await completeBtn(page).click();
  await eventually(async () => {
    const sales = await records("sales");
    expect(sales).toHaveLength(3);
    const exchange = sales.find((s) => s.creditUsed);
    const ret = sales.find((s) => s.type === "return");
    expect(exchange).toMatchObject({
      total: 1000,
      creditUsed: 500,
      creditOf: ret.id,
      payment: "UPI", // Billing re-opens on its default mode
    });
    expect(ret).toMatchObject({ total: -500, payment: "Credit" });
    // Net revenue across the three bills: 500 − 500 + 1,000
    expect(sales.reduce((a, s) => a + s.total, 0)).toBe(1000);
    const v = Object.fromEntries(
      (await records("items"))[0].variants.map((x) => [x.size, x.stockQty])
    );
    expect(v).toEqual({ M: 9, L: 7 }); // M back to 9; L 9 → 7
  });
  // The credit is spent: no banner on the next bill.
  await expect(page.getByText(/Exchange credit/)).toHaveCount(0);
});
