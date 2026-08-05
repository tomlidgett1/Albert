\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean,message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'progressive dependency assertion failed: %',message;
  END IF;
END;
$$;

INSERT INTO control_plane.tenants(tenant_id,slug,display_name)
VALUES ('01K60000000000000000000000','progressive-barrier','Progressive barrier');
INSERT INTO control_plane.connections(
  tenant_id,connection_id,connector_key,display_name,external_account_reference,
  status,auth_health,connection_generation
) VALUES (
  '01K60000000000000000000000','01K60000000000000000000001',
  'lightspeed-r','Progressive Lightspeed','lightspeed-progressive-account',
  'connected','healthy',1
);

-- The product domain is deliberately not a canonical table name. The sales
-- phase cannot transform until both pages of the items master have transformed.
SELECT control_plane.register_sync_stream_phase(
  '01K60000000000000000000000','01K60000000000000000000001',1,
  'items','recent',1,'single_pass','snapshot',true,
  ARRAY['sales'],ARRAY[]::text[],
  '2026-07-03T00:00:00Z','2026-08-03T00:00:00Z',null
);
SELECT control_plane.register_sync_stream_phase(
  '01K60000000000000000000000','01K60000000000000000000001',1,
  'sales','recent',1,'progressive','time_windowed',true,
  ARRAY['sales'],ARRAY['items'],
  '2026-07-03T00:00:00Z','2026-08-03T00:00:00Z',null
);
SELECT control_plane.register_sync_stream_phase(
  '01K60000000000000000000000','01K60000000000000000000001',1,
  'inventory_logs','recent',1,'progressive','time_windowed',false,
  ARRAY['inventory'],ARRAY['items'],
  '2026-07-03T00:00:00Z','2026-08-03T00:00:00Z',null
);
SELECT pg_temp.assert_true(
  control_plane.seal_sync_dependency_plan(
    '01K60000000000000000000000','01K60000000000000000000001',1
  )=3,
  'the complete immutable dependency plan must seal atomically'
);

DO $$
BEGIN
  BEGIN
    PERFORM control_plane.register_sync_stream_phase(
      '01K60000000000000000000000','01K60000000000000000000001',1,
      'late_added_stream','recent',1,'single_pass','snapshot',true,
      ARRAY['sales'],ARRAY[]::text[],
      '2026-07-03T00:00:00Z','2026-08-03T00:00:00Z',null
    );
    RAISE EXCEPTION 'a sealed dependency plan accepted another stream';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END;
$$;

UPDATE control_plane.sync_stream_phases
   SET status='queued'
 WHERE tenant_id='01K60000000000000000000000'
   AND connection_id='01K60000000000000000000001'
   AND stream='inventory_logs';
SELECT control_plane.mark_sync_stream_phase_unavailable(
  '01K60000000000000000000000','01K60000000000000000000001',1,
  'inventory_logs','recent',1,
  '{"code":"capability_unavailable","retryable":false}'::jsonb
);
SELECT pg_temp.assert_true(
  (
    SELECT status='degraded'
      FROM control_plane.progressive_stream_coverage
     WHERE tenant_id='01K60000000000000000000000'
       AND connection_id='01K60000000000000000000001'
       AND connection_generation=1 AND stream='inventory_logs'
  ),
  'an optional account capability must be explicit without blocking required siblings'
);

INSERT INTO control_plane.sync_runs(
  tenant_id,sync_run_id,connection_id,job_type,stream,status,attempt_number,
  scheduled_at,started_at,finished_at,connection_generation,backfill_phase,replay_version
) VALUES
  ('01K60000000000000000000000','01K60000000000000000000010','01K60000000000000000000001','InitialBackfill','items','succeeded',1,now(),now(),now(),1,'recent',1),
  ('01K60000000000000000000000','01K60000000000000000000020','01K60000000000000000000001','InitialBackfill','items','succeeded',1,now(),now(),now(),1,'recent',1),
  ('01K60000000000000000000000','01K60000000000000000000030','01K60000000000000000000001','InitialBackfill','sales','succeeded',1,now(),now(),now(),1,'recent',1),
  ('01K60000000000000000000000','01K60000000000000000000040','01K60000000000000000000001','InitialBackfill','sales','succeeded',1,now(),now(),now(),1,'recent',1);

