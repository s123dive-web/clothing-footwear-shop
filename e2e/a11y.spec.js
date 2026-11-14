// Phase 3 accessibility pass, kept honest by an automated audit (e2e/a11y-audit.js) run on every
// tab and the main dialogs:
//   • every input / select / textarea / button has an accessible name;
//   • all visible text meets WCAG AA contrast (4.5:1; 3:1 for large text);
//   • on a phone, every control is a tap target of at least 44 px.
import { test, expect } from "@playwright/test";
import {
  resetEmulator,
  login,
  gotoTab,
  addProduct,
  addToCart,
  completeBtn,
  dbPut,
} from "./helpers.js";
import { auditPage } from "./a11y-audit.js";

const TABS = [
  "Dashboard",
  "Billing (POS)",
  "Inventory",
  "Sales History",
  "Reports",
  "Udhari (Credit)",
  "Add Expense",
  "Supplier Bills",
  "Alerts",
  "Vendor Bills",
  "Data Import",
  "Activity Log",
  "Settings",
  "Admin",
];
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function auditEverything(page, minTarget) {
  await resetEmulator();
  const found = { unlabeled: {}, contrast: {}, small: {} };
  const run = async (where) => {
    await page.waitForTimeout(600); // lazy tab + charts settle
    const r = await page.evaluate(auditPage, { minTarget });
    for (const k of Object.keys(found))
      for (const f of r[k]) (found[k][f] = found[k][f] || []).push(where);
  };

  await page.goto("/");
  await run("Login");
  await login(page);
  await addProduct(page, {
    name: "Audit Kurti",
    price: 500,
    cost: 300,
    variants: [
      { size: "M", color: "Red", stock: 5 },
      { size: "L", color: "Red", stock: 1 },
    ],
  });
  await gotoTab(page, "Billing (POS)");
  await addToCart(page, "Audit Kurti", "M · Red", 1);
  await page.getByRole("button", { name: "Udhari", exact: true }).click();
  await page.getByLabel("Customer name").fill("Audit Customer");
  await completeBtn(page).click();
  await addToCart(page, "Audit Kurti", "M · Red", 1);
  await page.getByRole("button", { name: "⏸ Hold" }).click();
  await addToCart(page, "Audit Kurti", "M · Red", 1);
  await dbPut("shop/expenses/x1", { id: "x1", date: today(), desc: "Audit tea", amount: 40 });
  await run("Billing with cart, held bill, toast");

  for (const t of TABS) {
    await gotoTab(page, t);
    await run(t);
  }
  await gotoTab(page, "Inventory");
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await run("Product form");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Restock", exact: true }).first().click();
  await run("Restock dialog");
  await page.keyboard.press("Escape");
  await gotoTab(page, "Sales History");
  await page
    .locator("main div")
    .filter({ hasText: /·\s*1 item/ })
    .last()
    .click();
  await run("Bill open");
  await page.getByRole("button", { name: "✎ Edit bill" }).click();
  await run("Edit bill dialog");
  await page.keyboard.press("Escape");
  await gotoTab(page, "Activity Log");
  await page.getByRole("button", { name: /Clear/ }).click();
  await run("Confirm dialog");

  const lines = (k) =>
    Object.entries(found[k]).map(([f, w]) => `${f}   @ ${[...new Set(w)].join(", ")}`);
  return { unlabeled: lines("unlabeled"), contrast: lines("contrast"), small: lines("small") };
}

test("desktop: every control is labelled and all text meets AA contrast", async ({ page }) => {
  test.setTimeout(180_000);
  const r = await auditEverything(page, 0);
  expect(r.unlabeled, "controls without an accessible name").toEqual([]);
  expect(r.contrast, "text below WCAG AA contrast").toEqual([]);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });

  test("labels, contrast and 44 px tap targets on every screen", async ({ page }) => {
    test.setTimeout(180_000);
    const r = await auditEverything(page, 44);
    expect(r.unlabeled, "controls without an accessible name").toEqual([]);
    expect(r.contrast, "text below WCAG AA contrast").toEqual([]);
    expect(r.small, "tap targets smaller than 44 px").toEqual([]);
  });

  test("no screen scrolls sideways", async ({ page }) => {
    await resetEmulator();
    await login(page);
    await addProduct(page, {
      name: "Audit Kurti",
      price: 500,
      variants: [
        { size: "M", color: "Red", stock: 5 },
        { size: "L", color: "Red", stock: 5 },
      ],
    });
    await gotoTab(page, "Billing (POS)");
    await addToCart(page, "Audit Kurti", "M · Red", 1);
    const wide = async () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
    expect(await wide(), "Billing with a cart").toBeLessThanOrEqual(1);
    for (const t of TABS) {
      await gotoTab(page, t);
      await page.waitForTimeout(300);
      expect(await wide(), t).toBeLessThanOrEqual(1);
    }
  });
});

test("keyboard focus is visible on buttons", async ({ page }) => {
  await resetEmulator();
  await login(page);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const outline = await page.evaluate(() => {
    const cs = getComputedStyle(document.activeElement);
    return {
      tag: document.activeElement.tagName,
      width: parseFloat(cs.outlineWidth),
      style: cs.outlineStyle,
    };
  });
  expect(outline.tag).toBe("BUTTON");
  expect(outline.style).toBe("solid");
  expect(outline.width).toBeGreaterThanOrEqual(2);
});
