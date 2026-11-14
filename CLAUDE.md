# CLAUDE.md — Clothing & Footwear Shop Manager

POS + inventory app for a ladies clothing & footwear shop. **It is in live daily use at a shop
counter, mostly on a phone, with real sales data.** Read the hard rules before changing anything.

Status: the five hardening phases (0 baseline · 1 data integrity · 2 speed & offline ·
3 counter usability · 4 optional features · 5 rules & hardening) are complete, each on its own
`hardening/phase-N` branch and pull request. `docs/QA.md` is the QA report, including every
manual check still owed on a real phone.

## Hard rules

1. **Phased and gated.** One hardening phase at a time. End each phase with the report format at
   the bottom and the word STOP. Do not start the next phase until the owner replies "proceed".
2. **No regressions.** `npm test`, `npm run lint` and `npm run build` must pass before every
   commit. Never delete or weaken an existing test to make it pass. The 188 baseline unit tests
   stay green.
3. **Behaviour-preserving unless the phase says otherwise.** Refactors must not change what the
   user sees, the data written, or the RTDB paths.
4. **Never break live data.** No change to the shape of `shop/items`, `shop/sales`,
   `shop/expenses`, `shop/logs`, `shop/vendorBills`, `shop/dailyBills`, `shop/shopConfig`,
   `shop/meta` without a backward-compatible reader and a written migration note. Old records
   must still load. New fields must be optional.
5. **Never run against production Firebase.** All automated tests use the Firebase Emulator
   Suite or mocks. Do not deploy rules. Do not touch the values in `src/config/firebase.js`.
6. **Branches.** Work on `hardening/phase-N`, small commits, one PR per phase. **Never push to
   `main`** — a push to `main` deploys to the live shop.
7. **Say so if unsure.** If a listed bug cannot be reproduced, report that instead of "fixing"
   it blindly.
8. **Keep the visual style** — inline `S` style object, existing colours, emoji icons. No UI
   framework, no TypeScript migration, no state library.

## Architecture

- **Stack:** React 18 + Vite 5 (plain JS/JSX), Firebase JS SDK 12 (Auth email/password,
  Realtime Database, Storage), recharts, SheetJS `xlsx` (from cdn.sheetjs.com), pdfjs-dist.
- **Hosting:** GitHub Pages, built and deployed by `.github/workflows/deploy.yml` on push to
  `main`. Production base path is `/clothing-footwear-shop/`.
- **Entry:** `index.html` → `src/main.jsx` (ErrorBoundary, `window.storage` shim,
  `UpdatePrompt`) → `src/clothing-footwear-shop.jsx`.
- **`src/clothing-footwear-shop.jsx`** (~1,150 lines) is the root only: `App` (auth gate) and
  `StoreManager`, which owns all state (items, sales, expenses, logs, vendorBills, dailyBills,
  config, customCats), the sync effects, the sales window, the sidebar and the toast.
- **`src/screens/<Name>.jsx`** — one file per screen: Login, FirebaseSetupNeeded, Dashboard
  (+ `DashboardCharts.jsx`), Billing, Inventory (+ProductForm, RestockModal), SalesHistory,
  Finance (flagged off), Stats (Reports), Udhari, Expenses, DailyBills (Supplier Bills),
  Alerts, VendorBills, RawData (Data Import), Logs, Settings, Admin. **Dashboard and Billing
  are in the main chunk; every other tab is `React.lazy`** (see the `lazyScreen` list in the
  root). Dashboard's chart sections are lazy too, so `recharts` loads only when charts render.
- **`src/ui/`** — `index.jsx` (Header, Card, Field, Empty, Section, Modal, ColorDot,
  VariantChip), `styles.js` (`S`, `CSS`), `charts.jsx` (shared recharts helpers — import ONLY
  from lazy modules), `hooks.js` (`useDebouncedValue`, `useStableCallback`, `usePagedLimit`),
  `AllSalesGate.jsx`, `UpdatePrompt.jsx`.
