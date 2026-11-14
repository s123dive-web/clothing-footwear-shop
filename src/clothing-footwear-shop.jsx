import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from "react";
import { DialogHost, confirmDialog, promptDialog } from "./ui/dialogs.jsx";
import { useToasts, ToastStack } from "./ui/toasts.jsx";
import { isFirebaseConfigured, auth } from "./config/firebase.js";
import { onAuthStateChanged, signOut, sendPasswordResetEmail } from "firebase/auth";
import { FirebaseSetupNeeded } from "./screens/FirebaseSetupNeeded.jsx";
import { Login } from "./screens/Login.jsx";
import { ALL_SUBCATEGORIES } from "./lib/catalog.js";
import {
  loadCachedConfig,
  DEFAULT_SHOP_CONFIG,
  subscribeShopConfig,
  cacheConfig,
  normalizeConfig,
  saveShopConfig,
  ShopConfigContext,
} from "./config/shopConfig.js";
import { setCurrencySymbol } from "./config/currency.js";
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
  subscribeSalesSince,
  subscribeUdhariSales,
  fetchSalesRange,
  fetchAllSales,
} from "./lib/sync.js";
import {
  SALES_WINDOW_MONTHS,
  windowStart,
  monthStart,
  prevDay,
  unionSales,
  looksKeyedById,
  monthlyTotals,
} from "./lib/salesWindow.js";
import { AllSalesGate } from "./ui/AllSalesGate.jsx";
import { todayStr, uid } from "./lib/format.js";
import { buildSeedProducts, normalizeProduct, isProductLow } from "./lib/products.js";
import { exportXlsx, exportJson, importXlsx } from "./lib/backup.js";
import { S, CSS } from "./ui/styles.js";
import { LOGO_SRC } from "./lib/print.js";
import { Dashboard } from "./screens/Dashboard.jsx";
import { Billing } from "./screens/Billing.jsx";

