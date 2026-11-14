// Phase 3 — counter usability: in-app dialogs, Undo, toasts, billing ergonomics, sync status.
import { test, expect } from "@playwright/test";
import {
  resetEmulator,
  login,
  gotoTab,
  addProduct,
  addToCart,
  completeBtn,
  variantStock,
  records,
  eventually,
  dbPut,
} from "./helpers.js";

const KURTI = {
  name: "Usable Kurti",
  price: 500,
  cost: 300,
  variants: [
    { size: "S", color: "Red", stock: 5 },
    { size: "M", color: "Red", stock: 5 },
  ],
};
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

test.beforeEach(async ({ page }) => {
  await resetEmulator();
  page.on("dialog", (d) => {
    d.dismiss();
    throw new Error("unexpected native dialog: " + d.message());
  });
});

async function sellTwo(page) {
  await login(page);
  await addProduct(page, KURTI);
  await gotoTab(page, "Billing (POS)");
  await addToCart(page, KURTI.name, "M · Red", 2);
  await completeBtn(page).click();
  await eventually(async () => expect((await variantStock(KURTI.name))["M|Red"]).toBe(3));
}
const openBill = async (page) => {
  await gotoTab(page, "Sales History");
  await page
    .locator("main div")
    .filter({ hasText: /·\s*1 item/ })
    .filter({ hasText: "₹1,000" })
    .last()
    .click();
};

test("delete bill → Undo puts the bill and the stock decrement back", async ({ page }) => {
  await sellTwo(page);
  const [before] = await records("sales");
  await openBill(page);
  await page.getByRole("button", { name: "🗑 Delete" }).click();
  await eventually(async () => {
    expect(await records("sales")).toHaveLength(0);
    expect((await variantStock(KURTI.name))["M|Red"]).toBe(5);
  });
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Bill restored")).toBeVisible();
  await eventually(async () => {
    expect(await records("sales")).toEqual([before]);
    expect((await variantStock(KURTI.name))["M|Red"]).toBe(3);
  });
});

test("the Undo offer goes away after 5 seconds and the delete stands", async ({ page }) => {
  await sellTwo(page);
  await openBill(page);
  await page.getByRole("button", { name: "🗑 Delete" }).click();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toBeHidden({ timeout: 8000 });
  expect(await records("sales")).toHaveLength(0);
});

test("delete product → Undo restores it with its variants and stock", async ({ page }) => {
  await login(page);
  await addProduct(page, KURTI);
  const [before] = await eventually(async () => {
    const items = await records("items");
    expect(items).toHaveLength(1);
    return items;
  });
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Product deleted")).toBeVisible();
  await eventually(async () => expect(await records("items")).toHaveLength(0));
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Product restored")).toBeVisible();
  await eventually(async () => {
    const [after] = await records("items");
    expect(after.id).toBe(before.id);
    expect(after.variants).toEqual(before.variants);
  });
});

test("delete expense → Undo restores it", async ({ page }) => {
  await dbPut("shop/expenses/x1", { id: "x1", date: today(), desc: "Undo tea", amount: 40 });
  await login(page);
  await gotoTab(page, "Add Expense");
  await expect(page.getByText("Undo tea")).toBeVisible();
  await page
    .locator("tr, div")
    .filter({ hasText: "Undo tea" })
    .last()
    .getByRole("button", { name: /Delete|🗑|✕/ })
    .first()
    .click();
  await expect(page.getByText("Expense deleted")).toBeVisible();
  await eventually(async () => expect(await records("expenses")).toHaveLength(0));
  await page.getByRole("button", { name: "Undo" }).click();
  await eventually(async () =>
    expect(await records("expenses")).toEqual([
      { id: "x1", date: today(), desc: "Undo tea", amount: 40 },
    ])
  );
});

test("destructive confirm: in-app, red, Cancel focused, Esc cancels", async ({ page }) => {
  await login(page);
  await gotoTab(page, "Activity Log");
  await eventually(async () => expect((await records("logs")).length).toBe(0));
  await dbPut("shop/logs/l1", {
    id: "l1",
    at: Date.now(),
    date: today(),
    time: "10:00:00 am",
    type: "sale",
    message: "Seeded event",
  });
  await expect(page.getByText("Seeded event")).toBeVisible();
  await page.getByRole("button", { name: /Clear/ }).click();
  const dlg = page.getByRole("dialog", { name: "Clear activity log" });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole("button", { name: "Cancel" })).toBeFocused();
  const danger = dlg.getByRole("button", { name: "Clear log" });
  await expect(danger).toHaveCSS("background-color", "rgb(179, 38, 30)");
  const box = await danger.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);

  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  await expect(page.getByText("Seeded event")).toBeVisible(); // nothing was cleared

  await page.getByRole("button", { name: /Clear/ }).click();
  await dlg.getByRole("button", { name: "Clear log" }).click();
  await expect(page.getByText("Activity log cleared")).toBeVisible();
});

