-- =====================================================================
-- 100_seed.sql
-- Permissions, limits, UK VAT rates, plans, wholesalers, and
-- create_tenant_defaults() which sets up a new shop in one call.
-- =====================================================================

INSERT INTO permissions (code, module, description) VALUES
  -- POS
  ('pos.sell',               'pos',        'Sell at the till'),
  ('pos.discount',           'pos',        'Apply manual discounts (within limit)'),
  ('pos.price_override',     'pos',        'Change an item price at the till'),
  ('pos.void_line',          'pos',        'Remove an item from the basket'),
  ('pos.void_sale',          'pos',        'Void a whole sale'),
  ('pos.refund',             'pos',        'Process refunds (within limit)'),
  ('pos.refund_unreceipted', 'pos',        'Refund without a receipt'),
  ('pos.no_sale',            'pos',        'Open cash drawer without a sale'),
  ('pos.paid_out',           'pos',        'Pay cash out of the till'),
  ('pos.open_till',          'pos',        'Open a till session'),
  ('pos.close_till',         'pos',        'Cash up and close a till'),
  ('pos.z_report',           'pos',        'View end-of-day Z report'),
  ('pos.training_mode',      'pos',        'Use training mode'),
  ('pos.approve',            'pos',        'Approve actions for other staff (manager PIN)'),
  -- Catalogue & pricing
  ('products.view',          'catalog',    'View products'),
  ('products.edit',          'catalog',    'Create and edit products'),
  ('prices.edit',            'catalog',    'Change selling prices'),
  ('promotions.manage',      'catalog',    'Create and edit promotions'),
  ('labels.print',           'catalog',    'Print shelf and reduced labels'),
  -- Stock
  ('stock.view',             'stock',      'View stock levels'),
  ('stock.adjust',           'stock',      'Adjust stock'),
  ('stock.waste',            'stock',      'Record waste'),
  ('stock.transfer',         'stock',      'Transfer stock between branches'),
  ('stock.count',            'stock',      'Do stocktakes'),
  -- Purchasing
  ('purchasing.request',     'purchasing', 'Ask the manager for items ("we need")'),
  ('purchasing.manage_list', 'purchasing', 'Manage the shopping list and approve requests'),
  ('purchasing.order',       'purchasing', 'Create and send purchase orders'),
  ('invoices.upload',        'purchasing', 'Upload supplier invoices'),
  ('invoices.approve',       'purchasing', 'Review OCR and post invoices to stock'),
  ('suppliers.manage',       'purchasing', 'Manage suppliers'),
  -- Customers
  ('customers.view',         'customers',  'View customers'),
  ('customers.manage',       'customers',  'Create and edit customers'),
  -- Orders
  ('orders.handle',          'orders',     'Accept, pick and complete online orders'),
  -- HR
  ('time.clock',             'hr',         'Clock in and out'),
  ('time.edit',              'hr',         'Edit time entries'),
  ('time.approve',           'hr',         'Approve timesheets'),
  ('rota.manage',            'hr',         'Create the rota'),
  ('leave.request',          'hr',         'Request leave'),
  ('leave.approve',          'hr',         'Approve leave'),
  ('payroll.export',         'hr',         'Export timesheets to payroll'),
  ('staff.view',             'hr',         'View staff'),
  ('staff.manage',           'hr',         'Add and edit staff'),
  ('staff.documents',        'hr',         'View Right-to-Work and contracts'),
  ('roles.manage',           'hr',         'Manage roles, permissions and limits'),
  -- Tasks & training
  ('tasks.own',              'tasks',      'See and complete own tasks'),
  ('tasks.manage',           'tasks',      'Create and assign tasks'),
  ('quizzes.take',           'training',   'Take training quizzes'),
  ('quizzes.manage',         'training',   'Create and assign quizzes'),
  ('performance.view',       'training',   'View staff performance'),
  -- Reports & finance
  ('reports.sales',          'reports',    'Sales reports'),
  ('reports.stock',          'reports',    'Stock reports'),
  ('reports.financial',      'reports',    'Profit, margin and finance reports'),
  ('reports.staff',          'reports',    'Staff and loss-prevention reports'),
  ('finance.expenses',       'finance',    'Record expenses'),
  ('finance.vat',            'finance',    'Prepare and submit VAT returns'),
  -- AI
  ('ai.ask',                 'ai',         'Ask the AI assistant questions'),
  ('ai.insights',            'ai',         'See AI insights'),
  -- Admin
  ('compliance.manage',      'admin',      'Temperature logs, Challenge 25 records'),
  ('integrations.manage',    'admin',      'Connect Uber Eats, Xero, card terminals ...'),
  ('branches.manage',        'admin',      'Manage branches and devices'),
  ('settings.manage',        'admin',      'Business settings'),
  ('billing.manage',         'admin',      'Subscription and billing'),
  ('audit.view',             'admin',      'View audit log')
