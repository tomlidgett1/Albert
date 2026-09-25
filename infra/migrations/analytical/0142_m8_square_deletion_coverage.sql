BEGIN;

-- Keep the signed, one-use deletion capability wrappers installed by 0083 as
-- the only deletion_rw entry points. Extend only their migration-owner-owned
-- implementations so a capability is still consumed exactly once.
ALTER FUNCTION deletion_internal.purge_connection_pre_capability(text,text)
  RENAME TO purge_connection_before_square_source;
ALTER FUNCTION deletion_internal.purge_tenant_pre_capability(text)
  RENAME TO purge_tenant_before_square_source;
ALTER FUNCTION deletion_internal.verify_connection_pre_capability(text,text)
  RENAME TO verify_connection_before_square_source;
ALTER FUNCTION deletion_internal.verify_tenant_pre_capability(text)
  RENAME TO verify_tenant_before_square_source;

CREATE OR REPLACE FUNCTION deletion_internal.purge_connection_pre_capability(
  p_tenant_id text,p_connection_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE table_row record;affected bigint;square_removed bigint:=0;result jsonb;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) OR NOT core.is_ulid(p_connection_id) THEN
    RAISE EXCEPTION 'deletion scope identifiers must be ULIDs'
      USING ERRCODE='22023';
  END IF;
  PERFORM set_config('albert.tenant_id',p_tenant_id,true);
  PERFORM set_config('albert.deletion_authorized','on',true);

  FOR table_row IN
    SELECT column_value.table_schema,column_value.table_name
      FROM information_schema.columns column_value
      JOIN information_schema.tables table_value
        ON table_value.table_schema=column_value.table_schema
       AND table_value.table_name=column_value.table_name
     WHERE column_value.table_schema='source_square'
       AND column_value.column_name='connection_id'
       AND table_value.table_type='BASE TABLE'
     ORDER BY column_value.table_name
  LOOP
    EXECUTE format(
      'DELETE FROM %I.%I WHERE tenant_id=$1 AND connection_id=$2',
      table_row.table_schema,table_row.table_name
    ) USING p_tenant_id,p_connection_id;
    GET DIAGNOSTICS affected=ROW_COUNT;
    square_removed:=square_removed+affected;
  END LOOP;

  result:=deletion_internal.purge_connection_before_square_source(
    p_tenant_id,p_connection_id
  );
  RETURN result||jsonb_build_object(
    'rowsRemoved',coalesce((result->>'rowsRemoved')::bigint,0)+square_removed
  );
END;
$$;

CREATE OR REPLACE FUNCTION deletion_internal.purge_tenant_pre_capability(
  p_tenant_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE table_row record;affected bigint;square_removed bigint:=0;result jsonb;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) THEN
    RAISE EXCEPTION 'tenant id must be a ULID' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('albert.tenant_id',p_tenant_id,true);
  PERFORM set_config('albert.deletion_authorized','on',true);

  FOR table_row IN
    SELECT DISTINCT column_value.table_schema,column_value.table_name
      FROM information_schema.columns column_value
      JOIN information_schema.tables table_value
        ON table_value.table_schema=column_value.table_schema
       AND table_value.table_name=column_value.table_name
     WHERE column_value.table_schema='source_square'
       AND column_value.column_name='tenant_id'
       AND table_value.table_type='BASE TABLE'
     ORDER BY column_value.table_name
  LOOP
    EXECUTE format(
      'DELETE FROM %I.%I WHERE tenant_id=$1',
      table_row.table_schema,table_row.table_name
    ) USING p_tenant_id;
    GET DIAGNOSTICS affected=ROW_COUNT;
    square_removed:=square_removed+affected;
  END LOOP;

  result:=deletion_internal.purge_tenant_before_square_source(p_tenant_id);
  RETURN result||jsonb_build_object(
    'rowsRemoved',coalesce((result->>'rowsRemoved')::bigint,0)+square_removed
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
DECLARE table_row record;affected bigint;square_remaining bigint:=0;
DECLARE result jsonb;residuals jsonb;remaining bigint;staging bigint;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) OR NOT core.is_ulid(p_connection_id) THEN
    RAISE EXCEPTION 'deletion scope identifiers must be ULIDs'
      USING ERRCODE='22023';
  END IF;
  PERFORM set_config('albert.tenant_id',p_tenant_id,true);
  result:=deletion_internal.verify_connection_before_square_source(
    p_tenant_id,p_connection_id
  );

  FOR table_row IN
    SELECT column_value.table_schema,column_value.table_name
      FROM information_schema.columns column_value
      JOIN information_schema.tables table_value
        ON table_value.table_schema=column_value.table_schema
       AND table_value.table_name=column_value.table_name
     WHERE column_value.table_schema='source_square'
       AND column_value.column_name='connection_id'
       AND table_value.table_type='BASE TABLE'
     ORDER BY column_value.table_name
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I.%I WHERE tenant_id=$1 AND connection_id=$2',
      table_row.table_schema,table_row.table_name
    ) INTO affected USING p_tenant_id,p_connection_id;
    square_remaining:=square_remaining+affected;
  END LOOP;

  residuals:=result->'residuals';
  remaining:=coalesce((result->>'remainingRows')::bigint,0)+square_remaining;
  staging:=coalesce((residuals->>'stagingRows')::bigint,0)+square_remaining;
  RETURN result||jsonb_build_object(
    'verified',coalesce((result->>'verified')::boolean,false) AND square_remaining=0,
    'remainingRows',remaining,
    'residuals',residuals||jsonb_build_object('stagingRows',staging)
  );
