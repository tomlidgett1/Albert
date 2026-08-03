\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean,message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'raw Storage authority assertion failed: %',message;
  END IF;
END;
$$;

SELECT auth_user_id AS sync_user_id
  FROM albert_bootstrap.raw_storage_machine_principal WHERE purpose='sync' \gset
SELECT auth_user_id AS webhook_user_id
  FROM albert_bootstrap.raw_storage_machine_principal WHERE purpose='webhook' \gset
SELECT auth_user_id AS deletion_user_id
  FROM albert_bootstrap.raw_storage_machine_principal WHERE purpose='deletion' \gset

SELECT pg_temp.assert_true(
  (SELECT count(*)=3 AND count(DISTINCT auth_user_id)=3 AND bool_and(active)
     FROM albert_bootstrap.raw_storage_machine_principal),
  'exactly three distinct active machine principals must be mapped'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege('authenticated','albert_bootstrap.raw_storage_machine_principal','SELECT')
  AND NOT has_table_privilege('service_role','albert_bootstrap.raw_storage_machine_principal','SELECT')
  AND NOT has_table_privilege('albert_control_migration_owner','albert_bootstrap.raw_storage_machine_principal','SELECT'),
  'the protected principal mapping must not be directly readable'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=6 FROM pg_policy
    WHERE polrelid='storage.objects'::regclass AND polname LIKE 'albert_raw_%')
  AND NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid='storage.objects'::regclass AND polname LIKE 'albert_raw_%'
       AND polcmd IN ('w','*')
  ),
  'the exact immutable/list/delete policy set must be installed'
);
SELECT pg_temp.assert_true(
  NOT has_function_privilege(
    'service_role','extensions.albert_raw_storage_sync_authorized(text,text)','EXECUTE'
  ) AND NOT has_function_privilege(
    'service_role','extensions.albert_raw_storage_webhook_authorized(text,text)','EXECUTE'
  ) AND NOT has_function_privilege(
    'service_role','extensions.albert_raw_storage_deletion_authorized(text,text)','EXECUTE'
  ) AND (
    SELECT bool_and(policy.polroles=ARRAY['authenticated'::regrole::oid])
      FROM pg_policy AS policy
     WHERE policy.polrelid='storage.objects'::regclass
       AND policy.polname LIKE 'albert_raw_%'
  ),
  'service_role must be excluded from every Albert raw policy/helper'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM pg_policy AS policy
     WHERE policy.polrelid='storage.objects'::regclass
       AND policy.polname LIKE 'albert_raw_%'
       AND replace(
         coalesce(pg_get_expr(policy.polqual,policy.polrelid),'')||
         coalesce(pg_get_expr(policy.polwithcheck,policy.polrelid),''),
         ' ','') ~ 'albert_raw_storage_machine_authorized\(''(sync|webhook|deletion)''\)ANDname~'
  ),
  'no old purpose-only customer-key policy branch may remain'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege('albert_sync_control','control_plane.raw_storage_sync_session_grants','SELECT')
  AND NOT has_table_privilege('albert_webhook_control','control_plane.raw_storage_webhook_session_grants','SELECT')
  AND NOT has_table_privilege('albert_deletion_control','control_plane.raw_storage_deletion_session_grants','SELECT'),
  'runtime roles must not receive direct session-grant table authority'
);

-- Two connections make foreign-scope leakage observable without relying on
-- unguessable identifiers.
INSERT INTO control_plane.tenants(tenant_id,slug,display_name,status)
VALUES ('01J90000000000000000000001','raw-authority-sql','Raw authority SQL','active');
INSERT INTO control_plane.connections(
  tenant_id,connection_id,connector_key,display_name,external_account_reference,
  status,auth_health,connection_generation
) VALUES
  ('01J90000000000000000000001','01J90000000000000000000002','deputy',
   'Raw target A','raw-target-a','connected','healthy',1),
  ('01J90000000000000000000001','01J90000000000000000000003','xero',
   'Raw target B','raw-target-b','connected','healthy',1);

