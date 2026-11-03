-- Smoke test: tenant isolation, stock ledger, pricing, permissions, PMP guard.
-- Run as a superuser on a fresh database after all migrations.
\set ON_ERROR_STOP 1
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='test_api') THEN
    CREATE ROLE test_api LOGIN IN ROLE app_runtime; END IF; END $$;

-- Two shops, created the way the signup worker would.
INSERT INTO tenants (id, legal_name) VALUES
  ('00000000-0000-0000-0000-00000000000a','Shop A Ltd'),
  ('00000000-0000-0000-0000-00000000000b','Shop B Ltd');
BEGIN; SELECT create_tenant_defaults('00000000-0000-0000-0000-00000000000a'); COMMIT;
BEGIN; SELECT create_tenant_defaults('00000000-0000-0000-0000-00000000000b'); COMMIT;

SET ROLE test_api;

-- ---------- Shop A ----------
BEGIN;
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000000a', true);
INSERT INTO branches (tenant_id, id, code, name) VALUES
  (app_current_tenant(), '10000000-0000-0000-0000-000000000001', 'MAN1', 'Manchester Rd');
INSERT INTO staff (tenant_id, id, role_id, first_name, display_name)
  SELECT app_current_tenant(), '20000000-0000-0000-0000-000000000001', id, 'Sam', 'Sam'
  FROM roles WHERE system_key = 'cashier';
INSERT INTO products (tenant_id, id, name, vat_code, reorder_point, reorder_qty) VALUES
  (app_current_tenant(), '30000000-0000-0000-0000-000000000001', 'Semi-skimmed milk 2L', 'Z', 10, 24),
  (app_current_tenant(), '30000000-0000-0000-0000-000000000002', 'Cola 500ml PMP', 'S', 6, 24);
INSERT INTO product_barcodes (tenant_id, product_id, barcode, is_pmp, pmp_price_pence) VALUES
  (app_current_tenant(), '30000000-0000-0000-0000-000000000002', '5000112637922', true, 125);
INSERT INTO product_prices (tenant_id, product_id, price_level_id, price_pence)
  SELECT app_current_tenant(), '30000000-0000-0000-0000-000000000001', id, 165 FROM price_levels WHERE code='retail';
INSERT INTO product_prices (tenant_id, product_id, price_level_id, price_pence)
  SELECT app_current_tenant(), '30000000-0000-0000-0000-000000000001', id, 145 FROM price_levels WHERE code='trade';
INSERT INTO product_prices (tenant_id, product_id, price_level_id, min_qty, price_pence)
  SELECT app_current_tenant(), '30000000-0000-0000-0000-000000000001', id, 6, 150 FROM price_levels WHERE code='retail';

-- Stock in via ledger, sell some
INSERT INTO stock_movements (tenant_id, branch_id, product_id, quantity, movement_type) VALUES
  (app_current_tenant(), '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 24, 'receipt'),
  (app_current_tenant(), '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', -16, 'sale');
COMMIT;

BEGIN;
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000000a', true);
SELECT 'stock on hand (expect 8)' AS check, quantity FROM stock_levels;
SELECT 'low stock rows (expect 1)' AS check, count(*) FROM v_low_stock;
SELECT 'retail price qty1 (expect 165)' AS check,
  resolve_price('30000000-0000-0000-0000-000000000001', (SELECT id FROM price_levels WHERE code='retail'), '10000000-0000-0000-0000-000000000001', 1);
SELECT 'retail price qty6 (expect 150)' AS check,
  resolve_price('30000000-0000-0000-0000-000000000001', (SELECT id FROM price_levels WHERE code='retail'), '10000000-0000-0000-0000-000000000001', 6);
SELECT 'trade price (expect 145)' AS check,
  resolve_price('30000000-0000-0000-0000-000000000001', (SELECT id FROM price_levels WHERE code='trade'), '10000000-0000-0000-0000-000000000001', 1);
SELECT 'member falls back to retail (expect 165)' AS check,
  resolve_price('30000000-0000-0000-0000-000000000001', (SELECT id FROM price_levels WHERE code='member'), '10000000-0000-0000-0000-000000000001', 1);
SELECT 'cashier can refund? (expect f)' AS check, staff_has_permission('20000000-0000-0000-0000-000000000001','pos.refund');
SELECT 'cashier max discount % (expect 5)' AS check, staff_limit('20000000-0000-0000-0000-000000000001','pos.discount.max_percent');
COMMIT;

-- ---------- Shop B cannot see Shop A ----------
BEGIN;
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000000b', true);
SELECT 'shop B sees A products (expect 0)' AS check, count(*) FROM products;
SELECT 'shop B sees A stock (expect 0)' AS check, count(*) FROM stock_levels;
COMMIT;

-- No tenant set = sees nothing
SELECT 'no tenant context sees (expect 0)' AS check, count(*) FROM products;

-- ---------- Guards that MUST fail ----------
\set ON_ERROR_STOP 0
\echo '--- expected failures below ---'
BEGIN;  -- B tries to insert a row tagged as A
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000000b', true);
INSERT INTO categories (tenant_id, name) VALUES ('00000000-0000-0000-0000-00000000000a', 'hack');
ROLLBACK;
BEGIN;  -- editing the ledger
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000000a', true);
DELETE FROM stock_movements;
ROLLBACK;
BEGIN;  -- writing stock_levels directly
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000000a', true);
UPDATE stock_levels SET quantity = 999;
ROLLBACK;
BEGIN;  -- selling a PMP item above its printed price
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000000a', true);
INSERT INTO sales (tenant_id, id, branch_id, staff_id, receipt_number, subtotal_pence, total_pence, completed_at)
  VALUES (app_current_tenant(), gen_random_uuid(), '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'MAN1-1-1', 150, 150, now())
  RETURNING id \gset
INSERT INTO sale_lines (tenant_id, id, sale_id, line_no, product_id, description, quantity, unit_price_pence,
                        is_pmp, pmp_price_pence, line_total_pence, vat_code, vat_rate_percent, vat_pence)
  VALUES (app_current_tenant(), gen_random_uuid(), :'id', 1, '30000000-0000-0000-0000-000000000002', 'Cola', 1, 150,
          true, 125, 150, 'S', 20, 25);
ROLLBACK;
BEGIN;  -- waste without a reason
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000000a', true);
INSERT INTO stock_movements (tenant_id, branch_id, product_id, quantity, movement_type) VALUES
  (app_current_tenant(), '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', -1, 'waste');
ROLLBACK;
BEGIN;  -- API reading password hashes
SELECT password_hash FROM users;
ROLLBACK;
RESET ROLE;
\echo '--- audit trail entries (expect > 0) ---'
SELECT count(*) FROM audit_log;
