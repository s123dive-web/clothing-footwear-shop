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

```bash
npm install
npm run dev      # http://localhost:5173
```

Other scripts: `npm run build`, `npm run preview`, `npm run lint`, `npm run format`,
`npm test` (Vitest), `npm run test:watch`.

Until you point it at a Firebase project (below), the app shows a friendly **“Configure
Firebase”** screen instead of crashing.

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
  required for every read/write** (no open rules); by default it's locked to the single owner
  email. A commented one-liner switches it to “any signed-in user”.
- [`storage.rules`](storage.rules) — Storage access for supplier-bill proof files (owner-only,
  10 MB cap).
- [`firebase.json`](firebase.json) — points the CLI at both rule files.

The Firebase config is **public by design** (every client-side Firebase app ships its config);
the **rules** are what keep the data private. Never commit real keys you want kept secret — the
committed `firebase.js` holds only placeholders, and `.gitignore` ignores
`src/config/firebase.local.js` and `.env*` for anything sensitive.

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
`shopConfig` (shop identity) and `meta/seeded` (the one-time seed guard).

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
- **Mobile-friendly** — the sidebar collapses and grids stack on small screens for counter use.

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
npm test
```

[Vitest](https://vitest.dev) covers the correctness-critical pure modules (188 tests): products
& variants, the apparel catalog/sizes, shop-config normalisation/validation, the reports
(sales-by-category, best-selling sizes, dead stock, inventory value), the array↔map sync + 3-way
merge, and the tolerant import parser. Firebase is not touched by the suite.

## Screenshots

_Add screenshots here — e.g. Billing (variant picker), Inventory (size/colour chips), Reports._

<!-- ![Billing](docs/billing.png) -->
<!-- ![Inventory](docs/inventory.png) -->
<!-- ![Reports](docs/reports.png) -->

## Libraries

- **firebase** — Auth, Realtime Database (live sync), Storage.
- **recharts** — charts. · **pdfjs-dist** — PDF import (lazy-loaded).
- **xlsx (SheetJS)** — csv/xls/xlsx import + XLSX backups (patched CDN build).

## Deployment

Deployed to GitHub Pages via [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) on
every push to `main` (the Vite `base` is `/clothing-footwear-shop/`).