INSERT INTO control_plane.raw_batch_manifests(
  tenant_id,batch_id,connection_id,sync_run_id,connector_key,connector_version,
  api_version,stream,extracted_at,content_hash,schema_fingerprint,record_count,
  compressed_bytes,object_keys
) VALUES
  ('01K60000000000000000000000','01K60000000000000000000011','01K60000000000000000000001','01K60000000000000000000010','lightspeed-r','1.0.0','v3','items',now(),repeat('a',64),repeat('f',64),500,100,ARRAY['raw/items-1.gz']),
  ('01K60000000000000000000000','01K60000000000000000000021','01K60000000000000000000001','01K60000000000000000000020','lightspeed-r','1.0.0','v3','items',now(),repeat('b',64),repeat('f',64),5,100,ARRAY['raw/items-2.gz']),
  ('01K60000000000000000000000','01K60000000000000000000031','01K60000000000000000000001','01K60000000000000000000030','lightspeed-r','1.0.0','v3','sales',now(),repeat('c',64),repeat('f',64),100,100,ARRAY['raw/sales-1.gz']),
  ('01K60000000000000000000000','01K60000000000000000000041','01K60000000000000000000001','01K60000000000000000000040','lightspeed-r','1.0.0','v3','sales',now(),repeat('d',64),repeat('f',64),2,100,ARRAY['raw/sales-2.gz']);
INSERT INTO control_plane.raw_batch_landings(
  tenant_id,batch_id,status,staged_record_count,quarantine_count,analytical_committed_at
) VALUES
  ('01K60000000000000000000000','01K60000000000000000000011','landed',500,0,now()),
  ('01K60000000000000000000000','01K60000000000000000000021','landed',5,0,now()),
  ('01K60000000000000000000000','01K60000000000000000000031','landed',100,0,now()),
  ('01K60000000000000000000000','01K60000000000000000000041','landed',2,0,now());
INSERT INTO control_plane.canonical_transform_jobs(
  tenant_id,transform_job_id,batch_id,sync_run_id,connection_id,connector_id,
  stream,domains,mapping_version,backfill_complete,status,connection_generation,created_at
) VALUES
  ('01K60000000000000000000000','01K60000000000000000000012','01K60000000000000000000011','01K60000000000000000000010','01K60000000000000000000001','lightspeed-r','items',ARRAY['sales'],'progressive-v1',false,'queued',1,now()-interval '4 seconds'),
  ('01K60000000000000000000000','01K60000000000000000000022','01K60000000000000000000021','01K60000000000000000000020','01K60000000000000000000001','lightspeed-r','items',ARRAY['sales'],'progressive-v1',false,'queued',1,now()-interval '3 seconds'),
  ('01K60000000000000000000000','01K60000000000000000000032','01K60000000000000000000031','01K60000000000000000000030','01K60000000000000000000001','lightspeed-r','sales',ARRAY['sales'],'progressive-v1',false,'queued',1,now()-interval '2 seconds'),
  ('01K60000000000000000000000','01K60000000000000000000042','01K60000000000000000000041','01K60000000000000000000040','01K60000000000000000000001','lightspeed-r','sales',ARRAY['sales'],'progressive-v1',false,'queued',1,now()-interval '1 second');
INSERT INTO control_plane.readiness(
  tenant_id,connection_id,domain,state,progress,backfill_complete
) VALUES (
  '01K60000000000000000000000','01K60000000000000000000001',
  'sales','transforming',0.7,false
);

SELECT pg_temp.assert_true(
  (SELECT count(*)=0 FROM control_plane.claim_canonical_transform_job(
    'progressive-worker','progressive-v1',300
  )),
  'no page may transform before its complete extraction phase is terminal'
);
UPDATE control_plane.sync_stream_phases
   SET status='succeeded',completed_at=now()
 WHERE tenant_id='01K60000000000000000000000'
   AND connection_id='01K60000000000000000000001'
   AND stream IN ('items','sales');

