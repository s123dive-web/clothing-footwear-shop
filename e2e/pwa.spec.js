// PWA shell: runs against the PRODUCTION build served by `vite preview` (see the "pwa" project
// in playwright.config.js). The production bundle contains the live Firebase config, so every
// request that is not to this machine is aborted — these tests can never reach the live shop.
// They only ever see the sign-in screen.
import { test, expect } from "@playwright/test";

const APP = "/clothing-footwear-shop/";

test.beforeEach(async ({ context }) => {
  await context.route(
    (url) => url.hostname !== "127.0.0.1" && url.hostname !== "localhost",
    (route) => route.abort()
  );
});

test("manifest is linked and describes an installable app", async ({ page, request }) => {
  await page.goto(APP);
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBeTruthy();
  const res = await request.get(new URL(href, page.url()).toString());
  expect(res.ok()).toBe(true);
  const m = await res.json();
  expect(m.display).toBe("standalone");
  expect(m.name).toContain("Shop");
  expect(m.icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  expect(m.icons.some((i) => i.purpose === "maskable")).toBe(true);
  for (const icon of m.icons) {
    const r = await request.get(new URL(icon.src, new URL(href, page.url())).toString());
    expect(r.ok(), icon.src).toBe(true);
  }
});

test("app shell opens with no network after the first visit", async ({ page, context }) => {
  await page.goto(APP);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  // Wait for the service worker to install and take control of this page's scope.
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    if (!reg.active) throw new Error("no active service worker");
  });
  await expect
    .poll(() =>
      page.evaluate(async () => (await caches.keys()).some((k) => k.includes("precache")))
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const names = (await caches.keys()).filter((k) => k.includes("precache"));
        let n = 0;
        for (const name of names) n += (await (await caches.open(name)).keys()).length;
        return n;
      })
    )
    .toBeGreaterThan(20);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  // The logo and every script came from the cache — nothing failed to load.
  const logoOk = await page
    .locator("form img")
    .first()
    .evaluate((img) => img.complete && img.naturalWidth > 0);
  expect(logoOk).toBe(true);
  await context.setOffline(false);
});

test("a new version waits for the user — the page is not reloaded automatically", async ({
  page,
}) => {
  await page.goto(APP);
  await page.evaluate(() => navigator.serviceWorker.ready);
  // The generated worker must not call skipWaiting on install (that would swap versions under
  // an open bill). It only does so when the page sends SKIP_WAITING — i.e. the Reload button.
  const sw = await (await page.request.get(APP + "sw.js")).text();
  expect(sw).not.toMatch(/self\.skipWaiting\(\)\s*[,;]\s*.*clientsClaim/);
  expect(sw).toContain("SKIP_WAITING");
  await expect(page.getByText("Update available")).toHaveCount(0);
});
