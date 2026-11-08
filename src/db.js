'use strict';

const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    email          TEXT NOT NULL,
    sku            TEXT NOT NULL,
    product_name   TEXT,
    status         TEXT NOT NULL DEFAULT 'open',   -- open | sending | notified | failed
    attempts       INTEGER NOT NULL DEFAULT 0,
    last_error     TEXT,
    next_retry_at  TEXT,
    sending_since  TEXT,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    notified_at    TEXT,
    email_id       TEXT,
    source_event   TEXT
  );
  -- One open request per customer per SKU. Enforced by the database, so two simultaneous
  -- submissions can't both get through.
  CREATE UNIQUE INDEX IF NOT EXISTS uq_open_request
    ON requests (email, sku) WHERE status IN ('open', 'sending');
  CREATE INDEX IF NOT EXISTS ix_requests_sku_status ON requests (sku, status);
  CREATE INDEX IF NOT EXISTS ix_requests_created ON requests (created_at DESC);

  -- Every webhook we have ever accepted, by event_id. Inserting here is the idempotency check.
  CREATE TABLE IF NOT EXISTS webhook_events (
    event_id     TEXT PRIMARY KEY,
    sku          TEXT,
    quantity     INTEGER,
    verified_qty INTEGER,
    outcome      TEXT,
    received_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS stock_cache (
    sku         TEXT PRIMARY KEY,
    name        TEXT,
    price       REAL,
    currency    TEXT,
    image       TEXT,
    quantity    INTEGER,
    checked_at  TEXT
  );
`);

const now = () => new Date().toISOString();

const stmts = {
  insertRequest: db.prepare(
    `INSERT INTO requests (email, sku, product_name) VALUES (?, ?, ?)`,
  ),
  findOpen: db.prepare(
    `SELECT id, status FROM requests WHERE email = ? AND sku = ? AND status IN ('open','sending')`,
  ),
  openForSku: db.prepare(
    `SELECT id FROM requests WHERE sku = ? AND status = 'open'
       AND (next_retry_at IS NULL OR next_retry_at <= ?)`,
  ),
  // The atomic claim: only one worker can flip a row from open -> sending.
  claim: db.prepare(
    `UPDATE requests SET status = 'sending', sending_since = ?, attempts = attempts + 1
      WHERE id = ? AND status = 'open'`,
  ),
  markNotified: db.prepare(
    `UPDATE requests SET status = 'notified', notified_at = ?, email_id = ?, source_event = ?,
        last_error = NULL, sending_since = NULL WHERE id = ? AND status = 'sending'`,
  ),
  release: db.prepare(
    `UPDATE requests SET status = 'open', last_error = ?, next_retry_at = ?, sending_since = NULL
      WHERE id = ? AND status = 'sending'`,
  ),
  markFailed: db.prepare(
    `UPDATE requests SET status = 'failed', last_error = ?, sending_since = NULL
      WHERE id = ? AND status = 'sending'`,
  ),
  getRequest: db.prepare(`SELECT * FROM requests WHERE id = ?`),
  // Rows stuck in 'sending' (process died mid-send) go back to 'open'.
  recoverStale: db.prepare(
    `UPDATE requests SET status = 'open', sending_since = NULL,
        last_error = COALESCE(last_error, 'Recovered after restart')
      WHERE status = 'sending' AND sending_since < ?`,
  ),
  dueRetries: db.prepare(
    `SELECT DISTINCT sku FROM requests WHERE status = 'open' AND next_retry_at IS NOT NULL AND next_retry_at <= ?`,
  ),
  skusWithOpen: db.prepare(`SELECT DISTINCT sku FROM requests WHERE status = 'open'`),
  listRequests: db.prepare(
    `SELECT * FROM requests ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ),
  listByStatus: db.prepare(
    `SELECT * FROM requests WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ),
  search: db.prepare(
    `SELECT * FROM requests WHERE email LIKE ? OR sku LIKE ? OR product_name LIKE ?
      ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ),
  counts: db.prepare(`SELECT status, COUNT(*) AS n FROM requests GROUP BY status`),
  insertEvent: db.prepare(
    `INSERT INTO webhook_events (event_id, sku, quantity) VALUES (?, ?, ?)`,
  ),
  deleteEvent: db.prepare(`DELETE FROM webhook_events WHERE event_id = ?`),
  updateEvent: db.prepare(
    `UPDATE webhook_events SET verified_qty = ?, outcome = ? WHERE event_id = ?`,
  ),
  recentEvents: db.prepare(`SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT ?`),
  upsertStock: db.prepare(
    `INSERT INTO stock_cache (sku, name, price, currency, image, quantity, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sku) DO UPDATE SET name = excluded.name, price = excluded.price, currency = excluded.currency,
       image = excluded.image, quantity = excluded.quantity, checked_at = excluded.checked_at`,
  ),
  getStock: db.prepare(`SELECT * FROM stock_cache WHERE sku = ?`),
  allStock: db.prepare(`SELECT * FROM stock_cache ORDER BY name`),
};

module.exports = { db, stmts, now };
