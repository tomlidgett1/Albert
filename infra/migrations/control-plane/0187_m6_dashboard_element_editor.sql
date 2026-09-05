-- 0187: the element editor (ADR 0134 amendment — editing from first principles).
--
-- 1. A tile's governed recipe can now be re-minted by a deterministic
--    requery (granularity, window, comparison, members, limit) — never by the
--    browser sending a query: the server patches the recipe's CubeQuery,
--    validates it against the catalogue for the tile's view, runs it once,
--    and `albert_dashboard_tile_requery` writes the new digest-locked recipe
--    and snapshot in ONE transaction. `recipe_version` guards concurrent
--    edits; `recipe_origin`/`recipe_edited_at` record that the recipe left
--    its trace.
-- 2. Authored column state: `column_presentation` items may hide a column;
--    `albert_dashboard_tile_update` accepts an explicit column order that
--    rewrites the snapshot's column array (the column contract a refresh
--    aligns to), so order is owner state, never result-set order.
-- 3. KPI display gains the comparison presentation Sigma's KPI chart has
--    ('% difference from' / 'Difference from' / '% of' / 'Absolute', higher
--    or lower is better) — presentation only.
-- 4. `albert_dashboard_element_replace` applies a wand edit in one RPC:
--    delete the old tile, pin the replacement, title + display, the old slot
--    on both breakpoints, and the build-conversation link.
-- 5. Rate policy `dashboard.requery`.
--
-- Access posture unchanged: SECURITY DEFINER RPCs re-derive tenant + actor,
-- the browser holds no table grants, every dashboard row is checked against
-- owner_user_id = actor, and every recipe written here carries the digests
-- the refresh adapter re-verifies.

BEGIN;

-- 1. Recipe provenance -------------------------------------------------------

ALTER TABLE control_plane.dashboard_tiles
  ADD COLUMN IF NOT EXISTS recipe_version integer NOT NULL DEFAULT 1;
ALTER TABLE control_plane.dashboard_tiles
  ADD COLUMN IF NOT EXISTS recipe_origin text NOT NULL DEFAULT 'trace';
ALTER TABLE control_plane.dashboard_tiles
  DROP CONSTRAINT IF EXISTS dashboard_tiles_recipe_origin_check;
ALTER TABLE control_plane.dashboard_tiles
  ADD CONSTRAINT dashboard_tiles_recipe_origin_check
  CHECK (recipe_origin IN ('trace', 'edited'));
ALTER TABLE control_plane.dashboard_tiles
  ADD COLUMN IF NOT EXISTS recipe_edited_at timestamptz;

-- 2. Column presentation may hide a column ----------------------------------

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
              OR (entry.config - 'label' - 'format' - 'decimals' - 'hidden') <> '{}'::jsonb
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
              OR (
                entry.config ? 'hidden'
                AND jsonb_typeof(entry.config->'hidden') <> 'boolean'
              )
          END
      )
  END;
$$;

-- 3. KPI comparison presentation ---------------------------------------------

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
     OR octet_length(display::text) > 8192 THEN
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
    RETURN (display - 'mode' - 'note') = '{}'::jsonb;
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

-- 4. Tile update with an authored column order -------------------------------

/** True when `p_key` names one of the snapshot's columns, exactly or by underscore spelling. */
CREATE OR REPLACE FUNCTION control_plane.dashboard_snapshot_has_column(
  p_snapshot jsonb,
  p_key text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_snapshot->'columns', '[]'::jsonb)) AS column_value(value)
    WHERE column_value.value->>'key' = p_key
       OR replace(column_value.value->>'key', '.', '_') = replace(p_key, '.', '_')
  );
$$;

REVOKE ALL ON FUNCTION control_plane.dashboard_snapshot_has_column(jsonb, text) FROM PUBLIC;

/**
 * The snapshot's column array in the owner's order: named keys first in the
 * given order (exact or underscore-equivalent), unnamed columns after in
 * their existing order. Column order is authored state (Sigma), and this
 * array is the contract a refresh aligns to.
 */
