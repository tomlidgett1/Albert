BEGIN;

-- Migration 0007 removed Supabase's broad service_role authority in favour of
-- Albert's purpose-specific NOLOGIN runtime groups. Historical migrations
-- 0073 and 0086 later reintroduced these two direct function grants. Revoke
-- the exact migration-owned capabilities; administrator-owned attestation
-- objects remain outside the application migration role's authority.
REVOKE EXECUTE ON FUNCTION
  control_plane.enqueue_due_incremental_syncs(timestamptz),
  control_plane.is_known_connector(text)
FROM service_role;

COMMIT;
