-- =====================================================================
-- 099_security.sql
-- Row-Level Security on every tenant table, grants, updated_at triggers.
-- Run LAST, and re-run after adding new tables (it is idempotent).
-- =====================================================================

-- 1) RLS on every table with a NOT NULL tenant_id column.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN pg_class cl ON cl.relname = c.table_name
    JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = c.table_schema
    WHERE c.table_schema = 'public'
      AND c.column_name = 'tenant_id'
      AND c.is_nullable = 'NO'
      AND cl.relkind IN ('r','p')          -- tables and partitioned parents
      AND NOT cl.relispartition            -- partitions inherit via parent
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = app_current_tenant())
         WITH CHECK (tenant_id = app_current_tenant())', r.table_name);
  END LOOP;
END $$;

-- 2) tenants: a tenant sees and edits only itself.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self ON tenants;
CREATE POLICY tenant_self ON tenants
  USING (id = app_current_tenant())
  WITH CHECK (id = app_current_tenant());

-- 3) users: you see yourself and colleagues in the current tenant; you edit only yourself.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_visible ON users;
DROP POLICY IF EXISTS users_self_update ON users;
CREATE POLICY users_visible ON users FOR SELECT
  USING (id = app_current_user()
         OR EXISTS (SELECT 1 FROM staff s WHERE s.user_id = users.id));   -- staff is RLS-filtered
CREATE POLICY users_self_update ON users FOR UPDATE
  USING (id = app_current_user())
  WITH CHECK (id = app_current_user());

-- 4) Grants
GRANT USAGE ON SCHEMA public TO app_runtime, app_worker;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_runtime;

GRANT ALL ON ALL TABLES IN SCHEMA public TO app_worker;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO app_worker;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_worker;

-- Global reference data: read-only for the API.
REVOKE INSERT, UPDATE, DELETE ON
  plans, permissions, limit_definitions, vat_rates, statutory_wage_rates, global_suppliers,
  catalog_products, network_price_benchmarks, supplier_cost_benchmarks
FROM app_runtime;

-- Signup / tenant creation happen through the worker (auth service).
REVOKE INSERT, DELETE ON tenants FROM app_runtime;

-- users: no password hashes for the API role; column-level grants only.
REVOKE ALL ON users FROM app_runtime;
GRANT SELECT (id, email, phone, full_name, locale, mfa_enabled, last_login_at, created_at, updated_at)
  ON users TO app_runtime;
GRANT UPDATE (phone, full_name, locale) ON users TO app_runtime;

-- Webhooks are worker-only.
REVOKE ALL ON webhook_inbox FROM app_runtime;

-- Ledgers are append-only for the API (trigger also enforces it).
REVOKE UPDATE, DELETE ON stock_movements, audit_log FROM app_runtime;
-- stock_levels is maintained by trigger only.
REVOKE INSERT, UPDATE, DELETE ON stock_levels FROM app_runtime;

-- 5) updated_at triggers on every table that has the column.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN pg_class cl ON cl.relname = c.table_name
    JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'updated_at'
      AND cl.relkind = 'r' AND NOT cl.relispartition
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', r.table_name || '_updated_at', r.table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()', r.table_name || '_updated_at', r.table_name);
  END LOOP;
END $$;