- **Counter UX building blocks (Phase 3)** — use these, never the browser's own:
  - `ui/dialogs.jsx`: `await confirmDialog({ title, message, confirmLabel, danger })`,
    `promptDialog`, `alertDialog`. **No native `confirm()` / `prompt()` / `alert()` anywhere** —
    the e2e suites fail on any native dialog.
  - `ui/toasts.jsx`: `notify(message, { action: { label, run }, kind, duration })`. Errors
    (`kind: "error"` or a message starting with `⚠`) stay until dismissed; a toast with an
    action stays 5 s. Reversible deletes (bill, product, expense) do not confirm — they offer
    **Undo**.
  - `ui/index.jsx`: `Modal` (focus trap, top-most Esc, focus restore, `data-autofocus`),
    `PageSkeleton` / `Skeleton` (never a bare "Loading…"), `Empty` (always give it one action
    button as a child), `focusFirstField`.
  - `lib/syncStatus.js`: `syncSummary` / `syncText` — the sidebar line and the phone pill.
  - Billing: held bills live in localStorage `cfs-held-bills-v1` (device-local, not synced).
- **`src/i18n/`** — `strings.js` (table keyed by the English text → Hindi, Marathi),
  `index.jsx` (`LangProvider`, `useLang()` → `{ t, lang, setLang }`, `LangSelect`). Language is
  a per-device preference (`cfs-lang-v1`), default English. `Header` titles/subs and `Empty`
  text are translated automatically when they are plain strings found in the table. Stored
  data is language-neutral (e.g. `payment` stays `"Cash"`); only labels are translated.
  Translated today: navigation, screen titles, sign-in, the whole Billing screen, receipt,
  sync status, dialog buttons, common empty states. Everything else falls back to English.
- **Accessibility rules** (enforced by `e2e/a11y.spec.js` on every tab): every control has an
  accessible name (a wrapping `<label>`/`Field`, or `aria-label` — do NOT add `aria-label` to
  an input that already has a label, it overrides it); text contrast ≥ 4.5:1; on phones every
  control ≥ 44 px (`.tap`, `.step`, and the `(pointer: coarse)` block in `ui/styles.js`); no
  horizontal scrolling at 390 px.
- **Feature flags** — `src/config/features.js`. Every Phase 4 feature is `false` there and
  must stay `false` until the owner approves it; switching one on = change the value, merge,
  deploy. `featureOn(name)` is the only check. In dev / emulator builds a flag can also be
  switched on per browser via localStorage `cfs-features-dev` (that is how e2e tests reach
  them; `enableFeatures(page, [...])`); production builds ignore that override. **A feature
  that is off must show nothing and write nothing** — `features.spec.js` pins this.

  | Flag | What it adds | Where |
  |---|---|---|
  | `paymentSettings` | UPI ID, uploadable payment QR, receipt width 58/80 mm | Settings, `lib/print.js` |
  | `billNumbers` | `2026-27/0001` per financial year; provisional offline | `lib/billNumbers.js`, root numbering effect |
  | `whatsappReceipt` | "Send on WhatsApp" (`wa.me` link, plain-text bill) | `lib/whatsapp.js` |
  | `dayClose` | Day Close tab: cash / UPI / credit, expected vs counted | `lib/dayClose.js`, `screens/DayClose.jsx` |
  | `backupReminder` | "Last backup N days ago" + weekly reminder on Dashboard | `lib/backupReminder.js` |
  | `customerLedger` | Customers tab, outstanding, WhatsApp reminder | `lib/customers.js`, `screens/Customers.jsx` |
  | `restockSuggestions` | Restock tab: sell-through, days left, order qty | `lib/restock.js`, `screens/Restock.jsx` |
  | `gstInvoice` | HSN + GST rate per product; CGST/SGST split on receipt | `lib/gst.js` |
  | `returns` | Return / exchange from a bill; credit on a new bill | `lib/returns.js`, `ops.returnSaleOp` |
  | `barcode` | Camera scan in Billing; Code 128 labels | `lib/barcode.js`, `ui/BarcodeScanner.jsx` |
  | `staffAccounts` | owner / staff roles | `config/role.js`, `screens/StaffAccounts.jsx`, rules |

- **Roles** (`staffAccounts`): `RoleGate` in the root resolves `owner` / `staff` / `none` from
  `shop/users/<uid>` before mounting anything; screens use `useIsStaff()`. Staff get
  `STAFF_TABS`, subscribe only to `STAFF_SLICES`, and never see cost / profit controls. **The
  UI is not the security boundary — `database.rules.json` is**, and RTDB cannot hide fields: a
  staff account can read cost and profit through the API.
