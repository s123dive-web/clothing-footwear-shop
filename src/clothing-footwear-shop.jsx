import { useState, useEffect, useMemo, useRef, useCallback, Fragment } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  LineChart,
  Line,
  ComposedChart,
  Treemap,
  ReferenceLine,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  EmailAuthProvider,
  reauthenticateWithCredential,
} from "firebase/auth";
import { auth, isFirebaseConfigured } from "./config/firebase.js";
import { CURRENCY, setCurrencySymbol } from "./config/currency.js";
import {
  DEFAULT_SHOP_CONFIG,
  ShopConfigContext,
  useShopConfig,
  normalizeConfig,
  validateConfig,
  loadCachedConfig,
  cacheConfig,
  subscribeShopConfig,
  saveShopConfig,
} from "./config/shopConfig.js";
import {
  GROUPS,
  SUBCATEGORIES_BY_GROUP,
  ALL_SUBCATEGORIES,
  groupForSubcategory,
  CLOTHING_SIZES,
  sizesForProduct,
  COLOR_SWATCHES,
  guessSubcategory,
  subcatIcon,
} from "./lib/catalog.js";
import {
  blankProduct,
  blankVariant,
  productStock,
  productLowVariants,
  isProductLow,
  variantLabel,
  applyVariantDelta,
  normalizeProduct,
  mergeProductGroup,
  buildSeedProducts,
} from "./lib/products.js";
import {
  toMap,
  mapToArray,
  isLegacyShape,
  buildSliceUpdate,
  mergeRemote,
  writeSlice,
  overwriteSlice,
  subscribeSlice,
  subscribeConnection,
  updateItemAtomic,
  readMeta,
  writeMeta,
} from "./lib/sync.js";
import { parseFile, parseRawText } from "./lib/parse.js";
import { exportJson, exportXlsx, importXlsx } from "./lib/backup.js";
import { uploadBillProof, deleteBillProof, PROOF_ACCEPT, MAX_PROOF_BYTES } from "./lib/bills.js";
import {
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  SUPPLIER_CATEGORIES,
  itemsForCategory,
  blankDailyBill,
  validateDailyBill,
  dailyOutstanding,
  makeDailyBill,
  dailyToVendorBill,
  upsertMirror,
  lineTotal,
} from "./lib/dailyBills.js";
import {
  formatINR,
  inrCompact,
  summarize,
  dailyRevenueSeries,
  monthlyRevenueProfit,
  salesHeatmap,
  topItems as topItemsBy,
  paymentBreakdown,
  udhariOutstandingSeries,
  inventoryValue,
  inventoryByCategory,
  deadStock,
  breakEvenSeries,
  breakEvenEstimate,
  expenseTotal,
  expenseByMonth,
  expenseBreakdown,
  salesByCategory,
  topSizes,
  DOW,
  DOW_ORDER,
  hourLabel,
} from "./lib/stats.js";

// ---------- helpers ----------
// Format money with the shop's configured currency symbol (defaults to ₹).
const INR = (n) =>
  CURRENCY.symbol + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
// Round money to 2 decimals so bill totals don't drift (e.g. 0.1 + 0.2 = 0.30000004).
// A non-numeric input collapses to 0 rather than poisoning a total with NaN.
const money = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round((v + Number.EPSILON) * 100) / 100 : 0;
};
// Local calendar date as YYYY-MM-DD. MUST be local, not toISOString() (which is UTC)
// — otherwise early-morning sales in IST get filed under the previous day.
const dateStr = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayStr = () => dateStr(new Date());
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

// Brand + payment assets (served from /public). BASE_URL is "/" in dev and the repo
// sub-path on GitHub Pages, so these resolve correctly in both. assetUrl() makes them
// absolute for the print window (about:blank, which can't resolve relative paths).
const BASE = import.meta.env.BASE_URL;
const LOGO_SRC = BASE + "logo.jpg";
const PAYMENT_QR_SRC = BASE + "payment-qr.jpg";
const assetUrl = (p) => (typeof location !== "undefined" ? location.origin : "") + p;

// Print an HTML document via a hidden iframe. Mobile browsers block window.open popups,
// so the old "open a new window and print" approach silently failed on phones — an iframe
// prints from within the current page (the click is a user gesture) and works everywhere.
function printHtml(html, title) {
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
const lineVariantText = (l) =>
  [l.size ? "Size " + l.size : "", l.color || ""].filter(Boolean).join(" · ");

// Build a thermal-style receipt and send it to the printer. `config` is the shop config
// (name, address, gstin, phone, receipt footer, currency, logo) — nothing is hardcoded.
function printReceipt(sale, config = DEFAULT_SHOP_CONFIG) {
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
// ---------- apparel domain glue ----------
// Activity-log categories (generic; unchanged across domains).
const LOG_TYPES = ["sale", "inventory", "expense", "import", "backup", "bill"];

// A product's display icon: its own stored icon, else derived from its subcategory / group.
const iconFor = (p) => (p && p.icon) || subcatIcon(p && p.subcategory, p && p.category);

// ---------- authentication (Firebase email/password) ----------
// Real server-side auth via Firebase. Data is gated by the database security rules
// (locked to the shop owner's email), so it is genuinely private — not just a UI gate.
const AUTH_ERRORS = {
  "auth/invalid-credential": "Incorrect email or password.",
  "auth/wrong-password": "Incorrect email or password.",
  "auth/user-not-found": "No account with that email.",
  "auth/invalid-email": "That email address looks invalid.",
  "auth/missing-password": "Please enter your password.",
  "auth/too-many-requests": "Too many attempts — please wait a minute and retry.",
  "auth/network-request-failed": "Network error — check your internet connection.",
  "auth/unauthorized-domain": "This web address isn't authorised in Firebase Auth settings.",
};
const authMessage = (code) => AUTH_ERRORS[code] || "Could not sign in. Please try again.";

function Login() {
  // The Realtime DB config is locked behind auth, so on the sign-in screen we can only use
  // whatever was cached from a previous session (falling back to defaults for a fresh device).
  const cfg = loadCachedConfig() || DEFAULT_SHOP_CONFIG;
  const [email, setEmail] = useState("");
  const [pwd, setPwd] = useState("");
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setErr("");
    setInfo("");
    try {
      await signInWithEmailAndPassword(auth, email.trim(), pwd);
      // App's auth listener swaps to the dashboard on success.
    } catch (ex) {
      setErr(authMessage(ex.code));
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!email.trim()) return setErr("Enter your email above first, then tap reset.");
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setErr("");
      setInfo("Password reset link sent to " + email.trim());
    } catch (ex) {
      setErr(authMessage(ex.code));
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "#10331F",
        padding: 16,
      }}
    >
      <style>{CSS}</style>
      <form
        onSubmit={submit}
        style={{
          background: "#fff",
          borderRadius: 16,
          padding: "26px 24px",
          width: "min(380px, 94vw)",
          boxShadow: "0 12px 40px rgba(0,0,0,.3)",
        }}
      >
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <img
            src={cfg.logoUrl || LOGO_SRC}
            alt=""
            style={{ width: 52, height: 52, borderRadius: 12, objectFit: "contain", flexShrink: 0 }}
            onError={(e) => {
              e.currentTarget.style.visibility = "hidden";
            }}
          />
          <div>
            <div style={{ fontWeight: 800, fontSize: 18, letterSpacing: "-0.02em" }}>
              {cfg.name}
            </div>
            <div style={{ fontSize: 11.5, color: "#8A9C90" }}>{cfg.address || cfg.tagline}</div>
          </div>
        </div>
        <h2 style={{ fontSize: 16, margin: "18px 0 12px" }}>Sign in</h2>
        <Field label="Email">
          <input
            className="input"
            type="email"
            value={email}
            autoComplete="username"
            autoFocus
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Password">
          <input
            className="input"
            type="password"
            value={pwd}
            autoComplete="current-password"
            onChange={(e) => setPwd(e.target.value)}
          />
        </Field>
        {err && <div style={{ color: "#C44536", fontSize: 13, marginBottom: 8 }}>{err}</div>}
        {info && <div style={{ color: "#1B5E43", fontSize: 13, marginBottom: 8 }}>{info}</div>}
        <button className="btn primary big" type="submit" style={{ width: "100%" }} disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <button
          type="button"
          onClick={reset}
          style={{
            display: "block",
            background: "none",
            border: "none",
            color: "#1B5E43",
            fontSize: 12,
            marginTop: 10,
            cursor: "pointer",
            padding: 0,
          }}
        >
          Forgot password? Email me a reset link
        </button>
        <div style={{ fontSize: 11, color: "#8A9C90", marginTop: 12, lineHeight: 1.5 }}>
          Sign in with your shop account. Your data syncs live across every device that signs in.
        </div>
      </form>
    </div>
  );
}

// ---------- Firebase-not-configured screen ----------
// Shown when src/config/firebase.js still holds placeholder values, so the app degrades to a
// clear setup message instead of crashing on Firebase init / null auth.
function FirebaseSetupNeeded() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "#2A1A22",
        padding: 20,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 16,
          padding: "28px 26px",
          maxWidth: 560,
          boxShadow: "0 12px 40px rgba(0,0,0,.35)",
        }}
      >
        <h1 style={{ fontSize: 20, margin: "0 0 6px", color: "#8E2C48" }}>
          ⚙️ Configure Firebase to get started
        </h1>
        <p style={{ color: "#445", lineHeight: 1.55, fontSize: 14 }}>
          This app needs its own Firebase project before it can run. Right now
          <code
            style={{ background: "#F4EEF0", padding: "1px 5px", borderRadius: 5, margin: "0 3px" }}
          >
            src/config/firebase.js
          </code>
          still contains placeholder values.
        </p>
        <ol style={{ color: "#445", lineHeight: 1.7, fontSize: 13.5, paddingLeft: 20 }}>
          <li>
            Create a project at <b>console.firebase.google.com</b>.
          </li>
          <li>
            Enable <b>Realtime Database</b> and <b>Authentication → Email/Password</b>.
          </li>
          <li>
            Copy your web-app config into <b>src/config/firebase.js</b> (replace every{" "}
            <code>YOUR_…</code> value).
          </li>
          <li>
            Deploy the security rules: <code>firebase deploy --only database,storage</code>.
          </li>
        </ol>
        <p style={{ color: "#889", fontSize: 12.5, marginTop: 10 }}>
          See the README (“Firebase setup”) for the full walkthrough.
        </p>
      </div>
    </div>
  );
}

// ---------- root: Firebase auth gate ----------
export default function App() {
  const [user, setUser] = useState(undefined); // undefined = checking, null = signed out
  useEffect(() => {
    if (!isFirebaseConfigured) return; // auth is null until real config is filled in
    return onAuthStateChanged(auth, setUser);
  }, []);
  if (!isFirebaseConfigured) return <FirebaseSetupNeeded />;
  if (user === undefined) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#2A1A22",
          color: "#E6C9D4",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        Loading…
      </div>
    );
  }
  if (!user) return <Login />;
  return <StoreManager user={user} onLogout={() => signOut(auth)} />;
}

// ---------- main app ----------
// Feature flags for deprecating a section from the live UI WITHOUT deleting its
// code. A tab listed here as `false` is dropped from the sidebar and its render
// branch is skipped; the component and all its logic stay intact below. To bring
// a section back, flip its flag to `true` (or remove the line).
const FEATURES = {
  finance: false, // deprecated 2026 — kept for a possible future revival
};
// A tab is shown unless a flag explicitly turns it off.
const tabEnabled = (k) => FEATURES[k] !== false;

// Top-level sidebar destinations, plus the secondary group tucked under "Other".
// Both feed the same `tab` switch below — grouping is purely a nav-rendering concern.
const TOP_TABS = [
  ["dashboard", "⌂", "Dashboard"],
  ["billing", "🛍️", "Billing (POS)"],
  ["inventory", "👗", "Inventory"],
  ["sales", "⊟", "Sales History"],
  ["finance", "∑", "Finance"],
  ["stats", "📊", "Reports"],
  ["udhari", "💳", "Udhari (Credit)"],
  ["expense", "⊝", "Add Expense"],
  ["dailybills", "🧺", "Supplier Bills"],
];
const OTHER_TABS = [
  ["alerts", "⚠", "Alerts"],
  ["vendorbills", "🧾", "Vendor Bills"],
  ["raw", "⇪", "Data Import"],
  ["logs", "❑", "Activity Log"],
  ["settings", "⚙", "Settings"],
  ["admin", "🛠", "Admin"],
];

// localStorage keys (namespaced to this app; nothing carried over from the grocery build).
const CACHE_KEY = "cfs-cache-v1";
const CUSTOM_CATS_KEY = "cfs-custom-subcats-v1";

// Full subcategory list shown in dropdowns = built-in apparel subcategories, plus any already on
// a product, plus owner-added custom ones. De-duped case-insensitively, built-in order preserved.
function subcatList(items = [], custom = []) {
  const seen = new Set();
  const out = [];
  const add = (c) => {
    const t = (c == null ? "" : String(c)).trim();
    if (!t) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  ALL_SUBCATEGORIES.forEach(add);
  items.forEach((i) => add(i.subcategory));
  custom.forEach(add);
  return out;
}

// A URL/filename-safe slug of the shop name for backup filenames.
const slugify = (s) =>
  String(s || "shop")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "shop";

// ---------------------------------------------------------------------------
// Cloud product writes (the `items` slice). Every write is a Firebase transaction, so two
// devices changing stock at the same time apply their deltas on top of the freshest server
// value instead of clobbering each other (fixes the grocery app's silent-overwrite bug).
// Local product state is refreshed by the onValue echo — Firebase surfaces local writes to the
// listener immediately, so the UI updates instantly and offline edits still show this session.
// ---------------------------------------------------------------------------

// Create or replace a whole product record (metadata + variant structure). Preserves createdAt
// and bumps the version; when editing an existing record, untouched server fields are replaced
// by the passed product (the caller edits a snapshot, so this is an intentional owner override).
async function cloudWriteProduct(product) {
  const p = normalizeProduct(product);
  await updateItemAtomic(p.id, (curr) => ({
    ...p,
    createdAt: (curr && curr.createdAt) || p.createdAt || todayStr(),
    updatedAt: todayStr(),
    version: ((curr && curr.version) || 0) + 1,
  }));
  return p.id;
}

// Delete a product (transaction returning null removes the node).
const cloudDeleteProduct = (id) => updateItemAtomic(id, () => null);

// Atomically add stock to one variant (restock).
const cloudRestockVariant = (productId, variantId, qty) =>
  updateItemAtomic(productId, (curr) => {
    if (!curr) return curr;
    const p = applyVariantDelta(normalizeProduct(curr), variantId, Math.abs(Number(qty) || 0));
    p.updatedAt = todayStr();
    p.version = (curr.version || 0) + 1;
    return p;
  });

// Atomically apply a signed delta to one variant's stock (used to restore stock on bill delete).
const cloudAdjustVariant = (productId, variantId, delta) =>
  updateItemAtomic(productId, (curr) => {
    if (!curr) return curr;
    const p = applyVariantDelta(normalizeProduct(curr), variantId, Number(delta) || 0);
    p.updatedAt = todayStr();
    p.version = (curr.version || 0) + 1;
    return p;
  });

// Atomically decrement stock for every (non-misc) line of a completed bill. One transaction per
// product so a bill's lines for the same product commit together against the freshest counts.
async function cloudSellCart(cart) {
  const byProduct = new Map();
  for (const c of cart) {
    if (c.misc || !c.productId) continue;
    if (!byProduct.has(c.productId)) byProduct.set(c.productId, []);
    byProduct.get(c.productId).push(c);
  }
  await Promise.all(
    [...byProduct.entries()].map(([pid, lines]) =>
      updateItemAtomic(pid, (curr) => {
        if (!curr) return curr; // product deleted meanwhile — nothing to decrement
        let p = normalizeProduct(curr);
        for (const l of lines) p = applyVariantDelta(p, l.variantId, -Math.abs(Number(l.qty) || 0));
        p.updatedAt = todayStr();
        p.version = (curr.version || 0) + 1;
        return p;
      })
    )
  );
}

function StoreManager({ user, onLogout }) {
  const [tab, setTab] = useState("dashboard");
  const [otherOpen, setOtherOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [sales, setSales] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [logs, setLogs] = useState([]);
  const [bills, setBills] = useState([]); // vendor purchase bills (vendorBills slice)
  const [dailyBills, setDailyBills] = useState([]); // daily-need vendor bills (dailyBills slice; mirrors into vendorBills)
  // Owner-added categories that have no item yet (device-local; once an item uses one it also
  // rides along in the synced items data). Merged with the built-ins + item categories below.
  const [customCats, setCustomCats] = useState(() => {
    try {
      const c = JSON.parse(localStorage.getItem(CUSTOM_CATS_KEY) || "[]");
      return Array.isArray(c) ? c.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  });
  const [loaded, setLoaded] = useState(false);
  const [toast, setToast] = useState(null);

  // ---- Shop config (name / address / currency / logo / receipt footer), stored at
  //      shop/shopConfig and cached locally. Every screen reads it via ShopConfigContext. ----
  const [config, setConfig] = useState(() => loadCachedConfig() || DEFAULT_SHOP_CONFIG);
  useEffect(() => {
    setCurrencySymbol(config.currency);
  }, [config.currency]);
  useEffect(() => {
    const unsub = subscribeShopConfig(
      (cfg) => {
        setConfig(cfg);
        cacheConfig(cfg);
        setCurrencySymbol(cfg.currency);
      },
      (err) => console.error("shop-config read failed", err)
    );
    return () => unsub && unsub();
  }, []);

  // ---- Realtime Database sync (live across every signed-in device) ----
  // Every record (product/sale/expense/log) lives at its own keyed node — shop/<slice>/<id> —
  // so concurrent edits from different devices to different records merge instead of
  // clobbering. Writes are field-level deltas; incoming snapshots are 3-way merged with any
  // un-pushed local edits. A localStorage cache gives instant first paint and offline reads.
  // See src/lib/sync.js for the array↔map bridge.
  const lastRemote = useRef({
    items: {},
    sales: {},
    expenses: {},
    logs: {},
    vendorBills: {},
    dailyBills: {},
  }); // last cloud map per slice
  const synced = useRef({
    items: false,
    sales: false,
    expenses: false,
    logs: false,
    vendorBills: false,
    dailyBills: false,
  });
  const seeded = useRef(false);
  const [online, setOnline] = useState(true);

  // Always-current local state, readable from inside async listeners (for the merge).
  const dataRef = useRef({ items, sales, expenses, logs, vendorBills: bills, dailyBills });
  dataRef.current = { items, sales, expenses, logs, vendorBills: bills, dailyBills };
  const notifyRef = useRef(null);

  // 1) Instant paint from the local cache.
  useEffect(() => {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (c) {
        setItems(c.items || []);
        setSales(c.sales || []);
        setExpenses(c.expenses || []);
        setLogs(c.logs || []);
        setBills(c.vendorBills || []);
        setDailyBills(c.dailyBills || []);
      }
    } catch (e) {
      console.error("cache read failed", e);
    }
    setLoaded(true);
  }, []);

  // 2) Subscribe to the cloud; changes from any device flow in live.
  useEffect(() => {
    const slices = [
      ["items", setItems],
      ["sales", setSales],
      ["expenses", setExpenses],
      ["logs", setLogs],
      ["vendorBills", setBills],
      ["dailyBills", setDailyBills],
    ];
    const unsubs = slices.map(([slice, setter]) =>
      subscribeSlice(
        slice,
        (val) => {
          // First run anywhere: seed the catalogue ONCE, guarded by a DB-level flag
          // (shop/meta/seeded) so that deleting every product does NOT make the seed
          // catalogue resurrect on the next sync/reload. (Fixes the grocery app's
          // seed-resurrection bug.)
          if (slice === "items" && val === null) {
            if (seeded.current) {
              synced.current.items = true;
              return;
            }
            seeded.current = true; // guard within this session while the flag read is in flight
            readMeta("seeded")
              .then((already) => {
                if (already) {
                  // Seeded before; the owner has since cleared the catalogue. Respect empty.
                  lastRemote.current.items = {};
                  synced.current.items = true;
                  return;
                }
                const products = buildSeedProducts(todayStr());
                const map = toMap(products);
                lastRemote.current.items = map;
                synced.current.items = true;
                setItems(mapToArray("items", map));
                overwriteSlice("items", map).catch((e) => console.error("seed write failed", e));
                writeMeta("seeded", true).catch((e) => console.error("seed flag write failed", e));
              })
              .catch((e) => {
                console.error("seed flag read failed", e);
                // Fail safe: do NOT seed on error (avoids resurrecting data); just mark synced.
                synced.current.items = true;
              });
            return;
          }
          const theirs = toMap(val);
          // One-time migration of legacy array / numeric-keyed data → keyed-by-id map.
          if (isLegacyShape(val, theirs)) {
            overwriteSlice(slice, theirs).catch((e) => console.error("migrate failed", slice, e));
          }
          const base = lastRemote.current[slice];
          const wasSynced = synced.current[slice];
          lastRemote.current[slice] = theirs;
          synced.current[slice] = true;
          // Merge against the TRUE current state via the functional updater — NOT a ref that
          // may lag a just-dispatched local edit by a render. This is what stops an incoming
          // snapshot from silently reverting an edit/restock/delete made a moment earlier.
          setter((curr) =>
            mapToArray(slice, wasSynced ? mergeRemote(base, theirs, toMap(curr)) : theirs)
          );
        },
        (err) => {
          console.error("sync read failed", slice, err);
          notifyRef.current?.("⚠ Cloud sync error — check your connection or account access.");
        }
      )
    );
    const unsubConn = subscribeConnection(setOnline);
    return () => {
      unsubs.forEach((u) => u());
      unsubConn();
    };
  }, []);

  // 3) Push field-level deltas to the cloud when a slice changes locally (after the first
  //    cloud snapshot). buildSliceUpdate skips no-op echoes, so this is loop-safe.
  const pushSlice = useCallback((slice, value) => {
    if (!synced.current[slice]) return; // don't write before we've read the cloud once
    const { updates, nextMap, changed } = buildSliceUpdate(lastRemote.current[slice], value);
    if (!changed) return;
    lastRemote.current[slice] = nextMap; // optimistic; the echo snapshot confirms it
    writeSlice(slice, updates).catch((e) => {
      console.error("sync write failed", slice, e);
      notify("⚠ Couldn't sync to cloud — saved on this device, will retry when back online.");
    });
  }, []);
  // NOTE: the `items` (products) slice is intentionally NOT delta-pushed here. All product
  // writes go through Firebase transactions (cloudWriteProduct / cloudSellCart / …) so that
  // concurrent stock changes from two devices can never silently overwrite each other. Local
  // product state is updated purely by the onValue echo — Firebase applies local writes to its
  // cache immediately, so the UI stays instant (and works offline within a session).
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => pushSlice("sales", sales), 300);
    return () => clearTimeout(t);
  }, [sales, loaded, pushSlice]);
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => pushSlice("expenses", expenses), 300);
    return () => clearTimeout(t);
  }, [expenses, loaded, pushSlice]);
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => pushSlice("logs", logs), 300);
    return () => clearTimeout(t);
  }, [logs, loaded, pushSlice]);
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => pushSlice("vendorBills", bills), 300);
    return () => clearTimeout(t);
  }, [bills, loaded, pushSlice]);
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => pushSlice("dailyBills", dailyBills), 300);
    return () => clearTimeout(t);
  }, [dailyBills, loaded, pushSlice]);

  // 4) Mirror to a local cache (instant next paint + offline reads + no data loss on close).
  useEffect(() => {
    if (!loaded) return;
    const writeCache = () => {
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(dataRef.current));
      } catch (e) {
        console.error("cache write failed", e);
      }
    };
    const t = setTimeout(writeCache, 400);
    const onHide = () => {
      if (document.visibilityState === "hidden") writeCache();
    };
    window.addEventListener("beforeunload", writeCache);
    window.addEventListener("pagehide", writeCache);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      clearTimeout(t);
      window.removeEventListener("beforeunload", writeCache);
      window.removeEventListener("pagehide", writeCache);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [items, sales, expenses, logs, bills, dailyBills, loaded]);

  const toastTimer = useRef(null);
  const notify = (msg) => {
    if (toastTimer.current) clearTimeout(toastTimer.current); // don't let an old timer cut a new toast short
    setToast(msg);
    toastTimer.current = setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, 2200);
  };
  notifyRef.current = notify; // let the cloud listener surface errors via the same toast

  // Persist owner-added subcategories locally; the full list shown everywhere merges these with
  // the built-in apparel subcategories and any subcategory already on a product.
  useEffect(() => {
    try {
      localStorage.setItem(CUSTOM_CATS_KEY, JSON.stringify(customCats));
    } catch (e) {
      console.error("custom cats write failed", e);
    }
  }, [customCats]);
  const cats = useMemo(() => subcatList(items, customCats), [items, customCats]);

  // Prompt for and add a new subcategory. Returns the canonical name to select (existing match if
  // it's a duplicate, the new name otherwise), or null if cancelled/blank. Used by the Add/Edit forms.
  const addCategory = useCallback(() => {
    const raw = window.prompt("New subcategory name:");
    if (raw == null) return null;
    const name = raw.trim();
    if (!name) return null;
    const existing = subcatList(dataRef.current.items, customCats).find(
      (c) => c.toLowerCase() === name.toLowerCase()
    );
    if (existing) {
      notifyRef.current?.(`“${existing}” already exists.`);
      return existing;
    }
    setCustomCats((cs) => [...cs, name]);
    notifyRef.current?.(`Subcategory “${name}” added.`);
    return name;
  }, [customCats]);

  // Save shop-config changes: update local state + cache optimistically, then persist to the
  // cloud so every signed-in device (header, receipts, reports) picks up the new identity.
  const updateConfig = useCallback(
    async (patch) => {
      const next = normalizeConfig({ ...config, ...patch });
      setConfig(next);
      cacheConfig(next);
      setCurrencySymbol(next.currency);
      try {
        await saveShopConfig(patch);
        addLog("backup", "Shop settings updated");
        notify("Settings saved");
      } catch (e) {
        console.error("config save failed", e);
        notify("⚠ Couldn't save settings to cloud (saved on this device).");
      }
    },
    [config]
  );

  const resetMyPassword = async () => {
    if (!user?.email) return;
    if (!confirm(`Send a password reset link to ${user.email}?`)) return;
    try {
      await sendPasswordResetEmail(auth, user.email);
      notify("Reset link sent to " + user.email);
    } catch (e) {
      console.error("reset failed", e);
      notify("⚠ Could not send reset email.");
    }
  };

  // Append an entry to the global activity log (newest first; capped to protect storage).
  const addLog = (type, message) => {
    const now = new Date();
    setLogs((l) =>
      [
        {
          id: uid(),
          at: now.getTime(),
          date: todayStr(),
          time: now.toLocaleTimeString("en-IN", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }),
          type,
          message,
        },
        ...l,
      ].slice(0, 2000)
    );
  };

  const exportData = (fmt) => {
    const data = { items, sales, expenses, logs, vendorBills: bills, dailyBills };
    const fname = `${slugify(config.name)}-${todayStr()}.${fmt === "xlsx" ? "xlsx" : "json"}`;
    try {
      if (fmt === "xlsx") exportXlsx(data, fname);
      else exportJson(data, fname);
      addLog("backup", `Backup downloaded (${fmt.toUpperCase()})`);
      notify(`Backup downloaded (${fmt.toUpperCase()})`);
    } catch (err) {
      console.error("backup failed", err);
      notify("⚠ Could not create the backup file.");
    }
  };

  const importData = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // allow re-importing the same file later
    if (!f) return;
    try {
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      const d = ext === "xlsx" || ext === "xls" ? await importXlsx(f) : JSON.parse(await f.text());
      if (!d || !Array.isArray(d.items)) throw new Error("bad file");
      if (!confirm("Restore this backup? It will REPLACE all current data everywhere it syncs."))
        return;
      // Products go to the cloud (they're transaction-managed, not delta-pushed); local state
      // updates via the echo. Mark seeded so the restore isn't wiped by the first-run seeder.
      const products = d.items.map(normalizeProduct);
      await overwriteSlice("items", toMap(products));
      await writeMeta("seeded", true);
      setSales(Array.isArray(d.sales) ? d.sales : []);
      setExpenses(Array.isArray(d.expenses) ? d.expenses : []);
      setLogs(Array.isArray(d.logs) ? d.logs : []);
      setBills(Array.isArray(d.vendorBills) ? d.vendorBills : []);
      setDailyBills(Array.isArray(d.dailyBills) ? d.dailyBills : []);
      addLog("backup", `Backup restored (${ext.toUpperCase()})`);
      notify("Backup restored");
    } catch (err) {
      console.error("restore failed", err);
      notify("⚠ That file is not a valid backup.");
    }
  };

  // Low stock is evaluated at the VARIANT level: a product is "low" when any of its size/colour
  // variants is at or below its own threshold.
  const lowStock = items.filter(isProductLow);
  const alertCount = lowStock.length;
  // Show the "Other" sub-list when the user toggled it open, or whenever an active tab
  // lives inside it (so the current page is never hidden behind a collapsed group).
  const showOther = otherOpen || OTHER_TABS.some(([k]) => k === tab);

  return (
    <ShopConfigContext.Provider value={config}>
      <div className="app" style={S.app}>
        <style>{CSS}</style>
        {/* sidebar */}
        <nav className="nav" style={S.nav}>
          <div style={S.logo}>
            <img
              src={config.logoUrl || LOGO_SRC}
              alt=""
              style={{
                width: 42,
                height: 42,
                borderRadius: 10,
                objectFit: "contain",
                background: "#fff",
                padding: 2,
                flexShrink: 0,
              }}
              onError={(e) => {
                e.currentTarget.style.visibility = "hidden";
              }}
            />
            <div>
              <div style={{ fontWeight: 800, fontSize: 14.5, letterSpacing: "-0.02em" }}>
                {config.name}
              </div>
              <div style={{ fontSize: 10.5, color: "#9DB5A8", lineHeight: 1.3 }}>
                {config.address || config.tagline}
              </div>
            </div>
          </div>
          {TOP_TABS.filter(([k]) => tabEnabled(k)).map(([k, ic, label]) => (
            <button
              key={k}
              className={"navbtn" + (tab === k ? " active" : "")}
              onClick={() => setTab(k)}
            >
              <span style={{ width: 22, display: "inline-block", textAlign: "center" }}>{ic}</span>{" "}
              {label}
              {k === "inventory" && lowStock.length > 0 && (
                <span style={S.badge}>{lowStock.length}</span>
              )}
            </button>
          ))}
          {/* "Other" group — collapses the secondary sections. Auto-opens when one of its
            tabs is active so the current page is always visible in the rail. */}
          <button
            className={"navbtn" + (showOther ? " active" : "")}
            onClick={() => setOtherOpen((o) => !o)}
            aria-expanded={showOther}
          >
            <span style={{ width: 22, display: "inline-block", textAlign: "center" }}>⋯</span> Other
            <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.8 }}>
              {showOther ? "▾" : "▸"}
            </span>
            {!showOther && alertCount > 0 && <span style={S.badge}>{alertCount}</span>}
          </button>
          {showOther &&
            OTHER_TABS.filter(([k]) => tabEnabled(k)).map(([k, ic, label]) => (
              <button
                key={k}
                className={"navbtn sub" + (tab === k ? " active" : "")}
                onClick={() => setTab(k)}
              >
                <span style={{ width: 22, display: "inline-block", textAlign: "center" }}>
                  {ic}
                </span>{" "}
                {label}
                {k === "alerts" && alertCount > 0 && <span style={S.badge}>{alertCount}</span>}
              </button>
            ))}
          <div style={{ marginTop: "auto", padding: "8px 8px 4px" }}>
            <div
              style={{
                fontSize: 10.5,
                color: "#6E8A7C",
                textTransform: "uppercase",
                letterSpacing: ".06em",
                padding: "0 6px 4px",
              }}
            >
              Backup
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                className="navbtn"
                style={{ border: "1px solid #2A5A3E", justifyContent: "center" }}
                onClick={() => exportData("json")}
              >
                ⬇ JSON
              </button>
              <button
                className="navbtn"
                style={{ border: "1px solid #2A5A3E", justifyContent: "center" }}
                onClick={() => exportData("xlsx")}
              >
                ⬇ XLSX
              </button>
            </div>
            <label
              className="navbtn"
              style={{
                border: "1px solid #2A5A3E",
                justifyContent: "center",
                cursor: "pointer",
                marginTop: 6,
              }}
            >
              ⬆ Restore (JSON / XLSX)
              <input
                type="file"
                accept=".json,.xlsx,.xls,application/json"
                onChange={importData}
                style={{ display: "none" }}
              />
            </label>
          </div>
          <div style={{ display: "flex", gap: 6, padding: "8px 8px 4px" }}>
            <button
              className="navbtn"
              style={{ border: "1px solid #2A5A3E", justifyContent: "center" }}
              onClick={resetMyPassword}
            >
              🔑 Reset
            </button>
            <button
              className="navbtn"
              style={{ border: "1px solid #2A5A3E", justifyContent: "center" }}
              onClick={onLogout}
            >
              ⎋ Logout
            </button>
          </div>
          <div style={{ fontSize: 11, color: "#6E8A7C", padding: "6px 14px 8px" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: online ? "#3FB873" : "#C9803A",
                  display: "inline-block",
                }}
              />
              {online ? "Online · syncing live" : "Offline · saved on this device"}
            </span>
            <br />
            {user?.email ? (
              <>
                Signed in as {user.email}.<br />
              </>
            ) : null}
            Back up regularly.
          </div>
        </nav>

        {/* main */}
        <main className="main" style={S.main}>
          {!loaded ? (
            <div style={{ padding: 40, color: "#667" }}>Loading store data…</div>
          ) : tab === "dashboard" ? (
            <Dashboard
              items={items}
              sales={sales}
              lowStock={lowStock}
              goBilling={() => setTab("billing")}
            />
          ) : tab === "billing" ? (
            <Billing items={items} sales={sales} setSales={setSales} notify={notify} log={addLog} />
          ) : tab === "raw" ? (
            <RawData
              items={items}
              setSales={setSales}
              setExpenses={setExpenses}
              notify={notify}
              log={addLog}
            />
          ) : tab === "inventory" ? (
            <Inventory
              items={items}
              notify={notify}
              log={addLog}
              cats={cats}
              onAddCategory={addCategory}
            />
          ) : tab === "alerts" ? (
            <Alerts items={items} goInventory={() => setTab("inventory")} />
          ) : tab === "sales" ? (
            <SalesHistory
              sales={sales}
              items={items}
              setSales={setSales}
              notify={notify}
              log={addLog}
            />
          ) : tab === "finance" && tabEnabled("finance") ? (
            <Finance sales={sales} expenses={expenses} />
          ) : tab === "stats" ? (
            <Stats sales={sales} expenses={expenses} items={items} />
          ) : tab === "udhari" ? (
            <Udhari sales={sales} setSales={setSales} notify={notify} log={addLog} />
          ) : tab === "expense" ? (
            <Expenses expenses={expenses} setExpenses={setExpenses} notify={notify} log={addLog} />
          ) : tab === "vendorbills" ? (
            <VendorBills
              bills={bills}
              setBills={setBills}
              setDailyBills={setDailyBills}
              goDailyBills={() => setTab("dailybills")}
              online={online}
              notify={notify}
              log={addLog}
            />
          ) : tab === "dailybills" ? (
            <DailyBills
              dailyBills={dailyBills}
              setDailyBills={setDailyBills}
              bills={bills}
              setBills={setBills}
              goVendorBills={() => setTab("vendorbills")}
              notify={notify}
              log={addLog}
            />
          ) : tab === "logs" ? (
            <Logs logs={logs} setLogs={setLogs} notify={notify} />
          ) : tab === "settings" ? (
            <Settings config={config} onSave={updateConfig} notify={notify} />
          ) : tab === "admin" ? (
            <Admin
              items={items}
              setSales={setSales}
              setExpenses={setExpenses}
              setLogs={setLogs}
              user={user}
              notify={notify}
              log={addLog}
            />
          ) : (
            <Dashboard
              items={items}
              sales={sales}
              lowStock={lowStock}
              goBilling={() => setTab("billing")}
            />
          )}
        </main>

        {toast && <div style={S.toast}>{toast}</div>}
      </div>
    </ShopConfigContext.Provider>
  );
}

