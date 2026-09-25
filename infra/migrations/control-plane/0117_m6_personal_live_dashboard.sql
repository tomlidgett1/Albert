-- ADR 0083: one private, conversation-derived live dashboard per tenant/user.
-- The browser never receives direct table grants and pin RPCs resolve replay
-- recipes only from immutable conversation events owned by the current actor.

BEGIN;

CREATE TABLE control_plane.personal_dashboards (
  tenant_id text NOT NULL,
  dashboard_id text NOT NULL CHECK (control_plane.is_ulid(dashboard_id)),
  owner_user_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  layouts jsonb NOT NULL DEFAULT '{"desktop":[],"tablet":[]}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, dashboard_id),
  UNIQUE (tenant_id, owner_user_id),
  FOREIGN KEY (tenant_id) REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, owner_user_id)
    REFERENCES control_plane.memberships(tenant_id, user_id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(layouts) = 'object')
);

CREATE TABLE control_plane.dashboard_tiles (
  tenant_id text NOT NULL,
  dashboard_id text NOT NULL,
  tile_id text NOT NULL CHECK (control_plane.is_ulid(tile_id)),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  source_conversation_id text NOT NULL,
  source_turn_id text NOT NULL,
  source_table_event_id text NOT NULL CHECK (control_plane.is_ulid(source_table_event_id)),
  source_result_id text NOT NULL CHECK (length(btrim(source_result_id)) BETWEEN 1 AND 160),
  replay_kind text NOT NULL CHECK (replay_kind IN ('cube_v3', 'semantic_v2')),
  replay_recipe jsonb NOT NULL CHECK (jsonb_typeof(replay_recipe) = 'object'),
  latest_snapshot jsonb CHECK (latest_snapshot IS NULL OR jsonb_typeof(latest_snapshot) = 'object'),
  refresh_state text NOT NULL DEFAULT 'current'
    CHECK (refresh_state IN ('current', 'refreshing', 'stale', 'error')),
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{3,80}$'),
  last_refresh_attempt_at timestamptz,
  last_refreshed_at timestamptz,
  refresh_claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, dashboard_id, tile_id),
  UNIQUE (tenant_id, dashboard_id, source_table_event_id),
  FOREIGN KEY (tenant_id, dashboard_id)
    REFERENCES control_plane.personal_dashboards(tenant_id, dashboard_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, source_conversation_id)
    REFERENCES control_plane.conversations(tenant_id, conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, source_turn_id)
    REFERENCES control_plane.conversation_turns(tenant_id, turn_id) ON DELETE CASCADE
);

CREATE TABLE control_plane.dashboard_refresh_events (
  tenant_id text NOT NULL,
  dashboard_id text NOT NULL,
  refresh_event_id text NOT NULL CHECK (control_plane.is_ulid(refresh_event_id)),
  tile_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('success', 'empty', 'failure', 'incompatible')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  latency_ms integer NOT NULL CHECK (latency_ms >= 0 AND latency_ms <= 600000),
  result_digest text CHECK (result_digest IS NULL OR result_digest ~ '^[0-9a-f]{64}$'),
  row_count bigint CHECK (row_count IS NULL OR row_count >= 0),
  source_watermarks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_watermarks) = 'array'),
  adapter text NOT NULL CHECK (adapter IN ('cube_v3', 'semantic_v2')),
  dedupe_status text NOT NULL CHECK (dedupe_status IN ('executed', 'cache_hit')),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{3,80}$'),
  adapter_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(adapter_metadata) = 'object'),
  PRIMARY KEY (tenant_id, dashboard_id, refresh_event_id),
  FOREIGN KEY (tenant_id, dashboard_id, tile_id)
    REFERENCES control_plane.dashboard_tiles(tenant_id, dashboard_id, tile_id) ON DELETE CASCADE,
  CHECK (completed_at >= started_at),
  CHECK (
    (outcome IN ('success', 'empty') AND result_digest IS NOT NULL AND row_count IS NOT NULL AND error_code IS NULL)
    OR (outcome IN ('failure', 'incompatible') AND error_code IS NOT NULL)
  )
);

CREATE INDEX dashboard_tiles_owner_refresh_idx
  ON control_plane.dashboard_tiles (tenant_id, dashboard_id, last_refresh_attempt_at);
