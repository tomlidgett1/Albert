\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean,message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'disconnect-durability assertion failed: %',message;
  END IF;
END;
$$;

INSERT INTO auth.users(
  id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) VALUES (
  '50000000-0000-4000-8000-000000000005','authenticated','authenticated',
  'disconnect-owner@albert.invalid','',now(),'{}','{}',now(),now()
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','50000000-0000-4000-8000-000000000005',true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"50000000-0000-4000-8000-000000000005","role":"authenticated","app_metadata":{}}',
  true
);
SELECT * FROM public.bootstrap_albert_tenant(
  'Disconnect durability tenant','Australia/Melbourne'
) \gset disconnect_tenant_
RESET ROLE;

INSERT INTO control_plane.connections(
  tenant_id,connection_id,connector_key,display_name,status,auth_health,authorised_by
) VALUES (
  :'disconnect_tenant_tenant_id','01K30000000000000000000001','xero',
  'Disconnect Xero','disconnected','revoked',
  '50000000-0000-4000-8000-000000000005'
);

INSERT INTO control_plane.oauth_token_refs(
  tenant_id,token_ref_id,connection_id,secret_reference,encryption_key_version,
  granted_scopes,token_expires_at
) VALUES (
  :'disconnect_tenant_tenant_id','01K30000000000000000000002',
  '01K30000000000000000000001','disconnect-durability-secret','kek-v1',
  ARRAY['accounting.transactions.read'],now()+interval '1 hour'
);

INSERT INTO control_plane.oauth_secret_envelopes(
  tenant_id,oauth_secret_envelope_id,token_ref_id,credential_version,
  algorithm,ciphertext,nonce,authentication_tag,wrapped_data_key,
  key_reference,key_version,aad_digest
) VALUES (
  :'disconnect_tenant_tenant_id','01K30000000000000000000003',
  '01K30000000000000000000002',1,'AES-256-GCM',decode('01','hex'),
  decode(repeat('02',12),'hex'),decode(repeat('03',16),'hex'),
  decode('04','hex'),'test-kek','kek-v1',repeat('a',64)
);

INSERT INTO control_plane.deletion_requests(
  tenant_id,deletion_request_id,connection_id,scope,status,requested_by,
  remote_revocation_status,credential_destroyed_at,
  credential_destruction_due_at,purge_due_at,progress
) VALUES (
  :'disconnect_tenant_tenant_id','01K30000000000000000000004',
  '01K30000000000000000000001','connection','queued',
  '50000000-0000-4000-8000-000000000005','pending',null,
  clock_timestamp()-interval '1 second',clock_timestamp(),
  '{"disconnect_intent":{"durable":true}}'::jsonb
);

SELECT pg_temp.assert_true(
  control_plane.force_overdue_deletion_credential_destruction(clock_timestamp())=1,
  'the watchdog must cover an overdue connection-level request'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM control_plane.oauth_token_refs
     WHERE tenant_id=:'disconnect_tenant_tenant_id'
       AND connection_id='01K30000000000000000000001'
  ),
  'the local token reference must be cryptographically destroyed'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM control_plane.oauth_secret_envelopes
     WHERE tenant_id=:'disconnect_tenant_tenant_id'
       AND token_ref_id='01K30000000000000000000002'
  ),
  'the encrypted token envelope and wrapped key must be destroyed'
);
SELECT pg_temp.assert_true(
  (
    SELECT credential_destroyed_at IS NOT NULL
       AND remote_revocation_status='failed'
       AND progress#>>'{remote_revocation,forcedLocalDestruction}'='true'
      FROM control_plane.deletion_requests
     WHERE tenant_id=:'disconnect_tenant_tenant_id'
       AND deletion_request_id='01K30000000000000000000004'
  ),
  'the durable request must retain truthful forced-destruction evidence'
);

