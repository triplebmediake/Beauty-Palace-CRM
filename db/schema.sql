-- =====================================================================
-- Cute Nails & Salons Kenya - PostgreSQL schema (PostgreSQL 14+)
-- Design rules:
--   * One customer -> many visits -> one transaction per visit -> many items.
--   * Money is NUMERIC(12,2). Every monetary value that matters for history
--     (price, material cost, commission) is FROZEN on the row at sale time.
--   * History is append-only: no DELETE on sales/payments/commissions/ledger.
--   * Every important change is written to audit_logs by trigger.
--   * Every operational table carries branch_id so branches can be added later.
-- =====================================================================
BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- fast fuzzy search
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- exclusion constraints

-- ---------------------------------------------------------------------
-- 0. Helper functions
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- Normalise Kenyan phone numbers to 2547XXXXXXXX / 2541XXXXXXXX (used for de-duplication)
CREATE OR REPLACE FUNCTION normalize_ke_phone(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p IS NULL THEN NULL
    ELSE (SELECT CASE
            WHEN d ~ '^254[17][0-9]{8}$' THEN d
            WHEN d ~ '^0[17][0-9]{8}$'   THEN '254' || substr(d, 2)
            WHEN d ~ '^[17][0-9]{8}$'    THEN '254' || d
            ELSE NULLIF(d, '') END
          FROM (SELECT regexp_replace(p, '[^0-9]', '', 'g') AS d) x)
  END
$$;

-- Business reporting week runs SATURDAY -> FRIDAY. Returns the Saturday that starts the week.
-- dow: Sun=0 ... Sat=6  =>  Sat->0 days back, Sun->1, Mon->2, ... Fri->6
CREATE OR REPLACE FUNCTION business_week_start(d date) RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT d - ((extract(dow FROM d)::int + 1) % 7)
$$;

CREATE OR REPLACE FUNCTION business_today() RETURNS date LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE 'Africa/Nairobi')::date
$$;

CREATE OR REPLACE FUNCTION forbid_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows can never be deleted (append-only history)', TG_TABLE_NAME
  USING ERRCODE = 'restrict_violation'; END $$;

CREATE OR REPLACE FUNCTION forbid_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are immutable once written', TG_TABLE_NAME
  USING ERRCODE = 'restrict_violation'; END $$;

-- ---------------------------------------------------------------------
-- 1. Branches, users, roles, permissions
-- ---------------------------------------------------------------------
CREATE TABLE branches (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  address     TEXT,
  phone       TEXT,
  timezone    TEXT NOT NULL DEFAULT 'Africa/Nairobi',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code  TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL
);

CREATE TABLE permissions (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  description  TEXT
);

