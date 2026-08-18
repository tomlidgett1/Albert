-- 0171: the Cube Lightspeed R-Series contract reads Fivetran-landed data.
--
-- Lightspeed R-Series now arrives through Albert's Fivetran Connector SDK
-- connector (connectors/lightspeed-fivetran-sdk), one destination schema per
-- connection (lightspeed_<connection_ulid>) carrying the exact
-- source_lightspeed.ls_* staging shapes (all 90 tables, snake_case of the
-- vendor field, plus source_record_id / source_updated_at / tombstone /
-- _albert_synced_at). Cube must keep reading ONE stable surface, so this
-- migration adds:
--
--   * ingestion.rebuild_fivetran_source_views() v3:
--       - SDK-shaped tables are recognised by their control columns
--         (source_record_id + tombstone), not only by a table-name prefix, so
--         ls_* tables get Albert's contract names back;
--       - Fivetran's identifier rewrite (tax1_rate -> tax_1_rate, b2b -> b_2_b)
--         is undone through the connector's own albert_column_contract table
--         when the schema carries one (compare underscore-stripped names —
--         tests/contracts/fivetran-lightspeed-sdk.contract.test.ts pins that no
--         two contract columns of a table collapse to the same name), falling
--         back to the letter_digit collapse for SDK tables without it;
--       - for the lightspeed prefix the union view AND its
--         source_lightspeed_official twin are dropped and re-created together
--         (types may change between the empty seed view and the first landed
--         table); other prefixes keep CREATE OR REPLACE semantics;
--       - a union view whose every bound schema has retired is rewritten as an
--         empty typed view instead of being left pointing at a schema about to
--         be purged (DROP SCHEMA ... CASCADE would otherwise take the union
--         view and every dependent Cube view with it).
--   * ingestion.rebuild_lightspeed_official_view(table): the Albert-shaped read
--     surface source_lightspeed_official.ls_* over the union view — tenant
--     scoped, security_barrier, exposing the envelope Cube reads today
--     (tenant_id, namespaced_source_key, source_record_id, source_updated_at,
--     tombstone, mapping_version, ingested_at) plus every contract column.
--   * All 90 source_lightspeed_fivetran.ls_* union views seeded as empty typed
--     views (so the official layer exists before the first tenant lands), and
--     the 90 source_lightspeed_official.ls_* views over them. Cube models move
--     from source_lightspeed.ls_* to source_lightspeed_official.ls_*; the
--     native staging tables stay in place for the manual-only worker path and
--     the verified deletion chain (0159).
--
-- Tenancy: official views filter tenant_id = ingestion.current_tenant_id() and
-- the union views carry the binding's tenant per branch, so a tenant can never
-- see another schema's rows even if a table were unstamped.

BEGIN;

DO $$
BEGIN
  IF NOT pg_has_role('albert_migration_owner', 'fivetran_user', 'MEMBER') THEN
    RAISE EXCEPTION 'run "GRANT fivetran_user TO albert_migration_owner" as postgres before applying 0171';
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS source_lightspeed_fivetran;
GRANT USAGE ON SCHEMA source_lightspeed_fivetran TO transform_rw, diagnostic_ro;
CREATE SCHEMA IF NOT EXISTS source_lightspeed_official;
GRANT USAGE ON SCHEMA source_lightspeed_official TO semantic_ro, transform_rw, diagnostic_ro;

-- 1. Official-view builder --------------------------------------------------------

CREATE OR REPLACE FUNCTION ingestion.rebuild_lightspeed_official_view(p_table text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  union_view regclass;
  select_list text;
  column_rec record;
  has_column boolean;
BEGIN
  IF p_table IS NULL OR p_table !~ '^ls_[a-z0-9_]{1,60}$' THEN
    RETURN;
  END IF;
  union_view := to_regclass(format('source_lightspeed_fivetran.%I', p_table));
  IF union_view IS NULL THEN
    RETURN;
  END IF;
  -- Envelope Cube reads: present on every SDK-landed table; NULL-typed when a
  -- (never expected) shape lacks one so the view still builds.
  select_list := 'u.tenant_id';
  SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = union_view AND attname = 'namespaced_source_key' AND NOT attisdropped) INTO has_column;
  select_list := select_list || CASE WHEN has_column THEN ', u.namespaced_source_key' ELSE ', NULL::text AS namespaced_source_key' END;
  SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = union_view AND attname = 'source_record_id' AND NOT attisdropped) INTO has_column;
  select_list := select_list || CASE WHEN has_column THEN ', u.source_record_id' ELSE ', NULL::text AS source_record_id' END;
  SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = union_view AND attname = 'source_updated_at' AND NOT attisdropped) INTO has_column;
  select_list := select_list || CASE WHEN has_column THEN ', u.source_updated_at' ELSE ', NULL::timestamptz AS source_updated_at' END;
  SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = union_view AND attname = 'tombstone' AND NOT attisdropped) INTO has_column;
  select_list := select_list || CASE WHEN has_column THEN ', COALESCE(u.tombstone, false) AS tombstone' ELSE ', false AS tombstone' END;
  -- One pack for the whole Fivetran surface: Cube's latest-pack join then
  -- keeps every row, exactly as a single live pack version does today.
  select_list := select_list || ', ''fivetran-sdk''::text AS mapping_version';
  SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = union_view AND attname = '_albert_synced_at' AND NOT attisdropped) INTO has_column;
  select_list := select_list || CASE WHEN has_column THEN ', u._albert_synced_at AS ingested_at' ELSE ', NULL::timestamptz AS ingested_at' END;
  FOR column_rec IN
    SELECT attname AS name
      FROM pg_catalog.pg_attribute
     WHERE attrelid = union_view
       AND attnum > 0
       AND NOT attisdropped
       AND attname NOT IN ('tenant_id','namespaced_source_key','source_record_id','source_updated_at','tombstone','_albert_synced_at')
     ORDER BY attnum
  LOOP
    select_list := select_list || format(', u.%I', column_rec.name);
  END LOOP;
  EXECUTE format('DROP VIEW IF EXISTS source_lightspeed_official.%I', p_table);
  EXECUTE format(
    'CREATE VIEW source_lightspeed_official.%I WITH (security_barrier = true) AS '
    'SELECT %s FROM source_lightspeed_fivetran.%I u WHERE u.tenant_id = (SELECT ingestion.current_tenant_id())',
    p_table, select_list, p_table);
  EXECUTE format('GRANT SELECT ON source_lightspeed_official.%I TO semantic_ro, transform_rw, diagnostic_ro', p_table);
