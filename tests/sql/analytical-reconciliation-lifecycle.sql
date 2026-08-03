\set ON_ERROR_STOP on

-- Durable two-snapshot deletion proof, exact replay, generation isolation,
-- current-generation health, and deletion closure. The harness is repeatable.
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean,message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'analytical reconciliation assertion failed: %',message;
  END IF;
END;
$$;

SELECT set_config('albert.tenant_id','01H00000000000000000000901',true);

INSERT INTO ingestion.batch_manifests (
  tenant_id,batch_id,connection_id,sync_run_id,connector_key,
  connector_version,api_version,stream,external_account_reference,extracted_at,
  content_hash,schema_fingerprint,record_count,compressed_bytes,object_keys
)
SELECT
  '01H00000000000000000000901',seed.batch_id,seed.connection_id,seed.batch_id,
  'lightspeed-r','1.0.0','2026-08',seed.stream,'account-reconciliation',now(),
  repeat(substr(seed.batch_id,26,1),64),repeat('a',64),seed.record_count,0,
  ARRAY['raw/'||seed.batch_id||'.ndjson.gz']
FROM (VALUES
  ('01H00000000000000000000904','01H00000000000000000000902','items',2::bigint),
  ('01H00000000000000000000905','01H00000000000000000000902','items',1::bigint),
  ('01H00000000000000000000906','01H00000000000000000000902','items',1::bigint),
  ('01H00000000000000000000907','01H00000000000000000000902','items',1::bigint),
  ('01H00000000000000000000911','01H00000000000000000000902','customers',1::bigint),
  ('01H00000000000000000000912','01H00000000000000000000902','customers',1::bigint),
  ('01H00000000000000000000914','01H00000000000000000000902','shops',2::bigint),
  ('01H00000000000000000000916','01H00000000000000000000902','sales',1::bigint),
  ('01H00000000000000000000920','01H00000000000000000000902','sales',1::bigint),
  ('01H00000000000000000000921','01H00000000000000000000902','sales',0::bigint)
) AS seed(batch_id,connection_id,stream,record_count);

INSERT INTO ingestion.source_records (
  tenant_id,namespaced_source_key,connection_id,external_account_reference,
  connector_key,stream,source_object_type,source_record_id,source_updated_at,
  payload_hash,normalized_schema_version,normalized_payload,tombstone,
  payload_batch_id,sync_run_id,first_ingested_at,ingested_at
) VALUES
  ('01H00000000000000000000901','lightspeed-r:item:keep',
   '01H00000000000000000000902','account-reconciliation','lightspeed-r','items',
   'Item','keep','2026-08-01T00:00:00Z',repeat('b',64),'v1','{"id":"keep"}',false,
   '01H00000000000000000000904','01H00000000000000000000904',now()-interval '1 day',now()-interval '1 day'),
  ('01H00000000000000000000901','lightspeed-r:item:lost',
   '01H00000000000000000000902','account-reconciliation','lightspeed-r','items',
   'Item','lost','2026-08-01T00:00:00Z',repeat('c',64),'v1','{"id":"lost"}',false,
   '01H00000000000000000000904','01H00000000000000000000904',now()-interval '1 day',now()-interval '1 day');

INSERT INTO ingestion.quarantine_records (
  tenant_id,quarantine_id,connection_id,sync_run_id,payload_batch_id,stream,
  source_object_type,source_record_id,payload_hash,raw_object_key,error_code,
  error_summary,mapping_version,status
) VALUES (
  '01H00000000000000000000901','01H00000000000000000000922',
  '01H00000000000000000000902','01H00000000000000000000920',
  '01H00000000000000000000920','sales','Sale','old-generation-bad',repeat('d',64),
  'raw/01H00000000000000000000920.ndjson.gz','schema_drift',
  'old generation drift','v1','open'
);

SET LOCAL ROLE ingest_rw;
SELECT set_config('albert.tenant_id','01H00000000000000000000901',true);