ON CONFLICT (code) DO NOTHING;

INSERT INTO limit_definitions (code, unit, description) VALUES
  ('pos.discount.max_percent',      'percent', 'Max manual discount % per line or basket without approval'),
  ('pos.discount.max_amount_pence', 'pence',   'Max manual discount amount without approval'),
  ('pos.price_override.max_percent','percent', 'Max % a price can be lowered at the till'),
  ('pos.refund.max_amount_pence',   'pence',   'Max refund without approval'),
  ('pos.paid_out.max_amount_pence', 'pence',   'Max cash paid out without approval'),
  ('pos.void_line.max_per_shift',   'count',   'Line voids per shift before approval is required'),
  ('pos.no_sale.max_per_shift',     'count',   'No-sales per shift before approval is required'),
  ('stock.adjust.max_qty',          'count',   'Max units per stock adjustment without approval')
ON CONFLICT (code) DO NOTHING;

-- UK VAT. Most food = Zero, domestic fuel/some items = Reduced, rest = Standard.
INSERT INTO vat_rates (code, rate_percent, name, valid_from) VALUES
  ('S', 20.00, 'Standard', '2011-01-04'),
  ('R',  5.00, 'Reduced',  '1997-09-01'),
  ('Z',  0.00, 'Zero',     '1973-04-01'),
  ('E',  0.00, 'Exempt',   '1973-04-01')
ON CONFLICT DO NOTHING;

INSERT INTO plans (id, name, monthly_price_pence, max_branches, max_devices, features) VALUES
  ('starter',     'Starter',     0, 1,    1,    '{"ai_insights": false, "integrations": false}'),
  ('pro',         'Pro',         0, 1,    3,    '{"ai_insights": true,  "integrations": true}'),
  ('multi_store', 'Multi-store', 0, NULL, NULL, '{"ai_insights": true,  "integrations": true, "transfers": true}')
ON CONFLICT (id) DO NOTHING;   -- set real prices before launch

INSERT INTO global_suppliers (name, website, invoice_parser_key) VALUES
  ('Booker',   'https://www.booker.co.uk',   'booker'),
  ('Bestway',  'https://www.bestwaywholesale.co.uk', 'bestway'),
  ('Costco',   'https://www.costco.co.uk',   'costco'),
  ('Parfetts', 'https://www.parfetts.co.uk', 'parfetts'),
  ('Unitas',   'https://www.unitaswholesale.co.uk', 'unitas'),
  ('Dhamecha', 'https://www.dhamecha.com',   'dhamecha')
ON CONFLICT (name) DO NOTHING;

-- statutory_wage_rates: seed from gov.uk each April (rates change yearly).

