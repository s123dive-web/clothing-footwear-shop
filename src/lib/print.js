import { gstSplit, isGstInvoice } from "./gst.js";
import { billNoText } from "./billNumbers.js";
import { escapeHtml, INR, money } from "./format.js";
import { DEFAULT_SHOP_CONFIG } from "../config/shopConfig.js";

// Brand + payment assets (served from /public). BASE_URL is "/" in dev and the repo
// sub-path on GitHub Pages, so these resolve correctly in both. assetUrl() makes them
// absolute for the print window (about:blank, which can't resolve relative paths).
export const BASE = import.meta.env.BASE_URL;
export const LOGO_SRC = BASE + "logo.jpg";
export const PAYMENT_QR_SRC = BASE + "payment-qr.jpg";
export const assetUrl = (p) => (typeof location !== "undefined" ? location.origin : "") + p;

// How long printing will wait for receipt images before going ahead without them.
export const PRINT_IMAGE_WAIT_MS = 2500;

// Resolves when every image has finished (loaded + decoded, or failed), or after `capMs`.
export function whenImagesReady(imgs, capMs = PRINT_IMAGE_WAIT_MS) {
  const one = (img) => {
    if (img.complete && img.naturalWidth === 0) return Promise.resolve(); // already failed
    const settled = img.complete
      ? Promise.resolve()
      : new Promise((res) => {
          img.addEventListener("load", res, { once: true });
          img.addEventListener("error", res, { once: true });
        });
    return settled.then(() => (img.decode ? img.decode().catch(() => {}) : undefined));
  };
  const cap = new Promise((res) => setTimeout(res, capMs));
  return Promise.race([Promise.all([...imgs].map(one)), cap]);
}

// Warm the browser cache with the images a receipt needs, so the first print of the day does
// not wait on the network. Called when the Billing screen opens.
export function preloadReceiptAssets(config) {
  if (typeof Image === "undefined") return;
  for (const src of [
    (config && config.logoUrl) || assetUrl(LOGO_SRC),
    (config && config.paymentQrUrl) || assetUrl(PAYMENT_QR_SRC),
  ]) {
    const img = new Image();
    img.decoding = "async";
    img.src = src;
  }
}

