BEGIN;

-- Product readiness and canonical materialisation are different contracts.
-- A stream phase owns product domains for the UI, while immutable connector-
-- local dependencies fence canonical work until complete master populations
-- have landed and transformed.
ALTER TABLE control_plane.sync_stream_phases
  ADD COLUMN IF NOT EXISTS dependencies text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS dependency_plan_sealed boolean NOT NULL DEFAULT false;

UPDATE control_plane.sync_stream_phases
   SET dependency_plan_sealed=true
 WHERE dependency_plan_sealed=false;

CREATE OR REPLACE FUNCTION control_plane.stream_dependency_array_valid(
  p_stream text,p_dependencies text[]
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path=pg_catalog
AS $$
  SELECT p_stream ~ '^[a-z][a-z0-9_]*$'
     AND NOT p_stream=ANY(p_dependencies)
     AND cardinality(p_dependencies)=(
       SELECT count(DISTINCT dependency)::integer FROM unnest(p_dependencies) dependency
     )
     AND NOT EXISTS (
       SELECT 1 FROM unnest(p_dependencies) dependency
        WHERE dependency !~ '^[a-z][a-z0-9_]*$'
     )
$$;

CREATE OR REPLACE FUNCTION control_plane.product_domain_array_valid(
  p_domains text[]
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path=pg_catalog
AS $$
  SELECT cardinality(p_domains)>0
     AND cardinality(p_domains)=(
       SELECT count(DISTINCT domain_name)::integer FROM unnest(p_domains) domain_name
     )
     AND NOT EXISTS (
       SELECT 1 FROM unnest(p_domains) domain_name
        WHERE domain_name NOT IN (
          'sales','inventory','customers','products','accounting','workforce'
        )
     )
$$;

ALTER TABLE control_plane.sync_stream_phases
  DROP CONSTRAINT IF EXISTS sync_stream_phases_dependencies_valid;
ALTER TABLE control_plane.sync_stream_phases
  ADD CONSTRAINT sync_stream_phases_dependencies_valid CHECK (
    control_plane.stream_dependency_array_valid(stream,dependencies)
  );

CREATE TABLE control_plane.progressive_stream_coverage (
  tenant_id text NOT NULL CHECK (control_plane.is_ulid(tenant_id)),
  connection_id text NOT NULL CHECK (control_plane.is_ulid(connection_id)),
  connection_generation bigint NOT NULL CHECK (connection_generation>0),
  stream text NOT NULL CHECK (stream ~ '^[a-z][a-z0-9_]*$'),
  phase text NOT NULL DEFAULT 'recent' CHECK (phase='recent'),
  dependencies text[] NOT NULL DEFAULT '{}'::text[],
  product_domains text[] NOT NULL CHECK (cardinality(product_domains)>0),
  covered_from timestamptz NOT NULL,
  covered_to timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending','queryable','degraded','superseded')
  ),
  terminal_phase_completed_at timestamptz,
  fully_transformed_at timestamptz,
  queryable_at timestamptz,
  qualification text NOT NULL DEFAULT
    'Recent data is available only for the disclosed covered range while deeper history continues.',
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,connection_id,connection_generation,stream,phase),
  FOREIGN KEY (tenant_id,connection_id)
    REFERENCES control_plane.connections(tenant_id,connection_id) ON DELETE CASCADE,
  CHECK (control_plane.stream_dependency_array_valid(stream,dependencies)),
  CHECK (control_plane.product_domain_array_valid(product_domains)),
  CHECK (covered_from<covered_to),
  CHECK (
    (status='queryable')=(queryable_at IS NOT NULL)
    OR status IN ('degraded','superseded')
  )
);

CREATE TABLE control_plane.progressive_reconciliation_requests (
  tenant_id text NOT NULL CHECK (control_plane.is_ulid(tenant_id)),
  connection_id text NOT NULL CHECK (control_plane.is_ulid(connection_id)),
  connection_generation bigint NOT NULL CHECK (connection_generation>0),
  reconciliation_sweep_id text NOT NULL CHECK (control_plane.is_ulid(reconciliation_sweep_id)),
  job_request_id text NOT NULL CHECK (control_plane.is_ulid(job_request_id)),
  trigger_stream text NOT NULL CHECK (trigger_stream ~ '^[a-z][a-z0-9_]*$'),
  covered_from timestamptz NOT NULL,
  covered_to timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,connection_id,connection_generation),
  FOREIGN KEY (tenant_id,connection_id)
    REFERENCES control_plane.connections(tenant_id,connection_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,job_request_id)
    REFERENCES control_plane.sync_job_requests(tenant_id,job_request_id) ON DELETE CASCADE,
  CHECK (covered_from<covered_to)
);

CREATE INDEX progressive_stream_coverage_status_idx
  ON control_plane.progressive_stream_coverage(
    tenant_id,connection_id,connection_generation,status,stream
  );

ALTER TABLE control_plane.progressive_stream_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.progressive_reconciliation_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY progressive_coverage_tenant_read
  ON control_plane.progressive_stream_coverage
  FOR SELECT TO authenticated
  USING (control_plane.is_tenant_member(tenant_id));
CREATE POLICY progressive_coverage_semantic_read
  ON control_plane.progressive_stream_coverage
  FOR SELECT TO albert_semantic_control
  USING (tenant_id=nullif(current_setting('albert.tenant_id',true),''));
