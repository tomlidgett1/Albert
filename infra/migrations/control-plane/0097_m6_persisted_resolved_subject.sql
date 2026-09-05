-- Preserve the model's bounded, structured interpretation of a conversation
-- subject across turns. The subject is already sealed inside the terminal
-- answer execution event; model context now returns that artifact alongside
-- the answer prose instead of forcing every follow-up to reconstruct it from
-- prose alone. Hidden/rewound turns remain excluded by the existing query.

BEGIN;

CREATE OR REPLACE FUNCTION public.albert_model_context(
  p_conversation_id text,
  p_turn_limit integer DEFAULT 12
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  actor uuid := extensions.albert_auth_uid();
  result jsonb;
BEGIN
  IF p_turn_limit NOT BETWEEN 1 AND 24 THEN
    RAISE EXCEPTION 'model context turn limit must be between 1 and 24' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.conversations AS conversation
     WHERE conversation.tenant_id = selected_tenant
       AND conversation.conversation_id = p_conversation_id
       AND conversation.created_by = actor
  ) THEN
    RAISE EXCEPTION 'conversation was not found' USING ERRCODE = 'P0002';
  END IF;

  WITH recent AS (
    SELECT turn.turn_number, turn.user_message, turn.status,
           artifact.answer_state, artifact.answer_text,
           (
             SELECT execution.event_payload->'resolvedSubject'
               FROM control_plane.answer_execution_events AS execution
              WHERE execution.tenant_id = artifact.tenant_id
                AND execution.answer_artifact_id = artifact.answer_artifact_id
                AND execution.event_type = 'answer'
              ORDER BY execution.sequence_number DESC
              LIMIT 1
           ) AS resolved_subject
      FROM control_plane.conversation_turns AS turn
      JOIN control_plane.answer_artifacts AS artifact
        ON artifact.tenant_id = turn.tenant_id
       AND artifact.conversation_id = turn.conversation_id
       AND artifact.turn_id = turn.turn_id
     WHERE turn.tenant_id = selected_tenant
       AND turn.conversation_id = p_conversation_id
       AND turn.created_by = actor
       AND turn.status = 'completed'
       AND turn.hidden_at IS NULL
     ORDER BY turn.turn_number DESC
     LIMIT p_turn_limit
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'turn_number', recent.turn_number,
    'user_message', recent.user_message,
    'status', recent.status,
    'assistant_event', CASE WHEN recent.answer_state = 'clarification'
      THEN jsonb_build_object('type', 'clarification', 'question', recent.answer_text)
      ELSE jsonb_build_object('type', 'answer', 'text', recent.answer_text)
        || CASE WHEN jsonb_typeof(recent.resolved_subject) = 'object'
          THEN jsonb_build_object('resolvedSubject', recent.resolved_subject)
          ELSE '{}'::jsonb
        END
    END
  ) ORDER BY recent.turn_number), '[]'::jsonb)
    INTO result
    FROM recent;
  RETURN result;
END;
$$;

COMMIT;
