\set ON_ERROR_STOP on

BEGIN;
SET LOCAL ROLE albert_webhook_control;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean,message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'webhook raw Storage runtime assertion failed: %',message;
  END IF;
END;
$$;

SELECT control_plane.assert_raw_storage_session_authority_ready('webhook');
SELECT grant_id AS raw_grant_id,tenant_id AS raw_tenant_id,
       connection_id AS raw_connection_id,object_key AS raw_object_key
  FROM control_plane.issue_raw_storage_webhook_session(
    '01JA0000000000000000000001','01JA0000000000000000000002',
    '01JA0000000000000000000008','01JA0000000000000000000007',
    NULL,NULL,NULL,
    :'webhook_user_id'::uuid,'42000000-0000-4000-8000-000000000001'::uuid,
    clock_timestamp()+interval '10 minutes'
  ) \gset

SELECT pg_temp.assert_true(
  :'raw_tenant_id'='01JA0000000000000000000001'
  AND :'raw_connection_id'='01JA0000000000000000000002'
  AND :'raw_object_key'='tenant/01JA0000000000000000000001/connection/01JA0000000000000000000002/stream/webhook_deputy/date/2026-08-03/batch-01JA0000000000000000000008.json.gz',
  'issuer must return the exact attested receipt scope'
);
SELECT pg_temp.assert_true(
  control_plane.revoke_raw_storage_webhook_session(
    '01JA0000000000000000000001','01JA0000000000000000000008',:'raw_grant_id'
  ),
  'first exact revoke must remove the grant'
);
SELECT pg_temp.assert_true(
  NOT control_plane.revoke_raw_storage_webhook_session(
    '01JA0000000000000000000001','01JA0000000000000000000008',:'raw_grant_id'
  ),
  'a second exact revoke must be idempotently false'
);

COMMIT;
