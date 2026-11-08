'use strict';
// End-to-end tests against a tiny mock of the stock API + Resend API, mirroring the challenge harness.
// Run: npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SECRET = 'whsec_test';
const KEY = 're_test';
const stock = { 'TEE-1': 0, 'MUG-2': 0, 'CAP-3': 5 };
const emails = [];
let failNext = 0;
let stockApiDown = false;

const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const auth = req.headers.authorization === `Bearer ${KEY}`;
  const json = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (!auth) return json(401, { error: 'bad key' });
  if (req.method === 'GET' && url.pathname.startsWith('/api/stock')) {
    if (stockApiDown) return json(503, { error: 'down' });
    const sku = decodeURIComponent(url.pathname.replace('/api/stock', '').replace(/^\//, ''));
    if (!sku) return json(200, { products: Object.keys(stock).map((s) => ({ sku: s, name: `Item ${s}`, price: 10, currency: 'GBP', quantity: stock[s], in_stock: stock[s] > 0 })) });
    const q = stock[sku] ?? 0;
    return json(200, { sku, name: `Item ${sku}`, price: 10, currency: 'GBP', quantity: q, in_stock: q > 0 });
  }
  if (req.method === 'POST' && url.pathname === '/emails') {
    let body = ''; for await (const c of req) body += c;
    const p = JSON.parse(body);
    const idem = req.headers['idempotency-key'];
    const prev = emails.find((e) => e.idem === idem && e.ok);
    if (prev) return json(200, { id: prev.id });
    const rec = { id: `em_${emails.length + 1}`, to: p.to, subject: p.subject, idem, ok: true };
    if (failNext > 0) { failNext--; rec.ok = false; emails.push(rec); return json(500, { message: 'injected failure' }); }
    assert.ok(p.from && p.subject && p.html && p.text, 'email has from/subject/html/text');
    emails.push(rec);
    return json(200, { id: rec.id });
  }
  json(404, {});
});

let mockPort, app, appPort, dataDir;
const api = (p, opts = {}) => fetch(`http://127.0.0.1:${appPort}${p}`, opts);
const postJson = (p, body, headers = {}) => api(p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const webhook = (event_id, sku, quantity, secret = SECRET) => postJson('/webhooks/stock', { event_id, type: 'stock.updated', sku, quantity }, { 'x-webhook-secret': secret });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const accepted = (to) => emails.filter((e) => e.ok && e.to.includes(to)).length;

function startApp() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(__dirname, '..', 'src', 'server.js')], {
      env: {
        ...process.env, PORT: String(appPort), DATA_DIR: dataDir,
        STOCK_API_URL: `http://127.0.0.1:${mockPort}/api/stock`, STOCK_API_KEY: KEY,
        RESEND_API_KEY: KEY, RESEND_BASE_URL: `http://127.0.0.1:${mockPort}`,
        WEBHOOK_SECRET: SECRET, ADMIN_PASSWORD: 'pw',
        WORKER_INTERVAL_MS: '400', RECONCILE_INTERVAL_MS: '800', STALE_SENDING_MS: '500',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (d) => process.env.DEBUG && process.stderr.write(d));
    child.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(child); });
    child.on('exit', (code) => reject(new Error(`app exited ${code}`)));
    setTimeout(() => reject(new Error('app did not start')), 5000);
  });
}

before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  mockPort = mock.address().port;
  appPort = 20000 + Math.floor(Math.random() * 10000);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bis-test-'));
  app = await startApp();
});
after(() => { app?.kill(); mock.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('creates a request, rejects duplicates, reports in-stock items', async () => {
  let r = await postJson('/api/requests', { email: 'Ann@Example.com', sku: 'tee-1' });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).status, 'created');
  r = await postJson('/api/requests', { email: 'ann@example.com', sku: 'TEE-1' });
  assert.equal((await r.json()).status, 'exists');
  r = await postJson('/api/requests', { email: 'bob@example.com', sku: 'CAP-3' });
  assert.equal((await r.json()).status, 'in_stock');
  r = await postJson('/api/requests', { email: 'nope', sku: 'TEE-1' });
  assert.equal(r.status, 400);
});

test('five simultaneous identical submissions create exactly one request', async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => postJson('/api/requests', { email: 'race@example.com', sku: 'MUG-2' }).then((r) => r.json())));
  assert.equal(results.filter((x) => x.status === 'created').length, 1);
  assert.equal(results.filter((x) => x.status === 'exists').length, 4);
});

test('rejects a wrong webhook secret', async () => {
  const r = await webhook('evt_bad', 'TEE-1', 5, 'wrong');
  assert.equal(r.status, 401);
});

test('phantom webhook (stock API says 0) sends nothing', async () => {
  const r = await webhook('evt_phantom', 'TEE-1', 12);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).notified, 0);
  assert.equal(accepted('ann@example.com'), 0);
});

test('duplicate webhook delivered twice at once: one email per customer', async () => {
  await postJson('/api/requests', { email: 'cat@example.com', sku: 'TEE-1' });
  stock['TEE-1'] = 7;
  const [a, b] = await Promise.all([webhook('evt_1', 'TEE-1', 7), webhook('evt_1', 'TEE-1', 7)]);
  const [ja, jb] = [await a.json(), await b.json()];
  assert.equal([ja, jb].filter((x) => x.duplicate).length, 1, 'exactly one delivery is flagged duplicate');
  const again = await (await webhook('evt_1', 'TEE-1', 7)).json();
  assert.equal(again.duplicate, true);
  assert.equal(accepted('ann@example.com'), 1);
  assert.equal(accepted('cat@example.com'), 1);
});

test('injected email failure: no email sent, request stays open with the error for retry', async () => {
  failNext = 1;
  stock['MUG-2'] = 3;
  const r = await (await webhook('evt_2', 'MUG-2', 3)).json();
  assert.equal(r.retry, 1);
  assert.equal(accepted('race@example.com'), 0);
  // The first retry is scheduled 30s out (backoff), so here we check the state rather than wait for it.
  // The live harness run covers the actual retry: failed send, then one accepted email 30s later.
  const admin = await api('/admin?status=open', { headers: { authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') } });
  const page = await admin.text();
  assert.match(page, /race@example.com/);
  assert.match(page, /injected failure/);
});

test('stock API outage does not consume the webhook event', async () => {
  await postJson('/api/requests', { email: 'dan@example.com', sku: 'CAP-3' }).catch(() => {});
  stock['CAP-3'] = 0;
  await postJson('/api/requests', { email: 'dan@example.com', sku: 'CAP-3' });
  stock['CAP-3'] = 4;
  stockApiDown = true;
  const r1 = await webhook('evt_3', 'CAP-3', 4);
  assert.equal(r1.status, 500);
  stockApiDown = false;
  const r2 = await (await webhook('evt_3', 'CAP-3', 4)).json(); // sender retries the same event
  assert.equal(r2.duplicate, false, 'retry after outage is processed, not treated as duplicate');
  assert.equal(accepted('dan@example.com'), 1);
});

test('survives a restart and catches a webhook missed while down', async () => {
  stock['TEE-1'] = 0;
  await postJson('/api/requests', { email: 'eve@example.com', sku: 'TEE-1' });
  app.kill(); await sleep(300);
  stock['TEE-1'] = 9; // restocked while the app is down; the webhook is lost
  app = await startApp();
  await sleep(1500); // boot-time reconciliation
  assert.equal(accepted('eve@example.com'), 1);
  const admin = await api('/admin', { headers: { authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') } });
  assert.match(await admin.text(), /eve@example.com/);
});

test('admin requires a password', async () => {
  assert.equal((await api('/admin')).status, 401);
});
