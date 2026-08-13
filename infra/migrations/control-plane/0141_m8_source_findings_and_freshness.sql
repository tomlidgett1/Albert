-- 0141: durable tenant source-of-truth ledger + connector freshness RPC.
--
-- The 75-question Luna Max battery showed the agent re-deriving (and often
-- fumbling) the same source-topology facts every turn: which POS holds the
-- category tree, that Square timecards disagree with Deputy, that Square
-- payments are the card-tender subset of Lightspeed sales. tenant_source_findings
-- persists verified reconciliations per concept so every future turn starts
-- from them. albert_connector_freshness serves per-connector sync watermarks
-- from readiness, falling back to stream_cursors when readiness is unpopulated
-- (as it is for the dogfood tenant today).

BEGIN;

CREATE TABLE IF NOT EXISTS control_plane.tenant_source_findings (
  tenant_id text NOT NULL,
  finding_id text NOT NULL DEFAULT control_plane.generate_ulid(),
  concept text NOT NULL,
  finding text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  PRIMARY KEY (tenant_id, finding_id)
);
CREATE INDEX IF NOT EXISTS tenant_source_findings_active
  ON control_plane.tenant_source_findings (tenant_id, concept)
  WHERE superseded_at IS NULL;
ALTER TABLE control_plane.tenant_source_findings ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.albert_list_source_findings()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'concept', finding.concept,
    'finding', finding.finding,
    'recordedAt', finding.created_at
  ) ORDER BY finding.created_at DESC), '[]'::jsonb)
  FROM (
    SELECT concept, finding, created_at
    FROM control_plane.tenant_source_findings
    WHERE tenant_id = control_plane.require_current_tenant_id()
      AND superseded_at IS NULL
    ORDER BY created_at DESC
    LIMIT 24
  ) AS finding;
$$;

CREATE OR REPLACE FUNCTION public.albert_record_source_finding(
  p_concept text,
  p_finding text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := extensions.albert_auth_uid();
  selected_tenant text := control_plane.require_current_tenant_id();
  active_count integer;
BEGIN
  IF p_concept !~ '^[a-z0-9][a-z0-9 _-]{1,59}$' THEN
    RAISE EXCEPTION 'finding concept is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_finding IS NULL OR length(btrim(p_finding)) < 10 OR length(p_finding) > 500 THEN
    RAISE EXCEPTION 'finding text must be 10-500 characters' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO active_count
  FROM control_plane.tenant_source_findings
  WHERE tenant_id = selected_tenant AND superseded_at IS NULL;
  IF active_count >= 40 THEN
    RAISE EXCEPTION 'the source-finding ledger is full' USING ERRCODE = '54000';
  END IF;

  -- One active finding per concept: recording supersedes, never duplicates.
  UPDATE control_plane.tenant_source_findings
  SET superseded_at = now()
  WHERE tenant_id = selected_tenant
    AND concept = p_concept
    AND superseded_at IS NULL;

  INSERT INTO control_plane.tenant_source_findings (tenant_id, concept, finding, created_by)
  VALUES (selected_tenant, p_concept, btrim(p_finding), actor);

  RETURN jsonb_build_object('recorded', true, 'concept', p_concept);
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_connector_freshness()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  WITH tenant AS (
    SELECT control_plane.require_current_tenant_id() AS tenant_id
  ),
  active_connection AS (
    SELECT connection.connection_id, connection.connector_key
    FROM control_plane.connections AS connection, tenant
    WHERE connection.tenant_id = tenant.tenant_id
      AND connection.status NOT IN ('pending', 'disconnected')
  ),
  readiness_rows AS (
    SELECT active_connection.connector_key,
           readiness.domain,
           readiness.data_ready_through
    FROM control_plane.readiness AS readiness
    JOIN active_connection USING (connection_id), tenant
    WHERE readiness.tenant_id = tenant.tenant_id
      AND readiness.data_ready_through IS NOT NULL
  ),
  cursor_rows AS (
    SELECT active_connection.connector_key,
           cursors.stream AS domain,
           coalesce(cursors.source_watermark, cursors.last_successful_sync_at) AS data_ready_through
    FROM control_plane.stream_cursors AS cursors
    JOIN active_connection USING (connection_id), tenant
    WHERE cursors.tenant_id = tenant.tenant_id
      AND coalesce(cursors.source_watermark, cursors.last_successful_sync_at) IS NOT NULL
  ),
  chosen AS (
    SELECT * FROM readiness_rows
    UNION ALL
    SELECT * FROM cursor_rows
    WHERE NOT EXISTS (SELECT 1 FROM readiness_rows)
  ),
  best AS (
    SELECT connector_key, domain, max(data_ready_through) AS data_ready_through
    FROM chosen
    GROUP BY connector_key, domain
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'connector', best.connector_key,
    'domain', best.domain,
    'dataThrough', best.data_ready_through
  ) ORDER BY best.connector_key, best.domain), '[]'::jsonb)
  FROM best;
$$;

REVOKE ALL ON FUNCTION public.albert_list_source_findings() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_record_source_finding(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_connector_freshness() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_list_source_findings() TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_record_source_finding(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_connector_freshness() TO authenticated;

COMMIT;
