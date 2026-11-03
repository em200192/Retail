-- =====================================================================
-- 007_hr_tasks.sql
-- Pay rates, rota, clock in/out, leave, timesheets (export to payroll
-- software — we do NOT calculate PAYE/NI), staff documents, task
-- manager, training quizzes, performance scoring.
-- =====================================================================

CREATE TABLE pay_rates (
  tenant_id            uuid NOT NULL,
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  staff_id             uuid NOT NULL,
  hourly_rate_pence    bigint NOT NULL CHECK (hourly_rate_pence > 0),
  overtime_multiplier  numeric(4,2) NOT NULL DEFAULT 1.00 CHECK (overtime_multiplier >= 1),
  effective_from       date NOT NULL,
  effective_to         date,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id)   REFERENCES staff (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, created_by) REFERENCES staff (tenant_id, id),
  UNIQUE (tenant_id, staff_id, effective_from),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- Rota (planned shifts). Clock-ins are compared against this for punctuality.
CREATE TABLE shifts (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id   uuid NOT NULL,
  staff_id    uuid NOT NULL,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  shift_type  text NOT NULL DEFAULT 'day' CHECK (shift_type IN ('morning','day','evening','night')),
  note        text,
  published   boolean NOT NULL DEFAULT false,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)  REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id)   REFERENCES staff (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES staff (tenant_id, id),
  CHECK (ends_at > starts_at)
);
CREATE INDEX shifts_staff_time  ON shifts (tenant_id, staff_id, starts_at);
CREATE INDEX shifts_branch_time ON shifts (tenant_id, branch_id, starts_at);

CREATE TABLE time_entries (
  tenant_id            uuid NOT NULL,
  id                   uuid NOT NULL,                -- device-generated (offline clock-in)
  staff_id             uuid NOT NULL,
  branch_id            uuid NOT NULL,
  shift_id             uuid,
  clock_in_at          timestamptz NOT NULL,
  clock_out_at         timestamptz,
  clock_in_method      text NOT NULL CHECK (clock_in_method IN ('pos_pin','mobile_app','manager_entry')),
  clock_out_method     text CHECK (clock_out_method IN ('pos_pin','mobile_app','manager_entry','auto_closed')),
  clock_in_device_id   uuid,
  within_geofence      boolean,                      -- store the result, not raw GPS
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','approved','disputed')),
  edited_by            uuid,
  edit_reason          text,
  approved_by          uuid,
  approved_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id)           REFERENCES staff (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)          REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id)           REFERENCES shifts (tenant_id, id),
  FOREIGN KEY (tenant_id, clock_in_device_id) REFERENCES devices (tenant_id, id),
  FOREIGN KEY (tenant_id, edited_by)          REFERENCES staff (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by)        REFERENCES staff (tenant_id, id),
  CHECK (clock_out_at IS NULL OR clock_out_at > clock_in_at),
  CHECK (status = 'open' OR clock_out_at IS NOT NULL),
  CHECK (edited_by IS NULL OR edit_reason IS NOT NULL)
);
CREATE UNIQUE INDEX time_entries_one_open ON time_entries (tenant_id, staff_id) WHERE status = 'open';
CREATE INDEX time_entries_staff_time ON time_entries (tenant_id, staff_id, clock_in_at DESC);

CREATE TABLE time_entry_breaks (
  tenant_id      uuid NOT NULL,
  id             uuid NOT NULL,
  time_entry_id  uuid NOT NULL,
  started_at     timestamptz NOT NULL,
  ended_at       timestamptz,
  is_paid        boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, time_entry_id) REFERENCES time_entries (tenant_id, id) ON DELETE CASCADE,
  CHECK (ended_at IS NULL OR ended_at > started_at)
);

CREATE TABLE leave_requests (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  staff_id     uuid NOT NULL,
  leave_type   text NOT NULL CHECK (leave_type IN ('holiday','sick','unpaid','compassionate','other')),
  starts_on    date NOT NULL,
  ends_on      date NOT NULL,
  hours        numeric(6,2),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  note         text,
  reviewed_by  uuid,
  reviewed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id)    REFERENCES staff (tenant_id, id),
  FOREIGN KEY (tenant_id, reviewed_by) REFERENCES staff (tenant_id, id),
  CHECK (ends_on >= starts_on)
);

CREATE TABLE leave_balances (
  tenant_id          uuid NOT NULL,
  staff_id           uuid NOT NULL,
  leave_year_start   date NOT NULL,
  entitlement_hours  numeric(7,2) NOT NULL DEFAULT 0,
  accrued_hours      numeric(7,2) NOT NULL DEFAULT 0,   -- for irregular-hours workers
  taken_hours        numeric(7,2) NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, staff_id, leave_year_start),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE pay_periods (
  tenant_id                  uuid NOT NULL REFERENCES tenants(id),
  id                         uuid NOT NULL DEFAULT gen_random_uuid(),
  frequency                  text NOT NULL CHECK (frequency IN ('daily','weekly','fortnightly','four_weekly','monthly')),
  starts_on                  date NOT NULL,
  ends_on                    date NOT NULL,
  status                     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','locked','exported')),
  export_target              text CHECK (export_target IN ('xero','brightpay','sage','quickbooks','csv')),
  export_file_attachment_id  uuid,
  exported_at                timestamptz,
  exported_by                uuid,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, export_file_attachment_id) REFERENCES attachments (tenant_id, id),
  FOREIGN KEY (tenant_id, exported_by)               REFERENCES staff (tenant_id, id),
  UNIQUE (tenant_id, frequency, starts_on),
  CHECK (ends_on >= starts_on)
);

