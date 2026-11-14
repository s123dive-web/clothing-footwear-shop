// Customers (feature "customerLedger"): per-customer purchases, outstanding Udhari and a
// WhatsApp payment reminder. Built entirely from the bills — nothing extra is stored.
import { useMemo, useState } from "react";
import { INR } from "../lib/format.js";
import { customerLedger, reminderText, outstandingOfSale } from "../lib/customers.js";
import { waLink, waNumber } from "../lib/whatsapp.js";
import { Header, Card, Empty } from "../ui/index.jsx";
import { S } from "../ui/styles.js";
import { useShopConfig } from "../config/shopConfig.js";
import { useDebouncedValue, usePagedLimit } from "../ui/hooks.js";

export function Customers({ sales, goBilling }) {
  const config = useShopConfig();
  const [q, setQ] = useState("");
  const dq = useDebouncedValue(q);
  const [open, setOpen] = useState(null);
  const all = useMemo(() => customerLedger(sales), [sales]);
  const list = useMemo(() => {
    const s = dq.trim().toLowerCase();
    return s ? all.filter((c) => c.key.includes(s) || c.mobile.includes(s)) : all;
  }, [all, dq]);
  const [limit, showMore] = usePagedLimit(100, dq);
  const totalDue = all.reduce((a, c) => a + c.outstanding, 0);

  return (
    <div>
      <Header title="Customers" sub="Purchases and outstanding credit for every named customer" />
      <div style={S.cards}>
        <Card label="Customers" value={all.length} sub="with at least one named bill" />
        <Card
          label="Outstanding"
          value={INR(totalDue)}
          sub={`${all.filter((c) => c.outstanding > 0).length} customers owe`}
          accent
        />
      </div>
      <input
        className="input"
        style={{ margin: "16px 0" }}
        placeholder="Search name or mobile…"
        aria-label="Search customers"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <section style={S.panel}>
        {list.length === 0 ? (
          <Empty
            text={
              all.length === 0
                ? "No named customers yet. Add a customer name when billing."
                : "No customer matches."
            }
          >
            {all.length === 0 ? (
              goBilling && (
                <button className="btn primary" onClick={goBilling}>
                  Start billing
                </button>
              )
            ) : (
              <button className="btn" onClick={() => setQ("")}>
                Clear search
              </button>
            )}
          </Empty>
        ) : (
          list.slice(0, limit).map((c) => (
            <div key={c.key} style={{ borderBottom: "1px solid #EEF3EE" }}>
              <div
                role="button"
                tabIndex={0}
                aria-expanded={open === c.key}
                style={{ ...S.row, cursor: "pointer", minHeight: 44, alignItems: "center" }}
                onClick={() => setOpen(open === c.key ? null : c.key)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") setOpen(open === c.key ? null : c.key);
                }}
              >
                <span>
                  <b>{c.name}</b>
                  {c.mobile && <span style={{ color: "#556A5F" }}> · {c.mobile}</span>}
                  <span style={{ color: "#556A5F", fontSize: 12 }}>
                    {" "}
                    · {c.bills} bill{c.bills === 1 ? "" : "s"} · last {c.lastDate}
                  </span>
                </span>
                <span style={{ textAlign: "right" }}>
                  <b>{INR(c.total)}</b>
                  {c.outstanding > 0 && (
                    <span style={{ color: "#B3261E", fontWeight: 800, marginLeft: 8 }}>
                      {INR(c.outstanding)} due
                    </span>
                  )}
                </span>
              </div>
              {open === c.key && (
                <div
                  style={{
                    background: "#F4F7F4",
                    borderRadius: 8,
                    padding: "8px 12px",
                    margin: "0 0 8px",
                  }}
                >
                  {c.sales.map((s) => (
                    <div
                      key={s.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: 13,
                        padding: "3px 0",
                      }}
                    >
                      <span>
                        {s.date} · {s.payment}
                        {s.billNo ? ` · #${s.billNo}` : ""} ·{" "}
                        {(s.lines || []).map((l) => `${l.name} × ${l.qty}`).join(", ")}
                      </span>
                      <span>
                        {INR(s.total)}
                        {outstandingOfSale(s) > 0 && (
                          <span style={{ color: "#B3261E" }}>
                            {" "}
                            ({INR(outstandingOfSale(s))} due)
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                  {c.outstanding > 0 && (
                    <a
                      className="btn wa"
                      style={{ marginTop: 8 }}
                      href={waLink(
                        c.mobile,
                        reminderText(c, { shop: config.name, upiId: config.upiId, money: INR })
                      )}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      🟢 Send payment reminder{waNumber(c.mobile) ? "" : " (choose contact)"}
                    </a>
                  )}
                </div>
              )}
            </div>
          ))
        )}
        {list.length > limit && (
          <button
            className="btn"
            style={{ display: "block", margin: "12px auto 0" }}
            onClick={showMore}
          >
            Show more ({list.length - limit} more)
          </button>
        )}
      </section>
    </div>
  );
}
