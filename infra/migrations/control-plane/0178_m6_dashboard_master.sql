-- Dashboard Master: the daily deep-dive report (ADR 0113's morning-panel
-- sibling). One row per session; the browser orchestrates the investigation
-- exactly like proactive/swarm runs and persists durable session state here
-- between ticks, then the composed five-focus report document. Access follows
-- the 0153 posture: every active member reads, owner/manager write, all
-- through SECURITY DEFINER RPCs. Connection-scope deletion purges the table
-- tenant-wide alongside the other query-derived artefacts.

BEGIN;

CREATE TABLE IF NOT EXISTS control_plane.dashboard_master_reports (
  tenant_id text NOT NULL,
  report_id text NOT NULL CHECK (control_plane.is_ulid(report_id)),
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'abandoned')),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 120),
  reasoning_effort text NOT NULL CHECK (reasoning_effort IN ('none', 'low', 'medium', 'high', 'xhigh', 'max')),
  started_by uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  -- Durable tick-to-tick investigation state (objectives, findings, budget).
  session_state jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (pg_column_size(session_state) <= 4194304),
  -- The composed five-focus report document; present once completed.
  report jsonb CHECK (report IS NULL OR pg_column_size(report) <= 2097152),
  failure_note text CHECK (failure_note IS NULL OR length(failure_note) <= 300),
  PRIMARY KEY (tenant_id, report_id)
);
CREATE INDEX IF NOT EXISTS dashboard_master_reports_recent
  ON control_plane.dashboard_master_reports (tenant_id, started_at DESC);
ALTER TABLE control_plane.dashboard_master_reports ENABLE ROW LEVEL SECURITY;

INSERT INTO control_plane.rate_limit_policies (
  action, request_limit, window_seconds, audit_excess
) VALUES
  ('dashboard_master.refresh', 6, 86400, false)
ON CONFLICT (action) DO UPDATE SET
  request_limit = EXCLUDED.request_limit,
  window_seconds = EXCLUDED.window_seconds,
  audit_excess = EXCLUDED.audit_excess;

CREATE OR REPLACE FUNCTION control_plane.dashboard_master_row_json(report control_plane.dashboard_master_reports)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'reportId', report.report_id,
    'status', report.status,
    'model', report.model,
    'reasoningEffort', report.reasoning_effort,
    'startedAt', report.started_at,
    'completedAt', report.completed_at,
    'sessionState', report.session_state,
    'report', report.report,
    'failureNote', report.failure_note
  );
$$;

-- Panel read: any active member. Latest completed report (state stripped —
-- the document is what the tab renders) plus the current running session.
CREATE OR REPLACE FUNCTION public.albert_dashboard_master_panel()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text := control_plane.require_current_tenant_id();
  v_latest control_plane.dashboard_master_reports%ROWTYPE;
  v_running control_plane.dashboard_master_reports%ROWTYPE;
BEGIN
  SELECT * INTO v_latest
  FROM control_plane.dashboard_master_reports AS report
  WHERE report.tenant_id = v_tenant_id AND report.status = 'completed'
  ORDER BY report.completed_at DESC NULLS LAST
  LIMIT 1;
  SELECT * INTO v_running
  FROM control_plane.dashboard_master_reports AS report
  WHERE report.tenant_id = v_tenant_id AND report.status = 'running'
  ORDER BY report.started_at DESC
  LIMIT 1;
  RETURN jsonb_build_object(
    'latest', CASE WHEN v_latest.report_id IS NULL THEN NULL
      ELSE control_plane.dashboard_master_row_json(v_latest) - 'sessionState' END,
    'running', CASE WHEN v_running.report_id IS NULL THEN NULL
      ELSE control_plane.dashboard_master_row_json(v_running) END,
    -- Worker conversations across both rows, so the app can keep session
    -- research out of the sidebar history even after completion.
    'conversationIds',
      coalesce(v_latest.session_state -> 'conversationIds', '[]'::jsonb)
      || coalesce(v_running.session_state -> 'conversationIds', '[]'::jsonb)
  );
END;
$$;

