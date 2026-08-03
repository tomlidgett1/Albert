BEGIN;

DO $$
BEGIN
  IF to_regrole('albert_vendor_connection_attestor') IS NULL
     OR to_regprocedure('extensions.albert_finalize_vendor_attestation_boundary()') IS NULL THEN
    RAISE EXCEPTION 'independent vendor attestor authority is unavailable; apply administrator upgrade 0010 first';
  END IF;
  IF to_regclass('control_plane.protected_dogfood_onboarding_journeys') IS NULL THEN
    RAISE EXCEPTION 'nonce-bound human onboarding journeys are unavailable; apply migration 0065 first';
  END IF;
END;
$$;

CREATE TABLE control_plane.live_vendor_attestation_challenges (
  challenge_id text PRIMARY KEY CHECK (control_plane.is_ulid(challenge_id)),
  journey_id text NOT NULL REFERENCES
    control_plane.protected_dogfood_onboarding_journeys(journey_id) ON DELETE CASCADE,
  candidate_sha text NOT NULL CHECK (candidate_sha~'^[a-f0-9]{40}$'),
  deployment_id text NOT NULL CHECK (deployment_id~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  tenant_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('lightspeed-r','xero','deputy')),
  connection_id text NOT NULL,
  connection_generation bigint NOT NULL CHECK (connection_generation>0),
  selected_external_account_digest text NOT NULL CHECK (selected_external_account_digest~'^[a-f0-9]{64}$'),
  credential_reference_digest text NOT NULL CHECK (credential_reference_digest~'^[a-f0-9]{64}$'),
  challenge_nonce_digest text NOT NULL UNIQUE CHECK (challenge_nonce_digest~'^[a-f0-9]{64}$'),
  relay_nonce text CHECK (relay_nonce IS NULL OR relay_nonce~'^[A-Za-z0-9_-]{43}$'),
  status text NOT NULL CHECK (status IN ('issued','relayed','attesting','completed','expired')),
  relay_worker_id text,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  relayed_at timestamptz,
  attestor_claimed_at timestamptz,
  completed_at timestamptz,
  FOREIGN KEY(tenant_id,connection_id) REFERENCES
    control_plane.connections(tenant_id,connection_id) ON DELETE CASCADE,
  CHECK (expires_at=issued_at+interval '2 minutes'),
  CHECK (
    (status='issued' AND relay_nonce IS NOT NULL AND relayed_at IS NULL
      AND attestor_claimed_at IS NULL AND completed_at IS NULL)
    OR (status='relayed' AND relay_nonce IS NULL AND relayed_at IS NOT NULL
      AND attestor_claimed_at IS NULL AND completed_at IS NULL)
    OR (status='attesting' AND relay_nonce IS NULL AND relayed_at IS NOT NULL
      AND attestor_claimed_at IS NOT NULL AND completed_at IS NULL)
    OR (status='completed' AND relay_nonce IS NULL AND relayed_at IS NOT NULL
      AND attestor_claimed_at IS NOT NULL AND completed_at IS NOT NULL)
    OR status='expired'
  )
);
CREATE UNIQUE INDEX live_vendor_attestation_one_active_provider
  ON control_plane.live_vendor_attestation_challenges(journey_id,provider)
  WHERE status IN ('issued','relayed','attesting');
CREATE INDEX live_vendor_attestation_relay_queue
  ON control_plane.live_vendor_attestation_challenges(issued_at,challenge_id)
  WHERE status='issued';

CREATE TABLE control_plane.live_vendor_attestation_results (
  challenge_id text PRIMARY KEY REFERENCES
    control_plane.live_vendor_attestation_challenges(challenge_id) ON DELETE CASCADE,
  journey_id text NOT NULL,
  candidate_sha text NOT NULL CHECK (candidate_sha~'^[a-f0-9]{40}$'),
  deployment_id text NOT NULL,
  tenant_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('lightspeed-r','xero','deputy')),
  connection_id text NOT NULL,
  connection_generation bigint NOT NULL CHECK (connection_generation>0),
  selected_external_account_digest text NOT NULL CHECK (selected_external_account_digest~'^[a-f0-9]{64}$'),
  credential_reference_digest text NOT NULL CHECK (credential_reference_digest~'^[a-f0-9]{64}$'),
  challenge_nonce_digest text NOT NULL CHECK (challenge_nonce_digest~'^[a-f0-9]{64}$'),
  passed boolean NOT NULL,
  result_binding jsonb NOT NULL CHECK (jsonb_typeof(result_binding)='object'),
  result_digest text NOT NULL UNIQUE CHECK (result_digest~'^[a-f0-9]{64}$'),
  signature text NOT NULL CHECK (signature~'^[A-Za-z0-9_-]{86}$'),
  admission_mac text NOT NULL CHECK (admission_mac~'^[a-f0-9]{64}$'),
  completed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumption_id text,
  consumed_at timestamptz,
  CHECK ((consumption_id IS NULL)=(consumed_at IS NULL))
);
CREATE UNIQUE INDEX live_vendor_attestation_one_passed_provider
  ON control_plane.live_vendor_attestation_results(journey_id,provider)
  WHERE passed;

