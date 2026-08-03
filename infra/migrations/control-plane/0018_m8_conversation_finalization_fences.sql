BEGIN;

-- A conversation is a single ordered command stream. Resolve any historical
-- duplicate runners deterministically before installing the permanent fence.
WITH ranked_running AS (
  SELECT tenant_id,turn_id,
         row_number() OVER (
           PARTITION BY tenant_id,conversation_id
           ORDER BY turn_number,created_at,turn_id
         ) AS runner_number
    FROM control_plane.conversation_turns
   WHERE status='running'
)
UPDATE control_plane.conversation_turns AS turn
   SET status='failed',result_digest='superseded_concurrent_turn',completed_at=now()
  FROM ranked_running AS ranked
 WHERE turn.tenant_id=ranked.tenant_id
   AND turn.turn_id=ranked.turn_id
   AND ranked.runner_number>1;

CREATE UNIQUE INDEX IF NOT EXISTS conversation_turns_one_running_per_conversation
  ON control_plane.conversation_turns(tenant_id,conversation_id)
  WHERE status='running';

CREATE OR REPLACE FUNCTION public.begin_albert_turn(
  p_conversation_id text,
  p_turn_id text,
  p_user_message text,
  p_runtime_profile jsonb
)
RETURNS TABLE (conversation_id text,previous_response_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  actor uuid:=auth.uid();
  selected_tenant text:=control_plane.require_current_tenant_id();
  resolved_conversation text:=p_conversation_id;
  next_turn integer;
  previous_provider_response text;
  existing_conversation_id text;
  existing_user_message text;
  existing_runtime_profile jsonb;
BEGIN
  IF actor IS NULL
     OR length(btrim(p_turn_id)) NOT BETWEEN 8 AND 128
     OR length(btrim(p_user_message)) NOT BETWEEN 1 AND 40000
     OR p_runtime_profile IS NULL
     OR jsonb_typeof(p_runtime_profile)<>'object' THEN
    RAISE EXCEPTION 'turn input is invalid' USING ERRCODE='22023';
  END IF;

  IF resolved_conversation IS NULL THEN
    resolved_conversation:=control_plane.generate_ulid();
    INSERT INTO control_plane.conversations(
      tenant_id,conversation_id,status,created_by
    ) VALUES (
      selected_tenant,resolved_conversation,'active',actor
    );
  ELSE
    PERFORM 1
      FROM control_plane.conversations AS conversation
     WHERE conversation.tenant_id=selected_tenant
       AND conversation.conversation_id=resolved_conversation
       AND conversation.created_by=actor
       AND conversation.status='active'
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'conversation was not found' USING ERRCODE='P0002';
    END IF;
  END IF;

  SELECT turn.conversation_id,turn.user_message,turn.runtime_profile
    INTO existing_conversation_id,existing_user_message,existing_runtime_profile
    FROM control_plane.conversation_turns AS turn
    JOIN control_plane.conversations AS owned_conversation
      ON owned_conversation.tenant_id=turn.tenant_id
     AND owned_conversation.conversation_id=turn.conversation_id
   WHERE turn.tenant_id=selected_tenant AND turn.turn_id=p_turn_id
     AND turn.created_by=actor
     AND owned_conversation.created_by=actor;
  IF FOUND THEN
    IF existing_conversation_id<>resolved_conversation
       OR existing_user_message<>btrim(p_user_message)
       OR existing_runtime_profile<>p_runtime_profile THEN
      RAISE EXCEPTION 'turn id replay does not match the immutable request' USING ERRCODE='23505';
    END IF;
    conversation_id:=existing_conversation_id;
    SELECT completed.provider_response_id INTO previous_provider_response
      FROM control_plane.conversation_turns AS completed
     WHERE completed.tenant_id=selected_tenant
       AND completed.conversation_id=resolved_conversation
       AND completed.status='completed'
       AND completed.turn_number<(
         SELECT existing.turn_number
           FROM control_plane.conversation_turns AS existing
          WHERE existing.tenant_id=selected_tenant AND existing.turn_id=p_turn_id
       )
     ORDER BY completed.turn_number DESC LIMIT 1;
    previous_response_id:=previous_provider_response;
    RETURN NEXT;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM control_plane.conversation_turns AS colliding_turn
     WHERE colliding_turn.tenant_id=selected_tenant
       AND colliding_turn.turn_id=p_turn_id
  ) THEN
    RAISE EXCEPTION 'turn id collision' USING ERRCODE='23505';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('conversation:'||selected_tenant||':'||resolved_conversation,0)
  );
  IF EXISTS (
    SELECT 1 FROM control_plane.conversation_turns AS active_turn
     WHERE active_turn.tenant_id=selected_tenant
       AND active_turn.conversation_id=resolved_conversation
       AND active_turn.status='running'
  ) THEN
    RAISE EXCEPTION 'another turn is already running for this conversation' USING ERRCODE='55000';
  END IF;

  SELECT coalesce(max(turn.turn_number),0)+1 INTO next_turn
    FROM control_plane.conversation_turns AS turn
   WHERE turn.tenant_id=selected_tenant
     AND turn.conversation_id=resolved_conversation;
  SELECT turn.provider_response_id INTO previous_provider_response
    FROM control_plane.conversation_turns AS turn
   WHERE turn.tenant_id=selected_tenant
     AND turn.conversation_id=resolved_conversation
     AND turn.status='completed'
   ORDER BY turn.turn_number DESC LIMIT 1;

  INSERT INTO control_plane.conversation_turns(
    tenant_id,turn_id,conversation_id,turn_number,user_message,
    runtime_profile,status,created_by
  ) VALUES (
    selected_tenant,p_turn_id,resolved_conversation,next_turn,btrim(p_user_message),
    p_runtime_profile,'running',actor
  );
  UPDATE control_plane.conversations
     SET updated_at=now()
   WHERE tenant_id=selected_tenant AND conversation_id=resolved_conversation;

  conversation_id:=resolved_conversation;
  previous_response_id:=previous_provider_response;
  RETURN NEXT;
