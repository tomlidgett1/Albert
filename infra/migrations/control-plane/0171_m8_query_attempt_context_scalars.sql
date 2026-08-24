-- 0171: Repair analytical query context capture after 0170's composite-row
-- assignment produced null scalar fields. Existing ledger rows stay immutable;
-- every new attempt receives the bounded question and recent-turn snapshot.

BEGIN;

CREATE OR REPLACE FUNCTION public.albert_record_analytical_query_attempt(
  p_query_attempt_id text,
  p_conversation_id text,
  p_turn_id text,
  p_runtime text,
  p_source text,
  p_operation text,
  p_query_document jsonb,
  p_topic text DEFAULT NULL,
  p_branch_label text DEFAULT NULL,
  p_correlation_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := extensions.albert_auth_uid();
  selected_tenant text := control_plane.require_current_tenant_id();
  selected_user_message text;
  selected_turn_number integer;
  selected_runtime_profile jsonb;
  selected_turn_status text;
  selected_title text;
  selected_tenant_name text;
  context_document jsonb;
  inserted_count integer;
  existing_matches boolean;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_query_attempt_id IS NULL OR NOT control_plane.is_ulid(p_query_attempt_id)
     OR p_conversation_id IS NULL OR NOT control_plane.is_ulid(p_conversation_id)
     OR p_turn_id IS NULL OR NOT control_plane.is_ulid(p_turn_id) THEN
    RAISE EXCEPTION 'query attempt, conversation and turn ids must be ULIDs'
      USING ERRCODE = '22023';
  END IF;
  IF p_runtime NOT IN ('albert-v3', 'codex-app-server')
     OR p_source NOT IN ('cube', 'shopifyql', 'shopify_admin', 'xero_mcp')
     OR p_operation IS NULL OR p_operation !~ '^[a-z][a-z0-9_.-]{1,79}$' THEN
    RAISE EXCEPTION 'query attempt routing metadata is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_query_document IS NULL OR jsonb_typeof(p_query_document) <> 'object'
     OR octet_length(p_query_document::text) > 65536
     OR control_plane.trace_event_has_forbidden_key(p_query_document) THEN
    RAISE EXCEPTION 'query document is invalid or contains forbidden diagnostic material'
      USING ERRCODE = '22023';
  END IF;
  IF p_topic IS NOT NULL AND length(p_topic) NOT BETWEEN 1 AND 240
     OR p_branch_label IS NOT NULL AND length(p_branch_label) NOT BETWEEN 1 AND 160
     OR p_correlation_id IS NOT NULL AND length(p_correlation_id) NOT BETWEEN 8 AND 160 THEN
    RAISE EXCEPTION 'query attempt display metadata is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT
    turn_row.user_message,
    turn_row.turn_number,
    turn_row.runtime_profile,
    turn_row.status,
    conversation.title,
    tenant.display_name
  INTO
    selected_user_message,
    selected_turn_number,
    selected_runtime_profile,
    selected_turn_status,
    selected_title,
    selected_tenant_name
  FROM control_plane.conversation_turns AS turn_row
  JOIN control_plane.conversations AS conversation
    ON conversation.tenant_id = turn_row.tenant_id
   AND conversation.conversation_id = turn_row.conversation_id
  JOIN control_plane.tenants AS tenant ON tenant.tenant_id = turn_row.tenant_id
  WHERE turn_row.tenant_id = selected_tenant
    AND turn_row.conversation_id = p_conversation_id
    AND turn_row.turn_id = p_turn_id
    AND turn_row.created_by = actor;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'the analytical query attempt is not bound to this actor turn'
      USING ERRCODE = '42501';
  END IF;
  IF selected_turn_status <> 'running' THEN
    RAISE EXCEPTION 'analytical query attempts require a running turn'
      USING ERRCODE = '55000';
  END IF;

  SELECT jsonb_build_object(
    'question', left(selected_user_message, 8000),
    'conversationTitle', selected_title,
    'turnNumber', selected_turn_number,
    'tenantName', selected_tenant_name,
    'runtimeProfile', selected_runtime_profile,
    'recentTurns', coalesce(jsonb_agg(jsonb_build_object(
      'turnId', recent.turn_id,
      'turnNumber', recent.turn_number,
      'userMessage', left(recent.user_message, 4000),
      'status', recent.status,
      'answerState', recent.answer_state,
      'assistantAnswer', recent.assistant_answer
    ) ORDER BY recent.turn_number), '[]'::jsonb)
  )
  INTO context_document
  FROM (
    SELECT turn_context.*,
      (
        SELECT left(coalesce(event_row.event->>'text', event_row.event->>'question'), 2000)
        FROM control_plane.conversation_turn_events AS event_row
        WHERE event_row.tenant_id = turn_context.tenant_id
          AND event_row.turn_id = turn_context.turn_id
          AND event_row.event->>'type' IN ('answer', 'clarification')
        ORDER BY event_row.sequence_number DESC
        LIMIT 1
      ) AS assistant_answer
    FROM control_plane.conversation_turns AS turn_context
    WHERE turn_context.tenant_id = selected_tenant
      AND turn_context.conversation_id = p_conversation_id
      AND turn_context.turn_number <= selected_turn_number
    ORDER BY turn_context.turn_number DESC
    LIMIT 6
  ) AS recent;

  INSERT INTO control_plane.analytical_query_attempts (
    tenant_id, query_attempt_id, conversation_id, turn_id, actor_user_id,
    runtime, source, operation, topic, branch_label, query_document,
    context_snapshot, correlation_id
  ) VALUES (
    selected_tenant, p_query_attempt_id, p_conversation_id, p_turn_id, actor,
    p_runtime, p_source, p_operation, p_topic, p_branch_label, p_query_document,
    context_document, p_correlation_id
  )
  ON CONFLICT (tenant_id, query_attempt_id) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;

  IF inserted_count = 0 THEN
    SELECT EXISTS (
      SELECT 1
      FROM control_plane.analytical_query_attempts AS existing
      WHERE existing.tenant_id = selected_tenant
        AND existing.query_attempt_id = p_query_attempt_id
        AND existing.conversation_id = p_conversation_id
        AND existing.turn_id = p_turn_id
        AND existing.actor_user_id = actor
        AND existing.runtime = p_runtime
        AND existing.source = p_source
        AND existing.operation = p_operation
        AND existing.topic IS NOT DISTINCT FROM p_topic
        AND existing.branch_label IS NOT DISTINCT FROM p_branch_label
        AND existing.query_document = p_query_document
    ) INTO existing_matches;
    IF NOT existing_matches THEN
      RAISE EXCEPTION 'query attempt id was replayed with different content'
        USING ERRCODE = '23505';
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.albert_record_analytical_query_attempt(text,text,text,text,text,text,jsonb,text,text,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.albert_record_analytical_query_attempt(text,text,text,text,text,text,jsonb,text,text,text)
  TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
