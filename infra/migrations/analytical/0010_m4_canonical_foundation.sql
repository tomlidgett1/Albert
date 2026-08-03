BEGIN;

-- Albert analytical cell foundation (M4). Apply only as the migration owner.
-- Runtime processes never own DDL and the analytical database is not reachable
-- from browsers or the answering model.

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS mart;
CREATE SCHEMA IF NOT EXISTS quality;
CREATE SCHEMA IF NOT EXISTS semantic_internal;

CREATE OR REPLACE FUNCTION core.is_ulid(candidate text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$ SELECT candidate ~ '^[0-9A-HJKMNP-TV-Z]{26}$' $$;

CREATE OR REPLACE FUNCTION core.is_currency(candidate text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$ SELECT candidate ~ '^[A-Z]{3}$' $$;

CREATE OR REPLACE FUNCTION core.current_tenant_id()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$ SELECT NULLIF(current_setting('albert.tenant_id', true), '') $$;

-- Lookup-constrained text is used instead of PostgreSQL enums so lifecycle
-- changes remain reversible data migrations.
CREATE TABLE IF NOT EXISTS core.channel_type_lookup (value text PRIMARY KEY, description text NOT NULL);
CREATE TABLE IF NOT EXISTS core.commerce_status_lookup (value text PRIMARY KEY, description text NOT NULL);
CREATE TABLE IF NOT EXISTS core.payment_status_lookup (value text PRIMARY KEY, description text NOT NULL);
CREATE TABLE IF NOT EXISTS core.relationship_lookup (value text PRIMARY KEY, description text NOT NULL);
CREATE TABLE IF NOT EXISTS core.event_link_type_lookup (value text PRIMARY KEY, description text NOT NULL);
CREATE TABLE IF NOT EXISTS core.entity_type_lookup (value text PRIMARY KEY, description text NOT NULL);
CREATE TABLE IF NOT EXISTS core.match_method_lookup (value text PRIMARY KEY, description text NOT NULL);
CREATE TABLE IF NOT EXISTS core.match_status_lookup (value text PRIMARY KEY, description text NOT NULL);
CREATE TABLE IF NOT EXISTS core.confidence_band_lookup (value text PRIMARY KEY, description text NOT NULL);
CREATE TABLE IF NOT EXISTS core.authority_concept_lookup (value text PRIMARY KEY, description text NOT NULL);
CREATE TABLE IF NOT EXISTS core.authority_scope_lookup (value text PRIMARY KEY, description text NOT NULL);
CREATE TABLE IF NOT EXISTS quality.check_status_lookup (value text PRIMARY KEY, description text NOT NULL);

INSERT INTO core.channel_type_lookup VALUES
  ('in_store','In-store sale'),('online','Online sale'),('phone','Phone sale') ON CONFLICT DO NOTHING;
INSERT INTO core.commerce_status_lookup VALUES
  ('open','Open'),('completed','Completed'),('voided','Voided'),('cancelled','Cancelled'),('refunded','Refunded') ON CONFLICT DO NOTHING;
INSERT INTO core.payment_status_lookup VALUES
  ('pending','Pending'),('captured','Captured'),('refunded','Refunded'),('voided','Voided'),('failed','Failed') ON CONFLICT DO NOTHING;
INSERT INTO core.relationship_lookup VALUES
  ('authoritative','Authoritative source observation'),('downstream_copy','Downstream copy'),('accounting_posting','Accounting posting'),('settlement','Settlement') ON CONFLICT DO NOTHING;
INSERT INTO core.event_link_type_lookup VALUES
  ('duplicate_of','Duplicate source event'),('accounting_posting_of','Accounting posting evidence'),('reversal_of','Reversal evidence'),('part_of_batch','Batch membership') ON CONFLICT DO NOTHING;
INSERT INTO core.entity_type_lookup VALUES
  ('worker','Worker'),('location','Location'),('product_variant','Product variant'),('customer_account','Customer account'),('supplier','Supplier') ON CONFLICT DO NOTHING;
INSERT INTO core.match_method_lookup VALUES
  ('external_id','Explicit external identifier'),('deterministic_key','Exact scoped deterministic key'),('composite_suggestion','Deterministic composite suggestion'),('user_confirmed','User-confirmed match') ON CONFLICT DO NOTHING;
INSERT INTO core.match_status_lookup VALUES
  ('proposed','Awaiting review'),('accepted','Accepted'),('rejected','Rejected'),('superseded','Superseded reversibly') ON CONFLICT DO NOTHING;
INSERT INTO core.confidence_band_lookup VALUES
  ('high','High deterministic confidence'),('medium','Reviewable deterministic confidence'),('low','Insufficient confidence') ON CONFLICT DO NOTHING;
INSERT INTO core.authority_concept_lookup VALUES
  ('operational_sales','Operational sales'),('stock','Stock'),('product_master','Product master'),('customer_master','Customer master'),
  ('statutory_finance','Statutory finance'),('cash_settlement','Cash settlement'),('planned_shifts','Planned shifts'),('worked_hours','Worked hours') ON CONFLICT DO NOTHING;
INSERT INTO core.authority_scope_lookup VALUES
  ('tenant','Whole tenant'),('location','Location'),('legal_entity','Legal entity') ON CONFLICT DO NOTHING;
INSERT INTO quality.check_status_lookup VALUES
  ('passed','Check passed'),('warning','Check produced a caveat'),('failed','Check failed'),('blocked','Check could not run') ON CONFLICT DO NOTHING;

-- Sixteen dimensions.
CREATE TABLE IF NOT EXISTS core.calendar_day (
  calendar_date date PRIMARY KEY,
  calendar_year smallint NOT NULL,
  calendar_quarter smallint NOT NULL CHECK (calendar_quarter BETWEEN 1 AND 4),
  calendar_month smallint NOT NULL CHECK (calendar_month BETWEEN 1 AND 12),
  iso_week smallint NOT NULL CHECK (iso_week BETWEEN 1 AND 53),
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  is_weekend boolean NOT NULL
);

CREATE TABLE IF NOT EXISTS core.location (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)),
  name text NOT NULL, timezone text NOT NULL, legal_entity_id text, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id)
);
CREATE TABLE IF NOT EXISTS core.register (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)),
  location_id text NOT NULL, name text NOT NULL, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,location_id) REFERENCES core.location(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS core.channel (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)),
  name text NOT NULL, channel_type text NOT NULL REFERENCES core.channel_type_lookup(value), active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id)
);
CREATE TABLE IF NOT EXISTS core.legal_entity (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)),
  name text NOT NULL, abn text, base_currency text NOT NULL CHECK (core.is_currency(base_currency)), active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id)
);
ALTER TABLE core.location DROP CONSTRAINT IF EXISTS location_legal_entity_fk;
ALTER TABLE core.location ADD CONSTRAINT location_legal_entity_fk FOREIGN KEY (tenant_id,legal_entity_id) REFERENCES core.legal_entity(tenant_id,id);

