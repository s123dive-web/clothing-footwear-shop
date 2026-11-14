# Clothing & Footwear Shop Manager

A single-screen **point-of-sale, inventory, and accounts** app for a **ladies clothing &
footwear shop**. Built with **React + Vite** and backed by **Firebase** (Authentication,
Realtime Database, Storage) so data syncs live across every device that signs in — phone at
the counter, tablet in the back, laptop at home.

Products support **size & colour variants** with per-variant stock, variant-level low-stock
alerts, and a variant-aware billing flow. Everything is branded from an editable **Shop
Settings** screen — there is no hardcoded shop name anywhere.

> Adapted from an earlier grocery-store codebase: the reusable architecture (auth, live sync,
> reports, receipts, import/export) was kept; everything domain-specific was rebuilt for
> apparel, and the source project's known bugs were fixed (see **What changed**).

## Run it

Node 20.19+, 22.12+ or 24 (`npm ci` is verified on all three).

```bash
npm ci
npm run emulators      # terminal 1 — local Firebase (auth, database, storage). Needs Java 21+
npm run dev:emulator   # terminal 2 — the app against the emulators, http://localhost:5173
```

That is the safe way to try things: it never touches the live shop. `npm run dev` runs the app
against the **live** Firebase project in `src/config/firebase.js`.

| Script | What it does |
|---|---|
| `npm test` | Unit tests (Vitest) |
| `npm run test:e2e` | Playwright end-to-end tests — starts the emulators, an emulator-mode dev server and a production preview by itself. First time: `npx playwright install chromium` |
| `npm run lint` · `npm run format` | ESLint · Prettier |
| `npm run build` · `npm run preview` | Production build · serve it locally |

Until you point it at a Firebase project (below), the app shows a friendly **“Configure
Firebase”** screen instead of crashing.

**Deploying:** pushing to `main` builds and deploys to GitHub Pages
(`.github/workflows/deploy.yml`), after lint, unit tests and build pass. Pull requests and other
branches run the same checks plus the end-to-end suite, without deploying.

## Firebase setup (required)

This app uses **its own, separate Firebase project** — no keys are shared with any other app.

1. **Create a project** at <https://console.firebase.google.com>.
2. **Enable Authentication → Sign-in method → Email/Password**, and add your shop owner
   account (Users → Add user).
3. **Enable Realtime Database** (Build → Realtime Database → Create database). Note its URL.
4. **Register a Web app** (Project settings → General → Your apps → Web) and copy the config.
5. Paste that config into [`src/config/firebase.js`](src/config/firebase.js), replacing every
   `YOUR_…` placeholder. (Use [`src/config/firebase.example.js`](src/config/firebase.example.js)
   as the template.)
6. **Deploy the security rules** so the data is private:

```bash
npm i -g firebase-tools && firebase login
# edit OWNER_EMAIL in database.rules.json and storage.rules to the owner's sign-in email, then:
firebase deploy --only database,storage
```

- [`database.rules.json`](database.rules.json) — Realtime Database access. **Authentication is
  required for every read/write** (no open rules). The owner (by sign-in email) has full
  access; accounts the owner lists as **staff** get limited access (see *Staff accounts*
  below); nobody else gets anything. The file also declares the indexes the app's queries need
  (`shop/sales` by `date` and `payment`) and **validation** for bills and products (required
  fields, numeric types, stock never negative).

  > **Before deploying new rules:** open **Admin → Check data against rules** in the app. A
  > stored record that breaks the validation can still be read and deleted, but not edited,
  > until it is fixed. The rules are covered by unit tests (`e2e/rules.spec.js`).
- [`storage.rules`](storage.rules) — Storage access for supplier-bill proof files (owner-only,
  10 MB cap).
- [`firebase.json`](firebase.json) — points the CLI at both rule files.

The Firebase config is **public by design** (every client-side Firebase app ships its config);
the **rules** are what keep the data private. The committed
[`src/config/firebase.js`](src/config/firebase.js) holds this shop's web config;
`.gitignore` ignores `src/config/firebase.local.js` and `.env*` for anything that really is
secret.

## Data model

Products live at `shop/items/<id>` with size/colour **variants**:

```jsonc
{
  "id": "…", "name": "Cotton Printed Kurti", "brand": "Biba",
  "category": "Clothing",          // top group: Clothing | Footwear | Accessories
  "subcategory": "Kurtis",         // Kurtis, Sarees, Sandals, Heels, Handbags, …
  "code": "SKU…",                  // optional SKU / barcode
  "purchasePrice": 380, "sellingPrice": 649, "mrp": 899, "discountPct": 0,
  "supplier": "…", "imageUrl": "", "notes": "",
  "variants": [
    { "id": "…", "size": "M", "color": "Maroon", "sku": "", "stockQty": 6, "lowAt": 2 }
  ],
  "stock": 6,                      // cached total across variants
  "version": 3, "createdAt": "…", "updatedAt": "…"
}
```