SELECT * FROM control_plane.claim_canonical_transform_job(
  'progressive-worker','progressive-v1',300
) \gset items_page_one_
SELECT pg_temp.assert_true(:'items_page_one_stream'='items','the first master page must claim first');
SELECT control_plane.complete_canonical_transform_job(
  :'items_page_one_tenant_id',:'items_page_one_transform_job_id','progressive-worker',
  :'items_page_one_lease_token','{"qualityStatus":"passed"}'::jsonb
);
SELECT pg_temp.assert_true(
  (SELECT status='pending' FROM control_plane.progressive_stream_coverage
    WHERE tenant_id='01K60000000000000000000000'
      AND connection_id='01K60000000000000000000001' AND stream='items'),
  'the first of two master pages must not become queryable'
);

SELECT * FROM control_plane.claim_canonical_transform_job(
  'progressive-worker','progressive-v1',300
) \gset items_page_two_
SELECT pg_temp.assert_true(:'items_page_two_stream'='items','the second master page must precede sales');
SELECT control_plane.complete_canonical_transform_job(
  :'items_page_two_tenant_id',:'items_page_two_transform_job_id','progressive-worker',
  :'items_page_two_lease_token','{"qualityStatus":"passed"}'::jsonb
);
SELECT pg_temp.assert_true(
  (SELECT status='queryable' FROM control_plane.progressive_stream_coverage
    WHERE tenant_id='01K60000000000000000000000'
      AND connection_id='01K60000000000000000000001' AND stream='items'),
  'a master becomes queryable only after every landed page transforms'
);

SELECT * FROM control_plane.claim_canonical_transform_job(
  'progressive-worker','progressive-v1',300
) \gset sales_page_one_
SELECT pg_temp.assert_true(:'sales_page_one_stream'='sales','sales may claim only after its master dependency');
SELECT control_plane.complete_canonical_transform_job(
  :'sales_page_one_tenant_id',:'sales_page_one_transform_job_id','progressive-worker',
  :'sales_page_one_lease_token','{"qualityStatus":"passed"}'::jsonb
);
SELECT pg_temp.assert_true(
  (SELECT status='pending' FROM control_plane.progressive_stream_coverage
    WHERE tenant_id='01K60000000000000000000000'
      AND connection_id='01K60000000000000000000001' AND stream='sales'),
  'the first of two recent sales pages must remain unavailable'
);

SELECT * FROM control_plane.claim_canonical_transform_job(
  'progressive-worker','progressive-v1',300
) \gset sales_page_two_
SELECT pg_temp.assert_true(:'sales_page_two_stream'='sales','the terminal recent sales page must claim');
SELECT control_plane.complete_canonical_transform_job(
  :'sales_page_two_tenant_id',:'sales_page_two_transform_job_id','progressive-worker',
  :'sales_page_two_lease_token','{"qualityStatus":"warning"}'::jsonb
);
SELECT pg_temp.assert_true(
  (SELECT status='queryable' AND covered_from='2026-07-03T00:00:00Z'
          AND covered_to='2026-08-03T00:00:00Z'
     FROM control_plane.progressive_stream_coverage
    WHERE tenant_id='01K60000000000000000000000'
      AND connection_id='01K60000000000000000000001' AND stream='sales'),
  'recent coverage must publish its exact qualified range after both pages'
);
SELECT pg_temp.assert_true(
  (SELECT state='ready_partial' AND covered_from='2026-07-03T00:00:00Z'
          AND covered_to='2026-08-03T00:00:00Z'
          AND reconciliation_status='scheduled'
     FROM control_plane.readiness
    WHERE tenant_id='01K60000000000000000000000'
      AND connection_id='01K60000000000000000000001' AND domain='sales'),
  'deferred full-history quality must remain qualified, not block ready_partial'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=1 FROM control_plane.progressive_reconciliation_requests
    WHERE tenant_id='01K60000000000000000000000'
      AND connection_id='01K60000000000000000000001'
      AND connection_generation=1),
  'the last required stream must schedule exactly one immediate reconciliation'
);

-- The control cell, not a batch-local flag, selects the applicable quality
-- tier. A fully extracted stream with incomplete reconciliation remains
-- queryable as partial instead of being certified complete or revoked.
INSERT INTO control_plane.stream_cursors(
  tenant_id,connection_id,stream,cursor_value,source_watermark,
  last_successful_sync_at,backfill_complete,connection_generation
) VALUES
  ('01K60000000000000000000000','01K60000000000000000000001','items',
   '{"value":"items-complete"}'::jsonb,now(),now(),true,1),
  ('01K60000000000000000000000','01K60000000000000000000001','sales',
   '{"value":"sales-complete"}'::jsonb,now(),now(),true,1)
