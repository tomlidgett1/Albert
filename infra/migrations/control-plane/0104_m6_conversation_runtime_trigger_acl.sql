BEGIN;

-- Trigger functions receive PUBLIC EXECUTE by default. The runtime-lock
-- trigger is invoked only by PostgreSQL and must not be a callable private
-- control-plane capability for Supabase or any Albert runtime role.
REVOKE ALL ON FUNCTION control_plane.enforce_conversation_runtime_lock()
FROM PUBLIC,anon,authenticated,service_role,
  albert_sync_control,albert_webhook_control,albert_transform_control,
  albert_semantic_control,albert_anthropic_control,albert_deletion_control,
  albert_operator_diagnostic_control;

COMMIT;
