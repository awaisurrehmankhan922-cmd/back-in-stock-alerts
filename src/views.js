'use strict';

const config = require('./config');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC' : '');

const baseCss = `
:root{--bg:#f6f7f9;--card:#fff;--text:#111827;--muted:#6b7280;--line:#e5e7eb;--accent:#111827;--accent-text:#fff;--ok:#059669;--warn:#b45309;--bad:#b91c1c;--focus:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#0b0f14;--card:#111827;--text:#f3f4f6;--muted:#9ca3af;--line:#1f2937;--accent:#f3f4f6;--accent-text:#111827;--ok:#34d399;--warn:#fbbf24;--bad:#f87171;--focus:#60a5fa}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px}
label{display:block;font-size:14px;font-weight:600;margin:0 0 6px}
input,select{width:100%;font:inherit;color:var(--text);background:transparent;border:1px solid var(--line);border-radius:10px;padding:12px 14px;min-height:48px}
input:focus,select:focus,button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
button{font:inherit;font-weight:700;border:0;border-radius:10px;padding:14px 18px;min-height:48px;background:var(--accent);color:var(--accent-text);cursor:pointer;width:100%}
button[disabled]{opacity:.6;cursor:progress}
.muted{color:var(--muted)}
.small{font-size:13px}
`;

