-- 0158: Proactive control panel (ADR 0113).
--
-- One Start press fans a roster of research agents out across the business;
-- each agent is a real codex conversation turn and its distilled finding lands
-- here for the morning control panel. Access follows the 0153 posture: every
-- active member reads, owner/manager write, all through SECURITY DEFINER RPCs.
-- Connection-scope deletion invalidates proactive rows tenant-wide alongside
-- the other query-derived artefacts; tenant-scope deletion discovers the
-- tables through the generic tenant_id column walk.

BEGIN;

CREATE TABLE IF NOT EXISTS control_plane.proactive_runs (
  tenant_id text NOT NULL,
  run_id text NOT NULL CHECK (control_plane.is_ulid(run_id)),
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'abandoned')),
  agent_count integer NOT NULL CHECK (agent_count BETWEEN 1 AND 24),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 120),
  reasoning_effort text NOT NULL CHECK (reasoning_effort IN ('none', 'low', 'medium', 'high', 'xhigh', 'max')),
  started_by uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, run_id)
);
CREATE INDEX IF NOT EXISTS proactive_runs_recent
  ON control_plane.proactive_runs (tenant_id, started_at DESC);
ALTER TABLE control_plane.proactive_runs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS control_plane.proactive_findings (
  tenant_id text NOT NULL,
  finding_id text NOT NULL DEFAULT control_plane.generate_ulid(),
  run_id text NOT NULL,
  agent_key text NOT NULL CHECK (agent_key ~ '^[a-z][a-z0-9-]{2,60}$'),
  agent_title text NOT NULL CHECK (length(agent_title) BETWEEN 1 AND 120),
  agent_tagline text NOT NULL DEFAULT '' CHECK (length(agent_tagline) <= 240),
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 24),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  conversation_id text CHECK (conversation_id IS NULL OR control_plane.is_ulid(conversation_id)),
  turn_id text CHECK (turn_id IS NULL OR control_plane.is_ulid(turn_id)),
  answer_state text CHECK (answer_state IS NULL OR answer_state IN
    ('Verified', 'Qualified', 'Exploratory', 'Clarification', 'No data', 'Unavailable')),
  headline text CHECK (headline IS NULL OR length(headline) <= 300),
  summary text CHECK (summary IS NULL OR length(summary) <= 8000),
  key_numbers jsonb NOT NULL DEFAULT '[]'::jsonb,
  questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  failure_note text CHECK (failure_note IS NULL OR length(failure_note) <= 300),
  started_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, finding_id),
  UNIQUE (tenant_id, run_id, agent_key),
  FOREIGN KEY (tenant_id, run_id)
    REFERENCES control_plane.proactive_runs (tenant_id, run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS proactive_findings_by_run
  ON control_plane.proactive_findings (tenant_id, run_id, sequence);
ALTER TABLE control_plane.proactive_findings ENABLE ROW LEVEL SECURITY;

INSERT INTO control_plane.rate_limit_policies (
  action, request_limit, window_seconds, audit_excess
) VALUES
  ('proactive.run', 6, 3600, false)
ON CONFLICT (action) DO UPDATE SET
  request_limit = EXCLUDED.request_limit,
  window_seconds = EXCLUDED.window_seconds,
  audit_excess = EXCLUDED.audit_excess;

CREATE OR REPLACE FUNCTION control_plane.proactive_finding_row_json(finding control_plane.proactive_findings)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'findingId', finding.finding_id,
    'agentKey', finding.agent_key,
    'agentTitle', finding.agent_title,
    'agentTagline', finding.agent_tagline,
    'sequence', finding.sequence,
    'status', finding.status,
    'conversationId', finding.conversation_id,
    'turnId', finding.turn_id,
    'answerState', finding.answer_state,
    'headline', finding.headline,
    'summary', finding.summary,
    'keyNumbers', finding.key_numbers,
    'questions', finding.questions,
    'failureNote', finding.failure_note,
    'startedAt', finding.started_at,
    'completedAt', finding.completed_at
  );
$$;

CREATE OR REPLACE FUNCTION control_plane.proactive_run_json(p_tenant_id text, p_run_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'runId', run.run_id,
    'status', run.status,
    'agentCount', run.agent_count,
    'model', run.model,
    'reasoningEffort', run.reasoning_effort,
    'startedAt', run.started_at,
    'completedAt', run.completed_at,
    'findings', coalesce((
      SELECT jsonb_agg(control_plane.proactive_finding_row_json(finding) ORDER BY finding.sequence)
      FROM control_plane.proactive_findings AS finding
      WHERE finding.tenant_id = run.tenant_id AND finding.run_id = run.run_id
    ), '[]'::jsonb)
  )
  FROM control_plane.proactive_runs AS run
  WHERE run.tenant_id = p_tenant_id AND run.run_id = p_run_id;
$$;

