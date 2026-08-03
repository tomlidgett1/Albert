BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='deletion_rw') THEN
    RAISE EXCEPTION 'deletion_rw is missing; run the analytical role bootstrap first'
      USING ERRCODE='0A000';
  END IF;
END;
$$;

CREATE SCHEMA IF NOT EXISTS deletion_internal;
REVOKE ALL ON SCHEMA deletion_internal FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro;
GRANT USAGE ON SCHEMA deletion_internal TO deletion_rw;

CREATE OR REPLACE FUNCTION deletion_internal.mutation_authorized()
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT current_user='albert_migration_owner'
     AND current_setting('albert.deletion_authorized',true)='on';
$$;

-- Ingestion manifests and query audits are append-only during normal service
-- operation. A fixed deletion procedure owned by the migration role is the
-- only exception; callers cannot set current_user to the migration owner.
CREATE OR REPLACE FUNCTION ingestion.reject_immutable_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF deletion_internal.mutation_authorized() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'ingestion evidence is append-only' USING ERRCODE='55000';
END;
$$;

CREATE OR REPLACE FUNCTION semantic_internal.reject_audit_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF deletion_internal.mutation_authorized() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'semantic audit evidence is append-only' USING ERRCODE='42501';
END;
$$;

CREATE OR REPLACE FUNCTION deletion_internal.refresh_remaining_marts(p_tenant_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,core,mart AS $$
DECLARE first_day date; last_day date; chunk_start date; chunk_end date; chunks integer:=0;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501';
  END IF;
  SELECT min(business_date),max(business_date) INTO first_day,last_day FROM (
    SELECT business_date FROM core.commerce_order_line WHERE tenant_id=p_tenant_id
    UNION ALL SELECT business_date FROM core.commerce_refund_line WHERE tenant_id=p_tenant_id
    UNION ALL SELECT business_date FROM core.workforce_shift WHERE tenant_id=p_tenant_id
    UNION ALL SELECT business_date FROM core.workforce_time_entry WHERE tenant_id=p_tenant_id
  ) dates;
  DELETE FROM mart.sales_day_location WHERE tenant_id=p_tenant_id;
  DELETE FROM mart.labour_day_location WHERE tenant_id=p_tenant_id;
  IF first_day IS NULL THEN
    RETURN jsonb_build_object('refreshed',true,'chunks',0,'from',NULL,'to',NULL);
  END IF;
  chunk_start:=first_day;
  WHILE chunk_start<=last_day LOOP
    chunk_end:=least(chunk_start+399,last_day);
    PERFORM mart.refresh_tenant_day_marts(p_tenant_id,chunk_start,chunk_end);
    chunks:=chunks+1;chunk_start:=chunk_end+1;
  END LOOP;
  RETURN jsonb_build_object('refreshed',true,'chunks',chunks,'from',first_day,'to',last_day);
END;
$$;

CREATE OR REPLACE FUNCTION deletion_internal.purge_connection(
  p_tenant_id text,p_connection_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,core,ingestion,semantic_internal,quality,mart AS $$
DECLARE table_row record; fk_row record; affected bigint; removed bigint:=0; added bigint; closure_added bigint:=0; pass integer; changed boolean; residual bigint:=0; mart_result jsonb;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) OR NOT core.is_ulid(p_connection_id) THEN
    RAISE EXCEPTION 'deletion scope identifiers must be ULIDs' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('albert.tenant_id',p_tenant_id,true);
  PERFORM set_config('albert.deletion_authorized','on',true);
  PERFORM pg_advisory_xact_lock(hashtextextended('deletion:'||p_tenant_id,0));

  CREATE TEMP TABLE deletion_batches(batch_id text PRIMARY KEY) ON COMMIT DROP;
  INSERT INTO deletion_batches(batch_id)
  SELECT batch_id FROM ingestion.batch_manifests
  WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;

  -- canonical_record_state links every dimension/fact to the immutable source
  -- batch that last won version arbitration. It gives deletion a complete,
  -- source-neutral way to locate rows even when the row itself has no
  -- connection_id column.
  CREATE TEMP TABLE deletion_canonical_targets(
    table_schema text NOT NULL DEFAULT 'core',table_name text NOT NULL,id text NOT NULL,
    PRIMARY KEY(table_schema,table_name,id)
  ) ON COMMIT DROP;
  INSERT INTO deletion_canonical_targets(table_name,id)
  SELECT state.canonical_table,state.canonical_id
  FROM semantic_internal.canonical_record_state state
  JOIN deletion_batches batch ON batch.batch_id=state.batch_id
  WHERE state.tenant_id=p_tenant_id
    AND EXISTS (
      SELECT 1 FROM information_schema.tables t
      WHERE t.table_schema='core' AND t.table_name=state.canonical_table AND t.table_type='BASE TABLE'
    )
  ON CONFLICT DO NOTHING;

  -- Expand the target set through every tenant/id composite FK in core. This
  -- removes a retained-source derived row if it depends on a value whose only
  -- lawful origin is the disconnected source.
  FOR pass IN 1..40 LOOP
    added:=0;
    FOR fk_row IN
      SELECT child_ns.nspname child_schema,child.relname child_table,
             parent_ns.nspname parent_schema,parent.relname parent_table,
             child_col.attname child_reference_column
      FROM pg_constraint fk
      JOIN pg_class child ON child.oid=fk.conrelid
      JOIN pg_namespace child_ns ON child_ns.oid=child.relnamespace
      JOIN pg_class parent ON parent.oid=fk.confrelid
      JOIN pg_namespace parent_ns ON parent_ns.oid=parent.relnamespace
      JOIN LATERAL generate_subscripts(fk.conkey,1) position(n) ON true
      JOIN pg_attribute child_col ON child_col.attrelid=child.oid AND child_col.attnum=fk.conkey[position.n]
      JOIN pg_attribute parent_col ON parent_col.attrelid=parent.oid AND parent_col.attnum=fk.confkey[position.n]
      WHERE fk.contype='f' AND child_ns.nspname='core' AND parent_ns.nspname='core'
        AND parent_col.attname='id'
        AND EXISTS (SELECT 1 FROM pg_attribute id_col WHERE id_col.attrelid=child.oid AND id_col.attname='id' AND NOT id_col.attisdropped)
        AND EXISTS (
          SELECT 1 FROM generate_subscripts(fk.conkey,1) tenant_position(n)
          JOIN pg_attribute child_tenant ON child_tenant.attrelid=child.oid AND child_tenant.attnum=fk.conkey[tenant_position.n]
          JOIN pg_attribute parent_tenant ON parent_tenant.attrelid=parent.oid AND parent_tenant.attnum=fk.confkey[tenant_position.n]
          WHERE child_tenant.attname='tenant_id' AND parent_tenant.attname='tenant_id'
        )
    LOOP
      EXECUTE format(
        'INSERT INTO deletion_canonical_targets(table_schema,table_name,id)
         SELECT %L,%L,child.id FROM %I.%I child
         JOIN deletion_canonical_targets parent_target
           ON parent_target.table_schema=%L AND parent_target.table_name=%L
          AND parent_target.id=child.%I
         WHERE child.tenant_id=$1 ON CONFLICT DO NOTHING',
        fk_row.child_schema,fk_row.child_table,fk_row.child_schema,fk_row.child_table,
        fk_row.parent_schema,fk_row.parent_table,fk_row.child_reference_column
      ) USING p_tenant_id;
      GET DIAGNOSTICS affected=ROW_COUNT;added:=added+affected;
    END LOOP;
    closure_added:=closure_added+added;EXIT WHEN added=0;
  END LOOP;

  -- Cross-source bridges and every query-derived cache can contain the deleted
  -- source even when the bridge/cache has no direct connection column.
  DELETE FROM core.order_line_source_observation observation
  USING deletion_canonical_targets target
  WHERE observation.tenant_id=p_tenant_id AND target.table_name='commerce_order_line' AND observation.order_line_id=target.id;
  DELETE FROM core.order_source_observation observation
  USING deletion_canonical_targets target
  WHERE observation.tenant_id=p_tenant_id AND target.table_name='commerce_order' AND observation.order_id=target.id;
  DELETE FROM core.event_link WHERE tenant_id=p_tenant_id
    AND (from_connection_id=p_connection_id OR to_connection_id=p_connection_id);
  DELETE FROM core.entity_source_link link WHERE link.tenant_id=p_tenant_id
    AND (link.connection_id=p_connection_id OR EXISTS (
      SELECT 1 FROM deletion_canonical_targets target WHERE target.id=link.canonical_entity_id
    ));
  DELETE FROM core.source_authority WHERE tenant_id=p_tenant_id AND authoritative_connection_id=p_connection_id;
  -- Identity components can transitively contain the disconnected source even
  -- when an edge itself has no connection_id. Rebuild from future review
  -- evidence instead of retaining derived cross-source state.
  DELETE FROM core.entity_resolution WHERE tenant_id=p_tenant_id;
  DELETE FROM core.entity_identity_edge WHERE tenant_id=p_tenant_id;

  DELETE FROM semantic_internal.query_audit WHERE tenant_id=p_tenant_id;
  DELETE FROM semantic_internal.result_cache WHERE tenant_id=p_tenant_id;
  DELETE FROM semantic_internal.identity_decision_history WHERE tenant_id=p_tenant_id;
  DELETE FROM semantic_internal.identity_link_baseline WHERE tenant_id=p_tenant_id;
  DELETE FROM semantic_internal.identity_graph_state WHERE tenant_id=p_tenant_id;
  DELETE FROM semantic_internal.identity_review_projection_outbox WHERE tenant_id=p_tenant_id;
  DELETE FROM semantic_internal.readiness_projection_outbox WHERE tenant_id=p_tenant_id;
  DELETE FROM semantic_internal.pipeline_stats_projection_outbox WHERE tenant_id=p_tenant_id;
  DELETE FROM semantic_internal.pipeline_table_stats_projection_outbox WHERE tenant_id=p_tenant_id;
  DELETE FROM semantic_internal.promotion_candidate_outbox WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  DELETE FROM semantic_internal.source_field_allowlist WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  DELETE FROM semantic_internal.tenant_capability WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  DELETE FROM semantic_internal.identity_observation WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  DELETE FROM semantic_internal.canonical_transform_commits WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  DELETE FROM semantic_internal.canonical_record_state state
  USING deletion_canonical_targets target
  WHERE state.tenant_id=p_tenant_id AND state.canonical_table=target.table_name AND state.canonical_id=target.id;
  DELETE FROM quality.finding WHERE tenant_id=p_tenant_id;
  DELETE FROM quality.check_result WHERE tenant_id=p_tenant_id;
  DELETE FROM quality.pipeline_stats WHERE tenant_id=p_tenant_id;
  DELETE FROM semantic_internal.pipeline_stats_projection_outbox WHERE tenant_id=p_tenant_id;
  DELETE FROM mart.sales_day_location WHERE tenant_id=p_tenant_id;
  DELETE FROM mart.labour_day_location WHERE tenant_id=p_tenant_id;

  -- Delete child targets before parents. FK conflicts cause a later pass; an
  -- unresolved target is a hard error, never a silently retained record.
  FOR pass IN 1..60 LOOP
    changed:=false;
    FOR table_row IN SELECT DISTINCT table_schema,table_name FROM deletion_canonical_targets ORDER BY table_name LOOP
      BEGIN
        EXECUTE format(
          'DELETE FROM %I.%I row USING deletion_canonical_targets target
           WHERE target.table_schema=%L AND target.table_name=%L
             AND row.tenant_id=$1 AND row.id=target.id',
          table_row.table_schema,table_row.table_name,table_row.table_schema,table_row.table_name
        ) USING p_tenant_id;
        GET DIAGNOSTICS affected=ROW_COUNT;
        IF affected>0 THEN removed:=removed+affected;changed:=true;END IF;
      EXCEPTION WHEN foreign_key_violation THEN NULL;
      END;
    END LOOP;
    EXIT WHEN NOT changed;
  END LOOP;
  FOR table_row IN SELECT DISTINCT table_schema,table_name FROM deletion_canonical_targets LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I.%I row JOIN deletion_canonical_targets target
       ON target.table_schema=%L AND target.table_name=%L AND target.id=row.id
       WHERE row.tenant_id=$1',
      table_row.table_schema,table_row.table_name,table_row.table_schema,table_row.table_name
    ) INTO affected USING p_tenant_id;
    residual:=residual+affected;
  END LOOP;
  IF residual>0 THEN RAISE EXCEPTION 'canonical deletion closure left % rows',residual USING ERRCODE='55000';END IF;

  FOR table_row IN
    SELECT table_schema,table_name FROM information_schema.columns
    WHERE table_schema IN ('source_lightspeed','source_xero','source_deputy') AND column_name='connection_id'
    ORDER BY table_schema,table_name
  LOOP
    EXECUTE format('DELETE FROM %I.%I WHERE tenant_id=$1 AND connection_id=$2',table_row.table_schema,table_row.table_name)
      USING p_tenant_id,p_connection_id;
    GET DIAGNOSTICS affected=ROW_COUNT;removed:=removed+affected;
  END LOOP;
  DELETE FROM ingestion.source_records WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  GET DIAGNOSTICS affected=ROW_COUNT;removed:=removed+affected;
  DELETE FROM ingestion.quarantine_records WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  GET DIAGNOSTICS affected=ROW_COUNT;removed:=removed+affected;
  DELETE FROM ingestion.landing_commits commit_row USING deletion_batches batch
  WHERE commit_row.tenant_id=p_tenant_id AND commit_row.batch_id=batch.batch_id;
  GET DIAGNOSTICS affected=ROW_COUNT;removed:=removed+affected;
  DELETE FROM ingestion.batch_manifests manifest USING deletion_batches batch
  WHERE manifest.tenant_id=p_tenant_id AND manifest.batch_id=batch.batch_id;
  GET DIAGNOSTICS affected=ROW_COUNT;removed:=removed+affected;

  mart_result:=deletion_internal.refresh_remaining_marts(p_tenant_id);
  RETURN jsonb_build_object(
    'verified',true,'scope','connection','rowsRemoved',removed,
    'canonicalDependencyRowsAdded',closure_added,'canonicalResidual',residual,
    'marts',mart_result
  );
