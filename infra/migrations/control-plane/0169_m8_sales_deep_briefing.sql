-- 0169: Persist the sales-deep swarm briefing as markdown the owner
-- can ask follow-up questions against. Regular 2-5 question swarms
-- are unchanged.

BEGIN;

ALTER TABLE control_plane.swarm_runs
  ADD COLUMN IF NOT EXISTS briefing_markdown text
  CHECK (briefing_markdown IS NULL OR char_length(briefing_markdown) BETWEEN 1 AND 100000);

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
    'briefingMarkdown', run.briefing_markdown,
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

CREATE OR REPLACE FUNCTION public.albert_swarm_save_briefing(
  p_run_id text,
  p_briefing text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text := control_plane.require_current_tenant_id();
BEGIN
  IF p_run_id IS NULL OR NOT control_plane.is_ulid(p_run_id) THEN
    RAISE EXCEPTION 'swarm run id must be a ULID' USING ERRCODE = '22023';
  END IF;
  IF p_briefing IS NULL OR length(btrim(p_briefing)) < 40 OR length(p_briefing) > 100000 THEN
    RAISE EXCEPTION 'swarm briefing is required' USING ERRCODE = '22023';
  END IF;
  UPDATE control_plane.swarm_runs
  SET briefing_markdown = left(btrim(p_briefing), 100000)
  WHERE tenant_id = v_tenant_id AND run_id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'swarm run not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN control_plane.swarm_run_json(v_tenant_id, p_run_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_swarm_latest_briefing()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text := control_plane.require_current_tenant_id();
  v_briefing text;
BEGIN
  SELECT run.briefing_markdown INTO v_briefing
  FROM control_plane.swarm_runs AS run
  WHERE run.tenant_id = v_tenant_id
    AND run.briefing_markdown IS NOT NULL
    AND coalesce(run.plan ->> 'kind', '') = 'sales-deep'
  ORDER BY run.completed_at DESC NULLS LAST, run.started_at DESC
  LIMIT 1;
  RETURN v_briefing;
END;
$$;

REVOKE ALL ON FUNCTION public.albert_swarm_save_briefing(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_swarm_latest_briefing() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_swarm_save_briefing(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_swarm_latest_briefing() TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
