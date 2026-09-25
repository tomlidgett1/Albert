-- The session claim function is SECURITY DEFINER so the Anthropic runtime
-- cannot read conversations or turns directly. The session tables FORCE RLS,
-- which means the migration owner executing that function must also satisfy
-- the same tenant policy as the runtime role. Keep both identities scoped to
-- the server-captured tenant setting; no cross-tenant policy is introduced.

BEGIN;

ALTER POLICY anthropic_sessions_tenant_runtime
  ON control_plane.anthropic_conversation_sessions
  TO albert_anthropic_control, albert_control_migration_owner
  USING (tenant_id=current_setting('albert.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('albert.tenant_id',true));

ALTER POLICY anthropic_entries_tenant_runtime
  ON control_plane.anthropic_session_entries
  TO albert_anthropic_control, albert_control_migration_owner
  USING (tenant_id=current_setting('albert.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('albert.tenant_id',true));

COMMIT;
