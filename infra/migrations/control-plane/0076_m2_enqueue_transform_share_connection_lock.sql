-- Transform capability issuance (0038) holds FOR SHARE on the connections row
-- for the whole analytical transaction. Enqueue (0064) locked the same row
-- FOR UPDATE on every page commit, so any in-flight transform batch for the
-- connection starved sync commits into lock timeouts (55P03) and deadlocks
-- (40P01) on the connections tuple.
--
-- Enqueue only reads connection_generation and status; it never mutates the
-- connection. FOR SHARE preserves the reconnect/deletion fence (both must
-- UPDATE the row and therefore still wait), while share locks on the sync and
-- transform sides no longer conflict. The landing row keeps FOR UPDATE, which
-- still serialises duplicate enqueues of the same batch.

BEGIN;

CREATE OR REPLACE FUNCTION control_plane.enqueue_canonical_transform_job(
  p_tenant_id text,
  p_batch_id text,
  p_mapping_version text,
  p_domains text[],
  p_backfill_complete boolean
) RETURNS TABLE (transform_job_id text,created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE manifest_row record; existing_id text; generated_id text;
BEGIN
  IF p_tenant_id IS NULL OR NOT control_plane.is_ulid(p_tenant_id)
     OR p_batch_id IS NULL OR NOT control_plane.is_ulid(p_batch_id)
     OR p_mapping_version IS NULL
     OR p_mapping_version !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR p_domains IS NULL OR cardinality(p_domains)=0
     OR EXISTS (
       SELECT 1 FROM unnest(p_domains) domain(value)
       WHERE value !~ '^[a-z][a-z0-9_]*$'
     ) THEN
    RAISE EXCEPTION 'canonical transform enqueue input is invalid' USING ERRCODE='22023';
  END IF;

  SELECT manifest.tenant_id,manifest.batch_id,manifest.sync_run_id,
         manifest.connection_id,manifest.connector_key,manifest.stream,
         run.connection_generation
    INTO manifest_row
    FROM control_plane.raw_batch_manifests manifest
    JOIN control_plane.raw_batch_landings landing
      ON landing.tenant_id=manifest.tenant_id AND landing.batch_id=manifest.batch_id
    JOIN control_plane.sync_runs run
      ON run.tenant_id=manifest.tenant_id AND run.sync_run_id=manifest.sync_run_id
     AND run.connection_id=manifest.connection_id
    JOIN control_plane.connections connection
      ON connection.tenant_id=manifest.tenant_id
     AND connection.connection_id=manifest.connection_id
     AND connection.connection_generation=run.connection_generation
     AND connection.status IN ('connected','degraded')
   WHERE manifest.tenant_id=p_tenant_id AND manifest.batch_id=p_batch_id
     AND landing.status IN ('landed','quarantined')
     AND landing.analytical_committed_at IS NOT NULL
   FOR UPDATE OF landing
   FOR SHARE OF connection;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'canonical transform batch is not durably landed on the active connection generation'
      USING ERRCODE='55000';
  END IF;

  SELECT job.transform_job_id INTO existing_id
    FROM control_plane.canonical_transform_jobs job
   WHERE job.tenant_id=p_tenant_id AND job.batch_id=p_batch_id
     AND job.mapping_version=p_mapping_version;
  IF existing_id IS NOT NULL THEN
    RETURN QUERY SELECT existing_id,false;
    RETURN;
  END IF;

  generated_id:=control_plane.generate_ulid();
  INSERT INTO control_plane.canonical_transform_jobs (
    tenant_id,transform_job_id,batch_id,sync_run_id,connection_id,
    connection_generation,connector_id,stream,domains,mapping_version,
    backfill_complete
  ) VALUES (
    manifest_row.tenant_id,generated_id,manifest_row.batch_id,
    manifest_row.sync_run_id,manifest_row.connection_id,
    manifest_row.connection_generation,manifest_row.connector_key,
    manifest_row.stream,
    ARRAY(SELECT DISTINCT value FROM unnest(p_domains) domain(value) ORDER BY value),
    p_mapping_version,p_backfill_complete
  );
  RETURN QUERY SELECT generated_id,true;
END;
$$;

COMMIT;
