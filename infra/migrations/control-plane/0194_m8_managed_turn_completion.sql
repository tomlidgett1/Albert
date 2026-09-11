-- Native managed turns finalize as completed, without impersonating a V1 artifact.
BEGIN;

CREATE FUNCTION public.albert_managed_turn_visible(
  p_conversation_id text, p_turn_id text, p_server_key text
)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE selected_tenant text; actor uuid;
BEGIN
  PERFORM control_plane.require_managed_agent_server(p_server_key);
  actor := extensions.albert_auth_uid();
  selected_tenant := control_plane.require_current_tenant_id();
  RETURN EXISTS (
    SELECT 1 FROM control_plane.conversation_turns AS turn
    JOIN control_plane.conversations AS conversation
      ON conversation.tenant_id = turn.tenant_id AND conversation.conversation_id = turn.conversation_id
    WHERE turn.tenant_id = selected_tenant AND turn.turn_id = p_turn_id
      AND turn.conversation_id = p_conversation_id AND turn.created_by = actor
      AND conversation.created_by = actor AND turn.hidden_at IS NULL
  );
END;
$$;

CREATE FUNCTION public.albert_complete_managed_agent_turn(
  p_conversation_id text, p_turn_id text, p_server_key text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE selected_tenant text; actor uuid; answer jsonb; current_status text; final_state text;
BEGIN
  PERFORM control_plane.require_managed_agent_server(p_server_key);
  actor := extensions.albert_auth_uid();
  selected_tenant := control_plane.require_current_tenant_id();
  SELECT turn.status INTO current_status
    FROM control_plane.conversation_turns AS turn
    JOIN control_plane.conversations AS conversation
      ON conversation.tenant_id = turn.tenant_id AND conversation.conversation_id = turn.conversation_id
    JOIN control_plane.managed_agent_sessions AS session
      ON session.tenant_id = turn.tenant_id AND session.conversation_id = turn.conversation_id
   WHERE turn.tenant_id = selected_tenant AND turn.turn_id = p_turn_id
     AND turn.conversation_id = p_conversation_id AND turn.created_by = actor
     AND conversation.created_by = actor AND turn.hidden_at IS NULL
     AND turn.runtime_profile->>'runtime' = 'openai-agents-api'
     AND session.actor_id = actor AND session.active_turn_id = p_turn_id
     AND session.state->>'idleConfirmed' = 'true'
   FOR UPDATE OF turn;
  IF NOT FOUND THEN RAISE EXCEPTION 'an owned, finished managed session is required' USING ERRCODE = '42501'; END IF;
  IF current_status = 'completed' THEN RETURN; END IF;
  IF current_status <> 'running' THEN RAISE EXCEPTION 'the managed turn is no longer running' USING ERRCODE = '55000'; END IF;
  SELECT event.event INTO answer FROM control_plane.conversation_turn_events AS event
   WHERE event.tenant_id = selected_tenant AND event.conversation_id = p_conversation_id
     AND event.turn_id = p_turn_id AND event.event->>'type' = 'answer'
   ORDER BY event.sequence_number DESC LIMIT 1;
  final_state := replace(lower(answer->>'state'), ' ', '_');
  IF answer IS NULL OR length(coalesce(answer->>'text','')) = 0
     OR NOT EXISTS (SELECT 1 FROM control_plane.answer_state_lookup WHERE state = final_state) THEN
    RAISE EXCEPTION 'a persisted, validated answer is required' USING ERRCODE = '22023';
  END IF;
  UPDATE control_plane.conversation_turns SET status = 'completed', answer_state = final_state,
    result_digest = 'albert_managed_answered', completed_at = clock_timestamp()
   WHERE tenant_id = selected_tenant AND turn_id = p_turn_id;
  INSERT INTO control_plane.audit_log (tenant_id, audit_id, actor_user_id, actor_type, action, resource_type, resource_id, audit_metadata)
  VALUES (selected_tenant, control_plane.generate_ulid(), actor, 'user', 'conversation.managed_turn_completed',
    'conversation_turn', p_turn_id, jsonb_build_object('answer_state', final_state,
      'answer_digest', encode(extensions.digest(answer::text, 'sha256'), 'hex')));
END;
$$;

-- Retain the existing ownership/visibility logic and add only the new completion receipt.
DO $$
DECLARE signature regprocedure; definition text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['public.albert_conversation_history(text,integer)'::regprocedure, 'public.albert_model_context(text,integer)'::regprocedure]
  LOOP
    definition := pg_get_functiondef(signature);
    IF position('turn.result_digest = ''albert_swarm_answered''' IN definition) = 0 THEN
      RAISE EXCEPTION 'managed completion compatibility marker missing in %', signature;
    END IF;
    definition := replace(definition, 'turn.result_digest = ''albert_swarm_answered''',
      'turn.result_digest IN (''albert_swarm_answered'', ''albert_managed_answered'')');
    EXECUTE definition;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.albert_managed_turn_visible(text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.albert_complete_managed_agent_turn(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.albert_managed_turn_visible(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_complete_managed_agent_turn(text, text, text) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