- **`src/lib/`** — pure, unit-tested helpers: `sync.js` (array↔map bridge, `buildSliceUpdate`,
  3-way `mergeRemote`, `updateItemAtomic`, `sendOp`, sales queries), `ops.js`, `outbox.js`,
  `localdb.js`, `salesWindow.js`, `products.js` (variants, stock maths, `normalizeProduct`),
  `cloudProducts.js` (product transactions), `catalog.js`, `stats.js`, `dailyBills.js`,
  `bills.js` (Storage proofs), `backup.js` (JSON/XLSX export, XLSX import), `parse.js` (Data
  Import parsing), `format.js` (INR, money, dates, uid), `print.js` (receipt), `domain.js`.
  `xlsx` and `pdfjs-dist` are dynamic imports inside `backup.js` / `parse.js` — never import
  them statically.
- **`src/config/`** — `firebase.js` (live config + emulator switch), `shopConfig.js`,
  `currency.js`.
- **PWA** — `vite-plugin-pwa` (`generateSW`, `registerType: "prompt"`). The service worker
  precaches the app shell and all tab chunks (xlsx / pdf are cached on first use).
  `src/ui/UpdatePrompt.jsx` registers it in production builds only and shows "Update available"
  — the new version activates only when the user taps Reload. Never switch to `autoUpdate`.

### How sync works (since Phase 1)

Three device-side pieces, all in `src/lib/`:

- **`localdb.js`** — IndexedDB database `cfs-local-v1` with stores `cache` (one entry per
  record, key `slice\0id`), `outbox`, `kv`. Falls back to an in-memory store if IndexedDB is
  unavailable (`durable: false`). `createCacheWriter` writes only records that changed.
- **`outbox.js`** — durable queue of cloud writes. An op is persisted **before** it is sent
  (write-ahead) and removed only on server ack; failed ops stay queued, are reported, retried
  with backoff and on reconnect; everything still queued is replayed on the next start.
  Delivery is at-least-once, so every op must be idempotent.
- **`ops.js`** — pure helpers. An op is `{ id, seq, at, label, patch?, stock? }`:
  - `patch`: `{ "<path under shop/>": value | null }` — absolute sets/deletes, sent as ONE
    multi-path `update(shop, patch)`. Naturally idempotent.
  - `stock`: `[{ productId, variantId, delta }]` — sent as one `runTransaction` per product
    whose body is `applyStockOp`: it skips the op if `product.appliedOps[op.id]` exists,
    otherwise applies the deltas and records the op id in that ledger. This is what makes a
    replay unable to decrement twice.

Flow in `StoreManager`:

1. **Boot:** open the local db → load cache + pending ops → state = cache with pending
   `patch`es re-applied → `loaded`. (First run after upgrading: the old `cfs-cache-v1`
   localStorage key is read once, written to IndexedDB, then removed.)
2. **Subscribe** (`onValue` per slice, after `loaded`). For every snapshot — including the
   first — non-item slices become `applyOps(mergeRemote(base, cloud+pending, current), pending)`.
   Pending writes are therefore never discarded by an incoming snapshot.
3. **Local change to sales / expenses / logs / vendorBills / dailyBills:** an effect (no
   debounce) diffs state against the last-known cloud map (`buildSliceUpdate`) and enqueues the
   field-level difference as a `patch` op.
4. **Bills** use one code path — `recordSale`, `amendSale`, `voidSale` in `StoreManager`, built
   from `recordSaleOp` / `amendSaleOp` / `voidSaleOp`. Each is a SINGLE op carrying the bill
   patch and its stock deltas, applied to local state immediately. Billing never awaits the
   network.
5. **items:** `rawItems` state follows the cloud; what screens receive as `items` is
   `overlayPendingStock(rawItems, pendingOps)` (pending stock ops not yet in a product's
   ledger). Product add/edit/restock/delete are still direct transactions (`cloudWriteProduct`
   etc.) and still need a connection.
6. **Cache:** 400 ms after any change (and on `pagehide`/hidden) the changed records are written
   to IndexedDB. The cache stores RAW items — never the overlaid numbers.
7. **Custom subcategories** sync at `shop/meta/customSubcats/<key> = "Name"`; local-only values
   are pushed up once the first snapshot arrives.

