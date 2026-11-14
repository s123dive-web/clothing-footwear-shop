import { useState } from "react";
import { todayStr, money, uid, INR } from "../lib/format.js";
import { parseFile, parseRawText } from "../lib/parse.js";
import { normName } from "../lib/domain.js";
import { guessSubcategory, groupForSubcategory, CLOTHING_SIZES } from "../lib/catalog.js";
import { blankVariant, normalizeProduct } from "../lib/products.js";
import { cloudWriteProduct } from "../lib/cloudProducts.js";
import { CURRENCY } from "../config/currency.js";
import { Header, Empty } from "../ui/index.jsx";
import { S } from "../ui/styles.js";

// ---------- Data Import (file import / paste) ----------
export const RAW_ACCEPT = ".txt,.csv,.tsv,.xls,.xlsx,.pdf,.json";
export function RawData({ items, setSales, setExpenses, notify, log }) {
  const [mode, setMode] = useState("inventory"); // "inventory" | "sales" | "expenses"
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [raw, setRaw] = useState("");
  const [source, setSource] = useState("");
  const [saleDate, setSaleDate] = useState(todayStr());

  // The shared parser yields {name, qty, buyPrice, sellPrice, amount, ...}. Map each mode's rows.
  const toExpenseRow = (r) => ({
    name: r.name || "",
    amount: r.amount || r.sellPrice || r.buyPrice || r.qty || "",
    date: r.date || r.expiry || "",
  });
  const toInvRow = (r) => ({
    name: r.name || "",
    size: "",
    color: "",
    qty: +r.qty || 1,
    buyPrice: r.buyPrice ?? "",
    sellPrice: r.sellPrice ?? "",
  });

  const loadRows = (parsed, srcLabel) => {
    if (!parsed || parsed.length === 0) {
      setErr(
        "No rows found. Make sure the data has product names and numbers — or add rows manually below."
      );
      return;
    }
    setErr(null);
    setRows(
      mode === "expenses"
        ? parsed.map(toExpenseRow)
        : mode === "inventory"
          ? parsed.map(toInvRow)
          : parsed
    );
    setSource(srcLabel);
    notify(`${parsed.length} row(s) loaded — review, edit, then submit`);
  };

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setBusy(true);
    setErr(null);
    try {
      loadRows(await parseFile(f), f.name);
    } catch (ex) {
      console.error(ex);
      setErr("Could not read that file. Supported: txt, csv, tsv, xls, xlsx, pdf, json.");
    }
    setBusy(false);
  };
  const processPaste = () => {
    if (!raw.trim()) return setErr("Paste some data into the box first.");
    try {
      loadRows(parseRawText(raw), "pasted text");
    } catch (ex) {
      console.error(ex);
      setErr("Could not parse that text.");
    }
  };

  const addRow = () =>
    setRows([
      ...(rows || []),
      mode === "expenses"
        ? { name: "", amount: "", date: todayStr() }
        : mode === "inventory"
          ? { name: "", size: "", color: "", qty: 1, buyPrice: "", sellPrice: "" }
          : { name: "", qty: 1, amount: "" },
    ]);
  const edit = (i, k, v) => setRows(rows.map((r, x) => (x === i ? { ...r, [k]: v } : r)));
  const drop = (i) => setRows(rows.filter((_, x) => x !== i));
  const reset = () => {
    setRows(null);
    setRaw("");
    setSource("");
    setErr(null);
  };
  const changeMode = (m) => {
    if (m === mode) return;
    setMode(m);
    setRows(null);
    setErr(null);
  };

  // Each row = a product + one size/colour variant. Rows sharing a product name merge into one
  // product; matching size+colour combine their quantities. Existing products (by name) are
  // updated in place (prices refreshed, stock added), others are created (subcategory guessed).
  const commitInventory = async () => {
    const byName = new Map();
    (rows || []).forEach((r) => {
      const key = normName(r.name);
      if (!key) return;
      const buy = +r.buyPrice || 0,
        sell = +r.sellPrice || 0,
        qty = Math.max(0, +r.qty || 0);
      let e = byName.get(key);
      if (!e) {
        e = { name: r.name.trim(), buy, sell, variants: new Map() };
        byName.set(key, e);
      }
      if (buy) e.buy = buy;
      if (sell) e.sell = sell;
      const vk = String(r.size || "").trim() + "|" + String(r.color || "").trim();
      e.variants.set(vk, (e.variants.get(vk) || 0) + qty);
    });
    if (byName.size === 0) return notify("Add at least one row with a product name.");
    let created = 0,
      updated = 0;
    for (const e of byName.values()) {
      const existing = items.find((i) => normName(i.name) === normName(e.name));
      const sell = e.sell || (e.buy ? Math.round(e.buy * 1.4) : 0);
      const sub = existing?.subcategory || guessSubcategory(e.name) || "Kurtis";
      const base = existing ? existing.variants.map((v) => ({ ...v })) : [];
      e.variants.forEach((qty, vk) => {
        const [size, color] = vk.split("|");
        const match = base.find((v) => (v.size || "") === size && (v.color || "") === color);
        if (match) match.stockQty = (Number(match.stockQty) || 0) + qty;
        else base.push(blankVariant({ size, color, stockQty: qty }));
      });
      const product = normalizeProduct({
        ...(existing || {}),
        id: existing?.id,
        name: e.name,
        subcategory: sub,
        category: groupForSubcategory(sub),
        purchasePrice: e.buy || existing?.purchasePrice || 0,
        sellingPrice: sell || existing?.sellingPrice || 0,
        mrp: existing?.mrp || sell,
        variants: base,
        createdAt: existing?.createdAt || todayStr(),
      });
      try {
        await cloudWriteProduct(product);
        existing ? updated++ : created++;
      } catch (ex) {
        console.error("import product failed", ex);
      }
    }
    log(
      "import",
      `Imported to inventory (${source || "manual"}): ${created} new, ${updated} updated`
    );
    reset();
    notify(`Inventory updated — ${created} new, ${updated} updated`);
  };

  // Record an imported sale (revenue + profit). Stock is NOT changed for imports (a historical
  // row can't be mapped to a specific size/colour reliably).
  const commitSales = () => {
    const agg = new Map();
    (rows || []).forEach((r) => {
      const key = normName(r.name);
      if (!key) return;
      const qty = Math.max(0, +r.qty || 0);
      const amount = +r.amount || 0;
      const e = agg.get(key) || { name: r.name.trim(), qty: 0, amount: 0 };
      e.qty += qty;
      e.amount += amount;
      agg.set(key, e);
    });
    let total = 0,
      profit = 0;
    const lines = [...agg.values()].map((a) => {
      total += a.amount;
      const ex = items.find((i) => normName(i.name) === normName(a.name));
      const buy = ex ? Number(ex.purchasePrice) || 0 : 0;
      if (ex) profit += a.amount - buy * a.qty;
      return {
        name: a.name,
        qty: a.qty,
        price: a.qty ? money(a.amount / a.qty) : a.amount,
        buyPrice: buy,
        amount: money(a.amount),
        size: "",
        color: "",
      };
    });
    if (!lines.length) return notify("Add at least one line with a name and amount.");
    total = money(total);
    profit = money(profit);
    const now = new Date();
    setSales((s) => [
      ...s,
      {
        id: uid(),
        date: saleDate || todayStr(),
        time:
          now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) + " (imported)",
        lines,
        total,
        profit,
      },
    ]);
    log("import", `Imported sale ${INR(total)} · ${lines.length} line(s) (${source || "manual"})`);
    reset();
    notify("Sale recorded — " + INR(total));
  };

  const commitExpenses = () => {
    const valid = (rows || []).filter((r) => (r.name || "").trim() && +r.amount > 0);
    if (!valid.length)
      return notify("Each expense needs a description and an amount greater than 0.");
    const newRows = valid.map((r) => ({
      id: uid(),
      date: r.date || todayStr(),
      desc: r.name.trim(),
      amount: money(+r.amount),
    }));
    const sum = money(newRows.reduce((a, e) => a + e.amount, 0));
    setExpenses((list) => [...list, ...newRows]);
    log("import", `Imported ${newRows.length} expense(s) (${source || "manual"}) · ${INR(sum)}`);
    reset();
    notify(`${newRows.length} expense(s) added — ${INR(sum)}`);
  };

  const cur = CURRENCY.symbol;
  return (
    <div>
      <Header title="Data Import" sub="Import a file or paste data — then review, edit, and submit">
        {rows && (
          <button className="btn ghost small" onClick={reset}>
            Start over
          </button>
        )}
      </Header>

      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <button
          className={"btn " + (mode === "inventory" ? "primary" : "")}
          onClick={() => changeMode("inventory")}
        >
          ➕ Add products
        </button>
        <button
          className={"btn " + (mode === "sales" ? "primary" : "")}
          onClick={() => changeMode("sales")}
        >
          🧾 Record a sale
        </button>
        <button
          className={"btn " + (mode === "expenses" ? "primary" : "")}
          onClick={() => changeMode("expenses")}
        >
          💸 Add expenses
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 16 }}>
        <section style={S.panel}>
          <div style={S.panelHead}>1 · Provide data</div>
          <label
            className="btn primary"
            style={{
              display: "block",
              textAlign: "center",
              padding: "14px",
              cursor: "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? "Reading file…" : "📂 Choose a file"}
            <input
              type="file"
              accept={RAW_ACCEPT}
              onChange={onFile}
              disabled={busy}
              style={{ display: "none" }}
            />
          </label>
          <div
            style={{ fontSize: 11.5, color: "#5C6E63", margin: "8px 0 14px", textAlign: "center" }}
          >
            txt · csv · tsv · xls · xlsx · pdf · json
          </div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#465", marginBottom: 6 }}>
            …or paste data
          </div>
          <textarea
            className="input"
            aria-label="Paste data to import"
            rows={6}
            placeholder={
              mode === "inventory"
                ? "name, qty, buy, sell\nCotton Kurti, 5, 380, 649\nLeggings, 10, 180, 349"
                : mode === "expenses"
                  ? "expense, amount, date\nShop rent, 15000, 2026-06-01\nElectricity, 1800, 01/06/2026"
                  : "name, qty, amount\nCotton Kurti, 2, 1298\nLeggings, 3, 1047"
            }
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            style={{ resize: "vertical", fontFamily: "monospace", fontSize: 12.5 }}
          />
          <button className="btn" style={{ width: "100%", marginTop: 8 }} onClick={processPaste}>
            Process pasted data
          </button>
          {err && <div style={{ color: "#C44536", fontSize: 13, marginTop: 10 }}>{err}</div>}
          <div style={{ fontSize: 11.5, color: "#5C6E63", marginTop: 12, lineHeight: 1.5 }}>
            {mode === "inventory"
              ? "Columns are auto-detected (name / qty / buy / sell). Each row becomes a product with one size/colour variant — set the size & colour in the preview. Existing names get more stock; new names create a product (subcategory guessed from the name; blank sell = buy + 40%)."
              : mode === "expenses"
                ? "Auto-detected columns: description, amount, date. Blank dates default to today; rows with no amount are skipped."
                : "Auto-detected columns: name, qty, amount. Imported sales record revenue/profit but do not change stock."}
          </div>
        </section>

        <section style={S.panel}>
          <div style={S.panelHead}>
            2 · Review &amp; edit
            {source ? (
              <span
                style={{
                  fontWeight: 500,
                  textTransform: "none",
                  letterSpacing: 0,
                  color: "#5C6E63",
                  marginLeft: 8,
                }}
              >
                from {source}
              </span>
            ) : null}
            <button className="btn small ghost" style={{ marginLeft: "auto" }} onClick={addRow}>
              + Add row
            </button>
          </div>
          {!rows ? (
            <Empty
              text={
                busy
                  ? "Reading…"
                  : "Imported rows appear here. You can also build a list by hand with “+ Add row”."
              }
            />
          ) : (
            <>
              {mode === "sales" && (
                <label
                  style={{ fontSize: 12, color: "#556A5F", display: "block", marginBottom: 10 }}
                >
                  Sale date{" "}
                  <input
                    type="date"
                    className="input"
                    style={{ width: "auto", marginLeft: 6 }}
                    value={saleDate}
                    max={todayStr()}
                    onChange={(e) => setSaleDate(e.target.value || todayStr())}
                  />
                </label>
              )}
              {mode === "expenses" ? (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Description</th>
                      <th style={{ width: 110 }}>Amount {cur}</th>
                      <th style={{ width: 150 }}>Date</th>
                      <th style={{ width: 30 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i}>
                        <td>
                          <input
                            className="input"
                            style={{ padding: "6px 8px" }}
                            value={r.name}
                            aria-label="Example: Shop rent"
                            placeholder="e.g. Shop rent"
                            onChange={(e) => edit(i, "name", e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            style={{ padding: "6px 8px" }}
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="0.01"
                            value={r.amount}
                            onChange={(e) => edit(i, "amount", e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            style={{ padding: "6px 8px" }}
                            type="date"
                            max={todayStr()}
                            value={r.date || ""}
                            onChange={(e) => edit(i, "date", e.target.value)}
                          />
                        </td>
                        <td>
                          <button
                            className="btn small danger"
                            aria-label="Remove row"
                            onClick={() => drop(i)}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={4}>
                          <Empty text="No rows yet — click “+ Add row”." />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              ) : mode === "inventory" ? (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th style={{ width: 80 }}>Size</th>
                      <th style={{ width: 96 }}>Colour</th>
                      <th style={{ width: 54 }}>Qty</th>
                      <th style={{ width: 78 }}>Buy {cur}</th>
                      <th style={{ width: 78 }}>Sell {cur}</th>
                      <th style={{ width: 30 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i}>
                        <td>
                          <input
                            className="input"
                            style={{ padding: "6px 8px" }}
                            value={r.name}
                            onChange={(e) => edit(i, "name", e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            style={{ padding: "6px 6px" }}
                            list="color-list-sizes"
                            value={r.size}
                            onChange={(e) => edit(i, "size", e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            style={{ padding: "6px 6px" }}
                            list="color-list"
                            value={r.color}
                            onChange={(e) => edit(i, "color", e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            style={{ padding: "6px 6px" }}
                            type="number"
                            inputMode="decimal"
                            min="0"
                            value={r.qty}
                            onChange={(e) => edit(i, "qty", +e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            style={{ padding: "6px 8px" }}
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="0.01"
                            value={r.buyPrice}
                            onChange={(e) => edit(i, "buyPrice", e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            style={{ padding: "6px 8px" }}
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="0.01"
                            value={r.sellPrice}
                            onChange={(e) => edit(i, "sellPrice", e.target.value)}
                          />
                        </td>
                        <td>
                          <button
                            className="btn small danger"
                            aria-label="Remove row"
                            onClick={() => drop(i)}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={7}>
                          <Empty text="No rows yet — click “+ Add row”." />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th style={{ width: 58 }}>Qty</th>
                      <th style={{ width: 96 }}>Amount {cur}</th>
                      <th style={{ width: 30 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i}>
                        <td>
                          <input
                            className="input"
                            style={{ padding: "6px 8px" }}
                            value={r.name}
                            onChange={(e) => edit(i, "name", e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            style={{ padding: "6px 8px" }}
                            type="number"
                            inputMode="decimal"
                            min="0"
                            value={r.qty}
                            onChange={(e) => edit(i, "qty", +e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            style={{ padding: "6px 8px" }}
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="0.01"
                            value={r.amount}
                            onChange={(e) => edit(i, "amount", e.target.value)}
                          />
                        </td>
                        <td>
                          <button
                            className="btn small danger"
                            aria-label="Remove row"
                            onClick={() => drop(i)}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={4}>
                          <Empty text="No rows yet — click “+ Add row”." />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
              <button
                className="btn primary big"
                style={{ width: "100%", marginTop: 12 }}
                disabled={rows.length === 0}
                onClick={
                  mode === "inventory"
                    ? commitInventory
                    : mode === "expenses"
                      ? commitExpenses
                      : commitSales
                }
              >
                {mode === "inventory"
                  ? `Add ${rows.length} row(s) to inventory`
                  : mode === "expenses"
                    ? `Add ${rows.length} expense(s)`
                    : `Record sale · ${rows.length} line(s)`}
              </button>
            </>
          )}
        </section>
      </div>
      <datalist id="color-list-sizes">
        {[...CLOTHING_SIZES, "3", "4", "5", "6", "7", "8", "9"].map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  );
}