CREATE TABLE IF NOT EXISTS core.person (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id)
);
CREATE TABLE IF NOT EXISTS core.customer_account (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), person_id text, display_name text NOT NULL,
  first_order_at timestamptz, last_order_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,person_id) REFERENCES core.person(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS core.worker (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), person_id text, display_name text NOT NULL, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,person_id) REFERENCES core.person(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS core.employment_episode (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), worker_id text NOT NULL, legal_entity_id text,
  effective_from date NOT NULL, effective_to date, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), CHECK (effective_to IS NULL OR effective_to > effective_from),
  FOREIGN KEY (tenant_id,worker_id) REFERENCES core.worker(tenant_id,id), FOREIGN KEY (tenant_id,legal_entity_id) REFERENCES core.legal_entity(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS core.supplier (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), name text NOT NULL, abn text, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id)
);
CREATE TABLE IF NOT EXISTS core.product (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), name text NOT NULL, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id)
);
CREATE TABLE IF NOT EXISTS core.product_variant (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), product_id text NOT NULL, name text NOT NULL, sku text, barcode text, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,product_id) REFERENCES core.product(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS core.product_category (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), parent_category_id text, name text NOT NULL, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,parent_category_id) REFERENCES core.product_category(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS core.gl_account (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), legal_entity_id text NOT NULL,
  code text NOT NULL, name text NOT NULL, account_class text NOT NULL, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,legal_entity_id,code), FOREIGN KEY (tenant_id,legal_entity_id) REFERENCES core.legal_entity(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS core.tax_code (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), name text NOT NULL,
  rate numeric(9,6) NOT NULL, input_or_output text NOT NULL CHECK (input_or_output IN ('input','output','both','none')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id)
);
CREATE TABLE IF NOT EXISTS core.stock_location (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), location_id text, name text NOT NULL, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,location_id) REFERENCES core.location(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS core.product_category_assignment (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), product_variant_id text NOT NULL, product_category_id text NOT NULL,
  effective_from timestamptz NOT NULL, effective_to timestamptz, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  FOREIGN KEY (tenant_id,product_variant_id) REFERENCES core.product_variant(tenant_id,id),
  FOREIGN KEY (tenant_id,product_category_id) REFERENCES core.product_category(tenant_id,id)
);

