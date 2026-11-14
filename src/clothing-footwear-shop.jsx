import { useState, useEffect, useRef, useMemo, useCallback, Fragment } from "react";
import { isFirebaseConfigured, auth } from "./config/firebase.js";
import {
  onAuthStateChanged,
  signOut,
  sendPasswordResetEmail,
  EmailAuthProvider,
  reauthenticateWithCredential,
} from "firebase/auth";
import { FirebaseSetupNeeded } from "./screens/FirebaseSetupNeeded.jsx";
import { Login } from "./screens/Login.jsx";
import {
  ALL_SUBCATEGORIES,
  guessSubcategory,
  groupForSubcategory,
  CLOTHING_SIZES,
  GROUPS,
} from "./lib/catalog.js";
import {
  loadCachedConfig,
  DEFAULT_SHOP_CONFIG,
  subscribeShopConfig,
  cacheConfig,
  normalizeConfig,
  saveShopConfig,
  ShopConfigContext,
  useShopConfig,
} from "./config/shopConfig.js";
import { setCurrencySymbol, CURRENCY } from "./config/currency.js";
import {
  overlayPendingStock,
  applyOpsToMap,
  applyPatchToMap,
  recordSaleOp,
  amendSaleOp,
  voidSaleOp,
} from "./lib/ops.js";
import { openLocalDb, createCacheWriter } from "./lib/localdb.js";
import { createOutbox } from "./lib/outbox.js";
import {
  sendOp,
  SLICES,
  toMap,
  mapToArray,
  subscribeSlice,
  readMeta,
  overwriteSlice,
  writeMeta,
  isLegacyShape,
  mergeRemote,
  subscribeConnection,
  buildSliceUpdate,
  subscribeCustomSubcats,
  CUSTOM_SUBCATS_PATH,
  subcatKey,
} from "./lib/sync.js";
import { todayStr, uid, money, INR, dateStr } from "./lib/format.js";
import {
  buildSeedProducts,
  normalizeProduct,
  isProductLow,
  blankVariant,
  variantLabel,
  productStock,
  mergeProductGroup,
} from "./lib/products.js";
import { exportXlsx, exportJson, importXlsx } from "./lib/backup.js";
import { S, CSS } from "./ui/styles.js";
import { LOGO_SRC, printReceipt, lineVariantText } from "./lib/print.js";
import { Dashboard } from "./screens/Dashboard.jsx";
import { Billing } from "./screens/Billing.jsx";
import { Inventory } from "./screens/Inventory.jsx";
import { Settings } from "./screens/Settings.jsx";
import { parseFile, parseRawText } from "./lib/parse.js";
import { normName, PAY_COLORS, iconFor, LOG_TYPES } from "./lib/domain.js";
import { cloudWriteProduct } from "./lib/cloudProducts.js";
import { Header, Empty, Modal, Field, ColorDot, Card } from "./ui/index.jsx";
import {
  periodRange,
  buildSeries,
  FINANCE_PERIODS,
  ChartCard,
  renderPayMix,
  renderPayTrend,
  inrTick,
  PIE_COLORS,
  TRADING_START,
  CAPEX_START,
  STATS_PERIODS,
  barLabel,
} from "./ui/charts.jsx";
import {
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Bar,
  AreaChart,
  Legend,
  Area,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  ComposedChart,
  ResponsiveContainer,
  ReferenceLine,
  Treemap,
} from "recharts";
import {
  inrCompact,
  formatINR,
  hourLabel,
  DOW_ORDER,
  DOW,
  summarize,
  expenseByMonth,
  expenseBreakdown,
  expenseTotal,
  dailyRevenueSeries,
  monthlyRevenueProfit,
  salesHeatmap,
  topItems as topItemsBy,
  paymentBreakdown,
  udhariOutstandingSeries,
  inventoryValue,
  inventoryByCategory,
  deadStock,
  salesByCategory,
  topSizes,
  breakEvenSeries,
  breakEvenEstimate,
} from "./lib/stats.js";
import { MAX_PROOF_BYTES, uploadBillProof, deleteBillProof, PROOF_ACCEPT } from "./lib/bills.js";
import {
  blankDailyBill,
  validateDailyBill,
  makeDailyBill,
  dailyToVendorBill,
  upsertMirror,
  SUPPLIER_CATEGORIES,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  itemsForCategory,
  lineTotal,
  dailyOutstanding,
} from "./lib/dailyBills.js";

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

// NOTE: stock changes caused by a BILL (sale / edit / delete) do not use the helpers above. They
// travel in the same outbox op as the bill itself (lib/ops.js recordSaleOp / amendSaleOp /
// voidSaleOp → lib/sync.js sendOp), so the bill and its stock change are retried and replayed
// together and a replay can never apply the stock change twice.