SELECT pg_temp.assert_true(
  quality.register_connector_streams(
    '01H00000000000000000000901','01H00000000000000000000902',1,'lightspeed-r',
    '[
      {"stream":"items","required":true,"lateEditStrategy":"modified_field","deletionStrategy":"authoritative_identity_scan","sourceTotalStrategy":"count_distinct_complete_scan"},
      {"stream":"customers","required":true,"lateEditStrategy":"modified_field","deletionStrategy":"authoritative_identity_scan","sourceTotalStrategy":"count_distinct_complete_scan"},
      {"stream":"shops","required":true,"lateEditStrategy":"full_snapshot","deletionStrategy":"authoritative_identity_scan","sourceTotalStrategy":"count_distinct_complete_scan"},
      {"stream":"sales","required":true,"lateEditStrategy":"modified_field","deletionStrategy":"authoritative_identity_scan","sourceTotalStrategy":"count_distinct_complete_scan"}
    ]'::jsonb
  )=4,
  'every tested stream must have an explicit durable reconciliation policy'
);

-- One complete scan is insufficient deletion proof.
SELECT pg_temp.assert_true(
  quality.record_reconciliation_snapshot_page(
    '01H00000000000000000000901','01H00000000000000000000902',1,
    '01H00000000000000000000903','lightspeed-r','items',1,
    'authoritative_identity_scan','count_distinct_complete_scan',
    '01H00000000000000000000905',
    '[{"sourceObjectType":"Item","sourceRecordId":"keep","payloadHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","sourceUpdatedAt":"2026-08-01T00:00:00Z"}]',
    0,0,false,null
  )->>'status'='complete',
  'first complete identity scan must be recorded'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM quality.reconciliation_tombstone_candidates(
    '01H00000000000000000000901','01H00000000000000000000902',1,
    '01H00000000000000000000903','items','',500
  ))=0,
  'a single complete scan must never authorize a hard-delete tombstone'
);

-- Exact page replay succeeds; any changed evidence using the same batch fails.
SELECT pg_temp.assert_true(
  (quality.record_reconciliation_snapshot_page(
    '01H00000000000000000000901','01H00000000000000000000902',1,
    '01H00000000000000000000903','lightspeed-r','items',1,
    'authoritative_identity_scan','count_distinct_complete_scan',
    '01H00000000000000000000905',
    '[{"sourceObjectType":"Item","sourceRecordId":"keep","payloadHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","sourceUpdatedAt":"2026-08-01T00:00:00Z"}]',
    0,0,false,null
  )->>'idempotentReplay')::boolean,
  'an exact snapshot-page replay must be idempotent'
);
DO $$
BEGIN
  PERFORM quality.record_reconciliation_snapshot_page(
    '01H00000000000000000000901','01H00000000000000000000902',1,
    '01H00000000000000000000903','lightspeed-r','items',1,
    'authoritative_identity_scan','count_distinct_complete_scan',
    '01H00000000000000000000905',
    '[{"sourceObjectType":"Item","sourceRecordId":"changed","payloadHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]',
    0,0,false,null
  );
  RAISE EXCEPTION 'changed evidence replay was accepted';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

-- A second independent complete scan with identical membership authorizes
-- only identities absent from both scans and older than the proof window.
SELECT pg_temp.assert_true(
  quality.record_reconciliation_snapshot_page(
    '01H00000000000000000000901','01H00000000000000000000902',1,
    '01H00000000000000000000903','lightspeed-r','items',2,
    'authoritative_identity_scan','count_distinct_complete_scan',
    '01H00000000000000000000906',
    '[{"sourceObjectType":"Item","sourceRecordId":"keep","payloadHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","sourceUpdatedAt":"2026-08-01T00:00:00Z"}]',
    0,0,false,null
  )->>'status'='complete',
  'stable verification scan must complete'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM quality.reconciliation_tombstone_candidates(
    '01H00000000000000000000901','01H00000000000000000000902',1,
    '01H00000000000000000000903','items','',500
  ))=1,
  'two stable complete scans must expose exactly the absent local identity'
);
SELECT pg_temp.assert_true(
  (SELECT source_record_id='lost'
          AND first_snapshot_batch_id='01H00000000000000000000905'
          AND verification_snapshot_batch_id='01H00000000000000000000906'
     FROM quality.reconciliation_tombstone_candidates(
       '01H00000000000000000000901','01H00000000000000000000902',1,
       '01H00000000000000000000903','items','',500
     ) LIMIT 1),
  'candidate evidence must name the exact two completed snapshot batches'
);

