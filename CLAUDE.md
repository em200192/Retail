# Retail SaaS — UK convenience stores & supermarkets

Multi-tenant SaaS: POS, inventory, OCR purchasing, pricing levels, HR-lite,
tasks, training, AI insights, finance/VAT, delivery-platform integrations.
Target users: independent UK grocery / convenience shop owners and their staff.
Product principles: **simple to use, instant access to information, works offline.**

---

## Stack (recommended)

| Layer | Choice | Why |
|---|---|---|
| Database | PostgreSQL 16+ (UK region, e.g. AWS eu-west-2 London) | RLS, composite keys, UK GDPR data residency |
| API | TypeScript + Fastify, Kysely (or raw SQL via `postgres`) | Full control over transactions and `set_config`; ORMs fight RLS |
| Jobs / queue | pg-boss (Postgres-based) | No extra infra; outbox worker, forecasts, emails |
| Web back-office | Next.js | Owner / manager dashboards |
| POS & staff app | Expo (React Native) + SQLite | Offline-first, same TypeScript |
| Files | S3-compatible storage (London region), signed URLs | Invoices, photos, RTW documents |
| Email | Resend / Postmark | Notifications now; WhatsApp later |
| OCR + AI | Claude API (vision for invoices, tool use for Q&A) | |
| Payments | Adapter: Dojo / SumUp / Stripe Terminal | Card terminal integration later |

---

## Database — golden rules (DO NOT BREAK)

Schema lives in `db/migrations/` (run `db/migrate.sh`). Tests in `db/tests/`.

1. **Tenant context on every transaction.** First statements of each DB transaction:
   ```sql
   SELECT set_config('app.tenant_id', $1, true);  -- true = transaction-local (safe with PgBouncer)
   SELECT set_config('app.staff_id',  $2, true);
   SELECT set_config('app.user_id',   $3, true);
   SELECT set_config('app.device_id', $4, true);
   ```
   `tenant_id` comes from the authenticated session — **never** from the request body.
   Wrap this in one helper (`withTenant(ctx, fn)`); no query runs outside it.
2. **Roles:** the API connects as a login role that is a member of `app_runtime`
   (RLS enforced). Background jobs use `app_worker` (bypasses RLS) and must filter
   `tenant_id` explicitly. Migrations run as the owner role.
3. **Every tenant table:** `tenant_id` first, `PRIMARY KEY (tenant_id, id)`, and all
   references are composite FKs `(tenant_id, x_id)`. New tables must follow this,
   then re-run `099_security.sql` (it auto-applies RLS + updated_at triggers).
4. **Money = integer pence (`bigint`, `_pence` suffix).** Never floats. Quantities =
   `numeric(14,3)` (weighed goods). Do rounding in one shared function.
5. **Stock only via `stock_movements`** (append-only ledger). `stock_levels` is
   maintained by trigger; the API cannot write it. Corrections = new movement.
   Available stock = `v_stock_availability` (on hand − active online reservations).
6. **Prices only via `resolve_price()`**: requested level > default level,
   branch > all branches, best quantity break, newest. Price changes = new row
   with `valid_from`, never update old rows.
7. **PMP:** if the scanned barcode is PMP, charge `LEAST(resolved price, pmp_price)`.
   The DB rejects any line above the printed price.
8. **VAT snapshot:** every sale line stores `vat_code`, `vat_rate_percent`,
   `vat_pence` at time of sale (use `vat_rate_on()`). Never recompute history.
9. **Offline-first IDs:** sales, sale lines, payments, refunds, time entries, age
   checks get UUIDs generated **on the device** (prefer UUIDv7). Sync =
   `INSERT ... ON CONFLICT DO NOTHING` → retries are safe.
   Receipt number `{branch_code}-{device_no}-{seq}` is generated offline.
10. **Training mode sales** (`is_training = true`) never touch stock or reports.
11. **Ledgers are append-only:** `stock_movements`, `audit_log`. Sensitive tables are
    audited automatically by trigger (secrets stripped).
12. **Secrets never in tables:** integration tokens live in a secrets manager;
    the table stores `credentials_secret_ref`. NI numbers encrypted at app layer.

---

## Permissions model

- Permission codes are seeded in `100_seed.sql` (`pos.refund`, `prices.edit` ...).
  Code must reference these exact strings — add new ones there first.
- Effective permissions: `v_staff_permissions` (role + per-person overrides).
- Numeric limits: `v_staff_limits` / `staff_limit()` (max discount %, max refund £,
  voids per shift ...). `NULL` limit = not allowed without approval.
- Over-limit action → manager enters PIN on the till → record in `pos_approvals`
  (outcome `approved` / `denied`; within-limit = `self_authorised`).
- Check permissions **server-side** on every endpoint, and also on the device for
  offline use (sync the effective permission set + limits to the device).
- `create_tenant_defaults(tenant_id)` creates Owner/Manager/Supervisor/Cashier/Stock
  roles, limits, price levels, KPI weights and expense categories for a new shop.

---

## Modules & key tables