function StoreManager({ user, onLogout }) {
  const [tab, setTab] = useState("dashboard");
  const [otherOpen, setOtherOpen] = useState(false);
  // `rawItems` = products exactly as last received from the cloud (or the local cache).
  // `items` (below) = what every screen sees: rawItems + stock changes still in the outbox.
  const [rawItems, setItems] = useState([]);
  const [pendingOps, setPendingOps] = useState([]); // outbox: writes not yet acked by the server
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
  const items = useMemo(() => overlayPendingStock(rawItems, pendingOps), [rawItems, pendingOps]);

  // Always-current local state, readable from inside async listeners (for the merge) and by
  // the cache writer. `items` here is the RAW cloud view — pending stock is re-overlaid from the
  // outbox on every load, so caching the overlaid numbers would count it twice.
  const dataRef = useRef({});
  dataRef.current = { items: rawItems, sales, expenses, logs, vendorBills: bills, dailyBills };
  const notifyRef = useRef(null);
  const localDb = useRef(null); // IndexedDB handle (cache + outbox)
  const cacheWriter = useRef(null);
  const outboxRef = useRef(null);
  const pendingRef = useRef([]); // same as pendingOps, readable synchronously in listeners
  const legacyCache = useRef(false); // true until the old localStorage cache has been moved over
  const lastSyncWarn = useRef(0);

  // 1) Open the device database, load the offline cache and the outbox, and paint from them.
  //    Pending (un-acked) writes from a previous session are re-applied on top of the cache
  //    here and on every cloud snapshot below, so a bill made offline — or in the instant before
  //    the tab was closed — is never dropped; the outbox replays it to the cloud.
  useEffect(() => {
    let dead = false;
    let outbox = null;
    (async () => {
      const ldb = await openLocalDb();
      if (dead) return ldb.close();
      localDb.current = ldb;
      const writer = createCacheWriter(ldb);
      cacheWriter.current = writer;
      let cache = {};
      try {
        cache = await ldb.loadCache();
      } catch (e) {
        console.error("cache read failed", e);
      }
      // One-time move from the old single-key localStorage cache (pre-IndexedDB versions).
      if (!Object.keys(cache).length) {
        try {
          const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
          if (c && typeof c === "object") {
            cache = c;
            legacyCache.current = true;
          }
        } catch (e) {
          console.error("legacy cache read failed", e);
        }
      }
      outbox = createOutbox({
        store: ldb,
        send: (op) => sendOp(op, { today: todayStr() }),
        onChange: (ops) => {
          pendingRef.current = ops;
          setPendingOps(ops);
        },
        onError: (op, err) => {
          console.error("sync write failed", op.label || "", err);
          if (Date.now() - lastSyncWarn.current > 30000) {
            lastSyncWarn.current = Date.now();
            notifyRef.current?.(
              "⚠ Couldn't sync to cloud — saved on this device, will keep retrying."
            );
          }
        },
      });
      const pending = await outbox.start();
      if (dead) return;
      outboxRef.current = outbox;
      const init = {};
      for (const slice of SLICES) {
        const arr = Array.isArray(cache[slice]) ? cache[slice] : [];
        if (!legacyCache.current) writer.prime(slice, arr);
        let map = toMap(arr);
        if (slice !== "items") {
          map = applyOpsToMap(slice, map, pending);
          lastRemote.current[slice] = map; // base for the local-change diff until the cloud answers
        }
        init[slice] = mapToArray(slice, map);
      }
      setItems(init.items);
      setSales(init.sales);
      setExpenses(init.expenses);
      setLogs(init.logs);
      setBills(init.vendorBills);
      setDailyBills(init.dailyBills);
      setLoaded(true);
    })();
    return () => {
      dead = true;
      if (outbox) outbox.stop();
      outboxRef.current = null;
      if (localDb.current) localDb.current.close();
      localDb.current = null;
    };
  }, []);

  // 2) Subscribe to the cloud; changes from any device flow in live.
  useEffect(() => {
    if (!loaded) return; // the cache + outbox must be in place before the first merge
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
          const cloud = toMap(val);
          // One-time migration of legacy array / numeric-keyed data → keyed-by-id map.
          if (isLegacyShape(val, cloud)) {
            overwriteSlice(slice, cloud).catch((e) => console.error("migrate failed", slice, e));
          }
          const base = lastRemote.current[slice];
          const wasSynced = synced.current[slice];
          synced.current[slice] = true;
          if (slice === "items") {
            // Products are only ever written by transactions; pending stock is overlaid at
            // render time (see `items`), so the raw state simply follows the cloud.
            lastRemote.current.items = cloud;
            setter((curr) =>
              mapToArray(slice, wasSynced ? mergeRemote(base, cloud, toMap(curr)) : cloud)
            );
            return;
          }
          // What the cloud says, plus every write of ours it has not acknowledged yet. This
          // holds for the FIRST snapshot after a reload too — which is what keeps a bill that
          // only exists in the outbox from being discarded.
          const pend = pendingRef.current;
          const theirs = applyOpsToMap(slice, cloud, pend);
          lastRemote.current[slice] = theirs;
          // Merge against the TRUE current state via the functional updater — NOT a ref that
          // may lag a just-dispatched local edit by a render. This is what stops an incoming
          // snapshot from silently reverting an edit/restock/delete made a moment earlier.
          setter((curr) =>
            mapToArray(slice, applyOpsToMap(slice, mergeRemote(base, theirs, toMap(curr)), pend))
          );
        },
        (err) => {
          console.error("sync read failed", slice, err);
          notifyRef.current?.("⚠ Cloud sync error — check your connection or account access.");
        }
      )
    );
    const unsubConn = subscribeConnection((up) => {
      setOnline(up);
      if (up) outboxRef.current?.retryNow(); // back online → retry anything that failed
    });
    return () => {
      unsubs.forEach((u) => u());
      unsubConn();
    };
  }, [loaded]);

  // 3) When a slice changes locally, turn the difference from the last-known cloud state into
  //    an outbox op (field-level deltas). The outbox persists it to IndexedDB, sends it, retries
  //    it on failure and replays it after a reload. buildSliceUpdate skips no-op echoes, so
  //    this is loop-safe. There is deliberately no debounce: a change is queued durably the
  //    moment it is made, not 300 ms later.
  const pushSlice = useCallback((slice, value) => {
    const outbox = outboxRef.current;
    if (!outbox) return;
    const { updates, nextMap, changed } = buildSliceUpdate(lastRemote.current[slice], value);
    if (!changed) return;
    lastRemote.current[slice] = nextMap; // optimistic; the echo snapshot confirms it
    const patch = {};
    for (const k of Object.keys(updates)) patch[slice + "/" + k] = updates[k];
    outbox.enqueue({ id: uid(), patch, label: slice });
  }, []);
  // NOTE: the `items` (products) slice is intentionally NOT delta-pushed here. All product
  // writes go through Firebase transactions (cloudWriteProduct / sendOp stock deltas / …) so
  // that concurrent stock changes from two devices can never silently overwrite each other.
  useEffect(() => {
    if (loaded) pushSlice("sales", sales);
  }, [sales, loaded, pushSlice]);
  useEffect(() => {
    if (loaded) pushSlice("expenses", expenses);
  }, [expenses, loaded, pushSlice]);
  useEffect(() => {
    if (loaded) pushSlice("logs", logs);
  }, [logs, loaded, pushSlice]);
  useEffect(() => {
    if (loaded) pushSlice("vendorBills", bills);
  }, [bills, loaded, pushSlice]);
  useEffect(() => {
    if (loaded) pushSlice("dailyBills", dailyBills);
  }, [dailyBills, loaded, pushSlice]);

  // Bill operations. Each one is a SINGLE outbox op carrying the bill change and its stock
  // change together (lib/ops.js), applied to local state immediately so the counter never waits
  // on the network. `lastRemote` is advanced in the same breath so the generic diff above does
  // not queue the same change a second time.
  const commitSaleOp = useCallback((parts, label) => {
    lastRemote.current.sales = applyPatchToMap("sales", lastRemote.current.sales, parts.patch);
    outboxRef.current?.enqueue({ id: uid(), ...parts, label });
  }, []);
  const recordSale = useCallback(
    (sale) => {
      const parts = recordSaleOp(sale);
      commitSaleOp(parts, "sale");
      const saved = parts.patch["sales/" + sale.id];
      setSales((all) => [...all.filter((x) => x.id !== sale.id), saved]);
    },
    [commitSaleOp]
  );
  const amendSale = useCallback(
    (prev, next) => {
      const parts = amendSaleOp(prev, next);
      commitSaleOp(parts, "sale-edit");
      setSales((all) =>
        all.map((x) =>
          x.id === next.id ? applyPatchToMap("sales", { [x.id]: x }, parts.patch)[x.id] : x
        )
      );
    },
    [commitSaleOp]
  );
  const voidSale = useCallback(
    (sale) => {
      commitSaleOp(voidSaleOp(sale), "sale-delete");
      setSales((all) => all.filter((x) => x.id !== sale.id));
    },
    [commitSaleOp]
  );

  // 4) Mirror to the device cache (instant next paint + offline reads). IndexedDB, one entry
  //    per record, only changed records are written — so there is no size ceiling and a single
  //    new bill costs a single small write. Nothing here is needed for durability of unsynced
  //    work: that is the outbox's job.
  useEffect(() => {
    if (!loaded) return;
    const writeCache = () => {
      const writer = cacheWriter.current;
      if (!writer) return;
      const data = dataRef.current;
      Promise.all(SLICES.map((slice) => writer.write(slice, data[slice])))
        .then(() => {
          if (legacyCache.current) {
            legacyCache.current = false;
            localStorage.removeItem(CACHE_KEY); // now safely in IndexedDB
          }
        })
        .catch((e) => console.error("cache write failed", e));
    };
    const t = setTimeout(writeCache, 400);
    const onHide = () => {
      if (document.visibilityState === "hidden") writeCache();
    };
    window.addEventListener("pagehide", writeCache);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pagehide", writeCache);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [rawItems, sales, expenses, logs, bills, dailyBills, loaded]);

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

  // Share owner-added subcategories across devices at shop/meta/customSubcats/<key> = "Name".
  // Cloud values are merged into the local list; local values the cloud does not have yet
  // (including everything added on this device before this feature existed) are pushed up once.
  const [cloudCats, setCloudCats] = useState(null); // null until the first snapshot
  const pushedCats = useRef(new Set());
  useEffect(() => {
    if (!loaded) return;
    return subscribeCustomSubcats(setCloudCats, (err) =>
      console.error("custom subcategory read failed", err)
    );
  }, [loaded]);
  useEffect(() => {
    if (!cloudCats) return;
    const have = new Set(cloudCats.map((c) => c.toLowerCase()));
    const local = new Set(customCats.map((c) => c.toLowerCase()));
    const incoming = cloudCats.filter((c) => !local.has(c.toLowerCase()));
    if (incoming.length)
      setCustomCats((cs) => {
        const seen = new Set(cs.map((c) => c.toLowerCase()));
        return [...cs, ...incoming.filter((c) => !seen.has(c.toLowerCase()))];
      });
    const patch = {};
    for (const c of customCats) {
      const k = c.toLowerCase();
      if (have.has(k) || pushedCats.current.has(k)) continue;
      pushedCats.current.add(k);
      patch[CUSTOM_SUBCATS_PATH + "/" + subcatKey(c)] = c;
    }
    if (Object.keys(patch).length)
      outboxRef.current?.enqueue({ id: uid(), patch, label: "subcategories" });
  }, [cloudCats, customCats]);

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
              {online
                ? "Online · syncing live"
                : pendingOps.length
                  ? `Offline · ${pendingOps.length} change${pendingOps.length === 1 ? "" : "s"} waiting to sync`
                  : "Offline · saved on this device"}
            </span>
            {online && pendingOps.some((o) => o.error) && (
              <button
                className="navbtn"
                style={{ border: "1px solid #C9803A", color: "#F2C48D", margin: "2px 0 4px" }}
                onClick={() => outboxRef.current?.retryNow()}
              >
                ⚠ {pendingOps.filter((o) => o.error).length} not synced — tap to retry
              </button>
            )}
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
            <Billing
              items={items}
              sales={sales}
              recordSale={recordSale}
              online={online}
              notify={notify}
              log={addLog}
            />
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
              amendSale={amendSale}
              voidSale={voidSale}
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

function SalesHistory({ sales, items, setSales, amendSale, voidSale, notify, log }) {
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

  // Bill edits and deletes go through amendSale / voidSale (StoreManager): the bill change and
  // the per-variant stock correction are ONE outbox op, so they cannot drift apart, failures
  // are surfaced and retried, and a replay never adjusts stock twice. Lines without a
  // productId (misc, or legacy) touch no stock.
  const deleteSale = (s) => {
    if (!confirm(`Delete this ${INR(s.total)} bill from ${s.date}? Stock will be added back.`))
      return;
    voidSale(s);
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
    const paid =
      editing.payment === "Udhari"
        ? Math.min(total, Math.max(0, money(+editing.paid || 0)))
        : undefined;
    const prev = sales.find((x) => x.id === editing.id);
    if (!prev) {
      setEditing(null);
      return notify("That bill no longer exists.");
    }
    const next = {
      ...prev,
      date: editing.date || prev.date,
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
    // Stock is reconciled per (product, variant) from the ORIGINAL lines of the stored bill to
    // the new lines, inside the same op as the bill change.
    amendSale(prev, next);
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
