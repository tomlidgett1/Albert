\set ON_ERROR_STOP on

-- Executable proof that a bounded Momence population can reconcile and report
-- its window total without converting an out-of-window identity into deletion.
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean,message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Momence reconciliation assertion failed: %',message;
  END IF;
END;
$$;

SELECT set_config('albert.tenant_id','01H00000000000000000000M01',true);

INSERT INTO ingestion.batch_manifests (
  tenant_id,batch_id,connection_id,sync_run_id,connector_key,
  connector_version,api_version,stream,external_account_reference,extracted_at,
  content_hash,schema_fingerprint,record_count,compressed_bytes,object_keys
)
SELECT
  '01H00000000000000000000M01',seed.batch_id,'01H00000000000000000000M02',
  seed.sync_run_id,'momence','1.0.0','Public API v2',
  'momence_sessions','user:bounded-policy-test',seed.extracted_at,
  repeat(seed.hash_character,64),repeat('a',64),seed.record_count,0,
  ARRAY['raw/'||seed.batch_id||'.ndjson.gz']
FROM (VALUES
  ('01H00000000000000000000M04','01H00000000000000000000M04',
   '2026-08-01T00:00:00Z'::timestamptz,'b',2::bigint),
  ('01H00000000000000000000M05','01H00000000000000000000M09',
   '2026-08-10T00:00:00Z'::timestamptz,'c',1::bigint),
  ('01H00000000000000000000M06','01H00000000000000000000M0A',
   '2026-08-10T01:00:00Z'::timestamptz,'d',1::bigint),
  ('01H00000000000000000000M07','01H00000000000000000000M0B',
   '2026-08-10T02:00:00Z'::timestamptz,'e',1::bigint)
) AS seed(batch_id,sync_run_id,extracted_at,hash_character,record_count);

-- This historical row deliberately lies outside the operational scan window.
INSERT INTO ingestion.source_records (
  tenant_id,namespaced_source_key,connection_id,external_account_reference,
  connector_key,stream,source_object_type,source_record_id,source_version,
  source_updated_at,payload_hash,normalized_schema_version,normalized_payload,
  tombstone,payload_batch_id,sync_run_id,first_ingested_at,ingested_at
) VALUES (
  '01H00000000000000000000M01','momence:user:bounded-policy-test:Session:old',
  '01H00000000000000000000M02','user:bounded-policy-test','momence',
  'momence_sessions','Session','old','2026-01-01T00:00:00Z',
  '2026-01-01T00:00:00Z',repeat('b',64),'v1',
  '{"schemaVersion":"v1","tombstone":false,"metadata":{"id":"old"}}',false,
  '01H00000000000000000000M04','01H00000000000000000000M04',
  '2026-08-01T00:00:00Z','2026-08-01T00:00:00Z'
),(
  '01H00000000000000000000M01','momence:user:bounded-policy-test:Session:older',
  '01H00000000000000000000M02','user:bounded-policy-test','momence',
  'momence_sessions','Session','older','2025-01-01T00:00:00Z',
  '2025-01-01T00:00:00Z',repeat('f',64),'v1',
  '{"schemaVersion":"v1","tombstone":false,"metadata":{"id":"older"}}',false,
  '01H00000000000000000000M04','01H00000000000000000000M04',
  '2026-08-01T00:00:00Z','2026-08-01T00:00:00Z'
);

SET LOCAL ROLE ingest_rw;
SELECT set_config('albert.tenant_id','01H00000000000000000000M01',true);

SELECT pg_temp.assert_true(
  quality.register_connector_streams(
    '01H00000000000000000000M01','01H00000000000000000000M02',1,'momence',
    '[{"stream":"momence_sessions","required":true,"lateEditStrategy":"full_snapshot","deletionStrategy":"no_absence_deletes","sourceTotalStrategy":"count_distinct_bounded_scan"}]'
  )=1,
  'bounded Momence policy must register'
);

