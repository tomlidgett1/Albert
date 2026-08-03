\set ON_ERROR_STOP on

-- Proves approve -> suspended membership -> reload/status -> terminal proof,
-- while refusing an unintended replacement-tenant bootstrap. All fixtures are
-- transaction-local and rolled back.
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean, message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'tenant deletion receipt assertion failed: %', message;
  END IF;
END;
$$;

INSERT INTO auth.users (
  id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) VALUES
  (
    '5d000000-0000-4000-8000-000000000001','authenticated','authenticated',
    'deletion-receipt-owner@albert.invalid','',now(),'{}','{}',now(),now()
  ),
  (
    '5d000000-0000-4000-8000-000000000002','authenticated','authenticated',
    'deletion-receipt-other@albert.invalid','',now(),'{}','{}',now(),now()
  );

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','5d000000-0000-4000-8000-000000000001',true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"5d000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{}}',
  true
);
SELECT * FROM public.bootstrap_albert_tenant(
  'Receipt Bicycle Co','Australia/Melbourne'
) \gset receipt_tenant_
SELECT * FROM public.albert_request_tenant_deletion(
  :'receipt_tenant_tenant_id','DELETE Receipt Bicycle Co'
) \gset receipt_request_
SELECT * FROM public.albert_approve_tenant_deletion(
  :'receipt_tenant_tenant_id',:'receipt_request_deletion_request_id',
  'ERASE Receipt Bicycle Co'
) \gset receipt_approved_

SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM public.current_albert_context()),
  'approved deletion must remove active tenant context'
);
SELECT pg_temp.assert_true(
  (public.current_albert_tenant_deletion_receipt()->>'deletionRequestId')
    = :'receipt_request_deletion_request_id',
  'requester must reload the durable receipt without active membership'
);
SELECT pg_temp.assert_true(
  (public.current_albert_tenant_deletion_receipt()->>'status') = 'queued',
  'receipt must mirror the approved durable queue state'
);

DO $$
DECLARE before_count bigint; after_count bigint;
BEGIN
  SELECT count(*) INTO before_count
  FROM control_plane.tenants
  WHERE created_by='5d000000-0000-4000-8000-000000000001'::uuid;
  BEGIN
    PERFORM * FROM public.bootstrap_albert_tenant(
      'Unintended replacement','Australia/Melbourne'
    );
    RAISE EXCEPTION 'bootstrap unexpectedly succeeded during tenant deletion';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.albert_create_organisation(
      'Direct bypass replacement','Australia/Melbourne'
    );
    RAISE EXCEPTION 'explicit organisation creation bypassed active deletion';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
  SELECT count(*) INTO after_count
  FROM control_plane.tenants
  WHERE created_by='5d000000-0000-4000-8000-000000000001'::uuid;
  IF after_count <> before_count THEN
    RAISE EXCEPTION 'bootstrap created a replacement tenant during deletion';
  END IF;
END;
$$;
RESET ROLE;

-- The worker's fixed completion routine is the only production writer. This
-- privileged fixture inserts the same privacy-safe proof row to exercise the
-- proof-completion trigger without bypassing the public read boundary.
SET LOCAL ROLE albert_control_migration_owner;
UPDATE control_plane.deletion_requests
SET progress=progress||jsonb_build_object(
  'remote_revocation',jsonb_build_object(
    'attemptedAt','2026-08-04T00:00:00.000Z',
    'priorStatus','pending','targetCount',0,'targets','[]'::jsonb,'bestEffort',true
  )
)
WHERE deletion_request_id=:'receipt_request_deletion_request_id';

DO $$
DECLARE request_id text;
BEGIN
  SELECT deletion_request_id INTO STRICT request_id
  FROM control_plane.deletion_requests
  WHERE requested_by='5d000000-0000-4000-8000-000000000001'::uuid
    AND scope='tenant';
  INSERT INTO control_plane.deletion_proofs (
    proof_id,deletion_request_id,scope,tenant_reference_hash,
    connection_reference_hash,requested_at,completed_at,remote_revocation,
    store_verification,proof_digest,worker_id,service_version
  ) VALUES (
    '01K80000000000000000000002',request_id,'tenant',
    repeat('c',64),NULL,clock_timestamp()-interval '1 second',
    clock_timestamp(),
    '{"attemptedAt":"2026-08-04T00:00:00.000Z","priorStatus":"pending","targetCount":0,"targets":[],"bestEffort":true}'::jsonb,
    '{"credential_vault":{"verified":true,"tokenReferences":0,"credentialEnvelopes":0,"sessionEnvelopes":0},"raw_storage":{"verified":true,"remainingObjects":0},"analytical":{"verified":true},"control_plane":{"verified":true,"remainingTenantOrConnectionRows":0,"remainingDerivedArtifacts":0,"remainingQueueMessages":0}}'::jsonb,
    repeat('e',64),'deletion-worker:test','a000000000000000000000000000000000000000'
  );
  RAISE EXCEPTION 'a synthetic analytical boolean entered the proof ledger';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