CREATE OR REPLACE FUNCTION control_plane.dashboard_reorder_snapshot_columns(
  p_snapshot jsonb,
  p_order text[]
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  columns jsonb := coalesce(p_snapshot->'columns', '[]'::jsonb);
  ordered jsonb := '[]'::jsonb;
  used boolean[] := ARRAY[]::boolean[];
  wanted text;
  column_value jsonb;
  position integer;
  total integer := jsonb_array_length(columns);
BEGIN
  IF p_snapshot IS NULL THEN RETURN NULL; END IF;
  FOR position IN 1..total LOOP
    used := used || false;
  END LOOP;
  FOREACH wanted IN ARRAY p_order LOOP
    FOR position IN 1..total LOOP
      column_value := columns -> (position - 1);
      IF NOT used[position]
         AND (column_value->>'key' = wanted
              OR replace(column_value->>'key', '.', '_') = replace(wanted, '.', '_')) THEN
        ordered := ordered || jsonb_build_array(column_value);
        used[position] := true;
        EXIT;
      END IF;
    END LOOP;
  END LOOP;
  FOR position IN 1..total LOOP
    IF NOT used[position] THEN
      ordered := ordered || jsonb_build_array(columns -> (position - 1));
    END IF;
  END LOOP;
  RETURN jsonb_set(p_snapshot, '{columns}', ordered);
END;
$$;

REVOKE ALL ON FUNCTION control_plane.dashboard_reorder_snapshot_columns(jsonb, text[]) FROM PUBLIC;

DROP FUNCTION IF EXISTS public.albert_dashboard_tile_update(text, bigint, text, jsonb, jsonb, jsonb, text);

CREATE FUNCTION public.albert_dashboard_tile_update(
  p_tile_id text,
  p_expected_revision bigint,
  p_title text DEFAULT NULL,
  p_column_presentation jsonb DEFAULT NULL,
  p_display jsonb DEFAULT NULL,
  p_query_overrides jsonb DEFAULT NULL,
  p_dashboard_id text DEFAULT NULL,
  p_column_order text[] DEFAULT NULL
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
  selected_dashboard text;
  tile_snapshot jsonb;
  tile_replay_kind text;
  tile_overrides jsonb;
  overrides_changed boolean := false;
  order_key text;
BEGIN
  selected_dashboard := control_plane.require_owned_dashboard(selected_tenant, actor, p_dashboard_id);
  PERFORM control_plane.assert_dashboard_revision(
    selected_tenant, selected_dashboard, actor, p_expected_revision
  );
  IF p_title IS NULL AND p_column_presentation IS NULL AND p_display IS NULL
     AND p_query_overrides IS NULL AND p_column_order IS NULL THEN
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
  IF p_display IS NOT NULL
     AND NOT control_plane.dashboard_tile_display_valid(p_display) THEN
    RAISE EXCEPTION 'dashboard tile display is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_query_overrides IS NOT NULL
     AND NOT control_plane.dashboard_query_overrides_valid(p_query_overrides) THEN
    RAISE EXCEPTION 'dashboard query overrides are invalid' USING ERRCODE = '22023';
  END IF;
  IF p_column_order IS NOT NULL
     AND (cardinality(p_column_order) > 80
          OR EXISTS (SELECT 1 FROM unnest(p_column_order) AS key WHERE length(key) NOT BETWEEN 1 AND 160)) THEN
    RAISE EXCEPTION 'dashboard column order is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT tile.latest_snapshot, tile.replay_kind, tile.query_overrides
    INTO tile_snapshot, tile_replay_kind, tile_overrides
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
    WHERE NOT control_plane.dashboard_snapshot_has_column(tile_snapshot, configured.column_key)
  ) THEN
    RAISE EXCEPTION 'dashboard presentation references an unknown column' USING ERRCODE = '22023';
  END IF;

  IF p_query_overrides IS NOT NULL THEN
    overrides_changed := p_query_overrides <> tile_overrides;
    IF p_query_overrides <> '{}'::jsonb AND tile_replay_kind <> 'cube_v3' THEN
      RAISE EXCEPTION 'sorting and filters need a governed query behind the element' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM (
        SELECT element.value->>'column' AS column_key
        FROM jsonb_array_elements(coalesce(p_query_overrides->'order', '[]'::jsonb)) AS element
        UNION ALL
        SELECT element.value->>'column'
        FROM jsonb_array_elements(coalesce(p_query_overrides->'filters', '[]'::jsonb)) AS element
      ) AS referenced
      WHERE NOT control_plane.dashboard_snapshot_has_column(tile_snapshot, referenced.column_key)
    ) THEN
      RAISE EXCEPTION 'dashboard query overrides reference an unknown column' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_column_order IS NOT NULL THEN
    IF tile_snapshot IS NULL THEN
      RAISE EXCEPTION 'dashboard column order needs a snapshot' USING ERRCODE = '22023';
    END IF;
    FOREACH order_key IN ARRAY p_column_order LOOP
      IF NOT control_plane.dashboard_snapshot_has_column(tile_snapshot, order_key) THEN
        RAISE EXCEPTION 'dashboard column order references an unknown column' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  UPDATE control_plane.dashboard_tiles
  SET title = CASE WHEN p_title IS NULL THEN title ELSE btrim(p_title) END,
      column_presentation = coalesce(p_column_presentation, column_presentation),
      display = coalesce(p_display, display),
      query_overrides = coalesce(p_query_overrides, query_overrides),
      latest_snapshot = CASE
        WHEN p_column_order IS NULL THEN latest_snapshot
        ELSE control_plane.dashboard_reorder_snapshot_columns(latest_snapshot, p_column_order)
      END,
      refresh_state = CASE
        WHEN overrides_changed AND refresh_state <> 'refreshing' THEN 'stale'
        ELSE refresh_state
      END,
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

