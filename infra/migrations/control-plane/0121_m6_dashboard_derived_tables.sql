-- Owner-facing pivots and other composed answer tables are deterministic
-- transforms over governed query events. Pinning resolves every direct source
-- recipe from the immutable trace; refresh replays those sources and applies
-- the sealed transform without invoking a model.

BEGIN;

ALTER TABLE control_plane.dashboard_tiles
  DROP CONSTRAINT dashboard_tiles_replay_kind_check,
  ADD CONSTRAINT dashboard_tiles_replay_kind_check
    CHECK (replay_kind IN ('cube_v3', 'semantic_v2', 'derived_v1'));

ALTER TABLE control_plane.dashboard_refresh_events
  DROP CONSTRAINT dashboard_refresh_events_adapter_check,
  ADD CONSTRAINT dashboard_refresh_events_adapter_check
    CHECK (adapter IN ('cube_v3', 'semantic_v2', 'derived_v1'));

CREATE OR REPLACE FUNCTION control_plane.dashboard_direct_source_recipe(
  p_tenant_id text,
  p_turn_id text,
  p_table_event_id text,
  p_result_id text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  source_event jsonb;
  source_replay jsonb;
  query_event jsonb;
  source_recipe jsonb;
BEGIN
  SELECT event.event INTO source_event
  FROM control_plane.conversation_turn_events AS event
  WHERE event.tenant_id = p_tenant_id
    AND event.turn_id = p_turn_id
    AND event.event->>'id' = p_table_event_id
    AND event.event->>'type' = 'table'
    AND event.event->>'resultId' = p_result_id;
  IF source_event IS NULL THEN
    RAISE EXCEPTION 'a derived table source event was not found' USING ERRCODE = 'P0002';
  END IF;

  source_replay := source_event->'dashboardReplay';
  IF jsonb_typeof(source_replay) <> 'object'
     OR source_replay->>'kind' NOT IN ('cube_v3', 'semantic_v2') THEN
    RAISE EXCEPTION 'a derived table source is not directly replayable' USING ERRCODE = '22023';
  END IF;

  IF source_replay->>'kind' = 'cube_v3' THEN
    SELECT event.event INTO query_event
    FROM control_plane.conversation_turn_events AS event
    WHERE event.tenant_id = p_tenant_id
      AND event.turn_id = p_turn_id
      AND event.event->>'id' = source_replay->>'queryEventId'
      AND event.event->>'type' = 'query';
    IF query_event IS NULL
       OR coalesce(query_event->>'queryYaml', '') = ''
       OR coalesce(source_replay->>'queryDigest', '') !~ '^[0-9a-f]{64}$'
       OR coalesce(source_replay->>'semanticVersionDigest', '') !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'the Cube source replay reference is invalid' USING ERRCODE = '22023';
    END IF;
    source_recipe := jsonb_build_object(
      'kind', 'cube_v3',
      'queryYaml', query_event->>'queryYaml',
      'queryDigest', source_replay->>'queryDigest',
      'semanticVersionDigest', source_replay->>'semanticVersionDigest',
      'view', query_event->>'view',
      'connector', query_event->>'connector'
    );
  ELSE
    IF coalesce(source_replay->>'executionId', '') = ''
       OR coalesce(source_replay->>'resultId', '') = ''
       OR coalesce(source_replay->>'publicationHash', '') !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'the Semantic V2 source replay reference is invalid' USING ERRCODE = '22023';
    END IF;
    source_recipe := source_replay;
  END IF;

  RETURN jsonb_build_object(
    'tableEventId', p_table_event_id,
    'resultId', p_result_id,
    'recipe', source_recipe
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_dashboard_pin(
  p_conversation_id text,
  p_turn_id text,
  p_table_event_id text,
  p_result_id text,
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
  table_event jsonb;
  replay jsonb;
  derivation jsonb;
  source_ref jsonb;
  resolved_source jsonb;
  resolved_sources jsonb := '[]'::jsonb;
  recipe jsonb;
  initial_snapshot jsonb;
  resolved_title text;
  row_count bigint;
BEGIN
  selected_dashboard := control_plane.require_personal_dashboard(selected_tenant, actor);
  PERFORM control_plane.assert_dashboard_revision(
    selected_tenant, selected_dashboard, actor, p_expected_revision
  );

  IF EXISTS (
    SELECT 1 FROM control_plane.dashboard_tiles
    WHERE tenant_id = selected_tenant AND dashboard_id = selected_dashboard
      AND source_table_event_id = p_table_event_id
  ) THEN
    RETURN control_plane.dashboard_document(selected_tenant, selected_dashboard);
  END IF;
  IF (SELECT count(*) FROM control_plane.dashboard_tiles
      WHERE tenant_id = selected_tenant AND dashboard_id = selected_dashboard) >= 24 THEN
    RAISE EXCEPTION 'a dashboard supports at most 24 tiles' USING ERRCODE = '54000';
  END IF;

  SELECT event.event INTO table_event
  FROM control_plane.conversation_turn_events AS event
  JOIN control_plane.conversation_turns AS turn
    ON turn.tenant_id = event.tenant_id AND turn.turn_id = event.turn_id
  JOIN control_plane.conversations AS conversation
    ON conversation.tenant_id = turn.tenant_id
   AND conversation.conversation_id = turn.conversation_id
  WHERE event.tenant_id = selected_tenant
    AND event.conversation_id = p_conversation_id
    AND event.turn_id = p_turn_id
    AND event.event->>'id' = p_table_event_id
    AND event.event->>'type' = 'table'
    AND event.event->>'resultId' = p_result_id
    AND turn.created_by = actor
    AND conversation.created_by = actor;
  IF table_event IS NULL THEN
    RAISE EXCEPTION 'source table event was not found' USING ERRCODE = 'P0002';
  END IF;

  replay := table_event->'dashboardReplay';
  IF jsonb_typeof(replay) <> 'object'
     OR replay->>'kind' NOT IN ('cube_v3', 'semantic_v2', 'derived_v1') THEN
    RAISE EXCEPTION 'this table is not replayable' USING ERRCODE = '22023';
  END IF;

  IF replay->>'kind' IN ('cube_v3', 'semantic_v2') THEN
    resolved_source := control_plane.dashboard_direct_source_recipe(
      selected_tenant, p_turn_id, p_table_event_id, p_result_id
    );
    recipe := resolved_source->'recipe';
    row_count := CASE
      WHEN replay->>'kind' = 'cube_v3' THEN coalesce((
        SELECT (event.event->>'rowCount')::bigint
        FROM control_plane.conversation_turn_events AS event
        WHERE event.tenant_id = selected_tenant
          AND event.turn_id = p_turn_id
          AND event.event->>'id' = replay->>'queryEventId'
          AND event.event->>'type' = 'query'
      ), jsonb_array_length(coalesce(table_event->'rows', '[]'::jsonb)))
      ELSE jsonb_array_length(coalesce(table_event->'rows', '[]'::jsonb))
    END;
  ELSE
    derivation := table_event->'dashboardDerivation';
    IF coalesce(replay->>'transformDigest', '') !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(replay->'sourceTableEventIds') <> 'array'
       OR jsonb_typeof(derivation) <> 'object'
       OR derivation->>'version' <> 'derived_table_v1'
       OR jsonb_typeof(derivation->'sources') <> 'array'
       OR jsonb_array_length(derivation->'sources') NOT BETWEEN 1 AND 12
       OR jsonb_typeof(derivation->'columns') <> 'array'
       OR jsonb_array_length(derivation->'columns') NOT BETWEEN 1 AND 80
       OR jsonb_typeof(derivation->'rows') <> 'array'
       OR jsonb_array_length(derivation->'rows') > 50
       OR jsonb_array_length(replay->'sourceTableEventIds')
          <> jsonb_array_length(derivation->'sources')
       OR EXISTS (
         SELECT 1
         FROM jsonb_array_elements(derivation->'sources') WITH ORDINALITY AS source(value, ordinal)
         WHERE jsonb_typeof(source.value) <> 'object'
            OR coalesce(source.value->>'tableEventId', '') !~ '^[0-9A-HJKMNP-TV-Z]{26}$'
            OR length(coalesce(source.value->>'resultId', '')) NOT BETWEEN 1 AND 160
            OR replay->'sourceTableEventIds'->>((source.ordinal - 1)::integer)
               <> source.value->>'tableEventId'
       ) THEN
      RAISE EXCEPTION 'the derived table replay reference is invalid' USING ERRCODE = '22023';
    END IF;

    FOR source_ref IN
      SELECT value FROM jsonb_array_elements(derivation->'sources')
    LOOP
      resolved_source := control_plane.dashboard_direct_source_recipe(
        selected_tenant,
        p_turn_id,
        source_ref->>'tableEventId',
        source_ref->>'resultId'
      );
      resolved_sources := resolved_sources || jsonb_build_array(resolved_source);
    END LOOP;
    recipe := jsonb_build_object(
      'kind', 'derived_v1',
      'transform', derivation,
      'transformDigest', replay->>'transformDigest',
      'sources', resolved_sources
    );
    row_count := jsonb_array_length(derivation->'rows');
  END IF;

  resolved_title := left(coalesce(nullif(btrim(table_event->>'caption'), ''), 'Governed table'), 120);
  SELECT jsonb_build_object(
    'columns', coalesce(table_event->'columns', '[]'::jsonb),
    'rows', coalesce((SELECT jsonb_agg(value) FROM (
      SELECT value FROM jsonb_array_elements(coalesce(table_event->'rows', '[]'::jsonb)) WITH ORDINALITY AS row(value, ordinal)
      ORDER BY ordinal LIMIT 50
    ) AS bounded), '[]'::jsonb),
    'totalRowCount', row_count,
    'resultDigest', encode(extensions.digest(convert_to(
      coalesce(table_event->'rows', '[]'::jsonb)::text, 'UTF8'
    ), 'sha256'), 'hex'),
    'provenance', table_event->'provenance',
    'sourceWatermarks', coalesce(table_event->'provenance'->'sources', '[]'::jsonb),
    'queryTime', source_event.occurred_at,
    'refreshedAt', source_event.occurred_at,
    'empty', row_count = 0
  ) INTO initial_snapshot FROM (
    SELECT occurred_at FROM control_plane.conversation_turn_events
    WHERE tenant_id = selected_tenant AND turn_id = p_turn_id
      AND event->>'id' = p_table_event_id LIMIT 1
  ) AS source_event;

  INSERT INTO control_plane.dashboard_tiles (
    tenant_id, dashboard_id, tile_id, title,
    source_conversation_id, source_turn_id, source_table_event_id, source_result_id,
    replay_kind, replay_recipe, latest_snapshot, refresh_state, last_refreshed_at
  ) VALUES (
    selected_tenant, selected_dashboard, control_plane.generate_ulid(), resolved_title,
    p_conversation_id, p_turn_id, p_table_event_id, p_result_id,
    replay->>'kind', recipe, initial_snapshot, 'current',
    (initial_snapshot->>'refreshedAt')::timestamptz
  );
  UPDATE control_plane.personal_dashboards
  SET revision = revision + 1, updated_at = now()
  WHERE tenant_id = selected_tenant AND dashboard_id = selected_dashboard;
  RETURN control_plane.dashboard_document(selected_tenant, selected_dashboard);
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_dashboard_refresh_complete(
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
     OR p_adapter NOT IN ('cube_v3', 'semantic_v2', 'derived_v1')
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
    AND tile.replay_kind IN ('cube_v3', 'derived_v1')
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

REVOKE ALL ON FUNCTION control_plane.dashboard_direct_source_recipe(text, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
