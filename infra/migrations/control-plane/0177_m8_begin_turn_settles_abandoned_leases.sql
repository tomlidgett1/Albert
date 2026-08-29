-- 0177 (M8): begin_albert_turn settles abandoned leases instead of locking
--
-- A turn left 'running' by a crashed or severed client blocked every
-- follow-up in its conversation with 55000 'another turn is already running'
-- until the lease expired and something else settled it (the 2026-08-29
-- hard100 production battery hit this repeatedly after a proxy-level
-- cascade killed in-flight turns). begin_albert_turn_core_v1 now settles
-- expired-lease running turns as failed ('turn_lease_expired') under the
-- conversation advisory lock before enforcing the single-live-turn guard.
-- The guard still refuses while a lease is genuinely live.

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
  -- An abandoned turn (crashed browser, killed client, severed stream) used
  -- to lock its conversation for the full lease: the running row never
  -- settled, and every follow-up was refused here. A running turn whose
  -- lease has expired is abandoned by definition — settle it as failed the
  -- same way the reaper would, then guard only against genuinely live turns.
  UPDATE control_plane.conversation_turns AS expired_turn
     SET status = 'failed',
         result_digest = COALESCE(expired_turn.result_digest, 'turn_lease_expired'),
         completed_at = now()
   WHERE expired_turn.tenant_id = selected_tenant
     AND expired_turn.conversation_id = resolved_conversation
     AND expired_turn.status = 'running'
     AND expired_turn.lease_expires_at IS NOT NULL
     AND expired_turn.lease_expires_at <= clock_timestamp();
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

