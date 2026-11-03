-- =====================================================================
-- 002_platform.sql
-- SaaS platform tables and GLOBAL reference data (not tenant-scoped).
-- =====================================================================

CREATE TABLE plans (
  id                   text PRIMARY KEY,                 -- 'starter', 'pro', 'multi_store'
  name                 text NOT NULL,
  monthly_price_pence  bigint NOT NULL CHECK (monthly_price_pence >= 0),
  max_branches         int,
  max_devices          int,
  features             jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name               text NOT NULL,
  trading_name             text,
  company_number           text,                          -- Companies House
  vat_number               text,
  vat_registered           boolean NOT NULL DEFAULT true,
  vat_scheme               text NOT NULL DEFAULT 'standard'
                           CHECK (vat_scheme IN ('standard','flat_rate','cash_accounting','annual_accounting')),
  flat_rate_percent        numeric(5,2),
  country_code             char(2) NOT NULL DEFAULT 'GB',
  currency                 char(3) NOT NULL DEFAULT 'GBP',
  default_locale           text NOT NULL DEFAULT 'en-GB',
  timezone                 text NOT NULL DEFAULT 'Europe/London',
  status                   text NOT NULL DEFAULT 'trial'
                           CHECK (status IN ('trial','active','past_due','suspended','cancelled')),
  -- Opt-in for anonymised network price benchmarks
  share_anonymous_data     boolean NOT NULL DEFAULT false,
  data_sharing_consent_at  timestamptz,
  settings                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (vat_scheme <> 'flat_rate' OR flat_rate_percent IS NOT NULL)
);

CREATE TABLE subscriptions (
  tenant_id                 uuid NOT NULL REFERENCES tenants(id),
  id                        uuid NOT NULL DEFAULT gen_random_uuid(),
  plan_id                   text NOT NULL REFERENCES plans(id),
  status                    text NOT NULL
                            CHECK (status IN ('trialing','active','past_due','paused','cancelled')),
  billing_provider          text NOT NULL DEFAULT 'stripe',
  external_customer_id      text,
  external_subscription_id  text,
  trial_ends_at             timestamptz,
  current_period_end        timestamptz,
  cancel_at                 timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX subscriptions_one_live_uq ON subscriptions (tenant_id)
  WHERE status IN ('trialing','active','past_due','paused');

-- Global login identity. One person can belong to several tenants
-- (e.g. a manager who works for two shop owners) through staff.user_id.
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext UNIQUE,
  phone              text,
  full_name          text NOT NULL,
  password_hash      text,
  auth_provider      text NOT NULL DEFAULT 'password'
                     CHECK (auth_provider IN ('password','google','apple','microsoft','magic_link')),
  locale             text NOT NULL DEFAULT 'en-GB',
  mfa_enabled        boolean NOT NULL DEFAULT false,
  is_platform_admin  boolean NOT NULL DEFAULT false,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Catalogue of every permission the code understands (seeded in 100_seed.sql).
CREATE TABLE permissions (
  code         text PRIMARY KEY,          -- 'pos.refund'
  module       text NOT NULL,             -- 'pos'
  description  text NOT NULL
);

-- Numeric limits attached to roles/staff (max discount %, max refund £ ...).
CREATE TABLE limit_definitions (
  code         text PRIMARY KEY,          -- 'pos.discount.max_percent'
  unit         text NOT NULL CHECK (unit IN ('percent','pence','count')),
  description  text NOT NULL
);

-- UK VAT rates with history, so a future rate change never rewrites old sales.
CREATE TABLE vat_rates (
  code          text NOT NULL CHECK (code IN ('S','R','Z','E')),  -- Standard, Reduced, Zero, Exempt
  rate_percent  numeric(5,2) NOT NULL CHECK (rate_percent >= 0),
  name          text NOT NULL,
  valid_from    date NOT NULL,
  valid_to      date,
  PRIMARY KEY (code, valid_from),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

-- National Minimum / Living Wage bands, used to flag underpayment.
-- Seed from gov.uk each April.
CREATE TABLE statutory_wage_rates (
  age_band        text NOT NULL CHECK (age_band IN ('21_plus','18_20','16_17','apprentice')),
  hourly_pence    bigint NOT NULL CHECK (hourly_pence > 0),
  effective_from  date NOT NULL,
  PRIMARY KEY (age_band, effective_from)
);

-- Wholesalers shared across all tenants (Booker, Bestway, Costco ...).
CREATE TABLE global_suppliers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL UNIQUE,
  website             text,
  invoice_parser_key  text,               -- which OCR template / prompt to use
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- The ready-made UK product catalogue (barcode -> name, image, VAT, PMP).
-- Tenants copy from here when they scan an unknown barcode.
CREATE TABLE catalog_products (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gtin             text NOT NULL UNIQUE,
  name             text NOT NULL,
  brand            text,
  size_text        text,
  category_hint    text,
  image_url        text,
  vat_code         text CHECK (vat_code IN ('S','R','Z','E')),
  is_pmp           boolean NOT NULL DEFAULT false,
  pmp_price_pence  bigint CHECK (pmp_price_pence >= 0),
  min_age          smallint,
  is_hfss          boolean,
  source           text NOT NULL DEFAULT 'manual'
                   CHECK (source IN ('open_food_facts','manual','network','supplier_feed')),
  verified         boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_pmp OR pmp_price_pence IS NOT NULL)
);
CREATE INDEX catalog_products_name_trgm ON catalog_products USING gin (name gin_trgm_ops);

-- Anonymised sell-price benchmarks across opted-in shops.
-- region = postcode area ('M', 'B', 'E', 'SW' ...). Minimum 5 shops per row.
CREATE TABLE network_price_benchmarks (
  gtin               text NOT NULL,
  region             text NOT NULL,
  period_start       date NOT NULL,
  sample_size        int NOT NULL CHECK (sample_size >= 5),
  median_sell_pence  bigint NOT NULL,
  p25_sell_pence     bigint,
  p75_sell_pence     bigint,
  median_cost_pence  bigint,
  computed_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (gtin, region, period_start)
);

-- Wholesaler cost benchmarks derived from OCR'd invoices (opted-in shops).
CREATE TABLE supplier_cost_benchmarks (
  global_supplier_id      uuid NOT NULL REFERENCES global_suppliers(id),
  gtin                    text NOT NULL,
  period_start            date NOT NULL,
  sample_size             int NOT NULL CHECK (sample_size >= 3),
  median_unit_cost_pence  bigint NOT NULL,
  computed_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (global_supplier_id, gtin, period_start)
);
CREATE INDEX supplier_cost_benchmarks_gtin ON supplier_cost_benchmarks (gtin, period_start DESC);

-- Incoming webhooks land here BEFORE we know which tenant they belong to.
-- Worker-only table (no RLS; app_runtime has no access).
CREATE TABLE webhook_inbox (
  id               bigserial PRIMARY KEY,
  provider         text NOT NULL,
  event_id         text NOT NULL,
  tenant_id        uuid REFERENCES tenants(id),
  connection_id    uuid,
  signature_valid  boolean NOT NULL,
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','processing','processed','failed','ignored')),
  attempts         int NOT NULL DEFAULT 0,
  last_error       text,
  received_at      timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  UNIQUE (provider, event_id)                            -- idempotent receipt
);
CREATE INDEX webhook_inbox_pending ON webhook_inbox (received_at) WHERE status = 'pending';
