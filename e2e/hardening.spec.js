// Phase 5 — hardening: malformed data does not crash, errors are reported to the owner, a write
// the server refuses is surfaced (not retried forever, not silently dropped), and stored data
// can be checked against the validation rules.
import { test, expect } from "@playwright/test";
import {
  resetEmulator,
  login,
  gotoTab,
  eventually,
  dbGet,
  dbPut,
  blockDatabase,
  unblockDatabase,
  dialogClick,
  todayStr,
} from "./helpers.js";

test.beforeEach(async () => {
  await resetEmulator();
});

test("a bill with no lines (hand-edited / imported data) no longer crashes the app", async ({
  page,
}) => {
  await dbPut("shop/sales/broken", {
    id: "broken",
    date: todayStr(),
    time: "10:00 am",
    total: 750,
    profit: 100,
    payment: "Cash",
  });
  await login(page);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expect(page.locator("main")).toContainText("₹750");
  await gotoTab(page, "Sales History");
  await expect(page.getByText("· 1 bill")).toBeVisible();
  await gotoTab(page, "Reports");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
  // …and reading it did not rewrite it.
  expect(await dbGet("shop/sales/broken")).not.toHaveProperty("lines");
});

test("an uncaught error is reported to shop/meta/errors and shown in Admin", async ({ page }) => {
  await login(page);
  await page.evaluate(() =>
    setTimeout(() => {
      throw new Error("e2e boom in the page");
    }, 0)
  );
  const report = await eventually(async () => {
    const all = Object.values((await dbGet("shop/meta/errors")) || {});
    expect(all).toHaveLength(1);
    return all[0];
  });
  expect(report).toMatchObject({
    kind: "crash",
    message: "e2e boom in the page",
    user: "vijaykshopvarje@gmail.com",
  });
  expect(report.device).toMatch(/Chrome/);
  expect(typeof report.at).toBe("number");

  await gotoTab(page, "Admin");
  await expect(page.getByText("Error reports (1)")).toBeVisible();
  await expect(page.locator("main")).toContainText("e2e boom in the page");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await dialogClick(page, "Clear error reports", "Clear reports");
  await eventually(async () => expect(await dbGet("shop/meta/errors")).toBeNull());
});

test("a change the server refuses is shown, can be retried, and can be discarded", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await dbPut("shop/sales/cr1", {
    id: "cr1",
    date: todayStr(),
    time: "10:00 am",
    total: 1000,
    profit: 400,
    payment: "Udhari",
    customer: "Refused Lady",
    paid: 0,
    lines: [{ name: "Kurti", qty: 2, price: 500, buyPrice: 300, amount: 1000, misc: true }],
  });
  await login(page);
  await gotoTab(page, "Udhari (Credit)");
  await expect(page.getByRole("row", { name: /Refused Lady.*Pay/ })).toBeVisible();
  await page.waitForTimeout(1000);

  // Offline: take a ₹100 repayment on that bill.
  await blockDatabase(page);
  await page.reload();
  await gotoTab(page, "Udhari (Credit)");
  await page
    .getByRole("row", { name: /Refused Lady.*Pay/ })
    .getByRole("button", { name: "Pay" })
    .click();
  const pay = page.getByRole("dialog", { name: "Record payment" });
  await pay.getByLabel("Amount received").fill("100");
  await pay.getByRole("button", { name: "Pay", exact: true }).click();
  await expect(page.getByText(/Recorded ₹100/)).toBeVisible();

  // Meanwhile the bill is deleted from another device.
  await dbPut("shop/sales/cr1", null);

  // Back online: the repayment now targets a bill that no longer exists. The validation rules
  // refuse it (it would create a broken stub).
  await unblockDatabase(page);
  await page.reload();
  const retry = page.locator("nav.nav").getByRole("button", { name: /not synced — tap to retry/ });
  await expect(retry).toBeVisible({ timeout: 20_000 });
  expect(await dbGet("shop/sales")).toBeNull(); // no stub was written
  await retry.click();
  const dlg = page.getByRole("dialog", { name: "Changes not synced" });
  await expect(dlg).toContainText("Bill change");
  for (let i = 0; i < 3; i++) {
    await dlg.getByRole("button", { name: "Retry all" }).click();
    await page.waitForTimeout(500);
  }
  await expect(dlg).toContainText("Refused by the server");

  // The failure was reported for the owner.
  await eventually(async () => {
    const all = Object.values((await dbGet("shop/meta/errors")) || {});
    expect(all.some((r) => r.kind === "sync" && /permission/i.test(r.message))).toBe(true);
  });

  await dlg.getByRole("button", { name: "Discard", exact: true }).click();
  await dialogClick(page, "Discard this change?", "Discard");
  await expect(page.getByText("Online · syncing live")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("nav.nav").getByRole("button", { name: /not synced/ })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Online · syncing live")).toBeVisible();
  await page.waitForTimeout(3500); // long enough for a lingering failure to show again
  await expect(page.locator("nav.nav").getByRole("button", { name: /not synced/ })).toHaveCount(0);
  expect(await dbGet("shop/sales")).toBeNull();
});

test("Admin → Check data against rules lists the records the rules would refuse", async ({
  page,
}) => {
  // Written with admin rights, the way pre-rules data already sits in the database.
  await dbPut("shop/items", {
    good: {
      id: "good",
      name: "Good Kurti",
      sellingPrice: 500,
      variants: [{ id: "v", stockQty: 3, lowAt: 1 }],
      stock: 3,
    },
    bad: {
      id: "bad",
      name: "Bad Kurti",
      sellingPrice: "500",
      variants: [{ id: "v", stockQty: -2, lowAt: 1 }],
      stock: 0,
    },
  });
  await dbPut("shop/sales", {
    ok: {
      id: "ok",
      date: todayStr(),
      time: "x",
      total: 100,
      profit: 10,
      payment: "Cash",
      lines: [{ name: "a", qty: 1, price: 100, amount: 100 }],
    },
    odd: {
      id: "odd",
      date: "14/11/2026",
      time: "x",
      total: "100",
      payment: "Cash",
      lines: [{ name: "a", qty: 1, price: 100, amount: 100 }],
    },
  });
  await login(page);
  await gotoTab(page, "Admin");
  await page.getByRole("button", { name: /Check \d+ products and \d+ bills/ }).click();
  const result = page.getByRole("status").filter({ hasText: "would be refused" });
  await expect(result).toContainText("2 records would be refused");
  await expect(result).toContainText("Bad Kurti");
  await expect(result).toContainText("sellingPrice is not a number ≥ 0");
  await expect(result).toContainText("variant 1: stock is not a number ≥ 0");
  await expect(result).toContainText("date is not YYYY-MM-DD");
  await expect(result).toContainText("total is not a number");
  await expect(result).not.toContainText("Good Kurti");
});
