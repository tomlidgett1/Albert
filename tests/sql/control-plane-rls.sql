\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean, message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'control-plane assertion failed: %', message;
  END IF;
END;
$$;

INSERT INTO auth.users (
  id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) VALUES
  ('10000000-0000-4000-8000-000000000001','authenticated','authenticated',
   'owner-one@albert.invalid','',now(),'{}','{}',now(),now()),
  ('20000000-0000-4000-8000-000000000002','authenticated','authenticated',
   'owner-two@albert.invalid','',now(),'{}','{}',now(),now());

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{}}',
  true
);
SELECT * FROM public.bootstrap_albert_tenant('Albert RLS One','Australia/Sydney') \gset tenant_one_

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000002',true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{}}',
  true
);
SELECT * FROM public.bootstrap_albert_tenant('Albert RLS Two','Australia/Sydney') \gset tenant_two_

RESET ROLE;
INSERT INTO control_plane.connections (
  tenant_id,connection_id,connector_key,display_name,status,auth_health,authorised_by
) VALUES
  (:'tenant_one_tenant_id','01K1ZZZZZZ0000000000000001','lightspeed-r','One POS','active','healthy',
   '10000000-0000-4000-8000-000000000001'),
  (:'tenant_two_tenant_id','01K1ZZZZZZ0000000000000002','xero','Two Xero','active','healthy',
   '20000000-0000-4000-8000-000000000002');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
SELECT set_config(
  'request.jwt.claims',
  format(
    '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"active_tenant_id":"%s"}}',
    :'tenant_one_tenant_id'
  ),
  true
);

SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM control_plane.tenants),
  'an authenticated owner must see exactly their active tenant'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM control_plane.connections),
  'connection RLS must hide every other tenant'
);
SELECT pg_temp.assert_true(
  (SELECT bool_and(tenant_id = :'tenant_one_tenant_id') FROM control_plane.connections),
  'the visible connection must belong to the trusted tenant'
);
SELECT pg_temp.assert_true(
  (SELECT tenant_id = :'tenant_one_tenant_id' FROM public.current_albert_context()),
  'current context must derive tenant scope from auth claims and membership'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege('authenticated','control_plane.oauth_token_refs','SELECT'),
  'browser role must not read token references'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege('authenticated','control_plane.oauth_secret_envelopes','SELECT'),
  'browser role must not read encrypted credential envelopes'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege('authenticated','control_plane.xero_webhook_inbox','SELECT')
  AND NOT has_table_privilege('authenticated','control_plane.xero_webhook_connection_sequences','SELECT')
  AND NOT has_function_privilege(
    'authenticated',
    'control_plane.accept_xero_webhook_inbox(text,text,text,bytea,bytea,bytea,integer,integer,integer,integer,timestamptz,timestamptz,timestamptz)',
    'EXECUTE'
  ),
  'browser role must not access the encrypted Xero inbox or sequence controls'
);
SELECT pg_temp.assert_true(
  NOT has_schema_privilege('authenticated','pgmq','USAGE'),
  'browser role must not access durable queues'
);
SELECT pg_temp.assert_true(
  NOT has_schema_privilege('authenticated','cron','USAGE'),
  'browser role must not access schedules'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege('authenticated','control_plane.catalogue_documents','SELECT'),
  'browser role must not bypass the semantic service to read catalogue vectors'
);
SELECT pg_temp.assert_true(
  has_function_privilege('authenticated','public.albert_model_context(text,integer)','EXECUTE'),
  'authenticated conversations require the bounded tenant-scoped model-context RPC'
);
SELECT pg_temp.assert_true(
  (SELECT NOT internal_operator FROM public.albert_operator_status()),
  'ordinary tenant members must not receive operator access'
);