END;
$$;

CREATE OR REPLACE FUNCTION deletion_internal.purge_tenant(p_tenant_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,core,ingestion,semantic_internal,quality,mart AS $$
DECLARE table_row record;affected bigint;removed bigint:=0;remaining bigint:=0;pass integer;changed boolean;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) THEN RAISE EXCEPTION 'tenant id must be a ULID' USING ERRCODE='22023';END IF;
  PERFORM set_config('albert.tenant_id',p_tenant_id,true);
  PERFORM set_config('albert.deletion_authorized','on',true);
  PERFORM pg_advisory_xact_lock(hashtextextended('deletion:'||p_tenant_id,0));
  FOR pass IN 1..80 LOOP
    changed:=false;
    FOR table_row IN
      SELECT DISTINCT c.table_schema,c.table_name
      FROM information_schema.columns c JOIN information_schema.tables t
        ON t.table_schema=c.table_schema AND t.table_name=c.table_name
      WHERE c.column_name='tenant_id' AND t.table_type='BASE TABLE'
        AND c.table_schema IN ('ingestion','source_lightspeed','source_xero','source_deputy','core','quality','mart','semantic_internal')
      ORDER BY c.table_schema,c.table_name
    LOOP
      BEGIN
        EXECUTE format('DELETE FROM %I.%I WHERE tenant_id=$1',table_row.table_schema,table_row.table_name) USING p_tenant_id;
        GET DIAGNOSTICS affected=ROW_COUNT;
        IF affected>0 THEN removed:=removed+affected;changed:=true;END IF;
      EXCEPTION WHEN foreign_key_violation THEN NULL;
      END;
    END LOOP;
    EXIT WHEN NOT changed;
  END LOOP;
  FOR table_row IN
    SELECT DISTINCT c.table_schema,c.table_name
    FROM information_schema.columns c JOIN information_schema.tables t
      ON t.table_schema=c.table_schema AND t.table_name=c.table_name
    WHERE c.column_name='tenant_id' AND t.table_type='BASE TABLE'
      AND c.table_schema IN ('ingestion','source_lightspeed','source_xero','source_deputy','core','quality','mart','semantic_internal')
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I WHERE tenant_id=$1',table_row.table_schema,table_row.table_name)
      INTO affected USING p_tenant_id;
    remaining:=remaining+affected;
  END LOOP;
  IF remaining>0 THEN RAISE EXCEPTION 'analytical tenant purge left % rows',remaining USING ERRCODE='55000';END IF;
  RETURN jsonb_build_object('verified',true,'scope','tenant','rowsRemoved',removed,'remainingRows',remaining);
