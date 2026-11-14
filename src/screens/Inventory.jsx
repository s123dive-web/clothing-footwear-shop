import {
  ALL_SUBCATEGORIES,
  SUBCATEGORIES_BY_GROUP,
  GROUPS,
  guessSubcategory,
  groupForSubcategory,
  sizesForProduct,
  COLOR_SWATCHES,
} from "../lib/catalog.js";
import { useShopConfig } from "../config/shopConfig.js";
import { useState, useMemo, useRef } from "react";
import { normName, iconFor } from "../lib/domain.js";
import {
  cloudWriteProduct,
  cloudDeleteProduct,
  cloudRestockVariant,
} from "../lib/cloudProducts.js";
import { Header, Empty, VariantChip, Modal, ColorDot, Field } from "../ui/index.jsx";
import {
  blankProduct,
  productStock,
  isProductLow,
  variantLabel,
  blankVariant,
} from "../lib/products.js";
import { S } from "../ui/styles.js";
import { INR } from "../lib/format.js";

export function Inventory({ items, notify, log, cats = ALL_SUBCATEGORIES, onAddCategory }) {
  const config = useShopConfig();
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("All"); // All | Clothing | Footwear | Accessories
  const [sub, setSub] = useState("All");
  const [form, setForm] = useState(null); // product form object, or null
  const [restock, setRestock] = useState(null); // product being restocked, or null

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return items
      .filter((i) => {
        if (group !== "All" && (i.category || "") !== group) return false;
        if (sub !== "All" && (i.subcategory || "") !== sub) return false;
        if (!s) return true;
        return (
          i.name.toLowerCase().includes(s) ||
          (i.brand || "").toLowerCase().includes(s) ||
          (i.code || "").toLowerCase().includes(s) ||
          (i.subcategory || "").toLowerCase().includes(s)
        );
      })
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }, [items, q, group, sub]);

  const subOptions = useMemo(
    () => (group === "All" ? cats : SUBCATEGORIES_BY_GROUP[group] || []),
    [group, cats]
  );

  const save = async (product) => {
    const dup = items.find(
      (i) =>
        i.id !== product.id &&
        normName(i.name) === normName(product.name) &&
        (i.subcategory || "") === (product.subcategory || "")
    );
    if (
      dup &&
      !confirm(
        `A "${product.name}" already exists in ${product.subcategory}. Save anyway as a separate product?`
      )
    )
      return;
    try {
      await cloudWriteProduct(product);
      log(
        "inventory",
        `${product.id && items.some((i) => i.id === product.id) ? "Edited" : "Added"} “${product.name}” (${(product.variants || []).length} variant${(product.variants || []).length === 1 ? "" : "s"})`
      );
      notify(items.some((i) => i.id === product.id) ? "Product updated" : "Product added");
      setForm(null);
    } catch (e) {
      console.error("save product failed", e);
      notify("⚠ Couldn't save the product.");
    }
  };

  const del = async (product) => {
    if (!confirm(`Delete “${product.name}” and all its variants? This can't be undone.`)) return;
    try {
      await cloudDeleteProduct(product.id);
      log("inventory", `Deleted “${product.name}”`);
      notify("Product deleted");
    } catch (e) {
      console.error("delete failed", e);
      notify("⚠ Couldn't delete the product.");
    }
  };

  const doRestock = async (product, variantId, qty) => {
    const n = Number(qty) || 0;
    if (!(n > 0)) return notify("Enter a quantity to add.");
    try {
      await cloudRestockVariant(product.id, variantId, n);
      log("inventory", `Restocked “${product.name}” +${n}`);
      notify(`Added ${n} to ${product.name}`);
    } catch (e) {
      console.error("restock failed", e);
      notify("⚠ Couldn't restock.");
    }
  };

  return (
    <div>
      <Header
        title="Inventory"
        sub={`${items.length} product${items.length === 1 ? "" : "s"} · tap a product to edit its variants`}
      >
        <button className="btn primary" onClick={() => setForm(blankProduct())}>
          + Add product
        </button>
      </Header>

      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
          marginBottom: 14,
        }}
      >
        <input
          className="input"
          style={{ flex: "1 1 220px", minWidth: 0 }}
          placeholder="Search name / brand / code…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div
          style={{
            display: "flex",
            border: "1.5px solid #E1D4DA",
            borderRadius: 9,
            overflow: "hidden",
          }}
        >
          {["All", ...GROUPS].map((g) => (
            <button
              key={g}
              className={"seg" + (group === g ? " on" : "")}
              onClick={() => {
                setGroup(g);
                setSub("All");
              }}
            >
              {g}
            </button>
          ))}
        </div>
        <select
          className="input"
          style={{ width: "auto" }}
          value={sub}
          onChange={(e) => setSub(e.target.value)}
        >
          <option value="All">All subcategories</option>
          {subOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <Empty text={items.length === 0 ? "No products yet." : "No products match this filter."}>
          <button className="btn primary" onClick={() => setForm(blankProduct())}>
            + Add your first product
          </button>
        </Empty>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {filtered.map((i) => {
            const st = productStock(i);
            const low = isProductLow(i);
            return (
              <section
                key={i.id}
                style={{ ...S.panel, padding: 14, borderColor: low ? "#F0CDD6" : "#E2EAE3" }}
              >
                <div
                  style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}
                >
                  <div style={{ fontSize: 26, lineHeight: 1 }}>
                    {i.imageUrl ? (
                      <img
                        src={i.imageUrl}
                        alt=""
                        style={{ width: 40, height: 40, borderRadius: 8, objectFit: "cover" }}
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                        }}
                      />
                    ) : (
                      iconFor(i)
                    )}
                  </div>
                  <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                    <div style={{ fontWeight: 800, fontSize: 15 }}>
                      {i.name} {low && <span style={S.badgeInline}>low</span>}
                    </div>
                    <div style={{ fontSize: 12, color: "#8A9C90", marginTop: 1 }}>
                      {[i.brand, i.category, i.subcategory].filter(Boolean).join(" · ")}
                      {i.code ? ` · #${i.code}` : ""}
                    </div>
                    <div style={{ marginTop: 8 }}>
                      {(i.variants || []).length === 0 ? (
                        <span style={{ fontSize: 12, color: "#B0324C" }}>
                          No variants — edit to add sizes/colours
                        </span>
                      ) : (
                        (i.variants || []).map((v) => <VariantChip key={v.id} v={v} />)
                      )}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", minWidth: 110 }}>
                    <div style={{ fontWeight: 800, color: "#8E2C48", fontSize: 15 }}>
                      {INR(i.sellingPrice)}
                    </div>
                    {Number(i.mrp) > Number(i.sellingPrice) && (
                      <div
                        style={{ fontSize: 11.5, color: "#9AA", textDecoration: "line-through" }}
                      >
                        MRP {INR(i.mrp)}
                      </div>
                    )}
                    <div style={{ fontSize: 12, color: low ? "#C44536" : "#556", marginTop: 2 }}>
                      {st} in stock
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        marginTop: 8,
                        justifyContent: "flex-end",
                        flexWrap: "wrap",
                      }}
                    >
                      <button className="btn small" onClick={() => setRestock(i)}>
                        Restock
                      </button>
                      <button className="btn small" onClick={() => setForm(toFormShape(i))}>
                        Edit
                      </button>
                      <button className="btn small ghost" onClick={() => del(i)}>
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}

      {form && (
        <ProductForm
          initial={form}
          cats={cats}
          config={config}
          onAddCategory={onAddCategory}
          onSave={save}
          onClose={() => setForm(null)}
          isEdit={items.some((i) => i.id === form.id)}
        />
      )}
      {restock && (
        <RestockModal product={restock} onRestock={doRestock} onClose={() => setRestock(null)} />
      )}
    </div>
  );
}

