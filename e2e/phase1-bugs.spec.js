// Reproductions of the Phase 1 data-integrity bugs (found by code review).
//
// Every test here asserts the CORRECT behaviour and is marked `test.fail` — Playwright's
// "expected to fail" — so the suite stays green today while the bug exists, and goes RED the
// moment a bug is fixed without the annotation being removed. Phase 1 turns each one into a
// plain `test(...)`.
//
// Assertions are deliberately about behaviour (what the cloud and the screen end up showing),
// not about implementation details like which browser storage the cache lives in, so they stay
// valid when Phase 1 replaces localStorage with an IndexedDB cache + outbox.
import { test, expect } from "@playwright/test";
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
  blockDatabase,
  unblockDatabase,
} from "./helpers.js";

const KURTI = {
  name: "Bug Kurti",
  price: 500,
  cost: 300,
  variants: [
    { size: "S", color: "Red", stock: 5 },
    { size: "M", color: "Red", stock: 5 },
    { size: "L", color: "Blue", stock: 5 },
  ],
};
const FULL = { "S|Red": 5, "M|Red": 5, "L|Blue": 5 };
const SOLD_2M = { "S|Red": 5, "M|Red": 3, "L|Blue": 5 };
const EMPTY_CART = "No items yet. Tap a product to begin.";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.beforeEach(async () => {
  await resetEmulator();
});

/** Online: login, create the kurti, and open Billing with 2 × "M · Red" in the cart. */
async function cartWithTwo(page) {
  await login(page);
  await addProduct(page, KURTI);
  await eventually(async () => expect(await variantStock(KURTI.name)).toEqual(FULL));
  await gotoTab(page, "Billing (POS)");
  await addToCart(page, KURTI.name, "M · Red", 2);
}

/**
 * Take the shop offline the way it happens at the counter: the app is (re)opened with no route
 * to the database, and paints from whatever it cached on this device.
 */
async function reopenOffline(page) {
  await sleep(1000); // let the debounced local-cache write (400 ms) happen
  await blockDatabase(page);
  await page.reload();
  await gotoTab(page, "Billing (POS)");
  await expect(page.locator(".pick").filter({ hasText: KURTI.name })).toBeVisible(); // from cache
}

// ---------------------------------------------------------------------------------------------
// 1. Double-tap saves the same bill twice.
// ---------------------------------------------------------------------------------------------
test.fail("BUG 1 · double-tap on Complete sale records exactly one bill", async ({ page }) => {
  await cartWithTwo(page);
  // Two taps landing before the first one's stock transaction has resolved. Dispatching both
  // clicks in one task makes this deterministic instead of a timing race.
  await completeBtn(page).evaluate((btn) => {
    btn.click();
    btn.click();
  });
  await eventually(async () => expect((await records("sales")).length).toBeGreaterThan(0));
  await sleep(1500); // let any duplicate land (300 ms push debounce + round trip)

  expect(await records("sales")).toHaveLength(1);
  expect(await variantStock(KURTI.name)).toEqual(SOLD_2M);
});

// ---------------------------------------------------------------------------------------------
// 2. Completing a sale offline never finishes.
// ---------------------------------------------------------------------------------------------
test.fail(
  "BUG 2 · offline sale completes: cart clears and the user is told it is saved",
  async ({ page }) => {
    await login(page);
    await addProduct(page, KURTI);
    await reopenOffline(page);
    await addToCart(page, KURTI.name, "M · Red", 2);
    await completeBtn(page).click();

    // Within a few seconds — not "whenever the network returns".
    await expect(billPanel(page).getByText(EMPTY_CART)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/saved/i).last()).toBeVisible({ timeout: 5000 });
  }
);

// ---------------------------------------------------------------------------------------------
// 3. A sale that only reached this device's cache is discarded on the next load.
// ---------------------------------------------------------------------------------------------
test.fail(
  "BUG 3 · sale made offline survives a reload and syncs when back online",
  async ({ page }) => {
    await login(page);
    await addProduct(page, KURTI);
    await reopenOffline(page);
    await addToCart(page, KURTI.name, "M · Red", 2);
    await completeBtn(page).click();
    await sleep(1500); // sale is in memory + the local cache; nothing can reach the cloud
    expect(await records("sales")).toHaveLength(0);

    // Network comes back; the shopkeeper reopens the app.
    await unblockDatabase(page);
    await page.reload();
    await expect(page.getByText("Online · syncing live")).toBeVisible();

    await eventually(async () => {
      expect(await records("sales")).toHaveLength(1);
      expect(await variantStock(KURTI.name)).toEqual(SOLD_2M); // decremented once, not twice
    });
    await gotoTab(page, "Sales History");
    await expect(page.getByText("· 1 bill")).toBeVisible();
  }
);

// ---------------------------------------------------------------------------------------------
// 4. Sale record and stock change travel separately, so one can land without the other.
//    The stock transaction is sent immediately; the bill is pushed by a 300 ms debounced slice
//    write. Killing the tab in between (phone locks, browser is swiped away, battery dies)
//    leaves stock changed with no bill — or, for a delete, stock restored with the bill intact.
// ---------------------------------------------------------------------------------------------
test.fail(
  "BUG 4a · sale + stock are atomic: tab killed right after Complete sale",
  async ({ page, context }) => {
    await cartWithTwo(page);
    await completeBtn(page).click();
    // Kill the tab the instant the stock decrement is visible in the cloud.
    await eventually(async () => expect((await variantStock(KURTI.name))["M|Red"]).toBe(3), {
      interval: 5,
    });
    await page.close();
    const billAlreadyThere = (await records("sales")).length > 0;
    test.skip(billAlreadyThere, "race lost: the bill was pushed before the tab could be closed");

    // Reopen the app on the same device; give it time to recover anything it had pending.
    const again = await context.newPage();
    await again.goto("/");
    await expect(again.getByText("Online · syncing live")).toBeVisible();
    await sleep(2000);

    // Stock dropped by 2 ⇒ there must be a bill for those 2 units.
    expect(await variantStock(KURTI.name)).toEqual(SOLD_2M);
    expect(await records("sales")).toHaveLength(1);
  }
);

