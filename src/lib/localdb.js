// Device-local persistence (IndexedDB) for two things:
//
//   • the offline CACHE — every record of every slice, one IndexedDB entry per record, written
//     incrementally (only records that changed), so there is no ~5 MB localStorage ceiling;
//   • the OUTBOX — the durable queue of writes that have not been acknowledged by the server
//     yet (see outbox.js).
//
// `openLocalDb()` never rejects: if IndexedDB is missing or blocked it falls back to an
// in-memory store with the same interface, so the app keeps working (just without offline
// durability) and `durable` is false.

const DB_NAME = "cfs-local-v1";
const DB_VERSION = 1;
const SEP = "\u0000"; // cache key = slice + SEP + record id

const reqP = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
const txDone = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });

function openIdb(idb, name) {
  return new Promise((resolve, reject) => {
    const req = idb.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("cache")) d.createObjectStore("cache");
      if (!d.objectStoreNames.contains("outbox")) d.createObjectStore("outbox", { keyPath: "id" });
      if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

function idbBackend(d) {
  return {
    durable: true,
    // → { [slice]: record[] }
    async loadCache() {
      const tx = d.transaction("cache", "readonly");
      const st = tx.objectStore("cache");
      const [keys, vals] = await Promise.all([reqP(st.getAllKeys()), reqP(st.getAll())]);
      const out = {};
      keys.forEach((k, i) => {
        const slice = String(k).split(SEP)[0];
        (out[slice] = out[slice] || []).push(vals[i]);
      });
      return out;
    },
    // One transaction: upsert `puts` (records with an id) and remove `deletes` (ids).
    async writeCache(slice, puts, deletes) {
      if (!puts.length && !deletes.length) return;
      const tx = d.transaction("cache", "readwrite");
      const st = tx.objectStore("cache");
      for (const rec of puts) st.put(rec, slice + SEP + String(rec.id));
      for (const id of deletes) st.delete(slice + SEP + String(id));
      await txDone(tx);
    },
    async loadOutbox() {
      const all = await reqP(d.transaction("outbox", "readonly").objectStore("outbox").getAll());
      return all.sort((a, b) => (a.seq || 0) - (b.seq || 0));
    },
    async putOp(op) {
      const tx = d.transaction("outbox", "readwrite");
      tx.objectStore("outbox").put(op);
      await txDone(tx);
    },
    async removeOp(id) {
      const tx = d.transaction("outbox", "readwrite");
      tx.objectStore("outbox").delete(id);
      await txDone(tx);
    },
    async kvGet(key) {
      return reqP(d.transaction("kv", "readonly").objectStore("kv").get(key));
    },
    async kvSet(key, value) {
      const tx = d.transaction("kv", "readwrite");
      tx.objectStore("kv").put(value, key);
      await txDone(tx);
    },
    close() {
      d.close();
    },
  };
}

// Same interface, nothing survives a reload. Used when IndexedDB is unavailable, and in tests.
export function memoryBackend() {
  const cache = new Map(); // key → record
  const outbox = new Map();
  const kv = new Map();
  const clone = (x) => JSON.parse(JSON.stringify(x));
  return {
    durable: false,
    async loadCache() {
      const out = {};
      for (const [k, v] of cache) {
        const slice = k.split(SEP)[0];
        (out[slice] = out[slice] || []).push(clone(v));
      }
      return out;
    },
    async writeCache(slice, puts, deletes) {
      for (const rec of puts) cache.set(slice + SEP + String(rec.id), clone(rec));
      for (const id of deletes) cache.delete(slice + SEP + String(id));
    },
    async loadOutbox() {
      return [...outbox.values()].map(clone).sort((a, b) => (a.seq || 0) - (b.seq || 0));
    },
    async putOp(op) {
      outbox.set(op.id, clone(op));
    },
    async removeOp(id) {
      outbox.delete(id);
    },
    async kvGet(key) {
      return kv.get(key);
    },
    async kvSet(key, value) {
      kv.set(key, value);
    },
    close() {},
  };
}

export async function openLocalDb({ indexedDB = globalThis.indexedDB, name = DB_NAME } = {}) {
  if (!indexedDB) return memoryBackend();
  try {
    return idbBackend(await openIdb(indexedDB, name));
  } catch (e) {
    console.error("IndexedDB unavailable — offline cache and outbox are memory-only", e);
    return memoryBackend();
  }
}

// ---------------------------------------------------------------------------------------------
// Incremental cache writer. Remembers a cheap fingerprint of what it last wrote for each record
// and, given the current array for a slice, writes only the records that changed / disappeared.
// ---------------------------------------------------------------------------------------------
const fingerprint = (rec) => {
  const s = JSON.stringify(rec);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return s.length + ":" + h;
};

export function createCacheWriter(backend) {
  const seen = {}; // slice → Map(id → { ref, fp })
  return {
    // Tell the writer what is already on disk (so the first write after load is a no-op).
    prime(slice, arr) {
      const m = (seen[slice] = new Map());
      for (const rec of arr || []) {
        if (rec && rec.id != null) m.set(String(rec.id), { ref: rec, fp: fingerprint(rec) });
      }
    },
    // Persist the difference between what was last written and `arr`. Resolves when on disk.
    async write(slice, arr) {
      const prev = seen[slice] || (seen[slice] = new Map());
      const next = new Map();
      const puts = [];
      for (const rec of arr || []) {
        if (!rec || rec.id == null) continue;
        const id = String(rec.id);
        const p = prev.get(id);
        if (p && p.ref === rec) {
          next.set(id, p);
          continue;
        }
        const fp = fingerprint(rec);
        next.set(id, { ref: rec, fp });
        if (!p || p.fp !== fp) puts.push(rec);
      }
      const deletes = [];
      for (const id of prev.keys()) if (!next.has(id)) deletes.push(id);
      seen[slice] = next;
      await backend.writeCache(slice, puts, deletes);
      return { puts: puts.length, deletes: deletes.length };
    },
  };
}
