\set ON_ERROR_STOP on

-- Durable work for the exact-login raw Storage runtime proof. This fixture is
-- intentionally committed: the three runtime-login psql sessions and the real
-- S3 proof must all observe the same queue leases and source authority.
BEGIN;

INSERT INTO control_plane.tenants(tenant_id,slug,display_name,status)
VALUES ('01JA0000000000000000000001','raw-storage-runtime','Raw Storage runtime','active');

INSERT INTO control_plane.connections(
  tenant_id,connection_id,connector_key,display_name,external_account_reference,
  status,auth_health,connection_generation
) VALUES
  ('01JA0000000000000000000001','01JA0000000000000000000002','deputy',
   'Raw Storage ingest','raw-storage-ingest','connected','healthy',1),
  ('01JA0000000000000000000001','01JA0000000000000000000003','deputy',
   'Raw Storage deletion','raw-storage-deletion','connected','healthy',1);

INSERT INTO control_plane.sync_runs(
  tenant_id,sync_run_id,connection_id,job_type,stream,status,attempt_number,
  scheduled_at,started_at,connection_generation
) VALUES (
  '01JA0000000000000000000001','01JA0000000000000000000004',
  '01JA0000000000000000000002','IncrementalSync','sales','running',1,
  clock_timestamp(),clock_timestamp(),1
);

SELECT send AS sync_message_id
  FROM pgmq.send(
    'albert_sync_standard',
    jsonb_build_object(
      'jobRequestId','01JA0000000000000000000005',
      'tenantId','01JA0000000000000000000001',
      'connectionId','01JA0000000000000000000002',
      'connectionGeneration',1,
      'syncRunId','01JA0000000000000000000004',
      'batchId','01JA0000000000000000000006',
      'stream','sales',
      'jobType','IncrementalSync',
      'requestedAt','2026-08-03T00:00:00.000Z'
    ),
    0
  ) \gset

INSERT INTO control_plane.sync_job_requests(
  tenant_id,job_request_id,connection_id,idempotency_key,job_type,priority,
  queue_name,queue_message_id,payload,status,available_at
) VALUES (
  '01JA0000000000000000000001','01JA0000000000000000000005',
  '01JA0000000000000000000002','raw-storage-runtime-sync-job',
  'IncrementalSync','standard','albert_sync_standard',:sync_message_id,
  jsonb_build_object(
    'jobRequestId','01JA0000000000000000000005',
    'tenantId','01JA0000000000000000000001',
    'connectionId','01JA0000000000000000000002',
    'connectionGeneration',1,
    'syncRunId','01JA0000000000000000000004',
    'batchId','01JA0000000000000000000006',
    'stream','sales',
    'jobType','IncrementalSync',
    'requestedAt','2026-08-03T00:00:00.000Z'
  ),
  'queued',clock_timestamp()
);

INSERT INTO control_plane.deputy_webhook_material(
  tenant_id,connection_id,material_id,verification_mode,key_id,iv,ciphertext,
  callback_url,setup_status,required_topics,provisioned_topics,provisioned_at
) VALUES (
  '01JA0000000000000000000001','01JA0000000000000000000002',
  '01JA0000000000000000000007','custom_header','raw-storage-runtime-v1',
  'AAAAAAAAAAAAAAAA',repeat('B',64),
  'https://hooks.albert.invalid/v1/webhooks/deputy/raw-storage-runtime',
  'active',ARRAY['sales'],ARRAY['sales'],clock_timestamp()
);

INSERT INTO control_plane.webhook_receipts(
  tenant_id,webhook_receipt_id,connection_id,connector_key,vendor_event_id,
  dedupe_key,body_sha256,signature_verified,status,received_at
) VALUES (
  '01JA0000000000000000000001','01JA0000000000000000000008',
  '01JA0000000000000000000002','deputy','raw-storage-runtime-event',
  'raw-storage-runtime-webhook',repeat('a',64),true,'received',
  '2026-08-03T00:00:00.000Z'
);

INSERT INTO control_plane.deletion_requests(
  tenant_id,deletion_request_id,connection_id,scope,status,
  remote_revocation_status,credential_destroyed_at,credential_destruction_due_at,
  purge_due_at,progress
) VALUES (
  '01JA0000000000000000000001','01JA0000000000000000000009',
  '01JA0000000000000000000003','connection','queued','not_applicable',
  clock_timestamp(),clock_timestamp(),clock_timestamp(),
  '{"credential_vault":{"verified":true}}'::jsonb
);
SELECT control_plane.enqueue_deletion_request('01JA0000000000000000000009');

COMMIT;
