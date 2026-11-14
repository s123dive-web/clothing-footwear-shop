// Toasts. `notify(message, options?)`:
//   • ordinary messages disappear after ~2.6 s;
//   • a message with an action (e.g. Undo) stays 5 s;
//   • errors / warnings (kind: "error", or any message starting with "⚠") STAY until dismissed —
//     a warning must not vanish before it has been read.
// Up to three are stacked; the newest is at the bottom.
import { useCallback, useEffect, useRef, useState } from "react";
import { useLang } from "../i18n/index.jsx";

const INFO_MS = 2600;
const ACTION_MS = 5000;
const MAX = 3;

export function useToasts() {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());
  const seq = useRef(0);

  const dismiss = useCallback((id) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setToasts((list) => list.filter((x) => x.id !== id));
  }, []);

  const notify = useCallback(
    (message, opts = {}) => {
      const id = ++seq.current;
      const kind = opts.kind || (String(message).startsWith("⚠") ? "error" : "info");
      const sticky = opts.sticky ?? kind === "error";
      const toast = { id, message: String(message), kind, action: opts.action || null, sticky };
      setToasts((list) => {
        // The same text again replaces the earlier one instead of stacking duplicates.
        const rest = list.filter((x) => x.message !== toast.message);
        const next = [...rest, toast];
        for (const dropped of next.slice(0, Math.max(0, next.length - MAX))) {
          const t = timers.current.get(dropped.id);
          if (t) clearTimeout(t);
          timers.current.delete(dropped.id);
        }
        return next.slice(-MAX);
      });
      if (!sticky) {
        const ms = opts.duration || (toast.action ? ACTION_MS : INFO_MS);
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), ms)
        );
      }
      return id;
    },
    [dismiss]
  );

  useEffect(() => {
    const all = timers.current;
    return () => all.forEach((t) => clearTimeout(t));
  }, []);

  return { toasts, notify, dismiss };
}

const smallBtn = {
  minHeight: 44,
  minWidth: 44,
  padding: "0 14px",
  borderRadius: 9,
  fontSize: 14,
  fontWeight: 800,
  cursor: "pointer",
  fontFamily: "inherit",
};

export function ToastStack({ toasts, dismiss }) {
  const { t: tr } = useLang();
  if (!toasts.length) return null;
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: t.kind === "error" ? "#7A1C14" : "#10331F",
            color: "#fff",
            padding: t.action || t.sticky ? "6px 8px 6px 16px" : "11px 18px",
            borderRadius: 11,
            fontSize: 14,
            lineHeight: 1.35,
            boxShadow: "0 6px 20px rgba(0,0,0,.28)",
          }}
        >
          <span style={{ flex: 1 }}>{t.message}</span>
          {t.action && (
            <button
              style={{ ...smallBtn, border: "none", background: "#F2C94C", color: "#231A00" }}
              onClick={() => {
                dismiss(t.id);
                t.action.run();
              }}
            >
              {t.action.label}
            </button>
          )}
          {(t.sticky || t.action) && (
            <button
              aria-label={tr("Dismiss message")}
              style={{
                ...smallBtn,
                padding: 0,
                border: "1px solid rgba(255,255,255,.35)",
                background: "none",
                color: "#fff",
              }}
              onClick={() => dismiss(t.id)}
            >
              ✕
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
