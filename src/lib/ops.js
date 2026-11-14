// Pure helpers for outbox ops: applying a pending op to local data, the idempotent stock
// transaction body, and the builders for the three sale operations.
//
// Paths in an op's `patch` are relative to `shop/`:
//   "sales/<id>"            → whole record (null = delete)
//   "sales/<id>/<field>"    → one field of an existing record (null = remove the field)
//   "meta/customSubcats/<key>" → a value outside the keyed slices
import { applyVariantDelta, normalizeProduct } from "./products.js";

const sanitize = (x) => JSON.parse(JSON.stringify(x ?? null));
const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Apply the parts of `patch` that address `slice` to a { id: record } map. Returns the same map
// object when nothing applied, otherwise a new one (records that change are copied, not mutated).
export function applyPatchToMap(slice, map, patch) {
  if (!patch) return map;
  let out = map;
  const own = () => (out === map ? (out = { ...map }) : out);
  for (const path of Object.keys(patch)) {
    const parts = path.split("/");
    if (parts[0] !== slice || parts.length < 2) continue;
    const id = parts[1];
    const val = patch[path];
    if (parts.length === 2) {
      if (val == null) {
        if (id in out) delete own()[id];
      } else own()[id] = val;
      continue;
    }
    const rec = out[id];
    if (!rec) continue; // a field patch for a record we don't have — nothing to apply it to
    const next = { ...rec };
    let node = next;
    for (let i = 2; i < parts.length - 1; i++) {
      const child = node[parts[i]];
      node[parts[i]] = Array.isArray(child) ? child.slice() : { ...(child || {}) };
      node = node[parts[i]];
    }
    const leaf = parts[parts.length - 1];
    if (val == null) delete node[leaf];
    else node[leaf] = val;
    own()[id] = next;
  }
  return out;
}

// Apply every pending op, oldest first.
export function applyOpsToMap(slice, map, ops) {
  let out = map;
  for (const op of ops || []) out = applyPatchToMap(slice, out, op.patch);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Stock: idempotent per-product transaction body.
//
// Each product record carries an optional ledger `appliedOps: { <opId>: <ms timestamp> }`. A
// stock op is applied to a product at most once: if its id is already in the ledger the
// transaction is a no-op. This is what makes outbox replay safe.
// ---------------------------------------------------------------------------------------------
export const LEDGER_MAX = 150; // prune only beyond this many entries …
export const LEDGER_KEEP_MS = 90 * 24 * 60 * 60 * 1000; // … and only entries older than 90 days

export function pruneLedger(ledger, nowMs) {
  const ids = Object.keys(ledger || {});
  if (ids.length <= LEDGER_MAX) return ledger;
  const out = {};
  for (const id of ids)
    if (nowMs - (Number(ledger[id]) || 0) < LEDGER_KEEP_MS) out[id] = ledger[id];
  return out;
}

// `lines`: [{ variantId, delta }] for ONE product (delta < 0 = sold, > 0 = returned to stock).
// Returns the next product record, `undefined` when there is nothing to do (already applied),
// or the input unchanged when the product no longer exists.
export function applyStockOp(curr, opId, lines, nowMs, today) {
  if (!curr) return curr; // product deleted meanwhile — nothing to adjust
  if (curr.appliedOps && curr.appliedOps[opId]) return undefined;
  let p = normalizeProduct(curr);
  for (const l of lines) p = applyVariantDelta(p, l.variantId, Number(l.delta) || 0);
  if (today) p.updatedAt = today;
  p.version = (Number(curr.version) || 0) + 1;
  p.appliedOps = pruneLedger({ ...(curr.appliedOps || {}), [opId]: nowMs }, nowMs);
  return p;
}

// Group an op's stock lines by product: Map(productId → [{ variantId, delta }]).
export function stockByProduct(stock) {
  const m = new Map();
  for (const l of stock || []) {
    if (!l || !l.productId || !l.variantId || !l.delta) continue;
    if (!m.has(l.productId)) m.set(l.productId, []);
    m.get(l.productId).push({ variantId: l.variantId, delta: l.delta });
  }
  return m;
}

// What the user should SEE: the items as last received from the cloud/cache, plus every pending
// stock op that the record does not yet reflect (its id is not in the product's ledger).
export function overlayPendingStock(items, ops) {
  const pending = (ops || []).filter((o) => o.stock && o.stock.length);
  if (!pending.length) return items;
  let changed = false;
  const out = items.map((p) => {
    let next = p;
    for (const op of pending) {
      if (p.appliedOps && p.appliedOps[op.id]) continue;
      for (const l of op.stock) {
        if (l.productId === p.id) next = applyVariantDelta(next, l.variantId, Number(l.delta) || 0);
      }
    }
    if (next !== p) changed = true;
    return next;
  });
  return changed ? out : items;
}

// ---------------------------------------------------------------------------------------------
// The three sale operations. Each returns { patch, stock } — ONE op carrying both the bill
// change and the stock change, so they succeed, retry and replay together.
// ---------------------------------------------------------------------------------------------
const stockLine = (l) => !l.misc && l.productId && l.variantId;

// Sum signed stock deltas per (product, variant), dropping zeros.
function netStock(entries) {
  const m = new Map();
  for (const [l, delta] of entries) {
    if (!stockLine(l) || !delta) continue;
    const k = l.productId + "|" + l.variantId;
    m.set(k, (m.get(k) || 0) + delta);
  }
  return [...m.entries()]
    .filter(([, d]) => d)
    .map(([k, delta]) => {
      const [productId, variantId] = k.split("|");
      return { productId, variantId, delta };
    });
}

// New bill: write the sale, take its quantities out of stock.
export function recordSaleOp(sale) {
  return {
    patch: { ["sales/" + sale.id]: sanitize(sale) },
    stock: netStock((sale.lines || []).map((l) => [l, -Math.abs(Number(l.qty) || 0)])),
  };
}

// Edited bill: field-level diff prev → next, and the net stock difference between the two.
export function amendSaleOp(prev, next) {
  const patch = {};
  for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if (!eq(prev[k], next[k]))
      patch[`sales/${next.id}/${k}`] = next[k] === undefined ? null : sanitize(next[k]);
  }
  return {
    patch,
    stock: netStock([
      ...(prev.lines || []).map((l) => [l, Math.abs(Number(l.qty) || 0)]), // old qty comes back
      ...(next.lines || []).map((l) => [l, -Math.abs(Number(l.qty) || 0)]), // new qty goes out
    ]),
  };
}

// Deleted bill: remove the sale, put its quantities back.
export function voidSaleOp(sale) {
  return {
    patch: { ["sales/" + sale.id]: null },
    stock: netStock((sale.lines || []).map((l) => [l, Math.abs(Number(l.qty) || 0)])),
  };
}