// Map a stored product into the editable form shape (numeric strings so inputs can be cleared).
export function toFormShape(p) {
  return {
    id: p.id,
    name: p.name || "",
    brand: p.brand || "",
    category: p.category || "Clothing",
    subcategory: p.subcategory || "",
    code: p.code || "",
    purchasePrice: p.purchasePrice ?? "",
    sellingPrice: p.sellingPrice ?? "",
    mrp: p.mrp ?? "",
    discountPct: p.discountPct ?? "",
    supplier: p.supplier || "",
    imageUrl: p.imageUrl || "",
    notes: p.notes || "",
    variants: (p.variants || []).map((v) => ({ ...v })),
    createdAt: p.createdAt,
    version: p.version,
  };
}

// Restock modal: add stock to any variant of a product.
export function RestockModal({ product, onRestock, onClose }) {
  const [qty, setQty] = useState({}); // variantId -> string
  return (
    <Modal title={`Restock — ${product.name}`} onClose={onClose}>
      {(product.variants || []).length === 0 ? (
        <Empty text="This product has no variants yet. Edit it to add sizes/colours first." />
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {(product.variants || []).map((v) => (
            <div key={v.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <ColorDot color={v.color} />
                {variantLabel(v)}{" "}
                <span style={{ color: "#9AA", fontSize: 12 }}>· {Number(v.stockQty) || 0} now</span>
              </div>
              <input
                className="input"
                style={{ width: 90 }}
                type="number"
                min="1"
                placeholder="+ qty"
                value={qty[v.id] || ""}
                onChange={(e) => setQty((s) => ({ ...s, [v.id]: e.target.value }))}
              />
              <button
                className="btn small primary"
                onClick={async () => {
                  await onRestock(product, v.id, qty[v.id]);
                  setQty((s) => ({ ...s, [v.id]: "" }));
                }}
              >
                Add
              </button>
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 14, textAlign: "right" }}>
        <button className="btn" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}

// Add / edit a product, including its size/colour variant matrix.
export function ProductForm({ initial, cats, config, onAddCategory, onSave, onClose, isEdit }) {
  const [f, setF] = useState(initial);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const touchedSub = useRef(isEdit); // don't auto-guess subcategory once the user picks one

  // Auto-guess subcategory + group from the typed name (until the user picks one).
  const onName = (e) => {
    const name = e.target.value;
    setF((s) => {
      const next = { ...s, name };
      if (!touchedSub.current) {
        const guess = guessSubcategory(name);
        if (guess) {
          next.subcategory = guess;
          next.category = groupForSubcategory(guess);
        }
      }
      return next;
    });
  };

  const subList = useMemo(() => {
    const base = SUBCATEGORIES_BY_GROUP[f.category] || [];
    const extra = cats.filter((c) => !base.includes(c) && !ALL_SUBCATEGORIES.includes(c)); // custom ones
    return [...base, ...extra];
  }, [f.category, cats]);
  const sizeOptions = useMemo(
    () => sizesForProduct({ category: f.category, subcategory: f.subcategory }, config),
    [f.category, f.subcategory, config]
  );

  // ---- variant rows ----
  const setVar = (id, k, v) =>
    setF((s) => ({ ...s, variants: s.variants.map((x) => (x.id === id ? { ...x, [k]: v } : x)) }));
  const addVarRow = () => setF((s) => ({ ...s, variants: [...s.variants, blankVariant()] }));
  const removeVar = (id) =>
    setF((s) => ({ ...s, variants: s.variants.filter((x) => x.id !== id) }));

  // Bulk generator: pick sizes × colours → add any missing variant rows.
  const [genSizes, setGenSizes] = useState([]);
  const [genColors, setGenColors] = useState([]);
  const [genColorText, setGenColorText] = useState("");
  const toggle = (arr, set, val) =>
    set(arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val]);
  const generate = () => {
    const colors = [
      ...genColors,
      ...genColorText
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean),
    ];
    const sizes = genSizes.length ? genSizes : [""];
    const cols = colors.length ? colors : [""];
    setF((s) => {
      const have = new Set(s.variants.map((v) => (v.size + "|" + v.color).toLowerCase()));
      const add = [];
      for (const color of cols)
        for (const size of sizes) {
          const key = (size + "|" + color).toLowerCase();
          if (!have.has(key)) {
            have.add(key);
            add.push(blankVariant({ size, color }));
          }
        }
      // Drop an empty starter row if we're adding real variants.
      const base = s.variants.filter((v) => v.size || v.color || Number(v.stockQty) > 0);
      return { ...s, variants: [...base, ...add] };
    });
    setGenSizes([]);
    setGenColors([]);
    setGenColorText("");
  };

  const submit = () => {
    if (!f.name.trim()) return alert("Product name is required.");
    if (!(Number(f.sellingPrice) > 0)) return alert("Enter a selling price greater than 0.");
    const variants = (f.variants || []).filter((v) => v.size || v.color || Number(v.stockQty) > 0);
    if (variants.length === 0) return alert("Add at least one size/colour variant.");
    onSave({
      ...f,
      name: f.name.trim(),
      brand: f.brand.trim(),
      category: f.category,
      subcategory: f.subcategory || (SUBCATEGORIES_BY_GROUP[f.category] || [])[0] || "Other",
      code: (f.code || "").trim(),
      purchasePrice: Number(f.purchasePrice) || 0,
      sellingPrice: Number(f.sellingPrice) || 0,
      mrp: Number(f.mrp) || Number(f.sellingPrice) || 0,
      discountPct: Number(f.discountPct) || 0,
      supplier: (f.supplier || "").trim(),
      imageUrl: (f.imageUrl || "").trim(),
      notes: (f.notes || "").trim(),
      variants: variants.map((v) => ({
        id: v.id,
        size: String(v.size || "").trim(),
        color: String(v.color || "").trim(),
        sku: String(v.sku || "").trim(),
        stockQty: Math.max(0, Number(v.stockQty) || 0),
        lowAt: Math.max(0, Number(v.lowAt) || 0),
      })),
    });
  };

  return (
    <Modal title={isEdit ? "Edit product" : "Add product"} onClose={onClose}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div style={{ gridColumn: "1 / -1" }}>
          <Field label="Product name *">
            <input
              className="input"
              value={f.name}
              onChange={onName}
              autoFocus
              placeholder="e.g. Cotton Printed Kurti"
            />
          </Field>
        </div>
        <Field label="Brand">
          <input
            className="input"
            value={f.brand}
            onChange={set("brand")}
            placeholder="e.g. Biba"
          />
        </Field>
        <Field label="SKU / item code">
          <input className="input" value={f.code} onChange={set("code")} placeholder="Optional" />
        </Field>
        <Field label="Group">
          <select
            className="input"
            value={f.category}
            onChange={(e) => {
              const g = e.target.value;
              setF((s) => ({
                ...s,
                category: g,
                subcategory: (SUBCATEGORIES_BY_GROUP[g] || [])[0] || s.subcategory,
              }));
            }}
          >
            {GROUPS.map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        </Field>
        <Field label="Subcategory">
          <div style={{ display: "flex", gap: 6 }}>
            <select
              className="input"
              value={f.subcategory}
              onChange={(e) => {
                touchedSub.current = true;
                if (e.target.value === "__add") {
                  const nm = onAddCategory && onAddCategory();
                  if (nm) setF((s) => ({ ...s, subcategory: nm }));
                } else set("subcategory")(e);
              }}
            >
              {!subList.includes(f.subcategory) && f.subcategory ? (
                <option value={f.subcategory}>{f.subcategory}</option>
              ) : null}
              {subList.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              {onAddCategory && <option value="__add">+ Add subcategory…</option>}
            </select>
          </div>
        </Field>
        <Field label="Purchase price">
          <input
            className="input"
            type="number"
            min="0"
            step="0.01"
            value={f.purchasePrice}
            onChange={set("purchasePrice")}
            placeholder="cost"
          />
        </Field>
        <Field label="Selling price *">
          <input
            className="input"
            type="number"
            min="0"
            step="0.01"
            value={f.sellingPrice}
            onChange={set("sellingPrice")}
          />
        </Field>
        <Field label="MRP">
          <input
            className="input"
            type="number"
            min="0"
            step="0.01"
            value={f.mrp}
            onChange={set("mrp")}
          />
        </Field>
        <Field label="Discount %">
          <input
            className="input"
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={f.discountPct}
            onChange={set("discountPct")}
            placeholder="0"
          />
        </Field>
        <Field label="Supplier">
          <input
            className="input"
            value={f.supplier}
            onChange={set("supplier")}
            placeholder="Optional"
          />
        </Field>
        <div style={{ gridColumn: "1 / -1" }}>
          <Field label="Image URL (optional)">
            <input
              className="input"
              value={f.imageUrl}
              onChange={set("imageUrl")}
              placeholder="https://…"
            />
          </Field>
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <Field label="Notes">
            <input
              className="input"
              value={f.notes}
              onChange={set("notes")}
              placeholder="Optional"
            />
          </Field>
        </div>
      </div>

      {/* variant generator */}
      <div style={{ background: "#F7F2F4", borderRadius: 10, padding: 12, margin: "12px 0" }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: "#8E2C48", marginBottom: 6 }}>
          Quick-add variants (size × colour)
        </div>
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 11, color: "#889", marginBottom: 3 }}>Sizes</div>
          {sizeOptions.map((sz) => (
            <button
              key={sz}
              className={"chipbtn" + (genSizes.includes(sz) ? " on" : "")}
              onClick={() => toggle(genSizes, setGenSizes, sz)}
            >
              {sz}
            </button>
          ))}
        </div>
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 11, color: "#889", marginBottom: 3 }}>Colours</div>
          {COLOR_SWATCHES.slice(0, 12).map((c) => (
            <button
              key={c.name}
              className={"chipbtn" + (genColors.includes(c.name) ? " on" : "")}
              onClick={() => toggle(genColors, setGenColors, c.name)}
            >
              <ColorDot color={c.name} />
              {c.name}
            </button>
          ))}
          <input
            className="input"
            style={{ width: 160, marginTop: 6, display: "inline-block" }}
            placeholder="Other colours, comma-sep"
            value={genColorText}
            onChange={(e) => setGenColorText(e.target.value)}
          />
        </div>
        <button className="btn small primary" onClick={generate}>
          Generate variants
        </button>
      </div>

      {/* variant rows */}
      <div style={{ fontSize: 12.5, fontWeight: 700, color: "#465", margin: "6px 0" }}>
        Variants ({f.variants.length})
      </div>
      <div
        style={{ maxHeight: 220, overflow: "auto", border: "1px solid #EEE6EA", borderRadius: 8 }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: "#FAF6F8", textAlign: "left", color: "#889" }}>
              <th style={{ padding: "6px 8px" }}>Size</th>
              <th style={{ padding: "6px 8px" }}>Colour</th>
              <th style={{ padding: "6px 8px" }}>Stock</th>
              <th style={{ padding: "6px 8px" }}>Low at</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {f.variants.map((v) => (
              <tr key={v.id} style={{ borderTop: "1px solid #F0EAEE" }}>
                <td style={{ padding: "4px 8px" }}>
                  <input
                    className="input"
                    style={{ padding: "5px 7px", width: 78 }}
                    list={"sizes-" + f.category}
                    value={v.size}
                    onChange={(e) => setVar(v.id, "size", e.target.value)}
                  />
                </td>
                <td style={{ padding: "4px 8px" }}>
                  <input
                    className="input"
                    style={{ padding: "5px 7px", width: 96 }}
                    list="color-list"
                    value={v.color}
                    onChange={(e) => setVar(v.id, "color", e.target.value)}
                  />
                </td>
                <td style={{ padding: "4px 8px" }}>
                  <input
                    className="input"
                    style={{ padding: "5px 7px", width: 64 }}
                    type="number"
                    min="0"
                    value={v.stockQty}
                    onChange={(e) => setVar(v.id, "stockQty", e.target.value)}
                  />
                </td>
                <td style={{ padding: "4px 8px" }}>
                  <input
                    className="input"
                    style={{ padding: "5px 7px", width: 56 }}
                    type="number"
                    min="0"
                    value={v.lowAt}
                    onChange={(e) => setVar(v.id, "lowAt", e.target.value)}
                  />
                </td>
                <td style={{ padding: "4px 8px" }}>
                  <button
                    className="btn ghost small"
                    onClick={() => removeVar(v.id)}
                    aria-label="Remove variant"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="btn small" style={{ marginTop: 8 }} onClick={addVarRow}>
        + Add a variant row
      </button>

      <datalist id="color-list">
        {COLOR_SWATCHES.map((c) => (
          <option key={c.name} value={c.name} />
        ))}
      </datalist>
      <datalist id={"sizes-" + f.category}>
        {sizeOptions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button className="btn primary big" style={{ flex: 1 }} onClick={submit}>
          {isEdit ? "Save changes" : "Add product"}
        </button>
        <button className="btn big" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
