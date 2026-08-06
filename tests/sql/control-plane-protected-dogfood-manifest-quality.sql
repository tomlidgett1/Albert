\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean,message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'protected dogfood manifest/quality assertion failed: %',message;
  END IF;
END;
$$;

CREATE TEMP TABLE dogfood_stream_seed ON COMMIT DROP AS
WITH selected(connector_key,connection_id) AS (VALUES
  ('lightspeed-r','01H00000000000000000005411'),
  ('xero','01H00000000000000000005412'),
  ('deputy','01H00000000000000000005413')
)
SELECT expected.*,selected.connection_id,
       clock_timestamp() AS plan_at,
       control_plane.generate_ulid() AS sync_run_id,
       control_plane.generate_ulid() AS batch_id,
       control_plane.generate_ulid() AS reconciliation_sweep_id
  FROM control_plane.protected_dogfood_stream_expectation expected
  JOIN selected USING(connector_key);

CREATE TEMP TABLE dogfood_stats_inventory (
  schema_name text NOT NULL,
  table_name text NOT NULL,
  PRIMARY KEY(schema_name,table_name)
) ON COMMIT DROP;
INSERT INTO dogfood_stats_inventory(schema_name,table_name) VALUES
  ('core','commerce_order'),
  ('mart','sales_daily');

INSERT INTO control_plane.connections(
  tenant_id,connection_id,connector_key,display_name,status,auth_health,
  external_account_reference,connection_generation,created_at,updated_at
)
SELECT '01H00000000000000000005401',connection_id,connector_key,
       'Dogfood '||connector_key,'connected','healthy','account-'||connector_key,
       1,clock_timestamp(),clock_timestamp()
  FROM (SELECT DISTINCT connector_key,connection_id FROM dogfood_stream_seed) selected;

INSERT INTO control_plane.sync_stream_phases(
  tenant_id,connection_id,connection_generation,stream,phase,phase_ordinal,
  plan_mode,backfill_strategy,required,domains,dependencies,range_from,range_to,
  predecessor_phase,status,replay_version,dependency_plan_sealed,
  completed_at,created_at,updated_at
)
SELECT '01H00000000000000000005401',seed.connection_id,1,seed.stream,
       phase.phase,phase.ordinal,
       CASE WHEN seed.backfill_strategy='time_windowed' THEN 'progressive' ELSE 'single_pass' END,
       seed.backfill_strategy,seed.required,seed.domains,seed.dependencies,
       CASE phase.ordinal
         WHEN 1 THEN seed.plan_at-interval '30 days'
         WHEN 2 THEN seed.plan_at-interval '13 months'
         ELSE timestamptz '2000-01-01 00:00:00+00'
       END,
       CASE phase.ordinal
         WHEN 1 THEN seed.plan_at
         WHEN 2 THEN seed.plan_at-interval '30 days'
         ELSE seed.plan_at-interval '13 months'
       END,
       CASE phase.ordinal WHEN 2 THEN 'recent' WHEN 3 THEN 'thirteen_months' END,
       'succeeded',1,true,clock_timestamp(),clock_timestamp(),clock_timestamp()
  FROM dogfood_stream_seed seed
  CROSS JOIN LATERAL (
    SELECT value::text AS phase,ordinality::smallint AS ordinal
      FROM unnest(
        CASE WHEN seed.backfill_strategy='time_windowed'
          THEN ARRAY['recent','thirteen_months','full_history']::text[]
          ELSE ARRAY['recent']::text[]
        END
      ) WITH ORDINALITY AS expanded(value,ordinality)
  ) phase;

INSERT INTO control_plane.sync_runs(
  tenant_id,sync_run_id,connection_id,connection_generation,job_type,stream,status,
  record_count,quarantine_count,started_at,finished_at,created_at
)
SELECT '01H00000000000000000005401',sync_run_id,connection_id,1,
       'InitialBackfill',stream,'succeeded',1,0,
       clock_timestamp(),clock_timestamp(),clock_timestamp()
  FROM dogfood_stream_seed;

