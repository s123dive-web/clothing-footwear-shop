// Per-record keyed sync for the Realtime Database.
//
// Each slice (items, sales, expenses, logs) is stored as a MAP keyed by the record's own
// `id` — e.g. shop/items/<id> — instead of one big array. This is what makes the app safe
// across many devices:
//   • Concurrent edits to DIFFERENT records merge naturally (different keys never collide).
//   • Writes are field-level: only the changed fields of a changed record are pushed, so two
//     devices editing different fields of the SAME record both survive (last-write-wins per
//     field for the rare same-field clash).
//   • Incoming cloud snapshots are 3-way merged with un-pushed local edits, so a remote change
//     can't silently drop something you just added on this device.
//
// The React layer keeps working with plain arrays; this module is the only array↔map bridge.

import { ref, onValue, set, update, runTransaction, get } from "firebase/database";
import { db } from "../config/firebase.js";

export const SLICES = ["items", "sales", "expenses", "logs", "vendorBills", "dailyBills"];

const path = (slice) => "shop/" + slice;

// RTDB rejects `undefined` and functions; JSON round-trip drops them and deep-clones.
export const sanitize = (x) => JSON.parse(JSON.stringify(x ?? null));

const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Stable, predictable ordering so every device shows the same list order.
const SORTERS = {
  items: (a, b) => String(a.name || "").localeCompare(String(b.name || "")),
  sales: (a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.id).localeCompare(String(b.id)),
  expenses: (a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.id).localeCompare(String(b.id)),
  logs: (a, b) => (b.at || 0) - (a.at || 0), // newest first
  vendorBills: (a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : String(b.id).localeCompare(String(a.id)), // newest first
  dailyBills: (a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0), // newest first
};

// Accept null / legacy-array / keyed-object → { [id]: record }, keeping only valid records.
export function toMap(val) {
  const out = {};
  if (!val) return out;
  const entries = Array.isArray(val) ? val : Object.values(val);
  for (const rec of entries) {
    if (rec && typeof rec === "object" && rec.id != null) out[String(rec.id)] = rec;
  }
  return out;
}

export function mapToArray(slice, map) {
  const arr = Object.values(map);
  const cmp = SORTERS[slice];
  return cmp ? arr.slice().sort(cmp) : arr;
}

// True if the stored node isn't already keyed by record id (legacy array, or numeric keys)
// and therefore needs a one-time rewrite into the keyed-by-id shape.
export function isLegacyShape(val, map) {
  if (!val) return false;
  if (Array.isArray(val)) return true;
  return Object.keys(val).some((k) => map[k] === undefined);
}

// Build an atomic multi-path update from the last-known cloud map → the new local array:
// only the changed fields of changed/added records, plus `null` for deleted records.
export function buildSliceUpdate(prevMap, nextArr) {
  const updates = {};
  const nextMap = {};
  for (const rec of nextArr) {
    if (!rec || rec.id == null) continue;
    const id = String(rec.id);
    nextMap[id] = rec;
    const prev = prevMap[id];
    if (!prev) {
      updates[id] = sanitize(rec); // brand-new record → write the whole node
      continue;
    }
    for (const k of new Set([...Object.keys(prev), ...Object.keys(rec)])) {
      if (!eq(prev[k], rec[k]))
        updates[`${id}/${k}`] = rec[k] === undefined ? null : sanitize(rec[k]);
    }
  }
  for (const id of Object.keys(prevMap)) {
    if (!(id in nextMap)) updates[id] = null; // deleted locally
  }
  return { updates, nextMap, changed: Object.keys(updates).length > 0 };
}

// 3-way merge: reconcile an incoming cloud snapshot (`theirs`) with un-pushed local state
// (`ours`) relative to the last snapshot we acted on (`base`). Remote changes are accepted,
// but local-only adds/edits/deletes that haven't reached the cloud yet are preserved.
export function mergeRemote(base, theirs, ours) {
  const result = { ...theirs };
  for (const id of Object.keys(ours)) {
    const o = ours[id];
    const b = base[id];
    if (!b) {
      // Added locally since `base`. Keep it unless the cloud already has this id.
      if (!(id in theirs)) result[id] = o;
      continue;
    }
    const t = theirs[id];
    if (!t) continue; // remote deleted it → respect the deletion
    let merged = t;
    let changed = false;
    for (const k of new Set([...Object.keys(o), ...Object.keys(b)])) {
      if (!eq(o[k], b[k])) {
        // Field changed locally since base → apply our value on top of theirs.
        if (!changed) {
          merged = { ...t };
          changed = true;
        }
        if (o[k] === undefined) delete merged[k];
        else merged[k] = o[k];
      }
    }
    if (changed) result[id] = merged;
  }
  // Deleted locally since `base`: honour it unless the cloud changed that record meanwhile.
  for (const id of Object.keys(base)) {
    if (!(id in ours) && id in result && eq(theirs[id], base[id])) delete result[id];
  }
  return result;
}

export const writeSlice = (slice, updates) => update(ref(db, path(slice)), updates);
export const overwriteSlice = (slice, map) => set(ref(db, path(slice)), sanitize(map));

// Atomically read-modify-write a single item record in the cloud via a transaction. This is
// how stock changes (sales, restock, variant edits) avoid the silent-overwrite bug: two
// devices selling the same product both apply their delta on top of the freshest server value
// instead of each pushing a stale `stock`/variant field that clobbers the other. `mutate`
// receives the current record (or null if absent) and returns the next record; returning
// undefined aborts the transaction (leaves the record unchanged).
export function updateItemAtomic(id, mutate) {
  return runTransaction(ref(db, "shop/items/" + String(id)), (current) => {
    const next = mutate(current);
    return next === undefined ? current : next;
  });
}

export function subscribeSlice(slice, onData, onError) {
  return onValue(ref(db, path(slice)), (snap) => onData(snap.val()), onError);
}

// One-shot read / write of a small flag under shop/meta/<key>. Used for the one-time seed
// guard (shop/meta/seeded) so seed data never resurrects after the catalogue is cleared.
export const readMeta = (key) => get(ref(db, "shop/meta/" + key)).then((s) => s.val());
export const writeMeta = (key, val) => set(ref(db, "shop/meta/" + key), val);

// Live online/offline signal from the RTDB client. cb(true|false).
export function subscribeConnection(cb) {
  return onValue(
    ref(db, ".info/connected"),
    (snap) => cb(snap.val() === true),
    () => cb(false)
  );
}
