BEGIN;

-- M8 deletion lifecycle. A deletion is a durable, fenced job, not a UI flag.
-- Connection deletion retains the organisation and a non-sensitive connection
-- tombstone. Tenant deletion physically removes the tenant anchor after a
-- global, hash-only proof has been committed.

INSERT INTO control_plane.deletion_request_status_lookup (status, description) VALUES
  ('awaiting_approval', 'An owner created the request and must perform the second confirmation'),
  ('retry_wait', 'A durable deletion attempt will retry after its visibility delay')
ON CONFLICT (status) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO control_plane.rate_limit_policies (
  action, request_limit, window_seconds, audit_excess
) VALUES
  ('tenant.deletion_request', 3, 86400, true),
  ('tenant.deletion_approval', 5, 86400, true),
  ('tenant.deletion_cancel', 5, 86400, true)
ON CONFLICT (action) DO UPDATE SET
  request_limit = EXCLUDED.request_limit,
  window_seconds = EXCLUDED.window_seconds,
  audit_excess = EXCLUDED.audit_excess,
  enabled = true;

ALTER TABLE control_plane.deletion_requests
  ALTER COLUMN credential_destroyed_at DROP NOT NULL;
ALTER TABLE control_plane.deletion_requests
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approval_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS credential_destruction_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS queue_message_id bigint,
  ADD COLUMN IF NOT EXISTS failure_cycles integer NOT NULL DEFAULT 0 CHECK (failure_cycles >= 0),
  ADD COLUMN IF NOT EXISTS verification jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS proof_id text CHECK (proof_id IS NULL OR control_plane.is_ulid(proof_id));

ALTER TABLE control_plane.deletion_requests
  DROP CONSTRAINT IF EXISTS deletion_requests_approval_state_check;
ALTER TABLE control_plane.deletion_requests
  ADD CONSTRAINT deletion_requests_approval_state_check CHECK (
    (
      status IN ('awaiting_approval', 'cancelled')
      AND scope = 'tenant'
      AND approved_at IS NULL
      AND approved_by IS NULL
      AND credential_destroyed_at IS NULL
      AND approval_expires_at IS NOT NULL
    ) OR (
      status NOT IN ('awaiting_approval', 'cancelled')
      AND (
        scope = 'connection'
        OR (approved_at IS NOT NULL AND approved_by IS NOT NULL)
      )
    )
  );
ALTER TABLE control_plane.deletion_requests
  DROP CONSTRAINT IF EXISTS deletion_requests_credential_state_check;
ALTER TABLE control_plane.deletion_requests
  ADD CONSTRAINT deletion_requests_credential_state_check CHECK (
    credential_destroyed_at IS NOT NULL
    OR status IN ('awaiting_approval', 'cancelled', 'queued', 'running', 'retry_wait', 'failed')
  );
ALTER TABLE control_plane.deletion_requests
  DROP CONSTRAINT IF EXISTS deletion_requests_verification_object_check;
ALTER TABLE control_plane.deletion_requests
  ADD CONSTRAINT deletion_requests_verification_object_check
    CHECK (jsonb_typeof(verification) = 'object');

DROP INDEX IF EXISTS control_plane.deletion_requests_one_active_connection;
CREATE UNIQUE INDEX deletion_requests_one_active_connection
  ON control_plane.deletion_requests (tenant_id, connection_id)
  WHERE scope = 'connection'
    AND status IN ('queued', 'running', 'retry_wait', 'verifying', 'failed');
CREATE UNIQUE INDEX IF NOT EXISTS deletion_requests_one_active_tenant
  ON control_plane.deletion_requests (tenant_id)
  WHERE scope = 'tenant'
    AND status IN ('awaiting_approval', 'queued', 'running', 'retry_wait', 'verifying', 'failed');
CREATE UNIQUE INDEX IF NOT EXISTS deletion_requests_queue_message_unique
  ON control_plane.deletion_requests (queue_message_id)
  WHERE queue_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS control_plane.deletion_job_attempts (
  tenant_id text NOT NULL,
  deletion_attempt_id text NOT NULL CHECK (control_plane.is_ulid(deletion_attempt_id)),
  deletion_request_id text NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  worker_id text NOT NULL CHECK (length(btrim(worker_id)) BETWEEN 1 AND 160),
  visibility_deadline timestamptz NOT NULL,
  outcome text CHECK (outcome IN ('succeeded', 'retry', 'failed')),
  error_metadata jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (tenant_id, deletion_attempt_id),
  UNIQUE (tenant_id, deletion_request_id, attempt_number),
  FOREIGN KEY (tenant_id, deletion_request_id)
    REFERENCES control_plane.deletion_requests(tenant_id, deletion_request_id) ON DELETE CASCADE,
  CHECK (error_metadata IS NULL OR jsonb_typeof(error_metadata) = 'object'),
  CHECK ((outcome IS NULL AND finished_at IS NULL) OR (outcome IS NOT NULL AND finished_at IS NOT NULL))
);

-- A sync that has already completed its vendor request must hold this permit
-- before it can write raw Storage. Disconnect/tenant approval closes permit
-- acquisition under row locks; deletion then waits for existing permits to be
-- released (or expire after a crashed worker) before removing raw objects.
CREATE TABLE IF NOT EXISTS control_plane.sync_write_permits (
  tenant_id text NOT NULL,
  permit_id text NOT NULL CHECK (control_plane.is_ulid(permit_id)),
  connection_id text NOT NULL,
  worker_id text NOT NULL CHECK (length(btrim(worker_id)) BETWEEN 1 AND 160),
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,permit_id),
  FOREIGN KEY (tenant_id,connection_id)
    REFERENCES control_plane.connections(tenant_id,connection_id) ON DELETE CASCADE,
  CHECK (expires_at>acquired_at AND expires_at<=acquired_at+interval '30 minutes')
);
CREATE INDEX IF NOT EXISTS sync_write_permits_scope_expiry_idx
  ON control_plane.sync_write_permits(tenant_id,connection_id,expires_at);

