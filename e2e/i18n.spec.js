// Language toggle: English (default) / Hindi / Marathi for menus, Billing and the receipt.
import { test, expect } from "@playwright/test";
import {
  resetEmulator,
  login,
  gotoTab,
  addProduct,
  addToCart,
  records,
  eventually,
  receiptHtml,
} from "./helpers.js";

const KURTI = {
  name: "Lang Kurti",
  price: 500,
  cost: 300,
  variants: [
    { size: "M", color: "Red", stock: 5 },
    { size: "L", color: "Red", stock: 5 },
  ],
};

test.beforeEach(async () => {
  await resetEmulator();
});

test("default is English; Hindi translates menus, Billing, toast and the receipt", async ({
  page,
}) => {
  await login(page);
  await addProduct(page, KURTI);
  await gotoTab(page, "Billing (POS)");
  await addToCart(page, KURTI.name, "M · Red", 2);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  await page.locator("nav.nav").getByLabel("Language").selectOption("hi");
  await expect(page.locator("html")).toHaveAttribute("lang", "hi");
  const nav = page.locator("nav.nav");
  await expect(nav.getByRole("button", { name: "बिलिंग" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "बिक्री इतिहास" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "बिलिंग" })).toBeVisible();
  await expect(page.getByText("चालू बिल")).toBeVisible();
  await expect(page.getByRole("button", { name: "नकद", exact: true })).toBeVisible();

  // The stored bill is language-neutral: payment stays "Cash", not the translated label.
  await page.getByRole("button", { name: "नकद", exact: true }).click();
  await page.getByRole("button", { name: /^बिक्री पूरी करें · ₹1,000/ }).click();
  await expect(page.getByText(/बिल सेव हो गया \(Cash\) — ₹1,000/)).toBeVisible();
  const [sale] = await eventually(async () => {
    const s = await records("sales");
    expect(s).toHaveLength(1);
    return s;
  });
  expect(sale.payment).toBe("Cash");
  expect(sale.total).toBe(1000);

  const html = await receiptHtml(page, () =>
    page.getByRole("button", { name: /पिछली रसीद प्रिंट करें/ }).click()
  );
  expect(html).toMatch(/<td>कुल<\/td><td><\/td><td class="r">₹1,000</);
  expect(html).toContain("साइज़ M · Red");
  expect(html).toContain("भुगतान: नकद");
  expect(html).toContain("स्कैन करके भुगतान करें · UPI");
  expect(html).toContain(KURTI.name); // item names are printed as entered
});

test("the choice is remembered on this device, and Marathi works too", async ({ page }) => {
  await login(page);
  await page.locator("nav.nav").getByLabel("Language").selectOption("mr");
  await expect(
    page.locator("nav.nav").getByRole("button", { name: "विक्री इतिहास" })
  ).toBeVisible();
  await page.reload();
  await expect(
    page.locator("nav.nav").getByRole("button", { name: "विक्री इतिहास" })
  ).toBeVisible();
  await expect(page.getByText("ऑनलाइन · लाइव्ह सिंक")).toBeVisible();
  await page.locator("nav.nav").getByRole("button", { name: "विक्री इतिहास" }).click();
  await expect(page.getByText("अजून विक्री नाही.")).toBeVisible();
  await expect(page.getByRole("button", { name: "बिलिंग सुरू करा" })).toBeVisible();

  // Back to English.
  await page.locator("nav.nav").getByLabel("भाषा").selectOption("en");
  await expect(
    page.locator("nav.nav").getByRole("button", { name: "Sales History" })
  ).toBeVisible();
});

test("the sign-in screen can be switched too", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Language").selectOption("hi");
  await expect(page.getByRole("heading", { name: "साइन इन" })).toBeVisible();
  await expect(page.getByLabel("ईमेल")).toBeVisible();
  await expect(page.getByLabel("पासवर्ड")).toBeVisible();
});
