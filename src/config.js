'use strict';

const fs = require('node:fs');
const path = require('node:path');

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable ${name}`);
    process.exit(1);
  }
  return v;
}

const dataDir = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(process.cwd(), 'data'));
fs.mkdirSync(dataDir, { recursive: true });

module.exports = {
  port: Number(process.env.PORT || 3000),
  stockApiUrl: required('STOCK_API_URL').replace(/\/+$/, ''),
  stockApiKey: required('STOCK_API_KEY'),
  resendApiKey: required('RESEND_API_KEY'),
  resendBaseUrl: (process.env.RESEND_BASE_URL || 'https://api.resend.com').replace(/\/+$/, ''),
  webhookSecret: required('WEBHOOK_SECRET'),
  adminPassword: required('ADMIN_PASSWORD'),
  fromEmail: process.env.FROM_EMAIL || 'Restock alerts <alerts@example.com>',
  storeName: process.env.STORE_NAME || 'Our store',
  storeUrl: (process.env.STORE_URL || '').replace(/\/+$/, ''),
  dbPath: path.join(dataDir, 'alerts.sqlite'),
  // How often the background worker runs (retries + reconciliation).
  workerIntervalMs: Number(process.env.WORKER_INTERVAL_MS || 30_000),
  // How often we re-check the stock API for SKUs with open requests, in case a webhook was missed.
  reconcileIntervalMs: Number(process.env.RECONCILE_INTERVAL_MS || 120_000),
  // A send that has been "in flight" longer than this is treated as crashed and retried (idempotency key makes that safe).
  staleSendingMs: Number(process.env.STALE_SENDING_MS || 120_000),
  maxAttempts: Number(process.env.MAX_ATTEMPTS || 8),
};
