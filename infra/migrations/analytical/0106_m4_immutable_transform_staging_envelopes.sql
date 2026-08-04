BEGIN;

-- Canonical work is asynchronous. Vendor staging tables are intentionally
-- current-state projections, so their source-identity primary key can be
-- replaced before an older transform job is claimed. Preserve the exact typed
-- mapper input once per landed batch without widening the transform worker's
-- raw-storage authority.
CREATE TABLE IF NOT EXISTS ingestion.canonical_staging_batch_records (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  batch_id text NOT NULL CHECK (core.is_ulid(batch_id)),
  mapping_version text NOT NULL
    CHECK (mapping_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  namespaced_source_key text NOT NULL CHECK (length(btrim(namespaced_source_key))>0),
  connection_id text NOT NULL CHECK (core.is_ulid(connection_id)),
  sync_run_id text NOT NULL CHECK (core.is_ulid(sync_run_id)),
  connector_id text NOT NULL CHECK (connector_id IN ('lightspeed-r','xero','deputy')),
  stream text NOT NULL CHECK (stream ~ '^[a-z][a-z0-9_]{0,99}$'),
  source_object_type text NOT NULL
    CHECK (length(btrim(source_object_type)) BETWEEN 1 AND 200),
  source_record_id text NOT NULL
    CHECK (length(btrim(source_record_id)) BETWEEN 1 AND 300),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  staging_row jsonb NOT NULL CHECK (jsonb_typeof(staging_row)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,batch_id,mapping_version,namespaced_source_key),
  FOREIGN KEY (tenant_id,batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id,batch_id) ON DELETE CASCADE,
  CHECK (staging_row->>'tenant_id'=tenant_id),
  CHECK (staging_row->>'payload_batch_id'=batch_id),
  CHECK (staging_row->>'mapping_version'=mapping_version),
  CHECK (staging_row->>'namespaced_source_key'=namespaced_source_key),
  CHECK (staging_row->>'connection_id'=connection_id),
  CHECK (staging_row->>'sync_run_id'=sync_run_id),
  CHECK (staging_row->>'source_object_type'=source_object_type),
  CHECK (staging_row->>'source_record_id'=source_record_id),
  CHECK (staging_row->>'payload_hash'=payload_hash)
);

COMMENT ON TABLE ingestion.canonical_staging_batch_records IS
  'Append-only typed mapper inputs keyed by immutable landing batch. Current source_* projections may advance without invalidating queued canonical work.';

CREATE INDEX IF NOT EXISTS canonical_staging_batch_records_source_identity_idx
  ON ingestion.canonical_staging_batch_records(
    tenant_id,connection_id,stream,source_object_type,source_record_id
  );

-- Snapshot every typed row that still exists before enabling the new write
-- path. FORCE RLS is lifted only for table owners inside this migration
-- transaction and restored before commit; runtime policies remain enabled.
ALTER TABLE ingestion.source_records NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ingestion.landing_commits NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  relation record;
  connector_id text;
BEGIN
  FOR relation IN
    SELECT namespace.nspname AS schema_name,class.relname AS table_name
      FROM pg_class class
      JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
     WHERE class.relkind='r'
       AND namespace.nspname IN ('source_lightspeed','source_xero','source_deputy')
       AND NOT EXISTS (
         SELECT required.column_name
           FROM unnest(ARRAY[
             'tenant_id','namespaced_source_key','connection_id',
             'external_account_reference','source_record_id','payload_hash',
             'payload_batch_id','sync_run_id','mapping_version'
           ]) required(column_name)
          WHERE NOT EXISTS (
            SELECT 1
              FROM pg_attribute attribute
             WHERE attribute.attrelid=class.oid
               AND attribute.attname=required.column_name
               AND attribute.attnum>0
               AND NOT attribute.attisdropped
          )
       )
     ORDER BY namespace.nspname,class.relname
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I NO FORCE ROW LEVEL SECURITY',
      relation.schema_name,relation.table_name
    );
    connector_id:=CASE relation.schema_name
      WHEN 'source_lightspeed' THEN 'lightspeed-r'
      WHEN 'source_xero' THEN 'xero'
      WHEN 'source_deputy' THEN 'deputy'
      ELSE NULL
    END;
    EXECUTE format($sql$
      INSERT INTO ingestion.canonical_staging_batch_records (
        tenant_id,batch_id,mapping_version,namespaced_source_key,
        connection_id,sync_run_id,connector_id,stream,source_object_type,
        source_record_id,payload_hash,staging_row
      )
      SELECT staged.tenant_id,staged.payload_batch_id,staged.mapping_version,
             staged.namespaced_source_key,staged.connection_id,staged.sync_run_id,
             %L,%L,source.source_object_type,staged.source_record_id,
             staged.payload_hash,
             to_jsonb(staged)||jsonb_build_object(
               'source_object_type',source.source_object_type
             )
        FROM %I.%I staged
        JOIN ingestion.source_records source
          ON source.tenant_id=staged.tenant_id
         AND source.namespaced_source_key=staged.namespaced_source_key
         AND source.connection_id=staged.connection_id
         AND source.source_record_id=staged.source_record_id
        JOIN ingestion.landing_commits landing
          ON landing.tenant_id=staged.tenant_id
         AND landing.batch_id=staged.payload_batch_id
         AND landing.sync_run_id=staged.sync_run_id
         AND landing.mapping_version=staged.mapping_version
         AND landing.status='committed'
       WHERE source.connector_key=%L
         AND source.stream=%L
      ON CONFLICT DO NOTHING
    $sql$,
      connector_id,relation.table_name,
      relation.schema_name,relation.table_name,
      connector_id,relation.table_name
    );
  END LOOP;

  FOR relation IN
    SELECT namespace.nspname AS schema_name,class.relname AS table_name
      FROM pg_class class
      JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
     WHERE class.relkind='r'
       AND namespace.nspname IN ('source_lightspeed','source_xero','source_deputy')
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',
      relation.schema_name,relation.table_name
    );
  END LOOP;
