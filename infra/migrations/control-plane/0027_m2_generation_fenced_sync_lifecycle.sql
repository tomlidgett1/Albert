BEGIN;

-- A reconnect is a new authorisation epoch. Jobs, cursors, quality and
-- readiness from an older epoch may remain as audit evidence, but can never
-- advance the current connection.
ALTER TABLE control_plane.connections
  ADD COLUMN IF NOT EXISTS connection_generation bigint NOT NULL DEFAULT 1;
ALTER TABLE control_plane.connections
  DROP CONSTRAINT IF EXISTS connections_generation_positive;
ALTER TABLE control_plane.connections
  ADD CONSTRAINT connections_generation_positive CHECK (connection_generation > 0);

ALTER TABLE control_plane.sync_runs
  ADD COLUMN IF NOT EXISTS connection_generation bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS backfill_phase text,
  ADD COLUMN IF NOT EXISTS replay_version integer;
ALTER TABLE control_plane.sync_runs
  DROP CONSTRAINT IF EXISTS sync_runs_generation_phase_valid;
ALTER TABLE control_plane.sync_runs
  ADD CONSTRAINT sync_runs_generation_phase_valid CHECK (
    connection_generation > 0
    AND (backfill_phase IS NULL OR backfill_phase IN ('recent','thirteen_months','full_history'))
    AND (replay_version IS NULL OR replay_version > 0)
  );

ALTER TABLE control_plane.stream_cursors
  ADD COLUMN IF NOT EXISTS connection_generation bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS coverage_boundary_kind text,
  ADD COLUMN IF NOT EXISTS coverage_lower_bound timestamptz,
  ADD COLUMN IF NOT EXISTS coverage_verification text,
  ADD COLUMN IF NOT EXISTS coverage_detail text;
ALTER TABLE control_plane.stream_cursors
  DROP CONSTRAINT IF EXISTS stream_cursors_generation_coverage_valid;
ALTER TABLE control_plane.stream_cursors
  ADD CONSTRAINT stream_cursors_generation_coverage_valid CHECK (
    connection_generation > 0
    AND (
      (coverage_boundary_kind IS NULL AND coverage_lower_bound IS NULL AND coverage_verification IS NULL)
      OR (
        coverage_boundary_kind IN (
          'verified_oldest','verified_empty','account_start','vendor_retention','snapshot_at'
        )
        AND coverage_lower_bound IS NOT NULL
        AND coverage_verification IN (
          'exhaustive_vendor_scan','vendor_reported','account_metadata','point_in_time'
        )
      )
    )
  );

CREATE TABLE IF NOT EXISTS control_plane.sync_stream_phase_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);
INSERT INTO control_plane.sync_stream_phase_status_lookup(status,description) VALUES
  ('planned','Required phase is durable and awaits publication'),
  ('queued','A versioned queue request exists for this phase'),
  ('running','A visibility-fenced worker is executing the phase'),
  ('succeeded','The phase reached a terminal vendor page and committed'),
  ('failed','A terminal queue attempt failed and must be replayed'),
  ('unavailable','An optional vendor stream is durably unavailable')
ON CONFLICT(status) DO UPDATE SET description=excluded.description;

