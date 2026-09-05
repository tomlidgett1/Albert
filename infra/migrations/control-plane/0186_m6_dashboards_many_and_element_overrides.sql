-- 0186: dashboards, plural (ADR 0134 — the Sigma model).
--
-- 1. A member owns many dashboards. The 0117 one-per-member unique key goes;
--    every dashboard RPC gains a trailing `p_dashboard_id text DEFAULT NULL`
--    so an unnamed call keeps the legacy behaviour (the member's most
--    recently touched dashboard, created on first use) and a deployed web
--    tier that predates this migration keeps working unchanged. New RPCs:
--    list, create, delete, link the build conversation.
-- 2. Element-level query overrides: a tile carries owner-authored sort,
--    filters and a row limit (`query_overrides` jsonb, column keys of its
--    own snapshot). They never touch the governed replay recipe or its
--    digests; the refresh adapter applies them AFTER the digest check and
--    re-validates the effective query against the catalogue.
-- 3. The document exposes the tile's governed query YAML (already shown in
--    every trace) so an element edit can brief the architect with it, and
--    the dashboard remembers the conversation that last built it.
--
-- Access posture unchanged: SECURITY DEFINER RPCs re-derive tenant + actor,
-- the browser holds no table grants, and every dashboard row is checked
-- against owner_user_id = actor.

BEGIN;

-- 1. Many dashboards per member ---------------------------------------------

DO $$
DECLARE
  unique_name text;
BEGIN
  SELECT con.conname INTO unique_name
  FROM pg_constraint AS con
  WHERE con.conrelid = 'control_plane.personal_dashboards'::regclass
    AND con.contype = 'u'
    AND (
      SELECT array_agg(att.attname::text ORDER BY att.attname)
      FROM pg_attribute AS att
      WHERE att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
    ) = ARRAY['owner_user_id', 'tenant_id'];
  IF unique_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE control_plane.personal_dashboards DROP CONSTRAINT %I', unique_name);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS personal_dashboards_owner_recent_idx
  ON control_plane.personal_dashboards (tenant_id, owner_user_id, updated_at DESC);

ALTER TABLE control_plane.personal_dashboards
  ADD COLUMN IF NOT EXISTS last_build_conversation_id text;
ALTER TABLE control_plane.personal_dashboards
  DROP CONSTRAINT IF EXISTS personal_dashboards_build_conversation_ulid;
ALTER TABLE control_plane.personal_dashboards
  ADD CONSTRAINT personal_dashboards_build_conversation_ulid
  CHECK (last_build_conversation_id IS NULL OR control_plane.is_ulid(last_build_conversation_id));

-- 2. Element query overrides -------------------------------------------------

