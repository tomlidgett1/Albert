-- 0159: Proactive morning-brief synthesis (ADR 0113, iteration 2).
--
-- The control panel leads with a synthesized brief — verdict, ranked
-- highlights, and a quiet line — instead of fifteen equal cards. The
-- synthesis document is stored on the run and written through the same
-- owner/manager RPC posture as 0158.

BEGIN;

ALTER TABLE control_plane.proactive_runs
  ADD COLUMN IF NOT EXISTS synthesis jsonb;

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
    'synthesis', run.synthesis,
    'findings', coalesce((
      SELECT jsonb_agg(control_plane.proactive_finding_row_json(finding) ORDER BY finding.sequence)
      FROM control_plane.proactive_findings AS finding
      WHERE finding.tenant_id = run.tenant_id AND finding.run_id = run.run_id
    ), '[]'::jsonb)
  )
  FROM control_plane.proactive_runs AS run
  WHERE run.tenant_id = p_tenant_id AND run.run_id = p_run_id;
$$;

CREATE OR REPLACE FUNCTION public.albert_proactive_record_synthesis(
  p_run_id text,
  p_synthesis jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text;
  v_role text;
BEGIN
  SELECT admin.tenant_id, admin.role INTO v_tenant_id, v_role
    FROM control_plane.current_connection_admin_membership() AS admin;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'no active organisation' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'insufficient role for proactive research' USING ERRCODE = '42501';
  END IF;
  IF p_synthesis IS NULL OR jsonb_typeof(p_synthesis) <> 'object' THEN
    RAISE EXCEPTION 'proactive synthesis must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF length(p_synthesis::text) > 20000 THEN
    RAISE EXCEPTION 'proactive synthesis is too large' USING ERRCODE = '22023';
  END IF;
  UPDATE control_plane.proactive_runs
  SET synthesis = p_synthesis
  WHERE tenant_id = v_tenant_id AND run_id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'proactive run not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN control_plane.proactive_run_json(v_tenant_id, p_run_id);
END;
$$;

REVOKE ALL ON FUNCTION public.albert_proactive_record_synthesis(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_proactive_record_synthesis(text, jsonb) TO authenticated;

COMMIT;
