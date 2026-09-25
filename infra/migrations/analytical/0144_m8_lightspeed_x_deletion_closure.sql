BEGIN;

-- Lightspeed Retail X-Series is isolated from the existing R-Series staging
-- schema. Extend deletion beneath the signed, one-use wrappers installed by
-- 0083: the public function names, capability activation, target binding and
-- deletion_rw authority remain unchanged.
ALTER FUNCTION deletion_internal.purge_connection_pre_capability(text,text)
  RENAME TO purge_connection_before_lightspeed_x_staging;
ALTER FUNCTION deletion_internal.purge_tenant_pre_capability(text)
  RENAME TO purge_tenant_before_lightspeed_x_staging;
ALTER FUNCTION deletion_internal.verify_connection_pre_capability(text,text)
  RENAME TO verify_connection_before_lightspeed_x_staging;
ALTER FUNCTION deletion_internal.verify_tenant_pre_capability(text)
  RENAME TO verify_tenant_before_lightspeed_x_staging;

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

  -- Discover every current and future X-Series staging base table. A table in
  -- this tenant-owned source schema that cannot be connection-scoped is a hard
  -- contract failure, never a silently retained row class.
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
      WHERE table_value.table_schema='source_lightspeed_x'
        AND table_value.table_type='BASE TABLE'
      GROUP BY table_value.table_name
      ORDER BY table_value.table_name
    LOOP
      IF NOT table_row.has_tenant_id OR NOT table_row.has_connection_id THEN
        RAISE EXCEPTION
          'source_lightspeed_x table % lacks tenant_id or connection_id',
          table_row.table_name
          USING ERRCODE='55000';
      END IF;
      BEGIN
        EXECUTE format(
          'DELETE FROM source_lightspeed_x.%I
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
    WHERE table_value.table_schema='source_lightspeed_x'
      AND table_value.table_type='BASE TABLE'
    GROUP BY table_value.table_name
    ORDER BY table_value.table_name
  LOOP
    IF NOT table_row.has_tenant_id OR NOT table_row.has_connection_id THEN
      RAISE EXCEPTION
        'source_lightspeed_x table % lacks tenant_id or connection_id',
        table_row.table_name
        USING ERRCODE='55000';
    END IF;
    EXECUTE format(
      'SELECT count(*) FROM source_lightspeed_x.%I AS residual
        WHERE residual.tenant_id=$1 AND residual.connection_id=$2',
      table_row.table_name
    ) INTO affected USING p_tenant_id,p_connection_id;
    remaining:=remaining+affected;
  END LOOP;
  IF remaining>0 THEN
    RAISE EXCEPTION
      'Lightspeed X-Series connection purge left % staging rows',remaining
      USING ERRCODE='55000';
  END IF;

  -- X-Series rows must be gone before the established implementation removes
  -- their immutable ingestion.batch_manifests parents.
  result:=deletion_internal.purge_connection_before_lightspeed_x_staging(
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

  -- Retry in dependency-safe passes, matching the established tenant purge.
  -- Generated staging currently has no cross-table FKs, but this remains safe
  -- if the source pack later adds a tenant-scoped relational dependency.
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
      WHERE table_value.table_schema='source_lightspeed_x'
        AND table_value.table_type='BASE TABLE'
      GROUP BY table_value.table_name
      ORDER BY table_value.table_name
    LOOP
      IF NOT table_row.has_tenant_id THEN
        RAISE EXCEPTION 'source_lightspeed_x table % lacks tenant_id',
          table_row.table_name
          USING ERRCODE='55000';
      END IF;
      BEGIN
        EXECUTE format(
          'DELETE FROM source_lightspeed_x.%I WHERE tenant_id=$1',
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
    WHERE table_value.table_schema='source_lightspeed_x'
      AND table_value.table_type='BASE TABLE'
    GROUP BY table_value.table_name
    ORDER BY table_value.table_name
  LOOP
    IF NOT table_row.has_tenant_id THEN
      RAISE EXCEPTION 'source_lightspeed_x table % lacks tenant_id',
        table_row.table_name
        USING ERRCODE='55000';
    END IF;
    EXECUTE format(
      'SELECT count(*) FROM source_lightspeed_x.%I WHERE tenant_id=$1',
      table_row.table_name
    ) INTO affected USING p_tenant_id;
    remaining:=remaining+affected;
  END LOOP;
  IF remaining>0 THEN
    RAISE EXCEPTION 'Lightspeed X-Series tenant purge left % staging rows',
      remaining
      USING ERRCODE='55000';
  END IF;

  result:=deletion_internal.purge_tenant_before_lightspeed_x_staging(
    p_tenant_id
  );
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
DECLARE table_row record;row_count bigint;x_remaining bigint:=0;base jsonb;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) OR NOT core.is_ulid(p_connection_id) THEN
    RAISE EXCEPTION 'deletion scope identifiers must be ULIDs'
      USING ERRCODE='22023';
  END IF;
  PERFORM set_config('albert.tenant_id',p_tenant_id,true);
  base:=deletion_internal.verify_connection_before_lightspeed_x_staging(
    p_tenant_id,p_connection_id
  );

  -- The immutable proof contract has exactly five top-level properties and
  -- exactly these seven measured residual counters. Assert that predecessor
  -- shape before changing only stagingRows, remainingRows and verified.
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
    WHERE table_value.table_schema='source_lightspeed_x'
      AND table_value.table_type='BASE TABLE'
    GROUP BY table_value.table_name
    ORDER BY table_value.table_name
  LOOP
    IF NOT table_row.has_tenant_id OR NOT table_row.has_connection_id THEN
      RAISE EXCEPTION
        'source_lightspeed_x table % lacks tenant_id or connection_id',
        table_row.table_name
        USING ERRCODE='55000';
    END IF;
    EXECUTE format(
      'SELECT count(*) FROM source_lightspeed_x.%I AS residual
        WHERE residual.tenant_id=$1 AND residual.connection_id=$2',
      table_row.table_name
    ) INTO row_count USING p_tenant_id,p_connection_id;
    x_remaining:=x_remaining+row_count;
  END LOOP;

  base:=jsonb_set(
    base,
    '{residuals,stagingRows}',
    to_jsonb(coalesce((base#>>'{residuals,stagingRows}')::bigint,0)+x_remaining),
    false
  );
  base:=jsonb_set(
    base,
    '{remainingRows}',
    to_jsonb(coalesce((base->>'remainingRows')::bigint,0)+x_remaining),
    false
  );
  RETURN jsonb_set(
    base,
    '{verified}',
    to_jsonb(coalesce((base->>'verified')::boolean,false) AND x_remaining=0),
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
DECLARE table_row record;row_count bigint;x_remaining bigint:=0;base jsonb;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) THEN
    RAISE EXCEPTION 'tenant id must be a ULID' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('albert.tenant_id',p_tenant_id,true);
  base:=deletion_internal.verify_tenant_before_lightspeed_x_staging(
    p_tenant_id
  );

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
    WHERE table_value.table_schema='source_lightspeed_x'
      AND table_value.table_type='BASE TABLE'
    GROUP BY table_value.table_name
    ORDER BY table_value.table_name
  LOOP
    IF NOT table_row.has_tenant_id THEN
      RAISE EXCEPTION 'source_lightspeed_x table % lacks tenant_id',
        table_row.table_name
        USING ERRCODE='55000';
    END IF;
    EXECUTE format(
      'SELECT count(*) FROM source_lightspeed_x.%I AS residual
        WHERE residual.tenant_id=$1',
      table_row.table_name
    ) INTO row_count USING p_tenant_id;
    x_remaining:=x_remaining+row_count;
  END LOOP;

  base:=jsonb_set(
    base,
    '{residuals,stagingRows}',
    to_jsonb(coalesce((base#>>'{residuals,stagingRows}')::bigint,0)+x_remaining),
    false
  );
  base:=jsonb_set(
    base,
    '{remainingRows}',
    to_jsonb(coalesce((base->>'remainingRows')::bigint,0)+x_remaining),
    false
  );
  RETURN jsonb_set(
    base,
    '{verified}',
    to_jsonb(coalesce((base->>'verified')::boolean,false) AND x_remaining=0),
    false
  );
END;
$$;

-- Predecessors and private delegates are migration-owner-only. Reassert the
-- unchanged signed wrapper boundary explicitly so future ACL drift is visible.
REVOKE ALL ON FUNCTION
  deletion_internal.purge_connection_before_lightspeed_x_staging(text,text),
  deletion_internal.purge_tenant_before_lightspeed_x_staging(text),
  deletion_internal.verify_connection_before_lightspeed_x_staging(text,text),
  deletion_internal.verify_tenant_before_lightspeed_x_staging(text),
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
