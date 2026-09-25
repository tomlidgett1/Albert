-- 0168: the Cube Xero contract reads Fivetran-landed data.
--
-- Xero now arrives through Albert's Fivetran Connector SDK connector, one
-- destination schema per connection (xero_<connection_ulid>) carrying Albert's
-- own staging table shapes. Cube must keep reading ONE stable surface, so this
-- migration adds:
--
--   * source_xero_fivetran.<table>: UNION ALL views over every *active* bound
--     Fivetran schema, one per staged table, with tenant_id supplied from the
--     binding (never trusting the landed rows), tombstone, and
--     source_record_id exposed as namespaced_source_key. Maintained by
--     ingestion.rebuild_fivetran_source_views('xero'), which the sync worker
--     calls whenever a Fivetran schema is bound, refreshed, or retired.
--   * ingestion.retire_fivetran_destination(): marks a binding retired so a
--     disconnected connection's schema drops out of the union immediately,
--     before its purge.
--   * ingestion.stamp_fivetran_destination(): now skips tables already stamped
--     so it is cheap enough to run on every sync.
--   * The 50 source_xero_official.xo_* views, re-created verbatim from 0164
--     over source_xero_fivetran instead of source_xero. Column lists and names
--     are unchanged; Cube models are untouched.
--
-- Tenancy: xo_* views filter tenant_id = ingestion.current_tenant_id() as
-- before; the union views also carry the binding's tenant per branch, so a
-- tenant can never see another schema's rows even if a table were unstamped.

BEGIN;

-- Fivetran creates the landed tables as its own destination login
-- (fivetran_user). Stamping them and reading them through owner-side views
-- requires the migration owner to hold that role; without it every stamp
-- silently no-ops (0167 swallowed insufficient_privilege) and the union views
-- cannot be created. Operator bootstrap, run once as postgres:
--   GRANT fivetran_user TO albert_migration_owner;
DO $$
BEGIN
  IF NOT pg_has_role('albert_migration_owner', 'fivetran_user', 'MEMBER') THEN
    RAISE EXCEPTION 'run "GRANT fivetran_user TO albert_migration_owner" as postgres before applying 0168';
  END IF;
END $$;

ALTER TABLE ingestion.fivetran_destination_bindings
  ADD COLUMN IF NOT EXISTS retired_at timestamptz;

CREATE SCHEMA IF NOT EXISTS source_xero_fivetran;
GRANT USAGE ON SCHEMA source_xero_fivetran TO transform_rw, diagnostic_ro;

CREATE OR REPLACE FUNCTION ingestion.retire_fivetran_destination(
  p_destination_schema text,
  p_tenant_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_destination_schema IS NULL OR p_destination_schema !~ '^[a-z][a-z0-9_]{0,127}$' THEN
    RAISE EXCEPTION 'fivetran destination schema is invalid' USING ERRCODE = '22023';
  END IF;
  UPDATE ingestion.fivetran_destination_bindings
     SET retired_at = coalesce(retired_at, clock_timestamp())
   WHERE destination_schema = p_destination_schema
     AND tenant_id = p_tenant_id;
END;
$$;

-- Stamp: idempotent and cheap. Tables that already carry a NOT NULL tenant_id
-- with the tenant_scope policy are skipped, so calling this every sync is fine.
CREATE OR REPLACE FUNCTION ingestion.stamp_fivetran_destination(
  p_destination_schema text,
  p_tenant_id text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  binding ingestion.fivetran_destination_bindings%ROWTYPE;
  target record;
  stamped integer := 0;
BEGIN
  IF p_destination_schema IS NULL OR p_destination_schema !~ '^[a-z][a-z0-9_]{0,127}$' THEN
    RAISE EXCEPTION 'fivetran destination schema is invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT ingestion.is_ulid(p_tenant_id) THEN
    RAISE EXCEPTION 'fivetran destination identity is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO binding
    FROM ingestion.fivetran_destination_bindings
   WHERE destination_schema = p_destination_schema
     AND tenant_id = p_tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fivetran destination schema is not registered' USING ERRCODE = 'P0002';
  END IF;

  FOR target IN
    SELECT class.relname AS table_name, class.oid AS relid
      FROM pg_catalog.pg_class AS class
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
     WHERE namespace.nspname = p_destination_schema
       AND class.relkind = 'r'
       AND NOT class.relispartition
       AND NOT (
         EXISTS (
           SELECT 1 FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = class.oid
              AND attribute.attname = 'tenant_id'
              AND attribute.attnotnull
              AND NOT attribute.attisdropped
         )
         AND EXISTS (
           SELECT 1 FROM pg_catalog.pg_policy AS policy
            WHERE policy.polrelid = class.oid AND policy.polname = 'tenant_scope'
         )
       )
  LOOP
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid = target.relid
           AND attribute.attname = 'tenant_id'
           AND NOT attribute.attisdropped
      ) THEN
        EXECUTE format('ALTER TABLE %I.%I ADD COLUMN tenant_id text', p_destination_schema, target.table_name);
      END IF;
      EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN tenant_id SET DEFAULT %L',
                     p_destination_schema, target.table_name, binding.tenant_id);
      EXECUTE format('UPDATE %I.%I SET tenant_id = %L WHERE tenant_id IS NULL',
                     p_destination_schema, target.table_name, binding.tenant_id);
      EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN tenant_id SET NOT NULL',
                     p_destination_schema, target.table_name);
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', p_destination_schema, target.table_name);
      EXECUTE format('DROP POLICY IF EXISTS tenant_scope ON %I.%I', p_destination_schema, target.table_name);
      EXECUTE format(
        'CREATE POLICY tenant_scope ON %I.%I
           USING (tenant_id = (SELECT ingestion.current_tenant_id()))
           WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()))',
        p_destination_schema, target.table_name);
      EXECUTE format('GRANT SELECT ON TABLE %I.%I TO diagnostic_ro, transform_rw',
                     p_destination_schema, target.table_name);
      stamped := stamped + 1;
    EXCEPTION
      WHEN insufficient_privilege OR feature_not_supported OR datatype_mismatch
        OR not_null_violation OR undefined_column OR duplicate_object THEN
        NULL;
    END;
  END LOOP;
  RETURN stamped;
END;
$$;

-- Union views over every active bound schema for a source prefix.
CREATE OR REPLACE FUNCTION ingestion.rebuild_fivetran_source_views(p_prefix text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  target_schema text;
  active record;
  table_name text;
  column_rec record;
  branch_sql text;
  select_list text;
  branches text[];
  leader_schema text;
  rebuilt integer := 0;
  present boolean;
BEGIN
  IF p_prefix IS NULL OR p_prefix !~ '^[a-z][a-z0-9_]{0,31}$' THEN
    RAISE EXCEPTION 'fivetran source prefix is invalid' USING ERRCODE = '22023';
  END IF;
  target_schema := 'source_' || p_prefix || '_fivetran';
  IF to_regnamespace(target_schema) IS NULL THEN
    EXECUTE format('CREATE SCHEMA %I', target_schema);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO transform_rw, diagnostic_ro', target_schema);
  END IF;

  -- Every table name that exists in at least one active schema, newest first.
  FOR table_name IN
    SELECT DISTINCT class.relname
      FROM ingestion.fivetran_destination_bindings AS binding
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.nspname = binding.destination_schema
      JOIN pg_catalog.pg_class AS class ON class.relnamespace = namespace.oid AND class.relkind = 'r'
     WHERE binding.retired_at IS NULL
       AND binding.destination_schema LIKE p_prefix || '\_%'
       AND class.relname LIKE p_prefix || '\_%'
  LOOP
    -- The newest active schema carrying the table defines the column list.
    SELECT binding.destination_schema INTO leader_schema
      FROM ingestion.fivetran_destination_bindings AS binding
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.nspname = binding.destination_schema
      JOIN pg_catalog.pg_class AS class ON class.relnamespace = namespace.oid AND class.relkind = 'r'
     WHERE binding.retired_at IS NULL
       AND binding.destination_schema LIKE p_prefix || '\_%'
       AND class.relname = table_name
     ORDER BY binding.created_at DESC
     LIMIT 1;

    branches := ARRAY[]::text[];
    FOR active IN
      SELECT binding.destination_schema, binding.tenant_id
        FROM ingestion.fivetran_destination_bindings AS binding
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.nspname = binding.destination_schema
        JOIN pg_catalog.pg_class AS class ON class.relnamespace = namespace.oid AND class.relkind = 'r'
       WHERE binding.retired_at IS NULL
         AND binding.destination_schema LIKE p_prefix || '\_%'
         AND class.relname = table_name
       ORDER BY binding.created_at DESC
    LOOP
      select_list := format('%L::text AS tenant_id', active.tenant_id);
      FOR column_rec IN
        SELECT attribute.attname AS name, format_type(attribute.atttypid, attribute.atttypmod) AS type
          FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid = format('%I.%I', leader_schema, table_name)::regclass
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
           AND attribute.attname NOT IN ('tenant_id')
         ORDER BY attribute.attnum
      LOOP
        SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_attribute AS other
           WHERE other.attrelid = format('%I.%I', active.destination_schema, table_name)::regclass
             AND other.attname = column_rec.name
             AND NOT other.attisdropped
        ) INTO present;
        -- Fivetran rewrites destination identifiers to "single underscore
        -- case", inserting an underscore at every letter<->digit boundary
        -- (address_line1 -> address_line_1, box10 -> box_10). Albert's contract
        -- names never carry an underscore before a digit, so undoing exactly
        -- that transition restores the spec column name unambiguously
        -- (tests/contracts/fivetran-xero-sdk.contract.test.ts pins the
        -- invariant).
        IF present THEN
          select_list := select_list || format(', %I::%s AS %I', column_rec.name, column_rec.type,
                                               regexp_replace(column_rec.name, '([a-z])_([0-9])', '\1\2', 'g'));
        ELSE
          select_list := select_list || format(', NULL::%s AS %I', column_rec.type,
                                               regexp_replace(column_rec.name, '([a-z])_([0-9])', '\1\2', 'g'));
        END IF;
      END LOOP;
      -- Envelope aliases the source_xero contract expects.
      IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute AS other
         WHERE other.attrelid = format('%I.%I', active.destination_schema, table_name)::regclass
           AND other.attname = 'source_record_id' AND NOT other.attisdropped
      ) THEN
        select_list := select_list || ', source_record_id::text AS namespaced_source_key';
      ELSE
        select_list := select_list || ', NULL::text AS namespaced_source_key';
      END IF;
      branch_sql := format('SELECT %s FROM %I.%I', select_list, active.destination_schema, table_name);
      branches := branches || branch_sql;
    END LOOP;

    IF array_length(branches, 1) IS NULL THEN
      CONTINUE;
    END IF;
    BEGIN
      EXECUTE format('CREATE OR REPLACE VIEW %I.%I AS %s',
                     target_schema, table_name, array_to_string(branches, ' UNION ALL '));
      EXECUTE format('GRANT SELECT ON %I.%I TO transform_rw, diagnostic_ro', target_schema, table_name);
      rebuilt := rebuilt + 1;
    EXCEPTION
      WHEN feature_not_supported OR invalid_table_definition OR datatype_mismatch OR undefined_column THEN
        -- A column type changed between connector versions: the old view stays
        -- until the older schema retires; nothing downstream breaks.
        NULL;
    END;
  END LOOP;
  RETURN rebuilt;