CREATE TABLE role_permissions (
  role_id        BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id  BIGINT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE users (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  full_name      TEXT NOT NULL,
  phone          TEXT,
  password_hash  TEXT NOT NULL,
  role_id        BIGINT NOT NULL REFERENCES roles(id),
  is_active      BOOLEAN NOT NULL DEFAULT true,
  mfa_secret     TEXT,
  failed_logins  INT NOT NULL DEFAULT 0,
  locked_until   TIMESTAMPTZ,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which branches a user may work in (multi-branch ready)
CREATE TABLE user_branches (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id  BIGINT NOT NULL REFERENCES branches(id),
  PRIMARY KEY (user_id, branch_id)
);

-- ---------------------------------------------------------------------
-- 2. Services, technicians, packages
-- ---------------------------------------------------------------------
CREATE TABLE service_categories (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                TEXT NOT NULL UNIQUE,         -- HAIR, NAILS, LASHES ...
  name                TEXT NOT NULL,
  default_return_days INT CHECK (default_return_days > 0),
  is_active           BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE services (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  category_id      BIGINT NOT NULL REFERENCES service_categories(id),
  description      TEXT,
  standard_price   NUMERIC(12,2) NOT NULL CHECK (standard_price >= 0),
  duration_minutes INT NOT NULL DEFAULT 60 CHECK (duration_minutes > 0),
  return_days_min  INT CHECK (return_days_min > 0),
  return_days_max  INT CHECK (return_days_max >= return_days_min),
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Branch-specific price and availability (falls back to services.standard_price)
CREATE TABLE service_branch_prices (
  service_id    BIGINT NOT NULL REFERENCES services(id),
  branch_id     BIGINT NOT NULL REFERENCES branches(id),
  price         NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  is_available  BOOLEAN NOT NULL DEFAULT true,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (service_id, branch_id)
);

CREATE TABLE technicians (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id                BIGINT UNIQUE REFERENCES users(id),
  branch_id              BIGINT NOT NULL REFERENCES branches(id),
  display_name           TEXT NOT NULL,
  phone                  TEXT,
  specialty_category_id  BIGINT REFERENCES service_categories(id),
  is_active              BOOLEAN NOT NULL DEFAULT true,
  hired_on               DATE,
  email                  TEXT,
  national_id            TEXT,
  id_photo               TEXT,                       -- data-URL image of the ID card (staff.manage only)
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE staff_absences (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  technician_id BIGINT NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,
  absent_on     DATE NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('absent','sick','leave','late')),
  reason        TEXT,
  recorded_by   BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (technician_id, absent_on)
);

-- Technician-Service eligibility. A technician with NO rows here may do any service.
CREATE TABLE technician_services (
  technician_id  BIGINT NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,
  service_id     BIGINT NOT NULL REFERENCES services(id),
  PRIMARY KEY (technician_id, service_id)
);

CREATE TABLE packages (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  price             NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  -- allocated_price: commission on the package price share given to each service
  -- list_price:      commission on each service's individual value (ignores the package discount)
  commission_basis  TEXT NOT NULL DEFAULT 'allocated_price'
                    CHECK (commission_basis IN ('allocated_price','list_price')),
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE package_items (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  package_id        BIGINT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  service_id        BIGINT NOT NULL REFERENCES services(id),
  quantity          INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
  individual_value  NUMERIC(12,2) CHECK (individual_value >= 0),  -- NULL = use the service price
  UNIQUE (package_id, service_id)
);

-- ---------------------------------------------------------------------
-- 3. Inventory
-- ---------------------------------------------------------------------
CREATE TABLE suppliers (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT,
  email      TEXT,
  address    TEXT,
  is_active  BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE product_categories (
  id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code  TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL
);

CREATE TABLE products (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku            TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  category_id    BIGINT REFERENCES product_categories(id),
  supplier_id    BIGINT REFERENCES suppliers(id),
  unit           TEXT NOT NULL DEFAULT 'piece',
  purchase_cost  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (purchase_cost >= 0),
  selling_price  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
  is_consumable  BOOLEAN NOT NULL DEFAULT true,    -- used up during services
  is_retail      BOOLEAN NOT NULL DEFAULT false,   -- sold over the counter
  track_batches  BOOLEAN NOT NULL DEFAULT false,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stock per product per branch. qty_on_hand is maintained ONLY by the ledger trigger below.
CREATE TABLE inventory (
  product_id     BIGINT NOT NULL REFERENCES products(id),
  branch_id      BIGINT NOT NULL REFERENCES branches(id),
  qty_on_hand    NUMERIC(14,3) NOT NULL DEFAULT 0,
  avg_unit_cost  NUMERIC(12,4) NOT NULL DEFAULT 0 CHECK (avg_unit_cost >= 0),  -- weighted average
  min_level      NUMERIC(14,3) NOT NULL DEFAULT 0,
  reorder_level  NUMERIC(14,3) NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, branch_id)
);

CREATE TABLE inventory_batches (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id     BIGINT NOT NULL REFERENCES products(id),
  branch_id      BIGINT NOT NULL REFERENCES branches(id),
  batch_no       TEXT NOT NULL,
  expiry_date    DATE,
  qty_remaining  NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (qty_remaining >= 0),
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, branch_id, batch_no)
);

-- Append-only stock ledger. qty_change is signed (+ in, - out).
CREATE TABLE inventory_transactions (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id            BIGINT NOT NULL REFERENCES products(id),
  branch_id             BIGINT NOT NULL REFERENCES branches(id),
  txn_type              TEXT NOT NULL CHECK (txn_type IN
      ('purchase','sale','service_consumption','adjustment','damaged','expired',
       'transfer_in','transfer_out','return')),
  qty_change            NUMERIC(14,3) NOT NULL CHECK (qty_change <> 0),
  unit_cost             NUMERIC(12,4) CHECK (unit_cost >= 0),
  batch_id              BIGINT REFERENCES inventory_batches(id),
  counterpart_branch_id BIGINT REFERENCES branches(id),
  reference_type        TEXT,
  reference_id          BIGINT,
  reason                TEXT,
  created_by            BIGINT REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_invtxn_product ON inventory_transactions (product_id, branch_id, created_at);

CREATE OR REPLACE FUNCTION apply_inventory_txn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO inventory (product_id, branch_id, qty_on_hand, avg_unit_cost)
  VALUES (NEW.product_id, NEW.branch_id, NEW.qty_change,
          CASE WHEN NEW.txn_type = 'purchase' THEN COALESCE(NEW.unit_cost, 0) ELSE 0 END)
  ON CONFLICT (product_id, branch_id) DO UPDATE SET
    qty_on_hand   = inventory.qty_on_hand + NEW.qty_change,
    avg_unit_cost = CASE
        WHEN NEW.txn_type = 'purchase' AND NEW.qty_change > 0 AND NEW.unit_cost IS NOT NULL THEN
          round(((GREATEST(inventory.qty_on_hand, 0) * inventory.avg_unit_cost)
                 + (NEW.qty_change * NEW.unit_cost))
                / (GREATEST(inventory.qty_on_hand, 0) + NEW.qty_change), 4)
        ELSE inventory.avg_unit_cost END,
    updated_at    = now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_apply_inventory AFTER INSERT ON inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION apply_inventory_txn();
CREATE TRIGGER trg_invtxn_immutable BEFORE UPDATE OR DELETE ON inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_update();

-- Predefined (expected) materials per service. Actual usage is captured at sale time.
CREATE TABLE service_materials (
  service_id   BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  product_id   BIGINT NOT NULL REFERENCES products(id),
  default_qty  NUMERIC(12,3) NOT NULL CHECK (default_qty > 0),
  is_required  BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (service_id, product_id)
);

-- ---------------------------------------------------------------------
-- 4. Customers / CRM
-- ---------------------------------------------------------------------
CREATE SEQUENCE customer_code_seq;

CREATE TABLE customers (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_code          TEXT NOT NULL UNIQUE DEFAULT ('C' || to_char(nextval('customer_code_seq'), 'FM000000')),
  full_name              TEXT NOT NULL,
  phone                  TEXT,
  phone_normalized       TEXT,                       -- set by trigger, used for duplicate detection
  alt_phone              TEXT,
  whatsapp_number        TEXT,
  email                  TEXT,
  gender                 TEXT CHECK (gender IN ('female','male','other')),
  birthday               DATE,
  preferred_contact      TEXT CHECK (preferred_contact IN ('phone','whatsapp','sms','email')),
  allergies              TEXT,
  marketing_consent      BOOLEAN NOT NULL DEFAULT false,
  whatsapp_consent       BOOLEAN NOT NULL DEFAULT false,
  sms_consent            BOOLEAN NOT NULL DEFAULT false,
  consent_updated_at     TIMESTAMPTZ,
  opted_out_at           TIMESTAMPTZ,
  vip_override           BOOLEAN NOT NULL DEFAULT false,   -- management-defined VIP
  registered_branch_id   BIGINT REFERENCES branches(id),
  referred_by_customer_id BIGINT REFERENCES customers(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at             TIMESTAMPTZ
);
CREATE UNIQUE INDEX ux_customers_phone ON customers (phone_normalized)
  WHERE phone_normalized IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX ix_customers_name_trgm ON customers USING gin (full_name gin_trgm_ops);
CREATE INDEX ix_customers_phone_trgm ON customers USING gin (phone gin_trgm_ops);

CREATE OR REPLACE FUNCTION customers_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.phone_normalized := normalize_ke_phone(NEW.phone);
  IF TG_OP = 'INSERT' OR NEW.marketing_consent IS DISTINCT FROM OLD.marketing_consent
     OR NEW.whatsapp_consent IS DISTINCT FROM OLD.whatsapp_consent
     OR NEW.sms_consent IS DISTINCT FROM OLD.sms_consent THEN
    NEW.consent_updated_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_customers_write BEFORE INSERT OR UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION customers_before_write();

CREATE TABLE customer_notes (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES customers(id),
  note         TEXT NOT NULL,
  created_by   BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE customer_tags (
  id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE
);
CREATE TABLE customer_tag_map (
  customer_id  BIGINT NOT NULL REFERENCES customers(id),
  tag_id       BIGINT NOT NULL REFERENCES customer_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (customer_id, tag_id)
);

-- Loyalty
CREATE TABLE loyalty_rules (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_type  TEXT NOT NULL CHECK (rule_type IN
             ('points_per_spend','points_per_visit','birthday_bonus','referral_bonus')),
  params     JSONB NOT NULL,           -- e.g. {"spend_per_point": 100}
  is_active  BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE loyalty_accounts (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id      BIGINT NOT NULL UNIQUE REFERENCES customers(id),
  points_balance   INT NOT NULL DEFAULT 0,
  lifetime_points  INT NOT NULL DEFAULT 0,
  tier             TEXT
);
CREATE TABLE loyalty_transactions (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id       BIGINT NOT NULL REFERENCES loyalty_accounts(id),
  points           INT NOT NULL CHECK (points <> 0),
  reason           TEXT NOT NULL,
  transaction_id   BIGINT,             -- FK added after transactions exists
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 5. Appointments, visits
-- ---------------------------------------------------------------------
CREATE TABLE appointments (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id         BIGINT NOT NULL REFERENCES branches(id),
  customer_id       BIGINT NOT NULL REFERENCES customers(id),
  technician_id     BIGINT REFERENCES technicians(id),
  starts_at         TIMESTAMPTZ NOT NULL,
  expected_duration_minutes INT NOT NULL DEFAULT 60 CHECK (expected_duration_minutes > 0),
  ends_at           TIMESTAMPTZ NOT NULL,            -- set by trigger
  status            TEXT NOT NULL DEFAULT 'booked' CHECK (status IN
      ('booked','confirmed','checked_in','in_progress','completed','cancelled','no_show','rescheduled')),
  source            TEXT NOT NULL DEFAULT 'booking' CHECK (source IN ('booking','walk_in','whatsapp','phone','online')),
  notes             TEXT,
  deposit_amount    NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
  payment_status    TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','deposit_paid','paid','refunded')),
  rescheduled_from_id BIGINT REFERENCES appointments(id),
  created_by        BIGINT REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- a technician cannot be double-booked
  CONSTRAINT no_double_booking EXCLUDE USING gist
    (technician_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
    WHERE (technician_id IS NOT NULL AND status NOT IN ('cancelled','no_show','rescheduled'))
);
CREATE INDEX ix_appt_branch_time ON appointments (branch_id, starts_at);
CREATE INDEX ix_appt_customer ON appointments (customer_id, starts_at);

CREATE OR REPLACE FUNCTION appointments_set_end() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.ends_at := NEW.starts_at + make_interval(mins => NEW.expected_duration_minutes); RETURN NEW; END $$;
CREATE TRIGGER trg_appt_end BEFORE INSERT OR UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_set_end();

CREATE TABLE appointment_services (
  appointment_id    BIGINT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  service_id        BIGINT NOT NULL REFERENCES services(id),
  technician_id     BIGINT REFERENCES technicians(id),
  duration_minutes  INT,
  quoted_price      NUMERIC(12,2),
  PRIMARY KEY (appointment_id, service_id)
);

-- ONE visit = one customer attending the salon once (walk-in or appointment).
CREATE TABLE visits (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id        BIGINT NOT NULL REFERENCES branches(id),
  customer_id      BIGINT NOT NULL REFERENCES customers(id),
  appointment_id   BIGINT REFERENCES appointments(id),
  visit_type       TEXT NOT NULL CHECK (visit_type IN ('walk_in','appointment')),
  visit_date       DATE NOT NULL,
  checked_in_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','in_service','completed','cancelled')),
  queue_no         INT,
  is_new_customer  BOOLEAN NOT NULL DEFAULT false,   -- frozen at creation by trigger
  created_by       BIGINT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_visits_customer ON visits (customer_id, visit_date);
CREATE INDEX ix_visits_branch_date ON visits (branch_id, visit_date);

-- NEW vs RETURNING is decided once, when the visit is created, and never recalculated.
CREATE OR REPLACE FUNCTION visits_set_is_new() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.is_new_customer := NOT EXISTS (
    SELECT 1 FROM visits v WHERE v.customer_id = NEW.customer_id AND v.status <> 'cancelled');
  RETURN NEW;
END $$;
CREATE TRIGGER trg_visits_is_new BEFORE INSERT ON visits
  FOR EACH ROW EXECUTE FUNCTION visits_set_is_new();

-- ---------------------------------------------------------------------
-- 6. Sales: transactions, items, materials, payments, discounts
-- ---------------------------------------------------------------------
CREATE TABLE receipt_counters (
  branch_id  BIGINT NOT NULL REFERENCES branches(id),
  yr         INT NOT NULL,
  last_no    INT NOT NULL DEFAULT 0,
  PRIMARY KEY (branch_id, yr)
);
CREATE OR REPLACE FUNCTION next_receipt_no(p_branch bigint, p_date date) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_code text; v_no int;
BEGIN
  SELECT code INTO v_code FROM branches WHERE id = p_branch;
  INSERT INTO receipt_counters (branch_id, yr, last_no)
  VALUES (p_branch, extract(year FROM p_date)::int, 1)
  ON CONFLICT (branch_id, yr) DO UPDATE SET last_no = receipt_counters.last_no + 1
  RETURNING last_no INTO v_no;
  RETURN v_code || '-' || extract(year FROM p_date)::int || '-' || lpad(v_no::text, 6, '0');
END $$;

-- Historical data imports (Excel/CSV). Every imported sale points back to its batch so a bad import can be rolled back.
CREATE TABLE import_batches (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_name       TEXT NOT NULL,
  file_sha1       TEXT NOT NULL,
  branch_id       BIGINT REFERENCES branches(id),
  status          TEXT NOT NULL DEFAULT 'committed' CHECK (status IN ('committed','rolled_back')),
  options         JSONB NOT NULL DEFAULT '{}',
  summary         JSONB NOT NULL DEFAULT '{}',
  created_refs    JSONB NOT NULL DEFAULT '{}',          -- ids of customers/services/technicians created by this import
  created_by      BIGINT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  rolled_back_at  TIMESTAMPTZ,
  rolled_back_by  BIGINT REFERENCES users(id),
  rollback_reason TEXT,
  CHECK (status <> 'rolled_back' OR (rolled_back_at IS NOT NULL AND rollback_reason IS NOT NULL))
);

CREATE TABLE transactions (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_no     TEXT NOT NULL UNIQUE,
  branch_id      BIGINT NOT NULL REFERENCES branches(id),
  visit_id       BIGINT NOT NULL REFERENCES visits(id),
  customer_id    BIGINT NOT NULL REFERENCES customers(id),
  subtotal       NUMERIC(12,2) NOT NULL CHECK (subtotal >= 0),
  discount_total NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  total          NUMERIC(12,2) NOT NULL CHECK (total >= 0),
  amount_paid    NUMERIC(12,2) NOT NULL DEFAULT 0,    -- maintained by payments trigger
  balance        NUMERIC(12,2) GENERATED ALWAYS AS (total - amount_paid) STORED,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','partial','paid','voided')),
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  business_date  DATE NOT NULL,
  created_by     BIGINT REFERENCES users(id),
  voided_at      TIMESTAMPTZ,
  voided_by      BIGINT REFERENCES users(id),
  void_reason    TEXT,
  notes          TEXT,                                    -- free comment typed at the till
  import_batch_id BIGINT REFERENCES import_batches(id),   -- set only for imported history
  import_key     TEXT,                                    -- fingerprint of the source visit; makes re-imports harmless
  CHECK (total = subtotal - discount_total),
  CHECK (status <> 'voided' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE INDEX ix_txn_branch_date ON transactions (branch_id, business_date);
CREATE INDEX ix_txn_customer ON transactions (customer_id);
CREATE INDEX ix_txn_visit ON transactions (visit_id);
CREATE UNIQUE INDEX ux_txn_import_key ON transactions (import_key) WHERE import_key IS NOT NULL AND status <> 'voided';
CREATE INDEX ix_txn_import_batch ON transactions (import_batch_id) WHERE import_batch_id IS NOT NULL;
ALTER TABLE loyalty_transactions
  ADD CONSTRAINT fk_loyalty_txn FOREIGN KEY (transaction_id) REFERENCES transactions(id);

CREATE TABLE transaction_items (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id   BIGINT NOT NULL REFERENCES transactions(id),
  line_no          INT NOT NULL,
  item_type        TEXT NOT NULL CHECK (item_type IN ('service','product')),
  service_id       BIGINT REFERENCES services(id),
  product_id       BIGINT REFERENCES products(id),
  package_id       BIGINT REFERENCES packages(id),
  package_group    INT,                                   -- same number = same package purchase
  technician_id    BIGINT REFERENCES technicians(id),
  description      TEXT NOT NULL,                         -- frozen name at time of sale
  quantity         NUMERIC(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  list_price       NUMERIC(12,2) NOT NULL CHECK (list_price >= 0),   -- FROZEN individual list value
  gross_amount     NUMERIC(12,2) NOT NULL CHECK (gross_amount >= 0), -- after package allocation
  discount_amount  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  net_amount       NUMERIC(12,2) NOT NULL CHECK (net_amount >= 0),
  material_cost    NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (material_cost >= 0), -- FROZEN
  collab_technician_id BIGINT REFERENCES technicians(id),         -- second hairdresser on a shared ("collabo") service; commission split 50/50
  UNIQUE (transaction_id, line_no),
  CHECK (net_amount = gross_amount - discount_amount),
  CHECK ((item_type = 'service' AND service_id IS NOT NULL AND technician_id IS NOT NULL)
      OR (item_type = 'product' AND product_id IS NOT NULL))
);
CREATE INDEX ix_ti_tech ON transaction_items (technician_id);
CREATE INDEX ix_ti_service ON transaction_items (service_id);

CREATE TABLE material_usage (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_item_id BIGINT NOT NULL REFERENCES transaction_items(id),
  product_id          BIGINT NOT NULL REFERENCES products(id),
  branch_id           BIGINT NOT NULL REFERENCES branches(id),
  expected_qty        NUMERIC(12,3) NOT NULL DEFAULT 0,
  actual_qty          NUMERIC(12,3) NOT NULL CHECK (actual_qty > 0),   -- commission uses ACTUAL
  unit_cost           NUMERIC(12,4) NOT NULL CHECK (unit_cost >= 0),   -- FROZEN at sale time
  total_cost          NUMERIC(12,2) GENERATED ALWAYS AS (round(actual_qty * unit_cost, 2)) STORED,
  variance_flag       BOOLEAN NOT NULL DEFAULT false,
  inventory_txn_id    BIGINT REFERENCES inventory_transactions(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_mu_item ON material_usage (transaction_item_id);
CREATE INDEX ix_mu_product ON material_usage (product_id);

CREATE TABLE payments (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id  BIGINT NOT NULL REFERENCES transactions(id),
  method          TEXT NOT NULL CHECK (method IN ('mpesa','cash','card','bank','other')),
  amount          NUMERIC(12,2) NOT NULL CHECK (amount <> 0),  -- negative = refund
  reference       TEXT,                                         -- M-Pesa code, card slip ...
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      BIGINT REFERENCES users(id)
);
CREATE INDEX ix_pay_txn ON payments (transaction_id);
CREATE UNIQUE INDEX ux_pay_mpesa_ref ON payments (reference) WHERE method = 'mpesa' AND reference IS NOT NULL AND amount > 0;

CREATE OR REPLACE FUNCTION payments_sync_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_paid numeric(12,2);
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO v_paid FROM payments WHERE transaction_id = NEW.transaction_id;
  UPDATE transactions SET
    amount_paid = v_paid,
    status = CASE WHEN status = 'voided' THEN 'voided'
                  WHEN v_paid >= total THEN 'paid'
                  WHEN v_paid > 0 THEN 'partial'
                  ELSE 'open' END
  WHERE id = NEW.transaction_id;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payments_sync AFTER INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_sync_transaction();

CREATE TABLE discount_definitions (
  id                         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                       TEXT NOT NULL UNIQUE,
  name                       TEXT NOT NULL,
  discount_type              TEXT NOT NULL CHECK (discount_type IN ('percent','fixed','promo','staff','vip','package')),
  value                      NUMERIC(12,2) NOT NULL CHECK (value >= 0),
  value_is_percent           BOOLEAN NOT NULL DEFAULT true,
  requires_approval_above_pct NUMERIC(5,2),
  is_active                  BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE transaction_discounts (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id  BIGINT NOT NULL REFERENCES transactions(id),
  definition_id   BIGINT REFERENCES discount_definitions(id),
  discount_type   TEXT NOT NULL,
  value           NUMERIC(12,2) NOT NULL,
  is_percent      BOOLEAN NOT NULL,
  amount          NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reason          TEXT NOT NULL,
  applied_by      BIGINT REFERENCES users(id),
  approved_by     BIGINT REFERENCES users(id),
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 7. Commission engine tables
-- ---------------------------------------------------------------------
-- Rule precedence (highest first):
--   technician_service > technician > service > category > default
-- A rule applies on a date if effective_from <= date < effective_to (NULL = open ended).
-- Rules are never edited in place: close the old one and insert a new one.
CREATE TABLE commission_rules (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope          TEXT NOT NULL CHECK (scope IN ('default','category','service','technician','technician_service')),
  category_id    BIGINT REFERENCES service_categories(id),
  service_id     BIGINT REFERENCES services(id),
  technician_id  BIGINT REFERENCES technicians(id),
  calc_type      TEXT NOT NULL CHECK (calc_type IN
                   ('percent_of_price','percent_after_materials','fixed','tiered')),
  rate           NUMERIC(7,4) CHECK (rate BETWEEN 0 AND 1),         -- 0.4000 = 40%
  fixed_amount   NUMERIC(12,2) CHECK (fixed_amount >= 0),
  tiers          JSONB,        -- [{"up_to": 100000, "rate": 0.30}, {"up_to": null, "rate": 0.40}]
  tier_base      TEXT NOT NULL DEFAULT 'price' CHECK (tier_base IN ('price','after_materials')),
  effective_from DATE NOT NULL,
  effective_to   DATE,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_by     BIGINT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  scope_key      TEXT GENERATED ALWAYS AS (
                   scope || ':' || COALESCE(category_id::text, '') || ':' ||
                   COALESCE(service_id::text, '') || ':' || COALESCE(technician_id::text, '')) STORED,
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK ((scope = 'default'            AND category_id IS NULL AND service_id IS NULL AND technician_id IS NULL)
      OR (scope = 'category'           AND category_id IS NOT NULL AND service_id IS NULL AND technician_id IS NULL)
      OR (scope = 'service'            AND service_id IS NOT NULL AND category_id IS NULL AND technician_id IS NULL)
      OR (scope = 'technician'         AND technician_id IS NOT NULL AND category_id IS NULL AND service_id IS NULL)
      OR (scope = 'technician_service' AND technician_id IS NOT NULL AND service_id IS NOT NULL AND category_id IS NULL)),
  CHECK ((calc_type IN ('percent_of_price','percent_after_materials') AND rate IS NOT NULL)
      OR (calc_type = 'fixed'  AND fixed_amount IS NOT NULL)
      OR (calc_type = 'tiered' AND tiers IS NOT NULL AND jsonb_typeof(tiers) = 'array')),
  -- no two active rules for the same scope key may overlap in time
  CONSTRAINT no_overlapping_rules EXCLUDE USING gist
    (scope_key WITH =, daterange(effective_from, effective_to, '[)') WITH &&) WHERE (is_active)
);

CREATE TABLE commission_payments (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  technician_id  BIGINT NOT NULL REFERENCES technicians(id),
  branch_id      BIGINT REFERENCES branches(id),
  period_start   DATE NOT NULL,
  period_end     DATE NOT NULL CHECK (period_end >= period_start),
  total_amount   NUMERIC(12,2) NOT NULL CHECK (total_amount > 0),
  method         TEXT NOT NULL CHECK (method IN ('mpesa','cash','bank','other')),
  reference      TEXT,
  notes          TEXT,
  paid_by        BIGINT REFERENCES users(id),
  paid_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per service line. All calculated values are FROZEN at sale time.
-- Corrections (e.g. a voided sale) are made by inserting a NEGATIVE reversing row.
CREATE TABLE commission_calculations (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_item_id   BIGINT NOT NULL REFERENCES transaction_items(id),
  transaction_id        BIGINT NOT NULL REFERENCES transactions(id),
  technician_id         BIGINT NOT NULL REFERENCES technicians(id),
  branch_id             BIGINT NOT NULL REFERENCES branches(id),
  rule_id               BIGINT REFERENCES commission_rules(id),
  rule_snapshot         JSONB NOT NULL,                   -- full copy of the rule used
  calc_type             TEXT NOT NULL,
  service_price         NUMERIC(12,2) NOT NULL,           -- price the rule was applied to
  material_cost         NUMERIC(12,2) NOT NULL DEFAULT 0,
  commissionable_amount NUMERIC(12,2) NOT NULL,
  commission_rate       NUMERIC(7,4),                     -- effective rate (NULL for fixed)
  commission_amount     NUMERIC(12,2) NOT NULL,           -- negative on reversal rows
  business_date         DATE NOT NULL,
  reverses_id           BIGINT REFERENCES commission_calculations(id),
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid')),
  approved_by           BIGINT REFERENCES users(id),
  approved_at           TIMESTAMPTZ,
  paid_at               TIMESTAMPTZ,
  commission_payment_id BIGINT REFERENCES commission_payments(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status = 'pending' OR approved_at IS NOT NULL),
  CHECK (status <> 'paid' OR commission_payment_id IS NOT NULL)
);
CREATE UNIQUE INDEX ux_cc_one_original_per_item_tech ON commission_calculations (transaction_item_id, technician_id) WHERE reverses_id IS NULL;
CREATE UNIQUE INDEX ux_cc_one_reversal ON commission_calculations (reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX ix_cc_tech_status ON commission_calculations (technician_id, status, business_date);
CREATE INDEX ix_cc_date ON commission_calculations (business_date);

CREATE OR REPLACE FUNCTION commission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.transaction_item_id, NEW.transaction_id, NEW.technician_id, NEW.branch_id, NEW.rule_id,
      NEW.rule_snapshot, NEW.calc_type, NEW.service_price, NEW.material_cost, NEW.commissionable_amount,
      NEW.commission_rate, NEW.commission_amount, NEW.business_date, NEW.reverses_id)
     IS DISTINCT FROM
     (OLD.transaction_item_id, OLD.transaction_id, OLD.technician_id, OLD.branch_id, OLD.rule_id,
      OLD.rule_snapshot, OLD.calc_type, OLD.service_price, OLD.material_cost, OLD.commissionable_amount,
      OLD.commission_rate, OLD.commission_amount, OLD.business_date, OLD.reverses_id) THEN
    RAISE EXCEPTION 'Commission calculations are frozen; insert a reversal row instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT
     ((OLD.status = 'pending' AND NEW.status = 'approved') OR (OLD.status = 'approved' AND NEW.status = 'paid')) THEN
    RAISE EXCEPTION 'Illegal commission status change % -> %', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_commission_guard BEFORE UPDATE ON commission_calculations
  FOR EACH ROW EXECUTE FUNCTION commission_guard();

-- Sales history is append-only. Only status/payment/void columns of a transaction may change.
CREATE OR REPLACE FUNCTION transactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.receipt_no, NEW.branch_id, NEW.visit_id, NEW.customer_id, NEW.subtotal, NEW.discount_total,
      NEW.total, NEW.occurred_at, NEW.business_date)
     IS DISTINCT FROM
     (OLD.receipt_no, OLD.branch_id, OLD.visit_id, OLD.customer_id, OLD.subtotal, OLD.discount_total,
      OLD.total, OLD.occurred_at, OLD.business_date) THEN
    RAISE EXCEPTION 'A recorded sale cannot be edited. Void it and ring a new sale.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'voided' AND NEW.status <> 'voided' THEN
    RAISE EXCEPTION 'A voided sale cannot be reopened' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_transactions_guard BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION transactions_guard();

CREATE TRIGGER trg_ti_immutable BEFORE UPDATE ON transaction_items FOR EACH ROW EXECUTE FUNCTION forbid_update();
CREATE TRIGGER trg_mu_immutable BEFORE UPDATE ON material_usage    FOR EACH ROW EXECUTE FUNCTION forbid_update();
CREATE TRIGGER trg_pay_immutable BEFORE UPDATE ON payments         FOR EACH ROW EXECUTE FUNCTION forbid_update();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['transactions','transaction_items','material_usage','payments',
                           'commission_calculations','commission_payments','transaction_discounts']
  LOOP EXECUTE format('CREATE TRIGGER trg_nodelete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_delete()', t); END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 8. Marketing (WhatsApp / SMS)
-- ---------------------------------------------------------------------
CREATE TABLE marketing_segments (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  definition  JSONB NOT NULL,         -- filter definition interpreted by the application
  is_dynamic  BOOLEAN NOT NULL DEFAULT true,
  created_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE marketing_campaigns (
  id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name                     TEXT NOT NULL,
  channel                  TEXT NOT NULL CHECK (channel IN ('whatsapp','sms')),
  segment_id               BIGINT REFERENCES marketing_segments(id),
  message_template         TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent','cancelled')),
  scheduled_at             TIMESTAMPTZ,
  attribution_window_days  INT NOT NULL DEFAULT 14 CHECK (attribution_window_days > 0),
  created_by               BIGINT REFERENCES users(id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE campaign_recipients (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id          BIGINT NOT NULL REFERENCES marketing_campaigns(id),
  customer_id          BIGINT NOT NULL REFERENCES customers(id),
  phone                TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
                         ('queued','sent','delivered','read','failed','replied','opted_out')),
  provider_message_id  TEXT,
  sent_at              TIMESTAMPTZ,
  delivered_at         TIMESTAMPTZ,
  read_at              TIMESTAMPTZ,
  replied_at           TIMESTAMPTZ,
  reply_text           TEXT,
  error                TEXT,
  UNIQUE (campaign_id, customer_id)
);
CREATE INDEX ix_cr_customer ON campaign_recipients (customer_id, sent_at);

-- Periodic snapshots of campaign performance (see snapshot_campaign_results below)
CREATE TABLE campaign_results (
  campaign_id       BIGINT NOT NULL REFERENCES marketing_campaigns(id),
  snapshot_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  audience          INT NOT NULL,
  sent              INT NOT NULL,
  delivered         INT NOT NULL,
  read_count        INT NOT NULL,
  replies           INT NOT NULL,
  opt_outs          INT NOT NULL,
  bookings          INT NOT NULL,
  completed_visits  INT NOT NULL,
  revenue           NUMERIC(14,2) NOT NULL,
  PRIMARY KEY (campaign_id, snapshot_at)
);

-- ---------------------------------------------------------------------
-- 9. Finance, targets, settings, alerts
-- ---------------------------------------------------------------------
CREATE TABLE expenses (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id     BIGINT NOT NULL REFERENCES branches(id),
  category      TEXT NOT NULL CHECK (category IN
                ('rent','utilities','salaries','commissions','marketing','supplies','repairs','cleaning','internet','other')),
  amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  expense_date  DATE NOT NULL,
  description   TEXT,
  reference     TEXT,
  created_by    BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_exp_branch_date ON expenses (branch_id, expense_date);

CREATE TABLE targets (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id         BIGINT NOT NULL REFERENCES branches(id),
  period_type       TEXT NOT NULL CHECK (period_type IN ('daily','weekly','monthly')),
  period_start      DATE NOT NULL,   -- weekly targets start on a SATURDAY
  sales_target      NUMERIC(12,2),
  customer_target   INT,
  avg_spend_target  NUMERIC(12,2),
  UNIQUE (branch_id, period_type, period_start)
);

CREATE TABLE app_settings (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id   BIGINT REFERENCES branches(id),     -- NULL = global
  key         TEXT NOT NULL,
  value       JSONB NOT NULL,
  updated_by  BIGINT REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_settings ON app_settings (COALESCE(branch_id, 0), key);

CREATE OR REPLACE FUNCTION setting_num(k text, dflt numeric) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT (value #>> '{}')::numeric FROM app_settings WHERE branch_id IS NULL AND key = k), dflt)
$$;

CREATE TABLE alert_rules (
  code       TEXT PRIMARY KEY,
  params     JSONB NOT NULL DEFAULT '{}',
  is_active  BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE alerts (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_code    TEXT NOT NULL REFERENCES alert_rules(code),
  branch_id    BIGINT REFERENCES branches(id),
  entity_type  TEXT,
  entity_id    BIGINT,
  message      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ
);

-- ---------------------------------------------------------------------
-- 10. Audit trail (written by trigger; the app sets app.user_id / app.reason per transaction)
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      BIGINT,
  action       TEXT NOT NULL,                 -- INSERT / UPDATE / DELETE
  entity_type  TEXT NOT NULL,
  entity_id    TEXT,
  old_values   JSONB,                         -- only changed columns on UPDATE
  new_values   JSONB,
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_entity ON audit_logs (entity_type, entity_id, created_at);
CREATE INDEX ix_audit_user ON audit_logs (user_id, created_at);
CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_update();

CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_user   bigint := NULLIF(current_setting('app.user_id', true), '')::bigint;
  v_reason text   := NULLIF(current_setting('app.reason', true), '');
  v_secret text[] := ARRAY['password_hash','mfa_secret'];      -- never copied into the audit log
  v_skip   text[] := ARRAY['updated_at'];
  v_old    jsonb; v_new jsonb; k text;
BEGIN
  IF TG_TABLE_NAME = 'users' THEN                               -- login bookkeeping is not an audit event
    v_skip := v_skip || ARRAY['failed_logins','locked_until','last_login_at'];
  END IF;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_values, reason)
    VALUES (v_user, 'INSERT', TG_TABLE_NAME, to_jsonb(NEW)->>'id', to_jsonb(NEW) - v_secret, v_reason);
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT jsonb_object_agg(o.key, o.value), jsonb_object_agg(o.key, to_jsonb(NEW)->o.key)
      INTO v_old, v_new
      FROM jsonb_each(to_jsonb(OLD)) o
      WHERE to_jsonb(NEW)->o.key IS DISTINCT FROM o.value AND o.key <> ALL (v_skip);
    IF v_old IS NOT NULL THEN
      FOREACH k IN ARRAY v_secret LOOP                          -- record THAT a secret changed, not its value
        IF v_old ? k THEN
          v_old := jsonb_set(v_old, ARRAY[k], '"[redacted]"');
          v_new := jsonb_set(v_new, ARRAY[k], '"[redacted]"');
        END IF;
      END LOOP;
      INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_values, new_values, reason)
      VALUES (v_user, 'UPDATE', TG_TABLE_NAME, to_jsonb(NEW)->>'id', v_old, v_new, v_reason);
    END IF;
  ELSE
    INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_values, reason)
    VALUES (v_user, 'DELETE', TG_TABLE_NAME, to_jsonb(OLD)->>'id', to_jsonb(OLD) - v_secret, v_reason);
  END IF;
  RETURN NULL;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['users','role_permissions','branches','services','service_branch_prices',
     'technicians','technician_services','packages','package_items','products','inventory_transactions',
     'service_materials','customers','transactions','transaction_items','payments','transaction_discounts',
     'discount_definitions','commission_rules','commission_calculations','commission_payments',
     'import_batches','expenses','targets','app_settings','loyalty_rules','marketing_campaigns','appointments']
  LOOP EXECUTE format('CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row_change()', t); END LOOP;
  FOREACH t IN ARRAY ARRAY['branches','users','services','service_branch_prices','technicians','packages',
     'products','customers','appointments']
  LOOP EXECUTE format('CREATE TRIGGER trg_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t); END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 11. Reporting views
-- ---------------------------------------------------------------------
-- Daily sales: one row per SERVICE line (as required by the daily sales report)
-- One row per technician credited on a service line. A shared (collabo) line gives each of the two hairdressers half of the amount.
CREATE VIEW v_item_credits AS
SELECT ti.id AS item_id, ti.transaction_id, ti.service_id, ti.description, ti.technician_id,
       ti.net_amount - CASE WHEN ti.collab_technician_id IS NULL THEN 0 ELSE floor(ti.net_amount * 100 / 2) / 100 END AS amount,
       (ti.collab_technician_id IS NOT NULL) AS is_collab
  FROM transaction_items ti WHERE ti.item_type = 'service' AND ti.technician_id IS NOT NULL
UNION ALL
SELECT ti.id, ti.transaction_id, ti.service_id, ti.description, ti.collab_technician_id, floor(ti.net_amount * 100 / 2) / 100, true
  FROM transaction_items ti WHERE ti.item_type = 'service' AND ti.collab_technician_id IS NOT NULL;

CREATE VIEW v_daily_sales_lines AS
SELECT t.business_date          AS sale_date,
       t.branch_id,
       t.receipt_no,
       ti.id                    AS item_id,
       ti.technician_id,
       tech.display_name        AS technician_name,
       ti.description           AS service,
       ti.net_amount            AS amount,
       (SELECT string_agg(m, ' + ' ORDER BY m)
          FROM (SELECT DISTINCT CASE p.method WHEN 'mpesa' THEN 'M-Pesa' ELSE initcap(p.method) END AS m
                  FROM payments p WHERE p.transaction_id = t.id AND p.amount > 0) x) AS payment_modes,
       c.id                     AS customer_id,
       c.full_name              AS customer_name,
       c.phone                  AS contact
FROM transaction_items ti
JOIN transactions t   ON t.id = ti.transaction_id AND t.status <> 'voided'
JOIN technicians tech ON tech.id = ti.technician_id
JOIN customers c      ON c.id = t.customer_id
WHERE ti.item_type = 'service';

-- Weekly (Saturday-Friday) technician sales
CREATE VIEW v_weekly_technician_sales AS
SELECT business_week_start(t.business_date)  AS week_start,
       t.branch_id,
       ti.technician_id,
       tech.display_name                      AS technician_name,
       COUNT(DISTINCT t.customer_id)          AS customers_served,
       SUM(ti.net_amount)                     AS total_sales,
       COALESCE(SUM(cc.commission), 0)        AS commission
FROM transaction_items ti
JOIN transactions t   ON t.id = ti.transaction_id AND t.status <> 'voided'
JOIN technicians tech ON tech.id = ti.technician_id
LEFT JOIN (SELECT transaction_item_id, SUM(commission_amount) AS commission
             FROM commission_calculations GROUP BY transaction_item_id) cc ON cc.transaction_item_id = ti.id
WHERE ti.item_type = 'service'
GROUP BY 1, 2, 3, 4;

CREATE VIEW v_commission_liability AS
SELECT technician_id, branch_id,
       SUM(commission_amount) FILTER (WHERE status = 'pending')  AS pending,
       SUM(commission_amount) FILTER (WHERE status = 'approved') AS approved,
       SUM(commission_amount) FILTER (WHERE status = 'paid')     AS paid,
       SUM(commission_amount) FILTER (WHERE status <> 'paid')    AS outstanding
FROM commission_calculations GROUP BY technician_id, branch_id;

CREATE VIEW v_inventory_valuation AS
SELECT i.branch_id, p.id AS product_id, p.sku, p.name, i.qty_on_hand,
       COALESCE(NULLIF(i.avg_unit_cost, 0), p.purchase_cost) AS unit_cost,
       round(GREATEST(i.qty_on_hand, 0) * COALESCE(NULLIF(i.avg_unit_cost, 0), p.purchase_cost), 2) AS stock_value,
       (i.qty_on_hand <= i.min_level) AS is_low,
       (i.qty_on_hand < 0) AS is_negative
FROM inventory i JOIN products p ON p.id = i.product_id;

-- One row per customer: counts UNIQUE customers and VISITS (never service lines).
-- Thresholds come from app_settings so management can change them without a deploy.
CREATE VIEW v_customer_metrics AS
WITH visit_totals AS (
  SELECT v.customer_id, v.id AS visit_id, v.visit_date,
         COALESCE(SUM(t.total), 0) AS visit_total,
         COALESCE(SUM(sc.n), 0)    AS services_in_visit
  FROM visits v
  LEFT JOIN transactions t ON t.visit_id = v.id AND t.status <> 'voided'
  LEFT JOIN LATERAL (SELECT COUNT(*) AS n FROM transaction_items ti
                      WHERE ti.transaction_id = t.id AND ti.item_type = 'service') sc ON true
  WHERE v.status = 'completed'
  GROUP BY v.customer_id, v.id, v.visit_date
), agg AS (
  SELECT customer_id,
         COUNT(*)                         AS visits,
         SUM(visit_total)                 AS total_spend,
         SUM(services_in_visit)           AS services_purchased,
         MIN(visit_date)                  AS first_visit,
         MAX(visit_date)                  AS last_visit,
         CASE WHEN COUNT(*) > 1
              THEN (MAX(visit_date) - MIN(visit_date))::numeric / (COUNT(*) - 1) END AS avg_days_between
  FROM visit_totals GROUP BY customer_id
), m AS (
  SELECT c.id AS customer_id, c.full_name, c.phone, c.whatsapp_number, c.marketing_consent,
         c.whatsapp_consent, c.sms_consent, c.opted_out_at, c.vip_override, c.birthday,
         COALESCE(a.visits, 0)             AS visits,
         COALESCE(a.total_spend, 0)        AS total_spend,
         COALESCE(a.services_purchased, 0) AS services_purchased,
         a.first_visit, a.last_visit, a.avg_days_between,
         CASE WHEN a.visits > 0 THEN round(a.total_spend / a.visits, 2) END AS avg_spend_per_visit,
         CASE WHEN a.visits > 0 THEN round(a.services_purchased::numeric / a.visits, 2) END AS avg_services_per_visit,
         business_today() - a.last_visit   AS days_since_last_visit,
         -- personal rhythm needs 3+ visits; otherwise fall back to the configurable default
         CASE WHEN a.visits >= 3 THEN a.avg_days_between
              ELSE setting_num('status.default_return_days', 28) END AS expected_interval_days
  FROM customers c LEFT JOIN agg a ON a.customer_id = c.id
  WHERE c.deleted_at IS NULL
), s AS (
  SELECT m.*,
    CASE
      WHEN visits = 0 THEN 'new'
      WHEN days_since_last_visit >= setting_num('status.inactive_days', 180) THEN 'inactive'
      WHEN days_since_last_visit >= setting_num('status.winback_days', 90)   THEN 'win_back'
      WHEN days_since_last_visit >= setting_num('status.lapsed_days', 60)    THEN 'lapsed'
      WHEN days_since_last_visit >= expected_interval_days * 1.5             THEN 'at_risk'
      WHEN days_since_last_visit >= expected_interval_days                   THEN 'due'
      WHEN visits = 1 THEN 'new'
      WHEN days_since_last_visit <= setting_num('status.active_days', 30)    THEN 'active'
      ELSE 'returning' END AS lifecycle_status
  FROM m
)
SELECT s.*,
  CASE WHEN visits > 0 AND (vip_override
         OR total_spend >= setting_num('vip.min_spend', 50000)
         OR visits >= setting_num('vip.min_visits', 10)) THEN 'vip' ELSE lifecycle_status END AS status,
  CASE WHEN last_visit IS NOT NULL
       THEN last_visit + round(expected_interval_days)::int END AS expected_next_visit
FROM s;

-- Campaign performance with revenue attribution: visits/bookings by the recipient within the
-- attribution window AFTER the message was sent.
CREATE VIEW v_campaign_performance AS
SELECT c.id AS campaign_id, c.name, c.channel,
       COUNT(r.id)                                   AS audience,
       COUNT(r.sent_at)                              AS sent,
       COUNT(r.delivered_at)                         AS delivered,
       COUNT(r.read_at)                              AS read_count,
       COUNT(r.replied_at)                           AS replies,
       COUNT(*) FILTER (WHERE r.status = 'opted_out') AS opt_outs,
       COALESCE(SUM(att.bookings), 0)::int           AS bookings,
       COALESCE(SUM(att.visits), 0)::int             AS completed_visits,
       COALESCE(SUM(att.revenue), 0)::numeric(14,2)  AS revenue
FROM marketing_campaigns c
LEFT JOIN campaign_recipients r ON r.campaign_id = c.id
LEFT JOIN LATERAL (
  SELECT
    (SELECT COUNT(*) FROM appointments a
       WHERE a.customer_id = r.customer_id AND r.sent_at IS NOT NULL
         AND a.created_at >= r.sent_at
         AND a.created_at <  r.sent_at + make_interval(days => c.attribution_window_days)
         AND a.status <> 'cancelled') AS bookings,
    (SELECT COUNT(*) FROM visits v
       WHERE v.customer_id = r.customer_id AND r.sent_at IS NOT NULL AND v.status = 'completed'
         AND v.checked_in_at >= r.sent_at
         AND v.checked_in_at <  r.sent_at + make_interval(days => c.attribution_window_days)) AS visits,
    (SELECT COALESCE(SUM(t.total), 0) FROM transactions t JOIN visits v ON v.id = t.visit_id
       WHERE v.customer_id = r.customer_id AND r.sent_at IS NOT NULL AND t.status <> 'voided'
         AND v.checked_in_at >= r.sent_at
         AND v.checked_in_at <  r.sent_at + make_interval(days => c.attribution_window_days)) AS revenue
) att ON true
GROUP BY c.id, c.name, c.channel;

CREATE OR REPLACE FUNCTION snapshot_campaign_results(p_campaign bigint) RETURNS void LANGUAGE sql AS $$
  INSERT INTO campaign_results (campaign_id, audience, sent, delivered, read_count, replies, opt_outs,
                                bookings, completed_visits, revenue)
  SELECT campaign_id, audience, sent, delivered, read_count, replies, opt_outs, bookings, completed_visits, revenue
  FROM v_campaign_performance WHERE campaign_id = p_campaign
$$;

-- Services bought together (same visit) for cross-sell analysis
CREATE VIEW v_service_combinations AS
SELECT a.description AS service_a, b.description AS service_b,
       COUNT(DISTINCT t.customer_id) AS customers,
       COUNT(DISTINCT t.id)          AS combinations,
       SUM(t.total)                  AS revenue,
       round(AVG(t.total), 2)        AS avg_combination_value
FROM transactions t
JOIN transaction_items a ON a.transaction_id = t.id AND a.item_type = 'service'
JOIN transaction_items b ON b.transaction_id = t.id AND b.item_type = 'service' AND a.service_id < b.service_id
WHERE t.status <> 'voided'
GROUP BY a.description, b.description;

COMMIT;

-- Production hardening (run as a DBA after loading the schema):
--   CREATE ROLE salon_app LOGIN PASSWORD '...';
--   GRANT USAGE ON SCHEMA public TO salon_app;
--   GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO salon_app;
--   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO salon_app;
--   REVOKE UPDATE, DELETE ON audit_logs, inventory_transactions FROM salon_app;
-- The application must NOT connect as the table owner or a superuser.