INSERT INTO control_plane.deputy_webhook_material(
  tenant_id,connection_id,material_id,verification_mode,key_id,iv,ciphertext,
  callback_url,setup_status,required_topics,provisioned_at
) VALUES (
  '01J90000000000000000000001','01J90000000000000000000002',
  '01J90000000000000000000004','custom_header','raw-authority-v1',
  'AAAAAAAAAAAAAAAA',repeat('B',64),
  'https://hooks.albert.invalid/v1/webhooks/deputy/raw-authority',
  'active',ARRAY['employees'],clock_timestamp()
);

-- Two simultaneous sync permits share one Auth session but remain bound to
-- different exact immutable keys.
INSERT INTO control_plane.sync_runs(
  tenant_id,sync_run_id,connection_id,job_type,stream,status,attempt_number,
  scheduled_at,started_at,connection_generation
) VALUES
  ('01J90000000000000000000001','01J90000000000000000000005',
   '01J90000000000000000000002','IncrementalSync','employees','running',1,
   clock_timestamp(),clock_timestamp(),1),
  ('01J90000000000000000000001','01J90000000000000000000006',
   '01J90000000000000000000002','IncrementalSync','timesheets','running',1,
   clock_timestamp(),clock_timestamp(),1);
INSERT INTO control_plane.sync_job_requests(
  tenant_id,job_request_id,connection_id,idempotency_key,job_type,priority,
  queue_name,queue_message_id,payload,status,available_at,last_claimed_at
) VALUES
  ('01J90000000000000000000001','01J90000000000000000000007',
   '01J90000000000000000000002','raw-authority-sync-job-a','IncrementalSync','standard',
   'albert_sync_standard',7101,
   '{"tenantId":"01J90000000000000000000001","connectionId":"01J90000000000000000000002","syncRunId":"01J90000000000000000000005","batchId":"01J90000000000000000000008","stream":"employees","requestedAt":"2026-08-03T00:00:00.000Z"}',
   'running',clock_timestamp(),clock_timestamp()),
  ('01J90000000000000000000001','01J90000000000000000000009',
   '01J90000000000000000000002','raw-authority-sync-job-b','IncrementalSync','standard',
   'albert_sync_standard',7102,
   '{"tenantId":"01J90000000000000000000001","connectionId":"01J90000000000000000000002","syncRunId":"01J90000000000000000000006","batchId":"01J9000000000000000000000A","stream":"timesheets","requestedAt":"2026-08-03T00:00:00.000Z"}',
   'running',clock_timestamp(),clock_timestamp());
INSERT INTO control_plane.sync_job_attempts(
  tenant_id,job_attempt_id,job_request_id,attempt_number,worker_id,
  visibility_deadline,started_at
) VALUES
  ('01J90000000000000000000001','01J9000000000000000000000B',
   '01J90000000000000000000007',1,'raw-sync-worker',clock_timestamp()+interval '10 minutes',clock_timestamp()),
  ('01J90000000000000000000001','01J9000000000000000000000C',
   '01J90000000000000000000009',1,'raw-sync-worker',clock_timestamp()+interval '10 minutes',clock_timestamp());
INSERT INTO control_plane.sync_write_permits(
  tenant_id,permit_id,connection_id,connection_generation,sync_run_id,
  job_request_id,queue_name,message_id,read_count,worker_id,expires_at
) VALUES
  ('01J90000000000000000000001','01J9000000000000000000000D',
   '01J90000000000000000000002',1,'01J90000000000000000000005',
   '01J90000000000000000000007','albert_sync_standard',7101,1,
   'raw-sync-worker',clock_timestamp()+interval '10 minutes'),
  ('01J90000000000000000000001','01J9000000000000000000000E',
   '01J90000000000000000000002',1,'01J90000000000000000000006',
   '01J90000000000000000000009','albert_sync_standard',7102,1,
   'raw-sync-worker',clock_timestamp()+interval '10 minutes');

INSERT INTO control_plane.webhook_receipts(
  tenant_id,webhook_receipt_id,connection_id,connector_key,vendor_event_id,
  dedupe_key,body_sha256,signature_verified,status,received_at
) VALUES
  ('01J90000000000000000000001','01J9000000000000000000000F',
   '01J90000000000000000000002','deputy','event-a','raw-webhook-a',repeat('a',64),
   true,'received','2026-08-03T00:00:00Z'),
  ('01J90000000000000000000001','01J9000000000000000000000G',
   '01J90000000000000000000002','deputy','event-b','raw-webhook-b',repeat('b',64),
   true,'received','2026-08-03T00:00:00Z');

