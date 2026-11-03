-- =====================================================================
-- 006_sales_pos.sql
-- Customers & loyalty, tills & cash-up, sales, payments, refunds,
-- discounts, manager approvals, Challenge 25 age checks.
--
-- OFFLINE-FIRST: sale / refund / payment ids are UUIDs generated ON THE
-- DEVICE. A retried sync re-sends the same id -> INSERT ... ON CONFLICT
-- DO NOTHING. That is the idempotency key; no separate client_ref needed.
-- =====================================================================

CREATE TABLE customers (
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  id                    uuid NOT NULL DEFAULT gen_random_uuid(),
  first_name            text,
  last_name             text,
  phone                 text,                     -- E.164, used as loyalty identifier
  email                 citext,
  price_level_id        uuid,                     -- trade customers get trade prices
  loyalty_points        int NOT NULL DEFAULT 0,
  marketing_consent     boolean NOT NULL DEFAULT false,
  marketing_consent_at  timestamptz,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, price_level_id) REFERENCES price_levels (tenant_id, id)
);
CREATE UNIQUE INDEX customers_phone_uq ON customers (tenant_id, phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX customers_email_uq ON customers (tenant_id, email) WHERE email IS NOT NULL;

-- ---------------------------------------------------------------------
-- Tills & cash management
-- ---------------------------------------------------------------------
CREATE TABLE tills (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id   uuid NOT NULL,
  device_id   uuid,
  name        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, id)
);

CREATE TABLE till_sessions (
  tenant_id            uuid NOT NULL,
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  till_id              uuid NOT NULL,
  branch_id            uuid NOT NULL,
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_by            uuid NOT NULL,
  opened_at            timestamptz NOT NULL DEFAULT now(),
  opening_float_pence  bigint NOT NULL DEFAULT 0 CHECK (opening_float_pence >= 0),
  closed_by            uuid,
  closed_at            timestamptz,
  expected_cash_pence  bigint,
  counted_cash_pence   bigint,
  variance_pence       bigint GENERATED ALWAYS AS (counted_cash_pence - expected_cash_pence) STORED,
  z_report             jsonb,                     -- frozen end-of-day snapshot
  notes                text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, till_id)   REFERENCES tills (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, opened_by) REFERENCES staff (tenant_id, id),
  FOREIGN KEY (tenant_id, closed_by) REFERENCES staff (tenant_id, id),
  CHECK (status = 'open' OR (closed_at IS NOT NULL AND closed_by IS NOT NULL))
);
CREATE UNIQUE INDEX till_sessions_one_open ON till_sessions (tenant_id, till_id) WHERE status = 'open';

CREATE TABLE cash_movements (
  tenant_id        uuid NOT NULL,
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  till_session_id  uuid NOT NULL,
  movement_type    text NOT NULL CHECK (movement_type IN ('no_sale','paid_in','paid_out','cash_drop','float_adjust')),
  amount_pence     bigint NOT NULL DEFAULT 0 CHECK (amount_pence >= 0),
  reason           text,
  staff_id         uuid NOT NULL,
  approved_by      uuid,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, till_session_id) REFERENCES till_sessions (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id)        REFERENCES staff (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by)     REFERENCES staff (tenant_id, id),
  CHECK (movement_type = 'no_sale' OR amount_pence > 0)
);
CREATE INDEX cash_movements_session ON cash_movements (tenant_id, till_session_id);
CREATE INDEX cash_movements_staff   ON cash_movements (tenant_id, staff_id, occurred_at DESC);

