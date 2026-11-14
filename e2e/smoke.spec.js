// Smoke tests — pin the CURRENT behaviour of the core counter flows so later refactors
// (Phase 1 outbox, Phase 2 screen split) can prove they changed nothing the user sees.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resetEmulator,
  login,
  gotoTab,
  addProduct,
  addToCart,
  billPanel,
  completeBtn,
  variantStock,
  records,
  eventually,
  dbPut,
  receiptHtml,
} from "./helpers.js";

const KURTI = {
  name: "Smoke Kurti",
  price: 500,
  cost: 300,
  variants: [
    { size: "S", color: "Red", stock: 5 },
    { size: "M", color: "Red", stock: 5 },
    { size: "L", color: "Blue", stock: 5 },
  ],
};

/** The bill row (time · n items … total) in Sales History for a given total. */
const billRow = (page, totalText) =>
  page
    .locator("main div")
    .filter({ hasText: /·\s*\d+ items?/ })
    .filter({ hasText: totalText })
    .last();

/** Login, add the 3-variant kurti, and sell `qty` of "M · Red" with the given payment. */
async function sellKurti(page, { qty = 2, pay = "UPI", customer, paidNow } = {}) {
  await login(page);
  await addProduct(page, KURTI);
  await gotoTab(page, "Billing (POS)");
  await addToCart(page, KURTI.name, "M · Red", qty);
  await billPanel(page).getByRole("button", { name: pay, exact: true }).first().click();
  if (customer) await page.getByLabel("Customer name").fill(customer);
  if (paidNow != null) await page.getByLabel("Amount paid now").fill(String(paidNow));
  await completeBtn(page).click();
  await expect(page.getByText(new RegExp(`Bill saved \\(${pay}\\)`))).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await resetEmulator();
  page.on("dialog", (d) => d.accept()); // native confirm()/alert() — accept by default
});

test("1 · login → dashboard renders", async ({ page }) => {
  await login(page);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expect(page.getByText("Today's sales")).toBeVisible();
  await expect(page.getByText("Online · syncing live")).toBeVisible();
  await expect(page.locator("nav.nav")).toContainText("Signed in as");
});

test("2 · add product with 3 variants → appears in Inventory", async ({ page }) => {
  await login(page);
  await addProduct(page, KURTI);
  await expect(page.getByText("Product added")).toBeVisible();
  const card = page.locator("main section").filter({ hasText: KURTI.name });
  await expect(card).toContainText("15 in stock");
  await expect(card).toContainText("₹500");
  await expect(page.getByText("1 product ·")).toBeVisible();

  const [p] = await eventually(async () => {
    const items = await records("items");
    expect(items).toHaveLength(1);
    return items;
  });
  expect(p.variants.map((v) => `${v.size}|${v.color}|${v.stockQty}`)).toEqual([
    "S|Red|5",
    "M|Red|5",
    "L|Blue|5",
  ]);
  expect(p.sellingPrice).toBe(500);
  expect(p.purchasePrice).toBe(300);
});

test("3 · sell 2 units of one variant → stock −2, bill in Sales History, receipt has shop name + total", async ({
  page,
}) => {
  await sellKurti(page, { qty: 2 });

  // Only the sold variant drops, by exactly 2 — in the cloud …
  await eventually(async () =>
    expect(await variantStock(KURTI.name)).toEqual({ "S|Red": 5, "M|Red": 3, "L|Blue": 5 })
  );
  // … and on screen.
  await gotoTab(page, "Inventory");
  await expect(page.locator("main section").filter({ hasText: KURTI.name })).toContainText(
    "13 in stock"
  );

  // Exactly one bill, with the cost snapshotted for profit.
  const [sale] = await eventually(async () => {
    const s = await records("sales");
    expect(s).toHaveLength(1);
    return s;
  });
  expect(sale.total).toBe(1000);
  expect(sale.profit).toBe(400);
  expect(sale.payment).toBe("UPI");
  expect(sale.lines).toHaveLength(1);
  expect(sale.lines[0]).toMatchObject({ name: KURTI.name, qty: 2, size: "M", color: "Red" });

  await gotoTab(page, "Sales History");
  await expect(page.getByText("· Today")).toBeVisible();
  await expect(page.getByText("· 1 bill")).toBeVisible();
  await billRow(page, "₹1,000").click();
  await expect(page.getByText(`${KURTI.name} × 2`)).toBeVisible();

  // Receipt: printed through a hidden iframe whose srcdoc is the receipt HTML.
  const html = await receiptHtml(page, () => page.getByRole("button", { name: "🖨 Print" }).click());
  const shopName = await page.locator("nav.nav img + div > div").first().innerText();
  expect(shopName.trim().length).toBeGreaterThan(0);
  expect(html).toContain(`<h2>${shopName.trim().replace(/&/g, "&amp;")}</h2>`);
  expect(html).toMatch(/TOTAL<\/td><td><\/td><td class="r">₹1,000</);
  expect(html).toContain(KURTI.name);
  expect(html).toContain("Size M · Red");
  expect(html).toContain("Paid via UPI");
});