// ---------- Settings (shop config) ----------
const MAX_LOGO_BYTES = 250 * 1024; // keep the logo small — it's stored inline in the DB config
function Settings({ config, onSave, notify }) {
  const [f, setF] = useState(() => ({ ...DEFAULT_SHOP_CONFIG, ...config }));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setF({ ...DEFAULT_SHOP_CONFIG, ...config });
  }, [config]);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const onLogo = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!/^image\//.test(file.type)) return notify("Please choose an image file for the logo.");
    if (file.size > MAX_LOGO_BYTES)
      return notify("Logo is too large — please use an image under 250 KB.");
    const reader = new FileReader();
    reader.onload = () => setF((s) => ({ ...s, logoUrl: String(reader.result || "") }));
    reader.onerror = () => notify("Couldn't read that image.");
    reader.readAsDataURL(file);
  };

  const save = async () => {
    const err = validateConfig(f);
    if (err) return notify("⚠ " + err);
    setBusy(true);
    await onSave({
      name: f.name.trim(),
      tagline: f.tagline,
      address: f.address,
      phone: f.phone,
      email: f.email.trim(),
      gstin: f.gstin.trim(),
      currency: f.currency.trim() || "₹",
      logoUrl: f.logoUrl,
      receiptFooter: f.receiptFooter,
      footwearSizeMin: Number(f.footwearSizeMin) || 3,
      footwearSizeMax: Number(f.footwearSizeMax) || 9,
    });
    setBusy(false);
  };

  return (
    <div>
      <Header title="Settings" sub="Shop identity — shown in the header, receipts, and reports" />
      <div style={{ maxWidth: 720 }}>
        <Section title="Shop details">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Shop name *">
              <input
                className="input"
                value={f.name}
                onChange={set("name")}
                placeholder="e.g. Riya Ladies Collection"
              />
            </Field>
            <Field label="Tagline">
              <input
                className="input"
                value={f.tagline}
                onChange={set("tagline")}
                placeholder="Ladies Fashion & Footwear"
              />
            </Field>
          </div>
          <Field label="Address">
            <input
              className="input"
              value={f.address}
              onChange={set("address")}
              placeholder="Shop no., street, area, city, PIN"
            />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Phone">
              <input
                className="input"
                value={f.phone}
                onChange={set("phone")}
                placeholder="Contact number"
              />
            </Field>
            <Field label="Email">
              <input
                className="input"
                type="email"
                value={f.email}
                onChange={set("email")}
                placeholder="shop@email.com"
              />
            </Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="GSTIN (optional)">
              <input
                className="input"
                value={f.gstin}
                onChange={set("gstin")}
                placeholder="15-digit GSTIN"
              />
            </Field>
            <Field label="Currency symbol">
              <input
                className="input"
                style={{ width: 90 }}
                value={f.currency}
                onChange={set("currency")}
                maxLength={3}
              />
            </Field>
          </div>
        </Section>

        <Section title="Logo (optional)">
          <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            {f.logoUrl ? (
              <img
                src={f.logoUrl}
                alt="Shop logo"
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 12,
                  objectFit: "contain",
                  background: "#fff",
                  border: "1px solid #E3E9E5",
                }}
              />
            ) : (
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 12,
                  background: "#F4F7F4",
                  display: "grid",
                  placeItems: "center",
                  color: "#9AA",
                  fontSize: 24,
                }}
              >
                🛍️
              </div>
            )}
            <label className="btn">
              Upload logo
              <input type="file" accept="image/*" onChange={onLogo} style={{ display: "none" }} />
            </label>
            {f.logoUrl && (
              <button className="btn ghost" onClick={() => setF((s) => ({ ...s, logoUrl: "" }))}>
                Remove
              </button>
            )}
            <span style={{ fontSize: 12, color: "#8A9C90" }}>PNG/JPG under 250 KB.</span>
          </div>
        </Section>

        <Section title="Receipt & sizes">
          <Field label="Receipt / invoice footer text">
            <textarea
              className="input"
              rows={2}
              value={f.receiptFooter}
              onChange={set("receiptFooter")}
              placeholder="Thank you! Please visit again."
            />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Footwear size — min (IND/UK)">
              <input
                className="input"
                type="number"
                min="1"
                max="15"
                value={f.footwearSizeMin}
                onChange={set("footwearSizeMin")}
              />
            </Field>
            <Field label="Footwear size — max (IND/UK)">
              <input
                className="input"
                type="number"
                min="1"
                max="15"
                value={f.footwearSizeMax}
                onChange={set("footwearSizeMax")}
              />
            </Field>
          </div>
        </Section>

        <button className="btn primary big" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save settings"}
        </button>
      </div>
    </div>
  );
}

// ---------- Dashboard ----------
function Dashboard({ items, sales, lowStock, goBilling }) {
  const [date, setDate] = useState(todayStr());
  const isToday = date === todayStr();
  const daySales = sales.filter((s) => s.date === date);
  const rev = money(daySales.reduce((a, s) => a + s.total, 0));
  const profit = money(daySales.reduce((a, s) => a + s.profit, 0));
  const stockValue = money(
    items.reduce((a, i) => a + (Number(i.purchasePrice) || 0) * productStock(i), 0)
  );
  const month = date.slice(0, 7);
  const monthSales = sales.filter((s) => s.date.startsWith(month));
  const monthRev = money(monthSales.reduce((a, s) => a + s.total, 0));
  const monthProfit = money(monthSales.reduce((a, s) => a + s.profit, 0));
  // Sales/revenue above are amounts BOOKED (they include Udhari/credit bills at full value).
  // These are the still-unpaid (on-credit) portions, shown as a sub-note so the gap is visible.
  const udhariOf = (list) =>
    money(
      list.reduce(
        (a, s) => a + (s.payment === "Udhari" ? Math.max(0, (s.total || 0) - (s.paid || 0)) : 0),
        0
      )
    );
  const dayUdhari = udhariOf(daySales);
  const monthUdhari = udhariOf(monthSales);
  const monthName = new Date(date + "T00:00").toLocaleDateString("en-IN", { month: "long" });
  const niceDate = new Date(date + "T00:00").toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const trend = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 13);
    return buildSeries(sales, [], dateStr(d), todayStr());
  }, [sales]);

  // --- "Over time" charts: user picks a period, we show day-wise & week-wise series. ---
  const [period, setPeriod] = useState("7d");
  const [customFrom, setCustomFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    return dateStr(d);
  });
  const [customTo, setCustomTo] = useState(todayStr());
  const range = useMemo(() => {
    if (period === "custom") return { from: customFrom, to: customTo };
    const opt = DASH_PERIODS.find((p) => p[0] === period);
    const d = new Date();
    (opt?.[2] || (() => {}))(d);
    return { from: dateStr(d), to: todayStr() };
  }, [period, customFrom, customTo]);
  const dailySeries = useMemo(
    () => buildDaily(sales, range.from, range.to),
    [sales, range.from, range.to]
  );
  const weeklySeries = useMemo(
    () => buildWeekly(sales, range.from, range.to),
    [sales, range.from, range.to]
  );
  const rangeLabel = useMemo(() => {
    const f = (ds) =>
      new Date(ds + "T00:00").toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
    return range.from && range.to ? `${f(range.from)} – ${f(range.to)}` : "";
  }, [range]);

  // Fixed monthly overview: one bucket per calendar month from May 2026 through the current
  // month, regardless of the day picker above. Months with no sales show as zero bars.
  const monthly = useMemo(() => {
    const nowKey = todayStr().slice(0, 7);
    const keys = [];
    let y = 2026,
      m = 5; // start: May 2026
    const [ey, em] = nowKey.split("-").map(Number);
    while (y < ey || (y === ey && m <= em)) {
      keys.push(`${y}-${String(m).padStart(2, "0")}`);
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
    const agg = Object.fromEntries(keys.map((k) => [k, { revenue: 0, profit: 0 }]));
    sales.forEach((s) => {
      const k = (s.date || "").slice(0, 7);
      if (agg[k]) {
        agg[k].revenue += s.total || 0;
        agg[k].profit += s.profit || 0;
      }
    });
    return keys.map((k) => ({
      key: k,
      label: new Date(k + "-01T00:00").toLocaleDateString("en-IN", {
        month: "short",
        year: "2-digit",
      }),
      revenue: money(agg[k].revenue),
      profit: money(agg[k].profit),
    }));
  }, [sales]);

  return (
    <div>
      <Header title="Dashboard" sub={niceDate}>
        <label style={{ fontSize: 12, color: "#6B7E74" }}>
          View day{" "}
          <input
            type="date"
            className="input"
            style={{ width: "auto", marginLeft: 4 }}
            value={date}
            max={todayStr()}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
      </Header>
      <div style={S.cards}>
        <Card
          label={isToday ? "Today's sales" : "Sales (this day)"}
          value={INR(rev)}
          sub={daySales.length + " bills" + (dayUdhari > 0 ? ` · ${INR(dayUdhari)} on udhari` : "")}
        />
        <Card
          label={isToday ? "Today's profit" : "Profit (this day)"}
          value={INR(profit)}
          sub="after item cost"
          accent
        />
        <Card
          label={monthName + " revenue"}
          value={INR(monthRev)}
          sub={"month to date" + (monthUdhari > 0 ? ` · ${INR(monthUdhari)} on udhari` : "")}
        />
        <Card
          label={monthName + " profit"}
          value={INR(monthProfit)}
          sub="month to date · after item cost"
          accent
        />
        <Card
          label="Stock value"
          value={INR(stockValue)}
          sub={items.length + " products (at cost)"}
        />
      </div>

      <div style={{ marginTop: 16 }}>
        <ChartCard title="Sales — last 14 days" height={200}>
          <AreaChart data={trend} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
            <defs>
              <linearGradient id="gDash" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#1B5E43" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#1B5E43" stopOpacity={0.03} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#678" }}
              interval="preserveStartEnd"
              minTickGap={16}
            />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Area
              type="monotone"
              dataKey="revenue"
              name="Revenue"
              stroke="#1B5E43"
              strokeWidth={2}
              fill="url(#gDash)"
            />
          </AreaChart>
        </ChartCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <ChartCard title={`Payments in ${monthName} — Total vs Cash vs UPI`} height={200}>
          {renderPayMix(monthSales)}
        </ChartCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <ChartCard title="Total vs Cash vs UPI — last 14 days" height={200}>
          {renderPayTrend(trend)}
        </ChartCard>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
        <section style={S.panel}>
          <div style={S.panelHead}>
            Low stock — reorder soon
            {lowStock.length > 0 && (
              <span style={{ ...S.badge, position: "static", marginLeft: 8 }}>
                {lowStock.length}
              </span>
            )}
          </div>
          {lowStock.length === 0 ? (
            <Empty text="All products are well stocked." />
          ) : (
            lowStock.slice(0, 8).map((i) => {
              const lows = productLowVariants(i);
              return (
                <div key={i.id} style={S.row}>
                  <span>
                    {i.name}
                    {lows.length ? (
                      <span style={{ color: "#9AA", fontSize: 11 }}>
                        {" "}
                        · {lows.map(variantLabel).slice(0, 3).join(", ")}
                      </span>
                    ) : null}
                  </span>
                  <span style={{ color: "#C44536", fontWeight: 700 }}>{productStock(i)} left</span>
                </div>
              );
            })
          )}
        </section>
        <section style={S.panel}>
          <div style={S.panelHead}>{isToday ? "Recent bills" : "Bills on this day"}</div>
          {daySales.length === 0 ? (
            <Empty text={isToday ? "No bills yet today." : "No bills on this day."}>
              {isToday && (
                <button className="btn primary" onClick={goBilling}>
                  Start billing
                </button>
              )}
            </Empty>
          ) : (
            [...daySales]
              .reverse()
              .slice(0, 8)
              .map((s) => (
                <div key={s.id} style={S.row}>
                  <span>
                    {s.time} · {s.lines.length} items
                  </span>
                  <b>{INR(s.total)}</b>
                </div>
              ))
          )}
        </section>
      </div>

      <div
        style={{
          fontSize: 13,
          fontWeight: 800,
          color: "#10331F",
          letterSpacing: ".02em",
          margin: "22px 0 8px",
        }}
      >
        Monthly overview <span style={{ fontWeight: 500, color: "#8A9C90" }}>(from May 2026)</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <ChartCard title="Monthly revenue" height={220}>
          <BarChart data={monthly} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Bar
              dataKey="revenue"
              name="Revenue"
              fill="#1B5E43"
              radius={[3, 3, 0, 0]}
              label={barLabel}
            />
          </BarChart>
        </ChartCard>
        <ChartCard title="Monthly profit" height={220}>
          <BarChart data={monthly} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Bar
              dataKey="profit"
              name="Profit"
              fill="#E8A33D"
              radius={[3, 3, 0, 0]}
              label={barLabel}
            />
          </BarChart>
        </ChartCard>
      </div>
      <div style={{ marginTop: 16 }}>
        <ChartCard title="Monthly revenue vs profit" height={240}>
          <BarChart data={monthly} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar
              dataKey="revenue"
              name="Revenue"
              fill="#1B5E43"
              radius={[3, 3, 0, 0]}
              label={barLabel}
            />
            <Bar
              dataKey="profit"
              name="Profit"
              fill="#E8A33D"
              radius={[3, 3, 0, 0]}
              label={barLabel}
            />
          </BarChart>
        </ChartCard>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 10,
          margin: "22px 0 8px",
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 800, color: "#10331F", letterSpacing: ".02em" }}>
          Revenue &amp; profit over time
        </span>
        <select
          className="input"
          style={{ width: "auto" }}
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
        >
          {DASH_PERIODS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        {period === "custom" && (
          <>
            <input
              type="date"
              className="input"
              style={{ width: "auto" }}
              value={customFrom}
              max={customTo || todayStr()}
              onChange={(e) => setCustomFrom(e.target.value)}
            />
            <span style={{ color: "#8A9C90" }}>to</span>
            <input
              type="date"
              className="input"
              style={{ width: "auto" }}
              value={customTo}
              max={todayStr()}
              onChange={(e) => setCustomTo(e.target.value)}
            />
          </>
        )}
        {rangeLabel && <span style={{ fontSize: 12, color: "#8A9C90" }}>{rangeLabel}</span>}
      </div>

      <div style={{ fontSize: 12, fontWeight: 700, color: "#4A5D52", margin: "10px 0 6px" }}>
        Day wise
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <ChartCard title="Day wise revenue" height={220}>
          <BarChart data={dailySeries} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#678" }}
              interval="preserveStartEnd"
              minTickGap={16}
            />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Bar dataKey="revenue" name="Revenue" fill="#1B5E43" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ChartCard>
        <ChartCard title="Day wise profit" height={220}>
          <BarChart data={dailySeries} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#678" }}
              interval="preserveStartEnd"
              minTickGap={16}
            />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Bar dataKey="profit" name="Profit" fill="#E8A33D" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ChartCard>
      </div>
      <div style={{ marginTop: 16 }}>
        <ChartCard title="Day wise revenue vs profit" height={240}>
          <BarChart data={dailySeries} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#678" }}
              interval="preserveStartEnd"
              minTickGap={16}
            />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="revenue" name="Revenue" fill="#1B5E43" radius={[3, 3, 0, 0]} />
            <Bar dataKey="profit" name="Profit" fill="#E8A33D" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ChartCard>
      </div>

      <div style={{ fontSize: 12, fontWeight: 700, color: "#4A5D52", margin: "18px 0 6px" }}>
        Week wise <span style={{ fontWeight: 500, color: "#8A9C90" }}>(week starting Mon)</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <ChartCard title="Week wise revenue" height={220}>
          <BarChart data={weeklySeries} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#678" }}
              interval="preserveStartEnd"
              minTickGap={16}
            />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} labelFormatter={(l) => "Week of " + l} />
            <Bar
              dataKey="revenue"
              name="Revenue"
              fill="#1B5E43"
              radius={[3, 3, 0, 0]}
              label={barLabel}
            />
          </BarChart>
        </ChartCard>
        <ChartCard title="Week wise profit" height={220}>
          <BarChart data={weeklySeries} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#678" }}
              interval="preserveStartEnd"
              minTickGap={16}
            />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} labelFormatter={(l) => "Week of " + l} />
            <Bar
              dataKey="profit"
              name="Profit"
              fill="#E8A33D"
              radius={[3, 3, 0, 0]}
              label={barLabel}
            />
          </BarChart>
        </ChartCard>
      </div>
      <div style={{ marginTop: 16 }}>
        <ChartCard title="Week wise revenue vs profit" height={240}>
          <BarChart data={weeklySeries} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#678" }}
              interval="preserveStartEnd"
              minTickGap={16}
            />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} labelFormatter={(l) => "Week of " + l} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="revenue" name="Revenue" fill="#1B5E43" radius={[3, 3, 0, 0]} />
            <Bar dataKey="profit" name="Profit" fill="#E8A33D" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ChartCard>
      </div>
    </div>
  );
}

