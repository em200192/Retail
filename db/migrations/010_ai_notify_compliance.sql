-- =====================================================================
-- 010_ai_notify_compliance.sql
-- AI forecasts & insights, natural-language Q&A log, notifications
-- (EMAIL now, WhatsApp later = just another channel value), fridge
-- temperature logs, CCTV links, label printing, and the AUDIT LOG.
-- =====================================================================

CREATE TABLE demand_forecasts (
  tenant_id      uuid NOT NULL,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id      uuid NOT NULL,
  product_id     uuid NOT NULL,
  forecast_date  date NOT NULL,
  predicted_qty  numeric(14,3) NOT NULL CHECK (predicted_qty >= 0),
  lower_qty      numeric(14,3),
  upper_qty      numeric(14,3),
  model_version  text NOT NULL,
  features       jsonb,               -- {"bank_holiday": true, "temp_c": 24, "ramadan": false}
  generated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)  REFERENCES branches (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, branch_id, product_id, forecast_date, model_version)
);

CREATE TABLE ai_insights (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id     uuid,
  insight_type  text NOT NULL CHECK (insight_type IN (
                  'reorder','slow_mover','dead_stock','dont_reorder','bestseller_trend','price_opportunity',
                  'supplier_cheaper','expiry_risk','shrinkage_alert','staff_anomaly','cash_variance','margin_drop')),
  severity      text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  title         text NOT NULL,
  body          text NOT NULL,
  body_i18n     jsonb NOT NULL DEFAULT '{}'::jsonb,
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  product_id    uuid,
  staff_id      uuid,
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new','seen','actioned','dismissed')),
  actioned_by   uuid,
  actioned_at   timestamptz,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)   REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id)  REFERENCES products (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, staff_id)    REFERENCES staff (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, actioned_by) REFERENCES staff (tenant_id, id)
);
CREATE INDEX ai_insights_feed ON ai_insights (tenant_id, branch_id, generated_at DESC) WHERE status IN ('new','seen');

-- "How much milk did we sell last week?" — log of every question.
CREATE TABLE ai_queries (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  staff_id     uuid NOT NULL,
  channel      text NOT NULL DEFAULT 'app' CHECK (channel IN ('web','app','email','whatsapp')),
  locale       text,
  question     text NOT NULL,
  answer       text,
  tool_calls   jsonb,                 -- which report tools the model used
  tokens_in    int,
  tokens_out   int,
  latency_ms   int,
  feedback     text CHECK (feedback IN ('up','down')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff (tenant_id, id)
);

-- ---------------------------------------------------------------------
-- Notifications — channel-agnostic. Today: email + push. Later: whatsapp.
-- ---------------------------------------------------------------------
CREATE TABLE notification_preferences (
  tenant_id   uuid NOT NULL,
  staff_id    uuid NOT NULL,
  event_type  text NOT NULL CHECK (event_type IN (
                'low_stock','daily_summary','weekly_summary','purchase_request','task_assigned','task_overdue',
                'expiry_alert','shrinkage_alert','invoice_ready','vat_due','rtw_expiry','order_received','cash_variance')),
  channel     text NOT NULL CHECK (channel IN ('email','push','sms','whatsapp')),
  is_enabled  boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, staff_id, event_type, channel),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE outbound_messages (
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  channel              text NOT NULL CHECK (channel IN ('email','push','sms','whatsapp')),
  template_code        text NOT NULL,                -- 'daily_summary', 'low_stock' ...
  locale               text NOT NULL DEFAULT 'en-GB',
  staff_id             uuid,
  customer_id          uuid,
  to_address           text NOT NULL,
  subject              text,
  payload              jsonb NOT NULL DEFAULT '{}'::jsonb,
  status               text NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued','sending','sent','delivered','failed','bounced','suppressed')),
  provider             text,                          -- 'resend', 'postmark', 'ses', 'meta_whatsapp' ...
  provider_message_id  text,
  attempts             int NOT NULL DEFAULT 0,
  last_error           text,
  scheduled_for        timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id)    REFERENCES staff (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);
CREATE INDEX outbound_messages_queue ON outbound_messages (scheduled_for) WHERE status = 'queued';

-- ---------------------------------------------------------------------
-- Compliance
-- ---------------------------------------------------------------------
CREATE TABLE equipment (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id   uuid NOT NULL,
  name        text NOT NULL,                       -- 'Dairy chiller 1'
  kind        text NOT NULL CHECK (kind IN ('fridge','freezer','hot_hold','other')),
  min_c       numeric(4,1),
  max_c       numeric(4,1),
  is_active   boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);

CREATE TABLE temperature_logs (
  tenant_id          uuid NOT NULL,
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  equipment_id       uuid NOT NULL,
  reading_c          numeric(4,1) NOT NULL,
  is_out_of_range    boolean NOT NULL DEFAULT false,
  corrective_action  text,
  task_id            uuid,
  recorded_by        uuid,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, equipment_id) REFERENCES equipment (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id)      REFERENCES tasks (tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by)  REFERENCES staff (tenant_id, id),
  CHECK (NOT is_out_of_range OR corrective_action IS NOT NULL)
);
CREATE INDEX temperature_logs_time ON temperature_logs (tenant_id, equipment_id, recorded_at DESC);

