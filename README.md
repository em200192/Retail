# Retail SaaS

Multi-tenant POS, stock and back-office platform for independent UK convenience stores and
supermarkets. See [CLAUDE.md](CLAUDE.md) for the product rules, database golden rules and
build phases.

## What's here

| Path | What |
|---|---|
| `db/migrations/` | PostgreSQL 16 schema: RLS on every tenant table, composite tenant FKs, append-only stock ledger, audit log |
| `db/migrate.sh` | Applies pending migrations (tracked in `meta.schema_migrations`), always re-applies `099_security.sql` |
| `db/setup-dev.sh` | Creates a database plus the `retail_api` / `retail_worker` login roles |
| `packages/shared` | Code shared by API and POS device: money & VAT rounding, UUIDv7, receipt numbers, scale barcodes, permission codes & limit rules |
| `apps/api` | Fastify API + background worker |
| `apps/web` | Next.js back-office for owners and managers |
| `apps/pos` | Expo (React Native) till & staff app — runs on iPad/Android and in a browser |

### API (Phase 1 core + Phase 2 purchasing)

- **Auth** — owner signup (creates tenant, trial, default roles/limits/price levels, first branch), email login across shops, device registration, staff PIN login on tills.
- **Org & access** — branches, devices, tills, roles, permissions, numeric limits, per-person overrides, staff.
- **Catalogue & pricing** — categories with VAT/age defaults, products, barcodes (PMP, case, PLU), scale-barcode rules, price levels, price history (new rows only), shared UK catalogue lookup, `/v1/scan`.
- **Stock** — ledger-only changes: receipts, adjustments (manager PIN over limit), waste, transfers, stocktakes, expiry batches, low stock.
- **POS** — till sessions, no-sale / paid-out with limits and approvals, cash-up with frozen Z report, void.
- **Offline sync** — `POST /v1/sync/push` validates and stores device-generated sales/refunds idempotently, one transaction per record; `GET /v1/sync/pull` gives the till catalogue, prices, promotions and staff permissions for offline use.
- **Purchasing** — suppliers and supplier codes, staff "we need" requests, shopping list (incl. low-stock generation), purchase orders, supplier invoices with Claude-vision OCR → match (supplier code → barcode → fuzzy name) → review → post to stock, learning supplier codes.
- **Reports & finance** — daily branch summaries, top products, staff activity (loss prevention), MTD 9-box VAT draft.
- **Worker** — transactional outbox publisher (`FOR UPDATE SKIP LOCKED`, exponential backoff), invoice OCR job, notifications (email now), delivery-platform stock push through adapters (mock until partner access), daily summary refresh.

## Run it

```bash
npm install
docker compose up -d                                   # or any PostgreSQL 16+
ADMIN_URL=postgres://postgres:postgres@localhost/postgres DB_NAME=retail ./db/setup-dev.sh
cp .env.example .env                                   # fill in JWT_SECRET (and ANTHROPIC_API_KEY for OCR)
set -a; . ./.env; set +a
npm run seed:demo  # optional: demo corner shop — prints logins, PINs and a till pairing code
npm run dev        # API on :3000
npm run worker     # background jobs
npm run web        # back-office on http://localhost:3001  (owner@cornershop.demo / demo-password-1)
npm run pos        # till app in the browser; paste the pairing code, PINs e.g. Sam 1111, Mo 2222
```

For the till in a browser, start the API with `CORS_ORIGINS=http://localhost:8081` (Expo's web port).

## Test it

```bash
npm run typecheck
TEST_ADMIN_URL=postgres://postgres:postgres@localhost/postgres npm test
psql postgres://postgres:postgres@localhost/retail_smoke -f db/tests/smoke_test.sql   # fresh DB, as superuser
```

The API tests create a fresh `retail_test` database, apply the real migrations, and connect
through login roles that are members of `app_runtime` / `app_worker` — so row-level security
is genuinely enforced in every test.
