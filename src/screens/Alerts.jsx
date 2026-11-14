import { useState, useMemo } from "react";
import { Header, Empty, ColorDot } from "../ui/index.jsx";
import { GROUPS } from "../lib/catalog.js";
import { S } from "../ui/styles.js";
import { iconFor } from "../lib/domain.js";
import { variantLabel } from "../lib/products.js";

// ---------- Alerts ----------
// Low-stock alerts are evaluated at the VARIANT level: each row is a single size/colour variant
// that has fallen to or below its own threshold (e.g. "Kurti X — size M low").
export function Alerts({ items, goInventory }) {
  const [view, setView] = useState("low"); // low | out
  const [grp, setGrp] = useState("All");
  const rows = useMemo(() => {
    const inGroup = (i) => grp === "All" || (i.category || "") === grp;
    const out = [];
    items.filter(inGroup).forEach((p) => {
      (p.variants || []).forEach((v) => {
        const qty = Number(v.stockQty) || 0;
        const lowAt = Number(v.lowAt) || 0;
        if (qty <= lowAt) out.push({ p, v, qty, lowAt });
      });
    });
    return out.sort((a, b) => a.qty - b.qty || String(a.p.name).localeCompare(String(b.p.name)));
  }, [items, grp]);

  const lowRows = rows;
  const outRows = rows.filter((r) => r.qty <= 0);
  const list = view === "out" ? outRows : lowRows;
  const tabs = [
    ["low", "Low / out", lowRows.length],
    ["out", "Out of stock", outRows.length],
  ];

  return (
    <div>
      <Header title="Alerts" sub="Size/colour variants running low (lowest stock first)">
        <button className="btn ghost small" onClick={goInventory}>
          Go to inventory
        </button>
      </Header>

      <div
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 14,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        {tabs.map(([k, lbl, n]) => (
          <button
            key={k}
            className={"btn small " + (view === k ? "primary" : "")}
            onClick={() => setView(k)}
          >
            {lbl} <b>({n})</b>
          </button>
        ))}
        <div
          style={{
            display: "flex",
            border: "1.5px solid #E1D4DA",
            borderRadius: 9,
            overflow: "hidden",
            marginLeft: "auto",
          }}
        >
          {["All", ...GROUPS].map((g) => (
            <button key={g} className={"seg" + (grp === g ? " on" : "")} onClick={() => setGrp(g)}>
              {g}
            </button>
          ))}
        </div>
      </div>

      <section style={S.panel}>
        {list.length === 0 ? (
          <Empty text="Nothing here — stock looks healthy." />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Product</th>
                <th>Category</th>
                <th>Variant</th>
                <th style={{ textAlign: "right" }}>Stock</th>
                <th style={{ textAlign: "right" }}>Alert below</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.p.id + "|" + r.v.id}>
                  <td style={{ fontWeight: 600 }}>
                    <span style={{ marginRight: 6 }}>{iconFor(r.p)}</span>
                    {r.p.name}
                  </td>
                  <td style={{ color: "#677" }}>
                    {[r.p.category, r.p.subcategory].filter(Boolean).join(" · ")}
                  </td>
                  <td>
                    <ColorDot color={r.v.color} />
                    {variantLabel(r.v)}
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontWeight: 800,
                      color: r.qty <= 0 ? "#C44536" : "#B0762A",
                    }}
                  >
                    {r.qty}
                  </td>
                  <td style={{ textAlign: "right", color: "#789" }}>{r.lowAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