END;
$$;

REVOKE ALL ON FUNCTION ingestion.retire_fivetran_destination(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ingestion.rebuild_fivetran_source_views(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingestion.retire_fivetran_destination(text, text) TO ingest_rw;
GRANT EXECUTE ON FUNCTION ingestion.rebuild_fivetran_source_views(text) TO ingest_rw;

-- Retire bindings whose connections are already gone (pre-0168 disconnects
-- never wrote retired_at) so only live schemas feed the union. Anything not
-- carrying Albert's staging shape (the earlier Fivetran-standard schemas) is
-- retired outright: it has no xero_* tables to contribute.
UPDATE ingestion.fivetran_destination_bindings AS binding
   SET retired_at = clock_timestamp()
 WHERE retired_at IS NULL
   AND destination_schema LIKE 'xero\_%'
   AND NOT EXISTS (
     SELECT 1
       FROM pg_catalog.pg_namespace AS namespace
       JOIN pg_catalog.pg_class AS class ON class.relnamespace = namespace.oid AND class.relkind = 'r'
      WHERE namespace.nspname = binding.destination_schema
        AND class.relname = 'xero_organisations'
   );

-- Connections disconnected before retire_fivetran_destination existed (their
-- schemas carry Albert's table shapes but no live connection): retire by name.
UPDATE ingestion.fivetran_destination_bindings
   SET retired_at = coalesce(retired_at, clock_timestamp())
 WHERE destination_schema IN (
   'xero_01m077vtzte92qpz2jqmwesq7q',  -- hasty_gumminess, superseded by re-consent
   'xero_01m077kwstf6w25w9ej64n540r'   -- never created on Fivetran (404 on first deploy attempt)
 );

SELECT ingestion.rebuild_fivetran_source_views('xero');

DO $$
BEGIN
  IF to_regclass('source_xero_fivetran.xero_invoices') IS NULL THEN
    RAISE EXCEPTION 'no active Fivetran Xero schema carries xero_invoices yet; connect one before repointing the Cube contract';
  END IF;
END $$;

-- xo_* contract, verbatim from 0164 over source_xero_fivetran ------------------------

DROP VIEW IF EXISTS source_xero_official.xo_invoices;
DROP VIEW IF EXISTS source_xero_official.xo_invoice_line_items;
DROP VIEW IF EXISTS source_xero_official.xo_invoice_payments;
DROP VIEW IF EXISTS source_xero_official.xo_invoice_credit_notes;
DROP VIEW IF EXISTS source_xero_official.xo_repeating_invoices;
DROP VIEW IF EXISTS source_xero_official.xo_repeating_invoice_line_items;
DROP VIEW IF EXISTS source_xero_official.xo_payments;
DROP VIEW IF EXISTS source_xero_official.xo_credit_notes;
DROP VIEW IF EXISTS source_xero_official.xo_credit_note_line_items;
DROP VIEW IF EXISTS source_xero_official.xo_credit_note_allocations;
DROP VIEW IF EXISTS source_xero_official.xo_batch_payments;
DROP VIEW IF EXISTS source_xero_official.xo_batch_payment_members;
DROP VIEW IF EXISTS source_xero_official.xo_overpayments;
DROP VIEW IF EXISTS source_xero_official.xo_overpayment_allocations;
DROP VIEW IF EXISTS source_xero_official.xo_organisation;
DROP VIEW IF EXISTS source_xero_official.xo_accounts;
DROP VIEW IF EXISTS source_xero_official.xo_contacts;
DROP VIEW IF EXISTS source_xero_official.xo_contact_addresses;
DROP VIEW IF EXISTS source_xero_official.xo_contact_phones;
DROP VIEW IF EXISTS source_xero_official.xo_items;
DROP VIEW IF EXISTS source_xero_official.xo_tax_rates;
DROP VIEW IF EXISTS source_xero_official.xo_currencies;
DROP VIEW IF EXISTS source_xero_official.xo_users;
DROP VIEW IF EXISTS source_xero_official.xo_branding_themes;
DROP VIEW IF EXISTS source_xero_official.xo_budgets;
DROP VIEW IF EXISTS source_xero_official.xo_bank_transactions;
DROP VIEW IF EXISTS source_xero_official.xo_bank_transaction_line_items;
DROP VIEW IF EXISTS source_xero_official.xo_bank_transfers;
DROP VIEW IF EXISTS source_xero_official.xo_manual_journals;
DROP VIEW IF EXISTS source_xero_official.xo_manual_journal_lines;
DROP VIEW IF EXISTS source_xero_official.xo_assets;
DROP VIEW IF EXISTS source_xero_official.xo_asset_types;
DROP VIEW IF EXISTS source_xero_official.xo_files;
DROP VIEW IF EXISTS source_xero_official.xo_file_associations;
DROP VIEW IF EXISTS source_xero_official.xo_pnl_lines;
DROP VIEW IF EXISTS source_xero_official.xo_gst_lines;
DROP VIEW IF EXISTS source_xero_official.xo_payroll_employees;
DROP VIEW IF EXISTS source_xero_official.xo_pay_runs;
DROP VIEW IF EXISTS source_xero_official.xo_payslip_summaries;
DROP VIEW IF EXISTS source_xero_official.xo_payroll_timesheets;
DROP VIEW IF EXISTS source_xero_official.xo_timesheet_day_units;
DROP VIEW IF EXISTS source_xero_official.xo_earnings_rates;
DROP VIEW IF EXISTS source_xero_official.xo_deduction_types;
DROP VIEW IF EXISTS source_xero_official.xo_leave_types;
DROP VIEW IF EXISTS source_xero_official.xo_reimbursement_types;
DROP VIEW IF EXISTS source_xero_official.xo_payroll_calendars;
DROP VIEW IF EXISTS source_xero_official.xo_super_funds;
DROP VIEW IF EXISTS source_xero_official.xo_super_memberships;
DROP VIEW IF EXISTS source_xero_official.xo_employee_pay_template_earnings;
DROP VIEW IF EXISTS source_xero_official.xo_payroll_settings_accounts;

-- Organisation -----------------------------------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_organisation
WITH (security_barrier = true) AS
SELECT
  o.tenant_id,
  o.tenant_id || ':' || o.organisation_id AS row_key,
  o.organisation_id          AS organisation_id,
  o.name                     AS organisation_name,
  o.legal_name               AS legal_name,
  o.organisation_type        AS organisation_type,
  o.organisation_entity_type AS entity_type,
  o.line_of_business         AS line_of_business,
  o.base_currency            AS base_currency,
  o.country_code             AS country_code,
  o.timezone                 AS timezone,
  o.registration_number      AS abn,
  o.tax_number               AS tax_number,
  o.pays_tax                 AS pays_tax,
  o.sales_tax_basis          AS gst_basis,
  o.sales_tax_period         AS gst_period,
  o.default_sales_tax        AS default_sales_tax,
  o.default_purchases_tax    AS default_purchases_tax,
  o.financial_year_end_day   AS financial_year_end_day,
  o.financial_year_end_month AS financial_year_end_month,
  o.period_lock_date         AS period_lock_date,
  o.end_of_year_lock_date    AS end_of_year_lock_date,
  o.is_demo_company          AS is_demo_company,
  o.organisation_status      AS organisation_status,
  o.edition                  AS edition,
  o.created_date_utc         AS created_at
FROM "source_xero_fivetran"."xero_organisations" o
WHERE o.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT o.tombstone;

-- Chart of accounts --------------------------------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_accounts
WITH (security_barrier = true) AS
SELECT
  a.tenant_id,
  a.tenant_id || ':' || a.account_id AS row_key,
  a.account_id          AS account_id,
  a.code                AS account_code,
  a.name                AS account_name,
  a.status              AS status,
  a.type                AS account_type,
  a.class               AS account_class,
  a.tax_type            AS tax_type,
  a.description         AS description,
  a.system_account      AS system_account,
  a.bank_account_number IS NOT NULL AS is_bank_account,
  a.bank_account_type   AS bank_account_type,
  a.currency_code       AS currency_code,
  a.reporting_code      AS reporting_code,
  a.reporting_code_name AS reporting_code_name,
  a.enable_payments_to_account AS enable_payments,
  a.show_in_expense_claims     AS show_in_expense_claims,
  a.add_to_watchlist    AS on_watchlist,
  a.updated_date_utc    AS updated_at
FROM "source_xero_fivetran"."xero_accounts" a
WHERE a.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT a.tombstone;

-- Contacts ------------------------------------------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_contacts
WITH (security_barrier = true) AS
SELECT
  c.tenant_id,
  c.tenant_id || ':' || c.contact_id AS row_key,
  c.contact_id       AS contact_id,
  c.name             AS contact_name,
  c.first_name       AS first_name,
  c.last_name        AS last_name,
  c.email_address    AS email,
  c.contact_number   AS contact_number,
  c.contact_status   AS status,
  c.is_customer      AS is_customer,
  c.is_supplier      AS is_supplier,
  c.default_currency AS default_currency,
  bal.accounts_receivable_outstanding AS receivable_outstanding,
  bal.accounts_receivable_overdue     AS receivable_overdue,
  bal.accounts_payable_outstanding    AS payable_outstanding,
  bal.accounts_payable_overdue        AS payable_overdue,
  (c.payment_terms #>> '{Sales,Day}')::bigint AS sales_payment_terms_day,
  c.payment_terms #>> '{Sales,Type}'          AS sales_payment_terms_type,
  (c.payment_terms #>> '{Bills,Day}')::bigint AS bills_payment_terms_day,
  c.payment_terms #>> '{Bills,Type}'          AS bills_payment_terms_type,
  c.updated_date_utc AS updated_at
FROM "source_xero_fivetran"."xero_contacts" c
LEFT JOIN "source_xero_fivetran"."xero_contact_balances" bal
  ON bal.tenant_id = c.tenant_id
 AND bal.contact_id = c.contact_id
 AND NOT bal.tombstone
WHERE c.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT c.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_contact_addresses
WITH (security_barrier = true) AS
SELECT
  a.tenant_id,
  a.tenant_id || ':' || a.namespaced_source_key AS row_key,
  a.contact_id    AS contact_id,
  a.address_type  AS address_type,
  a.address_line1 AS address_line1,
  a.city          AS city,
  a.region        AS region,
  a.postal_code   AS postal_code,
  a.country       AS country,
  a.attention_to  AS attention_to
FROM "source_xero_fivetran"."xero_contact_addresses" a
WHERE a.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT a.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_contact_phones
WITH (security_barrier = true) AS
SELECT
  p.tenant_id,
  p.tenant_id || ':' || p.namespaced_source_key AS row_key,
  p.contact_id         AS contact_id,
  p.phone_type         AS phone_type,
  p.phone_number       AS phone_number,
  p.phone_area_code    AS phone_area_code,
  p.phone_country_code AS phone_country_code
FROM "source_xero_fivetran"."xero_contact_phones" p
WHERE p.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT p.tombstone;

-- Items, tax rates, currencies, users, branding, budgets -----------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_items
WITH (security_barrier = true) AS
SELECT
  i.tenant_id,
  i.tenant_id || ':' || i.item_id AS row_key,
  i.item_id                AS item_id,
  i.code                   AS item_code,
  i.name                   AS item_name,
  i.description            AS description,
  i.purchase_description   AS purchase_description,
  i.is_sold                AS is_sold,
  i.is_purchased           AS is_purchased,
  i.is_tracked_as_inventory AS is_tracked_as_inventory,
  i.sales_details_unit_price      AS sales_unit_price,
  i.sales_details_account_code    AS sales_account_code,
  i.sales_details_tax_type        AS sales_tax_type,
  i.purchase_details_unit_price   AS purchase_unit_price,
  i.purchase_details_account_code AS purchase_account_code,
  i.purchase_details_tax_type     AS purchase_tax_type,
  i.updated_date_utc       AS updated_at
FROM "source_xero_fivetran"."xero_items" i
WHERE i.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT i.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_tax_rates
WITH (security_barrier = true) AS
SELECT
  t.tenant_id,
  t.tenant_id || ':' || t.tax_type AS row_key,
  t.tax_type         AS tax_type,
  t.name             AS tax_name,
  t.report_tax_type  AS report_tax_type,
  t.status           AS status,
  t.display_tax_rate AS display_tax_rate,
  t.effective_rate   AS effective_rate,
  t.can_apply_to_assets      AS can_apply_to_assets,
  t.can_apply_to_equity      AS can_apply_to_equity,
  t.can_apply_to_expenses    AS can_apply_to_expenses,
  t.can_apply_to_liabilities AS can_apply_to_liabilities,
  t.can_apply_to_revenue     AS can_apply_to_revenue
FROM "source_xero_fivetran"."xero_tax_rates" t
WHERE t.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT t.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_currencies
WITH (security_barrier = true) AS
SELECT
  c.tenant_id,
  c.tenant_id || ':' || c.code AS row_key,
  c.code        AS currency_code,
  c.description AS description
FROM "source_xero_fivetran"."xero_currencies" c
WHERE c.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT c.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_users
WITH (security_barrier = true) AS
SELECT
  u.tenant_id,
  u.tenant_id || ':' || u.user_id AS row_key,
  u.user_id           AS user_id,
  u.first_name        AS first_name,
  u.last_name         AS last_name,
  u.email_address     AS email,
  u.organisation_role AS organisation_role,
  u.is_subscriber     AS is_subscriber,
  u.updated_date_utc  AS updated_at
FROM "source_xero_fivetran"."xero_users" u
WHERE u.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT u.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_branding_themes
WITH (security_barrier = true) AS
SELECT
  t.tenant_id,
  t.tenant_id || ':' || t.branding_theme_id AS row_key,
  t.branding_theme_id AS branding_theme_id,
  t.name              AS theme_name,
  t.type              AS theme_type,
  t.sort_order        AS sort_order,
  t.created_date_utc  AS created_at
FROM "source_xero_fivetran"."xero_branding_themes" t
WHERE t.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT t.tombstone;

-- MAPPING GAP: xo_budgets.status: neither source_xero_fivetran.xero_budgets nor the Xero
-- Budgets API (per connectors/xero/tables.json) carries a Status field; the old
-- dlt column existed but the typed staging has no equivalent.
CREATE OR REPLACE VIEW source_xero_official.xo_budgets
WITH (security_barrier = true) AS
SELECT
  g.tenant_id,
  g.tenant_id || ':' || g.budget_id AS row_key,
  g.budget_id        AS budget_id,
  g.type             AS budget_type,
  g.description      AS description,
  NULL::text         AS status,
  g.updated_date_utc AS updated_at
FROM "source_xero_fivetran"."xero_budgets" g
WHERE g.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT g.tombstone;

-- Invoices (sales invoices ACCREC and bills ACCPAY) --------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_invoices
WITH (security_barrier = true) AS
SELECT
  i.tenant_id,
  i.tenant_id || ':' || i."invoice_id" AS row_key,
  i."invoice_id"     AS invoice_id,
  i."invoice_number" AS invoice_number,
  i."type"           AS invoice_type,
  CASE i."type" WHEN 'ACCREC' THEN 'Sales invoice' WHEN 'ACCPAY' THEN 'Bill' ELSE i."type" END AS document_kind,
  i."reference"      AS reference,
  i."status"         AS status,
  i."line_amount_types" AS line_amount_types,
  i."contact_contact_id" AS contact_id,
  i."contact_name"   AS contact_name,
  i."date"           AS issued_on,
  i."due_date"       AS due_on,
  i."fully_paid_on_date" AS fully_paid_on,
  i."sub_total"      AS subtotal,
  i."total_tax"      AS total_tax,
  i."total"          AS total,
  i."amount_due"     AS amount_due,
  i."amount_paid"    AS amount_paid,
  i."amount_credited" AS amount_credited,
  i."currency_code"  AS currency_code,
  i."currency_rate"  AS currency_rate,
  i."is_discounted"  AS is_discounted,
  i."sent_to_contact" AS sent_to_contact,
  i."repeating_invoice_id" AS repeating_invoice_id,
  i."branding_theme_id" AS branding_theme_id,
  i."has_attachments" AS has_attachments,
  i."updated_date_utc" AS updated_at
FROM "source_xero_fivetran"."xero_invoices" i
WHERE i.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT i.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_invoice_line_items
WITH (security_barrier = true) AS
SELECT
  l.tenant_id,
  l.tenant_id || ':' || l."line_items_line_item_id" AS row_key,
  l."line_items_line_item_id" AS line_item_id,
  i."invoice_id"  AS invoice_id,
  i."type"        AS invoice_type,
  i."status"      AS invoice_status,
  i."date"        AS issued_on,
  i."contact_contact_id" AS contact_id,
  i."contact_name" AS contact_name,
  l."line_items_description" AS description,
  l."line_items_quantity"    AS quantity,
  l."line_items_unit_amount" AS unit_amount,
  l."line_items_line_amount" AS line_amount,
  l."line_items_tax_amount"  AS tax_amount,
  l."line_items_tax_type"    AS tax_type,
  l."line_items_account_code" AS account_code,
  l."line_items_account_id"  AS account_id,
  l."line_items_item_code"   AS item_code,
  l."line_items_item_item_id" AS item_id,
  l."line_items_item"->>'Name' AS item_name
FROM "source_xero_fivetran"."xero_invoice_line_items" l
JOIN "source_xero_fivetran"."xero_invoices" i
  ON i.tenant_id = l.tenant_id
 AND i."invoice_id" = l."invoice_id"
 AND NOT i.tombstone
WHERE l.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT l.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_invoice_payments
WITH (security_barrier = true) AS
SELECT
  p.tenant_id,
  p.tenant_id || ':' || p."payment_id" AS row_key,
  p."payment_id"  AS payment_id,
  i."invoice_id"  AS invoice_id,
  i."type"        AS invoice_type,
  p."date"        AS paid_on,
  p."amount"      AS amount,
  p."reference"   AS reference,
  p."currency_rate" AS currency_rate,
  p."batch_payment_id" AS batch_payment_id
FROM "source_xero_fivetran"."xero_payments" p
JOIN "source_xero_fivetran"."xero_invoices" i
  ON i.tenant_id = p.tenant_id
 AND i."invoice_id" = p."invoice_invoice_id"
 AND NOT i.tombstone
WHERE p.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT p.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_invoice_credit_notes
WITH (security_barrier = true) AS
SELECT
  a.tenant_id,
  a.tenant_id || ':' || a."credit_note_id" || ':' || a."allocations" AS row_key,
  a."credit_note_id" AS credit_note_id,
  cn."credit_note_number" AS credit_note_number,
  a."allocations_invoice_invoice_id" AS invoice_id,
  a."allocations_date" AS applied_on,
  a."allocations_amount" AS applied_amount,
  cn."total"         AS credit_note_total
FROM "source_xero_fivetran"."xero_credit_note_allocations" a
JOIN "source_xero_fivetran"."xero_credit_notes" cn
  ON cn.tenant_id = a.tenant_id
 AND cn."credit_note_id" = a."credit_note_id"
 AND NOT cn.tombstone
WHERE a.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT a.tombstone;

-- Repeating invoices ---------------------------------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_repeating_invoices
WITH (security_barrier = true) AS
SELECT
  r.tenant_id,
  r.tenant_id || ':' || r."repeating_invoice_id" AS row_key,
  r."repeating_invoice_id" AS repeating_invoice_id,
  r."type"           AS invoice_type,
  r."status"         AS status,
  r."reference"      AS reference,
  r."contact_contact_id" AS contact_id,
  r."contact_name"   AS contact_name,
  r."sub_total"      AS subtotal,
  r."total_tax"      AS total_tax,
  r."total"          AS total,
  r."currency_code"  AS currency_code,
  r."schedule_period" AS schedule_period,
  r."schedule_unit"   AS schedule_unit,
  r."schedule_due_date" AS schedule_due_day,
  r."schedule_due_date_type" AS schedule_due_date_type,
  r."schedule_start_date" AS schedule_starts_on,
  r."schedule_end_date"   AS schedule_ends_on,
  r."schedule_next_scheduled_date" AS next_scheduled_on,
  r."approved_for_sending" AS approved_for_sending
FROM "source_xero_fivetran"."xero_repeating_invoices" r
WHERE r.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT r.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_repeating_invoice_line_items
WITH (security_barrier = true) AS
SELECT
  l.tenant_id,
  l.tenant_id || ':' || l."line_items_line_item_id" AS row_key,
  l."line_items_line_item_id" AS line_item_id,
  r."repeating_invoice_id" AS repeating_invoice_id,
  r."type"        AS invoice_type,
  r."contact_name" AS contact_name,
  l."line_items_description" AS description,
  l."line_items_quantity"    AS quantity,
  l."line_items_unit_amount" AS unit_amount,
  l."line_items_line_amount" AS line_amount,
  l."line_items_tax_amount"  AS tax_amount,
  l."line_items_tax_type"    AS tax_type,
  l."line_items_account_code" AS account_code,
  l."line_items_item_code"   AS item_code
FROM "source_xero_fivetran"."xero_repeating_invoice_line_items" l
JOIN "source_xero_fivetran"."xero_repeating_invoices" r
  ON r.tenant_id = l.tenant_id
 AND r."repeating_invoice_id" = l."repeating_invoice_id"
 AND NOT r.tombstone
WHERE l.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT l.tombstone;

-- Payments --------------------------------------------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_payments
WITH (security_barrier = true) AS
SELECT
  p.tenant_id,
  p.tenant_id || ':' || p."payment_id" AS row_key,
  p."payment_id"    AS payment_id,
  p."date"          AS paid_on,
  p."amount"        AS amount,
  p."bank_amount"   AS bank_amount,
  p."currency_rate" AS currency_rate,
  p."payment_type"  AS payment_type,
  p."status"        AS status,
  p."is_reconciled" AS is_reconciled,
  p."reference"     AS reference,
  p."invoice_invoice_id" AS invoice_id,
  p."invoice_number"     AS invoice_number,
  p."invoice" ->> 'Type' AS invoice_type,
  p."invoice" -> 'Contact' ->> 'ContactID' AS contact_id,
  p."invoice" -> 'Contact' ->> 'Name'      AS contact_name,
  p."account_account_id" AS account_id,
  p."code"               AS account_code,
  p."batch_payment_id"   AS batch_payment_id,
  p."updated_date_utc"   AS updated_at
FROM "source_xero_fivetran"."xero_payments" p
WHERE p.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT p.tombstone;

-- Credit notes ------------------------------------------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_credit_notes
WITH (security_barrier = true) AS
SELECT
  cn.tenant_id,
  cn.tenant_id || ':' || cn."credit_note_id" AS row_key,
  cn."credit_note_id"     AS credit_note_id,
  cn."credit_note_number" AS credit_note_number,
  cn."type"               AS credit_note_type,
  CASE cn."type" WHEN 'ACCRECCREDIT' THEN 'Customer credit note' WHEN 'ACCPAYCREDIT' THEN 'Supplier credit note' ELSE cn."type" END AS document_kind,
  cn."status"             AS status,
  cn."reference"          AS reference,
  cn."contact_contact_id" AS contact_id,
  cn."contact_name"       AS contact_name,
  cn."date"               AS issued_on,
  cn."fully_paid_on_date" AS fully_paid_on,
  cn."sub_total"          AS subtotal,
  cn."total_tax"          AS total_tax,
  cn."total"              AS total,
  cn."remaining_credit"   AS remaining_credit,
  cn."currency_code"      AS currency_code,
  cn."currency_rate"      AS currency_rate,
  cn."updated_date_utc"   AS updated_at
FROM "source_xero_fivetran"."xero_credit_notes" cn
WHERE cn.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT cn.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_credit_note_line_items
WITH (security_barrier = true) AS
SELECT
  l.tenant_id,
  l.tenant_id || ':' || l.namespaced_source_key AS row_key,
  l."line_items_line_item_id" AS line_item_id,
  l."credit_note_id"  AS credit_note_id,
  cn."type"           AS credit_note_type,
  cn."date"           AS issued_on,
  cn."contact_name"   AS contact_name,
  l."line_items_description"  AS description,
  l."line_items_quantity"     AS quantity,
  l."line_items_unit_amount"  AS unit_amount,
  l."line_items_line_amount"  AS line_amount,
  l."line_items_tax_amount"   AS tax_amount,
  l."line_items_tax_type"     AS tax_type,
  l."line_items_account_code" AS account_code,
  l."line_items_account_id"   AS account_id
FROM "source_xero_fivetran"."xero_credit_note_line_items" l
JOIN "source_xero_fivetran"."xero_credit_notes" cn
  ON cn.tenant_id = l.tenant_id
 AND cn."credit_note_id" = l."credit_note_id"
 AND NOT cn.tombstone
WHERE l.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT l.tombstone;

-- MAPPING GAP: xo_credit_note_allocations.allocation_id: the typed table xero_credit_note_allocations
-- carries no allocation identifier (the pinned spec exposes none for credit note allocations; the row
-- key is parent id + array ordinal), and no jsonb column on the child holds it.
CREATE OR REPLACE VIEW source_xero_official.xo_credit_note_allocations
WITH (security_barrier = true) AS
SELECT
  a.tenant_id,
  a.tenant_id || ':' || a.namespaced_source_key AS row_key,
  NULL::text          AS allocation_id,
  a."credit_note_id"  AS credit_note_id,
  a."allocations_invoice_invoice_id" AS invoice_id,
  i."invoice_number"  AS invoice_number,
  a."allocations_date"   AS allocated_on,
  a."allocations_amount" AS amount
FROM "source_xero_fivetran"."xero_credit_note_allocations" a
LEFT JOIN "source_xero_fivetran"."xero_invoices" i
  ON i.tenant_id = a.tenant_id
 AND i."invoice_id" = a."allocations_invoice_invoice_id"
 AND NOT i.tombstone
WHERE a.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT a.tombstone;

-- Batch payments ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_batch_payments
WITH (security_barrier = true) AS
SELECT
  p.tenant_id,
  p.tenant_id || ':' || p."batch_payment_id" AS row_key,
  p."batch_payment_id" AS batch_payment_id,
  p."date"             AS paid_on,
  p."type"             AS batch_type,
  p."status"           AS status,
  p."total_amount"     AS total_amount,
  p."is_reconciled"    AS is_reconciled,
  p."details"          AS details,
  p."account_account_id" AS account_id,
  p."updated_date_utc" AS updated_at
FROM "source_xero_fivetran"."xero_batch_payments" p
WHERE p.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT p.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_batch_payment_members
WITH (security_barrier = true) AS
SELECT
  m.tenant_id,
  m.tenant_id || ':' || m.namespaced_source_key AS row_key,
  m."payment_id"        AS payment_id,
  p."batch_payment_id"  AS batch_payment_id,
  p."date"              AS paid_on,
  m."amount"            AS amount,
  m."bank_amount"       AS bank_amount,
  m."details"           AS details,
  m."invoice_invoice_id" AS invoice_id
FROM "source_xero_fivetran"."xero_payments" m
JOIN "source_xero_fivetran"."xero_batch_payments" p
  ON p.tenant_id = m.tenant_id
 AND p."batch_payment_id" = m."batch_payment_id"
 AND NOT p.tombstone
WHERE m.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT m.tombstone;

-- Overpayments --------------------------------------------------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_overpayments
WITH (security_barrier = true) AS
SELECT
  o.tenant_id,
  o.tenant_id || ':' || o."overpayment_id" AS row_key,
  o."overpayment_id" AS overpayment_id,
  o."type"           AS overpayment_type,
  o."status"         AS status,
  o."contact_contact_id" AS contact_id,
  c."name"           AS contact_name,
  o."date"           AS occurred_on,
  o."sub_total"      AS subtotal,
  o."total_tax"      AS total_tax,
  o."total"          AS total,
  o."remaining_credit" AS remaining_credit,
  o."currency_code"  AS currency_code,
  o."updated_date_utc" AS updated_at
FROM "source_xero_fivetran"."xero_overpayments" o
LEFT JOIN "source_xero_fivetran"."xero_contacts" c
  ON c.tenant_id = o.tenant_id
 AND c."contact_id" = o."contact_contact_id"
 AND NOT c.tombstone
WHERE o.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT o.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_overpayment_allocations
WITH (security_barrier = true) AS
SELECT
  a.tenant_id,
  a.tenant_id || ':' || a.namespaced_source_key AS row_key,
  a."allocation_id" AS allocation_id,
  a."overpayment_overpayment_id" AS overpayment_id,
  a."invoice_invoice_id" AS invoice_id,
  i."invoice_number" AS invoice_number,
  a."date"           AS allocated_on,
  a."amount"         AS amount
FROM "source_xero_fivetran"."xero_overpayment_allocations" a
LEFT JOIN "source_xero_fivetran"."xero_invoices" i
  ON i.tenant_id = a.tenant_id
 AND i."invoice_id" = a."invoice_invoice_id"
 AND NOT i.tombstone
WHERE a.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT a.tombstone;

-- Bank transactions ---------------------------------------------------------------------

-- MAPPING GAP: xo_bank_transactions.batch_payment_id: source_xero_fivetran.xero_bank_transactions has no
-- batch payment column (checked scalar and jsonb columns, and tables.json defines no
-- BatchPayment field for this table), so the column is emitted as NULL::text.
CREATE OR REPLACE VIEW source_xero_official.xo_bank_transactions
WITH (security_barrier = true) AS
SELECT
  t.tenant_id,
  t.tenant_id || ':' || t.bank_transaction_id AS row_key,
  t.bank_transaction_id,
  t.type            AS transaction_type,
  CASE
    WHEN t.type LIKE 'RECEIVE%' THEN 'Money in'
    WHEN t.type LIKE 'SPEND%' THEN 'Money out'
    ELSE t.type
  END AS money_direction,
  t.status,
  t.is_reconciled,
  t.reference,
  t.contact_contact_id      AS contact_id,
  t.contact_name,
  t.bank_account_account_id AS bank_account_id,
  t.bank_account_code,
  t.bank_account_name,
  t.date            AS occurred_on,
  t.sub_total       AS subtotal,
  t.total_tax,
  t.total,
  t.currency_code,
  t.line_amount_types,
  NULL::text        AS batch_payment_id,
  t.overpayment_id,
  t.updated_date_utc AS updated_at
FROM "source_xero_fivetran"."xero_bank_transactions" t
WHERE t.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT t.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_bank_transaction_line_items
WITH (security_barrier = true) AS
SELECT
  l.tenant_id,
  l.tenant_id || ':' || l.namespaced_source_key AS row_key,
  l.line_item_id,
  l.bank_transaction_id,
  t.type            AS transaction_type,
  t.date            AS occurred_on,
  t.contact_name,
  t.bank_account_name,
  l.description,
  l.quantity,
  l.unit_amount,
  l.line_amount,
  l.tax_amount,
  l.tax_type,
  l.account_code,
  l.account_id
FROM "source_xero_fivetran"."xero_bank_transaction_line_items" l
JOIN "source_xero_fivetran"."xero_bank_transactions" t
  ON t.tenant_id = l.tenant_id
 AND t.bank_transaction_id = l.bank_transaction_id
 AND NOT t.tombstone
WHERE l.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT l.tombstone;

-- Bank transfers -------------------------------------------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_bank_transfers
WITH (security_barrier = true) AS
SELECT
  t.tenant_id,
  t.tenant_id || ':' || t.bank_transfer_id AS row_key,
  t.bank_transfer_id,
  t.date            AS transferred_on,
  t.amount,
  t.currency_rate,
  t.reference,
  t.status,
  t.from_bank_account_account_id AS from_account_id,
  t.from_bank_account_name       AS from_account_name,
  t.to_bank_account_account_id   AS to_account_id,
  t.to_bank_account_name         AS to_account_name,
  t.from_is_reconciled,
  t.to_is_reconciled,
  t.created_date_utc AS created_at
FROM "source_xero_fivetran"."xero_bank_transfers" t
WHERE t.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT t.tombstone;

-- Manual journals ------------------------------------------------------------------------------

-- NOTE: source_xero_fivetran.xero_manual_journals carries no typed DebitTotal/CreditTotal columns; the
-- totals are derived from the verbatim journal_lines jsonb (sum of positive / negative
-- LineAmount over non-blank lines, matching Xero's total semantics). When the payload omits
-- the lines array the totals degrade to NULL rather than a misleading 0.
CREATE OR REPLACE VIEW source_xero_official.xo_manual_journals
WITH (security_barrier = true) AS
SELECT
  j.tenant_id,
  j.tenant_id || ':' || j.manual_journal_id AS row_key,
  j.manual_journal_id,
  j.narration,
  j.status,
  j.date            AS journal_on,
  totals.debit_total,
  totals.credit_total,
  j.line_amount_types,
  j.show_on_cash_basis_reports,
  j.updated_date_utc AS updated_at
FROM "source_xero_fivetran"."xero_manual_journals" j
LEFT JOIN LATERAL (
  SELECT
    sum(CASE WHEN (line->>'LineAmount')::numeric >= 0 THEN (line->>'LineAmount')::numeric ELSE 0 END) AS debit_total,
    sum(CASE WHEN (line->>'LineAmount')::numeric < 0 THEN -(line->>'LineAmount')::numeric ELSE 0 END) AS credit_total
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j.journal_lines) = 'array' THEN j.journal_lines ELSE '[]'::jsonb END) AS line
  WHERE NOT COALESCE((line->>'IsBlank')::boolean, false)
) totals ON true
WHERE j.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT j.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_manual_journal_lines
WITH (security_barrier = true) AS
SELECT
  l.tenant_id,
  l.tenant_id || ':' || l.namespaced_source_key AS row_key,
  l.manual_journal_id,
  j.narration,
  j.status          AS journal_status,
  j.date            AS journal_on,
  l.description,
  l.line_amount,
  l.tax_amount,
  l.tax_type,
  l.account_code,
  l.account_id,
  CASE WHEN l.line_amount >= 0 THEN l.line_amount ELSE 0 END AS debit_amount,
  CASE WHEN l.line_amount < 0 THEN -l.line_amount ELSE 0 END AS credit_amount
FROM "source_xero_fivetran"."xero_manual_journal_lines" l
JOIN "source_xero_fivetran"."xero_manual_journals" j
  ON j.tenant_id = l.tenant_id
 AND j.manual_journal_id = l.manual_journal_id
 AND NOT j.tombstone
WHERE l.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT l.tombstone
  AND NOT COALESCE(l.is_blank, false);

-- Fixed assets ------------------------------------------------------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_assets
WITH (security_barrier = true) AS
SELECT
  a.tenant_id,
  a.tenant_id || ':' || a.asset_id AS row_key,
  a.asset_id,
  a.asset_name,
  a.asset_number,
  a.asset_status    AS status,
  a.purchase_date   AS purchased_on,
  a.purchase_price,
  a.disposal_price,
  a.accounting_book_value AS book_value,
  a.asset_type_id,
  a.book_depreciation_setting_depreciation_method             AS depreciation_method,
  a.book_depreciation_setting_depreciation_calculation_method AS depreciation_calculation_method,
  a.book_depreciation_detail_depreciation_start_date          AS depreciation_started_on,
  a.book_depreciation_detail_prior_accum_depreciation_amount   AS prior_accumulated_depreciation,
  a.book_depreciation_detail_current_accum_depreciation_amount AS current_accumulated_depreciation,
  a.book_depreciation_detail_current_gain_loss                AS current_gain_loss
FROM "source_xero_fivetran"."xero_assets" a
WHERE a.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT a.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_asset_types
WITH (security_barrier = true) AS
SELECT
  t.tenant_id,
  t.tenant_id || ':' || t.asset_type_id AS row_key,
  t.asset_type_id,
  t.asset_type_name,
  t.fixed_asset_account_id,
  t.depreciation_expense_account_id,
  t.accumulated_depreciation_account_id,
  t.book_depreciation_setting_depreciation_method AS depreciation_method,
  t.book_depreciation_setting_depreciation_rate   AS depreciation_rate
FROM "source_xero_fivetran"."xero_asset_types" t
WHERE t.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT t.tombstone;

-- Files ----------------------------------------------------------------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_files
WITH (security_barrier = true) AS
SELECT
  f.tenant_id,
  f.tenant_id || ':' || f.id AS row_key,
  f.id              AS file_id,
  f.name            AS file_name,
  f.mime_type,
  f.size            AS size_bytes,
  f.folder_id,
  f.user_name       AS uploaded_by,
  f.created_date_utc AS created_at,
  f.updated_date_utc AS updated_at
FROM "source_xero_fivetran"."xero_files" f
WHERE f.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT f.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_file_associations
WITH (security_barrier = true) AS
SELECT
  a.tenant_id,
  a.tenant_id || ':' || a.namespaced_source_key AS row_key,
  a.file_id,
  a.object_id,
  a.object_type,
  a.object_group
FROM "source_xero_fivetran"."xero_file_associations" a
WHERE a.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT a.tombstone;

-- AU payroll --------------------------------------------------------------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_payroll_employees
WITH (security_barrier = true) AS
SELECT
  e.tenant_id,
  e.tenant_id || ':' || e.employee_id AS row_key,
  e.employee_id    AS employee_id,
  e.first_name     AS first_name,
  e.last_name      AS last_name,
  e.first_name || ' ' || e.last_name AS full_name,
  e.status         AS status,
  e.email          AS email,
  e.date_of_birth  AS date_of_birth,
  e.gender         AS gender,
  e.job_title      AS job_title,
  e.classification AS classification,
  e.employment_type AS employment_type,
  e.income_type    AS income_type,
  e.start_date     AS started_on,
  e.ordinary_earnings_rate_id AS ordinary_earnings_rate_id,
  e.payroll_calendar_id AS payroll_calendar_id,
  e.is_authorised_to_approve_leave AS approves_leave,
  e.is_authorised_to_approve_timesheets AS approves_timesheets,
  -- Tax declaration flags (the Tax File Number itself is deliberately excluded).
  td.employment_basis AS employment_basis,
  td.australian_resident_for_tax_purposes AS australian_tax_resident,
  td.tax_free_threshold_claimed AS tax_free_threshold_claimed,
  td.has_loan_or_student_debt AS has_loan_or_student_debt,
  ha.city          AS home_city,
  ha.region        AS home_region,
  ha.postal_code   AS home_postal_code,
  e.updated_date_utc AS updated_at
FROM "source_xero_fivetran"."xero_payroll_au_employees" e
LEFT JOIN "source_xero_fivetran"."xero_payroll_au_employee_tax_declarations" td
  ON td.tenant_id = e.tenant_id
 AND td.employee_id = e.employee_id
 AND NOT td.tombstone
LEFT JOIN "source_xero_fivetran"."xero_payroll_au_employee_home_addresses" ha
  ON ha.tenant_id = e.tenant_id
 AND ha.employee_id = e.employee_id
 AND NOT ha.tombstone
WHERE e.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT e.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_pay_runs
WITH (security_barrier = true) AS
SELECT
  p.tenant_id,
  p.tenant_id || ':' || p.pay_run_id AS row_key,
  p.pay_run_id     AS pay_run_id,
  p.payroll_calendar_id AS payroll_calendar_id,
  p.pay_run_period_start_date AS period_started_on,
  p.pay_run_period_end_date   AS period_ended_on,
  p.payment_date              AS paid_on,
  p.wages          AS wages,
  p.deductions     AS deductions,
  p.tax            AS tax,
  p.super          AS super,
  p.reimbursement  AS reimbursements,
  p.net_pay        AS net_pay,
  p.pay_run_status AS status,
  p.updated_date_utc AS updated_at
FROM "source_xero_fivetran"."xero_payroll_au_pay_runs" p
WHERE p.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT p.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_payslip_summaries
WITH (security_barrier = true) AS
SELECT
  s.tenant_id,
  s.tenant_id || ':' || s.payslip_id AS row_key,
  s.payslip_id    AS payslip_id,
  s.employee_id   AS employee_id,
  s.first_name || ' ' || s.last_name AS employee_name,
  r.pay_run_id    AS pay_run_id,
  r.pay_run_period_start_date AS period_started_on,
  r.pay_run_period_end_date   AS period_ended_on,
  r.payment_date              AS paid_on,
  r.pay_run_status AS pay_run_status,
  s.wages          AS wages,
  s.deductions     AS deductions,
  s.tax            AS tax,
  s.super          AS super,
  s.reimbursements AS reimbursements,
  s.net_pay        AS net_pay
FROM "source_xero_fivetran"."xero_payroll_au_payslips" s
JOIN "source_xero_fivetran"."xero_payroll_au_pay_runs" r
  ON r.tenant_id = s.tenant_id
 AND r.pay_run_id = s.pay_run_id
 AND NOT r.tombstone
WHERE s.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT s.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_payroll_timesheets
WITH (security_barrier = true) AS
SELECT
  t.tenant_id,
  t.tenant_id || ':' || t.timesheet_id AS row_key,
  t.timesheet_id  AS timesheet_id,
  t.employee_id   AS employee_id,
  t.start_date    AS period_started_on,
  t.end_date      AS period_ended_on,
  t.status        AS status,
  t.hours         AS total_hours,
  t.updated_date_utc AS updated_at
FROM "source_xero_fivetran"."xero_payroll_au_timesheets" t
WHERE t.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT t.tombstone;

-- One row per timesheet line per day: the NumberOfUnits jsonb array is indexed
-- by day offset from the timesheet period start (element 0 = start day).
CREATE OR REPLACE VIEW source_xero_official.xo_timesheet_day_units
WITH (security_barrier = true) AS
SELECT
  l.tenant_id,
  l.tenant_id || ':' || l.timesheet_id || ':' || l.timesheet_lines::int || ':' || (u.idx - 1) AS row_key,
  l.timesheet_id  AS timesheet_id,
  t.employee_id   AS employee_id,
  l.earnings_rate_id AS earnings_rate_id,
  (t.start_date + (u.idx - 1)::int)::date AS worked_on,
  (u.value #>> '{}')::numeric AS hours
FROM "source_xero_fivetran"."xero_payroll_au_timesheet_lines" l
CROSS JOIN LATERAL jsonb_array_elements(l.number_of_units) WITH ORDINALITY AS u(value, idx)
JOIN "source_xero_fivetran"."xero_payroll_au_timesheets" t
  ON t.tenant_id = l.tenant_id
 AND t.timesheet_id = l.timesheet_id
 AND NOT t.tombstone
WHERE l.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT l.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_earnings_rates
WITH (security_barrier = true) AS
SELECT
  e.tenant_id,
  e.tenant_id || ':' || e.earnings_rate_id AS row_key,
  e.earnings_rate_id AS earnings_rate_id,
  e.name            AS rate_name,
  e.earnings_type   AS earnings_type,
  e.rate_type       AS rate_type,
  e.rate_per_unit   AS rate_per_unit,
  e.type_of_units   AS type_of_units,
  e.account_code    AS account_code,
  e.is_exempt_from_tax   AS is_exempt_from_tax,
  e.is_exempt_from_super AS is_exempt_from_super,
  e.allowance_type  AS allowance_type,
  e.current_record  AS is_current
FROM "source_xero_fivetran"."xero_payroll_au_earnings_rates" e
WHERE e.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT e.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_deduction_types
WITH (security_barrier = true) AS
SELECT
  d.tenant_id,
  d.tenant_id || ':' || d.deduction_type_id AS row_key,
  d.deduction_type_id AS deduction_type_id,
  d.name              AS deduction_name,
  d.deduction_category AS category,
  d.account_code      AS account_code,
  d.reduces_tax       AS reduces_tax,
  d.reduces_super     AS reduces_super,
  d.current_record    AS is_current
FROM "source_xero_fivetran"."xero_payroll_au_deduction_types" d
WHERE d.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT d.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_leave_types
WITH (security_barrier = true) AS
SELECT
  l.tenant_id,
  l.tenant_id || ':' || l.leave_type_id AS row_key,
  l.leave_type_id   AS leave_type_id,
  l.name            AS leave_name,
  l.type_of_units   AS type_of_units,
  l.normal_entitlement AS normal_entitlement,
  l.is_paid_leave   AS is_paid_leave,
  l.show_on_payslip AS show_on_payslip,
  l.leave_category_code AS leave_category_code,
  l.current_record  AS is_current
FROM "source_xero_fivetran"."xero_payroll_au_leave_types" l
WHERE l.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT l.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_reimbursement_types
WITH (security_barrier = true) AS
SELECT
  r.tenant_id,
  r.tenant_id || ':' || r.reimbursement_type_id AS row_key,
  r.reimbursement_type_id AS reimbursement_type_id,
  r.name           AS reimbursement_name,
  r.account_code   AS account_code,
  r.current_record AS is_current
FROM "source_xero_fivetran"."xero_payroll_au_reimbursement_types" r
WHERE r.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT r.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_payroll_calendars
WITH (security_barrier = true) AS
SELECT
  c.tenant_id,
  c.tenant_id || ':' || c.payroll_calendar_id AS row_key,
  c.payroll_calendar_id AS payroll_calendar_id,
  c.name          AS calendar_name,
  c.calendar_type AS calendar_type,
  c.start_date    AS starts_on,
  c.payment_date  AS payment_date
FROM "source_xero_fivetran"."xero_payroll_au_payroll_calendars" c
WHERE c.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT c.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_super_funds
WITH (security_barrier = true) AS
SELECT
  f.tenant_id,
  f.tenant_id || ':' || f.super_fund_id AS row_key,
  f.super_fund_id AS super_fund_id,
  f.name          AS fund_name,
  f.type          AS fund_type,
  f.usi           AS usi,
  f.updated_date_utc AS updated_at
FROM "source_xero_fivetran"."xero_payroll_au_super_funds" f
WHERE f.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT f.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_super_memberships
WITH (security_barrier = true) AS
SELECT
  m.tenant_id,
  m.tenant_id || ':' || m.super_membership_id AS row_key,
  m.super_membership_id AS super_membership_id,
  m.employee_id    AS employee_id,
  m.super_fund_id  AS super_fund_id,
  m.employee_number AS employee_number
FROM "source_xero_fivetran"."xero_payroll_au_employee_super_memberships" m
WHERE m.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT m.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_employee_pay_template_earnings
WITH (security_barrier = true) AS
SELECT
  l.tenant_id,
  l.tenant_id || ':' || l.employee_id || ':' || l.line_index::int AS row_key,
  l.employee_id    AS employee_id,
  l.earnings_rate_id AS earnings_rate_id,
  l.calculation_type AS calculation_type,
  l.annual_salary  AS annual_salary,
  l.rate_per_unit  AS rate_per_unit,
  l.normal_number_of_units AS normal_number_of_units,
  l.number_of_units_per_week AS units_per_week
FROM "source_xero_fivetran"."xero_payroll_au_pay_template_earnings_lines" l
WHERE l.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT l.tombstone;

CREATE OR REPLACE VIEW source_xero_official.xo_payroll_settings_accounts
WITH (security_barrier = true) AS
SELECT
  a.tenant_id,
  a.tenant_id || ':' || a.account_id AS row_key,
  a.account_id AS account_id,
  a.type       AS account_purpose,
  a.code       AS account_code,
  a.name       AS account_name
FROM "source_xero_fivetran"."xero_payroll_au_settings_accounts" a
WHERE a.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT a.tombstone;

-- xo_pnl_lines: derived P&L lines for Xero, rewritten to read the typed
-- connector staging tables in source_xero (was dlt-loaded XER_OFFICIAL).
-- Same output contract: signed ledger movement (debit positive) over
-- REVENUE/EXPENSE-class accounts from invoice, bank-transaction, posted
-- manual-journal and credit-note lines.

CREATE OR REPLACE VIEW source_xero_official.xo_pnl_lines
WITH (security_barrier = true) AS
WITH pnl_accounts AS (
  SELECT
    a.tenant_id,
    a."account_id"      AS account_id,
    a."code"            AS account_code,
    a."name"            AS account_name,
    a."class"           AS account_class,
    a."type"            AS account_type,
    a."reporting_code"  AS reporting_code
  FROM "source_xero_fivetran"."xero_accounts" a
  WHERE a.tenant_id = (SELECT ingestion.current_tenant_id())
    AND NOT a.tombstone
    AND a."class" IN ('REVENUE', 'EXPENSE')
),
movements AS (
  -- Sales invoice and bill lines. ACCPAY debits the coded account,
  -- ACCREC credits it.
  SELECT
    l.tenant_id,
    'invoice_line'::text        AS source_kind,
    i."invoice_id"              AS source_id,
    l.namespaced_source_key     AS line_uid,
    i."date"                    AS occurred_on,
    i."contact_name"            AS contact_name,
    l."line_items_description"  AS description,
    l."line_items_account_id"   AS account_id,
    l."line_items_account_code" AS account_code,
    (CASE WHEN i."line_amount_types" = 'Inclusive'
          THEN l."line_items_line_amount" - COALESCE(l."line_items_tax_amount", 0)
          ELSE l."line_items_line_amount" END)
      * (CASE i."type" WHEN 'ACCPAY' THEN 1 ELSE -1 END) AS movement
  FROM "source_xero_fivetran"."xero_invoice_line_items" l
  JOIN "source_xero_fivetran"."xero_invoices" i
    ON i.tenant_id = l.tenant_id
   AND i."invoice_id" = l."invoice_id"
   AND NOT i.tombstone
  WHERE l.tenant_id = (SELECT ingestion.current_tenant_id())
    AND NOT l.tombstone
    AND i."status" IN ('AUTHORISED', 'PAID')

  UNION ALL

  -- Spend / receive money lines (excludes transfers, overpayments and
  -- prepayments, which are balance-sheet movements).
  SELECT
    l.tenant_id,
    'bank_line',
    t."bank_transaction_id",
    l.namespaced_source_key,
    t."date",
    t."contact_name",
    l."description",
    l."account_id",
    l."account_code",
    (CASE WHEN t."line_amount_types" = 'Inclusive'
          THEN l."line_amount" - COALESCE(l."tax_amount", 0)
          ELSE l."line_amount" END)
      * (CASE WHEN t."type" = 'SPEND' THEN 1 ELSE -1 END)
  FROM "source_xero_fivetran"."xero_bank_transaction_line_items" l
  JOIN "source_xero_fivetran"."xero_bank_transactions" t
    ON t.tenant_id = l.tenant_id
   AND t."bank_transaction_id" = l."bank_transaction_id"
   AND NOT t.tombstone
  WHERE l.tenant_id = (SELECT ingestion.current_tenant_id())
    AND NOT l.tombstone
    AND t."status" = 'AUTHORISED'
    AND t."type" IN ('SPEND', 'RECEIVE')

  UNION ALL

  -- Posted manual journal lines: line_amount is already debit-positive.
  SELECT
    l.tenant_id,
    'journal_line',
    j."manual_journal_id",
    l.namespaced_source_key,
    j."date",
    NULL,
    COALESCE(l."description", j."narration"),
    l."account_id",
    l."account_code",
    CASE WHEN j."line_amount_types" = 'Inclusive'
         THEN l."line_amount" - COALESCE(l."tax_amount", 0)
         ELSE l."line_amount" END
  FROM "source_xero_fivetran"."xero_manual_journal_lines" l
  JOIN "source_xero_fivetran"."xero_manual_journals" j
    ON j.tenant_id = l.tenant_id
   AND j."manual_journal_id" = l."manual_journal_id"
   AND NOT j.tombstone
  WHERE l.tenant_id = (SELECT ingestion.current_tenant_id())
    AND NOT l.tombstone
    AND j."status" = 'POSTED'
    AND NOT COALESCE(l."is_blank", false)

  UNION ALL

  -- Credit note lines reverse their document direction: a customer credit
  -- note (ACCRECCREDIT) debits revenue, a supplier one credits expense.
  SELECT
    l.tenant_id,
    'credit_note_line',
    cn."credit_note_id",
    l.namespaced_source_key,
    cn."date",
    cn."contact_name",
    l."line_items_description",
    l."line_items_account_id",
    l."line_items_account_code",
    (CASE WHEN cn."line_amount_types" = 'Inclusive'
          THEN l."line_items_line_amount" - COALESCE(l."line_items_tax_amount", 0)
          ELSE l."line_items_line_amount" END)
      * (CASE cn."type" WHEN 'ACCRECCREDIT' THEN 1 ELSE -1 END)
  FROM "source_xero_fivetran"."xero_credit_note_line_items" l
  JOIN "source_xero_fivetran"."xero_credit_notes" cn
    ON cn.tenant_id = l.tenant_id
   AND cn."credit_note_id" = l."credit_note_id"
   AND NOT cn.tombstone
  WHERE l.tenant_id = (SELECT ingestion.current_tenant_id())
    AND NOT l.tombstone
    AND cn."status" IN ('AUTHORISED', 'PAID')
)
SELECT
  m.tenant_id,
  m.tenant_id || ':' || m.source_kind || ':' || m.line_uid AS row_key,
  m.source_kind,
  m.source_id,
  m.occurred_on,
  m.contact_name,
  m.description,
  a.account_id,
  a.account_code,
  a.account_name,
  a.account_class,
  a.account_type,
  a.reporting_code,
  m.movement,
  CASE WHEN a.account_class = 'REVENUE' THEN -m.movement ELSE 0 END AS revenue_amount,
  CASE WHEN a.account_class = 'EXPENSE' THEN m.movement ELSE 0 END AS expense_amount,
  -m.movement AS profit_impact
FROM movements m
JOIN pnl_accounts a
  ON a.tenant_id = m.tenant_id
 AND ((m.account_id IS NOT NULL AND a.account_id = m.account_id)
   OR (m.account_id IS NULL AND a.account_code = m.account_code));

-- xo_gst_lines: derived GST lines for Xero, rewritten to read the typed
-- connector staging tables in source_xero (was dlt-loaded XER_OFFICIAL).
-- Same output contract: tax-bearing lines from invoices/bills, spend/receive
-- bank transactions and credit notes, split into gst_collected / gst_paid.
-- Manual journal lines remain deliberately excluded (no GST breakdown), and
-- lines coded to ANY account class are kept (capital-purchase GST claimable).

CREATE OR REPLACE VIEW source_xero_official.xo_gst_lines
WITH (security_barrier = true) AS
WITH accounts AS (
  SELECT
    a.tenant_id,
    a."account_id" AS account_id,
    a."code"       AS account_code,
    a."name"       AS account_name,
    a."class"      AS account_class,
    a."type"       AS account_type
  FROM "source_xero_fivetran"."xero_accounts" a
  WHERE a.tenant_id = (SELECT ingestion.current_tenant_id())
    AND NOT a.tombstone
),
tax_lines AS (
  -- Invoice and bill lines. ACCREC collects GST, ACCPAY pays it.
  SELECT
    l.tenant_id,
    'invoice_line'::text        AS source_kind,
    i."invoice_id"              AS source_id,
    l.namespaced_source_key     AS line_uid,
    i."date"                    AS occurred_on,
    i."contact_name"            AS contact_name,
    l."line_items_description"  AS description,
    l."line_items_account_id"   AS account_id,
    l."line_items_account_code" AS account_code,
    l."line_items_tax_type"     AS tax_type,
    CASE WHEN i."line_amount_types" = 'Inclusive'
         THEN l."line_items_line_amount" - COALESCE(l."line_items_tax_amount", 0)
         ELSE l."line_items_line_amount" END AS taxable_amount,
    CASE WHEN i."type" = 'ACCREC' THEN COALESCE(l."line_items_tax_amount", 0) ELSE 0 END AS gst_collected,
    CASE WHEN i."type" = 'ACCPAY' THEN COALESCE(l."line_items_tax_amount", 0) ELSE 0 END AS gst_paid
  FROM "source_xero_fivetran"."xero_invoice_line_items" l
  JOIN "source_xero_fivetran"."xero_invoices" i
    ON i.tenant_id = l.tenant_id
   AND i."invoice_id" = l."invoice_id"
   AND NOT i.tombstone
  WHERE l.tenant_id = (SELECT ingestion.current_tenant_id())
    AND NOT l.tombstone
    AND i."status" IN ('AUTHORISED', 'PAID')
    AND COALESCE(l."line_items_tax_amount", 0) <> 0

  UNION ALL

  -- Spend / receive money lines.
  SELECT
    l.tenant_id,
    'bank_line',
    t."bank_transaction_id",
    l.namespaced_source_key,
    t."date",
    t."contact_name",
    l."description",
    l."account_id",
    l."account_code",
    l."tax_type",
    CASE WHEN t."line_amount_types" = 'Inclusive'
         THEN l."line_amount" - COALESCE(l."tax_amount", 0)
         ELSE l."line_amount" END,
    CASE WHEN t."type" = 'RECEIVE' THEN COALESCE(l."tax_amount", 0) ELSE 0 END,
    CASE WHEN t."type" = 'SPEND' THEN COALESCE(l."tax_amount", 0) ELSE 0 END
  FROM "source_xero_fivetran"."xero_bank_transaction_line_items" l
  JOIN "source_xero_fivetran"."xero_bank_transactions" t
    ON t.tenant_id = l.tenant_id
   AND t."bank_transaction_id" = l."bank_transaction_id"
   AND NOT t.tombstone
  WHERE l.tenant_id = (SELECT ingestion.current_tenant_id())
    AND NOT l.tombstone
    AND t."status" = 'AUTHORISED'
    AND t."type" IN ('SPEND', 'RECEIVE')
    AND COALESCE(l."tax_amount", 0) <> 0

  UNION ALL

  -- Credit note lines reverse their document: a customer credit note
  -- (ACCRECCREDIT) reduces GST collected, a supplier one reduces GST paid.
  SELECT
    l.tenant_id,
    'credit_note_line',
    cn."credit_note_id",
    l.namespaced_source_key,
    cn."date",
    cn."contact_name",
    l."line_items_description",
    l."line_items_account_id",
    l."line_items_account_code",
    l."line_items_tax_type",
    -1 * (CASE WHEN cn."line_amount_types" = 'Inclusive'
               THEN l."line_items_line_amount" - COALESCE(l."line_items_tax_amount", 0)
               ELSE l."line_items_line_amount" END),
    CASE WHEN cn."type" = 'ACCRECCREDIT' THEN -COALESCE(l."line_items_tax_amount", 0) ELSE 0 END,
    CASE WHEN cn."type" = 'ACCPAYCREDIT' THEN -COALESCE(l."line_items_tax_amount", 0) ELSE 0 END
  FROM "source_xero_fivetran"."xero_credit_note_line_items" l
  JOIN "source_xero_fivetran"."xero_credit_notes" cn
    ON cn.tenant_id = l.tenant_id
   AND cn."credit_note_id" = l."credit_note_id"
   AND NOT cn.tombstone
  WHERE l.tenant_id = (SELECT ingestion.current_tenant_id())
    AND NOT l.tombstone
    AND cn."status" IN ('AUTHORISED', 'PAID')
    AND COALESCE(l."line_items_tax_amount", 0) <> 0
)
SELECT
  t.tenant_id,
  t.tenant_id || ':' || t.source_kind || ':' || t.line_uid AS row_key,
  t.source_kind,
  t.source_id,
  t.occurred_on,
  t.contact_name,
  t.description,
  t.tax_type,
  a.account_code,
  a.account_name,
  a.account_class,
  a.account_type,
  t.taxable_amount,
  t.gst_collected,
  t.gst_paid,
  t.gst_collected - t.gst_paid AS net_gst
FROM tax_lines t
LEFT JOIN accounts a
  ON a.tenant_id = t.tenant_id
 AND ((t.account_id IS NOT NULL AND a.account_id = t.account_id)
   OR (t.account_id IS NULL AND a.account_code = t.account_code));


-- Grants -----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA source_xero_official TO semantic_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA source_xero_official TO semantic_ro;

DO $$
DECLARE view_count integer; offender text;
BEGIN
  SELECT count(*) INTO view_count
  FROM pg_views WHERE schemaname = 'source_xero_official' AND viewname LIKE 'xo\_%';
  IF view_count <> 50 THEN
    RAISE EXCEPTION 'expected 50 xo_ views after repoint, found %', view_count;
  END IF;
  SELECT string_agg(viewname, ', ') INTO offender
  FROM pg_views
  WHERE schemaname = 'source_xero_official'
    AND definition ~ '"?source_xero"?\.' AND definition !~ 'source_xero_fivetran';
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'xo_ views still read source_xero: %', offender;
  END IF;
END $$;

COMMIT;
