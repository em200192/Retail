-- =====================================================================
-- 003_org_access.sql
-- Branches, roles & permissions, staff, devices, file attachments.
--
-- CONVENTION for every tenant table:
--   * tenant_id uuid NOT NULL is the FIRST column
--   * PRIMARY KEY (tenant_id, id)
--   * every reference to another tenant table is a COMPOSITE foreign key
--     (tenant_id, x_id) -> x(tenant_id, id). This makes it physically
--     impossible to link a row to another shop's data, even by a bug.
--     (FK checks bypass RLS, so RLS alone would NOT prevent this.)
-- =====================================================================

CREATE TABLE branches (
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  code           text NOT NULL,                 -- short code used in receipt numbers
  name           text NOT NULL,
  address_line1  text,
  address_line2  text,
  city           text,
  postcode       text,
  phone          text,
  latitude       numeric(9,6),
  longitude      numeric(9,6),
  geofence_m     int NOT NULL DEFAULT 150,      -- mobile clock-in radius
  timezone       text NOT NULL DEFAULT 'Europe/London',
  is_active      boolean NOT NULL DEFAULT true,
  settings       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE roles (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  system_key   text CHECK (system_key IN ('owner','manager','supervisor','cashier','stock')),
  description  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, name)
);
CREATE UNIQUE INDEX roles_system_key_uq ON roles (tenant_id, system_key) WHERE system_key IS NOT NULL;

CREATE TABLE role_permissions (
  tenant_id        uuid NOT NULL,
  role_id          uuid NOT NULL,
  permission_code  text NOT NULL REFERENCES permissions(code),
  PRIMARY KEY (tenant_id, role_id, permission_code),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE role_limits (
  tenant_id   uuid NOT NULL,
  role_id     uuid NOT NULL,
  limit_code  text NOT NULL REFERENCES limit_definitions(code),
  value       numeric(14,2) NOT NULL CHECK (value >= 0),
  PRIMARY KEY (tenant_id, role_id, limit_code),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id) ON DELETE CASCADE
);

-- An employee of this tenant. user_id is NULL for POS-only staff
-- who only log in with a PIN on the till.
CREATE TABLE staff (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id          uuid REFERENCES users(id),
  role_id          uuid NOT NULL,
  employee_number  text,
  first_name       text NOT NULL,
  last_name        text,
  display_name     text NOT NULL,              -- shown on receipts: "Served by Sam"
  email            citext,
  phone            text,
  locale           text NOT NULL DEFAULT 'en-GB',
  pos_pin_hash     text,                       -- argon2/bcrypt, never plain
  date_of_birth    date,                       -- needed for minimum-wage age band
  ni_number_enc    bytea,                      -- encrypted at app layer (payroll export)
  employment_type  text NOT NULL DEFAULT 'part_time'
                   CHECK (employment_type IN ('full_time','part_time','zero_hours','casual','contractor')),
  status           text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('invited','active','suspended','left')),
  start_date       date,
  end_date         date,
  settings         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id),
  UNIQUE (tenant_id, employee_number),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE UNIQUE INDEX staff_user_uq ON staff (tenant_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX staff_user_idx ON staff (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE staff_branch_access (
  tenant_id   uuid NOT NULL,
  staff_id    uuid NOT NULL,
  branch_id   uuid NOT NULL,
  is_primary  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, staff_id, branch_id),
  FOREIGN KEY (tenant_id, staff_id)  REFERENCES staff (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id) ON DELETE CASCADE
);

-- Per-person exceptions on top of the role: grant (true) or revoke (false).
CREATE TABLE staff_permission_overrides (
  tenant_id        uuid NOT NULL,
  staff_id         uuid NOT NULL,
  permission_code  text NOT NULL REFERENCES permissions(code),
  granted          boolean NOT NULL,
  reason           text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, staff_id, permission_code),
  FOREIGN KEY (tenant_id, staff_id)   REFERENCES staff (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, created_by) REFERENCES staff (tenant_id, id)
);

CREATE TABLE staff_limit_overrides (
  tenant_id   uuid NOT NULL,
  staff_id    uuid NOT NULL,
  limit_code  text NOT NULL REFERENCES limit_definitions(code),
  value       numeric(14,2) NOT NULL CHECK (value >= 0),
  PRIMARY KEY (tenant_id, staff_id, limit_code),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff (tenant_id, id) ON DELETE CASCADE
);

-- Tills, handhelds, label printers, scales ...
CREATE TABLE devices (
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id           uuid NOT NULL,
  name                text NOT NULL,
  kind                text NOT NULL
                      CHECK (kind IN ('pos','handheld','self_checkout','label_printer','scale','customer_display','back_office')),
  platform            text,                 -- 'ipad', 'android', 'windows', 'web'
  app_version         text,
  device_secret_hash  text,                 -- device auth for offline sync
  last_seen_at        timestamptz,
  last_sync_at        timestamptz,
  is_active           boolean NOT NULL DEFAULT true,
  registered_at       timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);

-- Files live in object storage (S3 / R2); this table only holds the pointer.
CREATE TABLE attachments (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  storage_key  text NOT NULL,
  file_name    text,
  mime_type    text NOT NULL,
  size_bytes   bigint CHECK (size_bytes >= 0),
  sha256       text,
  uploaded_by  uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, storage_key),
  FOREIGN KEY (tenant_id, uploaded_by) REFERENCES staff (tenant_id, id)
);
