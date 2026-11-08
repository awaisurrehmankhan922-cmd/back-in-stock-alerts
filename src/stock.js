'use strict';

const config = require('./config');
const { stmts, now } = require('./db');

const headers = { authorization: `Bearer ${config.stockApiKey}`, accept: 'application/json' };

async function fetchJson(url) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Stock API ${res.status} for ${url}`);
  return res.json();
}

function remember(p) {
  stmts.upsertStock.run(
    p.sku, p.name || null, p.price ?? null, p.currency || null, p.image || null,
    Number(p.quantity) || 0, now(),
  );
}

// Always ask the source of truth. The webhook's quantity is only a hint.
async function getStock(sku) {
  const p = await fetchJson(`${config.stockApiUrl}/${encodeURIComponent(sku)}`);
  remember({ ...p, sku: p.sku || sku });
  return { ...p, sku: p.sku || sku, quantity: Number(p.quantity) || 0, in_stock: Boolean(p.in_stock) && Number(p.quantity) > 0 };
}

let catalogueCache = { at: 0, items: [] };
async function getCatalogue() {
  if (Date.now() - catalogueCache.at < 60_000 && catalogueCache.items.length) return catalogueCache.items;
  try {
    const data = await fetchJson(config.stockApiUrl);
    const items = Array.isArray(data) ? data : Array.isArray(data.products) ? data.products : [];
    for (const p of items) if (p.sku) remember(p);
    catalogueCache = { at: Date.now(), items };
    return items;
  } catch (err) {
    console.warn('catalogue unavailable, using cache:', err.message);
    return catalogueCache.items.length ? catalogueCache.items : stmts.allStock.all();
  }
}

function cached(sku) {
  return stmts.getStock.get(sku) || null;
}

module.exports = { getStock, getCatalogue, cached };
