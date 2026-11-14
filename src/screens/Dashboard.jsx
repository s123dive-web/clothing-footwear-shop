import { useState, useEffect, lazy, Suspense } from "react";
import { todayStr, money, INR } from "../lib/format.js";
import { productStock, productLowVariants, variantLabel } from "../lib/products.js";
import { Header, Card, Empty } from "../ui/index.jsx";
import { S } from "../ui/styles.js";

// Charts (and with them the recharts bundle) load on demand — see DashboardCharts.jsx.
const DashTrendCharts = lazy(() =>
  import("./DashboardCharts.jsx").then((m) => ({ default: m.DashTrendCharts }))
);
const DashOverTimeCharts = lazy(() =>
  import("./DashboardCharts.jsx").then((m) => ({ default: m.DashOverTimeCharts }))
);
const ChartsLoading = () => (
  <section style={{ ...S.panel, marginTop: 16, color: "#8A9C90", fontSize: 13 }}>
    Loading charts…
  </section>
);

// ---------- Dashboard ----------
export function Dashboard({
  items,
  sales,
  lowStock,
  goBilling,
  salesFrom = null,
  olderMonthly,
  loadOlderSales,
}) {
  const [date, setDate] = useState(todayStr());
  const isToday = date === todayStr();
  // Viewing a day from before the loaded window → fetch that month once.
  useEffect(() => {
    if (salesFrom && date < salesFrom && loadOlderSales) loadOlderSales(date);
  }, [date, salesFrom, loadOlderSales]);
  const daySales = sales.filter((s) => s.date === date);
  const rev = money(daySales.reduce((a, s) => a + s.total, 0));
  const profit = money(daySales.reduce((a, s) => a + s.profit, 0));
  const stockValue = money(
    items.reduce((a, i) => a + (Number(i.purchasePrice) || 0) * productStock(i), 0)
  );
  const month = date.slice(0, 7);
  const monthSales = sales.filter((s) => s.date.startsWith(month));
  const monthRev = money(monthSales.reduce((a, s) => a + s.total, 0));
  const monthProfit = money(monthSales.reduce((a, s) => a + s.profit, 0));
  // Sales/revenue above are amounts BOOKED (they include Udhari/credit bills at full value).
  // These are the still-unpaid (on-credit) portions, shown as a sub-note so the gap is visible.
  const udhariOf = (list) =>
    money(
      list.reduce(
        (a, s) => a + (s.payment === "Udhari" ? Math.max(0, (s.total || 0) - (s.paid || 0)) : 0),
        0
      )
    );
  const dayUdhari = udhariOf(daySales);
  const monthUdhari = udhariOf(monthSales);
  const monthName = new Date(date + "T00:00").toLocaleDateString("en-IN", { month: "long" });
  const niceDate = new Date(date + "T00:00").toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return (
    <div>
      <Header title="Dashboard" sub={niceDate}>
        <label style={{ fontSize: 12, color: "#6B7E74" }}>
          View day{" "}
          <input
            type="date"
            className="input"
            style={{ width: "auto", marginLeft: 4 }}
            value={date}
            max={todayStr()}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
      </Header>
      <div style={S.cards}>
        <Card
          label={isToday ? "Today's sales" : "Sales (this day)"}
          value={INR(rev)}
          sub={daySales.length + " bills" + (dayUdhari > 0 ? ` · ${INR(dayUdhari)} on udhari` : "")}
        />
        <Card
          label={isToday ? "Today's profit" : "Profit (this day)"}
          value={INR(profit)}
          sub="after item cost"
          accent
        />
        <Card
          label={monthName + " revenue"}
          value={INR(monthRev)}
          sub={"month to date" + (monthUdhari > 0 ? ` · ${INR(monthUdhari)} on udhari` : "")}
        />
        <Card
          label={monthName + " profit"}
          value={INR(monthProfit)}
          sub="month to date · after item cost"
          accent
        />
        <Card
          label="Stock value"
          value={INR(stockValue)}
          sub={items.length + " products (at cost)"}
        />
      </div>

      <Suspense fallback={<ChartsLoading />}>
        <DashTrendCharts sales={sales} monthSales={monthSales} monthName={monthName} />
      </Suspense>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
        <section style={S.panel}>
          <div style={S.panelHead}>
            Low stock — reorder soon
            {lowStock.length > 0 && (
              <span style={{ ...S.badge, position: "static", marginLeft: 8 }}>
                {lowStock.length}
              </span>
            )}
          </div>
          {lowStock.length === 0 ? (
            <Empty text="All products are well stocked." />
          ) : (
            lowStock.slice(0, 8).map((i) => {
              const lows = productLowVariants(i);
              return (
                <div key={i.id} style={S.row}>
                  <span>
                    {i.name}
                    {lows.length ? (
                      <span style={{ color: "#9AA", fontSize: 11 }}>
                        {" "}
                        · {lows.map(variantLabel).slice(0, 3).join(", ")}
                      </span>
                    ) : null}
                  </span>
                  <span style={{ color: "#C44536", fontWeight: 700 }}>{productStock(i)} left</span>
                </div>
              );
            })
          )}
        </section>
        <section style={S.panel}>
          <div style={S.panelHead}>{isToday ? "Recent bills" : "Bills on this day"}</div>
          {daySales.length === 0 ? (
            <Empty text={isToday ? "No bills yet today." : "No bills on this day."}>
              {isToday && (
                <button className="btn primary" onClick={goBilling}>
                  Start billing
                </button>
              )}
            </Empty>
          ) : (
            [...daySales]
              .reverse()
              .slice(0, 8)
              .map((s) => (
                <div key={s.id} style={S.row}>
                  <span>
                    {s.time} · {s.lines.length} items
                  </span>
                  <b>{INR(s.total)}</b>
                </div>
              ))
          )}
        </section>
      </div>

      <Suspense fallback={<ChartsLoading />}>
        <DashOverTimeCharts
          sales={sales}
          salesFrom={salesFrom}
          olderMonthly={olderMonthly}
          loadOlderSales={loadOlderSales}
        />
      </Suspense>
    </div>
  );
}