-- Thirteen source-neutral truth facts. Money is always numeric(19,4) with an
-- explicit ISO-4217 currency; source multiplicity lives in observation bridges.
CREATE TABLE IF NOT EXISTS core.commerce_order (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)),
  location_id text NOT NULL, register_id text, channel_id text NOT NULL, customer_account_id text, worker_id text,
  ordered_at timestamptz NOT NULL, completed_at timestamptz, fulfilled_at timestamptz, business_date date NOT NULL,
  status text NOT NULL REFERENCES core.commerce_status_lookup(value), voided boolean NOT NULL DEFAULT false, internal_transaction boolean NOT NULL DEFAULT false,
  gross_amount numeric(19,4) NOT NULL, discount_amount numeric(19,4) NOT NULL, net_amount_inc_tax numeric(19,4) NOT NULL,
  tax_amount numeric(19,4) NOT NULL, net_amount_ex_tax numeric(19,4) NOT NULL, total_cost numeric(19,4), currency text NOT NULL CHECK (core.is_currency(currency)),
  primary_connection_id text NOT NULL, primary_source_record_id text NOT NULL, sync_run_id text NOT NULL CHECK (core.is_ulid(sync_run_id)), source_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,location_id) REFERENCES core.location(tenant_id,id), FOREIGN KEY (tenant_id,register_id) REFERENCES core.register(tenant_id,id),
  FOREIGN KEY (tenant_id,channel_id) REFERENCES core.channel(tenant_id,id), FOREIGN KEY (tenant_id,customer_account_id) REFERENCES core.customer_account(tenant_id,id),
  FOREIGN KEY (tenant_id,worker_id) REFERENCES core.worker(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS core.commerce_order_line (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), order_id text NOT NULL,
  line_number integer NOT NULL CHECK (line_number > 0), product_variant_id text, location_id text NOT NULL, register_id text, channel_id text NOT NULL,
  customer_account_id text, worker_id text, tax_code_id text, ordered_at timestamptz NOT NULL, completed_at timestamptz, fulfilled_at timestamptz, business_date date NOT NULL,
  order_status text NOT NULL REFERENCES core.commerce_status_lookup(value), voided boolean NOT NULL DEFAULT false, internal_transaction boolean NOT NULL DEFAULT false,
  quantity numeric(19,4) NOT NULL, unit_price numeric(19,4) NOT NULL, unit_cost numeric(19,4), gross_amount numeric(19,4) NOT NULL,
  discount_amount numeric(19,4) NOT NULL, net_amount_inc_tax numeric(19,4) NOT NULL, tax_amount numeric(19,4) NOT NULL,
  net_amount_ex_tax numeric(19,4) NOT NULL, total_cost numeric(19,4), currency text NOT NULL CHECK (core.is_currency(currency)),
  primary_connection_id text NOT NULL, primary_source_record_id text NOT NULL, sync_run_id text NOT NULL CHECK (core.is_ulid(sync_run_id)), source_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,order_id,line_number),
  FOREIGN KEY (tenant_id,order_id) REFERENCES core.commerce_order(tenant_id,id), FOREIGN KEY (tenant_id,product_variant_id) REFERENCES core.product_variant(tenant_id,id),
  FOREIGN KEY (tenant_id,location_id) REFERENCES core.location(tenant_id,id), FOREIGN KEY (tenant_id,register_id) REFERENCES core.register(tenant_id,id),
  FOREIGN KEY (tenant_id,channel_id) REFERENCES core.channel(tenant_id,id), FOREIGN KEY (tenant_id,customer_account_id) REFERENCES core.customer_account(tenant_id,id),
  FOREIGN KEY (tenant_id,worker_id) REFERENCES core.worker(tenant_id,id), FOREIGN KEY (tenant_id,tax_code_id) REFERENCES core.tax_code(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS core.commerce_payment (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), order_id text NOT NULL, location_id text NOT NULL, channel_id text,
  paid_at timestamptz NOT NULL, business_date date NOT NULL, tender_type text NOT NULL, status text NOT NULL REFERENCES core.payment_status_lookup(value),
  amount numeric(19,4) NOT NULL, currency text NOT NULL CHECK (core.is_currency(currency)),
  primary_connection_id text NOT NULL, primary_source_record_id text NOT NULL, sync_run_id text NOT NULL CHECK (core.is_ulid(sync_run_id)), source_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,order_id) REFERENCES core.commerce_order(tenant_id,id), FOREIGN KEY (tenant_id,location_id) REFERENCES core.location(tenant_id,id),
  FOREIGN KEY (tenant_id,channel_id) REFERENCES core.channel(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS core.commerce_refund_line (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), original_order_line_id text NOT NULL,
  location_id text NOT NULL, product_variant_id text, worker_id text, refunded_at timestamptz NOT NULL, business_date date NOT NULL,
  quantity numeric(19,4) NOT NULL CHECK (quantity >= 0), refund_amount_inc_tax numeric(19,4) NOT NULL CHECK (refund_amount_inc_tax >= 0),
  tax_amount numeric(19,4) NOT NULL CHECK (tax_amount >= 0), refund_amount_ex_tax numeric(19,4) NOT NULL CHECK (refund_amount_ex_tax >= 0),
  total_cost_reversed numeric(19,4), currency text NOT NULL CHECK (core.is_currency(currency)),
  primary_connection_id text NOT NULL, primary_source_record_id text NOT NULL, sync_run_id text NOT NULL CHECK (core.is_ulid(sync_run_id)), source_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,original_order_line_id) REFERENCES core.commerce_order_line(tenant_id,id), FOREIGN KEY (tenant_id,location_id) REFERENCES core.location(tenant_id,id),
  FOREIGN KEY (tenant_id,product_variant_id) REFERENCES core.product_variant(tenant_id,id), FOREIGN KEY (tenant_id,worker_id) REFERENCES core.worker(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS core.inventory_movement (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), product_variant_id text NOT NULL, stock_location_id text NOT NULL,
  movement_type text NOT NULL, occurred_at timestamptz NOT NULL, business_date date NOT NULL, quantity_delta numeric(19,4) NOT NULL,
  unit_cost numeric(19,4), total_cost numeric(19,4), currency text NOT NULL CHECK (core.is_currency(currency)),
  primary_connection_id text NOT NULL, primary_source_record_id text NOT NULL, sync_run_id text NOT NULL CHECK (core.is_ulid(sync_run_id)), source_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,product_variant_id) REFERENCES core.product_variant(tenant_id,id), FOREIGN KEY (tenant_id,stock_location_id) REFERENCES core.stock_location(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS core.inventory_balance_snapshot (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), product_variant_id text NOT NULL, stock_location_id text NOT NULL,
  snapshot_at timestamptz NOT NULL, snapshot_date date NOT NULL, quantity_on_hand numeric(19,4) NOT NULL, unit_cost numeric(19,4), stock_value numeric(19,4),
  currency text NOT NULL CHECK (core.is_currency(currency)), primary_connection_id text NOT NULL, primary_source_record_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (core.is_ulid(sync_run_id)), source_updated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,product_variant_id,stock_location_id,snapshot_date),
  FOREIGN KEY (tenant_id,product_variant_id) REFERENCES core.product_variant(tenant_id,id), FOREIGN KEY (tenant_id,stock_location_id) REFERENCES core.stock_location(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS core.purchase_order_line (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), purchase_order_ref text NOT NULL, line_number integer NOT NULL,
  supplier_id text, product_variant_id text, stock_location_id text, ordered_at timestamptz NOT NULL, expected_at timestamptz, received_at timestamptz, business_date date NOT NULL,
  status text NOT NULL, ordered_quantity numeric(19,4) NOT NULL, received_quantity numeric(19,4) NOT NULL, unit_cost numeric(19,4), total_cost numeric(19,4),
  currency text NOT NULL CHECK (core.is_currency(currency)), primary_connection_id text NOT NULL, primary_source_record_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (core.is_ulid(sync_run_id)), source_updated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,purchase_order_ref,line_number), FOREIGN KEY (tenant_id,supplier_id) REFERENCES core.supplier(tenant_id,id),
  FOREIGN KEY (tenant_id,product_variant_id) REFERENCES core.product_variant(tenant_id,id), FOREIGN KEY (tenant_id,stock_location_id) REFERENCES core.stock_location(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS core.finance_journal_line (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), journal_id text NOT NULL, line_number integer NOT NULL,
  legal_entity_id text NOT NULL, gl_account_id text NOT NULL, tax_code_id text, location_id text, posted_at timestamptz NOT NULL, business_date date NOT NULL,
  status text NOT NULL, debit_amount numeric(19,4) NOT NULL DEFAULT 0 CHECK (debit_amount >= 0), credit_amount numeric(19,4) NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
  tax_amount numeric(19,4) NOT NULL DEFAULT 0, currency text NOT NULL CHECK (core.is_currency(currency)), primary_connection_id text NOT NULL,
  primary_source_record_id text NOT NULL, sync_run_id text NOT NULL CHECK (core.is_ulid(sync_run_id)), source_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,journal_id,line_number),
  CHECK (debit_amount = 0 OR credit_amount = 0), FOREIGN KEY (tenant_id,legal_entity_id) REFERENCES core.legal_entity(tenant_id,id),
  FOREIGN KEY (tenant_id,gl_account_id) REFERENCES core.gl_account(tenant_id,id), FOREIGN KEY (tenant_id,tax_code_id) REFERENCES core.tax_code(tenant_id,id),
  FOREIGN KEY (tenant_id,location_id) REFERENCES core.location(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS core.finance_invoice_line (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), invoice_id text NOT NULL, line_number integer NOT NULL,
  invoice_type text NOT NULL CHECK (invoice_type IN ('sales_invoice','supplier_bill')), legal_entity_id text NOT NULL, customer_account_id text, supplier_id text,
  gl_account_id text, tax_code_id text, location_id text, issued_at timestamptz NOT NULL, due_at timestamptz, paid_at timestamptz, business_date date NOT NULL, status text NOT NULL,
  quantity numeric(19,4), unit_amount numeric(19,4), net_amount_ex_tax numeric(19,4) NOT NULL, tax_amount numeric(19,4) NOT NULL,
  net_amount_inc_tax numeric(19,4) NOT NULL, outstanding_amount numeric(19,4) NOT NULL, currency text NOT NULL CHECK (core.is_currency(currency)),
  primary_connection_id text NOT NULL, primary_source_record_id text NOT NULL, sync_run_id text NOT NULL CHECK (core.is_ulid(sync_run_id)), source_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,invoice_id,line_number),
  FOREIGN KEY (tenant_id,legal_entity_id) REFERENCES core.legal_entity(tenant_id,id), FOREIGN KEY (tenant_id,customer_account_id) REFERENCES core.customer_account(tenant_id,id),
  FOREIGN KEY (tenant_id,supplier_id) REFERENCES core.supplier(tenant_id,id), FOREIGN KEY (tenant_id,gl_account_id) REFERENCES core.gl_account(tenant_id,id),
  FOREIGN KEY (tenant_id,tax_code_id) REFERENCES core.tax_code(tenant_id,id), FOREIGN KEY (tenant_id,location_id) REFERENCES core.location(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS core.finance_bank_transaction (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), legal_entity_id text NOT NULL, gl_account_id text, location_id text,
  transaction_at timestamptz NOT NULL, posted_at timestamptz, business_date date NOT NULL, status text NOT NULL, amount numeric(19,4) NOT NULL,
  tax_amount numeric(19,4) NOT NULL DEFAULT 0, currency text NOT NULL CHECK (core.is_currency(currency)), primary_connection_id text NOT NULL,
  primary_source_record_id text NOT NULL, sync_run_id text NOT NULL CHECK (core.is_ulid(sync_run_id)), source_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,legal_entity_id) REFERENCES core.legal_entity(tenant_id,id), FOREIGN KEY (tenant_id,gl_account_id) REFERENCES core.gl_account(tenant_id,id),
  FOREIGN KEY (tenant_id,location_id) REFERENCES core.location(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS core.workforce_shift (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), worker_id text NOT NULL, employment_episode_id text, location_id text NOT NULL,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, business_date date NOT NULL, status text NOT NULL, rostered_minutes integer NOT NULL CHECK (rostered_minutes >= 0),
  estimated_cost numeric(19,4), currency text NOT NULL CHECK (core.is_currency(currency)), primary_connection_id text NOT NULL, primary_source_record_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (core.is_ulid(sync_run_id)), source_updated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), CHECK (ends_at > starts_at), FOREIGN KEY (tenant_id,worker_id) REFERENCES core.worker(tenant_id,id),
  FOREIGN KEY (tenant_id,employment_episode_id) REFERENCES core.employment_episode(tenant_id,id), FOREIGN KEY (tenant_id,location_id) REFERENCES core.location(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS core.workforce_time_entry (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), worker_id text NOT NULL, employment_episode_id text, location_id text NOT NULL,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, approved_at timestamptz, business_date date NOT NULL, status text NOT NULL,
  worked_minutes integer NOT NULL CHECK (worked_minutes >= 0), overtime_minutes integer NOT NULL DEFAULT 0 CHECK (overtime_minutes >= 0), labour_cost numeric(19,4),
  currency text NOT NULL CHECK (core.is_currency(currency)), primary_connection_id text NOT NULL, primary_source_record_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (core.is_ulid(sync_run_id)), source_updated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), CHECK (ends_at > starts_at), FOREIGN KEY (tenant_id,worker_id) REFERENCES core.worker(tenant_id,id),
  FOREIGN KEY (tenant_id,employment_episode_id) REFERENCES core.employment_episode(tenant_id,id), FOREIGN KEY (tenant_id,location_id) REFERENCES core.location(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS core.workforce_leave (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), worker_id text NOT NULL, employment_episode_id text, location_id text,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, business_date date NOT NULL, status text NOT NULL, leave_type text NOT NULL,
  leave_minutes integer NOT NULL CHECK (leave_minutes >= 0), leave_cost numeric(19,4), currency text NOT NULL CHECK (core.is_currency(currency)),
  primary_connection_id text NOT NULL, primary_source_record_id text NOT NULL, sync_run_id text NOT NULL CHECK (core.is_ulid(sync_run_id)), source_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id), CHECK (ends_at > starts_at),
  FOREIGN KEY (tenant_id,worker_id) REFERENCES core.worker(tenant_id,id), FOREIGN KEY (tenant_id,employment_episode_id) REFERENCES core.employment_episode(tenant_id,id),
  FOREIGN KEY (tenant_id,location_id) REFERENCES core.location(tenant_id,id)
);

