import { useShopConfig } from "../config/shopConfig.js";
import { useState, useMemo, memo, useEffect } from "react";
import { useDebouncedValue, useStableCallback, usePagedLimit } from "../ui/hooks.js";
import { money, INR, dateStr, todayStr, uid } from "../lib/format.js";
import { Header, Empty, Modal, Field } from "../ui/index.jsx";
import { S } from "../ui/styles.js";
import { PAY_COLORS } from "../lib/domain.js";
import { printReceipt, lineVariantText } from "../lib/print.js";

// One bill row (+ its expanded detail). Memoised so typing in the search box, opening another
// bill or a toast does not re-render every bill on screen.
const BillRow = memo(function BillRow({
  s,
  isOpen,
  searching,
  onToggle,
  onPrint,
  onEdit,
  onSplit,
  onDelete,
}) {
  return (
    <div>
      <div style={{ ...S.row, cursor: "pointer" }} onClick={() => onToggle(s.id)}>
        <span>
          {s.time} · {s.lines.length} item{s.lines.length > 1 ? "s" : ""}
          {searching && (
            <span style={{ marginLeft: 6, fontSize: 11, color: "#8A9C90" }}>
              {new Date(s.date + "T00:00").toLocaleDateString("en-IN", {
                day: "numeric",
                month: "short",
              })}
            </span>
          )}
          {s.payment && (
            <span
              style={{
                marginLeft: 8,
                fontSize: 10.5,
                fontWeight: 800,
                color: PAY_COLORS[s.payment] || "#789",
                border: `1px solid ${PAY_COLORS[s.payment] || "#bbb"}`,
                borderRadius: 6,
                padding: "0 6px",
              }}
            >
              {s.payment}
              {s.customer ? " · " + s.customer : ""}
              {s.mobile ? " · " + s.mobile : ""}
            </span>
          )}
        </span>
        <span>
          <b>{INR(s.total)}</b>{" "}
          <span style={{ color: "#1B5E43", fontSize: 12 }}>(+{INR(s.profit)})</span>
          {s.payment === "Udhari" && s.total - (s.paid || 0) > 0 && (
            <span
              style={{
                color: "#C44536",
                fontSize: 11.5,
                fontWeight: 700,
                marginLeft: 6,
              }}
            >
              {INR(money(s.total - (s.paid || 0)))} due
            </span>
          )}{" "}
          {isOpen ? "▾" : "▸"}
        </span>
      </div>
      {(isOpen || searching) && (
        <div
          style={{
            background: "#F4F7F4",
            borderRadius: 8,
            padding: "8px 12px",
            margin: "0 0 8px",
          }}
        >
          {s.lines.map((l, i) => (
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
          ))}
          {s.discount > 0 && (
            <div style={{ borderTop: "1px dashed #D8E0D8", marginTop: 4, paddingTop: 4 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 12.5,
                  padding: "2px 0",
                  color: "#6B7E74",
                }}
              >
                <span>Subtotal</span>
                <span>{INR(s.subtotal != null ? s.subtotal : money(s.total + s.discount))}</span>
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 12.5,
                  padding: "2px 0",
                  color: "#C44536",
                  fontWeight: 600,
                }}
              >
                <span>Discount{s.discountPct ? ` (${s.discountPct}%)` : ""}</span>
                <span>−{INR(s.discount)}</span>
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 13,
                  padding: "2px 0",
                  fontWeight: 800,
                }}
              >
                <span>Total</span>
                <span>{INR(s.total)}</span>
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button className="btn small" onClick={() => onPrint(s)}>
              🖨 Print
            </button>
            <button className="btn small ghost" onClick={() => onEdit(s)}>
              ✎ Edit bill
            </button>
            <button className="btn small ghost" onClick={() => onSplit(s)}>
              ✂ Split
            </button>
            <button className="btn small danger" onClick={() => onDelete(s)}>
              🗑 Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

const BILLS_PER_DATE = 200; // a single day rarely has more; beyond this, show on request
const DATES_PER_PAGE = 60;

export function SalesHistory({
  sales,
  items,
  setSales,
  amendSale,
  voidSale,
  notify,
  log,
  salesFrom = null,
  loadOlderSales,
  recordSale,
}) {
  const config = useShopConfig();
  const [open, setOpen] = useState(null);
  const [openDates, setOpenDates] = useState(() => new Set()); // expanded past dates (today is always open)
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState(""); // free-text search across bills
  const [editing, setEditing] = useState(null); // { id, date, payment, lines:[...], orig:[...] }
  const toggleDate = (d) =>
    setOpenDates((s) => {
      const n = new Set(s);
      n.has(d) ? n.delete(d) : n.add(d);
      return n;
    });

  // Search matches a bill when EVERY space-separated term is found somewhere in it —
  // item names, customer, mobile, payment, date/time, bill id, or any amount/quantity.
  const dq = useDebouncedValue(q, 200);
  // Only recent bills are loaded by default (lib/salesWindow.js). Older ones are fetched once,
  // on request — or automatically when the "from" date reaches back before what is loaded.
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadOlder = async (fromDate) => {
    if (!loadOlderSales || loadingOlder) return;
    setLoadingOlder(true);
    const ok = await loadOlderSales(fromDate);
    setLoadingOlder(false);
    if (!ok) notify("⚠ Older bills need an internet connection.");
  };
  useEffect(() => {
    if (salesFrom && from && from < salesFrom && loadOlderSales) loadOlderSales(from);
  }, [from, salesFrom, loadOlderSales]);
  const olderStep = () => {
    const d = new Date(salesFrom + "T00:00");
    d.setMonth(d.getMonth() - 3);
    return dateStr(d);
  };
  const terms = dq.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const searching = terms.length > 0;
  const matchSale = (s) => {
    if (!searching) return true;
    const hay = [
      s.date,
      s.time,
      s.payment,
      s.customer,
      s.mobile,
      s.id,
      s.total,
      s.profit,
      s.paid,
      ...(s.lines || []).flatMap((l) => [l.name, l.qty, l.amount, l.price]),
    ]
      .filter((v) => v != null)
      .join(" ")
      .toLowerCase();
    return terms.every((t) => hay.includes(t));
  };

  const visible = sales.filter(
    (s) => (!from || s.date >= from) && (!to || s.date <= to) && matchSale(s)
  );
  const byDate = useMemo(() => {
    const m = {};
    [...visible].reverse().forEach((s) => {
      (m[s.date] = m[s.date] || []).push(s);
    });
    return Object.entries(m).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [visible]);
  const rangeTotal = money(visible.reduce((a, s) => a + s.total, 0));
  // Long histories: 60 date groups at a time, and at most 200 bills of one day until asked.
  const [dateLimit, showMoreDates] = usePagedLimit(DATES_PER_PAGE, dq + "|" + from + "|" + to);
  const [fullDates, setFullDates] = useState(() => new Set());
  const onToggle = useStableCallback((id) => setOpen((o) => (o === id ? null : id)));
  const onPrint = useStableCallback((s) => printReceipt(s, config));
  const onEdit = useStableCallback((s) => openEdit(s));
  const onSplit = useStableCallback((s) => openSplit(s));
  const onDelete = useStableCallback((s) => deleteSale(s));

  // Bill edits and deletes go through amendSale / voidSale (StoreManager): the bill change and
  // the per-variant stock correction are ONE outbox op, so they cannot drift apart, failures
  // are surfaced and retried, and a replay never adjusts stock twice. Lines without a
  // productId (misc, or legacy) touch no stock.
  const deleteSale = (s) => {
    // Reversible → no "are you sure?"; a 5-second Undo re-creates the bill and takes the stock
    // back out (a fresh outbox op, so it is as safe as the original sale).
    voidSale(s);
    log("sale", `Deleted bill ${INR(s.total)} (${s.date}) — stock restored`);
    notify("Bill deleted, stock restored", {
      action: {
        label: "Undo",
        run: () => {
          recordSale(s);
          log("sale", `Restored deleted bill ${INR(s.total)} (${s.date})`);
          notify("Bill restored");
        },
      },
    });
  };

  const openEdit = (s) =>
    setEditing({
      id: s.id,
      date: s.date,
      payment: s.payment || "UPI",
      paid: s.paid != null ? String(s.paid) : "",
      paidMode: s.paidMode || "Cash",
      discount: s.discount != null ? String(s.discount) : "", // editable ₹ discount (a % discount is edited as its ₹ value)
      lines: s.lines.map((l) => ({ ...l })),
      orig: s.lines.map((l) => ({ ...l })),
    });
  const editLine = (idx, qty) =>
    setEditing((e) => ({
      ...e,
      lines: e.lines.map((l, i) => (i === idx ? { ...l, qty: Math.max(0, qty || 0) } : l)),
    }));
  const removeLine = (idx) =>
    setEditing((e) => ({ ...e, lines: e.lines.filter((_, i) => i !== idx) }));
  const editSubtotal = editing ? money(editing.lines.reduce((a, l) => a + l.price * l.qty, 0)) : 0;
  const editDiscount = editing
    ? Math.min(editSubtotal, Math.max(0, money(+editing.discount || 0)))
    : 0;
  const editTotal = money(editSubtotal - editDiscount);

  const saveEdit = () => {
    const newLines = editing.lines
      .filter((l) => l.qty > 0)
      .map((l) => ({ ...l, amount: money(l.price * l.qty) }));
    if (newLines.length === 0) return notify("A bill needs at least one line — use Delete instead");
    const gross = money(newLines.reduce((a, l) => a + l.amount, 0));
    // Re-clamp any existing discount to the new subtotal, then net it off total and profit.
    const discountAmt = Math.min(gross, Math.max(0, money(+editing.discount || 0)));
    const total = money(gross - discountAmt);
    // Prefer the cost snapshotted on the line at sale time; fall back to the current item
    // cost only for legacy bills saved before lines carried buyPrice.
    const buyOf = (l) =>
      l.buyPrice != null
        ? +l.buyPrice
        : items.find((i) => i.name.toLowerCase() === l.name.toLowerCase())?.purchasePrice || 0;
    const profit = money(
      newLines.reduce((a, l) => a + (l.price - buyOf(l)) * l.qty, 0) - discountAmt
    );
    const paid =
      editing.payment === "Udhari"
        ? Math.min(total, Math.max(0, money(+editing.paid || 0)))
        : undefined;
    const prev = sales.find((x) => x.id === editing.id);
    if (!prev) {
      setEditing(null);
      return notify("That bill no longer exists.");
    }
    const next = {
      ...prev,
      date: editing.date || prev.date,
      payment: editing.payment,
      lines: newLines,
      total,
      profit,
    };
    // A % discount, once edited, is stored as its plain ₹ value — drop the stale percent tag.
    if (discountAmt > 0) {
      next.subtotal = gross;
      next.discount = discountAmt;
      delete next.discountPct;
    } else {
      delete next.subtotal;
      delete next.discount;
      delete next.discountPct;
    }
    if (editing.payment === "Udhari") {
      next.paid = paid;
      if (paid > 0) next.paidMode = editing.paidMode;
      else delete next.paidMode;
    } else {
      delete next.paid;
      delete next.paidMode;
    }
    // Stock is reconciled per (product, variant) from the ORIGINAL lines of the stored bill to
    // the new lines, inside the same op as the bill change.
    amendSale(prev, next);
    log("sale", `Edited bill → ${INR(total)} · ${newLines.length} line(s) · ${editing.payment}`);
    setEditing(null);
    notify("Bill updated");
  };

  // ----- Split a bill across multiple dates -----
  // Replaces one bill with several smaller bills whose amounts (and, in the same
  // proportion, profit + line amounts) add up to exactly the original. It is purely a
  // re-dating of money already recorded, so stock is NOT touched. Because the dashboard
  // and finance views aggregate from the sales list by date/total/profit/lines, the split
  // parts flow through everywhere and the cumulative stays equal to the original bill.
  const [splitting, setSplitting] = useState(null);
  // { id, time, payment, customer, total, profit, lines, parts:[{date, amount}] }

  const addDays = (ds, n) => {
    const d = new Date(ds + "T00:00");
    d.setDate(d.getDate() + n);
    return dateStr(d);
  };
  // Spread an amount equally across n parts as 2-dp money; the last part absorbs the remainder.
  const equalShares = (amount, n) => {
    const each = money(amount / n);
    return Array.from({ length: n }, (_, i) =>
      i === n - 1 ? money(amount - each * (n - 1)) : each
    );
  };

  const openSplit = (s) =>
    setSplitting({
      id: s.id,
      time: s.time,
      payment: s.payment || "UPI",
      customer: s.customer || "",
      mobile: s.mobile || "",
      paid: s.paid || 0,
      paidMode: s.paidMode || "Cash",
      total: s.total,
      profit: s.profit,
      lines: s.lines,
      parts: equalShares(s.total, 2).map((amount, i) => ({ date: addDays(s.date, -i), amount })),
      rangeFrom: addDays(s.date, -1),
      rangeTo: s.date,
    });
  // Every calendar day in [from, to] inclusive.
  const datesInRange = (from, to) => {
    if (!from || !to || from > to) return [];
    const out = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
  };
  const setRangeFrom = (v) => setSplitting((sp) => ({ ...sp, rangeFrom: v }));
  const setRangeTo = (v) => setSplitting((sp) => ({ ...sp, rangeTo: v }));
  // Fill one part per day across the range, divided equally (still editable afterwards).
  const applyRange = () => {
    if (!splitting) return;
    const dates = datesInRange(splitting.rangeFrom, splitting.rangeTo);
    if (!dates.length) return notify("Pick a valid range — From must be on or before To.");
    if (dates.length > 90) return notify("Range too large — keep it within 90 days.");
    const shares = equalShares(splitting.total, dates.length);
    setSplitting((sp) => ({ ...sp, parts: dates.map((date, i) => ({ date, amount: shares[i] })) }));
  };
  const divideEqually = () =>
    setSplitting((sp) => {
      const shares = equalShares(sp.total, sp.parts.length);
      return { ...sp, parts: sp.parts.map((p, i) => ({ ...p, amount: shares[i] })) };
    });
  const addPart = () =>
    setSplitting((sp) => {
      const lastDate = sp.parts[sp.parts.length - 1]?.date || todayStr();
      const parts = [...sp.parts, { date: addDays(lastDate, -1), amount: 0 }];
      const shares = equalShares(sp.total, parts.length);
      return { ...sp, parts: parts.map((p, i) => ({ ...p, amount: shares[i] })) };
    });
  const removePart = (idx) =>
    setSplitting((sp) => {
      if (sp.parts.length <= 2) return sp;
      const parts = sp.parts.filter((_, i) => i !== idx);
      const shares = equalShares(sp.total, parts.length);
      return { ...sp, parts: parts.map((p, i) => ({ ...p, amount: shares[i] })) };
    });
  const setPartDate = (idx, date) =>
    setSplitting((sp) => ({
      ...sp,
      parts: sp.parts.map((p, i) => (i === idx ? { ...p, date } : p)),
    }));
  const setPartAmount = (idx, amount) =>
    setSplitting((sp) => ({
      ...sp,
      parts: sp.parts.map((p, i) => (i === idx ? { ...p, amount } : p)),
    }));
  // Put whatever is left over (total − all earlier parts) onto the last part, so the
  // amounts add up to the original in one click after editing the others.
  const balanceSplit = () =>
    setSplitting((sp) => {
      const exceptLast = money(sp.parts.slice(0, -1).reduce((a, p) => a + (+p.amount || 0), 0));
      return {
        ...sp,
        parts: sp.parts.map((p, i) =>
          i === sp.parts.length - 1 ? { ...p, amount: money(sp.total - exceptLast) } : p
        ),
      };
    });

  const splitSum = splitting ? money(splitting.parts.reduce((a, p) => a + (+p.amount || 0), 0)) : 0;
  const splitDiff = splitting ? money(splitting.total - splitSum) : 0;
  // Valid when every part has a date and a positive amount, and the amounts add up to the
  // original to the paisa. A sub-paisa float residual is tolerated and snapped exactly on save.
  const splitValid =
    !!splitting &&
    splitting.parts.length >= 2 &&
    splitting.parts.every((p) => p.date && (+p.amount || 0) > 0) &&
    Math.abs(splitDiff) < 0.005;

  const saveSplit = () => {
    if (!splitValid) return;
    const { id, time, payment, customer, mobile, paid, paidMode, total, profit, lines } = splitting;
    // Snap the last part to absorb any sub-paisa residual so the parts sum to EXACTLY total.
    const exceptLast = money(
      splitting.parts.slice(0, -1).reduce((a, p) => a + (+p.amount || 0), 0)
    );
    const parts = splitting.parts.map((p, i, arr) => ({
      ...p,
      amount: i === arr.length - 1 ? money(total - exceptLast) : money(+p.amount || 0),
    }));
    let profAcc = 0,
      paidAcc = 0;
    const newSales = parts.map((p, idx) => {
      const f = +p.amount / total;
      const isLast = idx === parts.length - 1;
      const prof = isLast ? money(profit - profAcc) : money(profit * f);
      profAcc = money(profAcc + prof);
      // Distribute any Udhari part-payment proportionally too (remainder on the last part).
      const partPaid = isLast ? money((+paid || 0) - paidAcc) : money((+paid || 0) * f);
      paidAcc = money(paidAcc + partPaid);
      // Scale each line by the same proportion; nudge the last line so the lines sum to
      // this part's amount exactly (keeps the bill detail and top-items totals consistent).
      let amtAcc = 0;
      const sl = lines.map((l) => {
        const amount = money((+l.amount || 0) * f);
        amtAcc = money(amtAcc + amount);
        return { ...l, qty: Math.round((+l.qty || 0) * f * 1000) / 1000, amount };
      });
      if (sl.length) {
        const d = money(+p.amount - amtAcc);
        if (d)
          sl[sl.length - 1] = { ...sl[sl.length - 1], amount: money(sl[sl.length - 1].amount + d) };
      }
      return {
        id: uid(),
        date: p.date,
        time: `${time || ""} (split ${idx + 1}/${parts.length})`.trim(),
        lines: sl,
        total: money(+p.amount),
        profit: prof,
        payment,
        ...(customer ? { customer } : {}),
        ...(mobile ? { mobile } : {}),
        ...(payment === "Udhari" ? { paid: partPaid } : {}),
        ...(payment === "Udhari" && partPaid > 0 ? { paidMode } : {}),
        splitOf: id,
      };
    });
    setSales((all) => all.flatMap((x) => (x.id === id ? newSales : [x])));
    log(
      "sale",
      `Split bill ${INR(total)} into ${parts.length} part(s) across ${new Set(parts.map((p) => p.date)).size} date(s)`
    );
    setSplitting(null);
    notify(`Bill split into ${parts.length} parts`);
  };

  return (
    <div>
      <Header
        title="Sales History"
        sub={`${visible.length} of ${sales.length} bills · ${INR(rangeTotal)}`}
      />

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
        <input
          className="input"
          style={{ flex: 1, minWidth: 0 }}
          placeholder="🔍 Search bills — item, customer, mobile, amount, payment…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {q && (
          <button className="btn ghost small" onClick={() => setQ("")}>
            Clear search
          </button>
        )}
      </div>

      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          marginBottom: 14,
          flexWrap: "wrap",
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
        {(from || to) && (
          <button
            className="btn ghost small"
            onClick={() => {
              setFrom("");
              setTo("");
            }}
          >
            Clear range
          </button>
        )}
      </div>

      {sales.length === 0 && (
        <section style={S.panel}>
          <Empty text="No sales yet. Bills will appear here after you complete a sale." />
        </section>
      )}
      {sales.length > 0 && visible.length === 0 && (
        <section style={S.panel}>
          <Empty
            text={
              searching
                ? `No bills match “${q.trim()}”${from || to ? " in this date range" : ""}.`
                : "No bills in this date range."
            }
          />
        </section>
      )}
      {byDate.slice(0, dateLimit).map(([date, list]) => {
        const isToday = date === todayStr();
        // Today is always open; every other date collapses (closed by default) so the list scans
        // quickly. While searching, open every matching date so the results are all visible.
        const expanded = isToday || searching || openDates.has(date);
        return (
          <section key={date} style={{ ...S.panel, marginBottom: 14 }}>
            <div
              style={{ ...S.panelHead, ...(isToday ? {} : { cursor: "pointer" }) }}
              onClick={isToday ? undefined : () => toggleDate(date)}
              {...(isToday ? {} : { role: "button", "aria-expanded": expanded })}
            >
              {!isToday && (
                <span style={{ color: "#8A9C90", marginRight: 6 }}>{expanded ? "▾" : "▸"}</span>
              )}
              {new Date(date + "T00:00").toLocaleDateString("en-IN", {
                weekday: "short",
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
              {isToday && (
                <span style={{ fontWeight: 600, color: "#1B5E43", marginLeft: 8 }}>· Today</span>
              )}
              <span style={{ fontWeight: 500, color: "#8A9C90", marginLeft: 8 }}>
                · {list.length} bill{list.length > 1 ? "s" : ""}
              </span>
              <span style={{ marginLeft: "auto", fontWeight: 800 }}>
                {INR(list.reduce((a, s) => a + s.total, 0))}
              </span>
            </div>
            {expanded &&
              (fullDates.has(date) ? list : list.slice(0, BILLS_PER_DATE)).map((s) => (
                <BillRow
                  key={s.id}
                  s={s}
                  isOpen={open === s.id}
                  searching={searching}
                  onToggle={onToggle}
                  onPrint={onPrint}
                  onEdit={onEdit}
                  onSplit={onSplit}
                  onDelete={onDelete}
                />
              ))}
            {expanded && list.length > BILLS_PER_DATE && !fullDates.has(date) && (
              <button
                className="btn small"
                style={{ marginTop: 8 }}
                onClick={() => setFullDates((d) => new Set(d).add(date))}
              >
                Show all {list.length} bills of this day
              </button>
            )}
          </section>
        );
      })}
      {byDate.length > dateLimit && (
        <button
          className="btn"
          style={{ display: "block", margin: "0 auto 14px" }}
          onClick={showMoreDates}
        >
          Show older dates ({byDate.length - dateLimit} more)
        </button>
      )}

      {salesFrom && (
        <section
          style={{ ...S.panel, marginBottom: 14, fontSize: 13, color: "#566", textAlign: "center" }}
        >
          Showing bills since{" "}
          <b>
            {new Date(salesFrom + "T00:00").toLocaleDateString("en-IN", {
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
          </b>{" "}
          (plus all credit bills).
          <div style={{ marginTop: 8, display: "flex", gap: 8, justifyContent: "center" }}>
            <button className="btn" disabled={loadingOlder} onClick={() => loadOlder(olderStep())}>
              {loadingOlder ? "Loading…" : "Load 3 more months"}
            </button>
            <button className="btn" disabled={loadingOlder} onClick={() => loadOlder(null)}>
              Load all bills
            </button>
          </div>
        </section>
      )}

      {editing && (
        <Modal title="Edit bill" onClose={() => setEditing(null)}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Date">
              <input
                type="date"
                className="input"
                max={todayStr()}
                value={editing.date}
                onChange={(e) => setEditing({ ...editing, date: e.target.value })}
              />
            </Field>
            <Field label="Payment">
              <select
                className="input"
                value={editing.payment}
                onChange={(e) => setEditing({ ...editing, payment: e.target.value })}
              >
                {["UPI", "Cash", "Udhari"].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </Field>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>Item</th>
                <th style={{ width: 70 }}>Qty</th>
                <th style={{ textAlign: "right" }}>Amount</th>
                <th style={{ width: 30 }}></th>
              </tr>
            </thead>
            <tbody>
              {editing.lines.map((l, idx) => (
                <tr key={idx}>
                  <td>
                    {l.name}
                    <div style={{ fontSize: 11, color: "#9AA" }}>
                      {INR(l.price)}
                      {lineVariantText(l) ? " · " + lineVariantText(l) : ""}
                    </div>
                  </td>
                  <td>
                    <input
                      className="input"
                      style={{ padding: "6px 8px" }}
                      type="number"
                      inputMode="decimal"
                      min="0"
                      value={l.qty}
                      onChange={(e) => editLine(idx, +e.target.value)}
                    />
                  </td>
                  <td style={{ textAlign: "right", fontWeight: 700 }}>
                    {INR(money(l.price * l.qty))}
                  </td>
                  <td>
                    <button
                      className="btn small danger"
                      aria-label="Remove line"
                      onClick={() => removeLine(idx)}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Field label="Additional discount (₹)">
            <input
              className="input"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              max={editSubtotal}
              placeholder="0"
              value={editing.discount}
              onChange={(e) => setEditing({ ...editing, discount: e.target.value })}
            />
          </Field>
          {editDiscount > 0 && (
            <>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 12.5,
                  color: "#6B7E74",
                }}
              >
                <span>Subtotal</span>
                <span>{INR(editSubtotal)}</span>
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 12.5,
                  color: "#C44536",
                  fontWeight: 600,
                }}
              >
                <span>Discount</span>
                <span>−{INR(editDiscount)}</span>
              </div>
            </>
          )}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontWeight: 800,
              marginTop: 10,
            }}
          >
            <span>New total</span>
            <span>{INR(editTotal)}</span>
          </div>
          {editing.payment === "Udhari" && (
            <div style={{ marginTop: 8 }}>
              <Field label="Amount paid (mark repayments here)">
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    max={editTotal}
                    value={editing.paid}
                    onChange={(e) => setEditing({ ...editing, paid: e.target.value })}
                  />
                  <button
                    className="btn small ghost"
                    onClick={() => setEditing({ ...editing, paid: String(editTotal) })}
                  >
                    Mark fully paid
                  </button>
                </div>
              </Field>
              {+editing.paid > 0 && (
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    alignItems: "center",
                    marginTop: -4,
                    marginBottom: 4,
                  }}
                >
                  <span style={{ fontSize: 11.5, color: "#6B7E74", fontWeight: 600 }}>
                    Paid via
                  </span>
                  {["UPI", "Cash"].map((m) => (
                    <button
                      key={m}
                      className={"btn small " + (editing.paidMode === m ? "primary" : "ghost")}
                      onClick={() => setEditing({ ...editing, paidMode: m })}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}
              <div style={{ fontSize: 12, textAlign: "right", color: "#C44536", fontWeight: 600 }}>
                Outstanding: {INR(Math.max(0, money(editTotal - (+editing.paid || 0))))}
              </div>
            </div>
          )}
          <div style={{ fontSize: 11.5, color: "#6B7E74", marginTop: 4 }}>
            Stock adjusts automatically for any quantity change.
          </div>
          <button
            className="btn primary big"
            style={{ width: "100%", marginTop: 12 }}
            onClick={saveEdit}
          >
            Save changes
          </button>
        </Modal>
      )}

      {splitting && (
        <Modal title="Split bill across dates" onClose={() => setSplitting(null)}>
          <div style={{ fontSize: 12.5, color: "#6B7E74", marginBottom: 10, lineHeight: 1.5 }}>
            Original total <b>{INR(splitting.total)}</b>. Give each part a date and an amount — by
            default it's divided equally, but you can enter your own amounts. The parts must add up
            to exactly the original total. Profit and items are split in the same proportion, so the
            dashboard and finance graphs stay accurate. (Stock isn't affected.)
          </div>
          <div
            style={{
              background: "#F4F7F4",
              borderRadius: 8,
              padding: "8px 12px",
              marginBottom: 10,
            }}
          >
            <div style={{ fontSize: 11.5, fontWeight: 700, color: "#465", marginBottom: 6 }}>
              Split over a date range
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ fontSize: 12, color: "#6B7E74" }}>
                From{" "}
                <input
                  type="date"
                  className="input"
                  style={{ width: "auto", marginLeft: 4 }}
                  max={splitting.rangeTo || todayStr()}
                  value={splitting.rangeFrom}
                  onChange={(e) => setRangeFrom(e.target.value)}
                />
              </label>
              <label style={{ fontSize: 12, color: "#6B7E74" }}>
                To{" "}
                <input
                  type="date"
                  className="input"
                  style={{ width: "auto", marginLeft: 4 }}
                  max={todayStr()}
                  value={splitting.rangeTo}
                  onChange={(e) => setRangeTo(e.target.value)}
                />
              </label>
              <button className="btn small" onClick={applyRange}>
                Fill range
              </button>
            </div>
            <div style={{ fontSize: 11, color: "#8A9C90", marginTop: 6 }}>
              Creates one part per day in the range, divided equally — then edit any amount below.
            </div>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>Date</th>
                <th style={{ textAlign: "right" }}>Amount ₹</th>
                <th style={{ width: 30 }}></th>
              </tr>
            </thead>
            <tbody>
              {splitting.parts.map((p, idx) => (
                <tr key={idx}>
                  <td>
                    <input
                      type="date"
                      className="input"
                      style={{ padding: "6px 8px" }}
                      max={todayStr()}
                      value={p.date}
                      onChange={(e) => setPartDate(idx, e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.01"
                      className="input"
                      style={{ padding: "6px 8px", textAlign: "right" }}
                      value={p.amount}
                      onChange={(e) => setPartAmount(idx, +e.target.value)}
                    />
                  </td>
                  <td>
                    <button
                      className="btn small danger"
                      disabled={splitting.parts.length <= 2}
                      aria-label="Remove part"
                      onClick={() => removePart(idx)}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button className="btn small ghost" onClick={addPart}>
              + Add date
            </button>
            <button className="btn small ghost" onClick={divideEqually}>
              Divide equally
            </button>
            <button
              className="btn small ghost"
              onClick={balanceSplit}
              disabled={Math.abs(splitDiff) < 0.005}
            >
              Balance last row
            </button>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontWeight: 800,
              marginTop: 12,
            }}
          >
            <span>Split total</span>
            <span style={{ color: Math.abs(splitDiff) < 0.005 ? "#1B5E43" : "#C44536" }}>
              {INR(splitSum)} / {INR(splitting.total)}
            </span>
          </div>
          {Math.abs(splitDiff) >= 0.005 && (
            <div style={{ fontSize: 12, color: "#C44536", marginTop: 4 }}>
              Amounts must add up to {INR(splitting.total)} —{" "}
              {splitDiff > 0 ? `${INR(splitDiff)} short` : `${INR(-splitDiff)} over`}. Use “Balance
              last row” to put the rest on the last date.
            </div>
          )}
          <button
            className="btn primary big"
            style={{ width: "100%", marginTop: 12 }}
            disabled={!splitValid}
            onClick={saveSplit}
          >
            Save split · {splitting.parts.length} part(s)
          </button>
        </Modal>
      )}
    </div>
  );
}