// Print an HTML document via a hidden iframe. Mobile browsers block window.open popups,
// so the old "open a new window and print" approach silently failed on phones — an iframe
// prints from within the current page (the click is a user gesture) and works everywhere.
export function printHtml(html, title) {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  Object.assign(iframe.style, {
    position: "fixed",
    right: "0",
    bottom: "0",
    width: "0",
    height: "0",
    border: "0",
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      document.body.removeChild(iframe);
    } catch {
      /* already gone */
    }
  };

  const doPrint = () => {
    try {
      const win = iframe.contentWindow;
      win.focus();
      win.onafterprint = cleanup;
      win.print();
      setTimeout(cleanup, 60000); // safety net: afterprint doesn't fire on every mobile browser
    } catch (err) {
      console.error("print failed", err);
      cleanup();
      const w = window.open("", "_blank"); // last-ditch fallback
      if (w) {
        w.document.write(html);
        w.document.close();
      }
    }
  };

  iframe.onload = () => {
    // Print once the logo / payment QR are actually decoded — not after a guessed delay. Each
    // image settles on load, error (it hides itself) or decode; a cap keeps a dead image URL
    // from holding the receipt up.
    let imgs = [];
    try {
      imgs = [...iframe.contentDocument.images];
    } catch {
      /* cross-origin / detached — just print */
    }
    whenImagesReady(imgs, PRINT_IMAGE_WAIT_MS).then(doPrint);
  };

  document.body.appendChild(iframe);
  // srcdoc gives a single load event after content + images, and works on mobile Safari/Chrome.
  iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title || "Print")}</title></head><body>${html}</body></html>`;
}

// Variant descriptor for a receipt/history line: "Size M · Maroon" (only the parts present).
const identity = (key, vars) =>
  vars ? key.replace(/\{(\w+)\}/g, (m, n) => (n in vars ? String(vars[n]) : m)) : key;
export const lineVariantText = (l, t = identity) =>
  [l.size ? t("Size {size}", { size: l.size }) : "", l.color || ""].filter(Boolean).join(" · ");

// Build a thermal-style receipt and send it to the printer. `config` is the shop config
// (name, address, gstin, phone, receipt footer, currency, logo) — nothing is hardcoded.
export function printReceipt(sale, config = DEFAULT_SHOP_CONFIG, t = identity) {
  // GST invoice: only when the shop has a GSTIN and the bill carries a taxed line.
  const gstInv = isGstInvoice(sale, config);
  const gst = gstInv ? gstSplit(sale) : null;
  const gstTable = gst
    ? `<table class="gst"><tr><th>GST%</th><th class="r">${escapeHtml(t("Taxable"))}</th><th class="r">CGST</th><th class="r">SGST</th></tr>${gst.rows
        .map(
          (r) =>
            `<tr><td>${r.rate}%</td><td class="r">${INR(r.taxable)}</td><td class="r">${INR(r.cgst)}</td><td class="r">${INR(r.sgst)}</td></tr>`
        )
        .join(
          ""
        )}<tr class="tot"><td>${escapeHtml(t("Total"))}</td><td class="r">${INR(gst.taxable)}</td><td class="r">${INR(gst.cgst)}</td><td class="r">${INR(gst.sgst)}</td></tr></table><div class="meta">${escapeHtml(t("Prices include GST"))}</div>`
    : "";
  const rows = sale.lines
    .map((l) => {
      const vt = lineVariantText(l, t);
      return `<tr><td>${escapeHtml(l.name)}${vt ? `<div class="var">${escapeHtml(vt)}</div>` : ""}${gstInv && l.hsn ? `<div class="var">HSN ${escapeHtml(l.hsn)} · GST ${Number(l.gstRate) || 0}%</div>` : ""}</td><td class="c">${l.qty}</td><td class="r">${INR(l.amount)}</td></tr>`;
    })
    .join("");
  const logo = config.logoUrl || assetUrl(LOGO_SRC);
  const qr = config.paymentQrUrl || assetUrl(PAYMENT_QR_SRC);
  const billNo = billNoText(sale);
  // Paper width: 58 mm and 80 mm rolls print about 48 mm / 72 mm wide. 0 = the classic layout.
  const mm = config.receiptWidth === 58 ? 48 : config.receiptWidth === 80 ? 72 : 0;
  const page = mm
    ? `@page{size:${config.receiptWidth}mm auto;margin:0}body{width:${mm}mm;padding:2mm;font-size:${mm < 60 ? 11 : 12}px}`
    : "";
  printHtml(
    `<style>body{font-family:'Courier New',monospace;padding:10px;width:280px;color:#000}
    h2{text-align:center;margin:4px 0}.meta{text-align:center;font-size:11px}
    .logo{display:block;margin:0 auto 2px;height:46px;object-fit:contain}
    table{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px}
    td{padding:2px 0}.c{text-align:center}.r{text-align:right}
    .var{font-size:10px;color:#333}
    .tot td{border-top:1px dashed #000;font-weight:bold;padding-top:4px}
    .ft{text-align:center;font-size:11px;margin-top:8px;border-top:1px dashed #000;padding-top:6px;white-space:pre-line}
    .pay{text-align:center;margin-top:10px;border-top:1px dashed #000;padding-top:8px}
    .pay img{width:150px;height:150px;object-fit:contain}
    .pay .lbl{font-size:11px;font-weight:bold;margin-top:2px}
    .gst{font-size:10.5px;margin-top:8px}.gst th{text-align:left;border-bottom:1px dashed #000;font-weight:bold}.gst th.r{text-align:right}${page}${mm && mm < 60 ? "table{font-size:11px}.pay img{width:36mm;height:36mm}" : ""}</style>
    <img class="logo" src="${escapeHtml(logo)}" alt="" onerror="this.style.display='none'" />
    <h2>${escapeHtml(config.name)}</h2>
    ${gstInv ? `<div class="meta"><b>${escapeHtml(t("TAX INVOICE"))}</b></div>` : ""}
    ${sale.type === "return" ? `<div class="meta"><b>${escapeHtml(t("RETURN"))}</b>${sale.refBillNo ? " · " + escapeHtml(t("Bill no: {no}", { no: sale.refBillNo })) : ""}</div>` : ""}
    ${config.address ? `<div class="meta">${escapeHtml(config.address)}</div>` : ""}
    ${config.phone ? `<div class="meta">☎ ${escapeHtml(config.phone)}</div>` : ""}
    ${config.gstin ? `<div class="meta">GSTIN: ${escapeHtml(config.gstin)}</div>` : ""}
    <div class="meta">${escapeHtml(sale.date)} &nbsp; ${escapeHtml(sale.time)}</div>
    ${billNo ? `<div class="meta">${escapeHtml(t("Bill no: {no}", { no: billNo }))}</div>` : ""}
    <table>${rows}
    ${
      sale.discount > 0
        ? `<tr><td>${escapeHtml(t("Subtotal"))}</td><td></td><td class="r">${INR(sale.subtotal != null ? sale.subtotal : money((sale.total || 0) + sale.discount))}</td></tr>
    <tr><td>${escapeHtml(t("Discount"))}${sale.discountPct ? " (" + sale.discountPct + "%)" : ""}</td><td></td><td class="r">−${INR(sale.discount)}</td></tr>`
        : ""
    }
    <tr class="tot"><td>${escapeHtml(t("TOTAL"))}</td><td></td><td class="r">${INR(sale.total)}</td></tr>
    ${
      sale.creditUsed > 0
        ? `<tr><td>${escapeHtml(t("Exchange credit"))}</td><td></td><td class="r">−${INR(sale.creditUsed)}</td></tr>
    <tr class="tot"><td>${escapeHtml(t("To pay"))}</td><td></td><td class="r">${INR((sale.total || 0) - sale.creditUsed)}</td></tr>`
        : ""
    }
    </table>
    ${sale.payment ? `<div class="meta">${escapeHtml(t("Paid via {mode}", { mode: t(sale.payment) }))}${sale.customer ? " — " + escapeHtml(sale.customer) : ""}</div>` : ""}
    ${sale.customer || sale.mobile ? `<div class="meta">${escapeHtml(t("Customer: {name}", { name: sale.customer || "—" }))}${sale.mobile ? " · " + escapeHtml(sale.mobile) : ""}</div>` : ""}
    ${sale.payment === "Udhari" ? `<div class="meta">${escapeHtml(t("Paid now: {amount}", { amount: INR(sale.paid || 0) }))}${sale.paidMode ? " (" + escapeHtml(t(sale.paidMode)) + ")" : ""} &nbsp; ${escapeHtml(t("Balance due: {amount}", { amount: INR(Math.max(0, (sale.total || 0) - (sale.paid || 0))) }))}</div>` : ""}
    ${gstTable}
    ${config.receiptFooter ? `<div class="ft">${escapeHtml(config.receiptFooter)}</div>` : ""}
    <div class="pay">
      <img src="${escapeHtml(qr)}" alt="Scan to pay" onerror="this.style.display='none'" />
      <div class="lbl">${escapeHtml(t("Scan to Pay · UPI"))}</div>
      ${config.upiId ? `<div class="meta">${escapeHtml(config.upiId)}</div>` : ""}
    </div>`,
    t("Receipt")
  );
}
