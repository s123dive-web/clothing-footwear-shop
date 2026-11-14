import { useShopConfig } from "../config/shopConfig.js";
import { useState, useRef, useEffect, useMemo } from "react";
import { featureOn } from "../config/features.js";
import { provisionalNo } from "../lib/billNumbers.js";
import { waLink, receiptText } from "../lib/whatsapp.js";
import { useLang } from "../i18n/index.jsx";
import { useDebouncedValue } from "../ui/hooks.js";
import { todayStr, money, uid, INR } from "../lib/format.js";
import { productStock, variantLabel, isProductLow } from "../lib/products.js";
import { iconFor } from "../lib/domain.js";
import { Header, Empty, Modal } from "../ui/index.jsx";
import { S } from "../ui/styles.js";
import { CURRENCY } from "../config/currency.js";
import { printReceipt, preloadReceiptAssets } from "../lib/print.js";

const HELD_KEY = "cfs-held-bills-v1";
const loadHeldBills = () => {
  try {
    const v = JSON.parse(localStorage.getItem(HELD_KEY) || "[]");
    return Array.isArray(v) ? v.filter((b) => b && Array.isArray(b.cart) && b.cart.length) : [];
  } catch {
    return [];
  }
};
const saveHeldBills = (list) => {
  try {
    localStorage.setItem(HELD_KEY, JSON.stringify(list));
  } catch (e) {
    console.error("held bills write failed", e);
  }
};
const heldTotal = (b) => money((b.cart || []).reduce((a, c) => a + c.sellingPrice * c.qty, 0));
const heldLabel = (b) =>
  new Date(b.at || Date.now()).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