-- Equal totals with changed membership are not a stable source snapshot.
SELECT pg_temp.assert_true(
  quality.record_reconciliation_snapshot_page(
    '01H00000000000000000000901','01H00000000000000000000902',1,
    '01H00000000000000000000910','lightspeed-r','customers',1,
    'authoritative_identity_scan','count_distinct_complete_scan',
    '01H00000000000000000000911',
    '[{"sourceObjectType":"Customer","sourceRecordId":"a","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]',
    0,0,false,null
  )->>'status'='complete',
  'first equal-count membership scan must complete'
);
SELECT pg_temp.assert_true(
  quality.record_reconciliation_snapshot_page(
    '01H00000000000000000000901','01H00000000000000000000902',1,
    '01H00000000000000000000910','lightspeed-r','customers',2,
    'authoritative_identity_scan','count_distinct_complete_scan',
    '01H00000000000000000000912',
    '[{"sourceObjectType":"Customer","sourceRecordId":"b","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]',
    0,0,false,null
  )->>'status'='failed',
  'changed membership with the same total must fail closed'
);

-- Duplicate and quarantine/invalid evidence each fail closed.
SELECT pg_temp.assert_true(
  quality.record_reconciliation_snapshot_page(
    '01H00000000000000000000901','01H00000000000000000000902',1,
    '01H00000000000000000000913','lightspeed-r','shops',1,
    'authoritative_identity_scan','count_distinct_complete_scan',
    '01H00000000000000000000914',
    '[
      {"sourceObjectType":"Shop","sourceRecordId":"dup","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
      {"sourceObjectType":"Shop","sourceRecordId":"dup","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
    ]',0,0,false,null
  )->>'status'='failed',
  'duplicate identities must invalidate a complete snapshot'
);
SELECT pg_temp.assert_true(
  quality.record_reconciliation_snapshot_page(
    '01H00000000000000000000901','01H00000000000000000000902',1,
    '01H00000000000000000000915','lightspeed-r','sales',1,
    'authoritative_identity_scan','count_distinct_complete_scan',
    '01H00000000000000000000916',
    '[{"sourceObjectType":"Sale","sourceRecordId":"bad","payloadHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]',
    1,1,false,null
  )->>'status'='failed',
  'normalization or quarantine evidence must invalidate a snapshot'
);

RESET ROLE;
SELECT set_config('albert.tenant_id','01H00000000000000000000901',true);
UPDATE ingestion.source_records
   SET tombstone=true,payload_batch_id='01H00000000000000000000907',
       sync_run_id='01H00000000000000000000907',payload_hash=repeat('e',64),
       normalized_payload='{"id":"lost","tombstone":true}',ingested_at=now()
 WHERE tenant_id='01H00000000000000000000901'
   AND namespaced_source_key='lightspeed-r:item:lost';

SET LOCAL ROLE ingest_rw;
SELECT set_config('albert.tenant_id','01H00000000000000000000901',true);
SELECT pg_temp.assert_true(
  quality.record_reconciliation_tombstone_applications(
    '01H00000000000000000000901','01H00000000000000000000902',1,
    '01H00000000000000000000903','items','01H00000000000000000000907',
    '[{"namespacedSourceKey":"lightspeed-r:item:lost","sourceObjectType":"Item","sourceRecordId":"lost","firstSnapshotBatchId":"01H00000000000000000000905","verificationSnapshotBatchId":"01H00000000000000000000906"}]'
  )=1,
  'a landed exact-batch tombstone with two-snapshot proof must become durable'
);
SELECT pg_temp.assert_true(
  quality.record_reconciliation_tombstone_applications(
    '01H00000000000000000000901','01H00000000000000000000902',1,
    '01H00000000000000000000903','items','01H00000000000000000000907',
    '[{"namespacedSourceKey":"lightspeed-r:item:lost","sourceObjectType":"Item","sourceRecordId":"lost","firstSnapshotBatchId":"01H00000000000000000000905","verificationSnapshotBatchId":"01H00000000000000000000906"}]'
  )=0,
  'exact tombstone application replay must be idempotent'
);
SELECT pg_temp.assert_true(
  quality.complete_connector_reconciliation(
    '01H00000000000000000000901','01H00000000000000000000902',1,
    '01H00000000000000000000903','items'
  )=1,
  'completion must verify source total against the landed post-tombstone population'
);

-- Generation-scoped page evidence prevents old open quarantine from poisoning
-- current health. An empty, terminal, retained page is valid evidence.
SELECT quality.register_connector_streams(
  '01H00000000000000000000901','01H00000000000000000000902',2,'lightspeed-r',
  '[{"stream":"sales","required":true,"lateEditStrategy":"modified_field","deletionStrategy":"authoritative_identity_scan","sourceTotalStrategy":"count_distinct_complete_scan"}]'
);
SELECT quality.record_connector_stream_page(
  '01H00000000000000000000901','01H00000000000000000000902',1,'sales',
  '01H00000000000000000000920',
  '{"recordCount":1,"quarantineCount":1,"schemaDriftCount":1,"enumDriftCount":0,"cursorLinkValid":true,"cursorComplete":true,"backfillComplete":true}'
);
SELECT quality.record_connector_stream_page(
  '01H00000000000000000000901','01H00000000000000000000902',2,'sales',
  '01H00000000000000000000921',
  '{"recordCount":0,"quarantineCount":0,"schemaDriftCount":0,"enumDriftCount":0,"cursorLinkValid":true,"cursorComplete":true,"backfillComplete":true,"coverage":{"boundaryKind":"snapshot_at"}}'
);
SELECT quality.refresh_connector_quality_rollup(
  '01H00000000000000000000901','01H00000000000000000000940'
);

RESET ROLE;
SELECT set_config('albert.tenant_id','01H00000000000000000000901',true);
SELECT pg_temp.assert_true(
  (SELECT unresolved_quarantine_count=0 AND unresolved_schema_drift_count=0
          AND observed_page_count=1 AND cursor_complete AND cursor_chain_valid
     FROM quality.connector_stream_state
    WHERE tenant_id='01H00000000000000000000901'
      AND connection_id='01H00000000000000000000902'
      AND connection_generation=2 AND stream='sales'),
  'current generation must ignore unresolved quarantine owned by an old generation'
);
SELECT pg_temp.assert_true(
  (SELECT status='passed' FROM quality.check_result
    WHERE tenant_id='01H00000000000000000000901'
      AND run_id='01H00000000000000000000940'
      AND check_id='scope_available'),
  'a clean empty observed stream must pass scope availability'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege('ingest_rw','quality.connector_stream_state','INSERT,UPDATE,DELETE'),
  'ingest runtime must use narrow functions rather than direct stream-state DML'
);

-- New reconciliation tables participate in connection purge and verification.
SET LOCAL ROLE ingest_rw;
SELECT set_config('albert.tenant_id','01H00000000000000000000901',true);
SELECT quality.register_connector_streams(
  '01H00000000000000000000901','01H00000000000000000000930',1,'lightspeed-r',
  '[{"stream":"items","required":true,"lateEditStrategy":"modified_field","deletionStrategy":"authoritative_identity_scan","sourceTotalStrategy":"count_distinct_complete_scan"}]'
);
RESET ROLE;
-- The signed public deletion wrappers are covered by the dual-database,
-- exact-login capability integration test. This analytical-only fixture runs
-- the reviewed algorithms as the migration/admin session so it cannot invent
-- a production token signer or weaken the runtime capability boundary.
SELECT deletion_internal.purge_connection_pre_capability(
  '01H00000000000000000000901','01H00000000000000000000930'
);
SELECT pg_temp.assert_true(
  (deletion_internal.verify_connection_pre_capability(
    '01H00000000000000000000901','01H00000000000000000000930'
  )->>'verified')::boolean,
  'connection erasure verification must include all reconciliation relations'
);

RESET ROLE;
ROLLBACK;
