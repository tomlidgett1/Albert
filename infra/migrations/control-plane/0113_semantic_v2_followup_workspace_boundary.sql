BEGIN;

-- The semantic runtime needs only one narrowly projected fact from the private
-- conversation ledger: the most recent executed workspace in the same
-- conversation. It must not receive SELECT on conversation_turns itself.
CREATE OR REPLACE FUNCTION control_plane.load_previous_semantic_workspace_v2(
  p_tenant_id text,
  p_conversation_id text,
  p_turn_id text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  previous_workspace jsonb;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_semantic_control_runtime',
    'albert_semantic_control'
  );
  IF current_setting('albert.tenant_id',true) IS DISTINCT FROM p_tenant_id
     OR NOT control_plane.is_ulid(p_tenant_id)
     OR NOT control_plane.is_ulid(p_conversation_id)
     OR NOT control_plane.is_ulid(p_turn_id) THEN
    RAISE EXCEPTION 'Semantic V2 follow-up context is invalid'
      USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(
    SELECT 1
      FROM control_plane.conversation_turns current_turn
     WHERE current_turn.tenant_id=p_tenant_id
       AND current_turn.conversation_id=p_conversation_id
       AND current_turn.turn_id=p_turn_id
       AND current_turn.status='running'
       AND current_turn.lease_expires_at>clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'semantic turn lease is not active'
      USING ERRCODE='55000';
  END IF;

  SELECT jsonb_build_object(
           'workspaceId',workspace.workspace_id,
           'publicationHash',workspace.publication_hash,
           'overlayVersion',workspace.overlay_version,
           'revision',workspace.revision,
           'blocks',workspace.blocks,
           'turnNumber',prior_turn.turn_number,
           'guidance','Continue this workspace only when the new question is a contextual follow-up; otherwise create a new workspace.'
         )
    INTO previous_workspace
    FROM control_plane.query_workspaces_v2 workspace
    JOIN control_plane.conversation_turns prior_turn
      ON prior_turn.tenant_id=workspace.tenant_id
     AND prior_turn.turn_id=workspace.question_id
   WHERE workspace.tenant_id=p_tenant_id
     AND prior_turn.conversation_id=p_conversation_id
     AND workspace.status='executed'
     AND workspace.question_id<>p_turn_id
   ORDER BY prior_turn.turn_number DESC,workspace.updated_at DESC
   LIMIT 1;

  RETURN previous_workspace;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.load_previous_semantic_workspace_v2(text,text,text)
FROM PUBLIC,anon,authenticated,service_role,
  albert_sync_control,albert_webhook_control,albert_transform_control,
  albert_anthropic_control,albert_deletion_control,
  albert_operator_diagnostic_control;
GRANT EXECUTE ON FUNCTION control_plane.load_previous_semantic_workspace_v2(text,text,text)
TO albert_semantic_control;

COMMIT;
