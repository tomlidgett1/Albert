-- Functions added after 0105 inherited PostgreSQL's PUBLIC EXECUTE default.
-- Albert's customer RPCs live in public; control_plane remains private and is
-- callable only through explicit, least-privilege runtime grants.

BEGIN;

REVOKE USAGE ON SCHEMA control_plane FROM PUBLIC,anon,authenticated,service_role;

DO $deny$
DECLARE
  routine regprocedure;
BEGIN
  FOR routine IN
    SELECT procedure.oid::regprocedure
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = procedure.pronamespace
     WHERE namespace.nspname = 'control_plane'
       AND procedure.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',
      routine
    );
  END LOOP;
END
$deny$;

ALTER DEFAULT PRIVILEGES FOR ROLE albert_control_migration_owner
  IN SCHEMA control_plane
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE albert_control_migration_owner
  IN SCHEMA control_plane
  REVOKE EXECUTE ON FUNCTIONS FROM service_role;
NOTIFY pgrst, 'reload schema';

COMMIT;