-- ---------------------------------------------------------------------
-- Sales
-- ---------------------------------------------------------------------
CREATE TABLE sales (
  tenant_id        uuid NOT NULL,
  id               uuid NOT NULL,                   -- generated on device
  branch_id        uuid NOT NULL,
  device_id        uuid,
  till_session_id  uuid,
  staff_id         uuid NOT NULL,
  customer_id      uuid,
  price_level_id   uuid,
  channel          text NOT NULL DEFAULT 'pos'
                   CHECK (channel IN ('pos','self_checkout','uber_eats','deliveroo','just_eat','snappy_shopper','own_store','phone')),
  receipt_number   text NOT NULL,                   -- '{branch}-{device}-{seq}', generated offline
  status           text NOT NULL DEFAULT 'completed'
                   CHECK (status IN ('parked','completed','voided','partially_refunded','refunded')),
  is_training      boolean NOT NULL DEFAULT false,  -- training mode: excluded from all reports & stock
  subtotal_pence   bigint NOT NULL DEFAULT 0,
  discount_pence   bigint NOT NULL DEFAULT 0 CHECK (discount_pence >= 0),
  total_pence      bigint NOT NULL DEFAULT 0,
  vat_pence        bigint NOT NULL DEFAULT 0,
  item_count       numeric(14,3) NOT NULL DEFAULT 0,
  started_at       timestamptz,
  completed_at     timestamptz,
  voided_at        timestamptz,
  voided_by        uuid,
  void_reason      text,
  synced_at        timestamptz NOT NULL DEFAULT now(),
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)       REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id)       REFERENCES devices (tenant_id, id),
  FOREIGN KEY (tenant_id, till_session_id) REFERENCES till_sessions (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id)        REFERENCES staff (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id)     REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, price_level_id)  REFERENCES price_levels (tenant_id, id),
  FOREIGN KEY (tenant_id, voided_by)       REFERENCES staff (tenant_id, id),
  UNIQUE (tenant_id, branch_id, receipt_number),
  CHECK (total_pence = subtotal_pence - discount_pence),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  CHECK (status <> 'voided' OR (voided_at IS NOT NULL AND voided_by IS NOT NULL))
);
CREATE INDEX sales_branch_time   ON sales (tenant_id, branch_id, completed_at DESC);
CREATE INDEX sales_staff_time    ON sales (tenant_id, staff_id, completed_at DESC);
CREATE INDEX sales_customer      ON sales (tenant_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX sales_session       ON sales (tenant_id, till_session_id);

-- Challenge 25 log: proof the check happened (Trading Standards / licence review).
CREATE TABLE age_checks (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL,
  branch_id     uuid NOT NULL,
  sale_id       uuid,
  product_id    uuid,
  staff_id      uuid NOT NULL,
  device_id     uuid,
  required_age  smallint NOT NULL,
  outcome       text NOT NULL CHECK (outcome IN ('looked_over_25','id_checked_ok','refused','id_not_available')),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)  REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, sale_id)    REFERENCES sales (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id)   REFERENCES staff (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id)  REFERENCES devices (tenant_id, id)
);
CREATE INDEX age_checks_branch_time ON age_checks (tenant_id, branch_id, occurred_at DESC);

CREATE TABLE sale_lines (
  tenant_id                 uuid NOT NULL,
  id                        uuid NOT NULL,
  sale_id                   uuid NOT NULL,
  line_no                   int NOT NULL,
  product_id                uuid,                       -- NULL = open/misc item
  barcode_scanned           text,
  description               text NOT NULL,              -- snapshot
  quantity                  numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_price_pence          bigint NOT NULL CHECK (unit_price_pence >= 0),
  price_level_id            uuid,
  is_pmp                    boolean NOT NULL DEFAULT false,
  pmp_price_pence           bigint,
  line_discount_pence       bigint NOT NULL DEFAULT 0 CHECK (line_discount_pence >= 0),
  promotion_id              uuid,
  promotion_discount_pence  bigint NOT NULL DEFAULT 0 CHECK (promotion_discount_pence >= 0),
  line_total_pence          bigint NOT NULL CHECK (line_total_pence >= 0),
  vat_code                  text NOT NULL CHECK (vat_code IN ('S','R','Z','E')),
  vat_rate_percent          numeric(5,2) NOT NULL,      -- snapshot at time of sale
  vat_pence                 bigint NOT NULL,
  unit_cost_pence           bigint,                     -- snapshot for margin reports
  age_check_id              uuid,
  is_voided                 boolean NOT NULL DEFAULT false,  -- kept for loss-prevention analytics
  voided_by                 uuid,
  void_reason               text,
  added_at                  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, sale_id)        REFERENCES sales (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id)     REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, price_level_id) REFERENCES price_levels (tenant_id, id),
  FOREIGN KEY (tenant_id, promotion_id)   REFERENCES promotions (tenant_id, id),
  FOREIGN KEY (tenant_id, age_check_id)   REFERENCES age_checks (tenant_id, id),
  FOREIGN KEY (tenant_id, voided_by)      REFERENCES staff (tenant_id, id),
  UNIQUE (tenant_id, sale_id, line_no),
  -- Never charge more than the price printed on a PMP pack.
  CHECK (NOT is_pmp OR (pmp_price_pence IS NOT NULL AND unit_price_pence <= pmp_price_pence)),
  CHECK (NOT is_voided OR voided_by IS NOT NULL)
);
CREATE INDEX sale_lines_product ON sale_lines (tenant_id, product_id);
CREATE INDEX sale_lines_voided  ON sale_lines (tenant_id, voided_by) WHERE is_voided;

-- Every action that needed (or bypassed) a permission/limit check.
CREATE TABLE pos_approvals (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL,
  branch_id     uuid NOT NULL,
  device_id     uuid,
  sale_id       uuid,
  sale_line_id  uuid,
  action_code   text NOT NULL REFERENCES permissions(code),
  requested_by  uuid NOT NULL,
  approved_by   uuid,                                -- manager who entered PIN
  outcome       text NOT NULL CHECK (outcome IN ('self_authorised','approved','denied')),
  value         numeric(14,2),                       -- e.g. discount % or refund pence
  reason        text,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)    REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id)    REFERENCES devices (tenant_id, id),
  FOREIGN KEY (tenant_id, sale_id)      REFERENCES sales (tenant_id, id),
  FOREIGN KEY (tenant_id, sale_line_id) REFERENCES sale_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES staff (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by)  REFERENCES staff (tenant_id, id),
  CHECK (outcome = 'self_authorised' OR approved_by IS NOT NULL)
);
CREATE INDEX pos_approvals_staff ON pos_approvals (tenant_id, requested_by, occurred_at DESC);

