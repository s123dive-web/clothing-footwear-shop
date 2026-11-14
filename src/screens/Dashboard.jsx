import { useState, useMemo } from "react";
import { todayStr, money, dateStr, INR } from "../lib/format.js";
import { productStock, productLowVariants, variantLabel } from "../lib/products.js";
import {
  buildSeries,
  DASH_PERIODS,
  buildDaily,
  buildWeekly,
  ChartCard,
  inrTick,
  renderPayMix,
  renderPayTrend,
  barLabel,
} from "../ui/charts.jsx";
import { Header, Card, Empty } from "../ui/index.jsx";
import { S } from "../ui/styles.js";
import {
  AreaChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Area,
  BarChart,
  Bar,
  Legend,
} from "recharts";

// ---------- Dashboard ----------
export function Dashboard({ items, sales, lowStock, goBilling }) {
  const [date, setDate] = useState(todayStr());
  const isToday = date === todayStr();
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
  const trend = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 13);
    return buildSeries(sales, [], dateStr(d), todayStr());
  }, [sales]);

  // --- "Over time" charts: user picks a period, we show day-wise & week-wise series. ---
  const [period, setPeriod] = useState("7d");
  const [customFrom, setCustomFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    return dateStr(d);
  });
  const [customTo, setCustomTo] = useState(todayStr());
  const range = useMemo(() => {
    if (period === "custom") return { from: customFrom, to: customTo };
    const opt = DASH_PERIODS.find((p) => p[0] === period);
    const d = new Date();
    (opt?.[2] || (() => {}))(d);
    return { from: dateStr(d), to: todayStr() };
  }, [period, customFrom, customTo]);
  const dailySeries = useMemo(
    () => buildDaily(sales, range.from, range.to),
    [sales, range.from, range.to]
  );
  const weeklySeries = useMemo(
    () => buildWeekly(sales, range.from, range.to),
    [sales, range.from, range.to]
  );
  const rangeLabel = useMemo(() => {
    const f = (ds) =>
      new Date(ds + "T00:00").toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
    return range.from && range.to ? `${f(range.from)} – ${f(range.to)}` : "";
  }, [range]);

  // Fixed monthly overview: one bucket per calendar month from May 2026 through the current
  // month, regardless of the day picker above. Months with no sales show as zero bars.
  const monthly = useMemo(() => {
    const nowKey = todayStr().slice(0, 7);
    const keys = [];
    let y = 2026,
      m = 5; // start: May 2026
    const [ey, em] = nowKey.split("-").map(Number);
    while (y < ey || (y === ey && m <= em)) {
      keys.push(`${y}-${String(m).padStart(2, "0")}`);
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
    const agg = Object.fromEntries(keys.map((k) => [k, { revenue: 0, profit: 0 }]));
    sales.forEach((s) => {
      const k = (s.date || "").slice(0, 7);
      if (agg[k]) {
        agg[k].revenue += s.total || 0;
        agg[k].profit += s.profit || 0;
      }
    });
    return keys.map((k) => ({
      key: k,
      label: new Date(k + "-01T00:00").toLocaleDateString("en-IN", {
        month: "short",
        year: "2-digit",
      }),
      revenue: money(agg[k].revenue),
      profit: money(agg[k].profit),
    }));
  }, [sales]);

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

      <div style={{ marginTop: 16 }}>
        <ChartCard title="Sales — last 14 days" height={200}>
          <AreaChart data={trend} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
            <defs>
              <linearGradient id="gDash" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#1B5E43" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#1B5E43" stopOpacity={0.03} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#678" }}
              interval="preserveStartEnd"
              minTickGap={16}
            />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Area
              type="monotone"
              dataKey="revenue"
              name="Revenue"
              stroke="#1B5E43"
              strokeWidth={2}
              fill="url(#gDash)"
            />
          </AreaChart>
        </ChartCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <ChartCard title={`Payments in ${monthName} — Total vs Cash vs UPI`} height={200}>
          {renderPayMix(monthSales)}
        </ChartCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <ChartCard title="Total vs Cash vs UPI — last 14 days" height={200}>
          {renderPayTrend(trend)}
        </ChartCard>
      </div>

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

      <div
        style={{
          fontSize: 13,
          fontWeight: 800,
          color: "#10331F",
          letterSpacing: ".02em",
          margin: "22px 0 8px",
        }}
      >
        Monthly overview <span style={{ fontWeight: 500, color: "#8A9C90" }}>(from May 2026)</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <ChartCard title="Monthly revenue" height={220}>
          <BarChart data={monthly} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Bar
              dataKey="revenue"
              name="Revenue"
              fill="#1B5E43"
              radius={[3, 3, 0, 0]}
              label={barLabel}
            />
          </BarChart>
        </ChartCard>
        <ChartCard title="Monthly profit" height={220}>
          <BarChart data={monthly} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Bar
              dataKey="profit"
              name="Profit"
              fill="#E8A33D"
              radius={[3, 3, 0, 0]}
              label={barLabel}
            />
          </BarChart>
        </ChartCard>
      </div>
      <div style={{ marginTop: 16 }}>
        <ChartCard title="Monthly revenue vs profit" height={240}>
          <BarChart data={monthly} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar
              dataKey="revenue"
              name="Revenue"
              fill="#1B5E43"
              radius={[3, 3, 0, 0]}
              label={barLabel}
            />
            <Bar
              dataKey="profit"
              name="Profit"
              fill="#E8A33D"
              radius={[3, 3, 0, 0]}
              label={barLabel}
            />
          </BarChart>
        </ChartCard>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 10,
          margin: "22px 0 8px",
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 800, color: "#10331F", letterSpacing: ".02em" }}>
          Revenue &amp; profit over time
        </span>
        <select
          className="input"
          style={{ width: "auto" }}
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
        >
          {DASH_PERIODS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        {period === "custom" && (
          <>
            <input
              type="date"
              className="input"
              style={{ width: "auto" }}
              value={customFrom}
              max={customTo || todayStr()}
              onChange={(e) => setCustomFrom(e.target.value)}
            />
            <span style={{ color: "#8A9C90" }}>to</span>
            <input
              type="date"
              className="input"
              style={{ width: "auto" }}
              value={customTo}
              max={todayStr()}
              onChange={(e) => setCustomTo(e.target.value)}
            />
          </>
        )}
        {rangeLabel && <span style={{ fontSize: 12, color: "#8A9C90" }}>{rangeLabel}</span>}
      </div>

      <div style={{ fontSize: 12, fontWeight: 700, color: "#4A5D52", margin: "10px 0 6px" }}>
        Day wise
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <ChartCard title="Day wise revenue" height={220}>
          <BarChart data={dailySeries} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#678" }}
              interval="preserveStartEnd"
              minTickGap={16}
            />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Bar dataKey="revenue" name="Revenue" fill="#1B5E43" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ChartCard>
        <ChartCard title="Day wise profit" height={220}>
          <BarChart data={dailySeries} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#678" }}
              interval="preserveStartEnd"
              minTickGap={16}
            />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Bar dataKey="profit" name="Profit" fill="#E8A33D" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ChartCard>
      </div>
      <div style={{ marginTop: 16 }}>
        <ChartCard title="Day wise revenue vs profit" height={240}>
          <BarChart data={dailySeries} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#678" }}
              interval="preserveStartEnd"
              minTickGap={16}
            />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="revenue" name="Revenue" fill="#1B5E43" radius={[3, 3, 0, 0]} />
            <Bar dataKey="profit" name="Profit" fill="#E8A33D" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ChartCard>
      </div>

      <div style={{ fontSize: 12, fontWeight: 700, color: "#4A5D52", margin: "18px 0 6px" }}>
        Week wise <span style={{ fontWeight: 500, color: "#8A9C90" }}>(week starting Mon)</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <ChartCard title="Week wise revenue" height={220}>
          <BarChart data={weeklySeries} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#678" }}
              interval="preserveStartEnd"
              minTickGap={16}
            />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} labelFormatter={(l) => "Week of " + l} />
            <Bar
              dataKey="revenue"
              name="Revenue"
              fill="#1B5E43"
              radius={[3, 3, 0, 0]}
              label={barLabel}
            />
          </BarChart>
        </ChartCard>
        <ChartCard title="Week wise profit" height={220}>
          <BarChart data={weeklySeries} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#678" }}
              interval="preserveStartEnd"
              minTickGap={16}
            />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} labelFormatter={(l) => "Week of " + l} />
            <Bar
              dataKey="profit"
              name="Profit"
              fill="#E8A33D"
              radius={[3, 3, 0, 0]}
              label={barLabel}
            />
          </BarChart>
        </ChartCard>
      </div>
      <div style={{ marginTop: 16 }}>
        <ChartCard title="Week wise revenue vs profit" height={240}>
          <BarChart data={weeklySeries} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#678" }}
              interval="preserveStartEnd"
              minTickGap={16}
            />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} labelFormatter={(l) => "Week of " + l} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="revenue" name="Revenue" fill="#1B5E43" radius={[3, 3, 0, 0]} />
            <Bar dataKey="profit" name="Profit" fill="#E8A33D" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ChartCard>
      </div>
    </div>
  );
}
