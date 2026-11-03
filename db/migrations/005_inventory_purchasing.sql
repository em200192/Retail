-- =====================================================================
-- 005_inventory_purchasing.sql
-- Suppliers, shopping list (purchase list), staff requests, purchase
-- orders, OCR supplier invoices, expiry batches, and the STOCK LEDGER.
--
-- GOLDEN RULE: stock is NEVER updated directly. Every change is an
-- INSERT into stock_movements; a trigger maintains stock_levels.
-- =====================================================================

CREATE TABLE suppliers (
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  global_supplier_id  uuid REFERENCES global_suppliers(id),   -- Booker, Bestway ...
  name                text NOT NULL,
  account_number      text,
  contact_name        text,
  email               citext,
  phone               text,
  website             text,
  vat_number          text,
  order_method        text NOT NULL DEFAULT 'email'
                      CHECK (order_method IN ('email','portal','phone','edi','in_person')),
  order_days          smallint[],                 -- ISO weekdays 1..7
  lead_time_days      smallint,
  min_order_pence     bigint,
  is_active           boolean NOT NULL DEFAULT true,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, name)
);

-- The OCR "learning" table: supplier's own code -> our product.
-- Most UK wholesale invoices show supplier codes, not barcodes.
CREATE TABLE supplier_products (
  tenant_id             uuid NOT NULL,
  id                    uuid NOT NULL DEFAULT gen_random_uuid(),
  supplier_id           uuid NOT NULL,
  product_id            uuid NOT NULL,
  supplier_code         text NOT NULL,
  supplier_description  text,
  pack_size             numeric(14,3) NOT NULL DEFAULT 1 CHECK (pack_size > 0),   -- units per case
  case_cost_pence       bigint CHECK (case_cost_pence >= 0),
  last_cost_at          timestamptz,
  is_preferred          boolean NOT NULL DEFAULT false,
  match_source          text NOT NULL DEFAULT 'manual'
                        CHECK (match_source IN ('manual','ocr_auto','ocr_confirmed','supplier_feed')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id)  REFERENCES products (tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, supplier_id, supplier_code)
);
CREATE INDEX supplier_products_product ON supplier_products (tenant_id, product_id);

-- ---------------------------------------------------------------------
-- Staff "we need this" requests
-- ---------------------------------------------------------------------
CREATE TABLE purchase_requests (
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id            uuid NOT NULL,
  product_id           uuid,
  free_text            text,
  photo_attachment_id  uuid,                         -- photo of the empty shelf
  quantity             numeric(14,3) CHECK (quantity > 0),
  priority             text NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent','normal','low')),
  note                 text,
  requested_by         uuid NOT NULL,
  status               text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','rejected','ordered','fulfilled','cancelled')),
  reviewed_by          uuid,
  reviewed_at          timestamptz,
  review_note          text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)           REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id)          REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, photo_attachment_id) REFERENCES attachments (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by)        REFERENCES staff (tenant_id, id),
  FOREIGN KEY (tenant_id, reviewed_by)         REFERENCES staff (tenant_id, id),
  CHECK (product_id IS NOT NULL OR free_text IS NOT NULL OR photo_attachment_id IS NOT NULL)
);
CREATE INDEX purchase_requests_queue ON purchase_requests (tenant_id, branch_id, status, created_at DESC);

-- ---------------------------------------------------------------------
-- Shopping list (purchase list) per branch
-- ---------------------------------------------------------------------
CREATE TABLE purchase_lists (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id   uuid NOT NULL,
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','finalised','archived')),
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)  REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES staff (tenant_id, id)
);
CREATE UNIQUE INDEX purchase_lists_one_open ON purchase_lists (tenant_id, branch_id) WHERE status = 'open';

CREATE TABLE purchase_orders (
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  id                     uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id              uuid NOT NULL,
  supplier_id            uuid NOT NULL,
  po_number              text NOT NULL,
  status                 text NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','sent','partially_received','received','cancelled')),
  expected_on            date,
  sent_at                timestamptz,
  sent_via               text,
  estimated_total_pence  bigint,
  notes                  text,
  created_by             uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)   REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)  REFERENCES staff (tenant_id, id),
  UNIQUE (tenant_id, po_number)
);

CREATE TABLE purchase_order_lines (
  tenant_id            uuid NOT NULL,
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  purchase_order_id    uuid NOT NULL,
  product_id           uuid NOT NULL,
  supplier_product_id  uuid,
  unit                 text NOT NULL DEFAULT 'case' CHECK (unit IN ('each','case')),
  qty_ordered          numeric(14,3) NOT NULL CHECK (qty_ordered > 0),
  qty_received         numeric(14,3) NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  unit_cost_pence      bigint CHECK (unit_cost_pence >= 0),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_order_id)   REFERENCES purchase_orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id)          REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_product_id) REFERENCES supplier_products (tenant_id, id)
);

