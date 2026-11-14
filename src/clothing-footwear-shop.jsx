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
} from "./lib/sync.js";
import { todayStr, uid, money, INR, dateStr } from "./lib/format.js";
import {
  buildSeedProducts,
  normalizeProduct,
  isProductLow,
  productStock,
  mergeProductGroup,
} from "./lib/products.js";
import { exportXlsx, exportJson, importXlsx } from "./lib/backup.js";
import { S, CSS } from "./ui/styles.js";
import { LOGO_SRC } from "./lib/print.js";
import { Dashboard } from "./screens/Dashboard.jsx";
import { Billing } from "./screens/Billing.jsx";
import { RawData } from "./screens/RawData.jsx";
import { Inventory } from "./screens/Inventory.jsx";
import { Alerts } from "./screens/Alerts.jsx";
import { SalesHistory } from "./screens/SalesHistory.jsx";
import { Finance } from "./screens/Finance.jsx";
import { Stats } from "./screens/Stats.jsx";
import { Logs } from "./screens/Logs.jsx";
import { Settings } from "./screens/Settings.jsx";
import { Header, Card, Empty, Field, Modal } from "./ui/index.jsx";
import { MAX_PROOF_BYTES, uploadBillProof, deleteBillProof, PROOF_ACCEPT } from "./lib/bills.js";
import { ChartCard, inrTick } from "./ui/charts.jsx";
import {
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Bar,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
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
import { normName } from "./lib/domain.js";

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
