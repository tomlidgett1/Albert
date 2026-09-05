BEGIN;

-- The Semantic V2 finalizer records clarification and unavailable outcomes in
-- the semantic inbox after the security-definer artifact finalization call.
-- Permit that runtime to read only the active tenant's turn question so it can
-- derive a stable, non-reversible question digest. The role receives no write
-- access to conversation turns.
GRANT SELECT ON TABLE control_plane.conversation_turns
  TO albert_semantic_control;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'control_plane'
       AND tablename = 'conversation_turns'
       AND policyname = 'conversation_turns_semantic_v2_terminal_read'
  ) THEN
    CREATE POLICY conversation_turns_semantic_v2_terminal_read
      ON control_plane.conversation_turns
      FOR SELECT
      TO albert_semantic_control
      USING (tenant_id = current_setting('albert.tenant_id', true));
  END IF;
END;
$$;

COMMIT;
