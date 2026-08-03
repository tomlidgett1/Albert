\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean, message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'operator-console assertion failed: %', message;
  END IF;
END;
$$;

INSERT INTO auth.users (
  id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) VALUES (
  '30000000-0000-4000-8000-000000000003','authenticated','authenticated',
  'operator-console@albert.invalid','',now(),'{}','{}',now(),now()
);

INSERT INTO control_plane.internal_operators (
  user_id,email,reason
) VALUES (
  '30000000-0000-4000-8000-000000000003',
  'operator-console@albert.invalid',
  'CI operator-console verification'
);

INSERT INTO control_plane.tenants (
  tenant_id,slug,display_name,created_by
) VALUES (
  '01K1ZZZZZZ0000000000000100','operator-console-fixture','Operator Console Fixture',
  '30000000-0000-4000-8000-000000000003'
);

INSERT INTO control_plane.tenant_overlays (
  tenant_id,overlay_id,version,status,overlay,change_reason,created_by,published_at
) VALUES (
  '01K1ZZZZZZ0000000000000100','01K1ZZZZZZ0000000000000101',1,'published',
  '{"timezone":"Australia/Sydney"}','Operator console fixture',
  '30000000-0000-4000-8000-000000000003',now()
);

INSERT INTO control_plane.connections (
  tenant_id,connection_id,connector_key,display_name,external_account_reference,
  status,auth_health,authorised_by,authorised_at,last_checked_at
) VALUES (
  '01K1ZZZZZZ0000000000000100','01K1ZZZZZZ0000000000000102','xero','Fixture Xero','xero-fixture',
  'connected','healthy','30000000-0000-4000-8000-000000000003',now()-interval '2 days',now()
);

INSERT INTO control_plane.oauth_token_refs (
  tenant_id,token_ref_id,connection_id,secret_reference,encryption_key_version,
  granted_scopes,token_expires_at,last_rotated_at
) VALUES (
  '01K1ZZZZZZ0000000000000100','01K1ZZZZZZ0000000000000103',
  '01K1ZZZZZZ0000000000000102','operator-console-secret-ref','fixture-key-v1',
  ARRAY['accounting.transactions','offline_access'],now()+interval '20 minutes',now()-interval '10 minutes'
);

INSERT INTO control_plane.stream_cursors (
  tenant_id,connection_id,stream,cursor_value,source_watermark,
  last_successful_sync_at,backfill_complete,cursor_requested_at
) VALUES (
  '01K1ZZZZZZ0000000000000100','01K1ZZZZZZ0000000000000102','invoices',
  '{"modified_since":"2026-08-03T06:00:00Z"}',now()-interval '4 minutes',
  now()-interval '3 minutes',false,now()-interval '5 minutes'
);

INSERT INTO control_plane.readiness (
  tenant_id,connection_id,domain,state,progress,data_ready_through,
  backfill_complete,reason_code,reason_detail,evaluated_at
) VALUES (
  '01K1ZZZZZZ0000000000000100','01K1ZZZZZZ0000000000000102','finance',
  'degraded',0.82,now()-interval '4 minutes',false,'journal_balances',
  'One projected quality check needs operator attention.',now()
);

INSERT INTO control_plane.sync_runs (
  tenant_id,sync_run_id,connection_id,job_type,stream,status,attempt_number,
  record_count,quarantine_count,scheduled_at,started_at,finished_at
) VALUES (
  '01K1ZZZZZZ0000000000000100','01K1ZZZZZZ0000000000000104',
  '01K1ZZZZZZ0000000000000102','IncrementalSync','invoices','succeeded',1,
  4,1,now()-interval '6 minutes',now()-interval '5 minutes',now()-interval '3 minutes'
);

INSERT INTO control_plane.raw_batch_manifests (
  tenant_id,batch_id,connection_id,sync_run_id,connector_key,connector_version,
  api_version,stream,extracted_at,cursor_start,cursor_end,content_hash,
  schema_fingerprint,record_count,compressed_bytes,object_keys
) VALUES (
  '01K1ZZZZZZ0000000000000100','01K1ZZZZZZ0000000000000105',
  '01K1ZZZZZZ0000000000000102','01K1ZZZZZZ0000000000000104','xero','1.0.0',
  '2.0','invoices',now()-interval '4 minutes','{}','{"page":2}',repeat('a',64),
  repeat('b',64),5,1024,ARRAY['tenant/fixture/connection/xero/stream/invoices/batch.jsonl.gz']
);

