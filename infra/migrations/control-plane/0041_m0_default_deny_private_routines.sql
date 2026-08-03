BEGIN;

-- PostgreSQL grants EXECUTE on newly created functions to PUBLIC unless the
-- creating role has a matching default-privilege rule. Reassert that invariant
-- for the exact migration owner and remove any privilege inherited by public
-- API roles from routines introduced after the original isolation migration.
-- Existing explicit per-function grants are the reviewed public RPC surface;
-- do not erase them here. Revoking PUBLIC removes PostgreSQL's implicit grant
-- (including the authority anon/authenticated/service_role inherited through
-- PUBLIC) while preserving those exact grants.
ALTER DEFAULT PRIVILEGES FOR ROLE albert_control_migration_owner
  IN SCHEMA control_plane
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA control_plane FROM PUBLIC;

COMMIT;
