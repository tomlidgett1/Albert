BEGIN;

-- A maintenance snapshot is useful operationally, but it is not evidence that
-- one candidate sync run executed every required quality check. Keep the
-- attestation nullable on the shared outbox so the existing four-argument
-- maintenance path remains available while release acceptance can fail closed.
ALTER TABLE semantic_internal.pipeline_table_stats_projection_outbox
  ADD COLUMN IF NOT EXISTS quality_run_id text,
  ADD COLUMN IF NOT EXISTS quality_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS snapshot_table_count integer,
  ADD COLUMN IF NOT EXISTS snapshot_inventory_hash text;
ALTER TABLE semantic_internal.pipeline_table_stats_projection_outbox
  DROP CONSTRAINT IF EXISTS pipeline_table_stats_quality_attestation_valid;
ALTER TABLE semantic_internal.pipeline_table_stats_projection_outbox
  ADD CONSTRAINT pipeline_table_stats_quality_attestation_valid CHECK (
    (quality_run_id IS NULL AND quality_checked_at IS NULL
      AND snapshot_table_count IS NULL AND snapshot_inventory_hash IS NULL)
    OR
    (quality_run_id IS NOT NULL AND core.is_ulid(quality_run_id)
      AND quality_checked_at IS NOT NULL
      AND snapshot_table_count IS NOT NULL AND snapshot_table_count>0
      AND snapshot_inventory_hash IS NOT NULL
      AND snapshot_inventory_hash ~ '^[0-9a-f]{64}$')
  ) NOT VALID;
-- Validation scans every tenant's historical outbox rows. Cross that forced
-- owner boundary only inside this atomic migration, with RLS still enabled for
-- all runtime roles, then restore FORCE before commit.
ALTER TABLE semantic_internal.pipeline_table_stats_projection_outbox
  NO FORCE ROW LEVEL SECURITY;
ALTER TABLE semantic_internal.pipeline_table_stats_projection_outbox
  VALIDATE CONSTRAINT pipeline_table_stats_quality_attestation_valid;
ALTER TABLE semantic_internal.pipeline_table_stats_projection_outbox
  FORCE ROW LEVEL SECURITY;

-- transform_rw intentionally has no access to the extensions schema. Expose
-- only the one content-addressing primitive this attestation needs instead of
-- broadening that runtime role to every pgcrypto function.
CREATE OR REPLACE FUNCTION semantic_internal.pipeline_table_inventory_hash(
  p_inventory jsonb
) RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
  SELECT encode(
    extensions.digest(convert_to(p_inventory::text,'UTF8'),'sha256'),
    'hex'
  )
$$;

COMMENT ON FUNCTION semantic_internal.pipeline_table_inventory_hash(jsonb) IS
  'Returns the migration-owned SHA-256 digest for a canonical pipeline table inventory without granting runtime access to the extensions schema.';

REVOKE ALL ON FUNCTION semantic_internal.pipeline_table_inventory_hash(jsonb)
  FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT EXECUTE ON FUNCTION semantic_internal.pipeline_table_inventory_hash(jsonb)
  TO transform_rw;

