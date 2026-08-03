BEGIN;

-- Preserve the one-use capability wrappers from 0083 while enriching the
-- final, post-purge result with privacy-safe residual counts. No row values,
-- identifiers or payloads cross into the immutable control-plane proof.
ALTER FUNCTION deletion_internal.verify_tenant_pre_capability(text)
  RENAME TO verify_tenant_before_granular_residuals;
ALTER FUNCTION deletion_internal.verify_connection_pre_capability(text,text)
  RENAME TO verify_connection_before_granular_residuals;

CREATE OR REPLACE FUNCTION deletion_internal.verify_tenant_pre_capability(
  p_tenant_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE table_row record;row_count bigint;total bigint:=0;
DECLARE staging bigint:=0;canonical bigint:=0;bridge bigint:=0;links bigint:=0;
DECLARE embeddings bigint:=0;caches bigint:=0;other_rows bigint:=0;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) THEN
    RAISE EXCEPTION 'tenant id must be a ULID' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('albert.tenant_id',p_tenant_id,true);
  FOR table_row IN
    SELECT DISTINCT column_value.table_schema,column_value.table_name
      FROM information_schema.columns column_value
      JOIN information_schema.tables table_value
        ON table_value.table_schema=column_value.table_schema
       AND table_value.table_name=column_value.table_name
     WHERE column_value.column_name='tenant_id'
       AND table_value.table_type='BASE TABLE'
       AND column_value.table_schema IN (
         'ingestion','source_lightspeed','source_xero','source_deputy',
         'core','quality','mart','semantic_internal'
       )
     ORDER BY column_value.table_schema,column_value.table_name
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I WHERE tenant_id=$1',
      table_row.table_schema,table_row.table_name) INTO row_count USING p_tenant_id;
    total:=total+row_count;
    IF table_row.table_name ~ '(embedding|vector)' THEN
      embeddings:=embeddings+row_count;
    ELSIF table_row.table_name ~ 'cache' THEN
      caches:=caches+row_count;
    ELSIF table_row.table_schema IN (
      'ingestion','source_lightspeed','source_xero','source_deputy'
    ) THEN
      staging:=staging+row_count;
    ELSIF table_row.table_schema='mart'
       OR table_row.table_name ~ '(aligned|bridge|reconciliation|source_observation|event_link)' THEN
      bridge:=bridge+row_count;
    ELSIF table_row.table_name ~ '(link|identity|association|authority|entity_resolution)' THEN
      links:=links+row_count;
    ELSIF table_row.table_schema='core' THEN
      canonical:=canonical+row_count;
    ELSE
      other_rows:=other_rows+row_count;
    END IF;
  END LOOP;
  RETURN jsonb_build_object(
    'verified',total=0,
    'scope','tenant',
    'measurement','post_purge_row_counts_v1',
    'remainingRows',total,
    'residuals',jsonb_build_object(
      'stagingRows',staging,
      'canonicalRows',canonical,
      'bridgeRows',bridge,
      'linkRows',links,
      'embeddingRows',embeddings,
      'cacheRows',caches,
      'otherAnalyticalRows',other_rows
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION deletion_internal.verify_connection_pre_capability(
  p_tenant_id text,p_connection_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  base jsonb;
  table_row record;
  connection_column text;
  scope_predicate text;
  row_count bigint;
  legacy_remaining bigint;
  total bigint;
  staging bigint:=0;
  canonical bigint:=0;
  bridge bigint:=0;
  links bigint:=0;
  embeddings bigint:=0;
  caches bigint:=0;
  other_rows bigint:=0;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) OR NOT core.is_ulid(p_connection_id) THEN
    RAISE EXCEPTION 'deletion scope identifiers must be ULIDs' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('albert.tenant_id',p_tenant_id,true);

  -- Preserve the superseded verifier as a compatibility backstop. Its count
  -- is never presented as a synthetic category: any row class that a future
  -- verifier knows about but this classifier does not is measured into the
  -- explicit otherAnalyticalRows remainder below.
  base:=deletion_internal.verify_connection_before_granular_residuals(
    p_tenant_id,p_connection_id
  );
  legacy_remaining:=coalesce((base->>'remainingRows')::bigint,0);

  -- Count every tenant table that has a direct connection reference. This is
  -- deliberately catalog-driven so a new primary/from/to/authoritative (or
  -- otherwise named) *_connection_id column becomes deletion evidence without
  -- waiting for another hand-maintained verifier list.
  FOR table_row IN
    SELECT
      column_value.table_schema,
      column_value.table_name,
      array_agg(column_value.column_name ORDER BY column_value.ordinal_position)
        FILTER (
          WHERE column_value.column_name='connection_id'
             OR column_value.column_name ~ '_connection_id$'
        ) AS connection_columns
      FROM information_schema.columns column_value
      JOIN information_schema.tables table_value
        ON table_value.table_schema=column_value.table_schema
       AND table_value.table_name=column_value.table_name
     WHERE table_value.table_type='BASE TABLE'
       AND column_value.table_schema IN (
         'ingestion','source_lightspeed','source_xero','source_deputy',
         'core','quality','mart','semantic_internal'
       )
     GROUP BY column_value.table_schema,column_value.table_name
    HAVING bool_or(column_value.column_name='tenant_id')
     ORDER BY column_value.table_schema,column_value.table_name
  LOOP
    scope_predicate:=NULL;

    -- These structures are invalidated tenant-wide on disconnect because they
    -- can transitively contain the disconnected source. Embeddings and caches
    -- follow the same fail-closed rule, including future tables of those kinds.
    IF concat_ws('.',table_row.table_schema,table_row.table_name)=ANY(ARRAY[
      'core.entity_identity_edge',
      'core.entity_resolution',
      'quality.check_result',
      'quality.finding',
      'quality.pipeline_stats',
      'semantic_internal.identity_decision_history',
      'semantic_internal.identity_graph_state',
      'semantic_internal.identity_link_baseline',
      'semantic_internal.identity_review_projection_outbox',
      'semantic_internal.pipeline_stats_projection_outbox',
      'semantic_internal.pipeline_table_stats_projection_outbox',
      'semantic_internal.query_audit',
      'semantic_internal.readiness_projection_outbox',
      'semantic_internal.result_cache'
    ]::text[])
       OR table_row.table_name ~ '(embedding|vector|cache)' THEN
      -- Reference $2 as well as $1 so every dynamic statement has one stable
      -- parameter contract; both identifiers were validated as non-null ULIDs.
      scope_predicate:='$2 IS NOT NULL';
    ELSIF table_row.connection_columns IS NOT NULL THEN
      FOREACH connection_column IN ARRAY table_row.connection_columns LOOP
        scope_predicate:=concat_ws(
          ' OR ',scope_predicate,format('residual.%I=$2',connection_column)
        );
      END LOOP;
    END IF;

    -- Tables without a connection reference may lawfully contain data rebuilt
    -- from the tenant's remaining sources, so they are not false residuals.
    CONTINUE WHEN scope_predicate IS NULL;

    EXECUTE format(
      'SELECT count(*) FROM %I.%I AS residual
        WHERE residual.tenant_id=$1 AND (%s)',
      table_row.table_schema,table_row.table_name,scope_predicate
    ) INTO row_count USING p_tenant_id,p_connection_id;

    IF table_row.table_name ~ '(embedding|vector)' THEN
      embeddings:=embeddings+row_count;
    ELSIF table_row.table_name ~ 'cache' THEN
      caches:=caches+row_count;
    ELSIF table_row.table_schema IN (
      'ingestion','source_lightspeed','source_xero','source_deputy'
    ) THEN
      staging:=staging+row_count;
    ELSIF table_row.table_schema='mart'
       OR table_row.table_name ~ '(aligned|bridge|reconciliation|source_observation|event_link)' THEN
      bridge:=bridge+row_count;
    ELSIF table_row.table_name ~ '(link|identity|association|authority|entity_resolution)' THEN
      links:=links+row_count;
    ELSIF table_row.table_schema='core'
       OR table_row.table_name ~ 'canonical' THEN
      canonical:=canonical+row_count;
    ELSE
      other_rows:=other_rows+row_count;
    END IF;
  END LOOP;

  total:=staging+canonical+bridge+links+embeddings+caches+other_rows;
  IF legacy_remaining>total THEN
    other_rows:=other_rows+(legacy_remaining-total);
  END IF;
  total:=staging+canonical+bridge+links+embeddings+caches+other_rows;

  RETURN jsonb_build_object(
    'verified',coalesce((base->>'verified')::boolean,false) AND total=0,
    'scope','connection',
    'measurement','post_purge_row_counts_v1',
    'remainingRows',total,
    'residuals',jsonb_build_object(
      'stagingRows',staging,
      'canonicalRows',canonical,
      'bridgeRows',bridge,
      'linkRows',links,
      'embeddingRows',embeddings,
      'cacheRows',caches,
      'otherAnalyticalRows',other_rows
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION
  deletion_internal.verify_tenant_before_granular_residuals(text),
  deletion_internal.verify_connection_before_granular_residuals(text,text),
  deletion_internal.verify_tenant_pre_capability(text),
  deletion_internal.verify_connection_pre_capability(text,text)
FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;

GRANT EXECUTE ON FUNCTION
  deletion_internal.verify_tenant_pre_capability(text),
  deletion_internal.verify_connection_pre_capability(text,text)
TO albert_migration_owner;

COMMIT;