-- The final authority boundary exposes one authenticated disconnect RPC and
-- one exact reconnect-cancellation capability. Generic table and queue powers
-- must not be inherited by either browser or sync identities.
SELECT pg_temp.assert_true(
  has_function_privilege(
    'authenticated','public.albert_disconnect_connection(text)','EXECUTE'
  )
  AND NOT has_function_privilege(
    'anon','public.albert_disconnect_connection(text)','EXECUTE'
  )
  AND NOT has_table_privilege(
    'authenticated','control_plane.connections','INSERT'
  )
  AND NOT has_table_privilege(
    'authenticated','control_plane.connections','UPDATE'
  )
  AND NOT has_table_privilege(
    'authenticated','control_plane.connections','DELETE'
  ),
  'authenticated connection mutations must be fixed-function only'
);
SELECT pg_temp.assert_true(
  NOT has_function_privilege(
    'albert_sync_control',
    'control_plane.cancel_reconnectable_connection_deletion(text,text,text)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'albert_sync_control',
    'control_plane.finalize_oauth_connection_identity(text,text,uuid,text,text,text,text,jsonb,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'albert_sync_control','control_plane.enqueue_deletion_request(text)','EXECUTE'
  )
  AND NOT has_table_privilege(
    'albert_sync_control','control_plane.deletion_requests','SELECT'
  )
  AND NOT has_table_privilege(
    'albert_sync_control','control_plane.deletion_requests','INSERT'
  )
  AND NOT has_table_privilege(
    'albert_sync_control','control_plane.deletion_requests','UPDATE'
  )
  AND NOT has_table_privilege(
    'albert_sync_control','control_plane.deletion_requests','DELETE'
  ),
  'sync must cancel reconnect deletion only through the OAuth-bound finalizer'
);

INSERT INTO auth.users(
  id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) VALUES
  ('50000000-0000-4000-8000-000000000006','authenticated','authenticated',
   'disconnect-manager@albert.invalid','',now(),'{}','{}',now(),now()),
  ('50000000-0000-4000-8000-000000000007','authenticated','authenticated',
   'disconnect-bookkeeper@albert.invalid','',now(),'{}','{}',now(),now()),
  ('50000000-0000-4000-8000-000000000008','authenticated','authenticated',
   'disconnect-foreign-owner@albert.invalid','',now(),'{}','{}',now(),now());

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','50000000-0000-4000-8000-000000000008',true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"50000000-0000-4000-8000-000000000008","role":"authenticated","app_metadata":{}}',
  true
);
SELECT * FROM public.bootstrap_albert_tenant(
  'Foreign disconnect tenant','Australia/Melbourne'
) \gset foreign_tenant_
RESET ROLE;

INSERT INTO control_plane.memberships(
  tenant_id,membership_id,user_id,role,status,created_by
) VALUES
  (:'disconnect_tenant_tenant_id','01K3000000000000000000000N',
   '50000000-0000-4000-8000-000000000006','manager','active',
   '50000000-0000-4000-8000-000000000005'),
  (:'disconnect_tenant_tenant_id','01K3000000000000000000000P',
   '50000000-0000-4000-8000-000000000007','bookkeeper','active',
   '50000000-0000-4000-8000-000000000005');

INSERT INTO control_plane.connections(
  tenant_id,connection_id,connector_key,display_name,external_account_reference,
  status,auth_health,authorised_by
) VALUES
  (:'disconnect_tenant_tenant_id','01K3000000000000000000000A','xero',
   'Owner Xero','owner-xero','connected','healthy',
   '50000000-0000-4000-8000-000000000005'),
  (:'disconnect_tenant_tenant_id','01K3000000000000000000000B','lightspeed-r',
   'Manager Lightspeed','manager-lightspeed','degraded','error',
   '50000000-0000-4000-8000-000000000006'),
  (:'disconnect_tenant_tenant_id','01K3000000000000000000000C','deputy',
   'Bookkeeper Deputy','bookkeeper-deputy','connected','healthy',
   '50000000-0000-4000-8000-000000000007'),
  (:'disconnect_tenant_tenant_id','01K3000000000000000000000D','xero',
   'Rollback Xero','rollback-xero','connected','healthy',
   '50000000-0000-4000-8000-000000000005'),
  (:'foreign_tenant_tenant_id','01K3000000000000000000000G','xero',
   'Foreign Xero','foreign-xero','connected','healthy',
   '50000000-0000-4000-8000-000000000008');

INSERT INTO control_plane.readiness(
  tenant_id,connection_id,domain,state,progress,backfill_complete
) VALUES (
  :'disconnect_tenant_tenant_id','01K3000000000000000000000A',
  'accounting','ready_complete',1,true
);

