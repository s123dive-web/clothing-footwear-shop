import { COLOR_SWATCHES } from "../lib/catalog.js";
import { variantLabel } from "../lib/products.js";
import { S } from "./styles.js";
import { useRef, useEffect } from "react";

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

export const Header = ({ title, sub, children }) => (
  <div style={{ display: "flex", alignItems: "flex-end", marginBottom: 18, gap: 12 }}>
    <div>
      <h1 style={{ margin: 0, fontSize: 24, letterSpacing: "-0.03em" }}>{title}</h1>
      {sub && <div style={{ color: "#6B7E74", fontSize: 13, marginTop: 2 }}>{sub}</div>}
    </div>
    <div style={{ marginLeft: "auto" }}>{children}</div>
  </div>
);

export const Card = ({ label, value, sub, accent }) => (
  <div style={{ ...S.card, ...(accent ? { background: "#1B5E43", color: "#fff" } : {}) }}>
    <div
      style={{
        fontSize: 11.5,
        textTransform: "uppercase",
        letterSpacing: "0.07em",
        color: accent ? "#A8CDBA" : "#7A8C81",
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
    <div style={{ fontSize: 12, color: accent ? "#C8E2D4" : "#8A9C90" }}>{sub}</div>
  </div>
);

export const Field = ({ label, children }) => (
  <label style={{ display: "block", marginBottom: 10 }}>
    <div style={{ fontSize: 12, fontWeight: 600, color: "#465", marginBottom: 4 }}>{label}</div>
    {children}
  </label>
);

export const Empty = ({ text, children }) => (
  <div style={{ padding: "22px 10px", textAlign: "center", color: "#8A9", fontSize: 13 }}>
    {text}
    {children && <div style={{ marginTop: 10 }}>{children}</div>}
  </div>
);

export const Section = ({ title, children }) => (
  <section style={{ ...S.panel, marginBottom: 16 }}>
    {title && <div style={S.panelHead}>{title}</div>}
    {children}
  </section>
);

export function Modal({ title, children, onClose }) {
  // Only close when the *press* started on the backdrop itself. Relying on the
  // click target alone closed the dialog whenever a drag (e.g. selecting digits
  // in a number field) began inside an input but released on the overlay.
  const downOnOverlay = useRef(false);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      style={S.overlay}
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
      <div style={S.modal}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>{title}</h2>
          <button
            className="btn ghost small"
            style={{ marginLeft: "auto" }}
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
