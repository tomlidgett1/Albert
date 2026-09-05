-- 0140: allow 'plan' trace events (the agent's visible working plan with
-- tick-off steps) through the append gate. Identical to the 0002 definition
-- except for the widened type whitelist.

BEGIN;

CREATE OR REPLACE FUNCTION public.albert_answer_event_append(
  p_conversation_id text,
  p_turn_id text,
  p_event jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := extensions.albert_auth_uid();
  selected_tenant text := control_plane.require_current_tenant_id();
  next_sequence integer;
BEGIN
  IF p_event IS NULL OR jsonb_typeof(p_event) <> 'object'
     OR octet_length(p_event::text) > 2097152
     OR coalesce(p_event ->> 'id', '') !~ '^.{1,128}$'
     OR coalesce(p_event ->> 'type', '') NOT IN (
       'progress', 'narrative', 'plan', 'query', 'table', 'chart',
       'validation', 'answer', 'clarification', 'error'
     )
     OR coalesce(p_event ->> 'sequence', '') !~ '^[1-9][0-9]*$'
     OR coalesce(p_event ->> 'occurredAt', '') IN ('', 'infinity', '-infinity')
     OR control_plane.trace_event_has_forbidden_key(p_event) THEN
    RAISE EXCEPTION 'event must be an object' USING ERRCODE = '22023';
  END IF;
  BEGIN
    PERFORM (p_event ->> 'occurredAt')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'event occurredAt is invalid' USING ERRCODE = '22023';
  END;

  PERFORM 1
  FROM control_plane.conversation_turns AS turn
  JOIN control_plane.conversations AS conversation
    ON conversation.tenant_id = turn.tenant_id
   AND conversation.conversation_id = turn.conversation_id
  WHERE turn.tenant_id = selected_tenant
    AND turn.turn_id = p_turn_id
    AND turn.conversation_id = p_conversation_id
    AND turn.status = 'running'
    AND turn.created_by = actor
    AND conversation.created_by = actor
  FOR UPDATE OF turn;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'running conversation turn was not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT coalesce(max(event.sequence_number), 0) + 1
    INTO next_sequence
  FROM control_plane.conversation_turn_events AS event
  WHERE event.tenant_id = selected_tenant
    AND event.turn_id = p_turn_id;

  IF (p_event ->> 'sequence')::integer <> next_sequence THEN
    RAISE EXCEPTION 'event sequence is not contiguous' USING ERRCODE = '22023';
  END IF;

  INSERT INTO control_plane.conversation_turn_events (
    tenant_id, turn_event_id, conversation_id, turn_id, sequence_number, event
  ) VALUES (
    selected_tenant, control_plane.generate_ulid(), p_conversation_id,
    p_turn_id, next_sequence, p_event
  );

  RETURN next_sequence;
END;
$$;

REVOKE ALL ON FUNCTION public.albert_answer_event_append(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_answer_event_append(text, text, jsonb) TO authenticated;

COMMIT;
