-- Dashboard Cube replays are new governed executions. They cannot reuse the
-- source conversation turn's expired analytical lease; each claimed refresh
-- receives its own short-lived, tile-bound capability authority instead.

BEGIN;

ALTER TABLE control_plane.dashboard_tiles
  ADD COLUMN refresh_lease_id text
    CHECK (refresh_lease_id IS NULL OR control_plane.is_ulid(refresh_lease_id)),
  ADD COLUMN refresh_lease_expires_at timestamptz,
  ADD CONSTRAINT dashboard_tiles_refresh_lease_pair
    CHECK ((refresh_lease_id IS NULL) = (refresh_lease_expires_at IS NULL));

CREATE OR REPLACE FUNCTION public.albert_dashboard_refresh_claim(
  p_tile_ids text[] DEFAULT NULL,
  p_force boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  actor uuid := extensions.albert_auth_uid();
  selected_dashboard text := control_plane.require_personal_dashboard(selected_tenant, actor);
  claimed jsonb;
BEGIN
  WITH eligible AS (
    SELECT tile.tile_id
    FROM control_plane.dashboard_tiles AS tile
    WHERE tile.tenant_id = selected_tenant AND tile.dashboard_id = selected_dashboard
      AND (p_tile_ids IS NULL OR tile.tile_id = ANY(p_tile_ids))
      AND (
        p_force
        OR tile.last_refresh_attempt_at IS NULL
        OR tile.last_refresh_attempt_at < date_trunc('minute', now())
          - ((extract(minute FROM now())::integer % 5) || ' minutes')::interval
      )
      AND (
        tile.refresh_state <> 'refreshing'
        OR tile.refresh_lease_expires_at IS NULL
        OR tile.refresh_lease_expires_at < clock_timestamp()
      )
    ORDER BY tile.created_at
    LIMIT 24
    FOR UPDATE SKIP LOCKED
  ), updated AS (
    UPDATE control_plane.dashboard_tiles AS tile
    SET refresh_state = 'refreshing',
        refresh_claimed_at = clock_timestamp(),
        refresh_lease_id = control_plane.generate_ulid(),
        refresh_lease_expires_at = clock_timestamp() + interval '3 minutes',
        last_refresh_attempt_at = clock_timestamp(),
        last_error_code = NULL,
        updated_at = clock_timestamp()
    FROM eligible
    WHERE tile.tenant_id = selected_tenant AND tile.dashboard_id = selected_dashboard
      AND tile.tile_id = eligible.tile_id
    RETURNING tile.*
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'tileId', updated.tile_id,
    'replayKind', updated.replay_kind,
    'recipe', updated.replay_recipe,
    'source', jsonb_build_object(
      'conversationId', updated.source_conversation_id,
      'turnId', updated.source_turn_id,
      'resultId', updated.source_result_id
    ),
    'previousSnapshot', updated.latest_snapshot,
    'claimedAt', updated.refresh_claimed_at,
    'leaseId', updated.refresh_lease_id
  ) ORDER BY updated.created_at), '[]'::jsonb) INTO claimed FROM updated;
  RETURN claimed;
END;
$$;

DROP FUNCTION public.albert_dashboard_refresh_complete(
  text, timestamptz, text, timestamptz, integer, jsonb, text, bigint,
  jsonb, text, text, text, jsonb
);