-- Durable many-to-many observation and identity evidence.
CREATE TABLE IF NOT EXISTS core.order_source_observation (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), order_id text NOT NULL, connection_id text NOT NULL,
  source_object_type text NOT NULL, source_record_id text NOT NULL, relationship text NOT NULL REFERENCES core.relationship_lookup(value),
  match_method text NOT NULL REFERENCES core.match_method_lookup(value), confidence_band text NOT NULL REFERENCES core.confidence_band_lookup(value),
  valid_from timestamptz NOT NULL, valid_to timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,order_id,connection_id,source_object_type,source_record_id,valid_from),
  CHECK (valid_to IS NULL OR valid_to > valid_from), FOREIGN KEY (tenant_id,order_id) REFERENCES core.commerce_order(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS core.order_line_source_observation (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), order_line_id text NOT NULL, connection_id text NOT NULL,
  source_object_type text NOT NULL, source_record_id text NOT NULL, source_line_ref text NOT NULL,
  relationship text NOT NULL REFERENCES core.relationship_lookup(value), allocation numeric(19,4),
  match_method text NOT NULL REFERENCES core.match_method_lookup(value), confidence_band text NOT NULL REFERENCES core.confidence_band_lookup(value),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,order_line_id,connection_id,source_object_type,source_record_id,source_line_ref),
  FOREIGN KEY (tenant_id,order_line_id) REFERENCES core.commerce_order_line(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS core.event_link (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), link_type text NOT NULL REFERENCES core.event_link_type_lookup(value),
  from_connection_id text NOT NULL, from_object_type text NOT NULL, from_source_record_id text NOT NULL,
  to_connection_id text NOT NULL, to_object_type text NOT NULL, to_source_record_id text NOT NULL,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'), rule_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,link_type,from_connection_id,from_object_type,from_source_record_id,to_connection_id,to_object_type,to_source_record_id)
);
CREATE TABLE IF NOT EXISTS core.entity_source_link (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), link_id text NOT NULL CHECK (core.is_ulid(link_id)), entity_type text NOT NULL REFERENCES core.entity_type_lookup(value),
  canonical_entity_id text NOT NULL, connection_id text NOT NULL, source_object_type text NOT NULL, source_record_id text NOT NULL,
  match_method text NOT NULL REFERENCES core.match_method_lookup(value), match_status text NOT NULL REFERENCES core.match_status_lookup(value),
  confidence_band text NOT NULL REFERENCES core.confidence_band_lookup(value), evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  valid_from timestamptz NOT NULL, valid_to timestamptz, confirmed_by text, superseded_by text,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,link_id),
  UNIQUE (tenant_id,entity_type,connection_id,source_object_type,source_record_id,valid_from),
  CHECK (valid_to IS NULL OR valid_to > valid_from), FOREIGN KEY (tenant_id,superseded_by) REFERENCES core.entity_source_link(tenant_id,link_id)
);
CREATE TABLE IF NOT EXISTS core.source_authority (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), concept text NOT NULL REFERENCES core.authority_concept_lookup(value),
  scope_type text NOT NULL REFERENCES core.authority_scope_lookup(value), scope_id text NOT NULL, authoritative_connection_id text NOT NULL,
  effective_from timestamptz NOT NULL, effective_to timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS source_authority_one_open_interval
  ON core.source_authority (tenant_id,concept,scope_type,scope_id) WHERE effective_to IS NULL;

