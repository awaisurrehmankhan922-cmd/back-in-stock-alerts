# Back-in-stock alerts

Customers ask to be emailed when a sold-out product returns. This service takes the request from an
embeddable form, verifies restock webhooks against the stock API, and emails each customer exactly once.

Zero npm dependencies: Node 22.13+ (built-in `http` and `node:sqlite`). One container, one SQLite file.

## Endpoints

| Route | What it does |
|---|---|
| `GET /embed` | Customer form (email + product). Designed for an iframe; pre-select with `?sku=...` |
| `POST /api/requests` | `{ email, sku }` → `201 created`, `200 exists` (already waiting), or `200 in_stock` (no need to wait) |
| `POST /webhooks/stock` | `{ event_id, sku, quantity }` with `X-Webhook-Secret`. Verifies stock, notifies waiting customers |
| `GET /admin` | Password-protected: every request, its status, when it was notified, attempts, recent webhooks |
| `GET /healthz` | Liveness check |

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `STOCK_API_URL` | yes | Stock API base. `GET {url}/{sku}` → `{ quantity, in_stock, ... }`, `GET {url}` → catalogue |
| `STOCK_API_KEY` | yes | Bearer token for the stock API |
| `RESEND_API_KEY` | yes | Bearer token for email |
| `RESEND_BASE_URL` | yes | Where to `POST /emails` (Resend format). Defaults to `https://api.resend.com` if unset |
| `WEBHOOK_SECRET` | yes | Expected `X-Webhook-Secret` header value |
| `ADMIN_PASSWORD` | yes | Protects `/admin` (HTTP Basic auth, any username) |
| `PORT` | no | Defaults to 3000 |
| `FROM_EMAIL`, `STORE_NAME`, `STORE_URL` | no | Email sender, store name and product-link base used in the email |
| `DATA_DIR` | no | Where the SQLite file lives. Defaults to `/data` if it exists, else `./data` |

## Run it

```bash
# Docker
docker build -t restock-alerts .
docker run -p 3000:3000 -v restock-data:/data \
  -e STOCK_API_URL=... -e STOCK_API_KEY=... -e RESEND_API_KEY=... -e RESEND_BASE_URL=... \
  -e WEBHOOK_SECRET=... -e ADMIN_PASSWORD=... restock-alerts

# Local (Node 22.13+)
cp .env.example .env   # fill in values, then:
set -a; . ./.env; set +a; npm start
```

Mount a volume at `/data` so requests survive container replacement. Without one, data survives
process restarts but not a new container.

## How customers get exactly one email

**No lost webhooks.** Every incoming `event_id` is inserted into a table with a primary key. If the same
event arrives twice, even in the same millisecond, the second insert fails and we answer `200 duplicate`
without doing anything. The sender sees success and stops retrying.

**No trusting the webhook.** The webhook's quantity is treated as a hint. Before emailing anyone we call
`GET {STOCK_API_URL}/{sku}`. If the stock API says 0, nobody is emailed (the test harness sends
"phantom" webhooks for exactly this). Wrong or missing `X-Webhook-Secret` is rejected with 401.

**No double sends.** Each waiting request is claimed with one atomic SQL update
(`open → sending`, `WHERE status = 'open'`). Only one caller can win that update, so two webhooks,
or a webhook plus the background worker, can never both send to the same person. The email request
also carries an `Idempotency-Key` of `restock-request-{id}`, so if our process dies after the provider
accepted the email but before we recorded it, the retry is deduplicated on their side.

**No missed sends.** If the email provider fails (the harness injects HTTP 500s), the row goes back to
`open` with a backoff (30s, 60s, 2m, ... up to 1h) and a background worker retries. After 8 attempts it
is marked `failed` and shown in the admin with a one-click retry. Every two minutes the worker also
re-checks the stock API for every SKU that still has open requests, so a webhook that never arrived
(network down, app down) is caught by the next poll.

**Survives restarts.** State is in SQLite (WAL mode) on disk. On boot the worker runs immediately:
rows stuck in `sending` for more than two minutes are released back to `open` (safe because of the
idempotency key), due retries run, and a full reconciliation pass runs. In testing: app killed, product
restocked while it was down (webhook lost), app restarted, customer emailed once within seconds.

**No duplicate requests.** A partial unique index on `(email, sku) WHERE status IN ('open','sending')`
means five simultaneous identical submissions create one row; the others get `200 exists`.

**No consumed-but-unprocessed events.** If the stock API is unreachable when a webhook arrives, the
event record is removed again and we return 500, so the sender's retry is processed as new rather than
dismissed as a duplicate.

## Tests

`npm test` runs an end-to-end suite (`test/exactly-once.test.js`) against a mock of the stock and email
APIs that reproduces the harness's behaviour: duplicate delivery at the same instant, replayed events,
phantom restocks, injected email failures, wrong secrets, racing submissions, a stock API outage, and a
kill-and-restart with a webhook lost while down. Nine tests, no dependencies beyond Node's test runner.

Also verified by hand against a local copy of the challenge harness: duplicate webhook → 2 customers,
2 emails; injected 500 → retried after 30s, 1 accepted email; kill, restock while down, restart → 1 email.

## Built with

Claude Code (planning, implementation and test scripts), reviewed and tested by hand against a local
copy of the challenge harness.