END;
$$;

CREATE OR REPLACE FUNCTION deletion_internal.verify_tenant_pre_capability(
  p_tenant_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE table_row record;affected bigint;square_remaining bigint:=0;
DECLARE result jsonb;residuals jsonb;remaining bigint;staging bigint;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) THEN
    RAISE EXCEPTION 'tenant id must be a ULID' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('albert.tenant_id',p_tenant_id,true);
  result:=deletion_internal.verify_tenant_before_square_source(p_tenant_id);

  FOR table_row IN
    SELECT DISTINCT column_value.table_schema,column_value.table_name
      FROM information_schema.columns column_value
      JOIN information_schema.tables table_value
        ON table_value.table_schema=column_value.table_schema
       AND table_value.table_name=column_value.table_name
     WHERE column_value.table_schema='source_square'
       AND column_value.column_name='tenant_id'
       AND table_value.table_type='BASE TABLE'
     ORDER BY column_value.table_name
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I.%I WHERE tenant_id=$1',
      table_row.table_schema,table_row.table_name
    ) INTO affected USING p_tenant_id;
    square_remaining:=square_remaining+affected;
  END LOOP;

  residuals:=result->'residuals';
  remaining:=coalesce((result->>'remainingRows')::bigint,0)+square_remaining;
  staging:=coalesce((residuals->>'stagingRows')::bigint,0)+square_remaining;
  RETURN result||jsonb_build_object(
    'verified',coalesce((result->>'verified')::boolean,false) AND square_remaining=0,
    'remainingRows',remaining,
    'residuals',residuals||jsonb_build_object('stagingRows',staging)
  );
END;
$$;

-- Recreate the public deletion entry points on their existing OIDs. This
-- invalidates any cached plan that resolved the predecessor implementation
-- before this migration, while preserving the exact one-use token boundary.
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
     OR evidence->>'request_scope'<>'connection'
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
     OR evidence->>'request_scope'<>'tenant'
     OR evidence->'connection_id'<>'null'::jsonb THEN
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
     OR evidence->>'request_scope'<>'connection'
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
     OR evidence->>'request_scope'<>'tenant'
     OR evidence->'connection_id'<>'null'::jsonb THEN
    RAISE EXCEPTION 'deletion capability target is invalid' USING ERRCODE='42501';
  END IF;
  RETURN deletion_internal.verify_tenant_pre_capability(p_tenant_id);
END;
$$;

REVOKE ALL ON FUNCTION
  deletion_internal.purge_connection_before_square_source(text,text),
  deletion_internal.purge_tenant_before_square_source(text),
  deletion_internal.verify_connection_before_square_source(text,text),
  deletion_internal.verify_tenant_before_square_source(text),
  deletion_internal.purge_connection_pre_capability(text,text),
  deletion_internal.purge_tenant_pre_capability(text),
  deletion_internal.verify_connection_pre_capability(text,text),
  deletion_internal.verify_tenant_pre_capability(text)
FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,
     deletion_rw;

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
FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,
     deletion_rw;

GRANT EXECUTE ON FUNCTION
  deletion_internal.purge_connection(text,text),
  deletion_internal.purge_tenant(text),
  deletion_internal.verify_connection(text,text),
  deletion_internal.verify_tenant(text)
TO deletion_rw;

COMMIT;