SELECT pg_temp.assert_true(
  quality.record_reconciliation_snapshot_page(
    '01H00000000000000000000M01','01H00000000000000000000M02',1,
    '01H00000000000000000000M03','momence','momence_sessions',1,
    'no_absence_deletes','count_distinct_bounded_scan',
    '01H00000000000000000000M05',
    '[{"sourceObjectType":"Session","sourceRecordId":"in-window","payloadHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","sourceUpdatedAt":"2026-08-10T00:00:00Z"}]',
    0,0,false,1
  )->>'status'='complete',
  'first bounded snapshot must complete'
);
SELECT pg_temp.assert_true(
  quality.record_reconciliation_snapshot_page(
    '01H00000000000000000000M01','01H00000000000000000000M02',1,
    '01H00000000000000000000M03','momence','momence_sessions',2,
    'no_absence_deletes','count_distinct_bounded_scan',
    '01H00000000000000000000M06',
    '[{"sourceObjectType":"Session","sourceRecordId":"in-window","payloadHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","sourceUpdatedAt":"2026-08-10T00:00:00Z"}]',
    0,0,false,1
  )->>'status'='complete',
  'stable verification snapshot must complete'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM quality.reconciliation_tombstone_candidates(
    '01H00000000000000000000M01','01H00000000000000000000M02',1,
    '01H00000000000000000000M03','momence_sessions','',500
  ))=0,
  'out-of-window history must never become a tombstone candidate'
);
SELECT pg_temp.assert_true(
  quality.complete_connector_reconciliation(
    '01H00000000000000000000M01','01H00000000000000000000M02',1,
    '01H00000000000000000000M03','momence_sessions'
  )=0,
  'bounded reconciliation must complete without tombstones'
);

-- Runtime mutations remain function-scoped; inspect durable state as the test
-- administrator rather than granting transform_rw direct table reads.
RESET ROLE;
SELECT set_config('albert.tenant_id','01H00000000000000000000M01',true);
SELECT pg_temp.assert_true(
  (SELECT source_total=1 AND local_live_total IS NULL
          AND deletion_strategy='no_absence_deletes'
          AND source_total_strategy='count_distinct_bounded_scan'
     FROM quality.connector_stream_state
    WHERE tenant_id='01H00000000000000000000M01'
      AND connection_id='01H00000000000000000000M02'
      AND connection_generation=1 AND stream='momence_sessions'),
  'bounded total must never be compared with all staged history'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM ingestion.source_records
    WHERE tenant_id='01H00000000000000000000M01'
      AND connection_id='01H00000000000000000000M02'
      AND stream='momence_sessions' AND NOT tombstone)=2,
  'the all-history population must deliberately differ from the bounded total'
);
SET LOCAL ROLE transform_rw;
SELECT set_config('albert.tenant_id','01H00000000000000000000M01',true);
SELECT quality.refresh_connector_quality_rollup(
  '01H00000000000000000000M01','01H00000000000000000000M08'
);

RESET ROLE;
SELECT set_config('albert.tenant_id','01H00000000000000000000M01',true);

-- Simulate an old worker that fetched candidates before the policy changed.
-- The final landing write itself must still reject the absence tombstone.
DO $$
BEGIN
  UPDATE ingestion.source_records
     SET tombstone=true,payload_batch_id='01H00000000000000000000M07',
         -- A real apply phase has its own sync run; it is never the sweep id.
         sync_run_id='01H00000000000000000000M0B',
         normalized_payload=jsonb_set(normalized_payload,'{tombstone}','true'::jsonb),
         payload_hash=repeat('e',64)
   WHERE tenant_id='01H00000000000000000000M01'
     AND namespaced_source_key='momence:user:bounded-policy-test:Session:old';
  RAISE EXCEPTION 'bounded reconciliation tombstone landing was accepted';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;
SELECT pg_temp.assert_true(
  (SELECT NOT tombstone
     FROM ingestion.source_records
    WHERE tenant_id='01H00000000000000000000M01'
      AND namespaced_source_key='momence:user:bounded-policy-test:Session:old'),
  'rejected stale landing must leave the historical source record live'
);