-- Gross only. PAYE / NI / pension are done by the payroll software.
CREATE TABLE timesheet_lines (
  tenant_id             uuid NOT NULL,
  id                    uuid NOT NULL DEFAULT gen_random_uuid(),
  pay_period_id         uuid NOT NULL,
  staff_id              uuid NOT NULL,
  regular_hours         numeric(7,2) NOT NULL DEFAULT 0,
  overtime_hours        numeric(7,2) NOT NULL DEFAULT 0,
  holiday_hours         numeric(7,2) NOT NULL DEFAULT 0,
  hourly_rate_pence     bigint NOT NULL,
  gross_pay_pence       bigint NOT NULL CHECK (gross_pay_pence >= 0),
  below_minimum_wage    boolean NOT NULL DEFAULT false,      -- compliance alert
  notes                 text,
  computed_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, pay_period_id) REFERENCES pay_periods (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, staff_id)      REFERENCES staff (tenant_id, id),
  UNIQUE (tenant_id, pay_period_id, staff_id)
);

-- Right to Work, contracts, certificates. Files encrypted in storage.
CREATE TABLE staff_documents (
  tenant_id      uuid NOT NULL,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  staff_id       uuid NOT NULL,
  doc_type       text NOT NULL CHECK (doc_type IN ('right_to_work','contract','training_certificate','food_hygiene_certificate','other')),
  attachment_id  uuid NOT NULL,
  share_code     text,                                -- Home Office online check
  expires_on     date,                                -- alert before visa/RTW expiry
  verified_by    uuid,
  verified_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id)      REFERENCES staff (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, attachment_id) REFERENCES attachments (tenant_id, id),
  FOREIGN KEY (tenant_id, verified_by)   REFERENCES staff (tenant_id, id)
);
CREATE INDEX staff_documents_expiry ON staff_documents (tenant_id, expires_on) WHERE expires_on IS NOT NULL;

-- ---------------------------------------------------------------------
-- Task manager
-- ---------------------------------------------------------------------
CREATE TABLE task_templates (
  tenant_id                 uuid NOT NULL REFERENCES tenants(id),
  id                        uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id                 uuid,                    -- NULL = all branches
  title                     text NOT NULL,
  description               text,
  kind                      text NOT NULL DEFAULT 'general'
                            CHECK (kind IN ('general','opening','closing','expiry_check','cleaning','temperature_check','stock_count','delivery')),
  rrule                     text NOT NULL,           -- RFC 5545, e.g. 'FREQ=DAILY'
  due_time                  time,
  default_assignee_role_id  uuid,
  requires_photo            boolean NOT NULL DEFAULT false,
  is_active                 boolean NOT NULL DEFAULT true,
  created_by                uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)                REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, default_assignee_role_id) REFERENCES roles (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)               REFERENCES staff (tenant_id, id)
);

CREATE TABLE tasks (
  tenant_id                 uuid NOT NULL REFERENCES tenants(id),
  id                        uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id                 uuid NOT NULL,
  template_id               uuid,
  title                     text NOT NULL,
  description               text,
  priority                  text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  assigned_to               uuid,                    -- a person ...
  assigned_role_id          uuid,                    -- ... or anyone with this role
  due_at                    timestamptz,
  status                    text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done','cancelled')),
  requires_photo            boolean NOT NULL DEFAULT false,
  completion_attachment_id  uuid,
  completion_note           text,
  completed_by              uuid,
  completed_at              timestamptz,
  created_by                uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)                REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, template_id)              REFERENCES task_templates (tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_to)              REFERENCES staff (tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_role_id)         REFERENCES roles (tenant_id, id),
  FOREIGN KEY (tenant_id, completion_attachment_id) REFERENCES attachments (tenant_id, id),
  FOREIGN KEY (tenant_id, completed_by)             REFERENCES staff (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)               REFERENCES staff (tenant_id, id),
  CHECK (status <> 'done' OR (completed_by IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK (status <> 'done' OR NOT requires_photo OR completion_attachment_id IS NOT NULL)
);
CREATE INDEX tasks_assignee_open ON tasks (tenant_id, assigned_to, due_at) WHERE status IN ('todo','in_progress');
CREATE INDEX tasks_branch_open   ON tasks (tenant_id, branch_id, due_at)   WHERE status IN ('todo','in_progress');
-- One task per template per due time (idempotent recurring generator)
CREATE UNIQUE INDEX tasks_template_due_uq ON tasks (tenant_id, template_id, due_at) WHERE template_id IS NOT NULL;

CREATE TABLE task_checklist_items (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  task_id      uuid,
  template_id  uuid,
  position     int NOT NULL DEFAULT 0,
  label        text NOT NULL,
  is_done      boolean NOT NULL DEFAULT false,
  done_by      uuid,
  done_at      timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, task_id)     REFERENCES tasks (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, template_id) REFERENCES task_templates (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, done_by)     REFERENCES staff (tenant_id, id),
  CHECK ((task_id IS NULL) <> (template_id IS NULL))
);

