import { todayStr, uid, money, INR, dateStr } from "../lib/format.js";
import { useState, useRef, useMemo } from "react";
import { confirmDialog } from "../ui/dialogs.jsx";
import { MAX_PROOF_BYTES, uploadBillProof, deleteBillProof, PROOF_ACCEPT } from "../lib/bills.js";
import { Header, Field, Card, Empty, focusFirstField } from "../ui/index.jsx";
import { S } from "../ui/styles.js";
import { ChartCard, inrTick } from "../ui/charts.jsx";
import { BarChart, CartesianGrid, XAxis, YAxis, Tooltip, Bar } from "recharts";

// ---------- Vendor Bills (purchase bills with proof, isolated from other data) ----------
export const BILL_CATEGORIES = [
  "Stock purchase",
  "Rent",
  "Utilities",
  "Salary",
  "Transport",
  "Maintenance",
  "Packaging",
  "Taxes/Fees",
  "Other",
];
export const BILL_STATUS = ["unpaid", "partial", "paid"];
export const STATUS_COLORS = { paid: "#1B5E43", partial: "#B0762A", unpaid: "#C44536" };
export const isImageType = (t, name) =>
  /^image\//i.test(t || "") || /\.(jpe?g|png|webp|gif|bmp|heic)$/i.test(name || "");
export const outstandingOf = (b) =>
  b.status === "paid"
    ? 0
    : b.status === "partial"
      ? Math.max(0, (+b.amount || 0) - (+b.paidAmount || 0))
      : +b.amount || 0;

