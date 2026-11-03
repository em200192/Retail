-- =====================================================================
-- 004_catalog_pricing.sql
-- Categories, products, barcodes (incl. PMP & weighted), price levels,
-- promotions (multibuy, BOGOF, meal deal ...).
-- Money is always integer PENCE (bigint). Quantities are numeric(14,3).
-- =====================================================================

CREATE TABLE categories (
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  parent_id         uuid,
  name              text NOT NULL,
  name_i18n         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"ar": "...", "ur": "..."}
  default_vat_code  text CHECK (default_vat_code IN ('S','R','Z','E')),
  default_min_age   smallint,
  sort_order        int NOT NULL DEFAULT 0,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES categories (tenant_id, id),
  CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE TABLE products (
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  id                    uuid NOT NULL DEFAULT gen_random_uuid(),
  catalog_product_id    uuid REFERENCES catalog_products(id),
  category_id           uuid,
  sku                   text,
  name                  text NOT NULL,
  name_i18n             jsonb NOT NULL DEFAULT '{}'::jsonb,
  brand                 text,
  size_text             text,                               -- '500ml', '4 x 330ml'
  description           text,
  image_attachment_id   uuid,
  image_url             text,
  unit_type             text NOT NULL DEFAULT 'each' CHECK (unit_type IN ('each','kg','g','l','ml')),
  sold_by_weight        boolean NOT NULL DEFAULT false,
  vat_code              text NOT NULL DEFAULT 'S' CHECK (vat_code IN ('S','R','Z','E')),
  min_age               smallint CHECK (min_age IS NULL OR min_age BETWEEN 12 AND 25),  -- triggers Challenge 25
  is_hfss               boolean NOT NULL DEFAULT false,
  track_stock           boolean NOT NULL DEFAULT true,
  track_expiry          boolean NOT NULL DEFAULT false,
  allow_negative_stock  boolean NOT NULL DEFAULT true,
  reorder_point         numeric(14,3),                      -- default; branch can override
  reorder_qty           numeric(14,3),
  last_cost_pence       bigint CHECK (last_cost_pence >= 0),
  avg_cost_pence        bigint CHECK (avg_cost_pence >= 0),  -- weighted average, updated on receipt
  is_active             boolean NOT NULL DEFAULT true,
  archived_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id)         REFERENCES categories (tenant_id, id),
  FOREIGN KEY (tenant_id, image_attachment_id) REFERENCES attachments (tenant_id, id),
  UNIQUE (tenant_id, sku)
);
CREATE INDEX products_name_trgm   ON products USING gin (name gin_trgm_ops);
CREATE INDEX products_category    ON products (tenant_id, category_id);
CREATE INDEX products_catalog     ON products (catalog_product_id) WHERE catalog_product_id IS NOT NULL;

CREATE TABLE product_branch_settings (
  tenant_id       uuid NOT NULL,
  branch_id       uuid NOT NULL,
  product_id      uuid NOT NULL,
  reorder_point   numeric(14,3),
  reorder_qty     numeric(14,3),
  max_qty         numeric(14,3),
  shelf_location  text,
  is_ranged       boolean NOT NULL DEFAULT true,     -- false = not sold in this branch
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, branch_id, product_id),
  FOREIGN KEY (tenant_id, branch_id)  REFERENCES branches (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id) ON DELETE CASCADE
);

-- A product can have many barcodes: single unit, case (units_per_scan = 12),
-- PMP variant (different barcode, printed price), internal PLU for weighed goods.
CREATE TABLE product_barcodes (
  tenant_id        uuid NOT NULL,
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  product_id       uuid NOT NULL,
  barcode          text NOT NULL,
  barcode_type     text NOT NULL DEFAULT 'EAN13'
                   CHECK (barcode_type IN ('EAN13','EAN8','UPCA','UPCE','ITF14','CODE128','PLU','INTERNAL')),
  units_per_scan   numeric(14,3) NOT NULL DEFAULT 1 CHECK (units_per_scan > 0),
  is_pmp           boolean NOT NULL DEFAULT false,
  pmp_price_pence  bigint CHECK (pmp_price_pence >= 0),
  is_primary       boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, barcode),
  CHECK (NOT is_pmp OR pmp_price_pence IS NOT NULL)
);
CREATE UNIQUE INDEX product_barcodes_primary_uq ON product_barcodes (tenant_id, product_id) WHERE is_primary;
CREATE INDEX product_barcodes_product ON product_barcodes (tenant_id, product_id);

-- Variable-measure barcodes from in-store scales (e.g. prefix '2', EAN-13).
-- Item code -> product via product_barcodes (barcode_type = 'PLU').
CREATE TABLE barcode_rules (
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  prefix            text NOT NULL CHECK (prefix ~ '^[0-9]{1,3}$'),
  barcode_length    smallint NOT NULL DEFAULT 13,
  item_code_start   smallint NOT NULL,           -- 1-based position
  item_code_length  smallint NOT NULL,
  value_type        text NOT NULL CHECK (value_type IN ('price_pence','weight_g')),
  value_start       smallint NOT NULL,
  value_length      smallint NOT NULL,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, prefix)
);