ON CONFLICT (tenant_id,connection_id,stream) DO UPDATE SET
  backfill_complete=excluded.backfill_complete,
  connection_generation=excluded.connection_generation,
  source_watermark=excluded.source_watermark;

SELECT set_config('albert.tenant_id','01K60000000000000000000000',true);
SELECT pg_temp.assert_true(
  (
    SELECT snapshot->>'worstState'='incomplete'
      FROM (
        SELECT control_plane.sync_readiness_inputs(
          '01K60000000000000000000000','01K60000000000000000000001',
          ARRAY['sales'],'01K60000000000000000000041','warning','blocked'
        ) AS snapshot
      ) scoped
  ),
  'complete-quality blockers must hold a complete cursor at ready_partial'
);
SELECT pg_temp.assert_true(
  (
    SELECT snapshot->>'worstState'='blocked'
      FROM (
        SELECT control_plane.sync_readiness_inputs(
          '01K60000000000000000000000','01K60000000000000000000001',
          ARRAY['sales'],'01K60000000000000000000041','blocked','blocked'
        ) AS snapshot
      ) scoped
  ),
  'a critical partial-quality blocker must still fail closed'
);
DO $$
BEGIN
  BEGIN
    PERFORM control_plane.sync_readiness_inputs(
      '01K60000000000000000000000','01K60000000000000000000001',
      ARRAY['sales'],'01K60000000000000000000041','blocked','passed'
    );
    RAISE EXCEPTION 'a stronger complete tier was accepted over blocked partial quality';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END;
$$;

INSERT INTO control_plane.sync_runs(
  tenant_id,sync_run_id,connection_id,job_type,stream,status,attempt_number,
  scheduled_at,started_at,finished_at,connection_generation,backfill_phase,replay_version
) VALUES (
  '01K60000000000000000000000','01K60000000000000000000050',
  '01K60000000000000000000001','InitialBackfill','sales','succeeded',1,
  now(),now(),now(),1,'full_history',1
);
INSERT INTO control_plane.raw_batch_manifests(
  tenant_id,batch_id,connection_id,sync_run_id,connector_key,connector_version,
  api_version,stream,extracted_at,content_hash,schema_fingerprint,record_count,
  compressed_bytes,object_keys
) VALUES (
  '01K60000000000000000000000','01K60000000000000000000051',
  '01K60000000000000000000001','01K60000000000000000000050',
  'lightspeed-r','1.0.0','v3','sales',now(),repeat('e',64),repeat('f',64),1,100,
  ARRAY['raw/sales-full-history.gz']
);
INSERT INTO control_plane.raw_batch_landings(
  tenant_id,batch_id,status,staged_record_count,quarantine_count,analytical_committed_at
) VALUES (
  '01K60000000000000000000000','01K60000000000000000000051',
  'landed',1,0,now()
);
INSERT INTO control_plane.canonical_transform_jobs(
  tenant_id,transform_job_id,batch_id,sync_run_id,connection_id,connector_id,
  stream,domains,mapping_version,backfill_complete,status,attempt_count,
  lease_owner,lease_token,lease_expires_at,started_at,connection_generation
) VALUES (
  '01K60000000000000000000000','01K60000000000000000000052',
  '01K60000000000000000000051','01K60000000000000000000050',
  '01K60000000000000000000001','lightspeed-r','sales',ARRAY['sales'],
  'progressive-v1',true,'running',1,'progressive-worker',
  '01K60000000000000000000053',now()+interval '5 minutes',now(),1
);

SELECT control_plane.complete_canonical_transform_job(
  '01K60000000000000000000000','01K60000000000000000000052',
  'progressive-worker','01K60000000000000000000053',
  '{"qualityStatus":"blocked","partialQualityStatus":"warning","completeQualityStatus":"blocked"}'::jsonb
);
SELECT pg_temp.assert_true(
  (
    SELECT state='ready_partial' AND backfill_complete
       AND progress=0.95
       AND reason_code='complete_quality_pending'
      FROM control_plane.readiness
     WHERE tenant_id='01K60000000000000000000000'
       AND connection_id='01K60000000000000000000001' AND domain='sales'
  ),
  'full-history completion must not bypass its complete-quality gate'
);

