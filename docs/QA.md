# QA report — Clothing & Footwear Shop Manager

State after the five hardening phases. Three kinds of evidence are kept apart:

- **Automated** — a test that runs in CI on every push and pull request.
- **Read only** — confirmed by reading the code; no test exercises it.
- **Manual** — has to be checked by a person on a real device. Nothing in this section has
  been done; it is the list of what is still owed.

All automated tests run against mocks or the local Firebase Emulator Suite. **No test has ever
run against the live Firebase project, and no security rules were deployed.**

## Automated checks

| Check | Command | Result |
|---|---|---|
| Install from lockfile | `npm ci` | passes on Node 20.20, 22.23 and 24.22 |
| Lint | `npm run lint` | clean |
| Unit tests | `npm test` | 333 pass (188 from before the hardening + 145 new) |
| Production build | `npm run build` | passes |
| End-to-end tests | `npm run test:e2e` | 83 pass |

### What the end-to-end tests cover

| Area | Spec | What is pinned |
|---|---|---|
| Core counter flows | `smoke.spec.js` | login; add product with 3 variants; sell 2 of one variant (stock, Sales History, receipt); delete bill → stock restored; Udhari with part payment; JSON export → wipe → import |
| Data integrity | `phase1-bugs.spec.js` | double-tap makes one bill; offline sale completes; offline sale survives reload and syncs once; tab killed mid-sale / mid-delete leaves bill and stock in agreement; a > 5 MB dataset opens offline; custom subcategory syncs to a second device; bill edit; offline delete; offline expense; old cache migration |
| Sales window | `window.spec.js` | recent bills only by default; older on demand; old credit bills always present; Reports load everything; delete never touches unloaded bills; backup has every bill; restore removes every other bill; monthly summary saved |
| Installable / offline shell | `pwa.spec.js` (production build, outside requests blocked) | manifest and icons; app shell opens with no network; a new version waits for the user |
| Usability | `usability.spec.js` | Undo for bill / product / expense; in-app destructive confirm (red, Cancel focused, Esc); focus trap; toast lifetimes; steppers; hold / resume; quick-pick; pinned total bar on a phone; waiting-to-sync count; empty-state actions; skeleton |
| Accessibility | `a11y.spec.js` | every control labelled; all text ≥ 4.5:1 contrast; every control ≥ 44 px on a phone; no sideways scroll; visible focus ring — on every tab and the main dialogs |
| Language | `i18n.spec.js` | Hindi and Marathi for menus, Billing, toast and receipt; stored data stays language-neutral; choice persists |
| Optional features | `features.spec.js`, `barcode.spec.js`, `staff.spec.js` | with all flags off nothing is shown or written; each feature works when switched on |
| Security rules | `rules.spec.js` | owner full access; staff limited exactly as documented; strangers and signed-out get nothing; no self-promotion; validation of bills and products agrees with the in-app checker |
| Hardening | `hardening.spec.js` | malformed bill does not crash; uncaught error reported; refused write shown, retried, discarded; data check lists bad records |

## Read only (no test)

- A production build cannot enter emulator mode (`import.meta.env.PROD` guard), and in
  production builds the per-browser feature override is ignored.
- `ErrorBoundary` reports a render crash (the reporter itself is tested; the boundary wiring is
  not, because no screen can be made to crash on demand any more).
- The service-worker update prompt appears after a real deploy (only "does not auto-activate"
  is tested).
- The `deploy` job in the workflow (it can only run on `main`).
- XLSX export / import, vendor-bill proof upload to Storage, and PDF data import were not
  touched by the hardening and have no end-to-end test.

## Manual — still to do on a real phone

Do these on the phone used at the counter, signed in as the owner, ideally against the
emulator build first and then once on the live site after a deploy.

**Every release**

1. Open the app, make a small bill, print or share the receipt. Logo and payment QR visible.
2. Delete that bill, tap **Undo**, then delete it again and let the Undo expire.
3. Switch on flight mode. Make a bill. The toast says *Saved on this device*; the sidebar /
   pill shows *1 bill waiting to sync*. Switch flight mode off; within a few seconds it shows
   *Online · syncing live* and the bill is on a second device.
4. With flight mode on, close the app completely and open it from the home-screen icon. It
   opens and shows the cached products.

**Once, after the first deploy of this work**

5. *Add to Home screen* installs the app with the shop icon and opens without the browser bar.
6. Deploy any later change: the **Update available — Reload** bar appears; a bill in progress
   is still there if Reload is not tapped; after Reload the new version is running.
7. Amount and quantity fields open the numeric keypad. The pinned **Complete sale** bar is
   reachable with the keyboard open and does not cover the last cart line.
8. Thermal receipt prints correctly (width, logo, QR). Print one in Hindi and one in Marathi and
   check the Devanagari text is not broken.
9. A Hindi and a Marathi speaker read through the Billing screen and a receipt — the
   translations were written without a native reviewer.
10. Sales History shows *Showing bills since …*; **Load all bills** brings back the old ones.
11. ⬇ XLSX opens in Excel / Google Sheets; restoring an XLSX backup into the **emulator** build
    gives the same data.
12. Upload and open a vendor-bill proof (photo and PDF).
13. Import a real supplier PDF / pasted list in Data Import.

**Before deploying `database.rules.json`**

14. Run **Admin → Check data against rules** on the live data and fix or delete anything listed.
15. Deploy (`firebase deploy --only database,storage`), then: make a bill, edit it, delete it,
    add a product, restock, add an expense, save Settings. Nothing should show
    *N not synced*.
16. Check **Admin → Error reports** the next day.

**Before switching on each optional feature** (see `src/config/features.js`)

17. `paymentSettings` — upload your QR, set the UPI ID, print on the real 58 mm / 80 mm roll.
18. `billNumbers` — make two bills on two devices at the same moment: consecutive numbers, no
    repeat. Make one in flight mode: provisional number, then a real one after reconnecting.
19. `whatsappReceipt` — the link opens WhatsApp to the right number with a readable bill.
20. `dayClose` — close one real day and compare with the cash actually in the drawer.
21. `customerLedger`, `restockSuggestions` — numbers match what you know of two or three
    customers / fast-selling sizes.
22. `gstInvoice` — an accountant checks the invoice layout and rates.
23. `returns` — every device updated first. Return one item for cash and one as exchange credit;
    check stock, Sales History, the Dashboard total and Day Close.
24. `barcode` — print labels, scan them with the phone camera in the shop's lighting; scan a
    manufacturer barcode that you have entered as a SKU.
25. `staffAccounts` — rules deployed first. Create a staff login, sign in on a second phone,
    make a bill; confirm the hidden tabs; remove the account and confirm the phone is locked out.

## Known limits (by design or not yet done)

- Product add / edit / restock / delete still need a connection (only bills, expenses, logs and
  vendor / supplier bills go through the offline outbox).
- If the browser has no IndexedDB (some private modes) nothing unsynced survives a reload.
- A staff account can read cost and profit through the Firebase API; the app only hides them.
- Only menus, Billing and the receipt are translated.
- Best-seller stars and customer autocomplete in Billing only consider the loaded (recent) bills.
- A tab left open across a full restore can write its stale state back; close other tabs first.
- Chart rendering of negative values (return bills) was not reviewed chart by chart.
