BEGIN;

CREATE TABLE IF NOT EXISTS control_plane.reconciliation_stream_sweeps (
  tenant_id text NOT NULL CHECK (control_plane.is_ulid(tenant_id)),
  connection_id text NOT NULL CHECK (control_plane.is_ulid(connection_id)),
  connection_generation bigint NOT NULL CHECK (connection_generation > 0),
  reconciliation_sweep_id text NOT NULL CHECK (control_plane.is_ulid(reconciliation_sweep_id)),
  connector_id text NOT NULL CHECK (connector_id IN ('lightspeed-r','xero','deputy')),
  stream text NOT NULL CHECK (stream ~ '^[a-z][a-z0-9_]*$'),
  required boolean NOT NULL,
  domains text[] NOT NULL CHECK (cardinality(domains) > 0),
  late_edit_strategy text NOT NULL CHECK (
    late_edit_strategy IN ('modified_field','full_snapshot','append_only')
  ),
  deletion_strategy text NOT NULL CHECK (
    deletion_strategy IN (
      'soft_delete','verified_delete_feed','authoritative_identity_scan','immutable_append_only'
    )
  ),
  source_total_strategy text NOT NULL CHECK (
    source_total_strategy IN ('provider_reported','count_distinct_complete_scan')
  ),
  lookback_from timestamptz NOT NULL,
  lookback_to timestamptz NOT NULL,
  current_phase text NOT NULL DEFAULT 'late_edits' CHECK (
    current_phase IN ('late_edits','identity_snapshot','verify_snapshot','apply_tombstones','complete')
  ),
  status text NOT NULL DEFAULT 'planned' CHECK (
    status IN ('planned','running','complete','blocked')
  ),
  phase_evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(phase_evidence)='object'),
  phase_transition_leases jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(phase_transition_leases)='object'),
  last_job_request_id text,
  active_queue_name text CHECK (
    active_queue_name IS NULL OR active_queue_name IN (
      'albert_sync_high','albert_sync_standard','albert_sync_backfill'
    )
  ),
  active_message_id bigint,
  active_worker_id text,
  active_read_count integer CHECK (active_read_count IS NULL OR active_read_count > 0),
  last_error jsonb CHECK (last_error IS NULL OR jsonb_typeof(last_error)='object'),
  phase_started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (
    tenant_id,connection_id,connection_generation,reconciliation_sweep_id,stream
  ),
  FOREIGN KEY (tenant_id,connection_id)
    REFERENCES control_plane.connections(tenant_id,connection_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,last_job_request_id)
    REFERENCES control_plane.sync_job_requests(tenant_id,job_request_id)
    ON DELETE SET NULL (last_job_request_id),
  CHECK (lookback_from <= lookback_to),
  CHECK ((status='complete')=(completed_at IS NOT NULL)),
  CHECK (
    (active_queue_name IS NULL AND active_message_id IS NULL AND active_worker_id IS NULL AND active_read_count IS NULL)
    OR
    (active_queue_name IS NOT NULL AND active_message_id IS NOT NULL AND active_worker_id IS NOT NULL AND active_read_count IS NOT NULL)
  ),
  CHECK (
    deletion_strategy<>'immutable_append_only' OR late_edit_strategy='append_only'
  )
);

CREATE INDEX IF NOT EXISTS reconciliation_stream_sweeps_current_idx
  ON control_plane.reconciliation_stream_sweeps (
    tenant_id,connection_id,connection_generation,status,current_phase,updated_at
  );

ALTER TABLE control_plane.reconciliation_stream_sweeps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_members_read ON control_plane.reconciliation_stream_sweeps;
CREATE POLICY tenant_members_read ON control_plane.reconciliation_stream_sweeps
  FOR SELECT TO authenticated USING (control_plane.is_tenant_member(tenant_id));
DROP POLICY IF EXISTS sync_runtime_access ON control_plane.reconciliation_stream_sweeps;
DROP POLICY IF EXISTS sync_runtime_read ON control_plane.reconciliation_stream_sweeps;
CREATE POLICY sync_runtime_read ON control_plane.reconciliation_stream_sweeps
  FOR SELECT TO albert_sync_control USING (true);

