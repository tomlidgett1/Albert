\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean, message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'tenant deletion concurrency assertion failed: %', message;
  END IF;
END;
$$;

INSERT INTO auth.users (
  id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) VALUES (
  '5d000000-0000-4000-8000-000000000003','authenticated','authenticated',
  'deletion-concurrency-owner@albert.invalid','',now(),'{}','{}',now(),now()
);

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','5d000000-0000-4000-8000-000000000003',true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"5d000000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{}}',
  true
);
SELECT * FROM public.bootstrap_albert_tenant(
  'Deletion Race Original','Australia/Melbourne'
) \gset deletion_race_original_
SELECT * FROM public.albert_create_organisation(
  'Deletion Race Alternate','Australia/Melbourne'
) \gset deletion_race_alternate_
SELECT public.albert_select_organisation(:'deletion_race_original_tenant_id');
COMMIT;

-- Keep an expected create failure inside the remote transaction so dblink can
-- return the SQLSTATE without weakening psql's global ON_ERROR_STOP behavior.
CREATE OR REPLACE FUNCTION public.albert_test_create_during_deletion()
RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM * FROM public.albert_create_organisation(
    'Unintended Concurrent Replacement','Australia/Melbourne'
  );
  RETURN 'created';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END;
$$;
REVOKE ALL ON FUNCTION public.albert_test_create_during_deletion() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_test_create_during_deletion() TO authenticated;

SELECT extensions.dblink_connect(
  'albert_deletion_request_winner',
  format(
    'host=supabase_db_albert-ci port=%s dbname=%L user=postgres password=postgres require_auth=scram-sha-256',
    current_setting('port'), current_database()
  )
);
SELECT extensions.dblink_connect(
  'albert_deletion_create_contender',
  format(
    'host=supabase_db_albert-ci port=%s dbname=%L user=postgres password=postgres require_auth=scram-sha-256',
    current_setting('port'), current_database()
  )
);

SELECT extensions.dblink_exec('albert_deletion_request_winner','BEGIN');
SELECT extensions.dblink_exec('albert_deletion_request_winner','SET LOCAL ROLE authenticated');
SELECT * FROM extensions.dblink(
  'albert_deletion_request_winner',
  format(
    $remote$
      SELECT set_config('request.jwt.claim.sub','5d000000-0000-4000-8000-000000000003',true),
             set_config('request.jwt.claims',%L,true)
    $remote$,
    format(
      '{"sub":"5d000000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"active_tenant_id":"%s"}}',
      :'deletion_race_original_tenant_id'
    )
  )
) AS configured(subject text,claims text);
SELECT * FROM extensions.dblink(
  'albert_deletion_request_winner',
  format($remote$
    SELECT * FROM public.albert_request_tenant_deletion(
      %L,'DELETE Deletion Race Original'
    )
  $remote$,
  :'deletion_race_original_tenant_id')
) AS requested(
  deletion_request_id text,status text,approval_expires_at timestamptz
) \gset deletion_race_request_

SELECT extensions.dblink_exec('albert_deletion_create_contender','BEGIN');
SELECT extensions.dblink_exec('albert_deletion_create_contender','SET LOCAL ROLE authenticated');
SELECT * FROM extensions.dblink(
  'albert_deletion_create_contender',
  format(
    $remote$
      SELECT set_config('request.jwt.claim.sub','5d000000-0000-4000-8000-000000000003',true),
             set_config('request.jwt.claims',%L,true)
    $remote$,
    format(
      '{"sub":"5d000000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"active_tenant_id":"%s"}}',
      :'deletion_race_original_tenant_id'
    )
  )
) AS configured(subject text,claims text);
SELECT pg_temp.assert_true(
  extensions.dblink_send_query(
    'albert_deletion_create_contender',
    'SELECT public.albert_test_create_during_deletion()'
  )=1,
  'the competing organisation create must be dispatched asynchronously'
);
SELECT pg_temp.assert_true(
  extensions.dblink_is_busy('albert_deletion_create_contender')=1,
  'organisation creation must wait on the requester user lock'
);

SELECT extensions.dblink_exec('albert_deletion_request_winner','COMMIT');
SELECT pg_temp.assert_true(
  (SELECT outcome='55000'
   FROM extensions.dblink_get_result('albert_deletion_create_contender')
     AS result(outcome text)),
  'the contender must recheck the committed receipt and fail closed'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=0
   FROM extensions.dblink_get_result('albert_deletion_create_contender')
     AS drained(outcome text)),
  'the asynchronous create result must be fully drained'
);
SELECT extensions.dblink_exec('albert_deletion_create_contender','COMMIT');
SELECT extensions.dblink_disconnect('albert_deletion_request_winner');
SELECT extensions.dblink_disconnect('albert_deletion_create_contender');

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','5d000000-0000-4000-8000-000000000003',true);
SELECT set_config(
  'request.jwt.claims',
  format(
    '{"sub":"5d000000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"active_tenant_id":"%s"}}',
    :'deletion_race_original_tenant_id'
  ),
  true
);
SELECT * FROM public.albert_approve_tenant_deletion(
  :'deletion_race_original_tenant_id',
  :'deletion_race_request_deletion_request_id','ERASE Deletion Race Original'
) \gset deletion_race_approved_
SELECT pg_temp.assert_true(
  (public.current_albert_session_state()->>'needsBootstrap')::boolean=false,
  'a queued receipt must never look like a new account'
);
SELECT pg_temp.assert_true(
  public.current_albert_session_state()->'context'='null'::jsonb,
  'queued deletion must dominate another active organisation context'
);
SELECT pg_temp.assert_true(
  public.current_albert_session_state()->'deletionReceipt'->>'status'='queued',
  'the same atomic session snapshot must expose the queued receipt'
);
COMMIT;

DROP FUNCTION public.albert_test_create_during_deletion();

-- Remove only this committed test fixture through the reviewed maintenance
-- authority; production deletion remains worker-owned.
BEGIN;
SET LOCAL ROLE albert_control_migration_owner;
SET LOCAL albert.deletion_authorized='on';
SELECT pgmq.delete('albert_deletion',queue_message_id)
FROM control_plane.deletion_requests
WHERE deletion_request_id=:'deletion_race_request_deletion_request_id'
  AND queue_message_id IS NOT NULL;
DELETE FROM control_plane.audit_log
WHERE tenant_id IN (
  :'deletion_race_original_tenant_id', :'deletion_race_alternate_tenant_id'
);
DELETE FROM control_plane.deletion_requests
WHERE deletion_request_id=:'deletion_race_request_deletion_request_id';
DELETE FROM control_plane.tenant_deletion_receipts
WHERE deletion_request_id=:'deletion_race_request_deletion_request_id';
DELETE FROM control_plane.tenants
WHERE tenant_id IN (
  :'deletion_race_original_tenant_id', :'deletion_race_alternate_tenant_id'
);
COMMIT;

DELETE FROM auth.users
WHERE id='5d000000-0000-4000-8000-000000000003';
