// Sales window (Phase 2): only recent bills + all credit bills are loaded and live; older bills
// are fetched on demand. These tests pin that nothing outside the window is lost or damaged.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resetEmulator,
  login,
  gotoTab,
  records,
  eventually,
  dbPut,
  dbGet,
  dialogClick,
} from "./helpers.js";

const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = (n) => iso(new Date(Date.now() - n * 86400000));
const TODAY = daysAgo(0);
const OLD = daysAgo(220); // well outside a 3-month window

const line = (name, qty, price) => ({
  name,
  qty,
  price,
  buyPrice: price / 2,
  amount: qty * price,
  size: "M",
  color: "Red",
  category: "Clothing",
  subcategory: "Kurtis",
  misc: true,
});
const SALES = {
  recent1: {
    id: "recent1",
    date: TODAY,
    time: "10:00 am",
    payment: "Cash",
    total: 500,
    profit: 250,
    lines: [line("Recent Kurti", 1, 500)],
  },
  oldcash: {
    id: "oldcash",
    date: OLD,
    time: "11:00 am",
    payment: "Cash",
    total: 7000,
    profit: 3500,
    lines: [line("Old Saree", 1, 7000)],
  },
  oldudhari: {
    id: "oldudhari",
    date: OLD,
    time: "12:00 pm",
    payment: "Udhari",
    customer: "Old Credit Customer",
    total: 1200,
    paid: 200,
    paidMode: "Cash",
    profit: 600,
    lines: [line("Old Dress", 1, 1200)],
  },
};

test.beforeEach(async () => {
  await resetEmulator();
  await dbPut("shop/sales", SALES);
});

test("only recent bills load by default; older ones load on request", async ({ page }) => {
  await login(page);
  await gotoTab(page, "Sales History");
  await expect(page.getByText("Showing bills since")).toBeVisible();
  await expect(page.getByText("· Today")).toBeVisible();
  // Today's cash bill + the old credit bill are loaded; the old cash bill is not, so the old
  // date's group total is the credit bill alone (past dates are collapsed to their header).
  await expect(page.getByText("₹1,200").first()).toBeVisible();
  await expect(page.getByText("₹8,200")).toHaveCount(0);

  await page.getByRole("button", { name: "Load all bills" }).click();
  await expect(page.getByText("Showing bills since")).toHaveCount(0);
  await expect(page.getByText("₹8,200").first()).toBeVisible(); // 7,000 + 1,200
  // Nothing was written by merely loading.
  expect(await dbGet("shop/sales")).toEqual(SALES);
});

test("a 'from' date before the window loads that range automatically", async ({ page }) => {
  await login(page);
  await gotoTab(page, "Sales History");
  await expect(page.getByText("₹8,200")).toHaveCount(0);
  await page.locator('main input[type="date"]').first().fill(daysAgo(230));
  await expect(page.getByText("₹8,200").first()).toBeVisible(); // 7,000 + 1,200
});

test("an old unpaid credit bill is always in the Udhari book", async ({ page }) => {
  await login(page);
  await gotoTab(page, "Udhari (Credit)");
  await expect(page.getByRole("row", { name: /Old Credit Customer.*₹1,000.*Pay/ })).toBeVisible();
});

test("Reports fetch the full history once", async ({ page }) => {
  await login(page);
  await gotoTab(page, "Reports");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Loading full sales history…")).toHaveCount(0);
  // All three bills are now loaded: Sales History no longer shows the window notice.
  await gotoTab(page, "Sales History");
  await expect(page.getByText("Showing bills since")).toHaveCount(0);
  await expect(page.getByText("₹8,200").first()).toBeVisible(); // 7,000 + 1,200
});

test("deleting a recent bill does not touch bills outside the window", async ({ page }) => {
  await login(page);
  await gotoTab(page, "Sales History");
  await page
    .locator("main div")
    .filter({ hasText: /·\s*1 item/ })
    .filter({ hasText: "₹500" })
    .last()
    .click();
  await page.getByRole("button", { name: "🗑 Delete" }).click();
  await expect(page.getByText("Bill deleted, stock restored")).toBeVisible();
  await eventually(async () => {
    const left = await dbGet("shop/sales");
    expect(Object.keys(left).sort()).toEqual(["oldcash", "oldudhari"]);
    expect(left.oldcash).toEqual(SALES.oldcash);
    expect(left.oldudhari).toEqual(SALES.oldudhari);
  });
});

test("backup contains every bill, and restore replaces every bill", async ({ page }) => {
  await login(page);
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "⬇ JSON" }).click();
  const download = await dl;
  const file = path.join(os.tmpdir(), `cfs-e2e-window-${Date.now()}.json`);
  await download.saveAs(file);
  const backup = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(backup.sales.map((s) => s.id).sort()).toEqual(["oldcash", "oldudhari", "recent1"]);
  expect(download.suggestedFilename()).not.toContain("PARTIAL");

  // Restore a backup that has ONE bill: the old ones outside the window must go too.
  const small = path.join(os.tmpdir(), `cfs-e2e-window-small-${Date.now()}.json`);
  fs.writeFileSync(
    small,
    JSON.stringify({ items: [], sales: [SALES.recent1], expenses: [], logs: [] })
  );
  await page.reload(); // back to the default window before restoring
  await expect(page.getByText("Online · syncing live")).toBeVisible();
  await page.locator('nav.nav input[type="file"]').setInputFiles(small);
  await dialogClick(page, "Restore backup", "Replace everything");
  await expect(page.getByText("Backup restored")).toBeVisible();
  await eventually(async () => expect(Object.keys(await dbGet("shop/sales"))).toEqual(["recent1"]));
  fs.rmSync(file, { force: true });
  fs.rmSync(small, { force: true });
});

test("the saved monthly summary covers months before the window", async ({ page }) => {
  await login(page);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  const want = OLD.slice(0, 7);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            new Promise((resolve) => {
              const open = indexedDB.open("cfs-local-v1");
              open.onsuccess = () => {
                const req = open.result.transaction("kv").objectStore("kv").get("salesMonthly");
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
              };
              open.onerror = () => resolve(null);
            })
        ),
      { timeout: 10000 }
    )
    .toMatchObject({ months: { [want]: { revenue: 8200, profit: 4100, bills: 2 } } });
  expect((await records("sales")).length).toBe(3);
});
