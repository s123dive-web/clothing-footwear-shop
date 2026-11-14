// Feature "staffAccounts" (off by default): owner creates a staff login; staff can bill and see
// stock, cannot see profit / cost / Admin, cannot delete bills. The rules themselves are tested
// in rules.spec.js — this is the app side.
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
  dialogClick,
} from "./helpers.js";

const KURTI = {
  name: "Staff Kurti",
  price: 500,
  cost: 300,
  variants: [
    { size: "M", color: "Red", stock: 5 },
    { size: "L", color: "Red", stock: 5 },
  ],
};
const STAFF = { email: "staff.e2e@example.com", password: "staff-pass-1" };

test.beforeEach(async () => {
  await resetEmulator();
});

async function signIn(page, who) {
  await page.goto("/");
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("owner adds a staff account; staff can bill but not see profit, cost, Admin or delete", async ({
  page,
  browser,
}) => {
  await enableFeatures(page, ["staffAccounts"]);
  await login(page); // owner: sees everything, as before
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await addProduct(page, KURTI);
  await gotoTab(page, "Admin");
  await page.getByLabel("Staff email").fill(STAFF.email);
  await page.getByLabel("Staff password").fill(STAFF.password);
  await page.getByRole("button", { name: "Add staff" }).click();
  await expect(page.getByText(`Staff account created for ${STAFF.email}`)).toBeVisible();
  // The owner is still signed in as the owner.
  await expect(page.locator("nav.nav")).toContainText("vijaykshopvarje@gmail.com");
  const users = await eventually(async () => {
    const u = await dbGet("shop/users");
    expect(Object.values(u || {})).toHaveLength(1);
    return u;
  });
  expect(Object.values(users)[0]).toMatchObject({ role: "staff", email: STAFF.email });

  // ---- the staff member, on their own phone
  const ctx = await browser.newContext();
  const sp = await ctx.newPage();
  await enableFeatures(sp, ["staffAccounts"]);
  const errors = [];
  sp.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await signIn(sp, STAFF);
  await expect(sp.getByRole("heading", { level: 1, name: "Billing" })).toBeVisible(); // lands on Billing
  const nav = sp.locator("nav.nav");
  await expect(nav).toContainText("(staff)");
  for (const t of ["Billing (POS)", "Inventory", "Sales History", "Udhari (Credit)"])
    await expect(nav.getByRole("button", { name: t })).toBeVisible();
  for (const t of [
    "Dashboard",
    "Reports",
    "Add Expense",
    "Supplier Bills",
    "Admin",
    "Settings",
    "⬇ JSON",
  ])
    await expect(nav.getByRole("button", { name: t })).toHaveCount(0);
  await expect(sp.getByLabel("Misc buy price (optional)")).toHaveCount(0); // no cost entry

  // Staff makes a bill: it syncs, and stock moves.
  await addToCart(sp, KURTI.name, "M · Red", 2);
  await completeBtn(sp).click();
  await expect(sp.getByText(/Bill saved/)).toBeVisible();
  await eventually(async () => {
    expect(await records("sales")).toHaveLength(1);
    expect((await records("items"))[0].variants[0].stockQty).toBe(3);
  });
  await expect(sp.getByText("Online · syncing live")).toBeVisible();

  // Sales History: the bill is there, without profit, and cannot be edited or deleted.
  await gotoTab(sp, "Sales History");
  const row = sp
    .locator("main div")
    .filter({ hasText: /·\s*1 item/ })
    .last();
  await expect(row).toContainText("₹1,000");
  await expect(row).not.toContainText("(+");
  await row.click();
  await expect(sp.getByRole("button", { name: "🖨 Print" })).toBeVisible();
  for (const b of ["🗑 Delete", "✎ Edit bill", "✂ Split"])
    await expect(sp.getByRole("button", { name: b })).toHaveCount(0);

  // Inventory: stock is visible, the catalogue is read-only.
  await gotoTab(sp, "Inventory");
  await expect(sp.locator("main section").filter({ hasText: KURTI.name })).toContainText(
    "8 in stock"
  );
  for (const b of ["+ Add product", "Edit", "Delete", "Restock"])
    await expect(sp.getByRole("button", { name: b, exact: true })).toHaveCount(0);
  expect(errors.filter((e) => /permission|denied/i.test(e))).toEqual([]); // no refused reads/writes
  await ctx.close();

  // ---- owner removes the staff account → that login no longer opens the shop
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await dialogClick(page, "Remove staff access", "Remove access");
  await eventually(async () => expect(await dbGet("shop/users")).toBeNull());
  const ctx2 = await browser.newContext();
  const gone = await ctx2.newPage();
  await enableFeatures(gone, ["staffAccounts"]);
  await signIn(gone, STAFF);
  await expect(gone.getByRole("heading", { name: "No access to this shop" })).toBeVisible();
  await ctx2.close();
});

test("with the feature off there are no roles: the owner sees everything as before", async ({
  page,
}) => {
  await login(page);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await gotoTab(page, "Admin");
  await expect(page.getByText("Staff accounts")).toHaveCount(0);
  expect(await dbGet("shop/users")).toBeNull();
});