CREATE TABLE control_plane.live_vendor_attestation_consumptions (
  consumption_id text PRIMARY KEY CHECK (control_plane.is_ulid(consumption_id)),
  journey_id text NOT NULL UNIQUE,
  candidate_sha text NOT NULL CHECK (candidate_sha~'^[a-f0-9]{40}$'),
  deployment_id text NOT NULL,
  tenant_id text NOT NULL,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object'),
  evidence_digest text NOT NULL UNIQUE CHECK (evidence_digest~'^[a-f0-9]{64}$'),
  consumed_at timestamptz NOT NULL,
  CHECK (evidence_digest=extensions.albert_vendor_attestation_json_digest(evidence-'evidenceDigest'))
);

CREATE TRIGGER live_vendor_attestation_results_append_only
  BEFORE UPDATE OR DELETE ON control_plane.live_vendor_attestation_results
  FOR EACH ROW WHEN (OLD.consumed_at IS NOT NULL)
  EXECUTE FUNCTION control_plane.reject_protected_dogfood_evidence_mutation();
CREATE TRIGGER live_vendor_attestation_consumptions_append_only
  BEFORE UPDATE OR DELETE ON control_plane.live_vendor_attestation_consumptions
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_protected_dogfood_evidence_mutation();

CREATE FUNCTION control_plane.issue_live_vendor_connection_attestation(
  p_journey_id text,p_candidate_sha text,p_deployment_id text,p_provider text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog
AS $$
DECLARE journey record;
DECLARE receipt record;
DECLARE connection_row record;
DECLARE token_row record;
DECLARE oauth_count integer;
DECLARE issued timestamptz:=clock_timestamp();
DECLARE nonce text;
DECLARE nonce_digest text;
DECLARE account_digest text;
DECLARE credential_digest text;
DECLARE challenge text:=control_plane.generate_ulid();
BEGIN
  PERFORM control_plane.assert_operator_diagnostic_control_ready();
  IF coalesce(control_plane.is_ulid(p_journey_id),false) IS NOT TRUE
     OR coalesce(p_candidate_sha,'')!~'^[a-f0-9]{40}$'
     OR coalesce(p_deployment_id,'')!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR p_provider NOT IN ('lightspeed-r','xero','deputy') THEN
    RAISE EXCEPTION 'live vendor challenge input is invalid' USING ERRCODE='22023';
  END IF;
  SELECT candidate.journey_id,candidate.candidate_sha,candidate.deployment_id,
         candidate.claimed_tenant_id,candidate.claimed_by,candidate.status,
         candidate.completed_at
    INTO journey
    FROM control_plane.protected_dogfood_onboarding_journeys candidate
   WHERE candidate.journey_id=p_journey_id FOR SHARE;
  SELECT candidate.completed_at INTO receipt
    FROM control_plane.protected_dogfood_onboarding_receipts candidate
   WHERE candidate.journey_id=p_journey_id;
  IF journey.journey_id IS NULL OR journey.status<>'completed'
     OR journey.candidate_sha<>p_candidate_sha
     OR journey.deployment_id<>p_deployment_id
     OR journey.claimed_tenant_id IS NULL OR receipt.completed_at IS NULL THEN
    RAISE EXCEPTION 'completed human onboarding journey is required' USING ERRCODE='55000';
  END IF;
  SELECT connection.connector_key,connection.connection_id,
         connection.connection_generation,connection.external_account_reference,
         connection.status,connection.auth_health
    INTO connection_row
    FROM control_plane.connections connection
   WHERE connection.tenant_id=journey.claimed_tenant_id
     AND connection.connector_key=p_provider
     AND EXISTS (
       SELECT 1 FROM control_plane.oauth_sessions session
        WHERE session.tenant_id=journey.claimed_tenant_id
          AND session.initiated_by=journey.claimed_by
          AND session.provider=p_provider AND session.status='consumed'
          AND session.selected_account_reference=connection.external_account_reference
          AND session.consumed_at>=receipt.completed_at
          AND session.completion_result->>'connectionId'=connection.connection_id
          AND session.completion_result->>'connectionGeneration'=
            connection.connection_generation::text
     )
   ORDER BY connection.connection_id
   LIMIT 1 FOR SHARE;
  SELECT token.secret_reference,token.token_expires_at INTO token_row
    FROM control_plane.oauth_token_refs token
   WHERE token.tenant_id=journey.claimed_tenant_id
     AND token.connection_id=connection_row.connection_id;
  IF connection_row.connection_id IS NULL
     OR connection_row.connector_key NOT IN ('lightspeed-r','xero','deputy')
     OR connection_row.external_account_reference IS NULL
     OR connection_row.status<>'connected'
     OR connection_row.auth_health NOT IN ('healthy','expiring')
     OR token_row.secret_reference IS NULL
     OR token_row.token_expires_at<=issued+interval '10 seconds'
     OR token_row.token_expires_at>issued+interval '25 hours' THEN
    RAISE EXCEPTION 'current live vendor connection is not attestable' USING ERRCODE='55000';
  END IF;
  SELECT count(*) INTO oauth_count
    FROM control_plane.oauth_sessions session
   WHERE session.tenant_id=journey.claimed_tenant_id
     AND session.initiated_by=journey.claimed_by
     AND session.provider=p_provider
     AND session.status='consumed'
     AND session.consumed_at>=receipt.completed_at;
  IF oauth_count<>1 THEN
    RAISE EXCEPTION 'exact journey OAuth completion is required' USING ERRCODE='55000';
  END IF;
  UPDATE control_plane.live_vendor_attestation_challenges candidate
     SET status='expired',relay_nonce=NULL
   WHERE candidate.journey_id=p_journey_id
     AND candidate.provider=connection_row.connector_key
     AND candidate.status IN ('issued','relayed','attesting')
     AND candidate.expires_at<=issued;
  IF EXISTS (
    SELECT 1 FROM control_plane.live_vendor_attestation_results result
     WHERE result.journey_id=p_journey_id
       AND result.provider=connection_row.connector_key AND result.passed
  ) OR EXISTS (
    SELECT 1 FROM control_plane.live_vendor_attestation_challenges candidate
     WHERE candidate.journey_id=p_journey_id
       AND candidate.provider=connection_row.connector_key
       AND candidate.status IN ('issued','relayed','attesting')
  ) THEN
    RAISE EXCEPTION 'live vendor challenge already exists' USING ERRCODE='55000';
  END IF;
  nonce:=replace(replace(rtrim(encode(extensions.gen_random_bytes(32),'base64'),'='),'+','-'),'/','_');
  nonce_digest:=encode(extensions.digest(convert_to(nonce,'UTF8'),'sha256'),'hex');
  account_digest:=extensions.albert_vendor_attestation_json_digest(jsonb_build_object(
    'provider',connection_row.connector_key,
    'selectedExternalAccount',connection_row.external_account_reference
  ));
  credential_digest:=extensions.albert_vendor_attestation_json_digest(jsonb_build_object(
    'tenantId',journey.claimed_tenant_id,'connectionId',connection_row.connection_id,
    'connectionGeneration',connection_row.connection_generation,
    'credentialReference',token_row.secret_reference
  ));
  INSERT INTO control_plane.live_vendor_attestation_challenges(
    challenge_id,journey_id,candidate_sha,deployment_id,tenant_id,provider,
    connection_id,connection_generation,selected_external_account_digest,
    credential_reference_digest,challenge_nonce_digest,relay_nonce,status,
    issued_at,expires_at
  ) VALUES(
    challenge,p_journey_id,p_candidate_sha,p_deployment_id,journey.claimed_tenant_id,
    connection_row.connector_key,connection_row.connection_id,
    connection_row.connection_generation,account_digest,credential_digest,
    nonce_digest,nonce,'issued',issued,issued+interval '2 minutes'
  );
  RETURN jsonb_build_object(
    'schemaVersion',1,'challengeId',challenge,'journeyId',p_journey_id,
    'candidateSha',p_candidate_sha,'deploymentId',p_deployment_id,
    'tenantId',journey.claimed_tenant_id,'provider',connection_row.connector_key,
    'connectionId',connection_row.connection_id,
    'connectionGeneration',connection_row.connection_generation,
    'selectedExternalAccountDigest',account_digest,
    'credentialReferenceDigest',credential_digest,
    'challengeNonceDigest',nonce_digest,'issuedAt',issued,
    'expiresAt',issued+interval '2 minutes'
  );
END;
$$;

CREATE FUNCTION control_plane.claim_live_vendor_attestation_relay(p_worker_id text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog
AS $$
DECLARE claimed record;
DECLARE relayed timestamptz:=clock_timestamp();
DECLARE nonce text;
BEGIN
  IF coalesce(p_worker_id,'')!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$' THEN
    RAISE EXCEPTION 'vendor attestation relay worker is invalid' USING ERRCODE='22023';
  END IF;
  UPDATE control_plane.live_vendor_attestation_challenges candidate
     SET status='expired',relay_nonce=NULL
   WHERE candidate.status IN ('issued','relayed','attesting')
     AND candidate.expires_at<=relayed;
  SELECT challenge.*,connection.external_account_reference,
         token.secret_reference,token.token_expires_at
    INTO claimed
    FROM control_plane.live_vendor_attestation_challenges challenge
    JOIN control_plane.connections connection
      ON connection.tenant_id=challenge.tenant_id
     AND connection.connection_id=challenge.connection_id
     AND connection.connector_key=challenge.provider
     AND connection.connection_generation=challenge.connection_generation
     AND connection.status='connected'
    JOIN control_plane.oauth_token_refs token
      ON token.tenant_id=challenge.tenant_id
     AND token.connection_id=challenge.connection_id
   WHERE challenge.status='issued' AND challenge.expires_at>relayed
     AND challenge.selected_external_account_digest=
       extensions.albert_vendor_attestation_json_digest(jsonb_build_object(
         'provider',challenge.provider,
         'selectedExternalAccount',connection.external_account_reference
       ))
     AND challenge.credential_reference_digest=
       extensions.albert_vendor_attestation_json_digest(jsonb_build_object(
         'tenantId',challenge.tenant_id,'connectionId',challenge.connection_id,
         'connectionGeneration',challenge.connection_generation,
         'credentialReference',token.secret_reference
       ))
     AND token.token_expires_at>relayed+interval '10 seconds'
   ORDER BY challenge.issued_at,challenge.challenge_id
   LIMIT 1 FOR UPDATE OF challenge SKIP LOCKED;
  IF claimed.challenge_id IS NULL THEN RETURN NULL; END IF;
  nonce:=claimed.relay_nonce;
  UPDATE control_plane.live_vendor_attestation_challenges challenge
     SET status='relayed',relay_nonce=NULL,relay_worker_id=p_worker_id,
         relayed_at=relayed
   WHERE challenge.challenge_id=claimed.challenge_id AND challenge.status='issued';
  RETURN jsonb_build_object(
    'schemaVersion',1,'challengeId',claimed.challenge_id,
    'challengeNonce',nonce,'challengeNonceDigest',claimed.challenge_nonce_digest,
    'provider',claimed.provider,'tenantId',claimed.tenant_id,
    'connectionId',claimed.connection_id,
    'connectionGeneration',claimed.connection_generation,
    'selectedExternalAccount',claimed.external_account_reference,
    'selectedExternalAccountDigest',claimed.selected_external_account_digest,
    'credentialRef',claimed.secret_reference,
    'credentialReferenceDigest',claimed.credential_reference_digest,
    'tokenExpiresAt',claimed.token_expires_at,'expiresAt',claimed.expires_at
  );
END;
$$;

CREATE FUNCTION control_plane.claim_live_vendor_connection_attestation(
  p_challenge_id text,p_nonce text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog
AS $$
DECLARE challenge record;
DECLARE claimed timestamptz:=clock_timestamp();
DECLARE account_digest text;
DECLARE credential_digest text;
BEGIN
  IF coalesce(control_plane.is_ulid(p_challenge_id),false) IS NOT TRUE
     OR coalesce(p_nonce,'')!~'^[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION 'vendor attestor claim is invalid' USING ERRCODE='22023';
  END IF;
  SELECT candidate.*,connection.external_account_reference,
         connection.status AS connection_status,
         connection.connection_generation AS current_generation,
         token.secret_reference,token.token_expires_at
    INTO challenge
    FROM control_plane.live_vendor_attestation_challenges candidate
    JOIN control_plane.connections connection
      ON connection.tenant_id=candidate.tenant_id
     AND connection.connection_id=candidate.connection_id
    JOIN control_plane.oauth_token_refs token
      ON token.tenant_id=candidate.tenant_id
     AND token.connection_id=candidate.connection_id
   WHERE candidate.challenge_id=p_challenge_id FOR UPDATE OF candidate;
  account_digest:=extensions.albert_vendor_attestation_json_digest(jsonb_build_object(
    'provider',challenge.provider,
    'selectedExternalAccount',challenge.external_account_reference
  ));
  credential_digest:=extensions.albert_vendor_attestation_json_digest(jsonb_build_object(
    'tenantId',challenge.tenant_id,'connectionId',challenge.connection_id,
    'connectionGeneration',challenge.connection_generation,
    'credentialReference',challenge.secret_reference
  ));
  IF challenge.challenge_id IS NULL OR challenge.status<>'relayed'
     OR challenge.expires_at<=claimed
     OR challenge.challenge_nonce_digest<>
        encode(extensions.digest(convert_to(p_nonce,'UTF8'),'sha256'),'hex')
     OR challenge.connection_status<>'connected'
     OR challenge.current_generation<>challenge.connection_generation
     OR challenge.selected_external_account_digest<>account_digest
     OR challenge.credential_reference_digest<>credential_digest
     OR challenge.token_expires_at<=claimed+interval '5 seconds'
     OR challenge.token_expires_at>challenge.issued_at+interval '25 hours' THEN
    RAISE EXCEPTION 'vendor attestation challenge is stale or mismatched' USING ERRCODE='55000';
  END IF;
  UPDATE control_plane.live_vendor_attestation_challenges candidate
     SET status='attesting',attestor_claimed_at=claimed
   WHERE candidate.challenge_id=p_challenge_id AND candidate.status='relayed';
  RETURN jsonb_build_object(
    'schemaVersion',1,'challengeId',challenge.challenge_id,
    'challengeNonceDigest',challenge.challenge_nonce_digest,
    'journeyId',challenge.journey_id,'candidateSha',challenge.candidate_sha,
    'deploymentId',challenge.deployment_id,'tenantId',challenge.tenant_id,
    'provider',challenge.provider,'connectionId',challenge.connection_id,
    'connectionGeneration',challenge.connection_generation,
    'selectedExternalAccount',challenge.external_account_reference,
    'selectedExternalAccountDigest',challenge.selected_external_account_digest,
    'credentialReferenceDigest',challenge.credential_reference_digest,
    'tokenExpiresAt',challenge.token_expires_at,'issuedAt',challenge.issued_at,
    'expiresAt',challenge.expires_at,'claimedAt',claimed
  );
END;
$$;

CREATE FUNCTION control_plane.prepare_live_vendor_connection_attestation_result(
  p_challenge_id text,p_result_binding jsonb
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog
AS $$
DECLARE challenge control_plane.live_vendor_attestation_challenges%ROWTYPE;
DECLARE requested timestamptz;
DECLARE responded timestamptz;
DECLARE evidence_item jsonb;
DECLARE expected_endpoints text[];
DECLARE actual_endpoints text[];
DECLARE passed boolean;
DECLARE verifier record;
BEGIN
  SELECT configured.key_id,configured.tool_ref,configured.build_digest
    INTO verifier
    FROM extensions.albert_vendor_attestor_verifier configured
   WHERE configured.singleton;
  SELECT candidate.* INTO challenge
    FROM control_plane.live_vendor_attestation_challenges candidate
   WHERE candidate.challenge_id=p_challenge_id FOR SHARE;
  IF challenge.challenge_id IS NULL OR challenge.status<>'attesting'
     OR challenge.expires_at<=clock_timestamp()
     OR jsonb_typeof(p_result_binding)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_result_binding))<>22
     OR NOT (p_result_binding ?& ARRAY[
       'schemaVersion','challengeId','challengeNonceDigest','journeyId',
       'candidateSha','deploymentId','tenantId','provider','connectionId',
       'connectionGeneration','selectedExternalAccountDigest',
       'credentialReferenceDigest','probeContractVersion','status','errorCode',
       'providerIdentityDigest','requestedAt','respondedAt','probeEvidence',
       'keyId','toolRef','buildDigest'
     ])
     OR p_result_binding->>'schemaVersion'<>'1'
     OR p_result_binding->>'challengeId'<>challenge.challenge_id
     OR p_result_binding->>'challengeNonceDigest'<>challenge.challenge_nonce_digest
     OR p_result_binding->>'journeyId'<>challenge.journey_id
     OR p_result_binding->>'candidateSha'<>challenge.candidate_sha
     OR p_result_binding->>'deploymentId'<>challenge.deployment_id
     OR p_result_binding->>'tenantId'<>challenge.tenant_id
     OR p_result_binding->>'provider'<>challenge.provider
     OR p_result_binding->>'connectionId'<>challenge.connection_id
     OR p_result_binding->>'connectionGeneration'<>challenge.connection_generation::text
     OR p_result_binding->>'selectedExternalAccountDigest'<>challenge.selected_external_account_digest
     OR p_result_binding->>'credentialReferenceDigest'<>challenge.credential_reference_digest
     OR p_result_binding->>'probeContractVersion'<>'provider-live-identity-v1'
     OR coalesce(p_result_binding->>'providerIdentityDigest','')!~'^[a-f0-9]{64}$'
     OR verifier.key_id IS NULL
     OR p_result_binding->>'keyId'<>verifier.key_id
     OR p_result_binding->>'toolRef'<>verifier.tool_ref
     OR p_result_binding->>'buildDigest'<>verifier.build_digest
     OR coalesce(p_result_binding->>'keyId','')!~'^ed25519:[a-f0-9]{64}$'
     OR coalesce(p_result_binding->>'toolRef','')!~'^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[a-f0-9]{40}$'
     OR coalesce(p_result_binding->>'buildDigest','')!~'^sha256:[a-f0-9]{64}$'
     OR jsonb_typeof(p_result_binding->'probeEvidence')<>'array' THEN
    RAISE EXCEPTION 'vendor attestation result binding is invalid' USING ERRCODE='22023';
  END IF;
  BEGIN
    requested:=(p_result_binding->>'requestedAt')::timestamptz;
    responded:=(p_result_binding->>'respondedAt')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'vendor attestation timestamps are invalid' USING ERRCODE='22023';
  END;
  passed:=p_result_binding->>'status'='passed';
  IF p_result_binding->>'status' NOT IN ('passed','failed')
     OR requested<challenge.attestor_claimed_at OR responded<requested
     OR responded>challenge.expires_at OR responded-requested>interval '20 seconds'
     OR (passed AND p_result_binding->'errorCode'<>'null'::jsonb)
     OR (NOT passed AND coalesce(p_result_binding->>'errorCode','')!~'^[a-z][a-z0-9_]{2,79}$')
     OR jsonb_array_length(p_result_binding->'probeEvidence')>2 THEN
    RAISE EXCEPTION 'vendor attestation outcome is invalid' USING ERRCODE='22023';
  END IF;
  FOR evidence_item IN SELECT value FROM jsonb_array_elements(p_result_binding->'probeEvidence')
  LOOP
    IF jsonb_typeof(evidence_item)<>'object'
       OR (SELECT count(*) FROM jsonb_object_keys(evidence_item))<>7
       OR NOT (evidence_item ?& ARRAY[
         'endpointId','method','statusCode','headerDigest','bodyDigest',
         'requestedAt','respondedAt'
       ])
       OR evidence_item->>'method'<>'GET'
       OR coalesce(evidence_item->>'statusCode','')!~'^[1-5][0-9]{2}$'
       OR coalesce(evidence_item->>'headerDigest','')!~'^[a-f0-9]{64}$'
       OR coalesce(evidence_item->>'bodyDigest','')!~'^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'vendor probe evidence is invalid' USING ERRCODE='22023';
    END IF;
  END LOOP;
  expected_endpoints:=CASE challenge.provider
    WHEN 'xero' THEN ARRAY['xero.connections.v1','xero.accounting.organisation.v2']
    WHEN 'lightspeed-r' THEN ARRAY['lightspeed-r.account.v3']
    ELSE ARRAY['deputy.me.v1'] END;
  SELECT array_agg(value->>'endpointId' ORDER BY ordinality)
    INTO actual_endpoints
    FROM jsonb_array_elements(p_result_binding->'probeEvidence')
         WITH ORDINALITY item(value,ordinality);
  IF passed AND (
    actual_endpoints IS DISTINCT FROM expected_endpoints OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_result_binding->'probeEvidence') item
       WHERE item->>'statusCode'<>'200'
    )
  ) THEN
    RAISE EXCEPTION 'passed vendor result lacks the fixed live probes' USING ERRCODE='55000';
  END IF;
  RETURN extensions.albert_vendor_attestation_json_digest(p_result_binding);
