// Feature "barcode" (off by default): scan → cart, and printable Code 128 labels.
import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resetEmulator,
  login,
  gotoTab,
  addProduct,
  records,
  eventually,
  enableFeatures,
  receiptHtml,
  OWNER,
} from "./helpers.js";

const KURTI = {
  name: "Scan Kurti",
  price: 500,
  cost: 300,
  variants: [
    { size: "M", color: "Red", stock: 5 },
    { size: "L", color: "Red", stock: 5 },
  ],
};
const ZXING_UMD = path.resolve("node_modules/@zxing/library/umd/index.min.js");

test.beforeEach(async () => {
  await resetEmulator();
});

async function setup(page) {
  await enableFeatures(page, ["barcode"]);
  await login(page);
  await addProduct(page, KURTI);
  const [p] = await eventually(async () => {
    const items = await records("items");
    expect(items).toHaveLength(1);
    return items;
  });
  return p;
}

test("typing (or a USB scanner typing) a label code adds that exact variant", async ({ page }) => {
  const p = await setup(page);
  const large = p.variants.find((v) => v.size === "L");
  await gotoTab(page, "Billing (POS)");
  await page.getByRole("button", { name: "📷 Scan barcode" }).click();
  const dlg = page.getByRole("dialog", { name: "Scan barcode" });
  await dlg.getByLabel("Barcode").fill("V" + large.id);
  await dlg.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText(`Added ${KURTI.name} — L · Red`)).toBeVisible();
  await dlg.getByLabel("Barcode").fill("NOT-A-CODE");
  await dlg.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("No product for code “NOT-A-CODE”")).toBeVisible();
  await dlg.getByRole("button", { name: "Done" }).click();
  await expect(page.getByLabel("Quantity for " + KURTI.name)).toHaveValue("1");
  await expect(page.locator("section").filter({ hasText: "Current bill" })).toContainText(
    "L · Red"
  );
});

test("labels: one per variant, and the printed barcode decodes back to the label code", async ({
  page,
}) => {
  const p = await setup(page);
  const html = await receiptHtml(page, () =>
    page.getByRole("button", { name: "🏷 Labels" }).click()
  );
  expect(html.match(/class="lbl"/g)).toHaveLength(2);
  expect(html).toContain("M · Red");
  expect(html).toContain("₹500");

  // Independent check of the Code 128 encoder: rasterise each printed SVG and read it back with
  // the ZXing decoder.
  const svgs = html.match(/<svg[\s\S]*?<\/svg>/g);
  await page.addScriptTag({ path: ZXING_UMD });
  const decoded = await page.evaluate(async (list) => {
    const out = [];
    for (const svg of list) {
      const img = new Image();
      img.src = "data:image/svg+xml;base64," + btoa(svg);
      await img.decode();
      const scale = 4;
      const c = document.createElement("canvas");
      c.width = img.width * scale;
      c.height = img.height * scale;
      const ctx = c.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const big = new Image();
      big.src = c.toDataURL("image/png");
      await big.decode();
      const reader = new window.ZXing.BrowserMultiFormatReader();
      out.push((await reader.decodeFromImageElement(big)).getText());
    }
    return out;
  }, svgs);
  expect(decoded.sort()).toEqual(p.variants.map((v) => "V" + v.id).sort());
});

test("camera: a barcode held up to the camera is read and added to the bill", async () => {
  test.setTimeout(120_000);
  // 1. Draw the label barcode for the "M" variant and turn it into a one-frame MJPEG that
  //    Chromium's fake camera plays in a loop.
  const browser0 = await chromium.launch();
  const page0 = await browser0.newPage({ viewport: { width: 640, height: 480 } });
  await enableFeatures(page0, ["barcode"]);
  await login(page0);
  await addProduct(page0, KURTI);
  const [p] = await eventually(async () => {
    const items = await records("items");
    expect(items).toHaveLength(1);
    return items;
  });
  const medium = p.variants.find((v) => v.size === "M");
  const labelHtml = await receiptHtml(page0, () =>
    page0.getByRole("button", { name: "🏷 Labels" }).click()
  );
  const svg = labelHtml.match(/<svg[\s\S]*?<\/svg>/g)[0];
  await page0.setContent(
    `<body style="margin:0;background:#fff;display:grid;place-items:center;height:480px"><div style="width:560px">${svg.replace(/width="\d+" height="\d+"/, 'width="560" height="200"')}</div></body>`
  );
  const jpeg = await page0.screenshot({ type: "jpeg", quality: 95 });
  await browser0.close();
  const mjpeg = path.join(os.tmpdir(), `cfs-e2e-cam-${Date.now()}.mjpeg`);
  fs.writeFileSync(mjpeg, Buffer.concat([jpeg, jpeg, jpeg]));

  // 2. A browser whose "camera" shows that picture.
  const browser = await chromium.launch({
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${mjpeg}`,
    ],
  });
  try {
    const context = await browser.newContext({ baseURL: "http://127.0.0.1:5174" });
    const page = await context.newPage();
    await enableFeatures(page, ["barcode"]);
    await page.goto("/");
    await page.getByLabel("Email").fill(OWNER.email);
    await page.getByLabel("Password").fill(OWNER.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await gotoTab(page, "Billing (POS)");
    await page.getByRole("button", { name: "📷 Scan barcode" }).click();
    await expect(page.getByText(`Added ${KURTI.name} — M · Red`).first()).toBeVisible({
      timeout: 30_000,
    });
    await page
      .getByRole("dialog", { name: "Scan barcode" })
      .getByRole("button", { name: "Done" })
      .click();
    await expect(page.locator("section").filter({ hasText: "Current bill" })).toContainText(
      "M · Red"
    );
    expect(medium.id).toBeTruthy();
  } finally {
    await browser.close();
    fs.rmSync(mjpeg, { force: true });
  }
});
