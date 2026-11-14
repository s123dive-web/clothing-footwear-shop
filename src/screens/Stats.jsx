import {
  inrCompact,
  formatINR,
  hourLabel,
  DOW_ORDER,
  DOW,
  summarize,
  expenseByMonth,
  expenseBreakdown,
  expenseTotal,
  dailyRevenueSeries,
  monthlyRevenueProfit,
  salesHeatmap,
  topItems as topItemsBy,
  paymentBreakdown,
  udhariOutstandingSeries,
  inventoryValue,
  inventoryByCategory,
  deadStock,
  salesByCategory,
  topSizes,
  breakEvenSeries,
  breakEvenEstimate,
} from "../lib/stats.js";
import { Empty, Header, Card } from "../ui/index.jsx";
import {
  PIE_COLORS,
  periodRange,
  TRADING_START,
  CAPEX_START,
  STATS_PERIODS,
  ChartCard,
  barLabel,
  legendText,
} from "../ui/charts.jsx";
import { useState, useMemo } from "react";
import { money, todayStr } from "../lib/format.js";
import { S } from "../ui/styles.js";
import {
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Bar,
  LineChart,
  Legend,
  Line,
  ComposedChart,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  AreaChart,
  Area,
  ReferenceLine,
  Treemap,
} from "recharts";
import { PAY_COLORS } from "../lib/domain.js";

// ---------- Stats (insights / analytics) ----------
// All the number-crunching lives in ./lib/stats.js (pure + unit-tested). This
// component only wires those transforms to a mobile-first, date-range-driven
// dashboard. Every inline `grid-template-columns` collapses to a single column
// under 820px via the CSS at the bottom of this file, so the phone view stacks
// automatically.
export const sectionHead = {
  fontSize: 13,
  fontWeight: 800,
  color: "#10331F",
  letterSpacing: ".02em",
  margin: "24px 0 8px",
};
// (payment-method colours reuse the shared PAY_COLORS defined near Sales History)
// Bar value labels (compact ₹ / plain qty) that skip zeros to keep charts clean.
// `compactLabel` sits on top of vertical bars; the `…Right` variants end horizontal bars.
export const compactLabel = {
  position: "top",
  formatter: (v) => (v ? inrCompact(v) : ""),
  fontSize: 9.5,
  fill: "#465",
};
export const compactLabelRight = {
  position: "right",
  formatter: (v) => (v ? inrCompact(v) : ""),
  fontSize: 9.5,
  fill: "#465",
};
export const qtyLabelRight = {
  position: "right",
  formatter: (v) => (v ? v : ""),
  fontSize: 9.5,
  fill: "#465",
};
// Exact full-₹ value printed on top of bars / line points (zeros hidden). Two
// tints so a bar and its overlaid line stay distinguishable in the combo chart.
export const exactLabel = {
  position: "top",
  formatter: (v) => (v ? formatINR(v) : ""),
  fontSize: 9,
  fill: "#14432E",
};
export const exactLabelGold = {
  position: "top",
  formatter: (v) => (v ? formatINR(v) : ""),
  fontSize: 9,
  fill: "#9A6410",
};

// Green ramp for the heatmap: pale mint (quiet) → deep brand green (busiest).
export const heatColor = (v, max) => {
  if (!v || !max) return "#F4F7F4";
  const t = Math.sqrt(Math.min(1, v / max)); // sqrt lifts the low end so small sales still register
  const lerp = (a, b) => Math.round(a + (b - a) * t);
  return `rgb(${lerp(224, 16)},${lerp(240, 51)},${lerp(230, 31)})`;
};

