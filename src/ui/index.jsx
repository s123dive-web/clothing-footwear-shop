import { COLOR_SWATCHES } from "../lib/catalog.js";
import { variantLabel } from "../lib/products.js";
import { S } from "./styles.js";
import { useRef, useEffect } from "react";
import { useLang } from "../i18n/index.jsx";

// A colour swatch dot for the variant chips / pickers.
export const ColorDot = ({ color }) => {
  const hit = COLOR_SWATCHES.find(
    (c) => c.name.toLowerCase() === String(color || "").toLowerCase()
  );
  const bg = hit ? hit.hex : "#CBD3CC";
  return (
    <span
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: bg,
        border: "1px solid rgba(0,0,0,.15)",
        marginRight: 4,
        verticalAlign: "middle",
      }}
    />
  );
};

// One small chip per variant: "M · Maroon ×4" (red when at/below its low threshold).
export const VariantChip = ({ v }) => {
  const low = (Number(v.stockQty) || 0) <= (Number(v.lowAt) || 0);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        fontSize: 11.5,
        padding: "2px 7px",
        borderRadius: 20,
        marginRight: 5,
        marginBottom: 4,
        background: low ? "#FBECEF" : "#F1F4F1",
        color: low ? "#B0324C" : "#3A5547",
        border: "1px solid " + (low ? "#F0CDD6" : "#E2EAE3"),
      }}
    >
      {v.color ? <ColorDot color={v.color} /> : null}
      {variantLabel(v)} <b style={{ marginLeft: 2 }}>×{Number(v.stockQty) || 0}</b>
    </span>
  );
};

// `title`, `sub` and Empty's `text` are looked up in the strings table when they are plain
// strings, so screens get translated titles without each one calling t().
const tr = (t, v) => (typeof v === "string" ? t(v) : v);

export const Header = ({ title, sub, children }) => {
  const { t } = useLang();
  return (
    <div style={{ display: "flex", alignItems: "flex-end", marginBottom: 18, gap: 12 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 24, letterSpacing: "-0.03em" }}>{tr(t, title)}</h1>
        {sub && <div style={{ color: "#556A5F", fontSize: 13, marginTop: 2 }}>{tr(t, sub)}</div>}
      </div>
      <div style={{ marginLeft: "auto" }}>{children}</div>
    </div>
  );
};

export const Card = ({ label, value, sub, accent }) => (
  <div style={{ ...S.card, ...(accent ? { background: "#1B5E43", color: "#fff" } : {}) }}>
    <div
      style={{
        fontSize: 11.5,
        textTransform: "uppercase",
        letterSpacing: "0.07em",
        color: accent ? "#C6E3D4" : "#5A6E63",
      }}
    >
      {label}
    </div>
    <div
      style={{
        fontSize: 24,
        fontWeight: 800,
        margin: "6px 0 2px",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {value}
    </div>
    <div style={{ fontSize: 12, color: accent ? "#C8E2D4" : "#5C6E63" }}>{sub}</div>
  </div>
);

export const Field = ({ label, children }) => (
  <label style={{ display: "block", marginBottom: 10 }}>
    <div style={{ fontSize: 12, fontWeight: 600, color: "#465", marginBottom: 4 }}>{label}</div>
    {children}
  </label>
);

export const Empty = ({ text, children }) => {
  const { t } = useLang();
  return (
    <div style={{ padding: "22px 10px", textAlign: "center", color: "#5A6E63", fontSize: 13 }}>
      {tr(t, text)}
      {children && <div style={{ marginTop: 10 }}>{children}</div>}
    </div>
  );
};

export const Section = ({ title, children }) => (
  <section style={{ ...S.panel, marginBottom: 16 }}>
    {title && <div style={S.panelHead}>{title}</div>}
    {children}
  </section>
);

// Open modals, innermost last — Esc and the focus trap only act for the top one.
const modalStack = [];
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, children, onClose, zIndex }) {
  // Only close when the *press* started on the backdrop itself. Relying on the
  // click target alone closed the dialog whenever a drag (e.g. selecting digits
  // in a number field) began inside an input but released on the overlay.
  const downOnOverlay = useRef(false);
  const box = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const me = {};
    modalStack.push(me);
    const opener = document.activeElement; // focus returns here when the dialog closes
    const node = box.current;
    // Initial focus: an explicit [data-autofocus], else whatever autoFocus already took,
    // else the first control. Keeps keyboard and screen-reader users inside the dialog.
    if (node) {
      const wanted = node.querySelector("[data-autofocus]");
      if (wanted) wanted.focus();
      else if (!node.contains(document.activeElement)) {
        const first = node.querySelector(FOCUSABLE);
        (first || node).focus();
      }
    }
    const onKey = (e) => {
      if (modalStack[modalStack.length - 1] !== me) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !node) return;
      // Focus trap: Tab / Shift+Tab cycle within the dialog.
      const items = [...node.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return e.preventDefault();
      const first = items[0];
      const last = items[items.length - 1];
      if (
        e.shiftKey &&
        (document.activeElement === first || !node.contains(document.activeElement))
      ) {
        e.preventDefault();
        last.focus();
      } else if (
        !e.shiftKey &&
        (document.activeElement === last || !node.contains(document.activeElement))
      ) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      const i = modalStack.indexOf(me);
      if (i >= 0) modalStack.splice(i, 1);
      if (opener && typeof opener.focus === "function" && document.contains(opener)) opener.focus();
    };
  }, []);
  return (
    <div
      style={zIndex ? { ...S.overlay, zIndex } : S.overlay}
      onMouseDown={(e) => {
        downOnOverlay.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOnOverlay.current) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div style={S.modal} ref={box} tabIndex={-1}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>{title}</h2>
          <button
            className="btn ghost"
            style={{ marginLeft: "auto", minWidth: 44, minHeight: 44, padding: 0 }}
            aria-label="Close dialog"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------- loading skeletons ----------
// Grey shimmering placeholders in the shape of the content that is about to appear, instead
// of a bare "Loading…". `label` is read by screen readers.
export const Skeleton = ({ height = 16, width = "100%", style }) => (
  <div className="skel" style={{ height, width, ...style }} />
);
export function PageSkeleton({ label = "Loading…", cards = 4, rows = 5 }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} style={{ padding: "4px 0" }}>
      <Skeleton height={26} width={200} style={{ marginBottom: 8 }} />
      <Skeleton height={13} width={280} style={{ marginBottom: 20 }} />
      {cards > 0 && (
        <div style={{ ...S.cards, marginBottom: 16 }}>
          {Array.from({ length: cards }, (_, i) => (
            <Skeleton key={i} height={86} style={{ borderRadius: 14 }} />
          ))}
        </div>
      )}
      <section style={S.panel}>
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} height={18} width={`${92 - i * 9}%`} style={{ margin: "12px 0" }} />
        ))}
      </section>
      <span className="sr-only">{label}</span>
    </div>
  );
}

// Empty-state action for screens whose "first step" is the form at the top of the page.
export function focusFirstField() {
  const el = document.querySelector(
    "main input:not([type=hidden]):not([type=file]):not([type=date]):not([type=month])"
  );
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (el) el.focus({ preventScroll: true });
}
