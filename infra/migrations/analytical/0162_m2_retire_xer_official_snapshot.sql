-- Retires the dlt-loaded XER_OFFICIAL snapshot and the single-tenant scaffolding
-- around it, completing the move of the Xero data home to the connector-owned
-- source_xero staging (restored in 0160, viewed through 0161).
--
-- After this migration every byte of Xero data lives in tables that carry
-- tenant_id + connection_id, so a disconnect purge (repaired in 0159) removes
-- all of it. While XER_OFFICIAL existed, its rows were invisible to deletion:
-- no purge function referenced the schema and its tables carry no connection
-- scoping.
--
-- Role note: XER_OFFICIAL is owned by the postgres role (dlt created it), not
-- albert_migration_owner, so this migration must be applied as postgres
-- (Supabase SQL editor / MCP apply_migration) — the cutover operator role
-- cannot drop it.
--
-- Apply order is enforced, not assumed: this migration refuses to run while
-- any source_xero_official view still reads XER_OFFICIAL, the hard-coded
-- tenant_binding, or the xero_ts() dlt timestamp shim — i.e. before 0161 has
-- been applied. It also refuses while source_xero is missing (0160 unapplied),
-- so it can never leave the xo_* contract reading nothing.

BEGIN;

DO $$
DECLARE offender text;
BEGIN
  IF to_regnamespace('source_xero') IS NULL THEN
    RAISE EXCEPTION 'source_xero staging is missing; apply 0160 before retiring XER_OFFICIAL';
  END IF;

  SELECT string_agg(viewname, ', ') INTO offender
  FROM pg_views
  WHERE schemaname = 'source_xero_official'
    AND (definition ~ 'XER_OFFICIAL'
      OR definition ~ 'tenant_binding'
      OR definition ~ 'xero_ts');
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION
      'views still read the retired snapshot (apply 0161 first): %', offender;
  END IF;
END $$;

DROP SCHEMA IF EXISTS "XER_OFFICIAL" CASCADE;
DROP TABLE IF EXISTS source_xero_official.tenant_binding;
DROP FUNCTION IF EXISTS source_xero_official.xero_ts(text);

COMMIT;