-- Quality snapshots are append-only evidence; details carry sampled finding IDs,
-- never unrestricted source payloads.
CREATE TABLE IF NOT EXISTS quality.check_result (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), run_id text NOT NULL CHECK (core.is_ulid(run_id)), check_id text NOT NULL,
  domain text NOT NULL, status text NOT NULL REFERENCES quality.check_status_lookup(value), observed numeric(19,4), threshold numeric(19,4),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'), checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,run_id,check_id)
);
CREATE TABLE IF NOT EXISTS quality.finding (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), id text NOT NULL CHECK (core.is_ulid(id)), run_id text NOT NULL CHECK (core.is_ulid(run_id)),
  check_id text NOT NULL, entity_type text NOT NULL, entity_id text NOT NULL, severity text NOT NULL CHECK (severity IN ('info','warning','error')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id)
);
CREATE TABLE IF NOT EXISTS quality.pipeline_stats (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), snapshot_at timestamptz NOT NULL, domain text NOT NULL,
  source_rows bigint NOT NULL CHECK (source_rows >= 0), canonical_rows bigint NOT NULL CHECK (canonical_rows >= 0), rejected_rows bigint NOT NULL CHECK (rejected_rows >= 0),
  observed_entities bigint NOT NULL CHECK (observed_entities >= 0), linked_entities bigint NOT NULL CHECK (linked_entities >= 0),
  source_watermarks jsonb NOT NULL DEFAULT '{}'::jsonb, invariant_status jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id,snapshot_at,domain)
);