INSERT INTO control_plane.raw_batch_manifests(
  tenant_id,batch_id,connection_id,sync_run_id,connector_key,connector_version,
  api_version,stream,extracted_at,content_hash,schema_fingerprint,
  record_count,compressed_bytes,object_keys,created_at
)
SELECT '01H00000000000000000005401',batch_id,connection_id,sync_run_id,
       connector_key,pack_version,api_version,stream,clock_timestamp(),
       encode(extensions.digest(convert_to(connector_key||':'||stream,'UTF8'),'sha256'),'hex'),
       encode(extensions.digest(convert_to('schema:'||connector_key||':'||stream,'UTF8'),'sha256'),'hex'),
       1,100,ARRAY['raw/'||batch_id||'.ndjson.gz'],clock_timestamp()
  FROM dogfood_stream_seed;

INSERT INTO control_plane.raw_batch_landings(
  tenant_id,batch_id,status,staged_record_count,quarantine_count,
  analytical_committed_at,attempt_count,updated_at
)
SELECT '01H00000000000000000005401',batch_id,'landed',1,0,
       clock_timestamp(),1,clock_timestamp()
  FROM dogfood_stream_seed;

INSERT INTO control_plane.stream_cursors(
  tenant_id,connection_id,connection_generation,stream,cursor_value,
  source_watermark,last_successful_sync_at,backfill_complete,updated_at
)
SELECT '01H00000000000000000005401',connection_id,1,stream,'{}'::jsonb,
       clock_timestamp(),clock_timestamp(),true,clock_timestamp()
  FROM dogfood_stream_seed;

INSERT INTO control_plane.reconciliation_stream_sweeps(
  tenant_id,connection_id,connection_generation,reconciliation_sweep_id,
  connector_id,stream,required,domains,late_edit_strategy,deletion_strategy,
  source_total_strategy,lookback_from,lookback_to,current_phase,status,
  phase_evidence,phase_transition_leases,completed_at,created_at,updated_at
)
SELECT '01H00000000000000000005401',connection_id,1,reconciliation_sweep_id,
       connector_key,stream,required,domains,
       late_edit_strategy,deletion_strategy,source_total_strategy,
       clock_timestamp()-interval '2 days',clock_timestamp(),'complete','complete',
       '{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp(),clock_timestamp()
  FROM dogfood_stream_seed;

WITH quality(value) AS (
  SELECT jsonb_object_agg(check_id,'passed' ORDER BY check_id)
    FROM control_plane.protected_dogfood_quality_expectation
), snapshot(value) AS (
  SELECT clock_timestamp()
), quality_run(value) AS (
  SELECT sync_run_id
    FROM dogfood_stream_seed
   WHERE connector_key='xero' AND stream='xero_invoices'
), inventory_attestation(table_count,inventory_hash) AS (
  SELECT count(*)::integer,
         encode(extensions.digest(convert_to(
           jsonb_agg(
             jsonb_build_array(inventory.schema_name,inventory.table_name)
             ORDER BY inventory.schema_name COLLATE "C",
                      inventory.table_name COLLATE "C"
           )::text,
           'UTF8'
         ),'sha256'),'hex')
    FROM dogfood_stats_inventory inventory
)
INSERT INTO control_plane.pipeline_stats(
  tenant_id,snapshot_at,schema_name,table_name,row_count,
  max_event_at,max_ingested_at,invariant_status,quality_run_id,quality_checked_at,
  snapshot_table_count,snapshot_inventory_hash,created_at
)
SELECT '01H00000000000000000005401',snapshot.value,
       inventory.schema_name,inventory.table_name,1,
       clock_timestamp(),clock_timestamp(),quality.value,quality_run.value,
       snapshot.value,attestation.table_count,attestation.inventory_hash,
       clock_timestamp()
  FROM quality
  CROSS JOIN snapshot
  CROSS JOIN quality_run
  CROSS JOIN inventory_attestation attestation
  CROSS JOIN dogfood_stats_inventory inventory;

-- A valid exact projection with the analytical count and content digest is the
-- positive control for every fail-closed mutation below.
SELECT control_plane.assert_protected_dogfood_manifest_and_quality(
  '01H00000000000000000005401',
  '{
    "lightspeed-r":"01H00000000000000000005411",
    "xero":"01H00000000000000000005412",
    "deputy":"01H00000000000000000005413"
  }'::jsonb,
  clock_timestamp()-interval '5 minutes'
);

DO $$
BEGIN
  PERFORM control_plane.assert_protected_dogfood_manifest_and_quality(
    '01H00000000000000000005401',
    '{"lightspeed-r":"01H00000000000000000005411","xero":null,"deputy":"01H00000000000000000005413"}'::jsonb,
    clock_timestamp()-interval '5 minutes'
  );
  RAISE EXCEPTION 'a JSON-null connection selector passed input validation';