test("modal traps focus: Tab from the last control wraps to the first", async ({ page }) => {
  await login(page);
  await gotoTab(page, "Activity Log");
  await dbPut("shop/logs/l1", {
    id: "l1",
    at: Date.now(),
    date: today(),
    time: "10:00:00 am",
    type: "sale",
    message: "Seeded event",
  });
  await page.getByRole("button", { name: /Clear/ }).click();
  const dlg = page.getByRole("dialog", { name: "Clear activity log" });
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    const inside = await dlg.evaluate((el) => el.contains(document.activeElement));
    expect(inside).toBe(true);
  }
});

test("a warning toast stays until dismissed; an info toast goes away by itself", async ({
  page,
}) => {
  await login(page);
  await gotoTab(page, "Billing (POS)");
  // Info: adding a misc item with no price is rejected with an ordinary message.
  await page.getByRole("button", { name: "+ Add" }).click();
  const info = page.getByText("Enter a price for the misc item.");
  await expect(info).toBeVisible();
  await expect(info).toBeHidden({ timeout: 6000 });

  // Warning: a restore file that is not a backup.
  await page.locator('nav.nav input[type="file"]').setInputFiles({
    name: "junk.json",
    mimeType: "application/json",
    buffer: Buffer.from("{ not json"),
  });
  const warn = page.getByRole("alert").filter({ hasText: "not a valid backup" });
  await expect(warn).toBeVisible();
  await page.waitForTimeout(4000);
  await expect(warn).toBeVisible(); // still there
  await warn.getByRole("button", { name: "Dismiss message" }).click();
  await expect(warn).toBeHidden();
});

// ---------------------------------------------------------------------------------------------
// Billing ergonomics
// ---------------------------------------------------------------------------------------------
test("quantity steppers: + / − are 44 px targets and respect stock", async ({ page }) => {
  await login(page);
  await addProduct(page, KURTI);
  await gotoTab(page, "Billing (POS)");
  await addToCart(page, KURTI.name, "M · Red", 1);
  const plus = page.getByRole("button", { name: "One more " + KURTI.name });
  const minus = page.getByRole("button", { name: "One less " + KURTI.name });
  const qty = page.getByLabel("Quantity for " + KURTI.name);
  for (const b of [plus, minus]) {
    const box = await b.boundingBox();
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
  }
  await plus.click();
  await plus.click();
  await expect(qty).toHaveValue("3");
  await minus.click();
  await expect(qty).toHaveValue("2");
  for (let i = 0; i < 6; i++) await plus.click(); // only 5 in stock
  await expect(qty).toHaveValue("5");
  await expect(qty).toHaveAttribute("inputmode", "numeric");
  await expect(page.getByLabel("Discount amount")).toHaveAttribute("inputmode", "decimal");
});

test("hold a bill, serve another customer, resume the first", async ({ page }) => {
  await login(page);
  await addProduct(page, KURTI);
  await gotoTab(page, "Billing (POS)");
  await addToCart(page, KURTI.name, "M · Red", 2);
  await page.getByLabel("Customer name").fill("Waiting Customer");
  await page.getByRole("button", { name: "⏸ Hold" }).click();
  await expect(page.getByText("No items yet. Tap a product to begin.")).toBeVisible();
  await expect(page.getByText("Held bills (1)")).toBeVisible();

  // Second customer, completed while the first is on hold.
  await addToCart(page, KURTI.name, "S · Red", 1);
  await completeBtn(page).click();
  await eventually(async () => expect(await records("sales")).toHaveLength(1));

  // A reload does not lose the held bill.
  await page.reload();
  await gotoTab(page, "Billing (POS)");
  await page.getByRole("button", { name: /▶ Waiting Customer · ₹1,000/ }).click();
  await expect(page.getByLabel("Quantity for " + KURTI.name)).toHaveValue("2");
  await expect(page.getByLabel("Customer name")).toHaveValue("Waiting Customer");
  await expect(page.getByText("Held bills")).toHaveCount(0);
  await completeBtn(page).click();
  await eventually(async () => {
    expect(await records("sales")).toHaveLength(2);
    expect(await variantStock(KURTI.name)).toEqual({ "S|Red": 4, "M|Red": 3 });
  });
});

test("quick-pick row offers recently sold products", async ({ page }) => {
  await sellTwo(page);
  const quick = page.getByLabel("Recent and best sellers").getByRole("button", {
    name: new RegExp(KURTI.name),
  });
  await expect(quick).toBeVisible();
  await quick.click();
  await expect(page.getByRole("dialog", { name: new RegExp(KURTI.name) })).toBeVisible();
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 780 } });

  test("total and Complete button stay pinned to the bottom of the screen", async ({ page }) => {
    await login(page);
    await addProduct(page, KURTI);
    await gotoTab(page, "Billing (POS)");
    await addToCart(page, KURTI.name, "M · Red", 2);
    const bar = page.locator(".bill-bar");
    await expect(bar).toHaveCSS("position", "fixed");
    await expect(bar).toContainText("₹1,000");
    for (const y of [0, 400, 5000]) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      const box = await completeBtn(page).boundingBox();
      expect(box.y + box.height).toBeLessThanOrEqual(780);
      expect(box.y).toBeGreaterThan(780 - 120);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await completeBtn(page).click();
    await eventually(async () => expect(await records("sales")).toHaveLength(1));
  });
});
