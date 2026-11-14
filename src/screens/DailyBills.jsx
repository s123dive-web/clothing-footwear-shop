import { useMemo, useState } from "react";
import { confirmDialog } from "../ui/dialogs.jsx";
import {
  blankDailyBill,
  validateDailyBill,
  makeDailyBill,
  dailyToVendorBill,
  upsertMirror,
  SUPPLIER_CATEGORIES,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  itemsForCategory,
  lineTotal,
  dailyOutstanding,
} from "../lib/dailyBills.js";
import { todayStr, uid, INR, money, dateStr } from "../lib/format.js";
import { Header, Field, Card, Empty } from "../ui/index.jsx";
import { S } from "../ui/styles.js";
import { ChartCard, inrTick } from "../ui/charts.jsx";
import {
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Bar,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";

// ---------- Supplier Bills (auto-syncs into Vendor Bills) ----------
// Day-to-day vendor bills for daily-need purchases. Each entry is the single source of truth
// and MIRRORS into the vendorBills slice (same id, source:"daily-need") so the Vendor Bills
// view shows it too — no double entry. See src/lib/dailyBills.js for the pure mappers.
export const METHOD_COLORS = {
  Cash: "#1B5E43",
  UPI: "#2A6FB0",
  "Bank Transfer": "#7A5AB0",
  Credit: "#C44536",
  Cheque: "#B0762A",
};
export const DAILY_STATUS_COLORS = { Paid: "#1B5E43", Pending: "#C44536", Partial: "#B0762A" };

export function DailyBills({
  dailyBills,
  setDailyBills,
  bills,
  setBills,
  goVendorBills,
  notify,
  log,
}) {
  const blank = useMemo(() => blankDailyBill(todayStr()), []);
  const [form, setForm] = useState(blank);
  const [editId, setEditId] = useState(null);
  const [err, setErr] = useState("");
  // filters
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [vq, setVq] = useState("");
  const [methodF, setMethodF] = useState("all");
  const [statusF, setStatusF] = useState("all");
  // sort
  const [sortKey, setSortKey] = useState("date");
  const [sortDir, setSortDir] = useState("desc");

  const resetForm = () => {
    setForm(blankDailyBill(todayStr()));
    setEditId(null);
    setErr("");
  };

  const save = () => {
    const msg = validateDailyBill(form);
    if (msg) {
      setErr(msg);
      return notify(msg);
    }
    setErr("");
    const id = editId || uid();
    const now = Date.now();
    const existing = editId ? dailyBills.find((d) => d.id === editId) : null;
    const rec = makeDailyBill(form, { id, now, existing });
    const mirror = dailyToVendorBill(rec);
    if (editId) {
      setDailyBills((list) => list.map((d) => (d.id === editId ? rec : d)));
      setBills((list) => upsertMirror(list, mirror)); // keep the Vendor Bills mirror in lockstep
      log("bill", `Edited daily-need bill — ${rec.vendorName} · ${INR(rec.billAmount)}`);
      notify("Daily-need bill updated · synced to Vendor Bills");
    } else {
      setDailyBills((list) => [...list, rec]);
      setBills((list) => upsertMirror(list, mirror));
      log("bill", `Added daily-need bill — ${rec.vendorName} · ${INR(rec.billAmount)}`);
      notify("Daily-need bill saved · synced to Vendor Bills");
    }
    resetForm();
  };

  const startEdit = (d) => {
    setEditId(d.id);
    setForm({
      category: d.category || SUPPLIER_CATEGORIES[0],
      itemName: d.itemName || "",
      qty: d.qty ? String(d.qty) : "",
      unitPrice: d.unitPrice ? String(d.unitPrice) : "",
      vendorName: d.vendorName || "",
      billAmount: String(d.billAmount ?? ""),
      paymentMethod: d.paymentMethod || PAYMENT_METHODS[0],
      paymentStatus: d.paymentStatus || PAYMENT_STATUS[0],
      paidAmount: String(d.paidAmount ?? ""),
      date: d.date || todayStr(),
      billNumber: d.billNumber || "",
      notes: d.notes || "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const del = async (d) => {
    if (
      !(await confirmDialog({
        title: "Delete supplier bill",
        message: `Delete daily-need bill from “${d.vendorName}” (${INR(d.billAmount)})? It will also be removed from Vendor Bills.`,
        danger: true,
      }))
    )
      return;
    setDailyBills((list) => list.filter((x) => x.id !== d.id));
    setBills((list) => list.filter((x) => x.id !== d.id)); // mirror shares the id → drops both
    if (editId === d.id) resetForm();
    log("bill", `Deleted daily-need bill — ${d.vendorName} · ${INR(d.billAmount)}`);
    notify("Daily-need bill deleted");
  };

  // Vendor autocomplete: names already used in daily-need OR the wider Vendor Bills list.
  const vendorSuggestions = useMemo(() => {
    const set = new Set();
    dailyBills.forEach((d) => d.vendorName && set.add(d.vendorName));
    bills.forEach((b) => b.vendor && set.add(b.vendor));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [dailyBills, bills]);

  // Item suggestions are driven by the chosen category, plus any items already used under it.
  const catItems = useMemo(() => {
    const set = new Set(itemsForCategory(form.category));
    dailyBills.forEach((d) => {
      if (d.category === form.category && d.itemName) set.add(d.itemName);
    });
    return [...set];
  }, [form.category, dailyBills]);

  // When both Qty and Price are set, the total is qty × price and the Amount field auto-reflects
  // it (read-only); otherwise the owner types the amount directly.
  const autoTotal = lineTotal(form.qty, form.unitPrice);

  const filtered = useMemo(
    () =>
      dailyBills.filter(
        (d) =>
          (!from || d.date >= from) &&
          (!to || d.date <= to) &&
          (!vq.trim() || (d.vendorName || "").toLowerCase().includes(vq.trim().toLowerCase())) &&
          (methodF === "all" || d.paymentMethod === methodF) &&
          (statusF === "all" || d.paymentStatus === statusF)
      ),
    [dailyBills, from, to, vq, methodF, statusF]
  );

  const toggleSort = (k) => {
    if (sortKey === k) setSortDir((s) => (s === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir(k === "billAmount" || k === "date" ? "desc" : "asc");
    }
  };
  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let av, bv;
      if (sortKey === "billAmount") {
        av = +a.billAmount || 0;
        bv = +b.billAmount || 0;
      } else {
        av = String(a[sortKey] || "").toLowerCase();
        bv = String(b[sortKey] || "").toLowerCase();
      }
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return (b.createdAt || 0) - (a.createdAt || 0); // stable newest-first tiebreak
    });
  }, [filtered, sortKey, sortDir]);

  const totalSpent = money(filtered.reduce((a, d) => a + (+d.billAmount || 0), 0));
  const totalPending = money(filtered.reduce((a, d) => a + dailyOutstanding(d), 0));

  const spendByDay = useMemo(() => {
    const m = {};
    filtered.forEach((d) => {
      const k = d.date;
      if (k) m[k] = (m[k] || 0) + (+d.billAmount || 0);
    });
    return Object.entries(m)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => ({
        label: new Date(k + "T00:00").toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
        }),
        amount: money(v),
      }));
  }, [filtered]);
  const topVendors = useMemo(() => {
    const m = {};
    filtered.forEach((d) => {
      const v = d.vendorName || "—";
      m[v] = (m[v] || 0) + (+d.billAmount || 0);
    });
    return Object.entries(m)
      .map(([name, value]) => ({ name, value: money(value) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }, [filtered]);
  const byMethod = useMemo(() => {
    const m = {};
    filtered.forEach((d) => {
      const k = d.paymentMethod || "—";
      m[k] = (m[k] || 0) + (+d.billAmount || 0);
    });
    return Object.entries(m)
      .map(([name, value]) => ({ name, value: money(value) }))
      .filter((r) => r.value > 0);
  }, [filtered]);
  const byStatus = useMemo(() => {
    const order = { Paid: 0, Partial: 1, Pending: 2 };
    const m = {};
    filtered.forEach((d) => {
      const k = d.paymentStatus || "—";
      m[k] = (m[k] || 0) + (+d.billAmount || 0);
    });
    return Object.entries(m)
      .map(([name, value]) => ({ name, value: money(value) }))
      .filter((r) => r.value > 0)
      .sort((a, b) => (order[a.name] ?? 9) - (order[b.name] ?? 9));
  }, [filtered]);

  const setMonth = (mv) => {
    if (!mv) {
      setFrom("");
      setTo("");
      return;
    }
    setFrom(mv + "-01");
    const d = new Date(+mv.slice(0, 4), +mv.slice(5, 7), 0);
    setTo(dateStr(d));
  };
  const fmtDate = (d) =>
    d
      ? new Date(d + "T00:00").toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : "—";
  const arrow = (k) => (sortKey === k ? (sortDir === "asc" ? " ▲" : " ▼") : "");
  const SortTh = ({ k, label, style }) => (
    <th
      style={{ cursor: "pointer", userSelect: "none", ...style }}
      onClick={() => toggleSort(k)}
      title="Click to sort"
    >
      {label}
      {arrow(k)}
    </th>
  );

  return (
    <div>
      <Header
        title="Supplier Bills"
        sub="Track day-to-day supplier purchase bills (stock, packaging, tailoring) — auto-synced into Vendor Bills"
      >
        <span style={{ fontSize: 11.5, color: "#0E7C86" }}>
          🧺 Each entry also appears in Vendor Bills
        </span>
      </Header>

      <div
        style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: 16, alignItems: "start" }}
      >
        {/* add / edit form */}
        <section style={S.panel}>
          <div style={S.panelHead}>{editId ? "Edit daily-need bill" : "New daily-need bill"}</div>
          {/* Category first — it drives the item suggestions below. Switching category clears the item. */}
          <Field label="Category">
            <select
              className="input"
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value, itemName: "" })}
            >
              {SUPPLIER_CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 10 }}>
            <Field label="Item">
              <input
                className="input"
                list="dnb-items"
                value={form.itemName}
                onChange={(e) => setForm({ ...form, itemName: e.target.value })}
                placeholder={catItems.length ? "Pick or type an item…" : "Type an item…"}
              />
              <datalist id="dnb-items">
                {catItems.map((it) => (
                  <option key={it} value={it} />
                ))}
              </datalist>
            </Field>
            <Field label="Qty">
              <input
                className="input"
                type="number"
                min="0"
                step="any"
                value={form.qty}
                onChange={(e) => setForm({ ...form, qty: e.target.value })}
                placeholder="e.g. 3"
              />
            </Field>
            <Field label="Price (₹/qty)">
              <input
                className="input"
                type="number"
                min="0"
                step="0.01"
                value={form.unitPrice}
                onChange={(e) => setForm({ ...form, unitPrice: e.target.value })}
                placeholder="e.g. 30"
              />
            </Field>
          </div>
          {autoTotal > 0 && (
            <div
              style={{
                fontSize: 12,
                color: "#0E7C86",
                background: "#EAF7F8",
                border: "1px solid #C5E7EA",
                borderRadius: 8,
                padding: "6px 10px",
                marginTop: -2,
                marginBottom: 10,
              }}
            >
              Total = {form.qty} × {INR(form.unitPrice)} = <b>{INR(autoTotal)}</b> — auto-filled
              into Amount below.
            </div>
          )}
          <Field label="Vendor name">
            <input
              className="input"
              list="dnb-vendors"
              value={form.vendorName}
              onChange={(e) => setForm({ ...form, vendorName: e.target.value })}
              placeholder="e.g. Surat Textile Wholesaler"
            />
            <datalist id="dnb-vendors">
              {vendorSuggestions.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Bill date">
              <input
                className="input"
                type="date"
                max={todayStr()}
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
              />
            </Field>
            <Field label={autoTotal > 0 ? "Amount (₹) · auto" : "Amount (₹)"}>
              <input
                className="input"
                type="number"
                min="0"
                step="0.01"
                value={autoTotal > 0 ? autoTotal : form.billAmount}
                readOnly={autoTotal > 0}
                onChange={(e) => setForm({ ...form, billAmount: e.target.value })}
                style={
                  autoTotal > 0
                    ? { background: "#EEF5F0", color: "#23402F", fontWeight: 700 }
                    : undefined
                }
                title={
                  autoTotal > 0
                    ? "Auto-calculated = Qty × Price. Clear Price or Qty to type a custom total."
                    : undefined
                }
              />
            </Field>
            <Field label="Payment method">
              <select
                className="input"
                value={form.paymentMethod}
                onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })}
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </Field>
            <Field label="Payment status">
              <select
                className="input"
                value={form.paymentStatus}
                onChange={(e) => setForm({ ...form, paymentStatus: e.target.value })}
              >
                {PAYMENT_STATUS.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </Field>
            {form.paymentStatus === "Partial" && (
              <Field label="Paid so far (₹)">
                <input
                  className="input"
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.paidAmount}
                  onChange={(e) => setForm({ ...form, paidAmount: e.target.value })}
                />
              </Field>
            )}
            <Field label="Bill number (optional)">
              <input
                className="input"
                value={form.billNumber}
                onChange={(e) => setForm({ ...form, billNumber: e.target.value })}
                placeholder="e.g. INV-204"
              />
            </Field>
          </div>
          <Field label="Notes (optional)">
            <textarea
              className="input"
              rows={2}
              style={{ resize: "vertical" }}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Anything to remember…"
            />
          </Field>
          {err && (
            <div
              style={{
                fontSize: 12,
                color: "#C44536",
                background: "#FBEDEB",
                border: "1px solid #E2B6B0",
                borderRadius: 8,
                padding: "8px 10px",
                marginBottom: 10,
              }}
            >
              {err}
            </div>
          )}
          <button className="btn primary big" style={{ width: "100%" }} onClick={save}>
            {editId ? "Save changes" : "Save bill"}
          </button>
          {editId && (
            <button
              className="btn ghost"
              style={{ width: "100%", marginTop: 8 }}
              onClick={resetForm}
            >
              Cancel edit
            </button>
          )}
        </section>

        {/* list + filters */}
        <section style={S.panel}>
          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <label style={{ fontSize: 12, color: "#6B7E74" }}>
              From{" "}
              <input
                type="date"
                className="input"
                style={{ width: "auto", marginLeft: 4 }}
                value={from}
                max={to || todayStr()}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label style={{ fontSize: 12, color: "#6B7E74" }}>
              To{" "}
              <input
                type="date"
                className="input"
                style={{ width: "auto", marginLeft: 4 }}
                value={to}
                max={todayStr()}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
            <label style={{ fontSize: 12, color: "#6B7E74" }}>
              Month{" "}
              <input
                type="month"
                className="input"
                style={{ width: "auto", marginLeft: 4 }}
                max={todayStr().slice(0, 7)}
                onChange={(e) => setMonth(e.target.value)}
              />
            </label>
            <select
              className="input"
              style={{ width: "auto" }}
              value={methodF}
              onChange={(e) => setMethodF(e.target.value)}
            >
              <option value="all">All methods</option>
              {PAYMENT_METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <select
              className="input"
              style={{ width: "auto" }}
              value={statusF}
              onChange={(e) => setStatusF(e.target.value)}
            >
              <option value="all">All status</option>
              {PAYMENT_STATUS.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <input
              className="input"
              style={{ flex: 1, minWidth: 120 }}
              placeholder="Search vendor…"
              value={vq}
              onChange={(e) => setVq(e.target.value)}
            />
            {(from || to || vq || methodF !== "all" || statusF !== "all") && (
              <button
                className="btn ghost small"
                onClick={() => {
                  setFrom("");
                  setTo("");
                  setVq("");
                  setMethodF("all");
                  setStatusF("all");
                }}
              >
                Clear
              </button>
            )}
          </div>

          <div style={S.cards}>
            <Card
              label="Total spent"
              value={INR(totalSpent)}
              sub={filtered.length + (filtered.length === 1 ? " bill" : " bills")}
            />
            <Card label="Pending" value={INR(totalPending)} sub="unpaid + partial" accent />
            <Card label="Entries" value={String(filtered.length)} sub="in selected range" />
          </div>

          {sorted.length === 0 ? (
            <Empty
              text={
                dailyBills.length === 0
                  ? "No daily-need bills yet. Add your first one on the left."
                  : "No bills match these filters."
              }
            />
          ) : (
            <table className="tbl" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <SortTh k="date" label="Date" style={{ width: 96 }} />
                  <SortTh k="category" label="Category" />
                  <SortTh k="itemName" label="Item" />
                  <SortTh k="vendorName" label="Vendor" />
                  <SortTh k="billAmount" label="Amount" style={{ textAlign: "right" }} />
                  <SortTh k="paymentMethod" label="Method" />
                  <SortTh k="paymentStatus" label="Status" />
                  <th style={{ width: 78 }}></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((d) => {
                  const out = dailyOutstanding(d);
                  return (
                    <tr key={d.id}>
                      <td style={{ whiteSpace: "nowrap", color: "#677" }}>{fmtDate(d.date)}</td>
                      <td style={{ color: "#677", fontSize: 12.5 }}>{d.category || "—"}</td>
                      <td>
                        {d.itemName ? (
                          <>
                            {d.itemName}
                            {d.qty ? (
                              <span style={{ color: "#9AA", fontWeight: 600 }}> ×{d.qty}</span>
                            ) : null}
                            {d.unitPrice ? (
                              <span style={{ color: "#9AA", fontWeight: 500 }}>
                                {" "}
                                @{INR(d.unitPrice)}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <span style={{ color: "#AAB" }}>—</span>
                        )}
                      </td>
                      <td style={{ fontWeight: 600 }}>
                        {d.vendorName}
                        {d.billNumber ? (
                          <span style={{ color: "#9AA", fontWeight: 500, fontSize: 11.5 }}>
                            {" "}
                            · {d.billNumber}
                          </span>
                        ) : null}
                      </td>
                      <td style={{ textAlign: "right", fontWeight: 700 }}>{INR(d.billAmount)}</td>
                      <td style={{ color: "#677", fontSize: 12.5, whiteSpace: "nowrap" }}>
                        {d.paymentMethod || "—"}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <span
                          style={{
                            fontSize: 10.5,
                            fontWeight: 800,
                            textTransform: "uppercase",
                            color: DAILY_STATUS_COLORS[d.paymentStatus] || "#789",
                            border: `1px solid ${DAILY_STATUS_COLORS[d.paymentStatus] || "#bbb"}`,
                            borderRadius: 6,
                            padding: "0 6px",
                          }}
                        >
                          {d.paymentStatus || "—"}
                        </span>
                        {out > 0 && (
                          <div style={{ fontSize: 10.5, color: "#C44536" }}>{INR(out)} due</div>
                        )}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button
                          className="btn small ghost"
                          aria-label={"Edit " + d.vendorName}
                          onClick={() => startEdit(d)}
                        >
                          ✎
                        </button>{" "}
                        <button
                          className="btn small danger"
                          aria-label={"Delete " + d.vendorName}
                          onClick={() => del(d)}
                        >
                          🗑
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {sorted.length > 0 && goVendorBills && (
            <div style={{ fontSize: 11.5, color: "#8A9C90", marginTop: 10 }}>
              These bills also appear in{" "}
              <button
                className="btn small ghost"
                style={{ padding: "2px 8px" }}
                onClick={goVendorBills}
              >
                Vendor Bills →
              </button>
            </div>
          )}
        </section>
      </div>

      {filtered.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
          <ChartCard title="Spend over time (by day)">
            <BarChart data={spendByDay} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: "#678" }}
                interval="preserveStartEnd"
                minTickGap={16}
              />
              <YAxis tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} width={48} />
              <Tooltip formatter={(v) => INR(v)} />
              <Bar dataKey="amount" name="Spend" fill="#0E7C86" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ChartCard>
          <ChartCard title="Top vendors by spend">
            <BarChart
              data={topVendors}
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
              <Bar dataKey="value" name="Spend" fill="#2A6FB0" radius={[0, 3, 3, 0]} />
            </BarChart>
          </ChartCard>
          <ChartCard title="Payment method breakdown">
            <PieChart>
              <Pie
                data={byMethod}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={45}
                outerRadius={78}
                paddingAngle={2}
                stroke="none"
              >
                {byMethod.map((r) => (
                  <Cell key={r.name} fill={METHOD_COLORS[r.name] || "#8A9C90"} />
                ))}
              </Pie>
              <Tooltip formatter={(v, n) => [INR(v), n]} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ChartCard>
          <ChartCard title="Paid vs Pending vs Partial">
            <PieChart>
              <Pie
                data={byStatus}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={45}
                outerRadius={78}
                paddingAngle={2}
                stroke="none"
              >
                {byStatus.map((r) => (
                  <Cell key={r.name} fill={DAILY_STATUS_COLORS[r.name] || "#8A9C90"} />
                ))}
              </Pie>
              <Tooltip formatter={(v, n) => [INR(v), n]} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ChartCard>
        </div>
      )}
    </div>
  );
}
