\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean,message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'capability-scoped health assertion failed: %',message;
  END IF;
END;
$$;

SELECT set_config('albert.tenant_id','01K70000000000000000000000',true);

INSERT INTO semantic_internal.tenant_capability(
  tenant_id,capability,source_key,connection_id,connector_id,available,
  support,reason_code,coverage,pack_version,source_watermark
) VALUES
  ('01K70000000000000000000000','commerce.order_lines','lightspeed:primary',
   '01K70000000000000000000001','lightspeed-r',true,'full','canonical_stream_observed',
   '{"stream":"sales"}'::jsonb,'1.0.0',now()),
  ('01K70000000000000000000000','commerce.order_lines','lightspeed:unrelated',
   '01K70000000000000000000002','lightspeed-r',true,'full','canonical_stream_observed',
   '{"stream":"sales"}'::jsonb,'1.0.0',now()),
  ('01K70000000000000000000000','finance.journals','xero:unrelated',
   '01K70000000000000000000003','xero',true,'full','canonical_stream_observed',
   '{"stream":"journals"}'::jsonb,'1.0.0',now());

INSERT INTO core.source_authority(
  tenant_id,id,concept,scope_type,scope_id,authoritative_connection_id,
  effective_from,sync_run_id
) VALUES (
  '01K70000000000000000000000','01K70000000000000000000010',
  'operational_sales','tenant','01K70000000000000000000000',
  '01K70000000000000000000001','2026-01-01T00:00:00Z',
  '01K70000000000000000000011'
);

-- Generation one is fully green, but generation two is the current bounded
-- recent slice. Health must never reuse the superseded generation to erase the
-- exact full-history/reconciliation limitations of the current one.
INSERT INTO quality.connector_stream_state(
  tenant_id,connection_id,connection_generation,connector_id,stream,required,
  late_edit_strategy,deletion_strategy,source_total_strategy,
  observed_page_count,cursor_chain_valid,cursor_complete,backfill_complete,
  retention_evidence,reconciliation_completed_at,source_total,local_live_total,
  last_page_at,updated_at
) VALUES
  ('01K70000000000000000000000','01K70000000000000000000001',1,
   'lightspeed-r','sales',true,'modified_field','soft_delete','provider_reported',
   1,true,true,true,'{"boundaryKind":"account_start"}'::jsonb,now(),10,10,now(),now()),
  ('01K70000000000000000000000','01K70000000000000000000001',2,
   'lightspeed-r','sales',true,'modified_field','soft_delete','provider_reported',
   1,true,true,false,null,null,null,null,now(),now()),
  ('01K70000000000000000000000','01K70000000000000000000002',1,
   'lightspeed-r','sales',true,'modified_field','soft_delete','provider_reported',
   1,false,false,false,null,null,null,null,now(),now()),
  ('01K70000000000000000000000','01K70000000000000000000003',1,
   'xero','journals',true,'append_only','immutable_append_only','provider_reported',
   0,true,false,false,null,null,null,null,null,now());

INSERT INTO quality.connector_check_observation(
  tenant_id,run_id,batch_id,check_id,connection_id,connector_id,stream,
  status,details,checked_at
)
SELECT '01K70000000000000000000000','01K70000000000000000000020',
       '01K70000000000000000000021',check_id,
       '01K70000000000000000000001','lightspeed-r','sales',
       CASE WHEN check_id IN (
         'retention_limit_recorded','webhook_gap_recovered','delete_handling','enum_drift'
       ) THEN 'warning' ELSE 'passed' END,
       '{"fixture":"page-local warning must not be current health"}'::jsonb,now()
  FROM unnest(ARRAY[
    'cursor_completeness','scope_available','retention_limit_recorded',
    'webhook_gap_recovered','delete_handling','schema_drift','enum_drift'
  ]) check_id;
