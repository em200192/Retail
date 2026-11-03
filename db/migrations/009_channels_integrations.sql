-- =====================================================================
-- 009_channels_integrations.sql
-- Integration connections (Uber Eats, Deliveroo, Just Eat, Snappy
-- Shopper, Xero, card terminals ...), online orders from any channel,
-- stock reservations, transactional outbox, in-store services.
--
-- Integrations are built LATER behind an adapter interface; this schema
-- is ready for them now so nothing needs reshaping.
-- =====================================================================

CREATE TABLE integration_connections (
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  id                     uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id              uuid,                       -- delivery apps are per branch
  provider               text NOT NULL CHECK (provider IN (
                           'uber_eats','deliveroo','just_eat','snappy_shopper',
                           'xero','quickbooks','sage','brightpay',
                           'dojo','sumup','stripe_terminal','square',
                           'email','whatsapp','sms','hmrc_mtd','cctv','symbol_group')),
  status                 text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','active','error','disconnected')),
  external_account_id    text,
  external_store_id      text,
  credentials_secret_ref text,                       -- pointer to secrets manager. NEVER tokens here.
  config                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at           timestamptz,
  last_error             text,
  created_by             uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)  REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES staff (tenant_id, id),
  UNIQUE NULLS NOT DISTINCT (tenant_id, provider, branch_id)
);
CREATE INDEX integration_connections_store ON integration_connections (provider, external_store_id)
  WHERE external_store_id IS NOT NULL;   -- used to route webhooks to the right tenant

-- Our product <-> platform listing. Platforms often get a marked-up price.
CREATE TABLE external_product_links (
  tenant_id              uuid NOT NULL,
  id                     uuid NOT NULL DEFAULT gen_random_uuid(),
  connection_id          uuid NOT NULL,
  product_id             uuid NOT NULL,
  external_item_id       text,
  price_override_pence   bigint CHECK (price_override_pence >= 0),
  markup_percent         numeric(5,2),
  is_listed              boolean NOT NULL DEFAULT true,
  sync_status            text NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending','synced','error')),
  last_pushed_at         timestamptz,
  last_error             text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES integration_connections (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id)    REFERENCES products (tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, connection_id, product_id),
  UNIQUE (tenant_id, connection_id, external_item_id)
);

-- Remote orders from every channel, incl. our own white-label store.
-- When fulfilled, a normal sale is created and linked via sale_id.
CREATE TABLE orders (
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id            uuid NOT NULL,
  channel              text NOT NULL CHECK (channel IN ('uber_eats','deliveroo','just_eat','snappy_shopper','own_store','phone','click_collect')),
  connection_id        uuid,
  external_order_id    text,
  status               text NOT NULL DEFAULT 'received'
                       CHECK (status IN ('received','accepted','picking','ready','picked_up','delivered','completed','cancelled','rejected')),
  fulfilment           text NOT NULL DEFAULT 'delivery' CHECK (fulfilment IN ('delivery','collection')),
  customer_id          uuid,
  customer_name        text,
  customer_phone       text,
  delivery_address     jsonb,
  scheduled_for        timestamptz,
  subtotal_pence       bigint NOT NULL DEFAULT 0,
  delivery_fee_pence   bigint NOT NULL DEFAULT 0,
  platform_fee_pence   bigint NOT NULL DEFAULT 0,      -- commission: shows the true cost of each channel
  tip_pence            bigint NOT NULL DEFAULT 0,
  total_pence          bigint NOT NULL DEFAULT 0,
  payment_status       text NOT NULL DEFAULT 'paid_on_platform'
                       CHECK (payment_status IN ('paid_on_platform','paid_online','pay_on_collection','refunded')),
  sale_id              uuid,
  picked_by            uuid,
  raw_payload          jsonb,
  cancelled_reason     text,
  received_at          timestamptz NOT NULL DEFAULT now(),
  accepted_at          timestamptz,
  completed_at         timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)     REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES integration_connections (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id)   REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, sale_id)       REFERENCES sales (tenant_id, id),
  FOREIGN KEY (tenant_id, picked_by)     REFERENCES staff (tenant_id, id)
);
CREATE UNIQUE INDEX orders_external_uq ON orders (tenant_id, channel, external_order_id) WHERE external_order_id IS NOT NULL;
CREATE INDEX orders_live ON orders (tenant_id, branch_id, received_at DESC)
  WHERE status NOT IN ('completed','cancelled','rejected');

CREATE TABLE order_lines (
  tenant_id                 uuid NOT NULL,
  id                        uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id                  uuid NOT NULL,
  product_id                uuid,
  external_item_id          text,
  description               text NOT NULL,
  quantity                  numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_price_pence          bigint NOT NULL CHECK (unit_price_pence >= 0),
  line_total_pence          bigint NOT NULL,
  picked_qty                numeric(14,3),
  status                    text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','picked','substituted','unavailable')),
  substitution_for_line_id  uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id)                 REFERENCES orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id)               REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, substitution_for_line_id) REFERENCES order_lines (tenant_id, id)
);

-- Holds stock for accepted online orders so the till can't sell the last one.
-- Available = stock_levels.quantity - SUM(active reservations)  (see v_stock_availability)
CREATE TABLE stock_reservations (
  tenant_id   uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id   uuid NOT NULL,
  product_id  uuid NOT NULL,
  order_id    uuid NOT NULL,
  quantity    numeric(14,3) NOT NULL CHECK (quantity > 0),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','consumed')),
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)  REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id)   REFERENCES orders (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX stock_reservations_active ON stock_reservations (tenant_id, branch_id, product_id) WHERE status = 'active';

-- Transactional outbox: write the event in the SAME transaction as the
-- business change; a worker publishes it (SELECT ... FOR UPDATE SKIP LOCKED)
-- to Uber Eats, email, accounting, etc. Guarantees nothing is lost.
CREATE TABLE outbox_events (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              bigserial,
  event_type      text NOT NULL,          -- 'stock.changed', 'price.changed', 'order.status_changed', 'notify.low_stock'
  aggregate_type  text NOT NULL,
  aggregate_id    uuid,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  available_at    timestamptz NOT NULL DEFAULT now(),   -- for retries with backoff
  published_at    timestamptz,
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX outbox_events_unpublished ON outbox_events (available_at) WHERE published_at IS NULL;

-- Parcels (Evri, InPost, Amazon), PayPoint, lottery, top-ups — extra income.
CREATE TABLE service_transactions (
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id         uuid NOT NULL,
  staff_id          uuid,
  service_type      text NOT NULL CHECK (service_type IN ('parcel_drop','parcel_collect','paypoint','lottery','mobile_topup','other')),
  provider          text,
  reference         text,
  amount_pence      bigint NOT NULL DEFAULT 0,
  commission_pence  bigint NOT NULL DEFAULT 0,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id)  REFERENCES staff (tenant_id, id)
);
CREATE INDEX service_transactions_time ON service_transactions (tenant_id, branch_id, occurred_at DESC);