END;
$$;

-- Only successfully finalized immutable artefacts may become future model
-- context. Failed/running turns and orphan terminal events are excluded.
CREATE OR REPLACE FUNCTION public.albert_model_context(
  p_conversation_id text,
  p_turn_limit integer DEFAULT 12
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  selected_tenant text:=control_plane.require_current_tenant_id();
  actor uuid:=auth.uid();
  result jsonb;
BEGIN
  IF p_turn_limit NOT BETWEEN 1 AND 24 THEN
    RAISE EXCEPTION 'model context turn limit must be between 1 and 24' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.conversations AS conversation
     WHERE conversation.tenant_id=selected_tenant
       AND conversation.conversation_id=p_conversation_id
       AND conversation.created_by=actor
  ) THEN
    RAISE EXCEPTION 'conversation was not found' USING ERRCODE='P0002';
  END IF;

  WITH recent AS (
    SELECT turn.turn_number,turn.user_message,turn.status,
           artifact.answer_state,artifact.answer_text
      FROM control_plane.conversation_turns AS turn
      JOIN control_plane.answer_artifacts AS artifact
        ON artifact.tenant_id=turn.tenant_id
       AND artifact.conversation_id=turn.conversation_id
       AND artifact.turn_id=turn.turn_id
     WHERE turn.tenant_id=selected_tenant
       AND turn.conversation_id=p_conversation_id
       AND turn.created_by=actor
       AND turn.status='completed'
     ORDER BY turn.turn_number DESC
     LIMIT p_turn_limit
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'turn_number',recent.turn_number,
    'user_message',recent.user_message,
    'status',recent.status,
    'assistant_event',CASE WHEN recent.answer_state='clarification'
      THEN jsonb_build_object('type','clarification','question',recent.answer_text)
      ELSE jsonb_build_object('type','answer','text',recent.answer_text)
    END
  ) ORDER BY recent.turn_number),'[]'::jsonb)
    INTO result
    FROM recent;
  RETURN result;
