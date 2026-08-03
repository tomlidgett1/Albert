\set ON_ERROR_STOP on

BEGIN;
SET LOCAL ROLE albert_transform_control;
SELECT set_config('albert.tenant_id','01H00000000000000000004801',true);

DO $$
DECLARE result jsonb;remaining bigint;due bigint;
BEGIN
  result:=control_plane.retain_pipeline_history(
    '01H00000000000000000004801'
  );
  IF result->>'pipeline_stats_removed'<>'2' THEN
    RAISE EXCEPTION 'pipeline retention removed unexpected rows: %',result;
  END IF;
  SELECT count(*) INTO remaining
    FROM control_plane.pipeline_stats
   WHERE tenant_id='01H00000000000000000004801'
     AND schema_name='source_xero' AND table_name='invoices';
  IF remaining<>1 THEN
    RAISE EXCEPTION 'pipeline retention did not keep exactly one hourly point: %',remaining;
  END IF;
  SELECT due_tenants INTO due
    FROM control_plane.transform_maintenance_metrics();
  IF due<1 THEN
    RAISE EXCEPTION 'maintenance metrics omitted a due active tenant';
  END IF;
END;
$$;

ROLLBACK;
