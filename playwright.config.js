// Playwright smoke tests. They drive the real app (vite dev server in `emulator` mode)
// against the local Firebase Emulator Suite — NEVER the live shop. See CLAUDE.md.
import { defineConfig, devices } from "@playwright/test";

const APP_PORT = 5174; // not 5173, so a normal `npm run dev` can stay open alongside
const PREVIEW_PORT = 5175;
const CI = !!process.env.CI;

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.js",
  // One emulator database is shared by every test, and each test wipes it first.
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    viewport: { width: 1280, height: 800 },
    trace: "off",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", testIgnore: "**/pwa.spec.js", use: { ...devices["Desktop Chrome"] } },
    {
      // The installable/offline shell is only in a PRODUCTION build, so this project runs
      // against `vite preview`. pwa.spec.js blocks every non-local request: the production
      // bundle carries the live Firebase config and must never reach it from a test.
      name: "pwa",
      testMatch: "**/pwa.spec.js",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${PREVIEW_PORT}` },
    },
  ],
  webServer: [
    {
      command: "npm run emulators",
      url: "http://127.0.0.1:9099/", // auth emulator answers here once the suite is up
      reuseExistingServer: !CI,
      timeout: 180_000,
      stdout: "ignore",
      stderr: "pipe",
      // Let firebase-tools stop its Java child (the database emulator); a hard kill orphans it
      // and the next run then finds port 9000 taken.
      gracefulShutdown: { signal: "SIGINT", timeout: 15_000 },
    },
    {
      command: `npx vite --mode emulator --host 127.0.0.1 --port ${APP_PORT} --strictPort`,
      url: `http://127.0.0.1:${APP_PORT}/`,
      reuseExistingServer: !CI,
      timeout: 60_000,
      env: { BROWSER: "none" }, // vite.config has server.open: true — don't pop a browser
    },
    {
      command: `npm run build && npx vite preview --base /clothing-footwear-shop/ --host 127.0.0.1 --port ${PREVIEW_PORT} --strictPort`,
      url: `http://127.0.0.1:${PREVIEW_PORT}/clothing-footwear-shop/`,
      reuseExistingServer: !CI,
      timeout: 120_000,
      env: { BROWSER: "none" },
    },
  ],
});