test("4 · delete that bill → stock restored", async ({ page }) => {
  await sellKurti(page, { qty: 2 });
  await eventually(async () => expect((await variantStock(KURTI.name))["M|Red"]).toBe(3));

  await gotoTab(page, "Sales History");
  await billRow(page, "₹1,000").click();
  await page.getByRole("button", { name: "🗑 Delete" }).click(); // confirm() auto-accepted
  await expect(page.getByText("Bill deleted, stock restored")).toBeVisible();
  await expect(page.getByText("No sales yet.")).toBeVisible();

  await eventually(async () => {
    expect(await variantStock(KURTI.name)).toEqual({ "S|Red": 5, "M|Red": 5, "L|Blue": 5 });
    expect(await records("sales")).toHaveLength(0);
  });
});

test("5 · Udhari sale with part payment → outstanding shown in Udhari tab", async ({ page }) => {
  await sellKurti(page, { qty: 2, pay: "Udhari", customer: "Sunita Test", paidNow: 300 });

  const [sale] = await eventually(async () => {
    const s = await records("sales");
    expect(s).toHaveLength(1);
    return s;
  });
  expect(sale).toMatchObject({
    payment: "Udhari",
    customer: "Sunita Test",
    total: 1000,
    paid: 300,
    paidMode: "Cash",
  });

  await gotoTab(page, "Udhari (Credit)");
  await expect(page.getByRole("heading", { level: 1, name: "Udhari / Credit" })).toBeVisible();
  // Customer summary row: name · bills · outstanding · Pay
  await expect(page.getByRole("row", { name: /Sunita Test.*₹700.*Pay/ })).toBeVisible();
  // "Outstanding credit" summary card
  await expect(page.getByText(/^Outstanding credit₹700/)).toBeVisible();
});

test("6 · JSON export → empty emulator → import → same counts", async ({ page, browser }) => {
  await sellKurti(page, { qty: 2 });
  // An expense too, so the backup covers more than items + sales.
  await gotoTab(page, "Add Expense");
  await eventually(async () => expect(await records("sales")).toHaveLength(1));
  const today = (await records("sales"))[0].date;
  await dbPut("shop/expenses/e2e-exp-1", {
    id: "e2e-exp-1",
    date: today,
    desc: "E2E tea",
    amount: 40,
    category: "Other",
  });
  await expect(page.getByText("E2E tea")).toBeVisible();

  const before = {
    items: await records("items"),
    sales: await records("sales"),
    expenses: await records("expenses"),
  };
  expect([before.items.length, before.sales.length, before.expenses.length]).toEqual([1, 1, 1]);

  // Export
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "⬇ JSON" }).click();
  const download = await dl;
  expect(download.suggestedFilename()).toMatch(/\.json$/);
  // ASCII-only path: Chromium silently ignores setInputFiles() for the "·"/"→" in the
  // per-test output directory name.
  const file = path.join(os.tmpdir(), `cfs-e2e-backup-${Date.now()}.json`);
  await download.saveAs(file);
  const backup = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(backup.items).toHaveLength(1);
  expect(backup.sales).toHaveLength(1);
  expect(backup.expenses).toHaveLength(1);
  expect(typeof backup.exportedAt).toBe("string");

  // Empty the emulator and restore from a brand-new browser profile (a new/replaced phone):
  // no local cache, nothing in the cloud.
  await page.close(); // the old tab must not write stale state back into the wiped database
  await resetEmulator();
  expect(await records("items")).toHaveLength(0);
  expect(await records("sales")).toHaveLength(0);
  const ctx = await browser.newContext();
  const fresh = await ctx.newPage();
  fresh.on("dialog", (d) => d.accept()); // "Restore this backup? It will REPLACE all current data…"
  await login(fresh);
  await gotoTab(fresh, "Inventory");
  await expect(fresh.getByText("No products yet.")).toBeVisible();

  await fresh.locator('nav.nav input[type="file"]').setInputFiles(file);
  await expect(fresh.getByText("Backup restored")).toBeVisible();

  await eventually(async () => {
    const after = {
      items: await records("items"),
      sales: await records("sales"),
      expenses: await records("expenses"),
    };
    expect(after.items).toHaveLength(1);
    expect(after.sales).toEqual(before.sales);
    expect(after.expenses).toEqual(before.expenses);
    // Stock and variant structure survive the round trip (version/updatedAt may be re-stamped).
    expect(after.items[0].variants).toEqual(before.items[0].variants);
    expect(after.items[0].name).toBe(before.items[0].name);
  });
  await expect(fresh.locator("main section").filter({ hasText: KURTI.name })).toContainText(
    "13 in stock"
  );
  await gotoTab(fresh, "Sales History");
  await expect(fresh.getByText("· 1 bill")).toBeVisible();
  await ctx.close();
  fs.rmSync(file, { force: true });
});
