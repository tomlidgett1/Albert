-- Dashboard column labels and value formats are owner presentation metadata.
-- They never alter the governed snapshot, replay recipe, result digest, or
-- immutable source table event.

BEGIN;

CREATE OR REPLACE FUNCTION control_plane.dashboard_column_presentation_valid(
  p_column_presentation jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p_column_presentation IS NULL
      OR jsonb_typeof(p_column_presentation) <> 'object' THEN false
    ELSE
      (SELECT count(*) FROM jsonb_object_keys(p_column_presentation)) <= 80
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_each(p_column_presentation) AS entry(column_key, config)
        WHERE length(entry.column_key) NOT BETWEEN 1 AND 160
          OR CASE
            WHEN jsonb_typeof(entry.config) <> 'object' THEN true
            ELSE
              entry.config = '{}'::jsonb
              OR (entry.config - 'label' - 'format' - 'decimals') <> '{}'::jsonb
              OR (
                entry.config ? 'label'
                AND (
                  jsonb_typeof(entry.config->'label') <> 'string'
                  OR length(btrim(entry.config->>'label')) NOT BETWEEN 1 AND 160
                )
              )
              OR (
                entry.config ? 'format'
                AND (
                  jsonb_typeof(entry.config->'format') <> 'string'
                  OR entry.config->>'format' NOT IN (
                    'number', 'currency', 'percent', 'text', 'date', 'datetime'
                  )
                )
              )
              OR (
                entry.config ? 'decimals'
                AND (
                  jsonb_typeof(entry.config->'decimals') <> 'number'
                  OR coalesce(entry.config->>'decimals', '') !~ '^[0-6]$'
                )
              )
          END
      )
  END;
$$;

ALTER TABLE control_plane.dashboard_tiles
  ADD COLUMN column_presentation jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT dashboard_tiles_column_presentation_valid
    CHECK (control_plane.dashboard_column_presentation_valid(column_presentation));

CREATE OR REPLACE FUNCTION control_plane.dashboard_document(
  p_tenant_id text,
  p_dashboard_id text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'dashboardId', dashboard.dashboard_id,
    'revision', dashboard.revision,
    'layouts', dashboard.layouts,
    'tiles', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'tileId', tile.tile_id,
        'title', tile.title,
        'source', jsonb_build_object(
          'conversationId', tile.source_conversation_id,
          'turnId', tile.source_turn_id,
          'tableEventId', tile.source_table_event_id,
          'resultId', tile.source_result_id
        ),
        'replayKind', tile.replay_kind,
        'snapshot', tile.latest_snapshot,
        'columnPresentation', tile.column_presentation,
        'refreshState', tile.refresh_state,
        'lastErrorCode', tile.last_error_code,
        'lastRefreshAttemptAt', tile.last_refresh_attempt_at,
        'lastRefreshedAt', tile.last_refreshed_at,
        'createdAt', tile.created_at
      ) ORDER BY tile.created_at, tile.tile_id)
      FROM control_plane.dashboard_tiles AS tile
      WHERE tile.tenant_id = dashboard.tenant_id
        AND tile.dashboard_id = dashboard.dashboard_id
    ), '[]'::jsonb),
    'createdAt', dashboard.created_at,
    'updatedAt', dashboard.updated_at
  )
  FROM control_plane.personal_dashboards AS dashboard
  WHERE dashboard.tenant_id = p_tenant_id
    AND dashboard.dashboard_id = p_dashboard_id;
$$;

DROP FUNCTION public.albert_dashboard_tile_update(text, text, bigint);

CREATE FUNCTION public.albert_dashboard_tile_update(
  p_tile_id text,
  p_expected_revision bigint,
  p_title text DEFAULT NULL,
  p_column_presentation jsonb DEFAULT NULL
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
  tile_snapshot jsonb;
BEGIN
  PERFORM control_plane.assert_dashboard_revision(
    selected_tenant, selected_dashboard, actor, p_expected_revision
  );
  IF p_title IS NULL AND p_column_presentation IS NULL THEN
    RAISE EXCEPTION 'a tile presentation change is required' USING ERRCODE = '22023';
  END IF;
  IF p_title IS NOT NULL
     AND length(btrim(p_title)) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'tile title must be between 1 and 120 characters' USING ERRCODE = '22023';
  END IF;
  IF p_column_presentation IS NOT NULL
     AND NOT control_plane.dashboard_column_presentation_valid(p_column_presentation) THEN
    RAISE EXCEPTION 'dashboard column presentation is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT tile.latest_snapshot INTO tile_snapshot
  FROM control_plane.dashboard_tiles AS tile
  WHERE tile.tenant_id = selected_tenant
    AND tile.dashboard_id = selected_dashboard
    AND tile.tile_id = p_tile_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dashboard tile was not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_column_presentation IS NOT NULL AND EXISTS (
    SELECT 1
    FROM jsonb_object_keys(p_column_presentation) AS configured(column_key)
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(coalesce(tile_snapshot->'columns', '[]'::jsonb)) AS column_value(value)
      WHERE column_value.value->>'key' = configured.column_key
    )
  ) THEN
    RAISE EXCEPTION 'dashboard presentation references an unknown column' USING ERRCODE = '22023';
  END IF;

  UPDATE control_plane.dashboard_tiles
  SET title = CASE WHEN p_title IS NULL THEN title ELSE btrim(p_title) END,
      column_presentation = coalesce(p_column_presentation, column_presentation),
      updated_at = clock_timestamp()
  WHERE tenant_id = selected_tenant
    AND dashboard_id = selected_dashboard
    AND tile_id = p_tile_id;

  UPDATE control_plane.personal_dashboards
  SET revision = revision + 1, updated_at = clock_timestamp()
  WHERE tenant_id = selected_tenant AND dashboard_id = selected_dashboard;
  RETURN control_plane.dashboard_document(selected_tenant, selected_dashboard);
END;
$$;

REVOKE ALL ON FUNCTION control_plane.dashboard_column_presentation_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_dashboard_tile_update(text, bigint, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_tile_update(text, bigint, text, jsonb)
  TO authenticated;

COMMIT;
