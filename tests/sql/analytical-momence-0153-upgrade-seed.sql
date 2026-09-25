-- This fixture is executed after the real analytical migration stream through
-- 0152 and before 0153. It represents damage produced by the superseded
-- authoritative-absence policy, including both immutable live/tombstone
-- envelopes and their mutable current-state projections.
BEGIN;

SELECT set_config('albert.tenant_id','01H00000000000000000000Q01',true);

INSERT INTO ingestion.batch_manifests (
  tenant_id,batch_id,connection_id,sync_run_id,connector_key,
  connector_version,api_version,stream,external_account_reference,extracted_at,
  content_hash,schema_fingerprint,record_count,compressed_bytes,object_keys
) SELECT
  '01H00000000000000000000Q01',seed.batch_id,
  '01H00000000000000000000Q02',seed.sync_run_id,'momence','1.0.0',
  'Public API v2','momence_sessions','user:upgrade-fixture',seed.extracted_at,
  repeat(seed.hash_character,64),repeat('a',64),seed.record_count,0,
  ARRAY['raw/momence-upgrade/'||seed.batch_id||'.ndjson.gz']
FROM (VALUES
  ('01H00000000000000000000Q03','01H00000000000000000000Q04',
   '2026-07-01T09:00:00Z'::timestamptz,'1',1::bigint),
  ('01H00000000000000000000Q06','01H00000000000000000000Q07',
   '2026-08-01T09:00:00Z'::timestamptz,'2',0::bigint),
  ('01H00000000000000000000Q08','01H00000000000000000000Q0D',
   '2026-08-01T10:00:00Z'::timestamptz,'3',0::bigint),
  ('01H00000000000000000000Q09','01H00000000000000000000Q0A',
   '2026-08-01T11:00:00Z'::timestamptz,'4',1::bigint),
  ('01H00000000000000000000Q0E','01H00000000000000000000Q0F',
   '2026-07-02T09:00:00Z'::timestamptz,'5',1::bigint),
  ('01H00000000000000000000Q0T','01H00000000000000000000Q0V',
   '2026-07-25T10:00:00Z'::timestamptz,'8',1::bigint),
  ('01H00000000000000000000Q0H','01H00000000000000000000Q0J',
   '2026-08-02T11:00:00Z'::timestamptz,'6',1::bigint),
  ('01H00000000000000000000Q0Q','01H00000000000000000000Q0R',
   '2026-08-03T12:00:00Z'::timestamptz,'7',1::bigint)
) AS seed(batch_id,sync_run_id,extracted_at,hash_character,record_count);

INSERT INTO ingestion.landing_commits (
  tenant_id,landing_commit_id,batch_id,sync_run_id,status,
  staged_record_count,quarantine_count,mapping_version,committed_at
) VALUES
  ('01H00000000000000000000Q01','01H00000000000000000000Q05',
   '01H00000000000000000000Q03','01H00000000000000000000Q04','committed',
   1,0,'momence-v1','2026-07-01T09:01:00Z'),
  ('01H00000000000000000000Q01','01H00000000000000000000Q0B',
   '01H00000000000000000000Q09','01H00000000000000000000Q0A','committed',
   1,0,'momence-v1','2026-08-01T11:01:00Z'),
  ('01H00000000000000000000Q01','01H00000000000000000000Q0G',
   '01H00000000000000000000Q0E','01H00000000000000000000Q0F','committed',
   1,0,'momence-v1','2026-07-02T09:01:00Z'),
  ('01H00000000000000000000Q01','01H00000000000000000000Q0W',
   '01H00000000000000000000Q0T','01H00000000000000000000Q0V','committed',
   1,0,'momence-v1','2026-07-25T10:01:00Z'),
  ('01H00000000000000000000Q01','01H00000000000000000000Q0N',
   '01H00000000000000000000Q0H','01H00000000000000000000Q0J','committed',
   1,0,'momence-v1','2026-08-02T11:01:00Z'),
  ('01H00000000000000000000Q01','01H00000000000000000000Q0S',
   '01H00000000000000000000Q0Q','01H00000000000000000000Q0R','committed',
   1,0,'momence-v1','2026-08-03T12:01:00Z');