INSERT INTO quality.connector_check_observation(
  tenant_id,run_id,batch_id,check_id,connection_id,connector_id,stream,
  status,details,checked_at
)
SELECT '01K70000000000000000000000','01K70000000000000000000030',
       '01K70000000000000000000031',check_id,
       '01K70000000000000000000002','lightspeed-r','sales','failed',
       '{"fixture":"non-authoritative account"}'::jsonb,now()
  FROM unnest(ARRAY[
    'cursor_completeness','scope_available','retention_limit_recorded',
    'webhook_gap_recovered','delete_handling','schema_drift','enum_drift'
  ]) check_id;
INSERT INTO quality.connector_check_observation(
  tenant_id,run_id,batch_id,check_id,connection_id,connector_id,stream,
  status,details,checked_at
)
SELECT '01K70000000000000000000000','01K70000000000000000000040',
       '01K70000000000000000000041',check_id,
       '01K70000000000000000000003','xero','journals','failed',
       '{"fixture":"unrelated Xero failure"}'::jsonb,now()
  FROM unnest(ARRAY[
    'cursor_completeness','scope_available','retention_limit_recorded',
    'webhook_gap_recovered','delete_handling','schema_drift','enum_drift'
  ]) check_id;

SET LOCAL ROLE semantic_ro;
SELECT set_config('albert.tenant_id','01K70000000000000000000000',true);

SELECT pg_temp.assert_true(
  (
    SELECT count(*)=7
       AND count(*) FILTER (WHERE status='warning')=3
       AND bool_and(status IN ('passed','warning'))
      FROM quality.current_scoped_health(
        '01K70000000000000000000000',ARRAY['connector'],
        ARRAY['commerce.order_lines']
      )
  ),
  'bounded recent health must qualify only history and reconciliation checks'
);
SELECT pg_temp.assert_true(
  (
    SELECT bool_and(
      details->>'contributor_count'='1'
      AND details->'contributors'->0->>'connection_id'='01K70000000000000000000001'
      AND details->'contributors'->0->>'connection_generation'='2'
    )
      FROM quality.current_scoped_health(
        '01K70000000000000000000000',ARRAY['connector'],
        ARRAY['commerce.order_lines']
      )
  ),
  'health evidence must name only the current-generation authority contributor'
);
SELECT pg_temp.assert_true(
  (
    SELECT count(*)=7 AND bool_and(status='blocked')
      FROM quality.current_scoped_health(
        '01K70000000000000000000000',ARRAY['connector'],
        ARRAY['finance.journals']
      )
  ),
  'the same Xero failure must block a Topic that actually depends on it'
);
SELECT pg_temp.assert_true(
  (
    SELECT count(*)=7 AND bool_and(status='blocked')
      FROM quality.current_scoped_health(
        '01K70000000000000000000000',ARRAY['connector'],
        ARRAY['inventory.balances']
      )
  ),
  'a missing requested capability contributor must fail closed'
);

RESET ROLE;

-- Durable completion supersedes page-local unknown warnings. This is the
-- recovery path that previously left every governed answer permanently
-- Qualified even after full history and reconciliation were green.
UPDATE quality.connector_stream_state
   SET backfill_complete=true,
       retention_evidence='{"boundaryKind":"account_start","verification":"provider_reported"}'::jsonb,
       reconciliation_completed_at=now(),
       source_total=10,
       local_live_total=10,
       updated_at=now()
 WHERE tenant_id='01K70000000000000000000000'
   AND connection_id='01K70000000000000000000001'
   AND connection_generation=2
   AND stream='sales';

SET LOCAL ROLE semantic_ro;
SELECT set_config('albert.tenant_id','01K70000000000000000000000',true);

SELECT pg_temp.assert_true(
  (
    SELECT count(*)=7 AND bool_and(status='passed')
      FROM quality.current_scoped_health(
        '01K70000000000000000000000',ARRAY['connector'],
        ARRAY['commerce.order_lines']
      )
  ),
  'durable full-history and reconciliation evidence must recover health to green'
);
SELECT pg_temp.assert_true(
  (
    SELECT bool_and(details->>'reason_code'='capability_scoped_durable_connector_health')
      FROM quality.current_scoped_health(
        '01K70000000000000000000000',ARRAY['connector'],
        ARRAY['commerce.order_lines']
      )
  ),
  'scoped health must disclose the durable evidence authority'
);

RESET ROLE;
ROLLBACK;