END;
$$;
REVOKE ALL ON FUNCTION ingestion.rebuild_lightspeed_official_view(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingestion.rebuild_lightspeed_official_view(text) TO ingest_rw;

-- 2. Union-view builder v3 ---------------------------------------------------------

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
  rebuilt_tables text[] := ARRAY[]::text[];
  present boolean;
  sdk_shaped boolean;
  has_contract boolean;
  alias_name text;
  contract_alias text;
  stale record;
  stub_list text;
BEGIN
  IF p_prefix IS NULL OR p_prefix !~ '^[a-z][a-z0-9_]{0,31}$' THEN
    RAISE EXCEPTION 'fivetran source prefix is invalid' USING ERRCODE = '22023';
  END IF;
  target_schema := 'source_' || p_prefix || '_fivetran';
  IF to_regnamespace(target_schema) IS NULL THEN
    EXECUTE format('CREATE SCHEMA %I', target_schema);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO transform_rw, diagnostic_ro', target_schema);
  END IF;

  FOR table_name IN
    SELECT DISTINCT class.relname
      FROM ingestion.fivetran_destination_bindings AS binding
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.nspname = binding.destination_schema
      JOIN pg_catalog.pg_class AS class ON class.relnamespace = namespace.oid AND class.relkind = 'r'
     WHERE binding.retired_at IS NULL
       AND binding.destination_schema LIKE p_prefix || '\_%'
       AND class.relname NOT LIKE 'fivetran\_%'
       AND class.relname NOT LIKE '\_fivetran\_%'
  LOOP
    SELECT binding.destination_schema INTO leader_schema
      FROM ingestion.fivetran_destination_bindings AS binding
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.nspname = binding.destination_schema
      JOIN pg_catalog.pg_class AS class ON class.relnamespace = namespace.oid AND class.relkind = 'r'
     WHERE binding.retired_at IS NULL
       AND binding.destination_schema LIKE p_prefix || '\_%'
       AND class.relname = table_name
     ORDER BY binding.created_at DESC
     LIMIT 1;

    -- SDK-shaped tables carry Albert's contract names: either the source
    -- prefix (xero_*) or the SDK control columns (ls_* lands source_record_id
    -- + tombstone). Fivetran-native tables (Deputy) keep landed names.
    sdk_shaped := table_name LIKE p_prefix || '\_%'
      OR (
        EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                 WHERE attrelid = format('%I.%I', leader_schema, table_name)::regclass
                   AND attname = 'source_record_id' AND NOT attisdropped)
        AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                     WHERE attrelid = format('%I.%I', leader_schema, table_name)::regclass
                       AND attname = 'tombstone' AND NOT attisdropped)
      );
    has_contract := to_regclass(format('%I.albert_column_contract', leader_schema)) IS NOT NULL;

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
        alias_name := column_rec.name;
        IF sdk_shaped THEN
          contract_alias := NULL;
          IF has_contract THEN
            -- The connector's own contract: the one contract column whose
            -- underscore-stripped name equals the landed column's. Fivetran
            -- only ever adds underscores, so this is exact when unique.
            BEGIN
              EXECUTE format(
                'SELECT CASE WHEN count(DISTINCT contract.column_name) = 1 THEN min(contract.column_name) END '
                'FROM %I.albert_column_contract AS contract '
                'WHERE contract.table_name = $1 AND replace(contract.column_name, ''_'', '''') = replace($2, ''_'', '''')',
                leader_schema)
                INTO contract_alias USING table_name, column_rec.name;
            EXCEPTION WHEN undefined_column OR undefined_table OR insufficient_privilege THEN
              contract_alias := NULL;
            END;
          END IF;
          alias_name := COALESCE(contract_alias, regexp_replace(column_rec.name, '([a-z])_([0-9])', '\1\2', 'g'));
        END IF;
        SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_attribute AS other
           WHERE other.attrelid = format('%I.%I', active.destination_schema, table_name)::regclass
             AND other.attname = column_rec.name
             AND NOT other.attisdropped
        ) INTO present;
        IF present THEN
          select_list := select_list || format(', %I::%s AS %I', column_rec.name, column_rec.type, alias_name);
        ELSE
          select_list := select_list || format(', NULL::%s AS %I', column_rec.type, alias_name);
        END IF;
      END LOOP;
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
      IF p_prefix = 'lightspeed' THEN
        -- Seed views and first landings differ in type; the official twin
        -- depends on the union view, so both are rebuilt in one step.
        IF table_name LIKE 'ls\_%' THEN
          EXECUTE format('DROP VIEW IF EXISTS source_lightspeed_official.%I', table_name);
        END IF;
        EXECUTE format('DROP VIEW IF EXISTS %I.%I', target_schema, table_name);
        EXECUTE format('CREATE VIEW %I.%I AS %s',
                       target_schema, table_name, array_to_string(branches, ' UNION ALL '));
        EXECUTE format('GRANT SELECT ON %I.%I TO transform_rw, diagnostic_ro', target_schema, table_name);
        IF table_name LIKE 'ls\_%' THEN
          PERFORM ingestion.rebuild_lightspeed_official_view(table_name);
        END IF;
      ELSE
        EXECUTE format('CREATE OR REPLACE VIEW %I.%I AS %s',
                       target_schema, table_name, array_to_string(branches, ' UNION ALL '));
        EXECUTE format('GRANT SELECT ON %I.%I TO transform_rw, diagnostic_ro', target_schema, table_name);
      END IF;
      rebuilt := rebuilt + 1;
      rebuilt_tables := rebuilt_tables || table_name;
    EXCEPTION
      WHEN feature_not_supported OR invalid_table_definition OR datatype_mismatch OR undefined_column OR dependent_objects_still_exist THEN
        NULL;
    END;
  END LOOP;

  -- Views no active binding carries any more (the last tenant with that table
  -- retired): keep the exact column list but read nothing, so purging the
  -- retired schema cannot cascade into the Cube contract.
  FOR stale IN
    SELECT class.relname AS name, class.oid AS oid
      FROM pg_catalog.pg_class AS class
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
     WHERE namespace.nspname = target_schema
       AND class.relkind = 'v'
       AND NOT (class.relname = ANY (rebuilt_tables))
       AND EXISTS (
         SELECT 1
           FROM pg_catalog.pg_depend AS dep
           JOIN pg_catalog.pg_rewrite AS rewrite ON rewrite.oid = dep.objid
           JOIN pg_catalog.pg_class AS source ON source.oid = dep.refobjid
           JOIN pg_catalog.pg_namespace AS source_ns ON source_ns.oid = source.relnamespace
          WHERE rewrite.ev_class = class.oid
            AND dep.classid = 'pg_rewrite'::regclass
            AND dep.refclassid = 'pg_class'::regclass
            AND source.oid <> class.oid
            AND source_ns.nspname LIKE p_prefix || '\_%'
       )
  LOOP
    stub_list := NULL;
    FOR column_rec IN
      SELECT attname AS name, format_type(atttypid, atttypmod) AS type
        FROM pg_catalog.pg_attribute
       WHERE attrelid = stale.oid AND attnum > 0 AND NOT attisdropped
       ORDER BY attnum
    LOOP
      stub_list := COALESCE(stub_list || ', ', '') || format('NULL::%s AS %I', column_rec.type, column_rec.name);
    END LOOP;
    IF stub_list IS NULL THEN
      CONTINUE;
    END IF;
    BEGIN
      EXECUTE format('CREATE OR REPLACE VIEW %I.%I AS SELECT %s WHERE false', target_schema, stale.name, stub_list);
    EXCEPTION
      WHEN feature_not_supported OR invalid_table_definition OR datatype_mismatch OR undefined_column THEN
        NULL;
    END;
  END LOOP;
  RETURN rebuilt;
