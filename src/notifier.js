'use strict';

const config = require('./config');
const { db, stmts, now } = require('./db');
const stock = require('./stock');
const mailer = require('./mailer');

// Per-SKU lock inside this process, so two webhooks for the same SKU arriving at the same
// moment don't both run the notify loop. (The database claim below is the real guarantee;
// this just avoids wasted work.)
const inFlight = new Map();

function backoff(attempts) {
  const seconds = Math.min(60 * 60, 30 * 2 ** Math.max(0, attempts - 1)); // 30s, 60s, 2m, 4m ... capped at 1h
  return new Date(Date.now() + seconds * 1000).toISOString();
}

async function notifyOne(id, product, sourceEvent) {
  // Atomic claim: if another worker already flipped this row, changes === 0 and we stop.
  const claimed = stmts.claim.run(now(), id);
  if (claimed.changes === 0) return 'skipped';
  const req = stmts.getRequest.get(id);
  try {
    const emailId = await mailer.sendRestockEmail({
      to: req.email,
      product,
      idempotencyKey: `restock-request-${id}`,
    });
    stmts.markNotified.run(now(), emailId, sourceEvent || null, id);
    return 'notified';
  } catch (err) {
    const message = String(err.message || err).slice(0, 300);
    if (req.attempts >= config.maxAttempts) {
      stmts.markFailed.run(message, id);
      console.error(`request ${id}: giving up after ${req.attempts} attempts: ${message}`);
      return 'failed';
    }
    stmts.release.run(message, backoff(req.attempts), id);
    console.warn(`request ${id}: send failed (attempt ${req.attempts}), will retry: ${message}`);
    return 'retry';
  }
}

// Verify with the stock API, then notify everyone waiting on this SKU.
async function processSku(sku, sourceEvent) {
  if (inFlight.has(sku)) return inFlight.get(sku);
  const p = (async () => {
    const product = await stock.getStock(sku);
    const summary = { sku, verified_quantity: product.quantity, notified: 0, retry: 0, failed: 0, skipped: 0 };
    if (!product.in_stock) return summary; // phantom webhook or already sold out again: do nothing
    const waiting = stmts.openForSku.all(sku, now());
    for (const row of waiting) {
      const outcome = await notifyOne(row.id, product, sourceEvent);
      summary[outcome] = (summary[outcome] || 0) + 1;
    }
    return summary;
  })().finally(() => inFlight.delete(sku));
  inFlight.set(sku, p);
  return p;
}

// Called by the webhook route. Returns what happened so the route can answer honestly.
async function handleStockEvent({ event_id, sku, quantity }) {
  try {
    stmts.insertEvent.run(event_id, sku, Number(quantity) || 0);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return { duplicate: true, event_id };
    throw err;
  }
  // A sell-out (quantity 0) can't trigger a notification, so don't bother the stock API.
  if (!(Number(quantity) > 0)) {
    stmts.updateEvent.run(null, JSON.stringify({ sku, verified_quantity: null, ignored: 'quantity 0' }), event_id);
    return { duplicate: false, sku, ignored: 'quantity 0' };
  }
  try {
    const summary = await processSku(sku, event_id);
    stmts.updateEvent.run(summary.verified_quantity, JSON.stringify(summary), event_id);
    return { duplicate: false, ...summary };
  } catch (err) {
    // We couldn't verify or notify (stock API down, for example). Forget the event so the sender's
    // retry is processed as new instead of being treated as a duplicate. The reconciler also covers this.
    stmts.deleteEvent.run(event_id);
    throw err;
  }
}

// Background worker: recover crashed sends, retry failures, and reconcile missed webhooks.
let lastReconcile = 0;
let ticking = false;
async function tick() {
  if (ticking) return; // a slow run must not overlap with the next interval
  ticking = true;
  try { await runTick(); } finally { ticking = false; }
}
async function runTick() {
  const staleBefore = new Date(Date.now() - config.staleSendingMs).toISOString();
  const recovered = stmts.recoverStale.run(staleBefore);
  if (recovered.changes) console.warn(`recovered ${recovered.changes} request(s) stuck in 'sending'`);

  for (const { sku } of stmts.dueRetries.all(now())) {
    await processSku(sku, 'retry').catch((e) => console.error('retry', sku, e.message));
  }

  if (Date.now() - lastReconcile >= config.reconcileIntervalMs) {
    lastReconcile = Date.now();
    for (const { sku } of stmts.skusWithOpen.all()) {
      await processSku(sku, 'reconcile').catch((e) => console.error('reconcile', sku, e.message));
    }
  }
}

function startWorker() {
  // Run once on boot so a restart immediately picks up anything pending.
  tick().catch((e) => console.error('worker', e));
  const timer = setInterval(() => tick().catch((e) => console.error('worker', e)), config.workerIntervalMs);
  timer.unref();
  return timer;
}

module.exports = { handleStockEvent, processSku, startWorker, tick, db };
