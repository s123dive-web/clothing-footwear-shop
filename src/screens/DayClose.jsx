// Day Close (feature "dayClose"): today's takings by payment mode, the cash that should be in
// the drawer, the cash actually counted, and a one-tap summary to copy or send.
import { useEffect, useMemo, useState } from "react";
import { INR, todayStr } from "../lib/format.js";
import { dayTotals, expectedCash, closeSummaryText } from "../lib/dayClose.js";
import { waLink } from "../lib/whatsapp.js";
import { subscribeDayClose } from "../lib/sync.js";
import { Header, Card } from "../ui/index.jsx";
import { S } from "../ui/styles.js";
import { useShopConfig } from "../config/shopConfig.js";

export function DayClose({
  sales,
  expenses,
  salesFrom,
  loadOlderSales,
  saveDayClose,
  notify,
  log,
}) {
  const config = useShopConfig();
  const [date, setDate] = useState(todayStr());
  const [opening, setOpening] = useState("");
  const [counted, setCounted] = useState("");
  const [saved, setSaved] = useState(null);

  // An old day's cash/UPI bills may be outside the loaded window → fetch that month once.
  useEffect(() => {
    if (salesFrom && date < salesFrom && loadOlderSales) loadOlderSales(date);
  }, [date, salesFrom, loadOlderSales]);
  // The close already saved for this date (from any device), if there is one.
  useEffect(() => {
    setSaved(null);
    return subscribeDayClose(date, (rec) => {
      setSaved(rec);
      if (rec) {
        setOpening(rec.opening != null ? String(rec.opening) : "");
        setCounted(rec.counted != null ? String(rec.counted) : "");
      } else {
        setOpening("");
        setCounted("");
      }
    });
  }, [date]);

  const t = useMemo(() => dayTotals(sales, expenses, date), [sales, expenses, date]);
  const expected = expectedCash(t, { opening: +opening || 0 });
  const hasCount = counted.trim() !== "" && Number.isFinite(+counted);
  const diff = hasCount ? Math.round((+counted - expected) * 100) / 100 : null;
  const close = { opening: +opening || 0, expected, ...(hasCount ? { counted: +counted } : {}) };
  const summary = closeSummaryText(t, close, { shop: config.name, money: INR });

  const save = () => {
    if (!hasCount) return notify("Enter the cash you counted.");
    saveDayClose(date, { date, ...close, diff, at: Date.now() });
    log("sale", `Day close ${date}: expected ${INR(expected)}, counted ${INR(+counted)}`);
    notify(
      diff === 0
        ? "Day closed — cash matches ✅"
        : `Day closed — ${diff > 0 ? "over" : "short"} by ${INR(Math.abs(diff))}`
    );
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(summary);
      notify("Summary copied");
    } catch {
      notify("⚠ Couldn't copy — select the text below and copy it.");
    }
  };

  const row = (label, value, strong) => (
    <div style={{ ...S.row, fontWeight: strong ? 800 : 500 }}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );

  return (
    <div>
      <Header
        title="Day Close"
        sub="Cash, UPI and credit for the day — and what should be in the drawer"
      >
        <label style={{ fontSize: 12, color: "#556A5F" }}>
          Day{" "}
          <input
            type="date"
            className="input"
            style={{ width: "auto", marginLeft: 4 }}
            value={date}
            max={todayStr()}
            onChange={(e) => setDate(e.target.value || todayStr())}
          />
        </label>
      </Header>
      <div style={S.cards}>
        <Card
          label="Billed"
          value={INR(t.revenue)}
          sub={`${t.bills} bill${t.bills === 1 ? "" : "s"}`}
        />
        <Card
          label="Cash received"
          value={INR(t.cashIn)}
          sub="cash bills + credit repaid in cash"
          accent
        />
        <Card label="UPI received" value={INR(t.upiIn)} sub="UPI bills + credit repaid by UPI" />
        <Card label="Udhari given" value={INR(t.udhariBilled)} sub="credit bills made this day" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
        <section style={S.panel}>
          <div style={S.panelHead}>Breakdown</div>
          {row("Cash bills", INR(t.cashSales))}
          {row("Credit repaid — cash", INR(t.udhariCashIn))}
          {row("UPI bills", INR(t.upiSales))}
          {row("Credit repaid — UPI", INR(t.udhariUpiIn))}
          {t.creditUsed > 0 && row("Exchange credit used (no money)", INR(t.creditUsed))}
          {row("Expenses", "− " + INR(t.expenses))}
        </section>

        <section style={S.panel}>
          <div style={S.panelHead}>Cash drawer</div>
          <label style={{ display: "block", marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#465", marginBottom: 4 }}>
              Opening cash (float)
            </div>
            <input
              className="input"
              type="number"
              inputMode="decimal"
              min="0"
              value={opening}
              onChange={(e) => setOpening(e.target.value)}
              placeholder="0"
            />
          </label>
          {row("Expected in drawer", INR(expected), true)}
          <label style={{ display: "block", margin: "10px 0" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#465", marginBottom: 4 }}>
              Cash counted
            </div>
            <input
              className="input"
              type="number"
              inputMode="decimal"
              min="0"
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
            />
          </label>
          {diff != null && (
            <div
              role="status"
              style={{
                fontWeight: 800,
                fontSize: 15,
                margin: "6px 0 12px",
                color: diff === 0 ? "#1B5E43" : "#B3261E",
              }}
            >
              {diff === 0
                ? "Cash matches ✅"
                : diff > 0
                  ? `Over by ${INR(diff)}`
                  : `Short by ${INR(-diff)}`}
            </div>
          )}
          <button className="btn primary big" style={{ width: "100%" }} onClick={save}>
            {saved ? "Update day close" : "Close the day"}
          </button>
          {saved && (
            <div style={{ fontSize: 12, color: "#556A5F", marginTop: 8 }}>
              Closed — counted {INR(saved.counted)} against {INR(saved.expected)} expected.
            </div>
          )}
        </section>
      </div>

      <section style={{ ...S.panel, marginTop: 16 }}>
        <div style={S.panelHead}>Daily summary</div>
        <pre
          aria-label="Daily summary text"
          style={{
            whiteSpace: "pre-wrap",
            fontFamily: "inherit",
            fontSize: 13.5,
            margin: "0 0 12px",
          }}
        >
          {summary}
        </pre>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn" onClick={copy}>
            📋 Copy summary
          </button>
          <a
            className="btn wa"
            href={waLink("", summary)}
            target="_blank"
            rel="noopener noreferrer"
          >
            🟢 Send on WhatsApp
          </a>
        </div>
      </section>
    </div>
  );
}
