// Shared helpers for the Playwright smoke tests.
//
// Everything here talks to the LOCAL Firebase emulators only (see firebase.json). The owner
// account uses the same email the real database rules are locked to, so the tests exercise
// database.rules.json exactly as deployed — but inside the throw-away `demo-cfs-shop` project.
import { expect } from "@playwright/test";

export const PROJECT = "demo-cfs-shop";
export const NS = `${PROJECT}-default-rtdb`;
export const DB_ORIGIN = "http://127.0.0.1:9000";
export const AUTH_ORIGIN = "http://127.0.0.1:9099";
export const OWNER = { email: "vijaykshopvarje@gmail.com", password: "emulator-pass-1" };

const admin = { Authorization: "Bearer owner", "Content-Type": "application/json" };
const dbUrl = (path) => `${DB_ORIGIN}/${path.replace(/^\/+/, "")}.json?ns=${NS}`;

/** Admin read of a database path (bypasses rules). */
export async function dbGet(path) {
  const r = await fetch(dbUrl(path), { headers: admin });
  if (!r.ok) throw new Error(`dbGet ${path}: ${r.status}`);
  return r.json();
}

/** Admin overwrite of a database path (bypasses rules). */
export async function dbPut(path, value) {
  const r = await fetch(dbUrl(path), {
    method: "PUT",
    headers: admin,
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`dbPut ${path}: ${r.status}`);
}

/**
 * Wipe the emulator database and auth users, then create the owner account.
 * `seeded: true` (default) sets shop/meta/seeded so the app does NOT auto-create its demo
 * catalogue — tests start from a genuinely empty shop.
 */
export async function resetEmulator({ seeded = true } = {}) {
  await dbPut("/", seeded ? { shop: { meta: { seeded: true } } } : null);
  const del = await fetch(`${AUTH_ORIGIN}/emulator/v1/projects/${PROJECT}/accounts`, {
    method: "DELETE",
    headers: admin,
  });
  if (!del.ok) throw new Error("auth reset failed: " + del.status);
  const r = await fetch(
    `${AUTH_ORIGIN}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...OWNER, returnSecureToken: true }),
    }
  );
  if (!r.ok) throw new Error("owner signUp failed: " + r.status + " " + (await r.text()));
}

/** Records of a slice as an array (shop/<slice> is a map keyed by record id). */
export async function records(slice) {
  return Object.values((await dbGet("shop/" + slice)) || {});
}

/** Poll until `fn()` stops throwing (for assertions on eventually-consistent cloud state). */
export async function eventually(fn, { timeout = 10_000, interval = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, interval));
    }
  }
}

export async function login(page) {
  await page.goto("/");
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

const OTHER = ["Alerts", "Vendor Bills", "Data Import", "Activity Log", "Settings", "Admin"];

/** Open a sidebar tab by its visible label (expands the "Other" group when needed). */
export async function gotoTab(page, label) {
  const nav = page.locator("nav.nav");
  const btn = nav.getByRole("button", { name: label });
  if (OTHER.includes(label) && !(await btn.isVisible())) {
    await nav.getByRole("button", { name: /Other/ }).click();
  }
  await btn.click();
}

/**
 * Add a product through the Inventory form.
 * variants: [{ size, color, stock }]
 */
export async function addProduct(page, { name, price, cost = 0, variants }) {
  await gotoTab(page, "Inventory");
  await page
    .getByRole("button", { name: /\+ Add (your first )?product/ })
    .first()
    .click();
  const dlg = page.getByRole("dialog", { name: "Add product" });
  await dlg.getByLabel("Product name *").fill(name);
  await dlg.getByLabel("Purchase price").fill(String(cost));
  await dlg.getByLabel("Selling price *").fill(String(price));
  const rows = dlg.locator("tbody tr");
  for (let i = 0; i < variants.length; i++) {
    if (i > 0) await dlg.getByRole("button", { name: "+ Add a variant row" }).click();
    const inputs = rows.nth(i).locator("input");
    await inputs.nth(0).fill(variants[i].size);
    await inputs.nth(1).fill(variants[i].color);
    await inputs.nth(2).fill(String(variants[i].stock));
  }
  await dlg.getByRole("button", { name: "Add product", exact: true }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByText(name).first()).toBeVisible();
}

/** The "Current bill" panel on the Billing screen. */
export const billPanel = (page) => page.locator("section").filter({ hasText: "Current bill" });

/**
 * On the Billing screen, put `qty` units of one variant of `product` in the cart.
 * `variant` is the picker label, e.g. "M · Red".
 */
export async function addToCart(page, product, variant, qty = 1) {
  await page.locator(".pick").filter({ hasText: product }).click();
  const picker = page.getByRole("dialog", { name: new RegExp(product) });
  await picker.getByRole("button", { name: new RegExp(variant) }).click();
  await picker.getByRole("button", { name: "Done" }).click();
  if (qty !== 1) await page.getByLabel("Quantity for " + product).fill(String(qty));
}

export const completeBtn = (page) => page.getByRole("button", { name: /^Complete sale/ });

/** Stock of every variant of the single product in the emulator, as { "M|Red": 5, … }. */
export async function variantStock(productName) {
  const p = (await records("items")).find((x) => x.name === productName);
  if (!p) return null;
  return Object.fromEntries((p.variants || []).map((v) => [`${v.size}|${v.color}`, v.stockQty]));
}

/**
 * Cut the page off from the Realtime Database (websocket + long-poll fallback) while the app
 * itself keeps loading from the dev server — i.e. "the shop's internet is down". Must be called
 * BEFORE the page (re)loads: an already-open socket is not affected.
 */
export async function blockDatabase(page) {
  await page.routeWebSocket(/127\.0\.0\.1:9000/, (ws) => ws.close());
  await page.route(/127\.0\.0\.1:9000/, (route) => route.abort());
}

export async function unblockDatabase(page) {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  // routeWebSocket handlers are not removed by unrouteAll; replace with a pass-through.
  await page.routeWebSocket(/127\.0\.0\.1:9000/, (ws) => ws.connectToServer());
}
