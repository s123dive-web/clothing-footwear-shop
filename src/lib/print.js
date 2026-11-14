import { escapeHtml, INR, money } from "./format.js";
import { DEFAULT_SHOP_CONFIG } from "../config/shopConfig.js";

// Brand + payment assets (served from /public). BASE_URL is "/" in dev and the repo
// sub-path on GitHub Pages, so these resolve correctly in both. assetUrl() makes them
// absolute for the print window (about:blank, which can't resolve relative paths).
export const BASE = import.meta.env.BASE_URL;
export const LOGO_SRC = BASE + "logo.jpg";
export const PAYMENT_QR_SRC = BASE + "payment-qr.jpg";
export const assetUrl = (p) => (typeof location !== "undefined" ? location.origin : "") + p;

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

  iframe.onload = () => {
    // Small delay so logo/QR images finish painting before the print dialog opens.
    setTimeout(() => {
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
    }, 250);
  };

  document.body.appendChild(iframe);
  // srcdoc gives a single load event after content + images, and works on mobile Safari/Chrome.
  iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title || "Print")}</title></head><body>${html}</body></html>`;
}

// Variant descriptor for a receipt/history line: "Size M · Maroon" (only the parts present).
export const lineVariantText = (l) =>
  [l.size ? "Size " + l.size : "", l.color || ""].filter(Boolean).join(" · ");

// Build a thermal-style receipt and send it to the printer. `config` is the shop config
// (name, address, gstin, phone, receipt footer, currency, logo) — nothing is hardcoded.
export function printReceipt(sale, config = DEFAULT_SHOP_CONFIG) {
  const rows = sale.lines
    .map((l) => {
      const vt = lineVariantText(l);
      return `<tr><td>${escapeHtml(l.name)}${vt ? `<div class="var">${escapeHtml(vt)}</div>` : ""}</td><td class="c">${l.qty}</td><td class="r">${INR(l.amount)}</td></tr>`;
    })
    .join("");
  const logo = config.logoUrl || assetUrl(LOGO_SRC);
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
    .pay .lbl{font-size:11px;font-weight:bold;margin-top:2px}</style>
    <img class="logo" src="${escapeHtml(logo)}" alt="" onerror="this.style.display='none'" />
    <h2>${escapeHtml(config.name)}</h2>
    ${config.address ? `<div class="meta">${escapeHtml(config.address)}</div>` : ""}
    ${config.phone ? `<div class="meta">☎ ${escapeHtml(config.phone)}</div>` : ""}
    ${config.gstin ? `<div class="meta">GSTIN: ${escapeHtml(config.gstin)}</div>` : ""}
    <div class="meta">${escapeHtml(sale.date)} &nbsp; ${escapeHtml(sale.time)}</div>
    <table>${rows}
    ${
      sale.discount > 0
        ? `<tr><td>Subtotal</td><td></td><td class="r">${INR(sale.subtotal != null ? sale.subtotal : money((sale.total || 0) + sale.discount))}</td></tr>
    <tr><td>Discount${sale.discountPct ? " (" + sale.discountPct + "%)" : ""}</td><td></td><td class="r">−${INR(sale.discount)}</td></tr>`
        : ""
    }
    <tr class="tot"><td>TOTAL</td><td></td><td class="r">${INR(sale.total)}</td></tr>
    </table>
    ${sale.payment ? `<div class="meta">Paid via ${escapeHtml(sale.payment)}${sale.customer ? " — " + escapeHtml(sale.customer) : ""}</div>` : ""}
    ${sale.customer || sale.mobile ? `<div class="meta">Customer: ${escapeHtml(sale.customer || "—")}${sale.mobile ? " · " + escapeHtml(sale.mobile) : ""}</div>` : ""}
    ${sale.payment === "Udhari" ? `<div class="meta">Paid now: ${INR(sale.paid || 0)}${sale.paidMode ? " (" + escapeHtml(sale.paidMode) + ")" : ""} &nbsp; Balance due: ${INR(Math.max(0, (sale.total || 0) - (sale.paid || 0)))}</div>` : ""}
    ${config.receiptFooter ? `<div class="ft">${escapeHtml(config.receiptFooter)}</div>` : ""}
    <div class="pay">
      <img src="${assetUrl(PAYMENT_QR_SRC)}" alt="Scan to pay" onerror="this.style.display='none'" />
      <div class="lbl">Scan to Pay · UPI</div>
    </div>`,
    "Receipt"
  );
}