CREATE POLICY progressive_coverage_sync_read
  ON control_plane.progressive_stream_coverage
  FOR SELECT TO albert_sync_control USING (true);
CREATE POLICY progressive_coverage_transform_read
  ON control_plane.progressive_stream_coverage
  FOR SELECT TO albert_transform_control
  USING (tenant_id=nullif(current_setting('albert.tenant_id',true),''));
CREATE POLICY progressive_reconciliation_sync_read
  ON control_plane.progressive_reconciliation_requests
  FOR SELECT TO albert_sync_control USING (true);

CREATE TRIGGER progressive_stream_coverage_touch_updated_at
  BEFORE UPDATE ON control_plane.progressive_stream_coverage
  FOR EACH ROW EXECUTE FUNCTION control_plane.touch_updated_at();

ALTER TABLE control_plane.readiness
  ADD COLUMN IF NOT EXISTS covered_from timestamptz,
  ADD COLUMN IF NOT EXISTS covered_to timestamptz,
  ADD COLUMN IF NOT EXISTS coverage_qualification text,
  ADD COLUMN IF NOT EXISTS reconciliation_status text;
ALTER TABLE control_plane.readiness
  DROP CONSTRAINT IF EXISTS readiness_progressive_coverage_valid;
ALTER TABLE control_plane.readiness
  ADD CONSTRAINT readiness_progressive_coverage_valid CHECK (
    (covered_from IS NULL AND covered_to IS NULL)
    OR (covered_from IS NOT NULL AND covered_to IS NOT NULL AND covered_from<covered_to)
  );
ALTER TABLE control_plane.readiness
  DROP CONSTRAINT IF EXISTS readiness_reconciliation_status_valid;
ALTER TABLE control_plane.readiness
  ADD CONSTRAINT readiness_reconciliation_status_valid CHECK (
    reconciliation_status IS NULL OR reconciliation_status IN (
      'scheduled','running','complete','degraded'
    )
  );