-- This overload is the only candidate-attested path. It proves that the exact
-- required/readiness-blocking expectation set was executed under one run id,
-- delegates table measurement to the mature four-argument implementation, and
-- refuses to stamp the snapshot unless every generated table row carries that
-- exact per-run status map. It also declares the row inventory's exact count
-- and deterministic digest so the control plane can detect partial transport.
-- A pre-existing snapshot timestamp is never adopted as evidence for another
-- call.
CREATE OR REPLACE FUNCTION quality.snapshot_all_pipeline_stats(
  p_tenant_id text,
  p_snapshot_at timestamptz,
  p_domains text[],
  p_source_watermarks jsonb,
  p_quality_run_id text
) RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path=pg_catalog,core,quality,semantic_internal
AS $$
DECLARE expected_count integer;
DECLARE result_count integer;
DECLARE run_status_map jsonb;
DECLARE run_checked_at timestamptz;
DECLARE run_checked_max timestamptz;
DECLARE projected_table_count integer;
DECLARE projected_inventory_hash text;
BEGIN
  IF p_tenant_id IS NULL
     OR p_tenant_id IS DISTINCT FROM core.current_tenant_id()
     OR p_snapshot_at IS NULL
     OR p_snapshot_at>clock_timestamp()
     OR p_quality_run_id IS NULL
     OR NOT core.is_ulid(p_quality_run_id)
     OR jsonb_typeof(p_source_watermarks) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'quality-attested pipeline snapshot input is invalid'
      USING ERRCODE='22023';
  END IF;

  SELECT count(*) INTO expected_count
    FROM quality.check_expectation expectation
   WHERE expectation.required AND expectation.blocks_readiness;
  SELECT count(*),
         min(result.checked_at),
         max(result.checked_at),
         jsonb_object_agg(result.check_id,result.status ORDER BY result.check_id)
    INTO result_count,run_checked_at,run_checked_max,run_status_map
    FROM quality.check_result result
    JOIN quality.check_expectation expectation
      ON expectation.check_id=result.check_id
     AND expectation.required
     AND expectation.blocks_readiness
   WHERE result.tenant_id=p_tenant_id
     AND result.run_id=p_quality_run_id;

  IF expected_count=0
     OR result_count<>expected_count
     OR run_checked_at IS NULL
     OR run_status_map IS NULL
     OR EXISTS (
       SELECT 1
         FROM quality.check_expectation expectation
        WHERE expectation.required
          AND expectation.blocks_readiness
          AND NOT EXISTS (
            SELECT 1 FROM quality.check_result result
             WHERE result.tenant_id=p_tenant_id
               AND result.run_id=p_quality_run_id
               AND result.check_id=expectation.check_id
          )
     )
     OR EXISTS (
       SELECT 1
         FROM quality.check_result result
        WHERE result.tenant_id=p_tenant_id
          AND result.run_id=p_quality_run_id
          AND NOT EXISTS (
            SELECT 1 FROM quality.check_expectation expectation
             WHERE expectation.check_id=result.check_id
               AND expectation.required
               AND expectation.blocks_readiness
          )
     ) THEN
    RAISE EXCEPTION 'quality run does not contain the exact required check set'
      USING ERRCODE='55000';
  END IF;

  IF run_checked_max>clock_timestamp() THEN
    RAISE EXCEPTION 'quality run contains future-dated results'
      USING ERRCODE='55000';
  END IF;
  IF p_snapshot_at<run_checked_max THEN
    RAISE EXCEPTION 'pipeline snapshot predates quality run completion'
      USING ERRCODE='55000';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM semantic_internal.pipeline_table_stats_projection_outbox projection
     WHERE projection.tenant_id=p_tenant_id
       AND projection.snapshot_at=p_snapshot_at
  ) THEN
    RAISE EXCEPTION 'pipeline snapshot timestamp already exists'
      USING ERRCODE='23505';
  END IF;

  PERFORM quality.snapshot_all_pipeline_stats(
    p_tenant_id,p_snapshot_at,p_domains,p_source_watermarks
  );

  IF NOT EXISTS (
    SELECT 1
      FROM semantic_internal.pipeline_table_stats_projection_outbox projection
     WHERE projection.tenant_id=p_tenant_id
       AND projection.snapshot_at=p_snapshot_at
  ) OR EXISTS (
    SELECT 1
      FROM semantic_internal.pipeline_table_stats_projection_outbox projection
     WHERE projection.tenant_id=p_tenant_id
       AND projection.snapshot_at=p_snapshot_at
       AND projection.invariant_status IS DISTINCT FROM run_status_map
  ) THEN
    RAISE EXCEPTION 'pipeline snapshot does not match its exact quality run'
      USING ERRCODE='55000';
  END IF;

  SELECT count(*)::integer,
         semantic_internal.pipeline_table_inventory_hash(
           jsonb_agg(
             jsonb_build_array(projection.schema_name,projection.table_name)
             ORDER BY projection.schema_name COLLATE "C",
                      projection.table_name COLLATE "C"
           )
         )
    INTO projected_table_count,projected_inventory_hash
    FROM semantic_internal.pipeline_table_stats_projection_outbox projection
   WHERE projection.tenant_id=p_tenant_id
     AND projection.snapshot_at=p_snapshot_at;
  IF projected_table_count<1 OR projected_inventory_hash IS NULL THEN
    RAISE EXCEPTION 'pipeline snapshot has no attestable table inventory'
      USING ERRCODE='55000';
  END IF;

  UPDATE semantic_internal.pipeline_table_stats_projection_outbox projection
     SET quality_run_id=p_quality_run_id,
         quality_checked_at=run_checked_at,
         snapshot_table_count=projected_table_count,
         snapshot_inventory_hash=projected_inventory_hash
   WHERE projection.tenant_id=p_tenant_id
     AND projection.snapshot_at=p_snapshot_at;
END;
$$;

COMMENT ON FUNCTION quality.snapshot_all_pipeline_stats(
  text,timestamptz,text[],jsonb,text
) IS
  'Creates a pipeline snapshot bound to one exact, complete quality run and a deterministic table-inventory attestation. The four-argument overload remains unattested maintenance only.';

REVOKE ALL ON FUNCTION quality.snapshot_all_pipeline_stats(
  text,timestamptz,text[],jsonb,text
) FROM PUBLIC,ingest_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT EXECUTE ON FUNCTION quality.snapshot_all_pipeline_stats(
  text,timestamptz,text[],jsonb,text
) TO transform_rw;

-- Connector rollups are first recorded by ingest_rw before the control-plane
-- run commit. Candidate attestation needs a causally later measurement, so the
-- tenant-locked canonical transaction refreshes the same bounded rollup after
-- that commit and immediately before the complete invariant run.
GRANT EXECUTE ON FUNCTION quality.refresh_connector_quality_rollup(text,text)
  TO transform_rw;

COMMIT;
