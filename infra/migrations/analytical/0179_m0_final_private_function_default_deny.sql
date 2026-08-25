-- Reassert the V3 private-function boundary after the Fivetran migrations.
-- Explicit runtime grants remain intact; only implicit PUBLIC/service access
-- is removed from analytical implementation schemas.

BEGIN;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA
  ingestion,quality,semantic_internal,deletion_internal,capability_internal
  FROM PUBLIC,service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner
  IN SCHEMA ingestion
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner
  IN SCHEMA quality
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner
  IN SCHEMA semantic_internal
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner
  IN SCHEMA deletion_internal
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner
  IN SCHEMA capability_internal
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMIT;
