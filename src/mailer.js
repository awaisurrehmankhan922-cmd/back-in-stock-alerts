'use strict';

const config = require('./config');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function money(price, currency) {
  if (price == null) return '';
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency || 'GBP' }).format(price);
  } catch {
    return `${currency || ''} ${price}`;
  }
}

function productUrl(sku) {
  return config.storeUrl ? `${config.storeUrl}/products/${encodeURIComponent(sku)}` : '#';
}

function renderEmail({ product, email }) {
  const name = product.name || product.sku;
  const price = money(product.price, product.currency);
  const url = productUrl(product.sku);
  const store = config.storeName;
  const text = [
    `Good news: ${name} is back in stock at ${store}.`,
    price ? `Price: ${price}` : '',
    `Shop now: ${url}`,
    '',
    `You asked us to let you know when this item returned. This is the only email you'll get about it.`,
  ].filter((l) => l !== null).join('\n');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${esc(name)} is back</title>
<style>
  body{margin:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#111827}
  .wrap{max-width:560px;margin:0 auto;padding:24px 12px}
  .card{background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb}
  .hero img{display:block;width:100%;height:auto}
  .body{padding:28px 24px}
  .eyebrow{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#059669;font-weight:700;margin:0 0 8px}
  h1{font-size:24px;line-height:1.25;margin:0 0 12px}
  p{font-size:16px;line-height:1.55;margin:0 0 16px;color:#374151}
  .price{font-size:18px;font-weight:700;color:#111827;margin:0 0 20px}
  .btn{display:block;text-align:center;background:#111827;color:#fff!important;text-decoration:none;font-weight:700;font-size:16px;padding:16px 20px;border-radius:12px}
  .foot{font-size:12px;color:#6b7280;text-align:center;padding:20px 12px 0;line-height:1.5}
  @media (prefers-color-scheme:dark){body{background:#0b0f14;color:#e5e7eb}.card{background:#111827;border-color:#1f2937}h1,.price{color:#f9fafb}p{color:#d1d5db}.btn{background:#f9fafb;color:#111827!important}}
</style></head>
<body><div class="wrap">
  <div class="card">
    ${product.image ? `<div class="hero"><a href="${esc(url)}"><img src="${esc(product.image)}" width="560" alt="${esc(name)}"></a></div>` : ''}
    <div class="body">
      <p class="eyebrow">Back in stock</p>
      <h1>${esc(name)} is available again</h1>
      <p>You asked us to tell you the moment this came back. It just did, and stock is limited, so it may not last long.</p>
      ${price ? `<p class="price">${esc(price)}</p>` : ''}
      <a class="btn" href="${esc(url)}">Shop ${esc(name)}</a>
    </div>
  </div>
  <p class="foot">Sent by ${esc(store)} to ${esc(email)} because you requested a one-time restock alert for SKU ${esc(product.sku)}.<br>This is the only email you'll receive about this item.</p>
</div></body></html>`;

  return { subject: `${name} is back in stock`, html, text };
}

// Send through the Resend API (or whatever RESEND_BASE_URL points at).
// idempotencyKey makes a retried send safe: the same key can never produce two emails.
async function sendRestockEmail({ to, product, idempotencyKey }) {
  const { subject, html, text } = renderEmail({ product, email: to });
  const res = await fetch(`${config.resendBaseUrl}/emails`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.resendApiKey}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({ from: config.fromEmail, to: [to], subject, html, text }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `Email provider returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body.id || null;
}

module.exports = { sendRestockEmail, renderEmail };