-- A transform that has not run yet carries no quality outcome. Scoring that
-- absence as a critical blocker made every queued page drop the domain to
-- blocked readiness until it drained; work in flight must read the same way as
-- work never started, which the 'incomplete' branch already models.
INSERT INTO control_plane.raw_batch_manifests(
  tenant_id,batch_id,connection_id,sync_run_id,connector_key,connector_version,
  api_version,stream,extracted_at,content_hash,schema_fingerprint,record_count,
  compressed_bytes,object_keys
) VALUES (
  '01K60000000000000000000000','01K60000000000000000000060',
  '01K60000000000000000000001','01K60000000000000000000050',
  'lightspeed-r','1.0.0','v3','sales',now(),repeat('1',64),repeat('2',64),1,100,
  ARRAY['raw/sales-pending.gz']
);
INSERT INTO control_plane.raw_batch_landings(
  tenant_id,batch_id,status,staged_record_count,quarantine_count,analytical_committed_at
) VALUES (
  '01K60000000000000000000000','01K60000000000000000000060','landed',1,0,now()
);
INSERT INTO control_plane.canonical_transform_jobs(
  tenant_id,transform_job_id,batch_id,sync_run_id,connection_id,connector_id,
  stream,domains,mapping_version,backfill_complete,status,attempt_count,
  connection_generation,created_at
) VALUES (
  '01K60000000000000000000000','01K60000000000000000000061',
  '01K60000000000000000000060','01K60000000000000000000050',
  '01K60000000000000000000001','lightspeed-r','sales',ARRAY['sales'],
  'progressive-v1',true,'queued',0,1,now()+interval '1 minute'
);

SELECT set_config('albert.tenant_id','01K60000000000000000000000',true);
SELECT pg_temp.assert_true(
  (
    SELECT snapshot->>'worstState'='incomplete'
       AND snapshot->'streams'->0->>'transformStatus'='queued'
       AND snapshot->'streams'->0->>'partialQualityStatus' IS NULL
      FROM (
        SELECT control_plane.sync_readiness_inputs(
          '01K60000000000000000000000','01K60000000000000000000001',
          ARRAY['sales'],'01K60000000000000000000041','warning','warning'
        ) AS snapshot
      ) scoped
  ),
  'a queued transform must read as incomplete, not as a quality blocker'
);

UPDATE control_plane.canonical_transform_jobs
   SET status='retry_wait'
 WHERE tenant_id='01K60000000000000000000000'
   AND transform_job_id='01K60000000000000000000061';
SELECT pg_temp.assert_true(
  (
    SELECT snapshot->>'worstState'='incomplete'
      FROM (
        SELECT control_plane.sync_readiness_inputs(
          '01K60000000000000000000000','01K60000000000000000000001',
          ARRAY['sales'],'01K60000000000000000000041','warning','warning'
        ) AS snapshot
      ) scoped
  ),
  'a retryable transform serving its backoff is in flight, not terminal'
);

-- The fail-closed default still belongs to a job that claims to have finished:
-- a succeeded transform without quality evidence is an invariant breach.
UPDATE control_plane.canonical_transform_jobs
   SET status='succeeded',result_metadata='{}'::jsonb,
       started_at=now()+interval '1 minute',completed_at=now()+interval '2 minutes'
 WHERE tenant_id='01K60000000000000000000000'
   AND transform_job_id='01K60000000000000000000061';
SELECT pg_temp.assert_true(
  (
    SELECT snapshot->>'worstState'='blocked'
      FROM (
        SELECT control_plane.sync_readiness_inputs(
          '01K60000000000000000000000','01K60000000000000000000001',
          ARRAY['sales'],'01K60000000000000000000041','warning','warning'
        ) AS snapshot
      ) scoped
  ),
  'a succeeded transform without quality evidence must still fail closed'
);

-- A permanently failed transform blocks on its own status and needs no
-- synthesised quality opinion.
UPDATE control_plane.canonical_transform_jobs
   SET status='failed',result_metadata=NULL,completed_at=now()+interval '2 minutes'
 WHERE tenant_id='01K60000000000000000000000'
   AND transform_job_id='01K60000000000000000000061';