END;
$$;

CREATE OR REPLACE FUNCTION deletion_internal.verify_connection(p_tenant_id text,p_connection_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,core,ingestion,semantic_internal AS $$
DECLARE table_row record;affected bigint;remaining bigint:=0;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) OR NOT core.is_ulid(p_connection_id) THEN RAISE EXCEPTION 'deletion scope identifiers must be ULIDs' USING ERRCODE='22023';END IF;
  PERFORM set_config('albert.tenant_id',p_tenant_id,true);
  FOR table_row IN
    SELECT table_schema,table_name FROM information_schema.columns
    WHERE table_schema IN ('source_lightspeed','source_xero','source_deputy') AND column_name='connection_id'
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I WHERE tenant_id=$1 AND connection_id=$2',table_row.table_schema,table_row.table_name)
      INTO affected USING p_tenant_id,p_connection_id;remaining:=remaining+affected;
  END LOOP;
  SELECT remaining
    +(SELECT count(*) FROM ingestion.batch_manifests WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id)
    +(SELECT count(*) FROM ingestion.source_records WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id)
    +(SELECT count(*) FROM ingestion.quarantine_records WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id)
    +(SELECT count(*) FROM core.entity_source_link WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id)
    +(SELECT count(*) FROM core.event_link WHERE tenant_id=p_tenant_id AND (from_connection_id=p_connection_id OR to_connection_id=p_connection_id))
    +(SELECT count(*) FROM core.source_authority WHERE tenant_id=p_tenant_id AND authoritative_connection_id=p_connection_id)
    +(SELECT count(*) FROM semantic_internal.identity_observation WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id)
    +(SELECT count(*) FROM semantic_internal.canonical_transform_commits WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id)
    +(SELECT count(*) FROM core.entity_resolution WHERE tenant_id=p_tenant_id)
    +(SELECT count(*) FROM core.entity_identity_edge WHERE tenant_id=p_tenant_id)
    +(SELECT count(*) FROM semantic_internal.identity_decision_history WHERE tenant_id=p_tenant_id)
    +(SELECT count(*) FROM semantic_internal.identity_link_baseline WHERE tenant_id=p_tenant_id)
    +(SELECT count(*) FROM semantic_internal.identity_graph_state WHERE tenant_id=p_tenant_id)
    INTO remaining;
  FOR table_row IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema='core' AND column_name='primary_connection_id'
  LOOP
    EXECUTE format('SELECT count(*) FROM core.%I WHERE tenant_id=$1 AND primary_connection_id=$2',table_row.table_name)
      INTO affected USING p_tenant_id,p_connection_id;remaining:=remaining+affected;
  END LOOP;
  RETURN jsonb_build_object('verified',remaining=0,'scope','connection','remainingRows',remaining);
