-- 0170: Complete analytical query-attempt ledger and Tom-only diagnostics (ADR 0126).
--
-- A successful trace event is not evidence that every attempted query was
-- observed: validation, execution, cancellation and runtime failures can occur
-- before a query event exists. Starts and outcomes are separate immutable rows
-- so a killed process leaves an explicit interrupted attempt. The database,
-- rather than the caller, snapshots bounded conversation context.

BEGIN;

CREATE TABLE IF NOT EXISTS control_plane.analytical_query_outcome_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL CHECK (length(btrim(description)) > 0)
);

INSERT INTO control_plane.analytical_query_outcome_status_lookup (status, description)
VALUES
  ('succeeded', 'The governed query completed and returned a valid result'),
  ('failed', 'The query reached an execution boundary but did not return a valid result'),
  ('rejected', 'Trusted validation or an execution policy refused the query before a valid result'),
  ('cancelled', 'The query was cancelled before a valid result completed')
ON CONFLICT (status) DO UPDATE SET description = EXCLUDED.description;

CREATE TABLE IF NOT EXISTS control_plane.analytical_query_attempts (
  tenant_id text NOT NULL,
  query_attempt_id text NOT NULL CHECK (control_plane.is_ulid(query_attempt_id)),
  conversation_id text NOT NULL CHECK (control_plane.is_ulid(conversation_id)),
  turn_id text NOT NULL CHECK (control_plane.is_ulid(turn_id)),
  actor_user_id uuid NOT NULL,
  runtime text NOT NULL CHECK (runtime IN ('albert-v3', 'codex-app-server')),
  source text NOT NULL CHECK (source IN ('cube', 'shopifyql', 'shopify_admin', 'xero_mcp')),
  operation text NOT NULL CHECK (
    operation ~ '^[a-z][a-z0-9_.-]{1,79}$'
  ),
  topic text CHECK (topic IS NULL OR length(topic) BETWEEN 1 AND 240),
  branch_label text CHECK (branch_label IS NULL OR length(branch_label) BETWEEN 1 AND 160),
  query_document jsonb NOT NULL,
  context_snapshot jsonb NOT NULL,
  correlation_id text CHECK (correlation_id IS NULL OR length(correlation_id) BETWEEN 8 AND 160),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, query_attempt_id),
  FOREIGN KEY (tenant_id, turn_id)
    REFERENCES control_plane.conversation_turns (tenant_id, turn_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES control_plane.conversations (tenant_id, conversation_id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(query_document) = 'object'),
  CHECK (jsonb_typeof(context_snapshot) = 'object'),
  CHECK (octet_length(query_document::text) <= 65536),
  CHECK (octet_length(context_snapshot::text) <= 65536),
  CHECK (NOT control_plane.trace_event_has_forbidden_key(query_document))
);

COMMENT ON TABLE control_plane.analytical_query_attempts IS
  'Append-only, pre-execution ledger for every governed analytical query attempt. Contains bounded typed query IR and database-derived question context; never SQL, credentials, provider payloads or hidden reasoning.';

CREATE TABLE IF NOT EXISTS control_plane.analytical_query_outcomes (
  tenant_id text NOT NULL,
  query_attempt_id text NOT NULL,
  status text NOT NULL
    REFERENCES control_plane.analytical_query_outcome_status_lookup(status),
  execution_ms integer CHECK (execution_ms IS NULL OR execution_ms BETWEEN 0 AND 3600000),
  row_count integer CHECK (row_count IS NULL OR row_count BETWEEN 0 AND 2000000),
  failure_code text CHECK (
    failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_]{1,119}$'
  ),
  failure_message text CHECK (
    failure_message IS NULL OR length(failure_message) BETWEEN 1 AND 1000
  ),
  result_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, query_attempt_id),
  FOREIGN KEY (tenant_id, query_attempt_id)
    REFERENCES control_plane.analytical_query_attempts (tenant_id, query_attempt_id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(result_metadata) = 'object'),
  CHECK (octet_length(result_metadata::text) <= 16384),
  CHECK (
    (status = 'succeeded' AND failure_code IS NULL AND failure_message IS NULL)
    OR
    (status <> 'succeeded' AND failure_code IS NOT NULL AND failure_message IS NOT NULL)
  )
);

COMMENT ON TABLE control_plane.analytical_query_outcomes IS
  'Append-only terminal outcomes for analytical_query_attempts. No row means the process has not yet completed or was interrupted.';