-- A separate connection deletion lease must not fence connection A's active
-- sync/webhook grants.
INSERT INTO control_plane.deletion_requests(
  tenant_id,deletion_request_id,connection_id,scope,status,
  remote_revocation_status,credential_destroyed_at,credential_destruction_due_at,
  purge_due_at,progress,queue_message_id,started_at
) VALUES (
  '01J90000000000000000000001','01J9000000000000000000000H',
  '01J90000000000000000000003','connection','running','not_applicable',
  clock_timestamp(),clock_timestamp(),clock_timestamp(),'{}',8101,clock_timestamp()
);
INSERT INTO control_plane.deletion_job_attempts(
  tenant_id,deletion_attempt_id,deletion_request_id,attempt_number,worker_id,
  visibility_deadline
) VALUES (
  '01J90000000000000000000001','01J9000000000000000000000J',
  '01J9000000000000000000000H',1,'raw-deletion-worker',
  clock_timestamp()+interval '10 minutes'
);

-- Seed customer objects as protected postgres. Policy tests below operate only
-- through authenticated machine JWTs.
INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES
  ('raw-payloads','tenant/01J90000000000000000000001/connection/01J90000000000000000000002/stream/employees/date/2026-08-03/batch-01J90000000000000000000008.jsonl.gz',:'sync_user_id'),
  ('raw-payloads','tenant/01J90000000000000000000001/connection/01J90000000000000000000002/stream/timesheets/date/2026-08-03/batch-01J9000000000000000000000A.jsonl.gz',:'sync_user_id'),
  ('raw-payloads','tenant/01J90000000000000000000001/connection/01J90000000000000000000002/stream/webhook_deputy/date/2026-08-03/batch-01J9000000000000000000000F.json.gz',:'webhook_user_id'),
  ('raw-payloads','tenant/01J90000000000000000000001/connection/01J90000000000000000000002/stream/webhook_deputy/date/2026-08-03/batch-01J9000000000000000000000G.json.gz',:'webhook_user_id'),
  ('raw-payloads','tenant/01J90000000000000000000001/connection/01J90000000000000000000003/stream/invoices/date/2026-08-03/batch-01J9000000000000000000000K.jsonl.gz',:'sync_user_id'),
  ('raw-payloads','tenant/01J90000000000000000000001/connection/01J90000000000000000000003/stream/webhook_xero/date/2026-08-03/batch-01J9000000000000000000000M.json.gz',:'webhook_user_id');

-- Purpose-only JWTs have sentinel-only ambient authority. There is no
-- customer-object visibility until the exact session grant exists.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'sync_user_id',true);
SELECT set_config('request.jwt.claims',jsonb_build_object(
  'sub',:'sync_user_id','role','authenticated',
  'session_id','10000000-0000-4000-8000-000000000001',
  'app_metadata',jsonb_build_object(
    'albert_machine_principal',true,'albert_raw_storage_purpose','sync'
  )
)::text,true);
SELECT pg_temp.assert_true(
  (SELECT count(*)=0 FROM storage.objects
    WHERE bucket_id='raw-payloads' AND name LIKE 'tenant/01J90000000000000000000001/%'),
  'sync purpose alone must reveal no customer key'
);
RESET ROLE;

INSERT INTO control_plane.raw_storage_sync_session_grants(
  tenant_id,grant_id,permit_id,worker_id,auth_user_id,auth_session_id,
  object_key,expires_at
) VALUES
  ('01J90000000000000000000001','01J9000000000000000000000N',
   '01J9000000000000000000000D','raw-sync-worker',:'sync_user_id',
   '10000000-0000-4000-8000-000000000001',
   'tenant/01J90000000000000000000001/connection/01J90000000000000000000002/stream/employees/date/2026-08-03/batch-01J90000000000000000000008.jsonl.gz',
   clock_timestamp()+interval '5 minutes'),
  ('01J90000000000000000000001','01J9000000000000000000000P',
   '01J9000000000000000000000E','raw-sync-worker',:'sync_user_id',
   '10000000-0000-4000-8000-000000000001',
   'tenant/01J90000000000000000000001/connection/01J90000000000000000000002/stream/timesheets/date/2026-08-03/batch-01J9000000000000000000000A.jsonl.gz',
   clock_timestamp()+interval '5 minutes');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'sync_user_id',true);