-- One list, four sources: reorder point, AI forecast, staff request, manual.
CREATE TABLE purchase_list_items (
  tenant_id                  uuid NOT NULL,
  id                         uuid NOT NULL DEFAULT gen_random_uuid(),
  purchase_list_id           uuid NOT NULL,
  product_id                 uuid,
  free_text                  text,
  supplier_id                uuid,
  quantity                   numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit                       text NOT NULL DEFAULT 'each' CHECK (unit IN ('each','case')),
  source                     text NOT NULL CHECK (source IN ('reorder_point','ai_forecast','staff_request','manual')),
  purchase_request_id        uuid,
  ai_reason                  text,                     -- "Sells 40/week, 6 left, Booker delivers Thu"
  estimated_unit_cost_pence  bigint,
  status                     text NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','approved','rejected','ordered','received')),
  purchase_order_id          uuid,
  added_by                   uuid,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_list_id)    REFERENCES purchase_lists (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id)          REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id)         REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_request_id) REFERENCES purchase_requests (tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_order_id)   REFERENCES purchase_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, added_by)            REFERENCES staff (tenant_id, id),
  CHECK (product_id IS NOT NULL OR free_text IS NOT NULL)
);
CREATE INDEX purchase_list_items_list ON purchase_list_items (tenant_id, purchase_list_id, status);

-- ---------------------------------------------------------------------
-- Supplier invoices + OCR
-- ---------------------------------------------------------------------
CREATE TABLE supplier_invoices (
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id           uuid NOT NULL,
  supplier_id         uuid,                          -- NULL until OCR identifies it
  purchase_order_id   uuid,
  invoice_number      text,
  invoice_date        date,
  due_date            date,
  subtotal_pence      bigint,
  vat_pence           bigint,
  total_pence         bigint,
  status              text NOT NULL DEFAULT 'uploaded'
                      CHECK (status IN ('uploaded','processing','needs_review','approved','posted','rejected','failed')),
  file_attachment_id  uuid NOT NULL,
  ocr_provider        text,
  ocr_model           text,
  ocr_raw             jsonb,
  ocr_confidence      numeric(4,3) CHECK (ocr_confidence BETWEEN 0 AND 1),
  ocr_error           text,
  processed_at        timestamptz,
  uploaded_by         uuid,
  reviewed_by         uuid,
  posted_by           uuid,
  posted_at           timestamptz,                   -- stock movements created at this moment
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)          REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id)        REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_order_id)  REFERENCES purchase_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, file_attachment_id) REFERENCES attachments (tenant_id, id),
  FOREIGN KEY (tenant_id, uploaded_by)        REFERENCES staff (tenant_id, id),
  FOREIGN KEY (tenant_id, reviewed_by)        REFERENCES staff (tenant_id, id),
  FOREIGN KEY (tenant_id, posted_by)          REFERENCES staff (tenant_id, id)
);
-- Same invoice uploaded twice = blocked (double stock is a classic bug).
CREATE UNIQUE INDEX supplier_invoices_no_duplicates
  ON supplier_invoices (tenant_id, supplier_id, invoice_number)
  WHERE invoice_number IS NOT NULL AND status <> 'rejected';
CREATE INDEX supplier_invoices_queue ON supplier_invoices (tenant_id, status, created_at DESC);

CREATE TABLE supplier_invoice_lines (
  tenant_id          uuid NOT NULL,
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  invoice_id         uuid NOT NULL,
  line_no            int NOT NULL,
  raw_text           text,
  supplier_code      text,
  barcode            text,
  description        text,
  quantity           numeric(14,3),                -- cases or units as printed
  pack_size          numeric(14,3),
  unit_cost_pence    bigint,
  line_total_pence   bigint,
  vat_code           text CHECK (vat_code IN ('S','R','Z','E')),
  is_pmp             boolean,
  pmp_price_pence    bigint,
  expiry_date        date,
  product_id         uuid,
  match_status       text NOT NULL DEFAULT 'unmatched'
                     CHECK (match_status IN ('matched_auto','matched_manual','new_product_created','unmatched','ignored')),
  match_confidence   numeric(4,3) CHECK (match_confidence BETWEEN 0 AND 1),
  matched_by         uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES supplier_invoices (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, matched_by) REFERENCES staff (tenant_id, id),
  UNIQUE (tenant_id, invoice_id, line_no)
);

-- ---------------------------------------------------------------------
-- Expiry batches (only for products with track_expiry = true)
-- ---------------------------------------------------------------------
CREATE TABLE stock_batches (
  tenant_id            uuid NOT NULL,
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id            uuid NOT NULL,
  product_id           uuid NOT NULL,
  supplier_invoice_id  uuid,
  batch_code           text,
  expiry_date          date,
  qty_received         numeric(14,3) NOT NULL CHECK (qty_received > 0),
  qty_remaining        numeric(14,3) NOT NULL CHECK (qty_remaining >= 0),
  unit_cost_pence      bigint,
  received_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)           REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id)          REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_invoice_id) REFERENCES supplier_invoices (tenant_id, id)
);
CREATE INDEX stock_batches_expiry ON stock_batches (tenant_id, branch_id, expiry_date) WHERE qty_remaining > 0;

