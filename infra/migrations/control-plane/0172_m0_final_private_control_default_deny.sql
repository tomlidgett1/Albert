-- Functions added after 0105 inherited PostgreSQL's PUBLIC EXECUTE default.
-- Albert's customer RPCs live in public; control_plane remains private and is
-- callable only through explicit, least-privilege runtime grants.

BEGIN;

REVOKE USAGE ON SCHEMA control_plane FROM PUBLIC,anon,authenticated,service_role;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA control_plane
  FROM PUBLIC,anon,authenticated,service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE albert_control_migration_owner
  IN SCHEMA control_plane
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE albert_control_migration_owner
  IN SCHEMA control_plane
  REVOKE EXECUTE ON FUNCTIONS FROM service_role;
NOTIFY pgrst, 'reload schema';

COMMIT;