8. **Sales window** (`lib/salesWindow.js`, `SALES_WINDOW_MONTHS = 3`; `0` restores "load
   everything live"). `sales` state = union of: `recent` (live query, bills dated on/after the
   first day of the month 3 months back), `udhari` (live query, every credit bill of any age),
   `older` (one-shot fetches). `salesFrom` = earliest date loaded, `null` = all.
   `loadOlderSales(from | null)` fetches more — used by Sales History ("Load 3 more months" /
   "Load all bills" / an earlier "from" date), Dashboard (viewing an old day or a long period),
   `AllSalesGate` around Reports / Finance / Admin, and by backup export and restore (both load
   everything first; an offline export is named `…-PARTIAL-since-<date>`).
   - The union is fed to the same snapshot handler as a full slice, so merge / outbox logic is
     unchanged. A windowed view is NEVER written back as the slice; if stored sales are in a
     legacy (non-id-keyed) shape the code falls back to the full subscription.
   - Dashboard's monthly overview uses `olderMonthly` (IndexedDB `kv` key `salesMonthly`:
     revenue/profit/bill count per month before the window), refreshed once a month per
     device and whenever everything is loaded.
   - Needs `.indexOn: ["date", "payment"]` on `shop/sales` (in `database.rules.json`, **not
     deployed by us**). Without the index the queries still return correct data but download
     every bill first.
   - Known limits: best-seller ★ / customer autocomplete in Billing only see loaded bills; a
     bill back-dated to before the window disappears from view once synced (it is in the
     cloud and shows after "load older"); `older` data is static until reload.

9. **Refused writes.** When the server answers "permission denied" (rules, validation) three
   times, the op is `stuck`: no more timed retries, it stays in the outbox, the sidebar shows
   "N not synced", and the `ui/SyncProblems.jsx` dialog offers Retry or Discard (discard
   reloads the page). Network errors never make an op stuck.
10. **Error reports.** `lib/errorReport.js` (pure) + `lib/reporter.js` (wiring): crashes
    (`ErrorBoundary`, `window.onerror`, unhandled rejections) and outbox failures are written to
    `shop/meta/errors/<id>` — throttled, de-duplicated, capped at 50, never containing shop
    data. Shown in Admin → Error reports.
11. Bills read from the cloud pass through `safeSale` (always an array of `lines`), so a
    malformed record cannot crash a screen. It is not written back.

Sidebar status: `Online · syncing live` / `Offline · N changes waiting to sync` /
`⚠ N not synced — tap to retry` (failed ops while online).

## RTDB data model

Everything lives under `shop/`. Slices are **maps keyed by record id** (`shop/sales/<id>`);
legacy arrays are migrated on first read (`isLegacyShape`). RTDB drops `undefined`, empty
arrays and empty objects, so every reader must tolerate missing fields.

| Path | Shape |
|---|---|
| `shop/items/<id>` | `{ id, name, brand, category (group: Clothing/Footwear/Accessories), subcategory, code, supplier, imageUrl, notes, icon, purchasePrice, sellingPrice, mrp, discountPct, variants: [{ id, size, color, sku, stockQty, lowAt }], stock (cached sum), createdAt, updatedAt, version, appliedOps?: { <opId>: <ms> } }` |
| `shop/sales/<id>` | `{ id, date "YYYY-MM-DD", time, lines: [{ name, qty, price, buyPrice, amount, size, color, category, subcategory, productId?, variantId?, misc? }], total, profit, payment "UPI"/"Cash"/"Udhari", subtotal?, discount?, discountPct?, customer?, mobile?, paid? (Udhari), paidMode?, payments?: [{ id, date, time, amount, mode }] }` |
| `shop/expenses/<id>` | `{ id, date, desc, amount, category? }` |
| `shop/logs/<id>` | `{ id, at (ms), date, time, type (sale/inventory/expense/import/backup/bill), message }` — capped at 2000, newest first |
| `shop/vendorBills/<id>` | vendor purchase bill (vendor, date, amount, status paid/unpaid/partial, proof file refs…) — see `VendorBills` and `dailyToVendorBill` |
| `shop/dailyBills/<id>` | supplier bill, mirrored into `vendorBills` — see `src/lib/dailyBills.js` (`makeDailyBill`) |
| `shop/shopConfig` | single object: `{ name, tagline, address, phone, email, gstin, currency, logoUrl (may be an inline base64 data-URL), receiptFooter, footwearSizeMin, footwearSizeMax }` |
| `shop/meta/seeded` | `true` once the demo catalogue has been seeded (stops it resurrecting) |
| `shop/meta/customSubcats/<key>` | `"Display Name"` — owner-added subcategories (key = `subcatKey(name)`) |
| `shop/meta/errors/<id>` | `{ at, kind: "crash"/"sync", message, stack?, device, user, where?, op?, paths?, attempts? }` — newest 50 |
| `shop/meta/billCounters/<fy>` | (flag `billNumbers`) `{ next, recent: { <saleId>: n } }` — transaction counter |
| `shop/meta/lastBackupAt` | (flag `backupReminder`) ms timestamp of the last full backup |
| `shop/dayCloses/<YYYY-MM-DD>` | (flag `dayClose`) `{ date, opening, expected, counted, diff, at }` |
| `shop/users/<uid>` | (flag `staffAccounts`) `{ role: "staff", email, addedAt }` |