SELECT set_config('request.jwt.claims',jsonb_build_object(
  'sub',:'sync_user_id','role','authenticated',
  'session_id','10000000-0000-4000-8000-000000000001',
  'app_metadata',jsonb_build_object(
    'albert_machine_principal',true,'albert_raw_storage_purpose','sync'
  )
)::text,true);
SELECT pg_temp.assert_true(
  (SELECT count(*)=2 FROM storage.objects
    WHERE bucket_id='raw-payloads' AND name LIKE 'tenant/01J90000000000000000000001/%'),
  'parallel sync grants on one Auth session must reveal exactly two object keys'
);
RESET ROLE;
UPDATE control_plane.raw_storage_sync_session_grants SET revoked_at=clock_timestamp()
 WHERE grant_id='01J9000000000000000000000N';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'sync_user_id',true);
SELECT set_config('request.jwt.claims',jsonb_build_object(
  'sub',:'sync_user_id','role','authenticated',
  'session_id','10000000-0000-4000-8000-000000000001',
  'app_metadata',jsonb_build_object(
    'albert_machine_principal',true,'albert_raw_storage_purpose','sync'
  )
)::text,true);
SELECT pg_temp.assert_true(
  (SELECT count(*)=1 FROM storage.objects
    WHERE bucket_id='raw-payloads' AND name LIKE 'tenant/01J90000000000000000000001/%'
      AND name LIKE '%/stream/timesheets/%'),
  'revoking one parallel sync grant must not revoke its sibling'
);
SELECT set_config('request.jwt.claims',jsonb_build_object(
  'sub',:'sync_user_id','role','authenticated',
  'session_id','10000000-0000-4000-8000-000000000002',
  'app_metadata',jsonb_build_object(
    'albert_machine_principal',true,'albert_raw_storage_purpose','sync'
  )
)::text,true);
SELECT pg_temp.assert_true(
  (SELECT count(*)=0 FROM storage.objects
    WHERE bucket_id='raw-payloads' AND name LIKE 'tenant/01J90000000000000000000001/%'),
  'a different Auth session must not inherit another session grant'
);
RESET ROLE;
INSERT INTO control_plane.sync_job_attempts(
  tenant_id,job_attempt_id,job_request_id,attempt_number,worker_id,
  visibility_deadline,started_at
) VALUES (
  '01J90000000000000000000001','01J9000000000000000000000V',
  '01J90000000000000000000009',2,'raw-sync-worker-redelivery',
  clock_timestamp()+interval '10 minutes',clock_timestamp()
);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'sync_user_id',true);
SELECT set_config('request.jwt.claims',jsonb_build_object(
  'sub',:'sync_user_id','role','authenticated',
  'session_id','10000000-0000-4000-8000-000000000001',
  'app_metadata',jsonb_build_object(
    'albert_machine_principal',true,'albert_raw_storage_purpose','sync'
  )
)::text,true);
SELECT pg_temp.assert_true(
  (SELECT count(*)=0 FROM storage.objects
    WHERE bucket_id='raw-payloads' AND name LIKE 'tenant/01J90000000000000000000001/%'),
  'a superseded sync attempt must immediately close its still-unexpired grant'
);
RESET ROLE;

INSERT INTO control_plane.raw_storage_webhook_session_grants(
  tenant_id,grant_id,connection_id,webhook_receipt_id,connector_key,
  verification_reference,auth_user_id,auth_session_id,object_key,expires_at
) VALUES
  ('01J90000000000000000000001','01J9000000000000000000000Q',
   '01J90000000000000000000002','01J9000000000000000000000F','deputy',
   '01J90000000000000000000004',:'webhook_user_id',
   '20000000-0000-4000-8000-000000000001',
   'tenant/01J90000000000000000000001/connection/01J90000000000000000000002/stream/webhook_deputy/date/2026-08-03/batch-01J9000000000000000000000F.json.gz',
   clock_timestamp()+interval '2 minutes'),
  ('01J90000000000000000000001','01J9000000000000000000000R',
   '01J90000000000000000000002','01J9000000000000000000000G','deputy',
   '01J90000000000000000000004',:'webhook_user_id',
   '20000000-0000-4000-8000-000000000001',
   'tenant/01J90000000000000000000001/connection/01J90000000000000000000002/stream/webhook_deputy/date/2026-08-03/batch-01J9000000000000000000000G.json.gz',
   clock_timestamp()+interval '2 minutes');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'webhook_user_id',true);