SELECT pg_temp.assert_true(
  (
    SELECT snapshot->>'worstState'='blocked'
      FROM (
        SELECT control_plane.sync_readiness_inputs(
          '01K60000000000000000000000','01K60000000000000000000001',
          ARRAY['sales'],'01K60000000000000000000041','warning','warning'
        ) AS snapshot
      ) scoped
  ),
  'a failed transform must still block on its terminal status'
);

-- The quality gates run once per sync run, on the page that completes its
-- stream. An earlier page carries fail-closed placeholders it never measured,
-- so it must assert no verdict at all rather than a blocking one.
UPDATE control_plane.canonical_transform_jobs
   SET status='succeeded',
       result_metadata='{"qualityEvaluated":false,"qualityStatus":"blocked",
         "partialQualityStatus":"blocked","completeQualityStatus":"blocked"}'::jsonb,
       started_at=now()+interval '1 minute',completed_at=now()+interval '2 minutes'
 WHERE tenant_id='01K60000000000000000000000'
   AND transform_job_id='01K60000000000000000000061';
SELECT pg_temp.assert_true(
  (
    SELECT snapshot->>'worstState'='incomplete'
       AND snapshot->'streams'->0->>'partialQualityStatus' IS NULL
      FROM (
        SELECT control_plane.sync_readiness_inputs(
          '01K60000000000000000000000','01K60000000000000000000001',
          ARRAY['sales'],'01K60000000000000000000041','warning','warning'
        ) AS snapshot
      ) scoped
  ),
  'an ungated page must assert no quality verdict'
);

-- ...and an ungated page must not drag a settled readiness back down.
UPDATE control_plane.readiness
   SET state='ready_complete',progress=1,reason_code=NULL,reason_detail=NULL
 WHERE tenant_id='01K60000000000000000000000'
   AND connection_id='01K60000000000000000000001' AND domain='sales';
INSERT INTO control_plane.raw_batch_manifests(
  tenant_id,batch_id,connection_id,sync_run_id,connector_key,connector_version,
  api_version,stream,extracted_at,content_hash,schema_fingerprint,record_count,
  compressed_bytes,object_keys
) VALUES (
  '01K60000000000000000000000','01K60000000000000000000070',
  '01K60000000000000000000001','01K60000000000000000000050',
  'lightspeed-r','1.0.0','v3','sales',now(),repeat('3',64),repeat('4',64),1,100,
  ARRAY['raw/sales-ungated.gz']
);
INSERT INTO control_plane.raw_batch_landings(
  tenant_id,batch_id,status,staged_record_count,quarantine_count,analytical_committed_at
) VALUES (
  '01K60000000000000000000000','01K60000000000000000000070','landed',1,0,now()
);
INSERT INTO control_plane.canonical_transform_jobs(
  tenant_id,transform_job_id,batch_id,sync_run_id,connection_id,connector_id,
  stream,domains,mapping_version,backfill_complete,status,attempt_count,
  lease_owner,lease_token,lease_expires_at,started_at,connection_generation
) VALUES (
  '01K60000000000000000000000','01K60000000000000000000071',
  '01K60000000000000000000070','01K60000000000000000000050',
  '01K60000000000000000000001','lightspeed-r','sales',ARRAY['sales'],
  'progressive-v1',true,'running',1,'progressive-worker',
  '01K60000000000000000000072',now()+interval '5 minutes',now(),1
);
SELECT control_plane.complete_canonical_transform_job(
  '01K60000000000000000000000','01K60000000000000000000071',
  'progressive-worker','01K60000000000000000000072',
  '{"qualityEvaluated":false,"qualityStatus":"blocked",
    "partialQualityStatus":"blocked","completeQualityStatus":"blocked"}'::jsonb
);
SELECT pg_temp.assert_true(
  (
    SELECT state='ready_complete' AND progress=1 AND reason_code IS NULL
      FROM control_plane.readiness
     WHERE tenant_id='01K60000000000000000000000'
       AND connection_id='01K60000000000000000000001' AND domain='sales'
  ),
  'an ungated page must not cap a settled readiness'
);

ROLLBACK;