export function VendorBills({ bills, setBills, setDailyBills, goDailyBills, online, notify, log }) {
  const blank = {
    vendor: "",
    date: todayStr(),
    amount: "",
    category: BILL_CATEGORIES[0],
    status: "unpaid",
    paidAmount: "",
    dueDate: "",
  };
  const [form, setForm] = useState(blank);
  const [editId, setEditId] = useState(null);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef(null);
  // filters
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [vq, setVq] = useState("");
  const [statusF, setStatusF] = useState("all");
  const [catF, setCatF] = useState("All");

  const resetForm = () => {
    setForm(blank);
    setEditId(null);
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const onFile = (e) => {
    const f = e.target.files?.[0] || null;
    if (f && f.size > MAX_PROOF_BYTES) {
      notify("Proof file is too large (max 10 MB).");
      e.target.value = "";
      return;
    }
    setFile(f);
  };

  const save = async () => {
    if (busy) return;
    if (!form.vendor.trim()) return notify("Vendor name is required.");
    if (!(+form.amount > 0)) return notify("Enter a bill amount greater than 0.");
    setBusy(true);
    setErr("");
    try {
      const id = editId || uid();
      let proof = null;
      if (file) proof = await uploadBillProof(id, file); // throws → caught below
      const base = {
        vendor: form.vendor.trim(),
        date: form.date || todayStr(),
        amount: money(+form.amount),
        category: form.category,
        status: form.status,
        paidAmount:
          form.status === "partial"
            ? money(+form.paidAmount || 0)
            : form.status === "paid"
              ? money(+form.amount)
              : 0,
        dueDate: form.status === "paid" ? "" : form.dueDate || "",
      };
      if (editId) {
        setBills((list) =>
          list.map((b) =>
            b.id === editId ? { ...b, ...base, ...(proof || {}), updatedAt: todayStr() } : b
          )
        );
        log("bill", `Edited vendor bill — ${base.vendor} · ${INR(base.amount)}`);
        notify("Bill updated");
      } else {
        setBills((list) => [...list, { id, ...base, ...(proof || {}), createdAt: todayStr() }]);
        log(
          "bill",
          `Added vendor bill — ${base.vendor} · ${INR(base.amount)}` +
            (proof ? " (with proof)" : "")
        );
        notify("Bill saved");
      }
      resetForm();
    } catch (e) {
      console.error("bill save failed", e);
      const code = e?.code || e?.message || "unknown";
      setErr(
        `Upload failed (${code}). The bill was NOT saved. ` +
          (code.includes("unauthorized") || code.includes("unauthenticated")
            ? "Firebase Storage rules are blocking it — publish the rule from the Storage → Rules page."
            : code.includes("object-not-found") ||
                code.includes("bucket") ||
                code.includes("unknown")
              ? "Firebase Storage isn't set up for this project — open Storage in the console and click ‘Get started’ to create the bucket."
              : code.includes("retry-limit") || code.includes("network")
                ? "Network/CORS problem — check the connection and retry."
                : "Open the browser console for details.")
      );
      notify("⚠ Proof upload failed — see the message in the form.");
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (b) => {
    // Daily-need bills are authored in their own section (single source of truth); redirect the
    // edit there so the two views can't drift.
    if (b.source === "daily-need") {
      notify("This bill syncs from Supplier Bills — edit it there.");
      goDailyBills?.();
      return;
    }
    setEditId(b.id);
    setForm({
      vendor: b.vendor || "",
      date: b.date || todayStr(),
      amount: String(b.amount ?? ""),
      category: b.category || BILL_CATEGORIES[0],
      status: b.status || "unpaid",
      paidAmount: String(b.paidAmount ?? ""),
      dueDate: b.dueDate || "",
    });
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const del = async (b) => {
    const synced = b.source === "daily-need";
    const msg = synced
      ? `Delete “${b.vendor}” (${INR(b.amount)})? This also removes it from Supplier Bills.`
      : `Delete bill from “${b.vendor}” (${INR(b.amount)})? Its proof file will also be removed.`;
    if (!(await confirmDialog({ title: "Delete bill", message: msg, danger: true }))) return;
    await deleteBillProof(b.filePath);
    setBills((list) => list.filter((x) => x.id !== b.id));
    // Delete-from-either-side: drop the matching daily record too (linked by shared id).
    if (synced) setDailyBills?.((list) => list.filter((x) => x.id !== b.id));
    if (editId === b.id) resetForm();
    log(
      "bill",
      `Deleted ${synced ? "daily-need" : "vendor"} bill — ${b.vendor} · ${INR(b.amount)}`
    );
    notify("Bill deleted");
  };

  const filtered = useMemo(
    () =>
      bills.filter(
        (b) =>
          (!from || b.date >= from) &&
          (!to || b.date <= to) &&
          (!vq.trim() || (b.vendor || "").toLowerCase().includes(vq.trim().toLowerCase())) &&
          (statusF === "all" || (b.status || "unpaid") === statusF) &&
          (catF === "All" || b.category === catF)
      ),
    [bills, from, to, vq, statusF, catF]
  );
  const sorted = useMemo(
    () => [...filtered].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    [filtered]
  );

  const totalSpend = money(filtered.reduce((a, b) => a + (+b.amount || 0), 0));
  const outstanding = money(filtered.reduce((a, b) => a + outstandingOf(b), 0));

  const monthly = useMemo(() => {
    const m = {};
    filtered.forEach((b) => {
      const k = (b.date || "").slice(0, 7);
      if (k) m[k] = (m[k] || 0) + (+b.amount || 0);
    });
    return Object.entries(m)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => ({
        label: new Date(k + "-01T00:00").toLocaleDateString("en-IN", {
          month: "short",
          year: "2-digit",
        }),
        amount: money(v),
      }));
  }, [filtered]);
  const topVendors = useMemo(() => {
    const m = {};
    filtered.forEach((b) => {
      const v = b.vendor || "—";
      m[v] = (m[v] || 0) + (+b.amount || 0);
    });
    return Object.entries(m)
      .map(([name, value]) => ({ name, value: money(value) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }, [filtered]);
  const byCategory = useMemo(() => {
    const m = {};
    filtered.forEach((b) => {
      const c = b.category || "Other";
      m[c] = (m[c] || 0) + (+b.amount || 0);
    });
    return Object.entries(m)
      .map(([name, value]) => ({ name, value: money(value) }))
      .sort((a, b) => b.value - a.value);
  }, [filtered]);
  const topVendorName = topVendors[0]?.name;

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

  return (
    <div>
      <Header
        title="Vendor Bills"
        sub="Record purchase bills with proof — separate from sales, inventory & finance"
      >
        {!online && (
          <span style={{ fontSize: 11.5, color: "#C9803A" }}>
            Offline — proof upload needs internet
          </span>
        )}
      </Header>

      <div
        style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: 16, alignItems: "start" }}
      >
        {/* add / edit form */}
        <section style={S.panel}>
          <div style={S.panelHead}>{editId ? "Edit bill" : "New bill"}</div>
          <Field label="Vendor name">
            <input
              className="input"
              value={form.vendor}
              onChange={(e) => setForm({ ...form, vendor: e.target.value })}
              placeholder="e.g. Sharma Wholesale"
            />
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
            <Field label="Amount (₹)">
              <input
                className="input"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
              />
            </Field>
            <Field label="Category">
              <select
                className="input"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
              >
                {BILL_CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </Field>
            <Field label="Payment status">
              <select
                className="input"
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
              >
                {BILL_STATUS.map((s) => (
                  <option key={s} value={s}>
                    {s[0].toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            </Field>
            {form.status === "partial" && (
              <Field label="Paid so far (₹)">
                <input
                  className="input"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={form.paidAmount}
                  onChange={(e) => setForm({ ...form, paidAmount: e.target.value })}
                />
              </Field>
            )}
            {form.status !== "paid" && (
              <Field label="Due date (optional)">
                <input
                  className="input"
                  type="date"
                  value={form.dueDate}
                  onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
                />
              </Field>
            )}
          </div>
          <Field label={editId ? "Replace proof (optional)" : "Bill proof (optional)"}>
            <input
              ref={fileRef}
              className="input"
              type="file"
              accept={PROOF_ACCEPT}
              onChange={onFile}
            />
          </Field>
          {editId &&
            !file &&
            (() => {
              const cur = bills.find((b) => b.id === editId);
              return cur?.fileURL ? (
                <div style={{ fontSize: 11.5, color: "#6B7E74", marginTop: -6, marginBottom: 6 }}>
                  Current proof:{" "}
                  <a href={cur.fileURL} target="_blank" rel="noopener noreferrer">
                    {cur.fileName || "view"}
                  </a>{" "}
                  — choose a file to replace it.
                </div>
              ) : null;
            })()}
          <div style={{ fontSize: 11, color: "#8A9C90", marginBottom: 10 }}>
            JPG/PNG/PDF/DOC/XLS… up to 10 MB. Stored securely in the cloud.
          </div>
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
                lineHeight: 1.5,
              }}
            >
              {err}
              {file && (
                <div style={{ marginTop: 6 }}>
                  <button
                    className="btn small ghost"
                    disabled={busy}
                    onClick={() => {
                      setFile(null);
                      if (fileRef.current) fileRef.current.value = "";
                      setErr("");
                      notify("Proof removed — you can save the bill without it for now.");
                    }}
                  >
                    Save without proof instead
                  </button>
                </div>
              )}
            </div>
          )}
          <button
            className="btn primary big"
            style={{ width: "100%" }}
            disabled={busy}
            onClick={save}
          >
            {busy ? "Saving…" : editId ? "Save changes" : "Save bill"}
          </button>
          {editId && (
            <button
              className="btn ghost"
              style={{ width: "100%", marginTop: 8 }}
              disabled={busy}
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
              value={statusF}
              onChange={(e) => setStatusF(e.target.value)}
            >
              <option value="all">All status</option>
              {BILL_STATUS.map((s) => (
                <option key={s} value={s}>
                  {s[0].toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
            <select
              className="input"
              style={{ width: "auto" }}
              value={catF}
              onChange={(e) => setCatF(e.target.value)}
            >
              <option>All</option>
              {BILL_CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <input
              className="input"
              style={{ flex: 1, minWidth: 120 }}
              placeholder="Search vendor…"
              value={vq}
              onChange={(e) => setVq(e.target.value)}
            />
            {(from || to || vq || statusF !== "all" || catF !== "All") && (
              <button
                className="btn ghost small"
                onClick={() => {
                  setFrom("");
                  setTo("");
                  setVq("");
                  setStatusF("all");
                  setCatF("All");
                }}
              >
                Clear
              </button>
            )}
          </div>

          <div style={S.cards}>
            <Card label="Total spend" value={INR(totalSpend)} sub={filtered.length + " bills"} />
            <Card label="Outstanding" value={INR(outstanding)} sub="unpaid + partial" accent />
            <Card
              label="Top vendor"
              value={topVendorName || "—"}
              sub={topVendors[0] ? INR(topVendors[0].value) : "—"}
            />
          </div>

          {sorted.length === 0 ? (
            <Empty
              text={
                bills.length === 0
                  ? "No bills yet. Add your first vendor bill on the left."
                  : "No bills match these filters."
              }
            >
              <button className="btn primary" onClick={focusFirstField}>
                Add a vendor bill
              </button>
            </Empty>
          ) : (
            <table className="tbl" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th style={{ width: 96 }}>Date</th>
                  <th>Vendor</th>
                  <th>Category</th>
                  <th style={{ textAlign: "right" }}>Amount</th>
                  <th>Status</th>
                  <th>Proof</th>
                  <th style={{ width: 78 }}></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((b) => {
                  const out = outstandingOf(b);
                  return (
                    <tr key={b.id}>
                      <td style={{ whiteSpace: "nowrap", color: "#677" }}>{fmtDate(b.date)}</td>
                      <td style={{ fontWeight: 600 }}>
                        {b.vendor}
                        {b.source === "daily-need" && (
                          <span
                            title="Synced from Supplier Bills"
                            style={{
                              marginLeft: 6,
                              fontSize: 9.5,
                              fontWeight: 800,
                              textTransform: "uppercase",
                              letterSpacing: ".03em",
                              color: "#0E7C86",
                              border: "1px solid #9FD3D8",
                              background: "#EAF7F8",
                              borderRadius: 6,
                              padding: "0 5px",
                              whiteSpace: "nowrap",
                            }}
                          >
                            🧺 Supplier
                          </span>
                        )}
                      </td>
                      <td style={{ color: "#677", fontSize: 12.5 }}>{b.category || "—"}</td>
                      <td style={{ textAlign: "right", fontWeight: 700 }}>{INR(b.amount)}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <span
                          style={{
                            fontSize: 10.5,
                            fontWeight: 800,
                            textTransform: "uppercase",
                            color: STATUS_COLORS[b.status] || "#789",
                            border: `1px solid ${STATUS_COLORS[b.status] || "#bbb"}`,
                            borderRadius: 6,
                            padding: "0 6px",
                          }}
                        >
                          {b.status || "unpaid"}
                        </span>
                        {out > 0 && (
                          <div style={{ fontSize: 10.5, color: "#C44536" }}>
                            {INR(out)} due{b.dueDate ? " · " + fmtDate(b.dueDate) : ""}
                          </div>
                        )}
                      </td>
                      <td>
                        {b.fileURL ? (
                          isImageType(b.fileType, b.fileName) ? (
                            <a
                              href={b.fileURL}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={b.fileName}
                            >
                              <img
                                src={b.fileURL}
                                alt="proof"
                                style={{
                                  width: 36,
                                  height: 36,
                                  objectFit: "cover",
                                  borderRadius: 6,
                                  border: "1px solid #E2EAE3",
                                }}
                              />
                            </a>
                          ) : (
                            <a
                              href={b.fileURL}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ fontSize: 12 }}
                            >
                              📎 Open
                            </a>
                          )
                        ) : (
                          <span style={{ color: "#AAB", fontSize: 12 }}>—</span>
                        )}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button
                          className="btn small ghost"
                          aria-label={"Edit " + b.vendor}
                          onClick={() => startEdit(b)}
                        >
                          ✎
                        </button>{" "}
                        <button
                          className="btn small danger"
                          aria-label={"Delete " + b.vendor}
                          onClick={() => del(b)}
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
        </section>
      </div>

      {filtered.length > 0 && (
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginTop: 16 }}
        >
          <ChartCard title="Spend by month">
            <BarChart data={monthly} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
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
          <ChartCard title="Spend by category">
            <BarChart
              data={byCategory}
              layout="vertical"
              margin={{ top: 4, right: 12, left: 8, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#EEF3EE" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: "#678" }} tickFormatter={inrTick} />
              <YAxis
                type="category"
                dataKey="name"
                tick={{ fontSize: 10.5, fill: "#465" }}
                width={96}
              />
              <Tooltip formatter={(v) => INR(v)} />
              <Bar dataKey="value" name="Spend" fill="#3DA17A" radius={[0, 3, 3, 0]} />
            </BarChart>
          </ChartCard>
        </div>
      )}
    </div>
  );
}