// ---------- Billing / POS ----------
function Billing({ items, sales, setSales, notify, log }) {
  const config = useShopConfig();
  const [q, setQ] = useState("");
  const [cart, setCart] = useState([]); // [{ key, productId, variantId, name, brand, icon, size, color, sellingPrice, purchasePrice, category, subcategory, qty, misc? }]
  const [lastSale, setLastSale] = useState(null);
  const [saleDate, setSaleDate] = useState(todayStr()); // back-date a bill if needed
  const [pay, setPay] = useState("UPI"); // UPI | Cash | Udhari
  const [customer, setCustomer] = useState("");
  const [mobile, setMobile] = useState("");
  const [paidNow, setPaidNow] = useState(""); // Udhari part-payment taken at billing time
  const [paidMode, setPaidMode] = useState("Cash");
  const [discount, setDiscount] = useState("");
  const [discMode, setDiscMode] = useState("flat"); // "flat" = amount, "%" = percent of subtotal
  const [picker, setPicker] = useState(null); // product whose size/colour variant picker is open
  const [miscName, setMiscName] = useState("");
  const [miscPrice, setMiscPrice] = useState("");
  const [miscBuy, setMiscBuy] = useState("");
  const [custFocus, setCustFocus] = useState(false);
  const searchRef = useRef(null);
  useEffect(() => searchRef.current?.focus(), []);

  // Unique past customers (name + most-recent mobile) for the name autocomplete.
  const knownCustomers = useMemo(() => {
    const m = new Map();
    sales.forEach((s) => {
      const name = (s.customer || "").trim();
      if (!name) return;
      const key = name.toLowerCase();
      const e = m.get(key) || { name, mobile: "" };
      e.name = name;
      if ((s.mobile || "").trim()) e.mobile = s.mobile.trim();
      m.set(key, e);
    });
    return [...m.values()];
  }, [sales]);
  const custSuggestions = useMemo(() => {
    const qq = customer.trim().toLowerCase();
    if (!qq) return [];
    return knownCustomers
      .filter((c) => c.name.toLowerCase().includes(qq) && c.name.toLowerCase() !== qq)
      .slice(0, 6);
  }, [customer, knownCustomers]);

  // Units sold / last-sold per product name — for the best-seller ★ and picker ordering.
  const soldQty = useMemo(() => {
    const m = {};
    (sales || []).forEach((s) =>
      (s.lines || []).forEach((l) => {
        m[l.name] = (m[l.name] || 0) + l.qty;
      })
    );
    return m;
  }, [sales]);
  const lastSold = useMemo(() => {
    const m = {};
    (sales || []).forEach((s) =>
      (s.lines || []).forEach((l) => {
        if (!m[l.name] || s.date > m[l.name]) m[l.name] = s.date;
      })
    );
    return m;
  }, [sales]);

  const stockOf = (p) => productStock(p);

  // Product picker results: sellable (any variant in stock) products first, then out-of-stock.
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    const matchesText = (i) =>
      i.name.toLowerCase().includes(s) ||
      (i.brand || "").toLowerCase().includes(s) ||
      (i.code || "").toLowerCase().includes(s) ||
      (i.subcategory || "").toLowerCase().includes(s) ||
      (i.category || "").toLowerCase().includes(s);
    const byActivity = (a, b) => {
      const la = lastSold[a.name] || "",
        lb = lastSold[b.name] || "";
      if (la !== lb) return la < lb ? 1 : -1;
      return (soldQty[b.name] || 0) - (soldQty[a.name] || 0);
    };
    const pool = s ? items.filter(matchesText) : items;
    const inStock = pool.filter((i) => stockOf(i) > 0).sort(byActivity);
    const out = pool.filter((i) => stockOf(i) <= 0).sort(byActivity);
    return [...inStock.slice(0, 14), ...out.slice(0, 8)];
  }, [q, items, soldQty, lastSold]);

  // Live availability of a variant, minus what's already in the cart for it.
  const variantAvail = (product, variant) => {
    const inCart = cart
      .filter((c) => c.productId === product.id && c.variantId === variant.id)
      .reduce((a, c) => a + c.qty, 0);
    return Math.max(0, (Number(variant.stockQty) || 0) - inCart);
  };

  const openProduct = (product) => {
    const vs = product.variants || [];
    if (stockOf(product) <= 0) return notify("Out of stock: " + product.name);
    if (vs.length === 1) return addVariant(product, vs[0]);
    setPicker(product);
  };

  const addVariant = (product, variant) => {
    if ((Number(variant.stockQty) || 0) <= 0)
      return notify(`${product.name} — ${variantLabel(variant)} is out of stock`);
    if (variantAvail(product, variant) <= 0)
      return notify(
        `Only ${variant.stockQty} of ${product.name} (${variantLabel(variant)}) in stock`
      );
    const key = product.id + "|" + variant.id;
    setCart((c) => {
      const ex = c.find((x) => x.key === key);
      if (ex) return c.map((x) => (x.key === key ? { ...x, qty: x.qty + 1 } : x));
      return [
        ...c,
        {
          key,
          productId: product.id,
          variantId: variant.id,
          name: product.name,
          brand: product.brand || "",
          icon: iconFor(product),
          size: variant.size || "",
          color: variant.color || "",
          sellingPrice: money(product.sellingPrice),
          purchasePrice: money(product.purchasePrice),
          category: product.category,
          subcategory: product.subcategory,
          qty: 1,
        },
      ];
    });
  };

  const setQty = (key, qty) => {
    const line = cart.find((c) => c.key === key);
    let q2 = qty;
    if (line && !line.misc) {
      const p = items.find((i) => i.id === line.productId);
      const v = p?.variants?.find((x) => x.id === line.variantId);
      const stock = Number(v?.stockQty) || 0;
      if (q2 > stock) {
        notify(`Only ${stock} in stock`);
        q2 = stock;
      }
    }
    setCart((c) =>
      q2 <= 0
        ? c.filter((x) => x.key !== key)
        : c.map((x) => (x.key === key ? { ...x, qty: q2 } : x))
    );
  };

  const addMisc = () => {
    const price = +miscPrice;
    if (!(price > 0)) return notify("Enter a price for the misc item.");
    const buy = +miscBuy;
    if (miscBuy.trim() !== "" && !(buy >= 0))
      return notify("Enter a valid buy price (or leave it blank).");
    const name = miscName.trim() || "Misc item";
    setCart((c) => [
      ...c,
      {
        key: "misc-" + uid(),
        misc: true,
        name,
        icon: "🧾",
        size: "",
        color: "",
        sellingPrice: money(price),
        purchasePrice: money(buy > 0 ? buy : 0),
        qty: 1,
        category: "",
        subcategory: "Misc",
      },
    ]);
    setMiscName("");
    setMiscPrice("");
    setMiscBuy("");
    notify(`Added “${name}” · ${INR(money(price))}`);
  };

  const onSearchKey = (e) => {
    if (e.key !== "Enter" || results.length === 0) return;
    const code = q.trim().toLowerCase();
    const exact = results.find((i) => (i.code || "").toLowerCase() === code && code);
    openProduct(exact || results[0]);
    setQ("");
  };

  const subtotal = money(cart.reduce((a, c) => a + c.sellingPrice * c.qty, 0));
  const grossProfit = money(
    cart.reduce((a, c) => a + (c.sellingPrice - c.purchasePrice) * c.qty, 0)
  );
  const discNum = Math.max(0, +discount || 0);
  const discountAmt =
    discMode === "%"
      ? money((subtotal * Math.min(100, discNum)) / 100)
      : Math.min(subtotal, money(discNum));
  const total = money(subtotal - discountAmt);
  const profit = money(grossProfit - discountAmt);

  const completeSale = async () => {
    if (cart.length === 0) return;
    // Re-check against the freshest variant stock (another device may have sold since).
    const short = cart
      .filter((c) => !c.misc)
      .map((c) => {
        const p = items.find((i) => i.id === c.productId);
        const v = p?.variants?.find((x) => x.id === c.variantId);
        return { c, stock: Number(v?.stockQty) || 0 };
      })
      .filter(({ c, stock }) => c.qty > stock);
    if (short.length) {
      const { c, stock } = short[0];
      return notify(`Only ${stock} of ${c.name} (${variantLabel(c)}) left — adjust the bill.`);
    }
    const now = new Date();
    const backDated = saleDate !== todayStr();
    const sale = {
      id: uid(),
      date: saleDate,
      time:
        now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) +
        (backDated ? " (back-dated)" : ""),
      // Snapshot the cost (buyPrice) onto each line so historical profit stays anchored even if
      // prices change or the product is deleted later. Size/colour/category ride along for reports.
      lines: cart.map((c) => ({
        name: c.name,
        qty: c.qty,
        price: c.sellingPrice,
        buyPrice: c.purchasePrice,
        amount: money(c.sellingPrice * c.qty),
        size: c.size || "",
        color: c.color || "",
        category: c.category || "",
        subcategory: c.subcategory || "",
        ...(c.misc ? { misc: true } : { productId: c.productId, variantId: c.variantId }),
      })),
      total,
      profit,
      ...(discountAmt > 0
        ? {
            subtotal,
            discount: discountAmt,
            ...(discMode === "%" ? { discountPct: money(discNum) } : {}),
          }
        : {}),
      payment: pay,
      ...(customer.trim() ? { customer: customer.trim() } : {}),
      ...(mobile.trim() ? { mobile: mobile.trim() } : {}),
      ...(pay === "Udhari" ? { paid: Math.min(total, Math.max(0, money(+paidNow || 0))) } : {}),
      ...(pay === "Udhari" && +paidNow > 0 ? { paidMode } : {}),
    };
    setSales((s) => [...s, sale]);
    // Atomic per-product stock decrement (concurrency-safe). Local stock refreshes via the echo.
    try {
      await cloudSellCart(cart);
    } catch (e) {
      console.error("stock update failed", e);
      notify("⚠ Sale saved, but stock update didn't sync — check connection.");
    }
    setLastSale(sale);
    log(
      "sale",
      `Bill ${INR(total)} · ${cart.length} item(s) · ${pay}` +
        (discountAmt > 0 ? ` · disc ${INR(discountAmt)}` : "") +
        (customer.trim() ? ` (${customer.trim()})` : "") +
        (backDated ? ` · back-dated to ${saleDate}` : "")
    );
    setCart([]);
    setQ("");
    setCustomer("");
    setMobile("");
    setPaidNow("");
    setPaidMode("Cash");
    setDiscount("");
    searchRef.current?.focus();
    notify(`Bill saved (${pay}) — ` + INR(total));
  };

  return (
    <div>
      <Header title="Billing" sub="Tap a product, pick size &amp; colour, add to the bill">
        <label
          style={{
            fontSize: 12,
            color: saleDate === todayStr() ? "#6B7E74" : "#C44536",
            fontWeight: 600,
          }}
        >
          Bill date{" "}
          <input
            type="date"
            className="input"
            style={{ width: "auto", marginLeft: 4 }}
            value={saleDate}
            max={todayStr()}
            onChange={(e) => setSaleDate(e.target.value || todayStr())}
          />
        </label>
      </Header>

      <div
        className="billing-grid"
        style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}
      >
        {/* product picker */}
        <section style={S.panel}>
          <input
            ref={searchRef}
            className="input"
            placeholder="Search name / brand / code… (Enter opens top match)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onSearchKey}
            aria-label="Search products or scan barcode"
            style={{ marginBottom: 12 }}
          />
          <div
            style={{
              display: "flex",
              gap: 6,
              alignItems: "center",
              marginBottom: 12,
              padding: "8px 10px",
              background: "#F7F2F4",
              borderRadius: 8,
            }}
          >
            <span
              style={{ fontSize: 11.5, fontWeight: 700, color: "#8E2C48", whiteSpace: "nowrap" }}
            >
              🧾 Misc
            </span>
            <input
              className="input"
              style={{ flex: 1, minWidth: 0 }}
              placeholder="Name (optional)"
              value={miscName}
              onChange={(e) => setMiscName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addMisc();
              }}
              aria-label="Misc item name"
            />
            <input
              className="input"
              style={{ width: 78 }}
              type="number"
              min="0"
              step="0.01"
              placeholder="buy"
              value={miscBuy}
              onChange={(e) => setMiscBuy(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addMisc();
              }}
              aria-label="Misc buy price (optional)"
              title="Buy / cost price (optional) — used for profit"
            />
            <input
              className="input"
              style={{ width: 86 }}
              type="number"
              min="0"
              step="0.01"
              placeholder="sell"
              value={miscPrice}
              onChange={(e) => setMiscPrice(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addMisc();
              }}
              aria-label="Misc sell price"
            />
            <button className="btn" onClick={addMisc}>
              + Add
            </button>
          </div>
          <div
            className="pick-grid"
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}
          >
            {results.length === 0 && (
              <Empty text={q ? "No products match." : "No products yet — add some in Inventory."} />
            )}
            {results.map((i) => {
              const st = stockOf(i);
              const inStock = st > 0;
              const low = isProductLow(i);
              return (
                <div
                  key={i.id}
                  className="pick"
                  style={{
                    cursor: inStock ? "pointer" : "default",
                    background: inStock ? undefined : "#F2F0F1",
                    opacity: inStock ? 1 : 0.7,
                  }}
                  onClick={inStock ? () => openProduct(i) : undefined}
                >
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>
                    <span style={{ marginRight: 5 }}>{iconFor(i)}</span>
                    {i.name}
                    {soldQty[i.name] ? (
                      <span
                        style={{ color: "#E8A33D", fontSize: 11, marginLeft: 4 }}
                        title="best-seller"
                      >
                        ★
                      </span>
                    ) : null}
                  </div>
                  <div style={{ fontSize: 11, color: "#9AA", marginTop: 1 }}>
                    {[i.brand, i.subcategory].filter(Boolean).join(" · ")}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginTop: 4,
                      fontSize: 12.5,
                    }}
                  >
                    <span style={{ color: "#8E2C48", fontWeight: 800 }}>{INR(i.sellingPrice)}</span>
                    <span
                      style={{
                        color: !inStock || low ? "#C44536" : "#789",
                        fontWeight: !inStock ? 600 : 400,
                      }}
                    >
                      {!inStock ? "Out of stock" : st + " in stock"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* cart / bill */}
        <section style={S.panel}>
          <div style={S.panelHead}>Current bill</div>
          {cart.length === 0 ? (
            <Empty text="No items yet. Tap a product to begin." />
          ) : (
            <div style={{ marginBottom: 10 }}>
              {cart.map((c) => (
                <div
                  key={c.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "7px 0",
                    borderBottom: "1px dotted #E7DDE2",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {c.icon} {c.name}
                    </div>
                    <div style={{ fontSize: 11, color: "#9AA" }}>
                      {[variantLabel(c) !== "—" ? variantLabel(c) : "", INR(c.sellingPrice)]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  <input
                    className="input"
                    style={{ width: 56, padding: "5px 6px" }}
                    type="number"
                    min="0"
                    value={c.qty}
                    onChange={(e) => setQty(c.key, Math.floor(+e.target.value || 0))}
                    aria-label={"Quantity for " + c.name}
                  />
                  <div style={{ width: 68, textAlign: "right", fontWeight: 700, fontSize: 13 }}>
                    {INR(c.sellingPrice * c.qty)}
                  </div>
                  <button
                    className="btn ghost small"
                    aria-label={"Remove " + c.name}
                    onClick={() => setQty(c.key, 0)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* discount */}
          <div style={{ display: "flex", gap: 6, alignItems: "center", margin: "8px 0" }}>
            <span style={{ fontSize: 12, color: "#465", fontWeight: 600 }}>Discount</span>
            <input
              className="input"
              style={{ width: 80, padding: "6px 8px" }}
              type="number"
              min="0"
              step="0.01"
              placeholder="0"
              value={discount}
              onChange={(e) => setDiscount(e.target.value)}
              aria-label="Discount amount"
            />
            <div
              style={{
                display: "flex",
                border: "1.5px solid #D5D0D2",
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
              <button
                className={"seg" + (discMode === "flat" ? " on" : "")}
                onClick={() => setDiscMode("flat")}
              >
                {CURRENCY.symbol}
              </button>
              <button
                className={"seg" + (discMode === "%" ? " on" : "")}
                onClick={() => setDiscMode("%")}
              >
                %
              </button>
            </div>
            {discountAmt > 0 && (
              <span style={{ fontSize: 12, color: "#C44536", marginLeft: "auto" }}>
                − {INR(discountAmt)}
              </span>
            )}
          </div>

          {/* totals */}
          <div style={{ borderTop: "2px dashed #E1D4DA", paddingTop: 10, marginTop: 4 }}>
            {discountAmt > 0 && (
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 13,
                  color: "#789",
                }}
              >
                <span>Subtotal</span>
                <span>{INR(subtotal)}</span>
              </div>
            )}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontWeight: 800,
                fontSize: 20,
                margin: "4px 0",
              }}
            >
              <span>Total</span>
              <span>{INR(total)}</span>
            </div>
          </div>

          {/* payment */}
          <div style={{ display: "flex", gap: 6, margin: "10px 0" }}>
            {["UPI", "Cash", "Udhari"].map((p) => (
              <button
                key={p}
                className={"seg wide" + (pay === p ? " on" : "")}
                onClick={() => setPay(p)}
              >
                {p}
              </button>
            ))}
          </div>

          {/* customer (optional; required-ish for Udhari) */}
          <div style={{ position: "relative", marginBottom: 8 }}>
            <input
              className="input"
              placeholder={
                pay === "Udhari"
                  ? "Customer name (for the credit book)"
                  : "Customer name (optional)"
              }
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
              onFocus={() => setCustFocus(true)}
              onBlur={() => setTimeout(() => setCustFocus(false), 150)}
              aria-label="Customer name"
            />
            {custFocus && custSuggestions.length > 0 && (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  right: 0,
                  background: "#fff",
                  border: "1px solid #E3E9E5",
                  borderRadius: 8,
                  zIndex: 5,
                  boxShadow: "0 6px 18px rgba(0,0,0,.1)",
                }}
              >
                {custSuggestions.map((c) => (
                  <div
                    key={c.name}
                    style={{ padding: "8px 10px", fontSize: 13, cursor: "pointer" }}
                    onMouseDown={() => {
                      setCustomer(c.name);
                      if (c.mobile) setMobile(c.mobile);
                    }}
                  >
                    {c.name}
                    {c.mobile ? <span style={{ color: "#9AA" }}> · {c.mobile}</span> : ""}
                  </div>
                ))}
              </div>
            )}
          </div>
          <input
            className="input"
            style={{ marginBottom: 8 }}
            placeholder="Mobile (optional)"
            value={mobile}
            onChange={(e) => setMobile(e.target.value)}
            aria-label="Customer mobile"
          />

          {pay === "Udhari" && (
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
              <input
                className="input"
                style={{ flex: 1 }}
                type="number"
                min="0"
                placeholder="Paid now (optional)"
                value={paidNow}
                onChange={(e) => setPaidNow(e.target.value)}
                aria-label="Amount paid now"
              />
              <div
                style={{
                  display: "flex",
                  border: "1.5px solid #D5D0D2",
                  borderRadius: 8,
                  overflow: "hidden",
                }}
              >
                {["Cash", "UPI"].map((m) => (
                  <button
                    key={m}
                    className={"seg" + (paidMode === m ? " on" : "")}
                    onClick={() => setPaidMode(m)}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          )}

          <button
            className="btn primary big"
            style={{ width: "100%" }}
            disabled={cart.length === 0}
            onClick={completeSale}
          >
            Complete sale · {INR(total)}
          </button>
          {lastSale && (
            <button
              className="btn"
              style={{ width: "100%", marginTop: 8 }}
              onClick={() => printReceipt(lastSale, config)}
            >
              🧾 Print last receipt
            </button>
          )}
        </section>
      </div>

      {/* variant picker modal */}
      {picker && (
        <Modal title={`${picker.name} — pick size & colour`} onClose={() => setPicker(null)}>
          <div style={{ fontSize: 12.5, color: "#8A9C90", marginBottom: 10 }}>
            {[picker.brand, picker.subcategory].filter(Boolean).join(" · ")} ·{" "}
            {INR(picker.sellingPrice)}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
              gap: 8,
            }}
          >
            {(picker.variants || []).map((v) => {
              const avail = variantAvail(picker, v);
              const can = avail > 0;
              return (
                <button
                  key={v.id}
                  disabled={!can}
                  onClick={() => {
                    addVariant(picker, v);
                  }}
                  style={{
                    textAlign: "left",
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: "1.5px solid " + (can ? "#D9C7CF" : "#EEE"),
                    background: can ? "#fff" : "#F5F3F4",
                    cursor: can ? "pointer" : "not-allowed",
                    opacity: can ? 1 : 0.6,
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>{variantLabel(v)}</div>
                  <div style={{ fontSize: 11.5, color: can ? "#2E7D5B" : "#C44536", marginTop: 2 }}>
                    {can ? avail + " available" : "Out of stock"}
                  </div>
                </button>
              );
            })}
          </div>
          <div style={{ marginTop: 12, textAlign: "right" }}>
            <button className="btn primary" onClick={() => setPicker(null)}>
              Done
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------- Inventory ----------
// Normalised product name for duplicate detection (trim, lowercase, collapse inner spaces).
const normName = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

// A colour swatch dot for the variant chips / pickers.
const ColorDot = ({ color }) => {
  const hit = COLOR_SWATCHES.find(
    (c) => c.name.toLowerCase() === String(color || "").toLowerCase()
  );
  const bg = hit ? hit.hex : "#CBD3CC";
  return (
    <span
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: bg,
        border: "1px solid rgba(0,0,0,.15)",
        marginRight: 4,
        verticalAlign: "middle",
      }}
    />
  );
};

// One small chip per variant: "M · Maroon ×4" (red when at/below its low threshold).
const VariantChip = ({ v }) => {
  const low = (Number(v.stockQty) || 0) <= (Number(v.lowAt) || 0);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        fontSize: 11.5,
        padding: "2px 7px",
        borderRadius: 20,
        marginRight: 5,
        marginBottom: 4,
        background: low ? "#FBECEF" : "#F1F4F1",
        color: low ? "#B0324C" : "#3A5547",
        border: "1px solid " + (low ? "#F0CDD6" : "#E2EAE3"),
      }}
    >
      {v.color ? <ColorDot color={v.color} /> : null}
      {variantLabel(v)} <b style={{ marginLeft: 2 }}>×{Number(v.stockQty) || 0}</b>
    </span>
  );
};

function Inventory({ items, notify, log, cats = ALL_SUBCATEGORIES, onAddCategory }) {
  const config = useShopConfig();
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("All"); // All | Clothing | Footwear | Accessories
  const [sub, setSub] = useState("All");
  const [form, setForm] = useState(null); // product form object, or null
  const [restock, setRestock] = useState(null); // product being restocked, or null

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return items
      .filter((i) => {
        if (group !== "All" && (i.category || "") !== group) return false;
        if (sub !== "All" && (i.subcategory || "") !== sub) return false;
        if (!s) return true;
        return (
          i.name.toLowerCase().includes(s) ||
          (i.brand || "").toLowerCase().includes(s) ||
          (i.code || "").toLowerCase().includes(s) ||
          (i.subcategory || "").toLowerCase().includes(s)
        );
      })
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }, [items, q, group, sub]);

  const subOptions = useMemo(
    () => (group === "All" ? cats : SUBCATEGORIES_BY_GROUP[group] || []),
    [group, cats]
  );

  const save = async (product) => {
    const dup = items.find(
      (i) =>
        i.id !== product.id &&
        normName(i.name) === normName(product.name) &&
        (i.subcategory || "") === (product.subcategory || "")
    );
    if (
      dup &&
      !confirm(
        `A "${product.name}" already exists in ${product.subcategory}. Save anyway as a separate product?`
      )
    )
      return;
    try {
      await cloudWriteProduct(product);
      log(
        "inventory",
        `${product.id && items.some((i) => i.id === product.id) ? "Edited" : "Added"} “${product.name}” (${(product.variants || []).length} variant${(product.variants || []).length === 1 ? "" : "s"})`
      );
      notify(items.some((i) => i.id === product.id) ? "Product updated" : "Product added");
      setForm(null);
    } catch (e) {
      console.error("save product failed", e);
      notify("⚠ Couldn't save the product.");
    }
  };

  const del = async (product) => {
    if (!confirm(`Delete “${product.name}” and all its variants? This can't be undone.`)) return;
    try {
      await cloudDeleteProduct(product.id);
      log("inventory", `Deleted “${product.name}”`);
      notify("Product deleted");
    } catch (e) {
      console.error("delete failed", e);
      notify("⚠ Couldn't delete the product.");
    }
  };

  const doRestock = async (product, variantId, qty) => {
    const n = Number(qty) || 0;
    if (!(n > 0)) return notify("Enter a quantity to add.");
    try {
      await cloudRestockVariant(product.id, variantId, n);
      log("inventory", `Restocked “${product.name}” +${n}`);
      notify(`Added ${n} to ${product.name}`);
    } catch (e) {
      console.error("restock failed", e);
      notify("⚠ Couldn't restock.");
    }
  };

  return (
    <div>
      <Header
        title="Inventory"
        sub={`${items.length} product${items.length === 1 ? "" : "s"} · tap a product to edit its variants`}
      >
        <button className="btn primary" onClick={() => setForm(blankProduct())}>
          + Add product
        </button>
      </Header>

      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
          marginBottom: 14,
        }}
      >
        <input
          className="input"
          style={{ flex: "1 1 220px", minWidth: 0 }}
          placeholder="Search name / brand / code…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div
          style={{
            display: "flex",
            border: "1.5px solid #E1D4DA",
            borderRadius: 9,
            overflow: "hidden",
          }}
        >
          {["All", ...GROUPS].map((g) => (
            <button
              key={g}
              className={"seg" + (group === g ? " on" : "")}
              onClick={() => {
                setGroup(g);
                setSub("All");
              }}
            >
              {g}
            </button>
          ))}
        </div>
        <select
          className="input"
          style={{ width: "auto" }}
          value={sub}
          onChange={(e) => setSub(e.target.value)}
        >
          <option value="All">All subcategories</option>
          {subOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <Empty text={items.length === 0 ? "No products yet." : "No products match this filter."}>
          <button className="btn primary" onClick={() => setForm(blankProduct())}>
            + Add your first product
          </button>
        </Empty>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {filtered.map((i) => {
            const st = productStock(i);
            const low = isProductLow(i);
            return (
              <section
                key={i.id}
                style={{ ...S.panel, padding: 14, borderColor: low ? "#F0CDD6" : "#E2EAE3" }}
              >
                <div
                  style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}
                >
                  <div style={{ fontSize: 26, lineHeight: 1 }}>
                    {i.imageUrl ? (
                      <img
                        src={i.imageUrl}
                        alt=""
                        style={{ width: 40, height: 40, borderRadius: 8, objectFit: "cover" }}
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                        }}
                      />
                    ) : (
                      iconFor(i)
                    )}
                  </div>
                  <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                    <div style={{ fontWeight: 800, fontSize: 15 }}>
                      {i.name} {low && <span style={S.badgeInline}>low</span>}
                    </div>
                    <div style={{ fontSize: 12, color: "#8A9C90", marginTop: 1 }}>
                      {[i.brand, i.category, i.subcategory].filter(Boolean).join(" · ")}
                      {i.code ? ` · #${i.code}` : ""}
                    </div>
                    <div style={{ marginTop: 8 }}>
                      {(i.variants || []).length === 0 ? (
                        <span style={{ fontSize: 12, color: "#B0324C" }}>
                          No variants — edit to add sizes/colours
                        </span>
                      ) : (
                        (i.variants || []).map((v) => <VariantChip key={v.id} v={v} />)
                      )}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", minWidth: 110 }}>
                    <div style={{ fontWeight: 800, color: "#8E2C48", fontSize: 15 }}>
                      {INR(i.sellingPrice)}
                    </div>
                    {Number(i.mrp) > Number(i.sellingPrice) && (
                      <div
                        style={{ fontSize: 11.5, color: "#9AA", textDecoration: "line-through" }}
                      >
                        MRP {INR(i.mrp)}
                      </div>
                    )}
                    <div style={{ fontSize: 12, color: low ? "#C44536" : "#556", marginTop: 2 }}>
                      {st} in stock
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        marginTop: 8,
                        justifyContent: "flex-end",
                        flexWrap: "wrap",
                      }}
                    >
                      <button className="btn small" onClick={() => setRestock(i)}>
                        Restock
                      </button>
                      <button className="btn small" onClick={() => setForm(toFormShape(i))}>
                        Edit
                      </button>
                      <button className="btn small ghost" onClick={() => del(i)}>
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}

      {form && (
        <ProductForm
          initial={form}
          cats={cats}
          config={config}
          onAddCategory={onAddCategory}
          onSave={save}
          onClose={() => setForm(null)}
          isEdit={items.some((i) => i.id === form.id)}
        />
      )}
      {restock && (
        <RestockModal product={restock} onRestock={doRestock} onClose={() => setRestock(null)} />
      )}
    </div>
  );
}

// Map a stored product into the editable form shape (numeric strings so inputs can be cleared).
function toFormShape(p) {
  return {
    id: p.id,
    name: p.name || "",
    brand: p.brand || "",
    category: p.category || "Clothing",
    subcategory: p.subcategory || "",
    code: p.code || "",
    purchasePrice: p.purchasePrice ?? "",
    sellingPrice: p.sellingPrice ?? "",
    mrp: p.mrp ?? "",
    discountPct: p.discountPct ?? "",
    supplier: p.supplier || "",
    imageUrl: p.imageUrl || "",
    notes: p.notes || "",
    variants: (p.variants || []).map((v) => ({ ...v })),
    createdAt: p.createdAt,
    version: p.version,
  };
}