END;
$$;

CREATE OR REPLACE FUNCTION deletion_internal.verify_tenant(p_tenant_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,core AS $$
DECLARE table_row record;affected bigint;remaining bigint:=0;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) THEN RAISE EXCEPTION 'tenant id must be a ULID' USING ERRCODE='22023';END IF;
  PERFORM set_config('albert.tenant_id',p_tenant_id,true);
  FOR table_row IN
    SELECT DISTINCT c.table_schema,c.table_name
    FROM information_schema.columns c JOIN information_schema.tables t
      ON t.table_schema=c.table_schema AND t.table_name=c.table_name
    WHERE c.column_name='tenant_id' AND t.table_type='BASE TABLE'
      AND c.table_schema IN ('ingestion','source_lightspeed','source_xero','source_deputy','core','quality','mart','semantic_internal')
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I WHERE tenant_id=$1',table_row.table_schema,table_row.table_name)
      INTO affected USING p_tenant_id;remaining:=remaining+affected;
  END LOOP;
  RETURN jsonb_build_object('verified',remaining=0,'scope','tenant','remainingRows',remaining);
END;
$$;

REVOKE ALL ON FUNCTION deletion_internal.refresh_remaining_marts(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION deletion_internal.purge_connection(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION deletion_internal.purge_tenant(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION deletion_internal.verify_connection(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION deletion_internal.verify_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION deletion_internal.purge_connection(text,text) TO deletion_rw;
GRANT EXECUTE ON FUNCTION deletion_internal.purge_tenant(text) TO deletion_rw;
GRANT EXECUTE ON FUNCTION deletion_internal.verify_connection(text,text) TO deletion_rw;
GRANT EXECUTE ON FUNCTION deletion_internal.verify_tenant(text) TO deletion_rw;

COMMIT;
