-- Repairs the deletion chain after the canonical retirement (0157/0158).
-- Those migrations dropped the core.* facts, the identity graph ledgers, the
-- canonical staging ledgers and the mart schema, but left the terminal links
-- of the deletion chain still issuing static DML against them. Since then any
-- connection purge has failed at the first DELETE on a dropped relation, so
-- disconnect deletion has been broken for every connector.
--
-- Repaired links (bodies keep only relations that still exist; catalog-driven
-- loops are untouched because a dropped table simply stops matching):
--   purge_connection_before_square_source  - deleted from the two Lightspeed
--     replay ledgers 0157 dropped; now pure delegation.
--   purge_connection_pre_reconciliation    - the 0060-era terminal purge; loses
--     the canonical-target closure, core.* bridge deletes, identity graph
--     deletes, mart deletes and the refresh_remaining_marts call.
--   verify_connection_pre_reconciliation   - loses static counts of dropped
--     core/semantic_internal tables.
--   refresh_remaining_marts                - dropped; the mart schema is gone
--     and its only caller was the repaired terminal purge.
-- verify_*_before_square_source keep mentioning retired names only inside
-- their classification vocabularies; their table sets come from the catalog,
-- so they need no repair.

BEGIN;

CREATE OR REPLACE FUNCTION deletion_internal.purge_connection_before_square_source(
  p_tenant_id text,p_connection_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF NOT core.is_ulid(p_tenant_id) OR NOT core.is_ulid(p_connection_id) THEN
    RAISE EXCEPTION 'deletion scope identifiers must be ULIDs' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('albert.tenant_id',p_tenant_id,true);
  PERFORM set_config('albert.deletion_authorized','on',true);
  PERFORM pg_advisory_xact_lock(hashtextextended('deletion:'||p_tenant_id,0));
  -- The Lightspeed replay ledgers this link used to clear were retired by
  -- 0157; the link survives as pure delegation to keep the chain contract.
  RETURN deletion_internal.purge_connection_before_lightspeed_dependency_replay(
    p_tenant_id,p_connection_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION deletion_internal.purge_connection_pre_reconciliation(
  p_tenant_id text,p_connection_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,ingestion,semantic_internal,quality
AS $$
DECLARE table_row record;affected bigint;removed bigint:=0;
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

  -- Query-derived caches and audit trails can contain the deleted source even
  -- without a connection column, so they are invalidated tenant-wide.
  DELETE FROM semantic_internal.query_audit WHERE tenant_id=p_tenant_id;
  DELETE FROM semantic_internal.result_cache WHERE tenant_id=p_tenant_id;
  DELETE FROM semantic_internal.readiness_projection_outbox WHERE tenant_id=p_tenant_id;
  DELETE FROM semantic_internal.pipeline_stats_projection_outbox WHERE tenant_id=p_tenant_id;
  DELETE FROM semantic_internal.pipeline_table_stats_projection_outbox WHERE tenant_id=p_tenant_id;
  DELETE FROM semantic_internal.promotion_candidate_outbox WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  DELETE FROM semantic_internal.source_field_allowlist WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  DELETE FROM semantic_internal.tenant_capability WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  DELETE FROM quality.finding WHERE tenant_id=p_tenant_id;
  DELETE FROM quality.check_result WHERE tenant_id=p_tenant_id;
  DELETE FROM quality.connector_check_observation
  WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  DELETE FROM quality.pipeline_stats WHERE tenant_id=p_tenant_id;

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

  RETURN jsonb_build_object('verified',true,'scope','connection','rowsRemoved',removed);
END;
$$;

CREATE OR REPLACE FUNCTION deletion_internal.verify_connection_pre_reconciliation(
  p_tenant_id text,p_connection_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,ingestion,semantic_internal,quality
AS $$
DECLARE table_row record;affected bigint;remaining bigint:=0;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) OR NOT core.is_ulid(p_connection_id) THEN
    RAISE EXCEPTION 'deletion scope identifiers must be ULIDs' USING ERRCODE='22023';
  END IF;
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
    +(SELECT count(*) FROM quality.connector_check_observation WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id)
    INTO remaining;
  RETURN jsonb_build_object('verified',remaining=0,'scope','connection','remainingRows',remaining);
END;
$$;

DROP FUNCTION IF EXISTS deletion_internal.refresh_remaining_marts(text);

REVOKE ALL ON FUNCTION
  deletion_internal.purge_connection_before_square_source(text,text),
  deletion_internal.purge_connection_pre_reconciliation(text,text),
  deletion_internal.verify_connection_pre_reconciliation(text,text)
FROM PUBLIC;

-- Fail closed: the repaired links must no longer mention any retired relation,
-- and the dropped helper must be gone. The two *_before_square_source
-- verifiers are exempt by construction (their retired names are vocabulary,
-- not DML) so they are not scanned here.
DO $$
DECLARE offender text;
BEGIN
  SELECT string_agg(p.proname,', ') INTO offender
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='deletion_internal'
    AND p.proname IN (
      'purge_connection_before_square_source',
      'purge_connection_pre_reconciliation',
      'verify_connection_pre_reconciliation'
    )
    AND pg_get_functiondef(p.oid) ~ ('canonical_record_state|canonical_transform_commits'
      || '|identity_observation|identity_graph_state|identity_link_baseline'
      || '|identity_decision_history|identity_review_projection_outbox'
      || '|entity_source_link|entity_resolution|entity_identity_edge'
      || '|order_line_source_observation|order_source_observation|event_link'
      || '|source_authority|refresh_remaining_marts'
      || '|lightspeed_order_dependency_replay_audit|lightspeed_supplier_replay_gate_index'
      || '|mart\.');
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'deletion repair left retired references in: %',offender;
  END IF;
  IF to_regprocedure('deletion_internal.refresh_remaining_marts(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'deletion repair left refresh_remaining_marts in place';
  END IF;
END $$;

COMMIT;
