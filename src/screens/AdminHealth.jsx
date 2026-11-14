// Admin panels added in Phase 5: error reports from every device, and a check of the stored
// data against the database's validation rules.
import { useEffect, useMemo, useState } from "react";
import { subscribeErrorReports, removeErrorReports } from "../lib/sync.js";
import { auditData } from "../lib/validate.js";
import { confirmDialog } from "../ui/dialogs.jsx";
import { S } from "../ui/styles.js";

export function ErrorReports({ notify }) {
  const [reports, setReports] = useState({});
  useEffect(() => subscribeErrorReports(setReports), []);
  const list = Object.entries(reports).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  const clear = async () => {
    if (
      !(await confirmDialog({
        title: "Clear error reports",
        message: `Delete all ${list.length} error reports?`,
        confirmLabel: "Clear reports",
        danger: true,
      }))
    )
      return;
    try {
      await removeErrorReports(list.map(([id]) => id));
      notify("Error reports cleared");
    } catch (e) {
      console.error("clear error reports failed", e);
      notify("⚠ Couldn't clear the error reports.");
    }
  };
  return (
    <section style={{ ...S.panel, marginBottom: 16 }}>
      <div style={{ ...S.panelHead, display: "flex", alignItems: "center" }}>
        Error reports ({list.length})
        {list.length > 0 && (
          <button className="btn small" style={{ marginLeft: "auto" }} onClick={clear}>
            Clear
          </button>
        )}
      </div>
      {list.length === 0 ? (
        <div style={{ fontSize: 13, color: "#556A5F" }}>
          No crashes or sync failures reported from any device. ✅
        </div>
      ) : (
        list.slice(0, 20).map(([id, r]) => (
          <details
            key={id}
            style={{ borderTop: "1px solid #EEF3EE", padding: "6px 0", fontSize: 13 }}
          >
            <summary style={{ cursor: "pointer", minHeight: 32 }}>
              <b style={{ color: r.kind === "crash" ? "#B3261E" : "#8A5A12" }}>
                {r.kind === "crash" ? "Crash" : "Sync failure"}
              </b>{" "}
              · {new Date(r.at).toLocaleString("en-IN")} · {r.message}
            </summary>
            <div style={{ color: "#445", fontSize: 12, marginTop: 4, wordBreak: "break-word" }}>
              {r.device && <div>Device: {r.device}</div>}
              {r.user && <div>Account: {r.user}</div>}
              {r.where && <div>Where: {r.where}</div>}
              {r.op && <div>Change: {r.op}</div>}
              {r.paths && <div>Paths: {r.paths}</div>}
              {r.stack && (
                <pre style={{ whiteSpace: "pre-wrap", margin: "4px 0 0" }}>{r.stack}</pre>
              )}
            </div>
          </details>
        ))
      )}
    </section>
  );
}

// Run BEFORE deploying database.rules.json: the validation rules refuse edits to a record that
// does not meet them, so anything listed here should be fixed (or deleted) first.
export function DataCheck({ items, sales }) {
  const [ran, setRan] = useState(false);
  const report = useMemo(() => (ran ? auditData({ items, sales }) : []), [ran, items, sales]);
  return (
    <section style={{ ...S.panel, marginBottom: 16 }}>
      <div style={S.panelHead}>Check data against rules</div>
      <p style={{ fontSize: 13, color: "#445", lineHeight: 1.5, margin: "0 0 10px" }}>
        The database rules require every bill to have an id, a date (YYYY-MM-DD) and a numeric
        total, and every product to have a name and non-negative numeric stock and prices. Run this
        before deploying new rules: a record that fails can still be read and deleted, but not
        edited.
      </p>
      <button className="btn primary" onClick={() => setRan(true)}>
        Check {items.length} products and {sales.length} bills
      </button>
      {ran && (
        <div role="status" style={{ marginTop: 10, fontSize: 13.5 }}>
          {report.length === 0 ? (
            <b style={{ color: "#1B5E43" }}>All records pass. ✅</b>
          ) : (
            <>
              <b style={{ color: "#B3261E" }}>
                {report.length} record{report.length === 1 ? "" : "s"} would be refused:
              </b>
              {report.slice(0, 50).map((r) => (
                <div
                  key={r.slice + r.id}
                  style={{ padding: "4px 0", borderTop: "1px solid #EEF3EE" }}
                >
                  {r.slice === "items" ? "Product" : "Bill"} <b>{r.label}</b>{" "}
                  <span style={{ color: "#556A5F" }}>({String(r.id)})</span> —{" "}
                  {r.problems.join("; ")}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}