INSERT INTO ingestion.canonical_staging_batch_records (
  tenant_id,batch_id,mapping_version,namespaced_source_key,connection_id,
  sync_run_id,connector_id,stream,source_object_type,source_record_id,
  payload_hash,staging_row,created_at
) SELECT
  '01H00000000000000000000Q01',envelope.batch_id,'momence-v1',
  'momence:user:upgrade-fixture:Session:501','01H00000000000000000000Q02',
  envelope.sync_run_id,'momence','momence_sessions','Session','501',
  repeat(envelope.hash_character,64),
  jsonb_build_object(
    'tenant_id','01H00000000000000000000Q01',
    'namespaced_source_key','momence:user:upgrade-fixture:Session:501',
    'connection_id','01H00000000000000000000Q02',
    'external_account_reference','user:upgrade-fixture',
    'source_object_type','Session',
    'source_record_id','501',
    'source_version',envelope.source_version,
    'source_updated_at',envelope.source_updated_at,
    'payload_hash',repeat(envelope.hash_character,64),
    'payload_batch_id',envelope.batch_id,
    'sync_run_id',envelope.sync_run_id,
    'tombstone',envelope.tombstone,
    'mapping_version','momence-v1',
    'record_id','501',
    'parent_id',NULL,
    'endpoint','/api/v2/host/sessions',
    'payload_json',jsonb_build_object(
      'id',501,
      'name','Sunrise Yoga',
      'teacher',jsonb_build_object('id',701,'firstName','Asha','lastName','Rao'),
      'inPersonLocation',jsonb_build_object(
        'id',801,'name','Harbour Studio','timeZone','Australia/Melbourne'
      )
    ),
    'field_index','{}'::jsonb,
    'name','Sunrise Yoga',
    'status','scheduled',
    'occurred_at','2026-07-05T07:00:00Z',
    'member_id',NULL,
    'session_id','501',
    'currency',NULL,
    'amount',NULL,
    'quantity',NULL,
    'is_cancelled',false,
    'first_ingested_at','2026-07-01T09:00:00Z',
    'ingested_at',envelope.ingested_at
  ),
  envelope.created_at
FROM (VALUES
  ('01H00000000000000000000Q03','01H00000000000000000000Q04','1',false,
   '2026-07-01T08:59:00Z','2026-07-01T08:59:00Z','2026-07-01T09:00:00Z'::timestamptz,
   '2026-07-01T09:00:30Z'::timestamptz),
  ('01H00000000000000000000Q09','01H00000000000000000000Q0A','4',true,
   '2026-08-01T11:00:00Z','2026-08-01T11:00:00Z','2026-08-01T11:00:00Z'::timestamptz,
   '2026-08-01T11:00:30Z'::timestamptz)
) AS envelope(
  batch_id,sync_run_id,hash_character,tombstone,source_version,
  source_updated_at,ingested_at,created_at
);

-- Session 502 is the adversarial history: the stale tombstone transformed at
-- a synthetic August source time, then a later live landing and transform
-- arrived with an older July vendor timestamp. Landing is already live before
-- 0153, while the normal canonical source-time claim remains poisoned.
INSERT INTO ingestion.canonical_staging_batch_records (
  tenant_id,batch_id,mapping_version,namespaced_source_key,connection_id,
  sync_run_id,connector_id,stream,source_object_type,source_record_id,
  payload_hash,staging_row,created_at
) SELECT
  '01H00000000000000000000Q01',envelope.batch_id,'momence-v1',
  'momence:user:upgrade-fixture:Session:502','01H00000000000000000000Q02',
  envelope.sync_run_id,'momence','momence_sessions','Session','502',
  repeat(envelope.hash_character,64),
  jsonb_build_object(
    'tenant_id','01H00000000000000000000Q01',
    'namespaced_source_key','momence:user:upgrade-fixture:Session:502',
    'connection_id','01H00000000000000000000Q02',
    'external_account_reference','user:upgrade-fixture',
    'source_object_type','Session',
    'source_record_id','502',
    'source_version',envelope.source_version,
    'source_updated_at',envelope.source_updated_at,
    'payload_hash',repeat(envelope.hash_character,64),
    'payload_batch_id',envelope.batch_id,
    'sync_run_id',envelope.sync_run_id,
    'tombstone',envelope.tombstone,
    'mapping_version','momence-v1',
    'record_id','502',
    'parent_id',NULL,
    'endpoint','/api/v2/host/sessions',
    'payload_json',jsonb_build_object(
      'id',502,
      'name','Evening Flow',
      'teacher',jsonb_build_object(
        'id',702,'firstName',envelope.teacher_first_name,
        'lastName',envelope.teacher_last_name
      ),
      'inPersonLocation',jsonb_build_object(
        'id',802,'name',envelope.location_name,
        'timeZone','Australia/Sydney'
      )
    ),
    'field_index','{}'::jsonb,
    'name','Evening Flow',
    'status','scheduled',
    'occurred_at','2026-08-05T08:00:00Z',
    'member_id',NULL,
    'session_id','502',
    'currency',NULL,
    'amount',NULL,
    'quantity',NULL,
    'is_cancelled',false,
    'first_ingested_at','2026-07-02T09:00:00Z',
    'ingested_at',envelope.ingested_at
  ),
  envelope.created_at
