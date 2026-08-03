BEGIN;

-- PostgreSQL resolves unqualified PL/pgSQL names against both local variables
-- and query columns. The original implementation named a local JSON document
-- `status`, which made the quality.check_result.status references ambiguous at
-- execution time. Keep the deployed migration immutable and replace the
-- function additively with an unambiguous local name and qualified columns.
CREATE OR REPLACE FUNCTION quality.snapshot_all_pipeline_stats(
  p_tenant_id text,p_snapshot_at timestamptz,p_domains text[],p_source_watermarks jsonb
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,core,quality,semantic_internal AS $$
DECLARE
  item record;
  row_total bigint;
  max_event timestamptz;
  max_ingested timestamptz;
  invariant_status jsonb;
  source_total bigint:=0;
  rejected_total bigint:=0;
  observed_total bigint:=0;
  linked_total bigint:=0;
  canonical_total bigint:=0;
  domain_name text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_source_watermarks)<>'object' THEN RAISE EXCEPTION 'source watermarks must be an object' USING ERRCODE='22023'; END IF;
  SELECT coalesce(jsonb_object_agg(latest.check_id,latest.check_status),'{}'::jsonb)
    INTO invariant_status
    FROM (
      SELECT DISTINCT ON (result.check_id)
        result.check_id,
        result.status AS check_status
      FROM quality.check_result AS result
      WHERE result.tenant_id=p_tenant_id
      ORDER BY result.check_id,result.checked_at DESC
    ) AS latest;
  FOR item IN SELECT * FROM (VALUES
    ('core','location','updated_at'),('core','register','updated_at'),('core','channel','updated_at'),('core','legal_entity','updated_at'),
    ('core','person','updated_at'),('core','customer_account','updated_at'),('core','worker','updated_at'),('core','employment_episode','updated_at'),
    ('core','supplier','updated_at'),('core','product','updated_at'),('core','product_variant','updated_at'),('core','product_category','updated_at'),
    ('core','gl_account','updated_at'),('core','tax_code','updated_at'),('core','stock_location','updated_at'),
    ('core','commerce_order','completed_at'),('core','commerce_order_line','completed_at'),('core','commerce_payment','paid_at'),
    ('core','commerce_refund_line','refunded_at'),('core','inventory_movement','occurred_at'),('core','inventory_balance_snapshot','snapshot_at'),
    ('core','purchase_order_line','ordered_at'),('core','finance_journal_line','posted_at'),('core','finance_invoice_line','issued_at'),
    ('core','finance_bank_transaction','transaction_at'),('core','workforce_shift','starts_at'),('core','workforce_time_entry','starts_at'),('core','workforce_leave','starts_at'),
    ('core','product_category_assignment','effective_from'),('core','order_source_observation','valid_from'),
    ('core','order_line_source_observation','created_at'),('core','event_link','created_at'),
    ('core','entity_source_link','valid_from'),('core','source_authority','effective_from'),
    ('mart','sales_day_location','refreshed_at'),('mart','labour_day_location','refreshed_at')
  ) AS tables(schema_name,table_name,event_column)
  LOOP
    IF item.schema_name='mart' THEN
      EXECUTE format('SELECT count(*),max(%I)::timestamptz,max(refreshed_at)::timestamptz FROM %I.%I WHERE tenant_id=$1',item.event_column,item.schema_name,item.table_name)
        INTO row_total,max_event,max_ingested USING p_tenant_id;
    ELSIF item.table_name=ANY(ARRAY[
      'product_category_assignment','order_source_observation',
      'order_line_source_observation','event_link','entity_source_link'
    ]) THEN
      EXECUTE format('SELECT count(*),max(%I)::timestamptz,max(created_at)::timestamptz FROM %I.%I WHERE tenant_id=$1',item.event_column,item.schema_name,item.table_name)
        INTO row_total,max_event,max_ingested USING p_tenant_id;
    ELSE
      EXECUTE format('SELECT count(*),max(%I)::timestamptz,max(updated_at)::timestamptz FROM %I.%I WHERE tenant_id=$1',item.event_column,item.schema_name,item.table_name)
        INTO row_total,max_event,max_ingested USING p_tenant_id;
    END IF;
    INSERT INTO semantic_internal.pipeline_table_stats_projection_outbox (
      tenant_id,projection_id,snapshot_at,schema_name,table_name,row_count,max_event_at,max_ingested_at,invariant_status
    ) VALUES (
      p_tenant_id,semantic_internal.deterministic_ulid('pipeline-stat|'||p_tenant_id||'|'||p_snapshot_at::text||'|'||item.schema_name||'|'||item.table_name),
      p_snapshot_at,item.schema_name,item.table_name,row_total,max_event,max_ingested,invariant_status
    ) ON CONFLICT (tenant_id,snapshot_at,schema_name,table_name) DO NOTHING;
  END LOOP;
  FOR item IN
    SELECT source_table.table_schema AS schema_name,source_table.table_name
    FROM information_schema.tables AS source_table
    WHERE source_table.table_schema IN ('source_lightspeed','source_xero','source_deputy')
      AND source_table.table_type='BASE TABLE'
    ORDER BY source_table.table_schema,source_table.table_name
  LOOP
    EXECUTE format('SELECT count(*),max(source_updated_at),max(ingested_at) FROM %I.%I WHERE tenant_id=$1',item.schema_name,item.table_name)
      INTO row_total,max_event,max_ingested USING p_tenant_id;
    source_total:=source_total+row_total;
    INSERT INTO semantic_internal.pipeline_table_stats_projection_outbox (
      tenant_id,projection_id,snapshot_at,schema_name,table_name,row_count,max_event_at,max_ingested_at,invariant_status
    ) VALUES (
      p_tenant_id,semantic_internal.deterministic_ulid('pipeline-stat|'||p_tenant_id||'|'||p_snapshot_at::text||'|'||item.schema_name||'|'||item.table_name),
      p_snapshot_at,item.schema_name,item.table_name,row_total,max_event,max_ingested,invariant_status
    ) ON CONFLICT (tenant_id,snapshot_at,schema_name,table_name) DO NOTHING;
  END LOOP;
  SELECT count(*) INTO rejected_total FROM ingestion.quarantine_records AS quarantine
   WHERE quarantine.tenant_id=p_tenant_id AND quarantine.status='open';
  SELECT count(*) INTO observed_total FROM semantic_internal.identity_observation AS observation
   WHERE observation.tenant_id=p_tenant_id AND observation.active;
  SELECT count(*) INTO linked_total FROM core.entity_source_link AS source_link
   WHERE source_link.tenant_id=p_tenant_id
     AND source_link.match_status='accepted'
     AND source_link.valid_to IS NULL;
  FOREACH domain_name IN ARRAY (
    CASE WHEN cardinality(p_domains)>0 THEN p_domains
         ELSE ARRAY['canonical']::text[] END
  ) LOOP
    IF domain_name=ANY(ARRAY[
      'location','register','channel','legal_entity','person','customer_account','worker','employment_episode',
      'supplier','product','product_variant','product_category','gl_account','tax_code','stock_location',
      'commerce_order','commerce_order_line','commerce_payment','commerce_refund_line','inventory_movement',
      'inventory_balance_snapshot','purchase_order_line','finance_journal_line','finance_invoice_line',
      'finance_bank_transaction','workforce_shift','workforce_time_entry','workforce_leave',
      'product_category_assignment','order_source_observation','order_line_source_observation',
      'event_link','entity_source_link','source_authority'
    ]) THEN
      EXECUTE format('SELECT count(*) FROM core.%I WHERE tenant_id=$1',domain_name)
        INTO canonical_total USING p_tenant_id;
    ELSE
      SELECT coalesce(sum(totals.latest_count),0) INTO canonical_total FROM (
        SELECT projection.row_count AS latest_count
          FROM semantic_internal.pipeline_table_stats_projection_outbox AS projection
         WHERE projection.tenant_id=p_tenant_id
           AND projection.snapshot_at=p_snapshot_at
           AND projection.schema_name='core'
      ) AS totals;
    END IF;
    PERFORM quality.snapshot_pipeline_stats(
      p_tenant_id,p_snapshot_at,domain_name,source_total,canonical_total,rejected_total,
      observed_total,linked_total,p_source_watermarks,invariant_status
    );
  END LOOP;
END $$;

COMMENT ON FUNCTION quality.snapshot_all_pipeline_stats(text,timestamptz,text[],jsonb) IS
  'Snapshots tenant-scoped canonical/source pipeline metrics and the latest fully qualified invariant statuses.';

REVOKE ALL ON FUNCTION quality.snapshot_all_pipeline_stats(text,timestamptz,text[],jsonb)
  FROM PUBLIC,ingest_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT EXECUTE ON FUNCTION quality.snapshot_all_pipeline_stats(text,timestamptz,text[],jsonb)
  TO transform_rw;

COMMIT;