-- ---------------------------------------------------------------------
-- STOCK LEDGER (append-only)
-- ---------------------------------------------------------------------
CREATE TABLE stock_movements (
  tenant_id        uuid NOT NULL,
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id        uuid NOT NULL,
  product_id       uuid NOT NULL,
  quantity         numeric(14,3) NOT NULL CHECK (quantity <> 0),   -- signed
  movement_type    text NOT NULL
                   CHECK (movement_type IN ('sale','refund','receipt','adjustment','waste','transfer_out',
                                            'transfer_in','stocktake','online_order','return_to_supplier','opening')),
  reason_code      text CHECK (reason_code IN ('expired','damaged','spoiled','theft_known','sampling',
                                               'count_correction','supplier_short','other')),
  reason           text,
  unit_cost_pence  bigint,
  reference_type   text,          -- 'sale', 'supplier_invoice', 'stocktake', 'order', 'transfer'
  reference_id     uuid,
  batch_id         uuid,
  staff_id         uuid,
  device_id        uuid,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)  REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id)   REFERENCES stock_batches (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id)   REFERENCES staff (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id)  REFERENCES devices (tenant_id, id),
  -- Sign must match the movement type
  CHECK (
       (movement_type IN ('sale','waste','transfer_out','return_to_supplier','online_order') AND quantity < 0)
    OR (movement_type IN ('receipt','refund','transfer_in','opening') AND quantity > 0)
    OR (movement_type IN ('adjustment','stocktake'))
  ),
  CHECK (movement_type <> 'waste' OR reason_code IS NOT NULL)
);
CREATE INDEX stock_movements_product_time ON stock_movements (tenant_id, branch_id, product_id, occurred_at DESC);
CREATE INDEX stock_movements_type_time    ON stock_movements (tenant_id, movement_type, occurred_at DESC);
CREATE INDEX stock_movements_reference    ON stock_movements (tenant_id, reference_type, reference_id);

CREATE TRIGGER stock_movements_immutable
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- Current on-hand, maintained ONLY by the trigger below.
CREATE TABLE stock_levels (
  tenant_id   uuid NOT NULL,
  branch_id   uuid NOT NULL,
  product_id  uuid NOT NULL,
  quantity    numeric(14,3) NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, branch_id, product_id),
  FOREIGN KEY (tenant_id, branch_id)  REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);

-- SECURITY DEFINER: the API role cannot write stock_levels directly,
-- only through this trigger. RLS still applies (FORCE), so tenant must match.
CREATE OR REPLACE FUNCTION apply_stock_movement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO stock_levels (tenant_id, branch_id, product_id, quantity, updated_at)
  VALUES (NEW.tenant_id, NEW.branch_id, NEW.product_id, NEW.quantity, now())
  ON CONFLICT (tenant_id, branch_id, product_id)
  DO UPDATE SET quantity   = stock_levels.quantity + EXCLUDED.quantity,
                updated_at = now();
  RETURN NEW;
END $$;

CREATE TRIGGER stock_movements_apply
  AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION apply_stock_movement();

-- ---------------------------------------------------------------------
-- Transfers between branches
-- ---------------------------------------------------------------------
CREATE TABLE stock_transfers (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  from_branch_id  uuid NOT NULL,
  to_branch_id    uuid NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_transit','received','cancelled')),
  created_by      uuid,
  sent_at         timestamptz,
  received_at     timestamptz,
  received_by     uuid,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, from_branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, to_branch_id)   REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)     REFERENCES staff (tenant_id, id),
  FOREIGN KEY (tenant_id, received_by)    REFERENCES staff (tenant_id, id),
  CHECK (from_branch_id <> to_branch_id)
);

CREATE TABLE stock_transfer_lines (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  transfer_id   uuid NOT NULL,
  product_id    uuid NOT NULL,
  qty_sent      numeric(14,3) NOT NULL CHECK (qty_sent > 0),
  qty_received  numeric(14,3) CHECK (qty_received >= 0),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, transfer_id) REFERENCES stock_transfers (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id)  REFERENCES products (tenant_id, id)
);

-- ---------------------------------------------------------------------
-- Stocktakes (full, by category, or quick spot-check with phone camera)
-- ---------------------------------------------------------------------
CREATE TABLE stocktakes (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id     uuid NOT NULL,
  scope         text NOT NULL DEFAULT 'spot' CHECK (scope IN ('full','category','spot')),
  category_id   uuid,
  status        text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','cancelled')),
  started_by    uuid,
  started_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)   REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories (tenant_id, id),
  FOREIGN KEY (tenant_id, started_by)  REFERENCES staff (tenant_id, id)
);

CREATE TABLE stocktake_lines (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  stocktake_id  uuid NOT NULL,
  product_id    uuid NOT NULL,
  expected_qty  numeric(14,3) NOT NULL,          -- snapshot when counted
  counted_qty   numeric(14,3) NOT NULL CHECK (counted_qty >= 0),
  variance_qty  numeric(14,3) GENERATED ALWAYS AS (counted_qty - expected_qty) STORED,
  counted_by    uuid,                            -- feeds "stocktake accuracy" KPI
  counted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, stocktake_id) REFERENCES stocktakes (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id)   REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, counted_by)   REFERENCES staff (tenant_id, id),
  UNIQUE (tenant_id, stocktake_id, product_id)
);