FROM (VALUES
  ('01H00000000000000000000Q0E','01H00000000000000000000Q0F','5',false,
   '2026-06-15T08:00:00Z','2026-06-15T08:00:00Z','Mina','Shah','Garden Studio',
   '2026-07-02T09:00:00Z'::timestamptz,'2026-07-02T09:00:30Z'::timestamptz),
  -- A' is an identical replay of A. Its observation timestamp is later than
  -- B, but unchanged hash/version/mapping means the transform's canonical
  -- state claim is deliberately a no-op and cannot become recovery authority.
  ('01H00000000000000000000Q0T','01H00000000000000000000Q0V','5',false,
   '2026-06-15T08:00:00Z','2026-07-20T08:00:00Z','Mina','Shah','Garden Studio',
   '2026-07-25T10:00:00Z'::timestamptz,'2026-07-25T10:00:30Z'::timestamptz),
  ('01H00000000000000000000Q0H','01H00000000000000000000Q0J','6',true,
   '2026-08-02T11:00:00Z','2026-08-02T11:00:00Z','Mina','Shah','Garden Studio',
   '2026-08-02T11:00:00Z'::timestamptz,'2026-08-02T11:00:30Z'::timestamptz),
  ('01H00000000000000000000Q0Q','01H00000000000000000000Q0R','7',false,
   '2026-07-15T08:00:00Z','2026-07-15T08:00:00Z','Mina','Patel','Garden Studio East',
   '2026-08-03T12:00:00Z'::timestamptz,'2026-08-03T12:00:30Z'::timestamptz)
) AS envelope(
  batch_id,sync_run_id,hash_character,tombstone,source_version,
  source_updated_at,teacher_first_name,teacher_last_name,location_name,
  ingested_at,created_at
);

INSERT INTO ingestion.source_records (
  tenant_id,namespaced_source_key,connection_id,external_account_reference,
  connector_key,stream,source_object_type,source_record_id,source_version,
  source_updated_at,payload_hash,normalized_schema_version,normalized_payload,
  tombstone,payload_batch_id,sync_run_id,first_ingested_at,ingested_at
) VALUES (
  '01H00000000000000000000Q01','momence:user:upgrade-fixture:Session:501',
  '01H00000000000000000000Q02','user:upgrade-fixture','momence',
  'momence_sessions','Session','501','2026-08-01T11:00:00Z',
  '2026-08-01T11:00:00Z',repeat('4',64),'momence-v1',
  '{"schemaVersion":"momence-v1","tombstone":true,"metadata":{"id":501,"name":"Sunrise Yoga"}}',
  true,'01H00000000000000000000Q09','01H00000000000000000000Q0A',
  '2026-07-01T09:00:00Z','2026-08-01T11:00:00Z'
),(
  '01H00000000000000000000Q01','momence:user:upgrade-fixture:Session:502',
  '01H00000000000000000000Q02','user:upgrade-fixture','momence',
  'momence_sessions','Session','502','2026-07-15T08:00:00Z',
  '2026-07-15T08:00:00Z',repeat('7',64),'momence-v1',
  '{"schemaVersion":"momence-v1","tombstone":false,"metadata":{"id":502,"name":"Evening Flow"}}',
  false,'01H00000000000000000000Q0Q','01H00000000000000000000Q0R',
  '2026-07-02T09:00:00Z','2026-08-03T12:00:00Z'
);

