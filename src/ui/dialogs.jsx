// In-app replacements for the browser's confirm() / prompt() / alert().
//
//   if (!(await confirmDialog({ title, message, confirmLabel, danger }))) return;
//   const name = await promptDialog({ title, label });   // string, or null if cancelled
//   await alertDialog({ title, message });
//
// One <DialogHost /> is mounted by StoreManager. Dialogs use the shared Modal (focus trap, Esc),
// have large tap targets, put Cancel first and focused by default, and show a destructive
// confirm in red. If no host is mounted the calls fall back to the native dialogs.
import { useEffect, useState } from "react";
import { Modal } from "./index.jsx";

let host = null; // (request) => void, set by the mounted DialogHost
const waiting = [];

function ask(req) {
  return new Promise((resolve) => {
    const full = { ...req, resolve };
    if (host) host(full);
    else waiting.push(full);
  });
}

export function confirmDialog(opts) {
  const o = typeof opts === "string" ? { message: opts } : opts;
  if (!host && typeof window !== "undefined" && !waiting.length && !hostExpected)
    return Promise.resolve(window.confirm(o.message));
  return ask({ kind: "confirm", ...o });
}
export function promptDialog(opts) {
  if (!host && typeof window !== "undefined" && !hostExpected)
    return Promise.resolve(window.prompt(opts.label || opts.title || ""));
  return ask({ kind: "prompt", ...opts });
}
export function alertDialog(opts) {
  const o = typeof opts === "string" ? { message: opts } : opts;
  if (!host && typeof window !== "undefined" && !hostExpected)
    return Promise.resolve(window.alert(o.message));
  return ask({ kind: "alert", ...o });
}

// True once a host has ever mounted, so a request made during a brief remount is queued
// instead of falling back to a native dialog.
let hostExpected = false;

const btn = {
  minHeight: 48,
  padding: "0 18px",
  borderRadius: 10,
  border: "none",
  fontSize: 15,
  fontWeight: 700,
  cursor: "pointer",
  fontFamily: "inherit",
  flex: 1,
};

export function DialogHost() {
  const [queue, setQueue] = useState([]);
  const [text, setText] = useState("");
  useEffect(() => {
    hostExpected = true;
    host = (req) => setQueue((q) => [...q, req]);
    while (waiting.length) host(waiting.shift());
    return () => {
      host = null;
    };
  }, []);
  const cur = queue[0];
  useEffect(() => {
    setText((cur && cur.initial) || "");
  }, [cur]);
  if (!cur) return null;

  const finish = (value) => {
    cur.resolve(value);
    setQueue((q) => q.slice(1));
  };
  const cancelValue = cur.kind === "confirm" ? false : cur.kind === "prompt" ? null : undefined;
  const okValue = cur.kind === "confirm" ? true : cur.kind === "prompt" ? text : undefined;
  const title =
    cur.title ||
    (cur.kind === "confirm"
      ? "Please confirm"
      : cur.kind === "prompt"
        ? "Enter a value"
        : "Notice");

  return (
    <Modal title={title} onClose={() => finish(cancelValue)} zIndex={80}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (cur.kind === "prompt" && !text.trim()) return;
          finish(okValue);
        }}
      >
        {cur.message && (
          <p style={{ margin: "0 0 14px", fontSize: 14.5, lineHeight: 1.5, color: "#2B3A31" }}>
            {cur.message}
          </p>
        )}
        {cur.kind === "prompt" && (
          <label style={{ display: "block", marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#465", marginBottom: 4 }}>
              {cur.label || "Value"}
            </div>
            <input
              className="input"
              data-autofocus
              value={text}
              placeholder={cur.placeholder || ""}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
        )}
        <div style={{ display: "flex", gap: 10 }}>
          {cur.kind !== "alert" && (
            <button
              type="button"
              // Cancel is the default (focused) choice for confirms — a stray Enter is safe.
              {...(cur.kind === "confirm" ? { "data-autofocus": true } : {})}
              style={{ ...btn, background: "#E4ECE5", color: "#23402F" }}
              onClick={() => finish(cancelValue)}
            >
              {cur.cancelLabel || "Cancel"}
            </button>
          )}
          <button
            type="submit"
            {...(cur.kind === "alert" ? { "data-autofocus": true } : {})}
            style={{
              ...btn,
              background: cur.danger ? "#B3261E" : "#1B5E43",
              color: "#fff",
            }}
          >
            {cur.confirmLabel || (cur.kind === "alert" ? "OK" : cur.danger ? "Delete" : "OK")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