END;
$$;
REVOKE ALL ON FUNCTION ingestion.rebuild_fivetran_source_views(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingestion.rebuild_fivetran_source_views(text) TO ingest_rw;

-- 3. Seed the 90 union views (empty, typed as the staging contract) and their official twins ---

DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_sales') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_sales AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "sale_id",
    NULL::boolean AS "completed",
    NULL::boolean AS "voided",
    NULL::boolean AS "archived",
    NULL::timestamptz AS "create_time",
    NULL::timestamptz AS "complete_time",
    NULL::timestamptz AS "updatetime",
    NULL::timestamptz AS "time_stamp",
    NULL::text AS "reference_number",
    NULL::text AS "reference_number_source",
    NULL::numeric(19,4) AS "tax1_rate",
    NULL::numeric(19,4) AS "tax2_rate",
    NULL::numeric(19,4) AS "change",
    NULL::boolean AS "tip_enabled",
    NULL::boolean AS "enable_promotions",
    NULL::numeric(19,4) AS "calc_discount",
    NULL::numeric(19,4) AS "calc_total",
    NULL::numeric(19,4) AS "calc_subtotal",
    NULL::numeric(19,4) AS "calc_taxable",
    NULL::numeric(19,4) AS "calc_non_taxable",
    NULL::numeric(19,4) AS "calc_avg_cost",
    NULL::numeric(19,4) AS "calc_fifo_cost",
    NULL::numeric(19,4) AS "calc_tax1",
    NULL::numeric(19,4) AS "calc_tax2",
    NULL::numeric(19,4) AS "calc_payments",
    NULL::numeric(19,4) AS "calc_tips",
    NULL::numeric(19,4) AS "total",
    NULL::numeric(19,4) AS "total_due",
    NULL::numeric(19,4) AS "displayable_total",
    NULL::numeric(19,4) AS "balance",
    NULL::numeric(19,4) AS "customer_id",
    NULL::numeric(19,4) AS "discount_id",
    NULL::numeric(19,4) AS "discount_percent",
    NULL::numeric(19,4) AS "employee_id",
    NULL::numeric(19,4) AS "tip_employee_id",
    NULL::numeric(19,4) AS "quote_id",
    NULL::numeric(19,4) AS "register_id",
    NULL::numeric(19,4) AS "ship_to_id",
    NULL::numeric(19,4) AS "shop_id",
    NULL::numeric(19,4) AS "tax_category_id",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_sales TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_sales');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_sale_lines') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_sale_lines AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "sale_line_id",
    NULL::numeric(19,4) AS "sale_id",
    NULL::timestamptz AS "create_time",
    NULL::timestamptz AS "time_stamp",
    NULL::numeric(19,4) AS "unit_quantity",
    NULL::numeric(19,4) AS "unit_price",
    NULL::numeric(19,4) AS "normal_unit_price",
    NULL::numeric(19,4) AS "discount_amount",
    NULL::numeric(19,4) AS "discount_percent",
    NULL::numeric(19,4) AS "avg_cost",
    NULL::numeric(19,4) AS "fifo_cost",
    NULL::boolean AS "tax",
    NULL::numeric(19,4) AS "tax1_rate",
    NULL::numeric(19,4) AS "tax2_rate",
    NULL::boolean AS "is_layaway",
    NULL::boolean AS "is_workorder",
    NULL::boolean AS "is_special_order",
    NULL::numeric(19,4) AS "displayable_subtotal",
    NULL::numeric(19,4) AS "displayable_unit_price",
    NULL::numeric(19,4) AS "calc_line_discount",
    NULL::numeric(19,4) AS "calc_transaction_discount",
    NULL::numeric(19,4) AS "calc_total",
    NULL::numeric(19,4) AS "calc_subtotal",
    NULL::numeric(19,4) AS "calc_tax1",
    NULL::numeric(19,4) AS "calc_tax2",
    NULL::numeric(19,4) AS "tax_class_id",
    NULL::numeric(19,4) AS "customer_id",
    NULL::numeric(19,4) AS "discount_id",
    NULL::numeric(19,4) AS "employee_id",
    NULL::numeric(19,4) AS "item_id",
    NULL::numeric(19,4) AS "note_id",
    NULL::numeric(19,4) AS "parent_sale_line_id",
    NULL::numeric(19,4) AS "shop_id",
    NULL::numeric(19,4) AS "tax_category_id",
    NULL::numeric(19,4) AS "item_fee_id",
    NULL::text AS "line_type",
    NULL::boolean AS "require_full_reservation",
    NULL::boolean AS "completed",
    NULL::boolean AS "voided",
    NULL::timestamptz AS "complete_time",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_sale_lines TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_sale_lines');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_sale_payments') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_sale_payments AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "sale_payment_id",
    NULL::numeric(19,4) AS "amount",
    NULL::timestamptz AS "create_time",
    NULL::boolean AS "archived",
    NULL::text AS "remote_reference",
    NULL::numeric(19,4) AS "tip_amount",
    NULL::text AS "payment_id",
    NULL::numeric(19,4) AS "sale_id",
    NULL::numeric(19,4) AS "payment_type_id",
    NULL::numeric(19,4) AS "cc_charge_id",
    NULL::numeric(19,4) AS "ref_payment_id",
    NULL::numeric(19,4) AS "register_id",
    NULL::numeric(19,4) AS "employee_id",
    NULL::numeric(19,4) AS "credit_account_id",
    NULL::boolean AS "completed",
    NULL::boolean AS "voided",
    NULL::timestamptz AS "complete_time",
    NULL::numeric(19,4) AS "shop_id",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_sale_payments TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_sale_payments');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_sale_accounts') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_sale_accounts AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "sale_account_id",
    NULL::numeric(19,4) AS "credit_account_id",
    NULL::numeric(19,4) AS "sale_payment_id",
    NULL::numeric(19,4) AS "sale_line_id",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_sale_accounts TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_sale_accounts');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_sale_payment_signatures') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_sale_payment_signatures AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "sale_payment_signature_id",
    NULL::text AS "file_path",
    NULL::timestamptz AS "create_time",
    NULL::numeric(19,4) AS "sale_payment_id",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_sale_payment_signatures TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_sale_payment_signatures');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_sale_line_inventory_allocations') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_sale_line_inventory_allocations AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "inventory_sale_id",
    NULL::numeric(19,4) AS "quantity",
    NULL::timestamptz AS "create_time",
    NULL::numeric(19,4) AS "inventory_id",
    NULL::numeric(19,4) AS "sale_line_id",
    NULL::numeric(19,4) AS "sale_id",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_sale_line_inventory_allocations TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_sale_line_inventory_allocations');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_sale_voids') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_sale_voids AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "sale_void_id",
    NULL::timestamptz AS "create_time",
    NULL::text AS "reason",
    NULL::numeric(19,4) AS "sale_id",
    NULL::numeric(19,4) AS "employee_id",
    NULL::numeric(19,4) AS "shop_id",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_sale_voids TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_sale_voids');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_cc_charges') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_cc_charges AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "cc_charge_id",
    NULL::text AS "gateway_trans_id",
    NULL::text AS "xnum",
    NULL::text AS "response",
    NULL::boolean AS "voided",
    NULL::numeric(19,4) AS "refunded",
    NULL::numeric(19,4) AS "amount",
    NULL::text AS "exp",
    NULL::boolean AS "auth_only",
    NULL::text AS "auth_code",
    NULL::timestamptz AS "time_stamp",
    NULL::boolean AS "declined",
    NULL::numeric(19,4) AS "sale_id",
    NULL::text AS "entry_method",
    NULL::text AS "cardholder_name",
    NULL::text AS "communication_key",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_cc_charges TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_cc_charges');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_processing_fees') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_processing_fees AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "sale_payment_processing_fee_id",
    NULL::numeric(19,4) AS "sale_payment_id",
    NULL::text AS "processing_fee_ref",
    NULL::text AS "processor",
    NULL::numeric(19,4) AS "amount",
    NULL::numeric(19,4) AS "fixed_fee",
    NULL::numeric(19,4) AS "variable_fee",
    NULL::numeric(19,4) AS "variable_pct",
    NULL::numeric(19,4) AS "interchange_fees_fixed_fee",
    NULL::numeric(19,4) AS "interchange_fees_variable_fee",
    NULL::numeric(19,4) AS "interchange_fees_variable_pct",
    NULL::numeric(19,4) AS "scheme_fees_fixed_fee",
    NULL::numeric(19,4) AS "scheme_fees_variable_fee",
    NULL::numeric(19,4) AS "scheme_fees_variable_pct",
    NULL::timestamptz AS "processing_time",
    NULL::timestamptz AS "create_time",
    NULL::timestamptz AS "update_time",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_processing_fees TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_processing_fees');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_quotes') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_quotes AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "quote_id",
    NULL::timestamptz AS "issue_date",
    NULL::text AS "notes",
    NULL::boolean AS "archived",
    NULL::numeric(19,4) AS "employee_id",
    NULL::numeric(19,4) AS "sale_id",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_quotes TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_quotes');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_discounts') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_discounts AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "discount_id",
    NULL::text AS "name",
    NULL::numeric(19,4) AS "discount_amount",
    NULL::numeric(19,4) AS "discount_percent",
    NULL::boolean AS "require_customer",
    NULL::boolean AS "archived",
    NULL::numeric(19,4) AS "source_id",
    NULL::timestamptz AS "time_stamp",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_discounts TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_discounts');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_items') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_items AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "item_id",
    NULL::text AS "system_sku",
    NULL::numeric(19,4) AS "default_cost",
    NULL::numeric(19,4) AS "avg_cost",
    NULL::boolean AS "tax",
    NULL::boolean AS "archived",
    NULL::boolean AS "discountable",
    NULL::text AS "item_type",
    NULL::boolean AS "serialized",
    NULL::text AS "description",
    NULL::numeric(19,4) AS "model_year",
    NULL::text AS "upc",
    NULL::text AS "ean",
    NULL::text AS "custom_sku",
    NULL::text AS "manufacturer_sku",
    NULL::timestamptz AS "time_stamp",
    NULL::timestamptz AS "create_time",
    NULL::boolean AS "publish_to_ecom",
    NULL::numeric(19,4) AS "category_id",
    NULL::numeric(19,4) AS "tax_class_id",
    NULL::numeric(19,4) AS "department_id",
    NULL::numeric(19,4) AS "item_matrix_id",
    NULL::numeric(19,4) AS "manufacturer_id",
    NULL::numeric(19,4) AS "season_id",
    NULL::numeric(19,4) AS "default_vendor_id",
    NULL::text AS "name",
    NULL::text AS "full_path_name",
    NULL::jsonb AS "tax_class",
    NULL::jsonb AS "note",
    NULL::jsonb AS "custom_field_values",
    NULL::text AS "attribute1",
    NULL::text AS "attribute2",
    NULL::text AS "attribute3",
    NULL::numeric(19,4) AS "item_attribute_set_id",
    NULL::text AS "attribute_name1",
    NULL::text AS "attribute_name2",
    NULL::text AS "attribute_name3",
    NULL::numeric(19,4) AS "item_e_commerce_id",
    NULL::text AS "long_description",
    NULL::text AS "short_description",
    NULL::numeric(19,4) AS "weight",
    NULL::numeric(19,4) AS "width",
    NULL::numeric(19,4) AS "height",
    NULL::numeric(19,4) AS "length",
    NULL::boolean AS "list_on_store",
    NULL::numeric(19,4) AS "amount_where_use_type_default",
    NULL::numeric(19,4) AS "amount_where_use_type_msrp",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_items TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_items');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_item_shops') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_item_shops AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "item_shop_id",
    NULL::numeric(19,4) AS "item_id",
    NULL::numeric(19,4) AS "shop_id",
    NULL::numeric(19,4) AS "qoh",
    NULL::numeric(19,4) AS "sellable",
    NULL::numeric(19,4) AS "backorder",
    NULL::numeric(19,4) AS "component_qoh",
    NULL::numeric(19,4) AS "component_backorder",
    NULL::numeric(19,4) AS "reorder_point",
    NULL::numeric(19,4) AS "reorder_level",
    NULL::timestamptz AS "time_stamp",
    NULL::text AS "description",
    NULL::boolean AS "archived",
    NULL::text AS "item_type",
    NULL::numeric(19,4) AS "avg_cost",
    NULL::numeric(19,4) AS "category_id",
    NULL::numeric(19,4) AS "manufacturer_id",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_item_shops TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_item_shops');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_item_prices') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_item_prices AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "item_id",
    NULL::numeric(19,4) AS "use_type_id",
    NULL::text AS "use_type",
    NULL::numeric(19,4) AS "amount",
    NULL::text AS "description",
    NULL::boolean AS "archived",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_item_prices TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_item_prices');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_item_components') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_item_components AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "item_component_id",
    NULL::numeric(19,4) AS "assembly_item_id",
    NULL::numeric(19,4) AS "component_item_id",
    NULL::numeric(19,4) AS "quantity",
    NULL::numeric(19,4) AS "component_group",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_item_components TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_item_components');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_item_vendor_nums') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_item_vendor_nums AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "item_vendor_num_id",
    NULL::numeric(19,4) AS "item_id",
    NULL::numeric(19,4) AS "vendor_id",
    NULL::text AS "value",
    NULL::numeric(19,4) AS "cost",
    NULL::timestamptz AS "time_stamp",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_item_vendor_nums TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_item_vendor_nums');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_item_matrices') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_item_matrices AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "item_matrix_id",
    NULL::text AS "description",
    NULL::text AS "item_type",
    NULL::boolean AS "serialized",
    NULL::boolean AS "tax",
    NULL::numeric(19,4) AS "default_cost",
    NULL::numeric(19,4) AS "model_year",
    NULL::boolean AS "archived",
    NULL::numeric(19,4) AS "category_id",
    NULL::numeric(19,4) AS "tax_class_id",
    NULL::numeric(19,4) AS "department_id",
    NULL::numeric(19,4) AS "manufacturer_id",
    NULL::numeric(19,4) AS "season_id",
    NULL::numeric(19,4) AS "default_vendor_id",
    NULL::numeric(19,4) AS "item_attribute_set_id",
    NULL::timestamptz AS "time_stamp",
    NULL::text AS "name",
    NULL::text AS "full_path_name",
    NULL::text AS "attribute_name1",
    NULL::text AS "attribute_name2",
    NULL::text AS "attribute_name3",
    NULL::jsonb AS "tax_class",
    NULL::jsonb AS "department",
    NULL::jsonb AS "custom_field_values",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_item_matrices TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_item_matrices');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_item_attribute_sets') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_item_attribute_sets AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "item_attribute_set_id",
    NULL::text AS "name",
    NULL::text AS "attribute_name1",
    NULL::text AS "attribute_name2",
    NULL::text AS "attribute_name3",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_item_attribute_sets TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_item_attribute_sets');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_item_fees') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_item_fees AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "item_fee_id",
    NULL::text AS "name",
    NULL::text AS "calculation_method",
    NULL::numeric(19,4) AS "fee_value",
    NULL::boolean AS "taxable",
    NULL::boolean AS "discountable",
    NULL::boolean AS "non_refundable",
    NULL::boolean AS "archived",
    NULL::timestamptz AS "create_time",
    NULL::timestamptz AS "timestamp",
    NULL::jsonb AS "item_fee_categories",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_item_fees TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_item_fees');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_images') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_images AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "image_id",
    NULL::numeric(19,4) AS "item_id",
    NULL::numeric(19,4) AS "item_matrix_id",
    NULL::text AS "description",
    NULL::text AS "filename",
    NULL::numeric(19,4) AS "ordering",
    NULL::text AS "public_id",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_images TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_images');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_serialized') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_serialized AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "serialized_id",
    NULL::text AS "serial",
    NULL::text AS "description",
    NULL::text AS "color_name",
    NULL::text AS "size_name",
    NULL::numeric(19,4) AS "item_id",
    NULL::numeric(19,4) AS "sale_line_id",
    NULL::numeric(19,4) AS "customer_id",
    NULL::timestamptz AS "time_stamp",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_serialized TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_serialized');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_tags') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_tags AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "tag_id",
    NULL::text AS "name",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_tags TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_tags');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_tag_groups') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_tag_groups AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::text AS "name",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_tag_groups TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_tag_groups');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_seasons') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_seasons AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "season_id",
    NULL::text AS "name",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_seasons TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_seasons');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_manufacturers') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_manufacturers AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "manufacturer_id",
    NULL::text AS "name",
    NULL::timestamptz AS "create_time",
    NULL::timestamptz AS "time_stamp",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_manufacturers TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_manufacturers');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_categories') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_categories AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "category_id",
    NULL::text AS "name",
    NULL::text AS "full_path_name",
    NULL::numeric(19,4) AS "parent_id",
    NULL::numeric(19,4) AS "node_depth",
    NULL::numeric(19,4) AS "left_node",
    NULL::numeric(19,4) AS "right_node",
    NULL::timestamptz AS "create_time",
    NULL::timestamptz AS "time_stamp",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_categories TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_categories');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_options') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_options AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::text AS "name",
    NULL::text AS "value",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_options TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_options');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_price_levels') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_price_levels AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "price_level_id",
    NULL::text AS "name",
    NULL::boolean AS "archived",
    NULL::boolean AS "can_be_archived",
    NULL::text AS "type",
    NULL::jsonb AS "calculation",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_price_levels TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_price_levels');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_catalog_vendor_items') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_catalog_vendor_items AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "catalog_vendor_item_id",
    NULL::numeric(19,4) AS "catalog_vendor_id",
    NULL::text AS "vendor_number",
    NULL::text AS "manufacturer_number",
    NULL::text AS "description",
    NULL::text AS "category",
    NULL::text AS "brand",
    NULL::text AS "model",
    NULL::text AS "year",
    NULL::text AS "upc",
    NULL::text AS "ean",
    NULL::text AS "ean2",
    NULL::text AS "color_name",
    NULL::text AS "size_name",
    NULL::numeric(19,4) AS "retail_unit",
    NULL::text AS "unit_of_measurement",
    NULL::numeric(19,4) AS "cost",
    NULL::numeric(19,4) AS "cost_level2",
    NULL::numeric(19,4) AS "cost_level3",
    NULL::numeric(19,4) AS "cost_level4",
    NULL::numeric(19,4) AS "msrp",
    NULL::numeric(19,4) AS "break_qty",
    NULL::numeric(19,4) AS "break_price",
    NULL::numeric(19,4) AS "break_qty2",
    NULL::numeric(19,4) AS "break_price2",
    NULL::numeric(19,4) AS "break_qty3",
    NULL::numeric(19,4) AS "break_price3",
    NULL::text AS "status",
    NULL::text AS "replacement",
    NULL::text AS "replacement_description",
    NULL::timestamptz AS "last_price_change",
    NULL::numeric(19,4) AS "last_qoh",
    NULL::boolean AS "archived",
    NULL::jsonb AS "catalog_vendor",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_catalog_vendor_items TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_catalog_vendor_items');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_inventory_logs') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_inventory_logs AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "inventory_log_id",
    NULL::timestamptz AS "create_time",
    NULL::numeric(19,4) AS "qoh_change",
    NULL::numeric(19,4) AS "cost_change",
    NULL::boolean AS "automated",
    NULL::text AS "reason",
    NULL::boolean AS "caused_negative",
    NULL::numeric(19,4) AS "employee_id",
    NULL::numeric(19,4) AS "item_id",
    NULL::numeric(19,4) AS "shop_id",
    NULL::numeric(19,4) AS "order_id",
    NULL::numeric(19,4) AS "transfer_id",
    NULL::numeric(19,4) AS "sale_id",
    NULL::numeric(19,4) AS "inventory_count_id",
    NULL::numeric(19,4) AS "customer_id",
    NULL::numeric(19,4) AS "vendor_return_id",
    NULL::numeric(19,4) AS "item_import_id",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_inventory_logs TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_inventory_logs');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_inventory_count_calcs') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_inventory_count_calcs AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "inventory_count_calc_id",
    NULL::timestamptz AS "time_stamp",
    NULL::numeric(19,4) AS "calc_qoh",
    NULL::numeric(19,4) AS "counted_qoh",
    NULL::numeric(19,4) AS "inventory_count_id",
    NULL::numeric(19,4) AS "item_id",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_inventory_count_calcs TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_inventory_count_calcs');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_inventory_count_items') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_inventory_count_items AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "inventory_count_item_id",
    NULL::numeric(19,4) AS "qty",
    NULL::timestamptz AS "time_stamp",
    NULL::numeric(19,4) AS "inventory_count_id",
    NULL::numeric(19,4) AS "item_id",
    NULL::numeric(19,4) AS "employee_id",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_inventory_count_items TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_inventory_count_items');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_inventory_count_reconciles') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_inventory_count_reconciles AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "inventory_count_reconcile_id",
    NULL::timestamptz AS "create_time",
    NULL::numeric(19,4) AS "cost_change",
    NULL::numeric(19,4) AS "qoh_change",
    NULL::numeric(19,4) AS "inventory_count_id",
    NULL::numeric(19,4) AS "item_id",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_inventory_count_reconciles TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_inventory_count_reconciles');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_transfers') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_transfers AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "transfer_id",
    NULL::boolean AS "sent",
    NULL::boolean AS "received",
    NULL::text AS "note",
    NULL::boolean AS "archived",
    NULL::numeric(19,4) AS "transfer_from_id",
    NULL::numeric(19,4) AS "transfer_to_id",
    NULL::numeric(19,4) AS "order_id",
    NULL::timestamptz AS "sent_on",
    NULL::numeric(19,4) AS "employee_id",
    NULL::numeric(19,4) AS "shop_id",
    NULL::timestamptz AS "need_by",
    NULL::timestamptz AS "time_stamp",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_transfers TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_transfers');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_transfer_items') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_transfer_items AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "transfer_item_id",
    NULL::numeric(19,4) AS "transfer_id",
    NULL::numeric(19,4) AS "item_id",
    NULL::numeric(19,4) AS "to_send",
    NULL::numeric(19,4) AS "to_receive",
    NULL::numeric(19,4) AS "sent",
    NULL::numeric(19,4) AS "received",
    NULL::numeric(19,4) AS "sent_value",
    NULL::numeric(19,4) AS "received_value",
    NULL::text AS "comment",
    NULL::timestamptz AS "time_stamp",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_transfer_items TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_transfer_items');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_special_orders') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_special_orders AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "special_order_id",
    NULL::numeric(19,4) AS "unit_quantity",
    NULL::boolean AS "contacted",
    NULL::boolean AS "completed",
    NULL::numeric(19,4) AS "customer_id",
    NULL::numeric(19,4) AS "shop_id",
    NULL::numeric(19,4) AS "sale_line_id",
    NULL::numeric(19,4) AS "order_line_id",
    NULL::numeric(19,4) AS "transfer_item_id",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_special_orders TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_special_orders');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_transfer_from') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_transfer_from AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "transfer_from_id",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_transfer_from TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_transfer_from');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_transfer_to') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_transfer_to AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "transfer_to_id",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_transfer_to TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_transfer_to');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_purchase_orders') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_purchase_orders AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "order_id",
    NULL::timestamptz AS "ordered_date",
    NULL::timestamptz AS "received_date",
    NULL::timestamptz AS "arrival_date",
    NULL::text AS "ref_num",
    NULL::text AS "ship_instructions",
    NULL::text AS "stock_instructions",
    NULL::numeric(19,4) AS "ship_cost",
    NULL::numeric(19,4) AS "ship_vendor_cost",
    NULL::numeric(19,4) AS "other_cost",
    NULL::numeric(19,4) AS "other_vendor_cost",
    NULL::boolean AS "complete",
    NULL::boolean AS "archived",
    NULL::numeric(19,4) AS "discount",
    NULL::numeric(19,4) AS "total_discount",
    NULL::numeric(19,4) AS "total_quantity",
    NULL::numeric(19,4) AS "vendor_id",
    NULL::text AS "name",
    NULL::numeric(19,4) AS "note_id",
    NULL::numeric(19,4) AS "shop_id",
    NULL::numeric(19,4) AS "created_by_employee_id",
    NULL::jsonb AS "custom_field_values",
    NULL::timestamptz AS "create_time",
    NULL::timestamptz AS "time_stamp",
    NULL::numeric(19,4) AS "vendor_currency_rate",
    NULL::text AS "vendor_currency_code",
    NULL::text AS "shipping_cost_method",
    NULL::boolean AS "has_shipments",
    NULL::text AS "discount_method",
    NULL::numeric(19,4) AS "discount_money_value",
    NULL::numeric(19,4) AS "discount_money_vendor_value",
    NULL::boolean AS "discount_is_percent",
    NULL::numeric(19,4) AS "discount_percent_value",
    NULL::boolean AS "costs_modified_after_shipment",
    NULL::text AS "b2b_order_uid",
    NULL::text AS "b2b_order_number",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_purchase_orders TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_purchase_orders');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_purchase_order_lines') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_purchase_order_lines AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "order_line_id",
    NULL::numeric(19,4) AS "order_id",
    NULL::numeric(19,4) AS "item_id",
    NULL::numeric(19,4) AS "quantity",
    NULL::numeric(19,4) AS "price",
    NULL::numeric(19,4) AS "original_price",
    NULL::numeric(19,4) AS "vendor_cost",
    NULL::numeric(19,4) AS "checked_in",
    NULL::numeric(19,4) AS "num_received",
    NULL::numeric(19,4) AS "total",
    NULL::numeric(19,4) AS "shipping_cost",
    NULL::numeric(19,4) AS "shipping_vendor_cost",
    NULL::numeric(19,4) AS "discount_money_value",
    NULL::numeric(19,4) AS "discount_money_vendor_value",
    NULL::numeric(19,4) AS "discount_percent_value",
    NULL::timestamptz AS "create_time",
    NULL::timestamptz AS "time_stamp",
    NULL::numeric(19,4) AS "vendor_id",
    NULL::numeric(19,4) AS "shop_id",
    NULL::boolean AS "complete",
    NULL::timestamptz AS "ordered_date",
    NULL::timestamptz AS "received_date",
    NULL::boolean AS "archived",
    NULL::text AS "vendor_currency_code",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_purchase_order_lines TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_purchase_order_lines');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_order_shipments') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_order_shipments AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "order_shipment_id",
    NULL::numeric(19,4) AS "order_id",
    NULL::numeric(19,4) AS "sequence_number",
    NULL::numeric(19,4) AS "total_qty_received",
    NULL::numeric(19,4) AS "total_vendor_cost",
    NULL::numeric(19,4) AS "total_cost",
    NULL::text AS "currency_code",
    NULL::text AS "vendor_currency_code",
    NULL::numeric(19,4) AS "vendor_currency_rate",
    NULL::timestamptz AS "create_time",
    NULL::date AS "payment_due_date",
    NULL::text AS "shipment_packing_ref_num",
    NULL::timestamptz AS "time_stamp",
    NULL::numeric(19,4) AS "employee_id",
    NULL::timestamptz AS "reception_date",
    NULL::text AS "shipping_cost_method",
    NULL::numeric(19,4) AS "shipping_vendor_cost",
    NULL::numeric(19,4) AS "shipping_cost",
    NULL::numeric(19,4) AS "shipping_cost_order_full_value",
    NULL::numeric(19,4) AS "shipping_cost_order_full_vendor_value",
    NULL::text AS "discount_method",
    NULL::numeric(19,4) AS "discount_money_vendor_value",
    NULL::numeric(19,4) AS "discount_money_value",
    NULL::numeric(19,4) AS "discount_percent_value",
    NULL::numeric(19,4) AS "discount_order_full_money_value",
    NULL::numeric(19,4) AS "discount_order_full_money_vendor_value",
    NULL::numeric(19,4) AS "cost",
    NULL::numeric(19,4) AS "vendor_cost",
    NULL::text AS "status",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_order_shipments TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_order_shipments');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_order_shipment_items') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_order_shipment_items AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "order_shipment_item_id",
    NULL::numeric(19,4) AS "order_shipment_id",
    NULL::numeric(19,4) AS "qty_received",
    NULL::numeric(19,4) AS "vendor_cost",
    NULL::numeric(19,4) AS "cost",
    NULL::numeric(19,4) AS "total_vendor_cost",
    NULL::numeric(19,4) AS "total_cost",
    NULL::numeric(19,4) AS "shipping_cost",
    NULL::numeric(19,4) AS "shipping_vendor_cost",
    NULL::numeric(19,4) AS "discount_money_value",
    NULL::numeric(19,4) AS "discount_money_vendor_value",
    NULL::numeric(19,4) AS "discount_percent_value",
    NULL::text AS "currency_code",
    NULL::text AS "vendor_currency_code",
    NULL::numeric(19,4) AS "vendor_currency_rate",
    NULL::timestamptz AS "create_time",
    NULL::timestamptz AS "time_stamp",
    NULL::numeric(19,4) AS "item_id",
    NULL::text AS "item_vendor_id",
    NULL::text AS "item_description",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_order_shipment_items TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_order_shipment_items');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_vendors') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_vendors AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "vendor_id",
    NULL::text AS "name",
    NULL::boolean AS "archived",
    NULL::text AS "account_number",
    NULL::text AS "price_level",
    NULL::boolean AS "update_price",
    NULL::boolean AS "update_cost",
    NULL::boolean AS "update_description",
    NULL::boolean AS "share_sell_through",
    NULL::text AS "b2b_seller_uid",
    NULL::jsonb AS "contact",
    NULL::text AS "code",
    NULL::text AS "symbol",
    NULL::numeric(19,4) AS "rate",
    NULL::timestamptz AS "time_stamp",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_vendors TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_vendors');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_vendor_returns') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_vendor_returns AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "vendor_return_id",
    NULL::numeric(19,4) AS "vendor_id",
    NULL::numeric(19,4) AS "shop_id",
    NULL::text AS "ref_num",
    NULL::text AS "status",
    NULL::timestamptz AS "sent_date",
    NULL::numeric(19,4) AS "ship_cost",
    NULL::numeric(19,4) AS "other_cost",
    NULL::boolean AS "hide_vendor_details",
    NULL::boolean AS "archived",
    NULL::numeric(19,4) AS "subtotal",
    NULL::numeric(19,4) AS "total",
    NULL::text AS "name",
    NULL::timestamptz AS "time_stamp",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_vendor_returns TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_vendor_returns');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_customers') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_customers AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "customer_id",
    NULL::text AS "first_name",
    NULL::text AS "last_name",
    NULL::timestamptz AS "dob",
    NULL::boolean AS "archived",
    NULL::text AS "title",
    NULL::text AS "company",
    NULL::text AS "company_registration_number",
    NULL::text AS "vat_number",
    NULL::timestamptz AS "create_time",
    NULL::timestamptz AS "time_stamp",
    NULL::numeric(19,4) AS "credit_account_id",
    NULL::numeric(19,4) AS "customer_type_id",
    NULL::numeric(19,4) AS "discount_id",
    NULL::numeric(19,4) AS "tax_category_id",
    NULL::numeric(19,4) AS "contact_id",
    NULL::jsonb AS "contact",
    NULL::jsonb AS "custom_field_values",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_customers TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_customers');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_contacts') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_contacts AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "contact_id",
    NULL::text AS "contact",
    NULL::numeric(19,4) AS "ship_to_id",
    NULL::text AS "address1",
    NULL::text AS "address2",
    NULL::text AS "city",
    NULL::text AS "state",
    NULL::text AS "state_code",
    NULL::text AS "zip",
    NULL::text AS "country",
    NULL::text AS "country_code",
    NULL::boolean AS "no_email",
    NULL::boolean AS "no_mail",
    NULL::boolean AS "no_phone",
    NULL::timestamptz AS "time_stamp",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_contacts TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_contacts');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_contact_emails') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_contact_emails AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "contact_id",
    NULL::numeric(19,4) AS "contact_email",
    NULL::text AS "address",
    NULL::text AS "use_type",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_contact_emails TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_contact_emails');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_contact_phones') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_contact_phones AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "contact_id",
    NULL::numeric(19,4) AS "contact_phone",
    NULL::text AS "number",
    NULL::text AS "use_type",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_contact_phones TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_contact_phones');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_contact_websites') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_contact_websites AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "contact_id",
    NULL::numeric(19,4) AS "contact_website",
    NULL::text AS "url",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_contact_websites TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_contact_websites');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_customer_types') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_customer_types AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "customer_type_id",
    NULL::text AS "name",
    NULL::numeric(19,4) AS "tax_category_id",
    NULL::numeric(19,4) AS "discount_id",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_customer_types TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_customer_types');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_credit_accounts') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_credit_accounts AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "credit_account_id",
    NULL::text AS "name",
    NULL::text AS "code",
    NULL::text AS "description",
    NULL::boolean AS "gift_card",
    NULL::boolean AS "archived",
    NULL::numeric(19,4) AS "customer_id",
    NULL::numeric(19,4) AS "balance",
    NULL::numeric(19,4) AS "contact_id",
    NULL::timestamptz AS "time_stamp",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_credit_accounts TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_credit_accounts');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_ship_tos') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_ship_tos AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "ship_to_id",
    NULL::boolean AS "shipped",
    NULL::text AS "ship_note",
    NULL::text AS "first_name",
    NULL::text AS "last_name",
    NULL::numeric(19,4) AS "customer_id",
    NULL::numeric(19,4) AS "sale_id",
    NULL::timestamptz AS "time_stamp",
    NULL::jsonb AS "contact",
    NULL::numeric(19,4) AS "contact_id",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_ship_tos TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_ship_tos');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_custom_fields') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_custom_fields AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "custom_field_id",
    NULL::text AS "type",
    NULL::text AS "name",
    NULL::text AS "uom",
    NULL::numeric(19,4) AS "decimal_precision",
    NULL::boolean AS "archived",
    NULL::jsonb AS "default",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_custom_fields TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_custom_fields');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_custom_field_choices') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_custom_field_choices AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "custom_field_choice_id",
    NULL::numeric(19,4) AS "custom_field_id",
    NULL::text AS "name",
    NULL::text AS "value",
    NULL::boolean AS "can_be_deleted",
    NULL::timestamptz AS "time_stamp",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_custom_field_choices TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_custom_field_choices');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_customer_custom_field_values') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_customer_custom_field_values AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "custom_field_value_id",
    NULL::numeric(19,4) AS "customer_id",
    NULL::numeric(19,4) AS "custom_field_id",
    NULL::text AS "name",
    NULL::text AS "type",
    NULL::jsonb AS "value",
    NULL::numeric(19,4) AS "custom_field_choice_id",
    NULL::boolean AS "deleted",
    NULL::timestamptz AS "time_stamp",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_customer_custom_field_values TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_customer_custom_field_values');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_customer_notes') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_customer_notes AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "note_id",
    NULL::numeric(19,4) AS "customer_id",
    NULL::text AS "note",
    NULL::boolean AS "is_public",
    NULL::timestamptz AS "time_stamp",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_customer_notes TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_customer_notes');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_workorders') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_workorders AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "workorder_id",
    NULL::timestamptz AS "time_in",
    NULL::timestamptz AS "eta_out",
    NULL::text AS "note",
    NULL::text AS "internal_note",
    NULL::boolean AS "warranty",
    NULL::boolean AS "tax",
    NULL::boolean AS "archived",
    NULL::text AS "hook_in",
    NULL::text AS "hook_out",
    NULL::boolean AS "save_parts",
    NULL::boolean AS "assign_employee_to_all",
    NULL::numeric(19,4) AS "customer_id",
    NULL::numeric(19,4) AS "discount_id",
    NULL::numeric(19,4) AS "employee_id",
    NULL::numeric(19,4) AS "serialized_id",
    NULL::numeric(19,4) AS "shop_id",
    NULL::numeric(19,4) AS "sale_id",
    NULL::numeric(19,4) AS "sale_line_id",
    NULL::numeric(19,4) AS "workorder_status_id",
    NULL::text AS "customer",
    NULL::text AS "name",
    NULL::text AS "system_value",
    NULL::text AS "description",
    NULL::text AS "serial",
    NULL::timestamptz AS "time_stamp",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_workorders TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_workorders');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_workorder_lines') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_workorder_lines AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "workorder_line_id",
    NULL::numeric(19,4) AS "workorder_id",
    NULL::text AS "note",
    NULL::numeric(19,4) AS "hours",
    NULL::numeric(19,4) AS "minutes",
    NULL::numeric(19,4) AS "unit_price_override",
    NULL::numeric(19,4) AS "unit_quantity",
    NULL::numeric(19,4) AS "unit_cost",
    NULL::boolean AS "done",
    NULL::boolean AS "approved",
    NULL::boolean AS "warranty",
    NULL::boolean AS "tax",
    NULL::numeric(19,4) AS "employee_id",
    NULL::numeric(19,4) AS "sale_line_id",
    NULL::numeric(19,4) AS "sale_id",
    NULL::numeric(19,4) AS "item_id",
    NULL::numeric(19,4) AS "discount_id",
    NULL::numeric(19,4) AS "tax_class_id",
    NULL::timestamptz AS "time_stamp",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_workorder_lines TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_workorder_lines');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_workorder_items') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_workorder_items AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "workorder_item_id",
    NULL::numeric(19,4) AS "workorder_id",
    NULL::boolean AS "approved",
    NULL::numeric(19,4) AS "unit_price",
    NULL::numeric(19,4) AS "unit_quantity",
    NULL::boolean AS "warranty",
    NULL::boolean AS "tax",
    NULL::boolean AS "is_special_order",
    NULL::text AS "note",
    NULL::numeric(19,4) AS "employee_id",
    NULL::numeric(19,4) AS "sale_line_id",
    NULL::numeric(19,4) AS "sale_id",
    NULL::numeric(19,4) AS "item_id",
    NULL::numeric(19,4) AS "discount_id",
    NULL::timestamptz AS "time_stamp",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_workorder_items TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_workorder_items');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_workorder_statuses') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_workorder_statuses AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "workorder_status_id",
    NULL::text AS "name",
    NULL::numeric(19,4) AS "sort_order",
    NULL::text AS "html_color",
    NULL::text AS "system_value",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_workorder_statuses TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_workorder_statuses');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_workorder_images') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_workorder_images AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "workorder_image_id",
    NULL::numeric(19,4) AS "workorder_id",
    NULL::text AS "description",
    NULL::text AS "filename",
    NULL::numeric(19,4) AS "ordering",
    NULL::text AS "public_id",
    NULL::text AS "base_image_url",
    NULL::numeric(19,4) AS "size",
    NULL::timestamptz AS "create_time",
    NULL::timestamptz AS "time_stamp",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_workorder_images TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_workorder_images');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_shops') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_shops AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "shop_id",
    NULL::text AS "name",
    NULL::numeric(19,4) AS "service_rate",
    NULL::text AS "time_zone",
    NULL::boolean AS "tax_labor",
    NULL::text AS "label_title",
    NULL::boolean AS "label_msrp",
    NULL::boolean AS "archived",
    NULL::numeric(19,4) AS "contact_id",
    NULL::numeric(19,4) AS "tax_category_id",
    NULL::numeric(19,4) AS "receipt_setup_id",
    NULL::numeric(19,4) AS "cc_gateway_id",
    NULL::numeric(19,4) AS "price_level_id",
    NULL::jsonb AS "contact",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_shops TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_shops');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_registers') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_registers AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "register_id",
    NULL::text AS "name",
    NULL::boolean AS "open",
    NULL::timestamptz AS "open_time",
    NULL::boolean AS "tip_enabled",
    NULL::numeric(19,4) AS "open_employee_id",
    NULL::numeric(19,4) AS "shop_id",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_registers TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_registers');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_employees') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_employees AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "employee_id",
    NULL::text AS "first_name",
    NULL::text AS "last_name",
    NULL::boolean AS "lock_out",
    NULL::boolean AS "archived",
    NULL::numeric(19,4) AS "contact_id",
    NULL::numeric(19,4) AS "clock_in_employee_hours_id",
    NULL::numeric(19,4) AS "employee_role_id",
    NULL::numeric(19,4) AS "limit_to_shop_id",
    NULL::numeric(19,4) AS "last_shop_id",
    NULL::numeric(19,4) AS "last_sale_id",
    NULL::numeric(19,4) AS "last_register_id",
    NULL::timestamptz AS "time_stamp",
    NULL::jsonb AS "contact",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_employees TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_employees');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_employee_roles') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_employee_roles AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "employee_role_id",
    NULL::text AS "name",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_employee_roles TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_employee_roles');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_employee_role_rights') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_employee_role_rights AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "employee_role_id",
    NULL::numeric(19,4) AS "employee_right_id",
    NULL::text AS "name",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_employee_role_rights TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_employee_role_rights');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_employee_rights') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_employee_rights AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "employee_id",
    NULL::numeric(19,4) AS "employee_right_id",
    NULL::text AS "name",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_employee_rights TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_employee_rights');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_employee_hours') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_employee_hours AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "employee_hours_id",
    NULL::timestamptz AS "check_in",
    NULL::timestamptz AS "check_out",
    NULL::numeric(19,4) AS "employee_id",
    NULL::numeric(19,4) AS "shop_id",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_employee_hours TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_employee_hours');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_session') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_session AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "session_id",
    NULL::text AS "session_cookie",
    NULL::numeric(19,4) AS "employee_id",
    NULL::numeric(19,4) AS "system_customer_id",
    NULL::numeric(19,4) AS "system_user_id",
    NULL::numeric(19,4) AS "system_api_client_id",
    NULL::numeric(19,4) AS "system_api_key_id",
    NULL::text AS "ecom_url",
    NULL::numeric(19,4) AS "shop_count",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_session TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_session');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_account') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_account AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "account_id",
    NULL::text AS "name",
    NULL::text AS "link",
    NULL::numeric(19,4) AS "system_customer_id",
    NULL::text AS "status",
    NULL::numeric(19,4) AS "employee_count",
    NULL::numeric(19,4) AS "employee_limit",
    NULL::text AS "unique_subscription_identifier",
    NULL::text AS "code",
    NULL::text AS "symbol",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_account TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_account');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_account_purchasing_currencies') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_account_purchasing_currencies AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "account_id",
    NULL::text AS "code",
    NULL::text AS "symbol",
    NULL::numeric(19,4) AS "rate",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_account_purchasing_currencies TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_account_purchasing_currencies');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_locales') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_locales AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::text AS "name",
    NULL::text AS "country",
    NULL::text AS "states",
    NULL::text AS "currency_symbol",
    NULL::text AS "currency_code",
    NULL::numeric(19,4) AS "currency_precision",
    NULL::numeric(19,4) AS "cash_rounding_precision",
    NULL::boolean AS "include_tax_on_labels",
    NULL::text AS "language_tag",
    NULL::text AS "date_format",
    NULL::text AS "datetime_format",
    NULL::text AS "tax_name1",
    NULL::text AS "tax_name2",
    NULL::jsonb AS "currency_denominations",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_locales TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_locales');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_industries') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_industries AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "industry_id",
    NULL::text AS "name",
    NULL::boolean AS "enabled",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_industries TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_industries');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_cc_gateways') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_cc_gateways AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "cc_gateway_id",
    NULL::text AS "gateway",
    NULL::boolean AS "enabled",
    NULL::boolean AS "test_mode",
    NULL::boolean AS "allow_credits",
    NULL::text AS "market_type",
    NULL::numeric(19,4) AS "device_type",
    NULL::text AS "terminal_num",
    NULL::text AS "login",
    NULL::text AS "trans_key",
    NULL::text AS "account_num",
    NULL::text AS "hash_value",
    NULL::text AS "other_credentials1",
    NULL::text AS "other_credentials2",
    NULL::numeric(19,4) AS "visa_payment_type_id",
    NULL::numeric(19,4) AS "master_payment_type_id",
    NULL::numeric(19,4) AS "discover_payment_type_id",
    NULL::numeric(19,4) AS "american_payment_type_id",
    NULL::numeric(19,4) AS "debit_payment_type_id",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_cc_gateways TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_cc_gateways');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_receipt_setups') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_receipt_setups AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "receipt_setup_id",
    NULL::text AS "header",
    NULL::text AS "general_msg",
    NULL::text AS "workorder_agree",
    NULL::text AS "creditcard_agree",
    NULL::text AS "logo",
    NULL::numeric(19,4) AS "logo_height",
    NULL::numeric(19,4) AS "logo_width",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_receipt_setups TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_receipt_setups');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_currency_rates') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_currency_rates AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "currency_rate_id",
    NULL::text AS "currency_code",
    NULL::numeric(19,4) AS "rate",
    NULL::timestamptz AS "create_time",
    NULL::timestamptz AS "time_stamp",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_currency_rates TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_currency_rates');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_currency_denominations') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_currency_denominations AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "locale_id",
    NULL::numeric(19,4) AS "currency_denominations",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_currency_denominations TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_currency_denominations');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_register_counts') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_register_counts AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "register_count_id",
    NULL::timestamptz AS "create_time",
    NULL::timestamptz AS "open_time",
    NULL::text AS "notes",
    NULL::numeric(19,4) AS "register_id",
    NULL::numeric(19,4) AS "open_employee_id",
    NULL::numeric(19,4) AS "close_employee_id",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_register_counts TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_register_counts');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_register_count_amounts') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_register_count_amounts AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "register_count_amount_id",
    NULL::numeric(19,4) AS "register_count_id",
    NULL::numeric(19,4) AS "payment_type_id",
    NULL::numeric(19,4) AS "calculated",
    NULL::numeric(19,4) AS "actual",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_register_count_amounts TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_register_count_amounts');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_register_withdraws') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_register_withdraws AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "register_withdraw_id",
    NULL::numeric(19,4) AS "amount",
    NULL::timestamptz AS "create_time",
    NULL::text AS "notes",
    NULL::numeric(19,4) AS "employee_id",
    NULL::numeric(19,4) AS "payment_type_id",
    NULL::numeric(19,4) AS "register_id",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_register_withdraws TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_register_withdraws');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_register_calculated') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_register_calculated AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "register_calculated_path_parameter_register_id",
    NULL::numeric(19,4) AS "payment_type_id",
    NULL::numeric(19,4) AS "payment",
    NULL::numeric(19,4) AS "add",
    NULL::numeric(19,4) AS "withdraw",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_register_calculated TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_register_calculated');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_tax_categories') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_tax_categories AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "tax_category_id",
    NULL::boolean AS "is_tax_inclusive",
    NULL::text AS "tax1_name",
    NULL::text AS "tax2_name",
    NULL::numeric(19,4) AS "tax1_rate",
    NULL::numeric(19,4) AS "tax2_rate",
    NULL::timestamptz AS "time_stamp",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_tax_categories TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_tax_categories');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_tax_category_classes') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_tax_category_classes AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "tax_category_id",
    NULL::numeric(19,4) AS "tax_category_class_id",
    NULL::numeric(19,4) AS "tax_class_id",
    NULL::numeric(19,4) AS "tax1_rate",
    NULL::numeric(19,4) AS "tax2_rate",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_tax_category_classes TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_tax_category_classes');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_tax_classes') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_tax_classes AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "tax_class_id",
    NULL::text AS "name",
    NULL::timestamptz AS "time_stamp",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_tax_classes TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_tax_classes');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_payment_types') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_payment_types AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::numeric(19,4) AS "payment_type_id",
    NULL::text AS "name",
    NULL::boolean AS "require_customer",
    NULL::boolean AS "archived",
    NULL::boolean AS "internal_reserved",
    NULL::text AS "type",
    NULL::numeric(19,4) AS "refund_as_payment_type_id",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_payment_types TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_payment_types');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_report_payments_by_day') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_report_payments_by_day AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::date AS "date",
    NULL::numeric(19,4) AS "shop_id",
    NULL::boolean AS "layaway",
    NULL::numeric(19,4) AS "amount",
    NULL::text AS "payment_type_name",
    NULL::numeric(19,4) AS "payment_type_id",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_report_payments_by_day TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_report_payments_by_day');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_report_taxes_by_day') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_report_taxes_by_day AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::date AS "date",
    NULL::numeric(19,4) AS "shop_id",
    NULL::numeric(19,4) AS "tax_category_id",
    NULL::text AS "tax_category_name",
    NULL::numeric(19,4) AS "tax",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_report_taxes_by_day TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_report_taxes_by_day');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_report_discounts_by_day') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_report_discounts_by_day AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::date AS "date",
    NULL::numeric(19,4) AS "shop_id",
    NULL::numeric(19,4) AS "discount",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_report_discounts_by_day TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_report_discounts_by_day');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_report_tax_class_sales_by_day') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_report_tax_class_sales_by_day AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::date AS "date",
    NULL::numeric(19,4) AS "shop_id",
    NULL::numeric(19,4) AS "tax_class_id",
    NULL::text AS "tax_class_name",
    NULL::numeric(19,4) AS "subtotal",
    NULL::numeric(19,4) AS "fifo_cost",
    NULL::numeric(19,4) AS "avg_cost",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_report_tax_class_sales_by_day TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_report_tax_class_sales_by_day');