INSERT INTO source_momence.momence_sessions (
  tenant_id,namespaced_source_key,connection_id,external_account_reference,
  source_record_id,source_version,source_updated_at,payload_hash,
  payload_batch_id,sync_run_id,tombstone,mapping_version,record_id,parent_id,
  endpoint,payload_json,field_index,name,status,occurred_at,member_id,session_id,
  currency,amount,quantity,is_cancelled,first_ingested_at,ingested_at
) VALUES (
  '01H00000000000000000000Q01','momence:user:upgrade-fixture:Session:501',
  '01H00000000000000000000Q02','user:upgrade-fixture','501',
  '2026-08-01T11:00:00Z','2026-08-01T11:00:00Z',repeat('4',64),
  '01H00000000000000000000Q09','01H00000000000000000000Q0A',true,'momence-v1',
  '501',NULL,'/api/v2/host/sessions',
  '{"id":501,"name":"Sunrise Yoga","teacher":{"id":701,"firstName":"Asha","lastName":"Rao"},"inPersonLocation":{"id":801,"name":"Harbour Studio","timeZone":"Australia/Melbourne"}}',
  '{}','Sunrise Yoga','scheduled','2026-07-05T07:00:00Z',NULL,'501',
  NULL,NULL,NULL,false,'2026-07-01T09:00:00Z','2026-08-01T11:00:00Z'
),(
  '01H00000000000000000000Q01','momence:user:upgrade-fixture:Session:502',
  '01H00000000000000000000Q02','user:upgrade-fixture','502',
  '2026-07-15T08:00:00Z','2026-07-15T08:00:00Z',repeat('7',64),
  '01H00000000000000000000Q0Q','01H00000000000000000000Q0R',false,'momence-v1',
  '502',NULL,'/api/v2/host/sessions',
  '{"id":502,"name":"Evening Flow","teacher":{"id":702,"firstName":"Mina","lastName":"Patel"},"inPersonLocation":{"id":802,"name":"Garden Studio East","timeZone":"Australia/Sydney"}}',
  '{}','Evening Flow','scheduled','2026-08-05T08:00:00Z',NULL,'502',
  NULL,NULL,NULL,false,'2026-07-02T09:00:00Z','2026-08-03T12:00:00Z'
);

-- The stale transform completed before the policy cutover lock. The canonical
-- IDs and epoch links are the exact SHA-256/base32 identities produced by the
-- production transform worker for Teacher 701 and Location 801.
INSERT INTO semantic_internal.canonical_transform_commits (
  tenant_id,batch_id,sync_run_id,connection_id,connector_id,stream,
  mapping_version,staged_rows,quarantined_rows,command_count,canonical_rows,
  metadata_rows,quality_status,partial_quality_status,complete_quality_status,
  quality_evaluated,data_ready_through,completed_at
) VALUES
  ('01H00000000000000000000Q01','01H00000000000000000000Q03',
   '01H00000000000000000000Q04','01H00000000000000000000Q02','momence',
   'momence_sessions','momence-v1',1,0,3,2,1,'passed','passed','passed',true,
   '2026-07-01T09:00:00Z','2026-07-01T09:02:00Z'),
  ('01H00000000000000000000Q01','01H00000000000000000000Q09',
   '01H00000000000000000000Q0A','01H00000000000000000000Q02','momence',
   'momence_sessions','momence-v1',1,0,3,2,1,'passed','passed','passed',true,
   '2026-08-01T11:00:00Z','2026-08-01T11:02:00Z'),
  ('01H00000000000000000000Q01','01H00000000000000000000Q0E',
   '01H00000000000000000000Q0F','01H00000000000000000000Q02','momence',
   'momence_sessions','momence-v1',1,0,3,2,1,'passed','passed','passed',true,
   '2026-06-15T08:00:00Z','2026-07-02T09:02:00Z'),
  ('01H00000000000000000000Q01','01H00000000000000000000Q0T',
   '01H00000000000000000000Q0V','01H00000000000000000000Q02','momence',
   'momence_sessions','momence-v1',1,0,3,0,1,'passed','passed','passed',true,
   '2026-07-20T08:00:00Z','2026-07-25T10:02:00Z'),
  ('01H00000000000000000000Q01','01H00000000000000000000Q0H',
   '01H00000000000000000000Q0J','01H00000000000000000000Q02','momence',
   'momence_sessions','momence-v1',1,0,3,2,1,'passed','passed','passed',true,
   '2026-08-02T11:00:00Z','2026-08-02T11:02:00Z'),
  ('01H00000000000000000000Q01','01H00000000000000000000Q0Q',
   '01H00000000000000000000Q0R','01H00000000000000000000Q02','momence',
   'momence_sessions','momence-v1',1,0,3,0,1,'passed','passed','passed',true,
   '2026-07-15T08:00:00Z','2026-08-03T12:02:00Z');