-- Required initial marts plus the registry's governed aggregate sets. These are
-- rebuilt tenant-at-a-time by transform_rw in migration 0002.
CREATE TABLE IF NOT EXISTS mart.sales_day_location (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), business_date date NOT NULL, location_id text NOT NULL,
  currency text NOT NULL CHECK (core.is_currency(currency)), gross_takings_inc_gst numeric(19,4) NOT NULL,
  net_sales_ex_gst numeric(19,4) NOT NULL, units_sold numeric(19,4) NOT NULL, transactions bigint NOT NULL,
  discount_amount numeric(19,4) NOT NULL, refund_amount_inc_tax numeric(19,4) NOT NULL, total_cost numeric(19,4),
  refreshed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,business_date,location_id,currency),
  FOREIGN KEY (tenant_id,location_id) REFERENCES core.location(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS mart.labour_day_location (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), business_date date NOT NULL, location_id text NOT NULL,
  currency text NOT NULL CHECK (core.is_currency(currency)), rostered_minutes bigint NOT NULL, worked_minutes bigint NOT NULL,
  overtime_minutes bigint NOT NULL, labour_cost numeric(19,4), refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,business_date,location_id,currency), FOREIGN KEY (tenant_id,location_id) REFERENCES core.location(tenant_id,id)
);

