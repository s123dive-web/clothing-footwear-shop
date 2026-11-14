// Restock (feature "restockSuggestions"): which sizes/colours are selling fastest and how many
// days their stock will last, with a suggested order quantity.
import { useMemo, useState } from "react";
import { todayStr } from "../lib/format.js";
import { restockSuggestions, fastSizes } from "../lib/restock.js";
import { Header, Empty } from "../ui/index.jsx";
import { S } from "../ui/styles.js";

export function Restock({ items, sales, goInventory }) {
  const [days, setDays] = useState(30);
  const rows = useMemo(
    () => restockSuggestions(items, sales, todayStr(), { days, cover: 30 }),
    [items, sales, days]
  );
  const sizes = useMemo(() => fastSizes(sales, todayStr(), days).slice(0, 8), [sales, days]);
  const urgent = rows.filter((r) => r.daysLeft != null && r.daysLeft <= 7).length;

  return (
    <div>
      <Header
        title="Restock"
        sub={`Based on the last ${days} days of sales · ${urgent} variant${urgent === 1 ? "" : "s"} will run out within a week`}
      >
        <select
          className="input"
          style={{ width: "auto" }}
          aria-label="Sales period"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
          <option value={60}>Last 60 days</option>
        </select>
      </Header>

      {sizes.length > 0 && (
        <section style={{ ...S.panel, marginBottom: 16 }}>
          <div style={S.panelHead}>Fast-moving sizes</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {sizes.map((s) => (
              <span
                key={s.size}
                style={{
                  background: "#FFF9EC",
                  border: "1.5px solid #E1D4DA",
                  borderRadius: 16,
                  padding: "6px 12px",
                  fontSize: 13,
                  fontWeight: 700,
                }}
              >
                {s.size} · {s.qty} sold
              </span>
            ))}
          </div>
        </section>
      )}

      <section style={S.panel}>
        {rows.length === 0 ? (
          <Empty text="Nothing to restock — no recent sales and no low stock.">
            {goInventory && (
              <button className="btn primary" onClick={goInventory}>
                Open Inventory
              </button>
            )}
          </Empty>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Product</th>
                <th>Size · Colour</th>
                <th style={{ textAlign: "right" }}>In stock</th>
                <th style={{ textAlign: "right" }}>Sold</th>
                <th style={{ textAlign: "right" }}>Per day</th>
                <th style={{ textAlign: "right" }}>Days left</th>
                <th style={{ textAlign: "right" }}>Order</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.productId + "|" + r.variantId}>
                  <td style={{ fontWeight: 600 }}>
                    {r.name}{" "}
                    {r.fast && (
                      <span style={{ ...S.badgeInline, background: "#FFF0C2", color: "#6B4700" }}>
                        fast
                      </span>
                    )}
                  </td>
                  <td>{[r.size, r.color].filter(Boolean).join(" · ") || "—"}</td>
                  <td
                    style={{
                      textAlign: "right",
                      color: r.low ? "#B3261E" : undefined,
                      fontWeight: r.low ? 800 : 400,
                    }}
                  >
                    {r.stock}
                  </td>
                  <td style={{ textAlign: "right" }}>{r.sold}</td>
                  <td style={{ textAlign: "right" }}>{r.perDay}</td>
                  <td
                    style={{
                      textAlign: "right",
                      fontWeight: 800,
                      color: r.daysLeft != null && r.daysLeft <= 7 ? "#B3261E" : "#23402F",
                    }}
                  >
                    {r.daysLeft == null ? "—" : r.daysLeft}
                  </td>
                  <td style={{ textAlign: "right", fontWeight: 800 }}>
                    {r.suggest > 0 ? "+" + r.suggest : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
