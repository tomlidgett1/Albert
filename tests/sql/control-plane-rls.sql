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
SELECT * FROM public.bootstrap_albert_tenant('Ignored Retry Name','Australia/Perth') \gset tenant_one_retry_
SELECT pg_temp.assert_true(
  :'tenant_one_retry_tenant_id'=:'tenant_one_tenant_id'
  AND :'tenant_one_retry_tenant_name'=:'tenant_one_tenant_name'
  AND :'tenant_one_retry_timezone'=:'tenant_one_timezone',
  'repeated first-user bootstrap must return the original tenant without mutation'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=1
     FROM control_plane.memberships
    WHERE user_id='10000000-0000-4000-8000-000000000001'
      AND status='active'),
  'idempotent bootstrap must create one active first-owner membership'
);

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
  (:'tenant_one_tenant_id','01K1ZZZZZZ0000000000000001','lightspeed-r','One POS','connected','healthy',
   '10000000-0000-4000-8000-000000000001'),
  (:'tenant_two_tenant_id','01K1ZZZZZZ0000000000000002','xero','Two Xero','connected','healthy',
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
  NOT has_table_privilege('authenticated','control_plane.memberships','INSERT')
  AND NOT has_table_privilege('authenticated','control_plane.memberships','UPDATE')
  AND NOT has_table_privilege('authenticated','control_plane.memberships','DELETE')
  AND NOT has_table_privilege('authenticated','control_plane.connections','INSERT')
  AND NOT has_table_privilege('authenticated','control_plane.connections','UPDATE')
  AND NOT has_table_privilege('authenticated','control_plane.connections','DELETE')
  AND NOT has_table_privilege('authenticated','control_plane.user_active_tenants','SELECT')
  AND NOT has_table_privilege('authenticated','control_plane.user_active_tenants','INSERT'),
  'membership, connection, and active-tenant writes must be mediated by guarded RPCs'
);
SELECT * FROM public.albert_create_organisation('Albert RLS One Branch','Australia/Melbourne') \gset tenant_branch_
SELECT pg_temp.assert_true(
  (SELECT tenant_id=:'tenant_branch_tenant_id' FROM public.current_albert_context()),
  'new organisations must become active immediately without trusting a browser tenant id'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=2 FROM jsonb_array_elements(public.albert_list_organisations())),
  'a user must be able to enumerate only their own organisation memberships'
);
SELECT public.albert_select_organisation(:'tenant_one_tenant_id');
SELECT pg_temp.assert_true(
  (SELECT tenant_id=:'tenant_one_tenant_id' FROM public.current_albert_context()),
  'a persisted active organisation selection must scope subsequent requests'
);
SELECT public.albert_add_organisation_member(
  :'tenant_one_tenant_id','owner-two@albert.invalid','manager'
);
SELECT pg_temp.assert_true(
  jsonb_array_length(public.albert_organisation_settings()->'members')=2,
  'an owner must be able to activate an existing confirmed Albert user'
);
DO $$
BEGIN
  BEGIN
    PERFORM public.albert_update_organisation_member(
      control_plane.require_current_tenant_id(),
      '10000000-0000-4000-8000-000000000001','manager','active'
    );
    RAISE EXCEPTION 'last owner was unexpectedly demoted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END;
$$;
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
  NOT public.albert_operator_status(),
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
  NOT has_table_privilege('service_role','control_plane.catalogue_documents','SELECT')
  AND NOT has_table_privilege('service_role','control_plane.catalogue_documents','INSERT')
  AND NOT has_table_privilege('service_role','control_plane.catalogue_documents','UPDATE')
  AND NOT has_table_privilege('service_role','control_plane.catalogue_documents','DELETE'),
  'the legacy platform service role must not bypass Albert runtime isolation'
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
  AND NOT has_function_privilege('service_role','control_plane.acquire_sync_write_permit(text,text,bigint,text,text,text,bigint,text,integer,integer)','EXECUTE')
  AND NOT has_function_privilege('service_role','control_plane.assert_sync_write_permit_and_issue_capability(text,text)','EXECUTE')
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
     WHERE actor_user_id = '10000000-0000-4000-8000-000000000001';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    immutable_blocked := true;
  END;
  IF NOT immutable_blocked THEN
    RAISE EXCEPTION 'control-plane assertion failed: audit rows must be immutable';
  END IF;
END;
$$;

ROLLBACK;

-- Deterministic two-session bootstrap race proof. The winner connection holds
-- the exact production per-user xact lock before the contender is dispatched,
-- so the contender cannot pass the membership recheck until the winner's
-- tenant is committed. This avoids relying on scheduler timing or pg_sleep.
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean, message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'control-plane concurrency assertion failed: %', message;
  END IF;
END;
$$;

INSERT INTO auth.users (
  id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) VALUES (
  '30000000-0000-4000-8000-000000000003','authenticated','authenticated',
  'bootstrap-race@albert.invalid','',now(),'{}','{}',now(),now()
);

CREATE TEMP TABLE bootstrap_concurrency_winner (
  tenant_id text,
  tenant_name text,
  tenant_slug text,
  role text,
  timezone text
);
CREATE TEMP TABLE bootstrap_concurrency_contender (
  tenant_id text,
  tenant_name text,
  tenant_slug text,
  role text,
  timezone text
);