-- Every composite/scan index begins with tenant_id; initial build deliberately
-- uses no table partitioning.
CREATE INDEX IF NOT EXISTS commerce_order_tenant_business_date_idx ON core.commerce_order (tenant_id,business_date,location_id);
CREATE INDEX IF NOT EXISTS commerce_order_line_tenant_business_date_idx ON core.commerce_order_line (tenant_id,business_date,location_id);
CREATE INDEX IF NOT EXISTS commerce_payment_tenant_business_date_idx ON core.commerce_payment (tenant_id,business_date,location_id);
CREATE INDEX IF NOT EXISTS commerce_refund_line_tenant_business_date_idx ON core.commerce_refund_line (tenant_id,business_date,location_id);
CREATE INDEX IF NOT EXISTS inventory_movement_tenant_business_date_idx ON core.inventory_movement (tenant_id,business_date,stock_location_id);
CREATE INDEX IF NOT EXISTS inventory_snapshot_tenant_date_idx ON core.inventory_balance_snapshot (tenant_id,snapshot_date,stock_location_id);
CREATE INDEX IF NOT EXISTS journal_line_tenant_business_date_idx ON core.finance_journal_line (tenant_id,business_date,legal_entity_id);
CREATE INDEX IF NOT EXISTS invoice_line_tenant_business_date_idx ON core.finance_invoice_line (tenant_id,business_date,legal_entity_id);
CREATE INDEX IF NOT EXISTS bank_tx_tenant_business_date_idx ON core.finance_bank_transaction (tenant_id,business_date,legal_entity_id);
CREATE INDEX IF NOT EXISTS shift_tenant_business_date_idx ON core.workforce_shift (tenant_id,business_date,location_id);
CREATE INDEX IF NOT EXISTS time_entry_tenant_business_date_idx ON core.workforce_time_entry (tenant_id,business_date,location_id);
CREATE INDEX IF NOT EXISTS source_link_tenant_entity_idx ON core.entity_source_link (tenant_id,entity_type,canonical_entity_id);
CREATE INDEX IF NOT EXISTS event_link_tenant_from_idx ON core.event_link (tenant_id,from_connection_id,from_object_type,from_source_record_id);

