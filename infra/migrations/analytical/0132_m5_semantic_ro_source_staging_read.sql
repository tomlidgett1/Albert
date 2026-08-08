-- M5: let the conversation agent read typed Lightspeed/Xero/Deputy staging.
-- Staging is already FORCE RLS'd on tenant_id via ingestion.current_tenant_id().
-- semantic_ro previously had no USAGE/SELECT on source_* and could not execute
-- that verifier, so run_sql / run_source_query always failed at the privilege layer.

BEGIN;

GRANT USAGE ON SCHEMA source_lightspeed, source_xero, source_deputy TO semantic_ro;

GRANT SELECT ON ALL TABLES IN SCHEMA source_lightspeed TO semantic_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA source_xero TO semantic_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA source_deputy TO semantic_ro;

ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner IN SCHEMA source_lightspeed
  GRANT SELECT ON TABLES TO semantic_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner IN SCHEMA source_xero
  GRANT SELECT ON TABLES TO semantic_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner IN SCHEMA source_deputy
  GRANT SELECT ON TABLES TO semantic_ro;

GRANT EXECUTE ON FUNCTION ingestion.current_tenant_id() TO semantic_ro;

COMMIT;