Optional fields added by Phase 4 features (present only once the feature has been used):

- sale: `billNo`, `billNoProv`, `createdAt` (billNumbers); `creditUsed`, `creditOf` (returns);
  `type: "return"`, `refOf`, `refBillNo` on a return bill, whose `total` / `profit` / line `qty`
  / `amount` are **negative**; line `returned` on the original bill.
- sale line: `gstRate`, `hsn` (gstInvoice).
- item: `hsn`, `gstRate` (gstInvoice).
- shopConfig: `upiId`, `paymentQrUrl`, `receiptWidth` (paymentSettings).

Storage: bill proof files at `shop/bills/<billId>/<file>` (≤ 10 MB).

Rules (`database.rules.json`, `storage.rules`) — **never deployed by us; the owner deploys**:
- Owner (by email): full access. Staff (listed at `shop/users/<uid>`): limited, see the file
  header. Everyone else: nothing.
- `shop/sales/.indexOn: ["date", "payment"]`.
- `.validate` on `shop/sales/<id>` and `shop/items/<id>`: id + date (YYYY-MM-DD) + numeric
  total; name; numeric non-negative prices and stock; numeric line qty / amount / price.
  `total` and `qty` may be negative (return bills). Validation applies to the owner too and is
  not run on deletes.
- **`src/lib/validate.js` is the same checks in JavaScript** (used by Admin → "Check data
  against rules"). `src/lib/validate.samples.js` feeds identical valid / invalid samples to
  the unit tests and to `e2e/rules.spec.js`. Change the rules → change `validate.js` and the
  samples in the same commit.
- A record that fails validation can be read and deleted but not edited. That is why the data
  check exists and why it must be run before a rules deploy.

Device-local only: IndexedDB `cfs-local-v1` (cache + outbox); localStorage
`cfs-shop-config-v1` (config cache) and `cfs-custom-subcats-v1` (local copy of the synced
subcategories). `cfs-cache-v1` (localStorage) is legacy and removed after its one-time move.

### Migration notes

Every data-model change must be recorded here: what changed, why old records still load, and
how to roll back.

**Phase 1 — `shop/items/<id>/appliedOps` (new, optional).** Map of outbox op id → client
timestamp (ms) for stock ops already applied to that product. Written only by bill
operations. Pruned to entries newer than 90 days once it exceeds 150 entries.
- Old records (no `appliedOps`) load and behave exactly as before; the field is created on
  the first bill that touches the product.
- `normalizeProduct` passes the field through untouched; `cloudWriteProduct` preserves it.
- An OLD app version (cached JS on another device) rewrites products through its own
  `normalizeProduct`, which drops the field. Effect: only if that happens between a stock op
  being applied and its replay could the op be applied twice. Stock numbers stay valid
  numbers either way.
- Roll back: revert the code; the extra field is ignored by old code and can be left in place
  or deleted (`shop/items/*/appliedOps`).

**Phase 1 — `shop/meta/customSubcats` (new, optional).** `{ <key>: "Name" }`. Old versions only
read `shop/meta/seeded` and ignore it. Roll back: revert the code; delete the node if wanted.

**Phase 1 — bill writes.** Bills are still plain records at `shop/sales/<id>` with the same
fields; nothing about their shape changed. They are now written by a multi-path update at
`shop/` instead of at `shop/sales/` — same resulting data.

**Phase 5 — `shop/meta/errors` (new, optional)**, written only when an error happens. Old
versions ignore it. The validation rules do not change any shape; they refuse writes that do not
match the existing one. Roll back: revert the rules file (or simply do not deploy it).

**Phase 4 — optional additions only, each written only when its flag is on.** See the tables
above. Notes on compatibility:
- `normalizeConfig` / `normalizeProduct` pass the new optional fields through; old records
  load unchanged; with all flags off nothing new is ever written (`features.spec.js`).
- Stock ops are now sign-aware (`outQty = qty − returned`): identical for ordinary bills; a
  return bill's negative quantities restock. An OLD app version that deletes a bill which has
  returns would restock the full quantity (it does not know `returned`) — turn `returns` on
  only once every device runs this version.
- A return bill has negative totals. Old versions display it as a negative bill and reports net
  it off; they must not be used to edit or delete it.
- `database.rules.json` now has per-path staff grants. With no `shop/users` entries it behaves
  exactly like the previous owner-only rules. **Not deployed by us.**
- Roll back any feature: set its flag to `false`. Data it wrote stays and is ignored, except
  return bills (they keep netting off sales, which is correct) and bill numbers (still shown).

**Phase 3 — no cloud data-model change.** New device-local localStorage keys only:
`cfs-held-bills-v1` (held bills), `cfs-lang-v1` (language).

**Phase 2 — no cloud data-model change.** `database.rules.json` gains
`shop/sales/.indexOn: ["date", "payment"]` (an index, not a shape change; safe to deploy and to
remove). New device-local IndexedDB `kv` entry `salesMonthly`.

**Phase 1 — device cache.** Moved from localStorage `cfs-cache-v1` to IndexedDB
`cfs-local-v1`. Not cloud data. Roll back: old code simply rebuilds its localStorage cache
from the cloud on first load.

## Running things

Node `^20.19 || >=22.12` (CI uses 24). `npm ci` is verified on Node 20, 22 and 24.

| Command | What it does |
|---|---|
| `npm ci` | Install. Needs network access to `cdn.sheetjs.com` (the `xlsx` tarball). |
| `npm run dev` | Vite dev server against the **live** Firebase project — avoid; use the next one. |
| `npm run emulators` | Firebase emulators: auth :9099, database :9000, storage :9199 (project `demo-cfs-shop`). Needs Java 21+. |
| `npm run dev:emulator` | Vite dev server (`--mode emulator`) pointed at the emulators. |
| `npm test` | Vitest unit tests (`src/**/*.test.js`). |
| `npm run lint` | ESLint. |
| `npm run build` | Production build to `dist/`. |
| `npm run test:e2e` | Playwright (`e2e/*.spec.js`); starts the emulators, an emulator-mode dev server on :5174 and (for the `pwa` project) a production build + `vite preview` on :5175. First time: `npx playwright install chromium`. |

### Emulator switch

`src/config/firebase.js` uses the emulators only when `VITE_FIREBASE_EMULATOR=1` (set by the
committed `.env.emulator`, loaded by `vite --mode emulator`) **and** `import.meta.env.PROD` is
false. A production build can never point at an emulator, and an emulator session never uses
the live config — it initialises a throw-away `demo-cfs-shop` project instead. The emulators
load the real `database.rules.json` / `storage.rules`, so the e2e owner account uses the
owner email those rules are locked to (it only exists inside the emulator).

To try the app by hand without touching live data: run `npm run emulators` and
`npm run dev:emulator` in two terminals, create a user in the auth emulator with the owner
email (see `resetEmulator` in `e2e/helpers.js`), and sign in.

### E2E layout

- `e2e/helpers.js` — emulator reset/admin REST helpers, `login`, `gotoTab`, `addProduct`,
  `addToCart`, `blockDatabase` / `unblockDatabase` (simulate the shop's internet dropping).
- `e2e/smoke.spec.js` — pins current behaviour of the six core flows.
- `e2e/phase1-bugs.spec.js` — regression tests for the Phase 1 data-integrity bugs (they were
  `test.fail` reproductions in Phase 0) plus offline edit/delete/expense and cache-migration
  coverage. To reproduce a new bug first, write the test asserting correct behaviour and mark
  it `test.fail`; remove the mark in the commit that fixes it.
- `e2e/window.spec.js` — sales window: older bills on demand, old credit bills always loaded,
  full backup/restore, deletes never touch unloaded bills.
- `e2e/pwa.spec.js` — runs against the PRODUCTION build (`pwa` project) with every non-local
  request aborted: manifest, offline app shell, no auto-activation of a new version.
- `e2e/usability.spec.js` — Undo, in-app dialogs, focus trap, toast lifetimes, steppers, hold /
  resume, quick-pick, sticky phone bar, sync count, empty-state actions, skeleton.
- `e2e/a11y.spec.js` + `e2e/a11y-audit.js` — automated audit of labels, contrast and tap targets
  on every tab and dialog (desktop + phone), plus sideways-scroll and focus-ring checks.
- `e2e/i18n.spec.js` — language toggle: menus, Billing, toast, receipt; persistence.
- Helpers: `dialogClick(page, title, button)` answers an in-app dialog; `receiptHtml(page,
  click)` captures a printed receipt.
- `e2e/features.spec.js` — Phase 4 features (flags switched on per test) and the "all flags
  off shows and writes nothing" check. `e2e/barcode.spec.js` — typed code, label barcode decoded
  with ZXing, fake-camera scan. `e2e/staff.spec.js` — owner adds / removes staff, staff UI.
  `e2e/rules.spec.js` — `@firebase/rules-unit-testing` against `database.rules.json`.
- `e2e/hardening.spec.js` — malformed bill, error reporting, refused write (retry / discard),
  data check.
- One worker, shared emulator; every test wipes the database first. Tests never use
  `page.waitForTimeout` to "wait for sync" — poll the emulator with `eventually(...)`.

### CI (`.github/workflows/deploy.yml`)

- `ci` — every push and pull request: `npm ci` → lint → unit tests → build.
- `e2e` — every push and pull request: Playwright against the emulators.
- `deploy` — only on `main` (push / manual), only after `ci` passes. `e2e` is reported but does
  not gate the deploy.

## Regression checklist

Run before every commit: `npm test && npm run lint && npm run build`. Run before every PR:
`npm run test:e2e`.

Automated (Playwright smoke, must stay green):

- [ ] Login → Dashboard renders, sidebar shows "Online · syncing live" and the signed-in email
- [ ] Add product with 3 variants → appears in Inventory with correct total stock and price;
      cloud record has the 3 variants
- [ ] Sell 2 units of one variant → only that variant drops by 2; one bill with correct
      total/profit; bill visible in Sales History; receipt HTML has shop name, total, variant,
      payment mode
- [ ] Delete that bill → stock restored, bill gone
- [ ] Udhari sale with part payment → `paid`/`paidMode` stored; outstanding shown per customer
      and in the summary card
- [ ] JSON export → wipe → import on a fresh profile → same items/sales/expenses

Automated (Playwright `phase1-bugs.spec.js`, must stay green):

- [ ] Double-tap on Complete sale → one bill, one stock decrement
- [ ] Offline sale completes: cart clears, "Saved on this device … will sync" toast
- [ ] Offline sale survives a reload and syncs once back online (stock decremented once)
- [ ] Tab killed right after Complete sale / Delete → bill and stock still agree after reopening
- [ ] > 5 MB dataset still opens offline from the cache
- [ ] Custom subcategory added on one device appears on another
- [ ] Edit bill qty → exact stock correction, total/profit updated
- [ ] Offline bill delete → pending count shown, synced after reopening online
- [ ] Offline expense survives a reload and syncs
- [ ] Old localStorage cache is moved to IndexedDB once and removed

Automated (Playwright `window.spec.js` + `pwa.spec.js`, must stay green):

- [ ] Only recent bills load; "Load all bills" / an earlier from-date loads older ones; loading
      writes nothing
- [ ] An old unpaid credit bill is in the Udhari book
- [ ] Reports load the full history once
- [ ] Deleting a recent bill leaves unloaded bills untouched
- [ ] Backup has every bill; restore removes bills outside the window too
- [ ] Monthly summary for pre-window months is saved on the device
- [ ] Manifest + icons served; app shell opens offline; new version waits for the user

Automated (Playwright `usability.spec.js`, `a11y.spec.js`, `i18n.spec.js`, must stay green):

- [ ] Delete bill / product / expense → Undo restores it; the offer disappears after 5 s
- [ ] Destructive confirm is in-app, red, Cancel focused, Esc cancels; focus stays in the dialog
- [ ] Warning toast stays until dismissed; info toast goes away
- [ ] Qty steppers ≥ 44 px and capped at stock; amount fields open the numeric keypad
- [ ] Hold a bill, bill someone else, reload, resume
- [ ] Quick-pick row offers recently sold products
- [ ] Phone: total + Complete pinned to the bottom of the screen
- [ ] Offline: "N bills waiting to sync" shown; clears when back online
- [ ] Every empty screen has one action; skeleton while a tab loads
- [ ] Audit: no unlabelled control, no text under AA contrast, no tap target under 44 px,
      no sideways scroll, visible focus ring
- [ ] Hindi / Marathi: menus, Billing, toast, receipt; choice survives a reload

Automated (Playwright `features.spec.js`, `barcode.spec.js`, `staff.spec.js`, `rules.spec.js`):

- [ ] All flags off: no feature UI anywhere, bill and line records have only the baseline keys,
      nothing new under `shop/meta`, `shop/users`, `shop/dayCloses`
- [ ] Each feature, switched on: payment settings on receipt; bill numbers sequential + offline
      provisional → final; WhatsApp link; day close totals and save; backup reminder; customer
      ledger; restock; GST split; return (refund) and exchange (credit); barcode typed / label
      decode / camera; staff account lifecycle
- [ ] Rules: owner full access; staff limited exactly as documented; strangers and signed-out
      get nothing; nobody can grant themselves a role

Automated (Playwright `hardening.spec.js` + the validation part of `rules.spec.js`):

- [ ] A bill with no `lines` renders everywhere and is not rewritten
- [ ] An uncaught error lands in `shop/meta/errors` and shows in Admin
- [ ] A refused change: shown, retried, marked "refused by the server", discarded; no stub is
      written; a sync error report exists
- [ ] Data check lists exactly the records the rules would refuse
- [ ] Every valid sample is accepted and every invalid sample refused by BOTH the rules and
      `validate.js`

Unit (vitest): `outbox.test.js` (write-ahead, order, replay, idempotency, crash mid-replay,
failure + backoff, retryNow), `ops.test.js`, `localdb.test.js`, `salesWindow.test.js`,
`print.test.js`, `syncStatus.test.js`, `i18n/i18n.test.js`, `validate.test.js`,
`errorReport.test.js`, and one test file per Phase 4 library.

Not automated — check by hand on a real phone after anything that touches them:

- [ ] Receipt actually prints (thermal printer / share-to-print), logo and QR visible
- [ ] XLSX export opens in Excel/Sheets; XLSX import round-trips
- [ ] Vendor / Supplier bill proof upload and view (Firebase Storage)
- [ ] Data Import from a PDF / pasted text
- [ ] Mobile layout (< 820 px): sidebar, Billing grid, modals
- [ ] Before switching on any Phase 4 flag: try it against the emulator (`cfs-features-dev`)
- [ ] `barcode`: real camera on the shop phone; a printed label scans; label size on the printer
- [ ] `paymentSettings`: 58 mm and 80 mm receipts on the real thermal printer
- [ ] `gstInvoice`: an accountant checks the invoice format and rates
- [ ] `staffAccounts`: deploy the rules first; sign in as staff on a second phone
- [ ] `whatsappReceipt`: link opens WhatsApp with the right number on Android
- [ ] Hindi and Marathi wording read by a native speaker (translations were written without
      one); receipt prints Devanagari correctly on the thermal printer
- [ ] Numeric keypad really opens on the shop's phone for amount / quantity fields
- [ ] Sticky Complete bar does not cover anything when the on-screen keyboard is open
- [ ] Install to home screen (Android Chrome "Add to Home screen"); open with flight mode on
- [ ] After a deploy: "Update available" bar appears; Reload switches version; a bill in
      progress is not lost if Reload is NOT tapped

## Known issues and limits

- When the cloud catalogue becomes empty (`shop/items` → null) while a device is open or has a
  cache, that device keeps showing its stale products (the null-snapshot branch never clears
  local `items`).
- A browser tab left open across a database wipe/restore writes its stale state back.
- Product add / edit / restock / delete are direct transactions and still wait for the network
  (the form does not close while offline). Only bills, expenses, logs and supplier/vendor
  bills go through the outbox.
- If IndexedDB is unavailable (some private-browsing modes) the cache and outbox are
  memory-only: the app works, but nothing unsynced survives a reload.
- Discarding a refused change reloads the page (the local screen cannot otherwise be rolled
  back to what the cloud has).
- `ErrorBoundary` → error report is wired but untested end to end (no screen crashes on demand).
- Staff can read cost / profit through the API (RTDB cannot hide fields).
- Translation covers menus, Billing and the receipt only; Hindi / Marathi were not reviewed by
  a native speaker.

## Report format for every phase

```
PHASE N — <name>
Changed: <files>
Tests: unit X/X · e2e X/X · lint · build (size: before -> after)
Verified by test: …
Verified by reading only: …
NOT verified: …
Data model changes: none | <details + migration>
STOP — reply "proceed" for Phase N+1
```
