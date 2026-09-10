-- ADR 0138: seven-day investigations, refreshed every 24 hours.
-- Preserve legacy windows for rollout; new weekly looks require exactly 168 hours.
BEGIN;

ALTER TABLE control_plane.recommended_analysis
  DROP CONSTRAINT recommended_analysis_window,
  ADD CONSTRAINT recommended_analysis_window CHECK (
    (window_start IS NULL AND window_end IS NULL) OR
    (window_start IS NOT NULL AND window_end IS NOT NULL
      AND isfinite(window_start) AND isfinite(window_end)
      AND window_end - window_start = CASE
        WHEN model LIKE 'omni:weekly-%' THEN interval '168 hours'
        ELSE interval '24 hours' END)
  );

CREATE OR REPLACE FUNCTION public.albert_save_recommended_analysis(
  p_source_fingerprint text,
  p_source_count integer,
  p_recommendations jsonb,
  p_model text,
  p_verdict text DEFAULT '',
  p_window_start timestamptz DEFAULT NULL,
  p_window_end timestamptz DEFAULT NULL
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
  IF p_source_count IS NULL OR p_source_count NOT BETWEEN 0 AND 40 THEN
    RAISE EXCEPTION 'recommended analysis source count must be between 0 and 40' USING ERRCODE = '22023';
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
  IF p_verdict IS NULL OR length(p_verdict) > 400 THEN
    RAISE EXCEPTION 'recommended analysis verdict is invalid' USING ERRCODE = '22023';
  END IF;

  IF num_nonnulls(p_window_start, p_window_end) = 1
    OR (p_window_end IS NOT NULL AND (
      p_window_end - p_window_start <> CASE
        WHEN p_model LIKE 'omni:weekly-%' THEN interval '168 hours'
        ELSE interval '24 hours' END
      OR p_window_end > clock_timestamp() + interval '5 minutes'
      OR NOT isfinite(p_window_start) OR NOT isfinite(p_window_end)
    ))
    OR ((p_model LIKE 'omni:daily-v2:%' OR p_model LIKE 'omni:weekly-%') AND p_window_end IS NULL) THEN
    RAISE EXCEPTION 'recommended analysis requires its exact observation window' USING ERRCODE = '22023';
  END IF;

  INSERT INTO control_plane.recommended_analysis (
    tenant_id, user_id, source_fingerprint, source_count, recommendations, model, verdict, generated_at, window_start, window_end
  ) VALUES (
    selected_tenant, actor, p_source_fingerprint, p_source_count, p_recommendations, btrim(p_model), btrim(p_verdict), clock_timestamp(), p_window_start, p_window_end
  )
  ON CONFLICT (tenant_id, user_id) DO UPDATE SET
    source_fingerprint = EXCLUDED.source_fingerprint,
    source_count = EXCLUDED.source_count,
    recommendations = EXCLUDED.recommendations,
    model = EXCLUDED.model,
    verdict = EXCLUDED.verdict,
    generated_at = EXCLUDED.generated_at,
    window_start = EXCLUDED.window_start,
    window_end = EXCLUDED.window_end
  -- An older worker still finishing during a rollout cannot overwrite the
  -- newly published seven-day selection. Conflict locking makes this atomic.
  WHERE NOT (control_plane.recommended_analysis.model LIKE 'omni:weekly-%'
    AND EXCLUDED.model NOT LIKE 'omni:weekly-%')
  RETURNING * INTO row;

  IF NOT FOUND THEN
    SELECT * INTO STRICT row FROM control_plane.recommended_analysis AS cached
    WHERE cached.tenant_id = selected_tenant AND cached.user_id = actor;
  END IF;

  RETURN jsonb_build_object(
    'sourceFingerprint', row.source_fingerprint,
    'sourceCount', row.source_count,
    'verdict', coalesce(row.verdict, ''),
    'recommendations', row.recommendations,
    'model', row.model,
    'generatedAt', row.generated_at,
    'windowStart', row.window_start,
    'windowEnd', row.window_end
  );
END;
$$;



REVOKE ALL ON FUNCTION public.albert_save_recommended_analysis(text, integer, jsonb, text, text, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_save_recommended_analysis(text, integer, jsonb, text, text, timestamptz, timestamptz) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