-- Price levels: retail, trade, member, staff ...
CREATE TABLE price_levels (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  code               text NOT NULL,
  name               text NOT NULL,
  is_default         boolean NOT NULL DEFAULT false,
  requires_customer  boolean NOT NULL DEFAULT false,   -- trade/member price needs a customer on the sale
  sort_order         int NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);
CREATE UNIQUE INDEX price_levels_one_default ON price_levels (tenant_id) WHERE is_default;

-- Price history. Resolution order (see resolve_price() in 090):
-- requested level > default level, branch-specific > all branches,
-- highest qualifying min_qty (quantity breaks), newest valid_from.
CREATE TABLE product_prices (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  product_id      uuid NOT NULL,
  price_level_id  uuid NOT NULL,
  branch_id       uuid,                               -- NULL = every branch
  min_qty         numeric(14,3) NOT NULL DEFAULT 1 CHECK (min_qty > 0),
  price_pence     bigint NOT NULL CHECK (price_pence >= 0),
  valid_from      timestamptz NOT NULL DEFAULT now(),
  valid_to        timestamptz,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id)     REFERENCES products (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, price_level_id) REFERENCES price_levels (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)      REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)     REFERENCES staff (tenant_id, id),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX product_prices_lookup
  ON product_prices (tenant_id, product_id, price_level_id, branch_id, min_qty, valid_from DESC);

CREATE TABLE promotions (
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  receipt_label       text,                          -- '3 for £5'
  promo_type          text NOT NULL
                      CHECK (promo_type IN ('multibuy_price','buy_x_get_y','meal_deal','percent_off','amount_off','fixed_price')),
  buy_qty             int CHECK (buy_qty > 0),
  get_qty             int CHECK (get_qty > 0),
  bundle_price_pence  bigint CHECK (bundle_price_pence >= 0),
  percent_off         numeric(5,2) CHECK (percent_off > 0 AND percent_off <= 100),
  amount_off_pence    bigint CHECK (amount_off_pence > 0),
  price_level_id      uuid,                          -- NULL = everyone; set = members-only etc.
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz,
  priority            int NOT NULL DEFAULT 0,
  is_stackable        boolean NOT NULL DEFAULT false,
  funded_by           text NOT NULL DEFAULT 'store' CHECK (funded_by IN ('store','supplier','symbol_group')),
  source_ref          text,                          -- symbol group promo file id
  is_active           boolean NOT NULL DEFAULT true,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, price_level_id) REFERENCES price_levels (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)     REFERENCES staff (tenant_id, id),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK (
       (promo_type = 'multibuy_price' AND buy_qty IS NOT NULL AND bundle_price_pence IS NOT NULL)
    OR (promo_type = 'buy_x_get_y'    AND buy_qty IS NOT NULL AND get_qty IS NOT NULL)
    OR (promo_type = 'meal_deal'      AND bundle_price_pence IS NOT NULL)
    OR (promo_type = 'percent_off'    AND percent_off IS NOT NULL)
    OR (promo_type = 'amount_off'     AND amount_off_pence IS NOT NULL)
    OR (promo_type = 'fixed_price'    AND bundle_price_pence IS NOT NULL)
  )
);
CREATE INDEX promotions_active ON promotions (tenant_id, starts_at, ends_at) WHERE is_active;

-- No rows = promotion applies to every branch.
CREATE TABLE promotion_branches (
  tenant_id     uuid NOT NULL,
  promotion_id  uuid NOT NULL,
  branch_id     uuid NOT NULL,
  PRIMARY KEY (tenant_id, promotion_id, branch_id),
  FOREIGN KEY (tenant_id, promotion_id) REFERENCES promotions (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, branch_id)    REFERENCES branches (tenant_id, id) ON DELETE CASCADE
);

-- Groups make meal deals possible: Main (1) + Snack (1) + Drink (1) = £3.50.
-- Simple multibuys just have one group.
CREATE TABLE promotion_groups (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  promotion_id  uuid NOT NULL,
  name          text NOT NULL,
  required_qty  int NOT NULL DEFAULT 1 CHECK (required_qty > 0),
  position      int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, promotion_id) REFERENCES promotions (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE promotion_group_items (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  group_id     uuid NOT NULL,
  product_id   uuid,
  category_id  uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, group_id)    REFERENCES promotion_groups (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id)  REFERENCES products (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories (tenant_id, id) ON DELETE CASCADE,
  CHECK ((product_id IS NULL) <> (category_id IS NULL))
);
CREATE INDEX promotion_group_items_product  ON promotion_group_items (tenant_id, product_id);
CREATE INDEX promotion_group_items_category ON promotion_group_items (tenant_id, category_id);
