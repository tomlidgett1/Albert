-- 0160: Proactive question bank (ADR 0113, iteration 3).
--
-- A refreshable wall of owner-voice questions the business might want to ask,
-- generated from business context and the latest research findings. One row
-- per tenant; the panel carries it alongside the latest run.

BEGIN;

CREATE TABLE IF NOT EXISTS control_plane.proactive_question_bank (
  tenant_id text PRIMARY KEY,
  questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  model text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  generated_by uuid
);
ALTER TABLE control_plane.proactive_question_bank ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.albert_proactive_record_question_bank(
  p_questions jsonb,
  p_model text DEFAULT NULL
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
  v_row control_plane.proactive_question_bank%ROWTYPE;
BEGIN
  SELECT admin.tenant_id, admin.role INTO v_tenant_id, v_role
    FROM control_plane.current_connection_admin_membership() AS admin;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'no active organisation' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'insufficient role for proactive research' USING ERRCODE = '42501';
  END IF;
  IF p_questions IS NULL OR jsonb_typeof(p_questions) <> 'array' THEN
    RAISE EXCEPTION 'question bank must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_questions) < 1 OR jsonb_array_length(p_questions) > 60 THEN
    RAISE EXCEPTION 'question bank supports 1-60 questions' USING ERRCODE = '22023';
  END IF;
  IF length(p_questions::text) > 30000 THEN
    RAISE EXCEPTION 'question bank is too large' USING ERRCODE = '22023';
  END IF;
  INSERT INTO control_plane.proactive_question_bank (tenant_id, questions, model, generated_at, generated_by)
  VALUES (v_tenant_id, p_questions, p_model, clock_timestamp(), v_actor)
  ON CONFLICT (tenant_id) DO UPDATE SET
    questions = EXCLUDED.questions,
    model = EXCLUDED.model,
    generated_at = EXCLUDED.generated_at,
    generated_by = EXCLUDED.generated_by
  RETURNING * INTO v_row;
  RETURN jsonb_build_object(
    'questions', v_row.questions,
    'generatedAt', v_row.generated_at
  );
END;
$$;

-- Panel now carries the question bank.
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
    'questionBank', (
      SELECT jsonb_build_object('questions', bank.questions, 'generatedAt', bank.generated_at)
      FROM control_plane.proactive_question_bank AS bank
      WHERE bank.tenant_id = v_tenant_id
    ),
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

REVOKE ALL ON FUNCTION public.albert_proactive_record_question_bank(jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_proactive_record_question_bank(jsonb, text) TO authenticated;

COMMIT;