-- ---------------------------------------------------------------------
-- Training quizzes (Challenge 25, food safety, refunds policy ...)
-- Platform templates are copied into each tenant on signup.
-- ---------------------------------------------------------------------
CREATE TABLE quizzes (
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  id                    uuid NOT NULL DEFAULT gen_random_uuid(),
  title                 text NOT NULL,
  title_i18n            jsonb NOT NULL DEFAULT '{}'::jsonb,
  topic                 text NOT NULL CHECK (topic IN ('challenge_25','food_safety','refunds','products','health_safety','custom')),
  source_template_code  text,
  pass_mark_percent     smallint NOT NULL DEFAULT 80 CHECK (pass_mark_percent BETWEEN 1 AND 100),
  is_mandatory          boolean NOT NULL DEFAULT false,
  recertify_days        int,                         -- e.g. 365 = yearly refresher
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE quiz_questions (
  tenant_id      uuid NOT NULL,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  quiz_id        uuid NOT NULL,
  position       int NOT NULL DEFAULT 0,
  question_type  text NOT NULL DEFAULT 'single' CHECK (question_type IN ('single','multi','true_false')),
  prompt         text NOT NULL,
  prompt_i18n    jsonb NOT NULL DEFAULT '{}'::jsonb,
  explanation    text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, quiz_id) REFERENCES quizzes (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE quiz_options (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  question_id  uuid NOT NULL,
  position     int NOT NULL DEFAULT 0,
  label        text NOT NULL,
  label_i18n   jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_correct   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, question_id) REFERENCES quiz_questions (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE quiz_assignments (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  quiz_id      uuid NOT NULL,
  staff_id     uuid NOT NULL,
  assigned_by  uuid,
  due_at       timestamptz,
  status       text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','passed','failed','expired')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, quiz_id)     REFERENCES quizzes (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, staff_id)    REFERENCES staff (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, assigned_by) REFERENCES staff (tenant_id, id)
);

CREATE TABLE quiz_attempts (
  tenant_id      uuid NOT NULL,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  quiz_id        uuid NOT NULL,
  staff_id       uuid NOT NULL,
  assignment_id  uuid,
  started_at     timestamptz NOT NULL DEFAULT now(),
  submitted_at   timestamptz,
  score_percent  numeric(5,2),
  passed         boolean,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, quiz_id)       REFERENCES quizzes (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id)      REFERENCES staff (tenant_id, id),
  FOREIGN KEY (tenant_id, assignment_id) REFERENCES quiz_assignments (tenant_id, id)
);
CREATE INDEX quiz_attempts_staff ON quiz_attempts (tenant_id, staff_id, submitted_at DESC);

CREATE TABLE quiz_attempt_answers (
  tenant_id            uuid NOT NULL,
  attempt_id           uuid NOT NULL,
  question_id          uuid NOT NULL,
  selected_option_ids  uuid[] NOT NULL DEFAULT '{}',
  is_correct           boolean NOT NULL,
  PRIMARY KEY (tenant_id, attempt_id, question_id),
  FOREIGN KEY (tenant_id, attempt_id)  REFERENCES quiz_attempts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, question_id) REFERENCES quiz_questions (tenant_id, id)
);

-- ---------------------------------------------------------------------
-- Performance (ADVISORY ONLY — never drives automatic HR decisions;
-- UK GDPR Art. 22. Staff must be told which metrics are measured.)
-- ---------------------------------------------------------------------
CREATE TABLE performance_kpi_weights (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  kpi_code    text NOT NULL CHECK (kpi_code IN ('punctuality','task_completion','cash_accuracy','scan_speed',
                                                'risk_ratio','stocktake_accuracy','training','manager_rating')),
  weight      numeric(5,2) NOT NULL DEFAULT 1 CHECK (weight >= 0),
  is_enabled  boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, kpi_code)
);

CREATE TABLE manager_ratings (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  staff_id      uuid NOT NULL,
  rated_by      uuid NOT NULL,
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  stars         smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, rated_by) REFERENCES staff (tenant_id, id),
  UNIQUE (tenant_id, staff_id, rated_by, period_start),
  CHECK (staff_id <> rated_by)
);

CREATE TABLE performance_snapshots (
  tenant_id         uuid NOT NULL,
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  staff_id          uuid NOT NULL,
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  peer_group        text NOT NULL,                 -- e.g. 'night' — compare like with like
  metrics           jsonb NOT NULL,                -- raw value + peer median per KPI
  score             numeric(5,2) CHECK (score BETWEEN 0 AND 100),
  model_version     text NOT NULL,
  computed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff (tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, staff_id, period_start, period_end)
);
