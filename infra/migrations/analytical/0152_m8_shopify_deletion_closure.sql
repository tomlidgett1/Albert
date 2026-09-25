BEGIN;

-- Shopify staging is connector-owned and may grow as the locked API surface
-- evolves. Extend deletion beneath the signed, one-use wrappers by discovering
-- every base table in source_shopify, while preserving the Momence,
-- Lightspeed X-Series, and Square delegates already in the predecessor chain.
ALTER FUNCTION deletion_internal.purge_connection_pre_capability(text,text)
  RENAME TO purge_connection_before_shopify_staging;
ALTER FUNCTION deletion_internal.purge_tenant_pre_capability(text)
  RENAME TO purge_tenant_before_shopify_staging;
ALTER FUNCTION deletion_internal.verify_connection_pre_capability(text,text)
  RENAME TO verify_connection_before_shopify_staging;
ALTER FUNCTION deletion_internal.verify_tenant_pre_capability(text)
  RENAME TO verify_tenant_before_shopify_staging;

CREATE FUNCTION deletion_internal.purge_connection_pre_capability(
  p_tenant_id text,p_connection_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  table_row record;
  affected bigint;
  removed bigint:=0;
  remaining bigint:=0;
  pass integer;
  changed boolean;
  result jsonb;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) OR NOT core.is_ulid(p_connection_id) THEN
    RAISE EXCEPTION 'deletion scope identifiers must be ULIDs'
      USING ERRCODE='22023';
  END IF;
  PERFORM set_config('albert.tenant_id',p_tenant_id,true);
  PERFORM set_config('albert.deletion_authorized','on',true);
  PERFORM pg_advisory_xact_lock(hashtextextended('deletion:'||p_tenant_id,0));

  -- Every table must remain tenant- and connection-addressable. Retry in
  -- dependency-safe passes so future Shopify child tables cannot strand data.
  FOR pass IN 1..80 LOOP
    changed:=false;
    FOR table_row IN
      SELECT
        table_value.table_name,
        bool_or(column_value.column_name='tenant_id') AS has_tenant_id,
        bool_or(column_value.column_name='connection_id') AS has_connection_id
      FROM information_schema.tables table_value
      JOIN information_schema.columns column_value
        ON column_value.table_schema=table_value.table_schema
       AND column_value.table_name=table_value.table_name
      WHERE table_value.table_schema='source_shopify'
        AND table_value.table_type='BASE TABLE'
      GROUP BY table_value.table_name
      ORDER BY table_value.table_name
    LOOP
      IF NOT table_row.has_tenant_id OR NOT table_row.has_connection_id THEN
        RAISE EXCEPTION 'source_shopify table % lacks tenant_id or connection_id',
          table_row.table_name
          USING ERRCODE='55000';
      END IF;
      BEGIN
        EXECUTE format(
          'DELETE FROM source_shopify.%I
            WHERE tenant_id=$1 AND connection_id=$2',
          table_row.table_name
        ) USING p_tenant_id,p_connection_id;
        GET DIAGNOSTICS affected=ROW_COUNT;
        IF affected>0 THEN
          removed:=removed+affected;
          changed:=true;
        END IF;
      EXCEPTION WHEN foreign_key_violation THEN
        NULL;
      END;
    END LOOP;
    EXIT WHEN NOT changed;
  END LOOP;

  FOR table_row IN
    SELECT
      table_value.table_name,
      bool_or(column_value.column_name='tenant_id') AS has_tenant_id,
      bool_or(column_value.column_name='connection_id') AS has_connection_id
    FROM information_schema.tables table_value
    JOIN information_schema.columns column_value
      ON column_value.table_schema=table_value.table_schema
     AND column_value.table_name=table_value.table_name
    WHERE table_value.table_schema='source_shopify'
      AND table_value.table_type='BASE TABLE'
    GROUP BY table_value.table_name
    ORDER BY table_value.table_name
  LOOP
    IF NOT table_row.has_tenant_id OR NOT table_row.has_connection_id THEN
      RAISE EXCEPTION 'source_shopify table % lacks tenant_id or connection_id',
        table_row.table_name
        USING ERRCODE='55000';
    END IF;
    EXECUTE format(
      'SELECT count(*) FROM source_shopify.%I AS residual
        WHERE residual.tenant_id=$1 AND residual.connection_id=$2',
      table_row.table_name
    ) INTO affected USING p_tenant_id,p_connection_id;
    remaining:=remaining+affected;
  END LOOP;
  IF remaining>0 THEN
    RAISE EXCEPTION 'Shopify connection purge left % staging rows',remaining
      USING ERRCODE='55000';
  END IF;

  -- Source rows must be gone before the predecessor removes their immutable
  -- ingestion.batch_manifests parents.
  result:=deletion_internal.purge_connection_before_shopify_staging(
    p_tenant_id,p_connection_id
  );
  RETURN jsonb_set(
    result,
    '{rowsRemoved}',
    to_jsonb(coalesce((result->>'rowsRemoved')::bigint,0)+removed),
    true
  );