EXCEPTION WHEN SQLSTATE '22023' THEN
  IF SQLERRM NOT LIKE '%gate input is invalid%' THEN RAISE; END IF;
END;
$$;

DO $$
BEGIN
  INSERT INTO control_plane.pipeline_stats(
    tenant_id,snapshot_at,schema_name,table_name,row_count,max_event_at,
    max_ingested_at,invariant_status,quality_run_id,quality_checked_at,
    snapshot_table_count,snapshot_inventory_hash,created_at
  )
  SELECT tenant_id,snapshot_at,schema_name,table_name,row_count,max_event_at,
         max_ingested_at,invariant_status,quality_run_id,quality_checked_at,
         snapshot_table_count,snapshot_inventory_hash,created_at
    FROM control_plane.pipeline_stats
   WHERE tenant_id='01H00000000000000000005401'
   ORDER BY schema_name,table_name
   LIMIT 1;
  RAISE EXCEPTION 'a duplicate projected table bypassed the primary-key fence';
EXCEPTION WHEN unique_violation THEN
  NULL;
END;
$$;

DO $$
BEGIN
  DELETE FROM control_plane.pipeline_stats
   WHERE tenant_id='01H00000000000000000005401'
     AND schema_name='mart' AND table_name='sales_daily';
  PERFORM control_plane.assert_protected_dogfood_manifest_and_quality(
    '01H00000000000000000005401',
    '{"lightspeed-r":"01H00000000000000000005411","xero":"01H00000000000000000005412","deputy":"01H00000000000000000005413"}'::jsonb,
    clock_timestamp()-interval '5 minutes'
  );
  RAISE EXCEPTION 'an omitted projected table passed snapshot inventory attestation';
EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM NOT LIKE '%pipeline snapshot inventory is incomplete or substituted%' THEN RAISE; END IF;
END;
$$;

DO $$
BEGIN
  INSERT INTO control_plane.pipeline_stats(
    tenant_id,snapshot_at,schema_name,table_name,row_count,max_event_at,
    max_ingested_at,invariant_status,quality_run_id,quality_checked_at,
    snapshot_table_count,snapshot_inventory_hash,created_at
  )
  SELECT tenant_id,snapshot_at,'core','unexpected_projection',row_count,max_event_at,
         max_ingested_at,invariant_status,quality_run_id,quality_checked_at,
         snapshot_table_count,snapshot_inventory_hash,created_at
    FROM control_plane.pipeline_stats
   WHERE tenant_id='01H00000000000000000005401'
   ORDER BY schema_name,table_name
   LIMIT 1;
  PERFORM control_plane.assert_protected_dogfood_manifest_and_quality(
    '01H00000000000000000005401',
    '{"lightspeed-r":"01H00000000000000000005411","xero":"01H00000000000000000005412","deputy":"01H00000000000000000005413"}'::jsonb,
    clock_timestamp()-interval '5 minutes'
  );
  RAISE EXCEPTION 'an extra projected table passed snapshot inventory attestation';
EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM NOT LIKE '%pipeline snapshot inventory is incomplete or substituted%' THEN RAISE; END IF;
END;
$$;

DO $$
BEGIN
  UPDATE control_plane.pipeline_stats
     SET table_name='commerce_order_substitute'
   WHERE tenant_id='01H00000000000000000005401'
     AND schema_name='core' AND table_name='commerce_order';
  PERFORM control_plane.assert_protected_dogfood_manifest_and_quality(
    '01H00000000000000000005401',
    '{"lightspeed-r":"01H00000000000000000005411","xero":"01H00000000000000000005412","deputy":"01H00000000000000000005413"}'::jsonb,
    clock_timestamp()-interval '5 minutes'
  );
  RAISE EXCEPTION 'a substituted projected table passed snapshot inventory attestation';
EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM NOT LIKE '%pipeline snapshot inventory is incomplete or substituted%' THEN RAISE; END IF;
END;
$$;