test.fail(
  "BUG 4b · delete bill + stock restore are atomic: tab killed right after Delete",
  async ({ page, context }) => {
    page.on("dialog", (d) => d.accept());
    await cartWithTwo(page);
    await completeBtn(page).click();
    await expect(page.getByText(/Bill saved/)).toBeVisible();
    await eventually(async () => {
      expect(await records("sales")).toHaveLength(1);
      expect(await variantStock(KURTI.name)).toEqual(SOLD_2M);
    });

    await gotoTab(page, "Sales History");
    await page
      .locator("main div")
      .filter({ hasText: /·\s*1 item/ })
      .filter({ hasText: "₹1,000" })
      .last()
      .click();
    await page.getByRole("button", { name: "🗑 Delete" }).click();
    await eventually(async () => expect((await variantStock(KURTI.name))["M|Red"]).toBe(5), {
      interval: 5,
    });
    await page.close();
    const billAlreadyGone = (await records("sales")).length === 0;
    test.skip(billAlreadyGone, "race lost: the delete was pushed before the tab could be closed");

    const again = await context.newPage();
    await again.goto("/");
    await expect(again.getByText("Online · syncing live")).toBeVisible();
    await sleep(2000);

    // Stock went back up ⇒ the bill must be gone too.
    expect(await variantStock(KURTI.name)).toEqual(FULL);
    expect(await records("sales")).toHaveLength(0);
  }
);

// ---------------------------------------------------------------------------------------------
// 5. Once the dataset outgrows localStorage (~5 MB) the offline cache silently stops updating.
// ---------------------------------------------------------------------------------------------
test.fail(
  "BUG 5 · a large shop (> 5 MB of data) still opens offline from the local cache",
  async ({ page }) => {
    test.setTimeout(120_000);
    // ~1,800 bills × 20 lines ≈ 7 MB of JSON — a couple of busy years.
    const sales = {};
    const day = (n) => new Date(Date.UTC(2025, 0, 1 + n)).toISOString().slice(0, 10);
    for (let i = 0; i < 1800; i++) {
      const id = "big" + String(i).padStart(5, "0");
      sales[id] = {
        id,
        date: day(i % 600),
        time: "11:00 am",
        payment: "Cash",
        total: 10000,
        profit: 4000,
        lines: Array.from({ length: 20 }, (_, k) => ({
          name: `Printed Cotton Anarkali Kurti with Dupatta ${k}`,
          qty: 1,
          price: 500,
          buyPrice: 300,
          amount: 500,
          size: "XL",
          color: "Maroon",
          category: "Clothing",
          subcategory: "Kurtis",
          productId: "p" + k,
          variantId: "v" + k,
        })),
      };
    }
    expect(JSON.stringify(sales).length).toBeGreaterThan(6_000_000);
    await dbPut("shop/sales", sales);
    await dbPut("shop/items/big-item", {
      id: "big-item",
      name: "Big Shop Saree",
      category: "Clothing",
      subcategory: "Sarees",
      sellingPrice: 900,
      purchasePrice: 600,
      variants: [{ id: "v1", size: "Free", color: "Green", stockQty: 4, lowAt: 1 }],
    });

    await login(page);
    await gotoTab(page, "Inventory");
    await expect(page.getByText("Big Shop Saree")).toBeVisible(); // loaded from the cloud
    await sleep(2500); // every chance to write the local cache

    // Internet goes down; app is reopened.
    await blockDatabase(page);
    await page.reload();
    await gotoTab(page, "Inventory");
    await expect(page.getByText("Big Shop Saree")).toBeVisible();
    await gotoTab(page, "Sales History");
    await expect(page.getByText("No sales yet.")).toBeHidden();
    await expect(page.getByText(/· \d+ bills?/).first()).toBeVisible();
  }
);

// ---------------------------------------------------------------------------------------------
// 6. Custom subcategories never leave the device they were created on.
// ---------------------------------------------------------------------------------------------
test.fail(
  "BUG 6 · a custom subcategory added on one device appears on another",
  async ({ page, browser }) => {
    const NAME = "Lehenga Special";
    page.on("dialog", (d) => (d.type() === "prompt" ? d.accept(NAME) : d.accept()));
    await login(page);
    await gotoTab(page, "Inventory");
    await page
      .getByRole("button", { name: /\+ Add (your first )?product/ })
      .first()
      .click();
    const dlg = page.getByRole("dialog", { name: "Add product" });
    await dlg.getByLabel("Subcategory").selectOption("__add"); // "+ Add subcategory…" → prompt()
    await expect(page.getByText(`Subcategory “${NAME}” added.`)).toBeVisible();
    await sleep(1500);

    // Second device: fresh browser profile, same shop account.
    const ctx = await browser.newContext();
    const other = await ctx.newPage();
    await login(other);
    await gotoTab(other, "Inventory");
    const filter = other.locator("main select").filter({ hasText: "All subcategories" });
    await expect(filter).toBeVisible();
    await expect(filter.locator("option", { hasText: NAME })).toHaveCount(1, { timeout: 5000 });
    await ctx.close();
  }
);