END;
$$;

CREATE FUNCTION deletion_internal.purge_tenant_pre_capability(
  p_tenant_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  table_row record;
  affected bigint;
  removed bigint:=0;
  remaining bigint:=0;
  pass integer;
  changed boolean;
  result jsonb;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) THEN
    RAISE EXCEPTION 'tenant id must be a ULID' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('albert.tenant_id',p_tenant_id,true);
  PERFORM set_config('albert.deletion_authorized','on',true);
  PERFORM pg_advisory_xact_lock(hashtextextended('deletion:'||p_tenant_id,0));

  FOR pass IN 1..80 LOOP
    changed:=false;
    FOR table_row IN
      SELECT
        table_value.table_name,
        bool_or(column_value.column_name='tenant_id') AS has_tenant_id
      FROM information_schema.tables table_value
      JOIN information_schema.columns column_value
        ON column_value.table_schema=table_value.table_schema
       AND column_value.table_name=table_value.table_name
      WHERE table_value.table_schema='source_shopify'
        AND table_value.table_type='BASE TABLE'
      GROUP BY table_value.table_name
      ORDER BY table_value.table_name
    LOOP
      IF NOT table_row.has_tenant_id THEN
        RAISE EXCEPTION 'source_shopify table % lacks tenant_id',
          table_row.table_name
          USING ERRCODE='55000';
      END IF;
      BEGIN
        EXECUTE format(
          'DELETE FROM source_shopify.%I WHERE tenant_id=$1',
          table_row.table_name
        ) USING p_tenant_id;
        GET DIAGNOSTICS affected=ROW_COUNT;
        IF affected>0 THEN
          removed:=removed+affected;
          changed:=true;
        END IF;
      EXCEPTION WHEN foreign_key_violation THEN
        NULL;
      END;
    END LOOP;
    EXIT WHEN NOT changed;
  END LOOP;

  FOR table_row IN
    SELECT
      table_value.table_name,
      bool_or(column_value.column_name='tenant_id') AS has_tenant_id
    FROM information_schema.tables table_value
    JOIN information_schema.columns column_value
      ON column_value.table_schema=table_value.table_schema
     AND column_value.table_name=table_value.table_name
    WHERE table_value.table_schema='source_shopify'
      AND table_value.table_type='BASE TABLE'
    GROUP BY table_value.table_name
    ORDER BY table_value.table_name
  LOOP
    IF NOT table_row.has_tenant_id THEN
      RAISE EXCEPTION 'source_shopify table % lacks tenant_id',
        table_row.table_name
        USING ERRCODE='55000';
    END IF;
    EXECUTE format(
      'SELECT count(*) FROM source_shopify.%I WHERE tenant_id=$1',
      table_row.table_name
    ) INTO affected USING p_tenant_id;
    remaining:=remaining+affected;
  END LOOP;
  IF remaining>0 THEN
    RAISE EXCEPTION 'Shopify tenant purge left % staging rows',remaining
      USING ERRCODE='55000';
  END IF;

  result:=deletion_internal.purge_tenant_before_shopify_staging(p_tenant_id);
  RETURN jsonb_set(
    result,
    '{rowsRemoved}',
    to_jsonb(coalesce((result->>'rowsRemoved')::bigint,0)+removed),
    true
  );
END;
$$;