-- After every terminal finding transition: close the run when nothing is
-- pending or running any more. A run with at least one completed finding
-- completes; a run where everything failed is failed.
CREATE OR REPLACE FUNCTION control_plane.proactive_settle_run(p_tenant_id text, p_run_id text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_open integer;
  v_completed integer;
BEGIN
  SELECT
    count(*) FILTER (WHERE finding.status IN ('pending', 'running')),
    count(*) FILTER (WHERE finding.status = 'completed')
  INTO v_open, v_completed
  FROM control_plane.proactive_findings AS finding
  WHERE finding.tenant_id = p_tenant_id AND finding.run_id = p_run_id;
  IF v_open > 0 THEN
    UPDATE control_plane.proactive_runs
    SET status = 'running', completed_at = NULL
    WHERE tenant_id = p_tenant_id AND run_id = p_run_id AND status <> 'running';
  ELSE
    UPDATE control_plane.proactive_runs
    SET status = CASE WHEN v_completed > 0 THEN 'completed' ELSE 'failed' END,
        completed_at = clock_timestamp()
    WHERE tenant_id = p_tenant_id AND run_id = p_run_id;
  END IF;
END;
$$;

-- Read: any active member. The latest run with its findings, plus every
-- proactive conversation id (bounded) so the dash shell can keep research
-- conversations out of the sidebar history.
CREATE OR REPLACE FUNCTION public.albert_proactive_panel()
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
  FROM control_plane.proactive_runs AS run
  WHERE run.tenant_id = v_tenant_id
  ORDER BY run.started_at DESC
  LIMIT 1;
  RETURN jsonb_build_object(
    'run', CASE WHEN v_run_id IS NULL THEN NULL
      ELSE control_plane.proactive_run_json(v_tenant_id, v_run_id) END,
    'conversationIds', coalesce((
      SELECT jsonb_agg(ids.conversation_id)
      FROM (
        SELECT DISTINCT finding.conversation_id, finding.finding_id
        FROM control_plane.proactive_findings AS finding
        WHERE finding.tenant_id = v_tenant_id AND finding.conversation_id IS NOT NULL
        ORDER BY finding.finding_id DESC
        LIMIT 400
      ) AS ids
    ), '[]'::jsonb)
  );
END;
$$;

-- Start a run: owner/manager. p_agents is the ordered roster
-- [{key, title, tagline}, ...]; a still-running previous run is abandoned —
-- the Start press is the single source of orchestration truth.
CREATE OR REPLACE FUNCTION public.albert_proactive_begin_run(
  p_run_id text,
  p_model text,
  p_reasoning_effort text,
  p_agents jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text;
  v_role text;
  v_actor uuid := extensions.albert_auth_uid();
  v_count integer;
BEGIN
  SELECT admin.tenant_id, admin.role INTO v_tenant_id, v_role
    FROM control_plane.current_connection_admin_membership() AS admin;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'no active organisation' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'insufficient role to start proactive research' USING ERRCODE = '42501';
  END IF;
  IF p_run_id IS NULL OR NOT control_plane.is_ulid(p_run_id) THEN
    RAISE EXCEPTION 'proactive run id must be a ULID' USING ERRCODE = '22023';
  END IF;
  IF p_agents IS NULL OR jsonb_typeof(p_agents) <> 'array' THEN
    RAISE EXCEPTION 'proactive agents must be a JSON array' USING ERRCODE = '22023';
  END IF;
  v_count := jsonb_array_length(p_agents);
  IF v_count < 1 OR v_count > 24 THEN
    RAISE EXCEPTION 'proactive runs support 1-24 agents' USING ERRCODE = '22023';
  END IF;

  UPDATE control_plane.proactive_runs
  SET status = 'abandoned', completed_at = clock_timestamp()
  WHERE tenant_id = v_tenant_id AND status = 'running';

  INSERT INTO control_plane.proactive_runs (
    tenant_id, run_id, status, agent_count, model, reasoning_effort, started_by
  ) VALUES (
    v_tenant_id, p_run_id, 'running', v_count, p_model, p_reasoning_effort, v_actor
  );

  INSERT INTO control_plane.proactive_findings (
    tenant_id, run_id, agent_key, agent_title, agent_tagline, sequence
  )
  SELECT
    v_tenant_id,
    p_run_id,
    agent.value ->> 'key',
    left(agent.value ->> 'title', 120),
    left(coalesce(agent.value ->> 'tagline', ''), 240),
    agent.ordinality::integer
  FROM jsonb_array_elements(p_agents) WITH ORDINALITY AS agent(value, ordinality);

  RETURN control_plane.proactive_run_json(v_tenant_id, p_run_id);
END;
$$;

-- An agent's codex turn has begun: record its conversation provenance. Also
-- the retry path — restarting a failed agent resets its distilled fields and
-- reopens the run.
CREATE OR REPLACE FUNCTION public.albert_proactive_agent_started(
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
  v_tenant_id text;
  v_role text;
  v_row control_plane.proactive_findings%ROWTYPE;
BEGIN
  SELECT admin.tenant_id, admin.role INTO v_tenant_id, v_role
    FROM control_plane.current_connection_admin_membership() AS admin;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'no active organisation' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'insufficient role for proactive research' USING ERRCODE = '42501';
  END IF;
  IF p_conversation_id IS NULL OR NOT control_plane.is_ulid(p_conversation_id)
     OR p_turn_id IS NULL OR NOT control_plane.is_ulid(p_turn_id) THEN
    RAISE EXCEPTION 'proactive agent provenance must be ULIDs' USING ERRCODE = '22023';
  END IF;
  UPDATE control_plane.proactive_findings
  SET status = 'running',
      conversation_id = p_conversation_id,
      turn_id = p_turn_id,
      answer_state = NULL,
      headline = NULL,
      summary = NULL,
      key_numbers = '[]'::jsonb,
      questions = '[]'::jsonb,
      failure_note = NULL,
      started_at = clock_timestamp(),
      completed_at = NULL
  WHERE tenant_id = v_tenant_id AND run_id = p_run_id AND agent_key = p_agent_key
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'proactive finding not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM control_plane.proactive_settle_run(v_tenant_id, p_run_id);
  RETURN control_plane.proactive_finding_row_json(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_proactive_agent_completed(
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
  v_tenant_id text;
  v_role text;
  v_row control_plane.proactive_findings%ROWTYPE;
BEGIN
  SELECT admin.tenant_id, admin.role INTO v_tenant_id, v_role
    FROM control_plane.current_connection_admin_membership() AS admin;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'no active organisation' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'insufficient role for proactive research' USING ERRCODE = '42501';
  END IF;
  IF p_key_numbers IS NOT NULL AND jsonb_typeof(p_key_numbers) <> 'array' THEN
    RAISE EXCEPTION 'key numbers must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF p_questions IS NOT NULL AND jsonb_typeof(p_questions) <> 'array' THEN
    RAISE EXCEPTION 'questions must be a JSON array' USING ERRCODE = '22023';
  END IF;
  UPDATE control_plane.proactive_findings
  SET status = 'completed',
      answer_state = p_answer_state,
      headline = left(p_headline, 300),
      summary = left(p_summary, 8000),
      key_numbers = coalesce(p_key_numbers, '[]'::jsonb),
      questions = coalesce(p_questions, '[]'::jsonb),
      failure_note = NULL,
      completed_at = clock_timestamp()
  WHERE tenant_id = v_tenant_id AND run_id = p_run_id AND agent_key = p_agent_key
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'proactive finding not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM control_plane.proactive_settle_run(v_tenant_id, p_run_id);
  RETURN control_plane.proactive_finding_row_json(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_proactive_agent_failed(
  p_run_id text,
  p_agent_key text,
  p_failure_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text;
  v_role text;
  v_row control_plane.proactive_findings%ROWTYPE;
BEGIN
  SELECT admin.tenant_id, admin.role INTO v_tenant_id, v_role
    FROM control_plane.current_connection_admin_membership() AS admin;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'no active organisation' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'insufficient role for proactive research' USING ERRCODE = '42501';
  END IF;
  UPDATE control_plane.proactive_findings
  SET status = 'failed',
      failure_note = left(p_failure_note, 300),
      completed_at = clock_timestamp()
  WHERE tenant_id = v_tenant_id AND run_id = p_run_id AND agent_key = p_agent_key
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'proactive finding not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM control_plane.proactive_settle_run(v_tenant_id, p_run_id);
  RETURN control_plane.proactive_finding_row_json(v_row);
END;
$$;

-- Connection-scope deletion: proactive findings distil query results across
-- sources, so they are invalidated tenant-wide on disconnect exactly like the
-- conversation artefacts they point at. This redefinition preserves 0006's
-- body and adds the two proactive DELETEs.
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

  -- Query-derived artefacts and identity review evidence can embed values from
  -- several sources and are therefore invalidated tenant-wide on disconnect.
  DELETE FROM control_plane.model_usage_ledger WHERE tenant_id = request_row.tenant_id;
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

REVOKE ALL ON FUNCTION control_plane.proactive_finding_row_json(control_plane.proactive_findings) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.proactive_run_json(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.proactive_settle_run(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_proactive_panel() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_proactive_begin_run(text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_proactive_agent_started(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_proactive_agent_completed(text, text, text, text, text, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_proactive_agent_failed(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_proactive_panel() TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_proactive_begin_run(text, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_proactive_agent_started(text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_proactive_agent_completed(text, text, text, text, text, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_proactive_agent_failed(text, text, text) TO authenticated;

COMMIT;