END $$;
ALTER TABLE ingestion.source_records FORCE ROW LEVEL SECURITY;
ALTER TABLE ingestion.landing_commits FORCE ROW LEVEL SECURITY;

ALTER TABLE ingestion.canonical_staging_batch_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.canonical_staging_batch_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON ingestion.canonical_staging_batch_records;
CREATE POLICY tenant_scope ON ingestion.canonical_staging_batch_records
  USING (tenant_id=ingestion.current_tenant_id())
  WITH CHECK (tenant_id=ingestion.current_tenant_id());

REVOKE ALL ON ingestion.canonical_staging_batch_records FROM PUBLIC;
GRANT SELECT,INSERT ON ingestion.canonical_staging_batch_records TO ingest_rw;
GRANT SELECT ON ingestion.canonical_staging_batch_records TO transform_rw,diagnostic_ro;

-- Strengthen the 0105 repair now that exact immutable record evidence exists.
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
    JOIN ingestion.canonical_staging_batch_records staged
      ON staged.tenant_id=landing.tenant_id
     AND staged.batch_id=landing.batch_id
     AND staged.mapping_version=landing.mapping_version
     AND staged.connection_id=manifest.connection_id
     AND staged.sync_run_id=manifest.sync_run_id
   WHERE manifest.tenant_id=p_tenant_id
     AND manifest.batch_id=p_batch_id
     AND manifest.connection_id=p_connection_id
     AND manifest.sync_run_id=p_sync_run_id
     AND manifest.stream=p_stream
     AND landing.mapping_version=p_mapping_version
     AND landing.status='committed'
     AND staged.stream=p_stream
     AND staged.source_object_type=p_source_object_type
     AND staged.source_record_id=p_source_record_id
     AND staged.payload_hash=p_payload_hash;
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
      JOIN ingestion.canonical_staging_batch_records staged
        ON staged.tenant_id=landing.tenant_id
       AND staged.batch_id=landing.batch_id
       AND staged.mapping_version=landing.mapping_version
       AND staged.connection_id=manifest.connection_id
       AND staged.sync_run_id=manifest.sync_run_id
     WHERE manifest.tenant_id=p_tenant_id
       AND manifest.batch_id=p_batch_id
       AND manifest.connection_id=p_connection_id
       AND manifest.sync_run_id=p_sync_run_id
       AND manifest.stream=p_stream
       AND landing.status='committed'
       AND staged.stream=p_stream
       AND staged.source_object_type=p_source_object_type
       AND staged.source_record_id=p_source_record_id
       AND staged.payload_hash=p_payload_hash
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
