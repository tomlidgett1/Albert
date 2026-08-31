-- 0179: the natural-language dashboard builder (ADR 0129).
--
-- 1. Widen the answer-event type whitelist with the Omni runtime's 'tasks'
--    and 'research' events and the new 'dashboard_plan' event. The 0140
--    whitelist predates Omni: its first 'tasks' event was rejected and the
--    contiguous-sequence gate then rejected every later event, so no Omni
--    turn had ever persisted its queries, tables or answer.
-- 2. Teach dashboard tiles a display mode (table | kpi | chart) so generated
--    dashboards can render KPI cards and charts over the same governed
--    snapshots, with `albert_dashboard_tile_update` accepting the new shape.
-- 3. Seed the dashboard.build rate-limit policy.

BEGIN;

-- 1. Answer-event whitelist -------------------------------------------------

CREATE OR REPLACE FUNCTION public.albert_answer_event_append(
  p_conversation_id text,
  p_turn_id text,
  p_event jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := extensions.albert_auth_uid();
  selected_tenant text := control_plane.require_current_tenant_id();
  next_sequence integer;
BEGIN
  IF p_event IS NULL OR jsonb_typeof(p_event) <> 'object'
     OR octet_length(p_event::text) > 2097152
     OR coalesce(p_event ->> 'id', '') !~ '^.{1,128}$'
     OR coalesce(p_event ->> 'type', '') NOT IN (
       'progress', 'narrative', 'plan', 'query', 'table', 'chart',
       'validation', 'answer', 'clarification', 'error',
       'tasks', 'research', 'dashboard_plan'
     )
     OR coalesce(p_event ->> 'sequence', '') !~ '^[1-9][0-9]*$'
     OR coalesce(p_event ->> 'occurredAt', '') IN ('', 'infinity', '-infinity')
     OR control_plane.trace_event_has_forbidden_key(p_event) THEN
    RAISE EXCEPTION 'event must be an object' USING ERRCODE = '22023';
  END IF;
  BEGIN
    PERFORM (p_event ->> 'occurredAt')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'event occurredAt is invalid' USING ERRCODE = '22023';
  END;

  PERFORM 1
  FROM control_plane.conversation_turns AS turn
  JOIN control_plane.conversations AS conversation
    ON conversation.tenant_id = turn.tenant_id
   AND conversation.conversation_id = turn.conversation_id
  WHERE turn.tenant_id = selected_tenant
    AND turn.turn_id = p_turn_id
    AND turn.conversation_id = p_conversation_id
    AND turn.status = 'running'
    AND turn.created_by = actor
    AND conversation.created_by = actor
  FOR UPDATE OF turn;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'running conversation turn was not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT coalesce(max(event.sequence_number), 0) + 1
    INTO next_sequence
  FROM control_plane.conversation_turn_events AS event
  WHERE event.tenant_id = selected_tenant
    AND event.turn_id = p_turn_id;

  IF (p_event ->> 'sequence')::integer <> next_sequence THEN
    RAISE EXCEPTION 'event sequence is not contiguous' USING ERRCODE = '22023';
  END IF;

  INSERT INTO control_plane.conversation_turn_events (
    tenant_id, turn_event_id, conversation_id, turn_id, sequence_number, event
  ) VALUES (
    selected_tenant, control_plane.generate_ulid(), p_conversation_id,
    p_turn_id, next_sequence, p_event
  );

  RETURN next_sequence;
END;
$$;

REVOKE ALL ON FUNCTION public.albert_answer_event_append(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_answer_event_append(text, text, jsonb) TO authenticated;

-- 2. Tile display modes -----------------------------------------------------

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
    RETURN true;
  END IF;
  IF mode = 'kpi' THEN
    RETURN NOT (display ? 'valueKey')
        OR (jsonb_typeof(display -> 'valueKey') = 'string'
            AND length(display ->> 'valueKey') BETWEEN 1 AND 160);
  END IF;
  -- chart
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

REVOKE ALL ON FUNCTION control_plane.dashboard_tile_display_valid(jsonb) FROM PUBLIC;

ALTER TABLE control_plane.dashboard_tiles
  ADD COLUMN display jsonb NOT NULL DEFAULT '{"mode":"table"}'::jsonb;
ALTER TABLE control_plane.dashboard_tiles
  ADD CONSTRAINT dashboard_tiles_display_valid
  CHECK (control_plane.dashboard_tile_display_valid(display));

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
        'display', tile.display,
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

DROP FUNCTION public.albert_dashboard_tile_update(text, bigint, text, jsonb);

CREATE FUNCTION public.albert_dashboard_tile_update(
  p_tile_id text,
  p_expected_revision bigint,
  p_title text DEFAULT NULL,
  p_column_presentation jsonb DEFAULT NULL,
  p_display jsonb DEFAULT NULL
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
  IF p_title IS NULL AND p_column_presentation IS NULL AND p_display IS NULL THEN
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
      display = coalesce(p_display, display),
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

REVOKE ALL ON FUNCTION public.albert_dashboard_tile_update(text, bigint, text, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_tile_update(text, bigint, text, jsonb, jsonb)
  TO authenticated;

-- 3. Rate-limit policy ------------------------------------------------------

INSERT INTO control_plane.rate_limit_policies (action, request_limit, window_seconds, audit_excess)
VALUES ('dashboard.build', 24, 86400, false)
ON CONFLICT (action) DO UPDATE SET
  request_limit = EXCLUDED.request_limit,
  window_seconds = EXCLUDED.window_seconds,
  audit_excess = EXCLUDED.audit_excess;

NOTIFY pgrst, 'reload schema';

COMMIT;