CREATE TABLE sale_discounts (
  tenant_id      uuid NOT NULL,
  id             uuid NOT NULL,
  sale_id        uuid NOT NULL,
  sale_line_id   uuid,                               -- NULL = basket discount
  discount_type  text NOT NULL CHECK (discount_type IN ('percent','amount','price_override')),
  percent        numeric(5,2) CHECK (percent > 0 AND percent <= 100),
  amount_pence   bigint NOT NULL CHECK (amount_pence > 0),
  reason_code    text,
  staff_id       uuid NOT NULL,
  approval_id    uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, sale_id)      REFERENCES sales (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, sale_line_id) REFERENCES sale_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id)     REFERENCES staff (tenant_id, id),
  FOREIGN KEY (tenant_id, approval_id)  REFERENCES pos_approvals (tenant_id, id)
);
CREATE INDEX sale_discounts_staff ON sale_discounts (tenant_id, staff_id, created_at DESC);

CREATE TABLE sale_payments (
  tenant_id         uuid NOT NULL,
  id                uuid NOT NULL,
  sale_id           uuid NOT NULL,
  method            text NOT NULL
                    CHECK (method IN ('cash','card','voucher','loyalty_points','account','online_platform','gift_card')),
  amount_pence      bigint NOT NULL CHECK (amount_pence > 0),
  tendered_pence    bigint,                            -- cash given
  change_pence      bigint,
  provider          text,                              -- 'dojo', 'sumup', 'stripe_terminal' ...
  provider_txn_ref  text,
  card_brand        text,
  card_last4        char(4),
  auth_code         text,
  status            text NOT NULL DEFAULT 'approved' CHECK (status IN ('pending','approved','declined','refunded','voided')),
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, sale_id) REFERENCES sales (tenant_id, id) ON DELETE CASCADE,
  CHECK (method <> 'cash' OR tendered_pence IS NULL OR tendered_pence >= amount_pence)
);
CREATE INDEX sale_payments_sale ON sale_payments (tenant_id, sale_id);
CREATE INDEX sale_payments_provider_ref ON sale_payments (provider, provider_txn_ref) WHERE provider_txn_ref IS NOT NULL;

CREATE TABLE refunds (
  tenant_id         uuid NOT NULL,
  id                uuid NOT NULL,
  branch_id         uuid NOT NULL,
  original_sale_id  uuid,                              -- NULL = unreceipted refund (needs approval)
  till_session_id   uuid,
  device_id         uuid,
  staff_id          uuid NOT NULL,
  approval_id       uuid,
  reason_code       text NOT NULL,
  reason            text,
  refund_method     text NOT NULL CHECK (refund_method IN ('cash','card','voucher','loyalty_points','original_platform')),
  total_pence       bigint NOT NULL CHECK (total_pence > 0),
  vat_pence         bigint NOT NULL DEFAULT 0,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  synced_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)        REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, original_sale_id) REFERENCES sales (tenant_id, id),
  FOREIGN KEY (tenant_id, till_session_id)  REFERENCES till_sessions (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id)        REFERENCES devices (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id)         REFERENCES staff (tenant_id, id),
  FOREIGN KEY (tenant_id, approval_id)      REFERENCES pos_approvals (tenant_id, id)
);
CREATE INDEX refunds_staff_time ON refunds (tenant_id, staff_id, occurred_at DESC);
CREATE INDEX refunds_original   ON refunds (tenant_id, original_sale_id);

CREATE TABLE refund_lines (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL,
  refund_id     uuid NOT NULL,
  sale_line_id  uuid,
  product_id    uuid,
  quantity      numeric(14,3) NOT NULL CHECK (quantity > 0),
  amount_pence  bigint NOT NULL CHECK (amount_pence >= 0),
  vat_code      text NOT NULL CHECK (vat_code IN ('S','R','Z','E')),
  vat_pence     bigint NOT NULL DEFAULT 0,
  restock       boolean NOT NULL DEFAULT true,          -- false = damaged, goes to waste
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, refund_id)    REFERENCES refunds (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, sale_line_id) REFERENCES sale_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id)   REFERENCES products (tenant_id, id)
);

CREATE TABLE receipt_deliveries (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  sale_id      uuid NOT NULL,
  channel      text NOT NULL CHECK (channel IN ('print','email','sms','whatsapp')),
  destination  text,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  sent_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, sale_id) REFERENCES sales (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE loyalty_transactions (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL,
  points       int NOT NULL CHECK (points <> 0),
  reason       text NOT NULL CHECK (reason IN ('earn','redeem','adjust','expire','refund_reversal')),
  sale_id      uuid,
  staff_id     uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, sale_id)     REFERENCES sales (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id)    REFERENCES staff (tenant_id, id)
);
CREATE INDEX loyalty_transactions_customer ON loyalty_transactions (tenant_id, customer_id, created_at DESC);
