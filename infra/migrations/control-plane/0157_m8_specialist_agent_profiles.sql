-- 0157: bind each conversation to one versioned specialist-agent identity and
-- preserve that identity in history/sidebar projections. The exact policy
-- version and digest remain turn-level release evidence; the stable profile id
-- is immutable for the lifetime of a conversation.

BEGIN;

CREATE OR REPLACE FUNCTION control_plane.enforce_conversation_specialist_agent_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  incoming_profile text := coalesce(
    nullif(btrim(NEW.runtime_profile ->> 'specialistAgentId'), ''),
    'general'
  );
  existing_profile text;
  incoming_version text := NEW.runtime_profile ->> 'specialistAgentVersion';
  incoming_digest text := NEW.runtime_profile ->> 'specialistAgentDigest';
BEGIN
  IF incoming_profile NOT IN ('general', 'customers') THEN
    RAISE EXCEPTION 'specialist agent profile is invalid' USING ERRCODE = '22023';
  END IF;
  IF incoming_version IS NOT NULL AND incoming_version !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'specialist agent profile version is invalid' USING ERRCODE = '22023';
  END IF;
  IF incoming_digest IS NOT NULL AND incoming_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'specialist agent profile digest is invalid' USING ERRCODE = '22023';
  END IF;
  IF incoming_profile <> 'general'
     AND (incoming_version IS NULL OR incoming_digest IS NULL) THEN
    RAISE EXCEPTION 'specialist agent profile receipt is incomplete' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(
           nullif(btrim(turn.runtime_profile ->> 'specialistAgentId'), ''),
           'general'
         )
    INTO existing_profile
    FROM control_plane.conversation_turns AS turn
   WHERE turn.tenant_id = NEW.tenant_id
     AND turn.conversation_id = NEW.conversation_id
   ORDER BY turn.turn_number
   LIMIT 1;

  IF FOUND AND existing_profile <> incoming_profile THEN
    RAISE EXCEPTION 'conversation specialist agent profile is immutable'
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversation_turns_specialist_agent_guard
  ON control_plane.conversation_turns;
CREATE TRIGGER conversation_turns_specialist_agent_guard
BEFORE INSERT ON control_plane.conversation_turns
FOR EACH ROW
EXECUTE FUNCTION control_plane.enforce_conversation_specialist_agent_v1();

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
          'fastMode', turn.runtime_profile->'fastMode',
          'runtime', turn.runtime_profile->'runtime',
          'analyticalRuntime', turn.runtime_profile->'analyticalRuntime',
          'provider', turn.runtime_profile->'provider',
          'specialistAgentId', coalesce(
            turn.runtime_profile->'specialistAgentId',
            '"general"'::jsonb
          ),
          'specialistAgentVersion', turn.runtime_profile->'specialistAgentVersion',
          'specialistAgentDigest', turn.runtime_profile->'specialistAgentDigest'
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

CREATE OR REPLACE FUNCTION public.albert_list_conversations(p_limit integer DEFAULT 30)
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
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'conversation limit must be between 1 and 100' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'conversation_id', conversation.conversation_id,
    'title', conversation.title,
    'status', conversation.status,
    'created_at', conversation.created_at,
    'updated_at', conversation.updated_at,
    'last_turn', (
      SELECT jsonb_build_object(
        'turn_id', turn.turn_id,
        'turn_number', turn.turn_number,
        'user_message', turn.user_message,
        'status', turn.status,
        'answer_state', turn.answer_state,
        'runtime_profile', jsonb_build_object(
          'model', turn.runtime_profile -> 'model',
          'reasoningEffort', turn.runtime_profile -> 'reasoningEffort',
          'fastMode', turn.runtime_profile -> 'fastMode',
          'runtime', turn.runtime_profile -> 'runtime',
          'analyticalRuntime', turn.runtime_profile -> 'analyticalRuntime',
          'provider', turn.runtime_profile -> 'provider',
          'specialistAgentId', coalesce(
            turn.runtime_profile -> 'specialistAgentId',
            '"general"'::jsonb
          ),
          'specialistAgentVersion', turn.runtime_profile -> 'specialistAgentVersion',
          'specialistAgentDigest', turn.runtime_profile -> 'specialistAgentDigest'
        ),
        'created_at', turn.created_at,
        'completed_at', turn.completed_at
      )
      FROM control_plane.conversation_turns AS turn
      WHERE turn.tenant_id = selected_tenant
        AND turn.conversation_id = conversation.conversation_id
        AND turn.created_by = actor
        AND turn.hidden_at IS NULL
      ORDER BY turn.turn_number DESC
      LIMIT 1
    )
  ) ORDER BY conversation.updated_at DESC), '[]'::jsonb)
  INTO result
  FROM (
    SELECT *
    FROM control_plane.conversations AS candidate
    WHERE candidate.tenant_id = selected_tenant
      AND candidate.created_by = actor
    ORDER BY candidate.updated_at DESC
    LIMIT p_limit
  ) AS conversation;
  RETURN result;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
