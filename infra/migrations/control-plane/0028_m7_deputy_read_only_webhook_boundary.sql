BEGIN;

-- Deputy webhooks are an optional, manually installed accelerator. The
-- connection's correctness and readiness are driven by scheduled polling and
-- reconciliation, so missing webhook installation must never degrade OAuth.
INSERT INTO control_plane.deputy_webhook_setup_status_lookup(status)
VALUES ('installation_required')
ON CONFLICT (status) DO NOTHING;

ALTER TABLE control_plane.deputy_webhook_material
  ALTER COLUMN setup_status SET DEFAULT 'installation_required';

UPDATE control_plane.deputy_webhook_material
SET setup_status = 'installation_required',
    last_error_code = 'deputy_webhook_operator_installation_required',
    last_attempted_at = NULL
WHERE retired_at IS NULL
  AND setup_status IN (
    'pending', 'provisioning', 'blocked_permission',
    'blocked_vendor_approval', 'retry_wait'
  );

UPDATE control_plane.connections
SET status = CASE
      WHEN status = 'degraded' AND auth_health IN ('healthy', 'expiring')
        THEN 'connected'
      ELSE status
    END,
    account_metadata = coalesce(account_metadata, '{}'::jsonb)
      || jsonb_build_object(
        'webhook_setup',
        jsonb_build_object(
          'status', 'operator_installation_required',
          'reason_code', 'deputy_webhook_operator_installation_required',
          'optional', true,
          'completeness_mode', 'scheduled_polling_and_reconciliation',
          'updated_at', now()
        )
      )
WHERE connector_key = 'deputy'
  AND coalesce(account_metadata -> 'webhook_setup' ->> 'status', '') IN (
    '', 'pending', 'provisioning', 'blocked_permission',
    'blocked_vendor_approval', 'retry_wait'
  );

COMMENT ON TABLE control_plane.deputy_webhook_material IS
  'Optional connection-bound Deputy ingress verifier. Material is prepared only for an explicit owner/operator installation workflow; OAuth and sync never write webhook resources to Deputy.';
COMMENT ON COLUMN control_plane.deputy_webhook_material.vendor_webhook_ids IS
  'Optional non-secret identifiers recorded only when an owner/operator supplies evidence from a manual Deputy webhook installation.';

-- The workspace exposes only non-secret account metadata, including the
-- truthful optional-installation state. Verification material remains private.
CREATE OR REPLACE FUNCTION public.albert_connections_workspace()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'tenant_id', tenant.tenant_id,
    'tenant_name', tenant.display_name,
    'connections', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'connection_id', connection.connection_id,
        'connector_key', connection.connector_key,
        'display_name', connection.display_name,
        'status', connection.status,
        'auth_health', connection.auth_health,
        'account_metadata', connection.account_metadata,
        'authorised_at', connection.authorised_at,
        'last_checked_at', connection.last_checked_at,
        'readiness', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'domain', readiness.domain,
            'state', readiness.state,
            'progress', readiness.progress,
            'data_ready_through', readiness.data_ready_through,
            'backfill_complete', readiness.backfill_complete,
            'reason_code', readiness.reason_code
          ) ORDER BY readiness.domain)
          FROM control_plane.readiness AS readiness
          WHERE readiness.tenant_id = selected_tenant
            AND readiness.connection_id = connection.connection_id
        ), '[]'::jsonb)
      ) ORDER BY connection.created_at)
      FROM control_plane.connections AS connection
      WHERE connection.tenant_id = selected_tenant
    ), '[]'::jsonb),
    'dossier', (
      SELECT jsonb_build_object(
        'version', dossier.version,
        'content', dossier.content,
        'provenance', dossier.provenance,
        'published_at', dossier.published_at
      )
      FROM control_plane.dossiers AS dossier
      WHERE dossier.tenant_id = selected_tenant
        AND dossier.status = 'published'
      LIMIT 1
    ),
    'identity_review_tasks', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'task_id', task.identity_review_task_id,
        'entity_type', task.entity_type,
        'status', task.status,
        'confidence_band', task.confidence_band,
        'candidate_links', task.candidate_links,
        'evidence', task.evidence,
        'resolution', task.resolution
      ) ORDER BY task.created_at)
      FROM control_plane.identity_review_tasks AS task
      WHERE task.tenant_id = selected_tenant
    ), '[]'::jsonb),
    'blocking_answers', coalesce((
      SELECT overlay.overlay -> 'blocking_answers'
      FROM control_plane.tenant_overlays AS overlay
      WHERE overlay.tenant_id = selected_tenant
        AND overlay.status = 'published'
      LIMIT 1
    ), '{}'::jsonb),
    'oauth_sessions', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'oauth_session_id', session.oauth_session_id,
        'provider', session.provider,
        'status', session.status,
        'discovered_account_choices', session.discovered_account_choices,
        'expires_at', session.expires_at
      ) ORDER BY session.created_at DESC)
      FROM control_plane.oauth_sessions AS session
      WHERE session.tenant_id = selected_tenant
        AND session.initiated_by = auth.uid()
        AND session.status IN ('pending', 'selecting_account', 'exchanging')
        AND session.expires_at > now()
    ), '[]'::jsonb)
  ) INTO result
  FROM control_plane.tenants AS tenant
  WHERE tenant.tenant_id = selected_tenant;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.albert_connections_workspace() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_connections_workspace() TO authenticated;

COMMIT;
