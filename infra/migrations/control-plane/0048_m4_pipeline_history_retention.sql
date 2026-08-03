BEGIN;

-- Pipeline-table snapshots are operational telemetry, not an unbounded event
-- store.  Keep enough resolution for incident response while compacting each
-- tenant independently behind the transform runtime's existing tenant scope.
CREATE INDEX IF NOT EXISTS pipeline_stats_retention_idx
  ON control_plane.pipeline_stats(
    tenant_id,schema_name,table_name,snapshot_at DESC
  );

CREATE OR REPLACE FUNCTION control_plane.transform_maintenance_metrics()
RETURNS TABLE(
  due_tenants bigint,
  active_leases bigint,
  completed_24h bigint,
  completed_p95_ms numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_transform_control_runtime','albert_transform_control'
  );
  RETURN QUERY
  WITH completion AS (
    SELECT count(*)::bigint AS sample_count,
           coalesce(
             percentile_cont(0.95) WITHIN GROUP (
               ORDER BY extract(epoch FROM (lease.completed_at-lease.claimed_at))*1000
             ),
             0
           )::numeric AS p95_ms
      FROM control_plane.transform_maintenance_leases lease
     WHERE lease.completed_at>=statement_timestamp()-interval '24 hours'
  )
  SELECT
    count(*) FILTER (
      WHERE tenant.status='active'
        AND EXISTS (
          SELECT 1 FROM control_plane.connections connection
           WHERE connection.tenant_id=tenant.tenant_id
             AND connection.status IN ('connected','degraded')
        )
        AND NOT EXISTS (
          SELECT 1 FROM control_plane.deletion_requests request
           WHERE request.tenant_id=tenant.tenant_id
             AND request.status IN ('queued','running','retry_wait','verifying','failed')
        )
        AND NOT EXISTS (
          SELECT 1 FROM control_plane.transform_maintenance_leases recent
           WHERE recent.tenant_id=tenant.tenant_id
             AND recent.purpose='pipeline_snapshot'
             AND (
               recent.expires_at>statement_timestamp()
               OR recent.completed_at>statement_timestamp()-interval '50 minutes'
             )
        )
    )::bigint,
    (
      SELECT count(*)::bigint
        FROM control_plane.transform_maintenance_leases lease
       WHERE lease.completed_at IS NULL
         AND lease.expires_at>statement_timestamp()
    ),
    max(completion.sample_count)::bigint,
    max(completion.p95_ms)::numeric
  FROM control_plane.tenants tenant
  CROSS JOIN completion;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.retain_pipeline_history(
  p_tenant_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE removed_count bigint:=0;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_transform_control_runtime','albert_transform_control'
  );
  IF NOT control_plane.is_ulid(p_tenant_id)
     OR p_tenant_id IS DISTINCT FROM
       nullif(current_setting('albert.tenant_id',true),'') THEN
    RAISE EXCEPTION 'pipeline retention tenant scope is invalid'
      USING ERRCODE='42501';
  END IF;

  WITH ranked AS MATERIALIZED (
    SELECT stat.tenant_id,stat.snapshot_at,stat.schema_name,stat.table_name,
           row_number() OVER (
             PARTITION BY stat.schema_name,stat.table_name,
               CASE
                 WHEN stat.snapshot_at>=statement_timestamp()-interval '48 hours'
                   THEN date_trunc('hour',stat.snapshot_at)
                 WHEN stat.snapshot_at>=statement_timestamp()-interval '35 days'
                   THEN date_trunc('day',stat.snapshot_at)
                 ELSE date_trunc('month',stat.snapshot_at)
               END
             ORDER BY stat.snapshot_at DESC
           ) AS bucket_rank
      FROM control_plane.pipeline_stats stat
     WHERE stat.tenant_id=p_tenant_id
  ), removed AS (
    DELETE FROM control_plane.pipeline_stats stat
     USING ranked candidate
     WHERE stat.tenant_id=candidate.tenant_id
       AND stat.snapshot_at=candidate.snapshot_at
       AND stat.schema_name=candidate.schema_name
       AND stat.table_name=candidate.table_name
       AND (
         candidate.snapshot_at<statement_timestamp()-interval '400 days'
         OR candidate.bucket_rank>1
       )
    RETURNING 1
  )
  SELECT count(*) INTO removed_count FROM removed;

  RETURN jsonb_build_object(
    'pipeline_stats_removed',removed_count,
    'hourly_retention_hours',48,
    'daily_retention_days',35,
    'maximum_retention_days',400
  );
END;
$$;

REVOKE ALL ON FUNCTION control_plane.retain_pipeline_history(text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION control_plane.transform_maintenance_metrics()
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION control_plane.retain_pipeline_history(text),
  control_plane.transform_maintenance_metrics()
  TO albert_transform_control;

COMMIT;