-- New signature: dependencies are immutable alongside ranges and product
-- domains. The old fourteen-argument routine remains revoked below so a
-- rolling worker cannot silently register an unfenced plan.
CREATE OR REPLACE FUNCTION control_plane.register_sync_stream_phase(
  p_tenant_id text,
  p_connection_id text,
  p_connection_generation bigint,
  p_stream text,
  p_phase text,
  p_phase_ordinal integer,
  p_plan_mode text,
  p_backfill_strategy text,
  p_required boolean,
  p_domains text[],
  p_dependencies text[],
  p_range_from timestamptz,
  p_range_to timestamptz,
  p_predecessor_phase text,
  p_inherited_coverage jsonb DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE existing control_plane.sync_stream_phases%ROWTYPE;
DECLARE canonical_domains text[];
DECLARE canonical_dependencies text[];
BEGIN
  canonical_domains:=ARRAY(
    SELECT DISTINCT value FROM unnest(p_domains) value ORDER BY value
  );
  canonical_dependencies:=ARRAY(
    SELECT DISTINCT value FROM unnest(coalesce(p_dependencies,'{}'::text[])) value ORDER BY value
  );
  IF NOT control_plane.is_ulid(p_tenant_id)
     OR NOT control_plane.is_ulid(p_connection_id)
     OR p_connection_generation<1 OR p_stream !~ '^[a-z][a-z0-9_]*$'
     OR p_phase NOT IN ('recent','thirteen_months','full_history')
     OR p_phase_ordinal NOT BETWEEN 1 AND 3
     OR p_plan_mode NOT IN ('progressive','resume_verified','single_pass')
     OR p_backfill_strategy NOT IN ('time_windowed','snapshot','exhaustive_offset')
     OR coalesce(cardinality(canonical_domains),0)=0
     OR EXISTS (
       SELECT 1 FROM unnest(canonical_domains) value
        WHERE value NOT IN ('sales','inventory','customers','products','accounting','workforce')
     )
     OR p_stream=ANY(canonical_dependencies)
     OR EXISTS (
       SELECT 1 FROM unnest(canonical_dependencies) value
        WHERE value !~ '^[a-z][a-z0-9_]*$'
     )
     OR p_range_from>=p_range_to
     OR (p_inherited_coverage IS NOT NULL AND jsonb_typeof(p_inherited_coverage)<>'object') THEN
    RAISE EXCEPTION 'sync stream dependency phase registration is invalid'
      USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM control_plane.connections connection
   WHERE connection.tenant_id=p_tenant_id
     AND connection.connection_id=p_connection_id
     AND connection.connection_generation=p_connection_generation
     AND connection.status IN ('connected','degraded')
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sync stream dependency generation is stale' USING ERRCODE='55000';
  END IF;

  SELECT * INTO existing FROM control_plane.sync_stream_phases phase_row
   WHERE phase_row.tenant_id=p_tenant_id AND phase_row.connection_id=p_connection_id
     AND phase_row.connection_generation=p_connection_generation
     AND phase_row.stream=p_stream AND phase_row.phase=p_phase;
  IF FOUND THEN
    IF existing.phase_ordinal<>p_phase_ordinal OR existing.plan_mode<>p_plan_mode
       OR existing.backfill_strategy<>p_backfill_strategy OR existing.required<>p_required
       OR existing.domains<>canonical_domains
       OR existing.dependencies<>canonical_dependencies
       OR existing.range_from<>p_range_from OR existing.range_to<>p_range_to
       OR existing.predecessor_phase IS DISTINCT FROM p_predecessor_phase THEN
      RAISE EXCEPTION 'sync stream dependency plan is immutable' USING ERRCODE='23505';
    END IF;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM control_plane.sync_stream_phases sealed_phase
     WHERE sealed_phase.tenant_id=p_tenant_id
       AND sealed_phase.connection_id=p_connection_id
       AND sealed_phase.connection_generation=p_connection_generation
       AND sealed_phase.dependency_plan_sealed
  ) THEN
    RAISE EXCEPTION 'sync stream dependency plan is already sealed' USING ERRCODE='55000';
  END IF;

  INSERT INTO control_plane.sync_stream_phases(
    tenant_id,connection_id,connection_generation,stream,phase,phase_ordinal,
    plan_mode,backfill_strategy,required,domains,dependencies,range_from,range_to,
    predecessor_phase,coverage_boundary_kind,coverage_lower_bound,
    coverage_verification,coverage_detail,inherited_coverage,dependency_plan_sealed
  ) VALUES (
    p_tenant_id,p_connection_id,p_connection_generation,p_stream,p_phase,p_phase_ordinal,
    p_plan_mode,p_backfill_strategy,p_required,canonical_domains,canonical_dependencies,
    p_range_from,p_range_to,p_predecessor_phase,
    p_inherited_coverage->>'boundaryKind',
    nullif(p_inherited_coverage->>'lowerBound','')::timestamptz,
    p_inherited_coverage->>'verification',nullif(p_inherited_coverage->>'detail',''),
    p_inherited_coverage IS NOT NULL,false
  );
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.seal_sync_dependency_plan(
  p_tenant_id text,p_connection_id text,p_connection_generation bigint
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE phase_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'sync-dependency-plan:'||p_tenant_id||':'||p_connection_id||':'||p_connection_generation,0
  ));
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.connections connection
     WHERE connection.tenant_id=p_tenant_id AND connection.connection_id=p_connection_id
       AND connection.connection_generation=p_connection_generation
       AND connection.status IN ('connected','degraded')
  ) THEN
    RAISE EXCEPTION 'sync dependency plan generation is stale' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.sync_stream_phases phase_row
     WHERE phase_row.tenant_id=p_tenant_id
       AND phase_row.connection_id=p_connection_id
       AND phase_row.connection_generation=p_connection_generation
       AND phase_row.phase='recent'
  ) THEN
    RAISE EXCEPTION 'sync dependency plan has no recent phase' USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM control_plane.sync_stream_phases phase_row
    CROSS JOIN LATERAL unnest(phase_row.dependencies) dependency
    LEFT JOIN control_plane.sync_stream_phases required_phase
      ON required_phase.tenant_id=phase_row.tenant_id
     AND required_phase.connection_id=phase_row.connection_id
     AND required_phase.connection_generation=phase_row.connection_generation
     AND required_phase.stream=dependency AND required_phase.phase='recent'
   WHERE phase_row.tenant_id=p_tenant_id AND phase_row.connection_id=p_connection_id
     AND phase_row.connection_generation=p_connection_generation
     AND (required_phase.stream IS NULL OR NOT required_phase.required)
  ) THEN
    RAISE EXCEPTION 'sync dependency is missing or optional' USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM control_plane.sync_stream_phases phase_row
    LEFT JOIN control_plane.sync_stream_phases recent_phase
      ON recent_phase.tenant_id=phase_row.tenant_id
     AND recent_phase.connection_id=phase_row.connection_id
     AND recent_phase.connection_generation=phase_row.connection_generation
     AND recent_phase.stream=phase_row.stream AND recent_phase.phase='recent'
   WHERE phase_row.tenant_id=p_tenant_id AND phase_row.connection_id=p_connection_id
     AND phase_row.connection_generation=p_connection_generation
     AND (
       recent_phase.stream IS NULL OR phase_row.dependencies<>recent_phase.dependencies
       OR phase_row.domains<>recent_phase.domains OR phase_row.required<>recent_phase.required
       OR phase_row.backfill_strategy<>recent_phase.backfill_strategy
     )
  ) THEN
    RAISE EXCEPTION 'sync dependency metadata differs across stream phases' USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    WITH RECURSIVE walk(root,current,path,cycle) AS (
      SELECT phase_row.stream,dependency,ARRAY[phase_row.stream,dependency],
             dependency=phase_row.stream
        FROM control_plane.sync_stream_phases phase_row
        CROSS JOIN LATERAL unnest(phase_row.dependencies) dependency
       WHERE phase_row.tenant_id=p_tenant_id AND phase_row.connection_id=p_connection_id
         AND phase_row.connection_generation=p_connection_generation
         AND phase_row.phase='recent'
      UNION ALL
      SELECT walk.root,next_dependency,walk.path||next_dependency,
             next_dependency=ANY(walk.path)
        FROM walk
        JOIN control_plane.sync_stream_phases next_phase
          ON next_phase.tenant_id=p_tenant_id AND next_phase.connection_id=p_connection_id
         AND next_phase.connection_generation=p_connection_generation
         AND next_phase.stream=walk.current AND next_phase.phase='recent'
        CROSS JOIN LATERAL unnest(next_phase.dependencies) next_dependency
       WHERE NOT walk.cycle
    ) SELECT 1 FROM walk WHERE cycle
  ) THEN
    RAISE EXCEPTION 'sync dependency plan contains a cycle' USING ERRCODE='55000';
  END IF;

  UPDATE control_plane.sync_stream_phases
     SET dependency_plan_sealed=true
   WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id
     AND connection_generation=p_connection_generation;
  GET DIAGNOSTICS phase_count=ROW_COUNT;
  INSERT INTO control_plane.progressive_stream_coverage(
    tenant_id,connection_id,connection_generation,stream,dependencies,
    product_domains,covered_from,covered_to,status,evidence
  )
  SELECT phase_row.tenant_id,phase_row.connection_id,phase_row.connection_generation,
         phase_row.stream,phase_row.dependencies,phase_row.domains,
         phase_row.range_from,phase_row.range_to,'pending',jsonb_build_object(
           'phase','recent','planMode',phase_row.plan_mode,
           'backfillStrategy',phase_row.backfill_strategy,
           'required',phase_row.required
         )
    FROM control_plane.sync_stream_phases phase_row
   WHERE phase_row.tenant_id=p_tenant_id AND phase_row.connection_id=p_connection_id
     AND phase_row.connection_generation=p_connection_generation
     AND phase_row.phase='recent'
  ON CONFLICT (tenant_id,connection_id,connection_generation,stream,phase) DO NOTHING;
  RETURN phase_count;