CREATE INDEX IF NOT EXISTS analytical_query_attempts_tenant_turn_idx
  ON control_plane.analytical_query_attempts (tenant_id, turn_id, started_at DESC);
CREATE INDEX IF NOT EXISTS analytical_query_attempts_tenant_recent_idx
  ON control_plane.analytical_query_attempts (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS analytical_query_attempts_recent_idx
  ON control_plane.analytical_query_attempts (started_at DESC);
CREATE INDEX IF NOT EXISTS analytical_query_outcomes_tenant_status_idx
  ON control_plane.analytical_query_outcomes (tenant_id, status, completed_at DESC);

ALTER TABLE control_plane.analytical_query_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.analytical_query_outcomes ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION control_plane.reject_analytical_query_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF control_plane.deletion_mutation_authorized() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'analytical query logs are append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS analytical_query_attempts_append_only
  ON control_plane.analytical_query_attempts;
CREATE TRIGGER analytical_query_attempts_append_only
  BEFORE UPDATE OR DELETE ON control_plane.analytical_query_attempts
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_analytical_query_log_mutation();

DROP TRIGGER IF EXISTS analytical_query_outcomes_append_only
  ON control_plane.analytical_query_outcomes;
CREATE TRIGGER analytical_query_outcomes_append_only
  BEFORE UPDATE OR DELETE ON control_plane.analytical_query_outcomes
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_analytical_query_log_mutation();

CREATE OR REPLACE FUNCTION control_plane.is_analytical_query_log_viewer()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT extensions.albert_auth_uid() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM extensions.albert_auth_confirmed_user_by_email('tom@lidgett.net') AS user_account
      WHERE user_account.id = extensions.albert_auth_uid()
    );
