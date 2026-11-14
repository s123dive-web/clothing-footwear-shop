import { useState, useMemo } from "react";
import {
  periodRange,
  buildSeries,
  FINANCE_PERIODS,
  ChartCard,
  renderPayMix,
  renderPayTrend,
  inrTick,
  PIE_COLORS,
  legendText,
} from "../ui/charts.jsx";
import { money, todayStr, INR } from "../lib/format.js";
import { Header, Card, Empty } from "../ui/index.jsx";
import { S } from "../ui/styles.js";
import {
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Bar,
  AreaChart,
  Legend,
  Area,
  PieChart,
  Pie,
  Cell,
} from "recharts";

export function Finance({ sales, expenses }) {
  const [preset, setPreset] = useState("thisMonth");
  const [cfrom, setCfrom] = useState("");
  const [cto, setCto] = useState("");
  const { from, to, label } = periodRange(preset, cfrom, cto);

  const pSales = useMemo(
    () => sales.filter((s) => s.date >= from && s.date <= to),
    [sales, from, to]
  );
  const pExp = useMemo(
    () => expenses.filter((e) => e.date >= from && e.date <= to),
    [expenses, from, to]
  );
  const revenue = money(pSales.reduce((a, s) => a + s.total, 0));
  const grossProfit = money(pSales.reduce((a, s) => a + s.profit, 0));
  const expTotal = money(pExp.reduce((a, e) => a + e.amount, 0));

  const series = useMemo(() => buildSeries(pSales, pExp, from, to), [pSales, pExp, from, to]);
  const expBreakdown = useMemo(() => {
    const m = {};
    pExp.forEach((e) => {
      m[e.desc] = (m[e.desc] || 0) + e.amount;
    });
    return Object.entries(m)
      .map(([name, value]) => ({ name, value: money(value) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }, [pExp]);
  const topItems = useMemo(() => {
    const m = {};
    pSales.forEach((s) =>
      (s.lines || []).forEach((l) => {
        m[l.name] = (m[l.name] || 0) + l.amount;
      })
    );
    return Object.entries(m)
      .map(([name, value]) => ({ name, value: money(value) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 7);
  }, [pSales]);

  return (
    <div>
      <Header title="Finance" sub={label}>
        <select
          className="input"
          style={{ width: "auto" }}
          value={preset}
          onChange={(e) => setPreset(e.target.value)}
        >
          {FINANCE_PERIODS.map(([k, lbl]) => (
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

      <div style={S.cards}>
        <Card label="Revenue" value={INR(revenue)} sub={pSales.length + " bills"} />
        <Card label="Gross profit" value={INR(grossProfit)} sub="sales − item cost" />
        <Card label="Expenses" value={INR(expTotal)} sub={pExp.length + " entries"} />
        <Card
          label="Net profit"
          value={INR(money(grossProfit - expTotal))}
          sub="gross − expenses"
          accent
        />
      </div>

      <div style={{ marginTop: 16 }}>
        <ChartCard title="Total vs Cash vs UPI" height={220}>
          {renderPayMix(pSales)}
        </ChartCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <ChartCard title="Total vs Cash vs UPI — trend" height={240}>
          {renderPayTrend(series)}
        </ChartCard>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginTop: 16 }}>
        {[
          { key: "revenue", title: "Revenue", color: "#1B5E43" },
          { key: "profit", title: "Profit", color: "#E8A33D" },
          { key: "expenses", title: "Expenses", color: "#C44536" },
        ].map((c) => (
          <ChartCard key={c.key} title={c.title} height={220}>
            <BarChart data={series} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: "#678" }}
                interval="preserveStartEnd"
                minTickGap={20}
              />
              <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
              <Tooltip formatter={(v) => INR(v)} />
              <Bar dataKey={c.key} name={c.title} fill={c.color} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ChartCard>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 16, marginTop: 16 }}>
        <ChartCard title="Revenue & profit over time">
          <AreaChart data={series} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
            <defs>
              <linearGradient id="gRev" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#1B5E43" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#1B5E43" stopOpacity={0.03} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#678" }}
              interval="preserveStartEnd"
              minTickGap={20}
            />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Legend formatter={legendText} wrapperStyle={{ fontSize: 12 }} />
            <Area
              type="monotone"
              dataKey="revenue"
              name="Revenue"
              stroke="#1B5E43"
              strokeWidth={2}
              fill="url(#gRev)"
            />
            <Area
              type="monotone"
              dataKey="profit"
              name="Profit"
              stroke="#E8A33D"
              strokeWidth={2}
              fill="none"
            />
          </AreaChart>
        </ChartCard>

        <ChartCard title="Expense breakdown">
          {expBreakdown.length === 0 ? (
            <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
              <Empty text="No expenses in this period." />
            </div>
          ) : (
            <PieChart>
              <Pie
                data={expBreakdown}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={84}
                label={(e) => {
                  const n = String(e.name || "");
                  return n.length > 10 ? n.slice(0, 10) + "…" : n;
                }}
                labelLine={false}
                fontSize={10}
              >
                {expBreakdown.map((e, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(v) => INR(v)} />
            </PieChart>
          )}
        </ChartCard>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
        <ChartCard title="Revenue vs expenses">
          <BarChart data={series} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#678" }}
              interval="preserveStartEnd"
              minTickGap={20}
            />
            <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
            <Tooltip formatter={(v) => INR(v)} />
            <Legend formatter={legendText} wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="revenue" name="Revenue" fill="#1B5E43" radius={[3, 3, 0, 0]} />
            <Bar dataKey="expenses" name="Expenses" fill="#C44536" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ChartCard>

        <ChartCard title="Top items by revenue">
          {topItems.length === 0 ? (
            <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
              <Empty text="No sales in this period." />
            </div>
          ) : (
            <BarChart
              data={topItems}
              layout="vertical"
              margin={{ top: 4, right: 12, left: 8, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} />
              <YAxis
                type="category"
                dataKey="name"
                tick={{ fontSize: 10.5, fill: "#465" }}
                width={110}
              />
              <Tooltip formatter={(v) => INR(v)} />
              <Bar dataKey="value" name="Revenue" fill="#2A6FB0" radius={[0, 3, 3, 0]} />
            </BarChart>
          )}
        </ChartCard>
      </div>
    </div>
  );
}
