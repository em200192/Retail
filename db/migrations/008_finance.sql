-- =====================================================================
-- 008_finance.sql
-- Expenses, VAT returns (MTD 9-box), pre-aggregated reporting tables
-- that make dashboards instant and feed the AI forecasting.
-- =====================================================================

CREATE TABLE expense_categories (
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  accounting_code   text,                          -- maps to Xero / QuickBooks account
  vat_reclaimable   boolean NOT NULL DEFAULT true,
  is_active         boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE expenses (
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  id                     uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id              uuid,
  category_id            uuid NOT NULL,
  supplier_id            uuid,
  description            text NOT NULL,
  net_pence              bigint NOT NULL CHECK (net_pence >= 0),
  vat_pence              bigint NOT NULL DEFAULT 0 CHECK (vat_pence >= 0),
  total_pence            bigint NOT NULL,
  incurred_on            date NOT NULL,
  payment_method         text CHECK (payment_method IN ('cash','card','bank_transfer','direct_debit','till_paid_out')),
  receipt_attachment_id  uuid,
  cash_movement_id       uuid,                    -- when paid from the till
  external_ref           text,                    -- accounting system id after sync
  created_by             uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)             REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id)           REFERENCES expense_categories (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id)           REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, receipt_attachment_id) REFERENCES attachments (tenant_id, id),
  FOREIGN KEY (tenant_id, cash_movement_id)      REFERENCES cash_movements (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)            REFERENCES staff (tenant_id, id),
  CHECK (total_pence = net_pence + vat_pence)
);
CREATE INDEX expenses_date ON expenses (tenant_id, incurred_on DESC);

-- Making Tax Digital 9-box VAT return. Submission goes via HMRC API
-- (or via the connected accounting package).
CREATE TABLE vat_returns (
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  due_date          date,
  box1_vat_due_sales_pence        bigint NOT NULL DEFAULT 0,
  box2_vat_due_acquisitions_pence bigint NOT NULL DEFAULT 0,
  box3_total_vat_due_pence        bigint NOT NULL DEFAULT 0,
  box4_vat_reclaimed_pence        bigint NOT NULL DEFAULT 0,
  box5_net_vat_pence              bigint NOT NULL DEFAULT 0,
  box6_total_sales_ex_vat_pence   bigint NOT NULL DEFAULT 0,
  box7_total_purchases_ex_vat_pence bigint NOT NULL DEFAULT 0,
  box8_supplies_ex_vat_pence      bigint NOT NULL DEFAULT 0,
  box9_acquisitions_ex_vat_pence  bigint NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','submitted','accepted','rejected')),
  submitted_at      timestamptz,
  submitted_by      uuid,
  hmrc_receipt_ref  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, submitted_by) REFERENCES staff (tenant_id, id),
  UNIQUE (tenant_id, period_start),
  CHECK (period_end > period_start)
);

-- ---------------------------------------------------------------------
-- Pre-aggregated reporting (refreshed by a worker job every few minutes
-- for today, nightly for history). Dashboards read ONLY these.
-- business_date is in the branch's local timezone.
-- ---------------------------------------------------------------------
CREATE TABLE daily_branch_summaries (
  tenant_id            uuid NOT NULL,
  branch_id            uuid NOT NULL,
  business_date        date NOT NULL,
  gross_sales_pence    bigint NOT NULL DEFAULT 0,
  net_sales_pence      bigint NOT NULL DEFAULT 0,
  vat_pence            bigint NOT NULL DEFAULT 0,
  refunds_pence        bigint NOT NULL DEFAULT 0,
  discounts_pence      bigint NOT NULL DEFAULT 0,
  cost_of_goods_pence  bigint NOT NULL DEFAULT 0,
  waste_cost_pence     bigint NOT NULL DEFAULT 0,
  transactions         int NOT NULL DEFAULT 0,
  avg_basket_pence     bigint NOT NULL DEFAULT 0,
  cash_pence           bigint NOT NULL DEFAULT 0,
  card_pence           bigint NOT NULL DEFAULT 0,
  online_pence         bigint NOT NULL DEFAULT 0,
  platform_fees_pence  bigint NOT NULL DEFAULT 0,      -- Uber Eats / Deliveroo commission
  voided_lines         int NOT NULL DEFAULT 0,
  no_sales             int NOT NULL DEFAULT 0,
  computed_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, branch_id, business_date),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);

CREATE TABLE product_daily_sales (
  tenant_id        uuid NOT NULL,
  branch_id        uuid NOT NULL,
  product_id       uuid NOT NULL,
  business_date    date NOT NULL,
  qty_sold         numeric(14,3) NOT NULL DEFAULT 0,
  net_sales_pence  bigint NOT NULL DEFAULT 0,
  cost_pence       bigint NOT NULL DEFAULT 0,
  qty_wasted       numeric(14,3) NOT NULL DEFAULT 0,
  was_out_of_stock boolean NOT NULL DEFAULT false,      -- important for forecasting: lost sales
  computed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, branch_id, product_id, business_date),
  FOREIGN KEY (tenant_id, branch_id)  REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);
CREATE INDEX product_daily_sales_date ON product_daily_sales (tenant_id, business_date DESC);