-- Note fan-out can observe one payment transaction through several notes.
-- The database identity set, not the connector cursor, is the exact distinct
-- authority for this bounded population; duplicate observations must remain
-- valid only for this one stream/policy combination.
INSERT INTO ingestion.batch_manifests (
  tenant_id,batch_id,connection_id,sync_run_id,connector_key,
  connector_version,api_version,stream,external_account_reference,extracted_at,
  content_hash,schema_fingerprint,record_count,compressed_bytes,object_keys
) SELECT
  '01H00000000000000000000M01',seed.batch_id,'01H00000000000000000000M02',
  seed.sync_run_id,'momence','1.0.0','Public API v2',
  'momence_payment_transactions','user:bounded-policy-test',seed.extracted_at,
  repeat(seed.hash_character,64),repeat('a',64),2,0,
  ARRAY['raw/'||seed.batch_id||'.ndjson.gz']
FROM (VALUES
  ('01H00000000000000000000M0C','01H00000000000000000000M0C',
   '2026-08-10T03:00:00Z'::timestamptz,'1'),
  ('01H00000000000000000000M0D','01H00000000000000000000M0D',
   '2026-08-10T04:00:00Z'::timestamptz,'2')
) AS seed(batch_id,sync_run_id,extracted_at,hash_character);

SET LOCAL ROLE ingest_rw;
SELECT set_config('albert.tenant_id','01H00000000000000000000M01',true);
SELECT quality.register_connector_streams(
  '01H00000000000000000000M01','01H00000000000000000000M02',1,'momence',
  '[{"stream":"momence_payment_transactions","required":false,"lateEditStrategy":"full_snapshot","deletionStrategy":"no_absence_deletes","sourceTotalStrategy":"count_distinct_bounded_scan"}]'
);
SELECT pg_temp.assert_true(
  quality.record_reconciliation_snapshot_page(
    '01H00000000000000000000M01','01H00000000000000000000M02',1,
    '01H00000000000000000000M0E','momence','momence_payment_transactions',1,
    'no_absence_deletes','count_distinct_bounded_scan',
    '01H00000000000000000000M0C',
    '[
      {"sourceObjectType":"PaymentTransaction","sourceRecordId":"50","payloadHash":"1111111111111111111111111111111111111111111111111111111111111111"},
      {"sourceObjectType":"PaymentTransaction","sourceRecordId":"50","payloadHash":"1111111111111111111111111111111111111111111111111111111111111111"}
    ]',0,0,false,NULL
  )->>'status'='complete',
  'duplicate payment references must reduce to one exact durable identity'
);
SELECT pg_temp.assert_true(
  quality.record_reconciliation_snapshot_page(
    '01H00000000000000000000M01','01H00000000000000000000M02',1,
    '01H00000000000000000000M0E','momence','momence_payment_transactions',2,
    'no_absence_deletes','count_distinct_bounded_scan',
    '01H00000000000000000000M0D',
    '[
      {"sourceObjectType":"PaymentTransaction","sourceRecordId":"50","payloadHash":"1111111111111111111111111111111111111111111111111111111111111111"},
      {"sourceObjectType":"PaymentTransaction","sourceRecordId":"50","payloadHash":"1111111111111111111111111111111111111111111111111111111111111111"}
    ]',0,0,false,NULL
  )->>'status'='complete',
  'duplicate payment verification must keep the same distinct population'
);
SELECT pg_temp.assert_true(
  quality.complete_connector_reconciliation(
    '01H00000000000000000000M01','01H00000000000000000000M02',1,
    '01H00000000000000000000M0E','momence_payment_transactions'
  )=0,
  'note-discovered payments must complete without absence tombstones'
);
SELECT pg_temp.assert_true(
  (SELECT source_total=1 AND local_live_total IS NULL
     FROM quality.connector_stream_state
    WHERE tenant_id='01H00000000000000000000M01'
      AND connection_id='01H00000000000000000000M02'
      AND connection_generation=1
      AND stream='momence_payment_transactions'),
  'payment source total must be the exact durable distinct identity count'
);

ROLLBACK;