INSERT INTO core.worker (
  tenant_id,id,person_id,display_name,active,created_at,updated_at,sync_run_id
) VALUES
(
  '01H00000000000000000000Q01','0BG8CP7M2D2FFQBZM9SMX68EJ1',NULL,
  'Asha Rao',false,'2026-07-01T09:02:00Z','2026-08-01T11:02:00Z',
  '01H00000000000000000000Q04'
),(
  '01H00000000000000000000Q01','13N16H2NPMN3NRBH65YYCHYH0S',NULL,
  'Mina Shah',false,'2026-07-02T09:02:00Z','2026-08-02T11:02:00Z',
  '01H00000000000000000000Q0F'
);
INSERT INTO core.location (
  tenant_id,id,name,timezone,legal_entity_id,active,created_at,updated_at,sync_run_id
) VALUES
(
  '01H00000000000000000000Q01','29KHMKKBAZNXCSVGQWB8DEMEXR',
  'Harbour Studio','Australia/Melbourne',NULL,false,
  '2026-07-01T09:02:00Z','2026-08-01T11:02:00Z',
  '01H00000000000000000000Q04'
),(
  '01H00000000000000000000Q01','7P2HFJ8174CW6J8A26Y7HMY4T2',
  'Garden Studio','Australia/Sydney',NULL,false,
  '2026-07-02T09:02:00Z','2026-08-02T11:02:00Z',
  '01H00000000000000000000Q0F'
);

INSERT INTO semantic_internal.canonical_record_state (
  tenant_id,canonical_table,canonical_id,source_updated_at,source_version,
  payload_hash,batch_id,sync_run_id,connection_id,source_object_type,
  source_record_id,mapping_version,updated_at
) VALUES
  ('01H00000000000000000000Q01','worker','0BG8CP7M2D2FFQBZM9SMX68EJ1',
   '2026-08-01T11:00:00Z','2026-08-01T11:00:00Z',repeat('4',64),
   '01H00000000000000000000Q09','01H00000000000000000000Q0A',
   '01H00000000000000000000Q02','Teacher','701','momence-v1',
   '2026-08-01T11:02:00Z'),
  ('01H00000000000000000000Q01','location','29KHMKKBAZNXCSVGQWB8DEMEXR',
   '2026-08-01T11:00:00Z','2026-08-01T11:00:00Z',repeat('4',64),
   '01H00000000000000000000Q09','01H00000000000000000000Q0A',
   '01H00000000000000000000Q02','Location','801','momence-v1',
   '2026-08-01T11:02:00Z'),
  ('01H00000000000000000000Q01','worker','13N16H2NPMN3NRBH65YYCHYH0S',
   '2026-08-02T11:00:00Z','2026-08-02T11:00:00Z',repeat('6',64),
   '01H00000000000000000000Q0H','01H00000000000000000000Q0J',
   '01H00000000000000000000Q02','Teacher','702','momence-v1',
   '2026-08-02T11:02:00Z'),
  ('01H00000000000000000000Q01','location','7P2HFJ8174CW6J8A26Y7HMY4T2',
   '2026-08-02T11:00:00Z','2026-08-02T11:00:00Z',repeat('6',64),
   '01H00000000000000000000Q0H','01H00000000000000000000Q0J',
   '01H00000000000000000000Q02','Location','802','momence-v1',
   '2026-08-02T11:02:00Z');