RESET ROLE;
SELECT pg_temp.assert_true(
  (SELECT NOT public FROM storage.buckets WHERE id='raw-payloads'),
  'raw payload storage must remain private'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 3 FROM cron.job WHERE jobname IN (
    'albert-incremental-sync-scheduler',
    'albert-nightly-reconciliation',
    'albert-oauth-session-expiry'
  )),
  'all durable production schedules must be installed exactly once'
);
SELECT pg_temp.assert_true(
  EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector'),
  'pgvector must be enabled for governed catalogue discovery'
);
SELECT pg_temp.assert_true(
  has_table_privilege('service_role','control_plane.catalogue_documents','SELECT')
  AND NOT has_table_privilege('service_role','control_plane.catalogue_documents','INSERT')
  AND NOT has_table_privilege('service_role','control_plane.catalogue_documents','UPDATE')
  AND NOT has_table_privilege('service_role','control_plane.catalogue_documents','DELETE'),
  'semantic runtime may read but never mutate immutable catalogue documents'
);
SELECT pg_temp.assert_true(
  has_table_privilege('albert_semantic_control','control_plane.catalogue_documents','SELECT')
  AND has_table_privilege('albert_semantic_control','control_plane.tenant_overlays','SELECT')
  AND NOT has_table_privilege('albert_semantic_control','control_plane.oauth_token_refs','SELECT')
  AND NOT has_table_privilege('albert_semantic_control','control_plane.oauth_secret_envelopes','SELECT'),
  'semantic runtime role must never be able to read OAuth credentials'
);
SELECT pg_temp.assert_true(
  (SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb
   FROM pg_roles WHERE rolname='albert_semantic_control'),
  'semantic control role must remain constrained and subject to RLS'
);

SELECT pg_temp.assert_true(
  (SELECT NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls
          AND NOT rolcreaterole AND NOT rolcreatedb
   FROM pg_roles WHERE rolname='albert_deletion_control'),
  'deletion control must be a constrained NOLOGIN group role'
);
SELECT pg_temp.assert_true(
  has_schema_privilege('albert_deletion_control','control_plane','USAGE')
  AND NOT has_schema_privilege('albert_deletion_control','pgmq','USAGE')
  AND NOT pg_has_role('albert_deletion_control','service_role','MEMBER'),
  'deletion control must not inherit service_role or direct queue access'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege('albert_deletion_control','control_plane.oauth_token_refs','SELECT')
  AND NOT has_table_privilege('albert_deletion_control','control_plane.oauth_secret_envelopes','SELECT')
  AND NOT has_table_privilege('albert_deletion_control','control_plane.oauth_session_secret_envelopes','SELECT')
  AND NOT has_table_privilege('albert_deletion_control','control_plane.deletion_requests','SELECT')
  AND NOT has_table_privilege('albert_deletion_control','control_plane.tenants','SELECT')
  AND NOT has_table_privilege('albert_deletion_control','control_plane.connections','SELECT')
  AND NOT has_table_privilege('albert_deletion_control','control_plane.conversations','SELECT'),
  'deletion control must have no direct credential, tenant, or conversation reads'
);
SELECT pg_temp.assert_true(
  has_function_privilege('albert_deletion_control','control_plane.claim_deletion_jobs(text,integer,integer)','EXECUTE')
  AND has_function_privilege('albert_deletion_control','control_plane.deletion_revocation_context(bigint,text,text,integer)','EXECUTE')
  AND has_function_privilege('albert_deletion_control','control_plane.read_deletion_credential(bigint,text,text,integer,text)','EXECUTE')
  AND has_function_privilege('albert_deletion_control','control_plane.rotate_deletion_credential(bigint,text,text,integer,text,integer,text,bytea,bytea,bytea,bytea,text,text,text,text[],timestamptz)','EXECUTE')
  AND has_function_privilege('albert_deletion_control','control_plane.destroy_one_deletion_credential(bigint,text,text,integer,text)','EXECUTE')
  AND has_function_privilege('albert_deletion_control','control_plane.verify_deletion_credentials(bigint,text,text,integer)','EXECUTE')
  AND has_function_privilege('albert_deletion_control','control_plane.destroy_claimed_deletion_credentials(bigint,text,text,integer,jsonb)','EXECUTE')
  AND has_function_privilege('albert_deletion_control','control_plane.assert_claimed_deletion_quiescent(bigint,text,text,integer)','EXECUTE')
  AND has_function_privilege('albert_deletion_control','control_plane.verify_claimed_control_deletion(bigint,text,text,integer)','EXECUTE')
  AND has_function_privilege('albert_deletion_control','control_plane.complete_deletion_job(bigint,text,text,integer,text,text,text,jsonb,jsonb,text,text)','EXECUTE')
  AND has_function_privilege('albert_deletion_control','control_plane.heartbeat_worker(text,text,text,timestamptz,integer,jsonb)','EXECUTE')
  AND NOT has_function_privilege('albert_deletion_control','control_plane.destroy_deletion_credentials(text,jsonb)','EXECUTE')
  AND NOT has_function_privilege('albert_deletion_control','control_plane.assert_deletion_quiescent(text)','EXECUTE')
  AND NOT has_function_privilege('albert_deletion_control','control_plane.verify_control_deletion(text)','EXECUTE')
  AND NOT has_function_privilege('albert_deletion_control','control_plane.claim_sync_jobs(text,text,integer,integer)','EXECUTE')
  AND NOT has_function_privilege('albert_deletion_control','control_plane.enqueue_due_deletions(timestamptz)','EXECUTE'),
  'deletion control must receive only its fenced lifecycle surface'
);
SELECT pg_temp.assert_true(
  NOT has_function_privilege('service_role','control_plane.enqueue_deletion_request(text)','EXECUTE')
  AND NOT has_function_privilege('service_role','control_plane.acquire_sync_write_permit(text,text,text,text,integer)','EXECUTE')
  AND NOT has_function_privilege('service_role','control_plane.release_sync_write_permit(text,text,text)','EXECUTE')
  AND NOT has_function_privilege('service_role','control_plane.claim_deletion_jobs(text,integer,integer)','EXECUTE')
  AND NOT has_function_privilege('service_role','control_plane.complete_deletion_job(bigint,text,text,integer,text,text,text,jsonb,jsonb,text,text)','EXECUTE'),
  'service_role must not enqueue, fence, claim, or execute deletion'
);

