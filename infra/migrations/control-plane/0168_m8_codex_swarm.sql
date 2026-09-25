-- 0168: Codex Swarm sub-agents (ADR 0120).
--
-- An explicit Swarm send on the Codex composer allocates 2-5 disjoint
-- work packages. Each worker is a real Codex conversation. The parent
-- conversation keeps the owner's question and the synthesised answer.
-- Access is membership-scoped through SECURITY DEFINER RPCs. Child
-- conversation ids are returned so the dash can keep them out of
-- sidebar history.

BEGIN;

CREATE TABLE IF NOT EXISTS control_plane.swarm_runs (
  tenant_id text NOT NULL,
  run_id text NOT NULL CHECK (control_plane.is_ulid(run_id)),
  parent_conversation_id text NOT NULL CHECK (control_plane.is_ulid(parent_conversation_id)),
  parent_turn_id text NOT NULL CHECK (control_plane.is_ulid(parent_turn_id)),
  question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 8000),
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN (
      'running', 'synthesising', 'completed', 'failed', 'stopped', 'abandoned'
    )),
  agent_count integer NOT NULL CHECK (agent_count BETWEEN 2 AND 5),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 120),
  reasoning_effort text NOT NULL
    CHECK (reasoning_effort IN ('none', 'low', 'medium', 'high', 'xhigh', 'max')),
  plan jsonb NOT NULL DEFAULT '{}'::jsonb,
  synthesis jsonb,
  started_by uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, run_id),
  FOREIGN KEY (tenant_id, parent_conversation_id)
    REFERENCES control_plane.conversations (tenant_id, conversation_id)
    ON DELETE CASCADE,
  CHECK (jsonb_typeof(plan) = 'object'),
  CHECK (synthesis IS NULL OR jsonb_typeof(synthesis) = 'object')
);
CREATE INDEX IF NOT EXISTS swarm_runs_by_parent
  ON control_plane.swarm_runs (tenant_id, parent_conversation_id, started_at DESC);
CREATE INDEX IF NOT EXISTS swarm_runs_recent
  ON control_plane.swarm_runs (tenant_id, started_at DESC);
ALTER TABLE control_plane.swarm_runs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS control_plane.swarm_agents (
  tenant_id text NOT NULL,
  agent_row_id text NOT NULL DEFAULT control_plane.generate_ulid(),
  run_id text NOT NULL,
  agent_key text NOT NULL CHECK (agent_key ~ '^[a-z][a-z0-9-]{2,60}$'),
  agent_title text NOT NULL CHECK (length(agent_title) BETWEEN 1 AND 120),
  agent_tagline text NOT NULL DEFAULT '' CHECK (length(agent_tagline) <= 240),
  agent_role text NOT NULL
    CHECK (agent_role IN ('measure', 'explain', 'challenge', 'reconcile')),
  assignment text NOT NULL CHECK (length(assignment) BETWEEN 1 AND 800),
  lane_exclude text NOT NULL DEFAULT '' CHECK (length(lane_exclude) <= 800),
  prompt text NOT NULL CHECK (length(prompt) BETWEEN 1 AND 4000),
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 5),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'stopped')),
  conversation_id text CHECK (conversation_id IS NULL OR control_plane.is_ulid(conversation_id)),
  turn_id text CHECK (turn_id IS NULL OR control_plane.is_ulid(turn_id)),
  answer_state text CHECK (answer_state IS NULL OR answer_state IN
    ('Verified', 'Derived', 'Qualified', 'Exploratory', 'Clarification', 'No data', 'Unavailable')),
  headline text CHECK (headline IS NULL OR length(headline) <= 300),
  summary text CHECK (summary IS NULL OR length(summary) <= 8000),
  key_numbers jsonb NOT NULL DEFAULT '[]'::jsonb,
  questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  failure_note text CHECK (failure_note IS NULL OR length(failure_note) <= 300),
  started_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, agent_row_id),
  UNIQUE (tenant_id, run_id, agent_key),
  FOREIGN KEY (tenant_id, run_id)
    REFERENCES control_plane.swarm_runs (tenant_id, run_id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(key_numbers) = 'array'),
  CHECK (jsonb_typeof(questions) = 'array')
);
CREATE INDEX IF NOT EXISTS swarm_agents_by_run
  ON control_plane.swarm_agents (tenant_id, run_id, sequence);
