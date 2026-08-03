BEGIN;

-- M7 release evidence must begin with a candidate-era, operator-issued secret
-- and end with a real authenticated browser journey. No journey exists during
-- ordinary product use, so these tables and capabilities are inert unless the
-- protected acceptance operator explicitly issues one.
DO $$
BEGIN
  IF to_regprocedure(
    'extensions.albert_protected_dogfood_auth_audit_proof(uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone)'
  ) IS NULL THEN
    RAISE EXCEPTION 'managed Supabase Auth audit proof is unavailable; apply administrator upgrade 0009 first';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS control_plane.protected_dogfood_onboarding_journey_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);
INSERT INTO control_plane.protected_dogfood_onboarding_journey_status_lookup(status,description) VALUES
  ('issued','A one-use protected onboarding code is waiting for a fresh human owner'),
  ('claimed','The fresh owner consumed the code and must complete a post-claim login'),
  ('completed','The independently signed browser/server receipt is sealed'),
  ('expired','The one-use protected onboarding code expired')
ON CONFLICT(status) DO NOTHING;

CREATE TABLE control_plane.protected_dogfood_onboarding_journeys (
  journey_id text PRIMARY KEY CHECK (control_plane.is_ulid(journey_id)),
  candidate_sha text NOT NULL CHECK (candidate_sha~'^[a-f0-9]{40}$'),
  deployment_id text NOT NULL CHECK (
    deployment_id~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
  ),
  deployment_barrier_at timestamptz NOT NULL,
  nonce_hash text NOT NULL UNIQUE CHECK (nonce_hash~'^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'issued' REFERENCES
    control_plane.protected_dogfood_onboarding_journey_status_lookup(status),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  claimed_by uuid,
  claimed_tenant_id text,
  claimed_membership_id text,
  tenant_created_audit_id text,
  completed_at timestamptz,
  FOREIGN KEY(claimed_tenant_id,claimed_membership_id) REFERENCES
    control_plane.memberships(tenant_id,membership_id) ON DELETE CASCADE,
  FOREIGN KEY(claimed_tenant_id,tenant_created_audit_id) REFERENCES
    control_plane.audit_log(tenant_id,audit_id) ON DELETE CASCADE,
  CHECK (
    expires_at>=issued_at+interval '10 minutes'
    AND expires_at<=issued_at+interval '90 minutes'
  ),
  CHECK (
    (status='issued' AND claimed_at IS NULL AND claimed_by IS NULL
      AND claimed_tenant_id IS NULL AND claimed_membership_id IS NULL
      AND tenant_created_audit_id IS NULL AND completed_at IS NULL)
    OR
    (status='claimed' AND claimed_at IS NOT NULL AND claimed_by IS NOT NULL
      AND claimed_tenant_id IS NOT NULL AND claimed_membership_id IS NOT NULL
      AND tenant_created_audit_id IS NOT NULL AND completed_at IS NULL)
    OR
    (status='completed' AND claimed_at IS NOT NULL AND claimed_by IS NOT NULL
      AND claimed_tenant_id IS NOT NULL AND claimed_membership_id IS NOT NULL
      AND tenant_created_audit_id IS NOT NULL AND completed_at IS NOT NULL)
    OR status='expired'
  ),
  CHECK (claimed_at IS NULL OR (claimed_at>issued_at AND claimed_at<expires_at)),
  CHECK (completed_at IS NULL OR (completed_at>claimed_at AND completed_at<=expires_at))
);
CREATE UNIQUE INDEX protected_dogfood_one_active_onboarding_journey
  ON control_plane.protected_dogfood_onboarding_journeys(candidate_sha,deployment_id)
  WHERE status IN ('issued','claimed');

CREATE TABLE control_plane.protected_dogfood_onboarding_claims (
  journey_id text PRIMARY KEY REFERENCES
    control_plane.protected_dogfood_onboarding_journeys(journey_id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  tenant_id text NOT NULL,
  membership_id text NOT NULL,
  tenant_created_audit_id text NOT NULL,
  browser_nonce_hash text NOT NULL UNIQUE CHECK (browser_nonce_hash~'^[a-f0-9]{64}$'),
  user_agent_hash text NOT NULL CHECK (user_agent_hash~'^[a-f0-9]{64}$'),
  claimed_at timestamptz NOT NULL,
  claim_binding jsonb NOT NULL CHECK (jsonb_typeof(claim_binding)='object'),
  claim_digest text NOT NULL UNIQUE CHECK (claim_digest~'^[a-f0-9]{64}$'),
  FOREIGN KEY(tenant_id,membership_id) REFERENCES
    control_plane.memberships(tenant_id,membership_id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,tenant_created_audit_id) REFERENCES
    control_plane.audit_log(tenant_id,audit_id) ON DELETE CASCADE,
  CONSTRAINT protected_dogfood_onboarding_claim_identity_unique
    UNIQUE(journey_id,user_id,tenant_id),
  CHECK (claim_digest=control_plane.dogfood_evidence_sha256(claim_binding))
);

CREATE TABLE control_plane.protected_dogfood_onboarding_receipts (
  journey_id text PRIMARY KEY REFERENCES
    control_plane.protected_dogfood_onboarding_claims(journey_id) ON DELETE CASCADE,
  receipt_id text NOT NULL UNIQUE CHECK (control_plane.is_ulid(receipt_id)),
  user_id uuid NOT NULL,
  tenant_id text NOT NULL,
  browser_nonce_hash text NOT NULL UNIQUE CHECK (browser_nonce_hash~'^[a-f0-9]{64}$'),
  user_agent_hash text NOT NULL CHECK (user_agent_hash~'^[a-f0-9]{64}$'),
  auth_proof jsonb NOT NULL CHECK (
    jsonb_typeof(auth_proof)='object'
    AND auth_proof->>'proofVersion'='1'
    AND auth_proof->>'emailProvider'='true'
  ),
  auth_proof_digest text NOT NULL CHECK (auth_proof_digest~'^[a-f0-9]{64}$'),
  completed_at timestamptz NOT NULL,
  receipt_binding jsonb NOT NULL CHECK (jsonb_typeof(receipt_binding)='object'),
  receipt_digest text NOT NULL UNIQUE CHECK (receipt_digest~'^[a-f0-9]{64}$'),
  FOREIGN KEY(journey_id,user_id,tenant_id) REFERENCES
    control_plane.protected_dogfood_onboarding_claims(journey_id,user_id,tenant_id)
    ON DELETE CASCADE,
  CHECK (auth_proof_digest=control_plane.dogfood_evidence_sha256(auth_proof)),
  CHECK (receipt_digest=control_plane.dogfood_evidence_sha256(receipt_binding))
);
CREATE TRIGGER protected_dogfood_onboarding_claims_append_only
  BEFORE UPDATE OR DELETE ON control_plane.protected_dogfood_onboarding_claims
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_protected_dogfood_evidence_mutation();
CREATE TRIGGER protected_dogfood_onboarding_receipts_append_only
  BEFORE UPDATE OR DELETE ON control_plane.protected_dogfood_onboarding_receipts
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_protected_dogfood_evidence_mutation();

-- Completion results created after this migration always carry the exact OAuth
-- session and generation. NOT VALID deliberately preserves historical replay
-- records while enforcing the stronger contract on every new write.
ALTER TABLE control_plane.oauth_sessions
  ADD CONSTRAINT oauth_sessions_completion_generation_binding_check CHECK (
    completion_result IS NULL OR (
      completion_result ?& ARRAY[
        'connectionId','jobRequestId','oauthSessionId','connectionGeneration'
      ]
      AND completion_result->>'oauthSessionId'=oauth_session_id
      AND coalesce(control_plane.is_ulid(completion_result->>'connectionId'),false)
      AND coalesce(control_plane.is_ulid(completion_result->>'jobRequestId'),false)
      AND (completion_result->>'connectionGeneration')~'^[1-9][0-9]*$'
    )
  ) NOT VALID;

-- Every newly registered progressive phase is tied to the coordinator OAuth
-- job which created its plan. Historical rows remain readable, while the old
-- unbound registration capability is revoked below.
ALTER TABLE control_plane.sync_stream_phases
  ADD COLUMN IF NOT EXISTS coordinator_job_request_id text,
  ADD COLUMN IF NOT EXISTS coordinator_sync_run_id text,
  ADD COLUMN IF NOT EXISTS coordinator_batch_id text;
ALTER TABLE control_plane.sync_stream_phases
  ADD CONSTRAINT sync_stream_phases_coordinator_binding_check CHECK (
    (coordinator_job_request_id IS NULL AND coordinator_sync_run_id IS NULL
      AND coordinator_batch_id IS NULL)
    OR (
      control_plane.is_ulid(coordinator_job_request_id)
      AND control_plane.is_ulid(coordinator_sync_run_id)
      AND control_plane.is_ulid(coordinator_batch_id)
    )
  ) NOT VALID;

CREATE FUNCTION control_plane.register_sync_stream_phase(
  p_tenant_id text,p_connection_id text,p_connection_generation bigint,
  p_stream text,p_phase text,p_phase_ordinal integer,p_plan_mode text,
  p_backfill_strategy text,p_required boolean,p_domains text[],
  p_dependencies text[],p_range_from timestamptz,p_range_to timestamptz,
  p_predecessor_phase text,p_inherited_coverage jsonb,
  p_coordinator_job_request_id text,p_coordinator_sync_run_id text,
  p_coordinator_batch_id text
) RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF coalesce(control_plane.is_ulid(p_coordinator_job_request_id),false) IS NOT TRUE
     OR coalesce(control_plane.is_ulid(p_coordinator_sync_run_id),false) IS NOT TRUE
     OR coalesce(control_plane.is_ulid(p_coordinator_batch_id),false) IS NOT TRUE
     OR NOT EXISTS (
       SELECT 1
         FROM control_plane.sync_job_requests request
         JOIN control_plane.sync_runs run
           ON run.tenant_id=request.tenant_id
          AND run.sync_run_id=p_coordinator_sync_run_id
          AND run.connection_id=request.connection_id
          AND run.connection_generation=p_connection_generation
          AND run.job_type='InitialBackfill'
          AND run.queue_job_reference=request.job_request_id
        WHERE request.tenant_id=p_tenant_id
          AND request.connection_id=p_connection_id
          AND request.job_request_id=p_coordinator_job_request_id
          AND request.job_type='InitialBackfill'
          AND request.payload->>'syncRunId'=p_coordinator_sync_run_id
          AND request.payload->>'batchId'=p_coordinator_batch_id
          AND request.payload->>'connectionGeneration'=p_connection_generation::text
          AND request.payload->>'phase'='recent'
          AND request.payload->>'planMode'='progressive'
     ) THEN
    RAISE EXCEPTION 'sync stream coordinator binding is invalid'
      USING ERRCODE='55000';
  END IF;
  PERFORM control_plane.register_sync_stream_phase(
    p_tenant_id,p_connection_id,p_connection_generation,p_stream,p_phase,
    p_phase_ordinal,p_plan_mode,p_backfill_strategy,p_required,p_domains,
    p_dependencies,p_range_from,p_range_to,p_predecessor_phase,p_inherited_coverage
  );
  IF EXISTS (
    SELECT 1 FROM control_plane.sync_stream_phases phase_row
     WHERE phase_row.tenant_id=p_tenant_id
       AND phase_row.connection_id=p_connection_id
       AND phase_row.connection_generation=p_connection_generation
       AND phase_row.stream=p_stream AND phase_row.phase=p_phase
       AND (
         phase_row.coordinator_job_request_id IS NOT NULL
         OR phase_row.coordinator_sync_run_id IS NOT NULL
         OR phase_row.coordinator_batch_id IS NOT NULL
       )
       AND (
         phase_row.coordinator_job_request_id IS DISTINCT FROM p_coordinator_job_request_id
         OR phase_row.coordinator_sync_run_id IS DISTINCT FROM p_coordinator_sync_run_id
         OR phase_row.coordinator_batch_id IS DISTINCT FROM p_coordinator_batch_id
       )
  ) THEN
    RAISE EXCEPTION 'sync stream coordinator binding is immutable'
      USING ERRCODE='23505';
  END IF;
  UPDATE control_plane.sync_stream_phases phase_row
     SET coordinator_job_request_id=p_coordinator_job_request_id,
         coordinator_sync_run_id=p_coordinator_sync_run_id,
         coordinator_batch_id=p_coordinator_batch_id
   WHERE phase_row.tenant_id=p_tenant_id
     AND phase_row.connection_id=p_connection_id
     AND phase_row.connection_generation=p_connection_generation
     AND phase_row.stream=p_stream AND phase_row.phase=p_phase
     AND phase_row.coordinator_job_request_id IS NULL
     AND phase_row.coordinator_sync_run_id IS NULL
     AND phase_row.coordinator_batch_id IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.issue_protected_dogfood_onboarding_journey(
  p_candidate_sha text,
  p_deployment_id text,
  p_nonce_hash text,
  p_ttl_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE issued timestamptz:=clock_timestamp();
DECLARE expires timestamptz;
DECLARE barrier_at timestamptz;
DECLARE journey_id text:=control_plane.generate_ulid();
BEGIN
  PERFORM control_plane.assert_operator_diagnostic_control_ready();
  IF coalesce(p_candidate_sha,'')!~'^[a-f0-9]{40}$'
     OR coalesce(p_deployment_id,'')!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR coalesce(p_nonce_hash,'')!~'^[a-f0-9]{64}$'
     OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 600 AND 5400 THEN
    RAISE EXCEPTION 'protected onboarding journey input is invalid'
      USING ERRCODE='22023';
  END IF;
  barrier_at:=control_plane.protected_dogfood_deployment_barrier(
    p_candidate_sha,p_deployment_id
  );
  IF issued<barrier_at THEN
    RAISE EXCEPTION 'protected onboarding journey predates the candidate barrier'
      USING ERRCODE='55000';
  END IF;
  expires:=issued+make_interval(secs=>p_ttl_seconds);
  UPDATE control_plane.protected_dogfood_onboarding_journeys journey
     SET status='expired'
   WHERE journey.candidate_sha=p_candidate_sha
     AND journey.deployment_id=p_deployment_id
     AND journey.status IN ('issued','claimed')
     AND journey.expires_at<=issued;
  IF EXISTS (
    SELECT 1 FROM control_plane.protected_dogfood_onboarding_journeys journey
     WHERE journey.candidate_sha=p_candidate_sha
       AND journey.deployment_id=p_deployment_id
       AND journey.status IN ('issued','claimed')
  ) THEN
    RAISE EXCEPTION 'an active protected onboarding journey already exists'
      USING ERRCODE='55000';
  END IF;
  INSERT INTO control_plane.protected_dogfood_onboarding_journeys(
    journey_id,candidate_sha,deployment_id,deployment_barrier_at,
    nonce_hash,status,issued_at,expires_at
  ) VALUES(
    journey_id,p_candidate_sha,p_deployment_id,barrier_at,
    p_nonce_hash,'issued',issued,expires
  );
  RETURN jsonb_build_object(
    'journeyId',journey_id,'candidateSha',p_candidate_sha,
    'deploymentId',p_deployment_id,'barrierAt',barrier_at,
    'issuedAt',issued,'expiresAt',expires
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_claim_protected_dogfood_onboarding_journey(
  p_journey_id text,
  p_nonce text,
  p_browser_nonce_hash text,
  p_user_agent_hash text
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE actor uuid:=extensions.albert_auth_uid();
DECLARE selected_tenant text:=control_plane.require_current_tenant_id();
DECLARE journey control_plane.protected_dogfood_onboarding_journeys%ROWTYPE;
DECLARE tenant_row control_plane.tenants%ROWTYPE;
DECLARE membership_row control_plane.memberships%ROWTYPE;
DECLARE tenant_audit_id text;
DECLARE tenant_audit_count integer;
DECLARE confirmed_at timestamptz;
DECLARE claimed timestamptz:=clock_timestamp();
DECLARE binding jsonb;
DECLARE binding_digest text;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE='42501';
  END IF;
  IF coalesce(control_plane.is_ulid(p_journey_id),false) IS NOT TRUE
     OR coalesce(p_nonce,'')!~'^[A-Za-z0-9_-]{43}$'
     OR coalesce(p_browser_nonce_hash,'')!~'^[a-f0-9]{64}$'
     OR coalesce(p_user_agent_hash,'')!~'^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'protected onboarding claim input is invalid'
      USING ERRCODE='22023';
  END IF;
  SELECT candidate.* INTO journey
    FROM control_plane.protected_dogfood_onboarding_journeys candidate
   WHERE candidate.journey_id=p_journey_id
   FOR UPDATE;
  IF NOT FOUND
     OR journey.status<>'issued'
     OR journey.expires_at<=claimed
     OR journey.nonce_hash<>encode(extensions.digest(convert_to(p_nonce,'UTF8'),'sha256'),'hex') THEN
    RAISE EXCEPTION 'protected onboarding journey is unavailable or already used'
      USING ERRCODE='55000';
  END IF;
  SELECT directory.email_confirmed_at INTO confirmed_at
    FROM extensions.albert_auth_users_by_ids(ARRAY[actor]::uuid[]) directory
   WHERE directory.id=actor;
  IF confirmed_at IS NULL OR confirmed_at<journey.issued_at OR confirmed_at>claimed THEN
    RAISE EXCEPTION 'a fresh confirmed email user is required'
      USING ERRCODE='55000';
  END IF;
  SELECT tenant.* INTO tenant_row FROM control_plane.tenants tenant
   WHERE tenant.tenant_id=selected_tenant FOR SHARE;
  SELECT membership.* INTO membership_row
    FROM control_plane.memberships membership
   WHERE membership.tenant_id=selected_tenant
     AND membership.user_id=actor
     AND membership.role='owner'
     AND membership.status='active'
   FOR SHARE;
  SELECT count(*),min(audit.audit_id)
    INTO tenant_audit_count,tenant_audit_id
    FROM control_plane.audit_log audit
   WHERE audit.tenant_id=selected_tenant
     AND audit.actor_user_id=actor
     AND audit.actor_type='user'
     AND audit.action='tenant.bootstrap'
     AND audit.resource_type='tenant'
     AND audit.resource_id=selected_tenant
     AND audit.occurred_at>=journey.issued_at
     AND audit.occurred_at<=claimed;
  IF tenant_row.tenant_id IS NULL OR tenant_row.status<>'active'
     OR tenant_row.created_by IS DISTINCT FROM actor
     OR tenant_row.created_at<journey.issued_at OR tenant_row.created_at>claimed
     OR membership_row.membership_id IS NULL
     OR membership_row.created_by IS DISTINCT FROM actor
     OR membership_row.created_at<journey.issued_at OR membership_row.created_at>claimed
     OR tenant_audit_count<>1 OR tenant_audit_id IS NULL THEN
    RAISE EXCEPTION 'fresh owner membership and tenant-created user audit proof are required'
      USING ERRCODE='55000';
  END IF;
  binding:=jsonb_build_object(
    'schemaVersion',1,'journeyId',journey.journey_id,
    'candidateSha',journey.candidate_sha,'deploymentId',journey.deployment_id,
    'barrierAt',journey.deployment_barrier_at,'issuedAt',journey.issued_at,
    'expiresAt',journey.expires_at,'issuedNonceHash',journey.nonce_hash,
    'userId',actor,'tenantId',selected_tenant,
    'membershipId',membership_row.membership_id,
    'tenantCreatedAuditId',tenant_audit_id,
    'browserNonceHash',p_browser_nonce_hash,
    'userAgentHash',p_user_agent_hash,
    'tenantCreationAction','tenant.bootstrap','claimedAt',claimed
  );
  binding_digest:=control_plane.dogfood_evidence_sha256(binding);
  INSERT INTO control_plane.protected_dogfood_onboarding_claims(
    journey_id,user_id,tenant_id,membership_id,tenant_created_audit_id,
    browser_nonce_hash,user_agent_hash,claimed_at,claim_binding,claim_digest
  ) VALUES(
    journey.journey_id,actor,selected_tenant,membership_row.membership_id,
    tenant_audit_id,p_browser_nonce_hash,p_user_agent_hash,claimed,binding,binding_digest
  );
  UPDATE control_plane.protected_dogfood_onboarding_journeys
     SET status='claimed',claimed_at=claimed,claimed_by=actor,
         claimed_tenant_id=selected_tenant,
         claimed_membership_id=membership_row.membership_id,
         tenant_created_audit_id=tenant_audit_id
   WHERE journey_id=journey.journey_id AND status='issued';
  INSERT INTO control_plane.audit_log(
    tenant_id,audit_id,actor_user_id,actor_type,action,
    resource_type,resource_id,audit_metadata,occurred_at
  ) VALUES(
    selected_tenant,control_plane.generate_ulid(),actor,'user',
    'dogfood.onboarding_journey_claimed','protected_dogfood_journey',
    journey.journey_id,jsonb_build_object('claimDigest',binding_digest),claimed
  );
  RETURN jsonb_build_object(
    'journeyId',journey.journey_id,'tenantId',selected_tenant,
    'claimDigest',binding_digest,'claimedAt',claimed,
    'expiresAt',journey.expires_at,'requiresPostClaimLogin',true
  );
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.complete_protected_dogfood_onboarding_receipt(
  p_journey_id text,
  p_user_id uuid,
  p_tenant_id text,
  p_browser_nonce_hash text,
  p_user_agent_hash text
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE journey control_plane.protected_dogfood_onboarding_journeys%ROWTYPE;
DECLARE claim control_plane.protected_dogfood_onboarding_claims%ROWTYPE;
DECLARE completed timestamptz:=clock_timestamp();
DECLARE receipt_id text:=control_plane.generate_ulid();
DECLARE auth_proof jsonb;
DECLARE auth_digest text;
DECLARE binding jsonb;
DECLARE binding_digest text;
BEGIN
  PERFORM control_plane.assert_operator_diagnostic_control_ready();
  IF coalesce(control_plane.is_ulid(p_journey_id),false) IS NOT TRUE
     OR p_user_id IS NULL
     OR coalesce(control_plane.is_ulid(p_tenant_id),false) IS NOT TRUE
     OR coalesce(p_browser_nonce_hash,'')!~'^[a-f0-9]{64}$'
     OR coalesce(p_user_agent_hash,'')!~'^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'protected onboarding receipt input is invalid'
      USING ERRCODE='22023';
  END IF;
  SELECT candidate.* INTO journey
    FROM control_plane.protected_dogfood_onboarding_journeys candidate
   WHERE candidate.journey_id=p_journey_id FOR UPDATE;
  SELECT candidate.* INTO claim
    FROM control_plane.protected_dogfood_onboarding_claims candidate
   WHERE candidate.journey_id=p_journey_id;
  IF journey.journey_id IS NULL OR claim.journey_id IS NULL
     OR journey.status<>'claimed'
     OR journey.claimed_by IS DISTINCT FROM p_user_id
     OR journey.claimed_tenant_id IS DISTINCT FROM p_tenant_id
     OR claim.user_id IS DISTINCT FROM p_user_id
     OR claim.tenant_id IS DISTINCT FROM p_tenant_id
     OR claim.browser_nonce_hash IS DISTINCT FROM p_browser_nonce_hash
     OR claim.user_agent_hash IS DISTINCT FROM p_user_agent_hash
     OR completed<=claim.claimed_at OR completed>journey.expires_at THEN
    RAISE EXCEPTION 'protected onboarding claim is stale or belongs to another user'
      USING ERRCODE='55000';
  END IF;
  auth_proof:=extensions.albert_protected_dogfood_auth_audit_proof(
    p_user_id,journey.issued_at,claim.claimed_at,completed
  );
  auth_digest:=control_plane.dogfood_evidence_sha256(auth_proof);
  binding:=jsonb_build_object(
    'schemaVersion',1,'receiptId',receipt_id,
    'journeyId',journey.journey_id,'candidateSha',journey.candidate_sha,
    'deploymentId',journey.deployment_id,'barrierAt',journey.deployment_barrier_at,
    'issuedAt',journey.issued_at,'expiresAt',journey.expires_at,
    'issuedNonceHash',journey.nonce_hash,'claimDigest',claim.claim_digest,
    'userId',p_user_id,'tenantId',p_tenant_id,'claimedAt',claim.claimed_at,
    'browserNonceHash',claim.browser_nonce_hash,'userAgentHash',claim.user_agent_hash,
    'authProofDigest',auth_digest,'completedAt',completed
  );
  binding_digest:=control_plane.dogfood_evidence_sha256(binding);
  INSERT INTO control_plane.protected_dogfood_onboarding_receipts(
    journey_id,receipt_id,user_id,tenant_id,browser_nonce_hash,user_agent_hash,
    auth_proof,auth_proof_digest,completed_at,receipt_binding,receipt_digest
  ) VALUES(
    journey.journey_id,receipt_id,p_user_id,p_tenant_id,claim.browser_nonce_hash,
    claim.user_agent_hash,auth_proof,auth_digest,completed,binding,binding_digest
  );
  UPDATE control_plane.protected_dogfood_onboarding_journeys
     SET status='completed',completed_at=completed
   WHERE journey_id=journey.journey_id AND status='claimed';
  INSERT INTO control_plane.audit_log(
    tenant_id,audit_id,actor_user_id,actor_type,action,
    resource_type,resource_id,audit_metadata,occurred_at
  ) VALUES(
    p_tenant_id,control_plane.generate_ulid(),p_user_id,'service',
    'dogfood.onboarding_browser_receipt_completed','protected_dogfood_journey',
    journey.journey_id,jsonb_build_object(
      'receiptDigest',binding_digest,'authProofDigest',auth_digest
    ),completed
  );
  RETURN jsonb_build_object(
    'journeyId',journey.journey_id,'receiptId',receipt_id,
    'receiptDigest',binding_digest,'authProofDigest',auth_digest,
    'candidateSha',journey.candidate_sha,'deploymentId',journey.deployment_id,
    'tenantId',p_tenant_id,'completedAt',completed
  );
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.protected_dogfood_m7_journey_evidence(
  p_journey_id text,
  p_candidate_sha text,
  p_deployment_id text,
  p_onboarding_tenant_id text,
  p_onboarding_target_minutes integer,
  p_barrier_at timestamptz,
  p_captured_at timestamptz,
  p_live_vendor_attestations jsonb
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE journey control_plane.protected_dogfood_onboarding_journeys%ROWTYPE;
DECLARE claim control_plane.protected_dogfood_onboarding_claims%ROWTYPE;
DECLARE receipt control_plane.protected_dogfood_onboarding_receipts%ROWTYPE;
DECLARE auth_proof_now jsonb;
DECLARE provider_name text;
DECLARE session_count integer;
DECLARE session_row control_plane.oauth_sessions%ROWTYPE;
DECLARE connection_row control_plane.connections%ROWTYPE;
DECLARE authorisation_audit_id text;
DECLARE authorisation_audit_metadata jsonb;
DECLARE authorisation_audit_at timestamptz;
DECLARE authorisation_audit_count integer;
DECLARE oauth_document jsonb:='[]'::jsonb;
DECLARE oauth_digest text;
DECLARE onboarding_connection_bindings jsonb:='[]'::jsonb;
DECLARE initial_job_request_id text;
DECLARE initial_sync_run_id text;
DECLARE initial_batch_id text;
DECLARE initial_range_from timestamptz;
DECLARE initial_range_to timestamptz;
DECLARE onboarding_created timestamptz;
DECLARE onboarding_reached timestamptz;
DECLARE onboarding_minutes numeric;
DECLARE readiness_count integer;
DECLARE ready_connection_count integer;
DECLARE readiness_binding jsonb;
DECLARE readiness_binding_digest text;
DECLARE blocking_count integer;
DECLARE blocking_contract jsonb;
DECLARE blocking_contract_digest text;
DECLARE blocking_contract_canonical text;
DECLARE expected_question_count integer;
DECLARE response_question_count integer;
DECLARE response_document jsonb;
DECLARE blocking_audits_exact boolean;
DECLARE blocking_response_binding jsonb;
DECLARE blocking_response_digest text;
DECLARE overlay_value jsonb;
DECLARE overlay_digest text;
DECLARE result jsonb;
DECLARE journey_binding_digest text;
DECLARE expected_claim_binding jsonb;
DECLARE expected_receipt_binding jsonb;
DECLARE oauth_connection_ids text[]:=ARRAY[]::text[];
DECLARE question_item jsonb;
DECLARE selected_option jsonb;
DECLARE mutation_item jsonb;
DECLARE mutation_path text[];
DECLARE live_vendor_provider_count integer;
DECLARE live_vendor_consumption_id text;
DECLARE live_vendor_evidence_digest text;
DECLARE live_vendor_consumed_at timestamptz;
BEGIN
  IF coalesce(control_plane.is_ulid(p_journey_id),false) IS NOT TRUE
     OR coalesce(p_candidate_sha,'')!~'^[a-f0-9]{40}$'
     OR coalesce(p_deployment_id,'')!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR coalesce(control_plane.is_ulid(p_onboarding_tenant_id),false) IS NOT TRUE
     OR p_onboarding_target_minutes IS NULL
     OR p_onboarding_target_minutes NOT BETWEEN 1 AND 1440
     OR p_barrier_at IS NULL OR p_captured_at IS NULL
     OR p_barrier_at>p_captured_at
     OR p_captured_at>statement_timestamp()+interval '5 seconds'
     OR jsonb_typeof(p_live_vendor_attestations)<>'object'
     OR NOT (p_live_vendor_attestations ?& ARRAY[
       'schemaVersion','consumptionId','journeyId','candidateSha','deploymentId',
       'tenantId','providers','consumedAt','evidenceDigest'
     ])
     OR p_live_vendor_attestations-'schemaVersion'-'consumptionId'-'journeyId'-
          'candidateSha'-'deploymentId'-'tenantId'-'providers'-'consumedAt'-
          'evidenceDigest'<>'{}'::jsonb THEN
    RAISE EXCEPTION 'protected M7 journey evidence input is invalid'
      USING ERRCODE='22023';
  END IF;
  live_vendor_consumption_id:=p_live_vendor_attestations->>'consumptionId';
  live_vendor_evidence_digest:=p_live_vendor_attestations->>'evidenceDigest';
  IF p_live_vendor_attestations->>'schemaVersion'<>'1'
     OR coalesce(control_plane.is_ulid(live_vendor_consumption_id),false) IS NOT TRUE
     OR p_live_vendor_attestations->>'journeyId'<>p_journey_id
     OR p_live_vendor_attestations->>'candidateSha'<>p_candidate_sha
     OR p_live_vendor_attestations->>'deploymentId'<>p_deployment_id
     OR p_live_vendor_attestations->>'tenantId'<>p_onboarding_tenant_id
     OR coalesce(live_vendor_evidence_digest,'')!~'^[a-f0-9]{64}$'
     OR jsonb_typeof(p_live_vendor_attestations->'consumedAt')<>'string'
     OR live_vendor_evidence_digest<>control_plane.dogfood_evidence_sha256(
          p_live_vendor_attestations-'evidenceDigest'
        )
     OR jsonb_typeof(p_live_vendor_attestations->'providers')<>'array' THEN
    RAISE EXCEPTION 'protected M7 live vendor attestation binding is invalid'
      USING ERRCODE='55000';
  END IF;
  live_vendor_consumed_at:=(p_live_vendor_attestations->>'consumedAt')::timestamptz;
  SELECT count(*) INTO live_vendor_provider_count
    FROM jsonb_array_elements(p_live_vendor_attestations->'providers') item(provider)
   WHERE jsonb_typeof(provider)='object'
     AND provider ?& ARRAY[
       'provider','connectionId','connectionGeneration','challengeId',
       'resultDigest','providerIdentityDigest','keyId','signature'
     ];
  IF live_vendor_provider_count<>3
     OR (SELECT count(DISTINCT provider->>'provider')
           FROM jsonb_array_elements(p_live_vendor_attestations->'providers') item(provider))<>3
     OR EXISTS (
       SELECT 1
         FROM jsonb_array_elements(p_live_vendor_attestations->'providers') item(provider)
        WHERE provider->>'provider' NOT IN ('deputy','lightspeed-r','xero')
           OR coalesce(control_plane.is_ulid(provider->>'connectionId'),false) IS NOT TRUE
           OR coalesce(provider->>'connectionGeneration','')!~'^[1-9][0-9]*$'
           OR coalesce(control_plane.is_ulid(provider->>'challengeId'),false) IS NOT TRUE
           OR coalesce(provider->>'resultDigest','')!~'^[a-f0-9]{64}$'
           OR coalesce(provider->>'providerIdentityDigest','')!~'^[a-f0-9]{64}$'
     ) THEN
    RAISE EXCEPTION 'protected M7 requires three exact live vendor attestations'
      USING ERRCODE='55000';
  END IF;
  SELECT candidate.* INTO journey
    FROM control_plane.protected_dogfood_onboarding_journeys candidate
   WHERE candidate.journey_id=p_journey_id;
  SELECT candidate.* INTO claim
    FROM control_plane.protected_dogfood_onboarding_claims candidate
   WHERE candidate.journey_id=p_journey_id;
  SELECT candidate.* INTO receipt
    FROM control_plane.protected_dogfood_onboarding_receipts candidate
   WHERE candidate.journey_id=p_journey_id;
  expected_claim_binding:=jsonb_build_object(
    'schemaVersion',1,'journeyId',journey.journey_id,
    'candidateSha',journey.candidate_sha,'deploymentId',journey.deployment_id,
    'barrierAt',journey.deployment_barrier_at,'issuedAt',journey.issued_at,
    'expiresAt',journey.expires_at,'issuedNonceHash',journey.nonce_hash,
    'userId',claim.user_id,'tenantId',claim.tenant_id,
    'membershipId',claim.membership_id,
    'tenantCreatedAuditId',claim.tenant_created_audit_id,
    'browserNonceHash',claim.browser_nonce_hash,
    'userAgentHash',claim.user_agent_hash,
    'tenantCreationAction','tenant.bootstrap',
    'claimedAt',claim.claimed_at
  );
  expected_receipt_binding:=jsonb_build_object(
    'schemaVersion',1,'receiptId',receipt.receipt_id,
    'journeyId',journey.journey_id,'candidateSha',journey.candidate_sha,
    'deploymentId',journey.deployment_id,'barrierAt',journey.deployment_barrier_at,
    'issuedAt',journey.issued_at,'expiresAt',journey.expires_at,
    'issuedNonceHash',journey.nonce_hash,'claimDigest',claim.claim_digest,
    'userId',receipt.user_id,'tenantId',receipt.tenant_id,
    'claimedAt',claim.claimed_at,
    'browserNonceHash',receipt.browser_nonce_hash,
    'userAgentHash',receipt.user_agent_hash,
    'authProofDigest',receipt.auth_proof_digest,
    'completedAt',receipt.completed_at
  );
  IF journey.journey_id IS NULL OR claim.journey_id IS NULL OR receipt.journey_id IS NULL
     OR journey.status<>'completed'
     OR journey.candidate_sha<>p_candidate_sha
     OR journey.deployment_id<>p_deployment_id
     OR journey.deployment_barrier_at IS DISTINCT FROM p_barrier_at
     OR journey.issued_at<p_barrier_at
     OR journey.issued_at>=claim.claimed_at
     OR claim.claimed_at>=receipt.completed_at
     OR receipt.completed_at>journey.expires_at
     OR receipt.completed_at>p_captured_at
     OR live_vendor_consumed_at<receipt.completed_at
     OR live_vendor_consumed_at>p_captured_at
     OR journey.claimed_tenant_id<>p_onboarding_tenant_id
     OR claim.tenant_id<>p_onboarding_tenant_id
     OR receipt.tenant_id<>p_onboarding_tenant_id
     OR journey.claimed_by IS DISTINCT FROM claim.user_id
     OR receipt.user_id IS DISTINCT FROM claim.user_id
     OR receipt.browser_nonce_hash IS DISTINCT FROM claim.browser_nonce_hash
     OR receipt.user_agent_hash IS DISTINCT FROM claim.user_agent_hash
     OR claim.claim_binding IS DISTINCT FROM expected_claim_binding
     OR receipt.receipt_binding IS DISTINCT FROM expected_receipt_binding
     OR claim.claim_digest<>control_plane.dogfood_evidence_sha256(expected_claim_binding)
     OR receipt.receipt_digest<>control_plane.dogfood_evidence_sha256(expected_receipt_binding)
     OR receipt.auth_proof_digest<>control_plane.dogfood_evidence_sha256(receipt.auth_proof) THEN
    RAISE EXCEPTION 'protected M7 journey binding is incomplete or mismatched'
      USING ERRCODE='55000';
  END IF;
  auth_proof_now:=extensions.albert_protected_dogfood_auth_audit_proof(
    claim.user_id,journey.issued_at,claim.claimed_at,receipt.completed_at
  );
  IF auth_proof_now IS DISTINCT FROM receipt.auth_proof THEN
    RAISE EXCEPTION 'protected M7 managed Auth audit proof changed or disappeared'
      USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.tenants tenant
    JOIN control_plane.memberships membership
      ON membership.tenant_id=tenant.tenant_id
     AND membership.membership_id=claim.membership_id
     AND membership.user_id=claim.user_id
     AND membership.role='owner' AND membership.status='active'
    JOIN control_plane.audit_log audit
      ON audit.tenant_id=tenant.tenant_id
     AND audit.audit_id=claim.tenant_created_audit_id
     AND audit.actor_user_id=claim.user_id
     AND audit.action='tenant.bootstrap'
     AND audit.resource_type='tenant'
     AND audit.resource_id=tenant.tenant_id
     AND audit.occurred_at>=journey.issued_at
     AND audit.occurred_at<=claim.claimed_at
   WHERE tenant.tenant_id=p_onboarding_tenant_id
     AND tenant.status='active' AND tenant.created_by=claim.user_id
     AND tenant.created_at>=journey.issued_at
     AND tenant.created_at<=claim.claimed_at
  ) THEN
    RAISE EXCEPTION 'protected M7 fresh owner or tenant-created audit binding is unavailable'
      USING ERRCODE='55000';
  END IF;

  FOR provider_name IN
    SELECT provider FROM (VALUES('deputy'),('lightspeed-r'),('xero')) item(provider)
    ORDER BY provider
  LOOP
    SELECT count(*) INTO session_count
      FROM control_plane.oauth_sessions session
     WHERE session.tenant_id=p_onboarding_tenant_id
       AND session.initiated_by=claim.user_id
       AND session.provider=provider_name
       AND session.status='consumed'
       AND session.created_at>=receipt.completed_at
       AND session.consumed_at<=p_captured_at;
    IF session_count<>1 THEN
      RAISE EXCEPTION 'protected M7 requires exactly one consumed % OAuth session',provider_name
        USING ERRCODE='55000';
    END IF;
    SELECT session.* INTO STRICT session_row
      FROM control_plane.oauth_sessions session
     WHERE session.tenant_id=p_onboarding_tenant_id
       AND session.initiated_by=claim.user_id
       AND session.provider=provider_name
       AND session.status='consumed'
       AND session.created_at>=receipt.completed_at
       AND session.consumed_at<=p_captured_at;
    IF session_row.completion_result IS NULL
       OR session_row.completion_result->>'oauthSessionId'<>session_row.oauth_session_id
       OR coalesce(control_plane.is_ulid(
            session_row.completion_result->>'connectionId'
          ),false) IS NOT TRUE
       OR coalesce(session_row.completion_result->>'connectionGeneration','')
          !~'^[1-9][0-9]*$' THEN
      RAISE EXCEPTION 'protected M7 OAuth completion is not generation-bound'
        USING ERRCODE='55000';
    END IF;
    SELECT connection.* INTO connection_row
      FROM control_plane.connections connection
     WHERE connection.tenant_id=p_onboarding_tenant_id
       AND connection.connection_id=session_row.completion_result->>'connectionId'
       AND connection.connector_key=provider_name;
    IF connection_row.connection_id IS NULL
       OR connection_row.connection_generation<>
          (session_row.completion_result->>'connectionGeneration')::bigint
       OR connection_row.authorised_by IS DISTINCT FROM claim.user_id
       OR connection_row.status<>'connected' OR connection_row.auth_health<>'healthy'
       OR connection_row.external_account_reference IS NULL
       OR connection_row.external_account_reference<>
          session_row.selected_account_reference
       OR connection_row.authorised_at IS NULL
       OR connection_row.authorised_at<session_row.created_at
       OR connection_row.authorised_at>session_row.consumed_at
       OR session_row.completion_result IS DISTINCT FROM jsonb_build_object(
         'connectionId',connection_row.connection_id,
         'jobRequestId',session_row.completion_result->>'jobRequestId',
         'oauthSessionId',session_row.oauth_session_id,
         'connectionGeneration',connection_row.connection_generation
       )
       OR NOT EXISTS (
         SELECT 1 FROM control_plane.sync_job_requests request
          WHERE request.tenant_id=p_onboarding_tenant_id
            AND request.job_request_id=session_row.completion_result->>'jobRequestId'
            AND request.connection_id=connection_row.connection_id
            AND request.job_type='InitialBackfill'
            AND request.priority='backfill'
            AND request.queue_name='albert_sync_backfill'
            AND request.idempotency_key='oauth-initial:'||session_row.oauth_session_id||
                ':g'||connection_row.connection_generation::text
            AND request.payload->>'type'='InitialBackfill'
            AND request.payload->>'tenantId'=p_onboarding_tenant_id
            AND request.payload->>'connectionId'=connection_row.connection_id
            AND request.payload->>'connectionGeneration'=
                connection_row.connection_generation::text
            AND request.payload->>'connectorId'=provider_name
            AND request.payload->>'externalAccountReference'=
                session_row.selected_account_reference
            AND request.payload->>'jobRequestId'=request.job_request_id
            AND request.payload->>'phase'='recent'
            AND request.payload->>'replayVersion'='1'
            AND request.payload->>'planMode'='progressive'
            AND jsonb_typeof(request.payload->'range')='object'
            AND (request.payload->'range') ?& ARRAY['from','to']
            AND coalesce(control_plane.is_ulid(request.payload->>'syncRunId'),false)
            AND coalesce(control_plane.is_ulid(request.payload->>'batchId'),false)
            AND request.created_at>=session_row.created_at
            AND request.created_at<=session_row.consumed_at
            AND EXISTS (
              SELECT 1 FROM control_plane.sync_runs run
               WHERE run.tenant_id=request.tenant_id
                 AND run.sync_run_id=request.payload->>'syncRunId'
                 AND run.connection_id=connection_row.connection_id
                 AND run.connection_generation=connection_row.connection_generation
                 AND run.job_type='InitialBackfill'
                 AND run.queue_job_reference=request.job_request_id
                 AND run.created_at>=request.created_at
                 AND run.created_at<=p_captured_at
            )
       )
       OR NOT EXISTS (
         SELECT 1 FROM control_plane.oauth_token_refs token
         JOIN control_plane.oauth_secret_envelopes envelope
           ON envelope.tenant_id=token.tenant_id
          AND envelope.token_ref_id=token.token_ref_id
          AND envelope.retired_at IS NULL
        WHERE token.tenant_id=connection_row.tenant_id
          AND token.connection_id=connection_row.connection_id
       ) THEN
      RAISE EXCEPTION 'protected M7 selected OAuth connection is not live or actor-bound'
        USING ERRCODE='55000';
    END IF;
    SELECT count(*),min(audit.audit_id),min(audit.occurred_at),
           min(audit.audit_metadata::text)::jsonb
      INTO authorisation_audit_count,authorisation_audit_id,
           authorisation_audit_at,authorisation_audit_metadata
      FROM control_plane.audit_log audit
     WHERE audit.tenant_id=p_onboarding_tenant_id
       AND audit.actor_user_id=claim.user_id
       AND audit.action='oauth.connection_authorised'
       AND audit.resource_type='connection'
       AND audit.resource_id=connection_row.connection_id
       AND audit.occurred_at>=session_row.consumed_at
       AND audit.occurred_at<=p_captured_at
       AND audit.audit_metadata->>'provider'=provider_name
       AND audit.audit_metadata->>'account'=session_row.selected_account_reference
       AND audit.audit_metadata->>'oauthSessionId'=session_row.oauth_session_id
       AND audit.audit_metadata->>'connectionGeneration'=
           connection_row.connection_generation::text;
    IF authorisation_audit_count<>1 OR authorisation_audit_id IS NULL THEN
      RAISE EXCEPTION 'protected M7 exact OAuth authorisation audit is missing or ambiguous'
        USING ERRCODE='55000';
    END IF;
    SELECT request.job_request_id,request.payload->>'syncRunId',
           request.payload->>'batchId',
           (request.payload->'range'->>'from')::timestamptz,
           (request.payload->'range'->>'to')::timestamptz
      INTO STRICT initial_job_request_id,initial_sync_run_id,initial_batch_id,
           initial_range_from,initial_range_to
      FROM control_plane.sync_job_requests request
     WHERE request.tenant_id=p_onboarding_tenant_id
       AND request.job_request_id=session_row.completion_result->>'jobRequestId';
    IF initial_range_from>=initial_range_to
       OR initial_range_to<receipt.completed_at
       OR initial_range_to>session_row.consumed_at+interval '5 seconds' THEN
      RAISE EXCEPTION 'protected M7 initial recent range is invalid'
        USING ERRCODE='55000';
    END IF;
    onboarding_connection_bindings:=onboarding_connection_bindings||
      jsonb_build_array(jsonb_build_object(
        'provider',provider_name,'connectionId',connection_row.connection_id,
        'connectionGeneration',connection_row.connection_generation,
        'jobRequestId',initial_job_request_id,'syncRunId',initial_sync_run_id,
        'batchId',initial_batch_id,'rangeFrom',initial_range_from,
        'rangeTo',initial_range_to
      ));
    oauth_connection_ids:=array_append(oauth_connection_ids,connection_row.connection_id);
    oauth_document:=oauth_document||jsonb_build_array(jsonb_build_object(
      'provider',provider_name,
      'sessionBindingDigest',control_plane.dogfood_evidence_sha256(jsonb_build_object(
        'oauthSessionId',session_row.oauth_session_id,
        'initiatedBy',session_row.initiated_by,
        'createdAt',session_row.created_at,'consumedAt',session_row.consumed_at,
        'selectedAccountReference',session_row.selected_account_reference,
        'completionResult',session_row.completion_result
      )),
      'connectionBindingDigest',control_plane.dogfood_evidence_sha256(jsonb_build_object(
        'connectionId',connection_row.connection_id,
        'generation',connection_row.connection_generation,
        'authorisedBy',connection_row.authorised_by,
        'authorisedAt',connection_row.authorised_at
      )),
      'authorisationAuditDigest',control_plane.dogfood_evidence_sha256(jsonb_build_object(
        'auditId',authorisation_audit_id,'occurredAt',authorisation_audit_at,
        'metadata',authorisation_audit_metadata
      ))
    ));
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM (
      (SELECT item->>'provider' AS provider,item->>'connectionId' AS connection_id,
              (item->>'connectionGeneration')::bigint AS generation
         FROM jsonb_array_elements(onboarding_connection_bindings) item)
      EXCEPT ALL
      (SELECT item->>'provider',item->>'connectionId',
              (item->>'connectionGeneration')::bigint
         FROM jsonb_array_elements(p_live_vendor_attestations->'providers') item)
    ) missing
  ) OR EXISTS (
    SELECT 1 FROM (
      (SELECT item->>'provider' AS provider,item->>'connectionId' AS connection_id,
              (item->>'connectionGeneration')::bigint AS generation
         FROM jsonb_array_elements(p_live_vendor_attestations->'providers') item)
      EXCEPT ALL
      (SELECT item->>'provider',item->>'connectionId',
              (item->>'connectionGeneration')::bigint
         FROM jsonb_array_elements(onboarding_connection_bindings) item)
    ) unexpected
  ) THEN
    RAISE EXCEPTION 'protected M7 live vendor attestations target another OAuth generation'
      USING ERRCODE='55000';
  END IF;
  oauth_digest:=control_plane.dogfood_evidence_sha256(oauth_document);

  SELECT tenant.created_at INTO onboarding_created
    FROM control_plane.tenants tenant
   WHERE tenant.tenant_id=p_onboarding_tenant_id AND tenant.status='active';
  WITH bindings AS (
    SELECT item->>'provider' AS provider,
           item->>'connectionId' AS connection_id,
           (item->>'connectionGeneration')::bigint AS connection_generation,
           item->>'jobRequestId' AS job_request_id,
           item->>'syncRunId' AS sync_run_id,
           item->>'batchId' AS batch_id,
           (item->>'rangeFrom')::timestamptz AS range_from,
           (item->>'rangeTo')::timestamptz AS range_to
      FROM jsonb_array_elements(onboarding_connection_bindings) item
  ),required_domains(provider,domain) AS (
    VALUES ('lightspeed-r','sales'),('lightspeed-r','inventory'),
           ('deputy','workforce'),('xero','accounting')
  ),qualified AS (
    SELECT binding.*,required.domain,readiness.state,readiness.data_ready_through,
           readiness.backfill_complete,readiness.covered_from,readiness.covered_to,
           readiness.coverage_qualification,readiness.evaluated_at,
           (
             SELECT control_plane.dogfood_evidence_sha256(coalesce(jsonb_agg(
               jsonb_build_object(
                 'stream',phase_row.stream,'phase',phase_row.phase,
                 'generation',phase_row.connection_generation,
                 'coordinatorJobRequestId',phase_row.coordinator_job_request_id,
                 'coordinatorSyncRunId',phase_row.coordinator_sync_run_id,
                 'coordinatorBatchId',phase_row.coordinator_batch_id,
                 'coveredFrom',coverage.covered_from,'coveredTo',coverage.covered_to,
                 'queryableAt',coverage.queryable_at,
                 'terminalBatchId',coverage.evidence->>'terminalBatchId',
                 'terminalTransformJobId',coverage.evidence->>'terminalTransformJobId'
               ) ORDER BY phase_row.stream
             ),'[]'::jsonb))
               FROM control_plane.sync_stream_phases phase_row
               JOIN control_plane.progressive_stream_coverage coverage
                 ON coverage.tenant_id=phase_row.tenant_id
                AND coverage.connection_id=phase_row.connection_id
                AND coverage.connection_generation=phase_row.connection_generation
                AND coverage.stream=phase_row.stream AND coverage.phase='recent'
              WHERE phase_row.tenant_id=p_onboarding_tenant_id
                AND phase_row.connection_id=binding.connection_id
                AND phase_row.connection_generation=binding.connection_generation
                AND phase_row.phase='recent' AND phase_row.required
                AND required.domain=ANY(phase_row.domains)
           ) AS coverage_digest
      FROM bindings binding
      JOIN required_domains required ON required.provider=binding.provider
      JOIN control_plane.readiness readiness
        ON readiness.tenant_id=p_onboarding_tenant_id
       AND readiness.connection_id=binding.connection_id
       AND readiness.domain=required.domain
     WHERE readiness.state IN ('ready_partial','ready_complete')
       AND readiness.evaluated_at>=receipt.completed_at
       AND readiness.evaluated_at<=p_captured_at
       AND readiness.data_ready_through IS NOT NULL
       AND readiness.covered_from IS NOT NULL
       AND readiness.covered_to IS NOT NULL
       AND readiness.covered_from<=binding.range_from
       AND readiness.covered_to>=binding.range_to
       AND readiness.data_ready_through>=binding.range_to
       AND readiness.data_ready_through>=p_captured_at-
           make_interval(mins=>p_onboarding_target_minutes)
       AND (
         readiness.backfill_complete
         OR (
           readiness.state='ready_partial'
           AND readiness.coverage_qualification=
             'Recent data is available only for the disclosed covered range while deeper history continues.'
         )
       )
       AND EXISTS (
         SELECT 1 FROM control_plane.sync_stream_phases phase_row
          WHERE phase_row.tenant_id=p_onboarding_tenant_id
            AND phase_row.connection_id=binding.connection_id
            AND phase_row.connection_generation=binding.connection_generation
            AND phase_row.phase='recent' AND phase_row.required
            AND required.domain=ANY(phase_row.domains)
            AND phase_row.dependency_plan_sealed
            AND phase_row.coordinator_job_request_id=binding.job_request_id
            AND phase_row.coordinator_sync_run_id=binding.sync_run_id
            AND phase_row.coordinator_batch_id=binding.batch_id
       )
       AND NOT EXISTS (
         SELECT 1
           FROM control_plane.sync_stream_phases phase_row
           LEFT JOIN control_plane.progressive_stream_coverage coverage
             ON coverage.tenant_id=phase_row.tenant_id
            AND coverage.connection_id=phase_row.connection_id
            AND coverage.connection_generation=phase_row.connection_generation
            AND coverage.stream=phase_row.stream AND coverage.phase='recent'
           LEFT JOIN control_plane.canonical_transform_jobs transform
             ON transform.tenant_id=phase_row.tenant_id
            AND transform.transform_job_id=coverage.evidence->>'terminalTransformJobId'
          WHERE phase_row.tenant_id=p_onboarding_tenant_id
            AND phase_row.connection_id=binding.connection_id
            AND phase_row.connection_generation=binding.connection_generation
            AND phase_row.phase='recent' AND phase_row.required
            AND required.domain=ANY(phase_row.domains)
            AND (
              NOT phase_row.dependency_plan_sealed
              OR phase_row.coordinator_job_request_id IS DISTINCT FROM binding.job_request_id
              OR phase_row.coordinator_sync_run_id IS DISTINCT FROM binding.sync_run_id
              OR phase_row.coordinator_batch_id IS DISTINCT FROM binding.batch_id
              OR phase_row.range_from>binding.range_from
              OR phase_row.range_to<binding.range_to
              OR coverage.status IS DISTINCT FROM 'queryable'
              OR coverage.covered_from>binding.range_from
              OR coverage.covered_to<binding.range_to
              OR coverage.queryable_at IS NULL
              OR coverage.queryable_at<receipt.completed_at
              OR coverage.queryable_at>p_captured_at
              OR transform.transform_job_id IS NULL
              OR transform.connection_id IS DISTINCT FROM binding.connection_id
              OR transform.connector_id IS DISTINCT FROM binding.provider
              OR transform.batch_id IS DISTINCT FROM coverage.evidence->>'terminalBatchId'
              OR transform.status IS DISTINCT FROM 'succeeded'
              OR transform.completed_at IS NULL
              OR transform.completed_at>p_captured_at
            )
       )
  )
  SELECT count(*),count(DISTINCT connection_id),max(evaluated_at),
         coalesce(jsonb_agg(jsonb_build_object(
           'provider',provider,'domain',domain,'connectionId',connection_id,
           'connectionGeneration',connection_generation,
           'coordinatorJobRequestId',job_request_id,
           'coordinatorSyncRunId',sync_run_id,'coordinatorBatchId',batch_id,
           'state',state,'dataReadyThrough',data_ready_through,
           'backfillComplete',backfill_complete,'coveredFrom',covered_from,
           'coveredTo',covered_to,'coverageQualification',coverage_qualification,
           'evaluatedAt',evaluated_at,'coverageDigest',coverage_digest
         ) ORDER BY provider,domain),'[]'::jsonb)
    INTO readiness_count,ready_connection_count,onboarding_reached,readiness_binding
    FROM qualified;
  readiness_binding_digest:=control_plane.dogfood_evidence_sha256(readiness_binding);
  onboarding_minutes:=extract(epoch FROM onboarding_reached-onboarding_created)/60;

  IF to_regclass('control_plane.blocking_question_contract') IS NULL THEN
    RAISE EXCEPTION 'content-addressed blocking-question contract is unavailable'
      USING ERRCODE='55000';
  END IF;
  EXECUTE $contract$
    SELECT contract.contract_digest,contract.contract_canonical_json,
           contract.contract_canonical_json::jsonb
      FROM control_plane.blocking_question_contract contract
     WHERE contract.singleton
  $contract$ INTO blocking_contract_digest,blocking_contract_canonical,blocking_contract;
  IF blocking_contract_digest IS NULL
     OR blocking_contract_digest!~'^[a-f0-9]{64}$'
     OR jsonb_typeof(blocking_contract->'questions')<>'array'
     OR blocking_contract_digest<>encode(extensions.digest(
       convert_to(blocking_contract_canonical,'UTF8'),'sha256'
     ),'hex') THEN
    RAISE EXCEPTION 'content-addressed blocking-question contract is invalid'
      USING ERRCODE='55000';
  END IF;
  expected_question_count:=jsonb_array_length(blocking_contract->'questions');
  WITH latest AS (
    SELECT DISTINCT ON (response.question_id)
           response.question_id,response.option_id,response.answered_by,
           response.response_id,response.response_version,response.answered_at
      FROM control_plane.onboarding_question_responses response
     WHERE response.tenant_id=p_onboarding_tenant_id
       AND response.answered_at>=receipt.completed_at
       AND response.answered_at<=p_captured_at
     ORDER BY response.question_id,response.response_version DESC,
              response.answered_at DESC,response.response_id DESC
  )
  SELECT count(*),coalesce(jsonb_object_agg(
           latest.question_id,latest.option_id ORDER BY latest.question_id
         ),'{}'::jsonb)
    INTO blocking_count,response_document
    FROM latest
   WHERE latest.answered_by=claim.user_id;
  SELECT count(*) INTO response_question_count
    FROM jsonb_object_keys(response_document);
  WITH latest AS (
    SELECT DISTINCT ON (response.question_id)
           response.question_id,response.option_id,response.answered_by,
           response.response_id,response.response_version,response.answered_at
      FROM control_plane.onboarding_question_responses response
     WHERE response.tenant_id=p_onboarding_tenant_id
       AND response.answered_at>=receipt.completed_at
       AND response.answered_at<=p_captured_at
     ORDER BY response.question_id,response.response_version DESC,
              response.answered_at DESC,response.response_id DESC
  )
  SELECT coalesce(bool_and((
    SELECT count(*)=1 FROM control_plane.audit_log audit
     WHERE audit.tenant_id=p_onboarding_tenant_id
       AND audit.actor_user_id=claim.user_id
       AND audit.actor_type='user'
       AND audit.action='onboarding.blocking_question_answered'
       AND audit.resource_type='onboarding_question'
       AND audit.resource_id=latest.question_id
       AND audit.audit_metadata->>'option_id'=latest.option_id
       AND audit.audit_metadata->>'response_version'=latest.response_version::text
       AND audit.audit_metadata->>'contract_version'=
           blocking_contract->>'contractVersion'
       AND audit.audit_metadata->>'contract_digest'=blocking_contract_digest
       AND audit.occurred_at>=latest.answered_at
       AND audit.occurred_at<=p_captured_at
  )),false) INTO blocking_audits_exact
    FROM latest
   WHERE latest.answered_by=claim.user_id;
  SELECT overlay.overlay INTO overlay_value
    FROM control_plane.tenant_overlays overlay
   WHERE overlay.tenant_id=p_onboarding_tenant_id
     AND overlay.status='published'
     AND overlay.created_by=claim.user_id
     AND overlay.created_at>=receipt.completed_at
     AND overlay.created_at<=p_captured_at
     AND overlay.published_at>=receipt.completed_at
     AND overlay.published_at<=p_captured_at;
  IF blocking_count<>expected_question_count
     OR response_question_count<>expected_question_count
     OR blocking_audits_exact IS DISTINCT FROM true
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(blocking_contract->'questions') expected(question)
        WHERE NOT response_document ? (expected.question->>'id')
           OR NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(expected.question->'options') allowed(option)
              WHERE allowed.option->>'id'=response_document->>(expected.question->>'id')
           )
     )
     OR overlay_value->'blocking_answers' IS DISTINCT FROM response_document THEN
    RAISE EXCEPTION 'fresh human blocking-question responses do not match the installed contract'
      USING ERRCODE='55000';
  END IF;
  WITH latest AS (
    SELECT DISTINCT ON (response.question_id)
           response.question_id,response.option_id,response.answered_by,
           response.response_id,response.response_version,response.answered_at
      FROM control_plane.onboarding_question_responses response
     WHERE response.tenant_id=p_onboarding_tenant_id
       AND response.answered_at>=receipt.completed_at
       AND response.answered_at<=p_captured_at
     ORDER BY response.question_id,response.response_version DESC,
              response.answered_at DESC,response.response_id DESC
  ),bound AS (
    SELECT latest.*,
           audit.audit_id,audit.occurred_at AS audit_at,
           audit.audit_metadata
      FROM latest
      JOIN LATERAL (
        SELECT candidate.audit_id,candidate.occurred_at,candidate.audit_metadata
          FROM control_plane.audit_log candidate
         WHERE candidate.tenant_id=p_onboarding_tenant_id
           AND candidate.actor_user_id=claim.user_id
           AND candidate.actor_type='user'
           AND candidate.action='onboarding.blocking_question_answered'
           AND candidate.resource_type='onboarding_question'
           AND candidate.resource_id=latest.question_id
           AND candidate.audit_metadata->>'option_id'=latest.option_id
           AND candidate.audit_metadata->>'response_version'=
               latest.response_version::text
           AND candidate.audit_metadata->>'contract_version'=
               blocking_contract->>'contractVersion'
           AND candidate.audit_metadata->>'contract_digest'=blocking_contract_digest
           AND candidate.occurred_at>=latest.answered_at
           AND candidate.occurred_at<=p_captured_at
         ORDER BY candidate.occurred_at,candidate.audit_id
         LIMIT 1
      ) audit ON true
     WHERE latest.answered_by=claim.user_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'questionId',bound.question_id,'optionId',bound.option_id,
           'responseId',bound.response_id,'responseVersion',bound.response_version,
           'answeredAt',bound.answered_at,
           'auditDigest',control_plane.dogfood_evidence_sha256(jsonb_build_object(
             'auditId',bound.audit_id,'occurredAt',bound.audit_at,
             'metadata',bound.audit_metadata
           ))
         ) ORDER BY bound.question_id),'[]'::jsonb)
    INTO blocking_response_binding
    FROM bound;
  blocking_response_digest:=control_plane.dogfood_evidence_sha256(
    blocking_response_binding
  );
  FOR question_item IN SELECT value FROM jsonb_array_elements(blocking_contract->'questions')
  LOOP
    SELECT option.value INTO selected_option
      FROM jsonb_array_elements(question_item->'options') option(value)
     WHERE option.value->>'id'=response_document->>(question_item->>'id');
    FOR mutation_item IN SELECT value FROM jsonb_array_elements(selected_option->'overlayMutations')
    LOOP
      SELECT array_agg(path.value ORDER BY path.ordinality)
        INTO mutation_path
        FROM jsonb_array_elements_text(mutation_item->'path')
             WITH ORDINALITY path(value,ordinality);
      IF mutation_path IS NULL
         OR overlay_value#>mutation_path IS DISTINCT FROM mutation_item->'value' THEN
        RAISE EXCEPTION 'published overlay does not implement the installed blocking answer contract'
          USING ERRCODE='55000';
      END IF;
    END LOOP;
  END LOOP;
  IF onboarding_created IS NULL OR onboarding_created<journey.issued_at
     OR onboarding_reached IS NULL OR onboarding_reached>p_captured_at
     OR onboarding_minutes<0 OR onboarding_minutes>p_onboarding_target_minutes
     OR ready_connection_count<>3 OR readiness_count<>4
     OR coalesce(readiness_binding_digest,'')!~'^[a-f0-9]{64}$'
     OR blocking_count<>expected_question_count OR expected_question_count<>4
     OR jsonb_typeof(overlay_value->'blocking_answers')<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(overlay_value->'blocking_answers'))
        <>expected_question_count THEN
    RAISE EXCEPTION 'fresh human onboarding did not meet the protected M7 target'
      USING ERRCODE='55000';
  END IF;
  overlay_digest:=control_plane.dogfood_evidence_sha256(overlay_value);
  journey_binding_digest:=control_plane.dogfood_evidence_sha256(jsonb_build_object(
    'schemaVersion',1,'journeyId',journey.journey_id,
    'candidateSha',journey.candidate_sha,'deploymentId',journey.deployment_id,
    'barrierAt',journey.deployment_barrier_at,'issuedAt',journey.issued_at,
    'claimDigest',claim.claim_digest,'receiptDigest',receipt.receipt_digest,
    'authProofDigest',receipt.auth_proof_digest,'oauthBindingDigest',oauth_digest,
    'tenantId',claim.tenant_id,'membershipId',claim.membership_id,
    'tenantCreatedAuditId',claim.tenant_created_audit_id,
    'tenantCreationAction','tenant.bootstrap',
    'onboardingMinutes',round(onboarding_minutes,3),
    'readinessCount',readiness_count,'blockingAnswerCount',blocking_count,
    'readinessBindingDigest',readiness_binding_digest,
    'liveVendorAttestationConsumptionId',live_vendor_consumption_id,
    'liveVendorAttestationEvidenceDigest',live_vendor_evidence_digest,
    'liveVendorAttestationProviderCount',live_vendor_provider_count,
    'blockingQuestionContractDigest',blocking_contract_digest,
    'blockingResponseDigest',blocking_response_digest,
    'overlayDigest',overlay_digest
  ));
  result:=jsonb_build_object(
    'passed',true,'journeyId',journey.journey_id,
    'journeyIssuedAt',journey.issued_at,'claimedAt',claim.claimed_at,
    'browserReceiptAt',receipt.completed_at,
    'onboardingMinutes',round(onboarding_minutes,3),
    'targetMinutes',p_onboarding_target_minutes,
    'readyPartialDomainCount',readiness_count,
    'readinessBindingDigest',readiness_binding_digest,
    'liveVendorAttestationConsumptionId',live_vendor_consumption_id,
    'liveVendorAttestationEvidenceDigest',live_vendor_evidence_digest,
    'liveVendorAttestationProviderCount',live_vendor_provider_count,
    'blockingAnswerCount',blocking_count,
    'blockingQuestionContractDigest',blocking_contract_digest,
    'blockingResponseDigest',blocking_response_digest,
    'overlayDigest',overlay_digest,
    'oauthConnectionCount',3,'claimDigest',claim.claim_digest,
    'browserReceiptDigest',receipt.receipt_digest,
    'authAuditProofDigest',receipt.auth_proof_digest,
    'oauthBindingDigest',oauth_digest,
    'journeyBindingDigest',journey_binding_digest
  );
  RETURN result||jsonb_build_object(
    'evidenceDigest',control_plane.dogfood_evidence_sha256(result)
  );
