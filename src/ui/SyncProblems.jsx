// "N changes not synced" dialog: what the server refused, with Retry and (last resort) Discard.
import { Modal } from "./index.jsx";
import { confirmDialog } from "./dialogs.jsx";

const WHAT = {
  sale: "New bill",
  "sale-edit": "Bill edit",
  "sale-delete": "Bill delete",
  "sale-return": "Return",
  sales: "Bill change",
  expenses: "Expense change",
  logs: "Activity log entry",
  vendorBills: "Vendor bill change",
  dailyBills: "Supplier bill change",
  dayclose: "Day close",
  subcategories: "Subcategory",
};

export function SyncProblems({ ops, onRetry, onDiscard, onClose }) {
  const discard = async (op) => {
    if (
      await confirmDialog({
        title: "Discard this change?",
        message:
          "The server refused this change, so it is NOT saved in the cloud. Discarding removes it from this device too. The app will reload.",
        confirmLabel: "Discard",
        danger: true,
      })
    )
      onDiscard(op.id);
  };
  return (
    <Modal title="Changes not synced" onClose={onClose}>
      {ops.length === 0 ? (
        <p style={{ fontSize: 14 }}>Everything is synced now. ✅</p>
      ) : (
        <>
          <p style={{ fontSize: 13.5, lineHeight: 1.5, margin: "0 0 10px", color: "#33443B" }}>
            These changes are safe on this device but the cloud has not accepted them. Check the
            internet connection and tap Retry. If one keeps failing, the record it changes may have
            been deleted on another device — discard it.
          </p>
          {ops.map((op) => (
            <div
              key={op.id}
              style={{ borderTop: "1px solid #EEF3EE", padding: "8px 0", display: "flex", gap: 8 }}
            >
              <div style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
                <b>{WHAT[op.label] || "Change"}</b>
                <span style={{ color: "#556A5F" }}>
                  {" "}
                  · {new Date(op.at).toLocaleString("en-IN")} · tried {op.attempts}×
                </span>
                <div style={{ color: "#B3261E", fontSize: 12, wordBreak: "break-word" }}>
                  {op.stuck ? "Refused by the server: " : ""}
                  {op.error}
                </div>
              </div>
              <button className="btn small danger" onClick={() => discard(op)}>
                Discard
              </button>
            </div>
          ))}
          <button
            className="btn primary big"
            style={{ width: "100%", marginTop: 12 }}
            onClick={onRetry}
          >
            Retry all
          </button>
        </>
      )}
    </Modal>
  );
}