$$;

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
  selected_turn control_plane.conversation_turns%ROWTYPE;
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

  SELECT turn_row
  INTO selected_turn
  FROM control_plane.conversation_turns AS turn_row
  WHERE turn_row.tenant_id = selected_tenant
    AND turn_row.conversation_id = p_conversation_id
    AND turn_row.turn_id = p_turn_id
    AND turn_row.created_by = actor;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'the analytical query attempt is not bound to this actor turn'
      USING ERRCODE = '42501';
  END IF;
  IF selected_turn.status <> 'running' THEN
    RAISE EXCEPTION 'analytical query attempts require a running turn'
      USING ERRCODE = '55000';
  END IF;

  SELECT conversation.title, tenant.display_name
  INTO selected_title, selected_tenant_name
  FROM control_plane.conversations AS conversation
  JOIN control_plane.tenants AS tenant ON tenant.tenant_id = conversation.tenant_id
  WHERE conversation.tenant_id = selected_tenant
    AND conversation.conversation_id = p_conversation_id;

  SELECT jsonb_build_object(
    'question', left(selected_turn.user_message, 8000),
    'conversationTitle', selected_title,
    'turnNumber', selected_turn.turn_number,
    'tenantName', selected_tenant_name,
    'runtimeProfile', selected_turn.runtime_profile,
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
      AND turn_context.turn_number <= selected_turn.turn_number
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

CREATE OR REPLACE FUNCTION public.albert_record_analytical_query_outcome(
  p_query_attempt_id text,
  p_status text,
  p_execution_ms integer DEFAULT NULL,
  p_row_count integer DEFAULT NULL,
  p_failure_code text DEFAULT NULL,
  p_failure_message text DEFAULT NULL,
  p_result_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := extensions.albert_auth_uid();
  selected_tenant text := control_plane.require_current_tenant_id();
  inserted_count integer;
  existing_matches boolean;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_query_attempt_id IS NULL OR NOT control_plane.is_ulid(p_query_attempt_id)
     OR p_status NOT IN ('succeeded', 'failed', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'query outcome identity or status is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_execution_ms IS NOT NULL AND p_execution_ms NOT BETWEEN 0 AND 3600000
     OR p_row_count IS NOT NULL AND p_row_count NOT BETWEEN 0 AND 2000000
     OR p_result_metadata IS NULL OR jsonb_typeof(p_result_metadata) <> 'object'
     OR octet_length(p_result_metadata::text) > 16384 THEN
    RAISE EXCEPTION 'query outcome metadata is invalid' USING ERRCODE = '22023';
  END IF;
  IF (p_status = 'succeeded' AND (p_failure_code IS NOT NULL OR p_failure_message IS NOT NULL))
     OR (p_status <> 'succeeded' AND (
       p_failure_code IS NULL OR p_failure_code !~ '^[a-z][a-z0-9_]{1,119}$'
       OR p_failure_message IS NULL OR length(p_failure_message) NOT BETWEEN 1 AND 1000
     )) THEN
    RAISE EXCEPTION 'query outcome failure evidence is invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM control_plane.analytical_query_attempts AS attempt
    WHERE attempt.tenant_id = selected_tenant
      AND attempt.query_attempt_id = p_query_attempt_id
      AND attempt.actor_user_id = actor
  ) THEN
    RAISE EXCEPTION 'the analytical query attempt is not available to this actor'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO control_plane.analytical_query_outcomes (
    tenant_id, query_attempt_id, status, execution_ms, row_count,
    failure_code, failure_message, result_metadata
  ) VALUES (
    selected_tenant, p_query_attempt_id, p_status, p_execution_ms, p_row_count,
    p_failure_code, p_failure_message, p_result_metadata
  )
  ON CONFLICT (tenant_id, query_attempt_id) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;

  IF inserted_count = 0 THEN
    SELECT EXISTS (
      SELECT 1
      FROM control_plane.analytical_query_outcomes AS existing
      WHERE existing.tenant_id = selected_tenant
        AND existing.query_attempt_id = p_query_attempt_id
        AND existing.status = p_status
        AND existing.execution_ms IS NOT DISTINCT FROM p_execution_ms
        AND existing.row_count IS NOT DISTINCT FROM p_row_count
        AND existing.failure_code IS NOT DISTINCT FROM p_failure_code
        AND existing.failure_message IS NOT DISTINCT FROM p_failure_message
        AND existing.result_metadata = p_result_metadata
    ) INTO existing_matches;
    IF NOT existing_matches THEN
      RAISE EXCEPTION 'query outcome was replayed with different content'
        USING ERRCODE = '23505';
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_analytical_query_log_viewer_status()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT control_plane.is_analytical_query_log_viewer();
$$;

CREATE OR REPLACE FUNCTION public.albert_analytical_query_logs(
  p_status text DEFAULT 'failures',
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := extensions.albert_auth_uid();
  normalized_search text := nullif(btrim(p_search), '');
  summary_document jsonb;
  items_document jsonb;
BEGIN
  IF actor IS NULL OR NOT control_plane.is_analytical_query_log_viewer() THEN
    RAISE EXCEPTION 'analytical query log access is restricted'
      USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('all', 'failures', 'succeeded', 'in_progress')
     OR p_limit NOT BETWEEN 1 AND 200
     OR normalized_search IS NOT NULL AND length(normalized_search) > 120 THEN
    RAISE EXCEPTION 'analytical query log filters are invalid' USING ERRCODE = '22023';
  END IF;

  INSERT INTO control_plane.operator_audit_log (
    operator_audit_id, actor_user_id, action, request_metadata
  ) VALUES (
    control_plane.generate_ulid(), actor, 'operator.query_logs_read',
    jsonb_build_object('status', p_status, 'searched', normalized_search IS NOT NULL, 'limit', p_limit)
  );

  SELECT jsonb_build_object(
    'windowDays', 30,
    'total', count(*),
    'succeeded', count(*) FILTER (WHERE resolved.status = 'succeeded'),
    'failures', count(*) FILTER (WHERE resolved.status IN ('failed', 'rejected', 'cancelled', 'interrupted')),
    'inProgress', count(*) FILTER (WHERE resolved.status = 'in_progress'),
    'failureRate', CASE WHEN count(*) = 0 THEN 0 ELSE round(
      count(*) FILTER (WHERE resolved.status IN ('failed', 'rejected', 'cancelled', 'interrupted'))::numeric
      / count(*)::numeric, 4
    ) END
  ) INTO summary_document
  FROM (
    SELECT CASE
      WHEN outcome.status IS NOT NULL THEN outcome.status
      WHEN attempt.started_at < clock_timestamp() - interval '15 minutes' THEN 'interrupted'
      ELSE 'in_progress'
    END AS status
    FROM control_plane.analytical_query_attempts AS attempt
    LEFT JOIN control_plane.analytical_query_outcomes AS outcome
      ON outcome.tenant_id = attempt.tenant_id
     AND outcome.query_attempt_id = attempt.query_attempt_id
    WHERE attempt.started_at >= clock_timestamp() - interval '30 days'
  ) AS resolved;

  SELECT coalesce(jsonb_agg(row_data.payload ORDER BY row_data.started_at DESC, row_data.query_attempt_id DESC), '[]'::jsonb)
  INTO items_document
  FROM (
    SELECT attempt.started_at, attempt.query_attempt_id, jsonb_build_object(
      'queryAttemptId', attempt.query_attempt_id,
      'tenantId', attempt.tenant_id,
      'tenantName', tenant.display_name,
      'actorEmail', user_account.email,
      'conversationId', attempt.conversation_id,
      'turnId', attempt.turn_id,
      'runtime', attempt.runtime,
      'source', attempt.source,
      'operation', attempt.operation,
      'topic', attempt.topic,
      'branchLabel', attempt.branch_label,
      'status', CASE
        WHEN outcome.status IS NOT NULL THEN outcome.status
        WHEN attempt.started_at < clock_timestamp() - interval '15 minutes' THEN 'interrupted'
        ELSE 'in_progress'
      END,
      'queryDocument', attempt.query_document,
      'contextSnapshot', attempt.context_snapshot,
      'correlationId', attempt.correlation_id,
      'executionMs', outcome.execution_ms,
      'rowCount', outcome.row_count,
      'failureCode', outcome.failure_code,
      'failureMessage', outcome.failure_message,
      'resultMetadata', coalesce(outcome.result_metadata, '{}'::jsonb),
      'startedAt', attempt.started_at,
      'completedAt', outcome.completed_at
    ) AS payload
    FROM control_plane.analytical_query_attempts AS attempt
    JOIN control_plane.tenants AS tenant ON tenant.tenant_id = attempt.tenant_id
    JOIN LATERAL extensions.albert_auth_users_by_ids(ARRAY[attempt.actor_user_id]) AS user_account
      ON user_account.id = attempt.actor_user_id
    LEFT JOIN control_plane.analytical_query_outcomes AS outcome
      ON outcome.tenant_id = attempt.tenant_id
     AND outcome.query_attempt_id = attempt.query_attempt_id
    WHERE (
      p_status = 'all'
      OR p_status = 'succeeded' AND outcome.status = 'succeeded'
      OR p_status = 'failures' AND (
        outcome.status IN ('failed', 'rejected', 'cancelled')
        OR outcome.status IS NULL AND attempt.started_at < clock_timestamp() - interval '15 minutes'
      )
      OR p_status = 'in_progress' AND outcome.status IS NULL
        AND attempt.started_at >= clock_timestamp() - interval '15 minutes'
    )
      AND (
        normalized_search IS NULL
        OR attempt.context_snapshot->>'question' ILIKE '%' || normalized_search || '%'
        OR coalesce(attempt.topic, '') ILIKE '%' || normalized_search || '%'
        OR attempt.operation ILIKE '%' || normalized_search || '%'
        OR tenant.display_name ILIKE '%' || normalized_search || '%'
        OR coalesce(outcome.failure_message, '') ILIKE '%' || normalized_search || '%'
      )
    ORDER BY attempt.started_at DESC, attempt.query_attempt_id DESC
    LIMIT p_limit
  ) AS row_data;

  RETURN jsonb_build_object(
    'generatedAt', clock_timestamp(),
    'summary', summary_document,
    'items', items_document
  );
END;
$$;

REVOKE ALL ON TABLE
  control_plane.analytical_query_outcome_status_lookup,
  control_plane.analytical_query_attempts,
  control_plane.analytical_query_outcomes
FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION control_plane.reject_analytical_query_log_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION control_plane.is_analytical_query_log_viewer()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.albert_record_analytical_query_attempt(text,text,text,text,text,text,jsonb,text,text,text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.albert_record_analytical_query_outcome(text,text,integer,integer,text,text,jsonb)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.albert_analytical_query_log_viewer_status()
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.albert_analytical_query_logs(text,text,integer)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.albert_record_analytical_query_attempt(text,text,text,text,text,text,jsonb,text,text,text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_record_analytical_query_outcome(text,text,integer,integer,text,text,jsonb)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_analytical_query_log_viewer_status()
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_analytical_query_logs(text,text,integer)
  TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