-- Immutable lineage columns can only be set at insert. Deletes remain possible
-- for the governed disconnection/deletion workflow.
CREATE OR REPLACE FUNCTION core.protect_fact_lineage()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog,core AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.primary_connection_id IS DISTINCT FROM OLD.primary_connection_id
     OR NEW.primary_source_record_id IS DISTINCT FROM OLD.primary_source_record_id
     OR NEW.sync_run_id IS DISTINCT FROM OLD.sync_run_id THEN
    RAISE EXCEPTION 'canonical fact lineage is immutable' USING ERRCODE = '22000';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE fact_table text;
BEGIN
  FOREACH fact_table IN ARRAY ARRAY[
    'commerce_order','commerce_order_line','commerce_payment','commerce_refund_line','inventory_movement',
    'inventory_balance_snapshot','purchase_order_line','finance_journal_line','finance_invoice_line',
    'finance_bank_transaction','workforce_shift','workforce_time_entry','workforce_leave'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS protect_lineage ON core.%I', fact_table);
    EXECUTE format('CREATE TRIGGER protect_lineage BEFORE UPDATE ON core.%I FOR EACH ROW EXECUTE FUNCTION core.protect_fact_lineage()', fact_table);
  END LOOP;
END $$;

-- Defence-in-depth RLS: even correctly parameterised queries must also set the
-- trusted transaction-local albert.tenant_id. No policy trusts a model field.
DO $$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT t.table_schema,t.table_name FROM information_schema.tables AS t
    WHERE t.table_schema IN ('core','mart','quality','semantic_internal')
      AND t.table_type = 'BASE TABLE'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.column_name = 'tenant_id'
      )
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', item.table_schema,item.table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', item.table_schema,item.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I.%I', item.table_schema,item.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I.%I USING (tenant_id = core.current_tenant_id()) WITH CHECK (tenant_id = core.current_tenant_id())',
      item.table_schema,item.table_name
    );
  END LOOP;
END $$;

-- Runtime role creation may be delegated to infrastructure in managed Postgres;
-- this block is idempotent where the migration owner has CREATEROLE.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ingest_rw') THEN CREATE ROLE ingest_rw NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'transform_rw') THEN CREATE ROLE transform_rw NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'semantic_ro') THEN CREATE ROLE semantic_ro NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'diagnostic_ro') THEN CREATE ROLE diagnostic_ro NOLOGIN; END IF;
END $$;

REVOKE ALL ON SCHEMA core,mart,quality,semantic_internal FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA core,mart,quality,semantic_internal FROM PUBLIC;
GRANT USAGE ON SCHEMA core,mart,quality TO transform_rw;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA core,mart,quality TO transform_rw;
GRANT USAGE ON SCHEMA core,mart,quality TO semantic_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA core,mart,quality TO semantic_ro;
GRANT USAGE ON SCHEMA core,mart,quality,semantic_internal TO diagnostic_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA core,mart,quality,semantic_internal TO diagnostic_ro;
-- ingest_rw receives source_<connector> grants in connector-pack migrations only;
-- it intentionally receives no core or mart privilege here.

COMMIT;
