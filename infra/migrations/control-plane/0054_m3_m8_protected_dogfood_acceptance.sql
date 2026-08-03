BEGIN;

-- Release evidence is captured by the one-purpose diagnostic login. Customer
-- identifiers never enter this ledger: only candidate metadata, bounded
-- counts, generations and content digests survive the transaction.
CREATE OR REPLACE FUNCTION control_plane.dogfood_evidence_sha256(p_value jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path=pg_catalog
AS $$
  SELECT encode(extensions.digest(convert_to(p_value::text,'UTF8'),'sha256'),'hex')
$$;

CREATE TABLE IF NOT EXISTS control_plane.protected_dogfood_acceptance_snapshots (
  snapshot_id text PRIMARY KEY CHECK (control_plane.is_ulid(snapshot_id)),
  candidate_sha text NOT NULL CHECK (candidate_sha ~ '^[a-f0-9]{40}$'),
  evidence jsonb NOT NULL CHECK (
    jsonb_typeof(evidence)='object'
    AND evidence ?& ARRAY[
      'schemaVersion','capturedAt','candidateSha','deployment','connections','milestones','references'
    ]
    AND evidence - ARRAY[
      'schemaVersion','capturedAt','candidateSha','deployment','connections','milestones','references'
    ]='{}'::jsonb
  ),
  evidence_digest text NOT NULL UNIQUE CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (evidence_digest=control_plane.dogfood_evidence_sha256(evidence)),
  CHECK (candidate_sha=evidence->>'candidateSha'),
  CHECK ((evidence->>'schemaVersion')::integer=1)
);

-- Consumption is a separate append-only fact. A snapshot can authorize only
-- one production release run, even while its short signature TTL is valid.
CREATE TABLE IF NOT EXISTS control_plane.protected_dogfood_acceptance_consumptions (
  snapshot_id text PRIMARY KEY REFERENCES
    control_plane.protected_dogfood_acceptance_snapshots(snapshot_id) ON DELETE RESTRICT,
  candidate_sha text NOT NULL CHECK (candidate_sha ~ '^[a-f0-9]{40}$'),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  release_workflow_run_id text NOT NULL UNIQUE CHECK (release_workflow_run_id ~ '^[1-9][0-9]{0,19}$'),
  repository text NOT NULL CHECK (repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Database-clocked first observation is the deployment barrier. Worker-
-- supplied started_at is useful health metadata but cannot backdate this fact.
CREATE TABLE IF NOT EXISTS control_plane.protected_dogfood_runtime_observations (
  service_name text NOT NULL CHECK (
    service_name IN ('sync-worker','transform-worker','deletion-worker')
  ),
  candidate_sha text NOT NULL CHECK (candidate_sha ~ '^[a-f0-9]{40}$'),
  deployment_id text NOT NULL CHECK (deployment_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  first_observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (service_name,candidate_sha,deployment_id)
);

-- M5 executes through the same durable conversation-turn lease checked by the
-- semantic capability issuer. Issuance and terminal results are distinct
-- append-only facts, so a case/pass cannot be replayed with invented IDs.
CREATE TABLE IF NOT EXISTS control_plane.protected_dogfood_semantic_turn_leases (
  lease_id text PRIMARY KEY CHECK (control_plane.is_ulid(lease_id)),
  tenant_id text NOT NULL CHECK (control_plane.is_ulid(tenant_id)),
  candidate_sha text NOT NULL CHECK (candidate_sha ~ '^[a-f0-9]{40}$'),
  deployment_id text NOT NULL CHECK (deployment_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  workflow_run_id text NOT NULL CHECK (workflow_run_id ~ '^[1-9][0-9]{0,19}$'),
  workflow_run_attempt integer,
  case_id text NOT NULL CHECK (case_id ~ '^[a-z][a-z0-9_-]{1,79}$'),
  pass smallint NOT NULL CHECK (pass IN (1,2)),
  conversation_id text NOT NULL CHECK (control_plane.is_ulid(conversation_id)),
  turn_id text NOT NULL CHECK (control_plane.is_ulid(turn_id)),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  UNIQUE (tenant_id,turn_id),
  FOREIGN KEY (tenant_id,turn_id)
    REFERENCES control_plane.conversation_turns(tenant_id,turn_id) ON DELETE CASCADE,
  CHECK (expires_at>issued_at AND expires_at<=issued_at+interval '3 minutes')
);

ALTER TABLE control_plane.protected_dogfood_semantic_turn_leases
  ADD COLUMN IF NOT EXISTS workflow_run_attempt integer NOT NULL DEFAULT 1;
ALTER TABLE control_plane.protected_dogfood_semantic_turn_leases
  ALTER COLUMN workflow_run_attempt SET NOT NULL,
  ALTER COLUMN workflow_run_attempt DROP DEFAULT,
  DROP CONSTRAINT IF EXISTS protected_dogfood_semantic_turn_leases_run_attempt_check,
  ADD CONSTRAINT protected_dogfood_semantic_turn_leases_run_attempt_check
    CHECK (workflow_run_attempt BETWEEN 1 AND 10000),
  DROP CONSTRAINT IF EXISTS protected_dogfood_semantic_turn_leases_workflow_run_id_case_id_pass_key,
  DROP CONSTRAINT IF EXISTS protected_dogfood_semantic_tur_workflow_run_id_case_id_pass_key,
  DROP CONSTRAINT IF EXISTS protected_dogfood_semantic_turn_leases_run_case_pass_unique,
  ADD CONSTRAINT protected_dogfood_semantic_turn_leases_run_case_pass_unique
    UNIQUE (workflow_run_id,workflow_run_attempt,case_id,pass);

CREATE TABLE IF NOT EXISTS control_plane.protected_dogfood_semantic_turn_results (
  lease_id text PRIMARY KEY REFERENCES
    control_plane.protected_dogfood_semantic_turn_leases(lease_id) ON DELETE CASCADE,
  succeeded boolean NOT NULL,
  result_digest text NOT NULL CHECK (result_digest ~ '^[a-f0-9]{64}$'),
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION control_plane.reject_protected_dogfood_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'protected dogfood evidence is append-only' USING ERRCODE='55000';
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.reject_protected_dogfood_semantic_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog
AS $$
BEGIN
  -- These short-lived operational leases contain a dogfood tenant id so the
  -- real semantic capability path can be exercised. The ordinary runtime is
  -- append-only, while the existing authorized tenant-erasure transaction may
  -- cascade them with the conversation rows.
  IF control_plane.deletion_mutation_authorized() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'protected dogfood semantic evidence is append-only' USING ERRCODE='55000';
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.capture_protected_dogfood_runtime_observation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE observed_service text:=NEW.health_metadata->>'service';
DECLARE expected_service text:=CASE session_user
  WHEN 'albert_sync_control_runtime' THEN 'sync-worker'
  WHEN 'albert_transform_control_runtime' THEN 'transform-worker'
  WHEN 'albert_deletion_control_runtime' THEN 'deletion-worker'
  ELSE NULL
END;
BEGIN
  IF observed_service=expected_service
     AND NEW.health_metadata->>'ready'='true'
     AND NEW.service_version ~ '^[a-f0-9]{40}$'
     AND NEW.deployment_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$' THEN
    INSERT INTO control_plane.protected_dogfood_runtime_observations(
      service_name,candidate_sha,deployment_id,first_observed_at
    ) VALUES(observed_service,NEW.service_version,NEW.deployment_id,clock_timestamp())
    ON CONFLICT ON CONSTRAINT protected_dogfood_runtime_observations_pkey DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS worker_heartbeat_dogfood_runtime_observation
  ON control_plane.worker_heartbeats;
CREATE TRIGGER worker_heartbeat_dogfood_runtime_observation
  AFTER INSERT OR UPDATE ON control_plane.worker_heartbeats
  FOR EACH ROW EXECUTE FUNCTION control_plane.capture_protected_dogfood_runtime_observation();

DROP TRIGGER IF EXISTS protected_dogfood_snapshots_append_only
  ON control_plane.protected_dogfood_acceptance_snapshots;
CREATE TRIGGER protected_dogfood_snapshots_append_only
  BEFORE UPDATE OR DELETE ON control_plane.protected_dogfood_acceptance_snapshots
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_protected_dogfood_evidence_mutation();
DROP TRIGGER IF EXISTS protected_dogfood_consumptions_append_only
  ON control_plane.protected_dogfood_acceptance_consumptions;
CREATE TRIGGER protected_dogfood_consumptions_append_only
  BEFORE UPDATE OR DELETE ON control_plane.protected_dogfood_acceptance_consumptions
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_protected_dogfood_evidence_mutation();
DROP TRIGGER IF EXISTS protected_dogfood_runtime_observations_append_only
  ON control_plane.protected_dogfood_runtime_observations;
CREATE TRIGGER protected_dogfood_runtime_observations_append_only
  BEFORE UPDATE OR DELETE ON control_plane.protected_dogfood_runtime_observations
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_protected_dogfood_evidence_mutation();
DROP TRIGGER IF EXISTS protected_dogfood_semantic_leases_append_only
  ON control_plane.protected_dogfood_semantic_turn_leases;
CREATE TRIGGER protected_dogfood_semantic_leases_append_only
  BEFORE UPDATE OR DELETE ON control_plane.protected_dogfood_semantic_turn_leases
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_protected_dogfood_semantic_mutation();
DROP TRIGGER IF EXISTS protected_dogfood_semantic_results_append_only
  ON control_plane.protected_dogfood_semantic_turn_results;
CREATE TRIGGER protected_dogfood_semantic_results_append_only
  BEFORE UPDATE OR DELETE ON control_plane.protected_dogfood_semantic_turn_results
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_protected_dogfood_semantic_mutation();

CREATE OR REPLACE FUNCTION control_plane.protected_dogfood_deployment_barrier(
  p_candidate_sha text,p_deployment_id text
) RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE barrier_at timestamptz;service_count integer;
BEGIN
  IF p_candidate_sha !~ '^[a-f0-9]{40}$'
     OR p_deployment_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$' THEN
    RAISE EXCEPTION 'dogfood deployment identity is invalid' USING ERRCODE='22023';
  END IF;
  WITH required(service) AS (
    VALUES ('sync-worker'),('transform-worker'),('deletion-worker')
  ),active AS (
    SELECT heartbeat.health_metadata->>'service' AS service
      FROM control_plane.worker_heartbeats heartbeat
      JOIN required ON required.service=heartbeat.health_metadata->>'service'
     WHERE heartbeat.service_version=p_candidate_sha
       AND heartbeat.deployment_id=p_deployment_id
       AND heartbeat.health_metadata->>'ready'='true'
       AND heartbeat.last_seen_at>=clock_timestamp()-interval '90 seconds'
       AND heartbeat.started_at<=clock_timestamp()+interval '5 minutes'
     GROUP BY heartbeat.health_metadata->>'service'
  ),observed AS (
    SELECT observation.service_name AS service,observation.first_observed_at
      FROM control_plane.protected_dogfood_runtime_observations observation
      JOIN required ON required.service=observation.service_name
     WHERE observation.candidate_sha=p_candidate_sha
       AND observation.deployment_id=p_deployment_id
  )
  SELECT count(*),max(observed.first_observed_at)
    INTO service_count,barrier_at
    FROM active JOIN observed USING(service);
  IF service_count<>3 OR barrier_at IS NULL THEN
    RAISE EXCEPTION 'candidate deployment does not have all fresh worker barriers'
      USING ERRCODE='55000';
  END IF;
  RETURN barrier_at;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.issue_protected_dogfood_semantic_turn(
  p_tenant_id text,p_candidate_sha text,p_deployment_id text,
  p_workflow_run_id text,p_workflow_run_attempt integer,p_case_id text,p_pass integer
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE issued timestamptz:=clock_timestamp();expires timestamptz:=issued+interval '3 minutes';
DECLARE barrier_at timestamptz;owner_id uuid;lease_id text:=control_plane.generate_ulid();
DECLARE conversation_id text:=control_plane.generate_ulid();turn_id text:=control_plane.generate_ulid();
BEGIN
  PERFORM control_plane.assert_operator_diagnostic_control_ready();
  IF NOT control_plane.is_ulid(p_tenant_id)
     OR p_workflow_run_id !~ '^[1-9][0-9]{0,19}$'
     OR p_workflow_run_attempt IS NULL OR p_workflow_run_attempt NOT BETWEEN 1 AND 10000
     OR p_case_id !~ '^[a-z][a-z0-9_-]{1,79}$'
     OR p_pass IS NULL OR p_pass NOT IN (1,2) THEN
    RAISE EXCEPTION 'dogfood semantic lease input is invalid' USING ERRCODE='22023';
  END IF;
  barrier_at:=control_plane.protected_dogfood_deployment_barrier(
    p_candidate_sha,p_deployment_id
  );
  IF issued<barrier_at THEN
    RAISE EXCEPTION 'dogfood semantic lease predates candidate deployment' USING ERRCODE='55000';
  END IF;
  SELECT membership.user_id INTO owner_id
    FROM control_plane.memberships membership
    JOIN control_plane.tenants tenant ON tenant.tenant_id=membership.tenant_id
   WHERE membership.tenant_id=p_tenant_id
     AND membership.role='owner' AND membership.status='active'
     AND tenant.status='active'
   ORDER BY membership.created_at,membership.membership_id LIMIT 1;
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'dogfood tenant has no active owner' USING ERRCODE='55000';
  END IF;
  INSERT INTO control_plane.conversations(
    tenant_id,conversation_id,title,status,created_by,created_at,updated_at
  ) VALUES(
    p_tenant_id,conversation_id,'Protected dogfood semantic probe','active',owner_id,issued,issued
  );
  INSERT INTO control_plane.conversation_turns(
    tenant_id,turn_id,conversation_id,turn_number,user_message,runtime_profile,
    status,created_by,created_at,lease_expires_at
  ) VALUES(
    p_tenant_id,turn_id,conversation_id,1,
    'Protected dogfood semantic case '||p_case_id||' pass '||p_pass,
    jsonb_build_object(
      'runtime','protected-dogfood-semantic','candidateSha',p_candidate_sha,
      'deploymentId',p_deployment_id,'caseId',p_case_id,'pass',p_pass
    ),'running',owner_id,issued,expires
  );
  INSERT INTO control_plane.protected_dogfood_semantic_turn_leases(
    lease_id,tenant_id,candidate_sha,deployment_id,case_id,pass,
    workflow_run_id,workflow_run_attempt,conversation_id,turn_id,issued_at,expires_at
  ) VALUES(
    lease_id,p_tenant_id,p_candidate_sha,p_deployment_id,p_case_id,p_pass,
    p_workflow_run_id,p_workflow_run_attempt,conversation_id,turn_id,issued,expires
  );
  RETURN jsonb_build_object(
    'leaseId',lease_id,'conversationId',conversation_id,
    'turnId',turn_id,'expiresAt',expires
  );
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'dogfood semantic case pass was already issued' USING ERRCODE='55000';
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.finish_protected_dogfood_semantic_turn(
  p_lease_id text,p_succeeded boolean,p_result_digest text
) RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE lease control_plane.protected_dogfood_semantic_turn_leases%ROWTYPE;
BEGIN
  PERFORM control_plane.assert_operator_diagnostic_control_ready();
  IF NOT control_plane.is_ulid(p_lease_id) OR p_succeeded IS NULL
     OR p_result_digest !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'dogfood semantic result input is invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO lease FROM control_plane.protected_dogfood_semantic_turn_leases candidate
   WHERE candidate.lease_id=p_lease_id FOR SHARE;
  IF NOT FOUND OR lease.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'dogfood semantic turn lease is absent or expired' USING ERRCODE='55000';
  END IF;
  INSERT INTO control_plane.protected_dogfood_semantic_turn_results(
    lease_id,succeeded,result_digest
  ) VALUES(p_lease_id,p_succeeded,p_result_digest);
  -- A direct semantic-tool probe has no assistant answer artifact. Terminate it
  -- as a diagnostic turn; the separate immutable result records probe success.
  UPDATE control_plane.conversation_turns turn_record
     SET status='failed',result_digest=p_result_digest,completed_at=clock_timestamp()
   WHERE turn_record.tenant_id=lease.tenant_id AND turn_record.turn_id=lease.turn_id
     AND turn_record.conversation_id=lease.conversation_id
     AND turn_record.status='running' AND turn_record.lease_expires_at>clock_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dogfood semantic conversation turn is no longer active' USING ERRCODE='55000';
  END IF;
  UPDATE control_plane.conversations conversation
     SET status='archived',archived_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE conversation.tenant_id=lease.tenant_id
     AND conversation.conversation_id=lease.conversation_id;
  RETURN true;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'dogfood semantic turn lease was already finalized' USING ERRCODE='55000';
END;
$$;

-- Reconnects are new authorization epochs. Persist the exact epoch in every
-- deletion proof's remote-revocation evidence.
CREATE OR REPLACE FUNCTION control_plane.deletion_revocation_context(
  p_message_id bigint,p_deletion_request_id text,p_worker_id text,p_read_count integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE request_row control_plane.deletion_requests%ROWTYPE;targets jsonb;
BEGIN
  request_row:=control_plane.require_active_deletion_lease(
    p_message_id,p_deletion_request_id,p_worker_id,p_read_count
  );
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'tenantId',token.tenant_id,
    'connectionId',token.connection_id,
    'connectionGeneration',connection.connection_generation,
    'connectorId',connection.connector_key,
    'credentialRef',token.secret_reference
  ) ORDER BY token.connection_id),'[]'::jsonb)
    INTO targets
    FROM control_plane.oauth_token_refs token
    JOIN control_plane.connections connection
      ON connection.tenant_id=token.tenant_id
     AND connection.connection_id=token.connection_id
   WHERE token.tenant_id=request_row.tenant_id
     AND (request_row.scope='tenant' OR token.connection_id=request_row.connection_id);
  RETURN jsonb_build_object(
    'priorStatus',request_row.remote_revocation_status,
    'priorProgress',request_row.progress,
    'targets',targets
  );
END;
$$;

-- Durable progress and proof persistence consume the same exact, privacy-safe
-- contracts as the worker. The database boundary prevents a caller with a
-- narrow lease from substituting free text, proof-shaped booleans, or
-- inconsistent residual totals.
CREATE OR REPLACE FUNCTION control_plane.require_measured_analytical_deletion(
  p_analytical jsonb,p_scope text
) RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
SET search_path=pg_catalog
AS $$
DECLARE
  residual_key text;
  residual_value jsonb;
  residual_total bigint:=0;
  remaining_value jsonb;
  remaining_rows bigint;
BEGIN
  IF jsonb_typeof(p_analytical) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_analytical->'residuals') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'analytical deletion attestation is missing' USING ERRCODE='55000';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_analytical))<>5
     OR (p_analytical ?& ARRAY[
       'verified','scope','measurement','remainingRows','residuals'
     ]) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'analytical deletion attestation fields are invalid' USING ERRCODE='55000';
  END IF;
  IF p_scope IS NULL OR p_scope NOT IN ('connection','tenant')
     OR p_analytical->>'scope' IS DISTINCT FROM p_scope
     OR p_analytical->>'measurement' IS DISTINCT FROM 'post_purge_row_counts_v1'
     OR jsonb_typeof(p_analytical->'verified') IS DISTINCT FROM 'boolean'
     OR p_analytical->'verified'<>'true'::jsonb THEN
    RAISE EXCEPTION 'analytical deletion attestation identity is invalid' USING ERRCODE='55000';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_analytical->'residuals'))<>7
     OR (p_analytical->'residuals' ?& ARRAY[
       'stagingRows','canonicalRows','bridgeRows','linkRows',
       'embeddingRows','cacheRows','otherAnalyticalRows'
     ]) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'analytical deletion residual classes are incomplete' USING ERRCODE='55000';
  END IF;
  FOREACH residual_key IN ARRAY ARRAY[
    'stagingRows','canonicalRows','bridgeRows','linkRows',
    'embeddingRows','cacheRows','otherAnalyticalRows'
  ] LOOP
    residual_value:=p_analytical->'residuals'->residual_key;
    IF jsonb_typeof(residual_value) IS DISTINCT FROM 'number'
       OR residual_value::text !~ '^(0|[1-9][0-9]*)$' THEN
      RAISE EXCEPTION 'analytical deletion residual count is invalid' USING ERRCODE='55000';
    END IF;
    residual_total:=residual_total+(residual_value::text)::bigint;
  END LOOP;
  remaining_value:=p_analytical->'remainingRows';
  IF jsonb_typeof(remaining_value) IS DISTINCT FROM 'number'
     OR remaining_value::text !~ '^(0|[1-9][0-9]*)$' THEN
    RAISE EXCEPTION 'analytical deletion residual total is invalid' USING ERRCODE='55000';
  END IF;
  remaining_rows:=(remaining_value::text)::bigint;
  IF remaining_rows<>residual_total OR residual_total<>0 THEN
    RAISE EXCEPTION 'analytical deletion residual total is not zero' USING ERRCODE='55000';
  END IF;
  RETURN residual_total;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.require_nonnegative_deletion_count(p_value jsonb)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
