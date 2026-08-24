-- 0163: recommended analysis on the homepage (ADR 0117).
--
-- Last-N owner conversation briefs (question + answer signals) plus a
-- per-user cache of the next questions worth asking. Conversations are
-- per-user, so the cache is too. Proactive research threads are excluded.

BEGIN;

INSERT INTO control_plane.rate_limit_policies (
  action, request_limit, window_seconds, audit_excess
) VALUES
  ('conversation.recommended_analysis', 12, 3600, false)
ON CONFLICT (action) DO UPDATE SET
  request_limit = EXCLUDED.request_limit,
  window_seconds = EXCLUDED.window_seconds,
  audit_excess = EXCLUDED.audit_excess,
  enabled = true;

CREATE TABLE IF NOT EXISTS control_plane.recommended_analysis (
  tenant_id text NOT NULL,
  user_id uuid NOT NULL,
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  source_count integer NOT NULL CHECK (source_count BETWEEN 0 AND 10),
  recommendations jsonb NOT NULL DEFAULT '[]'::jsonb,
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 120),
  generated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  CHECK (jsonb_typeof(recommendations) = 'array'),
  CHECK (length(recommendations::text) <= 20000)
);
ALTER TABLE control_plane.recommended_analysis ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.albert_recent_analysis_briefs(
  p_limit integer DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  actor uuid := extensions.albert_auth_uid();
  result jsonb;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'analysis brief limit must be between 1 and 10' USING ERRCODE = '22023';
  END IF;

  WITH recent AS (
    SELECT conversation.conversation_id, conversation.title, conversation.updated_at
    FROM control_plane.conversations AS conversation
    WHERE conversation.tenant_id = selected_tenant
      AND conversation.created_by = actor
      AND NOT EXISTS (
        SELECT 1
        FROM control_plane.proactive_findings AS finding
        WHERE finding.tenant_id = conversation.tenant_id
          AND finding.conversation_id = conversation.conversation_id
      )
    ORDER BY conversation.updated_at DESC
    LIMIT 20
  ),
  briefed AS (
    SELECT
      recent.conversation_id,
      recent.title,
      recent.updated_at,
      turn.turn_id,
      turn.user_message,
      turn.answer_state,
      turn.completed_at,
      coalesce(
        left(btrim(coalesce(answer_event.event->>'text', artifact.answer_text, '')), 1200),
        ''
      ) AS answer_excerpt,
      coalesce((
        SELECT jsonb_agg(to_jsonb(btrim(follow_up)))
        FROM jsonb_array_elements_text(coalesce(answer_event.event->'followUps', '[]'::jsonb)) AS follow_up
        WHERE length(btrim(follow_up)) BETWEEN 8 AND 180
      ), '[]'::jsonb) AS follow_ups,
      CASE
        WHEN jsonb_typeof(answer_event.event->'keyInsights') = 'array'
          THEN answer_event.event->'keyInsights'
        ELSE '[]'::jsonb
      END AS key_insights,
      coalesce((
        SELECT jsonb_agg(to_jsonb(btrim(claim->>'statement')))
        FROM jsonb_array_elements(coalesce(answer_event.event->'claims', '[]'::jsonb)) AS claim
        WHERE jsonb_typeof(claim) = 'object'
          AND length(btrim(coalesce(claim->>'statement', ''))) BETWEEN 4 AND 240
      ), '[]'::jsonb) AS claims,
      coalesce((
        SELECT jsonb_agg(to_jsonb(asked.user_message) ORDER BY asked.turn_number)
        FROM control_plane.conversation_turns AS asked
        WHERE asked.tenant_id = selected_tenant
          AND asked.conversation_id = recent.conversation_id
          AND asked.created_by = actor
          AND asked.hidden_at IS NULL
      ), '[]'::jsonb) AS asked_questions
    FROM recent
    JOIN LATERAL (
      SELECT
        candidate.turn_id,
        candidate.turn_number,
        candidate.user_message,
        candidate.answer_state,
        candidate.completed_at
      FROM control_plane.conversation_turns AS candidate
      WHERE candidate.tenant_id = selected_tenant
        AND candidate.conversation_id = recent.conversation_id
        AND candidate.created_by = actor
        AND candidate.hidden_at IS NULL
        AND (
          EXISTS (
            SELECT 1
            FROM control_plane.conversation_turn_events AS event
            WHERE event.tenant_id = candidate.tenant_id
              AND event.turn_id = candidate.turn_id
              AND event.event->>'type' IN ('answer', 'clarification')
          )
          OR EXISTS (
            SELECT 1
            FROM control_plane.answer_artifacts AS stored
            WHERE stored.tenant_id = candidate.tenant_id
              AND stored.conversation_id = candidate.conversation_id
              AND (
                stored.turn_id = candidate.turn_id
                OR (stored.turn_id IS NULL AND stored.turn_number = candidate.turn_number)
              )
          )
        )
      ORDER BY candidate.turn_number DESC
      LIMIT 1
    ) AS turn ON true
    LEFT JOIN LATERAL (
      SELECT event.event
      FROM control_plane.conversation_turn_events AS event
      WHERE event.tenant_id = selected_tenant
        AND event.turn_id = turn.turn_id
        AND event.event->>'type' IN ('answer', 'clarification')
      ORDER BY event.sequence_number DESC
      LIMIT 1
    ) AS answer_event ON true
    LEFT JOIN control_plane.answer_artifacts AS artifact
      ON artifact.tenant_id = selected_tenant
     AND artifact.conversation_id = recent.conversation_id
     AND (
       artifact.turn_id = turn.turn_id
       OR (artifact.turn_id IS NULL AND artifact.turn_number = turn.turn_number)
     )
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'conversationId', briefed.conversation_id,
    'title', coalesce(nullif(btrim(briefed.title), ''), briefed.user_message),
    'updatedAt', briefed.updated_at,
    'turnId', briefed.turn_id,
    'userQuestion', briefed.user_message,
    'answerState', briefed.answer_state,
    'completedAt', briefed.completed_at,
    'answerExcerpt', briefed.answer_excerpt,
    'followUps', briefed.follow_ups,
    'keyInsights', briefed.key_insights,
    'claims', briefed.claims,
    'askedQuestions', briefed.asked_questions
  ) ORDER BY briefed.updated_at DESC), '[]'::jsonb)
  INTO result
  FROM (
    SELECT *
    FROM briefed
    ORDER BY briefed.updated_at DESC
    LIMIT p_limit
  ) AS briefed;

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_recommended_analysis()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  actor uuid := extensions.albert_auth_uid();
  row control_plane.recommended_analysis%ROWTYPE;