END;
$$;

-- Optional capabilities fail closed for semantic use but do not poison the
-- readiness of required sibling streams. Persist the distinction instead of
-- leaving an optional phase looking indefinitely in-flight.
CREATE OR REPLACE FUNCTION control_plane.mark_sync_stream_phase_unavailable(
  p_tenant_id text,p_connection_id text,p_connection_generation bigint,
  p_stream text,p_phase text,p_replay_version integer,p_error jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_error IS NULL OR jsonb_typeof(p_error)<>'object'
     OR coalesce(p_error->>'code','')<>'capability_unavailable' THEN
    RAISE EXCEPTION 'optional stream unavailable evidence is invalid' USING ERRCODE='22023';
  END IF;
  UPDATE control_plane.sync_stream_phases phase_row
     SET status='unavailable',last_error=p_error,completed_at=now()
   WHERE phase_row.tenant_id=p_tenant_id AND phase_row.connection_id=p_connection_id
     AND phase_row.connection_generation=p_connection_generation
     AND phase_row.stream=p_stream AND phase_row.phase=p_phase
     AND phase_row.replay_version=p_replay_version
     AND NOT phase_row.required AND phase_row.status IN ('queued','running','failed');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'optional stream unavailable target is stale or required' USING ERRCODE='55000';
  END IF;
  IF p_phase='recent' THEN
    UPDATE control_plane.progressive_stream_coverage coverage
       SET status='degraded',terminal_phase_completed_at=now(),
           evidence=coverage.evidence||jsonb_build_object(
             'reasonCode','capability_unavailable','error',p_error
           )
     WHERE coverage.tenant_id=p_tenant_id AND coverage.connection_id=p_connection_id
       AND coverage.connection_generation=p_connection_generation
       AND coverage.stream=p_stream AND coverage.phase='recent'
       AND coverage.status='pending';
  END IF;
END;
$$;

-- A page transform is claimable only once its complete extraction phase is
-- terminal and every declared master dependency has become queryable. Raw and
-- typed staging may land concurrently; canonical truth cannot race the DAG.
CREATE OR REPLACE FUNCTION control_plane.claim_canonical_transform_job(
  p_worker_id text,p_mapping_version text,p_lease_seconds integer
) RETURNS TABLE (
  tenant_id text,transform_job_id text,batch_id text,sync_run_id text,
  connection_id text,connector_id text,stream text,domains text[],
  mapping_version text,backfill_complete boolean,attempt_count integer,
  lease_token text,lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF length(btrim(p_worker_id)) NOT BETWEEN 1 AND 160
     OR p_mapping_version !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR p_lease_seconds NOT BETWEEN 30 AND 3600 THEN
    RAISE EXCEPTION 'canonical transform claim input is invalid' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH candidate AS (
    SELECT job.tenant_id,job.transform_job_id
      FROM control_plane.canonical_transform_jobs job
      JOIN control_plane.sync_runs run
        ON run.tenant_id=job.tenant_id AND run.sync_run_id=job.sync_run_id
      JOIN control_plane.connections connection
        ON connection.tenant_id=job.tenant_id AND connection.connection_id=job.connection_id
       AND connection.connection_generation=run.connection_generation
       AND connection.status IN ('connected','degraded')
     WHERE job.mapping_version=p_mapping_version AND job.available_at<=now()
       AND (job.status IN ('queued','retry_wait')
         OR (job.status='running' AND job.lease_expires_at<now()))
       AND (
         run.backfill_phase IS NULL OR EXISTS (
           SELECT 1 FROM control_plane.sync_stream_phases own_phase
            WHERE own_phase.tenant_id=job.tenant_id
              AND own_phase.connection_id=job.connection_id
              AND own_phase.connection_generation=run.connection_generation
              AND own_phase.stream=job.stream AND own_phase.phase=run.backfill_phase
              AND own_phase.dependency_plan_sealed AND own_phase.status='succeeded'
         )
       )
       AND NOT EXISTS (
         SELECT 1
           FROM control_plane.sync_stream_phases own_phase
           CROSS JOIN LATERAL unnest(own_phase.dependencies) dependency
           LEFT JOIN control_plane.progressive_stream_coverage dependency_coverage
             ON dependency_coverage.tenant_id=own_phase.tenant_id
            AND dependency_coverage.connection_id=own_phase.connection_id
            AND dependency_coverage.connection_generation=own_phase.connection_generation
            AND dependency_coverage.stream=dependency
            AND dependency_coverage.phase='recent'
          WHERE own_phase.tenant_id=job.tenant_id
            AND own_phase.connection_id=job.connection_id
            AND own_phase.connection_generation=run.connection_generation
            AND own_phase.stream=job.stream AND own_phase.phase='recent'
            AND coalesce(dependency_coverage.status,'missing')
              NOT IN ('queryable','superseded')
       )
     ORDER BY job.available_at,job.created_at,job.transform_job_id
     FOR UPDATE OF job SKIP LOCKED LIMIT 1
  )
  UPDATE control_plane.canonical_transform_jobs job
     SET status='running',attempt_count=job.attempt_count+1,
         lease_owner=p_worker_id,lease_token=control_plane.generate_ulid(),
         lease_expires_at=now()+make_interval(secs=>p_lease_seconds),
         started_at=coalesce(job.started_at,now()),completed_at=NULL,
         last_error=NULL,updated_at=now()
    FROM candidate
   WHERE job.tenant_id=candidate.tenant_id
     AND job.transform_job_id=candidate.transform_job_id
  RETURNING job.tenant_id,job.transform_job_id,job.batch_id,job.sync_run_id,
            job.connection_id,job.connector_id,job.stream,job.domains,
            job.mapping_version,job.backfill_complete,job.attempt_count,
            job.lease_token,job.lease_expires_at;
  UPDATE control_plane.readiness readiness
     SET state='validating',progress=greatest(coalesce(readiness.progress,0),0.75),
         reason_code=NULL,reason_detail=NULL,evaluated_at=now(),updated_at=now()
    FROM control_plane.canonical_transform_jobs job
   WHERE job.lease_owner=p_worker_id AND job.status='running'
     AND job.lease_expires_at>now() AND readiness.tenant_id=job.tenant_id
     AND readiness.connection_id=job.connection_id
     AND readiness.domain=ANY(job.domains);
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.complete_canonical_transform_job(
  p_tenant_id text,p_transform_job_id text,p_worker_id text,p_lease_token text,p_result jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE completed_job control_plane.canonical_transform_jobs%ROWTYPE;
DECLARE run_row control_plane.sync_runs%ROWTYPE;
DECLARE phase_row control_plane.sync_stream_phases%ROWTYPE;
DECLARE connection_row control_plane.connections%ROWTYPE;
DECLARE receipt record;
DECLARE sweep_id text;
DECLARE reconciliation_run_id text;
DECLARE reconciliation_batch_id text;
DECLARE reconciliation_from timestamptz;
DECLARE reconciliation_to timestamptz;
BEGIN
  IF p_result IS NULL OR jsonb_typeof(p_result)<>'object' THEN
    RAISE EXCEPTION 'canonical transform result must be an object' USING ERRCODE='22023';
  END IF;
  UPDATE control_plane.canonical_transform_jobs job
     SET status='succeeded',result_metadata=p_result,completed_at=now(),
         lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
   WHERE job.tenant_id=p_tenant_id AND job.transform_job_id=p_transform_job_id
     AND job.status='running' AND job.lease_owner=p_worker_id
     AND job.lease_token=p_lease_token AND job.lease_expires_at>now()
  RETURNING job.* INTO completed_job;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'canonical transform lease is stale' USING ERRCODE='55000';
  END IF;

  SELECT * INTO run_row FROM control_plane.sync_runs run
   WHERE run.tenant_id=completed_job.tenant_id
     AND run.sync_run_id=completed_job.sync_run_id;
  IF run_row.backfill_phase='full_history' AND completed_job.backfill_complete THEN
    UPDATE control_plane.progressive_stream_coverage coverage
       SET status='superseded',evidence=coverage.evidence||jsonb_build_object(
             'fullHistoryBatchId',completed_job.batch_id,
             'fullHistoryTransformJobId',completed_job.transform_job_id
           )
     WHERE coverage.tenant_id=completed_job.tenant_id
       AND coverage.connection_id=completed_job.connection_id
       AND coverage.connection_generation=run_row.connection_generation
       AND coverage.stream=completed_job.stream AND coverage.phase='recent'
       AND coverage.status IN ('pending','queryable','degraded');
    UPDATE control_plane.readiness readiness
       SET state=CASE WHEN readiness.state IN ('blocked','degraded')
                      THEN readiness.state ELSE 'ready_complete' END,
           progress=CASE WHEN readiness.state IN ('blocked','degraded')
                         THEN readiness.progress ELSE 1 END,
           backfill_complete=true,covered_from=NULL,covered_to=NULL,
           coverage_qualification=NULL,
           reason_code=CASE WHEN readiness.state IN ('blocked','degraded')
                            THEN readiness.reason_code ELSE NULL END,
           reason_detail=CASE WHEN readiness.state IN ('blocked','degraded')
                              THEN readiness.reason_detail ELSE NULL END,
           evaluated_at=now(),updated_at=now()
     WHERE readiness.tenant_id=completed_job.tenant_id
       AND readiness.connection_id=completed_job.connection_id
       AND readiness.domain=ANY(completed_job.domains)
       AND NOT EXISTS (
         SELECT 1
           FROM control_plane.sync_stream_phases required_phase
           LEFT JOIN control_plane.stream_cursors cursor
             ON cursor.tenant_id=required_phase.tenant_id
            AND cursor.connection_id=required_phase.connection_id
            AND cursor.stream=required_phase.stream
            AND cursor.connection_generation=required_phase.connection_generation
          WHERE required_phase.tenant_id=readiness.tenant_id
            AND required_phase.connection_id=readiness.connection_id
            AND required_phase.connection_generation=run_row.connection_generation
            AND required_phase.phase='recent' AND required_phase.required
            AND readiness.domain=ANY(required_phase.domains)
            AND coalesce(cursor.backfill_complete,false)=false
       );
    RETURN;
  END IF;
  IF run_row.backfill_phase<>'recent' THEN RETURN; END IF;
  SELECT * INTO phase_row FROM control_plane.sync_stream_phases phase
   WHERE phase.tenant_id=completed_job.tenant_id
     AND phase.connection_id=completed_job.connection_id
     AND phase.connection_generation=run_row.connection_generation
     AND phase.stream=completed_job.stream AND phase.phase='recent'
   FOR UPDATE;
  IF NOT FOUND OR phase_row.status<>'succeeded' OR NOT phase_row.dependency_plan_sealed THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM control_plane.canonical_transform_jobs sibling
    JOIN control_plane.sync_runs sibling_run
      ON sibling_run.tenant_id=sibling.tenant_id
     AND sibling_run.sync_run_id=sibling.sync_run_id
   WHERE sibling.tenant_id=completed_job.tenant_id
     AND sibling.connection_id=completed_job.connection_id
     AND sibling.stream=completed_job.stream
     AND sibling_run.connection_generation=run_row.connection_generation
     AND sibling_run.backfill_phase='recent' AND sibling.status<>'succeeded'
  ) OR EXISTS (
    SELECT 1 FROM unnest(phase_row.dependencies) dependency
    LEFT JOIN control_plane.progressive_stream_coverage dependency_coverage
      ON dependency_coverage.tenant_id=completed_job.tenant_id
     AND dependency_coverage.connection_id=completed_job.connection_id
     AND dependency_coverage.connection_generation=run_row.connection_generation
     AND dependency_coverage.stream=dependency AND dependency_coverage.phase='recent'
   WHERE coalesce(dependency_coverage.status,'missing')
     NOT IN ('queryable','superseded')
  ) THEN
    RETURN;
  END IF;

  UPDATE control_plane.progressive_stream_coverage coverage
     SET status='queryable',terminal_phase_completed_at=phase_row.completed_at,
         fully_transformed_at=now(),queryable_at=now(),evidence=coverage.evidence||jsonb_build_object(
           'terminalBatchId',completed_job.batch_id,
           'terminalTransformJobId',completed_job.transform_job_id,
           'mappingVersion',completed_job.mapping_version
         )
   WHERE coverage.tenant_id=completed_job.tenant_id
     AND coverage.connection_id=completed_job.connection_id
     AND coverage.connection_generation=run_row.connection_generation
     AND coverage.stream=completed_job.stream AND coverage.phase='recent'
     AND coverage.status='pending';
  IF NOT FOUND THEN RETURN; END IF;

  -- A product domain is queryable only when every required stream assigned to
  -- that domain is queryable. Preserve a stricter quality failure while still
  -- attaching its exact covered range for operators.
  UPDATE control_plane.readiness readiness
     SET state=CASE WHEN readiness.state IN ('blocked','degraded')
                    THEN readiness.state ELSE 'ready_partial' END,
         progress=CASE WHEN readiness.state IN ('blocked','degraded')
                       THEN readiness.progress
                       ELSE greatest(coalesce(readiness.progress,0),0.8) END,
         data_ready_through=(
           SELECT min(domain_coverage.covered_to)
             FROM control_plane.sync_stream_phases domain_phase
             JOIN control_plane.progressive_stream_coverage domain_coverage
               ON domain_coverage.tenant_id=domain_phase.tenant_id
              AND domain_coverage.connection_id=domain_phase.connection_id
              AND domain_coverage.connection_generation=domain_phase.connection_generation
              AND domain_coverage.stream=domain_phase.stream
              AND domain_coverage.phase='recent'
            WHERE domain_phase.tenant_id=readiness.tenant_id
              AND domain_phase.connection_id=readiness.connection_id
              AND domain_phase.connection_generation=run_row.connection_generation
              AND domain_phase.phase='recent' AND domain_phase.required
              AND readiness.domain=ANY(domain_phase.domains)
         ),
         backfill_complete=false,
         reason_code=CASE WHEN readiness.state IN ('blocked','degraded')
                          THEN readiness.reason_code ELSE 'covered_range_qualified' END,
         reason_detail=CASE WHEN readiness.state IN ('blocked','degraded')
                            THEN readiness.reason_detail
                            ELSE 'Recent data is queryable only inside the disclosed covered range while deeper history continues.' END,
         covered_from=(
           SELECT max(domain_coverage.covered_from)
             FROM control_plane.sync_stream_phases domain_phase
             JOIN control_plane.progressive_stream_coverage domain_coverage
               ON domain_coverage.tenant_id=domain_phase.tenant_id
              AND domain_coverage.connection_id=domain_phase.connection_id
              AND domain_coverage.connection_generation=domain_phase.connection_generation
              AND domain_coverage.stream=domain_phase.stream
              AND domain_coverage.phase='recent'
            WHERE domain_phase.tenant_id=readiness.tenant_id
              AND domain_phase.connection_id=readiness.connection_id
              AND domain_phase.connection_generation=run_row.connection_generation
              AND domain_phase.phase='recent' AND domain_phase.required
              AND readiness.domain=ANY(domain_phase.domains)
         ),
         covered_to=(
           SELECT min(domain_coverage.covered_to)
             FROM control_plane.sync_stream_phases domain_phase
             JOIN control_plane.progressive_stream_coverage domain_coverage
               ON domain_coverage.tenant_id=domain_phase.tenant_id
              AND domain_coverage.connection_id=domain_phase.connection_id
              AND domain_coverage.connection_generation=domain_phase.connection_generation
              AND domain_coverage.stream=domain_phase.stream
              AND domain_coverage.phase='recent'
            WHERE domain_phase.tenant_id=readiness.tenant_id
              AND domain_phase.connection_id=readiness.connection_id
              AND domain_phase.connection_generation=run_row.connection_generation
              AND domain_phase.phase='recent' AND domain_phase.required
              AND readiness.domain=ANY(domain_phase.domains)
         ),
         coverage_qualification='Recent data is available only for the disclosed covered range while deeper history continues.',
         evaluated_at=now(),updated_at=now()
   WHERE readiness.tenant_id=completed_job.tenant_id
     AND readiness.connection_id=completed_job.connection_id
     AND readiness.domain=ANY(phase_row.domains)
     AND NOT EXISTS (
       SELECT 1
         FROM control_plane.sync_stream_phases required_phase
         LEFT JOIN control_plane.progressive_stream_coverage required_coverage
           ON required_coverage.tenant_id=required_phase.tenant_id
          AND required_coverage.connection_id=required_phase.connection_id
          AND required_coverage.connection_generation=required_phase.connection_generation
          AND required_coverage.stream=required_phase.stream
          AND required_coverage.phase='recent'
        WHERE required_phase.tenant_id=readiness.tenant_id
          AND required_phase.connection_id=readiness.connection_id
          AND required_phase.connection_generation=run_row.connection_generation
          AND required_phase.phase='recent' AND required_phase.required
          AND readiness.domain=ANY(required_phase.domains)
          AND coalesce(required_coverage.status,'missing')
            NOT IN ('queryable','superseded')
     );

  -- The last required recent stream schedules a full connector reconciliation
  -- coordinator in the same transaction as transform acknowledgement.
  IF EXISTS (
    SELECT 1 FROM control_plane.sync_stream_phases required_phase
     WHERE required_phase.tenant_id=completed_job.tenant_id
       AND required_phase.connection_id=completed_job.connection_id
       AND required_phase.connection_generation=run_row.connection_generation
       AND required_phase.phase='recent' AND required_phase.required
  ) AND NOT EXISTS (
    SELECT 1
      FROM control_plane.sync_stream_phases required_phase
      LEFT JOIN control_plane.progressive_stream_coverage required_coverage
        ON required_coverage.tenant_id=required_phase.tenant_id
       AND required_coverage.connection_id=required_phase.connection_id
       AND required_coverage.connection_generation=required_phase.connection_generation
       AND required_coverage.stream=required_phase.stream
       AND required_coverage.phase='recent'
     WHERE required_phase.tenant_id=completed_job.tenant_id
       AND required_phase.connection_id=completed_job.connection_id
       AND required_phase.connection_generation=run_row.connection_generation
       AND required_phase.phase='recent' AND required_phase.required
       AND coalesce(required_coverage.status,'missing')
         NOT IN ('queryable','superseded')
  ) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'progressive-reconciliation:'||completed_job.tenant_id||':'||completed_job.connection_id||':'||run_row.connection_generation,0
    ));
    IF NOT EXISTS (
      SELECT 1 FROM control_plane.progressive_reconciliation_requests request
       WHERE request.tenant_id=completed_job.tenant_id
         AND request.connection_id=completed_job.connection_id
         AND request.connection_generation=run_row.connection_generation
    ) THEN
      SELECT * INTO connection_row FROM control_plane.connections connection
       WHERE connection.tenant_id=completed_job.tenant_id
         AND connection.connection_id=completed_job.connection_id
         AND connection.connection_generation=run_row.connection_generation
         AND connection.status IN ('connected','degraded')
       FOR UPDATE;
      IF FOUND AND connection_row.external_account_reference IS NOT NULL THEN
        SELECT max(coverage.covered_from),min(coverage.covered_to)
          INTO reconciliation_from,reconciliation_to
          FROM control_plane.sync_stream_phases required_phase
          JOIN control_plane.progressive_stream_coverage coverage
            ON coverage.tenant_id=required_phase.tenant_id
           AND coverage.connection_id=required_phase.connection_id
           AND coverage.connection_generation=required_phase.connection_generation
           AND coverage.stream=required_phase.stream AND coverage.phase='recent'
         WHERE required_phase.tenant_id=completed_job.tenant_id
           AND required_phase.connection_id=completed_job.connection_id
           AND required_phase.connection_generation=run_row.connection_generation
           AND required_phase.phase='recent' AND required_phase.required;
        IF reconciliation_from IS NULL OR reconciliation_to IS NULL
           OR reconciliation_from>=reconciliation_to THEN
          RAISE EXCEPTION 'progressive reconciliation coverage intersection is invalid'
            USING ERRCODE='55000';
        END IF;
        sweep_id:=control_plane.generate_ulid();
        reconciliation_run_id:=control_plane.generate_ulid();
        reconciliation_batch_id:=control_plane.generate_ulid();
        SELECT * INTO receipt FROM control_plane.enqueue_sync_job(
          jsonb_build_object(
            'schemaVersion',1,'type','ReconciliationSweep',
            'tenantId',completed_job.tenant_id,'connectionId',completed_job.connection_id,
            'connectionGeneration',run_row.connection_generation,
            'connectorId',completed_job.connector_id,
            'externalAccountReference',connection_row.external_account_reference,
            'syncRunId',reconciliation_run_id,'batchId',reconciliation_batch_id,
            'requestedAt',clock_timestamp(),
            'reconciliationSweepId',sweep_id,'phase','late_edits',
            'lookbackFrom',reconciliation_from,'lookbackTo',reconciliation_to
          ),
          'standard',
          'progressive-reconciliation:'||completed_job.connection_id||':g'||run_row.connection_generation,
          0
        );
        INSERT INTO control_plane.progressive_reconciliation_requests(
          tenant_id,connection_id,connection_generation,reconciliation_sweep_id,
          job_request_id,trigger_stream,covered_from,covered_to
        ) VALUES (
          completed_job.tenant_id,completed_job.connection_id,run_row.connection_generation,
          sweep_id,receipt.job_request_id,completed_job.stream,reconciliation_from,reconciliation_to
        );
        UPDATE control_plane.readiness readiness
           SET reconciliation_status='scheduled',updated_at=now()
         WHERE readiness.tenant_id=completed_job.tenant_id
           AND readiness.connection_id=completed_job.connection_id
           AND readiness.covered_from IS NOT NULL;
      END IF;
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON control_plane.progressive_stream_coverage,
  control_plane.progressive_reconciliation_requests
  FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
       albert_transform_control,albert_semantic_control;
