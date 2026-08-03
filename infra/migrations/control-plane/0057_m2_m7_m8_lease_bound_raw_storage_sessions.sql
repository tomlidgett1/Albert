BEGIN;

-- ADR 0040. Customer raw objects are authorized by ephemeral Auth sessions
-- bound to an independently durable unit of work. The protected Storage
-- policy owner reads these FORCE-RLS relations; runtime roles can only invoke
-- the narrow issue/revoke routines below.
CREATE TABLE control_plane.raw_storage_sync_session_grants (
  tenant_id text NOT NULL,
  grant_id text NOT NULL CHECK (control_plane.is_ulid(grant_id)),
  permit_id text NOT NULL,
  worker_id text NOT NULL CHECK (length(btrim(worker_id)) BETWEEN 1 AND 160),
  auth_user_id uuid NOT NULL,
  auth_session_id uuid NOT NULL,
  object_key text NOT NULL CHECK (
    object_key ~ '^tenant/[0-9A-HJKMNP-TV-Z]{26}/connection/[0-9A-HJKMNP-TV-Z]{26}/stream/[A-Za-z0-9._-]{1,120}/date/[0-9]{4}-[0-9]{2}-[0-9]{2}/batch-[0-9A-HJKMNP-TV-Z]{26}[.]jsonl[.]gz$'
    AND object_key !~ '/stream/webhook_'
  ),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id,grant_id),
  UNIQUE (grant_id),
  FOREIGN KEY (tenant_id,permit_id)
    REFERENCES control_plane.sync_write_permits(tenant_id,permit_id) ON DELETE CASCADE,
  CHECK (expires_at>issued_at AND expires_at<=issued_at+interval '5 minutes'),
  CHECK (revoked_at IS NULL OR revoked_at>=issued_at)
);
CREATE INDEX raw_storage_sync_session_auth_object_expiry
  ON control_plane.raw_storage_sync_session_grants(auth_session_id,object_key,expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX raw_storage_sync_session_scope_expiry
  ON control_plane.raw_storage_sync_session_grants(tenant_id,permit_id,expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX raw_storage_sync_session_reap_expiry
  ON control_plane.raw_storage_sync_session_grants(expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE control_plane.raw_storage_webhook_session_grants (
  tenant_id text NOT NULL,
  grant_id text NOT NULL CHECK (control_plane.is_ulid(grant_id)),
  connection_id text NOT NULL,
  webhook_receipt_id text NOT NULL,
  connector_key text NOT NULL CHECK (connector_key IN ('xero','deputy')),
  verification_reference text NOT NULL CHECK (control_plane.is_ulid(verification_reference)),
  auth_user_id uuid NOT NULL,
  auth_session_id uuid NOT NULL,
  object_key text NOT NULL CHECK (
    object_key ~ '^tenant/[0-9A-HJKMNP-TV-Z]{26}/connection/[0-9A-HJKMNP-TV-Z]{26}/stream/webhook_(xero|deputy)/date/[0-9]{4}-[0-9]{2}-[0-9]{2}/batch-[0-9A-HJKMNP-TV-Z]{26}[.]json[.]gz$'
  ),
  xero_inbox_id text,
  xero_lease_owner text,
  xero_lease_token text,
  xero_lease_version bigint,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id,grant_id),
  UNIQUE (grant_id),
  FOREIGN KEY (tenant_id,webhook_receipt_id)
    REFERENCES control_plane.webhook_receipts(tenant_id,webhook_receipt_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,connection_id)
    REFERENCES control_plane.connections(tenant_id,connection_id) ON DELETE CASCADE,
  CHECK (expires_at>issued_at AND expires_at<=issued_at+interval '2 minutes'),
  CHECK (revoked_at IS NULL OR revoked_at>=issued_at),
  CHECK (
    (
      connector_key='deputy' AND xero_inbox_id IS NULL
      AND xero_lease_owner IS NULL AND xero_lease_token IS NULL
      AND xero_lease_version IS NULL
    ) OR (
      connector_key='xero' AND xero_inbox_id=verification_reference
      AND control_plane.is_ulid(xero_inbox_id)
      AND xero_lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
      AND xero_lease_token ~ '^[A-Za-z0-9_-]{22}$'
      AND xero_lease_version>0
    )
  )
);
CREATE INDEX raw_storage_webhook_session_auth_object_expiry
  ON control_plane.raw_storage_webhook_session_grants(auth_session_id,object_key,expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX raw_storage_webhook_session_receipt_expiry
  ON control_plane.raw_storage_webhook_session_grants(
    tenant_id,connection_id,webhook_receipt_id,expires_at
  ) WHERE revoked_at IS NULL;
CREATE INDEX raw_storage_webhook_session_reap_expiry
  ON control_plane.raw_storage_webhook_session_grants(expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE control_plane.raw_storage_deletion_session_grants (
  tenant_id text NOT NULL,
  grant_id text NOT NULL CHECK (control_plane.is_ulid(grant_id)),
  deletion_request_id text NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number>0),
  worker_id text NOT NULL CHECK (length(btrim(worker_id)) BETWEEN 1 AND 160),
  message_id bigint NOT NULL CHECK (message_id>0),
  auth_user_id uuid NOT NULL,
  auth_session_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('purge','verify')),
  scope text NOT NULL CHECK (scope IN ('tenant','connection')),
  connection_id text,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id,grant_id),
  UNIQUE (grant_id),
  FOREIGN KEY (tenant_id,deletion_request_id)
    REFERENCES control_plane.deletion_requests(tenant_id,deletion_request_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,deletion_request_id,attempt_number)
    REFERENCES control_plane.deletion_job_attempts(
      tenant_id,deletion_request_id,attempt_number
    ) ON DELETE CASCADE,
  CHECK (
    (scope='tenant' AND connection_id IS NULL)
    OR (scope='connection' AND control_plane.is_ulid(connection_id))
  ),
  CHECK (expires_at>issued_at AND expires_at<=issued_at+interval '5 minutes'),
  CHECK (revoked_at IS NULL OR revoked_at>=issued_at)
);
CREATE INDEX raw_storage_deletion_session_auth_scope_expiry
  ON control_plane.raw_storage_deletion_session_grants(
    auth_session_id,tenant_id,connection_id,expires_at
  ) WHERE revoked_at IS NULL;
CREATE INDEX raw_storage_deletion_session_request_expiry
  ON control_plane.raw_storage_deletion_session_grants(
    tenant_id,deletion_request_id,attempt_number,expires_at
  ) WHERE revoked_at IS NULL;
CREATE INDEX raw_storage_deletion_session_reap_expiry
  ON control_plane.raw_storage_deletion_session_grants(expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE control_plane.raw_storage_sync_session_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.raw_storage_sync_session_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.raw_storage_webhook_session_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.raw_storage_webhook_session_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.raw_storage_deletion_session_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.raw_storage_deletion_session_grants FORCE ROW LEVEL SECURITY;

CREATE POLICY migration_owner_access ON control_plane.raw_storage_sync_session_grants
  FOR ALL TO albert_control_migration_owner USING (true) WITH CHECK (true);
CREATE POLICY migration_owner_access ON control_plane.raw_storage_webhook_session_grants
  FOR ALL TO albert_control_migration_owner USING (true) WITH CHECK (true);
CREATE POLICY migration_owner_access ON control_plane.raw_storage_deletion_session_grants
  FOR ALL TO albert_control_migration_owner USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE
  control_plane.raw_storage_sync_session_grants,
  control_plane.raw_storage_webhook_session_grants,
  control_plane.raw_storage_deletion_session_grants
FROM PUBLIC,anon,authenticated,service_role,
     albert_sync_control,albert_webhook_control,albert_transform_control,
     albert_semantic_control,albert_operator_diagnostic_control,
     albert_deletion_control;

CREATE FUNCTION control_plane.issue_raw_storage_sync_session(
  p_permit_id text,
  p_worker_id text,
  p_object_key text,
  p_auth_user_id uuid,
  p_auth_session_id uuid,
  p_auth_token_expires_at timestamptz
)
RETURNS TABLE (
  grant_id text,tenant_id text,connection_id text,object_key text,expires_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  permit control_plane.sync_write_permits%ROWTYPE;
  request_payload jsonb;
  attempt_deadline timestamptz;
  deadline timestamptz;
  generated_id text;
  expected_key text;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_sync_control_runtime','albert_sync_control'
  );
  IF p_auth_user_id IS NULL OR p_auth_session_id IS NULL
     OR p_auth_token_expires_at<=clock_timestamp()+interval '5 seconds'
     OR NOT extensions.albert_raw_storage_machine_user_matches('sync',p_auth_user_id) THEN
    RAISE EXCEPTION 'raw Storage sync Auth session is invalid' USING ERRCODE='22023';
  END IF;
  SELECT candidate.* INTO permit
    FROM control_plane.sync_write_permits AS candidate
   WHERE candidate.permit_id=p_permit_id
     AND candidate.worker_id=p_worker_id
     AND candidate.expires_at>clock_timestamp()
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sync write permit is not active' USING ERRCODE='55000';
  END IF;
  PERFORM control_plane.require_sync_job_lease(
    permit.queue_name,permit.message_id,permit.job_request_id,
    permit.worker_id,permit.read_count
  );
  SELECT job.payload,attempt.visibility_deadline INTO request_payload,attempt_deadline
    FROM control_plane.sync_job_requests AS job
    JOIN control_plane.sync_job_attempts AS attempt
      ON attempt.tenant_id=job.tenant_id
     AND attempt.job_request_id=job.job_request_id
     AND attempt.attempt_number=permit.read_count
     AND attempt.worker_id=permit.worker_id
    JOIN control_plane.sync_runs AS run
      ON run.tenant_id=permit.tenant_id AND run.sync_run_id=permit.sync_run_id
    JOIN control_plane.connections AS connection
      ON connection.tenant_id=permit.tenant_id
     AND connection.connection_id=permit.connection_id
    JOIN control_plane.tenants AS tenant ON tenant.tenant_id=permit.tenant_id
   WHERE job.tenant_id=permit.tenant_id
     AND job.job_request_id=permit.job_request_id
     AND job.status='running'
     AND job.queue_name=permit.queue_name
     AND job.queue_message_id=permit.message_id
     AND attempt.visibility_deadline>clock_timestamp()
     AND attempt.finished_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM control_plane.sync_job_attempt_outcomes AS outcome
        WHERE outcome.tenant_id=attempt.tenant_id
          AND outcome.job_attempt_id=attempt.job_attempt_id
     )
     AND NOT EXISTS (
       SELECT 1 FROM control_plane.sync_job_attempts AS later
        WHERE later.tenant_id=attempt.tenant_id
          AND later.job_request_id=attempt.job_request_id
          AND later.attempt_number>attempt.attempt_number
     )
     AND run.status='running'
     AND run.connection_id=permit.connection_id
     AND run.connection_generation=permit.connection_generation
     AND connection.connection_generation=permit.connection_generation
     AND connection.status IN ('connected','degraded')
     AND tenant.status='active'
     AND NOT EXISTS (
       SELECT 1 FROM control_plane.deletion_requests AS deletion
        WHERE deletion.tenant_id=permit.tenant_id
          AND (deletion.scope='tenant' OR deletion.connection_id=permit.connection_id)
          AND deletion.status IN ('queued','running','retry_wait','verifying','failed')
     )
   FOR SHARE OF job,attempt,run,connection,tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sync raw write is fenced by stale work or deletion' USING ERRCODE='55000';
  END IF;
  BEGIN
    expected_key:=concat_ws(
      '/','tenant',permit.tenant_id,'connection',permit.connection_id,'stream',
      request_payload->>'stream','date',
      to_char((request_payload->>'requestedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD'),
      'batch-'||(request_payload->>'batchId')||'.jsonl.gz'
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'sync job raw object identity is invalid' USING ERRCODE='22023';
  END;
  IF p_object_key IS DISTINCT FROM expected_key
     OR p_object_key !~ '^tenant/[0-9A-HJKMNP-TV-Z]{26}/connection/[0-9A-HJKMNP-TV-Z]{26}/stream/[A-Za-z0-9._-]{1,120}/date/[0-9]{4}-[0-9]{2}-[0-9]{2}/batch-[0-9A-HJKMNP-TV-Z]{26}[.]jsonl[.]gz$'
     OR p_object_key ~ '/stream/webhook_' THEN
    RAISE EXCEPTION 'sync raw object is not bound to the claimed job' USING ERRCODE='22023';
  END IF;
  deadline:=least(
    p_auth_token_expires_at,permit.expires_at,attempt_deadline,
    clock_timestamp()+interval '5 minutes'
  );
  IF deadline<=clock_timestamp()+interval '5 seconds' THEN
    RAISE EXCEPTION 'sync raw Storage grant would already be expired' USING ERRCODE='55000';
  END IF;
  DELETE FROM control_plane.raw_storage_sync_session_grants AS expired
   WHERE expired.grant_id IN (
     SELECT candidate.grant_id
       FROM control_plane.raw_storage_sync_session_grants AS candidate
      WHERE candidate.expires_at<=clock_timestamp()
      ORDER BY candidate.expires_at,candidate.grant_id
      LIMIT 100
   );
  generated_id:=control_plane.generate_ulid();
  INSERT INTO control_plane.raw_storage_sync_session_grants(
    tenant_id,grant_id,permit_id,worker_id,auth_user_id,auth_session_id,
    object_key,expires_at
  ) VALUES (
    permit.tenant_id,generated_id,permit.permit_id,permit.worker_id,
    p_auth_user_id,p_auth_session_id,p_object_key,deadline
  );
  RETURN QUERY SELECT generated_id,permit.tenant_id,permit.connection_id,p_object_key,deadline;
END;
$$;

CREATE FUNCTION control_plane.revoke_raw_storage_sync_session(
  p_tenant_id text,p_permit_id text,p_worker_id text,p_grant_id text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE revoked boolean;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_sync_control_runtime','albert_sync_control'
  );
  DELETE FROM control_plane.raw_storage_sync_session_grants
   WHERE tenant_id=p_tenant_id AND permit_id=p_permit_id
     AND worker_id=p_worker_id AND grant_id=p_grant_id
  RETURNING true INTO revoked;
  RETURN coalesce(revoked,false);
END;
$$;

CREATE FUNCTION control_plane.issue_raw_storage_webhook_session(
  p_tenant_id text,
  p_connection_id text,
  p_webhook_receipt_id text,
  p_verification_reference text,
  p_xero_lease_owner text,
  p_xero_lease_token text,
  p_xero_lease_version bigint,
  p_auth_user_id uuid,
  p_auth_session_id uuid,
  p_auth_token_expires_at timestamptz
)
RETURNS TABLE (
  grant_id text,tenant_id text,connection_id text,object_key text,expires_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  receipt control_plane.webhook_receipts%ROWTYPE;
  deadline timestamptz;
  lease_deadline timestamptz;
  generated_id text;
  expected_key text;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_webhook_control_runtime','albert_webhook_control'
  );
  IF NOT control_plane.is_ulid(p_tenant_id)
     OR NOT control_plane.is_ulid(p_connection_id)
     OR NOT control_plane.is_ulid(p_webhook_receipt_id)
     OR NOT control_plane.is_ulid(p_verification_reference)
     OR p_auth_user_id IS NULL OR p_auth_session_id IS NULL
     OR p_auth_token_expires_at<=clock_timestamp()+interval '5 seconds'
     OR NOT extensions.albert_raw_storage_machine_user_matches('webhook',p_auth_user_id) THEN
    RAISE EXCEPTION 'raw Storage webhook session identity is invalid' USING ERRCODE='22023';
  END IF;
  SELECT candidate.* INTO receipt
    FROM control_plane.webhook_receipts AS candidate
    JOIN control_plane.connections AS connection
      ON connection.tenant_id=candidate.tenant_id
     AND connection.connection_id=candidate.connection_id
    JOIN control_plane.tenants AS tenant
      ON tenant.tenant_id=candidate.tenant_id
   WHERE candidate.tenant_id=p_tenant_id
     AND candidate.connection_id=p_connection_id
     AND candidate.webhook_receipt_id=p_webhook_receipt_id
     AND candidate.signature_verified
     AND candidate.status IN ('received','failed')
     AND connection.status IN ('connected','degraded')
     AND tenant.status='active'
     AND NOT EXISTS (
       SELECT 1 FROM control_plane.deletion_requests AS deletion
        WHERE deletion.tenant_id=candidate.tenant_id
          AND (deletion.scope='tenant' OR deletion.connection_id=candidate.connection_id)
          AND deletion.status IN ('queued','running','retry_wait','verifying','failed')
     )
   FOR SHARE OF candidate,connection,tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attested webhook receipt is not writable' USING ERRCODE='55000';
  END IF;
  expected_key:=concat_ws(
    '/','tenant',receipt.tenant_id,'connection',receipt.connection_id,'stream',
    'webhook_'||receipt.connector_key,'date',
    to_char(receipt.received_at AT TIME ZONE 'UTC','YYYY-MM-DD'),
    'batch-'||receipt.webhook_receipt_id||'.json.gz'
  );
  IF receipt.raw_object_key IS NOT NULL AND receipt.raw_object_key<>expected_key THEN
    RAISE EXCEPTION 'webhook receipt has conflicting raw object authority' USING ERRCODE='22000';
  END IF;
  IF receipt.connector_key='xero' THEN
    IF receipt.vendor_event_id IS DISTINCT FROM p_verification_reference
       OR p_xero_lease_owner !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
       OR p_xero_lease_token !~ '^[A-Za-z0-9_-]{22}$'
       OR p_xero_lease_version IS NULL OR p_xero_lease_version<1 THEN
      RAISE EXCEPTION 'Xero raw Storage lease identity is invalid' USING ERRCODE='22023';
    END IF;
    SELECT inbox.lease_expires_at INTO lease_deadline
      FROM control_plane.xero_webhook_inbox AS inbox
     WHERE inbox.inbox_id=p_verification_reference
       AND inbox.status='processing'
       AND inbox.lease_owner=p_xero_lease_owner
       AND inbox.lease_token=p_xero_lease_token
       AND inbox.lease_version=p_xero_lease_version
       AND inbox.lease_expires_at>clock_timestamp()
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Xero raw Storage lease is not active' USING ERRCODE='55000';
    END IF;
  ELSE
    IF p_xero_lease_owner IS NOT NULL OR p_xero_lease_token IS NOT NULL
       OR p_xero_lease_version IS NOT NULL OR NOT EXISTS (
         SELECT 1 FROM control_plane.deputy_webhook_material AS material
          WHERE material.tenant_id=receipt.tenant_id
            AND material.connection_id=receipt.connection_id
            AND material.material_id=p_verification_reference
            AND material.setup_status='active'
            AND material.retired_at IS NULL
       ) THEN
      RAISE EXCEPTION 'Deputy raw Storage verifier authority is not active' USING ERRCODE='55000';
    END IF;
    lease_deadline:=clock_timestamp()+interval '2 minutes';
  END IF;
  deadline:=least(
    p_auth_token_expires_at,lease_deadline,clock_timestamp()+interval '2 minutes'
  );
  IF deadline<=clock_timestamp()+interval '5 seconds' THEN
    RAISE EXCEPTION 'webhook raw Storage grant would already be expired' USING ERRCODE='55000';
  END IF;
  DELETE FROM control_plane.raw_storage_webhook_session_grants AS expired
   WHERE expired.grant_id IN (
     SELECT candidate.grant_id
       FROM control_plane.raw_storage_webhook_session_grants AS candidate
      WHERE candidate.expires_at<=clock_timestamp()
      ORDER BY candidate.expires_at,candidate.grant_id
      LIMIT 100
   );
  generated_id:=control_plane.generate_ulid();
  INSERT INTO control_plane.raw_storage_webhook_session_grants(
    tenant_id,grant_id,connection_id,webhook_receipt_id,connector_key,
    verification_reference,auth_user_id,auth_session_id,object_key,
    xero_inbox_id,xero_lease_owner,xero_lease_token,xero_lease_version,expires_at
  ) VALUES (
    receipt.tenant_id,generated_id,receipt.connection_id,receipt.webhook_receipt_id,
    receipt.connector_key,p_verification_reference,p_auth_user_id,p_auth_session_id,
    expected_key,
    CASE WHEN receipt.connector_key='xero' THEN p_verification_reference END,
    p_xero_lease_owner,p_xero_lease_token,p_xero_lease_version,deadline
  );
  RETURN QUERY SELECT generated_id,receipt.tenant_id,receipt.connection_id,expected_key,deadline;
END;
$$;

CREATE FUNCTION control_plane.revoke_raw_storage_webhook_session(
  p_tenant_id text,p_webhook_receipt_id text,p_grant_id text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE revoked boolean;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_webhook_control_runtime','albert_webhook_control'
  );
  DELETE FROM control_plane.raw_storage_webhook_session_grants
   WHERE tenant_id=p_tenant_id
     AND webhook_receipt_id=p_webhook_receipt_id
     AND grant_id=p_grant_id
  RETURNING true INTO revoked;
  RETURN coalesce(revoked,false);
END;
$$;

CREATE FUNCTION control_plane.issue_raw_storage_deletion_session(
  p_message_id bigint,
  p_deletion_request_id text,
  p_worker_id text,
  p_read_count integer,
  p_operation text,
  p_auth_user_id uuid,
  p_auth_session_id uuid,
  p_auth_token_expires_at timestamptz
)
RETURNS TABLE (
  grant_id text,tenant_id text,scope text,connection_id text,operation text,
  expires_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  request control_plane.deletion_requests%ROWTYPE;
  attempt_deadline timestamptz;
  deadline timestamptz;
  generated_id text;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_deletion_control_runtime','albert_deletion_control'
  );
  IF p_operation NOT IN ('purge','verify')
     OR p_auth_user_id IS NULL OR p_auth_session_id IS NULL
     OR p_auth_token_expires_at<=clock_timestamp()+interval '5 seconds'
     OR NOT extensions.albert_raw_storage_machine_user_matches('deletion',p_auth_user_id) THEN
    RAISE EXCEPTION 'raw Storage deletion Auth session is invalid' USING ERRCODE='22023';
  END IF;
  request:=control_plane.require_active_deletion_lease(
    p_message_id,p_deletion_request_id,p_worker_id,p_read_count
  );
  IF (p_operation='purge' AND request.status<>'running')
     OR (p_operation='verify' AND request.status<>'verifying') THEN
    RAISE EXCEPTION 'raw Storage deletion operation is not in its durable stage'
      USING ERRCODE='55000';
  END IF;
  SELECT attempt.visibility_deadline INTO attempt_deadline
    FROM control_plane.deletion_job_attempts AS attempt
   WHERE attempt.tenant_id=request.tenant_id
     AND attempt.deletion_request_id=request.deletion_request_id
     AND attempt.attempt_number=p_read_count
     AND attempt.worker_id=p_worker_id
     AND attempt.outcome IS NULL
     AND attempt.visibility_deadline>clock_timestamp()
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deletion raw Storage lease is not active' USING ERRCODE='55000';
  END IF;
  deadline:=least(
    p_auth_token_expires_at,attempt_deadline,clock_timestamp()+interval '5 minutes'
  );
  IF deadline<=clock_timestamp()+interval '5 seconds' THEN
    RAISE EXCEPTION 'deletion raw Storage grant would already be expired' USING ERRCODE='55000';
  END IF;
  DELETE FROM control_plane.raw_storage_deletion_session_grants AS expired
   WHERE expired.grant_id IN (
     SELECT candidate.grant_id
       FROM control_plane.raw_storage_deletion_session_grants AS candidate
      WHERE candidate.expires_at<=clock_timestamp()
      ORDER BY candidate.expires_at,candidate.grant_id
      LIMIT 100
   );
  generated_id:=control_plane.generate_ulid();
  INSERT INTO control_plane.raw_storage_deletion_session_grants(
    tenant_id,grant_id,deletion_request_id,attempt_number,worker_id,message_id,
    auth_user_id,auth_session_id,operation,scope,connection_id,expires_at
  ) VALUES (
    request.tenant_id,generated_id,request.deletion_request_id,p_read_count,
    p_worker_id,p_message_id,p_auth_user_id,p_auth_session_id,p_operation,
    request.scope,request.connection_id,deadline
  );
  RETURN QUERY SELECT generated_id,request.tenant_id,request.scope,
                      request.connection_id,p_operation,deadline;
END;
$$;

CREATE FUNCTION control_plane.revoke_raw_storage_deletion_session(
  p_message_id bigint,p_deletion_request_id text,p_worker_id text,
  p_read_count integer,p_grant_id text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE revoked boolean;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_deletion_control_runtime','albert_deletion_control'
  );
  DELETE FROM control_plane.raw_storage_deletion_session_grants
   WHERE deletion_request_id=p_deletion_request_id
     AND message_id=p_message_id AND worker_id=p_worker_id
     AND attempt_number=p_read_count AND grant_id=p_grant_id
  RETURNING true INTO revoked;
  RETURN coalesce(revoked,false);
END;
$$;

CREATE FUNCTION control_plane.assert_raw_storage_session_authority_ready(
  p_purpose text
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  CASE p_purpose
    WHEN 'sync' THEN
      PERFORM control_plane.require_exact_runtime_login(
        'albert_sync_control_runtime','albert_sync_control'
      );
    WHEN 'webhook' THEN
      PERFORM control_plane.require_exact_runtime_login(
        'albert_webhook_control_runtime','albert_webhook_control'
      );
    WHEN 'deletion' THEN
      PERFORM control_plane.require_exact_runtime_login(
        'albert_deletion_control_runtime','albert_deletion_control'
      );
    ELSE
      RAISE EXCEPTION 'raw Storage machine purpose is invalid' USING ERRCODE='22023';
  END CASE;
  IF (p_purpose='sync' AND (
       to_regprocedure('extensions.albert_raw_storage_sync_authorized(text,text)') IS NULL
       OR to_regprocedure('control_plane.issue_raw_storage_sync_session(text,text,text,uuid,uuid,timestamp with time zone)') IS NULL
     )) OR (p_purpose='webhook' AND (
       to_regprocedure('extensions.albert_raw_storage_webhook_authorized(text,text)') IS NULL
       OR to_regprocedure('control_plane.issue_raw_storage_webhook_session(text,text,text,text,text,text,bigint,uuid,uuid,timestamp with time zone)') IS NULL
     )) OR (p_purpose='deletion' AND (
       to_regprocedure('extensions.albert_raw_storage_deletion_authorized(text,text)') IS NULL
       OR to_regprocedure('control_plane.issue_raw_storage_deletion_session(bigint,text,text,integer,text,uuid,uuid,timestamp with time zone)') IS NULL
     )) THEN
    RAISE EXCEPTION 'lease-bound raw Storage authority is incomplete' USING ERRCODE='55000';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION
  control_plane.issue_raw_storage_sync_session(text,text,text,uuid,uuid,timestamptz),
  control_plane.revoke_raw_storage_sync_session(text,text,text,text),
  control_plane.issue_raw_storage_webhook_session(text,text,text,text,text,text,bigint,uuid,uuid,timestamptz),
  control_plane.revoke_raw_storage_webhook_session(text,text,text),
  control_plane.issue_raw_storage_deletion_session(bigint,text,text,integer,text,uuid,uuid,timestamptz),
  control_plane.revoke_raw_storage_deletion_session(bigint,text,text,integer,text),
  control_plane.assert_raw_storage_session_authority_ready(text)
FROM PUBLIC,anon,authenticated,service_role,
     albert_sync_control,albert_webhook_control,albert_transform_control,
     albert_semantic_control,albert_operator_diagnostic_control,
     albert_deletion_control;

GRANT EXECUTE ON FUNCTION
  control_plane.issue_raw_storage_sync_session(text,text,text,uuid,uuid,timestamptz),
  control_plane.revoke_raw_storage_sync_session(text,text,text,text)
TO albert_sync_control;
GRANT EXECUTE ON FUNCTION
  control_plane.issue_raw_storage_webhook_session(text,text,text,text,text,text,bigint,uuid,uuid,timestamptz),
  control_plane.revoke_raw_storage_webhook_session(text,text,text)
TO albert_webhook_control;
GRANT EXECUTE ON FUNCTION
  control_plane.issue_raw_storage_deletion_session(bigint,text,text,integer,text,uuid,uuid,timestamptz),
  control_plane.revoke_raw_storage_deletion_session(bigint,text,text,integer,text)
TO albert_deletion_control;
GRANT EXECUTE ON FUNCTION control_plane.assert_raw_storage_session_authority_ready(text)
TO albert_sync_control,albert_webhook_control,albert_deletion_control;

-- The administrator upgrade was deliberately closed until all grant tables
-- existed. Verify the final cross-schema policy graph once. The
-- SECURITY DEFINER verifier revokes this migration role's one-use EXECUTE
-- grant from inside the successful call, so the non-owner migration must not
-- attempt a second REVOKE afterward.
SELECT extensions.albert_verify_lease_bound_raw_storage_authority();

COMMIT;