ALTER TABLE control_plane.swarm_agents ENABLE ROW LEVEL SECURITY;

INSERT INTO control_plane.rate_limit_policies (
  action, request_limit, window_seconds, audit_excess
) VALUES
  ('swarm.run', 10, 3600, false)
ON CONFLICT (action) DO UPDATE SET
  request_limit = EXCLUDED.request_limit,
  window_seconds = EXCLUDED.window_seconds,
  audit_excess = EXCLUDED.audit_excess;

CREATE OR REPLACE FUNCTION control_plane.swarm_agent_row_json(agent control_plane.swarm_agents)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'agentKey', agent.agent_key,
    'title', agent.agent_title,
    'tagline', agent.agent_tagline,
    'role', agent.agent_role,
    'assignment', agent.assignment,
    'exclude', agent.lane_exclude,
    'prompt', agent.prompt,
    'sequence', agent.sequence,
    'status', agent.status,
    'conversationId', agent.conversation_id,
    'turnId', agent.turn_id,
    'answerState', agent.answer_state,
    'headline', agent.headline,
    'summary', agent.summary,
    'keyNumbers', agent.key_numbers,
    'questions', agent.questions,
    'failureNote', agent.failure_note,
    'startedAt', agent.started_at,
    'completedAt', agent.completed_at
  );
$$;

CREATE OR REPLACE FUNCTION control_plane.swarm_run_json(p_tenant_id text, p_run_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'runId', run.run_id,
    'parentConversationId', run.parent_conversation_id,
    'parentTurnId', run.parent_turn_id,
    'question', run.question,
    'status', run.status,
    'agentCount', run.agent_count,
    'model', run.model,
    'reasoningEffort', run.reasoning_effort,
    'plan', run.plan,
    'synthesis', run.synthesis,
    'startedAt', run.started_at,
    'completedAt', run.completed_at,
    'agents', coalesce((
      SELECT jsonb_agg(control_plane.swarm_agent_row_json(agent) ORDER BY agent.sequence)
      FROM control_plane.swarm_agents AS agent
      WHERE agent.tenant_id = run.tenant_id AND agent.run_id = run.run_id
    ), '[]'::jsonb)
  )
  FROM control_plane.swarm_runs AS run
  WHERE run.tenant_id = p_tenant_id AND run.run_id = p_run_id;
$$;