-- ---------------------------------------------------------------------
-- New shop setup: default roles + permissions + limits, price levels,
-- KPI weights, expense categories. Call from the signup worker right
-- after inserting the tenant row.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_tenant_defaults(p_tenant uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_owner uuid; v_manager uuid; v_supervisor uuid; v_cashier uuid; v_stock uuid;
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant::text, true);

  INSERT INTO roles (tenant_id, name, system_key, description) VALUES
    (p_tenant, 'Owner',      'owner',      'Full access')                       RETURNING id INTO v_owner;
  INSERT INTO roles (tenant_id, name, system_key, description) VALUES
    (p_tenant, 'Manager',    'manager',    'Runs the shop day to day')          RETURNING id INTO v_manager;
  INSERT INTO roles (tenant_id, name, system_key, description) VALUES
    (p_tenant, 'Supervisor', 'supervisor', 'Senior cashier, can approve small actions') RETURNING id INTO v_supervisor;
  INSERT INTO roles (tenant_id, name, system_key, description) VALUES
    (p_tenant, 'Cashier',    'cashier',    'Till staff')                        RETURNING id INTO v_cashier;
  INSERT INTO roles (tenant_id, name, system_key, description) VALUES
    (p_tenant, 'Stock',      'stock',      'Shelf filling, deliveries, counts') RETURNING id INTO v_stock;

  -- Owner: everything
  INSERT INTO role_permissions (tenant_id, role_id, permission_code)
  SELECT p_tenant, v_owner, code FROM permissions;

  -- Manager: everything except roles, billing, integrations, VAT submission
  INSERT INTO role_permissions (tenant_id, role_id, permission_code)
  SELECT p_tenant, v_manager, code FROM permissions
  WHERE code NOT IN ('roles.manage','billing.manage','integrations.manage','finance.vat','settings.manage');

  INSERT INTO role_permissions (tenant_id, role_id, permission_code)
  SELECT p_tenant, v_supervisor, code FROM permissions
  WHERE code IN ('pos.sell','pos.discount','pos.price_override','pos.void_line','pos.void_sale','pos.refund',
                 'pos.no_sale','pos.open_till','pos.close_till','pos.z_report','pos.approve','pos.training_mode',
                 'products.view','labels.print','stock.view','stock.waste','stock.count','purchasing.request',
                 'invoices.upload','customers.view','customers.manage','orders.handle','time.clock',
                 'leave.request','tasks.own','quizzes.take','ai.ask');

  INSERT INTO role_permissions (tenant_id, role_id, permission_code)
  SELECT p_tenant, v_cashier, code FROM permissions
  WHERE code IN ('pos.sell','pos.discount','pos.void_line','pos.open_till','pos.training_mode',
                 'products.view','stock.view','purchasing.request','customers.view','orders.handle',
                 'time.clock','leave.request','tasks.own','quizzes.take');

  INSERT INTO role_permissions (tenant_id, role_id, permission_code)
  SELECT p_tenant, v_stock, code FROM permissions
  WHERE code IN ('products.view','labels.print','stock.view','stock.waste','stock.count','stock.transfer',
                 'purchasing.request','invoices.upload','orders.handle','time.clock','leave.request',
                 'tasks.own','quizzes.take');

  -- Limits (pence / percent / count)
  INSERT INTO role_limits (tenant_id, role_id, limit_code, value) VALUES
    (p_tenant, v_manager,    'pos.discount.max_percent',       50),
    (p_tenant, v_manager,    'pos.refund.max_amount_pence', 20000),
    (p_tenant, v_manager,    'pos.paid_out.max_amount_pence',10000),
    (p_tenant, v_supervisor, 'pos.discount.max_percent',       20),
    (p_tenant, v_supervisor, 'pos.discount.max_amount_pence',  500),
    (p_tenant, v_supervisor, 'pos.refund.max_amount_pence',   2000),
    (p_tenant, v_supervisor, 'pos.void_line.max_per_shift',     30),
    (p_tenant, v_cashier,    'pos.discount.max_percent',        5),
    (p_tenant, v_cashier,    'pos.discount.max_amount_pence',  100),
    (p_tenant, v_cashier,    'pos.void_line.max_per_shift',     10),
    (p_tenant, v_cashier,    'pos.no_sale.max_per_shift',        0);

  INSERT INTO price_levels (tenant_id, code, name, is_default, requires_customer, sort_order) VALUES
    (p_tenant, 'retail', 'Retail',  true,  false, 0),
    (p_tenant, 'member', 'Member',  false, true,  1),
    (p_tenant, 'trade',  'Trade',   false, true,  2),
    (p_tenant, 'staff',  'Staff',   false, false, 3);

  INSERT INTO performance_kpi_weights (tenant_id, kpi_code, weight) VALUES
    (p_tenant, 'punctuality', 15), (p_tenant, 'task_completion', 15), (p_tenant, 'cash_accuracy', 20),
    (p_tenant, 'scan_speed', 10),  (p_tenant, 'risk_ratio', 15),      (p_tenant, 'stocktake_accuracy', 10),
    (p_tenant, 'training', 10),    (p_tenant, 'manager_rating', 5);

  INSERT INTO expense_categories (tenant_id, name, vat_reclaimable) VALUES
    (p_tenant, 'Rent', false), (p_tenant, 'Utilities', true), (p_tenant, 'Business rates', false),
    (p_tenant, 'Wages (non-payroll)', false), (p_tenant, 'Cleaning', true), (p_tenant, 'Repairs', true),
    (p_tenant, 'Card fees', false), (p_tenant, 'Software', true), (p_tenant, 'Insurance', false),
    (p_tenant, 'Other', true);
END $$;