CREATE INDEX dashboard_refresh_events_tile_idx
  ON control_plane.dashboard_refresh_events
  (tenant_id, dashboard_id, tile_id, completed_at DESC);

ALTER TABLE control_plane.personal_dashboards ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.personal_dashboards FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.dashboard_tiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.dashboard_tiles FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.dashboard_refresh_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.dashboard_refresh_events FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  control_plane.personal_dashboards,
  control_plane.dashboard_tiles,
  control_plane.dashboard_refresh_events
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION control_plane.dashboard_layouts_valid(p_layouts jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_typeof(p_layouts) = 'object'
    AND (p_layouts - 'desktop' - 'tablet') = '{}'::jsonb
    AND jsonb_typeof(p_layouts->'desktop') = 'array'
    AND jsonb_typeof(p_layouts->'tablet') = 'array'
    AND jsonb_array_length(p_layouts->'desktop') <= 24
    AND jsonb_array_length(p_layouts->'tablet') <= 24
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements((p_layouts->'desktop') || (p_layouts->'tablet')) AS item(value)
      WHERE jsonb_typeof(item.value) <> 'object'
         OR (item.value - 'i' - 'x' - 'y' - 'w' - 'h') <> '{}'::jsonb
         OR coalesce(item.value->>'i', '') !~ '^[0-9A-HJKMNP-TV-Z]{26}$'
         OR coalesce(item.value->>'x', '') !~ '^[0-9]+$'
         OR coalesce(item.value->>'y', '') !~ '^[0-9]+$'
         OR coalesce(item.value->>'w', '') !~ '^[0-9]+$'
         OR coalesce(item.value->>'h', '') !~ '^[0-9]+$'
         OR (item.value->>'x')::integer NOT BETWEEN 0 AND 11
         OR (item.value->>'y')::integer NOT BETWEEN 0 AND 10000
         OR (item.value->>'w')::integer NOT BETWEEN 3 AND 12
         OR (item.value->>'h')::integer NOT BETWEEN 5 AND 16
    );
$$;

ALTER TABLE control_plane.personal_dashboards
  ADD CONSTRAINT personal_dashboards_layouts_valid
  CHECK (control_plane.dashboard_layouts_valid(layouts));

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

