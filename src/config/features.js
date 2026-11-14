// Feature flags.
//
// `false` = the feature's code ships but is switched off: no tab, no button, no extra data
// written. Every Phase 4 feature starts OFF and is turned on here, one at a time, once the
// owner has approved it (change the value to `true`, merge, deploy).
//
// `finance: false` is the older flag that hides the deprecated Finance tab.
export const FEATURES = {
  finance: false, // deprecated 2026 — kept for a possible future revival

  // ---- Phase 4 (all off until approved) ----
  paymentSettings: false, // Settings: UPI ID, own payment QR, receipt width 58 / 80 mm
  billNumbers: false, // sequential bill numbers per financial year
  whatsappReceipt: false, // "Send on WhatsApp" for a bill
  dayClose: false, // Day Close tab: cash / UPI / Udhari totals, counted cash
  backupReminder: false, // weekly backup reminder + "last backup N days ago"
  customerLedger: false, // Customers tab: purchases, outstanding, WhatsApp reminder
  restockSuggestions: false, // Restock tab: sell-through, days of stock left
  gstInvoice: false, // HSN + GST rate per product, CGST/SGST split on the receipt
  returns: false, // Returns & exchange from an existing bill
  barcode: false, // camera scan in Billing + printable labels
  staffAccounts: false, // owner / staff roles
};

const DEV_KEY = "cfs-features-dev";

// Is a feature on? In production builds only the table above counts. In dev / emulator / test
// builds a feature can additionally be switched on per browser through localStorage
// (`cfs-features-dev` = {"billNumbers": true}) — that is how the e2e tests exercise features
// that are off for the shop.
export function featureOn(name) {
  if (FEATURES[name]) return true;
  const env = import.meta.env || {};
  if (env.PROD || typeof localStorage === "undefined") return false;
  try {
    return !!JSON.parse(localStorage.getItem(DEV_KEY) || "{}")[name];
  } catch {
    return false;
  }
}

// A tab is shown unless a flag explicitly turns it off.
export const tabEnabled = (key) => !(key in FEATURES) || featureOn(key);