INSERT INTO core.entity_source_link (
  tenant_id,link_id,entity_type,canonical_entity_id,connection_id,
  source_object_type,source_record_id,match_method,match_status,confidence_band,
  evidence,valid_from,valid_to,confirmed_by,superseded_by,created_at,sync_run_id
) VALUES
  ('01H00000000000000000000Q01','6WY5NDDK33W5BT4SFPT4FB792A','worker',
   '0BG8CP7M2D2FFQBZM9SMX68EJ1','01H00000000000000000000Q02',
   'Teacher','701','external_id','superseded','high',
   jsonb_build_object('payload_hash',repeat('4',64),'mapping_version','momence-v1'),
   '1970-01-01T00:00:00Z','2026-08-01T11:00:00Z',NULL,NULL,
   '2026-07-01T09:02:00Z','01H00000000000000000000Q04'),
  ('01H00000000000000000000Q01','7QGJBTZ73CEDNDN5NCG1S97J1H','location',
   '29KHMKKBAZNXCSVGQWB8DEMEXR','01H00000000000000000000Q02',
   'Location','801','external_id','superseded','high',
   jsonb_build_object('payload_hash',repeat('4',64),'mapping_version','momence-v1'),
   '1970-01-01T00:00:00Z','2026-08-01T11:00:00Z',NULL,NULL,
   '2026-07-01T09:02:00Z','01H00000000000000000000Q04'),
  ('01H00000000000000000000Q01','2WPF311JQ4W42PH4ZT351N5CSA','worker',
   '13N16H2NPMN3NRBH65YYCHYH0S','01H00000000000000000000Q02',
   'Teacher','702','external_id','superseded','high',
   jsonb_build_object('payload_hash',repeat('6',64),'mapping_version','momence-v1'),
   '1970-01-01T00:00:00Z','2026-08-02T11:00:00Z',NULL,NULL,
   '2026-07-02T09:02:00Z','01H00000000000000000000Q0F'),
  ('01H00000000000000000000Q01','6JRVQDM9BA80SA71HC2GXFJEMV','location',
   '7P2HFJ8174CW6J8A26Y7HMY4T2','01H00000000000000000000Q02',
   'Location','802','external_id','superseded','high',
   jsonb_build_object('payload_hash',repeat('6',64),'mapping_version','momence-v1'),
   '1970-01-01T00:00:00Z','2026-08-02T11:00:00Z',NULL,NULL,
   '2026-07-02T09:02:00Z','01H00000000000000000000Q0F');

INSERT INTO quality.connector_stream_state (
  tenant_id,connection_id,connection_generation,connector_id,stream,required,
  late_edit_strategy,deletion_strategy,source_total_strategy,
  observed_page_count,cursor_chain_valid,cursor_complete,backfill_complete,
  reconciliation_completed_at,reconciliation_sweep_id,reconciliation_gap_count,
  deletion_evidence_count,source_total,local_live_total,last_page_at
) VALUES (
  '01H00000000000000000000Q01','01H00000000000000000000Q02',1,'momence',
  'momence_sessions',true,'full_snapshot','authoritative_identity_scan',
  'count_distinct_complete_scan',2,true,true,true,'2026-08-01T11:02:00Z',
  '01H00000000000000000000Q0C',0,2,0,0,'2026-08-03T12:02:00Z'
);

INSERT INTO quality.reconciliation_snapshot (
  tenant_id,connection_id,connection_generation,reconciliation_sweep_id,
  connector_id,stream,scan_ordinal,deletion_strategy,source_total_strategy,
  status,page_count,observed_count,unique_count,duplicate_count,invalid_count,
  quarantine_count,source_total,membership_delta_count,last_batch_id,
  started_at,completed_at
) VALUES
  ('01H00000000000000000000Q01','01H00000000000000000000Q02',1,
   '01H00000000000000000000Q0C','momence','momence_sessions',1,
   'authoritative_identity_scan','count_distinct_complete_scan','complete',1,
   0,0,0,0,0,0,0,'01H00000000000000000000Q06',
   '2026-08-01T09:00:00Z','2026-08-01T09:01:00Z'),
  ('01H00000000000000000000Q01','01H00000000000000000000Q02',1,
   '01H00000000000000000000Q0C','momence','momence_sessions',2,
   'authoritative_identity_scan','count_distinct_complete_scan','complete',1,
   0,0,0,0,0,0,0,'01H00000000000000000000Q08',
   '2026-08-01T10:00:00Z','2026-08-01T10:01:00Z');

INSERT INTO quality.reconciliation_tombstone_application (
  tenant_id,connection_id,connection_generation,reconciliation_sweep_id,stream,
  namespaced_source_key,source_object_type,source_record_id,tombstone_batch_id,
  first_snapshot_batch_id,verification_snapshot_batch_id,applied_at
) VALUES
(
  '01H00000000000000000000Q01','01H00000000000000000000Q02',1,
  '01H00000000000000000000Q0C','momence_sessions',
  'momence:user:upgrade-fixture:Session:501','Session','501',
  '01H00000000000000000000Q09','01H00000000000000000000Q06',
  '01H00000000000000000000Q08','2026-08-01T11:02:00Z'
),(
  '01H00000000000000000000Q01','01H00000000000000000000Q02',1,
  '01H00000000000000000000Q0C','momence_sessions',
  'momence:user:upgrade-fixture:Session:502','Session','502',
  '01H00000000000000000000Q0H','01H00000000000000000000Q06',
  '01H00000000000000000000Q08','2026-08-02T11:02:00Z'
);

COMMIT;