- **Clothing sizes:** XS, S, M, L, XL, XXL, XXXL, Free Size.
- **Footwear sizes:** a configurable IND/UK numeric range (default 3–9), set in **Settings**.
- **Sales lines** are `product + variant` (`{ productId, variantId, name, size, color, qty,
  price, buyPrice, amount }`), so a sale reduces the exact variant's stock and reports can slice
  by size or category.

Other slices: `sales`, `expenses`, `logs`, `vendorBills`, `dailyBills` (supplier bills), plus
`shopConfig` (shop identity) and `meta` (`seeded`, `customSubcats`, `errors`, and — only when
their features are on — `billCounters`, `lastBackupAt`). The full, current data model with
every optional field and the migration notes is in [`CLAUDE.md`](CLAUDE.md).

## Working offline, and how data is kept safe

- **Installable.** On Android Chrome use *Add to Home screen*. The app shell is cached, so it
  opens at the counter with no network. A new version is downloaded in the background and the
  app shows **“Update available — Reload”**; it never reloads by itself in the middle of a bill.
- **Bills never wait for the network.** Completing a sale records it on the device at once.
  Every change is first written to a durable **outbox** (IndexedDB) and then sent; it is
  removed only when the server has confirmed it, retried if it fails, and replayed after a
  reload or a crash. A bill and its stock change travel together and cannot be applied twice.
- **Sync status** is in the sidebar (and a pill on phones): *Online · syncing live*,
  *Offline · 3 bills waiting to sync*, or *N not synced — tap to retry*, which opens the list
  of changes the server refused with **Retry** and **Discard**.
- **Recent bills only.** The app loads bills from the last three months plus every credit
  (Udhari) bill; older ones load on demand in Sales History and automatically for Reports,
  Admin, backup and restore.
- **Back up regularly** with ⬇ JSON / ⬇ XLSX in the sidebar. A backup always contains every
  bill; one made offline is named `…-PARTIAL-…` and says so.
- **Errors are reported.** Crashes and sync failures from any device appear in
  **Admin → Error reports**.

## Language

English, Hindi and Marathi — switch in the sidebar, on the sign-in screen or in Settings. It is
remembered per device. Menus, screen titles, the Billing screen and the printed receipt are
translated; the detailed labels inside other screens are still English.

## Optional features (switched off)

These are built and tested but **off** until switched on in
[`src/config/features.js`](src/config/features.js) (set the flag to `true`, merge, deploy):

| Flag | Feature |
|---|---|
| `paymentSettings` | UPI ID, your own payment QR, receipt width 58 / 80 mm |
| `billNumbers` | Sequential bill numbers per financial year (`2026-27/0001`) |
| `whatsappReceipt` | Send a bill on WhatsApp |
| `dayClose` | Day Close: cash / UPI / credit totals, expected vs counted cash |
| `backupReminder` | “Last backup N days ago” and a weekly reminder |
| `customerLedger` | Customers: purchases, outstanding credit, WhatsApp reminder |
| `restockSuggestions` | Restock: sell-through, days of stock left, fast sizes |
| `gstInvoice` | HSN + GST rate per product, CGST/SGST on the receipt |
| `returns` | Returns & exchange |
| `barcode` | Camera barcode scan and printable labels |
| `staffAccounts` | Staff accounts (see below) |

Read the notes for each in [`CLAUDE.md`](CLAUDE.md) before switching one on — in particular
`returns` (all devices must be on this version first) and `staffAccounts` (deploy the rules
first).

### Staff accounts

With `staffAccounts` on, the owner creates staff sign-ins in **Admin → Staff accounts**. Staff
can bill, look up stock, see bills and take credit repayments. They cannot open Dashboard,
Reports, Expenses, Vendor/Supplier Bills, Settings or Admin, and cannot edit or delete bills.

**Limit you should know:** the Realtime Database cannot hide individual fields, so a staff
account can still read cost price and profit through the Firebase API. The app hides them on
screen; that is not a security boundary.

## Features

- **Dashboard** — day picker, today/this-month revenue & profit, stock value, low-stock and
  recent-bills panels, 14-day trend, monthly overview.
- **Billing (POS)** — search a product, pick **size & colour** in a variant picker, build the
  bill; whole-bill discount (₹ or %); **UPI / Cash / Udhari (credit)**; back-date a bill;
  print a thermal receipt (branded from Settings). Stock decrements the exact variant.