// One weekday × hour heatmap of revenue. Custom CSS grid (not Recharts) so it
// stays tiny and scrolls horizontally on a phone instead of squashing.
export function Heatmap({ data }) {
  if (!data || data.placed === 0 || data.minHour == null) {
    return <Empty text="No clock-timed bills in this period to map." />;
  }
  const hours = [];
  for (let h = data.minHour; h <= data.maxHour; h++) hours.push(h);
  const cell = { width: 30, minWidth: 30, height: 26, borderRadius: 4 };
  return (
    <div style={{ overflowX: "auto", paddingBottom: 4 }}>
      <div style={{ display: "inline-block", minWidth: "100%" }}>
        <div style={{ display: "flex", gap: 3, marginLeft: 38, marginBottom: 3 }}>
          {hours.map((h) => (
            <div
              key={h}
              style={{
                ...cell,
                height: "auto",
                textAlign: "center",
                fontSize: 9.5,
                color: "#5C6E63",
                fontWeight: 600,
              }}
            >
              {hourLabel(h)}
            </div>
          ))}
        </div>
        {DOW_ORDER.map((d) => (
          <div key={d} style={{ display: "flex", gap: 3, marginBottom: 3, alignItems: "center" }}>
            <div style={{ width: 35, minWidth: 35, fontSize: 11, color: "#465", fontWeight: 700 }}>
              {DOW[d]}
            </div>
            {hours.map((h) => {
              const v = data.grid[d][h];
              return (
                <div
                  key={h}
                  title={`${DOW[d]} ${hourLabel(h).replace("a", " AM").replace("p", " PM")} · ${formatINR(v)}`}
                  style={{
                    ...cell,
                    background: heatColor(v, data.max),
                    border: "1px solid #EDF2ED",
                    cursor: "default",
                  }}
                />
              );
            })}
          </div>
        ))}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginTop: 8,
            marginLeft: 38,
            fontSize: 10.5,
            color: "#5C6E63",
          }}
        >
          <span>Quieter</span>
          <div style={{ display: "flex", gap: 2 }}>
            {[0.05, 0.25, 0.5, 0.75, 1].map((t) => (
              <div
                key={t}
                style={{ width: 16, height: 10, borderRadius: 2, background: heatColor(t, 1) }}
              />
            ))}
          </div>
          <span>Busier — colour = revenue taken</span>
        </div>
      </div>
    </div>
  );
}

// Treemap tile: category rectangle labelled with its stock value. Recharts feeds
// x/y/width/height/index plus the datum fields (name, cost, retail, size).
export function TreemapTile(props) {
  const { x, y, width, height, name, size, index } = props;
  if (!(width > 0) || !(height > 0)) return null;
  const fill = PIE_COLORS[(index ?? 0) % PIE_COLORS.length];
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        style={{ fill, stroke: "#fff", strokeWidth: 2 }}
      />
      {width > 54 && height > 22 && (
        <text x={x + 7} y={y + 16} fill="#fff" fontSize={11} fontWeight={700}>
          {name}
        </text>
      )}
      {width > 54 && height > 38 && (
        <text x={x + 7} y={y + 31} fill="rgba(255,255,255,.85)" fontSize={10}>
          {inrCompact(size)}
        </text>
      )}
    </g>
  );
}

// Turn a breakEvenEstimate() result into the big number + caption for its KPI card.
export function breakEvenCard(be, est) {
  switch (est.status) {
    case "reached":
      return { value: "Recovered ✓", sub: `took ${est.days} day(s) · ${be.recovered}% of capital` };
    case "projected":
      return {
        value: "~" + est.daysLeft + " days",
        sub: `${be.recovered}% recovered · ${formatINR(est.perDay)}/day`,
      };
    case "stalled":
      return { value: "—", sub: "no profit trend yet" };
    case "no-capex":
      return { value: "—", sub: "no setup cost logged" };
    default:
      return { value: "—", sub: "need more sales data" };
  }
}