CREATE OR REPLACE FUNCTION control_plane.require_personal_dashboard(
  p_tenant_id text,
  p_actor uuid
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  resolved_dashboard_id text;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'authentication is required' USING ERRCODE = '42501';
  END IF;
  INSERT INTO control_plane.personal_dashboards (
    tenant_id, dashboard_id, owner_user_id
  ) VALUES (
    p_tenant_id, control_plane.generate_ulid(), p_actor
  ) ON CONFLICT (tenant_id, owner_user_id) DO NOTHING;

  SELECT dashboard_id INTO resolved_dashboard_id
  FROM control_plane.personal_dashboards
  WHERE tenant_id = p_tenant_id AND owner_user_id = p_actor;
  RETURN resolved_dashboard_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_dashboard_get()
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
  selected_dashboard := control_plane.require_personal_dashboard(selected_tenant, actor);
  RETURN control_plane.dashboard_document(selected_tenant, selected_dashboard);
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.assert_dashboard_revision(
  p_tenant_id text,
  p_dashboard_id text,
  p_actor uuid,
  p_expected_revision bigint
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actual_revision bigint;
BEGIN
  SELECT revision INTO actual_revision
  FROM control_plane.personal_dashboards
  WHERE tenant_id = p_tenant_id
    AND dashboard_id = p_dashboard_id
    AND owner_user_id = p_actor
  FOR UPDATE;
  IF actual_revision IS NULL THEN
    RAISE EXCEPTION 'dashboard was not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_expected_revision IS NULL OR actual_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'dashboard revision conflict' USING ERRCODE = '40001';
  END IF;
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
  query_event jsonb;
  replay jsonb;
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
     OR replay->>'kind' NOT IN ('cube_v3', 'semantic_v2') THEN
    RAISE EXCEPTION 'this table is not replayable' USING ERRCODE = '22023';
  END IF;

  IF replay->>'kind' = 'cube_v3' THEN
    SELECT event.event INTO query_event
    FROM control_plane.conversation_turn_events AS event
    WHERE event.tenant_id = selected_tenant
      AND event.turn_id = p_turn_id
      AND event.event->>'id' = replay->>'queryEventId'
      AND event.event->>'type' = 'query';
    IF query_event IS NULL OR coalesce(query_event->>'queryYaml', '') = ''
       OR coalesce(replay->>'queryDigest', '') !~ '^[0-9a-f]{64}$'
       OR coalesce(replay->>'semanticVersionDigest', '') !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'the Cube replay reference is invalid' USING ERRCODE = '22023';
    END IF;
    recipe := jsonb_build_object(
      'kind', 'cube_v3',
      'queryYaml', query_event->>'queryYaml',
      'queryDigest', replay->>'queryDigest',
      'semanticVersionDigest', replay->>'semanticVersionDigest',
      'view', query_event->>'view',
      'connector', query_event->>'connector'
    );
    row_count := coalesce((query_event->>'rowCount')::bigint, jsonb_array_length(table_event->'rows'));
  ELSE
    IF coalesce(replay->>'executionId', '') = ''
       OR coalesce(replay->>'resultId', '') = ''
       OR coalesce(replay->>'publicationHash', '') !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'the Semantic V2 replay reference is invalid' USING ERRCODE = '22023';
    END IF;
    recipe := replay;
    row_count := jsonb_array_length(table_event->'rows');
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

CREATE OR REPLACE FUNCTION public.albert_dashboard_layout_update(
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
  selected_dashboard text := control_plane.require_personal_dashboard(selected_tenant, actor);
  persisted_tile_count integer;
BEGIN
  PERFORM control_plane.assert_dashboard_revision(selected_tenant, selected_dashboard, actor, p_expected_revision);
  IF NOT control_plane.dashboard_layouts_valid(p_layouts) THEN
    RAISE EXCEPTION 'dashboard layout is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO persisted_tile_count FROM control_plane.dashboard_tiles
  WHERE tenant_id = selected_tenant AND dashboard_id = selected_dashboard;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements((p_layouts->'desktop') || (p_layouts->'tablet')) AS item(value)
    WHERE NOT EXISTS (
      SELECT 1 FROM control_plane.dashboard_tiles AS tile
      WHERE tile.tenant_id = selected_tenant AND tile.dashboard_id = selected_dashboard
        AND tile.tile_id = item.value->>'i'
    )
  ) OR (SELECT count(DISTINCT item.value->>'i')
        FROM jsonb_array_elements(p_layouts->'desktop') AS item(value)) <> persisted_tile_count
     OR (SELECT count(DISTINCT item.value->>'i')
        FROM jsonb_array_elements(p_layouts->'tablet') AS item(value)) <> persisted_tile_count THEN
    RAISE EXCEPTION 'dashboard layout must contain every tile exactly once per breakpoint' USING ERRCODE = '22023';
  END IF;
  UPDATE control_plane.personal_dashboards
  SET layouts = p_layouts, revision = revision + 1, updated_at = now()
  WHERE tenant_id = selected_tenant AND dashboard_id = selected_dashboard;
  RETURN control_plane.dashboard_document(selected_tenant, selected_dashboard);
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_dashboard_tile_update(
  p_tile_id text,
  p_title text,
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
  selected_dashboard text := control_plane.require_personal_dashboard(selected_tenant, actor);
BEGIN
  PERFORM control_plane.assert_dashboard_revision(selected_tenant, selected_dashboard, actor, p_expected_revision);
  IF length(btrim(coalesce(p_title, ''))) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'tile title must be between 1 and 120 characters' USING ERRCODE = '22023';
  END IF;
  UPDATE control_plane.dashboard_tiles SET title = btrim(p_title), updated_at = now()
  WHERE tenant_id = selected_tenant AND dashboard_id = selected_dashboard AND tile_id = p_tile_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'dashboard tile was not found' USING ERRCODE = 'P0002'; END IF;
  UPDATE control_plane.personal_dashboards SET revision = revision + 1, updated_at = now()
  WHERE tenant_id = selected_tenant AND dashboard_id = selected_dashboard;
  RETURN control_plane.dashboard_document(selected_tenant, selected_dashboard);
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_dashboard_tile_delete(
  p_tile_id text,
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
  selected_dashboard text := control_plane.require_personal_dashboard(selected_tenant, actor);
BEGIN
  PERFORM control_plane.assert_dashboard_revision(selected_tenant, selected_dashboard, actor, p_expected_revision);
  DELETE FROM control_plane.dashboard_tiles
  WHERE tenant_id = selected_tenant AND dashboard_id = selected_dashboard AND tile_id = p_tile_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'dashboard tile was not found' USING ERRCODE = 'P0002'; END IF;
  UPDATE control_plane.personal_dashboards
  SET layouts = jsonb_build_object(
        'desktop', coalesce((SELECT jsonb_agg(item.value) FROM jsonb_array_elements(layouts->'desktop') AS item(value) WHERE item.value->>'i' <> p_tile_id), '[]'::jsonb),
        'tablet', coalesce((SELECT jsonb_agg(item.value) FROM jsonb_array_elements(layouts->'tablet') AS item(value) WHERE item.value->>'i' <> p_tile_id), '[]'::jsonb)
      ),
      revision = revision + 1,
      updated_at = now()
  WHERE tenant_id = selected_tenant AND dashboard_id = selected_dashboard;
  RETURN control_plane.dashboard_document(selected_tenant, selected_dashboard);
END;
$$;

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
      AND (tile.refresh_state <> 'refreshing' OR tile.refresh_claimed_at < now() - interval '2 minutes')
    ORDER BY tile.created_at
    LIMIT 24
    FOR UPDATE SKIP LOCKED
  ), updated AS (
    UPDATE control_plane.dashboard_tiles AS tile
    SET refresh_state = 'refreshing', refresh_claimed_at = now(),
        last_refresh_attempt_at = now(), last_error_code = NULL, updated_at = now()
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
    'claimedAt', updated.refresh_claimed_at
  ) ORDER BY updated.created_at), '[]'::jsonb) INTO claimed FROM updated;
  RETURN claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_dashboard_refresh_complete(
  p_tile_id text,
  p_claimed_at timestamptz,
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
  IF p_outcome NOT IN ('success', 'empty', 'failure', 'incompatible')
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
      last_refreshed_at = CASE WHEN p_outcome IN ('success', 'empty') THEN now() ELSE last_refreshed_at END,
      last_error_code = CASE WHEN p_outcome IN ('failure', 'incompatible') THEN p_error_code ELSE NULL END,
      refresh_claimed_at = NULL,
      updated_at = now()
  WHERE tenant_id = selected_tenant AND dashboard_id = selected_dashboard
    AND tile_id = p_tile_id AND refresh_claimed_at = p_claimed_at;
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

CREATE OR REPLACE FUNCTION control_plane.prevent_dashboard_refresh_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'dashboard refresh evidence is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER dashboard_refresh_events_no_update
BEFORE UPDATE ON control_plane.dashboard_refresh_events
FOR EACH ROW EXECUTE FUNCTION control_plane.prevent_dashboard_refresh_event_mutation();

INSERT INTO control_plane.rate_limit_policies (action, request_limit, window_seconds, audit_excess)
VALUES
  ('dashboard.mutation', 60, 60, false),
  ('dashboard.refresh', 12, 60, false)
ON CONFLICT (action) DO UPDATE SET
  request_limit = EXCLUDED.request_limit,
  window_seconds = EXCLUDED.window_seconds,
  audit_excess = EXCLUDED.audit_excess;

REVOKE ALL ON FUNCTION control_plane.dashboard_layouts_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.dashboard_document(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.require_personal_dashboard(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.assert_dashboard_revision(text, text, uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.prevent_dashboard_refresh_event_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.albert_dashboard_get() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_dashboard_pin(text, text, text, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_dashboard_layout_update(jsonb, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_dashboard_tile_update(text, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_dashboard_tile_delete(text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_dashboard_refresh_claim(text[], boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_dashboard_refresh_complete(
  text, timestamptz, text, timestamptz, integer, jsonb, text, bigint,
  jsonb, text, text, text, jsonb
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.albert_dashboard_get() TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_pin(text, text, text, text, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_layout_update(jsonb, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_tile_update(text, text, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_tile_delete(text, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_refresh_claim(text[], boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_refresh_complete(
  text, timestamptz, text, timestamptz, integer, jsonb, text, bigint,
  jsonb, text, text, text, jsonb
) TO authenticated;

COMMIT;