- **Inventory** — product list with **size/colour chips** and per-variant stock; add/edit a
  product with a **variant matrix builder** (quick-add size × colour); per-variant **restock**;
  Clothing / Footwear / Accessories group filter + subcategory filter.
- **Alerts** — variant-level low-stock (e.g. “Kurti X — size M low”), filterable by group.
- **Reports** — **sales by category**, **best-selling sizes**, **dead stock** (no sale in the
  period), daily/weekly/monthly summaries, payment mix, inventory value, break-even.
- **Sales History** — date-range + text search; edit or delete a bill (restores the right
  variant's stock); reprint receipts.
- **Udhari (Credit)**, **Add Expense**, **Vendor Bills** (with proof upload), **Supplier
  Bills**, **Data Import** (txt/csv/xls/xlsx/pdf/json → products/sales/expenses), **Activity
  Log**, **Settings**, and a password-guarded **Admin** for bulk operations.
- **Mobile-friendly** — on a phone the total and the Complete button stay pinned to the bottom
  of the Billing screen; quantity steppers and every control are at least 44 px; amount fields
  open the numeric keypad; a bill can be put on **Hold** and resumed.
- **Undo instead of “are you sure?”** for deleting a bill, a product or an expense.

## Settings (shop identity)

Everything the customer sees comes from **Settings → shop config** (stored at `shop/shopConfig`,
cached locally, read by the header, receipts, and reports):

- Shop name, tagline, address, phone, email, GSTIN (optional)
- Currency symbol (default ₹), logo upload (optional)
- Receipt / invoice footer text
- Footwear size range

## What changed vs. the source project

Three source bugs were **fixed, not carried over**:

1. **Seed data no longer resurrects.** The starter catalogue seeds **once**, guarded by a
   database flag (`shop/meta/seeded`). Deleting products and reloading never brings the seed
   back. Seed products start at **0 stock**.
2. **No silent overwrite on concurrent writes.** All product/stock writes go through **Firebase
   transactions** (`runTransaction`), so two devices selling or restocking the same item apply
   their change on top of the freshest server value instead of clobbering each other. Records
   also carry a `version` + `updatedAt`.
3. **Patched spreadsheet library.** Uses the maintained **SheetJS CDN build `xlsx-0.20.3`**
   (fixes the prototype-pollution and ReDoS advisories) — not the vulnerable npm `0.18.5`.

## Tests

```bash
npm test            # unit tests (Vitest)
npm run test:e2e    # end-to-end tests (Playwright + Firebase emulators)
```

- **Unit tests** cover the pure modules: products & variants, catalog/sizes, shop config,
  reports, the array↔map sync and 3-way merge, the import parser, the outbox (replay,
  idempotency, crash mid-replay, refused writes), stock ops, the device database, the sales
  window, bill numbers, GST, returns, day close, customers, restock, barcodes, roles, record
  validation, error reports and the strings table.
- **End-to-end tests** drive the real app against the local Firebase emulators — never the live
  shop: the core counter flows, the offline and crash-recovery cases, the sales window, the
  installable shell (against a production build with all outside requests blocked), usability,
  an accessibility audit of every screen, the language toggle, every optional feature, staff
  accounts, and the security rules.

[`docs/QA.md`](docs/QA.md) lists what is verified automatically and **what still has to be
checked by hand on a real phone**. [`CLAUDE.md`](CLAUDE.md) is the engineering guide:
architecture, data model, migration notes, and the regression checklist.

## Screenshots

_Add screenshots here — e.g. Billing (variant picker), Inventory (size/colour chips), Reports._

<!-- ![Billing](docs/billing.png) -->
<!-- ![Inventory](docs/inventory.png) -->
<!-- ![Reports](docs/reports.png) -->

## Libraries

- **firebase** — Auth, Realtime Database (live sync), Storage.
- **recharts** — charts (loaded with the Dashboard charts / Reports). · **pdfjs-dist** — PDF
  import (loaded on demand).
- **xlsx (SheetJS)** — csv/xls/xlsx import + XLSX backups (patched CDN build, loaded on demand).
- **vite-plugin-pwa** — installable app + offline shell.
- **@zxing/browser** — barcode-scanner fallback (loaded on demand, `barcode` feature only).
- Dev: **vitest**, **@playwright/test**, **firebase-tools** (emulators),
  **@firebase/rules-unit-testing**, **fake-indexeddb**.

## Deployment

Deployed to GitHub Pages via [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) on
every push to `main` (the Vite `base` is `/clothing-footwear-shop/`), after the `ci` job (lint,
unit tests, build) passes. Security rules are **not** deployed by the workflow — deploy them
yourself with `firebase deploy --only database,storage` after running the in-app data check.
