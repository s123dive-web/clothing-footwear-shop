import { money, uid, todayStr, INR } from "../lib/format.js";
import { useState, useMemo, Fragment } from "react";
import { Header, Card, Empty, Field } from "../ui/index.jsx";
import { S } from "../ui/styles.js";

// ---------- Udhari / Credit (outstanding by customer) ----------
// Standalone top-level view. Outstanding is tracked across ALL time — a debt isn't
// period-bound — so this reads the full sales list rather than a date-filtered slice.
export const billOut = (s) => Math.max(0, money((s.total || 0) - (s.paid || 0)));
// Minutes since midnight from a stored time like "02:15 pm" / "10:05 am (back-dated)"; -1 if unknown.
export const timeToMin = (t) => {
  const m = String(t || "").match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!m) return -1;
  let h = +m[1];
  const ap = (m[3] || "").toLowerCase();
  if (ap) {
    h = h % 12;
    if (ap === "pm") h += 12;
  }
  return h * 60 + +m[2];
};
// Newest-first comparator for {date,time} records: date descending, then time descending.
export const byDateTimeDesc = (a, b) =>
  a.date !== b.date ? (a.date < b.date ? 1 : -1) : timeToMin(b.time) - timeToMin(a.time);

export function Udhari({ sales, setSales, notify, log, goBilling }) {
  const [openCust, setOpenCust] = useState(() => new Set()); // expanded customer names
  const [openBills, setOpenBills] = useState(() => new Set()); // expanded bills (showing order details)
  const [paying, setPaying] = useState(null); // the sale (bill) a repayment is being recorded against
  const [payAmt, setPayAmt] = useState("");
  const [payMode, setPayMode] = useState("Cash");

  const udhari = useMemo(() => {
    const u = sales.filter((s) => s.payment === "Udhari");
    const byCust = {};
    u.forEach((s) => {
      const out = billOut(s);
      const name = (s.customer || "").trim() || "(no name)";
      const c =
        byCust[name] ||
        (byCust[name] = { name, mobile: "", outstanding: 0, total: 0, bills: 0, billList: [] });
      c.outstanding += out;
      c.total += s.total || 0;
      c.bills += 1;
      c.billList.push(s);
      if (s.mobile) c.mobile = s.mobile;
    });
    const customers = Object.values(byCust)
      .map((c) => ({
        ...c,
        outstanding: money(c.outstanding),
        total: money(c.total),
        // Newest bills first (date then time descending).
        billList: [...c.billList].sort(byDateTimeDesc),
      }))
      .sort((a, b) => b.outstanding - a.outstanding);
    return {
      customers,
      count: u.length,
      totalOutstanding: money(u.reduce((a, s) => a + billOut(s), 0)),
      withDue: customers.filter((c) => c.outstanding > 0),
    };
  }, [sales]);

  // A chronological ledger of every udhari event: credit given (bill date) and each repayment
  // (from the payments ledger; legacy/uncaptured paid amounts reconcile to the bill date).
  const history = useMemo(() => {
    const events = [];
    sales
      .filter((s) => s.payment === "Udhari")
      .forEach((s) => {
        const who = (s.customer || "").trim() || "(no name)";
        events.push({
          id: s.id + "-c",
          date: s.date,
          time: s.time || "",
          kind: "credit",
          who,
          amount: money(s.total || 0),
        });
        const ledger = Array.isArray(s.payments) ? s.payments : [];
        let ledgerSum = 0;
        ledger.forEach((p, i) => {
          const amt = money(p.amount || 0);
          ledgerSum += amt;
          events.push({
            id: `${s.id}-p${p.id || i}`,
            date: p.date || s.date,
            time: p.time || "",
            kind: "paid",
            who,
            amount: amt,
            mode: p.mode || "—",
          });
        });
        const rem = money((s.paid || 0) - ledgerSum);
        if (rem > 0.005)
          events.push({
            id: s.id + "-p0",
            date: s.date,
            time: s.time || "",
            kind: "paid",
            who,
            amount: rem,
            mode: s.paidMode || "—",
            atStart: true,
          });
      });
    // Strictly newest-first: date descending, then time descending. On an exact tie the
    // repayment (the later action) sorts above the credit.
    events.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      const tm = timeToMin(b.time) - timeToMin(a.time);
      if (tm) return tm;
      return a.kind === b.kind ? 0 : a.kind === "paid" ? -1 : 1;
    });
    const totalCredit = money(
      events.filter((e) => e.kind === "credit").reduce((a, e) => a + e.amount, 0)
    );
    const totalPaid = money(
      events.filter((e) => e.kind === "paid").reduce((a, e) => a + e.amount, 0)
    );
    return { events, totalCredit, totalPaid };
  }, [sales]);

  const toggle = (name) =>
    setOpenCust((s) => {
      const n = new Set(s);
      n.has(name) ? n.delete(name) : n.add(name);
      return n;
    });
  const toggleBill = (id) =>
    setOpenBills((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const openPay = (sale) => {
    setPaying(sale);
    setPayAmt(String(billOut(sale)));
    setPayMode(sale.paidMode || "Cash");
  };

  // Current outstanding/figures for the bill being paid are read live from `sales`, so the
  // modal stays correct even if the underlying record changed (e.g. edited elsewhere).
  const payingLive = paying ? sales.find((s) => s.id === paying.id) : null;
  const payOut = payingLive ? billOut(payingLive) : 0;
  const payAmtNum = Math.min(payOut, Math.max(0, money(+payAmt || 0)));
  const payRemaining = money(payOut - payAmtNum);

  const savePayment = () => {
    if (!payingLive) return setPaying(null);
    if (payAmtNum <= 0) return notify("Enter an amount greater than ₹0");
    const newPaid = money((payingLive.paid || 0) + payAmtNum);
    const rem = money((payingLive.total || 0) - newPaid);
    // Single setSales → Sales History, dashboard and cloud sync all pick up the new paid/outstanding.
    // Also append a dated entry to the payments ledger so the History panel can show when it was paid.
    const nowTime = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
    setSales((all) =>
      all.map((x) => {
        if (x.id !== payingLive.id) return x;
        const payments = [
          ...(x.payments || []),
          { id: uid(), date: todayStr(), time: nowTime, amount: payAmtNum, mode: payMode },
        ];
        return { ...x, paid: newPaid, paidMode: payMode, payments };
      })
    );
    const who = (payingLive.customer || "").trim() || "(no name)";
    log(
      "sale",
      `Udhari repayment ${INR(payAmtNum)} (${payMode}) from ${who}${rem > 0 ? ` — ${INR(rem)} still due` : " — bill cleared"}`
    );
    notify(
      `Recorded ${INR(payAmtNum)} (${payMode})${rem > 0 ? ` · ${INR(rem)} still due` : " · bill cleared 🎉"}`
    );
    setPaying(null);
  };

  return (
    <div>
      <Header title="Udhari / Credit" sub="Outstanding credit by customer, across all time." />
      <div style={S.cards}>
        <Card
          label="Outstanding credit"
          value={INR(udhari.totalOutstanding)}
          sub={udhari.withDue.length + " customer(s) owe"}
          accent
        />
        <Card label="Udhari bills" value={udhari.count} sub="total credit bills" />
        <Card
          label="Top debtor"
          value={udhari.withDue[0] ? udhari.withDue[0].name : "—"}
          sub={udhari.withDue[0] ? INR(udhari.withDue[0].outstanding) : "—"}
        />
      </div>
      <section style={{ ...S.panel, marginBottom: 4 }}>
        <div style={S.panelHead}>
          Who owes you{" "}
          <span
            style={{
              fontWeight: 500,
              textTransform: "none",
              letterSpacing: 0,
              color: "#5C6E63",
              marginLeft: 8,
            }}
          >
            {udhari.withDue.length}
          </span>
        </div>
        {udhari.withDue.length === 0 ? (
          <Empty text="No outstanding credit — all udhari settled. 🎉">
            {goBilling && (
              <button className="btn primary" onClick={goBilling}>
                New bill
              </button>
            )}
          </Empty>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 18 }}></th>
                <th>Customer</th>
                <th>Mobile</th>
                <th style={{ textAlign: "right" }}>Bills</th>
                <th style={{ textAlign: "right" }}>Outstanding</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {udhari.withDue.map((c) => {
                const isOpen = openCust.has(c.name);
                const dueBills = c.billList.filter((b) => billOut(b) > 0);
                // Record from the customer row: one bill → pay it straight away; several → expand to choose.
                const recordRow = () =>
                  dueBills.length === 1 ? openPay(dueBills[0]) : toggle(c.name);
                return (
                  <Fragment key={c.name}>
                    <tr onClick={() => toggle(c.name)} style={{ cursor: "pointer" }}>
                      <td style={{ color: "#5C6E63" }}>{isOpen ? "▾" : "▸"}</td>
                      <td style={{ fontWeight: 600 }}>{c.name}</td>
                      <td style={{ color: "#566" }}>{c.mobile || "—"}</td>
                      <td style={{ textAlign: "right" }}>{c.bills}</td>
                      <td style={{ textAlign: "right", fontWeight: 700, color: "#C44536" }}>
                        {INR(c.outstanding)}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          className="btn small primary"
                          onClick={(e) => {
                            e.stopPropagation();
                            recordRow();
                          }}
                        >
                          {dueBills.length === 1 ? "Pay" : "Pay ▸"}
                        </button>
                      </td>
                    </tr>
                    {isOpen &&
                      dueBills.map((b) => {
                        const billOpen = openBills.has(b.id);
                        const nLines = (b.lines || []).length;
                        return (
                          <Fragment key={b.id}>
                            <tr
                              onClick={() => toggleBill(b.id)}
                              style={{ background: "#FAFBF8", cursor: "pointer" }}
                            >
                              <td></td>
                              <td colSpan={3} style={{ fontSize: 12.5, color: "#566" }}>
                                <span style={{ color: "#5C6E63", marginRight: 4 }}>
                                  {billOpen ? "▾" : "▸"}
                                </span>
                                {b.date}
                                {b.time ? " · " + b.time : ""} · {nLines} item
                                {nLines === 1 ? "" : "s"} · bill {INR(b.total)}
                                {(b.paid || 0) > 0
                                  ? ` · paid ${INR(b.paid)}${b.paidMode ? " (" + b.paidMode + ")" : ""}`
                                  : ""}
                              </td>
                              <td style={{ textAlign: "right", fontWeight: 700, color: "#C44536" }}>
                                {INR(billOut(b))}
                              </td>
                              <td style={{ textAlign: "right" }}>
                                <button
                                  className="btn small"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openPay(b);
                                  }}
                                >
                                  Pay
                                </button>
                              </td>
                            </tr>
                            {billOpen && (
                              <tr style={{ background: "#FAFBF8" }}>
                                <td></td>
                                <td colSpan={5} style={{ paddingTop: 0 }}>
                                  <div
                                    style={{
                                      background: "#fff",
                                      border: "1px solid #EEF3EE",
                                      borderRadius: 8,
                                      padding: "8px 12px",
                                    }}
                                  >
                                    {nLines === 0 ? (
                                      <div style={{ fontSize: 12.5, color: "#5C6E63" }}>
                                        No line items on this bill.
                                      </div>
                                    ) : (
                                      b.lines.map((l, i) => (
                                        <div
                                          key={i}
                                          style={{
                                            display: "flex",
                                            justifyContent: "space-between",
                                            fontSize: 12.5,
                                            padding: "3px 0",
                                          }}
                                        >
                                          <span>
                                            {l.name} × {l.qty}
                                          </span>
                                          <span>{INR(l.amount)}</span>
                                        </div>
                                      ))
                                    )}
                                    <div
                                      style={{
                                        display: "flex",
                                        justifyContent: "space-between",
                                        fontSize: 12.5,
                                        fontWeight: 700,
                                        borderTop: "1px dashed #DDE8DE",
                                        marginTop: 4,
                                        paddingTop: 4,
                                      }}
                                    >
                                      <span>Total</span>
                                      <span>{INR(b.total)}</span>
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        <div style={{ fontSize: 11.5, color: "#5C6E63", marginTop: 8 }}>
          Tap a customer to see their bills, then Pay a full or part repayment (Cash / UPI). Sales
          History updates automatically.
        </div>
      </section>

      <section style={{ ...S.panel, marginTop: 16 }}>
        <div style={S.panelHead}>
          History
          <span
            style={{
              fontWeight: 500,
              textTransform: "none",
              letterSpacing: 0,
              color: "#5C6E63",
              marginLeft: 8,
            }}
          >
            {history.events.length} event{history.events.length === 1 ? "" : "s"}
          </span>
          <span
            style={{
              marginLeft: "auto",
              fontWeight: 500,
              fontSize: 12,
              color: "#5C6E63",
              textTransform: "none",
              letterSpacing: 0,
            }}
          >
            Credit given <b style={{ color: "#C44536" }}>{INR(history.totalCredit)}</b> · Repaid{" "}
            <b style={{ color: "#1B5E43" }}>{INR(history.totalPaid)}</b>
          </span>
        </div>
        {history.events.length === 0 ? (
          <Empty text="No udhari/credit activity yet." />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Date &amp; time</th>
                <th>Customer</th>
                <th>Type</th>
                <th style={{ textAlign: "right" }}>Amount</th>
                <th>Mode</th>
              </tr>
            </thead>
            <tbody>
              {history.events.slice(0, 150).map((e) => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: "nowrap", color: "#566" }}>
                    {e.date}
                    {e.time ? <span style={{ color: "#5F6B6B" }}> {e.time}</span> : null}
                  </td>
                  <td style={{ fontWeight: 600 }}>{e.who}</td>
                  <td>
                    {e.kind === "credit" ? (
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 800,
                          color: "#C44536",
                          border: "1px solid #C44536",
                          borderRadius: 6,
                          padding: "1px 6px",
                        }}
                      >
                        CREDIT
                      </span>
                    ) : (
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 800,
                          color: "#1B5E43",
                          border: "1px solid #1B5E43",
                          borderRadius: 6,
                          padding: "1px 6px",
                        }}
                      >
                        PAID
                      </span>
                    )}
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontWeight: 700,
                      color: e.kind === "credit" ? "#C44536" : "#1B5E43",
                    }}
                  >
                    {e.kind === "credit" ? INR(e.amount) : "− " + INR(e.amount)}
                  </td>
                  <td style={{ color: "#566", fontSize: 12 }}>
                    {e.kind === "paid" ? (e.mode || "—") + (e.atStart ? " · at billing" : "") : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {history.events.length > 150 && (
          <div style={{ fontSize: 11.5, color: "#5C6E63", marginTop: 8 }}>
            Showing the most recent 150 of {history.events.length} events.
          </div>
        )}
      </section>

      {paying && payingLive && (
        // Close only when the press STARTS on the backdrop itself. Using onClick here would
        // also fire when a drag/tap that began inside the input releases over the backdrop,
        // closing the modal mid-payment.
        <div
          style={S.overlay}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPaying(null);
          }}
        >
          <div style={S.modal}>
            <h2 style={{ fontSize: 17, margin: "0 0 4px" }}>Pay</h2>
            <div style={{ fontSize: 13, color: "#566", marginBottom: 14 }}>
              <b>{(payingLive.customer || "").trim() || "(no name)"}</b> · {payingLive.date} · bill{" "}
              {INR(payingLive.total)}
              {(payingLive.paid || 0) > 0 ? ` · already paid ${INR(payingLive.paid)}` : ""} ·{" "}
              <span style={{ color: "#C44536", fontWeight: 600 }}>outstanding {INR(payOut)}</span>
            </div>
            <Field label="Amount received">
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  className="input"
                  style={{ flex: 1 }}
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  max={payOut}
                  value={payAmt}
                  onChange={(e) => setPayAmt(e.target.value)}
                  autoFocus
                  aria-label="Amount received"
                />
                <button className="btn small ghost" onClick={() => setPayAmt(String(payOut))}>
                  Full
                </button>
              </div>
            </Field>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 12 }}>
              <span style={{ fontSize: 12, color: "#556A5F", fontWeight: 600 }}>Paid via</span>
              {["Cash", "UPI"].map((m) => (
                <button
                  key={m}
                  className={"btn small " + (payMode === m ? "primary" : "ghost")}
                  onClick={() => setPayMode(m)}
                >
                  {m}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 13, textAlign: "right", marginBottom: 14, fontWeight: 600 }}>
              Paying {INR(payAmtNum)} ({payMode})
              {payRemaining > 0 ? (
                <span style={{ color: "#C44536" }}> · remaining {INR(payRemaining)}</span>
              ) : (
                <span style={{ color: "#1B5E43" }}> · clears this bill 🎉</span>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setPaying(null)}>
                Cancel
              </button>
              <button className="btn primary" onClick={savePayment} disabled={payAmtNum <= 0}>
                Pay
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
