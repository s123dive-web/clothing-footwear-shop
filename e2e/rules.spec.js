// Security-rules unit tests (@firebase/rules-unit-testing) for database.rules.json, run against
// the Realtime Database emulator in a separate project so they never touch the app's data.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from "@firebase/rules-unit-testing";
import { ref, get, set, update, remove, query, orderByChild, startAt } from "firebase/database";
import { setLogLevel } from "firebase/app";

setLogLevel("silent"); // every refused write below would otherwise print a warning

const OWNER_EMAIL = "vijaykshopvarje@gmail.com";
let env;
let owner, staff, stranger, anon;

const SALE = {
  id: "s1",
  date: "2026-11-14",
  time: "10:00 am",
  total: 500,
  profit: 200,
  payment: "Cash",
  lines: [{ name: "Kurti", qty: 1, price: 500, amount: 500 }],
};
const ITEM = {
  id: "p1",
  name: "Kurti",
  sellingPrice: 500,
  purchasePrice: 300,
  variants: [{ id: "v1", size: "M", stockQty: 5, lowAt: 2 }],
  stock: 5,
};

test.beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-cfs-rules",
    database: {
      host: "127.0.0.1",
      port: 9000,
      rules: fs.readFileSync("database.rules.json", "utf8"),
    },
  });
  owner = env.authenticatedContext("owner-uid", { email: OWNER_EMAIL }).database();
  staff = env.authenticatedContext("staff-uid", { email: "staff@example.com" }).database();
  stranger = env.authenticatedContext("stranger-uid", { email: "someone@example.com" }).database();
  anon = env.unauthenticatedContext().database();
});
test.afterAll(async () => {
  await env.cleanup();
});
test.beforeEach(async () => {
  await env.clearDatabase();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await set(ref(ctx.database(), "shop"), {
      users: { "staff-uid": { role: "staff", email: "staff@example.com" } },
      sales: { s1: SALE },
      items: { p1: ITEM },
      expenses: { e1: { id: "e1", date: "2026-11-14", desc: "Rent", amount: 9000 } },
      vendorBills: { b1: { id: "b1", vendor: "Surat Textiles", amount: 40000 } },
      shopConfig: { name: "Shop" },
      meta: { seeded: true },
    });
  });
});

test("owner: full read and write, exactly as before", async () => {
  await assertSucceeds(get(ref(owner, "shop")));
  await assertSucceeds(set(ref(owner, "shop/expenses/e2"), { id: "e2", amount: 1 }));
  await assertSucceeds(remove(ref(owner, "shop/sales/s1")));
  await assertSucceeds(set(ref(owner, "shop/items/p2"), { ...ITEM, id: "p2" }));
  await assertSucceeds(set(ref(owner, "shop/users/new-uid"), { role: "staff" }));
  await assertSucceeds(set(ref(owner, "shop/shopConfig/name"), "New name"));
});

test("signed-out and unknown accounts get nothing", async () => {
  for (const db of [anon, stranger]) {
    await assertFails(get(ref(db, "shop")));
    await assertFails(get(ref(db, "shop/sales")));
    await assertFails(get(ref(db, "shop/items/p1")));
    await assertFails(set(ref(db, "shop/sales/x"), SALE));
    await assertFails(set(ref(db, "shop/users/stranger-uid"), { role: "staff" }));
  }
});

test("an account cannot make itself staff or owner", async () => {
  await assertFails(set(ref(stranger, "shop/users/stranger-uid/role"), "staff"));
  await assertFails(set(ref(staff, "shop/users/staff-uid/role"), "owner"));
  await assertFails(set(ref(staff, "shop/users/other-uid"), { role: "staff" }));
});

test("staff: reads what billing needs — and its own role — but not the books", async () => {
  await assertSucceeds(get(ref(staff, "shop/sales")));
  await assertSucceeds(
    get(query(ref(staff, "shop/sales"), orderByChild("date"), startAt("2026-08-01")))
  );
  await assertSucceeds(get(ref(staff, "shop/items")));
  await assertSucceeds(get(ref(staff, "shop/shopConfig")));
  await assertSucceeds(get(ref(staff, "shop/meta")));
  await assertSucceeds(get(ref(staff, "shop/users/staff-uid")));

  await assertFails(get(ref(staff, "shop")));
  await assertFails(get(ref(staff, "shop/expenses")));
  await assertFails(get(ref(staff, "shop/vendorBills")));
  await assertFails(get(ref(staff, "shop/dailyBills")));
  await assertFails(get(ref(staff, "shop/dayCloses")));
  await assertFails(get(ref(staff, "shop/users")));
  await assertFails(get(ref(staff, "shop/users/owner-uid")));
});

test("staff: can make and edit bills, never delete one", async () => {
  await assertSucceeds(set(ref(staff, "shop/sales/s2"), { ...SALE, id: "s2" }));
  await assertSucceeds(set(ref(staff, "shop/sales/s1/paid"), 100));
  // the app's own write: one multi-path update under shop/ (bill + log entry)
  await assertSucceeds(
    update(ref(staff, "shop"), {
      "sales/s3": { ...SALE, id: "s3" },
      "logs/l1": { id: "l1", type: "sale", message: "Bill ₹500" },
    })
  );
  await assertFails(remove(ref(staff, "shop/sales/s1")));
  await assertFails(update(ref(staff, "shop"), { "sales/s1": null }));
  await assertFails(set(ref(staff, "shop/sales"), null));
});

test("staff: can move stock on an existing product, cannot add or remove products", async () => {
  await assertSucceeds(set(ref(staff, "shop/items/p1/variants/0/stockQty"), 4));
  await assertSucceeds(set(ref(staff, "shop/items/p1"), { ...ITEM, stock: 3 }));
  await assertFails(set(ref(staff, "shop/items/p9"), { ...ITEM, id: "p9" }));
  await assertFails(remove(ref(staff, "shop/items/p1")));
  await assertFails(set(ref(staff, "shop/items"), {}));
});

test("staff: log is append-only; everything else is read-only or hidden", async () => {
  await assertSucceeds(set(ref(staff, "shop/logs/l2"), { id: "l2", message: "x" }));
  await assertFails(set(ref(staff, "shop/logs/l2"), { id: "l2", message: "rewritten" }));
  await assertFails(remove(ref(staff, "shop/logs/l2")));
  await assertSucceeds(set(ref(staff, "shop/meta/billCounters/2026-27"), { next: 2 }));
  await assertFails(set(ref(staff, "shop/meta/seeded"), false));
  await assertFails(set(ref(staff, "shop/shopConfig/name"), "Hacked"));
  await assertFails(set(ref(staff, "shop/expenses/e9"), { id: "e9", amount: 1 }));
  await assertFails(set(ref(staff, "shop/dayCloses/2026-11-14"), { counted: 1 }));
});

test("removing the staff entry removes all access at once", async () => {
  await assertSucceeds(get(ref(staff, "shop/sales")));
  await assertSucceeds(remove(ref(owner, "shop/users/staff-uid")));
  await assertFails(get(ref(staff, "shop/sales")));
  await assertFails(set(ref(staff, "shop/sales/s9"), SALE));
  expect(true).toBe(true);
});