BEGIN
  SELECT * INTO row
  FROM control_plane.recommended_analysis AS cached
  WHERE cached.tenant_id = selected_tenant
    AND cached.user_id = actor;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'sourceFingerprint', row.source_fingerprint,
    'sourceCount', row.source_count,
    'recommendations', row.recommendations,
    'model', row.model,
    'generatedAt', row.generated_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_save_recommended_analysis(
  p_source_fingerprint text,
  p_source_count integer,
  p_recommendations jsonb,
  p_model text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  actor uuid := extensions.albert_auth_uid();
  row control_plane.recommended_analysis%ROWTYPE;
BEGIN
  IF p_source_fingerprint IS NULL OR p_source_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'recommended analysis fingerprint is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_source_count IS NULL OR p_source_count NOT BETWEEN 0 AND 10 THEN
    RAISE EXCEPTION 'recommended analysis source count must be between 0 and 10' USING ERRCODE = '22023';
  END IF;
  IF p_recommendations IS NULL OR jsonb_typeof(p_recommendations) <> 'array' THEN
    RAISE EXCEPTION 'recommended analysis must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_recommendations) > 8 THEN
    RAISE EXCEPTION 'recommended analysis holds at most 8 questions' USING ERRCODE = '22023';
  END IF;
  IF length(p_recommendations::text) > 20000 THEN
    RAISE EXCEPTION 'recommended analysis is too large' USING ERRCODE = '22023';
  END IF;
  IF p_model IS NULL OR length(btrim(p_model)) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'recommended analysis model is required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO control_plane.recommended_analysis (
    tenant_id, user_id, source_fingerprint, source_count, recommendations, model, generated_at
  ) VALUES (
    selected_tenant, actor, p_source_fingerprint, p_source_count, p_recommendations, btrim(p_model), clock_timestamp()
  )
  ON CONFLICT (tenant_id, user_id) DO UPDATE SET
    source_fingerprint = EXCLUDED.source_fingerprint,
    source_count = EXCLUDED.source_count,
    recommendations = EXCLUDED.recommendations,
    model = EXCLUDED.model,
    generated_at = EXCLUDED.generated_at
  RETURNING * INTO row;

  RETURN jsonb_build_object(
    'sourceFingerprint', row.source_fingerprint,
    'sourceCount', row.source_count,
    'recommendations', row.recommendations,
    'model', row.model,
    'generatedAt', row.generated_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.albert_recent_analysis_briefs(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_recommended_analysis() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_save_recommended_analysis(text, integer, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_recent_analysis_briefs(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_recommended_analysis() TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_save_recommended_analysis(text, integer, jsonb, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