INSERT INTO control_plane.raw_batch_landings (
  tenant_id,batch_id,status,staged_record_count,quarantine_count,
  analytical_committed_at,attempt_count
) VALUES (
  '01K1ZZZZZZ0000000000000100','01K1ZZZZZZ0000000000000105',
  'landed',4,1,now()-interval '3 minutes',1
);

INSERT INTO control_plane.sync_job_requests (
  tenant_id,job_request_id,connection_id,idempotency_key,job_type,priority,
  queue_name,payload,status,available_at,last_claimed_at,completed_at,created_at
) VALUES (
  '01K1ZZZZZZ0000000000000100','01K1ZZZZZZ0000000000000106',
  '01K1ZZZZZZ0000000000000102','operator-console-job-fixture','IncrementalSync','standard',
  'albert_sync_standard','{"stream":"invoices"}','succeeded',
  now()-interval '6 minutes',now()-interval '5 minutes',now()-interval '3 minutes',now()-interval '6 minutes'
);

INSERT INTO control_plane.sync_job_attempts (
  tenant_id,job_attempt_id,job_request_id,attempt_number,worker_id,
  visibility_deadline,started_at,finished_at,outcome
) VALUES (
  '01K1ZZZZZZ0000000000000100','01K1ZZZZZZ0000000000000107',
  '01K1ZZZZZZ0000000000000106',1,'fixture-worker',now()-interval '2 minutes',
  now()-interval '5 minutes',now()-interval '3 minutes','succeeded'
);

INSERT INTO control_plane.sync_job_attempt_outcomes (
  tenant_id,job_attempt_outcome_id,job_attempt_id,outcome,finished_at
) VALUES (
  '01K1ZZZZZZ0000000000000100','01K1ZZZZZZ0000000000000108',
  '01K1ZZZZZZ0000000000000107','succeeded',now()-interval '3 minutes'
);

INSERT INTO control_plane.canonical_transform_jobs (
  tenant_id,transform_job_id,batch_id,sync_run_id,connection_id,connector_id,
  connection_generation,stream,domains,mapping_version,backfill_complete,status,attempt_count,
  started_at,completed_at,created_at
) VALUES (
  '01K1ZZZZZZ0000000000000100','01K1ZZZZZZ0000000000000109',
  '01K1ZZZZZZ0000000000000105','01K1ZZZZZZ0000000000000104',
  '01K1ZZZZZZ0000000000000102','xero',1,'invoices',ARRAY['finance'],'fixture-v1',
  false,'succeeded',1,now()-interval '3 minutes',now()-interval '2 minutes',now()-interval '3 minutes'
);

INSERT INTO control_plane.webhook_receipts (
  tenant_id,webhook_receipt_id,connection_id,connector_key,dedupe_key,body_sha256,
  signature_verified,status,routed_streams,received_at,queued_at
) VALUES (
  '01K1ZZZZZZ0000000000000100','01K1ZZZZZZ0000000000000110',
  '01K1ZZZZZZ0000000000000102','xero','operator-console-webhook',repeat('c',64),
  true,'queued',ARRAY['invoices'],now()-interval '4 minutes',now()-interval '4 minutes'
);

INSERT INTO control_plane.quarantine_items (
  tenant_id,quarantine_item_id,connection_id,sync_run_id,batch_id,stream,
  source_object_type,source_record_id,payload_hash,raw_object_key,error_code,
  error_path,error_summary,status
) VALUES (
  '01K1ZZZZZZ0000000000000100','01K1ZZZZZZ0000000000000111',
  '01K1ZZZZZZ0000000000000102','01K1ZZZZZZ0000000000000104',
  '01K1ZZZZZZ0000000000000105','invoices','Invoice','invoice-fixture',repeat('d',64),
  'tenant/fixture/connection/xero/stream/invoices/batch.jsonl.gz','schema.invalid',
  '$.LineItems[0]','Fixture field did not satisfy the pinned source schema.','open'
);

INSERT INTO control_plane.vendor_rate_budgets (
  tenant_id,connection_id,budget_key,window_started_at,window_ends_at,
  request_limit,requests_used,remaining,vendor_reset_at,observed_headers
) VALUES (
  '01K1ZZZZZZ0000000000000100','01K1ZZZZZZ0000000000000102','xero.daily',
  date_trunc('day',now()),date_trunc('day',now())+interval '1 day',5000,120,4880,
  date_trunc('day',now())+interval '1 day','{}'
);