-- Even a valid owner cannot bypass the RPC with a direct connection write.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','50000000-0000-4000-8000-000000000005',true);
SELECT set_config(
  'request.jwt.claims',
  format(
    '{"sub":"50000000-0000-4000-8000-000000000005","role":"authenticated","app_metadata":{"active_tenant_id":"%s"}}',
    :'disconnect_tenant_tenant_id'
  ),true
);
DO $$
BEGIN
  BEGIN
    UPDATE control_plane.connections
       SET status='disconnected'
     WHERE connection_id='01K3000000000000000000000A';
    RAISE EXCEPTION 'authenticated owner directly mutated a connection';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
SELECT public.albert_disconnect_connection(
  '01K3000000000000000000000A'
) AS result \gset owner_disconnect_
SELECT public.albert_disconnect_connection(
  '01K3000000000000000000000A'
) AS result \gset owner_disconnect_retry_
RESET ROLE;

SELECT pg_temp.assert_true(
  (:'owner_disconnect_result'::jsonb->>'status')='queued'
  AND (:'owner_disconnect_result'::jsonb->>'deletionRequestId')=
      (:'owner_disconnect_retry_result'::jsonb->>'deletionRequestId'),
  'owner disconnect must queue once and retry idempotently'
);
SELECT pg_temp.assert_true(
  (
    SELECT connection.status='disconnected'
       AND connection.auth_health='revoked'
       AND connection.disconnected_at IS NOT NULL
      FROM control_plane.connections AS connection
     WHERE connection.tenant_id=:'disconnect_tenant_tenant_id'
       AND connection.connection_id='01K3000000000000000000000A'
  )
  AND (
    SELECT readiness.state='blocked'
       AND readiness.reason_code='connection_disconnected'
      FROM control_plane.readiness AS readiness
     WHERE readiness.tenant_id=:'disconnect_tenant_tenant_id'
       AND readiness.connection_id='01K3000000000000000000000A'
       AND readiness.domain='accounting'
  ),
  'disconnect must atomically fence connection and readiness state'
);
SELECT pg_temp.assert_true(
  (
    SELECT request.scope='connection'
       AND request.status='queued'
       AND request.requested_by='50000000-0000-4000-8000-000000000005'
       AND request.remote_revocation_status='pending'
       AND request.credential_destroyed_at IS NULL
       AND request.queue_message_id IS NOT NULL
      FROM control_plane.deletion_requests AS request
     WHERE request.tenant_id=:'disconnect_tenant_tenant_id'
       AND request.deletion_request_id=
           (:'owner_disconnect_result'::jsonb->>'deletionRequestId')
  )
  AND EXISTS (
    SELECT 1 FROM control_plane.audit_log AS audit
     WHERE audit.tenant_id=:'disconnect_tenant_tenant_id'
       AND audit.action='connection.disconnect_requested'
       AND audit.resource_id='01K3000000000000000000000A'
       AND audit.actor_user_id='50000000-0000-4000-8000-000000000005'
       AND audit.actor_type='user'
  ),
  'durable request and audit actor must be derived from auth.uid()'
);

-- Managers share the explicit lifecycle capability.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','50000000-0000-4000-8000-000000000006',true);
SELECT set_config(
  'request.jwt.claims',
  format(
    '{"sub":"50000000-0000-4000-8000-000000000006","role":"authenticated","app_metadata":{"active_tenant_id":"%s"}}',
    :'disconnect_tenant_tenant_id'
  ),true
);
SELECT public.albert_disconnect_connection(
  '01K3000000000000000000000B'
) AS result \gset manager_disconnect_
RESET ROLE;
SELECT pg_temp.assert_true(
  (:'manager_disconnect_result'::jsonb->>'status')='queued'
  AND EXISTS (
    SELECT 1 FROM control_plane.deletion_requests
     WHERE tenant_id=:'disconnect_tenant_tenant_id'
       AND deletion_request_id=
           (:'manager_disconnect_result'::jsonb->>'deletionRequestId')
       AND requested_by='50000000-0000-4000-8000-000000000006'
  ),
  'manager disconnect must queue with the authenticated manager as actor'
);

