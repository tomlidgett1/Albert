\set ON_ERROR_STOP on

BEGIN;
SET LOCAL ROLE albert_deletion_control;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean,message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'deletion raw Storage runtime assertion failed: %',message;
  END IF;
END;
$$;

SELECT control_plane.assert_raw_storage_session_authority_ready('deletion');
CREATE OR REPLACE FUNCTION pg_temp.assert_null_expiry_rejected(p_auth_user_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    PERFORM 1 FROM control_plane.issue_raw_storage_deletion_session(
      1,'01JA0000000000000000000009','raw-storage-runtime-deletion',1,'purge',
      p_auth_user_id,'43000000-0000-4000-8000-000000000001'::uuid,NULL
    );
    RAISE EXCEPTION 'deletion issuer accepted a NULL Auth-token expiry';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;
END;
$$;
SELECT pg_temp.assert_null_expiry_rejected(:'deletion_user_id'::uuid);
SELECT message_id,read_count
  FROM control_plane.claim_deletion_jobs('raw-storage-runtime-deletion',900,1) \gset

SELECT grant_id AS raw_grant_id,tenant_id AS raw_tenant_id,
       scope AS raw_scope,connection_id AS raw_connection_id,
       operation AS raw_operation,expires_at AS raw_expires_at
  FROM control_plane.issue_raw_storage_deletion_session(
    :message_id,'01JA0000000000000000000009','raw-storage-runtime-deletion',
    :read_count::integer,'purge',
    :'deletion_user_id'::uuid,'43000000-0000-4000-8000-000000000001'::uuid,
    clock_timestamp()+interval '10 minutes'
  ) \gset

SELECT pg_temp.assert_true(
  :'raw_tenant_id'='01JA0000000000000000000001'
  AND :'raw_scope'='connection'
  AND :'raw_connection_id'='01JA0000000000000000000003'
  AND :'raw_operation'='purge',
  'issuer must return the exact active deletion scope and stage'
);
SELECT pg_temp.assert_true(
  :'raw_expires_at'::timestamptz>clock_timestamp()+interval '5 seconds'
  AND :'raw_expires_at'::timestamptz<=clock_timestamp()+interval '5 minutes',
  'issuer must return a live deadline inside the five-minute cap'
);
SELECT pg_temp.assert_true(
  control_plane.revoke_raw_storage_deletion_session(
    :message_id,'01JA0000000000000000000009','raw-storage-runtime-deletion',
    :read_count::integer,:'raw_grant_id'
  ),
  'first exact revoke must remove the grant'
);
SELECT pg_temp.assert_true(
  NOT control_plane.revoke_raw_storage_deletion_session(
    :message_id,'01JA0000000000000000000009','raw-storage-runtime-deletion',
    :read_count::integer,:'raw_grant_id'
  ),
  'a second exact revoke must be idempotently false'
);

COMMIT;
