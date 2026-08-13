-- ADR 0083: SECURITY DEFINER dashboard RPCs execute as the migration owner.
-- FORCE ROW LEVEL SECURITY therefore needs an internal-only policy; browser
-- roles retain no table grants or policies and can use only the vetted RPCs.

BEGIN;

CREATE POLICY dashboard_migration_role_access
  ON control_plane.personal_dashboards
  FOR ALL TO albert_control_migration_owner
  USING (true) WITH CHECK (true);

CREATE POLICY dashboard_tiles_migration_role_access
  ON control_plane.dashboard_tiles
  FOR ALL TO albert_control_migration_owner
  USING (true) WITH CHECK (true);

CREATE POLICY dashboard_refresh_events_migration_role_access
  ON control_plane.dashboard_refresh_events
  FOR ALL TO albert_control_migration_owner
  USING (true) WITH CHECK (true);

COMMIT;
