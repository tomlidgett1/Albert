BEGIN;

-- Return only privacy-preserving aggregate V2 telemetry to an existing internal
-- operator. The function intentionally exposes no tenant identifiers, question
-- text, result rows, claims, or evidence payloads.
CREATE OR REPLACE FUNCTION public.albert_semantic_v2_admin_health(
  p_since timestamptz DEFAULT now() - interval '30 days'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,control_plane
AS $$
DECLARE
  v_now timestamptz:=clock_timestamp();
  v_turn_count bigint:=0;
  v_answer_states jsonb:='{}'::jsonb;
  v_event_kinds jsonb:='{}'::jsonb;
  v_event_reasons jsonb:='[]'::jsonb;
  v_topic_usage jsonb:='[]'::jsonb;
  v_object_usage jsonb:='[]'::jsonb;
  v_query_count bigint:=0;
  v_p50_ms numeric;
  v_p95_ms numeric;
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access is required' USING ERRCODE='42501';
  END IF;
  IF p_since IS NULL OR p_since>v_now OR p_since<v_now-interval '366 days' THEN
    RAISE EXCEPTION 'health window must be within the prior 366 days' USING ERRCODE='22023';
  END IF;

  WITH v2_answers AS (
    SELECT artifact.answer_state,artifact.query_executions
    FROM control_plane.answer_artifacts artifact
    WHERE artifact.finalized_at>=p_since
      AND (
        artifact.runtime_profile->>'analyticalRuntime'='v2'
        OR artifact.semantic_ir->>'schemaVersion'='2'
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(artifact.query_executions) execution
          WHERE execution->>'route'='semantic_v2'
        )
      )
  ), counts AS (
    SELECT answer_state,count(*)::bigint AS total
    FROM v2_answers
    GROUP BY answer_state
  )
  SELECT
    (SELECT count(*) FROM v2_answers),
    coalesce(jsonb_object_agg(answer_state,total ORDER BY answer_state),'{}'::jsonb)
  INTO v_turn_count,v_answer_states
  FROM counts;

  WITH counts AS (
    SELECT event_kind,count(*)::bigint AS total
    FROM control_plane.semantic_runtime_events_v2
    WHERE created_at>=p_since
    GROUP BY event_kind
  )
  SELECT coalesce(jsonb_object_agg(event_kind,total ORDER BY event_kind),'{}'::jsonb)
  INTO v_event_kinds
  FROM counts;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'reasonCode',reason_code,
    'eventKind',event_kind,
    'count',total
  ) ORDER BY total DESC,reason_code),'[]'::jsonb)
  INTO v_event_reasons
  FROM (
    SELECT reason_code,event_kind,count(*)::bigint AS total
    FROM control_plane.semantic_runtime_events_v2
    WHERE created_at>=p_since
    GROUP BY reason_code,event_kind
    ORDER BY total DESC,reason_code
    LIMIT 20
  ) reasons;

  WITH v2_executions AS (
    SELECT execution
    FROM control_plane.answer_artifacts artifact
    CROSS JOIN LATERAL jsonb_array_elements(artifact.query_executions) execution
    WHERE artifact.finalized_at>=p_since
      AND execution->>'route'='semantic_v2'
  ), usage AS (
    SELECT topic_id,count(*)::bigint AS total
    FROM v2_executions
    CROSS JOIN LATERAL jsonb_array_elements_text(
      coalesce(execution->'normalizedIr'->'topicIds','[]'::jsonb)
    ) topic_id
    GROUP BY topic_id
    ORDER BY total DESC,topic_id
    LIMIT 20
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',topic_id,'count',total)
    ORDER BY total DESC,topic_id),'[]'::jsonb)
  INTO v_topic_usage
  FROM usage;

  WITH v2_executions AS (
    SELECT execution
    FROM control_plane.answer_artifacts artifact
    CROSS JOIN LATERAL jsonb_array_elements(artifact.query_executions) execution
    WHERE artifact.finalized_at>=p_since
      AND execution->>'route'='semantic_v2'
  ), objects AS (
    SELECT object_id
    FROM v2_executions
    CROSS JOIN LATERAL jsonb_array_elements_text(
      coalesce(execution->'normalizedIr'->'dimensionIds','[]'::jsonb)
    ) object_id
    UNION ALL
    SELECT object_id
    FROM v2_executions
    CROSS JOIN LATERAL jsonb_array_elements_text(
      coalesce(execution->'normalizedIr'->'measureIds','[]'::jsonb)
    ) object_id
  ), usage AS (
    SELECT object_id,count(*)::bigint AS total
    FROM objects
    GROUP BY object_id
    ORDER BY total DESC,object_id
    LIMIT 20
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',object_id,'count',total)
    ORDER BY total DESC,object_id),'[]'::jsonb)
  INTO v_object_usage
  FROM usage;

  SELECT
    count(*)::bigint,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY (artifact->>'durationMs')::numeric),
    percentile_cont(0.95) WITHIN GROUP (ORDER BY (artifact->>'durationMs')::numeric)
  INTO v_query_count,v_p50_ms,v_p95_ms
  FROM control_plane.evidence_artifacts_v2
  WHERE evidence_type='result'
    AND created_at>=p_since
    AND artifact->>'durationMs'~'^[0-9]+(?:\.[0-9]+)?$';

  RETURN jsonb_build_object(
    'schemaVersion',1,
    'windowStart',p_since,
    'generatedAt',v_now,
    'turnCount',v_turn_count,
    'answerStates',v_answer_states,
    'rates',jsonb_build_object(
      'answerability',CASE WHEN v_turn_count=0 THEN NULL ELSE round((
        coalesce((v_answer_states->>'verified')::numeric,0)
        +coalesce((v_answer_states->>'derived')::numeric,0)
        +coalesce((v_answer_states->>'exploratory')::numeric,0)
        +coalesce((v_answer_states->>'no_data')::numeric,0)
      )/v_turn_count,4) END,
      'clarification',CASE WHEN v_turn_count=0 THEN NULL ELSE round(
        coalesce((v_answer_states->>'clarification')::numeric,0)/v_turn_count,4
      ) END,
      'unavailable',CASE WHEN v_turn_count=0 THEN NULL ELSE round(
        coalesce((v_answer_states->>'unavailable')::numeric,0)/v_turn_count,4
      ) END
    ),
    'eventKinds',v_event_kinds,
    'eventReasons',v_event_reasons,
    'topicUsage',v_topic_usage,
    'objectUsage',v_object_usage,
    'latency',jsonb_build_object(
      'queryCount',v_query_count,
      'p50Ms',CASE WHEN v_p50_ms IS NULL THEN NULL ELSE round(v_p50_ms,2) END,
      'p95Ms',CASE WHEN v_p95_ms IS NULL THEN NULL ELSE round(v_p95_ms,2) END
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.albert_semantic_v2_admin_health(timestamptz)
  FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.albert_semantic_v2_admin_health(timestamptz)
  TO authenticated;

COMMIT;