END $$;
DO $$
BEGIN
  IF to_regclass('source_lightspeed_fivetran.ls_report_orders_by_tax_class') IS NULL THEN
    EXECUTE $view$
CREATE VIEW source_lightspeed_fivetran.ls_report_orders_by_tax_class AS
  SELECT
    NULL::text AS tenant_id,
    NULL::text AS source_record_id,
    NULL::timestamptz AS source_updated_at,
    NULL::boolean AS tombstone,
    NULL::timestamptz AS _albert_synced_at,
    NULL::date AS "date",
    NULL::numeric(19,4) AS "shop_id",
    NULL::numeric(19,4) AS "vendor_id",
    NULL::text AS "vendor_name",
    NULL::numeric(19,4) AS "tax_class_id",
    NULL::text AS "tax_class_name",
    NULL::numeric(19,4) AS "cost",
    NULL::numeric(19,4) AS "order_id",
    NULL::numeric(19,4) AS "total_ship_cost",
    NULL::numeric(19,4) AS "total_other_cost",
    NULL::text AS namespaced_source_key
  WHERE false
    $view$;
    GRANT SELECT ON source_lightspeed_fivetran.ls_report_orders_by_tax_class TO transform_rw, diagnostic_ro;
  END IF;
  PERFORM ingestion.rebuild_lightspeed_official_view('ls_report_orders_by_tax_class');