CREATE TABLE IF NOT EXISTS control_plane.sync_stream_phases (
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  connection_generation bigint NOT NULL CHECK (connection_generation > 0),
  stream text NOT NULL CHECK (stream ~ '^[a-z][a-z0-9_]*$'),
  phase text NOT NULL CHECK (phase IN ('recent','thirteen_months','full_history')),
  phase_ordinal smallint NOT NULL CHECK (phase_ordinal BETWEEN 1 AND 3),
  plan_mode text NOT NULL CHECK (plan_mode IN ('progressive','resume_verified','single_pass')),
  backfill_strategy text NOT NULL CHECK (
    backfill_strategy IN ('time_windowed','snapshot','exhaustive_offset')
  ),
  required boolean NOT NULL,
  domains text[] NOT NULL CHECK (cardinality(domains) > 0),
  range_from timestamptz NOT NULL,
  range_to timestamptz NOT NULL,
  predecessor_phase text CHECK (
    predecessor_phase IS NULL OR predecessor_phase IN ('recent','thirteen_months')
  ),
  status text NOT NULL DEFAULT 'planned'
    REFERENCES control_plane.sync_stream_phase_status_lookup(status),
  replay_version integer NOT NULL DEFAULT 1 CHECK (replay_version > 0),
  last_job_request_id text,
  coverage_boundary_kind text,
  coverage_lower_bound timestamptz,
  coverage_verification text,
  coverage_detail text,
  inherited_coverage boolean NOT NULL DEFAULT false,
  last_error jsonb,
  -- Gives a healthy coordinator time to publish normally. If it crashes or
  -- exhausts attempts, the fixed recovery job owns publication after this
  -- bounded grace period.
  available_at timestamptz NOT NULL DEFAULT (now()+interval '5 minutes'),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,connection_id,connection_generation,stream,phase),
  UNIQUE (tenant_id,connection_id,connection_generation,stream,phase_ordinal),
  FOREIGN KEY (tenant_id,connection_id)
    REFERENCES control_plane.connections(tenant_id,connection_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,last_job_request_id)
    REFERENCES control_plane.sync_job_requests(tenant_id,job_request_id)
    ON DELETE SET NULL (last_job_request_id),
  CHECK (range_from < range_to),
  CHECK (last_error IS NULL OR jsonb_typeof(last_error)='object'),
  CHECK (
    (coverage_boundary_kind IS NULL AND coverage_lower_bound IS NULL AND coverage_verification IS NULL)
    OR (
      coverage_boundary_kind IN (
        'verified_oldest','verified_empty','account_start','vendor_retention','snapshot_at'
      )
      AND coverage_lower_bound IS NOT NULL
      AND coverage_verification IN (
        'exhaustive_vendor_scan','vendor_reported','account_metadata','point_in_time'
      )
    )
  ),
  CHECK ((status IN ('succeeded','unavailable')) = (completed_at IS NOT NULL))
);

ALTER TABLE control_plane.sync_stream_phases
  ALTER COLUMN available_at SET DEFAULT (now()+interval '5 minutes');

CREATE INDEX IF NOT EXISTS sync_stream_phases_recovery_idx
  ON control_plane.sync_stream_phases(status,available_at,updated_at)
  WHERE status IN ('planned','queued','running','failed');

ALTER TABLE control_plane.sync_stream_phases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_members_read ON control_plane.sync_stream_phases;
CREATE POLICY tenant_members_read ON control_plane.sync_stream_phases
  FOR SELECT TO authenticated USING (control_plane.is_tenant_member(tenant_id));
DROP POLICY IF EXISTS sync_runtime_access ON control_plane.sync_stream_phases;
CREATE POLICY sync_runtime_access ON control_plane.sync_stream_phases
  FOR ALL TO albert_sync_control USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS sync_stream_phases_touch_updated_at
  ON control_plane.sync_stream_phases;
CREATE TRIGGER sync_stream_phases_touch_updated_at
  BEFORE UPDATE ON control_plane.sync_stream_phases
  FOR EACH ROW EXECUTE FUNCTION control_plane.touch_updated_at();