function embedPage(products) {
  const options = products
    .map((p) => `<option value="${esc(p.sku)}">${esc(p.name || p.sku)}${p.in_stock ? '' : ' (sold out)'}</option>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Get notified when it's back</title><style>${baseCss}
body{background:transparent;padding:4px}
.card{max-width:440px;margin:0 auto}
h1{font-size:20px;margin:0 0 6px}
p.lead{margin:0 0 20px;color:var(--muted);font-size:15px}
.field{margin-bottom:14px}
.msg{display:none;border-radius:12px;padding:16px;margin-top:4px}
.msg.ok{display:block;background:rgba(5,150,105,.1);color:var(--ok)}
.msg.info{display:block;background:rgba(37,99,235,.1);color:var(--focus)}
.msg.bad{display:block;background:rgba(185,28,28,.1);color:var(--bad)}
.msg strong{display:block;font-size:17px;margin-bottom:4px}
.fine{margin:14px 0 0;font-size:12px;color:var(--muted);text-align:center}
</style></head><body>
<div class="card">
  <form id="f" novalidate>
    <h1>Sold out? We'll email you when it's back.</h1>
    <p class="lead">One email, the moment it returns. No newsletter, no spam.</p>
    <div class="field"><label for="sku">Product</label>
      <select id="sku" name="sku" required><option value="">Choose a product</option>${options}<option value="__other">Enter a SKU manually</option></select>
      <input id="skuText" name="skuText" placeholder="SKU, e.g. TEE-ORG-WHT-M" style="display:none;margin-top:8px" autocomplete="off">
    </div>
    <div class="field"><label for="email">Email address</label>
      <input id="email" name="email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" required></div>
    <button id="btn" type="submit">Notify me</button>
    <div id="msg" class="msg" role="status" aria-live="polite"></div>
    <p class="fine">We only use your email for this one alert.</p>
  </form>
</div>
<script>
(function(){
  var f=document.getElementById('f'),sel=document.getElementById('sku'),txt=document.getElementById('skuText'),email=document.getElementById('email'),btn=document.getElementById('btn'),msg=document.getElementById('msg');
  var params=new URLSearchParams(location.search);var pre=params.get('sku');
  if(pre){var found=false;for(var i=0;i<sel.options.length;i++){if(sel.options[i].value===pre){sel.value=pre;found=true;}}if(!found){sel.value='__other';txt.style.display='block';txt.value=pre;}}
  sel.addEventListener('change',function(){txt.style.display=sel.value==='__other'?'block':'none';});
  function show(kind,title,body){msg.className='msg '+kind;msg.innerHTML='<strong>'+title+'</strong>'+body;}
  f.addEventListener('submit',async function(e){
    e.preventDefault();
    var sku=sel.value==='__other'?txt.value.trim():sel.value;
    if(!sku){show('bad','Choose a product','Pick a product or enter its SKU.');return;}
    if(!email.checkValidity()){show('bad','Check your email address','That doesn\\'t look like a valid email.');return;}
    btn.disabled=true;btn.textContent='Saving…';msg.className='msg';
    try{
      var r=await fetch('/api/requests',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:email.value.trim(),sku:sku})});
      var d=await r.json().catch(function(){return{}});
      if(r.ok&&d.status==='in_stock'){show('info','Good news, it\\'s in stock right now','No need to wait. Head back to the product page to grab it.');}
      else if(r.ok&&d.status==='exists'){show('info','You\\'re already on the list','We\\'ll email '+email.value.trim()+' as soon as '+(d.product_name||sku)+' is back.');}
      else if(r.ok){show('ok','You\\'re on the list','We\\'ll email '+email.value.trim()+' the moment '+(d.product_name||sku)+' is back in stock.');f.reset();txt.style.display='none';}
      else{show('bad','Something went wrong',(d.error||'Please try again in a moment.'));}
    }catch(err){show('bad','Connection problem','Please check your connection and try again.');}
    btn.disabled=false;btn.textContent='Notify me';
  });
})();
</script></body></html>`;
}

function outcomeText(e) {
  if (!e.outcome) return e.verified_qty == null ? 'Processing' : '';
  try {
    const o = JSON.parse(e.outcome);
    if (!o.verified_quantity) return 'Ignored: stock API says sold out (phantom or already gone)';
    const parts = [];
    if (o.notified) parts.push(`${o.notified} notified`);
    if (o.retry) parts.push(`${o.retry} queued for retry`);
    if (o.failed) parts.push(`${o.failed} failed`);
    if (o.skipped) parts.push(`${o.skipped} already handled`);
    return parts.length ? parts.join(', ') : 'Verified in stock, nobody waiting';
  } catch { return e.outcome; }
}

const badge = (status) => {
  const map = { open: ['Waiting', 'var(--warn)'], sending: ['Sending', 'var(--focus)'], notified: ['Notified', 'var(--ok)'], failed: ['Failed', 'var(--bad)'] };
  const [label, color] = map[status] || [status, 'var(--muted)'];
  return `<span style="color:${color};font-weight:700">${esc(label)}</span>`;
};

function adminPage({ requests, counts, events, filter, q: query = '', page, hasMore }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const stat = (label, n, color) => `<div class="stat"><div class="n" style="color:${color || 'inherit'}">${n}</div><div class="muted small">${label}</div></div>`;
  const q = (f, p) => `/admin?status=${encodeURIComponent(f)}&page=${p}${query ? `&q=${encodeURIComponent(query)}` : ''}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Restock alerts · Admin</title><style>${baseCss}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin:18px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}.stat .n{font-size:26px;font-weight:800}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 12px}.tabs a{text-decoration:none;padding:6px 12px;border-radius:999px;border:1px solid var(--line);font-size:14px}.tabs a.on{background:var(--accent);color:var(--accent-text);border-color:var(--accent)}
.card{padding:0;overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line);vertical-align:top;white-space:nowrap}th{color:var(--muted);font-weight:600;font-size:13px}
td.wrap{white-space:normal;max-width:360px}code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}
.pager{display:flex;gap:10px;margin:12px 0}.pager a{text-decoration:none;border:1px solid var(--line);padding:6px 12px;border-radius:8px;font-size:14px}
button{width:auto;padding:8px 12px;min-height:0;font-size:13px}
</style></head><body><main>
<h1>Restock alerts</h1><p class="muted">Who's waiting, who's been told, and when. Refreshes on reload.</p>
<div class="stats">${stat('Total requests', total)}${stat('Waiting', counts.open || 0, 'var(--warn)')}${stat('Notified', counts.notified || 0, 'var(--ok)')}${stat('Failed', counts.failed || 0, 'var(--bad)')}${stat('In flight', counts.sending || 0, 'var(--focus)')}</div>
<div class="tabs">${['all', 'open', 'notified', 'failed'].map((f) => `<a class="${filter === f && !query ? 'on' : ''}" href="/admin?status=${f}&page=1">${f === 'all' ? 'All' : f === 'open' ? 'Waiting' : f[0].toUpperCase() + f.slice(1)}</a>`).join('')}
<form method="get" action="/admin" style="display:flex;gap:6px;margin-left:auto"><input name="q" value="${esc(query)}" placeholder="Search email, SKU or product" style="min-height:0;padding:6px 10px;width:260px;font-size:14px"><button>Search</button></form></div>
${query ? `<p class="muted small">Showing results for "${esc(query)}". <a href="/admin">Clear</a></p>` : ''}
<div class="card"><table><thead><tr><th>Requested</th><th>Customer</th><th>Product</th><th>Status</th><th>Notified</th><th>Attempts</th><th>Notes</th></tr></thead><tbody>
${requests.map((r) => `<tr><td>${fmt(r.created_at)}</td><td>${esc(r.email)}</td><td>${esc(r.product_name || r.sku)}<div class="muted small"><code>${esc(r.sku)}</code></div></td><td>${badge(r.status)}</td><td>${r.notified_at ? fmt(r.notified_at) : '<span class="muted">—</span>'}</td><td>${r.attempts}</td><td class="wrap small muted">${r.last_error ? esc(r.last_error) : ''}${r.status === 'failed' ? ` <form method="post" action="/admin/requests/${r.id}/retry" style="display:inline"><button>Retry</button></form>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No requests yet.</td></tr>'}
</tbody></table></div>
<div class="pager">${page > 1 ? `<a href="${q(filter, page - 1)}">Newer</a>` : ''}${hasMore ? `<a href="${q(filter, page + 1)}">Older</a>` : ''}</div>
<h2>Recent stock webhooks</h2>
<div class="card"><table><thead><tr><th>Received</th><th>Event</th><th>SKU</th><th>Claimed qty</th><th>Verified qty</th><th>Outcome</th></tr></thead><tbody>
${events.map((e) => `<tr><td>${fmt(e.received_at)}</td><td><code>${esc(e.event_id)}</code></td><td><code>${esc(e.sku)}</code></td><td>${e.quantity}</td><td>${e.verified_qty ?? '<span class="muted">…</span>'}</td><td class="wrap small muted">${esc(outcomeText(e))}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">None yet.</td></tr>'}
</tbody></table></div>
<p class="muted small" style="margin-top:28px">Embed the form anywhere with <code>&lt;iframe src="/embed?sku=SKU" width="100%" height="420" style="border:0"&gt;&lt;/iframe&gt;</code>. Store: ${esc(config.storeName)}.</p>
</main></body></html>`;
}

module.exports = { embedPage, adminPage, esc };