DO $$
BEGIN
  UPDATE control_plane.sync_stream_phases
     SET required=false
   WHERE tenant_id='01H00000000000000000005401'
     AND connection_id='01H00000000000000000005411'
     AND stream='ls_sales';
  PERFORM control_plane.assert_protected_dogfood_manifest_and_quality(
    '01H00000000000000000005401',
    '{"lightspeed-r":"01H00000000000000000005411","xero":"01H00000000000000000005412","deputy":"01H00000000000000000005413"}'::jsonb,
    clock_timestamp()-interval '5 minutes'
  );
  RAISE EXCEPTION 'a truncated/changed manifest plan passed';
EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM NOT LIKE '%exact reviewed connector manifests%' THEN RAISE; END IF;
END;
$$;

DO $$
BEGIN
  UPDATE control_plane.sync_stream_phases
     SET domains=ARRAY['workforce']::text[]
   WHERE tenant_id='01H00000000000000000005401'
     AND connection_id='01H00000000000000000005412'
     AND stream='xero_invoices';
  PERFORM control_plane.assert_protected_dogfood_manifest_and_quality(
    '01H00000000000000000005401',
    '{"lightspeed-r":"01H00000000000000000005411","xero":"01H00000000000000000005412","deputy":"01H00000000000000000005413"}'::jsonb,
    clock_timestamp()-interval '5 minutes'
  );
  RAISE EXCEPTION 'a stream plan with the wrong product domain passed';
EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM NOT LIKE '%exact reviewed connector manifests%' THEN RAISE; END IF;
END;
$$;

DO $$
BEGIN
  UPDATE control_plane.sync_stream_phases
     SET dependencies=ARRAY['organisation']::text[]
   WHERE tenant_id='01H00000000000000000005401'
     AND connection_id='01H00000000000000000005412'
     AND stream='xero_invoices';
  PERFORM control_plane.assert_protected_dogfood_manifest_and_quality(
    '01H00000000000000000005401',
    '{"lightspeed-r":"01H00000000000000000005411","xero":"01H00000000000000000005412","deputy":"01H00000000000000000005413"}'::jsonb,
    clock_timestamp()-interval '5 minutes'
  );
  RAISE EXCEPTION 'a stream plan with the wrong dependency DAG passed';
EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM NOT LIKE '%exact reviewed connector manifests%' THEN RAISE; END IF;
END;
$$;

SAVEPOINT wrong_api_version;
ALTER TABLE control_plane.raw_batch_manifests
  DISABLE TRIGGER raw_batch_manifests_reject_mutation;
UPDATE control_plane.raw_batch_manifests
   SET api_version='unreviewed-api-version'
 WHERE tenant_id='01H00000000000000000005401'
   AND connector_key='xero' AND stream='xero_invoices';
ALTER TABLE control_plane.raw_batch_manifests
  ENABLE TRIGGER raw_batch_manifests_reject_mutation;
DO $$
BEGIN
  PERFORM control_plane.assert_protected_dogfood_manifest_and_quality(
    '01H00000000000000000005401',
    '{"lightspeed-r":"01H00000000000000000005411","xero":"01H00000000000000000005412","deputy":"01H00000000000000000005413"}'::jsonb,
    clock_timestamp()-interval '5 minutes'
  );
  RAISE EXCEPTION 'a raw manifest with an unreviewed API version passed';
EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM NOT LIKE '%raw manifests do not match the exact reviewed connector release%' THEN RAISE; END IF;
END;
$$;
ROLLBACK TO SAVEPOINT wrong_api_version;

DO $$
BEGIN
  UPDATE control_plane.sync_runs run
     SET status='failed'
    FROM dogfood_stream_seed seed
   WHERE run.tenant_id='01H00000000000000000005401'
     AND run.sync_run_id=seed.sync_run_id
     AND seed.connector_key='xero' AND seed.stream='xero_invoices';
  PERFORM control_plane.assert_protected_dogfood_manifest_and_quality(
    '01H00000000000000000005401',
    '{"lightspeed-r":"01H00000000000000000005411","xero":"01H00000000000000000005412","deputy":"01H00000000000000000005413"}'::jsonb,
    clock_timestamp()-interval '5 minutes'
  );
  RAISE EXCEPTION 'a failed candidate extraction passed';
EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM NOT LIKE '%candidate raw, cursor or reconciliation evidence%' THEN RAISE; END IF;
END;
$$;