CREATE OR REPLACE FUNCTION control_plane.dashboard_query_overrides_valid(p_overrides jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  entry jsonb;
  item jsonb;
BEGIN
  IF p_overrides IS NULL OR jsonb_typeof(p_overrides) <> 'object'
     OR octet_length(p_overrides::text) > 16384
     OR (p_overrides - 'order' - 'filters' - 'limit') <> '{}'::jsonb THEN
    RETURN false;
  END IF;
  IF p_overrides ? 'limit' AND (
    jsonb_typeof(p_overrides -> 'limit') <> 'number'
    OR coalesce(p_overrides ->> 'limit', '') !~ '^[0-9]{1,3}$'
    OR (p_overrides ->> 'limit')::integer NOT BETWEEN 1 AND 500
  ) THEN
    RETURN false;
  END IF;
  IF p_overrides ? 'order' THEN
    IF jsonb_typeof(p_overrides -> 'order') <> 'array'
       OR jsonb_array_length(p_overrides -> 'order') > 3 THEN
      RETURN false;
    END IF;
    FOR entry IN SELECT element.value FROM jsonb_array_elements(p_overrides -> 'order') AS element LOOP
      IF jsonb_typeof(entry) <> 'object'
         OR (entry - 'column' - 'direction') <> '{}'::jsonb
         OR jsonb_typeof(entry -> 'column') <> 'string'
         OR length(entry ->> 'column') NOT BETWEEN 1 AND 160
         OR coalesce(entry ->> 'direction', '') NOT IN ('asc', 'desc') THEN
        RETURN false;
      END IF;
    END LOOP;
  END IF;
  IF p_overrides ? 'filters' THEN
    IF jsonb_typeof(p_overrides -> 'filters') <> 'array'
       OR jsonb_array_length(p_overrides -> 'filters') > 8 THEN
      RETURN false;
    END IF;
    FOR entry IN SELECT element.value FROM jsonb_array_elements(p_overrides -> 'filters') AS element LOOP
      IF jsonb_typeof(entry) <> 'object'
         OR (entry - 'column' - 'operator' - 'values') <> '{}'::jsonb
         OR jsonb_typeof(entry -> 'column') <> 'string'
         OR length(entry ->> 'column') NOT BETWEEN 1 AND 160
         OR coalesce(entry ->> 'operator', '') NOT IN (
           'equals', 'notEquals', 'contains', 'notContains',
           'gt', 'gte', 'lt', 'lte', 'set', 'notSet',
           'inDateRange', 'notInDateRange', 'beforeDate', 'afterDate'
         )
         OR jsonb_typeof(entry -> 'values') <> 'array'
         OR jsonb_array_length(entry -> 'values') > 50 THEN
        RETURN false;
      END IF;
      FOR item IN SELECT element.value FROM jsonb_array_elements(entry -> 'values') AS element LOOP
        IF jsonb_typeof(item) <> 'string' OR length(item #>> '{}') > 200 THEN
          RETURN false;
        END IF;
      END LOOP;
    END LOOP;
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.dashboard_query_overrides_valid(jsonb) FROM PUBLIC;

ALTER TABLE control_plane.dashboard_tiles
  ADD COLUMN IF NOT EXISTS query_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE control_plane.dashboard_tiles
  DROP CONSTRAINT IF EXISTS dashboard_tiles_query_overrides_valid;
ALTER TABLE control_plane.dashboard_tiles
  ADD CONSTRAINT dashboard_tiles_query_overrides_valid
  CHECK (control_plane.dashboard_query_overrides_valid(query_overrides));

-- 3. Document ----------------------------------------------------------------

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

-- 4. Ownership resolution ------------------------------------------------------

CREATE OR REPLACE FUNCTION control_plane.require_owned_dashboard(
  p_tenant_id text,
  p_actor uuid,
  p_dashboard_id text
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
  IF p_dashboard_id IS NOT NULL THEN
    IF NOT control_plane.is_ulid(p_dashboard_id) THEN
      RAISE EXCEPTION 'dashboard id is invalid' USING ERRCODE = '22023';
    END IF;
    SELECT dashboard_id INTO resolved_dashboard_id
    FROM control_plane.personal_dashboards
    WHERE tenant_id = p_tenant_id
      AND dashboard_id = p_dashboard_id
      AND owner_user_id = p_actor;
    IF resolved_dashboard_id IS NULL THEN
      RAISE EXCEPTION 'dashboard was not found' USING ERRCODE = 'P0002';
    END IF;
    RETURN resolved_dashboard_id;
  END IF;

  -- Unnamed: the member's most recently touched dashboard, created on first
  -- use (the 0117 behaviour every pre-0186 caller relies on).
  PERFORM pg_advisory_xact_lock(hashtext('dashboard:' || p_tenant_id || ':' || p_actor::text));
  SELECT dashboard_id INTO resolved_dashboard_id
  FROM control_plane.personal_dashboards
  WHERE tenant_id = p_tenant_id AND owner_user_id = p_actor
  ORDER BY updated_at DESC, dashboard_id DESC
  LIMIT 1;
  IF resolved_dashboard_id IS NULL THEN
    resolved_dashboard_id := control_plane.generate_ulid();
    INSERT INTO control_plane.personal_dashboards (tenant_id, dashboard_id, owner_user_id)
    VALUES (p_tenant_id, resolved_dashboard_id, p_actor);
  END IF;
  RETURN resolved_dashboard_id;
END;
$$;

-- The 0117 helper relied on the dropped unique key for its upsert; it now
-- delegates so every older function body that still calls it keeps working.
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
BEGIN
  RETURN control_plane.require_owned_dashboard(p_tenant_id, p_actor, NULL);
END;
$$;

REVOKE ALL ON FUNCTION control_plane.require_owned_dashboard(text, uuid, text) FROM PUBLIC;

-- 5. List / create / delete / link -------------------------------------------

CREATE OR REPLACE FUNCTION public.albert_dashboard_list()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  actor uuid := extensions.albert_auth_uid();
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authentication is required' USING ERRCODE = '42501';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'dashboardId', dashboard.dashboard_id,
      'title', dashboard.title,
      'revision', dashboard.revision,
      'tileCount', (
        SELECT count(*) FROM control_plane.dashboard_tiles AS tile
        WHERE tile.tenant_id = dashboard.tenant_id AND tile.dashboard_id = dashboard.dashboard_id
      ),
      'lastBuildConversationId', dashboard.last_build_conversation_id,
      'createdAt', dashboard.created_at,
      'updatedAt', dashboard.updated_at
    ) ORDER BY dashboard.updated_at DESC, dashboard.dashboard_id DESC)
    FROM control_plane.personal_dashboards AS dashboard
    WHERE dashboard.tenant_id = selected_tenant
      AND dashboard.owner_user_id = actor
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_dashboard_create(
  p_title text DEFAULT NULL
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
  cleaned_title text;
  created_dashboard_id text;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authentication is required' USING ERRCODE = '42501';
  END IF;
  cleaned_title := nullif(btrim(coalesce(p_title, '')), '');
  IF cleaned_title IS NOT NULL AND length(cleaned_title) > 80 THEN
    RAISE EXCEPTION 'dashboard title must be 80 characters or fewer' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM control_plane.personal_dashboards
      WHERE tenant_id = selected_tenant AND owner_user_id = actor) >= 40 THEN
    RAISE EXCEPTION 'a member supports at most 40 dashboards' USING ERRCODE = '54000';
  END IF;
  created_dashboard_id := control_plane.generate_ulid();
  INSERT INTO control_plane.personal_dashboards (tenant_id, dashboard_id, owner_user_id, title)
  VALUES (selected_tenant, created_dashboard_id, actor, cleaned_title);
  RETURN control_plane.dashboard_document(selected_tenant, created_dashboard_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_dashboard_delete(
  p_dashboard_id text
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
  DELETE FROM control_plane.personal_dashboards
  WHERE tenant_id = selected_tenant
    AND dashboard_id = selected_dashboard
    AND owner_user_id = actor;
  RETURN public.albert_dashboard_list();
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_dashboard_link_conversation(
  p_conversation_id text,
  p_expected_revision bigint,
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
  PERFORM control_plane.assert_dashboard_revision(
    selected_tenant, selected_dashboard, actor, p_expected_revision
  );
  IF NOT control_plane.is_ulid(p_conversation_id) OR NOT EXISTS (
    SELECT 1 FROM control_plane.conversations AS conversation
    WHERE conversation.tenant_id = selected_tenant
      AND conversation.conversation_id = p_conversation_id
      AND conversation.created_by = actor
  ) THEN
    RAISE EXCEPTION 'build conversation was not found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE control_plane.personal_dashboards
  SET last_build_conversation_id = p_conversation_id,
      revision = revision + 1,
      updated_at = clock_timestamp()
  WHERE tenant_id = selected_tenant AND dashboard_id = selected_dashboard;
  RETURN control_plane.dashboard_document(selected_tenant, selected_dashboard);
END;
$$;

-- 6. Existing RPCs, now dashboard-addressed ------------------------------------

DROP FUNCTION IF EXISTS public.albert_dashboard_get();

CREATE FUNCTION public.albert_dashboard_get(
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
  RETURN control_plane.dashboard_document(selected_tenant, selected_dashboard);
END;
$$;

DROP FUNCTION IF EXISTS public.albert_dashboard_pin(text, text, text, text, bigint);

CREATE FUNCTION public.albert_dashboard_pin(
  p_conversation_id text,
  p_turn_id text,
  p_table_event_id text,
  p_result_id text,
  p_expected_revision bigint,
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
  selected_dashboard := control_plane.require_owned_dashboard(selected_tenant, actor, p_dashboard_id);
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
  SET revision = revision + 1, updated_at = clock_timestamp()
  WHERE tenant_id = selected_tenant AND dashboard_id = selected_dashboard;
  RETURN control_plane.dashboard_document(selected_tenant, selected_dashboard);
END;
$$;

DROP FUNCTION IF EXISTS public.albert_dashboard_layout_update(jsonb, bigint);

CREATE FUNCTION public.albert_dashboard_layout_update(
  p_layouts jsonb,
  p_expected_revision bigint,
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
  persisted_tile_count integer;
BEGIN
  selected_dashboard := control_plane.require_owned_dashboard(selected_tenant, actor, p_dashboard_id);
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
  SET layouts = p_layouts, revision = revision + 1, updated_at = clock_timestamp()
  WHERE tenant_id = selected_tenant AND dashboard_id = selected_dashboard;
  RETURN control_plane.dashboard_document(selected_tenant, selected_dashboard);
END;
$$;

DROP FUNCTION IF EXISTS public.albert_dashboard_rename(text, bigint);

CREATE FUNCTION public.albert_dashboard_rename(
  p_title text,
  p_expected_revision bigint,
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
  cleaned_title text;
BEGIN
  selected_dashboard := control_plane.require_owned_dashboard(selected_tenant, actor, p_dashboard_id);
  PERFORM control_plane.assert_dashboard_revision(
    selected_tenant, selected_dashboard, actor, p_expected_revision
  );
  cleaned_title := nullif(btrim(coalesce(p_title, '')), '');
  IF cleaned_title IS NOT NULL AND length(cleaned_title) > 80 THEN
    RAISE EXCEPTION 'dashboard title must be 80 characters or fewer' USING ERRCODE = '22023';
  END IF;
  UPDATE control_plane.personal_dashboards
  SET title = cleaned_title,
      revision = revision + 1,
      updated_at = clock_timestamp()
  WHERE tenant_id = selected_tenant AND dashboard_id = selected_dashboard;
  RETURN control_plane.dashboard_document(selected_tenant, selected_dashboard);
END;
$$;

DROP FUNCTION IF EXISTS public.albert_dashboard_tile_update(text, bigint, text, jsonb, jsonb);

CREATE FUNCTION public.albert_dashboard_tile_update(
  p_tile_id text,
  p_expected_revision bigint,
  p_title text DEFAULT NULL,
  p_column_presentation jsonb DEFAULT NULL,
  p_display jsonb DEFAULT NULL,
  p_query_overrides jsonb DEFAULT NULL,
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
  tile_snapshot jsonb;
  tile_replay_kind text;
  tile_overrides jsonb;
  overrides_changed boolean := false;
BEGIN
  selected_dashboard := control_plane.require_owned_dashboard(selected_tenant, actor, p_dashboard_id);
  PERFORM control_plane.assert_dashboard_revision(
    selected_tenant, selected_dashboard, actor, p_expected_revision
  );
  IF p_title IS NULL AND p_column_presentation IS NULL AND p_display IS NULL
     AND p_query_overrides IS NULL THEN
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
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(coalesce(tile_snapshot->'columns', '[]'::jsonb)) AS column_value(value)
      WHERE column_value.value->>'key' = configured.column_key
    )
  ) THEN
    RAISE EXCEPTION 'dashboard presentation references an unknown column' USING ERRCODE = '22023';
  END IF;

  IF p_query_overrides IS NOT NULL THEN
    overrides_changed := p_query_overrides <> tile_overrides;
    -- Sorting and filters re-run the tile's governed query; a composed pivot
    -- or a legacy semantic replay has no single query to re-run.
    IF p_query_overrides <> '{}'::jsonb AND tile_replay_kind <> 'cube_v3' THEN
      RAISE EXCEPTION 'sorting and filters need a governed query behind the element' USING ERRCODE = '22023';
    END IF;
    -- Every referenced column is one of the element's own columns. Snapshot
    -- keys carry raw member names (sales.gross) or underscore spellings
    -- (sales_gross) depending on how the snapshot was produced; accept both.
    IF EXISTS (
      SELECT 1
      FROM (
        SELECT element.value->>'column' AS column_key
        FROM jsonb_array_elements(coalesce(p_query_overrides->'order', '[]'::jsonb)) AS element
        UNION ALL
        SELECT element.value->>'column'
        FROM jsonb_array_elements(coalesce(p_query_overrides->'filters', '[]'::jsonb)) AS element
      ) AS referenced
      WHERE NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(coalesce(tile_snapshot->'columns', '[]'::jsonb)) AS column_value(value)
        WHERE column_value.value->>'key' = referenced.column_key
           OR replace(column_value.value->>'key', '.', '_') = replace(referenced.column_key, '.', '_')
      )
    ) THEN
      RAISE EXCEPTION 'dashboard query overrides reference an unknown column' USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE control_plane.dashboard_tiles
  SET title = CASE WHEN p_title IS NULL THEN title ELSE btrim(p_title) END,
      column_presentation = coalesce(p_column_presentation, column_presentation),
      display = coalesce(p_display, display),
      query_overrides = coalesce(p_query_overrides, query_overrides),
      -- Changed overrides make the snapshot describe a different result set;
      -- it stays visible but is flagged until the next refresh replaces it.
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

DROP FUNCTION IF EXISTS public.albert_dashboard_tile_delete(text, bigint);

CREATE FUNCTION public.albert_dashboard_tile_delete(
  p_tile_id text,
  p_expected_revision bigint,
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
      updated_at = clock_timestamp()
  WHERE tenant_id = selected_tenant AND dashboard_id = selected_dashboard;
  RETURN control_plane.dashboard_document(selected_tenant, selected_dashboard);
END;
$$;

DROP FUNCTION IF EXISTS public.albert_dashboard_refresh_claim(text[], boolean);

CREATE FUNCTION public.albert_dashboard_refresh_claim(
  p_tile_ids text[] DEFAULT NULL,
  p_force boolean DEFAULT false,
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
  claimed jsonb;
BEGIN
  selected_dashboard := control_plane.require_owned_dashboard(selected_tenant, actor, p_dashboard_id);
  WITH eligible AS (
    SELECT tile.tile_id
    FROM control_plane.dashboard_tiles AS tile
    WHERE tile.tenant_id = selected_tenant AND tile.dashboard_id = selected_dashboard
      AND (p_tile_ids IS NULL OR tile.tile_id = ANY(p_tile_ids))
      AND (
        p_force
        OR tile.refresh_state = 'stale'
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
    'queryOverrides', updated.query_overrides,
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

-- Completion is addressed by the tile's own lease, so the dashboard is
-- resolved from the tile rather than from "the" member dashboard.
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
  selected_dashboard text;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authentication is required' USING ERRCODE = '42501';
  END IF;
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

  SELECT tile.dashboard_id INTO selected_dashboard
  FROM control_plane.dashboard_tiles AS tile
  JOIN control_plane.personal_dashboards AS dashboard
    ON dashboard.tenant_id = tile.tenant_id AND dashboard.dashboard_id = tile.dashboard_id
  WHERE tile.tenant_id = selected_tenant
    AND tile.tile_id = p_tile_id
    AND dashboard.owner_user_id = actor;
  IF selected_dashboard IS NULL THEN
    RAISE EXCEPTION 'dashboard tile was not found' USING ERRCODE = 'P0002';
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

-- 7. Grants ------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.albert_dashboard_list() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_dashboard_create(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_dashboard_delete(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_dashboard_link_conversation(text, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_dashboard_get(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_dashboard_pin(text, text, text, text, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_dashboard_layout_update(jsonb, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_dashboard_rename(text, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_dashboard_tile_update(text, bigint, text, jsonb, jsonb, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_dashboard_tile_delete(text, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_dashboard_refresh_claim(text[], boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_dashboard_refresh_complete(
  text, timestamptz, text, text, timestamptz, integer, jsonb, text, bigint,
  jsonb, text, text, text, jsonb
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.albert_dashboard_list() TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_create(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_delete(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_link_conversation(text, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_get(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_pin(text, text, text, text, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_layout_update(jsonb, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_rename(text, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_tile_update(text, bigint, text, jsonb, jsonb, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_tile_delete(text, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_refresh_claim(text[], boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_refresh_complete(
  text, timestamptz, text, text, timestamptz, integer, jsonb, text, bigint,
  jsonb, text, text, text, jsonb
) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
