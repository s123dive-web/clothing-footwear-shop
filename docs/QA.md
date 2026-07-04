# QA Report — Clothing & Footwear Shop Manager

Verification of the Phase 5 checklist. **Automated** = covered by `npm test` / build / lint /
serve (reproducible here). **Code-verified** = confirmed by reading the wired code path.
**Manual** = recommended to click through once against a real Firebase project (no browser
automation was available in this build environment).

## Environment checks

| Check | Result |
|---|---|
| `npm run build` (Vite production build) | ✅ PASS — builds clean, 798 modules |
| `npm run lint` (ESLint) | ✅ PASS — 0 errors, 0 warnings |
| `npm test` (Vitest) | ✅ PASS — **188 / 188** across 8 files |
| `npm run preview` serves the app (HTTP 200, correct title, bundle loads) | ✅ PASS |

## Feature checklist (from the brief)

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Add/edit/delete product **with variants**; stock updates **per variant** | ✅ Automated + Code | `products.test.js` (applyVariantDelta / normalizeProduct / add·removeVariantStock); Inventory `ProductForm` + `cloudWriteProduct` / `cloudDeleteProduct` / `cloudRestockVariant` |
| 2 | Billing: sale reduces the **correct variant** stock; totals/discount math | ✅ Code + Automated | `Billing.completeSale` builds `productId+variantId` lines → `cloudSellCart` decrements each variant atomically; discount (₹/%) clamps to `[0, subtotal]`; stock-decrement math covered by `products.test.js` |
| 3 | Shop config: changing name/address reflects in header **and** receipt | ✅ Code + Automated | `shopConfig.test.js` (normalize/validate); header + nav + `printReceipt(sale, config)` all read `useShopConfig()` — no hardcoded shop name remains (grep clean) |
| 4 | **Seed data does not reappear** after delete + reload + sync | ✅ Code | Seeder runs only when `shop/items === null` **and** `shop/meta/seeded` is falsy; it sets the flag after seeding. Deleting all products keeps the flag true → no resurrection. Seeds start at 0 stock |
| 5 | Concurrent edit: two writes to the same item don't silently lose data | ✅ Code + Automated | Products slice is **not** delta-pushed; all writes use `runTransaction` (`updateItemAtomic`) so each device applies its delta on the freshest server value. `products.test.js` proves sequential deltas compose (no lost decrement) |
| 6 | Import/export with the replaced xlsx library | ✅ Code | `backup.js` rewritten for the product/variant + sale schema (flatten per variant / per line, regroup on import); uses patched SheetJS `xlsx-0.20.3` |
| 7 | App loads with placeholder Firebase config → clear **"configure Firebase"** message, no crash | ✅ Code | `isFirebaseConfigured` is false for `YOUR_…` placeholders → `App` renders `FirebaseSetupNeeded`; `auth/db/storage` are `null` and never touched before the gate |

## Bug-fix verification (Hard Rule 5)

| Bug | Fixed how | Verified |
|---|---|---|
| Seed/demo items resurrecting on sync | One-time DB flag `shop/meta/seeded` guards seeding (not a per-session ref) | Code path + logic reviewed |
| Silent overwrite on concurrent writes | Firebase transactions for all stock/product writes; `version`+`updatedAt` on records | `products.test.js` + code |
| `xlsx@0.18.5` vulnerability | Source already on patched SheetJS CDN `xlsx-0.20.3`; kept it | `package.json` |

## Firebase separation (Hard Rule 2 & Phase 4)

- ✅ `grep` for the grocery project's ID / API key / sender ID / DB URL (`prakash`, `AIzaSyAcaC5…`,
  `148896169688`, `asia-southeast1`, `cf4a7`) across all source: **no matches** (only the old
  README title, now rewritten, and the gitignored `dist/`).
- ✅ Config isolated in `src/config/firebase.js` (placeholders) + `firebase.example.js` template.
- ✅ `database.rules.json` requires auth on all paths (no open rules).

## Not automated here (recommended manual pass)

Do one click-through against a real Firebase project to confirm the UI wiring end-to-end:
add a product with 2–3 variants → restock one → sell it (variant picker) → check stock dropped
on the right variant → open a second device/tab and confirm live sync → delete the bill and
confirm stock restored → change the shop name in Settings and reprint a receipt → export XLSX
and re-import into a fresh project.
