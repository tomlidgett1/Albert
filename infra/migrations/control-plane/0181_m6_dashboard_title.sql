-- 0181: the personal dashboard gets a name. The natural-language builder
-- (ADR 0129) already composes a dashboardTitle but the apply path dropped it;
-- owners also rename the dashboard directly from dashboard mode. The title
-- lives on control_plane.personal_dashboards, travels in dashboard_document,
-- and changes through a revision-checked RPC in the 0117 layout-update shape.
--
-- Access posture unchanged: SECURITY DEFINER RPCs, member reads via
-- albert_dashboard_get, mutations for the dashboard owner under the existing
-- dashboard.mutation rate action.

BEGIN;

ALTER TABLE control_plane.personal_dashboards
  ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE control_plane.personal_dashboards
  DROP CONSTRAINT IF EXISTS personal_dashboards_title_length;
ALTER TABLE control_plane.personal_dashboards
  ADD CONSTRAINT personal_dashboards_title_length
  CHECK (title IS NULL OR length(btrim(title)) BETWEEN 1 AND 80);

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

CREATE OR REPLACE FUNCTION public.albert_dashboard_rename(
  p_title text,
  p_expected_revision bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text;
  actor uuid;
  selected_dashboard text;
  cleaned_title text;
BEGIN
  selected_tenant := control_plane.require_current_tenant_id();
  actor := extensions.albert_auth_uid();
  selected_dashboard := control_plane.require_personal_dashboard(selected_tenant, actor);
  PERFORM control_plane.assert_dashboard_revision(
    selected_tenant, selected_dashboard, actor, p_expected_revision
  );

  cleaned_title := nullif(btrim(coalesce(p_title, '')), '');
  IF cleaned_title IS NOT NULL AND length(cleaned_title) > 80 THEN
    RAISE EXCEPTION 'dashboard title must be 80 characters or fewer'
      USING ERRCODE = '22023';
  END IF;

  UPDATE control_plane.personal_dashboards
  SET title = cleaned_title,
      revision = revision + 1,
      updated_at = now()
  WHERE tenant_id = selected_tenant
    AND dashboard_id = selected_dashboard;

  RETURN control_plane.dashboard_document(selected_tenant, selected_dashboard);
END;
$$;

REVOKE ALL ON FUNCTION public.albert_dashboard_rename(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_dashboard_rename(text, bigint) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