DO $$
BEGIN
  -- A tenant-scoped run FK does not prove that the run belongs to this
  -- manifest's connection and stream. Keep the borrowed run successful and
  -- on generation one while moving it to another selected connector/stream.
  UPDATE control_plane.sync_runs run
     SET connection_id='01H00000000000000000005411',stream='ls_sales'
    FROM dogfood_stream_seed seed
   WHERE run.tenant_id='01H00000000000000000005401'
     AND run.sync_run_id=seed.sync_run_id
     AND seed.connector_key='xero' AND seed.stream='xero_invoices';
  PERFORM control_plane.assert_protected_dogfood_manifest_and_quality(
    '01H00000000000000000005401',
    '{"lightspeed-r":"01H00000000000000000005411","xero":"01H00000000000000000005412","deputy":"01H00000000000000000005413"}'::jsonb,
    clock_timestamp()-interval '5 minutes'
  );
  RAISE EXCEPTION 'cross-connection/cross-stream run evidence passed';
EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM NOT LIKE '%raw manifests do not match the exact reviewed connector release%' THEN RAISE; END IF;
END;
$$;

DO $$
BEGIN
  -- Simulate one reviewed stream finishing after the currently projected
  -- quality run. Every row still belongs to the candidate era, but the older
  -- snapshot cannot attest data that had not reached its terminal state yet.
  UPDATE control_plane.sync_stream_phases
     SET completed_at=clock_timestamp()
   WHERE tenant_id='01H00000000000000000005401'
     AND connection_id='01H00000000000000000005412'
     AND stream='xero_invoices' AND phase='recent';
  PERFORM control_plane.assert_protected_dogfood_manifest_and_quality(
    '01H00000000000000000005401',
    '{"lightspeed-r":"01H00000000000000000005411","xero":"01H00000000000000000005412","deputy":"01H00000000000000000005413"}'::jsonb,
    clock_timestamp()-interval '5 minutes'
  );
  RAISE EXCEPTION 'quality evidence predating final stream completion passed';
EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM NOT LIKE '%exact candidate-era passing check set%' THEN RAISE; END IF;
END;
$$;

DO $$
BEGIN
  UPDATE control_plane.pipeline_stats
     SET quality_checked_at=clock_timestamp()+interval '1 hour'
   WHERE tenant_id='01H00000000000000000005401';
  PERFORM control_plane.assert_protected_dogfood_manifest_and_quality(
    '01H00000000000000000005401',
    '{"lightspeed-r":"01H00000000000000000005411","xero":"01H00000000000000000005412","deputy":"01H00000000000000000005413"}'::jsonb,
    clock_timestamp()-interval '5 minutes'
  );
  RAISE EXCEPTION 'future-dated projected quality evidence passed M4';
EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM NOT LIKE '%exact candidate-era passing check set%' THEN RAISE; END IF;
END;
$$;

DO $$
BEGIN
  UPDATE control_plane.pipeline_stats
     SET invariant_status=jsonb_set(invariant_status,'{line_maths}','"warning"'::jsonb)
   WHERE tenant_id='01H00000000000000000005401';
  PERFORM control_plane.assert_protected_dogfood_manifest_and_quality(
    '01H00000000000000000005401',
    '{"lightspeed-r":"01H00000000000000000005411","xero":"01H00000000000000000005412","deputy":"01H00000000000000000005413"}'::jsonb,
    clock_timestamp()-interval '5 minutes'
  );
  RAISE EXCEPTION 'a warning quality result passed M4';
EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM NOT LIKE '%exact candidate-era passing check set%' THEN RAISE; END IF;
END;
$$;

SAVEPOINT json_null_quality_map;
ALTER TABLE control_plane.pipeline_stats
  DROP CONSTRAINT pipeline_stats_invariant_status_check;
DO $$
BEGIN
  UPDATE control_plane.pipeline_stats
     SET invariant_status='null'::jsonb
   WHERE tenant_id='01H00000000000000000005401';
  PERFORM control_plane.assert_protected_dogfood_manifest_and_quality(
    '01H00000000000000000005401',
    '{"lightspeed-r":"01H00000000000000000005411","xero":"01H00000000000000000005412","deputy":"01H00000000000000000005413"}'::jsonb,
    clock_timestamp()-interval '5 minutes'
  );
  RAISE EXCEPTION 'a JSON null quality snapshot passed M4';
EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM NOT LIKE '%exact candidate-era passing check set%' THEN RAISE; END IF;
END;
$$;
ROLLBACK TO SAVEPOINT json_null_quality_map;