SELECT set_config('request.jwt.claims',jsonb_build_object(
  'sub',:'webhook_user_id','role','authenticated',
  'session_id','20000000-0000-4000-8000-000000000001',
  'app_metadata',jsonb_build_object(
    'albert_machine_principal',true,'albert_raw_storage_purpose','webhook'
  )
)::text,true);
SELECT pg_temp.assert_true(
  (SELECT count(*)=2 FROM storage.objects
    WHERE bucket_id='raw-payloads' AND name LIKE 'tenant/01J90000000000000000000001/%'),
  'webhook receipt grants must reveal only their two exact objects'
);
RESET ROLE;
UPDATE control_plane.raw_storage_webhook_session_grants SET revoked_at=clock_timestamp()
 WHERE grant_id='01J9000000000000000000000Q';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'webhook_user_id',true);
SELECT set_config('request.jwt.claims',jsonb_build_object(
  'sub',:'webhook_user_id','role','authenticated',
  'session_id','20000000-0000-4000-8000-000000000001',
  'app_metadata',jsonb_build_object(
    'albert_machine_principal',true,'albert_raw_storage_purpose','webhook'
  )
)::text,true);
SELECT pg_temp.assert_true(
  (SELECT count(*)=1 FROM storage.objects
    WHERE bucket_id='raw-payloads' AND name LIKE '%batch-01J9000000000000000000000G.json.gz'),
  'revoking one webhook grant must preserve its concurrent sibling'
);
RESET ROLE;

-- Deletion has no ambient customer enumeration. A purge grant binds the exact
-- connection and active attempt; a verify grant cannot delete.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'deletion_user_id',true);
SELECT set_config('request.jwt.claims',jsonb_build_object(
  'sub',:'deletion_user_id','role','authenticated',
  'session_id','30000000-0000-4000-8000-000000000001',
  'app_metadata',jsonb_build_object(
    'albert_machine_principal',true,'albert_raw_storage_purpose','deletion'
  )
)::text,true);
SELECT pg_temp.assert_true(
  (SELECT count(*)=0 FROM storage.objects
    WHERE bucket_id='raw-payloads' AND name LIKE 'tenant/01J90000000000000000000001/%'),
  'deletion purpose alone must reveal no customer key'
);
RESET ROLE;
INSERT INTO control_plane.raw_storage_deletion_session_grants(
  tenant_id,grant_id,deletion_request_id,attempt_number,worker_id,message_id,
  auth_user_id,auth_session_id,operation,scope,connection_id,expires_at
) VALUES (
  '01J90000000000000000000001','01J9000000000000000000000S',
  '01J9000000000000000000000H',1,'raw-deletion-worker',8101,
  :'deletion_user_id','30000000-0000-4000-8000-000000000001',
  'purge','connection','01J90000000000000000000003',clock_timestamp()+interval '5 minutes'
);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'deletion_user_id',true);
SELECT set_config('request.jwt.claims',jsonb_build_object(
  'sub',:'deletion_user_id','role','authenticated',
  'session_id','30000000-0000-4000-8000-000000000001',
  'app_metadata',jsonb_build_object(
    'albert_machine_principal',true,'albert_raw_storage_purpose','deletion'
  )
)::text,true);
SELECT pg_temp.assert_true(
  (SELECT count(*)=2 FROM storage.objects
    WHERE bucket_id='raw-payloads' AND name LIKE 'tenant/01J90000000000000000000001/%'
      AND name LIKE '%/connection/01J90000000000000000000003/%'),
  'purge grant must enumerate only its exact deletion connection'
);
SELECT pg_temp.assert_true(
  extensions.albert_raw_storage_deletion_authorized(
    'tenant/01J90000000000000000000001/connection/01J90000000000000000000003/stream/invoices/date/2026-08-03/batch-01J9000000000000000000000K.jsonl.gz',
    'delete'
  ),
  'purge grant must permit deletion inside its exact scope'
);
SELECT set_config('request.jwt.claims',jsonb_build_object(
  'sub',:'deletion_user_id','role','authenticated',
  'session_id','30000000-0000-4000-8000-000000000002',
  'app_metadata',jsonb_build_object(
    'albert_machine_principal',true,'albert_raw_storage_purpose','deletion'
  )
)::text,true);
SELECT pg_temp.assert_true(
  (SELECT count(*)=0 FROM storage.objects
    WHERE bucket_id='raw-payloads' AND name LIKE 'tenant/01J90000000000000000000001/%'),
  'another deletion Auth session must not inherit the active purge grant'
);
RESET ROLE;
UPDATE control_plane.raw_storage_deletion_session_grants SET revoked_at=clock_timestamp()
 WHERE grant_id='01J9000000000000000000000S';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'deletion_user_id',true);
