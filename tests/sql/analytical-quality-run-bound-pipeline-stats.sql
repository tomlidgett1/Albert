\set ON_ERROR_STOP on

BEGIN;

SELECT set_config('albert.tenant_id','01J0000000000000000000QATT',true);

INSERT INTO quality.check_result(
  tenant_id,run_id,check_id,domain,status,observed,threshold,details,checked_at
)
SELECT '01J0000000000000000000QATT','01J0000000000000000000QRN1',
       expectation.check_id,expectation.domain,'passed',0,0,
       '{"source":"quality_run_attestation_test"}'::jsonb,clock_timestamp()
  FROM quality.check_expectation expectation
 WHERE expectation.required AND expectation.blocks_readiness;

DO $$
DECLARE attested_at timestamptz:=clock_timestamp();
DECLARE maintenance_at timestamptz;
DECLARE expected_map jsonb;
DECLARE oldest_check timestamptz;
DECLARE newest_check timestamptz;
DECLARE projected_count integer;
DECLARE projected_inventory_hash text;
DECLARE declared_count_min integer;
DECLARE declared_count_max integer;
DECLARE declared_hash_min text;
DECLARE declared_hash_max text;
BEGIN
  SELECT jsonb_object_agg(result.check_id,result.status ORDER BY result.check_id),
         min(result.checked_at),max(result.checked_at)
    INTO STRICT expected_map,oldest_check,newest_check
    FROM quality.check_result result
   WHERE result.tenant_id='01J0000000000000000000QATT'
     AND result.run_id='01J0000000000000000000QRN1';

  PERFORM quality.snapshot_all_pipeline_stats(
    '01J0000000000000000000QATT',attested_at,ARRAY['canonical']::text[],
    '{}'::jsonb,'01J0000000000000000000QRN1'
  );

  SELECT count(*)::integer,
         encode(extensions.digest(convert_to(
           jsonb_agg(
             jsonb_build_array(projection.schema_name,projection.table_name)
             ORDER BY projection.schema_name COLLATE "C",
                      projection.table_name COLLATE "C"
           )::text,
           'UTF8'
         ),'sha256'),'hex'),
         min(projection.snapshot_table_count),
         max(projection.snapshot_table_count),
         min(projection.snapshot_inventory_hash),
         max(projection.snapshot_inventory_hash)
    INTO projected_count,projected_inventory_hash,
         declared_count_min,declared_count_max,declared_hash_min,declared_hash_max
    FROM semantic_internal.pipeline_table_stats_projection_outbox projection
   WHERE projection.tenant_id='01J0000000000000000000QATT'
     AND projection.snapshot_at=attested_at;
  IF projected_count=0
     OR declared_count_min IS DISTINCT FROM projected_count
     OR declared_count_min IS DISTINCT FROM declared_count_max
     OR declared_hash_min IS DISTINCT FROM projected_inventory_hash
     OR declared_hash_min IS DISTINCT FROM declared_hash_max
     OR EXISTS (
    SELECT 1
      FROM semantic_internal.pipeline_table_stats_projection_outbox projection
     WHERE projection.tenant_id='01J0000000000000000000QATT'
       AND projection.snapshot_at=attested_at
       AND (
         projection.quality_run_id IS DISTINCT FROM '01J0000000000000000000QRN1'
         OR projection.quality_checked_at IS DISTINCT FROM oldest_check
         OR projection.invariant_status IS DISTINCT FROM expected_map
         OR projection.snapshot_table_count IS DISTINCT FROM projected_count
         OR projection.snapshot_inventory_hash IS DISTINCT FROM projected_inventory_hash
       )
  ) THEN
    RAISE EXCEPTION 'candidate snapshot was not bound to its exact quality run';
  END IF;

  BEGIN
    PERFORM quality.snapshot_all_pipeline_stats(
      '01J0000000000000000000QATT',newest_check-interval '1 microsecond',
      ARRAY['canonical']::text[],'{}'::jsonb,'01J0000000000000000000QRN1'
    );
    RAISE EXCEPTION 'a snapshot predating quality run completion was attested';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM NOT LIKE '%predates quality run completion%' THEN RAISE; END IF;
  END;

  -- The four-argument maintenance path remains operational but is intentionally
  -- unattested, so projecting it into the control plane cannot satisfy release.
  maintenance_at:=clock_timestamp();
  PERFORM quality.snapshot_all_pipeline_stats(
    '01J0000000000000000000QATT',maintenance_at,ARRAY[]::text[],'{}'::jsonb
  );
  IF NOT EXISTS (
    SELECT 1
      FROM semantic_internal.pipeline_table_stats_projection_outbox projection
     WHERE projection.tenant_id='01J0000000000000000000QATT'
       AND projection.snapshot_at=maintenance_at
  ) OR EXISTS (
    SELECT 1
      FROM semantic_internal.pipeline_table_stats_projection_outbox projection
     WHERE projection.tenant_id='01J0000000000000000000QATT'
       AND projection.snapshot_at=maintenance_at
       AND (projection.quality_run_id IS NOT NULL
         OR projection.quality_checked_at IS NOT NULL
         OR projection.snapshot_table_count IS NOT NULL
         OR projection.snapshot_inventory_hash IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'maintenance snapshot acquired candidate quality attestation';
  END IF;

  BEGIN
    PERFORM quality.snapshot_all_pipeline_stats(
      '01J0000000000000000000QATT',clock_timestamp(),ARRAY['canonical']::text[],
      '{}'::jsonb,'01J0000000000000000000MISS'
    );
    RAISE EXCEPTION 'an incomplete quality run produced an attested snapshot';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM NOT LIKE '%exact required check set%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE quality.check_result
       SET checked_at=clock_timestamp()+interval '1 hour'
     WHERE tenant_id='01J0000000000000000000QATT'
       AND run_id='01J0000000000000000000QRN1';
    PERFORM quality.snapshot_all_pipeline_stats(
      '01J0000000000000000000QATT',clock_timestamp(),ARRAY['canonical']::text[],
      '{}'::jsonb,'01J0000000000000000000QRN1'
    );
    RAISE EXCEPTION 'future-dated quality results produced an attested snapshot';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM NOT LIKE '%future-dated results%' THEN RAISE; END IF;
  END;
END;
$$;

-- Even a run containing every current check fails closed if a direct writer
-- adds one unreviewed check id.
INSERT INTO quality.check_result(
  tenant_id,run_id,check_id,domain,status,observed,threshold,details,checked_at
)
SELECT '01J0000000000000000000QATT','01J0000000000000000000QRN2',
       expectation.check_id,expectation.domain,'passed',0,0,'{}'::jsonb,
       clock_timestamp()
  FROM quality.check_expectation expectation
 WHERE expectation.required AND expectation.blocks_readiness;
INSERT INTO quality.check_result(
  tenant_id,run_id,check_id,domain,status,observed,threshold,details,checked_at
) VALUES (
  '01J0000000000000000000QATT','01J0000000000000000000QRN2',
  'unreviewed_check','canonical','passed',0,0,'{}'::jsonb,clock_timestamp()
);

DO $$
BEGIN
  BEGIN
    PERFORM quality.snapshot_all_pipeline_stats(
      '01J0000000000000000000QATT',clock_timestamp(),ARRAY['canonical']::text[],
      '{}'::jsonb,'01J0000000000000000000QRN2'
    );
    RAISE EXCEPTION 'an unreviewed extra quality result produced an attested snapshot';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM NOT LIKE '%exact required check set%' THEN RAISE; END IF;
  END;

  IF NOT has_function_privilege(
    'transform_rw',
    'quality.snapshot_all_pipeline_stats(text,timestamptz,text[],jsonb,text)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'transform_rw',
    'semantic_internal.pipeline_table_inventory_hash(jsonb)',
    'EXECUTE'
  ) OR has_function_privilege(
    'semantic_ro',
    'quality.snapshot_all_pipeline_stats(text,timestamptz,text[],jsonb,text)',
    'EXECUTE'
  ) OR has_function_privilege(
    'semantic_ro',
    'semantic_internal.pipeline_table_inventory_hash(jsonb)',
    'EXECUTE'
  ) OR has_schema_privilege(
    'transform_rw','extensions','USAGE'
  ) THEN
    RAISE EXCEPTION 'quality-attested snapshot overload has incorrect runtime ACLs';
  END IF;
END;
$$;

ROLLBACK;
