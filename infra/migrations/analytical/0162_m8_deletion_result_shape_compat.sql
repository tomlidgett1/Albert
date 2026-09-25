-- The deletion worker validates the connection purge result against the exact
-- legacy key set ("canonicalDependencyRowsAdded", "canonicalResidual",
-- "marts") that predates the canonical retirement. 0159 repaired the purge
-- body but returned a slimmer object, so every purge now succeeds and commits
-- and then fails the worker's shape validation, cycling the deletion request
-- forever. Keep emitting the legacy shape with retired-concept zeros: the
-- canonical closure no longer exists (0157/0158), so its counts are
-- definitionally zero and the mart refresh is a zero-chunk no-op.

BEGIN;

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

  -- Legacy result contract: the deployed deletion worker requires these exact
  -- keys. The canonical closure is retired, so its counts are zero and the
  -- mart refresh is a zero-chunk no-op with null bounds.
  RETURN jsonb_build_object(
    'verified',true,'scope','connection','rowsRemoved',removed,
    'canonicalDependencyRowsAdded',0,'canonicalResidual',0,
    'marts',jsonb_build_object('refreshed',true,'chunks',0,'from',NULL,'to',NULL)
  );
END;
$$;

REVOKE ALL ON FUNCTION
  deletion_internal.purge_connection_pre_reconciliation(text,text)
FROM PUBLIC;

-- Fail closed: the final chained result must carry the worker's exact key set
-- once before_connector_pack_retirement adds reconciliationRowsRemoved.
DO $$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('deletion_internal.purge_connection_pre_reconciliation(text,text)'::regprocedure);
  IF def !~ 'canonicalDependencyRowsAdded' OR def !~ 'canonicalResidual' OR def !~ '''marts''' THEN
    RAISE EXCEPTION 'purge result shape compat keys are missing';
  END IF;
END $$;

COMMIT;