| Module | Tables |
|---|---|
| Platform / billing | `tenants`, `plans`, `subscriptions`, `users` |
| Org & access | `branches`, `roles`, `role_permissions`, `role_limits`, `staff`, `staff_*_overrides`, `devices` |
| Catalogue | `categories`, `products`, `product_barcodes` (PMP, case, PLU), `barcode_rules` (scale barcodes), `catalog_products` (shared UK catalogue) |
| Pricing | `price_levels`, `product_prices`, `promotions` (+ groups for meal deals) |
| Stock | `stock_movements`, `stock_levels`, `stock_batches` (expiry), `stock_transfers`, `stocktakes` |
| Purchasing | `purchase_requests` (staff "we need"), `purchase_lists` + items (shopping list), `purchase_orders`, `supplier_products` (supplier code → product) |
| OCR invoices | `supplier_invoices`, `supplier_invoice_lines` (duplicate invoice blocked) |
| POS | `tills`, `till_sessions` (cash-up, Z report), `cash_movements`, `sales`, `sale_lines`, `sale_discounts`, `sale_payments`, `refunds`, `pos_approvals`, `age_checks` (Challenge 25) |
| Customers | `customers`, `loyalty_transactions`, `receipt_deliveries` |
| HR-lite | `shifts` (rota), `time_entries`, `leave_*`, `pay_rates`, `pay_periods`, `timesheet_lines`, `staff_documents` (RTW) |
| Tasks | `task_templates` (recurring, RRULE), `tasks`, `task_checklist_items` |
| Training & performance | `quizzes` …, `performance_kpi_weights`, `manager_ratings`, `performance_snapshots` |
| Finance | `expenses`, `vat_returns` (MTD 9 boxes), `daily_branch_summaries`, `product_daily_sales` |
| Channels | `integration_connections`, `external_product_links`, `orders`, `order_lines`, `stock_reservations`, `service_transactions` |
| Async | `outbox_events`, `webhook_inbox`, `outbound_messages`, `notification_preferences` |
| AI | `demand_forecasts`, `ai_insights`, `ai_queries` |
| Compliance | `equipment`, `temperature_logs`, `cameras`, `label_print_jobs`, `audit_log` |

---

## Integrations (build later — design now)

- One adapter interface per category, e.g.:
  ```ts
  interface DeliveryChannelAdapter {
    pushCatalog(items): Promise<void>;
    pushStock(changes): Promise<void>;
    acceptOrder(externalId): Promise<void>;
    updateOrderStatus(externalId, status): Promise<void>;
    parseWebhook(req): ParsedEvent;   // verify signature first
  }
  ```
  Implementations: `uber_eats`, `deliveroo`, `just_eat`, `snappy_shopper`, `own_store`.
  Same pattern for `AccountingAdapter` (Xero/QuickBooks/Sage), `PaymentTerminalAdapter`,
  `PayrollExportAdapter`, `MessageChannelAdapter`.
- **Outbound:** business change + `outbox_events` row in the SAME transaction; worker
  publishes with `FOR UPDATE SKIP LOCKED`, retries with backoff via `available_at`.
- **Inbound:** webhooks → `webhook_inbox` (idempotent on `provider + event_id`) →
  worker resolves tenant via `integration_connections.external_store_id` → processes.
- Uber Eats / Deliveroo API access requires partner approval — use a **mock adapter**
  until approved so the whole order flow is testable end-to-end.

## Notifications

- Channel-agnostic: enqueue into `outbound_messages` with `channel` + `template_code`.
- **Now: `email` (+ `push`).** WhatsApp later = new `MessageChannelAdapter`, no schema change.
- Daily summary email at shop closing time (branch timezone): sales, top sellers,
  low stock, staff requests waiting, AI insights.

## AI rules

- OCR: Claude vision → structured JSON (supplier, invoice no, lines) → match lines by
  `supplier_products.supplier_code` first, then barcode, then fuzzy name (pg_trgm).
  Low confidence → `needs_review`. Human confirms → save mapping (`ocr_confirmed`)
  so the next invoice auto-matches. Unknown barcode → look up `catalog_products`,
  then Open Food Facts.
- Natural-language Q&A: the model calls **predefined report tools** (sales by
  product/period, stock, margins ...) that run through `withTenant`. Never let the
  model write raw SQL against production.
- Forecasts use `product_daily_sales` (incl. `was_out_of_stock` to avoid
  under-forecasting), UK bank holidays, weather, local events.
- Performance scores are **advisory only** (UK GDPR Art. 22). Compare staff only
  within the same `peer_group` (shift type). Staff are told what is measured.

## UK compliance checklist

- VAT: S 20% / R 5% / Z 0% / E exempt per product; MTD-ready 9-box return.
- Challenge 25 prompt for any product with `min_age`; log in `age_checks`.
- PMP: never charge above printed price.
- Payroll: we export hours & gross pay only — PAYE/NI/pension in payroll software.
  Flag pay below National Living Wage (`statutory_wage_rates`, update every April).
- Right to Work documents with expiry alerts; restrict to `staff.documents`.
- Food safety: fridge temperature logs + opening/closing checklists.
- UK GDPR: data in UK region, customer marketing consent, retention policy,
  data export & deletion per tenant.

---

