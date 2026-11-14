import { normalizeProduct, applyVariantDelta } from "./products.js";
import { updateItemAtomic } from "./sync.js";
import { todayStr } from "./format.js";

// ---------------------------------------------------------------------------
// Cloud product writes (the `items` slice). Every write is a Firebase transaction, so two
// devices changing stock at the same time apply their deltas on top of the freshest server
// value instead of clobbering each other (fixes the grocery app's silent-overwrite bug).
// Local product state is refreshed by the onValue echo — Firebase surfaces local writes to the
// listener immediately, so the UI updates instantly and offline edits still show this session.
// ---------------------------------------------------------------------------

// Create or replace a whole product record (metadata + variant structure). Preserves createdAt
// and bumps the version; when editing an existing record, untouched server fields are replaced
// by the passed product (the caller edits a snapshot, so this is an intentional owner override).
export async function cloudWriteProduct(product) {
  const p = normalizeProduct(product);
  await updateItemAtomic(p.id, (curr) => ({
    ...p,
    createdAt: (curr && curr.createdAt) || p.createdAt || todayStr(),
    updatedAt: todayStr(),
    version: ((curr && curr.version) || 0) + 1,
    // Keep the ledger of already-applied stock ops (lib/ops.js) across an owner edit.
    ...(curr && curr.appliedOps ? { appliedOps: curr.appliedOps } : {}),
  }));
  return p.id;
}

// Delete a product (transaction returning null removes the node).
export const cloudDeleteProduct = (id) => updateItemAtomic(id, () => null);

// Atomically add stock to one variant (restock).
export const cloudRestockVariant = (productId, variantId, qty) =>
  updateItemAtomic(productId, (curr) => {
    if (!curr) return curr;
    const p = applyVariantDelta(normalizeProduct(curr), variantId, Math.abs(Number(qty) || 0));
    p.updatedAt = todayStr();
    p.version = (curr.version || 0) + 1;
    return p;
  });
