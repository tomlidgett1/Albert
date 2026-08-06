-- Canonical extensions ahead of the Square connector, all additive. Three of
-- Square's realities cannot be stored today, and each rejection would be a
-- silent data loss at transform time:
--
--   1. Virtual Terminal / raw Payments-API payments have no order, so
--      commerce_payment.order_id NOT NULL rejects real tender rows. The
--      column relaxes to nullable; the composite FK still binds every
--      non-null reference.
--   2. PaymentRefund carries no line data. commerce_refund_line's FK to the
--      original order line is deliberately NOT relaxed — a line-level refund
--      that lost its link would silently detach from product economics.
--      Money-level refunds get their own sibling fact, core.commerce_refund.
--   3. An OPEN timecard ("who is working right now") has no end. ends_at and
--      worked_minutes relax to nullable with the interval check preserved for
--      closed entries; SUM semantics ignore the open entry until it settles.
--
-- Settlement evidence graduates from heuristic to deterministic:
-- finance_settlement carries the provider's end_to_end_id — documented as
-- appearing on the bank statement — and finance_settlement_line itemises what
-- each deposit contains. commerce_payment_fee is a fact rather than a column
-- because fees arrive after their payment, may be negative, and adjustments
-- land days later with their own effective_at; a column would silently
-- restate history.
--
-- commerce_order_line gains line_item_type (the only way to exclude
-- gift-card issuance from revenue: without it the same $50 counts on sale and
-- again on redemption) and tax_treatment (Square's gross_sales_money deducts
-- inclusive tax in US/CA/JP but not in EU/AU, so a gross amount means two
-- different things by country unless the treatment is carried per line).

BEGIN;

ALTER TABLE core.commerce_payment ALTER COLUMN order_id DROP NOT NULL;

DO $$
DECLARE v_name text;
BEGIN
  SELECT conname INTO v_name
    FROM pg_constraint
   WHERE conrelid = 'core.workforce_time_entry'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%ends_at%starts_at%';
  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE core.workforce_time_entry DROP CONSTRAINT %I', v_name);
  END IF;
END $$;
ALTER TABLE core.workforce_time_entry ALTER COLUMN ends_at DROP NOT NULL;
ALTER TABLE core.workforce_time_entry ALTER COLUMN worked_minutes DROP NOT NULL;
ALTER TABLE core.workforce_time_entry
  ADD CONSTRAINT workforce_time_entry_interval_check
  CHECK (ends_at IS NULL OR ends_at > starts_at);

CREATE TABLE IF NOT EXISTS core.line_item_type_lookup (value text PRIMARY KEY);
INSERT INTO core.line_item_type_lookup (value) VALUES
  ('product'), ('service'), ('gift_card_issuance'), ('gift_card_redemption'),
  ('shipping'), ('fee'), ('adjustment')
ON CONFLICT (value) DO NOTHING;

ALTER TABLE core.commerce_order_line
  ADD COLUMN IF NOT EXISTS line_item_type text REFERENCES core.line_item_type_lookup(value);
ALTER TABLE core.commerce_order_line
  ADD COLUMN IF NOT EXISTS tax_treatment text
  CHECK (tax_treatment IN ('inclusive', 'additive'));

