'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const config = require('./config');
const { stmts } = require('./db');
const stock = require('./stock');
const notifier = require('./notifier');
const views = require('./views');

// ---------- helpers ----------
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'content-type': 'application/json' });
const html = (res, body, status = 200, headers = {}) => send(res, status, body, { 'content-type': 'text/html; charset=utf-8', ...headers });

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  return JSON.parse(raw);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function requireAdmin(req, res) {
  const [, b64] = (req.headers.authorization || '').split(' ');
  const pass = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
  if (pass && safeEqual(pass, config.adminPassword)) return true;
  send(res, 401, 'Authentication required', { 'www-authenticate': 'Basic realm="Restock alerts admin", charset="UTF-8"' });
  return false;
}

// Very small in-memory rate limit for the public form: 30 requests per minute per IP.
const hits = new Map();
function rateLimited(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const nowMin = Math.floor(Date.now() / 60_000);
  const key = `${ip}:${nowMin}`;
  const n = (hits.get(key) || 0) + 1;
  hits.set(key, n);
  if (hits.size > 5000) for (const k of hits.keys()) if (!k.endsWith(`:${nowMin}`)) hits.delete(k);
  return n > 30;
}

// ---------- routes ----------
async function route(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;

  if (p === '/healthz') return json(res, 200, { ok: true });

  if (m === 'GET' && p === '/') return html(res, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Restock alerts</title><body style="font-family:system-ui;padding:40px;max-width:640px;margin:auto;line-height:1.6"><h1>Restock alerts</h1><p>This service powers back-in-stock emails.</p><ul><li><a href="/embed">Customer form</a> (embed with an iframe)</li><li><a href="/admin">Admin</a> (password protected)</li></ul></body>`);

  // Embeddable form. No X-Frame-Options so it can live inside another site's iframe.
  if (m === 'GET' && p === '/embed') {
    const products = await stock.getCatalogue();
    return html(res, views.embedPage(products), 200, { 'cache-control': 'no-store' });
  }

  // Customer submits a request.
  if (m === 'POST' && p === '/api/requests') {
    if (rateLimited(req)) return json(res, 429, { error: 'Too many requests. Please try again in a minute.' });
    let body;
    try { body = await readJson(req); } catch { return json(res, 400, { error: 'Body must be JSON.' }); }
    const email = String(body.email || '').trim().toLowerCase();
    const sku = String(body.sku || '').trim().toUpperCase();
    if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'Please enter a valid email address.' });
    if (!SKU_RE.test(sku)) return json(res, 400, { error: 'Please choose a product.' });

    // Duplicate open request: say so, don't create another.
    const existing = stmts.findOpen.get(email, sku);
    if (existing) {
      const cached = stock.cached(sku);
      return json(res, 200, { status: 'exists', id: existing.id, sku, product_name: cached?.name || null });
    }

    // Check the stock API. If it's in stock now, there's nothing to wait for.
    let product = null;
    try { product = await stock.getStock(sku); } catch (err) { console.warn('stock lookup failed, accepting request anyway:', err.message); product = stock.cached(sku); }
    if (product && product.in_stock) return json(res, 200, { status: 'in_stock', sku, product_name: product.name || null, quantity: product.quantity });

    try {
      const r = stmts.insertRequest.run(email, sku, product?.name || null);
      return json(res, 201, { status: 'created', id: Number(r.lastInsertRowid), sku, product_name: product?.name || null });
    } catch (err) {
      // Two identical submissions raced; the unique index caught the second one.
      if (String(err.message).includes('UNIQUE')) {
        const again = stmts.findOpen.get(email, sku);
        return json(res, 200, { status: 'exists', id: again?.id, sku, product_name: product?.name || null });
      }
      throw err;
    }
  }

  // Stock webhook.
  if (m === 'POST' && p === '/webhooks/stock') {
    const secret = req.headers['x-webhook-secret'];
    if (!secret || !safeEqual(secret, config.webhookSecret)) return json(res, 401, { error: 'Invalid webhook secret.' });
    let body;
    try { body = await readJson(req); } catch { return json(res, 400, { error: 'Body must be JSON.' }); }
    const event_id = String(body.event_id || '').trim().slice(0, 128);
    const sku = String(body.sku || '').trim().toUpperCase();
    if (!event_id || !SKU_RE.test(sku)) return json(res, 400, { error: 'event_id and sku are required.' });
    if (body.type && body.type !== 'stock.updated') return json(res, 200, { ignored: true, type: body.type });

    const result = await notifier.handleStockEvent({ event_id, sku, quantity: body.quantity });
    if (result.duplicate) return json(res, 200, { received: true, duplicate: true, event_id });
    return json(res, 200, { received: true, ...result });
  }

  // Admin.
  if (p === '/admin' || p.startsWith('/admin/')) {
    if (!requireAdmin(req, res)) return;
    if (m === 'GET' && p === '/admin') {
      const filter = ['open', 'notified', 'failed'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'all';
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const limit = 50;
      const offset = (page - 1) * limit;
      const rows = q
        ? stmts.search.all(`%${q}%`, `%${q}%`, `%${q}%`, limit + 1, offset)
        : filter === 'all' ? stmts.listRequests.all(limit + 1, offset) : stmts.listByStatus.all(filter, limit + 1, offset);
      const counts = Object.fromEntries(stmts.counts.all().map((r) => [r.status, r.n]));
      return html(res, views.adminPage({ requests: rows.slice(0, limit), counts, events: stmts.recentEvents.all(25), filter, q, page, hasMore: rows.length > limit }), 200, { 'cache-control': 'no-store' });
    }
    const retry = m === 'POST' && p.match(/^\/admin\/requests\/(\d+)\/retry$/);
    if (retry) {
      const r = stmts.getRequest.get(Number(retry[1]));
      if (r && r.status === 'failed') {
        notifier.db.prepare(`UPDATE requests SET status='open', attempts=0, next_retry_at=NULL, last_error=NULL WHERE id=?`).run(r.id);
        notifier.processSku(r.sku, 'manual-retry').catch((e) => console.error(e));
      }
      return send(res, 303, '', { location: '/admin?status=all' });
    }
    return send(res, 404, 'Not found');
  }

  return send(res, 404, 'Not found');
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'Internal error' });
  });
});

server.listen(config.port, () => {
  console.log(`Restock alerts listening on :${config.port}, data at ${config.dbPath}`);
  notifier.startWorker();
});

function shutdown(sig) {
  console.log(`${sig}: shutting down`);
  server.close(() => { try { notifier.db.close(); } catch { /* already closed */ } process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(sig));

module.exports = server;