CREATE OR REPLACE FUNCTION control_plane.swarm_hidden_conversation_ids(p_tenant_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT coalesce((
    SELECT jsonb_agg(ids.conversation_id)
    FROM (
      SELECT DISTINCT agent.conversation_id
      FROM control_plane.swarm_agents AS agent
      WHERE agent.tenant_id = p_tenant_id AND agent.conversation_id IS NOT NULL
      ORDER BY agent.conversation_id DESC
      LIMIT 400
    ) AS ids
  ), '[]'::jsonb);
$$;

CREATE OR REPLACE FUNCTION control_plane.swarm_settle_run(p_tenant_id text, p_run_id text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_open integer;
  v_completed integer;
  v_status text;
BEGIN
  SELECT run.status INTO v_status
  FROM control_plane.swarm_runs AS run
  WHERE run.tenant_id = p_tenant_id AND run.run_id = p_run_id;
  IF v_status IN ('stopped', 'abandoned', 'completed') THEN
    RETURN;
  END IF;
  SELECT
    count(*) FILTER (WHERE agent.status IN ('pending', 'running')),
    count(*) FILTER (WHERE agent.status = 'completed')
  INTO v_open, v_completed
  FROM control_plane.swarm_agents AS agent
  WHERE agent.tenant_id = p_tenant_id AND agent.run_id = p_run_id;
  IF v_open > 0 THEN
    UPDATE control_plane.swarm_runs
    SET status = 'running', completed_at = NULL
    WHERE tenant_id = p_tenant_id AND run_id = p_run_id
      AND status NOT IN ('synthesising', 'stopped', 'abandoned');
  ELSIF v_completed > 0 THEN
    UPDATE control_plane.swarm_runs
    SET status = CASE WHEN status = 'synthesising' THEN status ELSE 'synthesising' END
    WHERE tenant_id = p_tenant_id AND run_id = p_run_id
      AND status NOT IN ('completed', 'stopped', 'abandoned');
  ELSE
    UPDATE control_plane.swarm_runs
    SET status = 'failed', completed_at = clock_timestamp()
    WHERE tenant_id = p_tenant_id AND run_id = p_run_id
      AND status NOT IN ('completed', 'stopped', 'abandoned');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_swarm_panel()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text := control_plane.require_current_tenant_id();
  v_run_id text;
BEGIN
  SELECT run.run_id INTO v_run_id
  FROM control_plane.swarm_runs AS run
  WHERE run.tenant_id = v_tenant_id
  ORDER BY run.started_at DESC
  LIMIT 1;
  RETURN jsonb_build_object(
    'run', CASE WHEN v_run_id IS NULL THEN NULL
      ELSE control_plane.swarm_run_json(v_tenant_id, v_run_id) END,
    'conversationIds', control_plane.swarm_hidden_conversation_ids(v_tenant_id)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_swarm_get_run(p_run_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text := control_plane.require_current_tenant_id();
BEGIN
  IF p_run_id IS NULL OR NOT control_plane.is_ulid(p_run_id) THEN
    RAISE EXCEPTION 'swarm run id must be a ULID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM control_plane.swarm_runs AS run
    WHERE run.tenant_id = v_tenant_id AND run.run_id = p_run_id
  ) THEN
    RAISE EXCEPTION 'swarm run not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN control_plane.swarm_run_json(v_tenant_id, p_run_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_swarm_for_conversation(p_conversation_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text := control_plane.require_current_tenant_id();
  v_run_id text;
BEGIN
  IF p_conversation_id IS NULL OR NOT control_plane.is_ulid(p_conversation_id) THEN
    RAISE EXCEPTION 'conversation id must be a ULID' USING ERRCODE = '22023';
  END IF;
  SELECT run.run_id INTO v_run_id
  FROM control_plane.swarm_runs AS run
  WHERE run.tenant_id = v_tenant_id
    AND run.parent_conversation_id = p_conversation_id
  ORDER BY run.started_at DESC
  LIMIT 1;
  RETURN jsonb_build_object(
    'run', CASE WHEN v_run_id IS NULL THEN NULL
      ELSE control_plane.swarm_run_json(v_tenant_id, v_run_id) END,
    'conversationIds', control_plane.swarm_hidden_conversation_ids(v_tenant_id)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_swarm_begin_run(
  p_run_id text,
  p_parent_conversation_id text,
  p_parent_turn_id text,
  p_question text,
  p_model text,
  p_reasoning_effort text,
  p_plan jsonb,
  p_agents jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text := control_plane.require_current_tenant_id();
  v_actor uuid := extensions.albert_auth_uid();
  v_count integer;
BEGIN
  IF p_run_id IS NULL OR NOT control_plane.is_ulid(p_run_id) THEN
    RAISE EXCEPTION 'swarm run id must be a ULID' USING ERRCODE = '22023';
  END IF;
  IF p_parent_conversation_id IS NULL OR NOT control_plane.is_ulid(p_parent_conversation_id) THEN
    RAISE EXCEPTION 'swarm parent conversation must be a ULID' USING ERRCODE = '22023';
  END IF;
  IF p_parent_turn_id IS NULL OR NOT control_plane.is_ulid(p_parent_turn_id) THEN
    RAISE EXCEPTION 'swarm parent turn must be a ULID' USING ERRCODE = '22023';
  END IF;
  IF p_question IS NULL OR length(btrim(p_question)) < 1 OR length(p_question) > 8000 THEN
    RAISE EXCEPTION 'swarm question is required' USING ERRCODE = '22023';
  END IF;
  IF p_agents IS NULL OR jsonb_typeof(p_agents) <> 'array' THEN
    RAISE EXCEPTION 'swarm agents must be a JSON array' USING ERRCODE = '22023';
  END IF;
  v_count := jsonb_array_length(p_agents);
  IF v_count < 2 OR v_count > 5 THEN
    RAISE EXCEPTION 'swarm runs support 2-5 agents' USING ERRCODE = '22023';
  END IF;
  IF p_plan IS NULL OR jsonb_typeof(p_plan) <> 'object' THEN
    RAISE EXCEPTION 'swarm plan must be a JSON object' USING ERRCODE = '22023';
  END IF;

  UPDATE control_plane.swarm_runs
  SET status = 'abandoned', completed_at = clock_timestamp()
  WHERE tenant_id = v_tenant_id
    AND parent_conversation_id = p_parent_conversation_id
    AND status IN ('running', 'synthesising');

  INSERT INTO control_plane.swarm_runs (
    tenant_id, run_id, parent_conversation_id, parent_turn_id, question,
    status, agent_count, model, reasoning_effort, plan, started_by
  ) VALUES (
    v_tenant_id, p_run_id, p_parent_conversation_id, p_parent_turn_id,
    left(btrim(p_question), 8000), 'running', v_count, p_model,
    p_reasoning_effort, p_plan, v_actor
  );

  INSERT INTO control_plane.swarm_agents (
    tenant_id, run_id, agent_key, agent_title, agent_tagline, agent_role,
    assignment, lane_exclude, prompt, sequence
  )
  SELECT
    v_tenant_id,
    p_run_id,
    agent.value ->> 'key',
    left(agent.value ->> 'title', 120),
    left(coalesce(agent.value ->> 'tagline', ''), 240),
    agent.value ->> 'role',
    left(agent.value ->> 'assignment', 800),
    left(coalesce(agent.value ->> 'exclude', ''), 800),
    left(agent.value ->> 'prompt', 4000),
    agent.ordinality::integer
  FROM jsonb_array_elements(p_agents) WITH ORDINALITY AS agent(value, ordinality);

  RETURN control_plane.swarm_run_json(v_tenant_id, p_run_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_swarm_agent_started(
  p_run_id text,
  p_agent_key text,
  p_conversation_id text,
  p_turn_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text := control_plane.require_current_tenant_id();
  v_row control_plane.swarm_agents%ROWTYPE;
BEGIN
  UPDATE control_plane.swarm_agents
  SET status = 'running',
      conversation_id = p_conversation_id,
      turn_id = p_turn_id,
      started_at = coalesce(started_at, clock_timestamp())
  WHERE tenant_id = v_tenant_id
    AND run_id = p_run_id
    AND agent_key = p_agent_key
    AND status IN ('pending', 'running')
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'swarm agent not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN control_plane.swarm_agent_row_json(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_swarm_agent_completed(
  p_run_id text,
  p_agent_key text,
  p_answer_state text,
  p_headline text,
  p_summary text,
  p_key_numbers jsonb,
  p_questions jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text := control_plane.require_current_tenant_id();
  v_row control_plane.swarm_agents%ROWTYPE;
BEGIN
  UPDATE control_plane.swarm_agents
  SET status = 'completed',
      answer_state = p_answer_state,
      headline = left(p_headline, 300),
      summary = left(p_summary, 8000),
      key_numbers = coalesce(p_key_numbers, '[]'::jsonb),
      questions = coalesce(p_questions, '[]'::jsonb),
      completed_at = clock_timestamp()
  WHERE tenant_id = v_tenant_id
    AND run_id = p_run_id
    AND agent_key = p_agent_key
    AND status IN ('pending', 'running')
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'swarm agent not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM control_plane.swarm_settle_run(v_tenant_id, p_run_id);
  RETURN control_plane.swarm_agent_row_json(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_swarm_agent_failed(
  p_run_id text,
  p_agent_key text,
  p_failure_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text := control_plane.require_current_tenant_id();
  v_row control_plane.swarm_agents%ROWTYPE;
BEGIN
  UPDATE control_plane.swarm_agents
  SET status = 'failed',
      failure_note = left(p_failure_note, 300),
      completed_at = clock_timestamp()
  WHERE tenant_id = v_tenant_id
    AND run_id = p_run_id
    AND agent_key = p_agent_key
    AND status IN ('pending', 'running')
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'swarm agent not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM control_plane.swarm_settle_run(v_tenant_id, p_run_id);
  RETURN control_plane.swarm_agent_row_json(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_swarm_record_synthesis(
  p_run_id text,
  p_synthesis jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text := control_plane.require_current_tenant_id();
BEGIN
  IF p_synthesis IS NULL OR jsonb_typeof(p_synthesis) <> 'object' THEN
    RAISE EXCEPTION 'swarm synthesis must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF length(p_synthesis::text) > 24000 THEN
    RAISE EXCEPTION 'swarm synthesis is too large' USING ERRCODE = '22023';
  END IF;
  UPDATE control_plane.swarm_runs
  SET status = 'completed',
      synthesis = p_synthesis,
      completed_at = clock_timestamp()
  WHERE tenant_id = v_tenant_id
    AND run_id = p_run_id
    AND status IN ('running', 'synthesising');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'swarm run not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN control_plane.swarm_run_json(v_tenant_id, p_run_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_swarm_stop(p_run_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text := control_plane.require_current_tenant_id();
BEGIN
  UPDATE control_plane.swarm_agents
  SET status = 'stopped',
      completed_at = coalesce(completed_at, clock_timestamp())
  WHERE tenant_id = v_tenant_id
    AND run_id = p_run_id
    AND status IN ('pending', 'running');

  UPDATE control_plane.swarm_runs
  SET status = 'stopped',
      completed_at = clock_timestamp()
  WHERE tenant_id = v_tenant_id
    AND run_id = p_run_id
    AND status IN ('running', 'synthesising');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'swarm run not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN control_plane.swarm_run_json(v_tenant_id, p_run_id);
END;
$$;

-- Connection-scope deletion: swarm findings distil query results, so they
-- are invalidated tenant-wide on disconnect with the other conversation
-- artefacts. This redefinition preserves 0158's body and adds the swarm
-- DELETEs.
CREATE OR REPLACE FUNCTION control_plane.purge_connection_control(
  p_message_id bigint, p_deletion_request_id text, p_worker_id text, p_read_count integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE request_row control_plane.deletion_requests%ROWTYPE; table_row record; affected bigint; removed bigint := 0; pass integer; changed boolean;
BEGIN
  request_row := control_plane.require_active_deletion_lease(
    p_message_id, p_deletion_request_id, p_worker_id, p_read_count
  );
  IF request_row.scope <> 'connection' OR request_row.credential_destroyed_at IS NULL THEN
    RAISE EXCEPTION 'connection deletion is not purge-ready' USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('albert.deletion_authorized', 'on', true);

  DELETE FROM control_plane.model_usage_ledger WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.swarm_agents WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.swarm_runs WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.conversation_turn_events WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.conversation_turns WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.answer_execution_events WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.answer_artifacts WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.conversations WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.proactive_findings WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.proactive_runs WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.identity_review_decisions WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.identity_review_tasks WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.semantic_inbox WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.dossiers WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.audit_log WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.pipeline_stats WHERE tenant_id = request_row.tenant_id;

  FOR pass IN 1..20 LOOP
    changed := false;
    FOR table_row IN
      SELECT c.table_name
      FROM information_schema.columns c
      WHERE c.table_schema = 'control_plane' AND c.column_name = 'connection_id'
        AND c.table_name NOT IN ('connections', 'deletion_requests')
      ORDER BY c.table_name
    LOOP
      BEGIN
        EXECUTE format('DELETE FROM control_plane.%I WHERE tenant_id=$1 AND connection_id=$2', table_row.table_name)
          USING request_row.tenant_id, request_row.connection_id;
        GET DIAGNOSTICS affected = ROW_COUNT;
        IF affected > 0 THEN removed := removed + affected; changed := true; END IF;
      EXCEPTION WHEN foreign_key_violation THEN NULL;
      END;
    END LOOP;
    EXIT WHEN NOT changed;
  END LOOP;

  UPDATE control_plane.connections SET
    display_name = 'Deleted connection', external_account_reference = NULL,
    account_metadata = '{}'::jsonb, status = 'disconnected', auth_health = 'revoked',
    authorised_by = NULL
  WHERE tenant_id = request_row.tenant_id AND connection_id = request_row.connection_id;
  removed := removed + control_plane.purge_deletion_queue_scope(request_row.tenant_id, request_row.connection_id);
  RETURN jsonb_build_object('scope','connection','rowsRemoved',removed,'connectionTombstoned',true);
END;
$$;

REVOKE ALL ON FUNCTION control_plane.swarm_agent_row_json(control_plane.swarm_agents) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.swarm_run_json(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.swarm_hidden_conversation_ids(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.swarm_settle_run(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_swarm_panel() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_swarm_get_run(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_swarm_for_conversation(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_swarm_begin_run(text, text, text, text, text, text, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_swarm_agent_started(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_swarm_agent_completed(text, text, text, text, text, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_swarm_agent_failed(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_swarm_record_synthesis(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_swarm_stop(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.albert_swarm_panel() TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_swarm_get_run(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_swarm_for_conversation(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_swarm_begin_run(text, text, text, text, text, text, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_swarm_agent_started(text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_swarm_agent_completed(text, text, text, text, text, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_swarm_agent_failed(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_swarm_record_synthesis(text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_swarm_stop(text) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
