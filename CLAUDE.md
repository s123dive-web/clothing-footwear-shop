# CLAUDE.md — Clothing & Footwear Shop Manager

POS + inventory app for a ladies clothing & footwear shop. **It is in live daily use at a shop
counter, mostly on a phone, with real sales data.** Read the hard rules before changing anything.

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
- **Entry:** `index.html` → `src/main.jsx` (ErrorBoundary + `window.storage` shim) →
  `src/clothing-footwear-shop.jsx`.
- **`src/clothing-footwear-shop.jsx`** (~9,500 lines) is the whole UI: `App` (auth gate) →
  `Login` | `StoreManager`. `StoreManager` owns all state (items, sales, expenses, logs,
  vendorBills, dailyBills, config, customCats), the sync effects, the sidebar and the toast, and
  renders one screen per tab: Dashboard, Billing, Inventory (+ProductForm, RestockModal),
  SalesHistory, Finance (flagged off), Stats (Reports), Udhari, Expenses, DailyBills (Supplier
  Bills), Alerts, VendorBills, RawData (Data Import), Logs, Settings, Admin. Shared UI
  (`Header`, `Card`, `Field`, `Empty`, `Section`, `Modal`, `S`, `CSS`) is at the bottom of the
  same file.
- **`src/lib/`** — pure, unit-tested helpers: `sync.js` (array↔map bridge, `buildSliceUpdate`,
  3-way `mergeRemote`, `updateItemAtomic`), `products.js` (variants, stock maths,
  `normalizeProduct`), `catalog.js` (groups, subcategories, sizes, seed list), `stats.js`
  (reports maths), `dailyBills.js`, `bills.js` (Storage proofs), `backup.js` (JSON/XLSX
  export, XLSX import), `parse.js` (Data Import parsing).
- **`src/config/`** — `firebase.js` (live config + emulator switch), `shopConfig.js`,
  `currency.js`.

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

Storage: bill proof files at `shop/bills/<billId>/<file>` (≤ 10 MB).

Rules (`database.rules.json`, `storage.rules`): every read/write requires auth **and** the
owner's email. There is no validation and no index yet (Phase 5).

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
| `npm run test:e2e` | Playwright (`e2e/*.spec.js`); starts the emulators and an emulator-mode dev server on :5174 itself. First time: `npx playwright install chromium`. |

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

Unit (vitest): `outbox.test.js` (write-ahead, order, replay, idempotency, crash mid-replay,
failure + backoff, retryNow), `ops.test.js`, `localdb.test.js`.

Not automated — check by hand on a real phone after anything that touches them:

- [ ] Receipt actually prints (thermal printer / share-to-print), logo and QR visible
- [ ] XLSX export opens in Excel/Sheets; XLSX import round-trips
- [ ] Vendor / Supplier bill proof upload and view (Firebase Storage)
- [ ] Data Import from a PDF / pasted text
- [ ] Mobile layout (< 820 px): sidebar, Billing grid, modals

## Known issues found but not yet scheduled

- When the cloud catalogue becomes empty (`shop/items` → null) while a device is open or has a
  cache, that device keeps showing its stale products (the null-snapshot branch never clears
  local `items`).
- A sale whose `lines` is missing/empty (RTDB drops empty arrays) crashes Dashboard
  (`s.lines.length`). Real bills always have ≥ 1 line; only hand-edited or imported data can
  hit this.
- A browser tab left open across a database wipe/restore writes its stale state back.
- Product add / edit / restock / delete are direct transactions and still wait for the network
  (the form does not close while offline). Only bills, expenses, logs and supplier/vendor
  bills go through the outbox.
- If IndexedDB is unavailable (some private-browsing modes) the cache and outbox are
  memory-only: the app works, but nothing unsynced survives a reload.

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
