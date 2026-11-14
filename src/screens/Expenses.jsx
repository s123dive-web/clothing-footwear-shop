import { useState } from "react";
import { todayStr, money, uid, INR } from "../lib/format.js";
import { Header, Field, Empty } from "../ui/index.jsx";
import { S } from "../ui/styles.js";

// ---------- Add Expense (own page) ----------
export function Expenses({ expenses, setExpenses, notify, log }) {
  const [exp, setExp] = useState({ desc: "", amount: "", date: todayStr() });
  const [month, setMonth] = useState(todayStr().slice(0, 7));
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState(null); // { id, desc, amount, date } being edited inline
  const listed = showAll ? expenses : expenses.filter((e) => e.date.startsWith(month));
  const sorted = [...listed].sort((a, b) => (a.date < b.date ? 1 : -1));
  const total = money(listed.reduce((a, e) => a + e.amount, 0));
  const monthLabel = new Date(month + "-01T00:00").toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
  });

  const addExp = () => {
    if (!exp.desc.trim() || !(+exp.amount > 0))
      return notify("Enter a description and a positive amount");
    const date = exp.date || todayStr();
    const row = { id: uid(), date, desc: exp.desc.trim(), amount: +exp.amount };
    setExpenses((list) => [...list, row]);
    log(
      "expense",
      `Expense ${INR(+exp.amount)} — ${exp.desc.trim()}` +
        (date !== todayStr() ? ` (dated ${date})` : "")
    );
    setExp({ desc: "", amount: "", date: todayStr() });
    notify("Expense recorded");
  };

  const del = (e) => {
    // Reversible → no "are you sure?"; a 5-second Undo instead.
    setExpenses((list) => list.filter((x) => x.id !== e.id));
    if (editing?.id === e.id) setEditing(null);
    log("expense", `Deleted expense ${INR(e.amount)} — ${e.desc}`);
    notify("Expense deleted", {
      action: {
        label: "Undo",
        run: () => {
          setExpenses((list) => (list.some((x) => x.id === e.id) ? list : [...list, e]));
          log("expense", `Restored expense ${INR(e.amount)} — ${e.desc}`);
          notify("Expense restored");
        },
      },
    });
  };

  const startEdit = (e) =>
    setEditing({ id: e.id, desc: e.desc, amount: String(e.amount), date: e.date });
  const saveEdit = () => {
    if (!editing.desc.trim() || !(+editing.amount > 0))
      return notify("Enter a description and a positive amount");
    const date = editing.date || todayStr();
    const amount = money(+editing.amount);
    setExpenses((list) =>
      list.map((x) => (x.id === editing.id ? { ...x, desc: editing.desc.trim(), amount, date } : x))
    );
    log("expense", `Edited expense ${INR(amount)} — ${editing.desc.trim()}`);
    setEditing(null);
    notify("Expense updated");
  };

  return (
    <div>
      <Header
        title="Add Expense"
        sub="Record shop expenses — rent, electricity, supplies, salaries…"
      >
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: 12, color: showAll ? "#9AA" : "#6B7E74" }}>
            Month{" "}
            <input
              type="month"
              className="input"
              style={{ width: "auto", marginLeft: 4 }}
              value={month}
              max={todayStr().slice(0, 7)}
              disabled={showAll}
              onChange={(e) => setMonth(e.target.value || todayStr().slice(0, 7))}
            />
          </label>
          <button
            className={"btn small " + (showAll ? "primary" : "ghost")}
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? "Showing all" : "Show all"}
          </button>
        </div>
      </Header>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 16 }}>
        <section style={S.panel}>
          <div style={S.panelHead}>New expense</div>
          <Field label="Description">
            <input
              className="input"
              autoFocus
              value={exp.desc}
              onChange={(e) => setExp({ ...exp, desc: e.target.value })}
              placeholder="e.g. Electricity bill"
            />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Amount (₹)">
              <input
                className="input"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={exp.amount}
                onChange={(e) => setExp({ ...exp, amount: e.target.value })}
              />
            </Field>
            <Field label="Date">
              <input
                className="input"
                type="date"
                max={todayStr()}
                value={exp.date}
                onChange={(e) => setExp({ ...exp, date: e.target.value })}
              />
            </Field>
          </div>
          <button
            className="btn primary big"
            style={{ width: "100%", marginTop: 8 }}
            onClick={addExp}
          >
            Record expense
          </button>
        </section>

        <section style={S.panel}>
          <div style={S.panelHead}>
            {showAll ? "All expenses" : monthLabel}
            <span
              style={{
                fontWeight: 500,
                textTransform: "none",
                letterSpacing: 0,
                color: "#8A9C90",
                marginLeft: 8,
              }}
            >
              {listed.length} {listed.length === 1 ? "entry" : "entries"}
            </span>
            <span style={{ marginLeft: "auto", fontWeight: 800 }}>{INR(total)}</span>
          </div>
          {sorted.length === 0 ? (
            <Empty
              text={
                showAll
                  ? "No expenses recorded yet."
                  : "No expenses recorded in " + monthLabel + "."
              }
            />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 150 }}>Date</th>
                  <th>Description</th>
                  <th style={{ textAlign: "right", width: 100 }}>Amount</th>
                  <th style={{ width: 96 }}></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((e) =>
                  editing?.id === e.id ? (
                    <tr key={e.id}>
                      <td>
                        <input
                          className="input"
                          style={{ padding: "6px 8px" }}
                          type="date"
                          max={todayStr()}
                          value={editing.date}
                          onChange={(ev) => setEditing({ ...editing, date: ev.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          style={{ padding: "6px 8px" }}
                          value={editing.desc}
                          onChange={(ev) => setEditing({ ...editing, desc: ev.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          style={{ padding: "6px 8px", textAlign: "right" }}
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="0.01"
                          value={editing.amount}
                          onChange={(ev) => setEditing({ ...editing, amount: ev.target.value })}
                        />
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button className="btn small primary" aria-label="Save" onClick={saveEdit}>
                          ✓
                        </button>{" "}
                        <button
                          className="btn small ghost"
                          aria-label="Cancel"
                          onClick={() => setEditing(null)}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ) : (
                    <tr key={e.id}>
                      <td style={{ color: "#677", whiteSpace: "nowrap" }}>{e.date}</td>
                      <td>{e.desc}</td>
                      <td style={{ textAlign: "right", fontWeight: 700 }}>{INR(e.amount)}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button
                          className="btn small ghost"
                          aria-label={"Edit " + e.desc}
                          onClick={() => startEdit(e)}
                        >
                          ✎
                        </button>{" "}
                        <button
                          className="btn small danger"
                          aria-label={"Delete " + e.desc}
                          onClick={() => del(e)}
                        >
                          🗑
                        </button>
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
