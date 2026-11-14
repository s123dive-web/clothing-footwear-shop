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
  await gotoTab(page, "Settings");
  await expect(page.getByText("Payment & receipt paper")).toHaveCount(0);
  expect(await dbGet("shop/meta")).toEqual({ seeded: true });
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