## Build phases

1. **Core:** auth, tenants, branches, roles/permissions, products, barcodes, price levels,
   VAT, POS (offline), stock ledger, till cash-up, basic reports.
2. **Purchasing:** OCR invoices, supplier code learning, shopping list, staff requests,
   low-stock alerts, expiry tracking, promotions, labels.
3. **People:** clock in/out, rota, timesheets export, tasks, quizzes, performance.
4. **Intelligence:** forecasts, insights, NL Q&A, daily email summary, supplier price
   comparison, network benchmarks.
5. **Channels:** delivery platforms, own store, accounting, card terminals, WhatsApp.

## Repository layout

```
db/migrations/        schema (tracked by db/migrate.sh in meta.schema_migrations)
db/setup-dev.sh       database + retail_api (app_runtime) / retail_worker (app_worker) login roles
packages/shared/      shared with the POS device: money/VAT rounding, uuidv7, receipt numbers,
                      scale barcodes, PERMISSIONS/LIMITS + evaluateLimit()/evaluateDiscount()
apps/api/src/
  lib/db.ts           Db.withTenant() (the ONLY way to touch tenant data) and Db.asWorker()
  lib/authz.ts        loadActor(), requirePermission(), branch access, authoriseAction() (manager PIN)
  lib/stock.ts        postMovements(): the ONLY way stock changes (+ stock.changed outbox event)
  lib/outbox.ts       enqueueEvent(): call in the same transaction as the change
  routes/             HTTP endpoints (all under /v1)
  services/sync.ts    offline sale/refund ingestion + validation
  services/invoices.ts OCR line matching, review, posting, supplier-code learning
  integrations/       OCR (Claude), file store, adapter interfaces + mocks
  worker/             outbox publisher, notifications, daily summaries
apps/api/test/        integration tests against a real, fresh PostgreSQL
```

## Commands

```bash
npm install
ADMIN_URL=postgres://postgres@localhost/postgres DB_NAME=retail ./db/setup-dev.sh
DATABASE_URL=postgres://localhost/retail ./db/migrate.sh        # apply pending migrations
psql postgres://localhost/retail -f db/tests/smoke_test.sql   # as superuser, fresh DB
npm run typecheck && npm test                                  # TEST_ADMIN_URL = superuser URL
npm run dev / npm run worker
```

## API conventions (decided — keep consistent)

- Every handler runs inside `tenantTx()` -> `Db.withTenant()`, which also does
  `set_config('role','app_runtime',true)` so RLS applies even if the login role is privileged.
  Auth, signup and jobs use `Db.asWorker()` and MUST filter `tenant_id` explicitly.
- Back-office tokens (`kind: user`) and till tokens (`kind: pos`, carry device + branch) are
  HS256 JWTs. Passwords and PINs are scrypt; device secrets are 256-bit random + SHA-256.
- Owners can work in every branch; everyone else needs `staff_branch_access`.
- **Limit rule** (`evaluateLimit`): owner = unrestricted; NULL limit = needs approval;
  else value <= limit. Discounts: percent cap required, amount cap applied on top when set.
  An approver must hold `pos.approve` + the action permission, cannot approve themselves, and is
  bound by their own *explicit* cap (per-shift counters don't apply to the approver).
- **Sale payload** (device -> `/v1/sync/push`): quantity in base units (case barcode = N units);
  `line_total = round(unit_price × qty) − line_discount − promotion_discount`; basket discounts are
  apportioned onto lines with `apportion()` and also recorded in `sale_discounts`;
  `subtotal = Σ round(unit_price × qty)`, `discount = Σ line+promo discounts`, `total = Σ line_total`,
  `vat = Σ line vat`, all over non-voided lines. VAT per line = `vatFromGross()` (half-up), rate from
  `vat_rate_on()` on the sale date. Age-restricted lines need a passing age check.
  Each record is its own transaction; results are `created` | `duplicate` | `rejected`.
- Refunds: unreceipted always need approval; damaged returns (`restock=false`) post refund + waste.
- Weighed goods: price lookups use `max(qty, 1)` for quantity breaks.
- OCR matching: supplier code (1.0) > barcode (0.97) > fuzzy name (capped at 0.85, so a human always
  confirms). Posting saves supplier code -> product with `match_source = 'ocr_confirmed'`.
- Money is `number` of pence in TS (int8 parsed with a safe-integer check); DATE columns stay strings.

## Status

Built: Phase 1 core API and most of Phase 2 (purchasing, OCR invoices, low stock, expiry,
labels table only). Not built yet: web back-office (Next.js), POS/staff app (Expo + SQLite),
promotions engine on the device (promotions are synced, not applied server-side), HR/tasks/
quizzes (Phase 3), forecasts/insights/NL Q&A (Phase 4), real channel/accounting/payment adapters
(Phase 5), S3 file store, real email provider, rate limiting on PIN login.

## Scaling notes (later, not now)

- Partition `sales`, `sale_lines`, `stock_movements` by month when they pass ~100M rows.
- Every PK starts with `tenant_id`, so the schema is ready for Citus sharding by tenant.
- Create monthly `audit_log` partitions with pg_partman.
