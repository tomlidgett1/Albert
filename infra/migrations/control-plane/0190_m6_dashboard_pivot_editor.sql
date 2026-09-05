-- 0190: persistent pivot shelves and a docked element editor (ADR 0136).
-- Presentation only; governed snapshots and replay recipes stay immutable.
BEGIN;

CREATE OR REPLACE FUNCTION control_plane.dashboard_pivot_valid(config jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE item jsonb; axis text; field_name text; seen text[] := ARRAY[]::text[];
BEGIN
  IF config IS NULL OR jsonb_typeof(config) <> 'object'
    OR (config - 'source' - 'rows' - 'columns' - 'values' - 'rowLayout' - 'rowTotals' - 'columnTotals' - 'rowSubtotals' - 'repeatRowLabels' - 'showRowHeaders' - 'showColumnHeaders' - 'emptyValue' - 'sort') <> '{}'::jsonb
    OR coalesce(config->>'source','') NOT IN ('result','composed') THEN RETURN false; END IF;
  FOREACH axis IN ARRAY ARRAY['rows','columns'] LOOP
    IF coalesce(jsonb_typeof(config->axis),'') <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(config->axis) > 5 THEN RETURN false; END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(config->axis) LOOP
      field_name := item #>> '{}';
      IF jsonb_typeof(item) <> 'string' OR length(field_name) NOT BETWEEN 1 AND 160 OR field_name = ANY(seen) THEN RETURN false; END IF;
      seen := array_append(seen, field_name);
    END LOOP;
  END LOOP;
  IF coalesce(jsonb_typeof(config->'values'),'') <> 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(config->'values') > 12 THEN RETURN false; END IF;
  seen := ARRAY[]::text[];
  FOR item IN SELECT value FROM jsonb_array_elements(config->'values') LOOP
    IF jsonb_typeof(item) <> 'object' OR (item - 'column' - 'aggregate' - 'label' - 'format' - 'decimals') <> '{}'::jsonb
      OR coalesce(jsonb_typeof(item->'column'),'') <> 'string' OR length(coalesce(item->>'column','')) NOT BETWEEN 1 AND 160
      OR item->>'column' = '__values__' OR item->>'column' = ANY(seen)
      OR coalesce(item->>'aggregate','') NOT IN ('none','sum','avg','min','max','count','count_distinct') THEN RETURN false; END IF;
    seen := array_append(seen, item->>'column');
    IF item ? 'label' AND (jsonb_typeof(item->'label') <> 'string' OR length(btrim(item->>'label')) NOT BETWEEN 1 AND 160) THEN RETURN false; END IF;
    IF item ? 'format' AND coalesce(item->>'format','') NOT IN ('number','currency','percent','text','date','datetime') THEN RETURN false; END IF;
    IF item ? 'decimals' AND (jsonb_typeof(item->'decimals') <> 'number' OR coalesce(item->>'decimals','') !~ '^[0-6]$') THEN RETURN false; END IF;
  END LOOP;
  FOREACH field_name IN ARRAY ARRAY['rowTotals','columnTotals','rowSubtotals','repeatRowLabels','showRowHeaders','showColumnHeaders'] LOOP
    IF config ? field_name AND jsonb_typeof(config->field_name) <> 'boolean' THEN RETURN false; END IF;
  END LOOP;
  IF config ? 'rowLayout' AND coalesce(config->>'rowLayout','') NOT IN ('single','separate') THEN RETURN false; END IF;
  IF config ? 'emptyValue' AND (jsonb_typeof(config->'emptyValue') <> 'string' OR length(config->>'emptyValue') > 40) THEN RETURN false; END IF;
  IF config ? 'sort' THEN
    IF jsonb_typeof(config->'sort') <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(config->'sort') > 8 THEN RETURN false; END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(config->'sort') LOOP
      IF jsonb_typeof(item) <> 'object' OR (item - 'column' - 'direction') <> '{}'::jsonb
        OR coalesce(jsonb_typeof(item->'column'),'') <> 'string' OR length(coalesce(item->>'column','')) NOT BETWEEN 1 AND 160
        OR coalesce(item->>'direction','') NOT IN ('asc','desc') THEN RETURN false; END IF;
    END LOOP;
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION control_plane.dashboard_pivot_valid(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION control_plane.dashboard_table_style_valid(config jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE field_name text;
BEGIN
  IF config IS NULL OR jsonb_typeof(config) <> 'object'
    OR (config - 'preset' - 'rowHeight' - 'rowNumbers' - 'bandedRows' - 'verticalGrid') <> '{}'::jsonb THEN RETURN false; END IF;
  IF config ? 'preset' AND coalesce(config->>'preset','') NOT IN ('spreadsheet','presentation') THEN RETURN false; END IF;
  IF config ? 'rowHeight' AND coalesce(config->>'rowHeight','') NOT IN ('small','medium','large') THEN RETURN false; END IF;
  FOREACH field_name IN ARRAY ARRAY['rowNumbers','bandedRows','verticalGrid'] LOOP
    IF config ? field_name AND jsonb_typeof(config->field_name) <> 'boolean' THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION control_plane.dashboard_table_style_valid(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION control_plane.dashboard_tile_display_valid(display jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  mode text;
  series_entry jsonb;
BEGIN
  IF display IS NULL OR jsonb_typeof(display) <> 'object'
     OR octet_length(display::text) > 32768 THEN
    RETURN false;
  END IF;
  mode := display ->> 'mode';
  IF mode IS NULL OR mode NOT IN ('table', 'kpi', 'chart') THEN
    RETURN false;
  END IF;
  IF display ? 'note'
     AND (jsonb_typeof(display -> 'note') <> 'string'
          OR length(display ->> 'note') > 160) THEN
    RETURN false;
  END IF;
  IF mode = 'table' THEN
    RETURN (display - 'mode' - 'note' - 'pivot' - 'tableStyle') = '{}'::jsonb AND (NOT (display ? 'pivot') OR display->'pivot' = 'null'::jsonb OR control_plane.dashboard_pivot_valid(display->'pivot')) AND (NOT (display ? 'tableStyle') OR control_plane.dashboard_table_style_valid(display->'tableStyle'));
  END IF;
  IF mode = 'kpi' THEN
    IF (display - 'mode' - 'note' - 'valueKey' - 'comparison' - 'betterWhen') <> '{}'::jsonb THEN
      RETURN false;
    END IF;
    IF display ? 'valueKey'
       AND (jsonb_typeof(display -> 'valueKey') <> 'string'
            OR length(display ->> 'valueKey') NOT BETWEEN 1 AND 160) THEN
      RETURN false;
    END IF;
    IF display ? 'comparison'
       AND coalesce(display ->> 'comparison', '') NOT IN ('percent_difference', 'difference', 'percent_of', 'absolute') THEN
      RETURN false;
    END IF;
    IF display ? 'betterWhen'
       AND coalesce(display ->> 'betterWhen', '') NOT IN ('higher', 'lower') THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;
  -- chart
  IF (display - 'mode' - 'note' - 'chartType' - 'xKey' - 'yKey' - 'series' - 'stacked' - 'orientation') <> '{}'::jsonb THEN
    RETURN false;
  END IF;
  IF coalesce(display ->> 'chartType', '') NOT IN ('bar', 'line')
     OR length(coalesce(display ->> 'xKey', '')) NOT BETWEEN 1 AND 160
     OR length(coalesce(display ->> 'yKey', '')) NOT BETWEEN 1 AND 160 THEN
    RETURN false;
  END IF;
  IF display ? 'stacked' AND jsonb_typeof(display -> 'stacked') <> 'boolean' THEN
    RETURN false;
  END IF;
  IF display ? 'orientation'
     AND coalesce(display ->> 'orientation', '') NOT IN ('vertical', 'horizontal') THEN
    RETURN false;
  END IF;
  IF display ? 'series' THEN
    IF jsonb_typeof(display -> 'series') <> 'array'
       OR jsonb_array_length(display -> 'series') > 6 THEN
      RETURN false;
    END IF;
    FOR series_entry IN SELECT value FROM jsonb_array_elements(display -> 'series') LOOP
      IF jsonb_typeof(series_entry) <> 'object'
         OR length(coalesce(series_entry ->> 'key', '')) NOT BETWEEN 1 AND 160
         OR length(coalesce(series_entry ->> 'label', '')) NOT BETWEEN 1 AND 160 THEN
        RETURN false;
      END IF;
    END LOOP;
  END IF;
  RETURN true;
END;
$$;

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
    'title', dashboard.title,
    'revision', dashboard.revision,
    'layouts', dashboard.layouts,
    'lastBuildConversationId', dashboard.last_build_conversation_id,
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
        'queryYaml', CASE
          WHEN tile.replay_kind = 'cube_v3' THEN tile.replay_recipe ->> 'queryYaml'
          ELSE NULL
        END,
        'recipeVersion', tile.recipe_version,
        'recipeOrigin', tile.recipe_origin,
        'snapshot', CASE WHEN tile.latest_snapshot IS NULL THEN NULL ELSE jsonb_set(tile.latest_snapshot, '{provenance}', coalesce(nullif(tile.latest_snapshot->'provenance','null'::jsonb),'{}'::jsonb) || jsonb_build_object('dashboardPivot', CASE WHEN tile.replay_kind = 'derived_v1' AND tile.replay_recipe->'transform'->'columns'->0->>'key' = 'metric' AND EXISTS (SELECT 1 FROM jsonb_array_elements(tile.replay_recipe->'transform'->'columns') AS c WHERE c ? 'labelSource') THEN jsonb_build_object('rowFormats', (SELECT event.event->'rowFormats' FROM control_plane.conversation_turn_events AS event WHERE event.tenant_id = tile.tenant_id AND event.turn_id = tile.source_turn_id AND event.event->>'id' = tile.source_table_event_id AND event.event->>'type' = 'table' LIMIT 1)) ELSE NULL END)) END,
        'columnPresentation', tile.column_presentation,
        'display', tile.display,
        'queryOverrides', tile.query_overrides,
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

NOTIFY pgrst, 'reload schema';
COMMIT;