END;
$$;

CREATE FUNCTION control_plane.complete_live_vendor_connection_attestation(
  p_challenge_id text,p_result_binding jsonb,p_result_digest text,
  p_signature text,p_admission_mac text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog
AS $$
DECLARE challenge control_plane.live_vendor_attestation_challenges%ROWTYPE;
DECLARE expected_digest text;
DECLARE completed timestamptz:=clock_timestamp();
DECLARE passed boolean;
DECLARE expected_mac text;
BEGIN
  SELECT candidate.* INTO challenge
    FROM control_plane.live_vendor_attestation_challenges candidate
   WHERE candidate.challenge_id=p_challenge_id FOR UPDATE;
  expected_digest:=control_plane.prepare_live_vendor_connection_attestation_result(
    p_challenge_id,p_result_binding
  );
  passed:=p_result_binding->>'status'='passed';
  SELECT encode(extensions.hmac(
           decode(p_result_digest,'hex'),configured.admission_hmac_key,'sha256'
         ),'hex') INTO expected_mac
    FROM extensions.albert_vendor_attestor_verifier configured
   WHERE configured.singleton
     AND configured.key_id=p_result_binding->>'keyId'
     AND configured.tool_ref=p_result_binding->>'toolRef'
     AND configured.build_digest=p_result_binding->>'buildDigest';
  IF expected_digest<>p_result_digest
     OR coalesce(p_result_digest,'')!~'^[a-f0-9]{64}$'
     OR coalesce(p_signature,'')!~'^[A-Za-z0-9_-]{86}$'
     OR coalesce(p_admission_mac,'')!~'^[a-f0-9]{64}$'
     OR expected_mac IS NULL OR expected_mac<>p_admission_mac
     OR completed>challenge.expires_at THEN
    RAISE EXCEPTION 'signed vendor attestation result is invalid' USING ERRCODE='22023';
  END IF;
  INSERT INTO control_plane.live_vendor_attestation_results(
    challenge_id,journey_id,candidate_sha,deployment_id,tenant_id,provider,
    connection_id,connection_generation,selected_external_account_digest,
    credential_reference_digest,challenge_nonce_digest,passed,result_binding,
    result_digest,signature,admission_mac,completed_at,expires_at
  ) VALUES(
    challenge.challenge_id,challenge.journey_id,challenge.candidate_sha,
    challenge.deployment_id,challenge.tenant_id,challenge.provider,
    challenge.connection_id,challenge.connection_generation,
    challenge.selected_external_account_digest,
    challenge.credential_reference_digest,challenge.challenge_nonce_digest,
    passed,p_result_binding,p_result_digest,p_signature,p_admission_mac,completed,
    challenge.expires_at
  );
  UPDATE control_plane.live_vendor_attestation_challenges candidate
     SET status='completed',completed_at=completed
   WHERE candidate.challenge_id=p_challenge_id AND candidate.status='attesting';
  RETURN jsonb_build_object(
    'challengeId',p_challenge_id,'provider',challenge.provider,
    'status',p_result_binding->>'status','resultDigest',p_result_digest,
    'completedAt',completed,'expiresAt',challenge.expires_at
  );
END;
$$;

CREATE FUNCTION control_plane.live_vendor_connection_attestation_status(
  p_journey_id text,p_candidate_sha text,p_deployment_id text,p_tenant_id text
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
  SELECT jsonb_build_object(
    'journeyId',p_journey_id,'candidateSha',p_candidate_sha,
    'deploymentId',p_deployment_id,'tenantId',p_tenant_id,
    'providers',coalesce(jsonb_agg(jsonb_build_object(
      'provider',challenge.provider,'challengeId',challenge.challenge_id,
      'status',challenge.status,'issuedAt',challenge.issued_at,
      'expiresAt',challenge.expires_at,'resultStatus',result.result_binding->>'status',
      'resultDigest',result.result_digest
    ) ORDER BY CASE challenge.provider WHEN 'lightspeed-r' THEN 1 WHEN 'xero' THEN 2 ELSE 3 END)
      FILTER (WHERE challenge.challenge_id IS NOT NULL),'[]'::jsonb)
  )
  FROM control_plane.live_vendor_attestation_challenges challenge
  LEFT JOIN control_plane.live_vendor_attestation_results result
    ON result.challenge_id=challenge.challenge_id
  WHERE challenge.journey_id=p_journey_id
    AND challenge.candidate_sha=p_candidate_sha
    AND challenge.deployment_id=p_deployment_id
    AND challenge.tenant_id=p_tenant_id
$$;

CREATE FUNCTION control_plane.consume_live_vendor_connection_attestations(
  p_journey_id text,p_candidate_sha text,p_deployment_id text,p_tenant_id text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog
AS $$
DECLARE journey record;
DECLARE provider_rows jsonb;
DECLARE provider_count integer;
DECLARE consumed timestamptz:=clock_timestamp();
DECLARE consumption text:=control_plane.generate_ulid();
DECLARE evidence_without_digest jsonb;
DECLARE evidence_digest text;
DECLARE evidence jsonb;
BEGIN
  PERFORM control_plane.assert_operator_diagnostic_control_ready();
  SELECT candidate.journey_id,candidate.candidate_sha,candidate.deployment_id,
         candidate.claimed_tenant_id,candidate.status
    INTO journey
    FROM control_plane.protected_dogfood_onboarding_journeys candidate
   WHERE candidate.journey_id=p_journey_id FOR SHARE;
  IF journey.journey_id IS NULL OR journey.status<>'completed'
     OR journey.candidate_sha<>p_candidate_sha
     OR journey.deployment_id<>p_deployment_id
     OR journey.claimed_tenant_id<>p_tenant_id THEN
    RAISE EXCEPTION 'live vendor consumption journey is invalid' USING ERRCODE='55000';
  END IF;
  PERFORM 1 FROM control_plane.live_vendor_attestation_results result
   WHERE result.journey_id=p_journey_id FOR UPDATE;
  WITH valid AS (
    SELECT result.*,challenge.status AS challenge_status,
           connection.connection_generation AS current_generation,
           connection.external_account_reference,token.secret_reference
      FROM control_plane.live_vendor_attestation_results result
      JOIN control_plane.live_vendor_attestation_challenges challenge
        ON challenge.challenge_id=result.challenge_id
      JOIN control_plane.connections connection
        ON connection.tenant_id=result.tenant_id
       AND connection.connection_id=result.connection_id
      JOIN control_plane.oauth_token_refs token
        ON token.tenant_id=result.tenant_id
       AND token.connection_id=result.connection_id
     WHERE result.journey_id=p_journey_id
       AND result.candidate_sha=p_candidate_sha
       AND result.deployment_id=p_deployment_id
       AND result.tenant_id=p_tenant_id
       AND result.passed AND result.consumed_at IS NULL
       AND result.expires_at>consumed AND challenge.status='completed'
       AND connection.status='connected'
       AND connection.connection_generation=result.connection_generation
       AND result.selected_external_account_digest=
         extensions.albert_vendor_attestation_json_digest(jsonb_build_object(
           'provider',result.provider,
           'selectedExternalAccount',connection.external_account_reference
         ))
       AND result.credential_reference_digest=
         extensions.albert_vendor_attestation_json_digest(jsonb_build_object(
           'tenantId',result.tenant_id,'connectionId',result.connection_id,
           'connectionGeneration',result.connection_generation,
           'credentialReference',token.secret_reference
         ))
  )
  SELECT count(*),jsonb_agg(jsonb_build_object(
      'provider',valid.provider,'connectionId',valid.connection_id,
      'connectionGeneration',valid.connection_generation,
      'selectedExternalAccountDigest',valid.selected_external_account_digest,
      'credentialReferenceDigest',valid.credential_reference_digest,
      'challengeId',valid.challenge_id,
      'challengeNonceDigest',valid.challenge_nonce_digest,
      'probeContractVersion',valid.result_binding->>'probeContractVersion',
      'providerIdentityDigest',valid.result_binding->>'providerIdentityDigest',
      'requestedAt',valid.result_binding->'requestedAt',
      'respondedAt',valid.result_binding->'respondedAt',
      'probeEvidence',valid.result_binding->'probeEvidence',
      'resultDigest',valid.result_digest,
      'keyId',valid.result_binding->>'keyId','signature',valid.signature,
      'toolRef',valid.result_binding->>'toolRef',
      'buildDigest',valid.result_binding->>'buildDigest'
    ) ORDER BY CASE valid.provider WHEN 'lightspeed-r' THEN 1 WHEN 'xero' THEN 2 ELSE 3 END)
    INTO provider_count,provider_rows FROM valid;
  IF provider_count<>3
     OR (SELECT array_agg(value->>'provider' ORDER BY value->>'provider')
           FROM jsonb_array_elements(provider_rows))
        IS DISTINCT FROM ARRAY['deputy','lightspeed-r','xero'] THEN
    RAISE EXCEPTION 'three current independent live vendor results are required' USING ERRCODE='55000';
  END IF;
  evidence_without_digest:=jsonb_build_object(
    'schemaVersion',1,'consumptionId',consumption,'journeyId',p_journey_id,
    'candidateSha',p_candidate_sha,'deploymentId',p_deployment_id,
    'tenantId',p_tenant_id,'providers',provider_rows,'consumedAt',consumed
  );
  evidence_digest:=extensions.albert_vendor_attestation_json_digest(evidence_without_digest);
  evidence:=evidence_without_digest||jsonb_build_object('evidenceDigest',evidence_digest);
  INSERT INTO control_plane.live_vendor_attestation_consumptions(
    consumption_id,journey_id,candidate_sha,deployment_id,tenant_id,
    evidence,evidence_digest,consumed_at
  ) VALUES(
    consumption,p_journey_id,p_candidate_sha,p_deployment_id,p_tenant_id,
    evidence,evidence_digest,consumed
  );
  UPDATE control_plane.live_vendor_attestation_results result
     SET consumption_id=consumption,consumed_at=consumed
   WHERE result.journey_id=p_journey_id AND result.passed
     AND result.consumed_at IS NULL;
  RETURN evidence;
END;
$$;

CREATE FUNCTION control_plane.assert_consumed_live_vendor_connection_attestations(
  p_consumption_id text,p_journey_id text,p_candidate_sha text,
  p_deployment_id text,p_tenant_id text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
DECLARE consumption control_plane.live_vendor_attestation_consumptions%ROWTYPE;
DECLARE result_count integer;
BEGIN
  SELECT candidate.* INTO consumption
    FROM control_plane.live_vendor_attestation_consumptions candidate
   WHERE candidate.consumption_id=p_consumption_id;
  SELECT count(*) INTO result_count
    FROM control_plane.live_vendor_attestation_results result
   WHERE result.consumption_id=p_consumption_id
     AND result.consumed_at=consumption.consumed_at
     AND result.passed;
  IF consumption.consumption_id IS NULL OR result_count<>3
     OR consumption.journey_id<>p_journey_id
     OR consumption.candidate_sha<>p_candidate_sha
     OR consumption.deployment_id<>p_deployment_id
     OR consumption.tenant_id<>p_tenant_id
     OR consumption.evidence->>'consumptionId'<>p_consumption_id
     OR consumption.evidence->>'evidenceDigest'<>consumption.evidence_digest
     OR extensions.albert_vendor_attestation_json_digest(consumption.evidence-'evidenceDigest')
        <>consumption.evidence_digest THEN
    RAISE EXCEPTION 'consumed live vendor evidence is unavailable or invalid' USING ERRCODE='55000';
  END IF;
  RETURN consumption.evidence;
END;
$$;

CREATE FUNCTION control_plane.assert_live_vendor_attestation_boundary_ready()
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
DECLARE object_name text;
BEGIN
  IF current_user<>'postgres' THEN
    RAISE EXCEPTION 'vendor attestation readiness function has the wrong owner' USING ERRCODE='55000';
  END IF;
  FOREACH object_name IN ARRAY ARRAY[
    'control_plane.live_vendor_attestation_challenges',
    'control_plane.live_vendor_attestation_results',
    'control_plane.live_vendor_attestation_consumptions'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class class
      JOIN pg_catalog.pg_roles owner ON owner.oid=class.relowner
      WHERE class.oid=to_regclass(object_name) AND owner.rolname='postgres'
    ) THEN
      RAISE EXCEPTION 'vendor attestation store is not administrator-owned' USING ERRCODE='55000';
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM extensions.albert_vendor_attestor_verifier configured
     WHERE configured.singleton
       AND configured.key_id='ed25519:'||encode(
         extensions.digest(configured.public_key_spki_der,'sha256'),'hex'
       )
       AND octet_length(configured.admission_hmac_key)=32
  ) THEN
    RAISE EXCEPTION 'vendor attestation verifier is not provisioned' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM extensions.albert_vendor_attestor_boundary_state state
     WHERE state.singleton AND state.finalized_at IS NOT NULL
       AND coalesce(state.contract_digest,'')~'^[a-f0-9]{64}$'
  ) THEN
    RAISE EXCEPTION 'vendor attestation administrator hand-off is not finalized'
      USING ERRCODE='55000';
  END IF;
  IF pg_has_role('albert_sync_control','albert_vendor_connection_attestor','member')
     OR pg_has_role('albert_operator_diagnostic_control','albert_vendor_connection_attestor','member')
     OR pg_has_role('service_role','albert_vendor_connection_attestor','member') THEN
    RAISE EXCEPTION 'candidate authority reaches the vendor attestor role' USING ERRCODE='55000';
  END IF;
  RETURN true;
END;
$$;

-- This call is the irreversible hand-off from candidate migration ownership to
-- the protected administrator boundary installed by bootstrap upgrade 0010.
SELECT extensions.albert_finalize_vendor_attestation_boundary();

COMMIT;
