\set ON_ERROR_STOP on

-- Exact OAuth identity finalisation and queue-leased auth-health mutation.
-- Every fixture is rolled back and is safe to run repeatedly.
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean,message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'connection mutation boundary assertion failed: %',message;
  END IF;
END;
$$;

INSERT INTO auth.users(
  id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) VALUES (
  '59000000-0000-4000-8000-000000000005','authenticated','authenticated',
  'connection-boundary-owner@albert.invalid','',now(),'{}','{}',now(),now()
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','59000000-0000-4000-8000-000000000005',true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"59000000-0000-4000-8000-000000000005","role":"authenticated","app_metadata":{}}',
  true
);
SELECT * FROM public.bootstrap_albert_tenant(
  'Connection mutation boundary','Australia/Melbourne'
) \gset connection_boundary_tenant_
RESET ROLE;

SELECT set_config('test.connection_boundary_tenant',:'connection_boundary_tenant_tenant_id',true);
SELECT set_config('test.connection_boundary_actor','59000000-0000-4000-8000-000000000005',true);

CREATE OR REPLACE FUNCTION pg_temp.seed_oauth_exchange(
  p_session_id text,p_provider text,p_account text,p_state_character text
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  selected_tenant text:=current_setting('test.connection_boundary_tenant');
  actor uuid:=current_setting('test.connection_boundary_actor')::uuid;
  pkce_reference text:='pkce-'||p_session_id;
  provisional_reference text:='provisional-'||p_session_id;
BEGIN
  INSERT INTO control_plane.oauth_sessions(
    tenant_id,oauth_session_id,initiated_by,provider,state_nonce_hash,
    pkce_verifier_secret_reference,redirect_uri,requested_scopes,status,
    discovered_account_choices,selected_account_reference,expires_at
  ) VALUES (
    selected_tenant,p_session_id,actor,p_provider,repeat(p_state_character,64),
    pkce_reference,'https://albert.invalid/api/oauth/callback',ARRAY['read'],
    'exchanging',jsonb_build_array(jsonb_build_object(
      'externalAccountId',p_account,'displayName','Boundary account','metadata','{}'::jsonb
    )),p_account,clock_timestamp()+interval '1 hour'
  );
  INSERT INTO control_plane.oauth_session_secret_envelopes(
    tenant_id,oauth_session_secret_id,oauth_session_id,secret_reference,
    secret_kind,credential_version,algorithm,ciphertext,nonce,
    authentication_tag,wrapped_data_key,key_reference,key_version,aad_digest
  ) VALUES
    (
      selected_tenant,control_plane.generate_ulid(),p_session_id,pkce_reference,
      'pkce_verifier',1,'AES-256-GCM',decode('01','hex'),
      decode(repeat('02',12),'hex'),decode(repeat('03',16),'hex'),
      decode('04','hex'),'test-kek','kek-v1',repeat('a',64)
    ),
    (
      selected_tenant,control_plane.generate_ulid(),p_session_id,provisional_reference,
      'exchanged_credential',1,'AES-256-GCM',decode('05','hex'),
      decode(repeat('06',12),'hex'),decode(repeat('07',16),'hex'),
      decode('08','hex'),'test-kek','kek-v1',repeat('b',64)
    );
  RETURN provisional_reference;
END;
$$;

SELECT pg_temp.seed_oauth_exchange(
  '01K70000000000000000000010','xero','boundary-account-a','a'
) AS provisional \gset oauth_a_
SELECT pg_temp.seed_oauth_exchange(
  '01K70000000000000000000020','xero','boundary-account-b','b'
) AS provisional \gset oauth_b_
SELECT pg_temp.seed_oauth_exchange(
  '01K70000000000000000000030','xero','boundary-account-disconnected','c'
) AS provisional \gset oauth_c_
SELECT pg_temp.seed_oauth_exchange(
  '01K70000000000000000000040','xero','boundary-account-reconnect','d'
) AS provisional \gset oauth_d_
SELECT set_config('test.oauth_a_provisional',:'oauth_a_provisional',true);
SELECT set_config('test.oauth_b_provisional',:'oauth_b_provisional',true);
SELECT set_config('test.oauth_c_provisional',:'oauth_c_provisional',true);

-- Disconnected rows cannot be silently reactivated. One has no reversible
-- deletion intent; the other has the exact intact intent used to prove the
-- legitimate reconnect path.
INSERT INTO control_plane.connections(
  tenant_id,connection_id,connector_key,display_name,external_account_reference,
  status,auth_health,authorised_by,connection_generation,disconnected_at
) VALUES
  (
    :'connection_boundary_tenant_tenant_id','01K70000000000000000000031','xero',
    'Disconnected without intent','boundary-account-disconnected','disconnected','revoked',
    '59000000-0000-4000-8000-000000000005',1,clock_timestamp()
  ),
  (
    :'connection_boundary_tenant_tenant_id','01K70000000000000000000041','xero',
    'Reconnectable','boundary-account-reconnect','disconnected','revoked',
    '59000000-0000-4000-8000-000000000005',1,clock_timestamp()
  );

INSERT INTO control_plane.oauth_token_refs(
  tenant_id,token_ref_id,connection_id,secret_reference,encryption_key_version,
  granted_scopes,token_expires_at
) VALUES (
  :'connection_boundary_tenant_tenant_id','01K70000000000000000000042',
  '01K70000000000000000000041','boundary-existing-token','kek-v1',ARRAY['read'],
  clock_timestamp()+interval '1 hour'
);
INSERT INTO control_plane.oauth_secret_envelopes(
  tenant_id,oauth_secret_envelope_id,token_ref_id,credential_version,
  algorithm,ciphertext,nonce,authentication_tag,wrapped_data_key,
  key_reference,key_version,aad_digest
) VALUES (
  :'connection_boundary_tenant_tenant_id','01K70000000000000000000043',
  '01K70000000000000000000042',1,'AES-256-GCM',decode('09','hex'),
  decode(repeat('0a',12),'hex'),decode(repeat('0b',16),'hex'),decode('0c','hex'),
  'test-kek','kek-v1',repeat('c',64)
);
INSERT INTO control_plane.deletion_requests(
  tenant_id,deletion_request_id,connection_id,scope,status,requested_by,
  remote_revocation_status,credential_destroyed_at,
  credential_destruction_due_at,purge_due_at,progress
) VALUES (
  :'connection_boundary_tenant_tenant_id','01K70000000000000000000044',
  '01K70000000000000000000041','connection','queued',
  '59000000-0000-4000-8000-000000000005','pending',NULL,
  clock_timestamp()+interval '15 minutes',clock_timestamp(),
  '{"disconnect_intent":{"durable":true}}'::jsonb
);

SELECT pg_temp.assert_true(
  has_table_privilege('albert_sync_control','control_plane.connections','SELECT')
  AND NOT has_table_privilege('albert_sync_control','control_plane.connections','INSERT')
  AND NOT has_table_privilege('albert_sync_control','control_plane.connections','UPDATE')
  AND NOT has_table_privilege('albert_sync_control','control_plane.connections','DELETE')
  AND has_function_privilege(
    'albert_sync_control',
    'control_plane.finalize_oauth_connection_identity(text,text,uuid,text,text,text,text,jsonb,text)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'albert_sync_control',
    'control_plane.record_connection_auth_health(text,text,bigint,text,text,text,text,text,text,bigint,text,integer)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'albert_sync_control',
    'control_plane.cancel_reconnectable_connection_deletion(text,text,text)',
    'EXECUTE'
  ),
  'sync must retain reads and only the reviewed connection mutation procedures'
);

SET LOCAL ROLE albert_sync_control;

-- Generic DML cannot manufacture, disconnect, retarget or delete a row.
DO $$
BEGIN
  BEGIN
    INSERT INTO control_plane.connections(
      tenant_id,connection_id,connector_key,display_name,status,auth_health
    ) VALUES (
      current_setting('test.connection_boundary_tenant'),
      '01K70000000000000000000090','xero','Manufactured','connected','healthy'
    );
    RAISE EXCEPTION 'sync manufactured a connection with direct INSERT';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE control_plane.connections SET status='disconnected',auth_health='revoked'
     WHERE tenant_id=current_setting('test.connection_boundary_tenant')
       AND connection_id='01K70000000000000000000031';
    RAISE EXCEPTION 'sync bypassed disconnect with direct UPDATE';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM control_plane.connections
     WHERE tenant_id=current_setting('test.connection_boundary_tenant')
       AND connection_id='01K70000000000000000000031';
    RAISE EXCEPTION 'sync deleted a connection directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;

-- A missing session, swapped actor, secret-shaped metadata, changed offered
-- account, and a proposed id already bound to another account all fail closed.
DO $$
BEGIN
  BEGIN
    PERFORM * FROM control_plane.finalize_oauth_connection_identity(
      current_setting('test.connection_boundary_tenant'),
      '01K70000000000000000000099',
      current_setting('test.connection_boundary_actor')::uuid,
      'xero','manufactured-account','01K70000000000000000000091',
      'Manufactured','{}'::jsonb,'missing-provisional'
    );
    RAISE EXCEPTION 'a missing OAuth session manufactured a connection';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM * FROM control_plane.finalize_oauth_connection_identity(
      current_setting('test.connection_boundary_tenant'),
      '01K70000000000000000000010',
      '59000000-0000-4000-8000-000000000099'::uuid,
      'xero','boundary-account-a','01K70000000000000000000001',
      'Boundary A','{}'::jsonb,current_setting('test.oauth_a_provisional')
    );
    RAISE EXCEPTION 'a swapped actor finalized a connection';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM * FROM control_plane.finalize_oauth_connection_identity(
      current_setting('test.connection_boundary_tenant'),
      '01K70000000000000000000010',
      current_setting('test.connection_boundary_actor')::uuid,
      'xero','boundary-account-a','01K70000000000000000000001',
      'Boundary A','{"accessToken":"forbidden"}'::jsonb,current_setting('test.oauth_a_provisional')
    );
    RAISE EXCEPTION 'credential-shaped account metadata was persisted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END;
$$;

SELECT * FROM control_plane.finalize_oauth_connection_identity(
  :'connection_boundary_tenant_tenant_id','01K70000000000000000000010',
  '59000000-0000-4000-8000-000000000005','xero','boundary-account-a',
  '01K70000000000000000000001','Boundary A','{"country":"AU"}'::jsonb,
  :'oauth_a_provisional'
) \gset first_finalization_
SELECT * FROM control_plane.finalize_oauth_connection_identity(
  :'connection_boundary_tenant_tenant_id','01K70000000000000000000010',
  '59000000-0000-4000-8000-000000000005','xero','boundary-account-a',
  '01K70000000000000000000001','Boundary A','{"country":"AU"}'::jsonb,
  :'oauth_a_provisional'
) \gset replay_finalization_

SELECT pg_temp.assert_true(
  :'first_finalization_connection_id'='01K70000000000000000000001'
  AND :'first_finalization_connection_generation'='1'
  AND :'first_finalization_replayed'='f'
  AND :'replay_finalization_connection_id'=:'first_finalization_connection_id'
  AND :'replay_finalization_connection_generation'=:'first_finalization_connection_generation'
  AND :'replay_finalization_replayed'='t',
  'an exact lost-response replay must return the first identity without advancing generation'
);

DO $$
BEGIN
  BEGIN
    PERFORM * FROM control_plane.finalize_oauth_connection_identity(
      current_setting('test.connection_boundary_tenant'),
      '01K70000000000000000000010',
      current_setting('test.connection_boundary_actor')::uuid,
      'xero','boundary-account-a','01K70000000000000000000001',
      'Changed replay','{"country":"AU"}'::jsonb,current_setting('test.oauth_a_provisional')
    );
    RAISE EXCEPTION 'a changed response-loss replay was accepted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
  BEGIN
    PERFORM * FROM control_plane.finalize_oauth_connection_identity(
      current_setting('test.connection_boundary_tenant'),
      '01K70000000000000000000020',
      current_setting('test.connection_boundary_actor')::uuid,
      'xero','boundary-account-b','01K70000000000000000000001',
      'Boundary B','{}'::jsonb,current_setting('test.oauth_b_provisional')
    );
    RAISE EXCEPTION 'an existing connection id was retargeted to another account';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM * FROM control_plane.finalize_oauth_connection_identity(
      current_setting('test.connection_boundary_tenant'),
      '01K70000000000000000000030',
      current_setting('test.connection_boundary_actor')::uuid,
      'xero','boundary-account-disconnected','01K70000000000000000000032',
      'Illicit reactivation','{}'::jsonb,current_setting('test.oauth_c_provisional')
    );
    RAISE EXCEPTION 'a disconnected connection without reversible deletion was reactivated';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END;
$$;

SELECT * FROM control_plane.finalize_oauth_connection_identity(
  :'connection_boundary_tenant_tenant_id','01K70000000000000000000040',
  '59000000-0000-4000-8000-000000000005','xero','boundary-account-reconnect',
  '01K70000000000000000000045','Reconnectable','{}'::jsonb,
  :'oauth_d_provisional'
) \gset reconnect_finalization_
RESET ROLE;
SELECT pg_temp.assert_true(
  :'reconnect_finalization_connection_id'='01K70000000000000000000041'
  AND :'reconnect_finalization_connection_generation'='2'
  AND (
    SELECT connection.status='connected'
       AND connection.auth_health='healthy'
       AND connection.disconnected_at IS NULL
       AND request.status='cancelled'
      FROM control_plane.connections AS connection
      JOIN control_plane.deletion_requests AS request
        ON request.tenant_id=connection.tenant_id
       AND request.connection_id=connection.connection_id
     WHERE connection.tenant_id=:'connection_boundary_tenant_tenant_id'
       AND connection.connection_id='01K70000000000000000000041'
       AND request.deletion_request_id='01K70000000000000000000044'
  ),
  'only an intact, never-started disconnect intent may be reconnected and generation-fenced'
);

-- Build one exact active queue lease for the newly-created connection.
INSERT INTO control_plane.sync_job_requests(
  tenant_id,job_request_id,connection_id,idempotency_key,job_type,priority,
  queue_name,queue_message_id,payload,status,last_claimed_at
) VALUES (
  :'connection_boundary_tenant_tenant_id','01K70000000000000000000050',
  '01K70000000000000000000001','connection-health-boundary-job',
  'IncrementalSync','standard','albert_sync_standard',88001,
  jsonb_build_object(
    'schemaVersion',1,'type','IncrementalSync',
    'tenantId',:'connection_boundary_tenant_tenant_id',
    'connectionId','01K70000000000000000000001','connectionGeneration',1,
    'connectorId','xero','externalAccountReference','boundary-account-a',
    'syncRunId','01K70000000000000000000051',
    'batchId','01K70000000000000000000052',
    'requestedAt','2026-08-03T00:00:00.000Z','stream','invoices',
    'reason','schedule','jobRequestId','01K70000000000000000000050'
  ),'running',clock_timestamp()
);
INSERT INTO control_plane.sync_job_attempts(
  tenant_id,job_attempt_id,job_request_id,attempt_number,worker_id,visibility_deadline
) VALUES (
  :'connection_boundary_tenant_tenant_id','01K70000000000000000000053',
  '01K70000000000000000000050',1,'worker-connection-boundary',
  clock_timestamp()+interval '10 minutes'
);

SET LOCAL ROLE albert_sync_control;
SELECT control_plane.record_connection_auth_health(
  :'connection_boundary_tenant_tenant_id','01K70000000000000000000001',1,
  'xero','boundary-account-a','01K70000000000000000000051','expired',
  '01K70000000000000000000050','albert_sync_standard',88001,
  'worker-connection-boundary',1
);
DO $$
BEGIN
  BEGIN
    PERFORM control_plane.record_connection_auth_health(
      current_setting('test.connection_boundary_tenant'),
      '01K70000000000000000000001',2,'xero','boundary-account-a',
      '01K70000000000000000000051','healthy',
      '01K70000000000000000000050','albert_sync_standard',88001,
      'worker-connection-boundary',1
    );
    RAISE EXCEPTION 'a stale/different generation changed auth health';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM control_plane.record_connection_auth_health(
      current_setting('test.connection_boundary_tenant'),
      '01K70000000000000000000001',1,'xero','retargeted-account',
      '01K70000000000000000000051','healthy',
      '01K70000000000000000000050','albert_sync_standard',88001,
      'worker-connection-boundary',1
    );
    RAISE EXCEPTION 'a leased job was retargeted to another source account';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM control_plane.cancel_reconnectable_connection_deletion(
      current_setting('test.connection_boundary_tenant'),
      '01K70000000000000000000041','01K70000000000000000000040'
    );
    RAISE EXCEPTION 'sync invoked reconnect cancellation outside the finalizer';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
RESET ROLE;

SELECT pg_temp.assert_true(
  (
    SELECT auth_health='expired' AND status='connected' AND connection_generation=1
      FROM control_plane.connections
     WHERE tenant_id=:'connection_boundary_tenant_tenant_id'
       AND connection_id='01K70000000000000000000001'
  ),
  'the exact active lease may update only auth health at its current generation'
);

-- Once disconnected, even the still-live exact lease cannot reactivate health
-- or touch lifecycle state.
UPDATE control_plane.connections
   SET status='disconnected',disconnected_at=clock_timestamp()
 WHERE tenant_id=:'connection_boundary_tenant_tenant_id'
   AND connection_id='01K70000000000000000000001';
SET LOCAL ROLE albert_sync_control;
DO $$
BEGIN
  BEGIN
    PERFORM control_plane.record_connection_auth_health(
      current_setting('test.connection_boundary_tenant'),
      '01K70000000000000000000001',1,'xero','boundary-account-a',
      '01K70000000000000000000051','healthy',
      '01K70000000000000000000050','albert_sync_standard',88001,
      'worker-connection-boundary',1
    );
    RAISE EXCEPTION 'auth-health procedure reactivated a disconnected connection';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END;
$$;
RESET ROLE;
SELECT pg_temp.assert_true(
  (
    SELECT status='disconnected' AND auth_health='expired' AND connection_generation=1
      FROM control_plane.connections
     WHERE tenant_id=:'connection_boundary_tenant_tenant_id'
       AND connection_id='01K70000000000000000000001'
  ),
  'disconnect state must remain immutable to auth-health mutation'
);

ROLLBACK;
