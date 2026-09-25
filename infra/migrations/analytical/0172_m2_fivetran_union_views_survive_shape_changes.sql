-- 0172: Fivetran union views survive landed-shape changes.
--
-- Found live on 2026-08-18: Ashburton's Xero Fivetran schema
-- (xero_01m079hp61gf295zwkx3s2ew35) held ~140k rows across 203 tables, yet 28
-- of the source_xero_fivetran union views Cube reads through — invoices,
-- invoice line items, manual journals, payments, repeating invoices, the P&L
-- report lines — were still the typed empty stubs (`SELECT NULL::… WHERE
-- false`). Every governed Xero query returned zero rows while the live Xero
-- statement showed a $3.7k Subscriptions line the owner could not drill into.
--
-- Cause: rebuild_fivetran_source_views() rebuilds non-Lightspeed unions with
-- CREATE OR REPLACE VIEW, and Fivetran appends control columns to landed
-- tables over time (`_fivetran_deleted` appears with the first soft delete).
-- The regenerated select list then carries a new column BEFORE the trailing
-- namespaced_source_key, and PostgreSQL refuses to reorder view columns:
--   42P16 cannot change name of view column "namespaced_source_key" to "_fivetran_deleted"
-- The rebuild swallowed that error, left the table out of rebuilt_tables, and
-- the "stale union" pass then rewrote the view as an empty stub — silently and
-- permanently, on every sync.
--
-- Fix:
--   * ingestion.recreate_view_with_dependents(schema, name, body): drops the
--     view CASCADE and re-creates it, then re-creates every dependent view
--     (recursively, in dependency order) from its saved definition with its
--     owner, reloptions (security_barrier), grants and comment restored. The
--     Cube contract views (source_xero_official.xo_*, source_deputy_*) depend
--     on the unions and come back byte-identical.
--   * rebuild_fivetran_source_views() v4: CREATE OR REPLACE first; on the
--     column-shape errors (42P16 invalid_table_definition, 42804
--     datatype_mismatch, 0A000 feature_not_supported) fall back to the
--     drop-and-restore path instead of giving up. A failed rebuild is no
--     longer silent: it raises, so the sync worker's call surfaces it.
--   * Re-run the rebuild for xero and deputy so the live stubs are replaced now.

BEGIN;

DO $$
BEGIN
  IF NOT pg_has_role('albert_migration_owner', 'fivetran_user', 'MEMBER') THEN
    RAISE EXCEPTION 'run "GRANT fivetran_user TO albert_migration_owner" as postgres before applying 0172';
  END IF;
END $$;

-- 1. Drop-and-restore helper ----------------------------------------------------

