\set ON_ERROR_STOP on

-- V3 has no core.* or mart layer. Prove least privilege on the typed staging
-- and Cube-facing official surfaces that production actually queries.
DO $$
DECLARE
  role_name text;
  role_record record;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'ingest_rw','transform_rw','semantic_ro','semantic_meta_rw',
    'diagnostic_ro','deletion_rw'
  ]
  LOOP
    SELECT * INTO role_record
      FROM pg_catalog.pg_roles
     WHERE rolname = role_name;
    IF role_record IS NULL
       OR role_record.rolcanlogin
       OR role_record.rolinherit
       OR role_record.rolsuper
       OR role_record.rolcreaterole
       OR role_record.rolcreatedb
       OR role_record.rolreplication
       OR role_record.rolbypassrls THEN
      RAISE EXCEPTION 'analytical group % has unsafe role attributes', role_name;
    END IF;
  END LOOP;
END;
$$;

DO $$
BEGIN
  IF to_regclass('core.product') IS NOT NULL
     OR to_regnamespace('mart') IS NOT NULL THEN
    RAISE EXCEPTION 'retired canonical or mart surface was recreated';
  END IF;

  IF NOT has_schema_privilege('ingest_rw','source_xero','USAGE')
     OR NOT has_table_privilege('ingest_rw','source_xero.xero_currencies','SELECT,INSERT,UPDATE')
     OR has_table_privilege('ingest_rw','source_xero.xero_currencies','DELETE') THEN
    RAISE EXCEPTION 'ingest_rw staging privileges are not exact';
  END IF;

  IF NOT has_table_privilege('transform_rw','source_xero.xero_currencies','SELECT')
     OR has_table_privilege('transform_rw','source_xero.xero_currencies','INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'transform_rw must remain read-only on typed staging';
  END IF;

  IF NOT has_table_privilege('semantic_ro','source_xero_official.xo_accounts','SELECT')
     OR has_table_privilege('semantic_ro','source_xero.xero_currencies','INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'semantic_ro privileges do not match the V3 Cube surface';
  END IF;

  IF NOT has_table_privilege('diagnostic_ro','source_xero.xero_currencies','SELECT')
     OR has_table_privilege('diagnostic_ro','source_xero.xero_currencies','INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'diagnostic_ro must remain read-only';
  END IF;

  IF has_table_privilege('deletion_rw','source_xero.xero_currencies','SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'deletion_rw gained direct staging-table authority';
  END IF;
END;
$$;

DO $$
DECLARE exposed record;
BEGIN
  SELECT namespace.nspname AS schema_name,procedure.proname AS function_name
    INTO exposed
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=procedure.pronamespace
   WHERE namespace.nspname IN (
     'ingestion','source_lightspeed','source_xero','source_deputy',
     'source_xero_official','quality','semantic_internal','deletion_internal'
   )
     AND procedure.prosecdef
     AND pg_catalog.has_function_privilege('public',procedure.oid,'EXECUTE')
   LIMIT 1;
  IF exposed IS NOT NULL THEN
    RAISE EXCEPTION 'protected SECURITY DEFINER %.% remains executable by PUBLIC',
      exposed.schema_name,exposed.function_name;
  END IF;
END;
$$;