-- Every publication is bound to the generation locked from the connection
-- row. SQL schedulers and webhook inboxes that omit the new field during a
-- rolling deploy are upgraded inside the transaction; a caller may never
-- supply a different generation.
CREATE OR REPLACE FUNCTION control_plane.enqueue_sync_job(
  p_payload jsonb,p_priority text,p_idempotency_key text,p_delay_seconds integer DEFAULT 0
) RETURNS TABLE(job_request_id text,queue_message_id bigint,queue_name text,created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pgmq AS $$
DECLARE
  payload_tenant text:=p_payload->>'tenantId';
  payload_connection text:=p_payload->>'connectionId';
  payload_job_type text:=p_payload->>'type';
  selected_queue text;generated_job_id text;generated_message_id bigint;
  current_generation bigint;supplied_generation bigint;effective_key text;
BEGIN
  PERFORM control_plane.assert_pgmq_ready();
  IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object'
     OR payload_tenant IS NULL OR payload_connection IS NULL
     OR payload_job_type NOT IN ('InitialBackfill','IncrementalSync','ReconciliationSweep')
     OR p_priority NOT IN ('high','standard','backfill')
     OR length(btrim(p_idempotency_key)) < 8
     OR p_delay_seconds NOT BETWEEN 0 AND 604800 THEN
    RAISE EXCEPTION 'sync job request is invalid' USING ERRCODE='22023';
  END IF;
  SELECT connection.connection_generation INTO current_generation
    FROM control_plane.connections AS connection
   WHERE connection.tenant_id=payload_tenant
     AND connection.connection_id=payload_connection
     AND connection.status<>'disconnected'
   FOR SHARE;
  IF current_generation IS NULL THEN
    RAISE EXCEPTION 'active connection was not found' USING ERRCODE='P0002';
  END IF;
  IF p_payload ? 'connectionGeneration' THEN
    BEGIN supplied_generation:=(p_payload->>'connectionGeneration')::bigint;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'sync job connection generation is invalid' USING ERRCODE='22023';
    END;
    IF supplied_generation<>current_generation THEN
      RAISE EXCEPTION 'sync job connection generation is stale' USING ERRCODE='55000';
    END IF;
  END IF;
  p_payload:=p_payload||jsonb_build_object('connectionGeneration',current_generation);
  IF payload_job_type='InitialBackfill' THEN
    p_payload:=p_payload||jsonb_build_object(
      'replayVersion',coalesce((p_payload->>'replayVersion')::integer,1),
      'planMode',coalesce(p_payload->>'planMode','progressive')
    );
  END IF;
  effective_key:=p_idempotency_key||':g'||current_generation::text;
  IF length(effective_key)>240 THEN
    RAISE EXCEPTION 'sync job idempotency key is too long' USING ERRCODE='22023';
  END IF;

  SELECT request.job_request_id,request.queue_message_id,request.queue_name,false
    INTO job_request_id,queue_message_id,queue_name,created
    FROM control_plane.sync_job_requests AS request
   WHERE request.tenant_id=payload_tenant AND request.idempotency_key=effective_key;
  IF FOUND THEN RETURN NEXT;RETURN; END IF;

  selected_queue:=CASE p_priority WHEN 'high' THEN 'albert_sync_high'
    WHEN 'standard' THEN 'albert_sync_standard' ELSE 'albert_sync_backfill' END;
  generated_job_id:=control_plane.generate_ulid();
  SELECT send INTO generated_message_id FROM pgmq.send(
    selected_queue,p_payload||jsonb_build_object('jobRequestId',generated_job_id),p_delay_seconds
  );
  INSERT INTO control_plane.sync_job_requests(
    tenant_id,job_request_id,connection_id,idempotency_key,job_type,priority,
    queue_name,queue_message_id,payload,status,available_at
  ) VALUES (
    payload_tenant,generated_job_id,payload_connection,effective_key,payload_job_type,
    p_priority,selected_queue,generated_message_id,
    p_payload||jsonb_build_object('jobRequestId',generated_job_id),'queued',
    now()+make_interval(secs=>p_delay_seconds)
  );
  job_request_id:=generated_job_id;queue_message_id:=generated_message_id;
  queue_name:=selected_queue;created:=true;RETURN NEXT;
EXCEPTION WHEN unique_violation THEN
  SELECT request.job_request_id,request.queue_message_id,request.queue_name,false
    INTO job_request_id,queue_message_id,queue_name,created
    FROM control_plane.sync_job_requests AS request
   WHERE request.tenant_id=payload_tenant AND request.idempotency_key=effective_key;
  IF FOUND THEN RETURN NEXT;RETURN;END IF;RAISE;
END;
$$;

-- Registration is immutable for one generation/stream/phase. A coordinator
-- replay may repeat the exact plan, but cannot silently change its ranges,
-- strategy, dependency or carried-forward coverage.
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
BEGIN
  IF p_connection_generation < 1 OR p_stream !~ '^[a-z][a-z0-9_]*$'
     OR p_phase NOT IN ('recent','thirteen_months','full_history')
     OR p_phase_ordinal NOT BETWEEN 1 AND 3
     OR p_plan_mode NOT IN ('progressive','resume_verified','single_pass')
     OR p_backfill_strategy NOT IN ('time_windowed','snapshot','exhaustive_offset')
     OR p_domains IS NULL OR cardinality(p_domains)=0
     OR EXISTS (
       SELECT 1 FROM unnest(p_domains) AS domain_name(value)
        WHERE value !~ '^[a-z][a-z0-9_]*$'
     )
     OR p_range_from >= p_range_to
     OR (p_inherited_coverage IS NOT NULL AND jsonb_typeof(p_inherited_coverage)<>'object') THEN
    RAISE EXCEPTION 'sync stream phase registration is invalid' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM control_plane.connections AS connection
   WHERE connection.tenant_id=p_tenant_id
     AND connection.connection_id=p_connection_id
     AND connection.connection_generation=p_connection_generation
     AND connection.status IN ('connected','degraded')
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sync stream phase generation is stale' USING ERRCODE='55000';
  END IF;

  SELECT * INTO existing FROM control_plane.sync_stream_phases AS phase
   WHERE phase.tenant_id=p_tenant_id AND phase.connection_id=p_connection_id
     AND phase.connection_generation=p_connection_generation
     AND phase.stream=p_stream AND phase.phase=p_phase;
  IF FOUND THEN
    IF existing.phase_ordinal<>p_phase_ordinal
       OR existing.plan_mode<>p_plan_mode
       OR existing.backfill_strategy<>p_backfill_strategy
       OR existing.required<>p_required
       OR existing.domains<>ARRAY(
         SELECT DISTINCT value
           FROM unnest(p_domains) AS domain_name(value)
          ORDER BY value
       )
       OR existing.range_from<>p_range_from OR existing.range_to<>p_range_to
       OR existing.predecessor_phase IS DISTINCT FROM p_predecessor_phase THEN
      RAISE EXCEPTION 'sync stream phase plan is immutable' USING ERRCODE='23505';
    END IF;
    RETURN;
  END IF;

  INSERT INTO control_plane.sync_stream_phases(
    tenant_id,connection_id,connection_generation,stream,phase,phase_ordinal,
    plan_mode,backfill_strategy,required,domains,range_from,range_to,
    predecessor_phase,coverage_boundary_kind,coverage_lower_bound,
    coverage_verification,coverage_detail,inherited_coverage
  ) VALUES (
    p_tenant_id,p_connection_id,p_connection_generation,p_stream,p_phase,p_phase_ordinal,
    p_plan_mode,p_backfill_strategy,p_required,
    ARRAY(
      SELECT DISTINCT value
        FROM unnest(p_domains) AS domain_name(value)
       ORDER BY value
    ),
    p_range_from,p_range_to,p_predecessor_phase,
    p_inherited_coverage->>'boundaryKind',
    nullif(p_inherited_coverage->>'lowerBound','')::timestamptz,
    p_inherited_coverage->>'verification',
    nullif(p_inherited_coverage->>'detail',''),
    p_inherited_coverage IS NOT NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.mark_sync_stream_phase_enqueued(
  p_tenant_id text,p_connection_id text,p_connection_generation bigint,
  p_stream text,p_phase text,p_replay_version integer,p_job_request_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  UPDATE control_plane.sync_stream_phases AS phase_row
     SET status='queued',replay_version=p_replay_version,
         last_job_request_id=p_job_request_id,last_error=NULL,available_at=now()
   WHERE phase_row.tenant_id=p_tenant_id AND phase_row.connection_id=p_connection_id
     AND phase_row.connection_generation=p_connection_generation
     AND phase_row.stream=p_stream AND phase_row.phase=p_phase
     AND phase_row.status IN ('planned','queued','running','failed')
     AND phase_row.replay_version<=p_replay_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sync stream phase enqueue target is stale' USING ERRCODE='55000';
  END IF;
END;
$$;

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
  UPDATE control_plane.sync_stream_phases AS phase_row
     SET status='unavailable',last_error=p_error,completed_at=now()
   WHERE phase_row.tenant_id=p_tenant_id AND phase_row.connection_id=p_connection_id
     AND phase_row.connection_generation=p_connection_generation
     AND phase_row.stream=p_stream AND phase_row.phase=p_phase
     AND phase_row.replay_version=p_replay_version
     AND phase_row.required=false AND phase_row.status IN ('queued','running','failed');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'optional stream unavailable target is stale or required' USING ERRCODE='55000';
  END IF;
END;
$$;

-- A scheduler always reconstructs work from the immutable phase plan. Failed
-- requests receive a new replay version, sync run, batch and idempotency key.
CREATE OR REPLACE FUNCTION control_plane.recover_sync_stream_phases(
  p_now timestamptz DEFAULT now(),p_limit integer DEFAULT 200
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE candidate record; next_replay integer; payload jsonb; receipt record; recovered integer:=0;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'sync phase recovery limit is invalid' USING ERRCODE='22023';
  END IF;
  FOR candidate IN
    SELECT phase_row.*,connection.connector_key,connection.external_account_reference,
           request.status AS request_status
      FROM control_plane.sync_stream_phases AS phase_row
      JOIN control_plane.connections AS connection
        ON connection.tenant_id=phase_row.tenant_id
       AND connection.connection_id=phase_row.connection_id
       AND connection.connection_generation=phase_row.connection_generation
      LEFT JOIN control_plane.sync_job_requests AS request
        ON request.tenant_id=phase_row.tenant_id
       AND request.job_request_id=phase_row.last_job_request_id
     WHERE connection.status IN ('connected','degraded')
       AND connection.external_account_reference IS NOT NULL
       AND phase_row.available_at<=p_now
       AND (
         (phase_row.status='planned' AND (
           phase_row.predecessor_phase IS NULL OR EXISTS (
             SELECT 1 FROM control_plane.sync_stream_phases predecessor
              WHERE predecessor.tenant_id=phase_row.tenant_id
                AND predecessor.connection_id=phase_row.connection_id
                AND predecessor.connection_generation=phase_row.connection_generation
                AND predecessor.stream=phase_row.stream
                AND predecessor.phase=phase_row.predecessor_phase
                AND predecessor.status='succeeded'
           )
         ))
         OR phase_row.status='failed'
         OR (
           phase_row.status IN ('queued','running')
           AND (
             request.job_request_id IS NULL
             OR request.status IN ('failed','succeeded')
           )
         )
       )
     ORDER BY phase_row.available_at,phase_row.updated_at
     FOR UPDATE OF phase_row SKIP LOCKED
     LIMIT p_limit
  LOOP
    next_replay:=CASE
      WHEN candidate.status='failed' OR candidate.request_status IN ('failed','succeeded')
        THEN candidate.replay_version+1
      ELSE candidate.replay_version
    END;
    payload:=jsonb_build_object(
      'schemaVersion',1,'type','InitialBackfill',
      'tenantId',candidate.tenant_id,'connectionId',candidate.connection_id,
      'connectionGeneration',candidate.connection_generation,
      'connectorId',candidate.connector_key,
      'externalAccountReference',candidate.external_account_reference,
      'syncRunId',control_plane.generate_ulid(),'batchId',control_plane.generate_ulid(),
      'requestedAt',p_now,'stream',candidate.stream,
      'range',jsonb_build_object('from',candidate.range_from,'to',candidate.range_to),
      'phase',candidate.phase,'replayVersion',next_replay,'planMode',candidate.plan_mode
    );
    SELECT * INTO receipt FROM control_plane.enqueue_sync_job(
      payload,'backfill',
      'backfill-phase:'||candidate.connection_id||':g'||candidate.connection_generation::text||
      ':'||candidate.stream||':'||candidate.phase||':v'||next_replay::text,0
    );
    UPDATE control_plane.sync_stream_phases AS phase_row
       SET status='queued',replay_version=next_replay,
           last_job_request_id=receipt.job_request_id,last_error=NULL,available_at=p_now
     WHERE phase_row.tenant_id=candidate.tenant_id
       AND phase_row.connection_id=candidate.connection_id
       AND phase_row.connection_generation=candidate.connection_generation
       AND phase_row.stream=candidate.stream AND phase_row.phase=candidate.phase;
    recovered:=recovered+1;
  END LOOP;
  RETURN recovered;
END;
$$;

-- Readiness consumers receive one generation-consistent snapshot and the
-- worst state across every required stream. A clean sibling can no longer
-- overwrite a failed or incomplete stream.
CREATE OR REPLACE FUNCTION control_plane.sync_readiness_inputs(
  p_tenant_id text,p_connection_id text,p_streams text[],
  p_current_batch_id text,p_current_quality text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE generation bigint; result jsonb;
BEGIN
  IF p_streams IS NULL OR cardinality(p_streams)=0
     OR EXISTS (
       SELECT 1 FROM unnest(p_streams) AS stream_name(value)
        WHERE value !~ '^[a-z][a-z0-9_]*$'
     )
     OR NOT control_plane.is_ulid(p_current_batch_id)
     OR p_current_quality NOT IN ('passed','warning','failed','blocked') THEN
    RAISE EXCEPTION 'readiness stream set is invalid' USING ERRCODE='22023';
  END IF;
  IF nullif(current_setting('albert.tenant_id',true),'') IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'readiness tenant scope mismatch' USING ERRCODE='42501';
  END IF;
  SELECT connection_generation INTO generation FROM control_plane.connections
   WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  IF generation IS NULL THEN RAISE EXCEPTION 'readiness connection missing' USING ERRCODE='P0002'; END IF;

  WITH required_streams AS (
    SELECT DISTINCT value AS stream FROM unnest(p_streams) AS stream_name(value)
  ), latest_transform AS (
    SELECT DISTINCT ON (job.stream) job.stream,
           CASE WHEN job.batch_id=p_current_batch_id THEN 'succeeded' ELSE job.status END AS status,
           CASE WHEN job.batch_id=p_current_batch_id THEN p_current_quality
                ELSE coalesce(job.result_metadata->>'qualityStatus','blocked') END AS quality_status
      FROM control_plane.canonical_transform_jobs job
      JOIN control_plane.sync_runs run
        ON run.tenant_id=job.tenant_id AND run.sync_run_id=job.sync_run_id
      JOIN required_streams required ON required.stream=job.stream
     WHERE job.tenant_id=p_tenant_id AND job.connection_id=p_connection_id
       AND run.connection_generation=generation
     ORDER BY job.stream,job.created_at DESC,job.transform_job_id DESC
  ), stream_state AS (
    SELECT required.stream,
           cursor.backfill_complete,cursor.source_watermark,
           coalesce((
             SELECT CASE
               WHEN bool_or(phase.required AND phase.status='failed') THEN 'failed'
               WHEN bool_or(phase.required AND phase.status IN ('planned','queued','running')) THEN 'incomplete'
               WHEN bool_and(phase.status IN ('succeeded','unavailable')) THEN 'complete'
               ELSE 'missing'
             END
             FROM control_plane.sync_stream_phases phase
             WHERE phase.tenant_id=p_tenant_id AND phase.connection_id=p_connection_id
               AND phase.connection_generation=generation AND phase.stream=required.stream
           ),'missing') AS phase_state,
           transform.status AS transform_status,transform.quality_status
      FROM required_streams required
      LEFT JOIN control_plane.stream_cursors cursor
        ON cursor.tenant_id=p_tenant_id AND cursor.connection_id=p_connection_id
       AND cursor.connection_generation=generation AND cursor.stream=required.stream
      LEFT JOIN latest_transform transform ON transform.stream=required.stream
  )
  SELECT jsonb_build_object(
    'connectionGeneration',generation,
    'streams',coalesce(jsonb_agg(jsonb_build_object(
      'stream',stream,'backfillComplete',coalesce(backfill_complete,false),
      'sourceWatermark',source_watermark,'phaseState',phase_state,
      'transformStatus',transform_status,'qualityStatus',quality_status
    ) ORDER BY stream),'[]'::jsonb),
    'worstState',CASE
      WHEN bool_or(phase_state='failed' OR transform_status='failed' OR quality_status='blocked') THEN 'blocked'
      WHEN bool_or(quality_status='failed') THEN 'degraded'
      WHEN bool_or(phase_state IN ('missing','incomplete') OR transform_status IS NULL OR transform_status<>'succeeded') THEN 'incomplete'
      WHEN bool_or(quality_status='warning') THEN 'warning'
      ELSE 'passed'
    END
  ) INTO result FROM stream_state;
  RETURN result;
END;
$$;

GRANT SELECT,INSERT,UPDATE ON control_plane.sync_stream_phases TO albert_sync_control;
GRANT SELECT ON control_plane.sync_stream_phases TO authenticated;
GRANT SELECT (tenant_id,connection_id,connection_generation,connector_key,status)
  ON control_plane.connections TO albert_transform_control;
GRANT SELECT (tenant_id,sync_run_id,connection_generation)
  ON control_plane.sync_runs TO albert_transform_control;
GRANT SELECT (tenant_id,connection_id,stream,connection_generation,backfill_complete,source_watermark)
  ON control_plane.stream_cursors TO albert_transform_control;

REVOKE ALL ON FUNCTION control_plane.register_sync_stream_phase(
  text,text,bigint,text,text,integer,text,text,boolean,text[],timestamptz,timestamptz,text,jsonb
) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION control_plane.mark_sync_stream_phase_enqueued(
  text,text,bigint,text,text,integer,text
) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION control_plane.mark_sync_stream_phase_unavailable(
  text,text,bigint,text,text,integer,jsonb
) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION control_plane.recover_sync_stream_phases(timestamptz,integer)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION control_plane.sync_readiness_inputs(text,text,text[],text,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION control_plane.register_sync_stream_phase(
  text,text,bigint,text,text,integer,text,text,boolean,text[],timestamptz,timestamptz,text,jsonb
) TO albert_sync_control;
GRANT EXECUTE ON FUNCTION control_plane.mark_sync_stream_phase_enqueued(
  text,text,bigint,text,text,integer,text
) TO albert_sync_control;
GRANT EXECUTE ON FUNCTION control_plane.mark_sync_stream_phase_unavailable(
  text,text,bigint,text,text,integer,jsonb
) TO albert_sync_control;
GRANT EXECUTE ON FUNCTION control_plane.sync_readiness_inputs(text,text,text[],text,text)
  TO albert_transform_control;

SELECT extensions.albert_install_sync_lifecycle_cron_job();

COMMIT;