END;
$$;

-- Partial execution traces remain inspectable, but an unfinalized terminal
-- narrative is never returned by history after a failed or running turn.
CREATE OR REPLACE FUNCTION public.albert_conversation_history(
  p_conversation_id text,
  p_after_sequence integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  selected_tenant text:=control_plane.require_current_tenant_id();
  actor uuid:=auth.uid();
  result jsonb;
BEGIN
  IF p_after_sequence<0 THEN
    RAISE EXCEPTION 'after sequence cannot be negative' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.conversations AS conversation
     WHERE conversation.tenant_id=selected_tenant
       AND conversation.conversation_id=p_conversation_id
       AND conversation.created_by=actor
  ) THEN
    RAISE EXCEPTION 'conversation was not found' USING ERRCODE='P0002';
  END IF;

  WITH ordered_events AS (
    SELECT turn.turn_id,turn.turn_number,event.event,
           row_number() OVER (ORDER BY turn.turn_number,event.sequence_number)::integer AS conversation_sequence
      FROM control_plane.conversation_turns AS turn
      JOIN control_plane.conversation_turn_events AS event
        ON event.tenant_id=turn.tenant_id AND event.turn_id=turn.turn_id
     WHERE turn.tenant_id=selected_tenant
       AND turn.conversation_id=p_conversation_id
       AND turn.created_by=actor
       AND (
         event.event->>'type' NOT IN ('answer','clarification')
         OR (
           turn.status='completed'
           AND EXISTS (
             SELECT 1 FROM control_plane.answer_artifacts AS artifact
              WHERE artifact.tenant_id=turn.tenant_id
                AND artifact.conversation_id=turn.conversation_id
                AND artifact.turn_id=turn.turn_id
           )
         )
       )
  )
  SELECT jsonb_build_object(
    'conversation_id',p_conversation_id,
    'turns',coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'turn_id',turn.turn_id,
        'turn_number',turn.turn_number,
        'user_message',turn.user_message,
        'status',turn.status,
        'answer_state',turn.answer_state,
        'runtime_profile',jsonb_build_object(
          'model',turn.runtime_profile->'model',
          'reasoningEffort',turn.runtime_profile->'reasoningEffort',
          'fastMode',turn.runtime_profile->'fastMode'
        ),
        'created_at',turn.created_at,
        'completed_at',turn.completed_at,
        'events',coalesce((
          SELECT jsonb_agg(event.event||jsonb_build_object(
            'conversationSequence',event.conversation_sequence
          ) ORDER BY event.conversation_sequence)
            FROM ordered_events AS event
           WHERE event.turn_id=turn.turn_id
             AND event.conversation_sequence>p_after_sequence
        ),'[]'::jsonb)
      ) ORDER BY turn.turn_number)
        FROM control_plane.conversation_turns AS turn
       WHERE turn.tenant_id=selected_tenant
         AND turn.conversation_id=p_conversation_id
         AND turn.created_by=actor
         AND (
           p_after_sequence=0
           OR turn.status IN ('running','failed')
           OR EXISTS (
             SELECT 1 FROM ordered_events AS event
              WHERE event.turn_id=turn.turn_id
                AND event.conversation_sequence>p_after_sequence
           )
         )
    ),'[]'::jsonb),
    'next_sequence',coalesce((SELECT max(conversation_sequence) FROM ordered_events),0)
  ) INTO result;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.begin_albert_turn(text,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_model_context(text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_conversation_history(text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.begin_albert_turn(text,text,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_model_context(text,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_conversation_history(text,integer) TO authenticated;

COMMIT;