END $$;

-- 4. Fold in anything already landed, then verify the surface -----------------------

DO $$
DECLARE binding record;
BEGIN
  FOR binding IN
    SELECT destination_schema, tenant_id FROM ingestion.fivetran_destination_bindings
     WHERE retired_at IS NULL AND destination_schema LIKE 'lightspeed\_%'
  LOOP
    PERFORM ingestion.stamp_fivetran_destination(binding.destination_schema, binding.tenant_id);
  END LOOP;
END $$;
SELECT ingestion.rebuild_fivetran_source_views('lightspeed');

GRANT USAGE ON SCHEMA source_lightspeed_official TO semantic_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA source_lightspeed_official TO semantic_ro;

DO $$
DECLARE view_count integer; missing text;
BEGIN
  SELECT count(*) INTO view_count
    FROM pg_views WHERE schemaname = 'source_lightspeed_official' AND viewname LIKE 'ls\_%';
  IF view_count <> 90 THEN
    RAISE EXCEPTION 'expected 90 ls_ official views, found %', view_count;
  END IF;
  SELECT string_agg(name, ', ') INTO missing FROM (
    SELECT viewname AS name FROM pg_views WHERE schemaname = 'source_lightspeed_official'
    EXCEPT
    SELECT viewname FROM pg_views WHERE schemaname = 'source_lightspeed_fivetran'
  ) AS orphan;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'official views without a union view: %', missing;
  END IF;
  -- The envelope Cube reads is present on every official view.
  IF EXISTS (
    SELECT 1 FROM pg_views v
     WHERE v.schemaname = 'source_lightspeed_official'
       AND NOT (
         EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = v.schemaname AND c.table_name = v.viewname AND c.column_name = 'mapping_version')
         AND EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = v.schemaname AND c.table_name = v.viewname AND c.column_name = 'ingested_at')
         AND EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = v.schemaname AND c.table_name = v.viewname AND c.column_name = 'tombstone')
       )
  ) THEN
    RAISE EXCEPTION 'an official view lacks the Cube envelope (mapping_version, ingested_at, tombstone)';
  END IF;
END $$;

COMMIT;