CREATE TABLE IF NOT EXISTS core.commerce_refund (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  id text NOT NULL CHECK (core.is_ulid(id)),
  order_id text,
  payment_id text,
  location_id text NOT NULL,
  worker_id text,
  refunded_at timestamptz NOT NULL,
  business_date date NOT NULL,
  reason text,
  refund_amount_inc_tax numeric(19,4) NOT NULL CHECK (refund_amount_inc_tax >= 0),
  tax_amount numeric(19,4) NOT NULL CHECK (tax_amount >= 0),
  refund_amount_ex_tax numeric(19,4) NOT NULL CHECK (refund_amount_ex_tax >= 0),
  currency text NOT NULL CHECK (core.is_currency(currency)),
  primary_connection_id text NOT NULL,
  primary_source_record_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (core.is_ulid(sync_run_id)),
  source_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES core.commerce_order(tenant_id, id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES core.commerce_payment(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES core.location(tenant_id, id),
  FOREIGN KEY (tenant_id, worker_id) REFERENCES core.worker(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS core.finance_settlement (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  id text NOT NULL CHECK (core.is_ulid(id)),
  provider text NOT NULL,
  settlement_reference text NOT NULL,
  -- The provider's own end-to-end identifier, documented as appearing on the
  -- bank statement line. This is what turns the amount-tolerance heuristic in
  -- core.refresh_daily_settlement_links into a deterministic id-level join.
  end_to_end_id text,
  initiated_at timestamptz,
  settled_at timestamptz,
  business_date date NOT NULL,
  location_id text,
  gross_amount numeric(19,4) NOT NULL,
  fee_amount numeric(19,4) NOT NULL DEFAULT 0,
  net_amount numeric(19,4) NOT NULL,
  status text NOT NULL,
  currency text NOT NULL CHECK (core.is_currency(currency)),
  primary_connection_id text NOT NULL,
  primary_source_record_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (core.is_ulid(sync_run_id)),
  source_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, provider, settlement_reference),
  FOREIGN KEY (tenant_id, location_id) REFERENCES core.location(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS core.finance_settlement_line (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  id text NOT NULL CHECK (core.is_ulid(id)),
  settlement_id text NOT NULL,
  payment_id text,
  line_type text NOT NULL CHECK (line_type IN ('charge', 'refund', 'fee', 'adjustment')),
  amount numeric(19,4) NOT NULL,
  fee_amount numeric(19,4),
  effective_at timestamptz NOT NULL,
  business_date date NOT NULL,
  currency text NOT NULL CHECK (core.is_currency(currency)),
  primary_connection_id text NOT NULL,
  primary_source_record_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (core.is_ulid(sync_run_id)),
  source_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, settlement_id) REFERENCES core.finance_settlement(tenant_id, id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES core.commerce_payment(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS core.commerce_payment_fee (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  id text NOT NULL CHECK (core.is_ulid(id)),
  payment_id text NOT NULL,
  settlement_id text,
  fee_type text NOT NULL,
  -- Negative amounts are real: fee adjustments and credits land after the
  -- fact with their own effective date.
  amount numeric(19,4) NOT NULL,
  effective_at timestamptz NOT NULL,
  business_date date NOT NULL,
  currency text NOT NULL CHECK (core.is_currency(currency)),
  primary_connection_id text NOT NULL,
  primary_source_record_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (core.is_ulid(sync_run_id)),
  source_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES core.commerce_payment(tenant_id, id),
  FOREIGN KEY (tenant_id, settlement_id) REFERENCES core.finance_settlement(tenant_id, id)
);

DO $do$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'commerce_refund', 'finance_settlement', 'finance_settlement_line', 'commerce_payment_fee'
  ] LOOP
    EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('ALTER TABLE core.%I FORCE ROW LEVEL SECURITY', v_table);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON core.%I', v_table);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON core.%I USING (tenant_id = (SELECT core.current_tenant_id())) WITH CHECK (tenant_id = (SELECT core.current_tenant_id()))',
      v_table);
    EXECUTE format('DROP TRIGGER IF EXISTS protect_lineage ON core.%I', v_table);
    EXECUTE format(
      'CREATE TRIGGER protect_lineage BEFORE UPDATE ON core.%I FOR EACH ROW EXECUTE FUNCTION core.protect_fact_lineage()',
      v_table);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON core.%I TO transform_rw', v_table);
    EXECUTE format('GRANT SELECT ON core.%I TO semantic_ro, diagnostic_ro', v_table);
  END LOOP;
END $do$;

GRANT SELECT ON core.line_item_type_lookup TO transform_rw, semantic_ro, diagnostic_ro;

COMMIT;