export function Stats({ sales, expenses, items }) {
  const [preset, setPreset] = useState("allTime"); // default to the full history
  const [cfrom, setCfrom] = useState("");
  const [cto, setCto] = useState("");
  const [metric, setMetric] = useState("revenue"); // top-items sort: revenue | qty | profit
  const [includeMisc, setIncludeMisc] = useState(false); // keep Misc/SwadSutra/Sold rows in item charts?
  const [treeMetric, setTreeMetric] = useState("cost"); // treemap sizing: cost | retail
  // "All time" for the sales charts is pinned to when trading began (TRADING_START).
  const { from, to, label } = periodRange(preset, cfrom, cto, TRADING_START);
  // Expenses (capital / setup cost) started before trading, so their "All time"
  // reaches back to CAPEX_START; every other preset shares the sales window.
  const expFrom = preset === "allTime" ? CAPEX_START : from;

  // Period slice drives most charts; a few (inventory, break-even, Udhari-now) are
  // "as of now" snapshots and deliberately read the full data — noted on each card.
  const pSales = useMemo(
    () => sales.filter((s) => s.date >= from && s.date <= to),
    [sales, from, to]
  );
  const pExp = useMemo(
    () => expenses.filter((e) => e.date >= expFrom && e.date <= to),
    [expenses, expFrom, to]
  );
  const sum = useMemo(() => summarize(pSales), [pSales]);
  const expMonthly = useMemo(() => expenseByMonth(pExp, expFrom, to), [pExp, expFrom, to]);
  const expBreak = useMemo(() => expenseBreakdown(pExp, { limit: 10 }), [pExp]);
  const expSum = useMemo(() => expenseTotal(pExp), [pExp]);

  const daily = useMemo(() => dailyRevenueSeries(pSales, from, to), [pSales, from, to]);
  const monthly = useMemo(() => monthlyRevenueProfit(pSales, from, to), [pSales, from, to]);
  const heat = useMemo(() => salesHeatmap(pSales), [pSales]);
  const topProducts = useMemo(
    () => topItemsBy(pSales, { metric, limit: 15, includeConsolidated: includeMisc }),
    [pSales, metric, includeMisc]
  );
  const pay = useMemo(() => paymentBreakdown(pSales), [pSales]);
  const udhariSeries = useMemo(() => udhariOutstandingSeries(sales, from, to), [sales, from, to]);
  const udhariNow = useMemo(
    () =>
      money(
        sales
          .filter((s) => s.payment === "Udhari")
          .reduce((a, s) => a + Math.max(0, (s.total || 0) - (s.paid || 0)), 0)
      ),
    [sales]
  );
  const inv = useMemo(() => inventoryValue(items), [items]);
  const invCats = useMemo(() => inventoryByCategory(items), [items]);
  const dead = useMemo(() => deadStock(items, pSales), [items, pSales]);
  const catMix = useMemo(() => salesByCategory(pSales), [pSales]); // sales by (sub)category
  const sizeMix = useMemo(() => topSizes(pSales, { limit: 12 }), [pSales]); // best-selling sizes
  const be = useMemo(() => breakEvenSeries(sales, expenses), [sales, expenses]); // all-time
  const est = useMemo(() => breakEvenEstimate(be), [be]);
  const beCard = breakEvenCard(be, est);

  const treeData = useMemo(
    () =>
      invCats
        .map((c) => ({ ...c, size: treeMetric === "retail" ? c.retail : c.cost }))
        .filter((c) => c.size > 0),
    [invCats, treeMetric]
  );
  const metricLabel = { revenue: "Revenue", qty: "Quantity", profit: "Profit" };

  return (
    <div>
      <Header title="Reports" sub={label}>
        <select
          className="input"
          style={{ width: "auto" }}
          aria-label="Period"
          value={preset}
          onChange={(e) => setPreset(e.target.value)}
        >
          {STATS_PERIODS.map(([k, lbl]) => (
            <option key={k} value={k}>
              {lbl}
            </option>
          ))}
        </select>
      </Header>

      {preset === "custom" && (
        <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
          <label style={{ fontSize: 12, color: "#556A5F" }}>
            From{" "}
            <input
              type="date"
              className="input"
              style={{ width: "auto", marginLeft: 4 }}
              value={cfrom}
              max={cto || todayStr()}
              onChange={(e) => setCfrom(e.target.value)}
            />
          </label>
          <label style={{ fontSize: 12, color: "#556A5F" }}>
            To{" "}
            <input
              type="date"
              className="input"
              style={{ width: "auto", marginLeft: 4 }}
              value={cto}
              max={todayStr()}
              onChange={(e) => setCto(e.target.value)}
            />
          </label>
        </div>
      )}

      {/* ---- KPI row (first four follow the date range; last four are "as of now") ---- */}
      <div style={S.cards}>
        <Card label="Revenue" value={formatINR(sum.revenue)} sub={sum.bills + " bills"} />
        <Card
          label="Trading profit"
          value={formatINR(sum.profit)}
          sub={`${sum.margin}% margin`}
          accent
        />
        <Card label="Margin" value={sum.margin + "%"} sub="profit ÷ revenue" />
        <Card label="Avg ticket" value={formatINR(sum.avgTicket)} sub="per bill" />
        <Card label="Udhari outstanding" value={formatINR(udhariNow)} sub="unpaid credit · now" />
        <Card
          label="Inventory at cost"
          value={formatINR(inv.cost)}
          sub={`${inv.count} products · now`}
        />
        <Card label="Out of stock" value={inv.outOfStock} sub="products at zero · now" />
        <Card label="Break-even" value={beCard.value} sub={beCard.sub} />
      </div>

      {pSales.length === 0 ? (
        <section style={{ ...S.panel, marginTop: 16 }}>
          <Empty text="No sales in this period — pick a wider range to see the charts.">
            {preset !== "allTime" && (
              <button className="btn primary" onClick={() => setPreset("allTime")}>
                Show all time
              </button>
            )}
          </Empty>
        </section>
      ) : (
        <>
          <div style={sectionHead}>Sales by category &amp; size</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <ChartCard title="Sales by category (revenue)" height={260}>
              <BarChart
                data={catMix}
                layout="vertical"
                margin={{ top: 6, right: 12, left: 6, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
                <XAxis
                  type="number"
                  tick={{ fontSize: 11, fill: "#678" }}
                  tickFormatter={inrCompact}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={{ fontSize: 11, fill: "#678" }}
                  width={110}
                />
                <Tooltip
                  formatter={(v, n) => [
                    n === "qty" ? v : formatINR(v),
                    n === "qty" ? "Units" : "Revenue",
                  ]}
                />
                <Bar dataKey="revenue" name="Revenue" fill="#8E2C48" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ChartCard>
            <ChartCard title="Best-selling sizes (units sold)" height={260}>
              {sizeMix.length === 0 ? (
                <Empty text="No sized sales in this period yet." />
              ) : (
                <BarChart data={sizeMix} margin={{ top: 12, right: 10, left: -6, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
                  <XAxis dataKey="size" tick={{ fontSize: 11, fill: "#678" }} />
                  <YAxis tick={{ fontSize: 11, fill: "#678" }} width={36} allowDecimals={false} />
                  <Tooltip
                    formatter={(v, n) => [
                      n === "revenue" ? formatINR(v) : v,
                      n === "revenue" ? "Revenue" : "Units",
                    ]}
                  />
                  <Bar
                    dataKey="qty"
                    name="Units"
                    fill="#C9A24B"
                    radius={[3, 3, 0, 0]}
                    label={barLabel}
                  />
                </BarChart>
              )}
            </ChartCard>
          </div>
          {catMix.length > 0 && (
            <section style={{ ...S.panel, marginTop: 16 }}>
              <div style={S.panelHead}>Category breakdown</div>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th style={{ textAlign: "right" }}>Units</th>
                    <th style={{ textAlign: "right" }}>Revenue</th>
                    <th style={{ textAlign: "right" }}>Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {catMix.map((c) => (
                    <tr key={c.name}>
                      <td style={{ fontWeight: 600 }}>{c.name}</td>
                      <td style={{ textAlign: "right" }}>{c.qty}</td>
                      <td style={{ textAlign: "right" }}>{formatINR(c.revenue)}</td>
                      <td style={{ textAlign: "right", color: "#2E7D5B" }}>
                        {formatINR(c.profit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <div style={sectionHead}>Revenue over time</div>
          <ChartCard title="Daily revenue & 7-day average" height={260}>
            <LineChart data={daily} margin={{ top: 12, right: 10, left: -6, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10.5, fill: "#678" }}
                interval="preserveStartEnd"
                minTickGap={26}
              />
              <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrCompact} width={48} />
              <Tooltip formatter={(v, n) => [formatINR(v), n]} />
              <Legend formatter={legendText} wrapperStyle={{ fontSize: 12 }} />
              <Line
                type="monotone"
                dataKey="revenue"
                name="Daily revenue"
                stroke="#4A7A63"
                strokeWidth={1.5}
                dot={false}
                label={exactLabel}
              />
              <Line
                type="monotone"
                dataKey="ma7"
                name="7-day average"
                stroke="#1B5E43"
                strokeWidth={2.5}
                dot={false}
              />
            </LineChart>
          </ChartCard>

          <div style={{ marginTop: 16 }}>
            <ChartCard title="Monthly revenue & profit" height={250}>
              <ComposedChart data={monthly} margin={{ top: 16, right: 10, left: -6, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} />
                <YAxis
                  tick={{ fontSize: 11, fill: "#678" }}
                  tickFormatter={inrCompact}
                  width={48}
                />
                <Tooltip formatter={(v, n) => [formatINR(v), n]} />
                <Legend formatter={legendText} wrapperStyle={{ fontSize: 12 }} />
                <Bar
                  dataKey="revenue"
                  name="Revenue"
                  fill="#1B5E43"
                  radius={[3, 3, 0, 0]}
                  maxBarSize={54}
                  label={exactLabel}
                />
                <Line
                  type="monotone"
                  dataKey="profit"
                  name="Profit"
                  stroke="#E8A33D"
                  strokeWidth={2.5}
                  dot={{ r: 2.5, fill: "#E8A33D" }}
                  label={exactLabelGold}
                />
              </ComposedChart>
            </ChartCard>
          </div>

          <div style={sectionHead}>When customers shop</div>
          <section style={S.panel}>
            <div style={S.panelHead}>Sales heatmap — weekday × time of day</div>
            <Heatmap data={heat} />
          </section>

          <div style={sectionHead}>Products & payment</div>
          <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 16 }}>
            <section style={S.panel}>
              <div style={{ ...S.panelHead, flexWrap: "wrap", gap: 6 }}>
                Top 15 items
                <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  {["revenue", "qty", "profit"].map((m) => (
                    <button
                      key={m}
                      className={"btn small " + (metric === m ? "primary" : "ghost")}
                      onClick={() => setMetric(m)}
                    >
                      {metricLabel[m]}
                    </button>
                  ))}
                </div>
              </div>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 11.5,
                  color: "#556A5F",
                  marginBottom: 8,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={includeMisc}
                  onChange={(e) => setIncludeMisc(e.target.checked)}
                />
                Include Misc / consolidated rows (they distort real top-sellers)
              </label>
              {topProducts.length === 0 ? (
                <Empty text="No individual items sold in this period." />
              ) : (
                <div style={{ width: "100%", height: Math.max(220, topProducts.length * 26 + 24) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={topProducts}
                      layout="vertical"
                      margin={{ top: 4, right: 54, left: 8, bottom: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" horizontal={false} />
                      <XAxis
                        type="number"
                        tick={{ fontSize: 10.5, fill: "#678" }}
                        tickFormatter={metric === "qty" ? undefined : inrCompact}
                      />
                      <YAxis
                        type="category"
                        dataKey="name"
                        tick={{ fontSize: 10, fill: "#465" }}
                        width={116}
                        interval={0}
                      />
                      <Tooltip formatter={(v) => (metric === "qty" ? v : formatINR(v))} />
                      <Bar
                        dataKey={metric}
                        name={metricLabel[metric]}
                        fill="#3DA17A"
                        radius={[0, 3, 3, 0]}
                        label={metric === "qty" ? qtyLabelRight : compactLabelRight}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </section>

            <section style={S.panel}>
              <div style={S.panelHead}>How customers pay</div>
              {pay.rows.length === 0 ? (
                <Empty text="No sales to split." />
              ) : (
                <>
                  <div style={{ position: "relative", width: "100%", height: 190 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={pay.rows}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          innerRadius={52}
                          outerRadius={80}
                          paddingAngle={2}
                          stroke="none"
                        >
                          {pay.rows.map((r) => (
                            <Cell key={r.name} fill={PAY_COLORS[r.name] || "#5C6E63"} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(v, n) => [formatINR(v), n]} />
                      </PieChart>
                    </ResponsiveContainer>
                    {/* Center total — a positioned overlay renders reliably across Recharts versions. */}
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        display: "grid",
                        placeItems: "center",
                        pointerEvents: "none",
                      }}
                    >
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 11, color: "#5C6E63" }}>Total</div>
                        <div style={{ fontSize: 15, fontWeight: 800, color: "#10331F" }}>
                          {inrCompact(pay.total)}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div>
                    {pay.rows.map((r) => (
                      <div key={r.name} style={S.row}>
                        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span
                            style={{
                              width: 10,
                              height: 10,
                              borderRadius: 3,
                              background: PAY_COLORS[r.name] || "#5C6E63",
                            }}
                          />
                          {r.name}
                        </span>
                        <b>
                          {formatINR(r.value)}{" "}
                          <span style={{ color: "#5C6E63", fontWeight: 500 }}>· {r.pct}%</span>
                        </b>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
          </div>

          <div style={sectionHead}>Credit & recovery</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <ChartCard title="Udhari outstanding over time">
              <AreaChart data={udhariSeries} margin={{ top: 8, right: 10, left: -6, bottom: 0 }}>
                <defs>
                  <linearGradient id="gUdhari" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#E8A33D" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#E8A33D" stopOpacity={0.04} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10.5, fill: "#678" }}
                  interval="preserveStartEnd"
                  minTickGap={26}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "#678" }}
                  tickFormatter={inrCompact}
                  width={48}
                />
                <Tooltip formatter={(v) => [formatINR(v), "Outstanding"]} />
                <Area
                  type="monotone"
                  dataKey="outstanding"
                  name="Outstanding"
                  stroke="#8A5A12"
                  strokeWidth={2}
                  fill="url(#gUdhari)"
                />
              </AreaChart>
            </ChartCard>

            <ChartCard title="Break-even — profit vs capital (all-time)">
              {be.series.length === 0 ? (
                <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
                  <Empty text="No sales yet to track break-even." />
                </div>
              ) : (
                <ComposedChart
                  data={be.series}
                  margin={{ top: 16, right: 12, left: -6, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="gBreak" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#1B5E43" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#1B5E43" stopOpacity={0.03} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10.5, fill: "#678" }}
                    interval="preserveStartEnd"
                    minTickGap={26}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "#678" }}
                    tickFormatter={inrCompact}
                    width={48}
                  />
                  <Tooltip formatter={(v) => [formatINR(v), "Cumulative profit"]} />
                  <Area
                    type="monotone"
                    dataKey="cumProfit"
                    name="Cumulative profit"
                    stroke="#1B5E43"
                    strokeWidth={2}
                    fill="url(#gBreak)"
                  />
                  {be.capex > 0 && (
                    <ReferenceLine
                      y={be.capex}
                      stroke="#C44536"
                      strokeDasharray="5 4"
                      label={{
                        value: `Capital ${inrCompact(be.capex)}`,
                        position: "insideTopRight",
                        fontSize: 10,
                        fill: "#C44536",
                      }}
                    />
                  )}
                </ComposedChart>
              )}
            </ChartCard>
          </div>
          <div style={{ fontSize: 12, color: "#556A5F", marginTop: 8 }}>
            <b>Capital / Setup Cost</b> (one-time): {formatINR(be.capex)} — this is investment,
            never subtracted from trading profit.
            {est.status === "reached" && <> You’ve recovered it (took {est.days} day(s)).</>}
            {est.status === "projected" && (
              <>
                {" "}
                At about {formatINR(est.perDay)}/day of profit, roughly {est.daysLeft} day(s) to go.
              </>
            )}
          </div>

          <div style={sectionHead}>
            Capital / setup spending
            {preset === "allTime" && (
              <span style={{ fontWeight: 500, color: "#5C6E63" }}>
                {" "}
                · since{" "}
                {new Date(CAPEX_START + "T00:00").toLocaleDateString("en-IN", {
                  month: "short",
                  year: "numeric",
                })}
              </span>
            )}
          </div>
          {pExp.length === 0 ? (
            <section style={S.panel}>
              <Empty text="No capital / setup spending recorded in this period." />
            </section>
          ) : (
            <>
              <div style={{ fontSize: 12.5, color: "#3A5547", marginBottom: 8 }}>
                One-time setup / capital of <b>{formatINR(expSum)}</b> across {pExp.length}{" "}
                {pExp.length === 1 ? "entry" : "entries"} — investment, not an operating cost, so it
                never reduces trading profit.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 16 }}>
                <ChartCard title="Capital deployed by month">
                  <BarChart data={expMonthly} margin={{ top: 16, right: 10, left: -6, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#678" }} />
                    <YAxis
                      tick={{ fontSize: 11, fill: "#678" }}
                      tickFormatter={inrCompact}
                      width={48}
                    />
                    <Tooltip formatter={(v) => [formatINR(v), "Spent"]} />
                    <Bar
                      dataKey="amount"
                      name="Spent"
                      fill="#C44536"
                      radius={[3, 3, 0, 0]}
                      maxBarSize={56}
                      label={compactLabel}
                    />
                  </BarChart>
                </ChartCard>
                <section style={S.panel}>
                  <div style={S.panelHead}>Where it went</div>
                  <div
                    style={{ width: "100%", height: Math.max(200, expBreak.rows.length * 26 + 24) }}
                  >
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={expBreak.rows}
                        layout="vertical"
                        margin={{ top: 4, right: 54, left: 8, bottom: 0 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" horizontal={false} />
                        <XAxis
                          type="number"
                          tick={{ fontSize: 10.5, fill: "#678" }}
                          tickFormatter={inrCompact}
                        />
                        <YAxis
                          type="category"
                          dataKey="name"
                          tick={{ fontSize: 10, fill: "#465" }}
                          width={112}
                          interval={0}
                        />
                        <Tooltip formatter={(v) => formatINR(v)} />
                        <Bar
                          dataKey="value"
                          name="Spent"
                          fill="#8A5A12"
                          radius={[0, 3, 3, 0]}
                          label={compactLabelRight}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </section>
              </div>
            </>
          )}

          <div style={sectionHead}>Inventory</div>
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}>
            <section style={S.panel}>
              <div style={{ ...S.panelHead, flexWrap: "wrap", gap: 6 }}>
                Stock value by category
                <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <button
                    className={"btn small " + (treeMetric === "cost" ? "primary" : "ghost")}
                    onClick={() => setTreeMetric("cost")}
                  >
                    At cost {inrCompact(inv.cost)}
                  </button>
                  <button
                    className={"btn small " + (treeMetric === "retail" ? "primary" : "ghost")}
                    onClick={() => setTreeMetric("retail")}
                  >
                    At retail {inrCompact(inv.retail)}
                  </button>
                </div>
              </div>
              {treeData.length === 0 ? (
                <Empty text="No stock on hand to value." />
              ) : (
                <div style={{ width: "100%", height: 280 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <Treemap
                      data={treeData}
                      dataKey="size"
                      nameKey="name"
                      stroke="#fff"
                      isAnimationActive={false}
                      content={<TreemapTile />}
                    />
                  </ResponsiveContainer>
                </div>
              )}
            </section>
            <section style={S.panel}>
              <div style={S.panelHead}>
                Slow movers — in stock, no sales this period{" "}
                <span
                  style={{
                    fontWeight: 500,
                    textTransform: "none",
                    letterSpacing: 0,
                    color: "#5C6E63",
                    marginLeft: 8,
                  }}
                >
                  {dead.length}
                </span>
              </div>
              {dead.length === 0 ? (
                <Empty text="Everything in stock sold at least once. 👍" />
              ) : (
                <>
                  {dead.slice(0, 10).map((i) => (
                    <div key={i.name} style={S.row}>
                      <span>
                        {i.name}{" "}
                        <span style={{ color: "#5F6B6B", fontSize: 11 }}>
                          · {i.stock} pcs{i.subcategory ? " · " + i.subcategory : ""}
                        </span>
                      </span>
                      <b>{formatINR(i.value)}</b>
                    </div>
                  ))}
                  {dead.length > 10 && (
                    <div style={{ fontSize: 11.5, color: "#5C6E63", marginTop: 6 }}>
                      + {dead.length - 10} more…
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
