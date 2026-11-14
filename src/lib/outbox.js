// Durable outbox of pending cloud writes.
//
// Every write the app makes to the cloud is first recorded here as an OP, persisted to
// IndexedDB (write-ahead), and only then sent. An op is removed only when the server has
// acknowledged every part of it. After a reload — or a crash, a killed tab, a dead battery —
// the ops still in the store are replayed.
//
// That makes delivery AT-LEAST-ONCE, so every op must be safe to send twice:
//   • `patch` parts are plain sets/deletes of absolute values — naturally idempotent;
//   • `stock` parts are relative deltas — made idempotent by a per-product ledger keyed by the
//     op id (see applyStockOp in ops.js), so a replay can never decrement twice.
//
// An op:
//   { id, seq, at, label?, patch?: { "<path under shop/>": value|null }, stock?: [{ productId,
//     variantId, delta }], attempts?, error? }
//
// Durability has two steps. IndexedDB writes are asynchronous: for a few milliseconds after
// enqueue() the op exists only in memory, and a reload or a killed tab in that instant would
// lose it. So enqueue() FIRST writes the op to a small synchronous journal (localStorage) and
// only then starts the IndexedDB write; start() recovers anything found in the journal. The
// journal entry is dropped once IndexedDB has the op.
//
// This module is framework- and Firebase-free: the storage backend and the `send` function are
// injected, which is what makes replay / idempotency / crash behaviour unit-testable.

const DEFAULT_BACKOFF = [3000, 10000, 30000, 60000, 300000];

export function createOutbox({
  store, // { loadOutbox(), putOp(op), removeOp(id), journalAdd?(op), journalRemove?(id), journalLoad?() }
  send, // (op) => Promise — resolves once the server acknowledged the whole op
  onChange = () => {}, // (pendingOps) — the pending list changed
  onError = () => {}, // (op, error) — a send failed (it stays queued and will be retried)
  backoff = DEFAULT_BACKOFF,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  now = () => Date.now(),
}) {
  let ops = []; // pending, oldest first
  const inFlight = new Set(); // op ids with a send outstanding
  let chain = Promise.resolve(); // serialises persist → send-issue so ops go out in order
  let retryTimer = null;
  let stopped = false;
  let lastSeq = 0;

  const emit = () => onChange(ops.slice());

  const nextSeq = () => {
    lastSeq = Math.max(lastSeq + 1, now() * 1000);
    return lastSeq;
  };

  const scheduleRetry = (attempts) => {
    if (stopped || retryTimer != null) return;
    const delay = backoff[Math.min(Math.max(attempts, 1), backoff.length) - 1];
    retryTimer = setTimer(() => {
      retryTimer = null;
      flush();
    }, delay);
  };

  // Issue the send for one op (does not wait for the ack — the SDK queues it while offline).
  const dispatch = (op) => {
    if (stopped || inFlight.has(op.id) || !ops.includes(op)) return;
    inFlight.add(op.id);
    let p;
    try {
      p = Promise.resolve(send(op));
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      async () => {
        inFlight.delete(op.id);
        ops = ops.filter((o) => o !== op);
        emit();
        try {
          if (store.journalRemove) store.journalRemove(op.id);
          await store.removeOp(op.id);
        } catch (e) {
          // Worst case it is replayed once more after a reload — harmless (idempotent).
          console.error("outbox: could not remove acknowledged op", e);
        }
      },
      (err) => {
        inFlight.delete(op.id);
        if (stopped) return;
        op.attempts = (op.attempts || 0) + 1;
        op.error = String((err && (err.code || err.message)) || err);
        emit();
        onError(op, err);
        scheduleRetry(op.attempts);
      }
    );
  };

  // (Re)issue every pending op that has no send outstanding, in order.
  function flush() {
    if (stopped) return;
    for (const op of ops) dispatch(op);
  }

  return {
    // Load what a previous session left behind and start replaying it. Resolves with the
    // pending ops so the caller can overlay them on its state BEFORE the first cloud merge.
    async start() {
      let stored = [];
      try {
        stored = await store.loadOutbox();
      } catch (e) {
        console.error("outbox: could not read pending writes", e);
      }
      // Ops that were journalled but never reached IndexedDB (the tab died in between).
      try {
        const have = new Set(stored.map((o) => o.id));
        const rescued = (store.journalLoad ? store.journalLoad() : []).filter(
          (o) => !have.has(o.id)
        );
        for (const op of rescued) {
          stored.push(op);
          store
            .putOp(op)
            .then(() => store.journalRemove && store.journalRemove(op.id))
            .catch((e) => console.error("outbox: could not persist journalled op", e));
        }
        stored.sort((a, b) => (a.seq || 0) - (b.seq || 0));
      } catch (e) {
        console.error("outbox: could not read the journal", e);
      }
      // Ops enqueued while we were loading stay after the stored (older) ones.
      ops = [...stored, ...ops];
      for (const o of ops) lastSeq = Math.max(lastSeq, o.seq || 0);
      emit();
      chain = chain.then(flush);
      return ops.slice();
    },

    // Queue a write. Synchronously visible in pending(); persisted, then sent.
    enqueue({ id, patch, stock, label }) {
      const op = { id, seq: nextSeq(), at: now(), attempts: 0 };
      if (label) op.label = label;
      if (patch && Object.keys(patch).length) op.patch = patch;
      if (stock && stock.length) op.stock = stock;
      ops = [...ops, op];
      // Synchronous write-ahead: survives a reload that happens before IndexedDB commits.
      try {
        if (store.journalAdd) store.journalAdd(op);
      } catch (e) {
        console.error("outbox: journal write failed", e);
      }
      emit();
      const persisted = Promise.resolve()
        .then(() => store.putOp(op))
        .then(() => store.journalRemove && store.journalRemove(op.id))
        .catch((e) => {
          // Could not make it durable — still send it; it just won't survive a reload.
          console.error("outbox: could not persist op", e);
        });
      chain = chain.then(() => persisted).then(() => dispatch(op));
      return op;
    },

    pending: () => ops.slice(),
    failed: () => ops.filter((o) => o.error && !inFlight.has(o.id)),

    // Retry failed ops now (e.g. the connection just came back, or the user tapped "retry").
    retryNow() {
      if (retryTimer != null) {
        clearTimer(retryTimer);
        retryTimer = null;
      }
      flush();
    },

    // Resolves when everything queued so far has been persisted and issued (not acked).
    settled: () => chain,

    stop() {
      stopped = true;
      if (retryTimer != null) clearTimer(retryTimer);
      retryTimer = null;
    },
  };
}