// Restock modal: add stock to any variant of a product.
function RestockModal({ product, onRestock, onClose }) {
  const [qty, setQty] = useState({}); // variantId -> string
  return (
    <Modal title={`Restock — ${product.name}`} onClose={onClose}>
      {(product.variants || []).length === 0 ? (
        <Empty text="This product has no variants yet. Edit it to add sizes/colours first." />
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {(product.variants || []).map((v) => (
            <div key={v.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <ColorDot color={v.color} />
                {variantLabel(v)}{" "}
                <span style={{ color: "#9AA", fontSize: 12 }}>· {Number(v.stockQty) || 0} now</span>
              </div>
              <input
                className="input"
                style={{ width: 90 }}
                type="number"
                min="1"
                placeholder="+ qty"
                value={qty[v.id] || ""}
                onChange={(e) => setQty((s) => ({ ...s, [v.id]: e.target.value }))}
              />
              <button
                className="btn small primary"
                onClick={async () => {
                  await onRestock(product, v.id, qty[v.id]);
                  setQty((s) => ({ ...s, [v.id]: "" }));
                }}
              >
                Add
              </button>
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 14, textAlign: "right" }}>
        <button className="btn" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}

// Add / edit a product, including its size/colour variant matrix.
function ProductForm({ initial, cats, config, onAddCategory, onSave, onClose, isEdit }) {
  const [f, setF] = useState(initial);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const touchedSub = useRef(isEdit); // don't auto-guess subcategory once the user picks one

  // Auto-guess subcategory + group from the typed name (until the user picks one).
  const onName = (e) => {
    const name = e.target.value;
    setF((s) => {
      const next = { ...s, name };
      if (!touchedSub.current) {
        const guess = guessSubcategory(name);
        if (guess) {
          next.subcategory = guess;
          next.category = groupForSubcategory(guess);
        }
      }
      return next;
    });
  };

  const subList = useMemo(() => {
    const base = SUBCATEGORIES_BY_GROUP[f.category] || [];
    const extra = cats.filter((c) => !base.includes(c) && !ALL_SUBCATEGORIES.includes(c)); // custom ones
    return [...base, ...extra];
  }, [f.category, cats]);
  const sizeOptions = useMemo(
    () => sizesForProduct({ category: f.category, subcategory: f.subcategory }, config),
    [f.category, f.subcategory, config]
  );

  // ---- variant rows ----
  const setVar = (id, k, v) =>
    setF((s) => ({ ...s, variants: s.variants.map((x) => (x.id === id ? { ...x, [k]: v } : x)) }));
  const addVarRow = () => setF((s) => ({ ...s, variants: [...s.variants, blankVariant()] }));
  const removeVar = (id) =>
    setF((s) => ({ ...s, variants: s.variants.filter((x) => x.id !== id) }));

  // Bulk generator: pick sizes × colours → add any missing variant rows.
  const [genSizes, setGenSizes] = useState([]);
  const [genColors, setGenColors] = useState([]);
  const [genColorText, setGenColorText] = useState("");
  const toggle = (arr, set, val) =>
    set(arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val]);
  const generate = () => {
    const colors = [
      ...genColors,
      ...genColorText
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean),
    ];
    const sizes = genSizes.length ? genSizes : [""];
    const cols = colors.length ? colors : [""];
    setF((s) => {
      const have = new Set(s.variants.map((v) => (v.size + "|" + v.color).toLowerCase()));
      const add = [];
      for (const color of cols)
        for (const size of sizes) {
          const key = (size + "|" + color).toLowerCase();
          if (!have.has(key)) {
            have.add(key);
            add.push(blankVariant({ size, color }));
          }
        }
      // Drop an empty starter row if we're adding real variants.
      const base = s.variants.filter((v) => v.size || v.color || Number(v.stockQty) > 0);
      return { ...s, variants: [...base, ...add] };
    });
    setGenSizes([]);
    setGenColors([]);
    setGenColorText("");
  };

  const submit = () => {
    if (!f.name.trim()) return alert("Product name is required.");
    if (!(Number(f.sellingPrice) > 0)) return alert("Enter a selling price greater than 0.");
    const variants = (f.variants || []).filter((v) => v.size || v.color || Number(v.stockQty) > 0);
    if (variants.length === 0) return alert("Add at least one size/colour variant.");
    onSave({
      ...f,
      name: f.name.trim(),
      brand: f.brand.trim(),
      category: f.category,
      subcategory: f.subcategory || (SUBCATEGORIES_BY_GROUP[f.category] || [])[0] || "Other",
      code: (f.code || "").trim(),
      purchasePrice: Number(f.purchasePrice) || 0,
      sellingPrice: Number(f.sellingPrice) || 0,
      mrp: Number(f.mrp) || Number(f.sellingPrice) || 0,
      discountPct: Number(f.discountPct) || 0,
      supplier: (f.supplier || "").trim(),
      imageUrl: (f.imageUrl || "").trim(),
      notes: (f.notes || "").trim(),
      variants: variants.map((v) => ({
        id: v.id,
        size: String(v.size || "").trim(),
        color: String(v.color || "").trim(),
        sku: String(v.sku || "").trim(),
        stockQty: Math.max(0, Number(v.stockQty) || 0),
        lowAt: Math.max(0, Number(v.lowAt) || 0),
      })),
    });
  };

  return (
    <Modal title={isEdit ? "Edit product" : "Add product"} onClose={onClose}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div style={{ gridColumn: "1 / -1" }}>
          <Field label="Product name *">
            <input
              className="input"
              value={f.name}
              onChange={onName}
              autoFocus
              placeholder="e.g. Cotton Printed Kurti"
            />
          </Field>
        </div>
        <Field label="Brand">
          <input
            className="input"
            value={f.brand}
            onChange={set("brand")}
            placeholder="e.g. Biba"
          />
        </Field>
        <Field label="SKU / item code">
          <input className="input" value={f.code} onChange={set("code")} placeholder="Optional" />
        </Field>
        <Field label="Group">
          <select
            className="input"
            value={f.category}
            onChange={(e) => {
              const g = e.target.value;
              setF((s) => ({
                ...s,
                category: g,
                subcategory: (SUBCATEGORIES_BY_GROUP[g] || [])[0] || s.subcategory,
              }));
            }}
          >
            {GROUPS.map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        </Field>
        <Field label="Subcategory">
          <div style={{ display: "flex", gap: 6 }}>
            <select
              className="input"
              value={f.subcategory}
              onChange={(e) => {
                touchedSub.current = true;
                if (e.target.value === "__add") {
                  const nm = onAddCategory && onAddCategory();
                  if (nm) setF((s) => ({ ...s, subcategory: nm }));
                } else set("subcategory")(e);
              }}
            >
              {!subList.includes(f.subcategory) && f.subcategory ? (
                <option value={f.subcategory}>{f.subcategory}</option>
              ) : null}
              {subList.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              {onAddCategory && <option value="__add">+ Add subcategory…</option>}
            </select>
          </div>
        </Field>
        <Field label="Purchase price">
          <input
            className="input"
            type="number"
            min="0"
            step="0.01"
            value={f.purchasePrice}
            onChange={set("purchasePrice")}
            placeholder="cost"
          />
        </Field>
        <Field label="Selling price *">
          <input
            className="input"
            type="number"
            min="0"
            step="0.01"
            value={f.sellingPrice}
            onChange={set("sellingPrice")}
          />
        </Field>
        <Field label="MRP">
          <input
            className="input"
            type="number"
            min="0"
            step="0.01"
            value={f.mrp}
            onChange={set("mrp")}
          />
        </Field>
        <Field label="Discount %">
          <input
            className="input"
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={f.discountPct}
            onChange={set("discountPct")}
            placeholder="0"
          />
        </Field>
        <Field label="Supplier">
          <input
            className="input"
            value={f.supplier}
            onChange={set("supplier")}
            placeholder="Optional"
          />
        </Field>
        <div style={{ gridColumn: "1 / -1" }}>
          <Field label="Image URL (optional)">
            <input
              className="input"
              value={f.imageUrl}
              onChange={set("imageUrl")}
              placeholder="https://…"
            />
          </Field>
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <Field label="Notes">
            <input
              className="input"
              value={f.notes}
              onChange={set("notes")}
              placeholder="Optional"
            />
          </Field>
        </div>
      </div>

      {/* variant generator */}
      <div style={{ background: "#F7F2F4", borderRadius: 10, padding: 12, margin: "12px 0" }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: "#8E2C48", marginBottom: 6 }}>
          Quick-add variants (size × colour)
        </div>
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 11, color: "#889", marginBottom: 3 }}>Sizes</div>
          {sizeOptions.map((sz) => (
            <button
              key={sz}
              className={"chipbtn" + (genSizes.includes(sz) ? " on" : "")}
              onClick={() => toggle(genSizes, setGenSizes, sz)}
            >
              {sz}
            </button>
          ))}
        </div>
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 11, color: "#889", marginBottom: 3 }}>Colours</div>
          {COLOR_SWATCHES.slice(0, 12).map((c) => (
            <button
              key={c.name}
              className={"chipbtn" + (genColors.includes(c.name) ? " on" : "")}
              onClick={() => toggle(genColors, setGenColors, c.name)}
            >
              <ColorDot color={c.name} />
              {c.name}
            </button>
          ))}
          <input
            className="input"
            style={{ width: 160, marginTop: 6, display: "inline-block" }}
            placeholder="Other colours, comma-sep"
            value={genColorText}
            onChange={(e) => setGenColorText(e.target.value)}
          />
        </div>
        <button className="btn small primary" onClick={generate}>
          Generate variants
        </button>
      </div>

      {/* variant rows */}
      <div style={{ fontSize: 12.5, fontWeight: 700, color: "#465", margin: "6px 0" }}>
        Variants ({f.variants.length})
      </div>
      <div
        style={{ maxHeight: 220, overflow: "auto", border: "1px solid #EEE6EA", borderRadius: 8 }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: "#FAF6F8", textAlign: "left", color: "#889" }}>
              <th style={{ padding: "6px 8px" }}>Size</th>
              <th style={{ padding: "6px 8px" }}>Colour</th>
              <th style={{ padding: "6px 8px" }}>Stock</th>
              <th style={{ padding: "6px 8px" }}>Low at</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {f.variants.map((v) => (
              <tr key={v.id} style={{ borderTop: "1px solid #F0EAEE" }}>
                <td style={{ padding: "4px 8px" }}>
                  <input
                    className="input"
                    style={{ padding: "5px 7px", width: 78 }}
                    list={"sizes-" + f.category}
                    value={v.size}
                    onChange={(e) => setVar(v.id, "size", e.target.value)}
                  />
                </td>
                <td style={{ padding: "4px 8px" }}>
                  <input
                    className="input"
                    style={{ padding: "5px 7px", width: 96 }}
                    list="color-list"
                    value={v.color}
                    onChange={(e) => setVar(v.id, "color", e.target.value)}
                  />
                </td>
                <td style={{ padding: "4px 8px" }}>
                  <input
                    className="input"
                    style={{ padding: "5px 7px", width: 64 }}
                    type="number"
                    min="0"
                    value={v.stockQty}
                    onChange={(e) => setVar(v.id, "stockQty", e.target.value)}
                  />
                </td>
                <td style={{ padding: "4px 8px" }}>
                  <input
                    className="input"
                    style={{ padding: "5px 7px", width: 56 }}
                    type="number"
                    min="0"
                    value={v.lowAt}
                    onChange={(e) => setVar(v.id, "lowAt", e.target.value)}
                  />
                </td>
                <td style={{ padding: "4px 8px" }}>
                  <button
                    className="btn ghost small"
                    onClick={() => removeVar(v.id)}
                    aria-label="Remove variant"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="btn small" style={{ marginTop: 8 }} onClick={addVarRow}>
        + Add a variant row
      </button>

      <datalist id="color-list">
        {COLOR_SWATCHES.map((c) => (
          <option key={c.name} value={c.name} />
        ))}
      </datalist>
      <datalist id={"sizes-" + f.category}>
        {sizeOptions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button className="btn primary big" style={{ flex: 1 }} onClick={submit}>
          {isEdit ? "Save changes" : "Add product"}
        </button>
        <button className="btn big" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

// ---------- Data Import (file import / paste) ----------
const RAW_ACCEPT = ".txt,.csv,.tsv,.xls,.xlsx,.pdf,.json";
function RawData({ items, setSales, setExpenses, notify, log }) {
  const [mode, setMode] = useState("inventory"); // "inventory" | "sales" | "expenses"
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [raw, setRaw] = useState("");
  const [source, setSource] = useState("");
  const [saleDate, setSaleDate] = useState(todayStr());

  // The shared parser yields {name, qty, buyPrice, sellPrice, amount, ...}. Map each mode's rows.
  const toExpenseRow = (r) => ({
    name: r.name || "",
    amount: r.amount || r.sellPrice || r.buyPrice || r.qty || "",
    date: r.date || r.expiry || "",
  });
  const toInvRow = (r) => ({
    name: r.name || "",
    size: "",
    color: "",
    qty: +r.qty || 1,
    buyPrice: r.buyPrice ?? "",
    sellPrice: r.sellPrice ?? "",
  });

  const loadRows = (parsed, srcLabel) => {
    if (!parsed || parsed.length === 0) {
      setErr(
        "No rows found. Make sure the data has product names and numbers — or add rows manually below."
      );
      return;
    }
    setErr(null);
    setRows(
      mode === "expenses"
        ? parsed.map(toExpenseRow)
        : mode === "inventory"
          ? parsed.map(toInvRow)
          : parsed
    );
    setSource(srcLabel);
    notify(`${parsed.length} row(s) loaded — review, edit, then submit`);
  };

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setBusy(true);
    setErr(null);
    try {
      loadRows(await parseFile(f), f.name);
    } catch (ex) {
      console.error(ex);
      setErr("Could not read that file. Supported: txt, csv, tsv, xls, xlsx, pdf, json.");
    }
    setBusy(false);
  };
  const processPaste = () => {
    if (!raw.trim()) return setErr("Paste some data into the box first.");
    try {
      loadRows(parseRawText(raw), "pasted text");
    } catch (ex) {
      console.error(ex);
      setErr("Could not parse that text.");
    }
  };

  const addRow = () =>
    setRows([
      ...(rows || []),
      mode === "expenses"
        ? { name: "", amount: "", date: todayStr() }
        : mode === "inventory"
          ? { name: "", size: "", color: "", qty: 1, buyPrice: "", sellPrice: "" }
          : { name: "", qty: 1, amount: "" },
    ]);
  const edit = (i, k, v) => setRows(rows.map((r, x) => (x === i ? { ...r, [k]: v } : r)));
  const drop = (i) => setRows(rows.filter((_, x) => x !== i));
  const reset = () => {
    setRows(null);
    setRaw("");
    setSource("");
    setErr(null);
  };
  const changeMode = (m) => {
    if (m === mode) return;
    setMode(m);
    setRows(null);
    setErr(null);
  };

  // Each row = a product + one size/colour variant. Rows sharing a product name merge into one
  // product; matching size+colour combine their quantities. Existing products (by name) are
  // updated in place (prices refreshed, stock added), others are created (subcategory guessed).
  const commitInventory = async () => {
    const byName = new Map();
    (rows || []).forEach((r) => {
      const key = normName(r.name);
      if (!key) return;
      const buy = +r.buyPrice || 0,
        sell = +r.sellPrice || 0,
        qty = Math.max(0, +r.qty || 0);
      let e = byName.get(key);
      if (!e) {
        e = { name: r.name.trim(), buy, sell, variants: new Map() };
        byName.set(key, e);
      }
      if (buy) e.buy = buy;
      if (sell) e.sell = sell;
      const vk = String(r.size || "").trim() + "|" + String(r.color || "").trim();
      e.variants.set(vk, (e.variants.get(vk) || 0) + qty);
    });
    if (byName.size === 0) return notify("Add at least one row with a product name.");
    let created = 0,
      updated = 0;
    for (const e of byName.values()) {
      const existing = items.find((i) => normName(i.name) === normName(e.name));
      const sell = e.sell || (e.buy ? Math.round(e.buy * 1.4) : 0);
      const sub = existing?.subcategory || guessSubcategory(e.name) || "Kurtis";
      const base = existing ? existing.variants.map((v) => ({ ...v })) : [];
      e.variants.forEach((qty, vk) => {
        const [size, color] = vk.split("|");
        const match = base.find((v) => (v.size || "") === size && (v.color || "") === color);
        if (match) match.stockQty = (Number(match.stockQty) || 0) + qty;
        else base.push(blankVariant({ size, color, stockQty: qty }));
      });
      const product = normalizeProduct({
        ...(existing || {}),
        id: existing?.id,
        name: e.name,
        subcategory: sub,
        category: groupForSubcategory(sub),
        purchasePrice: e.buy || existing?.purchasePrice || 0,
        sellingPrice: sell || existing?.sellingPrice || 0,
        mrp: existing?.mrp || sell,
        variants: base,
        createdAt: existing?.createdAt || todayStr(),
      });
      try {
        await cloudWriteProduct(product);
        existing ? updated++ : created++;
      } catch (ex) {
        console.error("import product failed", ex);
      }
    }
    log(
      "import",
      `Imported to inventory (${source || "manual"}): ${created} new, ${updated} updated`
    );
    reset();
    notify(`Inventory updated — ${created} new, ${updated} updated`);
  };

  // Record an imported sale (revenue + profit). Stock is NOT changed for imports (a historical
  // row can't be mapped to a specific size/colour reliably).
  const commitSales = () => {
    const agg = new Map();
    (rows || []).forEach((r) => {
      const key = normName(r.name);
      if (!key) return;
      const qty = Math.max(0, +r.qty || 0);
      const amount = +r.amount || 0;
      const e = agg.get(key) || { name: r.name.trim(), qty: 0, amount: 0 };
      e.qty += qty;
      e.amount += amount;
      agg.set(key, e);
    });
    let total = 0,
      profit = 0;
    const lines = [...agg.values()].map((a) => {
      total += a.amount;
      const ex = items.find((i) => normName(i.name) === normName(a.name));
      const buy = ex ? Number(ex.purchasePrice) || 0 : 0;
      if (ex) profit += a.amount - buy * a.qty;
      return {
        name: a.name,
        qty: a.qty,
        price: a.qty ? money(a.amount / a.qty) : a.amount,
        buyPrice: buy,
        amount: money(a.amount),
        size: "",
        color: "",
      };
    });
    if (!lines.length) return notify("Add at least one line with a name and amount.");
    total = money(total);
    profit = money(profit);
    const now = new Date();
    setSales((s) => [
      ...s,
      {
        id: uid(),
        date: saleDate || todayStr(),
        time:
          now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) + " (imported)",
        lines,
        total,
        profit,
      },
    ]);
    log("import", `Imported sale ${INR(total)} · ${lines.length} line(s) (${source || "manual"})`);
    reset();
    notify("Sale recorded — " + INR(total));
  };

  const commitExpenses = () => {
    const valid = (rows || []).filter((r) => (r.name || "").trim() && +r.amount > 0);
    if (!valid.length)
      return notify("Each expense needs a description and an amount greater than 0.");
    const newRows = valid.map((r) => ({
      id: uid(),
      date: r.date || todayStr(),
      desc: r.name.trim(),
      amount: money(+r.amount),
    }));
    const sum = money(newRows.reduce((a, e) => a + e.amount, 0));
    setExpenses((list) => [...list, ...newRows]);
    log("import", `Imported ${newRows.length} expense(s) (${source || "manual"}) · ${INR(sum)}`);
    reset();
    notify(`${newRows.length} expense(s) added — ${INR(sum)}`);
  };

  const cur = CURRENCY.symbol;
  return (
    <div>
      <Header title="Data Import" sub="Import a file or paste data — then review, edit, and submit">
        {rows && (
          <button className="btn ghost small" onClick={reset}>
            Start over
          </button>
        )}
      </Header>

      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <button
          className={"btn " + (mode === "inventory" ? "primary" : "")}
          onClick={() => changeMode("inventory")}
        >
          ➕ Add products
        </button>
        <button
          className={"btn " + (mode === "sales" ? "primary" : "")}
          onClick={() => changeMode("sales")}
        >
          🧾 Record a sale
        </button>
        <button
          className={"btn " + (mode === "expenses" ? "primary" : "")}
          onClick={() => changeMode("expenses")}
        >
          💸 Add expenses
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 16 }}>
        <section style={S.panel}>
          <div style={S.panelHead}>1 · Provide data</div>
          <label
            className="btn primary"
            style={{
              display: "block",
              textAlign: "center",
              padding: "14px",
              cursor: "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? "Reading file…" : "📂 Choose a file"}
            <input
              type="file"
              accept={RAW_ACCEPT}
              onChange={onFile}
              disabled={busy}
              style={{ display: "none" }}
            />
          </label>
          <div
            style={{ fontSize: 11.5, color: "#8A9C90", margin: "8px 0 14px", textAlign: "center" }}
          >
            txt · csv · tsv · xls · xlsx · pdf · json
          </div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#465", marginBottom: 6 }}>
            …or paste data
          </div>
          <textarea
            className="input"
            rows={6}
            placeholder={
              mode === "inventory"
                ? "name, qty, buy, sell\nCotton Kurti, 5, 380, 649\nLeggings, 10, 180, 349"
                : mode === "expenses"
                  ? "expense, amount, date\nShop rent, 15000, 2026-06-01\nElectricity, 1800, 01/06/2026"
                  : "name, qty, amount\nCotton Kurti, 2, 1298\nLeggings, 3, 1047"
            }
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            style={{ resize: "vertical", fontFamily: "monospace", fontSize: 12.5 }}
          />
          <button className="btn" style={{ width: "100%", marginTop: 8 }} onClick={processPaste}>
            Process pasted data
          </button>
          {err && <div style={{ color: "#C44536", fontSize: 13, marginTop: 10 }}>{err}</div>}
          <div style={{ fontSize: 11.5, color: "#8A9C90", marginTop: 12, lineHeight: 1.5 }}>
            {mode === "inventory"
              ? "Columns are auto-detected (name / qty / buy / sell). Each row becomes a product with one size/colour variant — set the size & colour in the preview. Existing names get more stock; new names create a product (subcategory guessed from the name; blank sell = buy + 40%)."
              : mode === "expenses"
                ? "Auto-detected columns: description, amount, date. Blank dates default to today; rows with no amount are skipped."
                : "Auto-detected columns: name, qty, amount. Imported sales record revenue/profit but do not change stock."}
          </div>
        </section>

        <section style={S.panel}>
          <div style={S.panelHead}>
            2 · Review &amp; edit
            {source ? (
              <span
                style={{
                  fontWeight: 500,
                  textTransform: "none",
                  letterSpacing: 0,
                  color: "#8A9C90",
                  marginLeft: 8,
                }}
              >
                from {source}
              </span>
            ) : null}
            <button className="btn small ghost" style={{ marginLeft: "auto" }} onClick={addRow}>
              + Add row
            </button>
          </div>
          {!rows ? (
            <Empty
              text={
                busy
                  ? "Reading…"
                  : "Imported rows appear here. You can also build a list by hand with “+ Add row”."
              }
            />
          ) : (
            <>
              {mode === "sales" && (
                <label
                  style={{ fontSize: 12, color: "#6B7E74", display: "block", marginBottom: 10 }}
                >
                  Sale date{" "}
                  <input
                    type="date"
                    className="input"
                    style={{ width: "auto", marginLeft: 6 }}
                    value={saleDate}
                    max={todayStr()}
                    onChange={(e) => setSaleDate(e.target.value || todayStr())}
                  />
                </label>
              )}
              {mode === "expenses" ? (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Description</th>
                      <th style={{ width: 110 }}>Amount {cur}</th>
                      <th style={{ width: 150 }}>Date</th>
                      <th style={{ width: 30 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i}>
                        <td>
                          <input
                            className="input"
                            style={{ padding: "6px 8px" }}
                            value={r.name}
                            placeholder="e.g. Shop rent"
                            onChange={(e) => edit(i, "name", e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            style={{ padding: "6px 8px" }}
                            type="number"
                            min="0"
                            step="0.01"
                            value={r.amount}
                            onChange={(e) => edit(i, "amount", e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            style={{ padding: "6px 8px" }}
                            type="date"
                            max={todayStr()}
                            value={r.date || ""}
                            onChange={(e) => edit(i, "date", e.target.value)}
                          />
                        </td>
                        <td>
                          <button
                            className="btn small danger"
                            aria-label="Remove row"
                            onClick={() => drop(i)}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={4}>
                          <Empty text="No rows yet — click “+ Add row”." />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              ) : mode === "inventory" ? (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th style={{ width: 80 }}>Size</th>
                      <th style={{ width: 96 }}>Colour</th>
                      <th style={{ width: 54 }}>Qty</th>
                      <th style={{ width: 78 }}>Buy {cur}</th>
                      <th style={{ width: 78 }}>Sell {cur}</th>
                      <th style={{ width: 30 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i}>
                        <td>
                          <input
                            className="input"
                            style={{ padding: "6px 8px" }}
                            value={r.name}
                            onChange={(e) => edit(i, "name", e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            style={{ padding: "6px 6px" }}
                            list="color-list-sizes"
                            value={r.size}
                            onChange={(e) => edit(i, "size", e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            style={{ padding: "6px 6px" }}
                            list="color-list"
                            value={r.color}
                            onChange={(e) => edit(i, "color", e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            style={{ padding: "6px 6px" }}
                            type="number"
                            min="0"
                            value={r.qty}
                            onChange={(e) => edit(i, "qty", +e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            style={{ padding: "6px 8px" }}
                            type="number"
                            min="0"
                            step="0.01"
                            value={r.buyPrice}
                            onChange={(e) => edit(i, "buyPrice", e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            style={{ padding: "6px 8px" }}
                            type="number"
                            min="0"
                            step="0.01"
                            value={r.sellPrice}
                            onChange={(e) => edit(i, "sellPrice", e.target.value)}
                          />
                        </td>
                        <td>
                          <button
                            className="btn small danger"
                            aria-label="Remove row"
                            onClick={() => drop(i)}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={7}>
                          <Empty text="No rows yet — click “+ Add row”." />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th style={{ width: 58 }}>Qty</th>
                      <th style={{ width: 96 }}>Amount {cur}</th>
                      <th style={{ width: 30 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i}>
                        <td>
                          <input
                            className="input"
                            style={{ padding: "6px 8px" }}
                            value={r.name}
                            onChange={(e) => edit(i, "name", e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            style={{ padding: "6px 8px" }}
                            type="number"
                            min="0"
                            value={r.qty}
                            onChange={(e) => edit(i, "qty", +e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            style={{ padding: "6px 8px" }}
                            type="number"
                            min="0"
                            step="0.01"
                            value={r.amount}
                            onChange={(e) => edit(i, "amount", e.target.value)}
                          />
                        </td>
                        <td>
                          <button
                            className="btn small danger"
                            aria-label="Remove row"
                            onClick={() => drop(i)}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={4}>
                          <Empty text="No rows yet — click “+ Add row”." />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
              <button
                className="btn primary big"
                style={{ width: "100%", marginTop: 12 }}
                disabled={rows.length === 0}
                onClick={
                  mode === "inventory"
                    ? commitInventory
                    : mode === "expenses"
                      ? commitExpenses
                      : commitSales
                }
              >
                {mode === "inventory"
                  ? `Add ${rows.length} row(s) to inventory`
                  : mode === "expenses"
                    ? `Add ${rows.length} expense(s)`
                    : `Record sale · ${rows.length} line(s)`}
              </button>
            </>
          )}
        </section>
      </div>
      <datalist id="color-list-sizes">
        {[...CLOTHING_SIZES, "3", "4", "5", "6", "7", "8", "9"].map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  );
}

// ---------- Sales history ----------
const PAY_COLORS = { UPI: "#2A6FB0", Cash: "#1B5E43", Udhari: "#C44536" };

function SalesHistory({ sales, items, setSales, notify, log }) {
  const config = useShopConfig();
  const [open, setOpen] = useState(null);
  const [openDates, setOpenDates] = useState(() => new Set()); // expanded past dates (today is always open)
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState(""); // free-text search across bills
  const [editing, setEditing] = useState(null); // { id, date, payment, lines:[...], orig:[...] }
  const toggleDate = (d) =>
    setOpenDates((s) => {
      const n = new Set(s);
      n.has(d) ? n.delete(d) : n.add(d);
      return n;
    });

  // Search matches a bill when EVERY space-separated term is found somewhere in it —
  // item names, customer, mobile, payment, date/time, bill id, or any amount/quantity.
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const searching = terms.length > 0;
  const matchSale = (s) => {
    if (!searching) return true;
    const hay = [
      s.date,
      s.time,
      s.payment,
      s.customer,
      s.mobile,
      s.id,
      s.total,
      s.profit,
      s.paid,
      ...(s.lines || []).flatMap((l) => [l.name, l.qty, l.amount, l.price]),
    ]
      .filter((v) => v != null)
      .join(" ")
      .toLowerCase();
    return terms.every((t) => hay.includes(t));
  };

  const visible = sales.filter(
    (s) => (!from || s.date >= from) && (!to || s.date <= to) && matchSale(s)
  );
  const byDate = useMemo(() => {
    const m = {};
    [...visible].reverse().forEach((s) => {
      (m[s.date] = m[s.date] || []).push(s);
    });
    return Object.entries(m).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [visible]);
  const rangeTotal = money(visible.reduce((a, s) => a + s.total, 0));

  // Adjust variant stock by per-(product,variant) SOLD-quantity deltas via atomic transactions
  // (positive delta = sold more → remove stock; negative = sold less/undone → add back).
  // Keyed "productId|variantId". Lines without a productId (misc, or legacy) touch no stock.
  const applyDeltas = (deltas) => {
    Object.entries(deltas).forEach(([key, delta]) => {
      if (!delta) return;
      const [pid, vid] = key.split("|");
      if (!pid || !vid) return;
      cloudAdjustVariant(pid, vid, -delta).catch((e) => console.error("stock adjust failed", e));
    });
  };
  const lineKey = (l) => (l.misc || !l.productId ? "" : l.productId + "|" + l.variantId);

  const deleteSale = (s) => {
    if (!confirm(`Delete this ${INR(s.total)} bill from ${s.date}? Stock will be added back.`))
      return;
    const deltas = {};
    s.lines.forEach((l) => {
      const k = lineKey(l);
      if (k) deltas[k] = (deltas[k] || 0) - l.qty;
    });
    applyDeltas(deltas);
    setSales((all) => all.filter((x) => x.id !== s.id));
    log("sale", `Deleted bill ${INR(s.total)} (${s.date}) — stock restored`);
    notify("Bill deleted, stock restored");
  };

  const openEdit = (s) =>
    setEditing({
      id: s.id,
      date: s.date,
      payment: s.payment || "UPI",
      paid: s.paid != null ? String(s.paid) : "",
      paidMode: s.paidMode || "Cash",
      discount: s.discount != null ? String(s.discount) : "", // editable ₹ discount (a % discount is edited as its ₹ value)
      lines: s.lines.map((l) => ({ ...l })),
      orig: s.lines.map((l) => ({ ...l })),
    });
  const editLine = (idx, qty) =>
    setEditing((e) => ({
      ...e,
      lines: e.lines.map((l, i) => (i === idx ? { ...l, qty: Math.max(0, qty || 0) } : l)),
    }));
  const removeLine = (idx) =>
    setEditing((e) => ({ ...e, lines: e.lines.filter((_, i) => i !== idx) }));
  const editSubtotal = editing ? money(editing.lines.reduce((a, l) => a + l.price * l.qty, 0)) : 0;
  const editDiscount = editing
    ? Math.min(editSubtotal, Math.max(0, money(+editing.discount || 0)))
    : 0;
  const editTotal = money(editSubtotal - editDiscount);

  const saveEdit = () => {
    const newLines = editing.lines
      .filter((l) => l.qty > 0)
      .map((l) => ({ ...l, amount: money(l.price * l.qty) }));
    if (newLines.length === 0) return notify("A bill needs at least one line — use Delete instead");
    const gross = money(newLines.reduce((a, l) => a + l.amount, 0));
    // Re-clamp any existing discount to the new subtotal, then net it off total and profit.
    const discountAmt = Math.min(gross, Math.max(0, money(+editing.discount || 0)));
    const total = money(gross - discountAmt);
    // Prefer the cost snapshotted on the line at sale time; fall back to the current item
    // cost only for legacy bills saved before lines carried buyPrice.
    const buyOf = (l) =>
      l.buyPrice != null
        ? +l.buyPrice
        : items.find((i) => i.name.toLowerCase() === l.name.toLowerCase())?.purchasePrice || 0;
    const profit = money(
      newLines.reduce((a, l) => a + (l.price - buyOf(l)) * l.qty, 0) - discountAmt
    );
    const oldQ = {},
      newQ = {};
    // Reconcile stock per (product, variant). Misc / legacy lines have no key → skipped.
    editing.orig.forEach((l) => {
      const k = lineKey(l);
      if (k) oldQ[k] = (oldQ[k] || 0) + l.qty;
    });
    newLines.forEach((l) => {
      const k = lineKey(l);
      if (k) newQ[k] = (newQ[k] || 0) + l.qty;
    });
    const deltas = {};
    [...new Set([...Object.keys(oldQ), ...Object.keys(newQ)])].forEach((k) => {
      const d = (newQ[k] || 0) - (oldQ[k] || 0);
      if (d) deltas[k] = d;
    });
    applyDeltas(deltas);
    const paid =
      editing.payment === "Udhari"
        ? Math.min(total, Math.max(0, money(+editing.paid || 0)))
        : undefined;
    setSales((all) =>
      all.map((x) => {
        if (x.id !== editing.id) return x;
        const next = {
          ...x,
          date: editing.date || x.date,
          payment: editing.payment,
          lines: newLines,
          total,
          profit,
        };
        // A % discount, once edited, is stored as its plain ₹ value — drop the stale percent tag.
        if (discountAmt > 0) {
          next.subtotal = gross;
          next.discount = discountAmt;
          delete next.discountPct;
        } else {
          delete next.subtotal;
          delete next.discount;
          delete next.discountPct;
        }
        if (editing.payment === "Udhari") {
          next.paid = paid;
          if (paid > 0) next.paidMode = editing.paidMode;
          else delete next.paidMode;
        } else {
          delete next.paid;
          delete next.paidMode;
        }
        return next;
      })
    );
    log("sale", `Edited bill → ${INR(total)} · ${newLines.length} line(s) · ${editing.payment}`);
    setEditing(null);
    notify("Bill updated");
  };

  // ----- Split a bill across multiple dates -----
  // Replaces one bill with several smaller bills whose amounts (and, in the same
  // proportion, profit + line amounts) add up to exactly the original. It is purely a
  // re-dating of money already recorded, so stock is NOT touched. Because the dashboard
  // and finance views aggregate from the sales list by date/total/profit/lines, the split
  // parts flow through everywhere and the cumulative stays equal to the original bill.
  const [splitting, setSplitting] = useState(null);
  // { id, time, payment, customer, total, profit, lines, parts:[{date, amount}] }

  const addDays = (ds, n) => {
    const d = new Date(ds + "T00:00");
    d.setDate(d.getDate() + n);
    return dateStr(d);
  };
  // Spread an amount equally across n parts as 2-dp money; the last part absorbs the remainder.
  const equalShares = (amount, n) => {
    const each = money(amount / n);
    return Array.from({ length: n }, (_, i) =>
      i === n - 1 ? money(amount - each * (n - 1)) : each
    );
  };

  const openSplit = (s) =>
    setSplitting({
      id: s.id,
      time: s.time,
      payment: s.payment || "UPI",
      customer: s.customer || "",
      mobile: s.mobile || "",
      paid: s.paid || 0,
      paidMode: s.paidMode || "Cash",
      total: s.total,
      profit: s.profit,
      lines: s.lines,
      parts: equalShares(s.total, 2).map((amount, i) => ({ date: addDays(s.date, -i), amount })),
      rangeFrom: addDays(s.date, -1),
      rangeTo: s.date,
    });
  // Every calendar day in [from, to] inclusive.
  const datesInRange = (from, to) => {
    if (!from || !to || from > to) return [];
    const out = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
  };
  const setRangeFrom = (v) => setSplitting((sp) => ({ ...sp, rangeFrom: v }));
  const setRangeTo = (v) => setSplitting((sp) => ({ ...sp, rangeTo: v }));
  // Fill one part per day across the range, divided equally (still editable afterwards).
  const applyRange = () => {
    if (!splitting) return;
    const dates = datesInRange(splitting.rangeFrom, splitting.rangeTo);
    if (!dates.length) return notify("Pick a valid range — From must be on or before To.");
    if (dates.length > 90) return notify("Range too large — keep it within 90 days.");
    const shares = equalShares(splitting.total, dates.length);
    setSplitting((sp) => ({ ...sp, parts: dates.map((date, i) => ({ date, amount: shares[i] })) }));
  };
  const divideEqually = () =>
    setSplitting((sp) => {
      const shares = equalShares(sp.total, sp.parts.length);
      return { ...sp, parts: sp.parts.map((p, i) => ({ ...p, amount: shares[i] })) };
    });
  const addPart = () =>
    setSplitting((sp) => {
      const lastDate = sp.parts[sp.parts.length - 1]?.date || todayStr();
      const parts = [...sp.parts, { date: addDays(lastDate, -1), amount: 0 }];
      const shares = equalShares(sp.total, parts.length);
      return { ...sp, parts: parts.map((p, i) => ({ ...p, amount: shares[i] })) };
    });
  const removePart = (idx) =>
    setSplitting((sp) => {
      if (sp.parts.length <= 2) return sp;
      const parts = sp.parts.filter((_, i) => i !== idx);
      const shares = equalShares(sp.total, parts.length);
      return { ...sp, parts: parts.map((p, i) => ({ ...p, amount: shares[i] })) };
    });
  const setPartDate = (idx, date) =>
    setSplitting((sp) => ({
      ...sp,
      parts: sp.parts.map((p, i) => (i === idx ? { ...p, date } : p)),
    }));
  const setPartAmount = (idx, amount) =>
    setSplitting((sp) => ({
      ...sp,
      parts: sp.parts.map((p, i) => (i === idx ? { ...p, amount } : p)),
    }));
  // Put whatever is left over (total − all earlier parts) onto the last part, so the
  // amounts add up to the original in one click after editing the others.
  const balanceSplit = () =>
    setSplitting((sp) => {
      const exceptLast = money(sp.parts.slice(0, -1).reduce((a, p) => a + (+p.amount || 0), 0));
      return {
        ...sp,
        parts: sp.parts.map((p, i) =>
          i === sp.parts.length - 1 ? { ...p, amount: money(sp.total - exceptLast) } : p
        ),
      };
    });

  const splitSum = splitting ? money(splitting.parts.reduce((a, p) => a + (+p.amount || 0), 0)) : 0;
  const splitDiff = splitting ? money(splitting.total - splitSum) : 0;
  // Valid when every part has a date and a positive amount, and the amounts add up to the
  // original to the paisa. A sub-paisa float residual is tolerated and snapped exactly on save.
  const splitValid =
    !!splitting &&
    splitting.parts.length >= 2 &&
    splitting.parts.every((p) => p.date && (+p.amount || 0) > 0) &&
    Math.abs(splitDiff) < 0.005;

  const saveSplit = () => {
    if (!splitValid) return;
    const { id, time, payment, customer, mobile, paid, paidMode, total, profit, lines } = splitting;
    // Snap the last part to absorb any sub-paisa residual so the parts sum to EXACTLY total.
    const exceptLast = money(
      splitting.parts.slice(0, -1).reduce((a, p) => a + (+p.amount || 0), 0)
    );
    const parts = splitting.parts.map((p, i, arr) => ({
      ...p,
      amount: i === arr.length - 1 ? money(total - exceptLast) : money(+p.amount || 0),
    }));
    let profAcc = 0,
      paidAcc = 0;
    const newSales = parts.map((p, idx) => {
      const f = +p.amount / total;
      const isLast = idx === parts.length - 1;
      const prof = isLast ? money(profit - profAcc) : money(profit * f);
      profAcc = money(profAcc + prof);
      // Distribute any Udhari part-payment proportionally too (remainder on the last part).
      const partPaid = isLast ? money((+paid || 0) - paidAcc) : money((+paid || 0) * f);
      paidAcc = money(paidAcc + partPaid);
      // Scale each line by the same proportion; nudge the last line so the lines sum to
      // this part's amount exactly (keeps the bill detail and top-items totals consistent).
      let amtAcc = 0;
      const sl = lines.map((l) => {
        const amount = money((+l.amount || 0) * f);
        amtAcc = money(amtAcc + amount);
        return { ...l, qty: Math.round((+l.qty || 0) * f * 1000) / 1000, amount };
      });
      if (sl.length) {
        const d = money(+p.amount - amtAcc);
        if (d)
          sl[sl.length - 1] = { ...sl[sl.length - 1], amount: money(sl[sl.length - 1].amount + d) };
      }
      return {
        id: uid(),
        date: p.date,
        time: `${time || ""} (split ${idx + 1}/${parts.length})`.trim(),
        lines: sl,
        total: money(+p.amount),
        profit: prof,
        payment,
        ...(customer ? { customer } : {}),
        ...(mobile ? { mobile } : {}),
        ...(payment === "Udhari" ? { paid: partPaid } : {}),
        ...(payment === "Udhari" && partPaid > 0 ? { paidMode } : {}),
        splitOf: id,
      };
    });
    setSales((all) => all.flatMap((x) => (x.id === id ? newSales : [x])));
    log(
      "sale",
      `Split bill ${INR(total)} into ${parts.length} part(s) across ${new Set(parts.map((p) => p.date)).size} date(s)`
    );
    setSplitting(null);
    notify(`Bill split into ${parts.length} parts`);
  };

  return (
    <div>
      <Header
        title="Sales History"
        sub={`${visible.length} of ${sales.length} bills · ${INR(rangeTotal)}`}
      />

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
        <input
          className="input"
          style={{ flex: 1, minWidth: 0 }}
          placeholder="🔍 Search bills — item, customer, mobile, amount, payment…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {q && (
          <button className="btn ghost small" onClick={() => setQ("")}>
            Clear search
          </button>
        )}
      </div>

      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          marginBottom: 14,
          flexWrap: "wrap",
        }}
      >
        <label style={{ fontSize: 12, color: "#6B7E74" }}>
          From{" "}
          <input
            type="date"
            className="input"
            style={{ width: "auto", marginLeft: 4 }}
            value={from}
            max={to || todayStr()}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label style={{ fontSize: 12, color: "#6B7E74" }}>
          To{" "}
          <input
            type="date"
            className="input"
            style={{ width: "auto", marginLeft: 4 }}
            value={to}
            max={todayStr()}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        {(from || to) && (
          <button
            className="btn ghost small"
            onClick={() => {
              setFrom("");
              setTo("");
            }}
          >
            Clear range
          </button>
        )}
      </div>

      {sales.length === 0 && (
        <section style={S.panel}>
          <Empty text="No sales yet. Bills will appear here after you complete a sale." />
        </section>
      )}
      {sales.length > 0 && visible.length === 0 && (
        <section style={S.panel}>
          <Empty
            text={
              searching
                ? `No bills match “${q.trim()}”${from || to ? " in this date range" : ""}.`
                : "No bills in this date range."
            }
          />
        </section>
      )}
      {byDate.map(([date, list]) => {
        const isToday = date === todayStr();
        // Today is always open; every other date collapses (closed by default) so the list scans
        // quickly. While searching, open every matching date so the results are all visible.
        const expanded = isToday || searching || openDates.has(date);
        return (
          <section key={date} style={{ ...S.panel, marginBottom: 14 }}>
            <div
              style={{ ...S.panelHead, ...(isToday ? {} : { cursor: "pointer" }) }}
              onClick={isToday ? undefined : () => toggleDate(date)}
              {...(isToday ? {} : { role: "button", "aria-expanded": expanded })}
            >
              {!isToday && (
                <span style={{ color: "#8A9C90", marginRight: 6 }}>{expanded ? "▾" : "▸"}</span>
              )}
              {new Date(date + "T00:00").toLocaleDateString("en-IN", {
                weekday: "short",
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
              {isToday && (
                <span style={{ fontWeight: 600, color: "#1B5E43", marginLeft: 8 }}>· Today</span>
              )}
              <span style={{ fontWeight: 500, color: "#8A9C90", marginLeft: 8 }}>
                · {list.length} bill{list.length > 1 ? "s" : ""}
              </span>
              <span style={{ marginLeft: "auto", fontWeight: 800 }}>
                {INR(list.reduce((a, s) => a + s.total, 0))}
              </span>
            </div>
            {expanded &&
              list.map((s) => (
                <div key={s.id}>
                  <div
                    style={{ ...S.row, cursor: "pointer" }}
                    onClick={() => setOpen(open === s.id ? null : s.id)}
                  >
                    <span>
                      {s.time} · {s.lines.length} item{s.lines.length > 1 ? "s" : ""}
                      {searching && (
                        <span style={{ marginLeft: 6, fontSize: 11, color: "#8A9C90" }}>
                          {new Date(s.date + "T00:00").toLocaleDateString("en-IN", {
                            day: "numeric",
                            month: "short",
                          })}
                        </span>
                      )}
                      {s.payment && (
                        <span
                          style={{
                            marginLeft: 8,
                            fontSize: 10.5,
                            fontWeight: 800,
                            color: PAY_COLORS[s.payment] || "#789",
                            border: `1px solid ${PAY_COLORS[s.payment] || "#bbb"}`,
                            borderRadius: 6,
                            padding: "0 6px",
                          }}
                        >
                          {s.payment}
                          {s.customer ? " · " + s.customer : ""}
                          {s.mobile ? " · " + s.mobile : ""}
                        </span>
                      )}
                    </span>
                    <span>
                      <b>{INR(s.total)}</b>{" "}
                      <span style={{ color: "#1B5E43", fontSize: 12 }}>(+{INR(s.profit)})</span>
                      {s.payment === "Udhari" && s.total - (s.paid || 0) > 0 && (
                        <span
                          style={{
                            color: "#C44536",
                            fontSize: 11.5,
                            fontWeight: 700,
                            marginLeft: 6,
                          }}
                        >
                          {INR(money(s.total - (s.paid || 0)))} due
                        </span>
                      )}{" "}
                      {open === s.id ? "▾" : "▸"}
                    </span>
                  </div>
                  {(open === s.id || searching) && (
                    <div
                      style={{
                        background: "#F4F7F4",
                        borderRadius: 8,
                        padding: "8px 12px",
                        margin: "0 0 8px",
                      }}
                    >
                      {s.lines.map((l, i) => (
                        <div
                          key={i}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            fontSize: 12.5,
                            padding: "3px 0",
                          }}
                        >
                          <span>
                            {l.name} × {l.qty}
                          </span>
                          <span>{INR(l.amount)}</span>
                        </div>
                      ))}
                      {s.discount > 0 && (
                        <div
                          style={{ borderTop: "1px dashed #D8E0D8", marginTop: 4, paddingTop: 4 }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              fontSize: 12.5,
                              padding: "2px 0",
                              color: "#6B7E74",
                            }}
                          >
                            <span>Subtotal</span>
                            <span>
                              {INR(s.subtotal != null ? s.subtotal : money(s.total + s.discount))}
                            </span>
                          </div>
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              fontSize: 12.5,
                              padding: "2px 0",
                              color: "#C44536",
                              fontWeight: 600,
                            }}
                          >
                            <span>Discount{s.discountPct ? ` (${s.discountPct}%)` : ""}</span>
                            <span>−{INR(s.discount)}</span>
                          </div>
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              fontSize: 13,
                              padding: "2px 0",
                              fontWeight: 800,
                            }}
                          >
                            <span>Total</span>
                            <span>{INR(s.total)}</span>
                          </div>
                        </div>
                      )}
                      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                        <button className="btn small" onClick={() => printReceipt(s, config)}>
                          🖨 Print
                        </button>
                        <button className="btn small ghost" onClick={() => openEdit(s)}>
                          ✎ Edit bill
                        </button>
                        <button className="btn small ghost" onClick={() => openSplit(s)}>
                          ✂ Split
                        </button>
                        <button className="btn small danger" onClick={() => deleteSale(s)}>
                          🗑 Delete
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
          </section>
        );
      })}

      {editing && (
        <Modal title="Edit bill" onClose={() => setEditing(null)}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Date">
              <input
                type="date"
                className="input"
                max={todayStr()}
                value={editing.date}
                onChange={(e) => setEditing({ ...editing, date: e.target.value })}
              />
            </Field>
            <Field label="Payment">
              <select
                className="input"
                value={editing.payment}
                onChange={(e) => setEditing({ ...editing, payment: e.target.value })}
              >
                {["UPI", "Cash", "Udhari"].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </Field>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>Item</th>
                <th style={{ width: 70 }}>Qty</th>
                <th style={{ textAlign: "right" }}>Amount</th>
                <th style={{ width: 30 }}></th>
              </tr>
            </thead>
            <tbody>
              {editing.lines.map((l, idx) => (
                <tr key={idx}>
                  <td>
                    {l.name}
                    <div style={{ fontSize: 11, color: "#9AA" }}>
                      {INR(l.price)}
                      {lineVariantText(l) ? " · " + lineVariantText(l) : ""}
                    </div>
                  </td>
                  <td>
                    <input
                      className="input"
                      style={{ padding: "6px 8px" }}
                      type="number"
                      min="0"
                      value={l.qty}
                      onChange={(e) => editLine(idx, +e.target.value)}
                    />
                  </td>
                  <td style={{ textAlign: "right", fontWeight: 700 }}>
                    {INR(money(l.price * l.qty))}
                  </td>
                  <td>
                    <button
                      className="btn small danger"
                      aria-label="Remove line"
                      onClick={() => removeLine(idx)}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Field label="Additional discount (₹)">
            <input
              className="input"
              type="number"
              min="0"
              step="0.01"
              max={editSubtotal}
              placeholder="0"
              value={editing.discount}
              onChange={(e) => setEditing({ ...editing, discount: e.target.value })}
            />
          </Field>
          {editDiscount > 0 && (
            <>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 12.5,
                  color: "#6B7E74",
                }}
              >
                <span>Subtotal</span>
                <span>{INR(editSubtotal)}</span>
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 12.5,
                  color: "#C44536",
                  fontWeight: 600,
                }}
              >
                <span>Discount</span>
                <span>−{INR(editDiscount)}</span>
              </div>
            </>
          )}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontWeight: 800,
              marginTop: 10,
            }}
          >
            <span>New total</span>
            <span>{INR(editTotal)}</span>
          </div>
          {editing.payment === "Udhari" && (
            <div style={{ marginTop: 8 }}>
              <Field label="Amount paid (mark repayments here)">
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    type="number"
                    min="0"
                    step="0.01"
                    max={editTotal}
                    value={editing.paid}
                    onChange={(e) => setEditing({ ...editing, paid: e.target.value })}
                  />
                  <button
                    className="btn small ghost"
                    onClick={() => setEditing({ ...editing, paid: String(editTotal) })}
                  >
                    Mark fully paid
                  </button>
                </div>
              </Field>
              {+editing.paid > 0 && (
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    alignItems: "center",
                    marginTop: -4,
                    marginBottom: 4,
                  }}
                >
                  <span style={{ fontSize: 11.5, color: "#6B7E74", fontWeight: 600 }}>
                    Paid via
                  </span>
                  {["UPI", "Cash"].map((m) => (
                    <button
                      key={m}
                      className={"btn small " + (editing.paidMode === m ? "primary" : "ghost")}
                      onClick={() => setEditing({ ...editing, paidMode: m })}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}
              <div style={{ fontSize: 12, textAlign: "right", color: "#C44536", fontWeight: 600 }}>
                Outstanding: {INR(Math.max(0, money(editTotal - (+editing.paid || 0))))}
              </div>
            </div>
          )}
          <div style={{ fontSize: 11.5, color: "#6B7E74", marginTop: 4 }}>
            Stock adjusts automatically for any quantity change.
          </div>
          <button
            className="btn primary big"
            style={{ width: "100%", marginTop: 12 }}
            onClick={saveEdit}
          >
            Save changes
          </button>
        </Modal>
      )}

      {splitting && (
        <Modal title="Split bill across dates" onClose={() => setSplitting(null)}>
          <div style={{ fontSize: 12.5, color: "#6B7E74", marginBottom: 10, lineHeight: 1.5 }}>
            Original total <b>{INR(splitting.total)}</b>. Give each part a date and an amount — by
            default it's divided equally, but you can enter your own amounts. The parts must add up
            to exactly the original total. Profit and items are split in the same proportion, so the
            dashboard and finance graphs stay accurate. (Stock isn't affected.)
          </div>
          <div
            style={{
              background: "#F4F7F4",
              borderRadius: 8,
              padding: "8px 12px",
              marginBottom: 10,
            }}
          >
            <div style={{ fontSize: 11.5, fontWeight: 700, color: "#465", marginBottom: 6 }}>
              Split over a date range
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ fontSize: 12, color: "#6B7E74" }}>
                From{" "}
                <input
                  type="date"
                  className="input"
                  style={{ width: "auto", marginLeft: 4 }}
                  max={splitting.rangeTo || todayStr()}
                  value={splitting.rangeFrom}
                  onChange={(e) => setRangeFrom(e.target.value)}
                />
              </label>
              <label style={{ fontSize: 12, color: "#6B7E74" }}>
                To{" "}
                <input
                  type="date"
                  className="input"
                  style={{ width: "auto", marginLeft: 4 }}
                  max={todayStr()}
                  value={splitting.rangeTo}
                  onChange={(e) => setRangeTo(e.target.value)}
                />
              </label>
              <button className="btn small" onClick={applyRange}>
                Fill range
              </button>
            </div>
            <div style={{ fontSize: 11, color: "#8A9C90", marginTop: 6 }}>
              Creates one part per day in the range, divided equally — then edit any amount below.
            </div>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>Date</th>
                <th style={{ textAlign: "right" }}>Amount ₹</th>
                <th style={{ width: 30 }}></th>
              </tr>
            </thead>
            <tbody>
              {splitting.parts.map((p, idx) => (
                <tr key={idx}>
                  <td>
                    <input
                      type="date"
                      className="input"
                      style={{ padding: "6px 8px" }}
                      max={todayStr()}
                      value={p.date}
                      onChange={(e) => setPartDate(idx, e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className="input"
                      style={{ padding: "6px 8px", textAlign: "right" }}
                      value={p.amount}
                      onChange={(e) => setPartAmount(idx, +e.target.value)}
                    />
                  </td>
                  <td>
                    <button
                      className="btn small danger"
                      disabled={splitting.parts.length <= 2}
                      aria-label="Remove part"
                      onClick={() => removePart(idx)}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button className="btn small ghost" onClick={addPart}>
              + Add date
            </button>
            <button className="btn small ghost" onClick={divideEqually}>
              Divide equally
            </button>
            <button
              className="btn small ghost"
              onClick={balanceSplit}
              disabled={Math.abs(splitDiff) < 0.005}
            >
              Balance last row
            </button>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontWeight: 800,
              marginTop: 12,
            }}
          >
            <span>Split total</span>
            <span style={{ color: Math.abs(splitDiff) < 0.005 ? "#1B5E43" : "#C44536" }}>
              {INR(splitSum)} / {INR(splitting.total)}
            </span>
          </div>
          {Math.abs(splitDiff) >= 0.005 && (
            <div style={{ fontSize: 12, color: "#C44536", marginTop: 4 }}>
              Amounts must add up to {INR(splitting.total)} —{" "}
              {splitDiff > 0 ? `${INR(splitDiff)} short` : `${INR(-splitDiff)} over`}. Use “Balance
              last row” to put the rest on the last date.
            </div>
          )}
          <button
            className="btn primary big"
            style={{ width: "100%", marginTop: 12 }}
            disabled={!splitValid}
            onClick={saveSplit}
          >
            Save split · {splitting.parts.length} part(s)
          </button>
        </Modal>
      )}
    </div>
  );
}

// ---------- Alerts ----------
// Low-stock alerts are evaluated at the VARIANT level: each row is a single size/colour variant
// that has fallen to or below its own threshold (e.g. "Kurti X — size M low").
function Alerts({ items, goInventory }) {
  const [view, setView] = useState("low"); // low | out
  const [grp, setGrp] = useState("All");
  const rows = useMemo(() => {
    const inGroup = (i) => grp === "All" || (i.category || "") === grp;
    const out = [];
    items.filter(inGroup).forEach((p) => {
      (p.variants || []).forEach((v) => {
        const qty = Number(v.stockQty) || 0;
        const lowAt = Number(v.lowAt) || 0;
        if (qty <= lowAt) out.push({ p, v, qty, lowAt });
      });
    });
    return out.sort((a, b) => a.qty - b.qty || String(a.p.name).localeCompare(String(b.p.name)));
  }, [items, grp]);

  const lowRows = rows;
  const outRows = rows.filter((r) => r.qty <= 0);
  const list = view === "out" ? outRows : lowRows;
  const tabs = [
    ["low", "Low / out", lowRows.length],
    ["out", "Out of stock", outRows.length],
  ];

  return (
    <div>
      <Header title="Alerts" sub="Size/colour variants running low (lowest stock first)">
        <button className="btn ghost small" onClick={goInventory}>
          Go to inventory
        </button>
      </Header>

      <div
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 14,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        {tabs.map(([k, lbl, n]) => (
          <button
            key={k}
            className={"btn small " + (view === k ? "primary" : "")}
            onClick={() => setView(k)}
          >
            {lbl} <b>({n})</b>
          </button>
        ))}
        <div
          style={{
            display: "flex",
            border: "1.5px solid #E1D4DA",
            borderRadius: 9,
            overflow: "hidden",
            marginLeft: "auto",
          }}
        >
          {["All", ...GROUPS].map((g) => (
            <button key={g} className={"seg" + (grp === g ? " on" : "")} onClick={() => setGrp(g)}>
              {g}
            </button>
          ))}
        </div>
      </div>

      <section style={S.panel}>
        {list.length === 0 ? (
          <Empty text="Nothing here — stock looks healthy." />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Product</th>
                <th>Category</th>
                <th>Variant</th>
                <th style={{ textAlign: "right" }}>Stock</th>
                <th style={{ textAlign: "right" }}>Alert below</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.p.id + "|" + r.v.id}>
                  <td style={{ fontWeight: 600 }}>
                    <span style={{ marginRight: 6 }}>{iconFor(r.p)}</span>
                    {r.p.name}
                  </td>
                  <td style={{ color: "#677" }}>
                    {[r.p.category, r.p.subcategory].filter(Boolean).join(" · ")}
                  </td>
                  <td>
                    <ColorDot color={r.v.color} />
                    {variantLabel(r.v)}
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontWeight: 800,
                      color: r.qty <= 0 ? "#C44536" : "#B0762A",
                    }}
                  >
                    {r.qty}
                  </td>
                  <td style={{ textAlign: "right", color: "#789" }}>{r.lowAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

// ---------- Activity Log ----------
const LOG_COLORS = {
  sale: "#1B5E43",
  inventory: "#2A6FB0",
  expense: "#C44536",
  import: "#7A5AB0",
  backup: "#7A6A1E",
  bill: "#0E7C86",
};

function Logs({ logs, setLogs, notify }) {
  const [date, setDate] = useState(""); // "" = all dates
  const [type, setType] = useState("all");

  const filtered = logs.filter(
    (l) => (!date || l.date === date) && (type === "all" || l.type === type)
  );

  const clear = () => {
    if (
      confirm(
        "Clear the entire activity log? This cannot be undone (it does not affect sales or stock)."
      )
    ) {
      setLogs([]);
      notify("Activity log cleared");
    }
  };

  return (
    <div>
      <Header
        title="Activity Log"
        sub={logs.length + " events recorded — every change is logged here"}
      >
        {logs.length > 0 && (
          <button className="btn ghost small" onClick={clear}>
            Clear log
          </button>
        )}
      </Header>

      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <label style={{ fontSize: 12, color: "#6B7E74" }}>
          Day{" "}
          <input
            type="date"
            className="input"
            style={{ width: "auto", marginLeft: 4 }}
            value={date}
            max={todayStr()}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <select
          className="input"
          style={{ width: 180 }}
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="all">All activity</option>
          {LOG_TYPES.map((t) => (
            <option key={t} value={t}>
              {t[0].toUpperCase() + t.slice(1)}
            </option>
          ))}
        </select>
        {(date || type !== "all") && (
          <button
            className="btn ghost small"
            onClick={() => {
              setDate("");
              setType("all");
            }}
          >
            Show all
          </button>
        )}
      </div>

      <section style={S.panel}>
        {filtered.length === 0 ? (
          <Empty
            text={
              logs.length === 0
                ? "No activity yet. Actions you take in the app will appear here."
                : "No activity matches this filter."
            }
          />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 168 }}>When</th>
                <th style={{ width: 96 }}>Type</th>
                <th>Activity</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((l) => (
                <tr key={l.id}>
                  <td style={{ whiteSpace: "nowrap", color: "#677" }}>
                    {l.date} <span style={{ color: "#9AA" }}>{l.time}</span>
                  </td>
                  <td>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 800,
                        textTransform: "uppercase",
                        color: LOG_COLORS[l.type] || "#555",
                      }}
                    >
                      {l.type}
                    </span>
                  </td>
                  <td>{l.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

// ---------- Finance analytics helpers ----------
const PIE_COLORS = [
  "#1B5E43",
  "#E8A33D",
  "#2A6FB0",
  "#C44536",
  "#7A5AB0",
  "#3DA17A",
  "#B0762A",
  "#8A9C90",
];
const inrTick = (v) => "₹" + (Math.abs(v) >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + "k" : v);
// Value labels sitting on top of vertical bars (compact ₹). Zeros are hidden so
// sparse charts stay uncluttered.
const barLabel = {
  position: "top",
  formatter: (v) => (v ? inrTick(v) : ""),
  fontSize: 9.5,
  fill: "#465",
};

// Resolve a period preset (+ optional custom range) to { from, to, label }.
// `earliest` (a YYYY-MM-DD) is only consulted for the "allTime" preset — the caller
// passes the oldest record date so "All time" spans exactly the real data.
function periodRange(preset, cfrom, cto, earliest) {
  const now = new Date();
  const y = now.getFullYear(),
    m = now.getMonth();
  const som = (yy, mm) => dateStr(new Date(yy, mm, 1));
  const eom = (yy, mm) => dateStr(new Date(yy, mm + 1, 0));
  switch (preset) {
    case "lastMonth": {
      const d = new Date(y, m - 1, 1);
      return {
        from: som(d.getFullYear(), d.getMonth()),
        to: eom(d.getFullYear(), d.getMonth()),
        label: d.toLocaleDateString("en-IN", { month: "long", year: "numeric" }),
      };
    }
    case "thisYear":
      return { from: dateStr(new Date(y, 0, 1)), to: dateStr(now), label: "Year " + y };
    case "last7": {
      const d = new Date();
      d.setDate(d.getDate() - 6);
      return { from: dateStr(d), to: dateStr(now), label: "Last 7 days" };
    }
    case "last14": {
      const d = new Date();
      d.setDate(d.getDate() - 13);
      return { from: dateStr(d), to: dateStr(now), label: "Last 14 days" };
    }
    case "last30": {
      const d = new Date();
      d.setDate(d.getDate() - 29);
      return { from: dateStr(d), to: dateStr(now), label: "Last 30 days" };
    }
    case "last45": {
      const d = new Date();
      d.setDate(d.getDate() - 44);
      return { from: dateStr(d), to: dateStr(now), label: "Last 45 days" };
    }
    // Month-based windows: new Date(y, m-N, day) rolls the year correctly and clamps overflow days.
    case "last2m": {
      const d = new Date(y, m - 2, now.getDate());
      return { from: dateStr(d), to: dateStr(now), label: "Last 2 months" };
    }
    case "lastQuarter": {
      const d = new Date(y, m - 3, now.getDate());
      return { from: dateStr(d), to: dateStr(now), label: "Last 3 months" };
    }
    case "last6m": {
      const d = new Date(y, m - 6, now.getDate());
      return { from: dateStr(d), to: dateStr(now), label: "Last 6 months" };
    }
    // All data on record: from the oldest entry — i.e. when the shop's books begin —
    // up to today. The label surfaces that start date so it's clear where "all time" begins.
    case "allTime": {
      const start = earliest || dateStr(new Date(y - 5, 0, 1));
      const since = earliest
        ? new Date(earliest + "T00:00").toLocaleDateString("en-IN", {
            day: "numeric",
            month: "short",
            year: "numeric",
          })
        : null;
      return {
        from: start,
        to: dateStr(now),
        label: since ? `All time · since ${since}` : "All time",
      };
    }
    case "custom":
      return {
        from: cfrom || dateStr(now),
        to: cto || dateStr(now),
        label: `${cfrom || "…"} → ${cto || "…"}`,
      };
    default:
      return {
        from: som(y, m),
        to: dateStr(now),
        label: now.toLocaleDateString("en-IN", { month: "long", year: "numeric" }),
      };
  }
}

// Build a daily (or monthly, for long ranges) revenue/profit/expense series.
function buildSeries(sales, expenses, from, to) {
  const start = new Date(from + "T00:00"),
    end = new Date(to + "T00:00");
  if (isNaN(start) || isNaN(end) || end < start) return [];
  const monthly = (end - start) / 86400000 > 62;
  const keyOf = (ds) => (monthly ? ds.slice(0, 7) : ds);
  const labelOf = (k) =>
    monthly
      ? new Date(k + "-01T00:00").toLocaleDateString("en-IN", { month: "short", year: "2-digit" })
      : new Date(k + "T00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  const buckets = new Map();
  if (monthly) {
    let d = new Date(start.getFullYear(), start.getMonth(), 1);
    while (d <= end) {
      const k = dateStr(d).slice(0, 7);
      buckets.set(k, {
        key: k,
        label: labelOf(k),
        revenue: 0,
        profit: 0,
        expenses: 0,
        cash: 0,
        upi: 0,
      });
      d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    }
  } else {
    const d = new Date(start);
    while (d <= end) {
      const k = dateStr(d);
      buckets.set(k, {
        key: k,
        label: labelOf(k),
        revenue: 0,
        profit: 0,
        expenses: 0,
        cash: 0,
        upi: 0,
      });
      d.setDate(d.getDate() + 1);
    }
  }
  sales.forEach((s) => {
    const b = buckets.get(keyOf(s.date));
    if (b) {
      b.revenue += s.total;
      b.profit += s.profit;
      if (s.payment === "Cash") b.cash += s.total;
      else if (s.payment === "UPI") b.upi += s.total;
    }
  });
  expenses.forEach((e) => {
    const b = buckets.get(keyOf(e.date));
    if (b) b.expenses += e.amount;
  });
  return [...buckets.values()].map((b) => ({
    ...b,
    revenue: money(b.revenue),
    profit: money(b.profit),
    expenses: money(b.expenses),
    cash: money(b.cash),
    upi: money(b.upi),
  }));
}

// Day-wise revenue/profit buckets across [from, to] inclusive. One bucket per calendar
// day; days with no sales show as zero. Used by the Dashboard "period" charts.
function buildDaily(sales, from, to) {
  const start = new Date(from + "T00:00"),
    end = new Date(to + "T00:00");
  if (isNaN(start) || isNaN(end) || end < start) return [];
  const buckets = new Map();
  const d = new Date(start);
  while (d <= end) {
    const k = dateStr(d);
    buckets.set(k, {
      key: k,
      label: new Date(k + "T00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
      revenue: 0,
      profit: 0,
    });
    d.setDate(d.getDate() + 1);
  }
  sales.forEach((s) => {
    const b = buckets.get(s.date);
    if (b) {
      b.revenue += s.total || 0;
      b.profit += s.profit || 0;
    }
  });
  return [...buckets.values()].map((b) => ({
    ...b,
    revenue: money(b.revenue),
    profit: money(b.profit),
  }));
}

// Monday that begins the week containing d.
const weekStartOf = (d) => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const wd = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - wd);
  return x;
};

// Week-wise revenue/profit buckets across [from, to] inclusive. One bucket per calendar
// week (Mon–Sun); weeks with no sales show as zero. Labels mark the week-start date.
function buildWeekly(sales, from, to) {
  const start = new Date(from + "T00:00"),
    end = new Date(to + "T00:00");
  if (isNaN(start) || isNaN(end) || end < start) return [];
  const buckets = new Map();
  const d = weekStartOf(start);
  while (d <= end) {
    const k = dateStr(d);
    buckets.set(k, {
      key: k,
      label: new Date(k + "T00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
      revenue: 0,
      profit: 0,
    });
    d.setDate(d.getDate() + 7);
  }
  sales.forEach((s) => {
    if (!s.date) return;
    const b = buckets.get(dateStr(weekStartOf(new Date(s.date + "T00:00"))));
    if (b) {
      b.revenue += s.total || 0;
      b.profit += s.profit || 0;
    }
  });
  return [...buckets.values()].map((b) => ({
    ...b,
    revenue: money(b.revenue),
    profit: money(b.profit),
  }));
}

// Period options for the Dashboard "over time" charts. Each computes the from-date
// relative to today; the range end is always today.
const DASH_PERIODS = [
  ["7d", "Last 7 days", (d) => d.setDate(d.getDate() - 6)],
  ["14d", "Last 14 days", (d) => d.setDate(d.getDate() - 13)],
  ["1m", "Last 1 month", (d) => d.setMonth(d.getMonth() - 1)],
  ["2m", "Last 2 months", (d) => d.setMonth(d.getMonth() - 2)],
  ["quarter", "Last quarter", (d) => d.setMonth(d.getMonth() - 3)],
  ["6m", "Last 6 months", (d) => d.setMonth(d.getMonth() - 6)],
  ["1y", "Last year", (d) => d.setFullYear(d.getFullYear() - 1)],
  ["custom", "Custom date period", null],
];

const ChartCard = ({ title, children, height = 240 }) => (
  <section style={S.panel}>
    <div style={S.panelHead}>{title}</div>
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  </section>
);

// Revenue split by how the bill was paid. Total includes everything (Udhari/credit too);
// Cash and UPI are the by-mode buckets. Shared by the Dashboard and Finance bar charts.
const PAYMIX_COLORS = ["#10331F", "#1B5E43", "#2A6FB0"]; // Total · Cash · UPI
const payMix = (sales) => {
  let total = 0,
    cash = 0,
    upi = 0;
  sales.forEach((s) => {
    const v = s.total || 0;
    total += v;
    if (s.payment === "Cash") cash += v;
    else if (s.payment === "UPI") upi += v;
  });
  return [
    { name: "Total", value: money(total) },
    { name: "Cash", value: money(cash) },
    { name: "UPI", value: money(upi) },
  ];
};
// Returns a BarChart ELEMENT (not a component) so it can be the direct child of ChartCard's
// ResponsiveContainer, which clones its child to inject width/height.
const renderPayMix = (sales) => {
  const data = payMix(sales);
  return (
    <BarChart data={data} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
      <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
      <XAxis dataKey="name" tick={{ fontSize: 12, fill: "#678" }} />
      <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
      <Tooltip formatter={(v) => INR(v)} />
      <Bar dataKey="value" name="Amount" radius={[3, 3, 0, 0]} label={barLabel}>
        {data.map((d, i) => (
          <Cell key={d.name} fill={PAYMIX_COLORS[i]} />
        ))}
      </Bar>
    </BarChart>
  );
};
// Trend lines for Total / Cash / UPI over a buildSeries() result. Returns a LineChart element
// so it can be ChartCard's direct child (ResponsiveContainer clones it for sizing).
const renderPayTrend = (series) => (
  <LineChart data={series} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
    <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
    <XAxis
      dataKey="label"
      tick={{ fontSize: 11, fill: "#678" }}
      interval="preserveStartEnd"
      minTickGap={20}
    />
    <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
    <Tooltip formatter={(v) => INR(v)} />
    <Legend wrapperStyle={{ fontSize: 12 }} />
    <Line
      type="monotone"
      dataKey="revenue"
      name="Total"
      stroke="#10331F"
      strokeWidth={2}
      dot={false}
    />
    <Line type="monotone" dataKey="cash" name="Cash" stroke="#1B5E43" strokeWidth={2} dot={false} />
    <Line type="monotone" dataKey="upi" name="UPI" stroke="#2A6FB0" strokeWidth={2} dot={false} />
  </LineChart>
);

// ---------- Finance (analytics) ----------
// Period presets for the analytics views. Finance and Stats each offer their own
// windows; the keys are resolved to concrete date ranges by periodRange().
const FINANCE_PERIODS = [
  ["thisMonth", "This month"],
  ["lastMonth", "Last month"],
  ["last7", "Last 7 days"],
  ["last14", "Last 14 days"],
  ["last30", "Last 30 days"],
  ["last45", "Last 45 days"],
  ["last2m", "Last 2 months"],
  ["lastQuarter", "Last quarter"],
  ["thisYear", "This year"],
  ["custom", "Custom"],
];
// Stats spans short windows through the full history. "All time" is anchored to
// fixed business milestones rather than the oldest data row: trading (sales) began
// May 2026, but capital / setup spending started earlier, in Jan 2026 — so the
// expense charts reach back further than the sales charts under "All time".
const TRADING_START = "2026-05-01"; // sales history begins — "All time" floor for revenue/profit charts
const CAPEX_START = "2026-01-01"; // capital/setup spending begins — "All time" floor for expense charts
const STATS_PERIODS = [
  ["last7", "Last 7 days"],
  ["last30", "Last 30 days"],
  ["thisMonth", "This month"],
  ["lastMonth", "Last month"],
  ["lastQuarter", "Last 3 months"],
  ["last6m", "Last 6 months"],
  ["thisYear", "This year"],
  ["allTime", "All time"],
  ["custom", "Custom"],
];

function Finance({ sales, expenses }) {
  const [preset, setPreset] = useState("thisMonth");
  const [cfrom, setCfrom] = useState("");
  const [cto, setCto] = useState("");
  const { from, to, label } = periodRange(preset, cfrom, cto);

  const pSales = useMemo(
    () => sales.filter((s) => s.date >= from && s.date <= to),
    [sales, from, to]
  );
  const pExp = useMemo(
    () => expenses.filter((e) => e.date >= from && e.date <= to),
    [expenses, from, to]
  );
  const revenue = money(pSales.reduce((a, s) => a + s.total, 0));
  const grossProfit = money(pSales.reduce((a, s) => a + s.profit, 0));
  const expTotal = money(pExp.reduce((a, e) => a + e.amount, 0));

  const series = useMemo(() => buildSeries(pSales, pExp, from, to), [pSales, pExp, from, to]);
  const expBreakdown = useMemo(() => {
    const m = {};
    pExp.forEach((e) => {
      m[e.desc] = (m[e.desc] || 0) + e.amount;
    });
    return Object.entries(m)
      .map(([name, value]) => ({ name, value: money(value) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }, [pExp]);
  const topItems = useMemo(() => {
    const m = {};
    pSales.forEach((s) =>
      (s.lines || []).forEach((l) => {
        m[l.name] = (m[l.name] || 0) + l.amount;
      })
    );
    return Object.entries(m)
      .map(([name, value]) => ({ name, value: money(value) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 7);
  }, [pSales]);

  return (
    <div>
      <Header title="Finance" sub={label}>
        <select
          className="input"
          style={{ width: "auto" }}
          value={preset}
          onChange={(e) => setPreset(e.target.value)}
        >
          {FINANCE_PERIODS.map(([k, lbl]) => (
            <option key={k} value={k}>
              {lbl}
            </option>
          ))}
        </select>
      </Header>

      {preset === "custom" && (
        <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
          <label style={{ fontSize: 12, color: "#6B7E74" }}>
            From{" "}
            <input
              type="date"
              className="input"
              style={{ width: "auto", marginLeft: 4 }}
              value={cfrom}
              max={cto || todayStr()}
              onChange={(e) => setCfrom(e.target.value)}
            />
          </label>
          <label style={{ fontSize: 12, color: "#6B7E74" }}>
            To{" "}
            <input
              type="date"
              className="input"
              style={{ width: "auto", marginLeft: 4 }}
              value={cto}
              max={todayStr()}
              onChange={(e) => setCto(e.target.value)}
            />
          </label>
        </div>
      )}

      <div style={S.cards}>
        <Card label="Revenue" value={INR(revenue)} sub={pSales.length + " bills"} />
        <Card label="Gross profit" value={INR(grossProfit)} sub="sales − item cost" />
        <Card label="Expenses" value={INR(expTotal)} sub={pExp.length + " entries"} />
        <Card
          label="Net profit"
          value={INR(money(grossProfit - expTotal))}
          sub="gross − expenses"
          accent
        />
      </div>

      <div style={{ marginTop: 16 }}>
        <ChartCard title="Total vs Cash vs UPI" height={220}>
          {renderPayMix(pSales)}
        </ChartCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <ChartCard title="Total vs Cash vs UPI — trend" height={240}>
          {renderPayTrend(series)}
        </ChartCard>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginTop: 16 }}>
        {[
          { key: "revenue", title: "Revenue", color: "#1B5E43" },
          { key: "profit", title: "Profit", color: "#E8A33D" },
          { key: "expenses", title: "Expenses", color: "#C44536" },
        ].map((c) => (
          <ChartCard key={c.key} title={c.title} height={220}>
            <BarChart data={series} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: "#678" }}
                interval="preserveStartEnd"
                minTickGap={20}
              />
              <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
              <Tooltip formatter={(v) => INR(v)} />
              <Bar dataKey={c.key} name={c.title} fill={c.color} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ChartCard>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 16, marginTop: 16 }}>
        <ChartCard title="Revenue & profit over time">
          <AreaChart data={series} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
            <defs>
              <linearGradient id="gRev" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#1B5E43" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#1B5E43" stopOpacity={0.03} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#678" }}
              interval="preserveStartEnd"
              minTickGap={20}
            />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area
              type="monotone"
              dataKey="revenue"
              name="Revenue"
              stroke="#1B5E43"
              strokeWidth={2}
              fill="url(#gRev)"
            />
            <Area
              type="monotone"
              dataKey="profit"
              name="Profit"
              stroke="#E8A33D"
              strokeWidth={2}
              fill="none"
            />
          </AreaChart>
        </ChartCard>

        <ChartCard title="Expense breakdown">
          {expBreakdown.length === 0 ? (
            <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
              <Empty text="No expenses in this period." />
            </div>
          ) : (
            <PieChart>
              <Pie
                data={expBreakdown}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={84}
                label={(e) => {
                  const n = String(e.name || "");
                  return n.length > 10 ? n.slice(0, 10) + "…" : n;
                }}
                labelLine={false}
                fontSize={10}
              >
                {expBreakdown.map((e, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(v) => INR(v)} />
            </PieChart>
          )}
        </ChartCard>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
        <ChartCard title="Revenue vs expenses">
          <BarChart data={series} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#678" }}
              interval="preserveStartEnd"
              minTickGap={20}
            />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="revenue" name="Revenue" fill="#1B5E43" radius={[3, 3, 0, 0]} />
            <Bar dataKey="expenses" name="Expenses" fill="#C44536" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ChartCard>

        <ChartCard title="Top items by revenue">
          {topItems.length === 0 ? (
            <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
              <Empty text="No sales in this period." />
            </div>
          ) : (
            <BarChart
              data={topItems}
              layout="vertical"
              margin={{ top: 4, right: 12, left: 8, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} />
              <YAxis
                type="category"
                dataKey="name"
                tick={{ fontSize: 10.5, fill: "#465" }}
                width={110}
              />
              <Tooltip formatter={(v) => INR(v)} />
              <Bar dataKey="value" name="Revenue" fill="#2A6FB0" radius={[0, 3, 3, 0]} />
            </BarChart>
          )}
        </ChartCard>
      </div>
    </div>
  );
}

// ---------- Stats (insights / analytics) ----------
// All the number-crunching lives in ./lib/stats.js (pure + unit-tested). This
// component only wires those transforms to a mobile-first, date-range-driven
// dashboard. Every inline `grid-template-columns` collapses to a single column
// under 820px via the CSS at the bottom of this file, so the phone view stacks
// automatically.
const sectionHead = {
  fontSize: 13,
  fontWeight: 800,
  color: "#10331F",
  letterSpacing: ".02em",
  margin: "24px 0 8px",
};
// (payment-method colours reuse the shared PAY_COLORS defined near Sales History)
// Bar value labels (compact ₹ / plain qty) that skip zeros to keep charts clean.
// `compactLabel` sits on top of vertical bars; the `…Right` variants end horizontal bars.
const compactLabel = {
  position: "top",
  formatter: (v) => (v ? inrCompact(v) : ""),
  fontSize: 9.5,
  fill: "#465",
};
const compactLabelRight = {
  position: "right",
  formatter: (v) => (v ? inrCompact(v) : ""),
  fontSize: 9.5,
  fill: "#465",
};
const qtyLabelRight = {
  position: "right",
  formatter: (v) => (v ? v : ""),
  fontSize: 9.5,
  fill: "#465",
};
// Exact full-₹ value printed on top of bars / line points (zeros hidden). Two
// tints so a bar and its overlaid line stay distinguishable in the combo chart.
const exactLabel = {
  position: "top",
  formatter: (v) => (v ? formatINR(v) : ""),
  fontSize: 9,
  fill: "#14432E",
};
const exactLabelGold = {
  position: "top",
  formatter: (v) => (v ? formatINR(v) : ""),
  fontSize: 9,
  fill: "#9A6410",
};

// Green ramp for the heatmap: pale mint (quiet) → deep brand green (busiest).
const heatColor = (v, max) => {
  if (!v || !max) return "#F4F7F4";
  const t = Math.sqrt(Math.min(1, v / max)); // sqrt lifts the low end so small sales still register
  const lerp = (a, b) => Math.round(a + (b - a) * t);
  return `rgb(${lerp(224, 16)},${lerp(240, 51)},${lerp(230, 31)})`;
};

// One weekday × hour heatmap of revenue. Custom CSS grid (not Recharts) so it
// stays tiny and scrolls horizontally on a phone instead of squashing.
function Heatmap({ data }) {
  if (!data || data.placed === 0 || data.minHour == null) {
    return <Empty text="No clock-timed bills in this period to map." />;
  }
  const hours = [];
  for (let h = data.minHour; h <= data.maxHour; h++) hours.push(h);
  const cell = { width: 30, minWidth: 30, height: 26, borderRadius: 4 };
  return (
    <div style={{ overflowX: "auto", paddingBottom: 4 }}>
      <div style={{ display: "inline-block", minWidth: "100%" }}>
        <div style={{ display: "flex", gap: 3, marginLeft: 38, marginBottom: 3 }}>
          {hours.map((h) => (
            <div
              key={h}
              style={{
                ...cell,
                height: "auto",
                textAlign: "center",
                fontSize: 9.5,
                color: "#8A9C90",
                fontWeight: 600,
              }}
            >
              {hourLabel(h)}
            </div>
          ))}
        </div>
        {DOW_ORDER.map((d) => (
          <div key={d} style={{ display: "flex", gap: 3, marginBottom: 3, alignItems: "center" }}>
            <div style={{ width: 35, minWidth: 35, fontSize: 11, color: "#465", fontWeight: 700 }}>
              {DOW[d]}
            </div>
            {hours.map((h) => {
              const v = data.grid[d][h];
              return (
                <div
                  key={h}
                  title={`${DOW[d]} ${hourLabel(h).replace("a", " AM").replace("p", " PM")} · ${formatINR(v)}`}
                  style={{
                    ...cell,
                    background: heatColor(v, data.max),
                    border: "1px solid #EDF2ED",
                    cursor: "default",
                  }}
                />
              );
            })}
          </div>
        ))}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginTop: 8,
            marginLeft: 38,
            fontSize: 10.5,
            color: "#8A9C90",
          }}
        >
          <span>Quieter</span>
          <div style={{ display: "flex", gap: 2 }}>
            {[0.05, 0.25, 0.5, 0.75, 1].map((t) => (
              <div
                key={t}
                style={{ width: 16, height: 10, borderRadius: 2, background: heatColor(t, 1) }}
              />
            ))}
          </div>
          <span>Busier — colour = revenue taken</span>
        </div>
      </div>
    </div>
  );
}

// Treemap tile: category rectangle labelled with its stock value. Recharts feeds
// x/y/width/height/index plus the datum fields (name, cost, retail, size).
function TreemapTile(props) {
  const { x, y, width, height, name, size, index } = props;
  if (!(width > 0) || !(height > 0)) return null;
  const fill = PIE_COLORS[(index ?? 0) % PIE_COLORS.length];
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        style={{ fill, stroke: "#fff", strokeWidth: 2 }}
      />
      {width > 54 && height > 22 && (
        <text x={x + 7} y={y + 16} fill="#fff" fontSize={11} fontWeight={700}>
          {name}
        </text>
      )}
      {width > 54 && height > 38 && (
        <text x={x + 7} y={y + 31} fill="rgba(255,255,255,.85)" fontSize={10}>
          {inrCompact(size)}
        </text>
      )}
    </g>
  );
}

// Turn a breakEvenEstimate() result into the big number + caption for its KPI card.
function breakEvenCard(be, est) {
  switch (est.status) {
    case "reached":
      return { value: "Recovered ✓", sub: `took ${est.days} day(s) · ${be.recovered}% of capital` };
    case "projected":
      return {
        value: "~" + est.daysLeft + " days",
        sub: `${be.recovered}% recovered · ${formatINR(est.perDay)}/day`,
      };
    case "stalled":
      return { value: "—", sub: "no profit trend yet" };
    case "no-capex":
      return { value: "—", sub: "no setup cost logged" };
    default:
      return { value: "—", sub: "need more sales data" };
  }
}

function Stats({ sales, expenses, items }) {
  const [preset, setPreset] = useState("allTime"); // default to the full history
  const [cfrom, setCfrom] = useState("");
  const [cto, setCto] = useState("");
  const [metric, setMetric] = useState("revenue"); // top-items sort: revenue | qty | profit
  const [includeMisc, setIncludeMisc] = useState(false); // keep Misc/SwadSutra/Sold rows in item charts?
  const [treeMetric, setTreeMetric] = useState("cost"); // treemap sizing: cost | retail
  // "All time" for the sales charts is pinned to when trading began (TRADING_START).
  const { from, to, label } = periodRange(preset, cfrom, cto, TRADING_START);
  // Expenses (capital / setup cost) started before trading, so their "All time"
  // reaches back to CAPEX_START; every other preset shares the sales window.
  const expFrom = preset === "allTime" ? CAPEX_START : from;

  // Period slice drives most charts; a few (inventory, break-even, Udhari-now) are
  // "as of now" snapshots and deliberately read the full data — noted on each card.
  const pSales = useMemo(
    () => sales.filter((s) => s.date >= from && s.date <= to),
    [sales, from, to]
  );
  const pExp = useMemo(
    () => expenses.filter((e) => e.date >= expFrom && e.date <= to),
    [expenses, expFrom, to]
  );
  const sum = useMemo(() => summarize(pSales), [pSales]);
  const expMonthly = useMemo(() => expenseByMonth(pExp, expFrom, to), [pExp, expFrom, to]);
  const expBreak = useMemo(() => expenseBreakdown(pExp, { limit: 10 }), [pExp]);
  const expSum = useMemo(() => expenseTotal(pExp), [pExp]);

  const daily = useMemo(() => dailyRevenueSeries(pSales, from, to), [pSales, from, to]);
  const monthly = useMemo(() => monthlyRevenueProfit(pSales, from, to), [pSales, from, to]);
  const heat = useMemo(() => salesHeatmap(pSales), [pSales]);
  const topProducts = useMemo(
    () => topItemsBy(pSales, { metric, limit: 15, includeConsolidated: includeMisc }),
    [pSales, metric, includeMisc]
  );
  const pay = useMemo(() => paymentBreakdown(pSales), [pSales]);
  const udhariSeries = useMemo(() => udhariOutstandingSeries(sales, from, to), [sales, from, to]);
  const udhariNow = useMemo(
    () =>
      money(
        sales
          .filter((s) => s.payment === "Udhari")
          .reduce((a, s) => a + Math.max(0, (s.total || 0) - (s.paid || 0)), 0)
      ),
    [sales]
  );
  const inv = useMemo(() => inventoryValue(items), [items]);
  const invCats = useMemo(() => inventoryByCategory(items), [items]);
  const dead = useMemo(() => deadStock(items, pSales), [items, pSales]);
  const catMix = useMemo(() => salesByCategory(pSales), [pSales]); // sales by (sub)category
  const sizeMix = useMemo(() => topSizes(pSales, { limit: 12 }), [pSales]); // best-selling sizes
  const be = useMemo(() => breakEvenSeries(sales, expenses), [sales, expenses]); // all-time
  const est = useMemo(() => breakEvenEstimate(be), [be]);
  const beCard = breakEvenCard(be, est);

  const treeData = useMemo(
    () =>
      invCats
        .map((c) => ({ ...c, size: treeMetric === "retail" ? c.retail : c.cost }))
        .filter((c) => c.size > 0),
    [invCats, treeMetric]
  );
  const metricLabel = { revenue: "Revenue", qty: "Quantity", profit: "Profit" };

  return (
    <div>
      <Header title="Reports" sub={label}>
        <select
          className="input"
          style={{ width: "auto" }}
          value={preset}
          onChange={(e) => setPreset(e.target.value)}
        >
          {STATS_PERIODS.map(([k, lbl]) => (
            <option key={k} value={k}>
              {lbl}
            </option>
          ))}
        </select>
      </Header>

      {preset === "custom" && (
        <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
          <label style={{ fontSize: 12, color: "#6B7E74" }}>
            From{" "}
            <input
              type="date"
              className="input"
              style={{ width: "auto", marginLeft: 4 }}
              value={cfrom}
              max={cto || todayStr()}
              onChange={(e) => setCfrom(e.target.value)}
            />
          </label>
          <label style={{ fontSize: 12, color: "#6B7E74" }}>
            To{" "}
            <input
              type="date"
              className="input"
              style={{ width: "auto", marginLeft: 4 }}
              value={cto}
              max={todayStr()}
              onChange={(e) => setCto(e.target.value)}
            />
          </label>
        </div>
      )}

      {/* ---- KPI row (first four follow the date range; last four are "as of now") ---- */}
      <div style={S.cards}>
        <Card label="Revenue" value={formatINR(sum.revenue)} sub={sum.bills + " bills"} />
        <Card
          label="Trading profit"
          value={formatINR(sum.profit)}
          sub={`${sum.margin}% margin`}
          accent
        />
        <Card label="Margin" value={sum.margin + "%"} sub="profit ÷ revenue" />
        <Card label="Avg ticket" value={formatINR(sum.avgTicket)} sub="per bill" />
        <Card label="Udhari outstanding" value={formatINR(udhariNow)} sub="unpaid credit · now" />
        <Card
          label="Inventory at cost"
          value={formatINR(inv.cost)}
          sub={`${inv.count} products · now`}
        />
        <Card label="Out of stock" value={inv.outOfStock} sub="products at zero · now" />
        <Card label="Break-even" value={beCard.value} sub={beCard.sub} />
      </div>

      {pSales.length === 0 ? (
        <section style={{ ...S.panel, marginTop: 16 }}>
          <Empty text="No sales in this period — pick a wider range to see the charts." />
        </section>
      ) : (
        <>
          <div style={sectionHead}>Sales by category &amp; size</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <ChartCard title="Sales by category (revenue)" height={260}>
              <BarChart
                data={catMix}
                layout="vertical"
                margin={{ top: 6, right: 12, left: 6, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
                <XAxis
                  type="number"
                  tick={{ fontSize: 11, fill: "#678" }}
                  tickFormatter={inrCompact}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={{ fontSize: 11, fill: "#678" }}
                  width={110}
                />
                <Tooltip
                  formatter={(v, n) => [
                    n === "qty" ? v : formatINR(v),
                    n === "qty" ? "Units" : "Revenue",
                  ]}
                />
                <Bar dataKey="revenue" name="Revenue" fill="#8E2C48" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ChartCard>
            <ChartCard title="Best-selling sizes (units sold)" height={260}>
              {sizeMix.length === 0 ? (
                <Empty text="No sized sales in this period yet." />
              ) : (
                <BarChart data={sizeMix} margin={{ top: 12, right: 10, left: -6, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
                  <XAxis dataKey="size" tick={{ fontSize: 11, fill: "#678" }} />
                  <YAxis tick={{ fontSize: 11, fill: "#678" }} width={36} allowDecimals={false} />
                  <Tooltip
                    formatter={(v, n) => [
                      n === "revenue" ? formatINR(v) : v,
                      n === "revenue" ? "Revenue" : "Units",
                    ]}
                  />
                  <Bar
                    dataKey="qty"
                    name="Units"
                    fill="#C9A24B"
                    radius={[3, 3, 0, 0]}
                    label={barLabel}
                  />
                </BarChart>
              )}
            </ChartCard>
          </div>
          {catMix.length > 0 && (
            <section style={{ ...S.panel, marginTop: 16 }}>
              <div style={S.panelHead}>Category breakdown</div>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th style={{ textAlign: "right" }}>Units</th>
                    <th style={{ textAlign: "right" }}>Revenue</th>
                    <th style={{ textAlign: "right" }}>Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {catMix.map((c) => (
                    <tr key={c.name}>
                      <td style={{ fontWeight: 600 }}>{c.name}</td>
                      <td style={{ textAlign: "right" }}>{c.qty}</td>
                      <td style={{ textAlign: "right" }}>{formatINR(c.revenue)}</td>
                      <td style={{ textAlign: "right", color: "#2E7D5B" }}>
                        {formatINR(c.profit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <div style={sectionHead}>Revenue over time</div>
          <ChartCard title="Daily revenue & 7-day average" height={260}>
            <LineChart data={daily} margin={{ top: 12, right: 10, left: -6, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10.5, fill: "#678" }}
                interval="preserveStartEnd"
                minTickGap={26}
              />
              <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrCompact} width={48} />
              <Tooltip formatter={(v, n) => [formatINR(v), n]} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line
                type="monotone"
                dataKey="revenue"
                name="Daily revenue"
                stroke="#9BC0AC"
                strokeWidth={1.5}
                dot={false}
                label={exactLabel}
              />
              <Line
                type="monotone"
                dataKey="ma7"
                name="7-day average"
                stroke="#1B5E43"
                strokeWidth={2.5}
                dot={false}
              />
            </LineChart>
          </ChartCard>

          <div style={{ marginTop: 16 }}>
            <ChartCard title="Monthly revenue & profit" height={250}>
              <ComposedChart data={monthly} margin={{ top: 16, right: 10, left: -6, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} />
                <YAxis
                  tick={{ fontSize: 11, fill: "#678" }}
                  tickFormatter={inrCompact}
                  width={48}
                />
                <Tooltip formatter={(v, n) => [formatINR(v), n]} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar
                  dataKey="revenue"
                  name="Revenue"
                  fill="#1B5E43"
                  radius={[3, 3, 0, 0]}
                  maxBarSize={54}
                  label={exactLabel}
                />
                <Line
                  type="monotone"
                  dataKey="profit"
                  name="Profit"
                  stroke="#E8A33D"
                  strokeWidth={2.5}
                  dot={{ r: 2.5, fill: "#E8A33D" }}
                  label={exactLabelGold}
                />
              </ComposedChart>
            </ChartCard>
          </div>

          <div style={sectionHead}>When customers shop</div>
          <section style={S.panel}>
            <div style={S.panelHead}>Sales heatmap — weekday × time of day</div>
            <Heatmap data={heat} />
          </section>

          <div style={sectionHead}>Products & payment</div>
          <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 16 }}>
            <section style={S.panel}>
              <div style={{ ...S.panelHead, flexWrap: "wrap", gap: 6 }}>
                Top 15 items
                <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  {["revenue", "qty", "profit"].map((m) => (
                    <button
                      key={m}
                      className={"btn small " + (metric === m ? "primary" : "ghost")}
                      onClick={() => setMetric(m)}
                    >
                      {metricLabel[m]}
                    </button>
                  ))}
                </div>
              </div>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 11.5,
                  color: "#6B7E74",
                  marginBottom: 8,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={includeMisc}
                  onChange={(e) => setIncludeMisc(e.target.checked)}
                />
                Include Misc / consolidated rows (they distort real top-sellers)
              </label>
              {topProducts.length === 0 ? (
                <Empty text="No individual items sold in this period." />
              ) : (
                <div style={{ width: "100%", height: Math.max(220, topProducts.length * 26 + 24) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={topProducts}
                      layout="vertical"
                      margin={{ top: 4, right: 54, left: 8, bottom: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" horizontal={false} />
                      <XAxis
                        type="number"
                        tick={{ fontSize: 10.5, fill: "#678" }}
                        tickFormatter={metric === "qty" ? undefined : inrCompact}
                      />
                      <YAxis
                        type="category"
                        dataKey="name"
                        tick={{ fontSize: 10, fill: "#465" }}
                        width={116}
                        interval={0}
                      />
                      <Tooltip formatter={(v) => (metric === "qty" ? v : formatINR(v))} />
                      <Bar
                        dataKey={metric}
                        name={metricLabel[metric]}
                        fill="#3DA17A"
                        radius={[0, 3, 3, 0]}
                        label={metric === "qty" ? qtyLabelRight : compactLabelRight}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </section>

            <section style={S.panel}>
              <div style={S.panelHead}>How customers pay</div>
              {pay.rows.length === 0 ? (
                <Empty text="No sales to split." />
              ) : (
                <>
                  <div style={{ position: "relative", width: "100%", height: 190 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={pay.rows}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          innerRadius={52}
                          outerRadius={80}
                          paddingAngle={2}
                          stroke="none"
                        >
                          {pay.rows.map((r) => (
                            <Cell key={r.name} fill={PAY_COLORS[r.name] || "#8A9C90"} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(v, n) => [formatINR(v), n]} />
                      </PieChart>
                    </ResponsiveContainer>
                    {/* Center total — a positioned overlay renders reliably across Recharts versions. */}
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        display: "grid",
                        placeItems: "center",
                        pointerEvents: "none",
                      }}
                    >
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 11, color: "#8A9C90" }}>Total</div>
                        <div style={{ fontSize: 15, fontWeight: 800, color: "#10331F" }}>
                          {inrCompact(pay.total)}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div>
                    {pay.rows.map((r) => (
                      <div key={r.name} style={S.row}>
                        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span
                            style={{
                              width: 10,
                              height: 10,
                              borderRadius: 3,
                              background: PAY_COLORS[r.name] || "#8A9C90",
                            }}
                          />
                          {r.name}
                        </span>
                        <b>
                          {formatINR(r.value)}{" "}
                          <span style={{ color: "#8A9C90", fontWeight: 500 }}>· {r.pct}%</span>
                        </b>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
          </div>

          <div style={sectionHead}>Credit & recovery</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <ChartCard title="Udhari outstanding over time">
              <AreaChart data={udhariSeries} margin={{ top: 8, right: 10, left: -6, bottom: 0 }}>
                <defs>
                  <linearGradient id="gUdhari" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#E8A33D" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#E8A33D" stopOpacity={0.04} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10.5, fill: "#678" }}
                  interval="preserveStartEnd"
                  minTickGap={26}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "#678" }}
                  tickFormatter={inrCompact}
                  width={48}
                />
                <Tooltip formatter={(v) => [formatINR(v), "Outstanding"]} />
                <Area
                  type="monotone"
                  dataKey="outstanding"
                  name="Outstanding"
                  stroke="#B0762A"
                  strokeWidth={2}
                  fill="url(#gUdhari)"
                />
              </AreaChart>
            </ChartCard>

            <ChartCard title="Break-even — profit vs capital (all-time)">
              {be.series.length === 0 ? (
                <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
                  <Empty text="No sales yet to track break-even." />
                </div>
              ) : (
                <ComposedChart
                  data={be.series}
                  margin={{ top: 16, right: 12, left: -6, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="gBreak" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#1B5E43" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#1B5E43" stopOpacity={0.03} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10.5, fill: "#678" }}
                    interval="preserveStartEnd"
                    minTickGap={26}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "#678" }}
                    tickFormatter={inrCompact}
                    width={48}
                  />
                  <Tooltip formatter={(v) => [formatINR(v), "Cumulative profit"]} />
                  <Area
                    type="monotone"
                    dataKey="cumProfit"
                    name="Cumulative profit"
                    stroke="#1B5E43"
                    strokeWidth={2}
                    fill="url(#gBreak)"
                  />
                  {be.capex > 0 && (
                    <ReferenceLine
                      y={be.capex}
                      stroke="#C44536"
                      strokeDasharray="5 4"
                      label={{
                        value: `Capital ${inrCompact(be.capex)}`,
                        position: "insideTopRight",
                        fontSize: 10,
                        fill: "#C44536",
                      }}
                    />
                  )}
                </ComposedChart>
              )}
            </ChartCard>
          </div>
          <div style={{ fontSize: 12, color: "#6B7E74", marginTop: 8 }}>
            <b>Capital / Setup Cost</b> (one-time): {formatINR(be.capex)} — this is investment,
            never subtracted from trading profit.
            {est.status === "reached" && <> You’ve recovered it (took {est.days} day(s)).</>}
            {est.status === "projected" && (
              <>
                {" "}
                At about {formatINR(est.perDay)}/day of profit, roughly {est.daysLeft} day(s) to go.
              </>
            )}
          </div>

          <div style={sectionHead}>
            Capital / setup spending
            {preset === "allTime" && (
              <span style={{ fontWeight: 500, color: "#8A9C90" }}>
                {" "}
                · since{" "}
                {new Date(CAPEX_START + "T00:00").toLocaleDateString("en-IN", {
                  month: "short",
                  year: "numeric",
                })}
              </span>
            )}
          </div>
          {pExp.length === 0 ? (
            <section style={S.panel}>
              <Empty text="No capital / setup spending recorded in this period." />
            </section>
          ) : (
            <>
              <div style={{ fontSize: 12.5, color: "#3A5547", marginBottom: 8 }}>
                One-time setup / capital of <b>{formatINR(expSum)}</b> across {pExp.length}{" "}
                {pExp.length === 1 ? "entry" : "entries"} — investment, not an operating cost, so it
                never reduces trading profit.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 16 }}>
                <ChartCard title="Capital deployed by month">
                  <BarChart data={expMonthly} margin={{ top: 16, right: 10, left: -6, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} />
                    <YAxis
                      tick={{ fontSize: 11, fill: "#678" }}
                      tickFormatter={inrCompact}
                      width={48}
                    />
                    <Tooltip formatter={(v) => [formatINR(v), "Spent"]} />
                    <Bar
                      dataKey="amount"
                      name="Spent"
                      fill="#C44536"
                      radius={[3, 3, 0, 0]}
                      maxBarSize={56}
                      label={compactLabel}
                    />
                  </BarChart>
                </ChartCard>
                <section style={S.panel}>
                  <div style={S.panelHead}>Where it went</div>
                  <div
                    style={{ width: "100%", height: Math.max(200, expBreak.rows.length * 26 + 24) }}
                  >
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={expBreak.rows}
                        layout="vertical"
                        margin={{ top: 4, right: 54, left: 8, bottom: 0 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" horizontal={false} />
                        <XAxis
                          type="number"
                          tick={{ fontSize: 10.5, fill: "#678" }}
                          tickFormatter={inrCompact}
                        />
                        <YAxis
                          type="category"
                          dataKey="name"
                          tick={{ fontSize: 10, fill: "#465" }}
                          width={112}
                          interval={0}
                        />
                        <Tooltip formatter={(v) => formatINR(v)} />
                        <Bar
                          dataKey="value"
                          name="Spent"
                          fill="#B0762A"
                          radius={[0, 3, 3, 0]}
                          label={compactLabelRight}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </section>
              </div>
            </>
          )}

          <div style={sectionHead}>Inventory</div>
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}>
            <section style={S.panel}>
              <div style={{ ...S.panelHead, flexWrap: "wrap", gap: 6 }}>
                Stock value by category
                <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <button
                    className={"btn small " + (treeMetric === "cost" ? "primary" : "ghost")}
                    onClick={() => setTreeMetric("cost")}
                  >
                    At cost {inrCompact(inv.cost)}
                  </button>
                  <button
                    className={"btn small " + (treeMetric === "retail" ? "primary" : "ghost")}
                    onClick={() => setTreeMetric("retail")}
                  >
                    At retail {inrCompact(inv.retail)}
                  </button>
                </div>
              </div>
              {treeData.length === 0 ? (
                <Empty text="No stock on hand to value." />
              ) : (
                <div style={{ width: "100%", height: 280 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <Treemap
                      data={treeData}
                      dataKey="size"
                      nameKey="name"
                      stroke="#fff"
                      isAnimationActive={false}
                      content={<TreemapTile />}
                    />
                  </ResponsiveContainer>
                </div>
              )}
            </section>
            <section style={S.panel}>
              <div style={S.panelHead}>
                Slow movers — in stock, no sales this period{" "}
                <span
                  style={{
                    fontWeight: 500,
                    textTransform: "none",
                    letterSpacing: 0,
                    color: "#8A9C90",
                    marginLeft: 8,
                  }}
                >
                  {dead.length}
                </span>
              </div>
              {dead.length === 0 ? (
                <Empty text="Everything in stock sold at least once. 👍" />
              ) : (
                <>
                  {dead.slice(0, 10).map((i) => (
                    <div key={i.name} style={S.row}>
                      <span>
                        {i.name}{" "}
                        <span style={{ color: "#9AA", fontSize: 11 }}>
                          · {i.stock} pcs{i.subcategory ? " · " + i.subcategory : ""}
                        </span>
                      </span>
                      <b>{formatINR(i.value)}</b>
                    </div>
                  ))}
                  {dead.length > 10 && (
                    <div style={{ fontSize: 11.5, color: "#8A9C90", marginTop: 6 }}>
                      + {dead.length - 10} more…
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- Udhari / Credit (outstanding by customer) ----------
// Standalone top-level view. Outstanding is tracked across ALL time — a debt isn't
// period-bound — so this reads the full sales list rather than a date-filtered slice.
const billOut = (s) => Math.max(0, money((s.total || 0) - (s.paid || 0)));
// Minutes since midnight from a stored time like "02:15 pm" / "10:05 am (back-dated)"; -1 if unknown.
const timeToMin = (t) => {
  const m = String(t || "").match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!m) return -1;
  let h = +m[1];
  const ap = (m[3] || "").toLowerCase();
  if (ap) {
    h = h % 12;
    if (ap === "pm") h += 12;
  }
  return h * 60 + +m[2];
};
// Newest-first comparator for {date,time} records: date descending, then time descending.
const byDateTimeDesc = (a, b) =>
  a.date !== b.date ? (a.date < b.date ? 1 : -1) : timeToMin(b.time) - timeToMin(a.time);

function Udhari({ sales, setSales, notify, log }) {
  const [openCust, setOpenCust] = useState(() => new Set()); // expanded customer names
  const [openBills, setOpenBills] = useState(() => new Set()); // expanded bills (showing order details)
  const [paying, setPaying] = useState(null); // the sale (bill) a repayment is being recorded against
  const [payAmt, setPayAmt] = useState("");
  const [payMode, setPayMode] = useState("Cash");

  const udhari = useMemo(() => {
    const u = sales.filter((s) => s.payment === "Udhari");
    const byCust = {};
    u.forEach((s) => {
      const out = billOut(s);
      const name = (s.customer || "").trim() || "(no name)";
      const c =
        byCust[name] ||
        (byCust[name] = { name, mobile: "", outstanding: 0, total: 0, bills: 0, billList: [] });
      c.outstanding += out;
      c.total += s.total || 0;
      c.bills += 1;
      c.billList.push(s);
      if (s.mobile) c.mobile = s.mobile;
    });
    const customers = Object.values(byCust)
      .map((c) => ({
        ...c,
        outstanding: money(c.outstanding),
        total: money(c.total),
        // Newest bills first (date then time descending).
        billList: [...c.billList].sort(byDateTimeDesc),
      }))
      .sort((a, b) => b.outstanding - a.outstanding);
    return {
      customers,
      count: u.length,
      totalOutstanding: money(u.reduce((a, s) => a + billOut(s), 0)),
      withDue: customers.filter((c) => c.outstanding > 0),
    };
  }, [sales]);

  // A chronological ledger of every udhari event: credit given (bill date) and each repayment
  // (from the payments ledger; legacy/uncaptured paid amounts reconcile to the bill date).
  const history = useMemo(() => {
    const events = [];
    sales
      .filter((s) => s.payment === "Udhari")
      .forEach((s) => {
        const who = (s.customer || "").trim() || "(no name)";
        events.push({
          id: s.id + "-c",
          date: s.date,
          time: s.time || "",
          kind: "credit",
          who,
          amount: money(s.total || 0),
        });
        const ledger = Array.isArray(s.payments) ? s.payments : [];
        let ledgerSum = 0;
        ledger.forEach((p, i) => {
          const amt = money(p.amount || 0);
          ledgerSum += amt;
          events.push({
            id: `${s.id}-p${p.id || i}`,
            date: p.date || s.date,
            time: p.time || "",
            kind: "paid",
            who,
            amount: amt,
            mode: p.mode || "—",
          });
        });
        const rem = money((s.paid || 0) - ledgerSum);
        if (rem > 0.005)
          events.push({
            id: s.id + "-p0",
            date: s.date,
            time: s.time || "",
            kind: "paid",
            who,
            amount: rem,
            mode: s.paidMode || "—",
            atStart: true,
          });
      });
    // Strictly newest-first: date descending, then time descending. On an exact tie the
    // repayment (the later action) sorts above the credit.
    events.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      const tm = timeToMin(b.time) - timeToMin(a.time);
      if (tm) return tm;
      return a.kind === b.kind ? 0 : a.kind === "paid" ? -1 : 1;
    });
    const totalCredit = money(
      events.filter((e) => e.kind === "credit").reduce((a, e) => a + e.amount, 0)
    );
    const totalPaid = money(
      events.filter((e) => e.kind === "paid").reduce((a, e) => a + e.amount, 0)
    );
    return { events, totalCredit, totalPaid };
  }, [sales]);

  const toggle = (name) =>
    setOpenCust((s) => {
      const n = new Set(s);
      n.has(name) ? n.delete(name) : n.add(name);
      return n;
    });
  const toggleBill = (id) =>
    setOpenBills((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const openPay = (sale) => {
    setPaying(sale);
    setPayAmt(String(billOut(sale)));
    setPayMode(sale.paidMode || "Cash");
  };

  // Current outstanding/figures for the bill being paid are read live from `sales`, so the
  // modal stays correct even if the underlying record changed (e.g. edited elsewhere).
  const payingLive = paying ? sales.find((s) => s.id === paying.id) : null;
  const payOut = payingLive ? billOut(payingLive) : 0;
  const payAmtNum = Math.min(payOut, Math.max(0, money(+payAmt || 0)));
  const payRemaining = money(payOut - payAmtNum);

  const savePayment = () => {
    if (!payingLive) return setPaying(null);
    if (payAmtNum <= 0) return notify("Enter an amount greater than ₹0");
    const newPaid = money((payingLive.paid || 0) + payAmtNum);
    const rem = money((payingLive.total || 0) - newPaid);
    // Single setSales → Sales History, dashboard and cloud sync all pick up the new paid/outstanding.
    // Also append a dated entry to the payments ledger so the History panel can show when it was paid.
    const nowTime = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
    setSales((all) =>
      all.map((x) => {
        if (x.id !== payingLive.id) return x;
        const payments = [
          ...(x.payments || []),
          { id: uid(), date: todayStr(), time: nowTime, amount: payAmtNum, mode: payMode },
        ];
        return { ...x, paid: newPaid, paidMode: payMode, payments };
      })
    );
    const who = (payingLive.customer || "").trim() || "(no name)";
    log(
      "sale",
      `Udhari repayment ${INR(payAmtNum)} (${payMode}) from ${who}${rem > 0 ? ` — ${INR(rem)} still due` : " — bill cleared"}`
    );
    notify(
      `Recorded ${INR(payAmtNum)} (${payMode})${rem > 0 ? ` · ${INR(rem)} still due` : " · bill cleared 🎉"}`
    );
    setPaying(null);
  };

  return (
    <div>
      <Header title="Udhari / Credit" sub="Outstanding credit by customer, across all time." />
      <div style={S.cards}>
        <Card
          label="Outstanding credit"
          value={INR(udhari.totalOutstanding)}
          sub={udhari.withDue.length + " customer(s) owe"}
          accent
        />
        <Card label="Udhari bills" value={udhari.count} sub="total credit bills" />
        <Card
          label="Top debtor"
          value={udhari.withDue[0] ? udhari.withDue[0].name : "—"}
          sub={udhari.withDue[0] ? INR(udhari.withDue[0].outstanding) : "—"}
        />
      </div>
      <section style={{ ...S.panel, marginBottom: 4 }}>
        <div style={S.panelHead}>
          Who owes you{" "}
          <span
            style={{
              fontWeight: 500,
              textTransform: "none",
              letterSpacing: 0,
              color: "#8A9C90",
              marginLeft: 8,
            }}
          >
            {udhari.withDue.length}
          </span>
        </div>
        {udhari.withDue.length === 0 ? (
          <Empty text="No outstanding credit — all udhari settled. 🎉" />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 18 }}></th>
                <th>Customer</th>
                <th>Mobile</th>
                <th style={{ textAlign: "right" }}>Bills</th>
                <th style={{ textAlign: "right" }}>Outstanding</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {udhari.withDue.map((c) => {
                const isOpen = openCust.has(c.name);
                const dueBills = c.billList.filter((b) => billOut(b) > 0);
                // Record from the customer row: one bill → pay it straight away; several → expand to choose.
                const recordRow = () =>
                  dueBills.length === 1 ? openPay(dueBills[0]) : toggle(c.name);
                return (
                  <Fragment key={c.name}>
                    <tr onClick={() => toggle(c.name)} style={{ cursor: "pointer" }}>
                      <td style={{ color: "#8A9C90" }}>{isOpen ? "▾" : "▸"}</td>
                      <td style={{ fontWeight: 600 }}>{c.name}</td>
                      <td style={{ color: "#677" }}>{c.mobile || "—"}</td>
                      <td style={{ textAlign: "right" }}>{c.bills}</td>
                      <td style={{ textAlign: "right", fontWeight: 700, color: "#C44536" }}>
                        {INR(c.outstanding)}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          className="btn small primary"
                          onClick={(e) => {
                            e.stopPropagation();
                            recordRow();
                          }}
                        >
                          {dueBills.length === 1 ? "Pay" : "Pay ▸"}
                        </button>
                      </td>
                    </tr>
                    {isOpen &&
                      dueBills.map((b) => {
                        const billOpen = openBills.has(b.id);
                        const nLines = (b.lines || []).length;
                        return (
                          <Fragment key={b.id}>
                            <tr
                              onClick={() => toggleBill(b.id)}
                              style={{ background: "#FAFBF8", cursor: "pointer" }}
                            >
                              <td></td>
                              <td colSpan={3} style={{ fontSize: 12.5, color: "#566" }}>
                                <span style={{ color: "#8A9C90", marginRight: 4 }}>
                                  {billOpen ? "▾" : "▸"}
                                </span>
                                {b.date}
                                {b.time ? " · " + b.time : ""} · {nLines} item
                                {nLines === 1 ? "" : "s"} · bill {INR(b.total)}
                                {(b.paid || 0) > 0
                                  ? ` · paid ${INR(b.paid)}${b.paidMode ? " (" + b.paidMode + ")" : ""}`
                                  : ""}
                              </td>
                              <td style={{ textAlign: "right", fontWeight: 700, color: "#C44536" }}>
                                {INR(billOut(b))}
                              </td>
                              <td style={{ textAlign: "right" }}>
                                <button
                                  className="btn small"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openPay(b);
                                  }}
                                >
                                  Pay
                                </button>
                              </td>
                            </tr>
                            {billOpen && (
                              <tr style={{ background: "#FAFBF8" }}>
                                <td></td>
                                <td colSpan={5} style={{ paddingTop: 0 }}>
                                  <div
                                    style={{
                                      background: "#fff",
                                      border: "1px solid #EEF3EE",
                                      borderRadius: 8,
                                      padding: "8px 12px",
                                    }}
                                  >
                                    {nLines === 0 ? (
                                      <div style={{ fontSize: 12.5, color: "#8A9C90" }}>
                                        No line items on this bill.
                                      </div>
                                    ) : (
                                      b.lines.map((l, i) => (
                                        <div
                                          key={i}
                                          style={{
                                            display: "flex",
                                            justifyContent: "space-between",
                                            fontSize: 12.5,
                                            padding: "3px 0",
                                          }}
                                        >
                                          <span>
                                            {l.name} × {l.qty}
                                          </span>
                                          <span>{INR(l.amount)}</span>
                                        </div>
                                      ))
                                    )}
                                    <div
                                      style={{
                                        display: "flex",
                                        justifyContent: "space-between",
                                        fontSize: 12.5,
                                        fontWeight: 700,
                                        borderTop: "1px dashed #DDE8DE",
                                        marginTop: 4,
                                        paddingTop: 4,
                                      }}
                                    >
                                      <span>Total</span>
                                      <span>{INR(b.total)}</span>
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        <div style={{ fontSize: 11.5, color: "#8A9C90", marginTop: 8 }}>
          Tap a customer to see their bills, then Pay a full or part repayment (Cash / UPI). Sales
          History updates automatically.
        </div>
      </section>

      <section style={{ ...S.panel, marginTop: 16 }}>
        <div style={S.panelHead}>
          History
          <span
            style={{
              fontWeight: 500,
              textTransform: "none",
              letterSpacing: 0,
              color: "#8A9C90",
              marginLeft: 8,
            }}
          >
            {history.events.length} event{history.events.length === 1 ? "" : "s"}
          </span>
          <span
            style={{
              marginLeft: "auto",
              fontWeight: 500,
              fontSize: 12,
              color: "#8A9C90",
              textTransform: "none",
              letterSpacing: 0,
            }}
          >
            Credit given <b style={{ color: "#C44536" }}>{INR(history.totalCredit)}</b> · Repaid{" "}
            <b style={{ color: "#1B5E43" }}>{INR(history.totalPaid)}</b>
          </span>
        </div>
        {history.events.length === 0 ? (
          <Empty text="No udhari/credit activity yet." />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Date &amp; time</th>
                <th>Customer</th>
                <th>Type</th>
                <th style={{ textAlign: "right" }}>Amount</th>
                <th>Mode</th>
              </tr>
            </thead>
            <tbody>
              {history.events.slice(0, 150).map((e) => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: "nowrap", color: "#677" }}>
                    {e.date}
                    {e.time ? <span style={{ color: "#9AA" }}> {e.time}</span> : null}
                  </td>
                  <td style={{ fontWeight: 600 }}>{e.who}</td>
                  <td>
                    {e.kind === "credit" ? (
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 800,
                          color: "#C44536",
                          border: "1px solid #C44536",
                          borderRadius: 6,
                          padding: "1px 6px",
                        }}
                      >
                        CREDIT
                      </span>
                    ) : (
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 800,
                          color: "#1B5E43",
                          border: "1px solid #1B5E43",
                          borderRadius: 6,
                          padding: "1px 6px",
                        }}
                      >
                        PAID
                      </span>
                    )}
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontWeight: 700,
                      color: e.kind === "credit" ? "#C44536" : "#1B5E43",
                    }}
                  >
                    {e.kind === "credit" ? INR(e.amount) : "− " + INR(e.amount)}
                  </td>
                  <td style={{ color: "#677", fontSize: 12 }}>
                    {e.kind === "paid" ? (e.mode || "—") + (e.atStart ? " · at billing" : "") : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {history.events.length > 150 && (
          <div style={{ fontSize: 11.5, color: "#8A9C90", marginTop: 8 }}>
            Showing the most recent 150 of {history.events.length} events.
          </div>
        )}
      </section>

      {paying && payingLive && (
        // Close only when the press STARTS on the backdrop itself. Using onClick here would
        // also fire when a drag/tap that began inside the input releases over the backdrop,
        // closing the modal mid-payment.
        <div
          style={S.overlay}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPaying(null);
          }}
        >
          <div style={S.modal}>
            <h2 style={{ fontSize: 17, margin: "0 0 4px" }}>Pay</h2>
            <div style={{ fontSize: 13, color: "#566", marginBottom: 14 }}>
              <b>{(payingLive.customer || "").trim() || "(no name)"}</b> · {payingLive.date} · bill{" "}
              {INR(payingLive.total)}
              {(payingLive.paid || 0) > 0 ? ` · already paid ${INR(payingLive.paid)}` : ""} ·{" "}
              <span style={{ color: "#C44536", fontWeight: 600 }}>outstanding {INR(payOut)}</span>
            </div>
            <Field label="Amount received">
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  className="input"
                  style={{ flex: 1 }}
                  type="number"
                  min="0"
                  step="0.01"
                  max={payOut}
                  value={payAmt}
                  onChange={(e) => setPayAmt(e.target.value)}
                  autoFocus
                  aria-label="Amount received"
                />
                <button className="btn small ghost" onClick={() => setPayAmt(String(payOut))}>
                  Full
                </button>
              </div>
            </Field>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 12 }}>
              <span style={{ fontSize: 12, color: "#6B7E74", fontWeight: 600 }}>Paid via</span>
              {["Cash", "UPI"].map((m) => (
                <button
                  key={m}
                  className={"btn small " + (payMode === m ? "primary" : "ghost")}
                  onClick={() => setPayMode(m)}
                >
                  {m}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 13, textAlign: "right", marginBottom: 14, fontWeight: 600 }}>
              Paying {INR(payAmtNum)} ({payMode})
              {payRemaining > 0 ? (
                <span style={{ color: "#C44536" }}> · remaining {INR(payRemaining)}</span>
              ) : (
                <span style={{ color: "#1B5E43" }}> · clears this bill 🎉</span>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setPaying(null)}>
                Cancel
              </button>
              <button className="btn primary" onClick={savePayment} disabled={payAmtNum <= 0}>
                Pay
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Vendor Bills (purchase bills with proof, isolated from other data) ----------
const BILL_CATEGORIES = [
  "Stock purchase",
  "Rent",
  "Utilities",
  "Salary",
  "Transport",
  "Maintenance",
  "Packaging",
  "Taxes/Fees",
  "Other",
];
const BILL_STATUS = ["unpaid", "partial", "paid"];
const STATUS_COLORS = { paid: "#1B5E43", partial: "#B0762A", unpaid: "#C44536" };
const isImageType = (t, name) =>
  /^image\//i.test(t || "") || /\.(jpe?g|png|webp|gif|bmp|heic)$/i.test(name || "");
const outstandingOf = (b) =>
  b.status === "paid"
    ? 0
    : b.status === "partial"
      ? Math.max(0, (+b.amount || 0) - (+b.paidAmount || 0))
      : +b.amount || 0;

function VendorBills({ bills, setBills, setDailyBills, goDailyBills, online, notify, log }) {
  const blank = {
    vendor: "",
    date: todayStr(),
    amount: "",
    category: BILL_CATEGORIES[0],
    status: "unpaid",
    paidAmount: "",
    dueDate: "",
  };
  const [form, setForm] = useState(blank);
  const [editId, setEditId] = useState(null);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef(null);
  // filters
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [vq, setVq] = useState("");
  const [statusF, setStatusF] = useState("all");
  const [catF, setCatF] = useState("All");

  const resetForm = () => {
    setForm(blank);
    setEditId(null);
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const onFile = (e) => {
    const f = e.target.files?.[0] || null;
    if (f && f.size > MAX_PROOF_BYTES) {
      notify("Proof file is too large (max 10 MB).");
      e.target.value = "";
      return;
    }
    setFile(f);
  };

  const save = async () => {
    if (busy) return;
    if (!form.vendor.trim()) return notify("Vendor name is required.");
    if (!(+form.amount > 0)) return notify("Enter a bill amount greater than 0.");
    setBusy(true);
    setErr("");
    try {
      const id = editId || uid();
      let proof = null;
      if (file) proof = await uploadBillProof(id, file); // throws → caught below
      const base = {
        vendor: form.vendor.trim(),
        date: form.date || todayStr(),
        amount: money(+form.amount),
        category: form.category,
        status: form.status,
        paidAmount:
          form.status === "partial"
            ? money(+form.paidAmount || 0)
            : form.status === "paid"
              ? money(+form.amount)
              : 0,
        dueDate: form.status === "paid" ? "" : form.dueDate || "",
      };
      if (editId) {
        setBills((list) =>
          list.map((b) =>
            b.id === editId ? { ...b, ...base, ...(proof || {}), updatedAt: todayStr() } : b
          )
        );
        log("bill", `Edited vendor bill — ${base.vendor} · ${INR(base.amount)}`);
        notify("Bill updated");
      } else {
        setBills((list) => [...list, { id, ...base, ...(proof || {}), createdAt: todayStr() }]);
        log(
          "bill",
          `Added vendor bill — ${base.vendor} · ${INR(base.amount)}` +
            (proof ? " (with proof)" : "")
        );
        notify("Bill saved");
      }
      resetForm();
    } catch (e) {
      console.error("bill save failed", e);
      const code = e?.code || e?.message || "unknown";
      setErr(
        `Upload failed (${code}). The bill was NOT saved. ` +
          (code.includes("unauthorized") || code.includes("unauthenticated")
            ? "Firebase Storage rules are blocking it — publish the rule from the Storage → Rules page."
            : code.includes("object-not-found") ||
                code.includes("bucket") ||
                code.includes("unknown")
              ? "Firebase Storage isn't set up for this project — open Storage in the console and click ‘Get started’ to create the bucket."
              : code.includes("retry-limit") || code.includes("network")
                ? "Network/CORS problem — check the connection and retry."
                : "Open the browser console for details.")
      );
      notify("⚠ Proof upload failed — see the message in the form.");
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (b) => {
    // Daily-need bills are authored in their own section (single source of truth); redirect the
    // edit there so the two views can't drift.
    if (b.source === "daily-need") {
      notify("This bill syncs from Supplier Bills — edit it there.");
      goDailyBills?.();
      return;
    }
    setEditId(b.id);
    setForm({
      vendor: b.vendor || "",
      date: b.date || todayStr(),
      amount: String(b.amount ?? ""),
      category: b.category || BILL_CATEGORIES[0],
      status: b.status || "unpaid",
      paidAmount: String(b.paidAmount ?? ""),
      dueDate: b.dueDate || "",
    });
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const del = async (b) => {
    const synced = b.source === "daily-need";
    const msg = synced
      ? `Delete “${b.vendor}” (${INR(b.amount)})? This also removes it from Supplier Bills.`
      : `Delete bill from “${b.vendor}” (${INR(b.amount)})? Its proof file will also be removed.`;
    if (!confirm(msg)) return;
    await deleteBillProof(b.filePath);
    setBills((list) => list.filter((x) => x.id !== b.id));
    // Delete-from-either-side: drop the matching daily record too (linked by shared id).
    if (synced) setDailyBills?.((list) => list.filter((x) => x.id !== b.id));
    if (editId === b.id) resetForm();
    log(
      "bill",
      `Deleted ${synced ? "daily-need" : "vendor"} bill — ${b.vendor} · ${INR(b.amount)}`
    );
    notify("Bill deleted");
  };

  const filtered = useMemo(
    () =>
      bills.filter(
        (b) =>
          (!from || b.date >= from) &&
          (!to || b.date <= to) &&
          (!vq.trim() || (b.vendor || "").toLowerCase().includes(vq.trim().toLowerCase())) &&
          (statusF === "all" || (b.status || "unpaid") === statusF) &&
          (catF === "All" || b.category === catF)
      ),
    [bills, from, to, vq, statusF, catF]
  );
  const sorted = useMemo(
    () => [...filtered].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    [filtered]
  );

  const totalSpend = money(filtered.reduce((a, b) => a + (+b.amount || 0), 0));
  const outstanding = money(filtered.reduce((a, b) => a + outstandingOf(b), 0));

  const monthly = useMemo(() => {
    const m = {};
    filtered.forEach((b) => {
      const k = (b.date || "").slice(0, 7);
      if (k) m[k] = (m[k] || 0) + (+b.amount || 0);
    });
    return Object.entries(m)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => ({
        label: new Date(k + "-01T00:00").toLocaleDateString("en-IN", {
          month: "short",
          year: "2-digit",
        }),
        amount: money(v),
      }));
  }, [filtered]);
  const topVendors = useMemo(() => {
    const m = {};
    filtered.forEach((b) => {
      const v = b.vendor || "—";
      m[v] = (m[v] || 0) + (+b.amount || 0);
    });
    return Object.entries(m)
      .map(([name, value]) => ({ name, value: money(value) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }, [filtered]);
  const byCategory = useMemo(() => {
    const m = {};
    filtered.forEach((b) => {
      const c = b.category || "Other";
      m[c] = (m[c] || 0) + (+b.amount || 0);
    });
    return Object.entries(m)
      .map(([name, value]) => ({ name, value: money(value) }))
      .sort((a, b) => b.value - a.value);
  }, [filtered]);
  const topVendorName = topVendors[0]?.name;

  const setMonth = (mv) => {
    if (!mv) {
      setFrom("");
      setTo("");
      return;
    }
    setFrom(mv + "-01");
    const d = new Date(+mv.slice(0, 4), +mv.slice(5, 7), 0);
    setTo(dateStr(d));
  };
  const fmtDate = (d) =>
    d
      ? new Date(d + "T00:00").toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : "—";

  return (
    <div>
      <Header
        title="Vendor Bills"
        sub="Record purchase bills with proof — separate from sales, inventory & finance"
      >
        {!online && (
          <span style={{ fontSize: 11.5, color: "#C9803A" }}>
            Offline — proof upload needs internet
          </span>
        )}
      </Header>

      <div
        style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: 16, alignItems: "start" }}
      >
        {/* add / edit form */}
        <section style={S.panel}>
          <div style={S.panelHead}>{editId ? "Edit bill" : "New bill"}</div>
          <Field label="Vendor name">
            <input
              className="input"
              value={form.vendor}
              onChange={(e) => setForm({ ...form, vendor: e.target.value })}
              placeholder="e.g. Sharma Wholesale"
            />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Bill date">
              <input
                className="input"
                type="date"
                max={todayStr()}
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
              />
            </Field>
            <Field label="Amount (₹)">
              <input
                className="input"
                type="number"
                min="0"
                step="0.01"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
              />
            </Field>
            <Field label="Category">
              <select
                className="input"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
              >
                {BILL_CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </Field>
            <Field label="Payment status">
              <select
                className="input"
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
              >
                {BILL_STATUS.map((s) => (
                  <option key={s} value={s}>
                    {s[0].toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            </Field>
            {form.status === "partial" && (
              <Field label="Paid so far (₹)">
                <input
                  className="input"
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.paidAmount}
                  onChange={(e) => setForm({ ...form, paidAmount: e.target.value })}
                />
              </Field>
            )}
            {form.status !== "paid" && (
              <Field label="Due date (optional)">
                <input
                  className="input"
                  type="date"
                  value={form.dueDate}
                  onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
                />
              </Field>
            )}
          </div>
          <Field label={editId ? "Replace proof (optional)" : "Bill proof (optional)"}>
            <input
              ref={fileRef}
              className="input"
              type="file"
              accept={PROOF_ACCEPT}
              onChange={onFile}
            />
          </Field>
          {editId &&
            !file &&
            (() => {
              const cur = bills.find((b) => b.id === editId);
              return cur?.fileURL ? (
                <div style={{ fontSize: 11.5, color: "#6B7E74", marginTop: -6, marginBottom: 6 }}>
                  Current proof:{" "}
                  <a href={cur.fileURL} target="_blank" rel="noopener noreferrer">
                    {cur.fileName || "view"}
                  </a>{" "}
                  — choose a file to replace it.
                </div>
              ) : null;
            })()}
          <div style={{ fontSize: 11, color: "#8A9C90", marginBottom: 10 }}>
            JPG/PNG/PDF/DOC/XLS… up to 10 MB. Stored securely in the cloud.
          </div>
          {err && (
            <div
              style={{
                fontSize: 12,
                color: "#C44536",
                background: "#FBEDEB",
                border: "1px solid #E2B6B0",
                borderRadius: 8,
                padding: "8px 10px",
                marginBottom: 10,
                lineHeight: 1.5,
              }}
            >
              {err}
              {file && (
                <div style={{ marginTop: 6 }}>
                  <button
                    className="btn small ghost"
                    disabled={busy}
                    onClick={() => {
                      setFile(null);
                      if (fileRef.current) fileRef.current.value = "";
                      setErr("");
                      notify("Proof removed — you can save the bill without it for now.");
                    }}
                  >
                    Save without proof instead
                  </button>
                </div>
              )}
            </div>
          )}
          <button
            className="btn primary big"
            style={{ width: "100%" }}
            disabled={busy}
            onClick={save}
          >
            {busy ? "Saving…" : editId ? "Save changes" : "Save bill"}
          </button>
          {editId && (
            <button
              className="btn ghost"
              style={{ width: "100%", marginTop: 8 }}
              disabled={busy}
              onClick={resetForm}
            >
              Cancel edit
            </button>
          )}
        </section>

        {/* list + filters */}
        <section style={S.panel}>
          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <label style={{ fontSize: 12, color: "#6B7E74" }}>
              From{" "}
              <input
                type="date"
                className="input"
                style={{ width: "auto", marginLeft: 4 }}
                value={from}
                max={to || todayStr()}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label style={{ fontSize: 12, color: "#6B7E74" }}>
              To{" "}
              <input
                type="date"
                className="input"
                style={{ width: "auto", marginLeft: 4 }}
                value={to}
                max={todayStr()}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
            <label style={{ fontSize: 12, color: "#6B7E74" }}>
              Month{" "}
              <input
                type="month"
                className="input"
                style={{ width: "auto", marginLeft: 4 }}
                max={todayStr().slice(0, 7)}
                onChange={(e) => setMonth(e.target.value)}
              />
            </label>
            <select
              className="input"
              style={{ width: "auto" }}
              value={statusF}
              onChange={(e) => setStatusF(e.target.value)}
            >
              <option value="all">All status</option>
              {BILL_STATUS.map((s) => (
                <option key={s} value={s}>
                  {s[0].toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
            <select
              className="input"
              style={{ width: "auto" }}
              value={catF}
              onChange={(e) => setCatF(e.target.value)}
            >
              <option>All</option>
              {BILL_CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <input
              className="input"
              style={{ flex: 1, minWidth: 120 }}
              placeholder="Search vendor…"
              value={vq}
              onChange={(e) => setVq(e.target.value)}
            />
            {(from || to || vq || statusF !== "all" || catF !== "All") && (
              <button
                className="btn ghost small"
                onClick={() => {
                  setFrom("");
                  setTo("");
                  setVq("");
                  setStatusF("all");
                  setCatF("All");
                }}
              >
                Clear
              </button>
            )}
          </div>

          <div style={S.cards}>
            <Card label="Total spend" value={INR(totalSpend)} sub={filtered.length + " bills"} />
            <Card label="Outstanding" value={INR(outstanding)} sub="unpaid + partial" accent />
            <Card
              label="Top vendor"
              value={topVendorName || "—"}
              sub={topVendors[0] ? INR(topVendors[0].value) : "—"}
            />
          </div>

          {sorted.length === 0 ? (
            <Empty
              text={
                bills.length === 0
                  ? "No bills yet. Add your first vendor bill on the left."
                  : "No bills match these filters."
              }
            />
          ) : (
            <table className="tbl" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th style={{ width: 96 }}>Date</th>
                  <th>Vendor</th>
                  <th>Category</th>
                  <th style={{ textAlign: "right" }}>Amount</th>
                  <th>Status</th>
                  <th>Proof</th>
                  <th style={{ width: 78 }}></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((b) => {
                  const out = outstandingOf(b);
                  return (
                    <tr key={b.id}>
                      <td style={{ whiteSpace: "nowrap", color: "#677" }}>{fmtDate(b.date)}</td>
                      <td style={{ fontWeight: 600 }}>
                        {b.vendor}
                        {b.source === "daily-need" && (
                          <span
                            title="Synced from Supplier Bills"
                            style={{
                              marginLeft: 6,
                              fontSize: 9.5,
                              fontWeight: 800,
                              textTransform: "uppercase",
                              letterSpacing: ".03em",
                              color: "#0E7C86",
                              border: "1px solid #9FD3D8",
                              background: "#EAF7F8",
                              borderRadius: 6,
                              padding: "0 5px",
                              whiteSpace: "nowrap",
                            }}
                          >
                            🧺 Supplier
                          </span>
                        )}
                      </td>
                      <td style={{ color: "#677", fontSize: 12.5 }}>{b.category || "—"}</td>
                      <td style={{ textAlign: "right", fontWeight: 700 }}>{INR(b.amount)}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <span
                          style={{
                            fontSize: 10.5,
                            fontWeight: 800,
                            textTransform: "uppercase",
                            color: STATUS_COLORS[b.status] || "#789",
                            border: `1px solid ${STATUS_COLORS[b.status] || "#bbb"}`,
                            borderRadius: 6,
                            padding: "0 6px",
                          }}
                        >
                          {b.status || "unpaid"}
                        </span>
                        {out > 0 && (
                          <div style={{ fontSize: 10.5, color: "#C44536" }}>
                            {INR(out)} due{b.dueDate ? " · " + fmtDate(b.dueDate) : ""}
                          </div>
                        )}
                      </td>
                      <td>
                        {b.fileURL ? (
                          isImageType(b.fileType, b.fileName) ? (
                            <a
                              href={b.fileURL}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={b.fileName}
                            >
                              <img
                                src={b.fileURL}
                                alt="proof"
                                style={{
                                  width: 36,
                                  height: 36,
                                  objectFit: "cover",
                                  borderRadius: 6,
                                  border: "1px solid #E2EAE3",
                                }}
                              />
                            </a>
                          ) : (
                            <a
                              href={b.fileURL}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ fontSize: 12 }}
                            >
                              📎 Open
                            </a>
                          )
                        ) : (
                          <span style={{ color: "#AAB", fontSize: 12 }}>—</span>
                        )}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button
                          className="btn small ghost"
                          aria-label={"Edit " + b.vendor}
                          onClick={() => startEdit(b)}
                        >
                          ✎
                        </button>{" "}
                        <button
                          className="btn small danger"
                          aria-label={"Delete " + b.vendor}
                          onClick={() => del(b)}
                        >
                          🗑
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {filtered.length > 0 && (
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginTop: 16 }}
        >
          <ChartCard title="Spend by month">
            <BarChart data={monthly} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: "#678" }}
                interval="preserveStartEnd"
                minTickGap={16}
              />
              <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
              <Tooltip formatter={(v) => INR(v)} />
              <Bar dataKey="amount" name="Spend" fill="#0E7C86" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ChartCard>
          <ChartCard title="Top vendors by spend">
            <BarChart
              data={topVendors}
              layout="vertical"
              margin={{ top: 4, right: 12, left: 8, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} />
              <YAxis
                type="category"
                dataKey="name"
                tick={{ fontSize: 10.5, fill: "#465" }}
                width={110}
              />
              <Tooltip formatter={(v) => INR(v)} />
              <Bar dataKey="value" name="Spend" fill="#2A6FB0" radius={[0, 3, 3, 0]} />
            </BarChart>
          </ChartCard>
          <ChartCard title="Spend by category">
            <BarChart
              data={byCategory}
              layout="vertical"
              margin={{ top: 4, right: 12, left: 8, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} />
              <YAxis
                type="category"
                dataKey="name"
                tick={{ fontSize: 10.5, fill: "#465" }}
                width={96}
              />
              <Tooltip formatter={(v) => INR(v)} />
              <Bar dataKey="value" name="Spend" fill="#3DA17A" radius={[0, 3, 3, 0]} />
            </BarChart>
          </ChartCard>
        </div>
      )}
    </div>
  );
}

// ---------- Supplier Bills (auto-syncs into Vendor Bills) ----------
// Day-to-day vendor bills for daily-need purchases. Each entry is the single source of truth
// and MIRRORS into the vendorBills slice (same id, source:"daily-need") so the Vendor Bills
// view shows it too — no double entry. See src/lib/dailyBills.js for the pure mappers.
const METHOD_COLORS = {
  Cash: "#1B5E43",
  UPI: "#2A6FB0",
  "Bank Transfer": "#7A5AB0",
  Credit: "#C44536",
  Cheque: "#B0762A",
};
const DAILY_STATUS_COLORS = { Paid: "#1B5E43", Pending: "#C44536", Partial: "#B0762A" };

function DailyBills({ dailyBills, setDailyBills, bills, setBills, goVendorBills, notify, log }) {
  const blank = useMemo(() => blankDailyBill(todayStr()), []);
  const [form, setForm] = useState(blank);
  const [editId, setEditId] = useState(null);
  const [err, setErr] = useState("");
  // filters
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [vq, setVq] = useState("");
  const [methodF, setMethodF] = useState("all");
  const [statusF, setStatusF] = useState("all");
  // sort
  const [sortKey, setSortKey] = useState("date");
  const [sortDir, setSortDir] = useState("desc");

  const resetForm = () => {
    setForm(blankDailyBill(todayStr()));
    setEditId(null);
    setErr("");
  };

  const save = () => {
    const msg = validateDailyBill(form);
    if (msg) {
      setErr(msg);
      return notify(msg);
    }
    setErr("");
    const id = editId || uid();
    const now = Date.now();
    const existing = editId ? dailyBills.find((d) => d.id === editId) : null;
    const rec = makeDailyBill(form, { id, now, existing });
    const mirror = dailyToVendorBill(rec);
    if (editId) {
      setDailyBills((list) => list.map((d) => (d.id === editId ? rec : d)));
      setBills((list) => upsertMirror(list, mirror)); // keep the Vendor Bills mirror in lockstep
      log("bill", `Edited daily-need bill — ${rec.vendorName} · ${INR(rec.billAmount)}`);
      notify("Daily-need bill updated · synced to Vendor Bills");
    } else {
      setDailyBills((list) => [...list, rec]);
      setBills((list) => upsertMirror(list, mirror));
      log("bill", `Added daily-need bill — ${rec.vendorName} · ${INR(rec.billAmount)}`);
      notify("Daily-need bill saved · synced to Vendor Bills");
    }
    resetForm();
  };

  const startEdit = (d) => {
    setEditId(d.id);
    setForm({
      category: d.category || SUPPLIER_CATEGORIES[0],
      itemName: d.itemName || "",
      qty: d.qty ? String(d.qty) : "",
      unitPrice: d.unitPrice ? String(d.unitPrice) : "",
      vendorName: d.vendorName || "",
      billAmount: String(d.billAmount ?? ""),
      paymentMethod: d.paymentMethod || PAYMENT_METHODS[0],
      paymentStatus: d.paymentStatus || PAYMENT_STATUS[0],
      paidAmount: String(d.paidAmount ?? ""),
      date: d.date || todayStr(),
      billNumber: d.billNumber || "",
      notes: d.notes || "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const del = (d) => {
    if (
      !confirm(
        `Delete daily-need bill from “${d.vendorName}” (${INR(d.billAmount)})? It will also be removed from Vendor Bills.`
      )
    )
      return;
    setDailyBills((list) => list.filter((x) => x.id !== d.id));
    setBills((list) => list.filter((x) => x.id !== d.id)); // mirror shares the id → drops both
    if (editId === d.id) resetForm();
    log("bill", `Deleted daily-need bill — ${d.vendorName} · ${INR(d.billAmount)}`);
    notify("Daily-need bill deleted");
  };

  // Vendor autocomplete: names already used in daily-need OR the wider Vendor Bills list.
  const vendorSuggestions = useMemo(() => {
    const set = new Set();
    dailyBills.forEach((d) => d.vendorName && set.add(d.vendorName));
    bills.forEach((b) => b.vendor && set.add(b.vendor));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [dailyBills, bills]);

  // Item suggestions are driven by the chosen category, plus any items already used under it.
  const catItems = useMemo(() => {
    const set = new Set(itemsForCategory(form.category));
    dailyBills.forEach((d) => {
      if (d.category === form.category && d.itemName) set.add(d.itemName);
    });
    return [...set];
  }, [form.category, dailyBills]);

  // When both Qty and Price are set, the total is qty × price and the Amount field auto-reflects
  // it (read-only); otherwise the owner types the amount directly.
  const autoTotal = lineTotal(form.qty, form.unitPrice);

  const filtered = useMemo(
    () =>
      dailyBills.filter(
        (d) =>
          (!from || d.date >= from) &&
          (!to || d.date <= to) &&
          (!vq.trim() || (d.vendorName || "").toLowerCase().includes(vq.trim().toLowerCase())) &&
          (methodF === "all" || d.paymentMethod === methodF) &&
          (statusF === "all" || d.paymentStatus === statusF)
      ),
    [dailyBills, from, to, vq, methodF, statusF]
  );

  const toggleSort = (k) => {
    if (sortKey === k) setSortDir((s) => (s === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir(k === "billAmount" || k === "date" ? "desc" : "asc");
    }
  };
  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let av, bv;
      if (sortKey === "billAmount") {
        av = +a.billAmount || 0;
        bv = +b.billAmount || 0;
      } else {
        av = String(a[sortKey] || "").toLowerCase();
        bv = String(b[sortKey] || "").toLowerCase();
      }
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return (b.createdAt || 0) - (a.createdAt || 0); // stable newest-first tiebreak
    });
  }, [filtered, sortKey, sortDir]);

  const totalSpent = money(filtered.reduce((a, d) => a + (+d.billAmount || 0), 0));
  const totalPending = money(filtered.reduce((a, d) => a + dailyOutstanding(d), 0));

  const spendByDay = useMemo(() => {
    const m = {};
    filtered.forEach((d) => {
      const k = d.date;
      if (k) m[k] = (m[k] || 0) + (+d.billAmount || 0);
    });
    return Object.entries(m)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => ({
        label: new Date(k + "T00:00").toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
        }),
        amount: money(v),
      }));
  }, [filtered]);
  const topVendors = useMemo(() => {
    const m = {};
    filtered.forEach((d) => {
      const v = d.vendorName || "—";
      m[v] = (m[v] || 0) + (+d.billAmount || 0);
    });
    return Object.entries(m)
      .map(([name, value]) => ({ name, value: money(value) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }, [filtered]);
  const byMethod = useMemo(() => {
    const m = {};
    filtered.forEach((d) => {
      const k = d.paymentMethod || "—";
      m[k] = (m[k] || 0) + (+d.billAmount || 0);
    });
    return Object.entries(m)
      .map(([name, value]) => ({ name, value: money(value) }))
      .filter((r) => r.value > 0);
  }, [filtered]);
  const byStatus = useMemo(() => {
    const order = { Paid: 0, Partial: 1, Pending: 2 };
    const m = {};
    filtered.forEach((d) => {
      const k = d.paymentStatus || "—";
      m[k] = (m[k] || 0) + (+d.billAmount || 0);
    });
    return Object.entries(m)
      .map(([name, value]) => ({ name, value: money(value) }))
      .filter((r) => r.value > 0)
      .sort((a, b) => (order[a.name] ?? 9) - (order[b.name] ?? 9));
  }, [filtered]);

  const setMonth = (mv) => {
    if (!mv) {
      setFrom("");
      setTo("");
      return;
    }
    setFrom(mv + "-01");
    const d = new Date(+mv.slice(0, 4), +mv.slice(5, 7), 0);
    setTo(dateStr(d));
  };
  const fmtDate = (d) =>
    d
      ? new Date(d + "T00:00").toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : "—";
  const arrow = (k) => (sortKey === k ? (sortDir === "asc" ? " ▲" : " ▼") : "");
  const SortTh = ({ k, label, style }) => (
    <th
      style={{ cursor: "pointer", userSelect: "none", ...style }}
      onClick={() => toggleSort(k)}
      title="Click to sort"
    >
      {label}
      {arrow(k)}
    </th>
  );

  return (
    <div>
      <Header
        title="Supplier Bills"
        sub="Track day-to-day supplier purchase bills (stock, packaging, tailoring) — auto-synced into Vendor Bills"
      >
        <span style={{ fontSize: 11.5, color: "#0E7C86" }}>
          🧺 Each entry also appears in Vendor Bills
        </span>
      </Header>

      <div
        style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: 16, alignItems: "start" }}
      >
        {/* add / edit form */}
        <section style={S.panel}>
          <div style={S.panelHead}>{editId ? "Edit daily-need bill" : "New daily-need bill"}</div>
          {/* Category first — it drives the item suggestions below. Switching category clears the item. */}
          <Field label="Category">
            <select
              className="input"
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value, itemName: "" })}
            >
              {SUPPLIER_CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 10 }}>
            <Field label="Item">
              <input
                className="input"
                list="dnb-items"
                value={form.itemName}
                onChange={(e) => setForm({ ...form, itemName: e.target.value })}
                placeholder={catItems.length ? "Pick or type an item…" : "Type an item…"}
              />
              <datalist id="dnb-items">
                {catItems.map((it) => (
                  <option key={it} value={it} />
                ))}
              </datalist>
            </Field>
            <Field label="Qty">
              <input
                className="input"
                type="number"
                min="0"
                step="any"
                value={form.qty}
                onChange={(e) => setForm({ ...form, qty: e.target.value })}
                placeholder="e.g. 3"
              />
            </Field>
            <Field label="Price (₹/qty)">
              <input
                className="input"
                type="number"
                min="0"
                step="0.01"
                value={form.unitPrice}
                onChange={(e) => setForm({ ...form, unitPrice: e.target.value })}
                placeholder="e.g. 30"
              />
            </Field>
          </div>
          {autoTotal > 0 && (
            <div
              style={{
                fontSize: 12,
                color: "#0E7C86",
                background: "#EAF7F8",
                border: "1px solid #C5E7EA",
                borderRadius: 8,
                padding: "6px 10px",
                marginTop: -2,
                marginBottom: 10,
              }}
            >
              Total = {form.qty} × {INR(form.unitPrice)} = <b>{INR(autoTotal)}</b> — auto-filled
              into Amount below.
            </div>
          )}
          <Field label="Vendor name">
            <input
              className="input"
              list="dnb-vendors"
              value={form.vendorName}
              onChange={(e) => setForm({ ...form, vendorName: e.target.value })}
              placeholder="e.g. Surat Textile Wholesaler"
            />
            <datalist id="dnb-vendors">
              {vendorSuggestions.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Bill date">
              <input
                className="input"
                type="date"
                max={todayStr()}
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
              />
            </Field>
            <Field label={autoTotal > 0 ? "Amount (₹) · auto" : "Amount (₹)"}>
              <input
                className="input"
                type="number"
                min="0"
                step="0.01"
                value={autoTotal > 0 ? autoTotal : form.billAmount}
                readOnly={autoTotal > 0}
                onChange={(e) => setForm({ ...form, billAmount: e.target.value })}
                style={
                  autoTotal > 0
                    ? { background: "#EEF5F0", color: "#23402F", fontWeight: 700 }
                    : undefined
                }
                title={
                  autoTotal > 0
                    ? "Auto-calculated = Qty × Price. Clear Price or Qty to type a custom total."
                    : undefined
                }
              />
            </Field>
            <Field label="Payment method">
              <select
                className="input"
                value={form.paymentMethod}
                onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })}
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </Field>
            <Field label="Payment status">
              <select
                className="input"
                value={form.paymentStatus}
                onChange={(e) => setForm({ ...form, paymentStatus: e.target.value })}
              >
                {PAYMENT_STATUS.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </Field>
            {form.paymentStatus === "Partial" && (
              <Field label="Paid so far (₹)">
                <input
                  className="input"
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.paidAmount}
                  onChange={(e) => setForm({ ...form, paidAmount: e.target.value })}
                />
              </Field>
            )}
            <Field label="Bill number (optional)">
              <input
                className="input"
                value={form.billNumber}
                onChange={(e) => setForm({ ...form, billNumber: e.target.value })}
                placeholder="e.g. INV-204"
              />
            </Field>
          </div>
          <Field label="Notes (optional)">
            <textarea
              className="input"
              rows={2}
              style={{ resize: "vertical" }}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Anything to remember…"
            />
          </Field>
          {err && (
            <div
              style={{
                fontSize: 12,
                color: "#C44536",
                background: "#FBEDEB",
                border: "1px solid #E2B6B0",
                borderRadius: 8,
                padding: "8px 10px",
                marginBottom: 10,
              }}
            >
              {err}
            </div>
          )}
          <button className="btn primary big" style={{ width: "100%" }} onClick={save}>
            {editId ? "Save changes" : "Save bill"}
          </button>
          {editId && (
            <button
              className="btn ghost"
              style={{ width: "100%", marginTop: 8 }}
              onClick={resetForm}
            >
              Cancel edit
            </button>
          )}
        </section>

        {/* list + filters */}
        <section style={S.panel}>
          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <label style={{ fontSize: 12, color: "#6B7E74" }}>
              From{" "}
              <input
                type="date"
                className="input"
                style={{ width: "auto", marginLeft: 4 }}
                value={from}
                max={to || todayStr()}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label style={{ fontSize: 12, color: "#6B7E74" }}>
              To{" "}
              <input
                type="date"
                className="input"
                style={{ width: "auto", marginLeft: 4 }}
                value={to}
                max={todayStr()}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
            <label style={{ fontSize: 12, color: "#6B7E74" }}>
              Month{" "}
              <input
                type="month"
                className="input"
                style={{ width: "auto", marginLeft: 4 }}
                max={todayStr().slice(0, 7)}
                onChange={(e) => setMonth(e.target.value)}
              />
            </label>
            <select
              className="input"
              style={{ width: "auto" }}
              value={methodF}
              onChange={(e) => setMethodF(e.target.value)}
            >
              <option value="all">All methods</option>
              {PAYMENT_METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <select
              className="input"
              style={{ width: "auto" }}
              value={statusF}
              onChange={(e) => setStatusF(e.target.value)}
            >
              <option value="all">All status</option>
              {PAYMENT_STATUS.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <input
              className="input"
              style={{ flex: 1, minWidth: 120 }}
              placeholder="Search vendor…"
              value={vq}
              onChange={(e) => setVq(e.target.value)}
            />
            {(from || to || vq || methodF !== "all" || statusF !== "all") && (
              <button
                className="btn ghost small"
                onClick={() => {
                  setFrom("");
                  setTo("");
                  setVq("");
                  setMethodF("all");
                  setStatusF("all");
                }}
              >
                Clear
              </button>
            )}
          </div>

          <div style={S.cards}>
            <Card
              label="Total spent"
              value={INR(totalSpent)}
              sub={filtered.length + (filtered.length === 1 ? " bill" : " bills")}
            />
            <Card label="Pending" value={INR(totalPending)} sub="unpaid + partial" accent />
            <Card label="Entries" value={String(filtered.length)} sub="in selected range" />
          </div>

          {sorted.length === 0 ? (
            <Empty
              text={
                dailyBills.length === 0
                  ? "No daily-need bills yet. Add your first one on the left."
                  : "No bills match these filters."
              }
            />
          ) : (
            <table className="tbl" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <SortTh k="date" label="Date" style={{ width: 96 }} />
                  <SortTh k="category" label="Category" />
                  <SortTh k="itemName" label="Item" />
                  <SortTh k="vendorName" label="Vendor" />
                  <SortTh k="billAmount" label="Amount" style={{ textAlign: "right" }} />
                  <SortTh k="paymentMethod" label="Method" />
                  <SortTh k="paymentStatus" label="Status" />
                  <th style={{ width: 78 }}></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((d) => {
                  const out = dailyOutstanding(d);
                  return (
                    <tr key={d.id}>
                      <td style={{ whiteSpace: "nowrap", color: "#677" }}>{fmtDate(d.date)}</td>
                      <td style={{ color: "#677", fontSize: 12.5 }}>{d.category || "—"}</td>
                      <td>
                        {d.itemName ? (
                          <>
                            {d.itemName}
                            {d.qty ? (
                              <span style={{ color: "#9AA", fontWeight: 600 }}> ×{d.qty}</span>
                            ) : null}
                            {d.unitPrice ? (
                              <span style={{ color: "#9AA", fontWeight: 500 }}>
                                {" "}
                                @{INR(d.unitPrice)}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <span style={{ color: "#AAB" }}>—</span>
                        )}
                      </td>
                      <td style={{ fontWeight: 600 }}>
                        {d.vendorName}
                        {d.billNumber ? (
                          <span style={{ color: "#9AA", fontWeight: 500, fontSize: 11.5 }}>
                            {" "}
                            · {d.billNumber}
                          </span>
                        ) : null}
                      </td>
                      <td style={{ textAlign: "right", fontWeight: 700 }}>{INR(d.billAmount)}</td>
                      <td style={{ color: "#677", fontSize: 12.5, whiteSpace: "nowrap" }}>
                        {d.paymentMethod || "—"}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <span
                          style={{
                            fontSize: 10.5,
                            fontWeight: 800,
                            textTransform: "uppercase",
                            color: DAILY_STATUS_COLORS[d.paymentStatus] || "#789",
                            border: `1px solid ${DAILY_STATUS_COLORS[d.paymentStatus] || "#bbb"}`,
                            borderRadius: 6,
                            padding: "0 6px",
                          }}
                        >
                          {d.paymentStatus || "—"}
                        </span>
                        {out > 0 && (
                          <div style={{ fontSize: 10.5, color: "#C44536" }}>{INR(out)} due</div>
                        )}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button
                          className="btn small ghost"
                          aria-label={"Edit " + d.vendorName}
                          onClick={() => startEdit(d)}
                        >
                          ✎
                        </button>{" "}
                        <button
                          className="btn small danger"
                          aria-label={"Delete " + d.vendorName}
                          onClick={() => del(d)}
                        >
                          🗑
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {sorted.length > 0 && goVendorBills && (
            <div style={{ fontSize: 11.5, color: "#8A9C90", marginTop: 10 }}>
              These bills also appear in{" "}
              <button
                className="btn small ghost"
                style={{ padding: "2px 8px" }}
                onClick={goVendorBills}
              >
                Vendor Bills →
              </button>
            </div>
          )}
        </section>
      </div>

      {filtered.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
          <ChartCard title="Spend over time (by day)">
            <BarChart data={spendByDay} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: "#678" }}
                interval="preserveStartEnd"
                minTickGap={16}
              />
              <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
              <Tooltip formatter={(v) => INR(v)} />
              <Bar dataKey="amount" name="Spend" fill="#0E7C86" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ChartCard>
          <ChartCard title="Top vendors by spend">
            <BarChart
              data={topVendors}
              layout="vertical"
              margin={{ top: 4, right: 12, left: 8, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} />
              <YAxis
                type="category"
                dataKey="name"
                tick={{ fontSize: 10.5, fill: "#465" }}
                width={110}
              />
              <Tooltip formatter={(v) => INR(v)} />
              <Bar dataKey="value" name="Spend" fill="#2A6FB0" radius={[0, 3, 3, 0]} />
            </BarChart>
          </ChartCard>
          <ChartCard title="Payment method breakdown">
            <PieChart>
              <Pie
                data={byMethod}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={45}
                outerRadius={78}
                paddingAngle={2}
                stroke="none"
              >
                {byMethod.map((r) => (
                  <Cell key={r.name} fill={METHOD_COLORS[r.name] || "#8A9C90"} />
                ))}
              </Pie>
              <Tooltip formatter={(v, n) => [INR(v), n]} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ChartCard>
          <ChartCard title="Paid vs Pending vs Partial">
            <PieChart>
              <Pie
                data={byStatus}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={45}
                outerRadius={78}
                paddingAngle={2}
                stroke="none"
              >
                {byStatus.map((r) => (
                  <Cell key={r.name} fill={DAILY_STATUS_COLORS[r.name] || "#8A9C90"} />
                ))}
              </Pie>
              <Tooltip formatter={(v, n) => [INR(v), n]} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ChartCard>
        </div>
      )}
    </div>
  );
}

// ---------- Add Expense (own page) ----------
function Expenses({ expenses, setExpenses, notify, log }) {
  const [exp, setExp] = useState({ desc: "", amount: "", date: todayStr() });
  const [month, setMonth] = useState(todayStr().slice(0, 7));
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState(null); // { id, desc, amount, date } being edited inline
  const listed = showAll ? expenses : expenses.filter((e) => e.date.startsWith(month));
  const sorted = [...listed].sort((a, b) => (a.date < b.date ? 1 : -1));
  const total = money(listed.reduce((a, e) => a + e.amount, 0));
  const monthLabel = new Date(month + "-01T00:00").toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
  });

  const addExp = () => {
    if (!exp.desc.trim() || !(+exp.amount > 0))
      return notify("Enter a description and a positive amount");
    const date = exp.date || todayStr();
    const row = { id: uid(), date, desc: exp.desc.trim(), amount: +exp.amount };
    setExpenses((list) => [...list, row]);
    log(
      "expense",
      `Expense ${INR(+exp.amount)} — ${exp.desc.trim()}` +
        (date !== todayStr() ? ` (dated ${date})` : "")
    );
    setExp({ desc: "", amount: "", date: todayStr() });
    notify("Expense recorded");
  };

  const del = (e) => {
    if (!confirm(`Delete expense “${e.desc}” (${INR(e.amount)})?`)) return;
    setExpenses((list) => list.filter((x) => x.id !== e.id));
    if (editing?.id === e.id) setEditing(null);
    log("expense", `Deleted expense ${INR(e.amount)} — ${e.desc}`);
    notify("Expense deleted");
  };

  const startEdit = (e) =>
    setEditing({ id: e.id, desc: e.desc, amount: String(e.amount), date: e.date });
  const saveEdit = () => {
    if (!editing.desc.trim() || !(+editing.amount > 0))
      return notify("Enter a description and a positive amount");
    const date = editing.date || todayStr();
    const amount = money(+editing.amount);
    setExpenses((list) =>
      list.map((x) => (x.id === editing.id ? { ...x, desc: editing.desc.trim(), amount, date } : x))
    );
    log("expense", `Edited expense ${INR(amount)} — ${editing.desc.trim()}`);
    setEditing(null);
    notify("Expense updated");
  };

  return (
    <div>
      <Header
        title="Add Expense"
        sub="Record shop expenses — rent, electricity, supplies, salaries…"
      >
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: 12, color: showAll ? "#9AA" : "#6B7E74" }}>
            Month{" "}
            <input
              type="month"
              className="input"
              style={{ width: "auto", marginLeft: 4 }}
              value={month}
              max={todayStr().slice(0, 7)}
              disabled={showAll}
              onChange={(e) => setMonth(e.target.value || todayStr().slice(0, 7))}
            />
          </label>
          <button
            className={"btn small " + (showAll ? "primary" : "ghost")}
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? "Showing all" : "Show all"}
          </button>
        </div>
      </Header>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 16 }}>
        <section style={S.panel}>
          <div style={S.panelHead}>New expense</div>
          <Field label="Description">
            <input
              className="input"
              autoFocus
              value={exp.desc}
              onChange={(e) => setExp({ ...exp, desc: e.target.value })}
              placeholder="e.g. Electricity bill"
            />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Amount (₹)">
              <input
                className="input"
                type="number"
                min="0"
                step="0.01"
                value={exp.amount}
                onChange={(e) => setExp({ ...exp, amount: e.target.value })}
              />
            </Field>
            <Field label="Date">
              <input
                className="input"
                type="date"
                max={todayStr()}
                value={exp.date}
                onChange={(e) => setExp({ ...exp, date: e.target.value })}
              />
            </Field>
          </div>
          <button
            className="btn primary big"
            style={{ width: "100%", marginTop: 8 }}
            onClick={addExp}
          >
            Record expense
          </button>
        </section>

        <section style={S.panel}>
          <div style={S.panelHead}>
            {showAll ? "All expenses" : monthLabel}
            <span
              style={{
                fontWeight: 500,
                textTransform: "none",
                letterSpacing: 0,
                color: "#8A9C90",
                marginLeft: 8,
              }}
            >
              {listed.length} {listed.length === 1 ? "entry" : "entries"}
            </span>
            <span style={{ marginLeft: "auto", fontWeight: 800 }}>{INR(total)}</span>
          </div>
          {sorted.length === 0 ? (
            <Empty
              text={
                showAll
                  ? "No expenses recorded yet."
                  : "No expenses recorded in " + monthLabel + "."
              }
            />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 150 }}>Date</th>
                  <th>Description</th>
                  <th style={{ textAlign: "right", width: 100 }}>Amount</th>
                  <th style={{ width: 96 }}></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((e) =>
                  editing?.id === e.id ? (
                    <tr key={e.id}>
                      <td>
                        <input
                          className="input"
                          style={{ padding: "6px 8px" }}
                          type="date"
                          max={todayStr()}
                          value={editing.date}
                          onChange={(ev) => setEditing({ ...editing, date: ev.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          style={{ padding: "6px 8px" }}
                          value={editing.desc}
                          onChange={(ev) => setEditing({ ...editing, desc: ev.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          style={{ padding: "6px 8px", textAlign: "right" }}
                          type="number"
                          min="0"
                          step="0.01"
                          value={editing.amount}
                          onChange={(ev) => setEditing({ ...editing, amount: ev.target.value })}
                        />
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button className="btn small primary" aria-label="Save" onClick={saveEdit}>
                          ✓
                        </button>{" "}
                        <button
                          className="btn small ghost"
                          aria-label="Cancel"
                          onClick={() => setEditing(null)}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ) : (
                    <tr key={e.id}>
                      <td style={{ color: "#677", whiteSpace: "nowrap" }}>{e.date}</td>
                      <td>{e.desc}</td>
                      <td style={{ textAlign: "right", fontWeight: 700 }}>{INR(e.amount)}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button
                          className="btn small ghost"
                          aria-label={"Edit " + e.desc}
                          onClick={() => startEdit(e)}
                        >
                          ✎
                        </button>{" "}
                        <button
                          className="btn small danger"
                          aria-label={"Delete " + e.desc}
                          onClick={() => del(e)}
                        >
                          🗑
                        </button>
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}

// ---------- small components ----------
// ---------- Admin (password-gated bulk / destructive operations) ----------
// Every action requires: confirm → confirm again → re-enter the account password
// (verified against Firebase Auth). Only on a successful re-auth does the action run.
function Admin({ items, setSales, setExpenses, setLogs, user, notify, log }) {
  const [pending, setPending] = useState(null); // the chosen operation
  const [step, setStep] = useState(1); // 1 = first confirm, 2 = password
  const [pwd, setPwd] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const dupeExtras = useMemo(() => {
    const seen = new Set();
    let extra = 0;
    for (const i of items) {
      const k = normName(i.name);
      seen.has(k) ? extra++ : seen.add(k);
    }
    return extra;
  }, [items]);

  const zeroStockCount = useMemo(() => items.filter((i) => productStock(i) <= 0).length, [items]);
  const zeroPriceCount = useMemo(
    () => items.filter((i) => (+i.sellingPrice || 0) <= 0).length,
    [items]
  );

  // Bulk product writes go straight to the cloud (the products slice is transaction-managed, not
  // delta-pushed); local state refreshes via the onValue echo.
  const applyItems = (fn) => overwriteSlice("items", toMap(fn(items).map(normalizeProduct)));
  const mapVariants = (p, mut) => normalizeProduct({ ...p, variants: (p.variants || []).map(mut) });

  const ops = [
    {
      key: "zeroStock",
      label: "Zero all stock",
      group: "Inventory",
      desc: "Set every size/colour variant's stock to 0. Names, variants and prices are kept.",
      apply: () => applyItems((l) => l.map((i) => mapVariants(i, (v) => ({ ...v, stockQty: 0 })))),
      logMsg: "Reset all stock to 0",
      toast: "All stock set to 0",
    },
    {
      key: "zeroBuy",
      label: "Zero all purchase prices",
      group: "Inventory",
      desc: "Set the purchase (cost) price to 0 for every product.",
      apply: () => applyItems((l) => l.map((i) => ({ ...i, purchasePrice: 0 }))),
      logMsg: "Reset all purchase prices to 0",
      toast: "All purchase prices set to 0",
    },
    {
      key: "zeroSell",
      label: "Zero all selling prices",
      group: "Inventory",
      desc: "Set the selling price and MRP to 0 for every product.",
      apply: () => applyItems((l) => l.map((i) => ({ ...i, sellingPrice: 0, mrp: 0 }))),
      logMsg: "Reset all selling prices to 0",
      toast: "All selling prices set to 0",
    },
    {
      key: "dedupe",
      label: "Merge duplicate products" + (dupeExtras ? ` (${dupeExtras})` : ""),
      group: "Inventory",
      desc: "Combine products that share the same name into one — variants and stock are pooled, nothing is lost.",
      disabled: dupeExtras === 0,
      apply: () =>
        applyItems((l) => {
          const g = new Map();
          for (const i of l) {
            const k = normName(i.name);
            if (!g.has(k)) g.set(k, []);
            g.get(k).push(i);
          }
          return [...g.values()].map((x) => (x.length === 1 ? x[0] : mergeProductGroup(x)));
        }),
      logMsg: "Merged duplicate products",
      toast: "Duplicates merged",
    },
    {
      key: "delZeroStock",
      label: "Delete 0-stock products" + (zeroStockCount ? ` (${zeroStockCount})` : ""),
      group: "Danger zone",
      danger: true,
      desc: "Permanently remove every product whose total stock is 0. Products with stock are kept.",
      disabled: zeroStockCount === 0,
      apply: () => applyItems((l) => l.filter((i) => productStock(i) > 0)),
      logMsg: "Deleted 0-stock products",
      toast: "0-stock products deleted",
    },
    {
      key: "delZeroPrice",
      label: "Delete 0-price products" + (zeroPriceCount ? ` (${zeroPriceCount})` : ""),
      group: "Danger zone",
      danger: true,
      desc: "Permanently remove every product whose selling price is 0.",
      disabled: zeroPriceCount === 0,
      apply: () => applyItems((l) => l.filter((i) => (+i.sellingPrice || 0) > 0)),
      logMsg: "Deleted 0-price products",
      toast: "0-price products deleted",
    },
    {
      key: "delItems",
      label: "Delete ALL products",
      group: "Danger zone",
      danger: true,
      desc: "Permanently remove every product from inventory. Sales history is kept.",
      apply: () => overwriteSlice("items", {}),
      logMsg: "Deleted all products",
      toast: "All products deleted",
    },
    {
      key: "clrSales",
      label: "Clear all sales history",
      group: "Danger zone",
      danger: true,
      desc: "Permanently delete every recorded sale. Inventory stock is NOT changed.",
      apply: () => setSales([]),
      logMsg: "Cleared all sales history",
      toast: "Sales history cleared",
    },
    {
      key: "clrExp",
      label: "Clear all expenses",
      group: "Danger zone",
      danger: true,
      desc: "Permanently delete every expense entry.",
      apply: () => setExpenses([]),
      logMsg: "Cleared all expenses",
      toast: "Expenses cleared",
    },
    {
      key: "clrLogs",
      label: "Clear activity log",
      group: "Danger zone",
      desc: "Delete all activity-log entries.",
      apply: () => setLogs([]),
      logMsg: "Cleared activity log",
      toast: "Activity log cleared",
    },
    {
      key: "factory",
      label: "Factory reset",
      group: "Danger zone",
      danger: true,
      desc: "Replace inventory with the fresh starter catalogue (all at 0 stock) and delete ALL sales, expenses and logs. Cannot be undone.",
      apply: async () => {
        await overwriteSlice("items", toMap(buildSeedProducts(todayStr())));
        await writeMeta("seeded", true);
        setSales([]);
        setExpenses([]);
        setLogs([]);
      },
      logMsg: "Factory reset performed",
      toast: "Factory reset complete",
    },
  ];

  const groups = [...new Set(ops.map((o) => o.group))];
  const choose = (op) => {
    if (op.disabled) return;
    setPending(op);
    setStep(1);
    setPwd("");
    setErr("");
  };
  const close = () => {
    setPending(null);
    setStep(1);
    setPwd("");
    setErr("");
    setBusy(false);
  };

  const confirmRun = async () => {
    if (!pwd) return setErr("Enter your account password.");
    if (!user?.email) return setErr("No signed-in account to verify against.");
    setBusy(true);
    setErr("");
    try {
      const cred = EmailAuthProvider.credential(user.email, pwd);
      await reauthenticateWithCredential(auth.currentUser, cred);
    } catch (e) {
      setBusy(false);
      setErr(
        e?.code === "auth/too-many-requests"
          ? "Too many attempts — please wait a minute and retry."
          : "Incorrect password — operation cancelled."
      );
      return;
    }
    try {
      await pending.apply();
      log("admin", pending.logMsg);
      notify(pending.toast);
    } catch (e) {
      console.error("admin op failed", e);
      notify("⚠ Operation failed.");
    }
    close();
  };

  return (
    <div>
      <Header
        title="Admin"
        sub="Bulk & destructive operations · double-confirm + password required"
      />
      {groups.map((grp) => (
        <section key={grp} style={{ ...S.panel, marginBottom: 16 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: ".06em",
              color: grp === "Danger zone" ? "#B23B2E" : "#6B7E74",
              marginBottom: 6,
            }}
          >
            {grp}
          </div>
          {ops
            .filter((o) => o.group === grp)
            .map((op) => (
              <div
                key={op.key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 14,
                  padding: "10px 0",
                  borderTop: "1px solid #EAF0EA",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, color: op.danger ? "#B23B2E" : "#10331F" }}>
                    {op.label}
                  </div>
                  <div style={{ fontSize: 12.5, color: "#5E7468" }}>{op.desc}</div>
                </div>
                <button
                  className="btn"
                  disabled={op.disabled}
                  onClick={() => choose(op)}
                  style={{
                    flex: "0 0 auto",
                    opacity: op.disabled ? 0.5 : 1,
                    ...(op.danger ? { borderColor: "#E2B6B0", color: "#B23B2E" } : {}),
                  }}
                >
                  Run
                </button>
              </div>
            ))}
        </section>
      ))}

      {pending && (
        <Modal
          title={step === 1 ? "Confirm operation" : "Enter password to confirm"}
          onClose={close}
        >
          {step === 1 ? (
            <>
              <p
                style={{
                  marginTop: 0,
                  fontWeight: 700,
                  color: pending.danger ? "#B23B2E" : "#10331F",
                }}
              >
                {pending.label}
              </p>
              <p style={{ color: "#5E7468", fontSize: 13 }}>{pending.desc}</p>
              <p style={{ color: pending.danger ? "#B23B2E" : "#5E7468", fontSize: 13 }}>
                This applies to all signed-in devices and may not be reversible. Continue?
              </p>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 14 }}>
                <button className="btn" onClick={close}>
                  Cancel
                </button>
                <button
                  className="btn primary"
                  onClick={() => {
                    setStep(2);
                    setErr("");
                  }}
                >
                  Yes, continue
                </button>
              </div>
            </>
          ) : (
            <>
              <p style={{ marginTop: 0, fontSize: 13, color: "#5E7468" }}>
                Final step. Enter the password for <b>{user?.email}</b> to run{" "}
                <b>{pending.label}</b>.
              </p>
              <input
                className="input"
                type="password"
                autoFocus
                placeholder="Account password"
                value={pwd}
                onChange={(e) => setPwd(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirmRun();
                }}
                style={{ width: "100%", boxSizing: "border-box" }}
              />
              {err && <div style={{ color: "#B23B2E", fontSize: 12.5, marginTop: 8 }}>{err}</div>}
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 14 }}>
                <button className="btn" onClick={close} disabled={busy}>
                  Cancel
                </button>
                <button className="btn primary" onClick={confirmRun} disabled={busy}>
                  {busy ? "Verifying…" : "Confirm & run"}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

const Header = ({ title, sub, children }) => (
  <div style={{ display: "flex", alignItems: "flex-end", marginBottom: 18, gap: 12 }}>
    <div>
      <h1 style={{ margin: 0, fontSize: 24, letterSpacing: "-0.03em" }}>{title}</h1>
      {sub && <div style={{ color: "#6B7E74", fontSize: 13, marginTop: 2 }}>{sub}</div>}
    </div>
    <div style={{ marginLeft: "auto" }}>{children}</div>
  </div>
);

const Card = ({ label, value, sub, accent }) => (
  <div style={{ ...S.card, ...(accent ? { background: "#1B5E43", color: "#fff" } : {}) }}>
    <div
      style={{
        fontSize: 11.5,
        textTransform: "uppercase",
        letterSpacing: "0.07em",
        color: accent ? "#A8CDBA" : "#7A8C81",
      }}
    >
      {label}
    </div>
    <div
      style={{
        fontSize: 24,
        fontWeight: 800,
        margin: "6px 0 2px",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {value}
    </div>
    <div style={{ fontSize: 12, color: accent ? "#C8E2D4" : "#8A9C90" }}>{sub}</div>
  </div>
);

const Field = ({ label, children }) => (
  <label style={{ display: "block", marginBottom: 10 }}>
    <div style={{ fontSize: 12, fontWeight: 600, color: "#465", marginBottom: 4 }}>{label}</div>
    {children}
  </label>
);

const Empty = ({ text, children }) => (
  <div style={{ padding: "22px 10px", textAlign: "center", color: "#8A9", fontSize: 13 }}>
    {text}
    {children && <div style={{ marginTop: 10 }}>{children}</div>}
  </div>
);

const Section = ({ title, children }) => (
  <section style={{ ...S.panel, marginBottom: 16 }}>
    {title && <div style={S.panelHead}>{title}</div>}
    {children}
  </section>
);

function Modal({ title, children, onClose }) {
  // Only close when the *press* started on the backdrop itself. Relying on the
  // click target alone closed the dialog whenever a drag (e.g. selecting digits
  // in a number field) began inside an input but released on the overlay.
  const downOnOverlay = useRef(false);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      style={S.overlay}
      onMouseDown={(e) => {
        downOnOverlay.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOnOverlay.current) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div style={S.modal}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>{title}</h2>
          <button
            className="btn ghost small"
            style={{ marginLeft: "auto" }}
            aria-label="Close dialog"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------- styles ----------
const S = {
  app: {
    display: "flex",
    minHeight: "100vh",
    background: "#EFF3EE",
    fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
    color: "#1E2421",
  },
  nav: {
    width: 210,
    background: "#10331F",
    color: "#E6F0E9",
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: "16px 10px",
    position: "sticky",
    top: 0,
    height: "100vh",
    boxSizing: "border-box",
  },
  logo: { display: "flex", gap: 10, alignItems: "center", padding: "4px 8px 18px" },
  logoMark: {
    width: 38,
    height: 38,
    borderRadius: 10,
    background: "#E8A33D",
    color: "#10331F",
    display: "grid",
    placeItems: "center",
    fontWeight: 800,
    fontSize: 17,
  },
  main: {
    flex: 1,
    padding: "26px 30px",
    maxWidth: 1280,
    margin: "0 auto",
    width: "100%",
    boxSizing: "border-box",
  },
  cards: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 },
  card: { background: "#fff", borderRadius: 14, padding: "16px 18px", border: "1px solid #E2EAE3" },
  panel: { background: "#fff", borderRadius: 14, padding: 16, border: "1px solid #E2EAE3" },
  panelHead: {
    fontWeight: 800,
    fontSize: 13.5,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "#3A5547",
    display: "flex",
    alignItems: "center",
    marginBottom: 10,
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    padding: "8px 2px",
    borderBottom: "1px dashed #E5ECE6",
    fontSize: 13.5,
  },
  receipt: {
    background: "#FFFDF6",
    borderRadius: 4,
    padding: "18px 16px",
    border: "1px solid #E8E2CF",
    boxShadow: "0 2px 10px rgba(40,60,40,.07)",
    alignSelf: "start",
    backgroundImage:
      "repeating-linear-gradient(transparent, transparent 27px, rgba(180,170,140,.12) 28px)",
  },
  receiptHead: {
    textAlign: "center",
    fontWeight: 800,
    letterSpacing: "0.25em",
    fontSize: 12,
    color: "#6B6347",
    borderBottom: "2px dashed #D8D0B8",
    paddingBottom: 10,
    marginBottom: 8,
  },
  rcptLine: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "7px 0",
    borderBottom: "1px dotted #E0D9C4",
  },
  rcptTotal: {
    display: "flex",
    justifyContent: "space-between",
    fontWeight: 800,
    fontSize: 18,
    paddingTop: 12,
    marginTop: 6,
    borderTop: "2px dashed #C9BF9F",
  },
  badge: {
    background: "#C44536",
    color: "#fff",
    fontSize: 10.5,
    fontWeight: 800,
    borderRadius: 9,
    padding: "1px 7px",
    marginLeft: 8,
  },
  badgeInline: {
    background: "#FBECEF",
    color: "#B0324C",
    fontSize: 10,
    fontWeight: 800,
    borderRadius: 6,
    padding: "1px 6px",
    marginLeft: 6,
    textTransform: "uppercase",
    letterSpacing: ".04em",
  },
  toast: {
    position: "fixed",
    bottom: 24,
    left: "50%",
    transform: "translateX(-50%)",
    background: "#10331F",
    color: "#fff",
    padding: "10px 20px",
    borderRadius: 10,
    fontSize: 13.5,
    boxShadow: "0 6px 20px rgba(0,0,0,.25)",
    zIndex: 60,
  },
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(15,30,20,.45)",
    display: "grid",
    placeItems: "center",
    zIndex: 50,
  },
  modal: {
    background: "#fff",
    borderRadius: 16,
    padding: 20,
    width: "min(480px, 92vw)",
    maxHeight: "86vh",
    overflow: "auto",
  },
};

const CSS = `
  .navbtn { display:flex; align-items:center; gap:6px; width:100%; text-align:left; background:none; border:none; color:#BCD2C4; padding:10px 12px; border-radius:9px; font-size:13.5px; font-weight:600; cursor:pointer; position:relative; }
  .navbtn:hover { background:#1A4A2E; color:#fff; }
  .navbtn.active { background:#1B5E43; color:#fff; }
  .navbtn.sub { padding-left:26px; font-size:13px; color:#A8C2B4; }
  .navbtn.sub::before { content:""; position:absolute; left:14px; top:9px; bottom:9px; width:2px; background:#2A5A3E; border-radius:2px; }
  .input { width:100%; box-sizing:border-box; padding:10px 12px; border:1.5px solid #D5E0D6; border-radius:9px; font-size:14px; background:#fff; outline:none; font-family:inherit; }
  .input:focus { border-color:#1B5E43; box-shadow:0 0 0 3px rgba(27,94,67,.12); }
  .btn { border:none; border-radius:9px; padding:9px 16px; font-size:13.5px; font-weight:700; cursor:pointer; background:#E4ECE5; color:#23402F; font-family:inherit; }
  .btn:hover { filter:brightness(.96); }
  .btn.primary { background:#1B5E43; color:#fff; }
  .btn.big { padding:13px 18px; font-size:15px; }
  .btn.ghost { background:transparent; border:1.5px solid #CFDCD1; }
  .btn.small { padding:5px 10px; font-size:12px; }
  .btn.danger { background:#FBEAE7; color:#C44536; }
  .pick { text-align:left; background:#F6FAF6; border:1.5px solid #DDE8DE; border-radius:11px; padding:10px 12px; cursor:pointer; font-family:inherit; }
  .pick:hover:not(:disabled) { border-color:#1B5E43; background:#fff; }
  .pick:disabled { opacity:.7; cursor:not-allowed; background:#F0F2F0; }
  .qty { width:26px; height:26px; border-radius:7px; border:1.5px solid #D0C7AB; background:#fff; font-size:15px; font-weight:700; cursor:pointer; line-height:1; }
  .seg { border:none; background:#F1ECEF; color:#5E4A54; padding:7px 12px; font-size:13px; font-weight:700; cursor:pointer; font-family:inherit; }
  .seg.wide { flex:1; border-radius:8px; }
  .seg.on { background:#8E2C48; color:#fff; }
  .chipbtn { display:inline-flex; align-items:center; gap:3px; border:1.5px solid #E1D4DA; background:#fff; color:#4A3A42; border-radius:16px; padding:4px 10px; font-size:12px; font-weight:600; cursor:pointer; margin:0 5px 5px 0; font-family:inherit; }
  .chipbtn.on { background:#8E2C48; color:#fff; border-color:#8E2C48; }
  .tbl { width:100%; border-collapse:collapse; font-size:13.5px; }
  .tbl th { text-align:left; font-size:11.5px; text-transform:uppercase; letter-spacing:.05em; color:#7A8C81; padding:6px 8px; border-bottom:2px solid #E2EAE3; }
  .tbl td { padding:9px 8px; border-bottom:1px solid #EEF3EE; }
  .tbl tr:hover td { background:#F7FAF7; }
  @media (max-width: 820px) {
    .app { flex-direction:column !important; }
    .nav { width:auto !important; height:auto !important; position:static !important;
           flex-direction:row !important; flex-wrap:wrap !important; gap:4px !important; }
    .nav .navbtn { width:auto !important; }
    .main { padding:16px !important; max-width:none !important; }
    /* 16px inputs stop mobile browsers auto-zooming on focus */
    .input { font-size:16px; }
    /* inline grids are 2- or 4-column; collapse them all on small screens */
    [style*="grid-template-columns"] { grid-template-columns:1fr !important; }
    /* let wide tables scroll horizontally instead of overflowing the panel */
    .tbl { display:block; overflow-x:auto; white-space:nowrap; }
  }
`;