CREATE OR REPLACE FUNCTION control_plane.acquire_sync_write_permit(
  p_tenant_id text,p_connection_id text,p_permit_id text,p_worker_id text,
  p_ttl_seconds integer DEFAULT 1200
) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE deadline timestamptz;
BEGIN
  IF NOT control_plane.is_ulid(p_tenant_id) OR NOT control_plane.is_ulid(p_connection_id)
     OR NOT control_plane.is_ulid(p_permit_id) OR length(btrim(p_worker_id)) NOT BETWEEN 1 AND 160
     OR p_ttl_seconds NOT BETWEEN 60 AND 1800 THEN
    RAISE EXCEPTION 'sync write permit input is invalid' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM control_plane.tenants tenant
  JOIN control_plane.connections connection ON connection.tenant_id=tenant.tenant_id
  WHERE tenant.tenant_id=p_tenant_id AND tenant.status='active'
    AND connection.connection_id=p_connection_id AND connection.status IN ('connected','degraded')
  FOR UPDATE OF tenant,connection;
  IF NOT FOUND OR EXISTS (
    SELECT 1 FROM control_plane.deletion_requests request
    WHERE request.tenant_id=p_tenant_id
      AND (request.scope='tenant' OR request.connection_id=p_connection_id)
      AND request.status IN ('queued','running','retry_wait','verifying','failed')
  ) THEN
    RAISE EXCEPTION 'sync write fenced by deletion' USING ERRCODE='55000';
  END IF;
  DELETE FROM control_plane.sync_write_permits WHERE expires_at<=clock_timestamp();
  deadline:=clock_timestamp()+make_interval(secs=>p_ttl_seconds);
  INSERT INTO control_plane.sync_write_permits(
    tenant_id,permit_id,connection_id,worker_id,expires_at
  ) VALUES (p_tenant_id,p_permit_id,p_connection_id,p_worker_id,deadline)
  ON CONFLICT (tenant_id,permit_id) DO UPDATE SET
    expires_at=EXCLUDED.expires_at
  WHERE control_plane.sync_write_permits.connection_id=EXCLUDED.connection_id
    AND control_plane.sync_write_permits.worker_id=EXCLUDED.worker_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'sync write permit ownership mismatch' USING ERRCODE='55000';END IF;
  RETURN deadline;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.release_sync_write_permit(
  p_tenant_id text,p_permit_id text,p_worker_id text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE removed_count bigint;
BEGIN
  DELETE FROM control_plane.sync_write_permits
  WHERE tenant_id=p_tenant_id AND permit_id=p_permit_id AND worker_id=p_worker_id;
  GET DIAGNOSTICS removed_count=ROW_COUNT;RETURN removed_count>0;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.assert_deletion_quiescent(p_deletion_request_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE request_row control_plane.deletion_requests%ROWTYPE; active_count bigint;
BEGIN
  SELECT * INTO STRICT request_row FROM control_plane.deletion_requests
  WHERE deletion_request_id=p_deletion_request_id FOR UPDATE;
  DELETE FROM control_plane.sync_write_permits WHERE expires_at<=clock_timestamp();
  SELECT count(*) INTO active_count FROM control_plane.sync_write_permits permit
  WHERE permit.tenant_id=request_row.tenant_id
    AND (request_row.scope='tenant' OR permit.connection_id=request_row.connection_id);
  IF active_count>0 THEN
    RAISE EXCEPTION 'deletion waiting for % active sync write permits',active_count USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('verified',true,'activeWritePermits',0);
END;
$$;

-- No tenant id, connection id, user id, display name, payload or SQL is kept in
-- this table. References are keyed HMACs generated outside Postgres so a DB-only
-- disclosure cannot enumerate deleted customers.
CREATE TABLE IF NOT EXISTS control_plane.deletion_proofs (
  proof_id text PRIMARY KEY CHECK (control_plane.is_ulid(proof_id)),
  deletion_request_id text NOT NULL UNIQUE CHECK (control_plane.is_ulid(deletion_request_id)),
  scope text NOT NULL CHECK (scope IN ('connection', 'tenant')),
  tenant_reference_hash text NOT NULL CHECK (tenant_reference_hash ~ '^[a-f0-9]{64}$'),
  connection_reference_hash text CHECK (connection_reference_hash IS NULL OR connection_reference_hash ~ '^[a-f0-9]{64}$'),
  requested_at timestamptz NOT NULL,
  approved_at timestamptz,
  completed_at timestamptz NOT NULL,
  remote_revocation jsonb NOT NULL CHECK (jsonb_typeof(remote_revocation) = 'object'),
  store_verification jsonb NOT NULL CHECK (jsonb_typeof(store_verification) = 'object'),
  proof_digest text NOT NULL UNIQUE CHECK (proof_digest ~ '^[a-f0-9]{64}$'),
  worker_id text NOT NULL CHECK (length(btrim(worker_id)) BETWEEN 1 AND 160),
  service_version text NOT NULL CHECK (length(btrim(service_version)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'tenant' AND connection_reference_hash IS NULL) OR (scope = 'connection' AND connection_reference_hash IS NOT NULL)),
  CHECK (completed_at >= requested_at)
);

CREATE OR REPLACE FUNCTION control_plane.reject_deletion_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF current_user = 'albert_control_migration_owner'
     AND current_setting('albert.deletion_authorized', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'deletion evidence is append-only' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS deletion_job_attempts_append_only ON control_plane.deletion_job_attempts;
CREATE TRIGGER deletion_job_attempts_append_only
  BEFORE UPDATE OR DELETE ON control_plane.deletion_job_attempts
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_deletion_evidence_mutation();
DROP TRIGGER IF EXISTS deletion_proofs_append_only ON control_plane.deletion_proofs;
CREATE TRIGGER deletion_proofs_append_only
  BEFORE UPDATE OR DELETE ON control_plane.deletion_proofs
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_deletion_evidence_mutation();

-- Existing append-only ledgers remain immutable to every runtime role. Their
-- only lawful deletion path is a fixed SECURITY DEFINER purge below.
CREATE OR REPLACE FUNCTION control_plane.deletion_mutation_authorized()
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT current_user = 'albert_control_migration_owner'
     AND current_setting('albert.deletion_authorized', true) = 'on';
$$;

CREATE OR REPLACE FUNCTION control_plane.reject_audit_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF control_plane.deletion_mutation_authorized() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'control_plane.audit_log is append-only' USING ERRCODE = '55000';
END;
$$;
CREATE OR REPLACE FUNCTION control_plane.reject_operator_audit_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF control_plane.deletion_mutation_authorized() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'control_plane.operator_audit_log is append-only' USING ERRCODE = '55000';
END;
$$;
CREATE OR REPLACE FUNCTION control_plane.reject_usage_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF control_plane.deletion_mutation_authorized() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'control_plane.model_usage_ledger is append-only' USING ERRCODE = '55000';
END;
$$;
CREATE OR REPLACE FUNCTION control_plane.reject_turn_event_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF control_plane.deletion_mutation_authorized() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'control_plane.conversation_turn_events is append-only' USING ERRCODE = '55000';
END;
$$;
CREATE OR REPLACE FUNCTION control_plane.reject_raw_manifest_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF control_plane.deletion_mutation_authorized() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'control_plane.raw_batch_manifests is append-only' USING ERRCODE = '55000';
END;
$$;
CREATE OR REPLACE FUNCTION control_plane.reject_sync_attempt_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF control_plane.deletion_mutation_authorized() THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id
     AND NEW.job_attempt_id IS NOT DISTINCT FROM OLD.job_attempt_id
     AND NEW.job_request_id IS NOT DISTINCT FROM OLD.job_request_id
     AND NEW.attempt_number IS NOT DISTINCT FROM OLD.attempt_number
     AND NEW.worker_id IS NOT DISTINCT FROM OLD.worker_id
     AND NEW.started_at IS NOT DISTINCT FROM OLD.started_at
     AND NEW.finished_at IS NOT DISTINCT FROM OLD.finished_at
     AND NEW.outcome IS NOT DISTINCT FROM OLD.outcome
     AND NEW.error_metadata IS NOT DISTINCT FROM OLD.error_metadata
     AND NEW.visibility_deadline > OLD.visibility_deadline THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'control_plane.sync_job_attempts is append-only' USING ERRCODE = '55000';
END;
$$;

SELECT extensions.albert_install_deletion_queue();

CREATE OR REPLACE FUNCTION control_plane.assert_deletion_queue_ready()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pgmq AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pgmq')
     OR NOT EXISTS (SELECT 1 FROM pgmq.meta WHERE queue_name = 'albert_deletion') THEN
    RAISE EXCEPTION 'Albert deletion queue is unavailable' USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.enqueue_deletion_request(p_deletion_request_id text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pgmq AS $$
DECLARE request_row control_plane.deletion_requests%ROWTYPE; generated_message_id bigint;
BEGIN
  PERFORM control_plane.assert_deletion_queue_ready();
  SELECT * INTO STRICT request_row
  FROM control_plane.deletion_requests
  WHERE deletion_request_id = p_deletion_request_id
  FOR UPDATE;
  IF request_row.status NOT IN ('queued', 'retry_wait', 'failed') THEN
    RAISE EXCEPTION 'deletion request is not enqueueable' USING ERRCODE = '55000';
  END IF;
  IF request_row.queue_message_id IS NOT NULL THEN RETURN request_row.queue_message_id; END IF;
  SELECT send INTO generated_message_id FROM pgmq.send(
    'albert_deletion',
    jsonb_build_object(
      'deletionRequestId', request_row.deletion_request_id,
      'tenantId', request_row.tenant_id,
      'connectionId', request_row.connection_id,
      'scope', request_row.scope
    ), 0
  );
  UPDATE control_plane.deletion_requests
  SET queue_message_id = generated_message_id, status = 'queued', last_error_code = NULL
  WHERE tenant_id = request_row.tenant_id AND deletion_request_id = request_row.deletion_request_id;
  RETURN generated_message_id;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.destroy_deletion_credentials(
  p_deletion_request_id text,
  p_remote_revocation jsonb DEFAULT '{}'::jsonb
) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE request_row control_plane.deletion_requests%ROWTYPE; destroyed_at timestamptz := clock_timestamp();
BEGIN
  IF p_remote_revocation IS NULL OR jsonb_typeof(p_remote_revocation) <> 'object' THEN
    RAISE EXCEPTION 'remote revocation evidence must be an object' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO STRICT request_row FROM control_plane.deletion_requests
  WHERE deletion_request_id = p_deletion_request_id FOR UPDATE;
  IF request_row.credential_destroyed_at IS NOT NULL THEN RETURN request_row.credential_destroyed_at; END IF;

  IF request_row.scope = 'tenant' THEN
    UPDATE control_plane.oauth_sessions SET
      status = CASE WHEN status IN ('consumed', 'expired', 'failed') THEN status ELSE 'failed' END,
      failure_code = coalesce(failure_code, 'tenant_deletion'),
      pkce_verifier_secret_reference = NULL
    WHERE tenant_id = request_row.tenant_id;
    DELETE FROM control_plane.oauth_session_secret_envelopes WHERE tenant_id = request_row.tenant_id;
    DELETE FROM control_plane.oauth_token_refs WHERE tenant_id = request_row.tenant_id;
  ELSE
    DELETE FROM control_plane.oauth_token_refs
    WHERE tenant_id = request_row.tenant_id AND connection_id = request_row.connection_id;
  END IF;

  UPDATE control_plane.deletion_requests SET
    credential_destroyed_at = destroyed_at,
    progress = progress || jsonb_build_object(
      'credential_vault', jsonb_build_object('verified', true, 'completedAt', destroyed_at),
      'remote_revocation', p_remote_revocation
    )
  WHERE tenant_id = request_row.tenant_id AND deletion_request_id = request_row.deletion_request_id;
  RETURN destroyed_at;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.force_overdue_deletion_credential_destruction(
  p_now timestamptz DEFAULT now()
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE request_row record; destroyed integer := 0;
BEGIN
  FOR request_row IN
    SELECT deletion_request_id FROM control_plane.deletion_requests
    WHERE scope = 'tenant'
      AND status IN ('queued', 'running', 'retry_wait', 'failed')
      AND credential_destroyed_at IS NULL
      AND credential_destruction_due_at <= p_now
    ORDER BY credential_destruction_due_at
    FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM control_plane.destroy_deletion_credentials(
      request_row.deletion_request_id,
      jsonb_build_object('forcedLocalDestruction', true, 'reason', 'remote_revocation_grace_expired')
    );
    destroyed := destroyed + 1;
  END LOOP;
  RETURN destroyed;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.enqueue_due_deletions(p_now timestamptz DEFAULT now())
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE request_row record; enqueued integer := 0;
BEGIN
  UPDATE control_plane.deletion_requests SET status='cancelled',completed_at=p_now,last_error_code='approval_expired'
  WHERE status='awaiting_approval' AND approval_expires_at<=p_now;
  PERFORM control_plane.force_overdue_deletion_credential_destruction(p_now);
  FOR request_row IN
    SELECT deletion_request_id FROM control_plane.deletion_requests
    WHERE status IN ('queued', 'failed') AND queue_message_id IS NULL AND purge_due_at <= p_now
    ORDER BY purge_due_at
    FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM control_plane.enqueue_deletion_request(request_row.deletion_request_id);
    enqueued := enqueued + 1;
  END LOOP;
  RETURN enqueued;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.claim_deletion_jobs(
  p_worker_id text, p_visibility_timeout_seconds integer DEFAULT 900, p_quantity integer DEFAULT 1
) RETURNS TABLE (
  message_id bigint, read_count bigint, enqueued_at timestamptz,
  visibility_deadline timestamptz, payload jsonb
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pgmq AS $$
DECLARE message record; request_row control_plane.deletion_requests%ROWTYPE;
BEGIN
  PERFORM control_plane.assert_deletion_queue_ready();
  IF length(btrim(p_worker_id)) NOT BETWEEN 1 AND 160
     OR p_visibility_timeout_seconds NOT BETWEEN 60 AND 3600
     OR p_quantity NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'deletion claim is invalid' USING ERRCODE = '22023';
  END IF;
  FOR message IN SELECT * FROM pgmq.read('albert_deletion', p_visibility_timeout_seconds, p_quantity) LOOP
    SELECT * INTO request_row FROM control_plane.deletion_requests
    WHERE deletion_request_id = message.message ->> 'deletionRequestId'
      AND queue_message_id = message.msg_id FOR UPDATE;
    IF NOT FOUND OR request_row.status NOT IN ('queued', 'retry_wait', 'running') THEN
      PERFORM pgmq.delete('albert_deletion', message.msg_id);
      CONTINUE;
    END IF;
    UPDATE control_plane.deletion_requests SET
      status = 'running', started_at = coalesce(started_at, now()), last_error_code = NULL
    WHERE tenant_id = request_row.tenant_id AND deletion_request_id = request_row.deletion_request_id;
    INSERT INTO control_plane.deletion_job_attempts (
      tenant_id, deletion_attempt_id, deletion_request_id, attempt_number, worker_id, visibility_deadline
    ) VALUES (
      request_row.tenant_id, control_plane.generate_ulid(), request_row.deletion_request_id,
      message.read_ct::integer, p_worker_id, message.vt
    ) ON CONFLICT (tenant_id, deletion_request_id, attempt_number) DO NOTHING;
    message_id := message.msg_id; read_count := message.read_ct;
    enqueued_at := message.enqueued_at; visibility_deadline := message.vt; payload := message.message;
    RETURN NEXT;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.require_active_deletion_lease(
  p_message_id bigint, p_deletion_request_id text, p_worker_id text, p_read_count integer
) RETURNS control_plane.deletion_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE request_row control_plane.deletion_requests%ROWTYPE;
BEGIN
  SELECT request.* INTO request_row
  FROM control_plane.deletion_requests request
  JOIN control_plane.deletion_job_attempts attempt
    ON attempt.tenant_id = request.tenant_id
   AND attempt.deletion_request_id = request.deletion_request_id
   AND attempt.attempt_number = p_read_count AND attempt.worker_id = p_worker_id
  WHERE request.deletion_request_id = p_deletion_request_id
    AND request.queue_message_id = p_message_id
    AND request.status IN ('running', 'verifying')
    AND attempt.visibility_deadline > clock_timestamp()
    AND attempt.outcome IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM control_plane.deletion_job_attempts later
      WHERE later.tenant_id = request.tenant_id
        AND later.deletion_request_id = request.deletion_request_id
        AND later.attempt_number > attempt.attempt_number
    )
  FOR UPDATE OF request, attempt;
  IF NOT FOUND THEN RAISE EXCEPTION 'deletion lease is no longer active' USING ERRCODE = '55000'; END IF;
  RETURN request_row;
END;
$$;

-- FORCE RLS also applies to the table owner. These policies let the DDL-only
-- owner service the fixed-input SECURITY DEFINER credential functions below.
-- No runtime identity receives a policy or a direct table grant.
DROP POLICY IF EXISTS migration_owner_deletion_access ON control_plane.oauth_secret_envelopes;
CREATE POLICY migration_owner_deletion_access ON control_plane.oauth_secret_envelopes
  FOR ALL TO albert_control_migration_owner USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS migration_owner_deletion_access ON control_plane.oauth_session_secret_envelopes;
CREATE POLICY migration_owner_deletion_access ON control_plane.oauth_session_secret_envelopes
  FOR ALL TO albert_control_migration_owner USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION control_plane.deletion_revocation_context(
  p_message_id bigint, p_deletion_request_id text, p_worker_id text, p_read_count integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE request_row control_plane.deletion_requests%ROWTYPE; targets jsonb;
BEGIN
  request_row := control_plane.require_active_deletion_lease(
    p_message_id,p_deletion_request_id,p_worker_id,p_read_count
  );
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'tenantId',token.tenant_id,
    'connectionId',token.connection_id,
    'connectorId',connection.connector_key,
    'credentialRef',token.secret_reference
  ) ORDER BY token.connection_id),'[]'::jsonb)
  INTO targets
  FROM control_plane.oauth_token_refs token
  JOIN control_plane.connections connection
    ON connection.tenant_id=token.tenant_id AND connection.connection_id=token.connection_id
  WHERE token.tenant_id=request_row.tenant_id
    AND (request_row.scope='tenant' OR token.connection_id=request_row.connection_id);
  RETURN jsonb_build_object(
    'priorStatus',request_row.remote_revocation_status,
    'priorProgress',request_row.progress,
    'targets',targets
  );
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.read_deletion_credential(
  p_message_id bigint,p_deletion_request_id text,p_worker_id text,p_read_count integer,
  p_credential_ref text
) RETURNS TABLE (
  tenant_id text,token_ref_id text,connection_id text,secret_reference text,
  credential_version integer,algorithm text,ciphertext bytea,nonce bytea,
  authentication_tag bytea,wrapped_data_key bytea,key_reference text,
  key_version text,aad_digest text
) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE request_row control_plane.deletion_requests%ROWTYPE;
BEGIN
  request_row := control_plane.require_active_deletion_lease(
    p_message_id,p_deletion_request_id,p_worker_id,p_read_count
  );
  RETURN QUERY
  SELECT token.tenant_id,token.token_ref_id,token.connection_id,token.secret_reference,
    envelope.credential_version,envelope.algorithm,envelope.ciphertext,envelope.nonce,
    envelope.authentication_tag,envelope.wrapped_data_key,envelope.key_reference,
    envelope.key_version,envelope.aad_digest
  FROM control_plane.oauth_token_refs token
  JOIN control_plane.oauth_secret_envelopes envelope
    ON envelope.tenant_id=token.tenant_id AND envelope.token_ref_id=token.token_ref_id
   AND envelope.retired_at IS NULL
  WHERE token.secret_reference=p_credential_ref
    AND token.tenant_id=request_row.tenant_id
    AND (request_row.scope='tenant' OR token.connection_id=request_row.connection_id);
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.rotate_deletion_credential(
  p_message_id bigint,p_deletion_request_id text,p_worker_id text,p_read_count integer,
  p_credential_ref text,p_expected_version integer,p_algorithm text,p_ciphertext bytea,
  p_nonce bytea,p_authentication_tag bytea,p_wrapped_data_key bytea,p_key_reference text,
  p_key_version text,p_aad_digest text,p_granted_scopes text[],p_token_expires_at timestamptz
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  request_row control_plane.deletion_requests%ROWTYPE;
  token_row control_plane.oauth_token_refs%ROWTYPE;
  current_version integer;
  next_version integer;
BEGIN
  request_row := control_plane.require_active_deletion_lease(
    p_message_id,p_deletion_request_id,p_worker_id,p_read_count
  );
  IF p_expected_version IS NULL OR p_expected_version < 1 OR p_algorithm<>'AES-256-GCM'
     OR p_ciphertext IS NULL OR octet_length(p_ciphertext)=0
     OR octet_length(p_nonce)<>12 OR octet_length(p_authentication_tag)<>16
     OR p_wrapped_data_key IS NULL OR octet_length(p_wrapped_data_key)=0
     OR length(btrim(p_key_reference))=0 OR length(btrim(p_key_version))=0
     OR p_aad_digest !~ '^[0-9a-f]{64}$' OR p_granted_scopes IS NULL THEN
    RAISE EXCEPTION 'deletion credential rotation input is invalid' USING ERRCODE='22023';
  END IF;
  SELECT token.* INTO token_row
  FROM control_plane.oauth_token_refs token
  WHERE token.secret_reference=p_credential_ref
    AND token.tenant_id=request_row.tenant_id
    AND (request_row.scope='tenant' OR token.connection_id=request_row.connection_id)
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'deletion credential was not found' USING ERRCODE='P0002'; END IF;
  SELECT envelope.credential_version INTO current_version
  FROM control_plane.oauth_secret_envelopes envelope
  WHERE envelope.tenant_id=token_row.tenant_id AND envelope.token_ref_id=token_row.token_ref_id
    AND envelope.retired_at IS NULL
  FOR UPDATE;
  IF current_version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'deletion credential revision conflict' USING ERRCODE='40001';
  END IF;
  next_version:=p_expected_version+1;
  UPDATE control_plane.oauth_secret_envelopes SET retired_at=clock_timestamp()
  WHERE tenant_id=token_row.tenant_id AND token_ref_id=token_row.token_ref_id AND retired_at IS NULL;
  INSERT INTO control_plane.oauth_secret_envelopes (
    tenant_id,oauth_secret_envelope_id,token_ref_id,credential_version,algorithm,
    ciphertext,nonce,authentication_tag,wrapped_data_key,key_reference,key_version,aad_digest
  ) VALUES (
    token_row.tenant_id,control_plane.generate_ulid(),token_row.token_ref_id,next_version,p_algorithm,
    p_ciphertext,p_nonce,p_authentication_tag,p_wrapped_data_key,p_key_reference,p_key_version,p_aad_digest
  );
  UPDATE control_plane.oauth_token_refs SET
    encryption_key_version=p_key_version,granted_scopes=p_granted_scopes,
    token_expires_at=p_token_expires_at,last_rotated_at=clock_timestamp()
  WHERE tenant_id=token_row.tenant_id AND token_ref_id=token_row.token_ref_id;
  RETURN next_version;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.destroy_one_deletion_credential(
  p_message_id bigint,p_deletion_request_id text,p_worker_id text,p_read_count integer,
  p_credential_ref text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE request_row control_plane.deletion_requests%ROWTYPE; token_row control_plane.oauth_token_refs%ROWTYPE;
BEGIN
  request_row := control_plane.require_active_deletion_lease(
    p_message_id,p_deletion_request_id,p_worker_id,p_read_count
  );
  SELECT token.* INTO token_row
  FROM control_plane.oauth_token_refs token
  WHERE token.secret_reference=p_credential_ref
    AND token.tenant_id=request_row.tenant_id
    AND (request_row.scope='tenant' OR token.connection_id=request_row.connection_id)
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  DELETE FROM control_plane.oauth_token_refs
  WHERE tenant_id=token_row.tenant_id AND token_ref_id=token_row.token_ref_id;
  INSERT INTO control_plane.audit_log (
    tenant_id,audit_id,actor_type,action,resource_type,resource_id,audit_metadata
  ) VALUES (
    token_row.tenant_id,control_plane.generate_ulid(),'service','oauth.credential_destroyed',
    'connection',token_row.connection_id,jsonb_build_object('deletionRequestId',p_deletion_request_id)
  );
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.verify_deletion_credentials(
  p_message_id bigint,p_deletion_request_id text,p_worker_id text,p_read_count integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  request_row control_plane.deletion_requests%ROWTYPE;
  token_count bigint;
  envelope_count bigint;
  session_envelope_count bigint;
BEGIN
  request_row := control_plane.require_active_deletion_lease(
    p_message_id,p_deletion_request_id,p_worker_id,p_read_count
  );
  SELECT count(*) INTO token_count FROM control_plane.oauth_token_refs token
  WHERE token.tenant_id=request_row.tenant_id
    AND (request_row.scope='tenant' OR token.connection_id=request_row.connection_id);
  SELECT count(*) INTO envelope_count
  FROM control_plane.oauth_secret_envelopes envelope
  JOIN control_plane.oauth_token_refs token
    ON token.tenant_id=envelope.tenant_id AND token.token_ref_id=envelope.token_ref_id
  WHERE token.tenant_id=request_row.tenant_id
    AND (request_row.scope='tenant' OR token.connection_id=request_row.connection_id);
  SELECT count(*) INTO session_envelope_count
  FROM control_plane.oauth_session_secret_envelopes envelope
  WHERE envelope.tenant_id=request_row.tenant_id AND request_row.scope='tenant';
  RETURN jsonb_build_object(
    'verified',token_count=0 AND envelope_count=0 AND session_envelope_count=0,
    'tokenReferences',token_count,
    'credentialEnvelopes',envelope_count,
    'sessionEnvelopes',session_envelope_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.destroy_claimed_deletion_credentials(
  p_message_id bigint,p_deletion_request_id text,p_worker_id text,p_read_count integer,
  p_remote_revocation jsonb
) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM control_plane.require_active_deletion_lease(
    p_message_id,p_deletion_request_id,p_worker_id,p_read_count
  );
  RETURN control_plane.destroy_deletion_credentials(p_deletion_request_id,p_remote_revocation);
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.assert_claimed_deletion_quiescent(
  p_message_id bigint,p_deletion_request_id text,p_worker_id text,p_read_count integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM control_plane.require_active_deletion_lease(
    p_message_id,p_deletion_request_id,p_worker_id,p_read_count
  );
  RETURN control_plane.assert_deletion_quiescent(p_deletion_request_id);
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.extend_deletion_visibility(
  p_message_id bigint, p_deletion_request_id text, p_worker_id text,
  p_read_count integer, p_visibility_timeout_seconds integer
) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pgmq AS $$
DECLARE request_row control_plane.deletion_requests%ROWTYPE; deadline timestamptz;
BEGIN
  IF p_visibility_timeout_seconds NOT BETWEEN 60 AND 3600 THEN
    RAISE EXCEPTION 'deletion visibility extension is invalid' USING ERRCODE = '22023';
  END IF;
  request_row := control_plane.require_active_deletion_lease(
    p_message_id, p_deletion_request_id, p_worker_id, p_read_count
  );
  PERFORM pgmq.set_vt('albert_deletion', p_message_id, p_visibility_timeout_seconds);
  deadline := clock_timestamp() + make_interval(secs => p_visibility_timeout_seconds);
  PERFORM set_config('albert.deletion_authorized', 'on', true);
  UPDATE control_plane.deletion_job_attempts SET visibility_deadline = deadline
  WHERE tenant_id = request_row.tenant_id AND deletion_request_id = p_deletion_request_id
    AND attempt_number = p_read_count AND worker_id = p_worker_id;
  RETURN deadline;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.record_deletion_progress(
  p_message_id bigint, p_deletion_request_id text, p_worker_id text,
  p_read_count integer, p_stage text, p_evidence jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE request_row control_plane.deletion_requests%ROWTYPE;
BEGIN
  IF p_stage NOT IN ('remote_revocation','credential_vault','raw_storage','analytical','control_plane','verification')
     OR p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object' THEN
    RAISE EXCEPTION 'deletion progress is invalid' USING ERRCODE = '22023';
  END IF;
  request_row := control_plane.require_active_deletion_lease(
    p_message_id, p_deletion_request_id, p_worker_id, p_read_count
  );
  UPDATE control_plane.deletion_requests SET progress = progress || jsonb_build_object(p_stage, p_evidence)
  WHERE tenant_id = request_row.tenant_id AND deletion_request_id = p_deletion_request_id;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.purge_deletion_queue_scope(
  p_tenant_id text, p_connection_id text DEFAULT NULL
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE queue_name text; table_name text; removed bigint := 0; affected bigint;
BEGIN
  IF NOT control_plane.deletion_mutation_authorized() THEN
    RAISE EXCEPTION 'deletion purge context required' USING ERRCODE = '42501';
  END IF;
  FOREACH queue_name IN ARRAY ARRAY[
    'albert_sync_high','albert_sync_standard','albert_sync_backfill','albert_sync_deadletter'
  ] LOOP
    FOREACH table_name IN ARRAY ARRAY['q_' || queue_name, 'a_' || queue_name] LOOP
      IF to_regclass('pgmq.' || table_name) IS NOT NULL THEN
        EXECUTE format(
          'DELETE FROM pgmq.%I WHERE position($1 in message::text) > 0 AND ($2::text IS NULL OR position($2 in message::text) > 0)',
          table_name
        ) USING p_tenant_id, p_connection_id;
        GET DIAGNOSTICS affected = ROW_COUNT; removed := removed + affected;
      END IF;
    END LOOP;
  END LOOP;
  RETURN removed;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.purge_connection_control(
  p_message_id bigint, p_deletion_request_id text, p_worker_id text, p_read_count integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE request_row control_plane.deletion_requests%ROWTYPE; table_row record; affected bigint; removed bigint := 0; pass integer; changed boolean;
BEGIN
  request_row := control_plane.require_active_deletion_lease(
    p_message_id, p_deletion_request_id, p_worker_id, p_read_count
  );
  IF request_row.scope <> 'connection' OR request_row.credential_destroyed_at IS NULL THEN
    RAISE EXCEPTION 'connection deletion is not purge-ready' USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('albert.deletion_authorized', 'on', true);

  -- Query-derived artefacts and identity review evidence can embed values from
  -- several sources and are therefore invalidated tenant-wide on disconnect.
  DELETE FROM control_plane.model_usage_ledger WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.conversation_turn_events WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.conversation_turns WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.answer_execution_events WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.answer_artifacts WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.conversations WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.identity_review_decisions WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.identity_review_tasks WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.semantic_inbox WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.dossiers WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.audit_log WHERE tenant_id = request_row.tenant_id;
  DELETE FROM control_plane.pipeline_stats WHERE tenant_id = request_row.tenant_id;

  FOR pass IN 1..20 LOOP
    changed := false;
    FOR table_row IN
      SELECT c.table_name
      FROM information_schema.columns c
      WHERE c.table_schema = 'control_plane' AND c.column_name = 'connection_id'
        AND c.table_name NOT IN ('connections', 'deletion_requests')
      ORDER BY c.table_name
    LOOP
      BEGIN
        EXECUTE format('DELETE FROM control_plane.%I WHERE tenant_id=$1 AND connection_id=$2', table_row.table_name)
          USING request_row.tenant_id, request_row.connection_id;
        GET DIAGNOSTICS affected = ROW_COUNT;
        IF affected > 0 THEN removed := removed + affected; changed := true; END IF;
      EXCEPTION WHEN foreign_key_violation THEN NULL;
      END;
    END LOOP;
    EXIT WHEN NOT changed;
  END LOOP;

  UPDATE control_plane.connections SET
    display_name = 'Deleted connection', external_account_reference = NULL,
    account_metadata = '{}'::jsonb, status = 'disconnected', auth_health = 'revoked',
    authorised_by = NULL
  WHERE tenant_id = request_row.tenant_id AND connection_id = request_row.connection_id;
  removed := removed + control_plane.purge_deletion_queue_scope(request_row.tenant_id, request_row.connection_id);
  RETURN jsonb_build_object('scope','connection','rowsRemoved',removed,'connectionTombstoned',true);
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.purge_tenant_control(
  p_message_id bigint, p_deletion_request_id text, p_worker_id text, p_read_count integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE request_row control_plane.deletion_requests%ROWTYPE; table_row record; affected bigint; removed bigint := 0; pass integer; changed boolean;
BEGIN
  request_row := control_plane.require_active_deletion_lease(
    p_message_id, p_deletion_request_id, p_worker_id, p_read_count
  );
  IF request_row.scope <> 'tenant' OR request_row.credential_destroyed_at IS NULL THEN
    RAISE EXCEPTION 'tenant deletion is not purge-ready' USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('albert.deletion_authorized', 'on', true);
  DELETE FROM control_plane.operator_audit_log WHERE target_tenant_id = request_row.tenant_id;

  FOR pass IN 1..50 LOOP
    changed := false;
    FOR table_row IN
      SELECT c.table_name
      FROM information_schema.columns c
      WHERE c.table_schema = 'control_plane' AND c.column_name = 'tenant_id'
        AND c.table_name NOT IN ('tenants','deletion_requests','deletion_job_attempts')
      ORDER BY c.table_name
    LOOP
      BEGIN
        EXECUTE format('DELETE FROM control_plane.%I WHERE tenant_id=$1', table_row.table_name)
          USING request_row.tenant_id;
        GET DIAGNOSTICS affected = ROW_COUNT;
        IF affected > 0 THEN removed := removed + affected; changed := true; END IF;
      EXCEPTION WHEN foreign_key_violation THEN NULL;
      END;
    END LOOP;
    EXIT WHEN NOT changed;
  END LOOP;

  removed := removed + control_plane.purge_deletion_queue_scope(request_row.tenant_id, NULL);
  RETURN jsonb_build_object('scope','tenant','rowsRemoved',removed,'tenantAnchorPendingProof',true);
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.verify_control_deletion(p_deletion_request_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE request_row control_plane.deletion_requests%ROWTYPE; table_row record; affected bigint; remaining bigint := 0; queue_remaining bigint := 0; table_name text; derived_remaining bigint := 0;
BEGIN
  SELECT * INTO STRICT request_row FROM control_plane.deletion_requests
  WHERE deletion_request_id = p_deletion_request_id;
  IF request_row.scope = 'tenant' THEN
    FOR table_row IN
      SELECT c.table_name FROM information_schema.columns c
      WHERE c.table_schema='control_plane' AND c.column_name='tenant_id'
        AND c.table_name NOT IN ('tenants','deletion_requests','deletion_job_attempts')
    LOOP
      EXECUTE format('SELECT count(*) FROM control_plane.%I WHERE tenant_id=$1', table_row.table_name)
        INTO affected USING request_row.tenant_id;
      remaining := remaining + affected;
    END LOOP;
  ELSE
    FOR table_row IN
      SELECT c.table_name FROM information_schema.columns c
      WHERE c.table_schema='control_plane' AND c.column_name='connection_id'
        AND c.table_name NOT IN ('connections','deletion_requests')
    LOOP
      EXECUTE format('SELECT count(*) FROM control_plane.%I WHERE tenant_id=$1 AND connection_id=$2', table_row.table_name)
        INTO affected USING request_row.tenant_id, request_row.connection_id;
      remaining := remaining + affected;
    END LOOP;
    SELECT
      (SELECT count(*) FROM control_plane.conversations WHERE tenant_id=request_row.tenant_id) +
      (SELECT count(*) FROM control_plane.dossiers WHERE tenant_id=request_row.tenant_id) +
      (SELECT count(*) FROM control_plane.identity_review_tasks WHERE tenant_id=request_row.tenant_id) +
      (SELECT count(*) FROM control_plane.semantic_inbox WHERE tenant_id=request_row.tenant_id) +
      (SELECT count(*) FROM control_plane.audit_log WHERE tenant_id=request_row.tenant_id) +
      (SELECT count(*) FROM control_plane.pipeline_stats WHERE tenant_id=request_row.tenant_id)
      INTO derived_remaining;
  END IF;
  FOREACH table_name IN ARRAY ARRAY[
    'q_albert_sync_high','a_albert_sync_high','q_albert_sync_standard','a_albert_sync_standard',
    'q_albert_sync_backfill','a_albert_sync_backfill','q_albert_sync_deadletter','a_albert_sync_deadletter'
  ] LOOP
    IF to_regclass('pgmq.'||table_name) IS NOT NULL THEN
      EXECUTE format(
        'SELECT count(*) FROM pgmq.%I WHERE position($1 in message::text)>0 AND ($2::text IS NULL OR position($2 in message::text)>0)',
        table_name
      ) INTO affected USING request_row.tenant_id, request_row.connection_id;
      queue_remaining := queue_remaining + affected;
    END IF;
  END LOOP;
  RETURN jsonb_build_object(
    'verified', remaining=0 AND queue_remaining=0 AND derived_remaining=0,
    'remainingTenantOrConnectionRows',remaining,
    'remainingDerivedArtifacts',derived_remaining,
    'remainingQueueMessages',queue_remaining
  );
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.verify_claimed_control_deletion(
  p_message_id bigint,p_deletion_request_id text,p_worker_id text,p_read_count integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM control_plane.require_active_deletion_lease(
    p_message_id,p_deletion_request_id,p_worker_id,p_read_count
  );
  RETURN control_plane.verify_control_deletion(p_deletion_request_id);
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.mark_deletion_verifying(
  p_message_id bigint, p_deletion_request_id text, p_worker_id text, p_read_count integer
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE request_row control_plane.deletion_requests%ROWTYPE;
BEGIN
  request_row := control_plane.require_active_deletion_lease(p_message_id,p_deletion_request_id,p_worker_id,p_read_count);
  UPDATE control_plane.deletion_requests SET status='verifying'
  WHERE tenant_id=request_row.tenant_id AND deletion_request_id=p_deletion_request_id;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.complete_deletion_job(
  p_message_id bigint, p_deletion_request_id text, p_worker_id text, p_read_count integer,
  p_proof_id text, p_tenant_reference_hash text, p_connection_reference_hash text,
  p_remote_revocation jsonb, p_store_verification jsonb, p_proof_digest text,
  p_service_version text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pgmq AS $$
DECLARE request_row control_plane.deletion_requests%ROWTYPE; store_name text;
BEGIN
  IF NOT control_plane.is_ulid(p_proof_id)
     OR p_tenant_reference_hash !~ '^[a-f0-9]{64}$'
     OR (p_connection_reference_hash IS NOT NULL AND p_connection_reference_hash !~ '^[a-f0-9]{64}$')
     OR p_proof_digest !~ '^[a-f0-9]{64}$'
     OR jsonb_typeof(p_remote_revocation) <> 'object'
     OR jsonb_typeof(p_store_verification) <> 'object' THEN
    RAISE EXCEPTION 'deletion proof is invalid' USING ERRCODE='22023';
  END IF;
  request_row := control_plane.require_active_deletion_lease(p_message_id,p_deletion_request_id,p_worker_id,p_read_count);
  IF request_row.status <> 'verifying' OR request_row.credential_destroyed_at IS NULL THEN
    RAISE EXCEPTION 'deletion is not ready for proof' USING ERRCODE='55000';
  END IF;
  FOREACH store_name IN ARRAY ARRAY['credential_vault','raw_storage','analytical','control_plane'] LOOP
    IF coalesce((p_store_verification->store_name->>'verified')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'deletion store verification failed: %',store_name USING ERRCODE='55000';
    END IF;
  END LOOP;
  IF request_row.scope='tenant' AND p_connection_reference_hash IS NOT NULL
     OR request_row.scope='connection' AND p_connection_reference_hash IS NULL THEN
    RAISE EXCEPTION 'deletion proof scope does not match' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('albert.deletion_authorized','on',true);
  IF NOT pgmq.delete('albert_deletion',p_message_id) THEN
    RAISE EXCEPTION 'deletion message could not be removed' USING ERRCODE='55000';
  END IF;
  INSERT INTO control_plane.deletion_proofs (
    proof_id,deletion_request_id,scope,tenant_reference_hash,connection_reference_hash,
    requested_at,approved_at,completed_at,remote_revocation,store_verification,
    proof_digest,worker_id,service_version
  ) VALUES (
    p_proof_id,request_row.deletion_request_id,request_row.scope,p_tenant_reference_hash,p_connection_reference_hash,
    request_row.requested_at,request_row.approved_at,clock_timestamp(),p_remote_revocation,p_store_verification,
    p_proof_digest,p_worker_id,p_service_version
  ) ON CONFLICT (deletion_request_id) DO NOTHING;
  UPDATE control_plane.deletion_job_attempts SET outcome='succeeded',finished_at=clock_timestamp()
  WHERE tenant_id=request_row.tenant_id AND deletion_request_id=request_row.deletion_request_id
    AND attempt_number=p_read_count AND worker_id=p_worker_id;
  IF request_row.scope='tenant' THEN
    DELETE FROM control_plane.deletion_requests
    WHERE tenant_id=request_row.tenant_id AND deletion_request_id=request_row.deletion_request_id;
    DELETE FROM control_plane.tenants WHERE tenant_id=request_row.tenant_id;
  ELSE
    UPDATE control_plane.deletion_requests SET
      status='completed',completed_at=clock_timestamp(),queue_message_id=NULL,
      verification=p_store_verification,proof_id=p_proof_id,requested_by=NULL,approved_by=NULL
    WHERE tenant_id=request_row.tenant_id AND deletion_request_id=request_row.deletion_request_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.retry_deletion_job(
  p_message_id bigint,p_deletion_request_id text,p_worker_id text,p_read_count integer,
  p_error jsonb,p_retry_delay_seconds integer,p_max_attempts integer DEFAULT 20
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pgmq AS $$
DECLARE request_row control_plane.deletion_requests%ROWTYPE; terminal boolean;
BEGIN
  IF jsonb_typeof(p_error)<>'object' OR p_retry_delay_seconds NOT BETWEEN 5 AND 3600
     OR p_max_attempts NOT BETWEEN 1 AND 50
     OR NOT p_error ?& ARRAY['code','errorClass','correlationId','retryable','failedAt']
     OR p_error - ARRAY['code','errorClass','correlationId','retryable','failedAt'] <> '{}'::jsonb
     OR coalesce(p_error->>'code' = ANY(ARRAY[
       'unexpected_deletion_failure','connector_authentication_required',
       'connector_capability_unavailable','connector_configuration_invalid',
       'connector_credential_conflict','connector_cursor_invalid',
       'connector_oauth_exchange_failed','connector_rate_limited',
       'connector_remote_response_invalid','connector_remote_unavailable',
       'connector_webhook_signature_invalid','database_serialization_conflict',
       'database_deadlock','database_permission_denied','deletion_fence_conflict',
       'database_unavailable','database_integrity_violation','operation_aborted',
       'operation_timeout','internal_type_error','internal_syntax_error'
     ]::text[]),false) IS NOT TRUE
     OR coalesce(p_error->>'errorClass' = ANY(ARRAY['connector','database','timeout','internal']::text[]),false) IS NOT TRUE
     OR coalesce(control_plane.is_ulid(p_error->>'correlationId'),false) IS NOT TRUE
     OR p_error->'retryable' IS DISTINCT FROM 'true'::jsonb
     OR coalesce(p_error->>'failedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$',false) IS NOT TRUE THEN
    RAISE EXCEPTION 'deletion retry input is invalid' USING ERRCODE='22023';
  END IF;
  request_row := control_plane.require_active_deletion_lease(p_message_id,p_deletion_request_id,p_worker_id,p_read_count);
  terminal := p_read_count >= p_max_attempts;
  PERFORM set_config('albert.deletion_authorized','on',true);
  UPDATE control_plane.deletion_job_attempts SET
    outcome=CASE WHEN terminal THEN 'failed' ELSE 'retry' END,error_metadata=p_error,finished_at=clock_timestamp()
  WHERE tenant_id=request_row.tenant_id AND deletion_request_id=request_row.deletion_request_id
    AND attempt_number=p_read_count AND worker_id=p_worker_id;
  IF terminal THEN
    PERFORM pgmq.delete('albert_deletion',p_message_id);
    UPDATE control_plane.deletion_requests SET
      status='failed',queue_message_id=NULL,failure_cycles=failure_cycles+1,
      last_error_code=coalesce(p_error->>'code','deletion_failed'),
      progress=progress||jsonb_build_object('lastFailure',p_error)
    WHERE tenant_id=request_row.tenant_id AND deletion_request_id=request_row.deletion_request_id;
    RETURN 'failed_requeue_pending';
  END IF;
  PERFORM pgmq.set_vt('albert_deletion',p_message_id,p_retry_delay_seconds);
  UPDATE control_plane.deletion_requests SET
    status='retry_wait',last_error_code=coalesce(p_error->>'code','deletion_retry'),
    progress=progress||jsonb_build_object('lastFailure',p_error)
  WHERE tenant_id=request_row.tenant_id AND deletion_request_id=request_row.deletion_request_id;
  RETURN 'retry_wait';
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_request_tenant_deletion(p_confirmation text)
RETURNS TABLE (deletion_request_id text,status text,approval_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE selected_tenant text:=control_plane.require_current_tenant_id(); actor uuid:=auth.uid(); tenant_name text; generated_id text; rate_allowed boolean;
BEGIN
  IF NOT control_plane.has_tenant_role(selected_tenant,ARRAY['owner']::text[]) THEN
    RAISE EXCEPTION 'owner role required' USING ERRCODE='42501';
  END IF;
  SELECT allowed INTO rate_allowed FROM public.consume_albert_rate_limit('tenant.deletion_request',3,86400);
  IF NOT rate_allowed THEN RAISE EXCEPTION 'rate_limit_exceeded' USING ERRCODE='P0001'; END IF;
  SELECT display_name INTO STRICT tenant_name FROM control_plane.tenants
  WHERE tenant_id=selected_tenant AND status='active' FOR UPDATE;
  IF p_confirmation IS DISTINCT FROM 'DELETE '||tenant_name THEN
    RAISE EXCEPTION 'tenant deletion confirmation does not match' USING ERRCODE='22023';
  END IF;
  generated_id:=control_plane.generate_ulid();
  INSERT INTO control_plane.deletion_requests (
    tenant_id,deletion_request_id,scope,status,requested_by,remote_revocation_status,
    credential_destroyed_at,purge_due_at,approval_expires_at,progress
  ) VALUES (
    selected_tenant,generated_id,'tenant','awaiting_approval',actor,'not_applicable',
    NULL,now(),now()+interval '30 minutes',jsonb_build_object('request','confirmed')
  );
  INSERT INTO control_plane.audit_log (
    tenant_id,audit_id,actor_user_id,actor_type,action,resource_type,resource_id,audit_metadata
  ) VALUES (
    selected_tenant,control_plane.generate_ulid(),actor,'user','tenant.deletion_requested',
    'deletion_request',generated_id,jsonb_build_object('approval_expires_at',now()+interval '30 minutes')
  );
  deletion_request_id:=generated_id;status:='awaiting_approval';approval_expires_at:=now()+interval '30 minutes';RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_approve_tenant_deletion(
  p_deletion_request_id text,p_confirmation text
) RETURNS TABLE (deletion_request_id text,status text,purge_due_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE selected_tenant text:=control_plane.require_current_tenant_id();actor uuid:=auth.uid();tenant_name text;request_row control_plane.deletion_requests%ROWTYPE;rate_allowed boolean;
BEGIN
  IF NOT control_plane.has_tenant_role(selected_tenant,ARRAY['owner']::text[]) THEN RAISE EXCEPTION 'owner role required' USING ERRCODE='42501'; END IF;
  SELECT allowed INTO rate_allowed FROM public.consume_albert_rate_limit('tenant.deletion_approval',5,86400);
  IF NOT rate_allowed THEN RAISE EXCEPTION 'rate_limit_exceeded' USING ERRCODE='P0001'; END IF;
  SELECT display_name INTO STRICT tenant_name FROM control_plane.tenants WHERE tenant_id=selected_tenant FOR UPDATE;
  IF p_confirmation IS DISTINCT FROM 'ERASE '||tenant_name THEN RAISE EXCEPTION 'tenant erasure confirmation does not match' USING ERRCODE='22023'; END IF;
  SELECT * INTO STRICT request_row FROM control_plane.deletion_requests
  WHERE tenant_id=selected_tenant AND deletion_request_id=p_deletion_request_id FOR UPDATE;
  IF request_row.status<>'awaiting_approval' OR request_row.approval_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'tenant deletion approval is unavailable or expired' USING ERRCODE='55000';
  END IF;
  UPDATE control_plane.deletion_requests SET
    status='queued',approved_by=actor,approved_at=clock_timestamp(),
    credential_destruction_due_at=clock_timestamp()+interval '15 minutes',purge_due_at=clock_timestamp(),
    progress=progress||jsonb_build_object('approval','confirmed')
  WHERE tenant_id=selected_tenant AND deletion_request_id=p_deletion_request_id;
  UPDATE control_plane.tenants SET status='deleting' WHERE tenant_id=selected_tenant;
  UPDATE control_plane.memberships SET status='suspended' WHERE tenant_id=selected_tenant;
  UPDATE control_plane.connections SET status='blocked',auth_health='revoked' WHERE tenant_id=selected_tenant;
  PERFORM control_plane.enqueue_deletion_request(p_deletion_request_id);
  deletion_request_id:=p_deletion_request_id;status:='queued';purge_due_at:=clock_timestamp();RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_cancel_tenant_deletion(p_deletion_request_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE selected_tenant text:=control_plane.require_current_tenant_id(); actor uuid:=auth.uid(); rate_allowed boolean;
BEGIN
  IF NOT control_plane.has_tenant_role(selected_tenant,ARRAY['owner']::text[]) THEN RAISE EXCEPTION 'owner role required' USING ERRCODE='42501'; END IF;
  SELECT allowed INTO rate_allowed FROM public.consume_albert_rate_limit('tenant.deletion_cancel',5,86400);
  IF NOT rate_allowed THEN RAISE EXCEPTION 'rate_limit_exceeded' USING ERRCODE='P0001'; END IF;
  UPDATE control_plane.deletion_requests SET status='cancelled',completed_at=clock_timestamp()
  WHERE tenant_id=selected_tenant AND deletion_request_id=p_deletion_request_id
    AND scope='tenant' AND status='awaiting_approval';
  IF NOT FOUND THEN RAISE EXCEPTION 'tenant deletion request cannot be cancelled' USING ERRCODE='55000'; END IF;
  INSERT INTO control_plane.audit_log (
    tenant_id,audit_id,actor_user_id,actor_type,action,resource_type,resource_id,audit_metadata
  ) VALUES (selected_tenant,control_plane.generate_ulid(),actor,'user','tenant.deletion_cancelled','deletion_request',p_deletion_request_id,'{}');
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_deletion_status(p_deletion_request_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE selected_tenant text:=control_plane.require_current_tenant_id();result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'deletionRequestId',request.deletion_request_id,'scope',request.scope,'status',request.status,
    'requestedAt',request.requested_at,'approvedAt',request.approved_at,'purgeDueAt',request.purge_due_at,
    'completedAt',request.completed_at,'progress',request.progress,'lastErrorCode',request.last_error_code,
    'proofId',request.proof_id
  ) INTO result FROM control_plane.deletion_requests request
  WHERE request.tenant_id=selected_tenant AND request.deletion_request_id=p_deletion_request_id;
  IF result IS NULL THEN RAISE EXCEPTION 'deletion request was not found' USING ERRCODE='P0002'; END IF;
  RETURN result;
END;
$$;

SELECT extensions.albert_install_deletion_cron_job();

REVOKE ALL ON TABLE control_plane.deletion_job_attempts,control_plane.deletion_proofs,control_plane.sync_write_permits
  FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;

GRANT USAGE ON SCHEMA control_plane TO albert_deletion_control;

REVOKE ALL ON FUNCTION control_plane.assert_deletion_queue_ready() FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.acquire_sync_write_permit(text,text,text,text,integer) FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.release_sync_write_permit(text,text,text) FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.assert_deletion_quiescent(text) FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.enqueue_deletion_request(text) FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.destroy_deletion_credentials(text,jsonb) FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.force_overdue_deletion_credential_destruction(timestamptz) FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.enqueue_due_deletions(timestamptz) FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.claim_deletion_jobs(text,integer,integer) FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.require_active_deletion_lease(bigint,text,text,integer) FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.deletion_revocation_context(bigint,text,text,integer) FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.read_deletion_credential(bigint,text,text,integer,text) FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.rotate_deletion_credential(bigint,text,text,integer,text,integer,text,bytea,bytea,bytea,bytea,text,text,text,text[],timestamptz) FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.destroy_one_deletion_credential(bigint,text,text,integer,text) FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.verify_deletion_credentials(bigint,text,text,integer) FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.destroy_claimed_deletion_credentials(bigint,text,text,integer,jsonb) FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.assert_claimed_deletion_quiescent(bigint,text,text,integer) FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.extend_deletion_visibility(bigint,text,text,integer,integer) FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.record_deletion_progress(bigint,text,text,integer,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.purge_connection_control(bigint,text,text,integer) FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.purge_tenant_control(bigint,text,text,integer) FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.verify_control_deletion(text) FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.verify_claimed_control_deletion(bigint,text,text,integer) FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.mark_deletion_verifying(bigint,text,text,integer) FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.complete_deletion_job(bigint,text,text,integer,text,text,text,jsonb,jsonb,text,text) FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.retry_deletion_job(bigint,text,text,integer,jsonb,integer,integer) FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;

GRANT EXECUTE ON FUNCTION
  control_plane.assert_deletion_queue_ready(),
  control_plane.claim_deletion_jobs(text,integer,integer),
  control_plane.deletion_revocation_context(bigint,text,text,integer),
  control_plane.read_deletion_credential(bigint,text,text,integer,text),
  control_plane.rotate_deletion_credential(bigint,text,text,integer,text,integer,text,bytea,bytea,bytea,bytea,text,text,text,text[],timestamptz),
  control_plane.destroy_one_deletion_credential(bigint,text,text,integer,text),
  control_plane.verify_deletion_credentials(bigint,text,text,integer),
  control_plane.destroy_claimed_deletion_credentials(bigint,text,text,integer,jsonb),
  control_plane.assert_claimed_deletion_quiescent(bigint,text,text,integer),
  control_plane.extend_deletion_visibility(bigint,text,text,integer,integer),
  control_plane.record_deletion_progress(bigint,text,text,integer,text,jsonb),
  control_plane.purge_connection_control(bigint,text,text,integer),
  control_plane.purge_tenant_control(bigint,text,text,integer),
  control_plane.verify_claimed_control_deletion(bigint,text,text,integer),
  control_plane.mark_deletion_verifying(bigint,text,text,integer),
  control_plane.complete_deletion_job(bigint,text,text,integer,text,text,text,jsonb,jsonb,text,text),
  control_plane.retry_deletion_job(bigint,text,text,integer,jsonb,integer,integer),
  control_plane.heartbeat_worker(text,text,text,timestamptz,integer,jsonb)
TO albert_deletion_control;

REVOKE ALL ON FUNCTION public.albert_request_tenant_deletion(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_approve_tenant_deletion(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_cancel_tenant_deletion(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_deletion_status(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_request_tenant_deletion(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_approve_tenant_deletion(text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_cancel_tenant_deletion(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_deletion_status(text) TO authenticated;

COMMIT;
