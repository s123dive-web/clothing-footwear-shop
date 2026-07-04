// ---------------------------------------------------------------------------
// Product + size/colour variant helpers.
//
// A product carries its own metadata (name, brand, group/subcategory, prices) plus a list of
// VARIANTS, each with its own size, colour, and stock count:
//   product = {
//     id, name, brand, category(group), subcategory, code(SKU), supplier, imageUrl, notes,
//     purchasePrice, sellingPrice, mrp, discountPct,
//     variants: [ { id, size, color, sku, stockQty, lowAt } ],
//     stock,            // cached = sum(variant.stockQty); kept so list/stats code stays simple
//     createdAt, updatedAt, version
//   }
//
// The transform helpers (productStock, isProductLow, add/removeVariantStock, normalizeProduct,
// mergeProductGroup) are PURE so they unit-test cleanly. Only the *builders* (blankProduct,
// blankVariant, buildSeedProducts) mint ids via Date.now/Math.random — never call those in a test.
// ---------------------------------------------------------------------------
import { groupForSubcategory, subcatIcon, SEED_PRODUCTS } from "./catalog.js";

let counter = 0;
const rid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + (counter++).toString(36);

export const DEFAULT_VARIANT_LOW_AT = 2;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const blankVariant = (over = {}) => ({
  id: rid(),
  size: "",
  color: "",
  sku: "",
  stockQty: 0,
  lowAt: DEFAULT_VARIANT_LOW_AT,
  ...over,
});

// Blank product FORM shape (strings for numeric inputs so the fields start empty).
export const blankProduct = () => ({
  id: null,
  name: "",
  brand: "",
  category: "Clothing",
  subcategory: "Kurtis",
  code: "",
  purchasePrice: "",
  sellingPrice: "",
  mrp: "",
  discountPct: "",
  supplier: "",
  imageUrl: "",
  notes: "",
  variants: [blankVariant()],
});

// Human label for a variant: "M · Maroon", "Size 7", "Maroon", or "—" if it has neither.
export const variantLabel = (v) =>
  [v?.size ? String(v.size) : "", v?.color || ""].filter(Boolean).join(" · ") || "—";

// Cached total stock across all variants (falls back to a legacy flat `stock`).
export const productStock = (p) => {
  const vs = Array.isArray(p?.variants) ? p.variants : null;
  if (vs) return vs.reduce((a, v) => a + num(v.stockQty), 0);
  return num(p?.stock);
};

// Variants at or below their own low-stock threshold (only counts variants that hold a size/colour).
export const productLowVariants = (p) =>
  (Array.isArray(p?.variants) ? p.variants : []).filter((v) => num(v.stockQty) <= num(v.lowAt));

export const isProductLow = (p) => productLowVariants(p).length > 0;

// Recompute and stamp the cached total stock onto a product.
export const recomputeStock = (p) => ({ ...p, stock: productStock(p) });

// Apply a signed delta to one variant's stock (clamped at 0), returning a new product with the
// cached total refreshed. Used by both local edits and the atomic cloud transaction.
export function applyVariantDelta(product, variantId, delta) {
  if (!product) return product;
  const variants = (product.variants || []).map((v) =>
    v.id === variantId ? { ...v, stockQty: Math.max(0, num(v.stockQty) + num(delta)) } : v
  );
  const next = { ...product, variants };
  next.stock = productStock(next);
  return next;
}

export const addVariantStock = (product, variantId, qty) =>
  applyVariantDelta(product, variantId, Math.abs(num(qty)));
export const removeVariantStock = (product, variantId, qty) =>
  applyVariantDelta(product, variantId, -Math.abs(num(qty)));

// Coerce an arbitrary/legacy record into the canonical product shape.
export function normalizeProduct(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const subcategory = String(r.subcategory || r.category || "Kurtis");
  const category = String(r.category || groupForSubcategory(subcategory));
  const variants = (Array.isArray(r.variants) ? r.variants : []).map((v) => ({
    id: v.id || rid(),
    size: String(v.size ?? "").trim(),
    color: String(v.color ?? "").trim(),
    sku: String(v.sku ?? "").trim(),
    stockQty: Math.max(0, num(v.stockQty)),
    lowAt: Math.max(0, num(v.lowAt ?? DEFAULT_VARIANT_LOW_AT)),
  }));
  const p = {
    id: r.id || rid(),
    name: String(r.name ?? "").trim(),
    brand: String(r.brand ?? "").trim(),
    category,
    subcategory,
    code: String(r.code ?? r.sku ?? "").trim(),
    purchasePrice: num(r.purchasePrice ?? r.buyPrice),
    sellingPrice: num(r.sellingPrice ?? r.sellPrice),
    mrp: num(r.mrp ?? r.sellingPrice ?? r.sellPrice),
    discountPct: num(r.discountPct),
    supplier: String(r.supplier ?? "").trim(),
    imageUrl: String(r.imageUrl ?? "").trim(),
    notes: String(r.notes ?? "").trim(),
    icon: r.icon || subcatIcon(subcategory, category),
    variants,
    createdAt: r.createdAt || "",
    updatedAt: r.updatedAt || "",
    version: num(r.version) || 1,
  };
  p.stock = productStock(p);
  return p;
}

// Merge several same-name products into one: concatenate variants, keep the most complete
// metadata, and keep the oldest id. Used by the Admin "merge duplicates" tool.
export function mergeProductGroup(group) {
  const sorted = [...group].sort((a, b) =>
    String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
  );
  const primary = sorted[0];
  const pick = (key) => sorted.map((x) => x[key]).find((v) => v != null && v !== "" && v !== 0);
  const merged = normalizeProduct({
    ...primary,
    name: (primary.name || "").trim(),
    brand: primary.brand || pick("brand") || "",
    subcategory: primary.subcategory || pick("subcategory"),
    code: pick("code") || "",
    purchasePrice: pick("purchasePrice") || 0,
    sellingPrice: pick("sellingPrice") || primary.sellingPrice || 0,
    mrp: pick("mrp") || pick("sellingPrice") || 0,
    supplier: pick("supplier") || "",
    variants: sorted.flatMap((x) => (Array.isArray(x.variants) ? x.variants : [])),
  });
  return merged;
}

// Turn the seed specs (catalog.js) into full product records at 0 stock. `today` is injected
// so the caller controls the createdAt date (keeps this deterministic-friendly).
export function buildSeedProducts(today = "") {
  return SEED_PRODUCTS.map((spec) => {
    const subcategory = spec.subcategory;
    const category = groupForSubcategory(subcategory);
    const sizes = spec.sizes && spec.sizes.length ? spec.sizes : ["Free Size"];
    const colors = spec.colors && spec.colors.length ? spec.colors : [""];
    const variants = [];
    for (const color of colors)
      for (const size of sizes) {
        variants.push(blankVariant({ size, color, stockQty: 0, lowAt: DEFAULT_VARIANT_LOW_AT }));
      }
    return normalizeProduct({
      id: rid(),
      name: spec.name,
      brand: spec.brand || "",
      category,
      subcategory,
      purchasePrice: spec.purchasePrice,
      sellingPrice: spec.sellingPrice,
      mrp: spec.mrp,
      variants,
      createdAt: today,
    });
  });
}