// ---------- Billing / POS ----------
export function Billing({ items, sales, recordSale, online, notify, log, goInventory }) {
  const { t } = useLang();
  const config = useShopConfig();
  const [q, setQ] = useState("");
  const [cart, setCart] = useState([]); // [{ key, productId, variantId, name, brand, icon, size, color, sellingPrice, purchasePrice, category, subcategory, qty, misc? }]
  const [lastSale, setLastSale] = useState(null);
  const [saleDate, setSaleDate] = useState(todayStr()); // back-date a bill if needed
  const [pay, setPay] = useState("UPI"); // UPI | Cash | Udhari
  const [customer, setCustomer] = useState("");
  const [mobile, setMobile] = useState("");
  const [paidNow, setPaidNow] = useState(""); // Udhari part-payment taken at billing time
  const [paidMode, setPaidMode] = useState("Cash");
  const [discount, setDiscount] = useState("");
  const [discMode, setDiscMode] = useState("flat"); // "flat" = amount, "%" = percent of subtotal
  const [picker, setPicker] = useState(null); // product whose size/colour variant picker is open
  const [miscName, setMiscName] = useState("");
  const [miscPrice, setMiscPrice] = useState("");
  const [miscBuy, setMiscBuy] = useState("");
  const [custFocus, setCustFocus] = useState(false);
  // Held ("parked") bills: a customer steps away mid-bill → hold it, serve the next one,
  // resume later. Kept on this device (localStorage) so a reload does not lose them. Stock is
  // not reserved while held; it is re-checked when the bill is completed.
  const [held, setHeld] = useState(() => loadHeldBills());
  useEffect(() => saveHeldBills(held), [held]);
  const searchRef = useRef(null);
  useEffect(() => searchRef.current?.focus(), []);
  // Have the receipt's logo and payment QR ready before the first bill is printed.
  useEffect(() => preloadReceiptAssets(config), [config]);
  // Double-tap guard: a cart can be turned into a bill exactly once. `soldCart` remembers the
  // cart array that was just saved, so a second tap that arrives before React has re-rendered
  // the (now empty) cart is ignored; `saving` also disables the button for that moment.
  const soldCart = useRef(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (saving) setSaving(false);
  }, [saving]);

  // Unique past customers (name + most-recent mobile) for the name autocomplete.
  const knownCustomers = useMemo(() => {
    const m = new Map();
    sales.forEach((s) => {
      const name = (s.customer || "").trim();
      if (!name) return;
      const key = name.toLowerCase();
      const e = m.get(key) || { name, mobile: "" };
      e.name = name;
      if ((s.mobile || "").trim()) e.mobile = s.mobile.trim();
      m.set(key, e);
    });
    return [...m.values()];
  }, [sales]);
  const custSuggestions = useMemo(() => {
    const qq = customer.trim().toLowerCase();
    if (!qq) return [];
    return knownCustomers
      .filter((c) => c.name.toLowerCase().includes(qq) && c.name.toLowerCase() !== qq)
      .slice(0, 6);
  }, [customer, knownCustomers]);

  // Units sold / last-sold per product name — for the best-seller ★ and picker ordering.
  const soldQty = useMemo(() => {
    const m = {};
    (sales || []).forEach((s) =>
      (s.lines || []).forEach((l) => {
        m[l.name] = (m[l.name] || 0) + l.qty;
      })
    );
    return m;
  }, [sales]);
  const lastSold = useMemo(() => {
    const m = {};
    (sales || []).forEach((s) =>
      (s.lines || []).forEach((l) => {
        if (!m[l.name] || s.date > m[l.name]) m[l.name] = s.date;
      })
    );
    return m;
  }, [sales]);

  const stockOf = (p) => productStock(p);

  // Product picker results: sellable (any variant in stock) products first, then out-of-stock.
  const findProducts = (query) => {
    const s = query.trim().toLowerCase();
    const matchesText = (i) =>
      i.name.toLowerCase().includes(s) ||
      (i.brand || "").toLowerCase().includes(s) ||
      (i.code || "").toLowerCase().includes(s) ||
      (i.subcategory || "").toLowerCase().includes(s) ||
      (i.category || "").toLowerCase().includes(s);
    const byActivity = (a, b) => {
      const la = lastSold[a.name] || "",
        lb = lastSold[b.name] || "";
      if (la !== lb) return la < lb ? 1 : -1;
      return (soldQty[b.name] || 0) - (soldQty[a.name] || 0);
    };
    const pool = s ? items.filter(matchesText) : items;
    const inStock = pool.filter((i) => stockOf(i) > 0).sort(byActivity);
    const out = pool.filter((i) => stockOf(i) <= 0).sort(byActivity);
    return [...inStock.slice(0, 14), ...out.slice(0, 8)];
  };
  // The grid follows the search box after a short pause; Enter (a barcode scanner types fast
  // and then sends Enter) always searches the text exactly as typed — see onSearchKey.
  const dq = useDebouncedValue(q);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const results = useMemo(() => findProducts(dq), [dq, items, soldQty, lastSold]);

  // Live availability of a variant, minus what's already in the cart for it.
  const variantAvail = (product, variant) => {
    const inCart = cart
      .filter((c) => c.productId === product.id && c.variantId === variant.id)
      .reduce((a, c) => a + c.qty, 0);
    return Math.max(0, (Number(variant.stockQty) || 0) - inCart);
  };

  const openProduct = (product) => {
    const vs = product.variants || [];
    if (stockOf(product) <= 0) return notify(t("Out of stock: {name}", { name: product.name }));
    if (vs.length === 1) return addVariant(product, vs[0]);
    setPicker(product);
  };

  const addVariant = (product, variant) => {
    if ((Number(variant.stockQty) || 0) <= 0)
      return notify(
        t("{name} — {variant} is out of stock", {
          name: product.name,
          variant: variantLabel(variant),
        })
      );
    if (variantAvail(product, variant) <= 0)
      return notify(
        t("Only {n} of {name} ({variant}) in stock", {
          n: variant.stockQty,
          name: product.name,
          variant: variantLabel(variant),
        })
      );
    const key = product.id + "|" + variant.id;
    setCart((c) => {
      const ex = c.find((x) => x.key === key);
      if (ex) return c.map((x) => (x.key === key ? { ...x, qty: x.qty + 1 } : x));
      return [
        ...c,
        {
          key,
          productId: product.id,
          variantId: variant.id,
          name: product.name,
          brand: product.brand || "",
          icon: iconFor(product),
          size: variant.size || "",
          color: variant.color || "",
          sellingPrice: money(product.sellingPrice),
          purchasePrice: money(product.purchasePrice),
          category: product.category,
          subcategory: product.subcategory,
          qty: 1,
        },
      ];
    });
  };

  const setQty = (key, qty) => {
    const line = cart.find((c) => c.key === key);
    let q2 = qty;
    if (line && !line.misc) {
      const p = items.find((i) => i.id === line.productId);
      const v = p?.variants?.find((x) => x.id === line.variantId);
      const stock = Number(v?.stockQty) || 0;
      if (q2 > stock) {
        notify(t("Only {n} in stock", { n: stock }));
        q2 = stock;
      }
    }
    setCart((c) =>
      q2 <= 0
        ? c.filter((x) => x.key !== key)
        : c.map((x) => (x.key === key ? { ...x, qty: q2 } : x))
    );
  };

  const addMisc = () => {
    const price = +miscPrice;
    if (!(price > 0)) return notify(t("Enter a price for the misc item."));
    const buy = +miscBuy;
    if (miscBuy.trim() !== "" && !(buy >= 0))
      return notify(t("Enter a valid buy price (or leave it blank)."));
    const name = miscName.trim() || t("Misc item");
    setCart((c) => [
      ...c,
      {
        key: "misc-" + uid(),
        misc: true,
        name,
        icon: "🧾",
        size: "",
        color: "",
        sellingPrice: money(price),
        purchasePrice: money(buy > 0 ? buy : 0),
        qty: 1,
        category: "",
        subcategory: "Misc",
      },
    ]);
    setMiscName("");
    setMiscPrice("");
    setMiscBuy("");
    notify(t("Added “{name}” · {amount}", { name, amount: INR(money(price)) }));
  };

  const onSearchKey = (e) => {
    if (e.key !== "Enter") return;
    const list = q === dq ? results : findProducts(q);
    if (list.length === 0) return;
    const code = q.trim().toLowerCase();
    const exact = list.find((i) => (i.code || "").toLowerCase() === code && code);
    openProduct(exact || list[0]);
    setQ("");
  };

  const subtotal = money(cart.reduce((a, c) => a + c.sellingPrice * c.qty, 0));
  const grossProfit = money(
    cart.reduce((a, c) => a + (c.sellingPrice - c.purchasePrice) * c.qty, 0)
  );
  const discNum = Math.max(0, +discount || 0);
  const discountAmt =
    discMode === "%"
      ? money((subtotal * Math.min(100, discNum)) / 100)
      : Math.min(subtotal, money(discNum));
  const total = money(subtotal - discountAmt);
  const profit = money(grossProfit - discountAmt);

  const currentBill = () => ({
    id: uid(),
    at: Date.now(),
    cart,
    saleDate,
    pay,
    customer,
    mobile,
    paidNow,
    paidMode,
    discount,
    discMode,
  });
  const loadBill = (b) => {
    setCart(b.cart || []);
    setSaleDate(b.saleDate && b.saleDate <= todayStr() ? b.saleDate : todayStr());
    setPay(b.pay || "UPI");
    setCustomer(b.customer || "");
    setMobile(b.mobile || "");
    setPaidNow(b.paidNow || "");
    setPaidMode(b.paidMode || "Cash");
    setDiscount(b.discount || "");
    setDiscMode(b.discMode || "flat");
  };
  const clearBill = () => {
    setCart([]);
    setQ("");
    setCustomer("");
    setMobile("");
    setPaidNow("");
    setPaidMode("Cash");
    setDiscount("");
  };
  const holdBill = () => {
    if (cart.length === 0) return;
    setHeld((h) => [...h, currentBill()]);
    clearBill();
    searchRef.current?.focus();
    notify(t("Bill held — tap it under “Held bills” to resume"));
  };
  const resumeBill = (b) => {
    // Resuming while another bill is open swaps them: the open one is held, nothing is lost.
    const swap = cart.length > 0 ? currentBill() : null;
    setHeld((h) => [...h.filter((x) => x.id !== b.id), ...(swap ? [swap] : [])]);
    loadBill(b);
    notify(swap ? t("Resumed — the bill you were on is now held") : t("Bill resumed"));
  };
  const dropHeld = (b) => {
    setHeld((h) => h.filter((x) => x.id !== b.id));
    notify(t("Held bill discarded"), {
      action: { label: t("Undo"), run: () => setHeld((h) => [...h, b]) },
    });
  };

  // Quick-pick: the products sold most recently / most often (from the loaded bills), one tap
  // to add. Shown only while the search box is empty.
  const quickPicks = useMemo(() => {
    return items
      .filter((i) => soldQty[i.name] && productStock(i) > 0)
      .sort((a, b) => {
        const la = lastSold[a.name] || "",
          lb = lastSold[b.name] || "";
        if (la !== lb) return la < lb ? 1 : -1;
        return (soldQty[b.name] || 0) - (soldQty[a.name] || 0);
      })
      .slice(0, 8);
  }, [items, soldQty, lastSold]);

  // The bill just made, as it is NOW in the synced list (so it carries its bill number once that
  // has been allocated), falling back to the copy taken at the moment of sale.
  const salesRef = useRef(sales);
  salesRef.current = sales;
  const liveSale = () =>
    (lastSale && salesRef.current.find((x) => x.id === lastSale.id)) || lastSale;
  const lastSaleLive = liveSale();
  const printLast = async () => {
    // Online, the real bill number arrives a moment after the sale — wait for it (briefly)
    // rather than print a provisional one. Offline it prints provisional straight away.
    if (featureOn("billNumbers") && online) {
      for (let i = 0; i < 15 && liveSale()?.billNoProv && !liveSale()?.billNo; i++)
        await new Promise((r) => setTimeout(r, 100));
    }
    printReceipt(liveSale(), config, t);
  };

  const completeSale = () => {
    if (cart.length === 0 || soldCart.current === cart) return;
    // Re-check against the freshest variant stock (another device may have sold since).
    const short = cart
      .filter((c) => !c.misc)
      .map((c) => {
        const p = items.find((i) => i.id === c.productId);
        const v = p?.variants?.find((x) => x.id === c.variantId);
        return { c, stock: Number(v?.stockQty) || 0 };
      })
      .filter(({ c, stock }) => c.qty > stock);
    if (short.length) {
      const { c, stock } = short[0];
      return notify(
        t("Only {n} of {name} ({variant}) left — adjust the bill.", {
          n: stock,
          name: c.name,
          variant: variantLabel(c),
        })
      );
    }
    const now = new Date();
    const backDated = saleDate !== todayStr();
    const sale = {
      id: uid(),
      date: saleDate,
      time:
        now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) +
        (backDated ? " (back-dated)" : ""),
      // Snapshot the cost (buyPrice) onto each line so historical profit stays anchored even if
      // prices change or the product is deleted later. Size/colour/category ride along for reports.
      lines: cart.map((c) => ({
        name: c.name,
        qty: c.qty,
        price: c.sellingPrice,
        buyPrice: c.purchasePrice,
        amount: money(c.sellingPrice * c.qty),
        size: c.size || "",
        color: c.color || "",
        category: c.category || "",
        subcategory: c.subcategory || "",
        ...(c.misc ? { misc: true } : { productId: c.productId, variantId: c.variantId }),
      })),
      total,
      profit,
      ...(discountAmt > 0
        ? {
            subtotal,
            discount: discountAmt,
            ...(discMode === "%" ? { discountPct: money(discNum) } : {}),
          }
        : {}),
      payment: pay,
      ...(customer.trim() ? { customer: customer.trim() } : {}),
      ...(mobile.trim() ? { mobile: mobile.trim() } : {}),
      ...(pay === "Udhari" ? { paid: Math.min(total, Math.max(0, money(+paidNow || 0))) } : {}),
      ...(pay === "Udhari" && +paidNow > 0 ? { paidMode } : {}),
      // Feature "billNumbers": provisional now, the sequential number arrives once online.
      ...(featureOn("billNumbers")
        ? { billNoProv: provisionalNo(now.getTime()), createdAt: now.getTime() }
        : {}),
    };
    // One outbox op = the bill + its stock decrement. It is recorded on this device at once and
    // delivered (and retried / replayed) in the background, so the counter never waits on the
    // network — online or offline.
    soldCart.current = cart;
    setSaving(true);
    recordSale(sale);
    setLastSale(sale);
    log(
      "sale",
      `Bill ${INR(total)} · ${cart.length} item(s) · ${pay}` +
        (discountAmt > 0 ? ` · disc ${INR(discountAmt)}` : "") +
        (customer.trim() ? ` (${customer.trim()})` : "") +
        (backDated ? ` · back-dated to ${saleDate}` : "")
    );
    clearBill();
    searchRef.current?.focus();
    notify(
      online
        ? t("Bill saved ({pay}) — {amount}", { pay, amount: INR(total) })
        : t("Saved on this device ({pay}) — {amount} · will sync when online", {
            pay,
            amount: INR(total),
          })
    );
  };

  return (
    <div>
      <Header title="Billing" sub="Tap a product, pick size & colour, add to the bill">
        <label
          style={{
            fontSize: 12,
            color: saleDate === todayStr() ? "#556A5F" : "#C44536",
            fontWeight: 600,
          }}
        >
          {t("Bill date")}{" "}
          <input
            type="date"
            className="input"
            style={{ width: "auto", marginLeft: 4 }}
            value={saleDate}
            max={todayStr()}
            onChange={(e) => setSaleDate(e.target.value || todayStr())}
          />
        </label>
      </Header>

      <div
        className="billing-grid"
        style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}
      >
        {/* product picker */}
        <section style={S.panel}>
          <input
            ref={searchRef}
            className="input"
            aria-label="Search name / brand / code"
            placeholder={t("Search name / brand / code… (Enter opens top match)")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onSearchKey}
            aria-label="Search products or scan barcode"
            style={{ marginBottom: 12 }}
          />
          <div
            style={{
              display: "flex",
              gap: 6,
              alignItems: "center",
              marginBottom: 12,
              padding: "8px 10px",
              background: "#F7F2F4",
              borderRadius: 8,
            }}
          >
            <span
              style={{ fontSize: 11.5, fontWeight: 700, color: "#8E2C48", whiteSpace: "nowrap" }}
            >
              🧾 {t("Misc")}
            </span>
            <input
              className="input"
              style={{ flex: 1, minWidth: 0 }}
              aria-label="Name (optional)"
              placeholder={t("Name (optional)")}
              value={miscName}
              onChange={(e) => setMiscName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addMisc();
              }}
              aria-label="Misc item name"
            />
            <input
              className="input"
              style={{ width: 78 }}
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              aria-label="buy"
              placeholder={t("buy")}
              value={miscBuy}
              onChange={(e) => setMiscBuy(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addMisc();
              }}
              aria-label="Misc buy price (optional)"
              title="Buy / cost price (optional) — used for profit"
            />
            <input
              className="input"
              style={{ width: 86 }}
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              aria-label="sell"
              placeholder={t("sell")}
              value={miscPrice}
              onChange={(e) => setMiscPrice(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addMisc();
              }}
              aria-label="Misc sell price"
            />
            <button className="btn" onClick={addMisc}>
              {t("+ Add")}
            </button>
          </div>
          {!q.trim() && quickPicks.length > 0 && (
            <div className="quick-row" aria-label="Recent and best sellers">
              {quickPicks.map((i) => (
                <button key={i.id} className="quick" onClick={() => openProduct(i)}>
                  <span style={{ color: "#8A5A00" }}>★</span> {i.name}
                  <span style={{ color: "#6A5560", fontWeight: 600 }}>
                    {" "}
                    · {INR(i.sellingPrice)}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div
            className="pick-grid"
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}
          >
            {results.length === 0 && (
              <Empty text={q ? "No products match." : "No products yet — add some in Inventory."}>
                {q ? (
                  <button className="btn" onClick={() => setQ("")}>
                    {t("Clear search")}
                  </button>
                ) : (
                  goInventory && (
                    <button className="btn primary" onClick={goInventory}>
                      {t("Open Inventory")}
                    </button>
                  )
                )}
              </Empty>
            )}
            {results.map((i) => {
              const st = stockOf(i);
              const inStock = st > 0;
              const low = isProductLow(i);
              return (
                <div
                  key={i.id}
                  className="pick"
                  style={{
                    cursor: inStock ? "pointer" : "default",
                    background: inStock ? undefined : "#F2F0F1",
                    opacity: inStock ? 1 : 0.7,
                  }}
                  onClick={inStock ? () => openProduct(i) : undefined}
                >
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>
                    <span style={{ marginRight: 5 }}>{iconFor(i)}</span>
                    {i.name}
                    {soldQty[i.name] ? (
                      <span
                        style={{ color: "#8A5A00", fontSize: 11, marginLeft: 4 }}
                        title="best-seller"
                      >
                        ★
                      </span>
                    ) : null}
                  </div>
                  <div style={{ fontSize: 11, color: "#5F6B6B", marginTop: 1 }}>
                    {[i.brand, i.subcategory].filter(Boolean).join(" · ")}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginTop: 4,
                      fontSize: 12.5,
                    }}
                  >
                    <span style={{ color: "#8E2C48", fontWeight: 800 }}>{INR(i.sellingPrice)}</span>
                    <span
                      style={{
                        color: !inStock || low ? "#C44536" : "#586878",
                        fontWeight: !inStock ? 600 : 400,
                      }}
                    >
                      {!inStock ? t("Out of stock") : t("{n} in stock", { n: st })}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* cart / bill */}
        <section style={S.panel}>
          <div style={{ ...S.panelHead, display: "flex", alignItems: "center", gap: 8 }}>
            {t("Current bill")}
            <button
              className="btn tap"
              style={{ marginLeft: "auto" }}
              disabled={cart.length === 0}
              onClick={holdBill}
            >
              {t("⏸ Hold")}
            </button>
          </div>
          {held.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: "#6A5560", marginBottom: 4 }}>
                {t("Held bills ({n})", { n: held.length })}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {held.map((b) => (
                  <span key={b.id} className="held">
                    <button className="held-main" onClick={() => resumeBill(b)}>
                      ▶ {b.customer?.trim() || heldLabel(b)} · {INR(heldTotal(b))}
                    </button>
                    <button
                      className="held-x"
                      aria-label={"Discard held bill " + (b.customer?.trim() || heldLabel(b))}
                      onClick={() => dropHeld(b)}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
          {cart.length === 0 ? (
            <Empty text="No items yet. Tap a product to begin." />
          ) : (
            <div style={{ marginBottom: 10 }}>
              {cart.map((c) => (
                <div
                  key={c.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "7px 0",
                    borderBottom: "1px dotted #E7DDE2",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {c.icon} {c.name}
                    </div>
                    <div style={{ fontSize: 11, color: "#5F6B6B" }}>
                      {[variantLabel(c) !== "—" ? variantLabel(c) : "", INR(c.sellingPrice)]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  <div className="stepper">
                    <button
                      className="step"
                      aria-label={"One less " + c.name}
                      onClick={() => setQty(c.key, c.qty - 1)}
                    >
                      −
                    </button>
                    <input
                      className="input"
                      style={{ width: 48, padding: "5px 4px", textAlign: "center" }}
                      type="number"
                      inputMode="numeric"
                      min="0"
                      value={c.qty}
                      onChange={(e) => setQty(c.key, Math.floor(+e.target.value || 0))}
                      aria-label={"Quantity for " + c.name}
                    />
                    <button
                      className="step"
                      aria-label={"One more " + c.name}
                      onClick={() => setQty(c.key, c.qty + 1)}
                    >
                      +
                    </button>
                  </div>
                  <div style={{ width: 68, textAlign: "right", fontWeight: 700, fontSize: 13 }}>
                    {INR(c.sellingPrice * c.qty)}
                  </div>
                  <button
                    className="btn ghost tap"
                    aria-label={"Remove " + c.name}
                    onClick={() => setQty(c.key, 0)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* discount */}
          <div style={{ display: "flex", gap: 6, alignItems: "center", margin: "8px 0" }}>
            <span style={{ fontSize: 12, color: "#465", fontWeight: 600 }}>{t("Discount")}</span>
            <input
              className="input"
              style={{ width: 80, padding: "6px 8px" }}
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              aria-label="0"
              placeholder="0"
              value={discount}
              onChange={(e) => setDiscount(e.target.value)}
              aria-label="Discount amount"
            />
            <div
              style={{
                display: "flex",
                border: "1.5px solid #D5D0D2",
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
              <button
                className={"seg" + (discMode === "flat" ? " on" : "")}
                onClick={() => setDiscMode("flat")}
              >
                {CURRENCY.symbol}
              </button>
              <button
                className={"seg" + (discMode === "%" ? " on" : "")}
                onClick={() => setDiscMode("%")}
              >
                %
              </button>
            </div>
            {discountAmt > 0 && (
              <span style={{ fontSize: 12, color: "#C44536", marginLeft: "auto" }}>
                − {INR(discountAmt)}
              </span>
            )}
          </div>

          {/* totals */}
          <div style={{ borderTop: "2px dashed #E1D4DA", paddingTop: 10, marginTop: 4 }}>
            {discountAmt > 0 && (
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 13,
                  color: "#586878",
                }}
              >
                <span>{t("Subtotal")}</span>
                <span>{INR(subtotal)}</span>
              </div>
            )}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontWeight: 800,
                fontSize: 20,
                margin: "4px 0",
              }}
            >
              <span>{t("Total")}</span>
              <span>{INR(total)}</span>
            </div>
          </div>

          {/* payment */}
          <div style={{ display: "flex", gap: 6, margin: "10px 0" }}>
            {["UPI", "Cash", "Udhari"].map((p) => (
              <button
                key={p}
                className={"seg wide" + (pay === p ? " on" : "")}
                onClick={() => setPay(p)}
              >
                {t(p)}
              </button>
            ))}
          </div>

          {/* customer (optional; required-ish for Udhari) */}
          <div style={{ position: "relative", marginBottom: 8 }}>
            <input
              className="input"
              placeholder={
                pay === "Udhari"
                  ? t("Customer name (for the credit book)")
                  : t("Customer name (optional)")
              }
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
              onFocus={() => setCustFocus(true)}
              onBlur={() => setTimeout(() => setCustFocus(false), 150)}
              aria-label="Customer name"
            />
            {custFocus && custSuggestions.length > 0 && (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  right: 0,
                  background: "#fff",
                  border: "1px solid #E3E9E5",
                  borderRadius: 8,
                  zIndex: 5,
                  boxShadow: "0 6px 18px rgba(0,0,0,.1)",
                }}
              >
                {custSuggestions.map((c) => (
                  <div
                    key={c.name}
                    style={{ padding: "8px 10px", fontSize: 13, cursor: "pointer" }}
                    onMouseDown={() => {
                      setCustomer(c.name);
                      if (c.mobile) setMobile(c.mobile);
                    }}
                  >
                    {c.name}
                    {c.mobile ? <span style={{ color: "#5F6B6B" }}> · {c.mobile}</span> : ""}
                  </div>
                ))}
              </div>
            )}
          </div>
          <input
            className="input"
            style={{ marginBottom: 8 }}
            aria-label="Mobile (optional)"
            placeholder={t("Mobile (optional)")}
            value={mobile}
            onChange={(e) => setMobile(e.target.value)}
            aria-label="Customer mobile"
          />

          {pay === "Udhari" && (
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
              <input
                className="input"
                style={{ flex: 1 }}
                type="number"
                inputMode="decimal"
                min="0"
                aria-label="Paid now (optional)"
                placeholder={t("Paid now (optional)")}
                value={paidNow}
                onChange={(e) => setPaidNow(e.target.value)}
                aria-label="Amount paid now"
              />
              <div
                style={{
                  display: "flex",
                  border: "1.5px solid #D5D0D2",
                  borderRadius: 8,
                  overflow: "hidden",
                }}
              >
                {["Cash", "UPI"].map((m) => (
                  <button
                    key={m}
                    className={"seg" + (paidMode === m ? " on" : "")}
                    onClick={() => setPaidMode(m)}
                  >
                    {t(m)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* On a phone this bar is pinned to the bottom of the screen (see .bill-bar in CSS), so
              the total and the Complete button are always reachable without scrolling. */}
          <div className="bill-bar">
            <div className="bill-bar-total">
              <span style={{ fontSize: 11.5, color: "#556A5F" }}>
                {t("{n} items", { n: cart.reduce((a, c) => a + c.qty, 0) })} · {t(pay)}
              </span>
              <b style={{ fontSize: 19 }}>{INR(total)}</b>
            </div>
            <button
              className="btn primary big"
              style={{ width: "100%" }}
              disabled={cart.length === 0 || saving}
              onClick={completeSale}
            >
              {t("Complete sale · {amount}", { amount: INR(total) })}
            </button>
          </div>
          <div className="bill-bar-spacer" />
          {lastSale && (
            <button className="btn" style={{ width: "100%", marginTop: 8 }} onClick={printLast}>
              {t("🧾 Print last receipt")}
            </button>
          )}
          {lastSale && featureOn("whatsappReceipt") && (
            <a
              className="btn wa"
              style={{ width: "100%", marginTop: 8 }}
              href={waLink(
                lastSaleLive.mobile,
                receiptText(lastSaleLive, config, { t, money: INR })
              )}
              target="_blank"
              rel="noopener noreferrer"
            >
              🟢 {t("Send on WhatsApp")}
            </a>
          )}
        </section>
      </div>

      {/* variant picker modal */}
      {picker && (
        <Modal
          title={t("{name} — pick size & colour", { name: picker.name })}
          onClose={() => setPicker(null)}
        >
          <div style={{ fontSize: 12.5, color: "#5C6E63", marginBottom: 10 }}>
            {[picker.brand, picker.subcategory].filter(Boolean).join(" · ")} ·{" "}
            {INR(picker.sellingPrice)}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
              gap: 8,
            }}
          >
            {(picker.variants || []).map((v) => {
              const avail = variantAvail(picker, v);
              const can = avail > 0;
              return (
                <button
                  key={v.id}
                  disabled={!can}
                  onClick={() => {
                    addVariant(picker, v);
                  }}
                  style={{
                    textAlign: "left",
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: "1.5px solid " + (can ? "#D9C7CF" : "#EEE"),
                    background: can ? "#fff" : "#F5F3F4",
                    cursor: can ? "pointer" : "not-allowed",
                    opacity: can ? 1 : 0.6,
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>{variantLabel(v)}</div>
                  <div style={{ fontSize: 11.5, color: can ? "#2E7D5B" : "#C44536", marginTop: 2 }}>
                    {can ? t("{n} available", { n: avail }) : t("Out of stock")}
                  </div>
                </button>
              );
            })}
          </div>
          <div style={{ marginTop: 12, textAlign: "right" }}>
            <button className="btn primary" onClick={() => setPicker(null)}>
              {t("Done")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
