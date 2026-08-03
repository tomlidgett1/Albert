BEGIN;

-- The maintenance ledger is short-lived operational evidence. Keep a bounded
-- incident window and index both the live fleet aggregate and an explicitly
-- attributed diagnostic run. This avoids a 20,000-row hourly workload growing
-- without limit or repeatedly scanning the table from its primary key.
CREATE INDEX IF NOT EXISTS transform_maintenance_completed_at_idx
  ON control_plane.transform_maintenance_leases(completed_at DESC)
  WHERE completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS transform_maintenance_worker_completed_at_idx
  ON control_plane.transform_maintenance_leases(worker_id,completed_at DESC)
  WHERE completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS transform_maintenance_capacity_prefix_idx
  ON control_plane.transform_maintenance_leases(worker_id text_pattern_ops,claimed_at,completed_at)
  WHERE completed_at IS NOT NULL;

-- A participant observation is written by the candidate process itself through
-- the exact transform runtime login.  The protected collector never accepts a
-- participant summary from workflow input or an operator-authored JSON file.
CREATE TABLE IF NOT EXISTS control_plane.transform_capacity_participant_observations (
  run_id text NOT NULL CHECK(run_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
  participant_id text NOT NULL CHECK(participant_id ~ '^[a-f0-9]{14}$'),
  worker_id text NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 160),
  release_sha text NOT NULL CHECK(release_sha ~ '^[a-f0-9]{40}$'),
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  completed_claims integer NOT NULL CHECK(completed_claims BETWEEN 0 AND 20000),
  control_pool_acquire_p95_ms numeric NOT NULL CHECK(control_pool_acquire_p95_ms>=0),
  analytical_pool_acquire_p95_ms numeric NOT NULL CHECK(analytical_pool_acquire_p95_ms>=0),
  error_count integer NOT NULL CHECK(error_count BETWEEN 0 AND 1),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(run_id,participant_id),
  UNIQUE(run_id,worker_id),
  CHECK(completed_at>=started_at),
  CHECK(worker_id='capacity:'||run_id||':'||participant_id)
);

REVOKE ALL ON TABLE control_plane.transform_capacity_participant_observations
  FROM PUBLIC,anon,authenticated,service_role,albert_transform_control;