SET search_path=pg_catalog
AS $$
DECLARE result bigint;
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'number'
     OR p_value::text !~ '^(0|[1-9][0-9]*)$'
     OR length(p_value::text)>18 THEN
    RAISE EXCEPTION 'deletion proof count is invalid' USING ERRCODE='55000';
  END IF;
  result:=(p_value::text)::bigint;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.require_zero_deletion_count(p_value jsonb)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
SET search_path=pg_catalog
AS $$
DECLARE result bigint;
BEGIN
  result:=control_plane.require_nonnegative_deletion_count(p_value);
  IF result<>0 THEN
    RAISE EXCEPTION 'deletion proof contains a non-zero residual' USING ERRCODE='55000';
  END IF;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.require_privacy_safe_remote_revocation(
  p_remote jsonb
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path=pg_catalog
AS $$
DECLARE
  target jsonb;
  target_count bigint;
  target_status text;
  error_code text;
  error_class text;
  expected_error_class text;
BEGIN
  IF jsonb_typeof(p_remote) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'remote revocation proof fields are invalid' USING ERRCODE='55000';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_remote)) NOT IN (5,7)
     OR (p_remote ?& ARRAY[
       'attemptedAt','priorStatus','targetCount','targets','bestEffort'
     ]) IS DISTINCT FROM true
     OR jsonb_typeof(p_remote->'attemptedAt') IS DISTINCT FROM 'string'
     OR p_remote->>'attemptedAt' !~
       '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
     OR jsonb_typeof(p_remote->'priorStatus') IS DISTINCT FROM 'string'
     OR p_remote->>'priorStatus' NOT IN (
       'pending','succeeded','unsupported','failed','not_applicable'
     )
     OR jsonb_typeof(p_remote->'targetCount') IS DISTINCT FROM 'number'
     OR (p_remote->'targetCount')::text !~ '^(0|[1-9][0-9]*)$'
     OR length((p_remote->'targetCount')::text)>18
     OR jsonb_typeof(p_remote->'targets') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_remote->'bestEffort') IS DISTINCT FROM 'boolean'
     OR (p_remote->'bestEffort')<>'true'::jsonb THEN
    RAISE EXCEPTION 'remote revocation proof fields are invalid' USING ERRCODE='55000';
  END IF;
  target_count:=((p_remote->'targetCount')::text)::bigint;
  IF (SELECT count(*) FROM jsonb_object_keys(p_remote))=7 AND (
       (p_remote ?& ARRAY['forcedLocalDestruction','reason']) IS DISTINCT FROM true
       OR jsonb_typeof(p_remote->'forcedLocalDestruction') IS DISTINCT FROM 'boolean'
       OR (p_remote->'forcedLocalDestruction')<>'true'::jsonb
       OR jsonb_typeof(p_remote->'reason') IS DISTINCT FROM 'string'
       OR p_remote->>'reason'<>'remote_revocation_grace_expired'
       OR p_remote->>'priorStatus'<>'failed'
       OR target_count<>0
     ) THEN
    RAISE EXCEPTION 'forced local destruction proof is invalid' USING ERRCODE='55000';
  END IF;
  IF target_count<>jsonb_array_length(p_remote->'targets') THEN
    RAISE EXCEPTION 'remote revocation target count is inconsistent' USING ERRCODE='55000';
  END IF;
  FOR target IN SELECT item.value FROM jsonb_array_elements(p_remote->'targets') item LOOP
    IF jsonb_typeof(target) IS DISTINCT FROM 'object'
       OR (target ?& ARRAY['provider','connectionGeneration','status']) IS DISTINCT FROM true
       OR jsonb_typeof(target->'provider') IS DISTINCT FROM 'string'
       OR target->>'provider' NOT IN ('lightspeed-r','xero','deputy')
       OR jsonb_typeof(target->'connectionGeneration') IS DISTINCT FROM 'number'
       OR (target->'connectionGeneration')::text !~ '^[1-9][0-9]*$'
       OR length((target->'connectionGeneration')::text)>18
       OR jsonb_typeof(target->'status') IS DISTINCT FROM 'string'
       OR target->>'status' NOT IN ('succeeded','unsupported','failed') THEN
      RAISE EXCEPTION 'remote revocation target fields are invalid' USING ERRCODE='55000';
    END IF;
    target_status:=target->>'status';
    IF target_status<>'failed' THEN
      IF (SELECT count(*) FROM jsonb_object_keys(target))<>3 THEN
        RAISE EXCEPTION 'successful remote revocation target has extra fields' USING ERRCODE='55000';
      END IF;
      CONTINUE;
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(target))<>6
       OR (target ?& ARRAY['errorCode','errorClass','correlationId']) IS DISTINCT FROM true
       OR jsonb_typeof(target->'errorCode') IS DISTINCT FROM 'string'
       OR jsonb_typeof(target->'errorClass') IS DISTINCT FROM 'string'
       OR jsonb_typeof(target->'correlationId') IS DISTINCT FROM 'string'
       OR target->>'correlationId' !~ '^[0-9A-HJKMNP-TV-Z]{26}$' THEN
      RAISE EXCEPTION 'failed remote revocation evidence is invalid' USING ERRCODE='55000';
    END IF;
    error_code:=target->>'errorCode';
    error_class:=target->>'errorClass';
    expected_error_class:=CASE
      WHEN error_code IN (
        'connector_authentication_required','connector_capability_unavailable',
        'connector_configuration_invalid','connector_credential_conflict',
        'connector_cursor_invalid','connector_oauth_exchange_failed',
        'connector_rate_limited','connector_remote_response_invalid',
        'connector_remote_unavailable','connector_webhook_signature_invalid'
      ) THEN 'connector'
      WHEN error_code IN (
        'database_serialization_conflict','database_deadlock',
        'database_permission_denied','deletion_fence_conflict',
        'database_unavailable','database_integrity_violation'
      ) THEN 'database'
      WHEN error_code IN ('operation_aborted','operation_timeout') THEN 'timeout'
      WHEN error_code IN (
        'internal_type_error','internal_syntax_error','unexpected_deletion_failure'
      ) THEN 'internal'
      ELSE NULL
    END;
    IF expected_error_class IS NULL OR error_class IS DISTINCT FROM expected_error_class THEN
      RAISE EXCEPTION 'failed remote revocation code is invalid' USING ERRCODE='55000';
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.require_privacy_safe_deletion_stores(
  p_stores jsonb,p_scope text
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path=pg_catalog
AS $$
BEGIN
  IF jsonb_typeof(p_stores) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_stores->'credential_vault') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_stores->'raw_storage') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_stores->'control_plane') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'deletion store proof fields are invalid' USING ERRCODE='55000';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_stores))<>4
     OR (p_stores ?& ARRAY[
       'credential_vault','raw_storage','analytical','control_plane'
     ]) IS DISTINCT FROM true
     OR (SELECT count(*) FROM jsonb_object_keys(p_stores->'credential_vault'))<>4
     OR (p_stores->'credential_vault' ?& ARRAY[
       'verified','tokenReferences','credentialEnvelopes','sessionEnvelopes'
     ]) IS DISTINCT FROM true
     OR (SELECT count(*) FROM jsonb_object_keys(p_stores->'raw_storage'))<>2
     OR (p_stores->'raw_storage' ?& ARRAY['verified','remainingObjects']) IS DISTINCT FROM true
     OR (SELECT count(*) FROM jsonb_object_keys(p_stores->'control_plane'))<>4
     OR (p_stores->'control_plane' ?& ARRAY[
       'verified','remainingTenantOrConnectionRows',
       'remainingDerivedArtifacts','remainingQueueMessages'
     ]) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'deletion store proof fields are invalid' USING ERRCODE='55000';
  END IF;
  IF jsonb_typeof(p_stores#>'{credential_vault,verified}') IS DISTINCT FROM 'boolean'
     OR p_stores#>'{credential_vault,verified}'<>'true'::jsonb
     OR jsonb_typeof(p_stores#>'{raw_storage,verified}') IS DISTINCT FROM 'boolean'
     OR p_stores#>'{raw_storage,verified}'<>'true'::jsonb
     OR jsonb_typeof(p_stores#>'{control_plane,verified}') IS DISTINCT FROM 'boolean'
     OR p_stores#>'{control_plane,verified}'<>'true'::jsonb THEN
    RAISE EXCEPTION 'deletion store proof is not verified' USING ERRCODE='55000';
  END IF;
  PERFORM control_plane.require_zero_deletion_count(
    p_stores#>'{credential_vault,tokenReferences}'
  );
  PERFORM control_plane.require_zero_deletion_count(
    p_stores#>'{credential_vault,credentialEnvelopes}'
  );
  PERFORM control_plane.require_zero_deletion_count(
    p_stores#>'{credential_vault,sessionEnvelopes}'
  );
  PERFORM control_plane.require_zero_deletion_count(
    p_stores#>'{raw_storage,remainingObjects}'
  );
  PERFORM control_plane.require_measured_analytical_deletion(
    p_stores->'analytical',p_scope
  );
  PERFORM control_plane.require_zero_deletion_count(
    p_stores#>'{control_plane,remainingTenantOrConnectionRows}'
  );
  PERFORM control_plane.require_zero_deletion_count(
    p_stores#>'{control_plane,remainingDerivedArtifacts}'
  );
  PERFORM control_plane.require_zero_deletion_count(
    p_stores#>'{control_plane,remainingQueueMessages}'
  );
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.require_privacy_safe_deletion_progress(
  p_stage text,p_evidence jsonb,p_scope text
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path=pg_catalog
AS $$
BEGIN
  IF p_stage IS NULL OR p_stage NOT IN (
       'remote_revocation','credential_vault','raw_storage',
       'analytical','control_plane','verification'
     )
     OR p_scope IS NULL OR p_scope NOT IN ('connection','tenant')
     OR jsonb_typeof(p_evidence) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'deletion progress is invalid' USING ERRCODE='55000';
  END IF;
  IF p_stage='remote_revocation' THEN
    PERFORM control_plane.require_privacy_safe_remote_revocation(p_evidence);
    RETURN true;
  END IF;
  IF p_stage='credential_vault' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(p_evidence))<>4
       OR (p_evidence ?& ARRAY[
         'verified','tokenReferences','credentialEnvelopes','sessionEnvelopes'
       ]) IS DISTINCT FROM true
       OR jsonb_typeof(p_evidence->'verified') IS DISTINCT FROM 'boolean'
       OR (p_evidence->'verified')<>'true'::jsonb THEN
      RAISE EXCEPTION 'credential deletion progress is invalid' USING ERRCODE='55000';
    END IF;
    PERFORM control_plane.require_zero_deletion_count(p_evidence->'tokenReferences');
    PERFORM control_plane.require_zero_deletion_count(p_evidence->'credentialEnvelopes');
    PERFORM control_plane.require_zero_deletion_count(p_evidence->'sessionEnvelopes');
    RETURN true;
  END IF;
  IF p_stage='raw_storage' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(p_evidence))<>2
       OR (p_evidence ?& ARRAY['verified','objectsRemoved']) IS DISTINCT FROM true
       OR jsonb_typeof(p_evidence->'verified') IS DISTINCT FROM 'boolean'
       OR (p_evidence->'verified')<>'true'::jsonb THEN
      RAISE EXCEPTION 'raw deletion progress is invalid' USING ERRCODE='55000';
    END IF;
    PERFORM control_plane.require_nonnegative_deletion_count(p_evidence->'objectsRemoved');
    RETURN true;
  END IF;
  IF p_stage IN ('analytical','control_plane') THEN
    IF (SELECT count(*) FROM jsonb_object_keys(p_evidence))<>3
       OR (p_evidence ?& ARRAY['verified','scope','rowsRemoved']) IS DISTINCT FROM true
       OR jsonb_typeof(p_evidence->'verified') IS DISTINCT FROM 'boolean'
       OR (p_evidence->'verified')<>'true'::jsonb
       OR jsonb_typeof(p_evidence->'scope') IS DISTINCT FROM 'string'
       OR p_evidence->>'scope' IS DISTINCT FROM p_scope THEN
      RAISE EXCEPTION 'database deletion progress is invalid' USING ERRCODE='55000';
    END IF;
    PERFORM control_plane.require_nonnegative_deletion_count(p_evidence->'rowsRemoved');
    RETURN true;
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_evidence))<>2
     OR (p_evidence ?& ARRAY['verified','storesVerified']) IS DISTINCT FROM true
     OR jsonb_typeof(p_evidence->'verified') IS DISTINCT FROM 'boolean'
     OR (p_evidence->'verified')<>'true'::jsonb
     OR control_plane.require_nonnegative_deletion_count(
       p_evidence->'storesVerified'
     )<>4 THEN
    RAISE EXCEPTION 'deletion verification progress is invalid' USING ERRCODE='55000';
  END IF;
  RETURN true;