INSERT INTO control_plane.deletion_proofs (
  proof_id,deletion_request_id,scope,tenant_reference_hash,
  connection_reference_hash,requested_at,approved_at,completed_at,
  remote_revocation,store_verification,proof_digest,worker_id,service_version
) VALUES (
  '01K80000000000000000000001',:'receipt_request_deletion_request_id','tenant',
  repeat('a',64),NULL,clock_timestamp()-interval '2 minutes',
  clock_timestamp()-interval '1 minute',clock_timestamp(),
  jsonb_build_object(
    'attemptedAt','2026-08-04T00:00:00.000Z',
    'priorStatus','pending','targetCount',0,'targets','[]'::jsonb,'bestEffort',true
  ),
  jsonb_build_object(
    'credential_vault',jsonb_build_object(
      'verified',true,'tokenReferences',0,'credentialEnvelopes',0,'sessionEnvelopes',0
    ),
    'raw_storage',jsonb_build_object('verified',true,'remainingObjects',0),
    'analytical',jsonb_build_object(
      'verified',true,'scope','tenant','measurement','post_purge_row_counts_v1',
      'remainingRows',0,'residuals',jsonb_build_object(
        'stagingRows',0,'canonicalRows',0,'bridgeRows',0,'linkRows',0,
        'embeddingRows',0,'cacheRows',0,'otherAnalyticalRows',0
      )
    ),
    'control_plane',jsonb_build_object(
      'verified',true,'remainingTenantOrConnectionRows',0,
      'remainingDerivedArtifacts',0,'remainingQueueMessages',0
    )
  ),
  repeat('b',64),'deletion-worker:test','a000000000000000000000000000000000000000'
);
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','5d000000-0000-4000-8000-000000000001',true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"5d000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{}}',
  true
);
SELECT pg_temp.assert_true(
  (public.albert_tenant_deletion_receipt(:'receipt_request_deletion_request_id')->>'status')
    = 'completed',
  'immutable proof insertion must complete the user receipt'
);
SELECT pg_temp.assert_true(
  (public.albert_tenant_deletion_receipt(:'receipt_request_deletion_request_id')
    ->'proof'->>'proofId') = '01K80000000000000000000001',
  'requester must receive the terminal proof after membership suspension'
);
SELECT pg_temp.assert_true(
  public.albert_tenant_deletion_receipt(:'receipt_request_deletion_request_id')::text
    NOT LIKE '%'||:'receipt_tenant_tenant_id'||'%',
  'receipt response must not disclose the deleted tenant identifier'
);

-- Only after a terminal receipt may the user explicitly elect to create a new
-- organisation. The old proof remains retrievable by its user-bound request.
SELECT * FROM public.albert_create_organisation(
  'Explicit New Bicycle Co','Australia/Melbourne'
) \gset replacement_tenant_
SELECT pg_temp.assert_true(
  (SELECT tenant_id FROM public.current_albert_context())
    = :'replacement_tenant_tenant_id',
  'completed deletion must permit an explicit replacement organisation'
);
SELECT pg_temp.assert_true(
  (public.albert_tenant_deletion_receipt(:'receipt_request_deletion_request_id')
    ->'proof'->>'proofId') = '01K80000000000000000000001',
  'explicit replacement creation must not erase the prior receipt'
);

SELECT set_config('request.jwt.claim.sub','5d000000-0000-4000-8000-000000000002',true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"5d000000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{}}',
  true
);
SELECT pg_temp.assert_true(
  public.albert_tenant_deletion_receipt(:'receipt_request_deletion_request_id') IS NULL,
  'another authenticated user must not discover the receipt'
);
RESET ROLE;

SELECT pg_temp.assert_true(
  NOT has_table_privilege(
    'authenticated','control_plane.tenant_deletion_receipts','SELECT'
  ),
  'authenticated must have no direct receipt-table reads'
);
SELECT pg_temp.assert_true(
  has_function_privilege(
    'authenticated','public.albert_tenant_deletion_receipt(text)','EXECUTE'
  ) AND has_function_privilege(
    'authenticated','public.current_albert_tenant_deletion_receipt()','EXECUTE'
  ),
  'authenticated receipt reads must use only the fixed user-bound RPCs'
);
SELECT pg_temp.assert_true(
  NOT has_function_privilege(
    'anon','public.albert_tenant_deletion_receipt(text)','EXECUTE'
  ),
  'anonymous callers must not execute the receipt RPC'
);

ROLLBACK;
