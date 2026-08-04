BEGIN;

-- source_records is the mutable current-state landing seam. A later snapshot
-- may legitimately replace its batch/hash before an older transform page is
-- claimed, so it cannot authenticate historical batch lineage. The manifest
-- and landing commit are both append-only and form the durable transform
-- boundary; the exact rejected payload remains addressable by object_keys[1].
CREATE OR REPLACE FUNCTION semantic_internal.record_canonical_mapping_quarantine(
  p_tenant_id text,
  p_connection_id text,
  p_sync_run_id text,
  p_batch_id text,
  p_stream text,
  p_source_object_type text,
  p_source_record_id text,
  p_payload_hash text,
  p_mapping_version text,
  p_error_code text,
  p_error_path text,
  p_error_summary text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,core,ingestion,semantic_internal
AS $$
DECLARE
  raw_object_key text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501';
  END IF;
  IF NOT core.is_ulid(p_tenant_id)
     OR NOT core.is_ulid(p_connection_id)
     OR NOT core.is_ulid(p_sync_run_id)
     OR NOT core.is_ulid(p_batch_id) THEN
    RAISE EXCEPTION 'canonical quarantine lineage is invalid' USING ERRCODE='22023';
  END IF;
  IF p_stream !~ '^[a-z][a-z0-9_]{0,99}$'
     OR length(btrim(p_source_object_type)) NOT BETWEEN 1 AND 200
     OR length(btrim(p_source_record_id)) NOT BETWEEN 1 AND 300
     OR p_payload_hash !~ '^[a-f0-9]{64}$'
     OR length(btrim(p_mapping_version)) NOT BETWEEN 1 AND 100
     OR p_error_code !~ '^canonical\.[a-z][a-z0-9_.-]{0,119}$'
     OR p_error_path NOT IN ('$mapper','$projection')
     OR length(btrim(p_error_summary)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'canonical quarantine evidence is invalid' USING ERRCODE='22023';
  END IF;

  SELECT manifest.object_keys[1]
    INTO raw_object_key
    FROM ingestion.batch_manifests manifest
    JOIN ingestion.landing_commits landing
      ON landing.tenant_id=manifest.tenant_id
     AND landing.batch_id=manifest.batch_id
     AND landing.sync_run_id=manifest.sync_run_id
   WHERE manifest.tenant_id=p_tenant_id
     AND manifest.batch_id=p_batch_id
     AND manifest.connection_id=p_connection_id
     AND manifest.sync_run_id=p_sync_run_id
     AND manifest.stream=p_stream
     AND landing.mapping_version=p_mapping_version
     AND landing.status='committed';
  IF raw_object_key IS NULL THEN
    RAISE EXCEPTION 'canonical quarantine source lineage is missing'
      USING ERRCODE='23503';
  END IF;

  INSERT INTO ingestion.quarantine_records (
    tenant_id,quarantine_id,connection_id,sync_run_id,payload_batch_id,
    stream,source_object_type,source_record_id,payload_hash,raw_object_key,
    error_code,error_path,error_summary,mapping_version,status
  ) VALUES (
    p_tenant_id,
    semantic_internal.deterministic_ulid(
      'canonical-quarantine-v1|'||p_tenant_id||'|'||p_batch_id||'|'||
      p_source_object_type||'|'||p_source_record_id||'|'||p_error_code||'|'||p_error_path
    ),
    p_connection_id,p_sync_run_id,p_batch_id,p_stream,p_source_object_type,
    p_source_record_id,p_payload_hash,raw_object_key,p_error_code,p_error_path,
    p_error_summary,p_mapping_version,'open'
  )
  ON CONFLICT (
    tenant_id,payload_batch_id,source_object_type,source_record_id,error_code,error_path
  ) DO UPDATE SET
    connection_id=excluded.connection_id,
    sync_run_id=excluded.sync_run_id,
    payload_hash=excluded.payload_hash,
    raw_object_key=excluded.raw_object_key,
    error_summary=excluded.error_summary,
    mapping_version=excluded.mapping_version,
    status='open',
    replayed_in_sync_run_id=NULL,
    resolution_reason=NULL,
    resolved_at=NULL;
END $$;

CREATE OR REPLACE FUNCTION semantic_internal.resolve_canonical_mapping_quarantine(
  p_tenant_id text,
  p_connection_id text,
  p_sync_run_id text,
  p_batch_id text,
  p_stream text,
  p_source_object_type text,
  p_source_record_id text,
  p_payload_hash text
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,core,ingestion
AS $$
DECLARE
  resolved_count bigint:=0;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501';
  END IF;
  IF NOT core.is_ulid(p_tenant_id)
     OR NOT core.is_ulid(p_connection_id)
     OR NOT core.is_ulid(p_sync_run_id)
     OR NOT core.is_ulid(p_batch_id)
     OR p_stream !~ '^[a-z][a-z0-9_]{0,99}$'
     OR length(btrim(p_source_object_type)) NOT BETWEEN 1 AND 200
     OR length(btrim(p_source_record_id)) NOT BETWEEN 1 AND 300
     OR p_payload_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'canonical quarantine recovery lineage is invalid'
      USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM ingestion.batch_manifests manifest
      JOIN ingestion.landing_commits landing
        ON landing.tenant_id=manifest.tenant_id
       AND landing.batch_id=manifest.batch_id
       AND landing.sync_run_id=manifest.sync_run_id
     WHERE manifest.tenant_id=p_tenant_id
       AND manifest.batch_id=p_batch_id
       AND manifest.connection_id=p_connection_id
       AND manifest.sync_run_id=p_sync_run_id
       AND manifest.stream=p_stream
       AND landing.status='committed'
  ) THEN
    RAISE EXCEPTION 'canonical quarantine recovery lineage is missing'
      USING ERRCODE='23503';
  END IF;

  UPDATE ingestion.quarantine_records quarantine
     SET status='resolved',
         replayed_in_sync_run_id=p_sync_run_id,
         resolution_reason='canonical_projection_recovered',
         resolved_at=now()
   WHERE quarantine.tenant_id=p_tenant_id
     AND quarantine.connection_id=p_connection_id
     AND quarantine.stream=p_stream
     AND quarantine.source_object_type=p_source_object_type
     AND quarantine.source_record_id=p_source_record_id
     AND quarantine.status='open'
     AND quarantine.error_code LIKE 'canonical.%';
  GET DIAGNOSTICS resolved_count=ROW_COUNT;
  RETURN resolved_count;
END $$;

COMMENT ON FUNCTION semantic_internal.record_canonical_mapping_quarantine(
  text,text,text,text,text,text,text,text,text,text,text,text
) IS 'Records a row-scoped canonical rejection against append-only manifest and committed landing evidence; mutable current source state is never used as historical proof.';
COMMENT ON FUNCTION semantic_internal.resolve_canonical_mapping_quarantine(
  text,text,text,text,text,text,text,text
) IS 'Heals canonical mapping quarantine after a later append-only batch and landing commit prove a valid transform boundary.';

REVOKE ALL ON FUNCTION
  semantic_internal.record_canonical_mapping_quarantine(
    text,text,text,text,text,text,text,text,text,text,text,text
  ),
  semantic_internal.resolve_canonical_mapping_quarantine(
    text,text,text,text,text,text,text,text
  )
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  semantic_internal.record_canonical_mapping_quarantine(
    text,text,text,text,text,text,text,text,text,text,text,text
  ),
  semantic_internal.resolve_canonical_mapping_quarantine(
    text,text,text,text,text,text,text,text
  )
TO transform_rw;

COMMIT;