// Every tab except Dashboard and Billing (the two the counter opens all day) is loaded on first
// use, so the initial bundle carries only what is needed to start billing.
const lazyScreen = (load, name) => lazy(() => load().then((m) => ({ default: m[name] })));
const RawData = lazyScreen(() => import("./screens/RawData.jsx"), "RawData");
const Inventory = lazyScreen(() => import("./screens/Inventory.jsx"), "Inventory");
const Alerts = lazyScreen(() => import("./screens/Alerts.jsx"), "Alerts");
const SalesHistory = lazyScreen(() => import("./screens/SalesHistory.jsx"), "SalesHistory");
const Finance = lazyScreen(() => import("./screens/Finance.jsx"), "Finance");
const Stats = lazyScreen(() => import("./screens/Stats.jsx"), "Stats");
const Udhari = lazyScreen(() => import("./screens/Udhari.jsx"), "Udhari");
const Expenses = lazyScreen(() => import("./screens/Expenses.jsx"), "Expenses");
const VendorBills = lazyScreen(() => import("./screens/VendorBills.jsx"), "VendorBills");
const DailyBills = lazyScreen(() => import("./screens/DailyBills.jsx"), "DailyBills");
const Logs = lazyScreen(() => import("./screens/Logs.jsx"), "Logs");
const Settings = lazyScreen(() => import("./screens/Settings.jsx"), "Settings");
const Admin = lazyScreen(() => import("./screens/Admin.jsx"), "Admin");

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
  const { toasts, notify, dismiss: dismissToast } = useToasts();

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

  // ---- Sales window (lib/salesWindow.js): only recent bills + all credit bills are loaded and
  //      live; older ones are fetched on demand. `salesFrom` = the earliest bill date loaded
  //      (always a month start), or null when every bill is loaded.
  const WINDOW_FROM = useMemo(() => windowStart(todayStr(), SALES_WINDOW_MONTHS), []);
  const [salesFrom, setSalesFromState] = useState(WINDOW_FROM);
  const salesFromRef = useRef(WINDOW_FROM);
  const setSalesFrom = useCallback((v) => {
    salesFromRef.current = v;
    setSalesFromState(v);
  }, []);
  const salesSrc = useRef({ recent: undefined, udhari: undefined, older: {} });
  const salesEmit = useRef(null); // re-evaluates the union after an older range was fetched
  const olderLoad = useRef(null); // the fetch in flight, so requests run one at a time
  // Revenue/profit per month for the months BEFORE the window, kept on the device so the
  // Dashboard's monthly overview does not need the old bills themselves.
  const [olderMonthly, setOlderMonthly] = useState({});
  const monthlyMeta = useRef(null); // { until, months } as stored in the device db
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
      try {
        const m = await ldb.kvGet("salesMonthly");
        if (m && m.months) {
          monthlyMeta.current = m;
          if (!dead) setOlderMonthly(m.months);
        }
      } catch (e) {
        console.error("monthly summary read failed", e);
      }
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
    // The reaction to a snapshot of `slice` (or, for windowed sales, to the union of the loaded
    // sources — `windowed` true).
    const makeHandler = (slice, setter) => (val, windowed) => {
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
      // One-time migration of legacy array / numeric-keyed data → keyed-by-id map. NEVER for a
      // windowed (partial) view: writing that back as the whole slice would delete every bill
      // outside the window.
      if (!windowed && isLegacyShape(val, cloud)) {
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
    };
    const onErr = (slice) => (err) => {
      console.error("sync read failed", slice, err);
      notifyRef.current?.("⚠ Cloud sync error — check your connection or account access.");
    };
    // Sales: two live queries (recent bills + all credit bills) instead of the whole slice.
    const subscribeWindowedSales = (handle) => {
      const src = salesSrc.current;
      src.recent = undefined;
      src.udhari = undefined;
      let parts = [];
      let full = null;
      const emit = () => {
        if (src.recent === undefined || src.udhari === undefined) return; // wait for both
        handle(unionSales(src), true);
      };
      const goFull = () => {
        // Stored data is still in a legacy shape → use the complete subscription so the
        // one-time migration runs on complete data.
        parts.forEach((u) => u());
        parts = [];
        salesEmit.current = null;
        setSalesFrom(null);
        full = subscribeSlice("sales", (v) => handle(v, false), onErr("sales"));
      };
      const part = (key) => (val) => {
        if (full) return;
        if (!looksKeyedById(val)) return goFull();
        src[key] = toMap(val);
        emit();
      };
      salesEmit.current = emit;
      parts = [
        subscribeSalesSince(WINDOW_FROM, part("recent"), onErr("sales")),
        subscribeUdhariSales(part("udhari"), onErr("sales")),
      ];
      return () => {
        parts.forEach((u) => u());
        if (full) full();
        salesEmit.current = null;
      };
    };
    const unsubs = slices.map(([slice, setter]) => {
      const handle = makeHandler(slice, setter);
      if (slice === "sales" && WINDOW_FROM) return subscribeWindowedSales(handle);
      return subscribeSlice(slice, (v) => handle(v, false), onErr(slice));
    });
    const unsubConn = subscribeConnection((up) => {
      setOnline(up);
      if (up) outboxRef.current?.retryNow(); // back online → retry anything that failed
    });
    return () => {
      unsubs.forEach((u) => u());
      unsubConn();
    };
  }, [loaded, WINDOW_FROM, setSalesFrom]);

  // Fetch older bills once (not live) and add them to what is loaded. `from` = the earliest
  // date wanted (rounded down to its month start); null = everything. Resolves true when the
  // range is loaded, false when it could not be fetched (offline).
  const saveMonthly = useCallback(
    (months) => {
      const rec = { until: WINDOW_FROM, months };
      monthlyMeta.current = rec;
      setOlderMonthly(months);
      localDb.current?.kvSet("salesMonthly", rec).catch((e) => console.error("summary save", e));
    },
    [WINDOW_FROM]
  );
  const loadOlderSales = useCallback(
    async (from) => {
      for (;;) {
        const cur = salesFromRef.current;
        if (cur === null) return true;
        const target = from ? monthStart(from) : null;
        if (target && target >= cur) return true;
        if (olderLoad.current) {
          await olderLoad.current.catch(() => {});
          continue; // re-check against what the previous request loaded
        }
        const timeout = new Promise((_, rej) =>
          setTimeout(() => rej(new Error("timed out (offline?)")), 20000)
        );
        const run = Promise.race([
          target ? fetchSalesRange(target, prevDay(cur)) : fetchAllSales(),
          timeout,
        ]).then((val) => {
          if (salesFromRef.current === null) return; // switched to the full subscription meanwhile
          if (!looksKeyedById(val)) throw new Error("sales are stored in a legacy shape");
          const got = toMap(val);
          salesSrc.current.older = { ...salesSrc.current.older, ...got };
          setSalesFrom(target);
          salesEmit.current?.();
          if (!target) {
            // Everything is in hand → refresh the saved monthly summary for the old months.
            const before = Object.values(got).filter((x) => String(x.date || "") < WINDOW_FROM);
            saveMonthly(monthlyTotals(before));
          }
        });
        olderLoad.current = run;
        try {
          await run;
          return true;
        } catch (e) {
          console.error("loading older bills failed", e);
          return false;
        } finally {
          olderLoad.current = null;
        }
      }
    },
    [WINDOW_FROM, setSalesFrom, saveMonthly]
  );
  // Every bill currently known (cloud + un-acked local writes), as an array — for backup.
  const allLoadedSales = () => mapToArray("sales", lastRemote.current.sales);

  // Once per device per month: summarise the months that have just left the window.
  const monthlyDone = useRef(false);
  useEffect(() => {
    if (!loaded || !online || !WINDOW_FROM || monthlyDone.current) return;
    const have = monthlyMeta.current;
    if (have && have.until >= WINDOW_FROM) return;
    monthlyDone.current = true;
    fetchSalesRange((have && have.until) || "0000-00-00", prevDay(WINDOW_FROM))
      .then((val) => {
        if (!looksKeyedById(val)) return;
        saveMonthly({ ...((have && have.months) || {}), ...monthlyTotals(toMap(val)) });
      })
      .catch((e) => {
        monthlyDone.current = false;
        console.error("monthly summary failed", e);
      });
  }, [loaded, online, WINDOW_FROM, saveMonthly]);

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
  const addCategory = useCallback(async () => {
    const raw = await promptDialog({
      title: "New subcategory",
      label: "Subcategory name",
      placeholder: "e.g. Lehenga",
      confirmLabel: "Add",
    });
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
    [config, notify]
  );

  const resetMyPassword = async () => {
    if (!user?.email) return;
    if (
      !(await confirmDialog({
        title: "Reset password",
        message: `Send a password reset link to ${user.email}?`,
        confirmLabel: "Send link",
      }))
    )
      return;
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

  const exportData = async (fmt) => {
    // A backup must contain EVERY bill, not just the loaded window.
    let allSales = sales;
    let partial = "";
    if (salesFromRef.current !== null) {
      notify("Preparing backup — loading full sales history…");
      if (await loadOlderSales(null)) allSales = allLoadedSales();
      else partial = salesFromRef.current;
    }
    const data = { items, sales: allSales, expenses, logs, vendorBills: bills, dailyBills };
    const fname = `${slugify(config.name)}-${todayStr()}${partial ? "-PARTIAL-since-" + partial : ""}.${fmt === "xlsx" ? "xlsx" : "json"}`;
    try {
      if (fmt === "xlsx") await exportXlsx(data, fname);
      else exportJson(data, fname);
      addLog("backup", `Backup downloaded (${fmt.toUpperCase()})${partial ? " — PARTIAL" : ""}`);
      notify(
        partial
          ? `⚠ Offline — this backup only has bills since ${partial}. Export again when online.`
          : `Backup downloaded (${fmt.toUpperCase()})`
      );
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
      if (
        !(await confirmDialog({
          title: "Restore backup",
          message:
            "Restore this backup? It will REPLACE all current data everywhere it syncs. This cannot be undone.",
          confirmLabel: "Replace everything",
          danger: true,
        }))
      )
        return;
      // Replacing "all current data" needs all current bills loaded, so the ones that are not
      // in the backup are removed too — not just those inside the loaded window.
      if (!(await loadOlderSales(null)))
        return notify("⚠ Restore needs an internet connection — nothing was changed.");
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
          <Suspense fallback={<div style={{ padding: 40, color: "#667" }}>Loading…</div>}>
            {!loaded ? (
              <div style={{ padding: 40, color: "#667" }}>Loading store data…</div>
            ) : tab === "dashboard" ? (
              <Dashboard
                items={items}
                sales={sales}
                lowStock={lowStock}
                goBilling={() => setTab("billing")}
                salesFrom={salesFrom}
                olderMonthly={olderMonthly}
                loadOlderSales={loadOlderSales}
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
                recordSale={recordSale}
                salesFrom={salesFrom}
                loadOlderSales={loadOlderSales}
                notify={notify}
                log={addLog}
              />
            ) : tab === "finance" && tabEnabled("finance") ? (
              <AllSalesGate salesFrom={salesFrom} loadOlderSales={loadOlderSales} allowPartial>
                <Finance sales={sales} expenses={expenses} />
              </AllSalesGate>
            ) : tab === "stats" ? (
              <AllSalesGate salesFrom={salesFrom} loadOlderSales={loadOlderSales} allowPartial>
                <Stats sales={sales} expenses={expenses} items={items} />
              </AllSalesGate>
            ) : tab === "udhari" ? (
              <Udhari sales={sales} setSales={setSales} notify={notify} log={addLog} />
            ) : tab === "expense" ? (
              <Expenses
                expenses={expenses}
                setExpenses={setExpenses}
                notify={notify}
                log={addLog}
              />
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
              <AllSalesGate salesFrom={salesFrom} loadOlderSales={loadOlderSales}>
                <Admin
                  items={items}
                  setSales={setSales}
                  setExpenses={setExpenses}
                  setLogs={setLogs}
                  user={user}
                  notify={notify}
                  log={addLog}
                />
              </AllSalesGate>
            ) : (
              <Dashboard
                items={items}
                sales={sales}
                lowStock={lowStock}
                goBilling={() => setTab("billing")}
                salesFrom={salesFrom}
                olderMonthly={olderMonthly}
                loadOlderSales={loadOlderSales}
              />
            )}
          </Suspense>
        </main>

        <ToastStack toasts={toasts} dismiss={dismissToast} />
        <DialogHost />
      </div>
    </ShopConfigContext.Provider>
  );
}