-- CCTV: map tills to cameras so a suspicious void opens the right clip.
CREATE TABLE cameras (
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id            uuid NOT NULL,
  till_id              uuid,
  connection_id        uuid,
  name                 text NOT NULL,
  provider             text,                        -- 'hikvision', 'dahua', 'reolink' ...
  stream_ref           text,
  clock_offset_seconds int NOT NULL DEFAULT 0,      -- camera clocks drift
  is_active            boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)     REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, till_id)       REFERENCES tills (tenant_id, id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES integration_connections (tenant_id, id)
);

CREATE TABLE label_print_jobs (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id     uuid NOT NULL,
  label_kind    text NOT NULL CHECK (label_kind IN ('shelf_edge','reduced_to_clear','price','barcode')),
  product_ids   uuid[] NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,    -- e.g. reduced price, new expiry
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','printed','failed')),
  requested_by  uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  printed_at    timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)    REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES staff (tenant_id, id)
);

-- ---------------------------------------------------------------------
-- AUDIT LOG — append-only, partitioned by month.
-- Create monthly partitions with pg_partman (or a cron job).
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
  tenant_id       uuid NOT NULL,
  id              bigserial,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_staff_id  uuid,
  actor_user_id   uuid,
  device_id       uuid,
  table_name      text NOT NULL,
  record_id       text,
  action          text NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
  old_data        jsonb,
  new_data        jsonb,
  PRIMARY KEY (tenant_id, occurred_at, id)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;
CREATE INDEX audit_log_record ON audit_log (tenant_id, table_name, record_id, occurred_at DESC);

CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
BEGIN
  -- Never copy secrets into the audit trail
  IF TG_OP IN ('UPDATE','DELETE') THEN
    v_old := to_jsonb(OLD) - 'pos_pin_hash' - 'ni_number_enc' - 'password_hash';
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    v_new := to_jsonb(NEW) - 'pos_pin_hash' - 'ni_number_enc' - 'password_hash';
  END IF;
  IF TG_OP = 'UPDATE' AND v_old = v_new THEN
    RETURN NULL;   -- nothing meaningful changed
  END IF;
  v_row := COALESCE(v_new, v_old);

  INSERT INTO audit_log (tenant_id, actor_staff_id, actor_user_id, device_id,
                         table_name, record_id, action, old_data, new_data)
  VALUES ((v_row->>'tenant_id')::uuid, app_current_staff(), app_current_user(), app_current_device(),
          TG_TABLE_NAME, v_row->>'id', TG_OP, v_old, v_new);
  RETURN NULL;
END $$;

-- Tables where "who changed what" matters.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'roles','role_permissions','role_limits','staff','staff_permission_overrides','staff_limit_overrides',
    'product_prices','products','promotions','price_levels','pay_rates','time_entries','refunds',
    'cash_movements','till_sessions','supplier_invoices','expenses','vat_returns','integration_connections',
    'branches'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION audit_row_change()', t || '_audit', t);
  END LOOP;
END $$;