-- This harness runs only against CI's disposable local Supabase database,
-- whose postgres test credential is fixed by .github/workflows/ci.yml. Connect
-- to the server's bridge address rather than its loopback address: Supabase's
-- loopback pg_hba rule does not consume a password, and PostgreSQL 17 correctly
-- rejects password-less dblink connections from its protected postgres role.
SELECT extensions.dblink_connect(
  'albert_bootstrap_winner',
  format(
    'hostaddr=%s port=%s dbname=%L user=postgres password=postgres',
    host(inet_server_addr()),
    current_setting('port'),
    current_database()
  )
);
SELECT extensions.dblink_connect(
  'albert_bootstrap_contender',
  format(
    'hostaddr=%s port=%s dbname=%L user=postgres password=postgres',
    host(inet_server_addr()),
    current_setting('port'),
    current_database()
  )
);

SELECT extensions.dblink_exec('albert_bootstrap_winner','BEGIN');
SELECT extensions.dblink_exec('albert_bootstrap_winner','SET LOCAL ROLE authenticated');
SELECT *
FROM extensions.dblink(
  'albert_bootstrap_winner',
  $remote$
    SELECT set_config(
             'request.jwt.claim.sub',
             '30000000-0000-4000-8000-000000000003',
             true
           ),
           set_config(
             'request.jwt.claims',
             '{"sub":"30000000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{}}',
             true
           )
  $remote$
) AS configured(subject text,claims text);
SELECT *
FROM extensions.dblink(
  'albert_bootstrap_winner',
  $remote$
    SELECT true
    FROM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'albert:tenant-bootstrap:'||'30000000-0000-4000-8000-000000000003'::uuid::text,
        0
      )
    )
  $remote$
) AS locked(acquired boolean);

SELECT extensions.dblink_exec('albert_bootstrap_contender','BEGIN');
SELECT extensions.dblink_exec('albert_bootstrap_contender','SET LOCAL ROLE authenticated');
SELECT *
FROM extensions.dblink(
  'albert_bootstrap_contender',
  $remote$
    SELECT set_config(
             'request.jwt.claim.sub',
             '30000000-0000-4000-8000-000000000003',
             true
           ),
           set_config(
             'request.jwt.claims',
             '{"sub":"30000000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{}}',
             true
           )
  $remote$
) AS configured(subject text,claims text);
SELECT pg_temp.assert_true(
  extensions.dblink_send_query(
    'albert_bootstrap_contender',
    $remote$
      SELECT tenant_id,tenant_name,tenant_slug,role,timezone
      FROM public.bootstrap_albert_tenant('Contender Organisation','Australia/Perth')
    $remote$
  )=1,
  'the competing bootstrap query must be accepted asynchronously'
);
SELECT pg_temp.assert_true(
  extensions.dblink_is_busy('albert_bootstrap_contender')=1,
  'the contender must remain outstanding while the per-user lock is held'
);

INSERT INTO bootstrap_concurrency_winner
SELECT *
FROM extensions.dblink(
  'albert_bootstrap_winner',
  $remote$
    SELECT tenant_id,tenant_name,tenant_slug,role,timezone
    FROM public.bootstrap_albert_tenant('Winning Organisation','Australia/Sydney')
  $remote$
) AS result(tenant_id text,tenant_name text,tenant_slug text,role text,timezone text);
SELECT extensions.dblink_exec('albert_bootstrap_winner','COMMIT');

INSERT INTO bootstrap_concurrency_contender
SELECT *
FROM extensions.dblink_get_result('albert_bootstrap_contender')
  AS result(tenant_id text,tenant_name text,tenant_slug text,role text,timezone text);
SELECT pg_temp.assert_true(
  (SELECT count(*)=0
     FROM extensions.dblink_get_result('albert_bootstrap_contender')
       AS drained(tenant_id text,tenant_name text,tenant_slug text,role text,timezone text)),
  'the asynchronous contender result must be fully drained before reuse'
);
SELECT extensions.dblink_exec('albert_bootstrap_contender','COMMIT');

SELECT pg_temp.assert_true(
  (SELECT winner.tenant_id=contender.tenant_id
          AND winner.tenant_name=contender.tenant_name
          AND winner.tenant_slug=contender.tenant_slug
          AND winner.timezone=contender.timezone
     FROM bootstrap_concurrency_winner AS winner
     CROSS JOIN bootstrap_concurrency_contender AS contender),
  'both concurrent bootstrap calls must return the winner tenant unchanged'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=1
     FROM control_plane.memberships
    WHERE user_id='30000000-0000-4000-8000-000000000003'
      AND role='owner'
      AND status='active'),
  'concurrent bootstrap must create exactly one active owner membership'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=1
     FROM control_plane.audit_log
    WHERE actor_user_id='30000000-0000-4000-8000-000000000003'
      AND action='tenant.bootstrap'),
  'concurrent bootstrap must emit exactly one bootstrap audit event'
);

SELECT extensions.dblink_disconnect('albert_bootstrap_winner');
SELECT extensions.dblink_disconnect('albert_bootstrap_contender');

-- Remove committed concurrency fixtures through the migration-owner-only
-- append-only retention seam so later SQL harnesses still start from a clean DB.
BEGIN;
SET LOCAL ROLE albert_control_migration_owner;
SET LOCAL albert.deletion_authorized='on';
DELETE FROM control_plane.audit_log
WHERE actor_user_id='30000000-0000-4000-8000-000000000003';
DELETE FROM control_plane.tenants
WHERE created_by='30000000-0000-4000-8000-000000000003';
COMMIT;
DELETE FROM auth.users
WHERE id='30000000-0000-4000-8000-000000000003';