SELECT set_config('request.jwt.claims',jsonb_build_object(
  'sub',:'deletion_user_id','role','authenticated',
  'session_id','30000000-0000-4000-8000-000000000001',
  'app_metadata',jsonb_build_object(
    'albert_machine_principal',true,'albert_raw_storage_purpose','deletion'
  )
)::text,true);
SELECT pg_temp.assert_true(
  (SELECT count(*)=0 FROM storage.objects
    WHERE bucket_id='raw-payloads' AND name LIKE 'tenant/01J90000000000000000000001/%'),
  'revoked deletion grant must close immediately'
);
RESET ROLE;

UPDATE control_plane.deletion_requests SET status='verifying'
 WHERE deletion_request_id='01J9000000000000000000000H';
INSERT INTO control_plane.raw_storage_deletion_session_grants(
  tenant_id,grant_id,deletion_request_id,attempt_number,worker_id,message_id,
  auth_user_id,auth_session_id,operation,scope,connection_id,expires_at
) VALUES (
  '01J90000000000000000000001','01J9000000000000000000000T',
  '01J9000000000000000000000H',1,'raw-deletion-worker',8101,
  :'deletion_user_id','30000000-0000-4000-8000-000000000001',
  'verify','connection','01J90000000000000000000003',clock_timestamp()+interval '5 minutes'
);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'deletion_user_id',true);
SELECT set_config('request.jwt.claims',jsonb_build_object(
  'sub',:'deletion_user_id','role','authenticated',
  'session_id','30000000-0000-4000-8000-000000000001',
  'app_metadata',jsonb_build_object(
    'albert_machine_principal',true,'albert_raw_storage_purpose','deletion'
  )
)::text,true);
SELECT pg_temp.assert_true(
  extensions.albert_raw_storage_deletion_authorized(
    'tenant/01J90000000000000000000001/connection/01J90000000000000000000003/stream/invoices/date/2026-08-03/batch-01J9000000000000000000000K.jsonl.gz',
    'select'
  ) AND NOT extensions.albert_raw_storage_deletion_authorized(
    'tenant/01J90000000000000000000001/connection/01J90000000000000000000003/stream/invoices/date/2026-08-03/batch-01J9000000000000000000000K.jsonl.gz',
    'delete'
  ),
  'verification grants must be read-only'
);
RESET ROLE;
INSERT INTO control_plane.deletion_job_attempts(
  tenant_id,deletion_attempt_id,deletion_request_id,attempt_number,worker_id,
  visibility_deadline
) VALUES (
  '01J90000000000000000000001','01J9000000000000000000000W',
  '01J9000000000000000000000H',2,'raw-deletion-worker-redelivery',
  clock_timestamp()+interval '10 minutes'
);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'deletion_user_id',true);
SELECT set_config('request.jwt.claims',jsonb_build_object(
  'sub',:'deletion_user_id','role','authenticated',
  'session_id','30000000-0000-4000-8000-000000000001',
  'app_metadata',jsonb_build_object(
    'albert_machine_principal',true,'albert_raw_storage_purpose','deletion'
  )
)::text,true);
SELECT pg_temp.assert_true(
  (SELECT count(*)=0 FROM storage.objects
    WHERE bucket_id='raw-payloads' AND name LIKE 'tenant/01J90000000000000000000001/%'),
  'a superseded deletion attempt must immediately close its still-unexpired grant'
);
RESET ROLE;

ROLLBACK;
