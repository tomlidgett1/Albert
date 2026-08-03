BEGIN;

-- The replay evidence routine is compiled lazily on first use. Its original
-- local `supplier_id` collided with core.purchase_order_line.supplier_id under
-- PostgreSQL's safe PL/pgSQL variable-conflict policy. Preserve the deployed
-- migration and replace the routine with an explicitly named resolved value.
CREATE OR REPLACE FUNCTION semantic_internal.record_lightspeed_order_dependency_replay(
  p_tenant_id text,p_connection_id text,p_repair_batch_id text,p_repair_sync_run_id text,
  p_source_order_namespaced_key text,p_source_order_payload_hash text,
  p_source_order_mapping_version text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE order_row record;repair_generation bigint;inserted_count integer;
DECLARE resolved_supplier_id text;raw_line_count bigint;expected_line_count bigint;
DECLARE unique_line_count bigint;materialized_line_count bigint;
BEGIN
  PERFORM semantic_internal.lock_lightspeed_supplier_replay(
    p_tenant_id,p_connection_id
  );
  repair_generation:=semantic_internal.lightspeed_supplier_replay_generation(
    p_tenant_id,p_connection_id,p_repair_batch_id
  );
  IF repair_generation IS NULL
     OR NOT core.is_ulid(p_repair_sync_run_id)
     OR length(btrim(p_source_order_namespaced_key)) NOT BETWEEN 1 AND 1000
     OR p_source_order_payload_hash !~ '^[a-f0-9]{64}$'
     OR length(btrim(p_source_order_mapping_version)) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Lightspeed dependency replay evidence is invalid' USING ERRCODE='22023';
  END IF;

  SELECT staged.source_record_id,btrim(staged.order_id) AS order_id,
         btrim(staged.vendor_id) AS vendor_id,staged.order_lines,
         staged.payload_batch_id,staged.sync_run_id,
         origin.payload_batch_id AS legacy_origin_batch_id,
         origin.sync_run_id AS legacy_origin_sync_run_id,
         origin.normalized_schema_version,repair_manifest.stream AS repair_stream
    INTO STRICT order_row
    FROM source_lightspeed.orders staged
    JOIN ingestion.batch_manifests staged_manifest
      ON staged_manifest.tenant_id=staged.tenant_id
     AND staged_manifest.batch_id=staged.payload_batch_id
     AND staged_manifest.connection_id=staged.connection_id
     AND staged_manifest.sync_run_id=staged.sync_run_id
     AND staged_manifest.connector_key='lightspeed-r' AND staged_manifest.stream='orders'
    JOIN ingestion.source_records origin
      ON origin.tenant_id=staged.tenant_id
     AND origin.namespaced_source_key=staged.namespaced_source_key
     AND origin.connection_id=staged.connection_id
     AND origin.connector_key='lightspeed-r' AND origin.stream='orders'
     AND origin.source_object_type='Order'
     AND origin.source_record_id=staged.source_record_id
     AND origin.payload_hash=staged.payload_hash
     AND origin.normalized_schema_version='1.0.0'
    JOIN ingestion.batch_manifests origin_manifest
      ON origin_manifest.tenant_id=origin.tenant_id
     AND origin_manifest.batch_id=origin.payload_batch_id
     AND origin_manifest.connection_id=origin.connection_id
     AND origin_manifest.sync_run_id=origin.sync_run_id
     AND origin_manifest.connector_key='lightspeed-r'
     AND origin_manifest.connector_version='1.0.0' AND origin_manifest.stream='orders'
    JOIN ingestion.batch_manifests repair_manifest
      ON repair_manifest.tenant_id=p_tenant_id AND repair_manifest.batch_id=p_repair_batch_id
     AND repair_manifest.connection_id=p_connection_id
     AND repair_manifest.sync_run_id=p_repair_sync_run_id
     AND repair_manifest.connector_key='lightspeed-r'
     AND repair_manifest.connector_version='1.1.0'
     AND repair_manifest.stream IN ('vendors','orders')
   WHERE staged.tenant_id=p_tenant_id AND staged.connection_id=p_connection_id
     AND staged.namespaced_source_key=p_source_order_namespaced_key
     AND staged.payload_hash=p_source_order_payload_hash
     AND staged.mapping_version=p_source_order_mapping_version
     AND NOT staged.tombstone AND nullif(btrim(staged.vendor_id),'') IS NOT NULL
     AND btrim(staged.vendor_id)<>'0'
     AND (
       jsonb_typeof(staged.order_lines->'OrderLine')='object'
       OR (jsonb_typeof(staged.order_lines->'OrderLine')='array'
           AND jsonb_array_length(staged.order_lines->'OrderLine')>0)
       OR (jsonb_typeof(staged.order_lines)='array'
           AND jsonb_array_length(staged.order_lines)>0)
     );

  SELECT supplier_state.canonical_id INTO STRICT resolved_supplier_id
    FROM semantic_internal.canonical_record_state supplier_state
    JOIN core.supplier supplier
      ON supplier.tenant_id=supplier_state.tenant_id
     AND supplier.id=supplier_state.canonical_id
   WHERE supplier_state.tenant_id=p_tenant_id
     AND supplier_state.canonical_table='supplier'
     AND supplier_state.connection_id=p_connection_id
     AND supplier_state.source_object_type='Vendor'
     AND supplier_state.source_record_id=order_row.vendor_id
     AND supplier_state.mapping_version=p_source_order_mapping_version;

  WITH raw_line AS (
    SELECT line.value,line.ordinality
      FROM jsonb_array_elements(CASE
        WHEN jsonb_typeof(order_row.order_lines->'OrderLine')='array'
          THEN order_row.order_lines->'OrderLine'
        WHEN jsonb_typeof(order_row.order_lines->'OrderLine')='object'
          THEN jsonb_build_array(order_row.order_lines->'OrderLine')
        WHEN jsonb_typeof(order_row.order_lines)='array'
          THEN order_row.order_lines
        ELSE '[]'::jsonb
      END) WITH ORDINALITY line(value,ordinality)
  ), expected_line AS (
    SELECT CASE
             WHEN jsonb_typeof(line.value->'orderLineID') IN ('string','number','boolean')
              AND nullif(btrim(line.value->>'orderLineID'),'') IS NOT NULL
              AND btrim(line.value->>'orderLineID')<>'0'
               THEN btrim(line.value->>'orderLineID')
             ELSE order_row.order_id||'#order-line:'||line.ordinality::text
           END AS source_record_id
      FROM raw_line line
     WHERE jsonb_typeof(line.value)='object'
  )
  SELECT
    (SELECT count(*) FROM raw_line),
    count(*),
    count(DISTINCT expected.source_record_id),
    count(*) FILTER (WHERE fact.id IS NOT NULL)
    INTO raw_line_count,expected_line_count,unique_line_count,materialized_line_count
    FROM expected_line expected
    LEFT JOIN semantic_internal.canonical_record_state state
      ON state.tenant_id=p_tenant_id
     AND state.canonical_table='purchase_order_line'
     AND state.connection_id=p_connection_id
     AND state.source_object_type='OrderLine'
     AND state.source_record_id=expected.source_record_id
     AND state.batch_id=order_row.payload_batch_id
     AND state.sync_run_id=order_row.sync_run_id
     AND state.payload_hash=p_source_order_payload_hash
     AND state.mapping_version=p_source_order_mapping_version
    LEFT JOIN core.purchase_order_line fact
      ON fact.tenant_id=state.tenant_id AND fact.id=state.canonical_id
     AND fact.primary_connection_id=p_connection_id
     AND fact.primary_source_record_id=expected.source_record_id
     AND fact.sync_run_id=order_row.sync_run_id
     AND fact.purchase_order_ref=order_row.order_id
     AND fact.supplier_id=resolved_supplier_id;
  IF raw_line_count<>expected_line_count OR expected_line_count=0
     OR unique_line_count<>expected_line_count
     OR materialized_line_count<>expected_line_count THEN
    RAISE EXCEPTION 'Lightspeed replay canonical materialization is incomplete: % of %',
      materialized_line_count,expected_line_count USING ERRCODE='55000';
  END IF;

  INSERT INTO semantic_internal.lightspeed_order_dependency_replay_audit (
    tenant_id,connection_id,connection_generation,repair_batch_id,repair_sync_run_id,
    repair_stream,supplier_source_record_id,source_order_namespaced_key,
    source_order_record_id,source_order_payload_hash,source_order_mapping_version,
    source_order_batch_id,source_order_sync_run_id,legacy_origin_batch_id,
    legacy_origin_sync_run_id,legacy_normalized_schema_version,
    materialized_command_count,result,reason
  ) VALUES (
    p_tenant_id,p_connection_id,repair_generation,p_repair_batch_id,p_repair_sync_run_id,
    order_row.repair_stream,order_row.vendor_id,p_source_order_namespaced_key,
    order_row.source_record_id,p_source_order_payload_hash,p_source_order_mapping_version,
    order_row.payload_batch_id,order_row.sync_run_id,order_row.legacy_origin_batch_id,
    order_row.legacy_origin_sync_run_id,order_row.normalized_schema_version,
    materialized_line_count,'materialized','vendor_stream_introduction'
  ) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted_count=ROW_COUNT;
  RETURN inserted_count=1;
EXCEPTION
  WHEN no_data_found OR too_many_rows THEN
    RAISE EXCEPTION 'Lightspeed dependency replay lineage is missing or ambiguous'
      USING ERRCODE='23503';
END;
$$;

REVOKE ALL ON FUNCTION semantic_internal.record_lightspeed_order_dependency_replay(
  text,text,text,text,text,text,text
) FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT EXECUTE ON FUNCTION semantic_internal.record_lightspeed_order_dependency_replay(
  text,text,text,text,text,text,text
) TO transform_rw;

COMMIT;
