BEGIN;

-- Migration 0007 removed Supabase's broad service_role authority in favour of
-- Albert's purpose-specific NOLOGIN runtime groups. Two later historical
-- migrations temporarily reintroduced direct function grants, and every new
-- object must be covered by the same final-state deny. No production Albert
-- process authenticates as service_role.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA control_plane FROM service_role;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA control_plane FROM service_role;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA control_plane FROM service_role;
REVOKE USAGE ON SCHEMA control_plane FROM service_role;

COMMIT;