END;
$$;

-- The claimed credential-destruction path persists remote evidence before the
-- immutable proof exists. Apply the same exact vocabulary at that earlier
-- boundary, rather than relying only on the later ledger trigger.
CREATE OR REPLACE FUNCTION control_plane.destroy_claimed_deletion_credentials(
  p_message_id bigint,
  p_deletion_request_id text,
  p_worker_id text,
  p_read_count integer,
  p_remote_revocation jsonb
) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  request_row control_plane.deletion_requests%ROWTYPE;
  destroyed_at timestamptz;
  target_count integer;
  failure_count integer;
  success_count integer;
  unsupported_count integer;
  summary_status text;
  prior_remote jsonb;
BEGIN
  request_row:=control_plane.require_active_deletion_lease(
    p_message_id,p_deletion_request_id,p_worker_id,p_read_count
  );
  PERFORM control_plane.require_privacy_safe_remote_revocation(p_remote_revocation);
  IF request_row.credential_destroyed_at IS NOT NULL THEN
    prior_remote:=request_row.progress->'remote_revocation';
    IF jsonb_typeof(prior_remote) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'prior remote revocation evidence is missing' USING ERRCODE='55000';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(prior_remote))=2
       AND (prior_remote ?& ARRAY['forcedLocalDestruction','reason'])
       AND prior_remote->'forcedLocalDestruction'='true'::jsonb
       AND prior_remote->>'reason'='remote_revocation_grace_expired' THEN
      IF (SELECT count(*) FROM jsonb_object_keys(p_remote_revocation))<>7
         OR p_remote_revocation->'forcedLocalDestruction'<>'true'::jsonb THEN
        RAISE EXCEPTION 'forced revocation evidence was not preserved' USING ERRCODE='55000';
      END IF;
    ELSIF prior_remote IS DISTINCT FROM p_remote_revocation THEN
      RAISE EXCEPTION 'remote revocation evidence changed after credential destruction'
        USING ERRCODE='55000';
    END IF;
    RETURN request_row.credential_destroyed_at;
  END IF;
  IF request_row.credential_destroyed_at IS NULL
     AND p_remote_revocation->>'priorStatus'
       IS DISTINCT FROM request_row.remote_revocation_status THEN
    RAISE EXCEPTION 'remote revocation prior status is stale' USING ERRCODE='55000';
  END IF;
  IF (
    EXISTS (
      SELECT 1 FROM (
        (SELECT connection.connector_key AS provider,
                connection.connection_generation::bigint AS generation
           FROM control_plane.oauth_token_refs token
           JOIN control_plane.connections connection
             ON connection.tenant_id=token.tenant_id
            AND connection.connection_id=token.connection_id
          WHERE token.tenant_id=request_row.tenant_id
            AND (request_row.scope='tenant'
              OR token.connection_id=request_row.connection_id))
        EXCEPT ALL
        (SELECT target->>'provider',
                (target->>'connectionGeneration')::bigint
           FROM jsonb_array_elements(p_remote_revocation->'targets') AS item(target))
      ) missing
    ) OR EXISTS (
      SELECT 1 FROM (
        (SELECT target->>'provider' AS provider,
                (target->>'connectionGeneration')::bigint AS generation
           FROM jsonb_array_elements(p_remote_revocation->'targets') AS item(target))
        EXCEPT ALL
        (SELECT connection.connector_key,
                connection.connection_generation::bigint
           FROM control_plane.oauth_token_refs token
           JOIN control_plane.connections connection
             ON connection.tenant_id=token.tenant_id
            AND connection.connection_id=token.connection_id
          WHERE token.tenant_id=request_row.tenant_id
            AND (request_row.scope='tenant'
              OR token.connection_id=request_row.connection_id))
      ) unexpected
    )
  ) THEN
    RAISE EXCEPTION 'remote revocation targets do not match the deletion scope'
      USING ERRCODE='55000';
  END IF;
  SELECT count(*),
         count(*) FILTER (WHERE target->>'status'='failed'),
         count(*) FILTER (WHERE target->>'status'='succeeded'),
         count(*) FILTER (WHERE target->>'status'='unsupported')
    INTO target_count,failure_count,success_count,unsupported_count
    FROM jsonb_array_elements(p_remote_revocation->'targets') AS item(target);
  summary_status:=CASE
    WHEN target_count=0 THEN 'not_applicable'
    WHEN failure_count>0 THEN 'failed'
    WHEN success_count>0 THEN 'succeeded'
    WHEN unsupported_count=target_count THEN 'unsupported'
    ELSE 'failed'
  END;
  destroyed_at:=control_plane.destroy_deletion_credentials(
    p_deletion_request_id,p_remote_revocation
  );
  UPDATE control_plane.deletion_requests
     SET remote_revocation_status=summary_status
   WHERE tenant_id=request_row.tenant_id
     AND deletion_request_id=request_row.deletion_request_id;
  RETURN destroyed_at;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.record_deletion_progress(
  p_message_id bigint,p_deletion_request_id text,p_worker_id text,
  p_read_count integer,p_stage text,p_evidence jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  request_row control_plane.deletion_requests%ROWTYPE;
  prior_remote jsonb;
BEGIN
  request_row:=control_plane.require_active_deletion_lease(
    p_message_id,p_deletion_request_id,p_worker_id,p_read_count
  );
  PERFORM control_plane.require_privacy_safe_deletion_progress(
    p_stage,p_evidence,request_row.scope
  );
  IF p_stage='remote_revocation' AND request_row.credential_destroyed_at IS NOT NULL THEN
    prior_remote:=request_row.progress->'remote_revocation';
    IF jsonb_typeof(prior_remote) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'prior remote revocation evidence is missing' USING ERRCODE='55000';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(prior_remote))=2
       AND (prior_remote ?& ARRAY['forcedLocalDestruction','reason'])
       AND (prior_remote->'forcedLocalDestruction')='true'::jsonb
       AND prior_remote->>'reason'='remote_revocation_grace_expired' THEN
      IF (SELECT count(*) FROM jsonb_object_keys(p_evidence))<>7
         OR (p_evidence->'forcedLocalDestruction')<>'true'::jsonb THEN
        RAISE EXCEPTION 'forced revocation progress was not preserved' USING ERRCODE='55000';
      END IF;
    ELSIF prior_remote IS DISTINCT FROM p_evidence THEN
      RAISE EXCEPTION 'remote revocation progress is immutable after credential destruction'
        USING ERRCODE='55000';
    END IF;
  END IF;
  UPDATE control_plane.deletion_requests
     SET progress=progress||jsonb_build_object(p_stage,p_evidence)
   WHERE tenant_id=request_row.tenant_id
     AND deletion_request_id=request_row.deletion_request_id;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.enforce_measured_analytical_deletion_proof()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog
AS $$
DECLARE expected_remote jsonb;
BEGIN
  SELECT request.progress->'remote_revocation'
    INTO expected_remote
    FROM control_plane.deletion_requests request
   WHERE request.deletion_request_id=NEW.deletion_request_id;
  IF NOT FOUND OR expected_remote IS DISTINCT FROM NEW.remote_revocation THEN
    RAISE EXCEPTION 'deletion proof remote evidence does not match durable progress'
      USING ERRCODE='55000';
  END IF;
  PERFORM control_plane.require_privacy_safe_remote_revocation(NEW.remote_revocation);
  PERFORM control_plane.require_privacy_safe_deletion_stores(
    NEW.store_verification,NEW.scope
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deletion_proofs_require_measured_analytical
  ON control_plane.deletion_proofs;
CREATE TRIGGER deletion_proofs_require_measured_analytical
  BEFORE INSERT ON control_plane.deletion_proofs
  FOR EACH ROW EXECUTE FUNCTION
    control_plane.enforce_measured_analytical_deletion_proof();

REVOKE ALL ON FUNCTION
  control_plane.require_measured_analytical_deletion(jsonb,text),
  control_plane.require_nonnegative_deletion_count(jsonb),
  control_plane.require_zero_deletion_count(jsonb),
  control_plane.require_privacy_safe_remote_revocation(jsonb),
  control_plane.require_privacy_safe_deletion_stores(jsonb,text),
  control_plane.require_privacy_safe_deletion_progress(text,jsonb,text),
  control_plane.enforce_measured_analytical_deletion_proof()
FROM PUBLIC,anon,authenticated,service_role,
  albert_sync_control,albert_transform_control,albert_semantic_control,
  albert_operator_diagnostic_control,albert_webhook_control,albert_deletion_control;

CREATE OR REPLACE FUNCTION control_plane.dogfood_deletion_residuals(p_stores jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path=pg_catalog
AS $$
DECLARE result jsonb;
BEGIN
  PERFORM control_plane.require_privacy_safe_deletion_stores(
    p_stores,p_stores#>>'{analytical,scope}'
  );
  IF jsonb_typeof(p_stores)<>'object'
     OR coalesce((p_stores#>>'{credential_vault,verified}')::boolean,false) IS NOT TRUE
     OR coalesce((p_stores#>>'{raw_storage,verified}')::boolean,false) IS NOT TRUE
     OR coalesce((p_stores#>>'{analytical,verified}')::boolean,false) IS NOT TRUE
     OR coalesce((p_stores#>>'{control_plane,verified}')::boolean,false) IS NOT TRUE
     OR (p_stores#>>'{analytical,measurement}') IS DISTINCT FROM 'post_purge_row_counts_v1'
     OR coalesce(p_stores->'analytical' ? 'remainingRows',false) IS NOT TRUE
     OR coalesce(p_stores->'credential_vault' ?& ARRAY[
       'tokenReferences','credentialEnvelopes','sessionEnvelopes'
     ],false) IS NOT TRUE
     OR coalesce(p_stores->'raw_storage' ? 'remainingObjects',false) IS NOT TRUE
     OR coalesce(p_stores->'analytical'->'residuals' ?& ARRAY[
       'stagingRows','canonicalRows','bridgeRows','linkRows',
       'embeddingRows','cacheRows','otherAnalyticalRows'
     ],false) IS NOT TRUE
     OR coalesce(p_stores->'control_plane' ?& ARRAY[
       'remainingTenantOrConnectionRows','remainingDerivedArtifacts','remainingQueueMessages'
     ],false) IS NOT TRUE THEN
    RAISE EXCEPTION 'deletion proof is missing granular store verification' USING ERRCODE='55000';
  END IF;
  result:=jsonb_build_object(
    'rawObjects',(p_stores#>>'{raw_storage,remainingObjects}')::bigint,
    'stagingRows',(p_stores#>>'{analytical,residuals,stagingRows}')::bigint,
    'canonicalRows',(p_stores#>>'{analytical,residuals,canonicalRows}')::bigint,
    'bridgeRows',(p_stores#>>'{analytical,residuals,bridgeRows}')::bigint,
    'linkRows',(p_stores#>>'{analytical,residuals,linkRows}')::bigint,
    'embeddingRows',(p_stores#>>'{analytical,residuals,embeddingRows}')::bigint,
    'cacheRows',(p_stores#>>'{analytical,residuals,cacheRows}')::bigint,
    'otherAnalyticalRows',(p_stores#>>'{analytical,residuals,otherAnalyticalRows}')::bigint,
    'controlRows',(p_stores#>>'{control_plane,remainingTenantOrConnectionRows}')::bigint,
    'derivedArtifacts',(p_stores#>>'{control_plane,remainingDerivedArtifacts}')::bigint,
    'queueMessages',(p_stores#>>'{control_plane,remainingQueueMessages}')::bigint,
    'credentialReferences',(p_stores#>>'{credential_vault,tokenReferences}')::bigint,
    'credentialEnvelopes',(p_stores#>>'{credential_vault,credentialEnvelopes}')::bigint,
    'sessionEnvelopes',(p_stores#>>'{credential_vault,sessionEnvelopes}')::bigint
  );
  IF (p_stores#>>'{analytical,remainingRows}')::bigint<>
     (SELECT sum(item.value::bigint)
        FROM jsonb_each_text(p_stores#>'{analytical,residuals}') item) THEN
    RAISE EXCEPTION 'analytical deletion residual total is inconsistent' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each_text(result) item WHERE item.value::bigint<>0) THEN
    RAISE EXCEPTION 'deletion proof contains residual customer data' USING ERRCODE='55000';
  END IF;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.dogfood_answer_artifact_evidence(
  p_tenant_id text,p_answer_artifact_id text,p_kind text,p_category_topic text,
  p_barrier_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE artifact control_plane.answer_artifacts%ROWTYPE;
DECLARE query_count integer;table_count integer;narrative_count integer;chart_count integer;
DECLARE first_table integer;first_narrative integer;last_answer integer;sequential boolean;
DECLARE result jsonb;
BEGIN
  IF p_kind NOT IN ('flagship','category') THEN
    RAISE EXCEPTION 'dogfood answer kind is invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO artifact FROM control_plane.answer_artifacts candidate
   WHERE candidate.tenant_id=p_tenant_id
     AND candidate.answer_artifact_id=p_answer_artifact_id;
  IF NOT FOUND OR artifact.finalized_at IS NULL
     OR artifact.created_at<p_barrier_at OR artifact.finalized_at<p_barrier_at
     OR artifact.artifact_digest !~ '^[a-f0-9]{64}$'
     OR artifact.trace_digest !~ '^[a-f0-9]{64}$'
     OR artifact.answer_state NOT IN ('verified','qualified') THEN
    RAISE EXCEPTION 'dogfood answer artifact is not finalized analytical evidence' USING ERRCODE='55000';
  END IF;
  query_count:=jsonb_array_length(artifact.query_executions);
  IF query_count<1 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(artifact.query_executions) query
     WHERE query->>'route'<>'semantic'
        OR query->>'bundleHash' !~ '^[a-f0-9]{64}$'
        OR query->>'resultDigest' !~ '^[a-f0-9]{64}$'
        OR jsonb_typeof(query->'normalizedIr')<>'object'
        OR query#>>'{validation,status}' NOT IN ('passed','warning')
  ) THEN
    RAISE EXCEPTION 'dogfood answer query lineage is incomplete' USING ERRCODE='55000';
  END IF;
  IF p_kind='flagship' AND (
    query_count<2
    OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(artifact.query_executions) query
       WHERE query#>>'{normalizedIr,topic}'='workforce_labour'
    )
    OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(artifact.query_executions) query
       WHERE query#>>'{normalizedIr,kind}'='composite'
         AND query#>>'{normalizedIr,topic}'='workforce_sales'
    )
  ) THEN
    RAISE EXCEPTION 'flagship artifact does not contain the governed labour and sales plan' USING ERRCODE='55000';
  END IF;
  IF p_kind='category' AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(artifact.query_executions) query
     WHERE query#>>'{normalizedIr,topic}'=p_category_topic
  ) THEN
    RAISE EXCEPTION 'category artifact does not contain the expected semantic topic' USING ERRCODE='55000';
  END IF;

  SELECT count(*) FILTER (WHERE event_type='table'),
         count(*) FILTER (WHERE event_type='narrative'),
         count(*) FILTER (WHERE event_type='chart'),
         min(sequence_number) FILTER (WHERE event_type='table'),
         min(sequence_number) FILTER (WHERE event_type='narrative'),
         max(sequence_number) FILTER (WHERE event_type='answer')
    INTO table_count,narrative_count,chart_count,first_table,first_narrative,last_answer
    FROM control_plane.answer_execution_events event
   WHERE event.tenant_id=p_tenant_id
     AND event.answer_artifact_id=p_answer_artifact_id
     AND event.occurred_at>=p_barrier_at;
  sequential:=first_narrative<first_table AND last_answer>first_table AND EXISTS (
    SELECT 1 FROM control_plane.answer_execution_events event
     WHERE event.tenant_id=p_tenant_id
       AND event.answer_artifact_id=p_answer_artifact_id
       AND event.event_type='narrative'
       AND event.occurred_at>=p_barrier_at
       AND event.sequence_number>first_table AND event.sequence_number<last_answer
  );
  IF narrative_count<2 OR NOT sequential
     OR EXISTS (
       SELECT 1 FROM control_plane.answer_execution_events event
        WHERE event.tenant_id=p_tenant_id
          AND event.answer_artifact_id=p_answer_artifact_id
          AND event.occurred_at<p_barrier_at
     )
     OR (p_kind='flagship' AND table_count<2)
     OR (p_kind='category' AND (table_count<1 OR chart_count<1))
     OR EXISTS (
       SELECT 1 FROM control_plane.answer_execution_events event
        WHERE event.tenant_id=p_tenant_id
          AND event.answer_artifact_id=p_answer_artifact_id
          AND event.event_type IN ('table','answer')
          AND (
            jsonb_typeof(event.event_payload#>'{provenance,sources}')<>'array'
            OR jsonb_array_length(event.event_payload#>'{provenance,sources}')=0
            OR coalesce(event.event_payload#>>'{provenance,semanticBundleHash}','') !~ '^[a-f0-9]{64}$'
          )
     )
     OR EXISTS (
       SELECT 1 FROM control_plane.answer_execution_events chart
        WHERE chart.tenant_id=p_tenant_id
          AND chart.answer_artifact_id=p_answer_artifact_id
          AND chart.event_type='chart'
          AND NOT EXISTS (
            SELECT 1 FROM control_plane.answer_execution_events result_table
             WHERE result_table.tenant_id=chart.tenant_id
               AND result_table.answer_artifact_id=chart.answer_artifact_id
               AND result_table.event_type='table'
               AND result_table.event_payload->>'resultId'=chart.event_payload->>'dataRef'
          )
     ) THEN
    RAISE EXCEPTION 'dogfood answer trace lacks sequential grounded tables or charts' USING ERRCODE='55000';
  END IF;
  result:=jsonb_build_object(
    'artifactDigest',artifact.artifact_digest,
    'traceDigest',artifact.trace_digest,
    'answerState',artifact.answer_state,
    'queryCount',query_count,
    'provenanceComplete',true,
    'sequentialNarrative',true,
    'chartPresent',chart_count>0
  );
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.capture_protected_dogfood_acceptance(
  p_candidate_sha text,
  p_deployment_id text,
  p_dogfood_tenant_id text,
  p_connections jsonb,
  p_onboarding_tenant_id text,
  p_onboarding_target_minutes integer,
  p_flagship_answer_artifact_id text,
  p_category_answer_artifact_id text,
  p_category_topic text,
  p_disconnect_proof_id text,
  p_tenant_deletion_proof_id text
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE captured timestamptz:=clock_timestamp();snapshot_id text:=control_plane.generate_ulid();
DECLARE barrier_at timestamptz;candidate_worker_count integer:=3;
DECLARE connection_evidence jsonb;connection_count integer;
DECLARE stream_count integer;live_count integer;backfill_count integer;reconciled_count integer;
DECLARE latest_snapshot timestamptz;invariant_map jsonb;invariant_count integer;
DECLARE identity_count integer;core_count integer;mart_count integer;
DECLARE m3 jsonb;m4 jsonb;m6 jsonb;m7 jsonb;m8 jsonb;evidence jsonb;evidence_digest text;
DECLARE onboarding_created timestamptz;onboarding_reached timestamptz;
DECLARE onboarding_minutes numeric;onboarding_connections integer;onboarding_connectors integer;
DECLARE ready_connection_count integer;readiness_count integer;blocking_count integer;
DECLARE overlay_value jsonb;overlay_digest text;
DECLARE disconnect_proof control_plane.deletion_proofs%ROWTYPE;
DECLARE tenant_proof control_plane.deletion_proofs%ROWTYPE;
DECLARE disconnect_targets jsonb;tenant_targets jsonb;disconnect_residuals jsonb;tenant_residuals jsonb;
DECLARE disconnect_provider text;disconnect_generation bigint;
DECLARE disconnect_generations_digest text;tenant_generations_digest text;
BEGIN
  PERFORM control_plane.assert_operator_diagnostic_control_ready();
  IF p_candidate_sha !~ '^[a-f0-9]{40}$'
     OR p_deployment_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR NOT control_plane.is_ulid(p_dogfood_tenant_id)
     OR NOT control_plane.is_ulid(p_onboarding_tenant_id)
     OR p_dogfood_tenant_id=p_onboarding_tenant_id
     OR p_onboarding_target_minutes NOT BETWEEN 1 AND 1440
     OR NOT control_plane.is_ulid(p_flagship_answer_artifact_id)
     OR NOT control_plane.is_ulid(p_category_answer_artifact_id)
     OR p_category_topic !~ '^[a-z][a-z0-9_]{1,79}$'
     OR NOT control_plane.is_ulid(p_disconnect_proof_id)
     OR NOT control_plane.is_ulid(p_tenant_deletion_proof_id)
     OR jsonb_typeof(p_connections)<>'object'
     OR NOT (p_connections ?& ARRAY['lightspeed-r','xero','deputy'])
     OR p_connections-ARRAY['lightspeed-r','xero','deputy']<>'{}'::jsonb
     OR EXISTS (
       SELECT 1 FROM jsonb_each_text(p_connections) item
        WHERE NOT control_plane.is_ulid(item.value)
     ) THEN
    RAISE EXCEPTION 'protected dogfood snapshot input is invalid' USING ERRCODE='22023';
  END IF;
  barrier_at:=control_plane.protected_dogfood_deployment_barrier(
    p_candidate_sha,p_deployment_id
  );
  IF barrier_at>captured THEN
    RAISE EXCEPTION 'candidate deployment barrier is in the future' USING ERRCODE='55000';
  END IF;

  WITH expected AS (
    SELECT key AS connector,value AS connection_id FROM jsonb_each_text(p_connections)
  ),verified AS (
    SELECT connection.connector_key AS connector,connection.connection_generation AS generation
      FROM expected
      JOIN control_plane.connections connection
        ON connection.tenant_id=p_dogfood_tenant_id
       AND connection.connection_id=expected.connection_id
       AND connection.connector_key=expected.connector
      JOIN control_plane.oauth_token_refs token
        ON token.tenant_id=connection.tenant_id
       AND token.connection_id=connection.connection_id
      JOIN control_plane.oauth_secret_envelopes envelope
        ON envelope.tenant_id=token.tenant_id
       AND envelope.token_ref_id=token.token_ref_id
       AND envelope.retired_at IS NULL
     WHERE connection.status='connected' AND connection.auth_health='healthy'
       AND connection.external_account_reference IS NOT NULL
       AND connection.authorised_by IS NOT NULL AND connection.authorised_at IS NOT NULL
       AND connection.disconnected_at IS NULL
       AND (token.token_expires_at IS NULL OR token.token_expires_at>captured)
  )
  SELECT count(*),coalesce(jsonb_agg(jsonb_build_object(
    'connector',connector,'generation',generation
  ) ORDER BY connector),'[]'::jsonb)
    INTO connection_count,connection_evidence FROM verified;
  IF connection_count<>3 THEN
    RAISE EXCEPTION 'all three dogfood OAuth connections must be live and healthy' USING ERRCODE='55000';
  END IF;

  WITH selected AS (
    SELECT value AS connection_id FROM jsonb_each_text(p_connections)
  ),planned AS (
    SELECT DISTINCT phase.connection_id,phase.connection_generation,phase.stream
      FROM control_plane.sync_stream_phases phase
      JOIN selected ON selected.connection_id=phase.connection_id
      JOIN control_plane.connections connection
        ON connection.tenant_id=phase.tenant_id
       AND connection.connection_id=phase.connection_id
       AND connection.connection_generation=phase.connection_generation
     WHERE phase.tenant_id=p_dogfood_tenant_id AND phase.required
  ),latest_sweep AS (
    SELECT DISTINCT ON (sweep.connection_id,sweep.connection_generation,sweep.stream)
           sweep.connection_id,sweep.connection_generation,sweep.stream,sweep.status,
           sweep.completed_at
      FROM control_plane.reconciliation_stream_sweeps sweep
      JOIN planned ON planned.connection_id=sweep.connection_id
       AND planned.connection_generation=sweep.connection_generation
       AND planned.stream=sweep.stream
     WHERE sweep.tenant_id=p_dogfood_tenant_id AND sweep.required
     ORDER BY sweep.connection_id,sweep.connection_generation,sweep.stream,
              sweep.created_at DESC,sweep.reconciliation_sweep_id DESC
  )
  SELECT count(*),
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM control_plane.raw_batch_manifests manifest
           JOIN control_plane.raw_batch_landings landing
             ON landing.tenant_id=manifest.tenant_id AND landing.batch_id=manifest.batch_id
           JOIN control_plane.sync_runs run
             ON run.tenant_id=manifest.tenant_id AND run.sync_run_id=manifest.sync_run_id
          WHERE manifest.tenant_id=p_dogfood_tenant_id
            AND manifest.connection_id=planned.connection_id
            AND run.connection_generation=planned.connection_generation
            AND manifest.stream=planned.stream
            AND manifest.created_at>=barrier_at AND manifest.extracted_at>=barrier_at
            AND run.status='succeeded' AND run.finished_at>=barrier_at
            AND landing.status='landed' AND landing.analytical_committed_at IS NOT NULL
            AND landing.analytical_committed_at>=barrier_at
         )),
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM control_plane.stream_cursors cursor
            WHERE cursor.tenant_id=p_dogfood_tenant_id
              AND cursor.connection_id=planned.connection_id
              AND cursor.connection_generation=planned.connection_generation
              AND cursor.stream=planned.stream AND cursor.backfill_complete
              AND cursor.last_successful_sync_at>=barrier_at
         )),
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM latest_sweep sweep
            WHERE sweep.connection_id=planned.connection_id
              AND sweep.connection_generation=planned.connection_generation
              AND sweep.stream=planned.stream AND sweep.status='complete'
              AND sweep.completed_at>=barrier_at
         ))
    INTO stream_count,live_count,backfill_count,reconciled_count FROM planned;
  IF stream_count=0 OR live_count<>stream_count OR backfill_count<>stream_count
     OR reconciled_count<>stream_count OR EXISTS (
       SELECT 1 FROM control_plane.sync_stream_phases phase
        WHERE phase.tenant_id=p_dogfood_tenant_id AND phase.required
          AND phase.connection_id IN (SELECT value FROM jsonb_each_text(p_connections))
          AND EXISTS (
            SELECT 1 FROM control_plane.connections connection
             WHERE connection.tenant_id=phase.tenant_id
               AND connection.connection_id=phase.connection_id
               AND connection.connection_generation=phase.connection_generation
          )
          AND (
            phase.status NOT IN ('succeeded','unavailable')
            OR phase.completed_at<barrier_at
          )
     ) THEN
    RAISE EXCEPTION 'every planned dogfood stream must be landed, backfilled and reconciled' USING ERRCODE='55000';
  END IF;

  SELECT max(snapshot_at) INTO latest_snapshot FROM control_plane.pipeline_stats
   WHERE tenant_id=p_dogfood_tenant_id
     AND snapshot_at>=barrier_at AND created_at>=barrier_at;
  SELECT invariant_status INTO invariant_map
    FROM control_plane.pipeline_stats
   WHERE tenant_id=p_dogfood_tenant_id AND snapshot_at=latest_snapshot
   ORDER BY schema_name,table_name LIMIT 1;
  invariant_map:=coalesce(invariant_map,'{}'::jsonb);
  SELECT count(*) INTO invariant_count FROM jsonb_each_text(invariant_map);
  IF latest_snapshot IS NULL OR invariant_count<12 OR EXISTS (
    SELECT 1 FROM jsonb_each_text(invariant_map) item
     WHERE item.value IN ('failed','blocked')
  ) OR EXISTS (
    SELECT 1 FROM control_plane.pipeline_stats stat
     WHERE stat.tenant_id=p_dogfood_tenant_id
       AND stat.snapshot_at=latest_snapshot AND stat.created_at<barrier_at
  ) THEN
    RAISE EXCEPTION 'dogfood quality and invariant snapshot is incomplete' USING ERRCODE='55000';
  END IF;
  m3:=jsonb_build_object(
    'passed',true,'streamCount',stream_count,'liveRecordedStreams',live_count,
    'backfillCompleteStreams',backfill_count,'reconciledStreams',reconciled_count,
    'qualityCheckCount',invariant_count
  );
  m3:=m3||jsonb_build_object('evidenceDigest',control_plane.dogfood_evidence_sha256(m3));

  SELECT count(*) INTO identity_count
    FROM control_plane.identity_review_tasks task
   WHERE task.tenant_id=p_dogfood_tenant_id
     AND task.created_at>=barrier_at
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(task.candidate_links) link
        WHERE link->>'connection_id'=p_connections->>'lightspeed-r'
     )
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(task.candidate_links) link
        WHERE link->>'connection_id'=p_connections->>'deputy'
     );
  SELECT count(*) FILTER (WHERE schema_name='core' AND row_count>0),
         count(*) FILTER (WHERE schema_name='mart' AND row_count>0)
    INTO core_count,mart_count FROM control_plane.pipeline_stats
   WHERE tenant_id=p_dogfood_tenant_id AND snapshot_at=latest_snapshot;
  IF identity_count<1 OR core_count<1 OR mart_count<1
     OR invariant_map->>'posting_bridge_coverage'<>'passed' THEN
    RAISE EXCEPTION 'dogfood canonical, identity or posting bridge evidence is incomplete' USING ERRCODE='55000';
  END IF;
  m4:=jsonb_build_object(
    'passed',true,'invariantCount',invariant_count,
    'identitySuggestionCount',identity_count,'xeroPostingBridgeVerified',true
  );
  m4:=m4||jsonb_build_object('evidenceDigest',control_plane.dogfood_evidence_sha256(m4));

  m6:=jsonb_build_object(
    'passed',true,
    'flagship',control_plane.dogfood_answer_artifact_evidence(
      p_dogfood_tenant_id,p_flagship_answer_artifact_id,'flagship',p_category_topic,barrier_at
    )-'chartPresent',
    'category',control_plane.dogfood_answer_artifact_evidence(
      p_dogfood_tenant_id,p_category_answer_artifact_id,'category',p_category_topic,barrier_at
    )
  );
  m6:=m6||jsonb_build_object('evidenceDigest',control_plane.dogfood_evidence_sha256(m6));

  SELECT tenant.created_at INTO onboarding_created FROM control_plane.tenants tenant
   WHERE tenant.tenant_id=p_onboarding_tenant_id AND tenant.status='active';
  IF onboarding_created IS NULL OR onboarding_created<barrier_at
     OR onboarding_created>captured THEN
    RAISE EXCEPTION 'onboarding evidence must start after candidate deployment' USING ERRCODE='55000';
  END IF;
  WITH valid_connections AS (
    SELECT connection.connection_id,connection.connector_key
      FROM control_plane.connections connection
      JOIN control_plane.oauth_token_refs token
        ON token.tenant_id=connection.tenant_id AND token.connection_id=connection.connection_id
      JOIN control_plane.oauth_secret_envelopes envelope
        ON envelope.tenant_id=token.tenant_id AND envelope.token_ref_id=token.token_ref_id
       AND envelope.retired_at IS NULL
     WHERE connection.tenant_id=p_onboarding_tenant_id
       AND connection.connector_key IN ('lightspeed-r','xero','deputy')
       AND connection.status='connected' AND connection.auth_health='healthy'
       AND connection.authorised_at>=barrier_at
       AND connection.external_account_reference IS NOT NULL
  ),per_connection AS (
    SELECT connection.connection_id,min(readiness.evaluated_at) AS ready_at
      FROM valid_connections connection
      JOIN control_plane.readiness readiness
        ON readiness.tenant_id=p_onboarding_tenant_id
       AND readiness.connection_id=connection.connection_id
       AND readiness.state IN ('ready_partial','ready_complete')
       AND readiness.evaluated_at>=barrier_at
     GROUP BY connection.connection_id
  )
  SELECT (SELECT count(*) FROM valid_connections),
         (SELECT count(DISTINCT connector_key) FROM valid_connections),
         count(*),max(ready_at)
    INTO onboarding_connections,onboarding_connectors,ready_connection_count,onboarding_reached
    FROM per_connection;
  SELECT count(*) INTO readiness_count FROM control_plane.readiness readiness
   WHERE readiness.tenant_id=p_onboarding_tenant_id
     AND readiness.state IN ('ready_partial','ready_complete')
     AND readiness.evaluated_at>=barrier_at;
  onboarding_minutes:=extract(epoch FROM onboarding_reached-onboarding_created)/60;
  SELECT count(DISTINCT response.question_id) INTO blocking_count
    FROM control_plane.onboarding_question_responses response
   WHERE response.tenant_id=p_onboarding_tenant_id
     AND response.answered_at>=barrier_at;
  SELECT overlay.overlay INTO overlay_value FROM control_plane.tenant_overlays overlay
   WHERE overlay.tenant_id=p_onboarding_tenant_id AND overlay.status='published'
     AND overlay.created_at>=barrier_at AND overlay.published_at>=barrier_at;
  IF onboarding_connections<>3 OR onboarding_connectors<>3 OR onboarding_reached IS NULL
     OR ready_connection_count<>3
     OR onboarding_minutes<0 OR onboarding_minutes>p_onboarding_target_minutes
     OR readiness_count<3 OR blocking_count<4
     OR jsonb_typeof(overlay_value->'blocking_answers')<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(overlay_value->'blocking_answers'))<4 THEN
    RAISE EXCEPTION 'fresh onboarding did not meet the protected acceptance target' USING ERRCODE='55000';
  END IF;
  overlay_digest:=control_plane.dogfood_evidence_sha256(overlay_value);
  m7:=jsonb_build_object(
    'passed',true,'onboardingMinutes',round(onboarding_minutes,3),
    'targetMinutes',p_onboarding_target_minutes,
    'readyPartialDomainCount',readiness_count,
    'blockingAnswerCount',blocking_count,'overlayDigest',overlay_digest
  );
  m7:=m7||jsonb_build_object('evidenceDigest',control_plane.dogfood_evidence_sha256(m7));

  SELECT * INTO disconnect_proof FROM control_plane.deletion_proofs proof
   WHERE proof.proof_id=p_disconnect_proof_id AND proof.scope='connection';
  SELECT * INTO tenant_proof FROM control_plane.deletion_proofs proof
   WHERE proof.proof_id=p_tenant_deletion_proof_id AND proof.scope='tenant';
  IF disconnect_proof.proof_id IS NULL OR tenant_proof.proof_id IS NULL
     OR disconnect_proof.service_version<>p_candidate_sha
     OR tenant_proof.service_version<>p_candidate_sha
     OR disconnect_proof.requested_at<barrier_at OR disconnect_proof.completed_at<barrier_at
     OR tenant_proof.requested_at<barrier_at OR tenant_proof.completed_at<barrier_at
     OR disconnect_proof.tenant_reference_hash=tenant_proof.tenant_reference_hash THEN
    RAISE EXCEPTION 'exact candidate deletion proofs were not found' USING ERRCODE='55000';
  END IF;
  disconnect_targets:=disconnect_proof.remote_revocation->'targets';
  tenant_targets:=tenant_proof.remote_revocation->'targets';
  IF jsonb_typeof(disconnect_targets)<>'array' OR jsonb_array_length(disconnect_targets)<>1
     OR disconnect_targets->0->>'provider' NOT IN ('lightspeed-r','xero')
     OR disconnect_targets->0->>'status'<>'succeeded'
     OR coalesce((disconnect_targets->0->>'connectionGeneration')::bigint,0)<1
     OR jsonb_typeof(tenant_targets)<>'array' OR jsonb_array_length(tenant_targets)<3
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(tenant_targets) target
        WHERE target->>'provider' NOT IN ('lightspeed-r','xero','deputy')
           OR target->>'status' NOT IN ('succeeded','unsupported')
           OR coalesce((target->>'connectionGeneration')::bigint,0)<1
     ) OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(tenant_targets) target
        WHERE target->>'provider' IN ('lightspeed-r','xero') AND target->>'status'<>'succeeded'
     ) THEN
    RAISE EXCEPTION 'remote provider revocation evidence is incomplete' USING ERRCODE='55000';
  END IF;
  disconnect_provider:=disconnect_targets->0->>'provider';
  disconnect_generation:=(disconnect_targets->0->>'connectionGeneration')::bigint;
  SELECT control_plane.dogfood_evidence_sha256(coalesce(jsonb_agg(jsonb_build_object(
    'provider',target->>'provider','generation',(target->>'connectionGeneration')::bigint
  ) ORDER BY target->>'provider'),'[]'::jsonb)) INTO disconnect_generations_digest
    FROM jsonb_array_elements(disconnect_targets) target;
  SELECT control_plane.dogfood_evidence_sha256(coalesce(jsonb_agg(jsonb_build_object(
    'provider',target->>'provider','generation',(target->>'connectionGeneration')::bigint
  ) ORDER BY target->>'provider'),'[]'::jsonb)) INTO tenant_generations_digest
    FROM jsonb_array_elements(tenant_targets) target;
  disconnect_residuals:=control_plane.dogfood_deletion_residuals(disconnect_proof.store_verification);
  tenant_residuals:=control_plane.dogfood_deletion_residuals(tenant_proof.store_verification);
  m8:=jsonb_build_object(
    'passed',true,
    'disconnect',jsonb_build_object(
      'proofDigest',disconnect_proof.proof_digest,
      'completedAt',disconnect_proof.completed_at,
      'providerGenerationsDigest',disconnect_generations_digest,
      'remoteRevocationVerified',true,'storesVerified',true,
      'residuals',disconnect_residuals,
      'provider',disconnect_provider,'connectionGeneration',disconnect_generation
    ),
    'tenantDeletion',jsonb_build_object(
      'proofDigest',tenant_proof.proof_digest,
      'completedAt',tenant_proof.completed_at,
      'providerGenerationsDigest',tenant_generations_digest,
      'remoteRevocationVerified',true,'storesVerified',true,
      'residuals',tenant_residuals
    )
  );
  m8:=m8||jsonb_build_object('evidenceDigest',control_plane.dogfood_evidence_sha256(m8));

  evidence:=jsonb_build_object(
    'schemaVersion',1,'capturedAt',captured,'candidateSha',p_candidate_sha,
    'deployment',jsonb_build_object(
      'deploymentId',p_deployment_id,'barrierAt',barrier_at,
      'candidateWorkerCount',candidate_worker_count
    ),
    'connections',connection_evidence,
    'milestones',jsonb_build_object('m3',m3,'m4',m4,'m6',m6,'m7',m7,'m8',m8),
    'references',jsonb_build_object(
      'disconnectConnectionReferenceHash',disconnect_proof.connection_reference_hash,
      'deletionTenantReferenceHash',tenant_proof.tenant_reference_hash
    )
  );
  evidence_digest:=control_plane.dogfood_evidence_sha256(evidence);
  INSERT INTO control_plane.protected_dogfood_acceptance_snapshots(
    snapshot_id,candidate_sha,evidence,evidence_digest,captured_at
  ) VALUES(snapshot_id,p_candidate_sha,evidence,evidence_digest,captured);
  RETURN jsonb_build_object(
    'snapshotId',snapshot_id,'capturedAt',captured,
    'evidenceDigest',evidence_digest,'evidence',evidence
  );
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.consume_protected_dogfood_acceptance(
  p_snapshot_id text,p_candidate_sha text,p_evidence_digest text,
  p_release_workflow_run_id text,p_repository text
) RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE snapshot control_plane.protected_dogfood_acceptance_snapshots%ROWTYPE;
BEGIN
  PERFORM control_plane.assert_operator_diagnostic_control_ready();
  IF NOT control_plane.is_ulid(p_snapshot_id)
     OR p_candidate_sha !~ '^[a-f0-9]{40}$'
     OR p_evidence_digest !~ '^[a-f0-9]{64}$'
     OR p_release_workflow_run_id !~ '^[1-9][0-9]{0,19}$'
     OR p_repository !~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' THEN
    RAISE EXCEPTION 'dogfood acceptance consumption input is invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO snapshot FROM control_plane.protected_dogfood_acceptance_snapshots candidate
   WHERE candidate.snapshot_id=p_snapshot_id FOR SHARE;
  IF NOT FOUND OR snapshot.candidate_sha<>p_candidate_sha
     OR snapshot.evidence_digest<>p_evidence_digest
     OR snapshot.captured_at<=clock_timestamp()-interval '6 hours'
     OR snapshot.captured_at>clock_timestamp()+interval '5 minutes' THEN
    RAISE EXCEPTION 'dogfood acceptance snapshot is stale or mismatched' USING ERRCODE='55000';
  END IF;
  INSERT INTO control_plane.protected_dogfood_acceptance_consumptions(
    snapshot_id,candidate_sha,evidence_digest,release_workflow_run_id,repository
  ) VALUES(
    p_snapshot_id,p_candidate_sha,p_evidence_digest,p_release_workflow_run_id,p_repository
  );
  RETURN true;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'dogfood acceptance snapshot was already consumed' USING ERRCODE='55000';
END;
$$;

REVOKE ALL ON TABLE
  control_plane.protected_dogfood_acceptance_snapshots,
  control_plane.protected_dogfood_acceptance_consumptions,
  control_plane.protected_dogfood_runtime_observations,
  control_plane.protected_dogfood_semantic_turn_leases,
  control_plane.protected_dogfood_semantic_turn_results
FROM PUBLIC,anon,authenticated,service_role,albert_operator_diagnostic_control;
REVOKE ALL ON FUNCTION
  control_plane.dogfood_evidence_sha256(jsonb),
  control_plane.reject_protected_dogfood_evidence_mutation(),
  control_plane.reject_protected_dogfood_semantic_mutation(),
  control_plane.capture_protected_dogfood_runtime_observation(),
  control_plane.protected_dogfood_deployment_barrier(text,text),
  control_plane.issue_protected_dogfood_semantic_turn(text,text,text,text,integer,text,integer),
  control_plane.finish_protected_dogfood_semantic_turn(text,boolean,text),
  control_plane.dogfood_deletion_residuals(jsonb),
  control_plane.dogfood_answer_artifact_evidence(text,text,text,text,timestamptz),
  control_plane.capture_protected_dogfood_acceptance(text,text,text,jsonb,text,integer,text,text,text,text,text),
  control_plane.consume_protected_dogfood_acceptance(text,text,text,text,text)
FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION control_plane.deletion_revocation_context(bigint,text,text,integer)
FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control;
GRANT EXECUTE ON FUNCTION
  control_plane.issue_protected_dogfood_semantic_turn(text,text,text,text,integer,text,integer),
  control_plane.finish_protected_dogfood_semantic_turn(text,boolean,text),
  control_plane.capture_protected_dogfood_acceptance(text,text,text,jsonb,text,integer,text,text,text,text,text),
  control_plane.consume_protected_dogfood_acceptance(text,text,text,text,text)
TO albert_operator_diagnostic_control;
GRANT EXECUTE ON FUNCTION control_plane.deletion_revocation_context(bigint,text,text,integer)
TO albert_deletion_control;

COMMIT;