-- A bookkeeper and a manager presenting a connection from another tenant are
-- both rejected inside the definer, independent of request-body contents.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','50000000-0000-4000-8000-000000000007',true);
SELECT set_config(
  'request.jwt.claims',
  format(
    '{"sub":"50000000-0000-4000-8000-000000000007","role":"authenticated","app_metadata":{"active_tenant_id":"%s"}}',
    :'disconnect_tenant_tenant_id'
  ),true
);
DO $$
BEGIN
  BEGIN
    PERFORM public.albert_disconnect_connection('01K3000000000000000000000C');
    RAISE EXCEPTION 'bookkeeper disconnected a connection';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','50000000-0000-4000-8000-000000000006',true);
SELECT set_config(
  'request.jwt.claims',
  format(
    '{"sub":"50000000-0000-4000-8000-000000000006","role":"authenticated","app_metadata":{"active_tenant_id":"%s"}}',
    :'disconnect_tenant_tenant_id'
  ),true
);
DO $$
BEGIN
  BEGIN
    PERFORM public.albert_disconnect_connection('01K3000000000000000000000G');
    RAISE EXCEPTION 'manager disconnected a cross-tenant connection';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
END;
$$;
RESET ROLE;
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM control_plane.deletion_requests
     WHERE tenant_id=:'disconnect_tenant_tenant_id'
       AND connection_id='01K3000000000000000000000C'
  )
  AND NOT EXISTS (
    SELECT 1 FROM control_plane.deletion_requests
     WHERE tenant_id=:'foreign_tenant_tenant_id'
       AND connection_id='01K3000000000000000000000G'
  ),
  'rejected bookkeeper and cross-tenant attempts must leave no intent'
);

-- A compromised sync process cannot forge a tenant deletion row or publish an
-- arbitrary deletion job now that generic DML and enqueue have been revoked.
SELECT set_config(
  'albert.test_disconnect_tenant',:'disconnect_tenant_tenant_id',true
);
SELECT set_config(
  'albert.test_owner_deletion',
  :'owner_disconnect_result'::jsonb->>'deletionRequestId',true
);
SET LOCAL ROLE albert_sync_control;
DO $$
BEGIN
  BEGIN
    INSERT INTO control_plane.deletion_requests(
      tenant_id,deletion_request_id,connection_id,scope,status,requested_by,
      remote_revocation_status,credential_destroyed_at,
      credential_destruction_due_at,purge_due_at,progress
    ) VALUES (
      current_setting('albert.test_disconnect_tenant'),
      '01K3000000000000000000000Z',
      '01K3000000000000000000000C','connection','queued',
      '50000000-0000-4000-8000-000000000006','pending',NULL,
      now()+interval '15 minutes',now(),'{}'::jsonb
    );
    RAISE EXCEPTION 'sync forged a deletion request';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM control_plane.enqueue_deletion_request(
      current_setting('albert.test_owner_deletion')
    );
    RAISE EXCEPTION 'sync published an arbitrary deletion job';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
RESET ROLE;

-- Build two exact reconnect cases with intact token envelopes. The first has
-- never been claimed; the second has started and is therefore irreversible.
INSERT INTO control_plane.connections(
  tenant_id,connection_id,connector_key,display_name,external_account_reference,
  status,auth_health,authorised_by,disconnected_at
) VALUES
  (:'disconnect_tenant_tenant_id','01K3000000000000000000000E','xero',
   'Reconnectable Xero','reconnectable-xero','disconnected','revoked',
   '50000000-0000-4000-8000-000000000006',now()),
  (:'disconnect_tenant_tenant_id','01K3000000000000000000000F','xero',
   'Irreversible Xero','irreversible-xero','disconnected','revoked',
   '50000000-0000-4000-8000-000000000006',now());
INSERT INTO control_plane.oauth_token_refs(
  tenant_id,token_ref_id,connection_id,secret_reference,encryption_key_version,
  granted_scopes,token_expires_at
) VALUES
  (:'disconnect_tenant_tenant_id','01K3000000000000000000000V',
   '01K3000000000000000000000E','reconnectable-secret','kek-v1',
   ARRAY['accounting.transactions.read'],now()+interval '1 hour'),
  (:'disconnect_tenant_tenant_id','01K3000000000000000000000W',
   '01K3000000000000000000000F','irreversible-secret','kek-v1',
   ARRAY['accounting.transactions.read'],now()+interval '1 hour');