END;
$$;

-- Preserve the 0054 -> 0062 -> 0063 validation stack as an inaccessible
-- implementation detail. The new overload performs every earlier gate first,
-- then writes and returns a second snapshot whose M7 milestone is bound to the
-- human journey. A failure rolls both inserts back atomically.
ALTER FUNCTION control_plane.capture_protected_dogfood_acceptance(
  text,text,text,jsonb,text,integer,text,text,text,text,text
) RENAME TO capture_protected_dogfood_acceptance_v2;

CREATE FUNCTION control_plane.capture_protected_dogfood_acceptance(
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
  p_tenant_deletion_proof_id text,
  p_onboarding_journey_id text
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE baseline jsonb;
DECLARE evidence jsonb;
DECLARE strong_m7 jsonb;
DECLARE evidence_digest text;
DECLARE snapshot_id text:=control_plane.generate_ulid();
DECLARE captured timestamptz;
DECLARE barrier_at timestamptz;
DECLARE live_vendor_attestations jsonb;
BEGIN
  baseline:=control_plane.capture_protected_dogfood_acceptance_v2(
    p_candidate_sha,p_deployment_id,p_dogfood_tenant_id,p_connections,
    p_onboarding_tenant_id,p_onboarding_target_minutes,
    p_flagship_answer_artifact_id,p_category_answer_artifact_id,p_category_topic,
    p_disconnect_proof_id,p_tenant_deletion_proof_id
  );
  barrier_at:=(baseline->'evidence'->'deployment'->>'barrierAt')::timestamptz;
  IF to_regprocedure(
    'control_plane.consume_live_vendor_connection_attestations(text,text,text,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'independent live vendor attestation boundary is unavailable'
      USING ERRCODE='55000';
  END IF;
  EXECUTE $attestor$
    SELECT control_plane.consume_live_vendor_connection_attestations($1,$2,$3,$4)
  $attestor$ INTO live_vendor_attestations USING
    p_onboarding_journey_id,p_candidate_sha,p_deployment_id,p_onboarding_tenant_id;
  captured:=clock_timestamp();
  strong_m7:=control_plane.protected_dogfood_m7_journey_evidence(
    p_onboarding_journey_id,p_candidate_sha,p_deployment_id,
    p_onboarding_tenant_id,p_onboarding_target_minutes,barrier_at,captured,
    live_vendor_attestations
  );
  evidence:=jsonb_set(
    jsonb_set(baseline->'evidence','{capturedAt}',to_jsonb(captured),false),
    '{milestones,m7}',strong_m7,false
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

ALTER FUNCTION control_plane.consume_protected_dogfood_acceptance(
  text,text,text,text,text
) RENAME TO consume_protected_dogfood_acceptance_v1;

CREATE FUNCTION control_plane.consume_protected_dogfood_acceptance(
  p_snapshot_id text,p_candidate_sha text,p_evidence_digest text,
  p_release_workflow_run_id text,p_repository text
) RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE snapshot control_plane.protected_dogfood_acceptance_snapshots%ROWTYPE;
DECLARE m7 jsonb;
DECLARE journey control_plane.protected_dogfood_onboarding_journeys%ROWTYPE;
DECLARE claim control_plane.protected_dogfood_onboarding_claims%ROWTYPE;
DECLARE receipt control_plane.protected_dogfood_onboarding_receipts%ROWTYPE;
DECLARE asserted_live_vendor_attestations jsonb;
BEGIN
  PERFORM control_plane.assert_operator_diagnostic_control_ready();
  SELECT candidate.* INTO snapshot
    FROM control_plane.protected_dogfood_acceptance_snapshots candidate
   WHERE candidate.snapshot_id=p_snapshot_id FOR SHARE;
  m7:=snapshot.evidence->'milestones'->'m7';
  IF snapshot.snapshot_id IS NULL OR jsonb_typeof(m7)<>'object'
     OR NOT (m7 ?& ARRAY[
       'journeyId','claimDigest','browserReceiptDigest','authAuditProofDigest',
       'oauthBindingDigest','journeyBindingDigest','evidenceDigest',
       'oauthConnectionCount','targetMinutes','blockingQuestionContractDigest',
       'blockingResponseDigest','readinessBindingDigest',
       'liveVendorAttestationConsumptionId','liveVendorAttestationEvidenceDigest',
       'liveVendorAttestationProviderCount'
     ])
     OR coalesce(control_plane.is_ulid(m7->>'journeyId'),false) IS NOT TRUE
     OR m7->>'passed' IS DISTINCT FROM 'true'
     OR coalesce(m7->>'oauthConnectionCount','')!~'^[1-9][0-9]*$'
     OR coalesce(m7->>'targetMinutes','')!~'^[1-9][0-9]*$'
     OR coalesce(m7->>'claimDigest','')!~'^[a-f0-9]{64}$'
     OR coalesce(m7->>'browserReceiptDigest','')!~'^[a-f0-9]{64}$'
     OR coalesce(m7->>'authAuditProofDigest','')!~'^[a-f0-9]{64}$'
     OR coalesce(m7->>'oauthBindingDigest','')!~'^[a-f0-9]{64}$'
     OR coalesce(m7->>'blockingQuestionContractDigest','')!~'^[a-f0-9]{64}$'
     OR coalesce(m7->>'blockingResponseDigest','')!~'^[a-f0-9]{64}$'
     OR coalesce(m7->>'readinessBindingDigest','')!~'^[a-f0-9]{64}$'
     OR coalesce(control_plane.is_ulid(
          m7->>'liveVendorAttestationConsumptionId'
        ),false) IS NOT TRUE
     OR coalesce(m7->>'liveVendorAttestationEvidenceDigest','')!~'^[a-f0-9]{64}$'
     OR coalesce(m7->>'liveVendorAttestationProviderCount','')!~'^[1-9][0-9]*$'
     OR coalesce(m7->>'journeyBindingDigest','')!~'^[a-f0-9]{64}$'
     OR m7->>'evidenceDigest' IS DISTINCT FROM
        control_plane.dogfood_evidence_sha256(m7-'evidenceDigest') THEN
    RAISE EXCEPTION 'dogfood acceptance snapshot lacks nonce-bound human M7 evidence'
      USING ERRCODE='55000';
  END IF;
  IF (m7->>'oauthConnectionCount')::integer<>3
     OR (m7->>'liveVendorAttestationProviderCount')::integer<>3
     OR (m7->>'targetMinutes')::integer NOT BETWEEN 1 AND 1440 THEN
    RAISE EXCEPTION 'dogfood acceptance snapshot has invalid nonce-bound M7 counts'
      USING ERRCODE='55000';
  END IF;
  SELECT candidate.* INTO journey
    FROM control_plane.protected_dogfood_onboarding_journeys candidate
   WHERE candidate.journey_id=m7->>'journeyId';
  SELECT candidate.* INTO claim
    FROM control_plane.protected_dogfood_onboarding_claims candidate
   WHERE candidate.journey_id=m7->>'journeyId';
  SELECT candidate.* INTO receipt
    FROM control_plane.protected_dogfood_onboarding_receipts candidate
   WHERE candidate.journey_id=m7->>'journeyId';
  IF journey.journey_id IS NULL OR claim.journey_id IS NULL OR receipt.journey_id IS NULL
     OR journey.status<>'completed'
     OR journey.candidate_sha<>p_candidate_sha
     OR journey.deployment_id<>snapshot.evidence->'deployment'->>'deploymentId'
     OR snapshot.evidence->'deployment'->'barrierAt'
        IS DISTINCT FROM to_jsonb(journey.deployment_barrier_at)
     OR claim.claim_digest<>m7->>'claimDigest'
     OR receipt.receipt_digest<>m7->>'browserReceiptDigest'
     OR receipt.auth_proof_digest<>m7->>'authAuditProofDigest'
     OR receipt.browser_nonce_hash IS DISTINCT FROM claim.browser_nonce_hash
     OR receipt.user_agent_hash IS DISTINCT FROM claim.user_agent_hash THEN
    RAISE EXCEPTION 'dogfood acceptance human M7 receipt is unavailable or mismatched'
      USING ERRCODE='55000';
  END IF;
  -- Readiness, connections, and overlays are live projections. The accepted
  -- values and their exact row bindings were sealed into this append-only,
  -- digest-constrained snapshot at capture. Re-reading current projections
  -- here would make valid evidence fail after ordinary continued sync.
  IF to_regprocedure(
    'control_plane.assert_consumed_live_vendor_connection_attestations(text,text,text,text,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'independent live vendor attestation assertion is unavailable'
      USING ERRCODE='55000';
  END IF;
  EXECUTE $attestor$
    SELECT control_plane.assert_consumed_live_vendor_connection_attestations(
      $1,$2,$3,$4,$5
    )
  $attestor$ INTO asserted_live_vendor_attestations USING
    m7->>'liveVendorAttestationConsumptionId',journey.journey_id,p_candidate_sha,
    journey.deployment_id,claim.tenant_id;
  IF jsonb_typeof(asserted_live_vendor_attestations)<>'object'
     OR NOT (asserted_live_vendor_attestations ?& ARRAY[
       'schemaVersion','consumptionId','journeyId','candidateSha','deploymentId',
       'tenantId','providers','consumedAt','evidenceDigest'
     ])
     OR asserted_live_vendor_attestations-'schemaVersion'-'consumptionId'-
          'journeyId'-'candidateSha'-'deploymentId'-'tenantId'-'providers'-
          'consumedAt'-'evidenceDigest'<>'{}'::jsonb
     OR asserted_live_vendor_attestations->>'schemaVersion'<>'1'
     OR asserted_live_vendor_attestations->>'consumptionId' IS DISTINCT FROM
          m7->>'liveVendorAttestationConsumptionId'
     OR asserted_live_vendor_attestations->>'journeyId' IS DISTINCT FROM journey.journey_id
     OR asserted_live_vendor_attestations->>'candidateSha' IS DISTINCT FROM p_candidate_sha
     OR asserted_live_vendor_attestations->>'deploymentId' IS DISTINCT FROM journey.deployment_id
     OR asserted_live_vendor_attestations->>'tenantId' IS DISTINCT FROM claim.tenant_id
     OR asserted_live_vendor_attestations->>'evidenceDigest' IS DISTINCT FROM
       m7->>'liveVendorAttestationEvidenceDigest'
     OR asserted_live_vendor_attestations->>'evidenceDigest' IS DISTINCT FROM
          control_plane.dogfood_evidence_sha256(
            asserted_live_vendor_attestations-'evidenceDigest'
          )
     OR jsonb_typeof(asserted_live_vendor_attestations->'providers')<>'array'
     OR jsonb_array_length(asserted_live_vendor_attestations->'providers')<>3
     OR (SELECT count(DISTINCT provider->>'provider')
           FROM jsonb_array_elements(
             asserted_live_vendor_attestations->'providers'
           ) item(provider))<>3 THEN
    RAISE EXCEPTION 'independent live vendor attestation seal is mismatched'
      USING ERRCODE='55000';
  END IF;
  RETURN control_plane.consume_protected_dogfood_acceptance_v1(
    p_snapshot_id,p_candidate_sha,p_evidence_digest,
    p_release_workflow_run_id,p_repository
  );
END;
$$;

REVOKE ALL ON TABLE
  control_plane.protected_dogfood_onboarding_journey_status_lookup,
  control_plane.protected_dogfood_onboarding_journeys,
  control_plane.protected_dogfood_onboarding_claims,
  control_plane.protected_dogfood_onboarding_receipts
FROM PUBLIC,anon,authenticated,service_role,
     albert_sync_control,albert_webhook_control,albert_transform_control,
     albert_semantic_control,albert_operator_diagnostic_control,
     albert_deletion_control;
REVOKE ALL ON FUNCTION
  control_plane.issue_protected_dogfood_onboarding_journey(text,text,text,integer),
  control_plane.register_sync_stream_phase(
    text,text,bigint,text,text,integer,text,text,boolean,text[],text[],
    timestamptz,timestamptz,text,jsonb
  ),
  control_plane.register_sync_stream_phase(
    text,text,bigint,text,text,integer,text,text,boolean,text[],text[],
    timestamptz,timestamptz,text,jsonb,text,text,text
  ),
  public.albert_claim_protected_dogfood_onboarding_journey(text,text,text,text),
  control_plane.complete_protected_dogfood_onboarding_receipt(text,uuid,text,text,text),
  control_plane.protected_dogfood_m7_journey_evidence(
    text,text,text,text,integer,timestamptz,timestamptz,jsonb
  ),
  control_plane.capture_protected_dogfood_acceptance_v2(
    text,text,text,jsonb,text,integer,text,text,text,text,text
  ),
  control_plane.capture_protected_dogfood_acceptance_v1(
    text,text,text,jsonb,text,integer,text,text,text,text,text
  ),
  control_plane.capture_protected_dogfood_acceptance(
    text,text,text,jsonb,text,integer,text,text,text,text,text,text
  ),
  control_plane.consume_protected_dogfood_acceptance_v1(text,text,text,text,text),
  control_plane.consume_protected_dogfood_acceptance(text,text,text,text,text)
FROM PUBLIC,anon,authenticated,service_role,
     albert_sync_control,albert_webhook_control,albert_transform_control,
     albert_semantic_control,albert_operator_diagnostic_control,
     albert_deletion_control;
GRANT EXECUTE ON FUNCTION
  public.albert_claim_protected_dogfood_onboarding_journey(text,text,text,text)
TO authenticated;
GRANT EXECUTE ON FUNCTION control_plane.register_sync_stream_phase(
  text,text,bigint,text,text,integer,text,text,boolean,text[],text[],
  timestamptz,timestamptz,text,jsonb,text,text,text
) TO albert_sync_control;
GRANT EXECUTE ON FUNCTION
  control_plane.issue_protected_dogfood_onboarding_journey(text,text,text,integer),
  control_plane.complete_protected_dogfood_onboarding_receipt(text,uuid,text,text,text),
  control_plane.capture_protected_dogfood_acceptance(
    text,text,text,jsonb,text,integer,text,text,text,text,text,text
  ),
  control_plane.consume_protected_dogfood_acceptance(text,text,text,text,text)
TO albert_operator_diagnostic_control;

COMMIT;
