\set ON_ERROR_STOP on

BEGIN;
SET LOCAL ROLE albert_sync_control;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean,message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'sync raw Storage runtime assertion failed: %',message;
  END IF;
END;
$$;

SELECT control_plane.assert_raw_storage_session_authority_ready('sync');
CREATE OR REPLACE FUNCTION pg_temp.assert_null_expiry_rejected(p_auth_user_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    PERFORM 1 FROM control_plane.issue_raw_storage_sync_session(
      '01JA0000000000000000000000','raw-storage-runtime-sync',
      'tenant/01JA0000000000000000000001/connection/01JA0000000000000000000002/stream/sales/date/2026-08-03/batch-01JA0000000000000000000006.jsonl.gz',
      p_auth_user_id,'41000000-0000-4000-8000-000000000001'::uuid,NULL
    );
    RAISE EXCEPTION 'sync issuer accepted a NULL Auth-token expiry';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;
END;
$$;
SELECT pg_temp.assert_null_expiry_rejected(:'sync_user_id'::uuid);
SELECT message_id,read_count
  FROM control_plane.claim_sync_jobs(
    'albert_sync_standard','raw-storage-runtime-sync',900,1
  ) \gset

SELECT permit_id
  FROM control_plane.acquire_sync_write_permit(
    '01JA0000000000000000000001','01JA0000000000000000000002',1,
    '01JA0000000000000000000004','01JA0000000000000000000005',
    'albert_sync_standard',:message_id,'raw-storage-runtime-sync',
    :read_count::integer,600
  ) \gset

SELECT grant_id AS raw_grant_id,tenant_id AS raw_tenant_id,
       connection_id AS raw_connection_id,object_key AS raw_object_key,
       expires_at AS raw_expires_at
  FROM control_plane.issue_raw_storage_sync_session(
    :'permit_id','raw-storage-runtime-sync',
    'tenant/01JA0000000000000000000001/connection/01JA0000000000000000000002/stream/sales/date/2026-08-03/batch-01JA0000000000000000000006.jsonl.gz',
    :'sync_user_id'::uuid,'41000000-0000-4000-8000-000000000001'::uuid,
    clock_timestamp()+interval '10 minutes'
  ) \gset

SELECT pg_temp.assert_true(
  :'raw_tenant_id'='01JA0000000000000000000001'
  AND :'raw_connection_id'='01JA0000000000000000000002'
  AND :'raw_object_key'='tenant/01JA0000000000000000000001/connection/01JA0000000000000000000002/stream/sales/date/2026-08-03/batch-01JA0000000000000000000006.jsonl.gz',
  'issuer must return the exact claimed job scope'
);
SELECT pg_temp.assert_true(
  :'raw_expires_at'::timestamptz>clock_timestamp()+interval '5 seconds'
  AND :'raw_expires_at'::timestamptz<=clock_timestamp()+interval '5 minutes',
  'issuer must return a live deadline inside the five-minute cap'
);
SELECT pg_temp.assert_true(
  control_plane.revoke_raw_storage_sync_session(
    '01JA0000000000000000000001',:'permit_id',
    'raw-storage-runtime-sync',:'raw_grant_id'
  ),
  'first exact revoke must remove the grant'
);
SELECT pg_temp.assert_true(
  NOT control_plane.revoke_raw_storage_sync_session(
    '01JA0000000000000000000001',:'permit_id',
    'raw-storage-runtime-sync',:'raw_grant_id'
  ),
  'a second exact revoke must be idempotently false'
);

COMMIT;
