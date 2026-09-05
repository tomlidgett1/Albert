-- Albert v3 and Cubecore release conversation leases via fail_albert_turn with
-- success codes instead of immutable artefact finalization. Those turns still
-- persist terminal answer/clarification events (with Cube query provenance) in
-- conversation_turn_events, but albert_model_context previously only joined
-- completed turns with answer_artifacts. Follow-up turns therefore saw no prior
-- governed query YAML and misclassified refinements as clarifications.

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
           artifact.answer_state AS artifact_answer_state,
           artifact.answer_text AS artifact_answer_text,
           (
             SELECT execution.event_payload->'resolvedSubject'
               FROM control_plane.answer_execution_events AS execution
              WHERE execution.tenant_id = artifact.tenant_id
                AND execution.answer_artifact_id = artifact.answer_artifact_id
                AND execution.event_type = 'answer'
              ORDER BY execution.sequence_number DESC
              LIMIT 1
           ) AS artifact_resolved_subject,
           (
             SELECT event.event
               FROM control_plane.conversation_turn_events AS event
              WHERE event.tenant_id = turn.tenant_id
                AND event.turn_id = turn.turn_id
                AND event.event->>'type' IN ('answer', 'clarification')
              ORDER BY event.sequence_number DESC
              LIMIT 1
           ) AS terminal_event
      FROM control_plane.conversation_turns AS turn
      LEFT JOIN control_plane.answer_artifacts AS artifact
        ON artifact.tenant_id = turn.tenant_id
       AND artifact.conversation_id = turn.conversation_id
       AND artifact.turn_id = turn.turn_id
     WHERE turn.tenant_id = selected_tenant
       AND turn.conversation_id = p_conversation_id
       AND turn.created_by = actor
       AND turn.hidden_at IS NULL
       AND (
         turn.status = 'completed'
         AND artifact.answer_artifact_id IS NOT NULL
         OR turn.status = 'failed'
         AND turn.result_digest IN (
           'albert_v3_answered',
           'albert_v3_unavailable',
           'cubecore_v1_answered',
           'cubecore_unavailable'
         )
         AND EXISTS (
           SELECT 1
             FROM control_plane.conversation_turn_events AS event
            WHERE event.tenant_id = turn.tenant_id
              AND event.turn_id = turn.turn_id
              AND event.event->>'type' IN ('answer', 'clarification')
         )
       )
     ORDER BY turn.turn_number DESC
     LIMIT p_turn_limit
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'turn_number', recent.turn_number,
    'user_message', recent.user_message,
    'status', recent.status,
    'assistant_event', CASE
      WHEN coalesce(recent.terminal_event->>'type', '') = 'clarification'
        OR coalesce(recent.artifact_answer_state, '') = 'clarification'
      THEN jsonb_build_object(
        'type', 'clarification',
        'question', coalesce(recent.terminal_event->>'question', recent.artifact_answer_text)
      )
      ELSE jsonb_build_object(
        'type', 'answer',
        'text', coalesce(recent.terminal_event->>'text', recent.artifact_answer_text)
      )
        || CASE WHEN recent.terminal_event IS NOT NULL
          AND jsonb_typeof(recent.terminal_event->'provenance') = 'object'
          THEN jsonb_build_object('provenance', recent.terminal_event->'provenance')
          ELSE '{}'::jsonb
        END
        || CASE WHEN jsonb_typeof(
          coalesce(recent.terminal_event->'resolvedSubject', recent.artifact_resolved_subject)
        ) = 'object'
          THEN jsonb_build_object(
            'resolvedSubject',
            coalesce(recent.terminal_event->'resolvedSubject', recent.artifact_resolved_subject)
          )
          ELSE '{}'::jsonb
        END
    END
  ) ORDER BY recent.turn_number), '[]'::jsonb)
    INTO result
    FROM recent;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_conversation_history(
  p_conversation_id text,
  p_after_sequence integer DEFAULT 0
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
  IF p_after_sequence < 0 THEN
    RAISE EXCEPTION 'after sequence cannot be negative' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.conversations AS conversation
     WHERE conversation.tenant_id = selected_tenant
       AND conversation.conversation_id = p_conversation_id
       AND conversation.created_by = actor
  ) THEN
    RAISE EXCEPTION 'conversation was not found' USING ERRCODE = 'P0002';
  END IF;

  WITH ordered_events AS (
    SELECT turn.turn_id, turn.turn_number, event.event,
           row_number() OVER (ORDER BY turn.turn_number, event.sequence_number)::integer AS conversation_sequence
      FROM control_plane.conversation_turns AS turn
      JOIN control_plane.conversation_turn_events AS event
        ON event.tenant_id = turn.tenant_id AND event.turn_id = turn.turn_id
     WHERE turn.tenant_id = selected_tenant
       AND turn.conversation_id = p_conversation_id
       AND turn.created_by = actor
       AND turn.hidden_at IS NULL
       AND (
         event.event->>'type' NOT IN ('answer', 'clarification')
         OR (
           turn.status = 'completed'
           AND EXISTS (
             SELECT 1 FROM control_plane.answer_artifacts AS artifact
              WHERE artifact.tenant_id = turn.tenant_id
                AND artifact.conversation_id = turn.conversation_id
                AND artifact.turn_id = turn.turn_id
           )
           OR turn.status = 'failed'
           AND turn.result_digest IN (
             'albert_v3_answered',
             'albert_v3_unavailable',
             'cubecore_v1_answered',
             'cubecore_unavailable'
           )
         )
       )
  )
  SELECT jsonb_build_object(
    'conversation_id', p_conversation_id,
    'turns', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'turn_id', turn.turn_id,
        'turn_number', turn.turn_number,
        'user_message', turn.user_message,
        'status', turn.status,
        'answer_state', turn.answer_state,
        'runtime_profile', jsonb_build_object(
          'model', turn.runtime_profile->'model',
          'reasoningEffort', turn.runtime_profile->'reasoningEffort',
          'fastMode', turn.runtime_profile->'fastMode'
        ),
        'created_at', turn.created_at,
        'completed_at', turn.completed_at,
        'events', coalesce((
          SELECT jsonb_agg(event.event || jsonb_build_object(
            'conversationSequence', event.conversation_sequence
          ) ORDER BY event.conversation_sequence)
            FROM ordered_events AS event
           WHERE event.turn_id = turn.turn_id
             AND event.conversation_sequence > p_after_sequence
        ), '[]'::jsonb)
      ) ORDER BY turn.turn_number)
        FROM control_plane.conversation_turns AS turn
       WHERE turn.tenant_id = selected_tenant
         AND turn.conversation_id = p_conversation_id
         AND turn.created_by = actor
         AND turn.hidden_at IS NULL
         AND (
           p_after_sequence = 0
           OR turn.status IN ('running', 'failed')
           OR EXISTS (
             SELECT 1 FROM ordered_events AS event
              WHERE event.turn_id = turn.turn_id
                AND event.conversation_sequence > p_after_sequence
           )
         )
    ), '[]'::jsonb),
    'next_sequence', coalesce((SELECT max(conversation_sequence) FROM ordered_events), 0)
  ) INTO result;
  RETURN result;
END;
$$;

COMMIT;
