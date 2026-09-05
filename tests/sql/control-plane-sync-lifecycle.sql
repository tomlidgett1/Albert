\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean,message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'sync-lifecycle assertion failed: %',message;
  END IF;
END;
$$;

INSERT INTO auth.users(
  id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) VALUES (
  '58000000-0000-4000-8000-000000000005','authenticated','authenticated',
  'sync-lifecycle-owner@albert.invalid','',now(),'{}','{}',now(),now()
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','58000000-0000-4000-8000-000000000005',true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"58000000-0000-4000-8000-000000000005","role":"authenticated","app_metadata":{}}',
  true
);
SELECT * FROM public.bootstrap_albert_tenant(
  'Sync lifecycle tenant','Australia/Melbourne'
) \gset lifecycle_tenant_
RESET ROLE;

SELECT set_config('test.lifecycle_tenant_id',:'lifecycle_tenant_tenant_id',true);
SELECT set_config('albert.tenant_id',:'lifecycle_tenant_tenant_id',true);

INSERT INTO control_plane.connections(
  tenant_id,connection_id,connector_key,display_name,external_account_reference,
  status,auth_health,authorised_by,connection_generation,ingestion_start_mode,
  ingestion_activated_at,ingestion_activated_by,ingestion_activated_generation
) VALUES (
  :'lifecycle_tenant_tenant_id','01K50000000000000000000001','xero',
  'Lifecycle Xero','xero-lifecycle-account','connected','healthy',
  '58000000-0000-4000-8000-000000000005',1,'manual',clock_timestamp(),
  '58000000-0000-4000-8000-000000000005',1
);

SELECT control_plane.register_sync_stream_phase(
  :'lifecycle_tenant_tenant_id','01K50000000000000000000001',1,
  'invoices','recent',1,'progressive','time_windowed',true,ARRAY['finance'],
  '2026-07-03T00:00:00Z','2026-08-03T00:00:00Z',null
);

SELECT * FROM control_plane.enqueue_sync_job(
  jsonb_build_object(
    'schemaVersion',1,'type','InitialBackfill',
    'tenantId',:'lifecycle_tenant_tenant_id',
    'connectionId','01K50000000000000000000001',
    'connectionGeneration',1,'connectorId','xero',
    'externalAccountReference','xero-lifecycle-account',
    'syncRunId','01K50000000000000000000002',
    'batchId','01K50000000000000000000003',
    'requestedAt','2026-08-03T00:00:00.000Z',
    'stream','invoices',
    'range',jsonb_build_object(
      'from','2026-07-03T00:00:00.000Z','to','2026-08-03T00:00:00.000Z'
    ),
    'phase','recent','replayVersion',1,'planMode','progressive'
  ),
  'backfill','backfill-phase:01K50000000000000000000001:g1:invoices:recent:v1',0
) \gset initial_request_

-- If a coordinator dies after queue publication but before linking the phase,
-- recovery reuses the exact phase idempotency key instead of double-fetching.
SELECT pg_temp.assert_true(
  control_plane.recover_sync_stream_phases(now()+interval '6 minutes',20)=1,
  'a published-but-unlinked phase must be recovered'
);
SELECT pg_temp.assert_true(
  (
    SELECT phase.last_job_request_id=:'initial_request_job_request_id'
       AND phase.status='queued'
       AND (
         SELECT count(*)=1 FROM control_plane.sync_job_requests request
          WHERE request.tenant_id=phase.tenant_id
            AND request.idempotency_key =
              'backfill-phase:01K50000000000000000000001:g1:invoices:recent:v1:g1'
       )
      FROM control_plane.sync_stream_phases phase
     WHERE phase.tenant_id=:'lifecycle_tenant_tenant_id'
       AND phase.connection_id='01K50000000000000000000001'
       AND phase.connection_generation=1
       AND phase.stream='invoices' AND phase.phase='recent'
  ),
  'crash recovery must link the existing request without duplicate publication'
);

SELECT pg_temp.assert_true(
  (
    SELECT payload->>'connectionGeneration'='1'
       AND idempotency_key LIKE '%:g1'
      FROM control_plane.sync_job_requests
     WHERE tenant_id=:'lifecycle_tenant_tenant_id'
       AND job_request_id=:'initial_request_job_request_id'
  ),
  'publication must be generation-fenced in both payload and idempotency identity'
);

-- Simulate terminal queue exhaustion. The durable phase remains discoverable
-- and recovery must issue a fresh replay identity instead of losing the stream.
UPDATE control_plane.sync_job_requests
   SET status='failed',completed_at=now(),last_error='{"code":"remote_unavailable"}'::jsonb
 WHERE tenant_id=:'lifecycle_tenant_tenant_id'
   AND job_request_id=:'initial_request_job_request_id';