CREATE OR REPLACE FUNCTION ingestion.recreate_view_with_dependents(
  p_schema text,
  p_view text,
  p_body text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  target regclass;
  dependent record;
  acl record;
  saved record;
  restored integer := 0;
  saved_views jsonb := '[]'::jsonb;
BEGIN
  IF p_schema IS NULL OR p_schema !~ '^[a-z][a-z0-9_]{0,62}$'
     OR p_view IS NULL OR p_view !~ '^[a-z][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'view identifier is invalid' USING ERRCODE = '22023';
  END IF;
  target := to_regclass(format('%I.%I', p_schema, p_view));

  IF target IS NOT NULL THEN
    -- Every view that (transitively) selects from the target, deepest last so
    -- re-creation can proceed in the same order.
    FOR dependent IN
      WITH RECURSIVE deps AS (
        SELECT class.oid, 1 AS depth
          FROM pg_catalog.pg_depend AS dep
          JOIN pg_catalog.pg_rewrite AS rewrite ON rewrite.oid = dep.objid
          JOIN pg_catalog.pg_class AS class ON class.oid = rewrite.ev_class
         WHERE dep.classid = 'pg_rewrite'::regclass
           AND dep.refclassid = 'pg_class'::regclass
           AND dep.refobjid = target
           AND class.oid <> target
        UNION
        SELECT class.oid, deps.depth + 1
          FROM deps
          JOIN pg_catalog.pg_depend AS dep ON dep.refobjid = deps.oid
          JOIN pg_catalog.pg_rewrite AS rewrite ON rewrite.oid = dep.objid
          JOIN pg_catalog.pg_class AS class ON class.oid = rewrite.ev_class
         WHERE dep.classid = 'pg_rewrite'::regclass
           AND dep.refclassid = 'pg_class'::regclass
           AND class.oid <> deps.oid
           AND deps.depth < 32
      )
      SELECT class.oid,
             namespace.nspname AS schema_name,
             class.relname AS view_name,
             class.relkind,
             pg_get_userbyid(class.relowner) AS owner_name,
             class.reloptions,
             class.relacl,
             obj_description(class.oid, 'pg_class') AS comment_text,
             pg_get_viewdef(class.oid, true) AS definition,
             max(deps.depth) AS depth
        FROM deps
        JOIN pg_catalog.pg_class AS class ON class.oid = deps.oid
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
       GROUP BY class.oid, namespace.nspname, class.relname, class.relkind, class.relowner, class.reloptions, class.relacl
       ORDER BY max(deps.depth), namespace.nspname, class.relname
    LOOP
      IF dependent.relkind <> 'v' THEN
        RAISE EXCEPTION 'cannot rebuild %.%: dependent %.% is not a plain view (relkind %)',
          p_schema, p_view, dependent.schema_name, dependent.view_name, dependent.relkind
          USING ERRCODE = '55006';
      END IF;
      saved_views := saved_views || jsonb_build_object(
        'schema', dependent.schema_name,
        'name', dependent.view_name,
        'owner', dependent.owner_name,
        'reloptions', to_jsonb(dependent.reloptions),
        'acl', dependent.relacl::text,
        'comment', dependent.comment_text,
        'definition', dependent.definition
      );
    END LOOP;

    EXECUTE format('DROP VIEW %I.%I CASCADE', p_schema, p_view);
  END IF;

  EXECUTE format('CREATE VIEW %I.%I AS %s', p_schema, p_view, p_body);

  FOR saved IN
    SELECT value->>'schema' AS schema_name,
           value->>'name' AS view_name,
           value->>'owner' AS owner_name,
           (SELECT array_agg(elem) FROM jsonb_array_elements_text(COALESCE(value->'reloptions', '[]'::jsonb)) AS elem) AS reloptions,
           value->>'acl' AS acl_text,
           value->>'comment' AS comment_text,
           value->>'definition' AS definition
      FROM jsonb_array_elements(saved_views) AS entries(value)
  LOOP
    IF saved.reloptions IS NULL OR array_length(saved.reloptions, 1) IS NULL THEN
      EXECUTE format('CREATE VIEW %I.%I AS %s', saved.schema_name, saved.view_name, saved.definition);
    ELSE
      EXECUTE format('CREATE VIEW %I.%I WITH (%s) AS %s',
                     saved.schema_name, saved.view_name,
                     array_to_string(saved.reloptions, ', '), saved.definition);
    END IF;
    EXECUTE format('ALTER VIEW %I.%I OWNER TO %I', saved.schema_name, saved.view_name, saved.owner_name);
    IF saved.acl_text IS NOT NULL THEN
      FOR acl IN
        SELECT grantee, privilege_type, is_grantable
          FROM aclexplode(saved.acl_text::aclitem[])
      LOOP
        IF acl.grantee = 0 THEN
          EXECUTE format('GRANT %s ON %I.%I TO PUBLIC%s', acl.privilege_type, saved.schema_name, saved.view_name,
                         CASE WHEN acl.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
        ELSIF pg_get_userbyid(acl.grantee) <> saved.owner_name THEN
          EXECUTE format('GRANT %s ON %I.%I TO %I%s', acl.privilege_type, saved.schema_name, saved.view_name,
                         pg_get_userbyid(acl.grantee),
                         CASE WHEN acl.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
        END IF;
      END LOOP;
    END IF;
    IF saved.comment_text IS NOT NULL THEN
      EXECUTE format('COMMENT ON VIEW %I.%I IS %L', saved.schema_name, saved.view_name, saved.comment_text);
    END IF;
    restored := restored + 1;
  END LOOP;
  RETURN restored;
END;
$$;
REVOKE ALL ON FUNCTION ingestion.recreate_view_with_dependents(text, text, text) FROM PUBLIC;

-- 2. Union-view builder v4 ---------------------------------------------------------

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
  union_body text;
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
    union_body := array_to_string(branches, ' UNION ALL ');
    IF p_prefix = 'lightspeed' THEN
      -- Seed views and first landings differ in type; the official twin
      -- depends on the union view, so both are rebuilt in one step.
      IF table_name LIKE 'ls\_%' THEN
        EXECUTE format('DROP VIEW IF EXISTS source_lightspeed_official.%I', table_name);
      END IF;
      EXECUTE format('DROP VIEW IF EXISTS %I.%I', target_schema, table_name);
      EXECUTE format('CREATE VIEW %I.%I AS %s', target_schema, table_name, union_body);
      EXECUTE format('GRANT SELECT ON %I.%I TO transform_rw, diagnostic_ro', target_schema, table_name);
      IF table_name LIKE 'ls\_%' THEN
        PERFORM ingestion.rebuild_lightspeed_official_view(table_name);
      END IF;
    ELSE
      -- Cheap path when the column list is unchanged or only grew at the end;
      -- otherwise (a landed table gained a column mid-list, or a type moved
      -- between the seed and the first landing) drop and re-create, restoring
      -- every dependent contract view. Never swallow: a union that cannot be
      -- rebuilt must fail the sync loudly, not read nothing.
      BEGIN
        EXECUTE format('CREATE OR REPLACE VIEW %I.%I AS %s', target_schema, table_name, union_body);
      EXCEPTION
        WHEN feature_not_supported OR invalid_table_definition OR datatype_mismatch OR undefined_column THEN
          PERFORM ingestion.recreate_view_with_dependents(target_schema, table_name, union_body);
      END;
      EXECUTE format('GRANT SELECT ON %I.%I TO transform_rw, diagnostic_ro', target_schema, table_name);
    END IF;
    rebuilt := rebuilt + 1;
    rebuilt_tables := rebuilt_tables || table_name;
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
    EXECUTE format('CREATE OR REPLACE VIEW %I.%I AS SELECT %s WHERE false', target_schema, stale.name, stub_list);
  END LOOP;
  RETURN rebuilt;
END;
$$;
REVOKE ALL ON FUNCTION ingestion.rebuild_fivetran_source_views(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingestion.rebuild_fivetran_source_views(text) TO ingest_rw;

-- 3. Replace the live stubs now -----------------------------------------------------

SELECT ingestion.rebuild_fivetran_source_views('xero');
SELECT ingestion.rebuild_fivetran_source_views('deputy');

-- 4. Proof: no union view an active binding lands data for may remain a stub -----------

DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(target_ns.nspname || '.' || class.relname, ', ' ORDER BY class.relname)
    INTO offenders
    FROM pg_catalog.pg_class AS class
    JOIN pg_catalog.pg_namespace AS target_ns ON target_ns.oid = class.relnamespace
   WHERE class.relkind = 'v'
     AND target_ns.nspname IN ('source_xero_fivetran', 'source_deputy_fivetran')
     AND pg_get_viewdef(class.oid) LIKE '%WHERE false%'
     AND EXISTS (
       SELECT 1
         FROM ingestion.fivetran_destination_bindings AS binding
         JOIN pg_catalog.pg_namespace AS landed_ns ON landed_ns.nspname = binding.destination_schema
         JOIN pg_catalog.pg_class AS landed ON landed.relnamespace = landed_ns.oid
          AND landed.relkind = 'r' AND landed.relname = class.relname
        WHERE binding.retired_at IS NULL
          AND binding.destination_schema LIKE regexp_replace(target_ns.nspname, '^source_(.*)_fivetran$', '\1') || '\_%'
     );
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION '0172: union views still stubbed despite landed tables: %', offenders;
  END IF;
END $$;

COMMIT;
