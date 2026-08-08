BEGIN;

-- Edit-and-rerun keeps the same conversation id. Later turns are soft-hidden so
-- immutable answer artefacts and usage ledgers stay intact, while history,
-- model context, and the sidebar only expose the active prefix.

ALTER TABLE control_plane.conversation_turns
  ADD COLUMN IF NOT EXISTS hidden_at timestamptz;

CREATE INDEX IF NOT EXISTS conversation_turns_visible_order_idx
  ON control_plane.conversation_turns (tenant_id, conversation_id, turn_number)
  WHERE hidden_at IS NULL;

COMMENT ON COLUMN control_plane.conversation_turns.hidden_at IS
  'Soft-hide timestamp for conversation rewind. Hidden turns remain for lineage and metering but are excluded from history, model context, and sidebar previews.';

CREATE OR REPLACE FUNCTION public.albert_rewind_conversation_from_turn(
  p_conversation_id text,
  p_from_turn_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  actor uuid := extensions.albert_auth_uid();
  from_turn_number integer;
  hidden_count integer := 0;
  failed_running_count integer := 0;
BEGIN
  IF actor IS NULL
     OR p_conversation_id IS NULL
     OR NOT control_plane.is_ulid(p_conversation_id)
     OR p_from_turn_id IS NULL
     OR NOT control_plane.is_ulid(p_from_turn_id) THEN
    RAISE EXCEPTION 'conversation rewind input is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
    FROM control_plane.conversations AS conversation
   WHERE conversation.tenant_id = selected_tenant
     AND conversation.conversation_id = p_conversation_id
     AND conversation.created_by = actor
     AND conversation.status = 'active'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation was not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('conversation:' || selected_tenant || ':' || p_conversation_id, 0)
  );
  PERFORM control_plane.reap_expired_conversation_turns(
    selected_tenant,
    p_conversation_id
  );

  SELECT turn.turn_number
    INTO from_turn_number
    FROM control_plane.conversation_turns AS turn
   WHERE turn.tenant_id = selected_tenant
     AND turn.conversation_id = p_conversation_id
     AND turn.turn_id = p_from_turn_id
     AND turn.created_by = actor
     AND turn.hidden_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation turn was not found' USING ERRCODE = 'P0002';
  END IF;

  WITH failed AS (
    UPDATE control_plane.conversation_turns AS turn
       SET status = 'failed',
           result_digest = 'conversation_rewound',
           completed_at = clock_timestamp(),
           hidden_at = coalesce(turn.hidden_at, clock_timestamp())
     WHERE turn.tenant_id = selected_tenant
       AND turn.conversation_id = p_conversation_id
       AND turn.created_by = actor
       AND turn.turn_number >= from_turn_number
       AND turn.status = 'running'
       AND turn.hidden_at IS NULL
    RETURNING 1
  )
  SELECT count(*)::integer INTO failed_running_count FROM failed;

  WITH hidden AS (
    UPDATE control_plane.conversation_turns AS turn
       SET hidden_at = clock_timestamp()
     WHERE turn.tenant_id = selected_tenant
       AND turn.conversation_id = p_conversation_id
       AND turn.created_by = actor
       AND turn.turn_number >= from_turn_number
       AND turn.hidden_at IS NULL
    RETURNING 1
  )
  SELECT count(*)::integer INTO hidden_count FROM hidden;

  UPDATE control_plane.conversations AS conversation
     SET updated_at = now()
   WHERE conversation.tenant_id = selected_tenant
     AND conversation.conversation_id = p_conversation_id;

  RETURN jsonb_build_object(
    'conversation_id', p_conversation_id,
    'from_turn_id', p_from_turn_id,
    'from_turn_number', from_turn_number,
    'hidden_turn_count', hidden_count,
    'failed_running_count', failed_running_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_albert_turn_core_v1(
  p_conversation_id text,
  p_turn_id text,
  p_user_message text,
  p_runtime_profile jsonb,
  p_confirmation_turn_id text DEFAULT NULL,
  p_confirmation_option_id text DEFAULT NULL
)
RETURNS TABLE (
  conversation_id text,
  previous_response_id text,
  confirmed_option_id text,
  confirmed_preference text,
  confirmed_value text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := extensions.albert_auth_uid();
  selected_tenant text := control_plane.require_current_tenant_id();
  resolved_conversation text := p_conversation_id;
  next_turn integer;
  previous_provider_response text;
  existing_conversation_id text;
  existing_user_message text;
  existing_runtime_profile jsonb;
  existing_confirmation_turn text;
  existing_confirmation_option text;
  selected_option control_plane.clarification_options%ROWTYPE;
BEGIN
  IF actor IS NULL
     OR length(btrim(p_turn_id)) NOT BETWEEN 8 AND 128
     OR length(btrim(p_user_message)) NOT BETWEEN 1 AND 40000
     OR p_runtime_profile IS NULL
     OR jsonb_typeof(p_runtime_profile) <> 'object'
     OR ((p_confirmation_turn_id IS NULL) <> (p_confirmation_option_id IS NULL)) THEN
    RAISE EXCEPTION 'turn input is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT turn.conversation_id, turn.user_message, turn.runtime_profile
    INTO existing_conversation_id, existing_user_message, existing_runtime_profile
    FROM control_plane.conversation_turns AS turn
    JOIN control_plane.conversations AS owned_conversation
      ON owned_conversation.tenant_id = turn.tenant_id
     AND owned_conversation.conversation_id = turn.conversation_id
   WHERE turn.tenant_id = selected_tenant
     AND turn.turn_id = p_turn_id
     AND turn.created_by = actor
     AND turn.hidden_at IS NULL
     AND owned_conversation.created_by = actor;
  IF FOUND THEN
    IF (resolved_conversation IS NOT NULL AND existing_conversation_id <> resolved_conversation)
       OR existing_user_message <> btrim(p_user_message)
       OR existing_runtime_profile <> p_runtime_profile THEN
      RAISE EXCEPTION 'turn id replay does not match the immutable request' USING ERRCODE = '23505';
    END IF;
    SELECT prompt.offered_turn_id, prompt.consumed_option_id,
           option.preference_key, option.preference_value
      INTO existing_confirmation_turn, existing_confirmation_option,
           confirmed_preference, confirmed_value
      FROM control_plane.clarification_prompts AS prompt
      JOIN control_plane.clarification_options AS option
        ON option.tenant_id = prompt.tenant_id
       AND option.offered_turn_id = prompt.offered_turn_id
       AND option.option_id = prompt.consumed_option_id
     WHERE prompt.tenant_id = selected_tenant
       AND prompt.consumed_turn_id = p_turn_id;
    IF (p_confirmation_turn_id IS NULL AND existing_confirmation_turn IS NOT NULL)
       OR (p_confirmation_turn_id IS NOT NULL AND (
         existing_confirmation_turn IS DISTINCT FROM p_confirmation_turn_id
         OR existing_confirmation_option IS DISTINCT FROM p_confirmation_option_id
       )) THEN
      RAISE EXCEPTION 'turn confirmation replay does not match the immutable request' USING ERRCODE = '23505';
    END IF;
    conversation_id := existing_conversation_id;
    confirmed_option_id := existing_confirmation_option;
    SELECT completed.provider_response_id INTO previous_provider_response
      FROM control_plane.conversation_turns AS completed
     WHERE completed.tenant_id = selected_tenant
       AND completed.conversation_id = existing_conversation_id
       AND completed.status = 'completed'
       AND completed.hidden_at IS NULL
       AND completed.turn_number < (
         SELECT existing.turn_number
           FROM control_plane.conversation_turns AS existing
          WHERE existing.tenant_id = selected_tenant
            AND existing.turn_id = p_turn_id
       )
     ORDER BY completed.turn_number DESC
     LIMIT 1;
    previous_response_id := previous_provider_response;
    RETURN NEXT;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM control_plane.conversation_turns AS colliding_turn
     WHERE colliding_turn.tenant_id = selected_tenant
       AND colliding_turn.turn_id = p_turn_id
  ) THEN
    RAISE EXCEPTION 'turn id collision' USING ERRCODE = '23505';
  END IF;

  IF resolved_conversation IS NULL THEN
    IF p_confirmation_turn_id IS NOT NULL THEN
      RAISE EXCEPTION 'a confirmation requires its existing conversation' USING ERRCODE = '22023';
    END IF;
    resolved_conversation := control_plane.generate_ulid();
    INSERT INTO control_plane.conversations (
      tenant_id, conversation_id, status, created_by
    ) VALUES (
      selected_tenant, resolved_conversation, 'active', actor
    );
  ELSE
    PERFORM 1
      FROM control_plane.conversations AS conversation
     WHERE conversation.tenant_id = selected_tenant
       AND conversation.conversation_id = resolved_conversation
       AND conversation.created_by = actor
       AND conversation.status = 'active'
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'conversation was not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('conversation:' || selected_tenant || ':' || resolved_conversation, 0)
  );
  IF EXISTS (
    SELECT 1 FROM control_plane.conversation_turns AS active_turn
     WHERE active_turn.tenant_id = selected_tenant
       AND active_turn.conversation_id = resolved_conversation
       AND active_turn.status = 'running'
       AND active_turn.hidden_at IS NULL
  ) THEN
    RAISE EXCEPTION 'another turn is already running for this conversation' USING ERRCODE = '55000';
  END IF;

  IF p_confirmation_turn_id IS NOT NULL THEN
    SELECT option.* INTO selected_option
      FROM control_plane.clarification_options AS option
      JOIN control_plane.clarification_prompts AS prompt
        ON prompt.tenant_id = option.tenant_id
       AND prompt.offered_turn_id = option.offered_turn_id
      JOIN control_plane.conversation_turns AS offered_turn
        ON offered_turn.tenant_id = option.tenant_id
       AND offered_turn.turn_id = option.offered_turn_id
      JOIN control_plane.answer_artifacts AS artifact
        ON artifact.tenant_id = offered_turn.tenant_id
       AND artifact.turn_id = offered_turn.turn_id
     WHERE option.tenant_id = selected_tenant
       AND option.conversation_id = resolved_conversation
       AND option.offered_turn_id = p_confirmation_turn_id
       AND option.option_id = p_confirmation_option_id
       AND prompt.consumed_turn_id IS NULL
       AND prompt.offered_by = actor
       AND offered_turn.created_by = actor
       AND offered_turn.status = 'completed'
       AND offered_turn.hidden_at IS NULL
       AND artifact.answer_state = 'clarification'
     FOR UPDATE OF prompt, option;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'clarification option was not found or was already consumed' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  SELECT coalesce(max(turn.turn_number), 0) + 1 INTO next_turn
    FROM control_plane.conversation_turns AS turn
   WHERE turn.tenant_id = selected_tenant
     AND turn.conversation_id = resolved_conversation;
  SELECT turn.provider_response_id INTO previous_provider_response
    FROM control_plane.conversation_turns AS turn
   WHERE turn.tenant_id = selected_tenant
     AND turn.conversation_id = resolved_conversation
     AND turn.status = 'completed'
     AND turn.hidden_at IS NULL
   ORDER BY turn.turn_number DESC
   LIMIT 1;

  INSERT INTO control_plane.conversation_turns (
    tenant_id, turn_id, conversation_id, turn_number, user_message,
    runtime_profile, status, created_by
  ) VALUES (
    selected_tenant, p_turn_id, resolved_conversation, next_turn, btrim(p_user_message),
    p_runtime_profile, 'running', actor
  );
  IF p_confirmation_turn_id IS NOT NULL THEN
    UPDATE control_plane.clarification_prompts
       SET consumed_turn_id = p_turn_id,
           consumed_option_id = p_confirmation_option_id,
           consumed_at = now()
     WHERE tenant_id = selected_tenant
       AND offered_turn_id = p_confirmation_turn_id
       AND consumed_turn_id IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'clarification option was consumed concurrently' USING ERRCODE = '55000';
    END IF;
    confirmed_option_id := selected_option.option_id;
    confirmed_preference := selected_option.preference_key;
    confirmed_value := selected_option.preference_value;
  END IF;
  UPDATE control_plane.conversations AS active_conversation
     SET updated_at = now()
   WHERE active_conversation.tenant_id = selected_tenant
     AND active_conversation.conversation_id = resolved_conversation;

  conversation_id := resolved_conversation;
  previous_response_id := previous_provider_response;
  RETURN NEXT;
END;
$$;

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
           artifact.answer_state, artifact.answer_text
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
          'fastMode', turn.runtime_profile -> 'fastMode'
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

REVOKE ALL ON FUNCTION public.albert_rewind_conversation_from_turn(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_rewind_conversation_from_turn(text, text) TO authenticated;

COMMIT;