INSERT INTO control_plane.oauth_secret_envelopes(
  tenant_id,oauth_secret_envelope_id,token_ref_id,credential_version,
  algorithm,ciphertext,nonce,authentication_tag,wrapped_data_key,
  key_reference,key_version,aad_digest
) VALUES
  (:'disconnect_tenant_tenant_id','01K3000000000000000000000X',
   '01K3000000000000000000000V',1,'AES-256-GCM',decode('11','hex'),
   decode(repeat('12',12),'hex'),decode(repeat('13',16),'hex'),
   decode('14','hex'),'test-kek','kek-v1',repeat('b',64)),
  (:'disconnect_tenant_tenant_id','01K3000000000000000000000Y',
   '01K3000000000000000000000W',1,'AES-256-GCM',decode('21','hex'),
   decode(repeat('22',12),'hex'),decode(repeat('23',16),'hex'),
   decode('24','hex'),'test-kek','kek-v1',repeat('c',64));
INSERT INTO control_plane.oauth_sessions(
  tenant_id,oauth_session_id,initiated_by,provider,state_nonce_hash,
  pkce_verifier_secret_reference,redirect_uri,requested_scopes,status,
  selected_account_reference,expires_at
) VALUES
  (:'disconnect_tenant_tenant_id','01K3000000000000000000000S',
   '50000000-0000-4000-8000-000000000006','xero',repeat('d',64),
   'reconnectable-pkce',
   'https://albert.invalid/api/oauth/xero/callback',ARRAY['offline_access'],
   'exchanging','reconnectable-xero',now()+interval '1 hour'),
  (:'disconnect_tenant_tenant_id','01K3000000000000000000000T',
   '50000000-0000-4000-8000-000000000006','xero',repeat('e',64),
   'irreversible-pkce',
   'https://albert.invalid/api/oauth/xero/callback',ARRAY['offline_access'],
   'exchanging','irreversible-xero',now()+interval '1 hour');
INSERT INTO control_plane.oauth_session_secret_envelopes(
  tenant_id,oauth_session_secret_id,oauth_session_id,secret_reference,
  secret_kind,credential_version,algorithm,ciphertext,nonce,authentication_tag,
  wrapped_data_key,key_reference,key_version,aad_digest
) VALUES
  (:'disconnect_tenant_tenant_id','01K3000000000000000000000Z',
   '01K3000000000000000000000S','reconnectable-pkce','pkce_verifier',1,
   'AES-256-GCM',decode('31','hex'),decode(repeat('32',12),'hex'),
   decode(repeat('33',16),'hex'),decode('34','hex'),'test-kek','kek-v1',repeat('f',64)),
  (:'disconnect_tenant_tenant_id','01K30000000000000000000010',
   '01K3000000000000000000000T','irreversible-pkce','pkce_verifier',1,
   'AES-256-GCM',decode('41','hex'),decode(repeat('42',12),'hex'),
   decode(repeat('43',16),'hex'),decode('44','hex'),'test-kek','kek-v1',repeat('a',64)),
  (:'disconnect_tenant_tenant_id','01K30000000000000000000011',
   '01K3000000000000000000000S','reconnectable-exchanged','exchanged_credential',1,
   'AES-256-GCM',decode('51','hex'),decode(repeat('52',12),'hex'),
   decode(repeat('53',16),'hex'),decode('54','hex'),'test-kek','kek-v1',repeat('9',64)),
  (:'disconnect_tenant_tenant_id','01K30000000000000000000012',
   '01K3000000000000000000000T','irreversible-exchanged','exchanged_credential',1,
   'AES-256-GCM',decode('61','hex'),decode(repeat('62',12),'hex'),
   decode(repeat('63',16),'hex'),decode('64','hex'),'test-kek','kek-v1',repeat('8',64));
INSERT INTO control_plane.deletion_requests(
  tenant_id,deletion_request_id,connection_id,scope,status,requested_by,
  remote_revocation_status,credential_destroyed_at,
  credential_destruction_due_at,purge_due_at,progress,started_at
) VALUES
  (:'disconnect_tenant_tenant_id','01K3000000000000000000000Q',
   '01K3000000000000000000000E','connection','queued',
   '50000000-0000-4000-8000-000000000006','pending',NULL,
   now()+interval '15 minutes',now(),
   '{"disconnect_intent":{"durable":true}}'::jsonb,NULL),
  (:'disconnect_tenant_tenant_id','01K3000000000000000000000R',
   '01K3000000000000000000000F','connection','running',
   '50000000-0000-4000-8000-000000000006','pending',NULL,
   now()+interval '15 minutes',now(),
  '{"disconnect_intent":{"durable":true}}'::jsonb,now());