SET LOCAL ROLE albert_deletion_control;
DO $$
BEGIN
  BEGIN
    PERFORM 1 FROM control_plane.oauth_token_refs LIMIT 1;
    RAISE EXCEPTION 'deletion role unexpectedly read OAuth token references';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM control_plane.oauth_secret_envelopes LIMIT 1;
    RAISE EXCEPTION 'deletion role unexpectedly read OAuth envelopes';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM control_plane.tenants LIMIT 1;
    RAISE EXCEPTION 'deletion role unexpectedly read tenant rows';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
RESET ROLE;

SET LOCAL ROLE albert_semantic_control;
SELECT set_config('albert.tenant_id',:'tenant_one_tenant_id',true);
SELECT pg_temp.assert_true(
  (SELECT count(*)=1 AND bool_and(tenant_id=:'tenant_one_tenant_id')
   FROM control_plane.tenant_overlays),
  'semantic runtime RLS must restrict overlays to trusted tenant scope'
);
RESET ROLE;

DO $$
DECLARE
  immutable_blocked boolean := false;
BEGIN
  BEGIN
    UPDATE control_plane.audit_log
       SET audit_metadata = '{"tampered":true}'::jsonb
     WHERE tenant_id = (
       SELECT tenant_id
       FROM control_plane.memberships
       WHERE user_id = '10000000-0000-4000-8000-000000000001'
     );
  EXCEPTION WHEN SQLSTATE '55000' THEN
    immutable_blocked := true;
  END;
  IF NOT immutable_blocked THEN
    RAISE EXCEPTION 'control-plane assertion failed: audit rows must be immutable';
  END IF;
END;
$$;

ROLLBACK;