DROP TRIGGER IF EXISTS reconciliation_stream_sweeps_touch_updated_at
  ON control_plane.reconciliation_stream_sweeps;
CREATE TRIGGER reconciliation_stream_sweeps_touch_updated_at
  BEFORE UPDATE ON control_plane.reconciliation_stream_sweeps
  FOR EACH ROW EXECUTE FUNCTION control_plane.touch_updated_at();

CREATE OR REPLACE FUNCTION control_plane.register_reconciliation_stream(
  p_tenant_id text,
  p_connection_id text,
  p_connection_generation bigint,
  p_reconciliation_sweep_id text,
  p_connector_id text,
  p_stream text,
  p_required boolean,
  p_domains text[],
  p_late_edit_strategy text,
  p_deletion_strategy text,
  p_source_total_strategy text,
  p_lookback_from timestamptz,
  p_lookback_to timestamptz
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE existing control_plane.reconciliation_stream_sweeps%ROWTYPE;
BEGIN
  IF NOT control_plane.is_ulid(p_tenant_id)
     OR NOT control_plane.is_ulid(p_connection_id)
     OR NOT control_plane.is_ulid(p_reconciliation_sweep_id)
     OR p_connection_generation < 1
     OR p_connector_id NOT IN ('lightspeed-r','xero','deputy')
     OR p_stream !~ '^[a-z][a-z0-9_]*$'
     OR coalesce(cardinality(p_domains),0)=0
     OR p_late_edit_strategy NOT IN ('modified_field','full_snapshot','append_only')
     OR p_deletion_strategy NOT IN (
       'soft_delete','verified_delete_feed','authoritative_identity_scan','immutable_append_only'
     )
     OR p_source_total_strategy NOT IN ('provider_reported','count_distinct_complete_scan')
     OR p_lookback_from > p_lookback_to
     OR (p_deletion_strategy='immutable_append_only' AND p_late_edit_strategy<>'append_only') THEN
    RAISE EXCEPTION 'reconciliation stream registration is invalid' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.connections connection
     WHERE connection.tenant_id=p_tenant_id
       AND connection.connection_id=p_connection_id
       AND connection.connector_key=p_connector_id
       AND connection.connection_generation=p_connection_generation
       AND connection.status IN ('connected','degraded')
  ) THEN
    RAISE EXCEPTION 'reconciliation connection generation is stale' USING ERRCODE='55000';
  END IF;

  SELECT * INTO existing
    FROM control_plane.reconciliation_stream_sweeps
   WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id
     AND connection_generation=p_connection_generation
     AND reconciliation_sweep_id=p_reconciliation_sweep_id AND stream=p_stream
   FOR UPDATE;
  IF FOUND THEN
    IF existing.connector_id<>p_connector_id OR existing.required<>p_required
       OR existing.domains<>p_domains
       OR existing.late_edit_strategy<>p_late_edit_strategy
       OR existing.deletion_strategy<>p_deletion_strategy
       OR existing.source_total_strategy<>p_source_total_strategy
       OR existing.lookback_from<>p_lookback_from OR existing.lookback_to<>p_lookback_to THEN
      RAISE EXCEPTION 'reconciliation stream registration conflicts with durable plan'
        USING ERRCODE='55000';
    END IF;
    RETURN;
  END IF;

  INSERT INTO control_plane.reconciliation_stream_sweeps (
    tenant_id,connection_id,connection_generation,reconciliation_sweep_id,
    connector_id,stream,required,domains,late_edit_strategy,deletion_strategy,
    source_total_strategy,lookback_from,lookback_to
  ) VALUES (
    p_tenant_id,p_connection_id,p_connection_generation,p_reconciliation_sweep_id,
    p_connector_id,p_stream,p_required,p_domains,p_late_edit_strategy,p_deletion_strategy,
    p_source_total_strategy,p_lookback_from,p_lookback_to
  );
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.begin_reconciliation_phase(
  p_tenant_id text,
  p_connection_id text,
  p_connection_generation bigint,
  p_reconciliation_sweep_id text,
  p_stream text,
  p_phase text,
  p_job_request_id text,
  p_queue_name text,
  p_message_id bigint,
  p_worker_id text,
  p_read_count integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF p_phase NOT IN ('late_edits','identity_snapshot','verify_snapshot','apply_tombstones')
     OR NOT control_plane.is_ulid(p_job_request_id) THEN
    RAISE EXCEPTION 'reconciliation phase lease is invalid' USING ERRCODE='22023';
  END IF;
  IF control_plane.require_active_sync_job_lease(
    p_queue_name,p_message_id,p_job_request_id,p_worker_id,p_read_count
  )<>p_tenant_id THEN
    RAISE EXCEPTION 'reconciliation lease tenant mismatch' USING ERRCODE='42501';
  END IF;
  UPDATE control_plane.reconciliation_stream_sweeps sweep
     SET status='running',phase_started_at=coalesce(phase_started_at,now()),
         last_job_request_id=p_job_request_id,last_error=NULL,
         active_queue_name=p_queue_name,active_message_id=p_message_id,
         active_worker_id=p_worker_id,active_read_count=p_read_count
   WHERE sweep.tenant_id=p_tenant_id AND sweep.connection_id=p_connection_id
     AND sweep.connection_generation=p_connection_generation
     AND sweep.reconciliation_sweep_id=p_reconciliation_sweep_id
     AND sweep.stream=p_stream AND sweep.current_phase=p_phase
     AND sweep.status IN ('planned','running')
     AND EXISTS (
       SELECT 1 FROM control_plane.sync_job_requests request
        WHERE request.tenant_id=sweep.tenant_id
          AND request.connection_id=sweep.connection_id
          AND request.job_request_id=p_job_request_id
          AND request.job_type='ReconciliationSweep'
          AND (request.payload->>'connectionGeneration')::bigint=sweep.connection_generation
          AND request.payload->>'reconciliationSweepId'=sweep.reconciliation_sweep_id
          AND request.payload->>'stream'=sweep.stream
          AND coalesce(request.payload->>'phase','late_edits')=p_phase
     )
     AND EXISTS (
       SELECT 1 FROM control_plane.connections connection
        WHERE connection.tenant_id=sweep.tenant_id
          AND connection.connection_id=sweep.connection_id
          AND connection.connection_generation=sweep.connection_generation
          AND connection.status IN ('connected','degraded')
     );
  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM control_plane.reconciliation_stream_sweeps sweep
      JOIN control_plane.sync_job_requests request
        ON request.tenant_id=sweep.tenant_id
       AND request.connection_id=sweep.connection_id
       AND request.job_request_id=p_job_request_id
       AND request.job_type='ReconciliationSweep'
     WHERE sweep.tenant_id=p_tenant_id AND sweep.connection_id=p_connection_id
       AND sweep.connection_generation=p_connection_generation
       AND sweep.reconciliation_sweep_id=p_reconciliation_sweep_id
       AND sweep.stream=p_stream AND sweep.phase_evidence ? p_phase
       AND (request.payload->>'connectionGeneration')::bigint=sweep.connection_generation
       AND request.payload->>'reconciliationSweepId'=sweep.reconciliation_sweep_id
       AND request.payload->>'stream'=sweep.stream
       AND coalesce(request.payload->>'phase','late_edits')=p_phase
    ) THEN
      RETURN false;
    END IF;
    RAISE EXCEPTION 'reconciliation phase or generation is stale' USING ERRCODE='55000';
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.complete_reconciliation_phase(
  p_tenant_id text,
  p_connection_id text,
  p_connection_generation bigint,
  p_reconciliation_sweep_id text,
  p_stream text,
  p_phase text,
  p_evidence jsonb,
  p_job_request_id text,p_queue_name text,p_message_id bigint,
  p_worker_id text,p_read_count integer
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE next_phase text;
DECLARE lease_evidence jsonb;
BEGIN
  IF p_phase NOT IN ('late_edits','identity_snapshot','verify_snapshot','apply_tombstones')
     OR p_evidence IS NULL OR jsonb_typeof(p_evidence)<>'object'
     OR octet_length(p_evidence::text)>65536 THEN
    RAISE EXCEPTION 'reconciliation phase evidence is invalid' USING ERRCODE='22023';
  END IF;
  IF control_plane.require_active_sync_job_lease(
    p_queue_name,p_message_id,p_job_request_id,p_worker_id,p_read_count
  )<>p_tenant_id THEN
    RAISE EXCEPTION 'reconciliation lease tenant mismatch' USING ERRCODE='42501';
  END IF;
  lease_evidence:=jsonb_build_object(
    'jobRequestId',p_job_request_id,'queueName',p_queue_name,
    'messageId',p_message_id,'workerId',p_worker_id,'readCount',p_read_count
  );
  next_phase:=CASE p_phase
    WHEN 'late_edits' THEN 'identity_snapshot'
    WHEN 'identity_snapshot' THEN 'verify_snapshot'
    WHEN 'verify_snapshot' THEN 'apply_tombstones'
    ELSE 'complete'
  END;
  UPDATE control_plane.reconciliation_stream_sweeps sweep
     SET current_phase=next_phase,
         status=CASE WHEN next_phase='complete' THEN 'complete' ELSE 'planned' END,
         completed_at=CASE WHEN next_phase='complete' THEN now() ELSE NULL END,
         phase_started_at=NULL,
         phase_evidence=jsonb_set(sweep.phase_evidence,ARRAY[p_phase],p_evidence,true),
         phase_transition_leases=jsonb_set(
           sweep.phase_transition_leases,ARRAY[p_phase],lease_evidence,true
         ),
         last_error=NULL,
         active_queue_name=NULL,active_message_id=NULL,
         active_worker_id=NULL,active_read_count=NULL
   WHERE sweep.tenant_id=p_tenant_id AND sweep.connection_id=p_connection_id
     AND sweep.connection_generation=p_connection_generation
     AND sweep.reconciliation_sweep_id=p_reconciliation_sweep_id
     AND sweep.stream=p_stream AND sweep.current_phase=p_phase
     AND sweep.status='running' AND sweep.last_job_request_id=p_job_request_id
     AND sweep.active_queue_name=p_queue_name AND sweep.active_message_id=p_message_id
     AND sweep.active_worker_id=p_worker_id AND sweep.active_read_count=p_read_count
     AND EXISTS (
       SELECT 1 FROM control_plane.connections connection
        WHERE connection.tenant_id=sweep.tenant_id
          AND connection.connection_id=sweep.connection_id
          AND connection.connection_generation=sweep.connection_generation
          AND connection.status IN ('connected','degraded')
     );
  IF NOT FOUND THEN
    -- A replay of the exact completed transition is harmless.
    IF EXISTS (
      SELECT 1 FROM control_plane.reconciliation_stream_sweeps sweep
       WHERE sweep.tenant_id=p_tenant_id AND sweep.connection_id=p_connection_id
         AND sweep.connection_generation=p_connection_generation
         AND sweep.reconciliation_sweep_id=p_reconciliation_sweep_id
         AND sweep.stream=p_stream AND sweep.phase_evidence->p_phase=p_evidence
         AND sweep.phase_transition_leases->p_phase=lease_evidence
         AND sweep.last_job_request_id=p_job_request_id
    ) THEN
      RETURN next_phase;
    END IF;
    RAISE EXCEPTION 'reconciliation phase completion is stale' USING ERRCODE='55000';
  END IF;
  RETURN next_phase;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.block_reconciliation_phase(
  p_tenant_id text,p_connection_id text,p_connection_generation bigint,
  p_reconciliation_sweep_id text,p_stream text,p_phase text,p_error jsonb,
  p_job_request_id text,p_queue_name text,p_message_id bigint,
  p_worker_id text,p_read_count integer
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE lease_evidence jsonb;
BEGIN
  IF p_phase NOT IN ('late_edits','identity_snapshot','verify_snapshot','apply_tombstones')
     OR NOT control_plane.is_ulid(p_job_request_id)
     OR p_error IS NULL OR jsonb_typeof(p_error)<>'object'
     OR octet_length(p_error::text)>8192 THEN
    RAISE EXCEPTION 'reconciliation failure evidence is invalid' USING ERRCODE='22023';
  END IF;
  IF control_plane.require_active_sync_job_lease(
    p_queue_name,p_message_id,p_job_request_id,p_worker_id,p_read_count
  )<>p_tenant_id THEN
    RAISE EXCEPTION 'reconciliation lease tenant mismatch' USING ERRCODE='42501';
  END IF;
  lease_evidence:=jsonb_build_object(
    'jobRequestId',p_job_request_id,'queueName',p_queue_name,
    'messageId',p_message_id,'workerId',p_worker_id,'readCount',p_read_count
  );
  UPDATE control_plane.reconciliation_stream_sweeps
     SET status='blocked',last_error=p_error,
         phase_transition_leases=jsonb_set(
           phase_transition_leases,ARRAY[p_phase],lease_evidence,true
         ),
         active_queue_name=NULL,active_message_id=NULL,
         active_worker_id=NULL,active_read_count=NULL
   WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id
     AND connection_generation=p_connection_generation
     AND reconciliation_sweep_id=p_reconciliation_sweep_id
     AND stream=p_stream AND current_phase=p_phase AND status='running'
     AND last_job_request_id=p_job_request_id
     AND active_queue_name=p_queue_name AND active_message_id=p_message_id
     AND active_worker_id=p_worker_id AND active_read_count=p_read_count
     AND EXISTS (
       SELECT 1 FROM control_plane.connections connection
        WHERE connection.tenant_id=p_tenant_id
          AND connection.connection_id=p_connection_id
          AND connection.connection_generation=p_connection_generation
          AND connection.status IN ('connected','degraded')
     );
  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM control_plane.reconciliation_stream_sweeps sweep
       WHERE sweep.tenant_id=p_tenant_id AND sweep.connection_id=p_connection_id
         AND sweep.connection_generation=p_connection_generation
         AND sweep.reconciliation_sweep_id=p_reconciliation_sweep_id
         AND sweep.stream=p_stream AND sweep.current_phase=p_phase
         AND sweep.status='blocked' AND sweep.last_error=p_error
         AND sweep.last_job_request_id=p_job_request_id
         AND sweep.phase_transition_leases->p_phase=lease_evidence
    ) THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'reconciliation phase is stale' USING ERRCODE='55000';
  END IF;
END;
$$;

REVOKE ALL ON control_plane.reconciliation_stream_sweeps FROM PUBLIC;
REVOKE ALL ON control_plane.reconciliation_stream_sweeps FROM service_role;
GRANT SELECT ON control_plane.reconciliation_stream_sweeps TO authenticated,albert_sync_control;
REVOKE ALL ON FUNCTION control_plane.register_reconciliation_stream(
  text,text,bigint,text,text,text,boolean,text[],text,text,text,timestamptz,timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.begin_reconciliation_phase(
  text,text,bigint,text,text,text,text,text,bigint,text,integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.complete_reconciliation_phase(
  text,text,bigint,text,text,text,jsonb,text,text,bigint,text,integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.block_reconciliation_phase(
  text,text,bigint,text,text,text,jsonb,text,text,bigint,text,integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control_plane.register_reconciliation_stream(
  text,text,bigint,text,text,text,boolean,text[],text,text,text,timestamptz,timestamptz
) TO albert_sync_control;
GRANT EXECUTE ON FUNCTION control_plane.begin_reconciliation_phase(
  text,text,bigint,text,text,text,text,text,bigint,text,integer
) TO albert_sync_control;
GRANT EXECUTE ON FUNCTION control_plane.complete_reconciliation_phase(
  text,text,bigint,text,text,text,jsonb,text,text,bigint,text,integer
) TO albert_sync_control;
GRANT EXECUTE ON FUNCTION control_plane.block_reconciliation_phase(
  text,text,bigint,text,text,text,jsonb,text,text,bigint,text,integer
) TO albert_sync_control;

COMMIT;
