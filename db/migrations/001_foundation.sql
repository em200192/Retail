-- =====================================================================
-- 001_foundation.sql
-- Extensions, database roles, and shared helper functions.
-- Requires PostgreSQL 16+.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid(), encryption helpers
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fast fuzzy product search

-- ---------------------------------------------------------------------
-- Database roles
--   app_runtime : used by the API / POS sync. Always subject to RLS.
--   app_worker  : background jobs (forecasting, benchmarks, webhook routing).
--                 Bypasses RLS. Never used for user-facing requests.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker') THEN
    CREATE ROLE app_worker NOLOGIN BYPASSRLS;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- Request context. The API sets these at the start of EVERY transaction:
--   SELECT set_config('app.tenant_id', $1, true);  -- true = transaction-local
--   SELECT set_config('app.staff_id',  $2, true);
--   SELECT set_config('app.user_id',   $3, true);
--   SELECT set_config('app.device_id', $4, true);
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_current_staff() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.staff_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_current_device() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.device_id', true), '')::uuid
$$;

-- Keeps updated_at fresh. Attached automatically in 099_security.sql
-- to every table that has an updated_at column.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Blocks UPDATE/DELETE on append-only ledgers (stock_movements, audit_log).
CREATE OR REPLACE FUNCTION prevent_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: post a correcting entry instead', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;