CREATE FUNCTION public.albert_dashboard_refresh_complete(
  p_tile_id text,
  p_claimed_at timestamptz,
  p_lease_id text,
  p_outcome text,
  p_started_at timestamptz,
  p_latency_ms integer,
  p_snapshot jsonb,
  p_result_digest text,
  p_row_count bigint,
  p_source_watermarks jsonb,
  p_adapter text,
  p_dedupe_status text,
  p_error_code text,
  p_adapter_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  actor uuid := extensions.albert_auth_uid();
  selected_dashboard text := control_plane.require_personal_dashboard(selected_tenant, actor);
BEGIN
  IF NOT control_plane.is_ulid(p_lease_id)
     OR p_outcome NOT IN ('success', 'empty', 'failure', 'incompatible')
     OR p_adapter NOT IN ('cube_v3', 'semantic_v2')
     OR p_dedupe_status NOT IN ('executed', 'cache_hit')
     OR p_latency_ms NOT BETWEEN 0 AND 600000
     OR jsonb_typeof(coalesce(p_source_watermarks, '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_adapter_metadata, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'dashboard refresh evidence is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_outcome IN ('success', 'empty') AND (
    jsonb_typeof(p_snapshot) <> 'object'
    OR jsonb_array_length(coalesce(p_snapshot->'rows', '[]'::jsonb)) > 50
    OR coalesce(p_result_digest, '') !~ '^[0-9a-f]{64}$'
    OR p_row_count IS NULL OR p_row_count < 0 OR p_error_code IS NOT NULL
  ) THEN RAISE EXCEPTION 'successful dashboard snapshot is invalid' USING ERRCODE = '22023'; END IF;
  IF p_outcome IN ('failure', 'incompatible') AND coalesce(p_error_code, '') !~ '^[a-z0-9_]{3,80}$' THEN
    RAISE EXCEPTION 'dashboard refresh failure code is invalid' USING ERRCODE = '22023';
  END IF;

  UPDATE control_plane.dashboard_tiles
  SET latest_snapshot = CASE WHEN p_outcome IN ('success', 'empty') THEN p_snapshot ELSE latest_snapshot END,
      refresh_state = CASE WHEN p_outcome IN ('success', 'empty') THEN 'current' ELSE 'error' END,
      last_refreshed_at = CASE WHEN p_outcome IN ('success', 'empty') THEN clock_timestamp() ELSE last_refreshed_at END,
      last_error_code = CASE WHEN p_outcome IN ('failure', 'incompatible') THEN p_error_code ELSE NULL END,
      refresh_claimed_at = NULL,
      refresh_lease_id = NULL,
      refresh_lease_expires_at = NULL,
      updated_at = clock_timestamp()
  WHERE tenant_id = selected_tenant AND dashboard_id = selected_dashboard
    AND tile_id = p_tile_id
    AND refresh_claimed_at = p_claimed_at
    AND refresh_lease_id = p_lease_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'dashboard refresh claim is no longer current' USING ERRCODE = '40001'; END IF;

  INSERT INTO control_plane.dashboard_refresh_events (
    tenant_id, dashboard_id, refresh_event_id, tile_id, outcome, started_at,
    latency_ms, result_digest, row_count, source_watermarks, adapter,
    dedupe_status, error_code, adapter_metadata
  ) VALUES (
    selected_tenant, selected_dashboard, control_plane.generate_ulid(), p_tile_id,
    p_outcome, p_started_at, p_latency_ms, p_result_digest, p_row_count,
    coalesce(p_source_watermarks, '[]'::jsonb), p_adapter, p_dedupe_status,
    p_error_code, coalesce(p_adapter_metadata, '{}'::jsonb)
  );
  RETURN control_plane.dashboard_document(selected_tenant, selected_dashboard);
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.issue_dashboard_analytical_capability(
  p_tenant_id text,
  p_tile_id text,
  p_refresh_lease_id text,
  p_scope text
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  tile_row control_plane.dashboard_tiles%ROWTYPE;
  audience text;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_semantic_control_runtime', 'albert_semantic_control'
  );
  IF NOT control_plane.is_ulid(p_tile_id)
     OR NOT control_plane.is_ulid(p_refresh_lease_id)
     OR p_scope NOT IN ('semantic_read', 'semantic_metadata') THEN
    RAISE EXCEPTION 'dashboard analytical claims are invalid' USING ERRCODE = '22023';
  END IF;

  SELECT tile.* INTO tile_row
  FROM control_plane.dashboard_tiles AS tile
  WHERE tile.tenant_id = p_tenant_id
    AND tile.tile_id = p_tile_id
    AND tile.replay_kind = 'cube_v3'
    AND tile.refresh_state = 'refreshing'
    AND tile.refresh_lease_id = p_refresh_lease_id
    AND tile.refresh_lease_expires_at > clock_timestamp()
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dashboard refresh lease is not active' USING ERRCODE = '55000';
  END IF;

  audience := CASE p_scope
    WHEN 'semantic_read' THEN 'analytical:semantic-read'
    ELSE 'analytical:semantic-metadata'
  END;
  RETURN control_plane.sign_analytical_capability(
    p_tenant_id,
    audience,
    p_scope,
    'dashboard-tile:' || p_tile_id || ':refresh:' || p_refresh_lease_id,
    tile_row.refresh_lease_expires_at,
    jsonb_build_object(
      'dashboard_id', tile_row.dashboard_id,
      'tile_id', p_tile_id,
      'refresh_lease_id', p_refresh_lease_id,
      'source_conversation_id', tile_row.source_conversation_id,
      'source_turn_id', tile_row.source_turn_id
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.albert_dashboard_refresh_complete(
  text, timestamptz, text, text, timestamptz, integer, jsonb, text, bigint,
  jsonb, text, text, text, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_refresh_complete(
  text, timestamptz, text, text, timestamptz, integer, jsonb, text, bigint,
  jsonb, text, text, text, jsonb
) TO authenticated;

REVOKE ALL ON FUNCTION control_plane.issue_dashboard_analytical_capability(text, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role, albert_sync_control,
       albert_transform_control, albert_semantic_control, albert_webhook_control,
       albert_deletion_control, albert_operator_diagnostic_control;
GRANT EXECUTE ON FUNCTION control_plane.issue_dashboard_analytical_capability(text, text, text, text)
  TO albert_semantic_control;

COMMIT;