INSERT INTO control_plane.pipeline_stats (
  tenant_id,snapshot_at,schema_name,table_name,row_count,max_event_at,
  max_ingested_at,invariant_status
) VALUES
  ('01K1ZZZZZZ0000000000000100',now()-interval '2 minutes','source_xero','invoices',5,now()-interval '4 minutes',now()-interval '3 minutes','{"line_maths":"passed","journal_balances":"warning"}'),
  ('01K1ZZZZZZ0000000000000100',now()-interval '2 minutes','core','finance_invoice_line',4,now()-interval '4 minutes',now()-interval '2 minutes','{"line_maths":"passed","journal_balances":"warning"}'),
  ('01K1ZZZZZZ0000000000000100',now()-interval '2 minutes','mart','finance_day_location',1,now()-interval '4 minutes',now()-interval '2 minutes','{"line_maths":"passed","journal_balances":"warning"}');

INSERT INTO control_plane.worker_heartbeats (
  worker_id,service_version,deployment_id,started_at,last_seen_at,active_job_count
) VALUES ('fixture-worker','fixture-v1','fixture-deploy',now()-interval '1 hour',now(),0);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"30000000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{}}',
  true
);

SELECT pg_temp.assert_true(public.albert_operator_status(), 'allowlisted operator must be recognised');

SELECT pg_temp.assert_true(
  jsonb_array_length(jsonb_path_query_array(
    public.albert_operator_fleet(),
    '$.connections[*] ? (@.connection_id == "01K1ZZZZZZ0000000000000102")'
  )) = 1,
  'fleet must return the tenant connection'
);
SELECT pg_temp.assert_true(
  jsonb_path_query_first(
    public.albert_operator_fleet(),
    '$.connections[*] ? (@.connection_id == "01K1ZZZZZZ0000000000000102")'
  )->>'token_expires_at' IS NOT NULL,
  'fleet must return token expiry metadata without credential references'
);
SELECT pg_temp.assert_true(
  jsonb_array_length(jsonb_path_query_first(
    public.albert_operator_fleet(),
    '$.connections[*] ? (@.connection_id == "01K1ZZZZZZ0000000000000102")'
  )->'quality_failures') = 1,
  'fleet must surface projected failing quality checks'
);

SELECT pg_temp.assert_true(
  public.albert_operator_pipeline('01K1ZZZZZZ0000000000000100')->'tenant'->>'timezone' = 'Australia/Sydney',
  'pipeline overview must resolve the published tenant timezone'
);
SELECT pg_temp.assert_true(
  (public.albert_operator_pipeline('01K1ZZZZZZ0000000000000100')->'stage_counts'->>'canonical')::integer = 1,
  'pipeline overview must count the latest canonical snapshot'
);

DO $$
DECLARE
  stage text;
  detail jsonb;
BEGIN
  FOREACH stage IN ARRAY ARRAY[
    'connections','streams','raw','staging','canonical','marts',
    'quality','readiness','runs','jobs','quarantine','budgets'
  ] LOOP
    detail := public.albert_operator_pipeline_stage('01K1ZZZZZZ0000000000000100',stage);
    PERFORM pg_temp.assert_true(detail->>'stage'=stage,'drill-down stage must round-trip');
    PERFORM pg_temp.assert_true(jsonb_array_length(detail->'groups')>0,'drill-down must return at least one group');
    PERFORM pg_temp.assert_true(jsonb_array_length(detail->'groups'->0->'rows')>0,'fixture drill-down must return metadata rows');
  END LOOP;

  BEGIN
    PERFORM public.albert_operator_pipeline_stage('01K1ZZZZZZ0000000000000100','source_sql');
    RAISE EXCEPTION 'invalid operator stage was unexpectedly accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END;
$$;

RESET ROLE;

SELECT pg_temp.assert_true(
  (SELECT count(*) = 17 FROM control_plane.operator_audit_log
    WHERE actor_user_id='30000000-0000-4000-8000-000000000003'),
  'fleet, pipeline and each drill-down must be audit logged'
);
SELECT pg_temp.assert_true(
  (SELECT count(DISTINCT request_metadata->>'stage')=12
    FROM control_plane.operator_audit_log
    WHERE action='operator.pipeline_drilldown'
      AND actor_user_id='30000000-0000-4000-8000-000000000003'),
  'every allowlisted stage must carry its name in immutable audit metadata'
);

ROLLBACK;