CREATE FUNCTION deletion_internal.verify_connection_pre_capability(
  p_tenant_id text,p_connection_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE table_row record;row_count bigint;shopify_remaining bigint:=0;base jsonb;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) OR NOT core.is_ulid(p_connection_id) THEN
    RAISE EXCEPTION 'deletion scope identifiers must be ULIDs'
      USING ERRCODE='22023';
  END IF;
  PERFORM set_config('albert.tenant_id',p_tenant_id,true);
  base:=deletion_internal.verify_connection_before_shopify_staging(
    p_tenant_id,p_connection_id
  );

  IF jsonb_typeof(base)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(base))<>5
     OR base->>'scope'<>'connection'
     OR base->>'measurement'<>'post_purge_row_counts_v1'
     OR jsonb_typeof(base->'residuals')<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(base->'residuals'))<>7
     OR NOT ((base->'residuals') ?& ARRAY[
       'stagingRows','canonicalRows','bridgeRows','linkRows',
       'embeddingRows','cacheRows','otherAnalyticalRows'
     ]::text[]) THEN
    RAISE EXCEPTION 'connection deletion attestation shape is invalid'
      USING ERRCODE='55000';
  END IF;

  FOR table_row IN
    SELECT
      table_value.table_name,
      bool_or(column_value.column_name='tenant_id') AS has_tenant_id,
      bool_or(column_value.column_name='connection_id') AS has_connection_id
    FROM information_schema.tables table_value
    JOIN information_schema.columns column_value
      ON column_value.table_schema=table_value.table_schema
     AND column_value.table_name=table_value.table_name
    WHERE table_value.table_schema='source_shopify'
      AND table_value.table_type='BASE TABLE'
    GROUP BY table_value.table_name
    ORDER BY table_value.table_name
  LOOP
    IF NOT table_row.has_tenant_id OR NOT table_row.has_connection_id THEN
      RAISE EXCEPTION 'source_shopify table % lacks tenant_id or connection_id',
        table_row.table_name
        USING ERRCODE='55000';
    END IF;
    EXECUTE format(
      'SELECT count(*) FROM source_shopify.%I AS residual
        WHERE residual.tenant_id=$1 AND residual.connection_id=$2',
      table_row.table_name
    ) INTO row_count USING p_tenant_id,p_connection_id;
    shopify_remaining:=shopify_remaining+row_count;
  END LOOP;

  base:=jsonb_set(
    base,
    '{residuals,stagingRows}',
    to_jsonb(coalesce((base#>>'{residuals,stagingRows}')::bigint,0)+shopify_remaining),
    false
  );
  base:=jsonb_set(
    base,
    '{remainingRows}',
    to_jsonb(coalesce((base->>'remainingRows')::bigint,0)+shopify_remaining),
    false
  );
  RETURN jsonb_set(
    base,
    '{verified}',
    to_jsonb(coalesce((base->>'verified')::boolean,false) AND shopify_remaining=0),
    false
  );
END;
$$;

CREATE FUNCTION deletion_internal.verify_tenant_pre_capability(
  p_tenant_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE table_row record;row_count bigint;shopify_remaining bigint:=0;base jsonb;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) THEN
    RAISE EXCEPTION 'tenant id must be a ULID' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('albert.tenant_id',p_tenant_id,true);
  base:=deletion_internal.verify_tenant_before_shopify_staging(p_tenant_id);

  IF jsonb_typeof(base)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(base))<>5
     OR base->>'scope'<>'tenant'
     OR base->>'measurement'<>'post_purge_row_counts_v1'
     OR jsonb_typeof(base->'residuals')<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(base->'residuals'))<>7
     OR NOT ((base->'residuals') ?& ARRAY[
       'stagingRows','canonicalRows','bridgeRows','linkRows',
       'embeddingRows','cacheRows','otherAnalyticalRows'
     ]::text[]) THEN
    RAISE EXCEPTION 'tenant deletion attestation shape is invalid'
      USING ERRCODE='55000';
  END IF;

  FOR table_row IN
    SELECT
      table_value.table_name,
      bool_or(column_value.column_name='tenant_id') AS has_tenant_id
    FROM information_schema.tables table_value
    JOIN information_schema.columns column_value
      ON column_value.table_schema=table_value.table_schema
     AND column_value.table_name=table_value.table_name
    WHERE table_value.table_schema='source_shopify'
      AND table_value.table_type='BASE TABLE'
    GROUP BY table_value.table_name
    ORDER BY table_value.table_name
  LOOP
    IF NOT table_row.has_tenant_id THEN
      RAISE EXCEPTION 'source_shopify table % lacks tenant_id',
        table_row.table_name
        USING ERRCODE='55000';
    END IF;
    EXECUTE format(
      'SELECT count(*) FROM source_shopify.%I AS residual
        WHERE residual.tenant_id=$1',
      table_row.table_name
    ) INTO row_count USING p_tenant_id;
    shopify_remaining:=shopify_remaining+row_count;
  END LOOP;

  base:=jsonb_set(
    base,
    '{residuals,stagingRows}',
    to_jsonb(coalesce((base#>>'{residuals,stagingRows}')::bigint,0)+shopify_remaining),
    false
  );
  base:=jsonb_set(
    base,
    '{remainingRows}',
    to_jsonb(coalesce((base->>'remainingRows')::bigint,0)+shopify_remaining),
    false
  );
  RETURN jsonb_set(
    base,
    '{verified}',
    to_jsonb(coalesce((base->>'verified')::boolean,false) AND shopify_remaining=0),
    false
  );
END;
$$;

-- Recreate the stable public entry points on their existing OIDs so any
-- always-on deletion-worker session invalidates a cached predecessor plan and
-- resolves the complete Shopify -> Momence -> Lightspeed X -> Square chain.
CREATE OR REPLACE FUNCTION deletion_internal.purge_connection(
  p_tenant_id text,p_connection_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE claims jsonb;evidence jsonb;
BEGIN
  claims:=capability_internal.activate_deletion_capability('deletion_purge');
  evidence:=claims->'evidence';
  IF claims->>'tenant_id' IS DISTINCT FROM p_tenant_id
     OR evidence->>'request_scope' IS DISTINCT FROM 'connection'
     OR evidence->>'connection_id' IS DISTINCT FROM p_connection_id THEN
    RAISE EXCEPTION 'deletion capability target is invalid' USING ERRCODE='42501';
  END IF;
  PERFORM capability_internal.record_tenant_revocation(p_tenant_id);
  RETURN deletion_internal.purge_connection_pre_capability(
    p_tenant_id,p_connection_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION deletion_internal.purge_tenant(
  p_tenant_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE claims jsonb;evidence jsonb;
BEGIN
  claims:=capability_internal.activate_deletion_capability('deletion_purge');
  evidence:=claims->'evidence';
  IF claims->>'tenant_id' IS DISTINCT FROM p_tenant_id
     OR evidence->>'request_scope' IS DISTINCT FROM 'tenant'
     OR evidence->'connection_id' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'deletion capability target is invalid' USING ERRCODE='42501';
  END IF;
  PERFORM capability_internal.record_tenant_revocation(p_tenant_id);
  RETURN deletion_internal.purge_tenant_pre_capability(p_tenant_id);
END;
$$;

CREATE OR REPLACE FUNCTION deletion_internal.verify_connection(
  p_tenant_id text,p_connection_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE claims jsonb;evidence jsonb;
BEGIN
  claims:=capability_internal.activate_deletion_capability('deletion_verify');
  evidence:=claims->'evidence';
  IF claims->>'tenant_id' IS DISTINCT FROM p_tenant_id
     OR evidence->>'request_scope' IS DISTINCT FROM 'connection'
     OR evidence->>'connection_id' IS DISTINCT FROM p_connection_id THEN
    RAISE EXCEPTION 'deletion capability target is invalid' USING ERRCODE='42501';
  END IF;
  RETURN deletion_internal.verify_connection_pre_capability(
    p_tenant_id,p_connection_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION deletion_internal.verify_tenant(
  p_tenant_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE claims jsonb;evidence jsonb;
BEGIN
  claims:=capability_internal.activate_deletion_capability('deletion_verify');
  evidence:=claims->'evidence';
  IF claims->>'tenant_id' IS DISTINCT FROM p_tenant_id
     OR evidence->>'request_scope' IS DISTINCT FROM 'tenant'
     OR evidence->'connection_id' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'deletion capability target is invalid' USING ERRCODE='42501';
  END IF;
  RETURN deletion_internal.verify_tenant_pre_capability(p_tenant_id);
END;
$$;

-- Predecessors and private delegates are migration-owner-only. The signed
-- capability wrappers remain the only deletion_rw entry points.
REVOKE ALL ON FUNCTION
  deletion_internal.purge_connection_before_shopify_staging(text,text),
  deletion_internal.purge_tenant_before_shopify_staging(text),
  deletion_internal.verify_connection_before_shopify_staging(text,text),
  deletion_internal.verify_tenant_before_shopify_staging(text),
  deletion_internal.purge_connection_pre_capability(text,text),
  deletion_internal.purge_tenant_pre_capability(text),
  deletion_internal.verify_connection_pre_capability(text,text),
  deletion_internal.verify_tenant_pre_capability(text)
FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;

GRANT EXECUTE ON FUNCTION
  deletion_internal.purge_connection_pre_capability(text,text),
  deletion_internal.purge_tenant_pre_capability(text),
  deletion_internal.verify_connection_pre_capability(text,text),
  deletion_internal.verify_tenant_pre_capability(text)
TO albert_migration_owner;

REVOKE ALL ON FUNCTION
  deletion_internal.purge_connection(text,text),
  deletion_internal.purge_tenant(text),
  deletion_internal.verify_connection(text,text),
  deletion_internal.verify_tenant(text)
FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT USAGE ON SCHEMA deletion_internal TO deletion_rw;
GRANT EXECUTE ON FUNCTION
  deletion_internal.purge_connection(text,text),
  deletion_internal.purge_tenant(text),
  deletion_internal.verify_connection(text,text),
  deletion_internal.verify_tenant(text)
TO deletion_rw;

COMMIT;