SELECT set_config(
  'albert.test_disconnect_tenant',:'disconnect_tenant_tenant_id',true
);
SET LOCAL ROLE albert_sync_control;
DO $$
BEGIN
  BEGIN
    PERFORM control_plane.cancel_reconnectable_connection_deletion(
      current_setting('albert.test_disconnect_tenant'),
      '01K3000000000000000000000E',
      '01K3000000000000000000000S'
    );
    RAISE EXCEPTION 'sync invoked reconnect cancellation outside OAuth finalization';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM * FROM control_plane.finalize_oauth_connection_identity(
      current_setting('albert.test_disconnect_tenant'),
      '01K3000000000000000000000T',
      '50000000-0000-4000-8000-000000000006'::uuid,
      'xero','irreversible-xero','01K3000000000000000000000F',
      'Irreversible Xero','{}'::jsonb,'irreversible-exchanged'
    );
    RAISE EXCEPTION 'reconnect cancelled an irreversible deletion';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END;
$$;
SELECT * FROM control_plane.finalize_oauth_connection_identity(
  :'disconnect_tenant_tenant_id','01K3000000000000000000000S',
  '50000000-0000-4000-8000-000000000006'::uuid,
  'xero','reconnectable-xero','01K3000000000000000000000E',
  'Reconnectable Xero','{}'::jsonb,'reconnectable-exchanged'
) \gset reconnect_
RESET ROLE;

SELECT pg_temp.assert_true(
  :'reconnect_connection_id'='01K3000000000000000000000E'
  AND :'reconnect_replayed'='f'
  AND (
    SELECT status='cancelled'
       AND tenant_id=:'disconnect_tenant_tenant_id'
       AND connection_id='01K3000000000000000000000E'
       AND scope='connection'
       AND requested_by='50000000-0000-4000-8000-000000000006'
       AND credential_destroyed_at IS NULL
       AND progress->>'reconnected'='true'
      FROM control_plane.deletion_requests
     WHERE deletion_request_id='01K3000000000000000000000Q'
  )
  AND (
    SELECT status='running' AND started_at IS NOT NULL
      FROM control_plane.deletion_requests
     WHERE deletion_request_id='01K3000000000000000000000R'
  ),
  'exact untouched reconnect cancellation must pass and irreversible deletion must remain'
);

-- Queue publication is part of the same database transaction. Replacing the
-- publisher with a throwing test double proves every fence and audit write is
-- rolled back when publication is unavailable; the outer ROLLBACK restores
-- the production function definition.
CREATE OR REPLACE FUNCTION control_plane.enqueue_deletion_request(
  p_deletion_request_id text
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $queue_failure$
BEGIN
  RAISE EXCEPTION 'test_queue_unavailable' USING ERRCODE='55000';
END;
$queue_failure$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','50000000-0000-4000-8000-000000000005',true);
SELECT set_config(
  'request.jwt.claims',
  format(
    '{"sub":"50000000-0000-4000-8000-000000000005","role":"authenticated","app_metadata":{"active_tenant_id":"%s"}}',
    :'disconnect_tenant_tenant_id'
  ),true
);
DO $$
BEGIN
  BEGIN
    PERFORM public.albert_disconnect_connection('01K3000000000000000000000D');
    RAISE EXCEPTION 'disconnect committed without queue publication';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END;
$$;
RESET ROLE;
SELECT pg_temp.assert_true(
  (
    SELECT status='connected' AND auth_health='healthy' AND disconnected_at IS NULL
      FROM control_plane.connections
     WHERE tenant_id=:'disconnect_tenant_tenant_id'
       AND connection_id='01K3000000000000000000000D'
  )
  AND NOT EXISTS (
    SELECT 1 FROM control_plane.deletion_requests
     WHERE tenant_id=:'disconnect_tenant_tenant_id'
       AND connection_id='01K3000000000000000000000D'
  )
  AND NOT EXISTS (
    SELECT 1 FROM control_plane.audit_log
     WHERE tenant_id=:'disconnect_tenant_tenant_id'
       AND resource_id='01K3000000000000000000000D'
       AND action='connection.disconnect_requested'
  ),
  'enqueue failure must roll back request, fence, and audit atomically'
);

ROLLBACK;