UPDATE control_plane.sync_stream_phases
   SET status='failed',available_at=now()-interval '1 second',
       last_error='{"code":"remote_unavailable","retryable":true}'::jsonb
 WHERE tenant_id=:'lifecycle_tenant_tenant_id'
   AND connection_id='01K50000000000000000000001'
   AND connection_generation=1 AND stream='invoices' AND phase='recent';

SELECT pg_temp.assert_true(
  control_plane.recover_sync_stream_phases(now(),20)=1,
  'terminal phase failure must be reconstructed from its durable plan'
);
SELECT pg_temp.assert_true(
  (
    SELECT phase.status='queued' AND phase.replay_version=2
       AND phase.last_job_request_id<>:'initial_request_job_request_id'
       AND request.payload->>'connectionGeneration'='1'
       AND request.payload->>'replayVersion'='2'
       AND request.idempotency_key LIKE '%:v2:g1'
      FROM control_plane.sync_stream_phases phase
      JOIN control_plane.sync_job_requests request
        ON request.tenant_id=phase.tenant_id
       AND request.job_request_id=phase.last_job_request_id
     WHERE phase.tenant_id=:'lifecycle_tenant_tenant_id'
       AND phase.connection_id='01K50000000000000000000001'
       AND phase.connection_generation=1
       AND phase.stream='invoices' AND phase.phase='recent'
  ),
  'recovery must use a new run, batch, request and replay-versioned idempotency key'
);

-- A clean sibling stream cannot clear a failed required stream for the same
-- connection generation.
SELECT control_plane.register_sync_stream_phase(
  :'lifecycle_tenant_tenant_id','01K50000000000000000000001',1,
  'payments','recent',1,'single_pass','snapshot',true,ARRAY['finance'],
  '2026-07-03T00:00:00Z','2026-08-03T00:00:00Z',null
);
UPDATE control_plane.sync_stream_phases
   SET status='succeeded',completed_at=now(),coverage_boundary_kind='snapshot_at',
       coverage_lower_bound='2026-08-03T00:00:00Z',
       coverage_verification='point_in_time'
 WHERE tenant_id=:'lifecycle_tenant_tenant_id'
   AND connection_id='01K50000000000000000000001'
   AND connection_generation=1 AND stream='payments' AND phase='recent';
UPDATE control_plane.sync_stream_phases
   SET status='failed',available_at=now()+interval '10 days',
       last_error='{"code":"required_stream_failed"}'::jsonb
 WHERE tenant_id=:'lifecycle_tenant_tenant_id'
   AND connection_id='01K50000000000000000000001'
   AND connection_generation=1 AND stream='invoices' AND phase='recent';

INSERT INTO control_plane.stream_cursors(
  tenant_id,connection_id,stream,cursor_value,source_watermark,
  last_successful_sync_at,backfill_complete,connection_generation,
  coverage_boundary_kind,coverage_lower_bound,coverage_verification
) VALUES
  (:'lifecycle_tenant_tenant_id','01K50000000000000000000001','invoices',
   '{"value":"invoice-cursor"}'::jsonb,'2026-08-02T00:00:00Z',now(),false,1,
   null,null,null),
  (:'lifecycle_tenant_tenant_id','01K50000000000000000000001','payments',
   '{"value":"payment-cursor"}'::jsonb,'2026-08-03T00:00:00Z',now(),true,1,
   'snapshot_at','2026-08-03T00:00:00Z','point_in_time');

INSERT INTO control_plane.sync_runs(
  tenant_id,sync_run_id,connection_id,job_type,stream,status,attempt_number,
  scheduled_at,started_at,finished_at,connection_generation
) VALUES (
  :'lifecycle_tenant_tenant_id','01K50000000000000000000010',
  '01K50000000000000000000001','InitialBackfill','payments','succeeded',1,
  now(),now(),now(),1
);
INSERT INTO control_plane.raw_batch_manifests(
  tenant_id,batch_id,connection_id,sync_run_id,connector_key,connector_version,
  api_version,stream,extracted_at,content_hash,schema_fingerprint,record_count,
  compressed_bytes,object_keys
) VALUES (
  :'lifecycle_tenant_tenant_id','01K50000000000000000000011',
  '01K50000000000000000000001','01K50000000000000000000010','xero','1.0.0',
  '2.0','payments',now(),repeat('a',64),repeat('b',64),1,100,
  ARRAY['raw/lifecycle-payments.ndjson.gz']
);
INSERT INTO control_plane.raw_batch_landings(
  tenant_id,batch_id,status,staged_record_count,quarantine_count,analytical_committed_at
) VALUES (
  :'lifecycle_tenant_tenant_id','01K50000000000000000000011','landed',1,0,now()
);
INSERT INTO control_plane.canonical_transform_jobs(
  tenant_id,transform_job_id,batch_id,sync_run_id,connection_id,connector_id,
  connection_generation,stream,domains,mapping_version,backfill_complete,status,result_metadata,
  started_at,completed_at
) VALUES (
  :'lifecycle_tenant_tenant_id','01K50000000000000000000012',
  '01K50000000000000000000011','01K50000000000000000000010',
  '01K50000000000000000000001','xero',1,'payments',ARRAY['finance'],'v1',true,
  'succeeded','{"qualityStatus":"passed"}'::jsonb,now(),now()
);