-- Begin a session: owner/manager. A still-running previous session is
-- abandoned — the refresh press is the single source of orchestration truth.
CREATE OR REPLACE FUNCTION public.albert_dashboard_master_begin(
  p_report_id text,
  p_model text,
  p_reasoning_effort text,
  p_state jsonb
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
  v_row control_plane.dashboard_master_reports%ROWTYPE;
BEGIN
  SELECT admin.tenant_id, admin.role INTO v_tenant_id, v_role
    FROM control_plane.current_connection_admin_membership() AS admin;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'no active organisation' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'insufficient role to refresh the dashboard' USING ERRCODE = '42501';
  END IF;
  IF p_report_id IS NULL OR NOT control_plane.is_ulid(p_report_id) THEN
    RAISE EXCEPTION 'dashboard report id must be a ULID' USING ERRCODE = '22023';
  END IF;
  IF p_model IS NULL OR length(btrim(p_model)) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'dashboard model is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_reasoning_effort NOT IN ('none', 'low', 'medium', 'high', 'xhigh', 'max') THEN
    RAISE EXCEPTION 'dashboard reasoning effort is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_state IS NULL OR jsonb_typeof(p_state) <> 'object' THEN
    RAISE EXCEPTION 'dashboard session state must be an object' USING ERRCODE = '22023';
  END IF;

  UPDATE control_plane.dashboard_master_reports SET
    status = 'abandoned',
    completed_at = now()
  WHERE tenant_id = v_tenant_id AND status = 'running';

  INSERT INTO control_plane.dashboard_master_reports (
    tenant_id, report_id, model, reasoning_effort, started_by, session_state
  ) VALUES (
    v_tenant_id, p_report_id, btrim(p_model), p_reasoning_effort, v_actor, p_state
  )
  RETURNING * INTO v_row;
  RETURN control_plane.dashboard_master_row_json(v_row);
END;
$$;

-- Persist tick-to-tick session state while running: owner/manager.
CREATE OR REPLACE FUNCTION public.albert_dashboard_master_save_state(
  p_report_id text,
  p_state jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text;
  v_role text;
  v_row control_plane.dashboard_master_reports%ROWTYPE;
BEGIN
  SELECT admin.tenant_id, admin.role INTO v_tenant_id, v_role
    FROM control_plane.current_connection_admin_membership() AS admin;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'no active organisation' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'insufficient role to update the dashboard' USING ERRCODE = '42501';
  END IF;
  IF p_report_id IS NULL OR NOT control_plane.is_ulid(p_report_id) THEN
    RAISE EXCEPTION 'dashboard report id must be a ULID' USING ERRCODE = '22023';
  END IF;
  IF p_state IS NULL OR jsonb_typeof(p_state) <> 'object' THEN
    RAISE EXCEPTION 'dashboard session state must be an object' USING ERRCODE = '22023';
  END IF;
  UPDATE control_plane.dashboard_master_reports SET
    session_state = p_state
  WHERE tenant_id = v_tenant_id AND report_id = p_report_id AND status = 'running'
  RETURNING * INTO v_row;
  IF v_row.report_id IS NULL THEN
    RAISE EXCEPTION 'dashboard session is not running' USING ERRCODE = 'P0002';
  END IF;
  RETURN control_plane.dashboard_master_row_json(v_row);
END;
$$;

-- Record the composed report and complete the session: owner/manager.
CREATE OR REPLACE FUNCTION public.albert_dashboard_master_complete(
  p_report_id text,
  p_report jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text;
  v_role text;
  v_row control_plane.dashboard_master_reports%ROWTYPE;
BEGIN
  SELECT admin.tenant_id, admin.role INTO v_tenant_id, v_role
    FROM control_plane.current_connection_admin_membership() AS admin;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'no active organisation' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'insufficient role to update the dashboard' USING ERRCODE = '42501';
  END IF;
  IF p_report_id IS NULL OR NOT control_plane.is_ulid(p_report_id) THEN
    RAISE EXCEPTION 'dashboard report id must be a ULID' USING ERRCODE = '22023';
  END IF;
  IF p_report IS NULL OR jsonb_typeof(p_report) <> 'object' THEN
    RAISE EXCEPTION 'dashboard report must be an object' USING ERRCODE = '22023';
  END IF;
  UPDATE control_plane.dashboard_master_reports SET
    status = 'completed',
    report = p_report,
    completed_at = now()
  WHERE tenant_id = v_tenant_id AND report_id = p_report_id AND status = 'running'
  RETURNING * INTO v_row;
  IF v_row.report_id IS NULL THEN
    RAISE EXCEPTION 'dashboard session is not running' USING ERRCODE = 'P0002';
  END IF;
  RETURN control_plane.dashboard_master_row_json(v_row);
END;
$$;

-- Mark a session failed: owner/manager.
CREATE OR REPLACE FUNCTION public.albert_dashboard_master_fail(
  p_report_id text,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text;
  v_role text;
  v_row control_plane.dashboard_master_reports%ROWTYPE;
BEGIN
  SELECT admin.tenant_id, admin.role INTO v_tenant_id, v_role
    FROM control_plane.current_connection_admin_membership() AS admin;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'no active organisation' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'insufficient role to update the dashboard' USING ERRCODE = '42501';
  END IF;
  IF p_report_id IS NULL OR NOT control_plane.is_ulid(p_report_id) THEN
    RAISE EXCEPTION 'dashboard report id must be a ULID' USING ERRCODE = '22023';
  END IF;
  UPDATE control_plane.dashboard_master_reports SET
    status = 'failed',
    failure_note = CASE WHEN p_note IS NULL THEN NULL ELSE left(btrim(p_note), 300) END,
    completed_at = now()
  WHERE tenant_id = v_tenant_id AND report_id = p_report_id AND status = 'running'
  RETURNING * INTO v_row;
  IF v_row.report_id IS NULL THEN
    RAISE EXCEPTION 'dashboard session is not running' USING ERRCODE = 'P0002';
  END IF;
  RETURN control_plane.dashboard_master_row_json(v_row);
END;
$$;

-- Connection-scope purge now clears the dashboard report alongside the other
-- query-derived artefacts (body otherwise identical to 0168).
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
  DELETE FROM control_plane.dashboard_master_reports WHERE tenant_id = request_row.tenant_id;
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

REVOKE ALL ON FUNCTION control_plane.dashboard_master_row_json(control_plane.dashboard_master_reports) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_dashboard_master_panel() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_dashboard_master_begin(text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_dashboard_master_save_state(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_dashboard_master_complete(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_dashboard_master_fail(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_master_panel() TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_master_begin(text, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_master_save_state(text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_master_complete(text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_master_fail(text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