GRANT SELECT ON control_plane.progressive_stream_coverage
  TO authenticated,albert_sync_control,albert_transform_control,albert_semantic_control;
GRANT SELECT ON control_plane.progressive_reconciliation_requests
  TO albert_sync_control,albert_transform_control;

REVOKE ALL ON FUNCTION control_plane.register_sync_stream_phase(
  text,text,bigint,text,text,integer,text,text,boolean,text[],timestamptz,timestamptz,text,jsonb
) FROM PUBLIC,anon,authenticated,service_role,albert_sync_control;
REVOKE ALL ON FUNCTION control_plane.register_sync_stream_phase(
  text,text,bigint,text,text,integer,text,text,boolean,text[],text[],timestamptz,timestamptz,text,jsonb
) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION control_plane.seal_sync_dependency_plan(text,text,bigint)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION control_plane.mark_sync_stream_phase_unavailable(
  text,text,bigint,text,text,integer,jsonb
) FROM PUBLIC,anon,authenticated,service_role,albert_transform_control,
       albert_semantic_control;
GRANT EXECUTE ON FUNCTION control_plane.register_sync_stream_phase(
  text,text,bigint,text,text,integer,text,text,boolean,text[],text[],timestamptz,timestamptz,text,jsonb
) TO albert_sync_control;
GRANT EXECUTE ON FUNCTION control_plane.seal_sync_dependency_plan(text,text,bigint)
  TO albert_sync_control;
GRANT EXECUTE ON FUNCTION control_plane.mark_sync_stream_phase_unavailable(
  text,text,bigint,text,text,integer,jsonb
) TO albert_sync_control;
REVOKE ALL ON FUNCTION control_plane.stream_dependency_array_valid(text,text[])
  FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
       albert_transform_control,albert_semantic_control;
GRANT EXECUTE ON FUNCTION control_plane.stream_dependency_array_valid(text,text[])
  TO albert_sync_control,albert_transform_control;
REVOKE ALL ON FUNCTION control_plane.product_domain_array_valid(text[])
  FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
       albert_transform_control,albert_semantic_control;

REVOKE ALL ON FUNCTION control_plane.claim_canonical_transform_job(text,text,integer),
  control_plane.complete_canonical_transform_job(text,text,text,text,jsonb)
  FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,albert_semantic_control;
GRANT EXECUTE ON FUNCTION control_plane.claim_canonical_transform_job(text,text,integer),
  control_plane.complete_canonical_transform_job(text,text,text,text,jsonb)
  TO albert_transform_control;

COMMIT;