SELECT pg_temp.assert_true(
  control_plane.sync_readiness_inputs(
    :'lifecycle_tenant_tenant_id','01K50000000000000000000001',
    ARRAY['payments','invoices'],'01K50000000000000000000011','passed'
  )->>'worstState'='blocked',
  'a passed sibling transform must not clear a failed required stream'
);

-- Optional vendor capabilities terminate as explicit evidence and are not
-- endlessly retried.
SELECT control_plane.register_sync_stream_phase(
  :'lifecycle_tenant_tenant_id','01K50000000000000000000001',1,
  'journals','recent',1,'single_pass','exhaustive_offset',false,ARRAY['finance'],
  '2026-07-03T00:00:00Z','2026-08-03T00:00:00Z',null
);
SELECT * FROM control_plane.enqueue_sync_job(
  jsonb_build_object(
    'type','InitialBackfill','tenantId',:'lifecycle_tenant_tenant_id',
    'connectionId','01K50000000000000000000001','connectionGeneration',1,
    'connectorId','xero','externalAccountReference','xero-lifecycle-account',
    'syncRunId','01K50000000000000000000020',
    'batchId','01K50000000000000000000021',
    'requestedAt','2026-08-03T00:00:00.000Z','stream','journals',
    'range',jsonb_build_object('from','2026-07-03T00:00:00.000Z','to','2026-08-03T00:00:00.000Z'),
    'phase','recent','replayVersion',1,'planMode','single_pass'
  ),'backfill','sync-lifecycle-journals-v1',0
) \gset optional_request_
SELECT control_plane.mark_sync_stream_phase_enqueued(
  :'lifecycle_tenant_tenant_id','01K50000000000000000000001',1,
  'journals','recent',1,:'optional_request_job_request_id'
);
SELECT control_plane.mark_sync_stream_phase_unavailable(
  :'lifecycle_tenant_tenant_id','01K50000000000000000000001',1,
  'journals','recent',1,
  '{"code":"capability_unavailable","retryable":false}'::jsonb
);
SELECT pg_temp.assert_true(
  (
    SELECT status='unavailable' AND completed_at IS NOT NULL
      FROM control_plane.sync_stream_phases
     WHERE tenant_id=:'lifecycle_tenant_tenant_id'
       AND connection_id='01K50000000000000000000001'
       AND connection_generation=1 AND stream='journals' AND phase='recent'
  ),
  'optional capability failure must be durable terminal evidence'
);

-- A reconnect advances the authorisation epoch. Old work may remain for audit
-- but cannot be published or recovered into the new generation.
UPDATE control_plane.connections SET connection_generation=2
 WHERE tenant_id=:'lifecycle_tenant_tenant_id'
   AND connection_id='01K50000000000000000000001';
SELECT pg_temp.assert_true(
  control_plane.recover_sync_stream_phases(now()+interval '20 days',20)=0,
  'recovery must ignore every prior-generation phase'
);
DO $$
BEGIN
  BEGIN
    PERFORM * FROM control_plane.enqueue_sync_job(
      jsonb_build_object(
        'type','IncrementalSync',
        'tenantId',current_setting('test.lifecycle_tenant_id'),
        'connectionId','01K50000000000000000000001',
        'connectionGeneration',1
      ),
      'standard','sync-lifecycle-stale-generation',0
    );
    RAISE EXCEPTION 'stale connection generation was published';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END;
$$;

SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname='albert-sync-lifecycle-recovery'
       AND schedule='*/5 * * * *'
       AND command='SELECT control_plane.recover_sync_stream_phases()'
  ),
  'the fixed durable lifecycle recovery schedule must be installed'
);

ROLLBACK;