-- 5. Deterministic requery: a new governed recipe and its snapshot, atomically --

CREATE OR REPLACE FUNCTION public.albert_dashboard_tile_requery(
  p_tile_id text,
  p_expected_revision bigint,
  p_recipe_version integer,
  p_recipe jsonb,
  p_snapshot jsonb,
  p_result_digest text,
  p_row_count bigint,
  p_source_watermarks jsonb,
  p_started_at timestamptz,
  p_latency_ms integer,
  p_dedupe_status text,
  p_display jsonb DEFAULT NULL,
  p_query_overrides jsonb DEFAULT NULL,
  p_column_presentation jsonb DEFAULT NULL,
  p_adapter_metadata jsonb DEFAULT '{}'::jsonb,
  p_dashboard_id text DEFAULT NULL
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
  selected_dashboard text;
  tile_row control_plane.dashboard_tiles%ROWTYPE;
  kept_presentation jsonb := '{}'::jsonb;
  presentation_entry record;
  next_display jsonb;
BEGIN
  selected_dashboard := control_plane.require_owned_dashboard(selected_tenant, actor, p_dashboard_id);
  PERFORM control_plane.assert_dashboard_revision(
    selected_tenant, selected_dashboard, actor, p_expected_revision
  );
  IF jsonb_typeof(p_recipe) <> 'object'
     OR p_recipe->>'kind' <> 'cube_v3'
     OR length(coalesce(p_recipe->>'queryYaml', '')) NOT BETWEEN 1 AND 32000
     OR coalesce(p_recipe->>'queryDigest', '') !~ '^[0-9a-f]{64}$'
     OR coalesce(p_recipe->>'semanticVersionDigest', '') !~ '^[0-9a-f]{64}$'
     OR length(coalesce(p_recipe->>'view', '')) NOT BETWEEN 1 AND 160
     OR (p_recipe - 'kind' - 'queryYaml' - 'queryDigest' - 'semanticVersionDigest' - 'view' - 'connector') <> '{}'::jsonb THEN
    RAISE EXCEPTION 'dashboard requery recipe is invalid' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_snapshot) <> 'object'
     OR jsonb_typeof(p_snapshot->'columns') <> 'array'
     OR jsonb_array_length(p_snapshot->'columns') NOT BETWEEN 1 AND 80
     OR jsonb_array_length(coalesce(p_snapshot->'rows', '[]'::jsonb)) > 50
     OR coalesce(p_result_digest, '') !~ '^[0-9a-f]{64}$'
     OR p_row_count IS NULL OR p_row_count < 0
     OR p_dedupe_status NOT IN ('executed', 'cache_hit')
     OR p_latency_ms NOT BETWEEN 0 AND 600000
     OR jsonb_typeof(coalesce(p_source_watermarks, '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_adapter_metadata, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'dashboard requery snapshot is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_display IS NOT NULL AND NOT control_plane.dashboard_tile_display_valid(p_display) THEN
    RAISE EXCEPTION 'dashboard tile display is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_query_overrides IS NOT NULL AND NOT control_plane.dashboard_query_overrides_valid(p_query_overrides) THEN
    RAISE EXCEPTION 'dashboard query overrides are invalid' USING ERRCODE = '22023';
  END IF;
  IF p_column_presentation IS NOT NULL
     AND NOT control_plane.dashboard_column_presentation_valid(p_column_presentation) THEN
    RAISE EXCEPTION 'dashboard column presentation is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT tile.* INTO tile_row
  FROM control_plane.dashboard_tiles AS tile
  WHERE tile.tenant_id = selected_tenant
    AND tile.dashboard_id = selected_dashboard
    AND tile.tile_id = p_tile_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dashboard tile was not found' USING ERRCODE = 'P0002';
  END IF;
  IF tile_row.replay_kind <> 'cube_v3' THEN
    RAISE EXCEPTION 'only a governed query element can be requeried' USING ERRCODE = '22023';
  END IF;
  -- A newer edit already re-minted the recipe: the caller must re-read.
  IF tile_row.recipe_version <> p_recipe_version THEN
    RAISE EXCEPTION 'dashboard recipe version conflict' USING ERRCODE = '40001';
  END IF;

  -- Presentation, overrides and display keys that no longer name a column
  -- of the new result are dropped rather than left dangling. The caller may
  -- send the presentation already remapped to the new keys (a granularity
  -- change re-spells a time column); it is validated against the new columns.
  FOR presentation_entry IN
    SELECT entry.column_key, entry.config
    FROM jsonb_each(coalesce(p_column_presentation, tile_row.column_presentation)) AS entry(column_key, config)
  LOOP
    IF control_plane.dashboard_snapshot_has_column(p_snapshot, presentation_entry.column_key) THEN
      kept_presentation := kept_presentation || jsonb_build_object(presentation_entry.column_key, presentation_entry.config);
    END IF;
  END LOOP;
  next_display := coalesce(p_display, tile_row.display);
  IF next_display->>'mode' = 'kpi' AND next_display ? 'valueKey'
     AND NOT control_plane.dashboard_snapshot_has_column(p_snapshot, next_display->>'valueKey') THEN
    next_display := next_display - 'valueKey';
  END IF;
  IF next_display->>'mode' = 'chart'
     AND (NOT control_plane.dashboard_snapshot_has_column(p_snapshot, next_display->>'xKey')
          OR NOT control_plane.dashboard_snapshot_has_column(p_snapshot, next_display->>'yKey')) THEN
    next_display := jsonb_build_object('mode', 'table')
      || CASE WHEN next_display ? 'note' THEN jsonb_build_object('note', next_display->'note') ELSE '{}'::jsonb END;
  END IF;

  UPDATE control_plane.dashboard_tiles
  SET replay_recipe = p_recipe,
      recipe_version = recipe_version + 1,
      recipe_origin = 'edited',
      recipe_edited_at = clock_timestamp(),
      latest_snapshot = p_snapshot,
      column_presentation = kept_presentation,
      display = next_display,
      query_overrides = CASE
        WHEN p_query_overrides IS NOT NULL THEN p_query_overrides
        ELSE (
          -- Keep only overrides whose columns survive the requery.
          SELECT coalesce(jsonb_strip_nulls(jsonb_build_object(
            'order', (
              SELECT jsonb_agg(element.value)
              FROM jsonb_array_elements(coalesce(query_overrides->'order', '[]'::jsonb)) AS element
              WHERE control_plane.dashboard_snapshot_has_column(p_snapshot, element.value->>'column')
            ),
            'filters', (
              SELECT jsonb_agg(element.value)
              FROM jsonb_array_elements(coalesce(query_overrides->'filters', '[]'::jsonb)) AS element
              WHERE control_plane.dashboard_snapshot_has_column(p_snapshot, element.value->>'column')
            ),
            'limit', query_overrides->'limit'
          )), '{}'::jsonb)
        )
      END,
      refresh_state = 'current',
      last_error_code = NULL,
      last_refreshed_at = clock_timestamp(),
      last_refresh_attempt_at = clock_timestamp(),
      refresh_claimed_at = NULL,
      refresh_lease_id = NULL,
      refresh_lease_expires_at = NULL,
      updated_at = clock_timestamp()
  WHERE tenant_id = selected_tenant
    AND dashboard_id = selected_dashboard
    AND tile_id = p_tile_id;

  INSERT INTO control_plane.dashboard_refresh_events (
    tenant_id, dashboard_id, refresh_event_id, tile_id, outcome, started_at,
    latency_ms, result_digest, row_count, source_watermarks, adapter,
    dedupe_status, error_code, adapter_metadata
  ) VALUES (
    selected_tenant, selected_dashboard, control_plane.generate_ulid(), p_tile_id,
    CASE WHEN p_row_count = 0 THEN 'empty' ELSE 'success' END, p_started_at, p_latency_ms,
    p_result_digest, p_row_count, coalesce(p_source_watermarks, '[]'::jsonb), 'cube_v3',
    p_dedupe_status, NULL,
    coalesce(p_adapter_metadata, '{}'::jsonb) || jsonb_build_object('requery', true, 'recipeVersion', tile_row.recipe_version + 1)
  );

  UPDATE control_plane.personal_dashboards
  SET revision = revision + 1, updated_at = clock_timestamp()
  WHERE tenant_id = selected_tenant AND dashboard_id = selected_dashboard;
  RETURN control_plane.dashboard_document(selected_tenant, selected_dashboard);
END;
$$;

-- 6. One-RPC element replace for wand edits ------------------------------------

CREATE OR REPLACE FUNCTION public.albert_dashboard_element_replace(
  p_dashboard_id text,
  p_replace_tile_id text,
  p_conversation_id text,
  p_turn_id text,
  p_table_event_id text,
  p_result_id text,
  p_title text,
  p_display jsonb,
  p_layouts jsonb,
  p_expected_revision bigint
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
  selected_dashboard text;
  revision bigint := p_expected_revision;
  document jsonb;
  minted_tile_id text;
BEGIN
  selected_dashboard := control_plane.require_owned_dashboard(selected_tenant, actor, p_dashboard_id);
  PERFORM control_plane.assert_dashboard_revision(selected_tenant, selected_dashboard, actor, revision);
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.dashboard_tiles
    WHERE tenant_id = selected_tenant AND dashboard_id = selected_dashboard AND tile_id = p_replace_tile_id
  ) THEN
    RAISE EXCEPTION 'the element being edited is no longer on the dashboard' USING ERRCODE = 'P0002';
  END IF;
  -- Each step is the existing owner RPC, so its checks all apply; the
  -- revision advances by one per step and the whole thing is one transaction.
  PERFORM public.albert_dashboard_tile_delete(p_replace_tile_id, revision, selected_dashboard);
  revision := revision + 1;
  document := public.albert_dashboard_pin(p_conversation_id, p_turn_id, p_table_event_id, p_result_id, revision, selected_dashboard);
  revision := revision + 1;
  SELECT tile.tile_id INTO minted_tile_id
  FROM control_plane.dashboard_tiles AS tile
  WHERE tile.tenant_id = selected_tenant AND tile.dashboard_id = selected_dashboard
    AND tile.source_table_event_id = p_table_event_id;
  IF minted_tile_id IS NULL THEN
    RAISE EXCEPTION 'the replacement element could not be pinned' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.albert_dashboard_tile_update(minted_tile_id, revision, p_title, NULL, p_display, NULL, selected_dashboard, NULL);
  revision := revision + 1;
  -- The caller computed the layouts with the replacement in the old slot,
  -- naming the new tile by a placeholder the server fills in.
  PERFORM public.albert_dashboard_layout_update(
    replace(p_layouts::text, '"__replacement__"', to_jsonb(minted_tile_id)::text)::jsonb,
    revision,
    selected_dashboard
  );
  revision := revision + 1;
  BEGIN
    document := public.albert_dashboard_link_conversation(p_conversation_id, revision, selected_dashboard);
  EXCEPTION WHEN OTHERS THEN
    document := control_plane.dashboard_document(selected_tenant, selected_dashboard);
  END;
  RETURN document || jsonb_build_object('replacedTileId', p_replace_tile_id, 'newTileId', minted_tile_id);
END;
$$;

-- 7. The document carries recipe provenance --------------------------------------

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
        'snapshot', tile.latest_snapshot,
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

-- 8. Releasing a requery lease that produced nothing -----------------------------

/**
 * A requery claims the tile (the Cube capability needs a live lease) and,
 * when the edit cannot be run, hands the lease back without recording a
 * refresh outcome: the element keeps its data and its state, and the owner
 * sees the edit's own message instead of an error badge.
 */
CREATE OR REPLACE FUNCTION public.albert_dashboard_refresh_release(
  p_tile_id text,
  p_lease_id text,
  p_dashboard_id text DEFAULT NULL
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
  selected_dashboard text;
BEGIN
  selected_dashboard := control_plane.require_owned_dashboard(selected_tenant, actor, p_dashboard_id);
  UPDATE control_plane.dashboard_tiles
  SET refresh_state = CASE WHEN latest_snapshot IS NULL THEN 'stale' ELSE 'current' END,
      refresh_claimed_at = NULL,
      refresh_lease_id = NULL,
      refresh_lease_expires_at = NULL,
      updated_at = clock_timestamp()
  WHERE tenant_id = selected_tenant
    AND dashboard_id = selected_dashboard
    AND tile_id = p_tile_id
    AND refresh_lease_id = p_lease_id;
  RETURN control_plane.dashboard_document(selected_tenant, selected_dashboard);
END;
$$;

REVOKE ALL ON FUNCTION public.albert_dashboard_refresh_release(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_refresh_release(text, text, text) TO authenticated;

-- 9. Rate policy and grants ----------------------------------------------------

INSERT INTO control_plane.rate_limit_policies (action, request_limit, window_seconds, audit_excess)
VALUES ('dashboard.requery', 240, 3600, false)
ON CONFLICT (action) DO UPDATE SET
  request_limit = EXCLUDED.request_limit,
  window_seconds = EXCLUDED.window_seconds,
  audit_excess = EXCLUDED.audit_excess;

REVOKE ALL ON FUNCTION public.albert_dashboard_tile_update(text, bigint, text, jsonb, jsonb, jsonb, text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_dashboard_tile_requery(
  text, bigint, integer, jsonb, jsonb, text, bigint, jsonb, timestamptz, integer, text, jsonb, jsonb, jsonb, jsonb, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_dashboard_element_replace(
  text, text, text, text, text, text, text, jsonb, jsonb, bigint
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.albert_dashboard_tile_update(text, bigint, text, jsonb, jsonb, jsonb, text, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_tile_requery(
  text, bigint, integer, jsonb, jsonb, text, bigint, jsonb, timestamptz, integer, text, jsonb, jsonb, jsonb, jsonb, text
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_element_replace(
  text, text, text, text, text, text, text, jsonb, jsonb, bigint
) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