DO $$
BEGIN
  UPDATE control_plane.pipeline_stats
     SET quality_run_id=NULL,quality_checked_at=NULL,
         snapshot_table_count=NULL,snapshot_inventory_hash=NULL
   WHERE tenant_id='01H00000000000000000005401';
  PERFORM control_plane.assert_protected_dogfood_manifest_and_quality(
    '01H00000000000000000005401',
    '{"lightspeed-r":"01H00000000000000000005411","xero":"01H00000000000000000005412","deputy":"01H00000000000000000005413"}'::jsonb,
    clock_timestamp()-interval '5 minutes'
  );
  RAISE EXCEPTION 'an unattested maintenance quality snapshot passed M4';
EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM NOT LIKE '%pipeline snapshot inventory is incomplete or substituted%' THEN RAISE; END IF;
END;
$$;

SAVEPOINT optional_unavailable;
UPDATE control_plane.sync_stream_phases
   SET status='unavailable',completed_at=clock_timestamp(),
       last_error='{"code":"capability_unavailable","retryable":false}'::jsonb
 WHERE tenant_id='01H00000000000000000005401'
   AND connection_id='01H00000000000000000005411'
   AND stream='ls_register_calculated' AND phase='recent';
UPDATE control_plane.sync_stream_phases
   SET status='planned',completed_at=NULL
 WHERE tenant_id='01H00000000000000000005401'
   AND connection_id='01H00000000000000000005411'
   AND stream='ls_register_calculated' AND phase<>'recent';
-- Optional-unavailable is a supported terminal policy, but its terminal event
-- is still candidate evidence. Publish a causally later exact-run snapshot;
-- the pre-terminal snapshot above must not be reused.
WITH quality(value) AS (
  SELECT jsonb_object_agg(check_id,'passed' ORDER BY check_id)
    FROM control_plane.protected_dogfood_quality_expectation
), snapshot(value) AS (
  SELECT clock_timestamp()
), quality_run(value) AS (
  SELECT sync_run_id
    FROM dogfood_stream_seed
   WHERE connector_key='xero' AND stream='xero_invoices'
), inventory_attestation(table_count,inventory_hash) AS (
  SELECT count(*)::integer,
         encode(extensions.digest(convert_to(
           jsonb_agg(
             jsonb_build_array(inventory.schema_name,inventory.table_name)
             ORDER BY inventory.schema_name COLLATE "C",
                      inventory.table_name COLLATE "C"
           )::text,
           'UTF8'
         ),'sha256'),'hex')
    FROM dogfood_stats_inventory inventory
)
INSERT INTO control_plane.pipeline_stats(
  tenant_id,snapshot_at,schema_name,table_name,row_count,
  max_event_at,max_ingested_at,invariant_status,quality_run_id,quality_checked_at,
  snapshot_table_count,snapshot_inventory_hash,created_at
)
SELECT '01H00000000000000000005401',snapshot.value,
       inventory.schema_name,inventory.table_name,1,
       clock_timestamp(),clock_timestamp(),quality.value,quality_run.value,
       snapshot.value,attestation.table_count,attestation.inventory_hash,
       clock_timestamp()
  FROM quality
  CROSS JOIN snapshot
  CROSS JOIN quality_run
  CROSS JOIN inventory_attestation attestation
  CROSS JOIN dogfood_stats_inventory inventory;
SELECT control_plane.assert_protected_dogfood_manifest_and_quality(
  '01H00000000000000000005401',
  '{"lightspeed-r":"01H00000000000000000005411","xero":"01H00000000000000000005412","deputy":"01H00000000000000000005413"}'::jsonb,
  clock_timestamp()-interval '5 minutes'
);
ROLLBACK TO SAVEPOINT optional_unavailable;

SELECT pg_temp.assert_true(
  NOT pg_catalog.has_function_privilege(
    'albert_operator_diagnostic_control',
    'control_plane.capture_protected_dogfood_acceptance_v1(text,text,text,jsonb,text,integer,text,text,text,text,text)',
    'EXECUTE'
  ) AND pg_catalog.has_function_privilege(
    'albert_operator_diagnostic_control',
    'control_plane.capture_protected_dogfood_acceptance(text,text,text,jsonb,text,integer,text,text,text,text,text,text)',
    'EXECUTE'
  ),
  'the diagnostic runtime group must only execute the hardened wrapper'
);

ROLLBACK;