CREATE OR REPLACE FUNCTION control_plane.retain_transform_maintenance_history()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE removed_count bigint;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_transform_control_runtime','albert_transform_control'
  );
  WITH removed AS (
    DELETE FROM control_plane.transform_maintenance_leases lease
     WHERE lease.completed_at<statement_timestamp()-interval '48 hours'
        OR (
          lease.completed_at IS NULL
          AND lease.expires_at<statement_timestamp()-interval '24 hours'
        )
    RETURNING 1
  )
  SELECT count(*)::bigint INTO removed_count FROM removed;
  DELETE FROM control_plane.transform_capacity_participant_observations observation
   WHERE observation.recorded_at<statement_timestamp()-interval '48 hours';
  RETURN removed_count;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.transform_capacity_run_metrics(
  p_worker_id text,
  p_started_at timestamptz
) RETURNS TABLE(
  completed_count bigint,
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
  IF length(btrim(p_worker_id)) NOT BETWEEN 1 AND 160
     OR p_started_at<statement_timestamp()-interval '6 hours'
     OR p_started_at>statement_timestamp()+interval '1 minute' THEN
    RAISE EXCEPTION 'transform capacity run scope is invalid' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  SELECT count(*)::bigint,
         coalesce(
           percentile_cont(0.95) WITHIN GROUP (
             ORDER BY extract(epoch FROM (lease.completed_at-lease.claimed_at))*1000
           ),
           0
         )::numeric
    FROM control_plane.transform_maintenance_leases lease
   WHERE lease.worker_id=p_worker_id
     AND lease.claimed_at>=p_started_at
     AND lease.completed_at IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.record_transform_capacity_participant(
  p_run_id text,
  p_participant_id text,
  p_worker_id text,
  p_release_sha text,
  p_started_at timestamptz,
  p_completed_at timestamptz,
  p_completed_claims integer,
  p_control_pool_acquire_p95_ms numeric,
  p_analytical_pool_acquire_p95_ms numeric,
  p_error_count integer
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_transform_control_runtime','albert_transform_control'
  );
  IF p_run_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
     OR p_participant_id !~ '^[a-f0-9]{14}$'
     OR p_worker_id IS DISTINCT FROM 'capacity:'||p_run_id||':'||p_participant_id
     OR p_release_sha !~ '^[a-f0-9]{40}$'
     OR p_started_at<statement_timestamp()-interval '6 hours'
     OR p_started_at>statement_timestamp()+interval '1 minute'
     OR p_completed_at<p_started_at
     OR p_completed_at>statement_timestamp()+interval '1 minute'
     OR p_completed_claims NOT BETWEEN 0 AND 20000
     OR p_control_pool_acquire_p95_ms NOT BETWEEN 0 AND 60000
     OR p_analytical_pool_acquire_p95_ms NOT BETWEEN 0 AND 60000
     OR p_error_count NOT BETWEEN 0 AND 1 THEN
    RAISE EXCEPTION 'transform capacity participant observation is invalid'
      USING ERRCODE='22023';
  END IF;
  INSERT INTO control_plane.transform_capacity_participant_observations(
    run_id,participant_id,worker_id,release_sha,started_at,completed_at,
    completed_claims,control_pool_acquire_p95_ms,
    analytical_pool_acquire_p95_ms,error_count
  ) VALUES(
    p_run_id,p_participant_id,p_worker_id,p_release_sha,p_started_at,p_completed_at,
    p_completed_claims,p_control_pool_acquire_p95_ms,
    p_analytical_pool_acquire_p95_ms,p_error_count
  )
  ON CONFLICT(run_id,participant_id) DO UPDATE SET
    completed_at=excluded.completed_at,
    completed_claims=excluded.completed_claims,
    control_pool_acquire_p95_ms=excluded.control_pool_acquire_p95_ms,
    analytical_pool_acquire_p95_ms=excluded.analytical_pool_acquire_p95_ms,
    error_count=excluded.error_count,
    recorded_at=clock_timestamp()
  WHERE control_plane.transform_capacity_participant_observations.worker_id=excluded.worker_id
    AND control_plane.transform_capacity_participant_observations.release_sha=excluded.release_sha
    AND control_plane.transform_capacity_participant_observations.started_at=excluded.started_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transform capacity participant identity is immutable'
      USING ERRCODE='55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.transform_capacity_fleet_run_metrics(
  p_run_id text,
  p_started_at timestamptz
) RETURNS TABLE(
  completed_count bigint,
  distinct_tenants bigint,
  observed_worker_processes bigint,
  participant_count bigint,
  participant_error_count bigint,
  completed_p95_ms numeric,
  completed_p99_ms numeric,
  control_pool_acquire_p95_ms numeric,
  analytical_pool_acquire_p95_ms numeric,
  first_claimed_at timestamptz,
  last_completed_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE worker_prefix text;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_transform_control_runtime','albert_transform_control'
  );
  IF p_run_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
     OR p_started_at<statement_timestamp()-interval '6 hours'
     OR p_started_at>statement_timestamp()+interval '1 minute' THEN
    RAISE EXCEPTION 'transform capacity fleet run scope is invalid' USING ERRCODE='22023';
  END IF;
  worker_prefix:='capacity:'||p_run_id||':';
  RETURN QUERY
  WITH lease_metrics AS (
    SELECT count(*)::bigint AS completed_count,
           count(DISTINCT lease.tenant_id)::bigint AS distinct_tenants,
           count(DISTINCT lease.worker_id)::bigint AS observed_worker_processes,
           coalesce(percentile_cont(0.95) WITHIN GROUP (
             ORDER BY extract(epoch FROM (lease.completed_at-lease.claimed_at))*1000
           ),0)::numeric AS completed_p95_ms,
           coalesce(percentile_cont(0.99) WITHIN GROUP (
             ORDER BY extract(epoch FROM (lease.completed_at-lease.claimed_at))*1000
           ),0)::numeric AS completed_p99_ms,
           min(lease.claimed_at) AS first_claimed_at,
           max(lease.completed_at) AS last_completed_at
      FROM control_plane.transform_maintenance_leases lease
     WHERE starts_with(lease.worker_id,worker_prefix)
       AND lease.claimed_at>=p_started_at
       AND lease.completed_at IS NOT NULL
  ), participant_metrics AS (
    SELECT count(*)::bigint AS participant_count,
           coalesce(sum(observation.error_count),0)::bigint AS participant_error_count,
           coalesce(max(observation.control_pool_acquire_p95_ms),0)::numeric
             AS control_pool_acquire_p95_ms,
           coalesce(max(observation.analytical_pool_acquire_p95_ms),0)::numeric
             AS analytical_pool_acquire_p95_ms
      FROM control_plane.transform_capacity_participant_observations observation
     WHERE observation.run_id=p_run_id
       AND observation.started_at>=p_started_at
  )
  SELECT lease_metrics.completed_count,lease_metrics.distinct_tenants,
         lease_metrics.observed_worker_processes,participant_metrics.participant_count,
         participant_metrics.participant_error_count,lease_metrics.completed_p95_ms,
         lease_metrics.completed_p99_ms,participant_metrics.control_pool_acquire_p95_ms,
         participant_metrics.analytical_pool_acquire_p95_ms,
         lease_metrics.first_claimed_at,lease_metrics.last_completed_at
    FROM lease_metrics CROSS JOIN participant_metrics;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.transform_capacity_workload_profile(
  p_run_id text,
  p_started_at timestamptz
) RETURNS TABLE(
  completed_tenants bigint,
  source_p50 numeric,
  source_p95 numeric,
  source_max bigint,
  canonical_p50 numeric,
  canonical_p95 numeric,
  canonical_max bigint,
  micro_count bigint,
  small_count bigint,
  medium_count bigint,
  corpus_fingerprint text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE worker_prefix text;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_transform_control_runtime','albert_transform_control'
  );
  IF p_run_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
     OR p_started_at<statement_timestamp()-interval '6 hours'
     OR p_started_at>statement_timestamp()+interval '1 minute' THEN
    RAISE EXCEPTION 'transform capacity workload scope is invalid' USING ERRCODE='22023';
  END IF;
  worker_prefix:='capacity:'||p_run_id||':';
  RETURN QUERY
  WITH completed AS (
    SELECT DISTINCT lease.tenant_id
      FROM control_plane.transform_maintenance_leases lease
     WHERE starts_with(lease.worker_id,worker_prefix)
       AND lease.claimed_at>=p_started_at
       AND lease.completed_at IS NOT NULL
  ), latest_snapshot AS (
    SELECT completed.tenant_id,max(stat.snapshot_at) AS snapshot_at
      FROM completed
      JOIN control_plane.pipeline_stats stat ON stat.tenant_id=completed.tenant_id
     WHERE stat.snapshot_at>=p_started_at
     GROUP BY completed.tenant_id
  ), tenant_volume AS (
    SELECT latest_snapshot.tenant_id,
           coalesce(sum(stat.row_count) FILTER(WHERE starts_with(stat.schema_name,'source_')),0)::bigint
             AS source_rows,
           coalesce(sum(stat.row_count) FILTER(WHERE stat.schema_name IN ('core','mart')),0)::bigint
             AS canonical_rows
      FROM latest_snapshot
      JOIN control_plane.pipeline_stats stat
        ON stat.tenant_id=latest_snapshot.tenant_id
       AND stat.snapshot_at=latest_snapshot.snapshot_at
     GROUP BY latest_snapshot.tenant_id
  )
  SELECT count(*)::bigint,
         coalesce(percentile_cont(0.50) WITHIN GROUP(ORDER BY source_rows),0)::numeric,
         coalesce(percentile_cont(0.95) WITHIN GROUP(ORDER BY source_rows),0)::numeric,
         coalesce(max(source_rows),0)::bigint,
         coalesce(percentile_cont(0.50) WITHIN GROUP(ORDER BY canonical_rows),0)::numeric,
         coalesce(percentile_cont(0.95) WITHIN GROUP(ORDER BY canonical_rows),0)::numeric,
         coalesce(max(canonical_rows),0)::bigint,
         count(*) FILTER(WHERE greatest(source_rows,canonical_rows) BETWEEN 1 AND 999)::bigint,
         count(*) FILTER(WHERE greatest(source_rows,canonical_rows) BETWEEN 1000 AND 9999)::bigint,
         count(*) FILTER(WHERE greatest(source_rows,canonical_rows)>=10000)::bigint,
         encode(extensions.digest(
           string_agg(tenant_id||':'||source_rows::text||':'||canonical_rows::text,
             ',' ORDER BY tenant_id),'sha256'
         ),'hex')::text
    FROM tenant_volume;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.transform_capacity_fleet_participants(
  p_run_id text,
  p_started_at timestamptz
) RETURNS TABLE(
  participant_id text,
  worker_id text,
  release_sha text,
  completed_claims integer,
  error_count integer
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
  IF p_run_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
     OR p_started_at<statement_timestamp()-interval '6 hours'
     OR p_started_at>statement_timestamp()+interval '1 minute' THEN
    RAISE EXCEPTION 'transform capacity participant scope is invalid' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  SELECT observation.participant_id,observation.worker_id,
         observation.release_sha,observation.completed_claims,observation.error_count
    FROM control_plane.transform_capacity_participant_observations observation
   WHERE observation.run_id=p_run_id
     AND observation.started_at>=p_started_at
   ORDER BY observation.participant_id;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.retain_transform_maintenance_history()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION control_plane.transform_capacity_run_metrics(text,timestamptz)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION control_plane.record_transform_capacity_participant(
  text,text,text,text,timestamptz,timestamptz,integer,numeric,numeric,integer
) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION control_plane.transform_capacity_fleet_run_metrics(text,timestamptz)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION control_plane.transform_capacity_workload_profile(text,timestamptz)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION control_plane.transform_capacity_fleet_participants(text,timestamptz)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION control_plane.retain_transform_maintenance_history()
  TO albert_transform_control;
GRANT EXECUTE ON FUNCTION control_plane.transform_capacity_run_metrics(text,timestamptz)
  TO albert_transform_control;
GRANT EXECUTE ON FUNCTION control_plane.record_transform_capacity_participant(
  text,text,text,text,timestamptz,timestamptz,integer,numeric,numeric,integer
) TO albert_transform_control;
GRANT EXECUTE ON FUNCTION control_plane.transform_capacity_fleet_run_metrics(text,timestamptz)
  TO albert_transform_control;
GRANT EXECUTE ON FUNCTION control_plane.transform_capacity_workload_profile(text,timestamptz)
  TO albert_transform_control;
GRANT EXECUTE ON FUNCTION control_plane.transform_capacity_fleet_participants(text,timestamptz)
  TO albert_transform_control;

COMMIT;
