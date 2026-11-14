import { useState, useMemo } from "react";
import { DataCheck, ErrorReports } from "./AdminHealth.jsx";
import { featureOn } from "../config/features.js";
import { StaffAccounts } from "./StaffAccounts.jsx";
import { normName } from "../lib/domain.js";
import {
  productStock,
  normalizeProduct,
  mergeProductGroup,
  buildSeedProducts,
} from "../lib/products.js";
import { overwriteSlice, toMap, writeMeta } from "../lib/sync.js";
import { todayStr } from "../lib/format.js";
import { EmailAuthProvider, reauthenticateWithCredential } from "firebase/auth";
import { auth } from "../config/firebase.js";
import { Header, Modal } from "../ui/index.jsx";
import { S } from "../ui/styles.js";

// ---------- small components ----------
// ---------- Admin (password-gated bulk / destructive operations) ----------
// Every action requires: confirm → confirm again → re-enter the account password
// (verified against Firebase Auth). Only on a successful re-auth does the action run.
export function Admin({ items, setSales, setExpenses, setLogs, user, notify, log, sales = [] }) {
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
      {featureOn("staffAccounts") && <StaffAccounts notify={notify} log={log} />}
      <ErrorReports notify={notify} />
      <DataCheck items={items} sales={sales} />
      {groups.map((grp) => (
        <section key={grp} style={{ ...S.panel, marginBottom: 16 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: ".06em",
              color: grp === "Danger zone" ? "#B23B2E" : "#556A5F",
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
                aria-label="Account password"
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
