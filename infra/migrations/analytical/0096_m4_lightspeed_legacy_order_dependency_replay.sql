BEGIN;

-- Pack 1.0 could land a valid Order whose canonical transaction then failed
-- because that pack had no Vendor stream. The compatibility path below is
-- deliberately narrower than a general mapping replay: it is available only
-- to pack 1.1, only after current-generation Vendor and Order backfill plus
-- reconciliation, and only for unchanged, non-tombstoned pack-1.0 Orders.
CREATE TABLE semantic_internal.lightspeed_order_dependency_replay_audit (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  connection_id text NOT NULL CHECK (core.is_ulid(connection_id)),
  connection_generation bigint NOT NULL CHECK (connection_generation>0),
  repair_batch_id text NOT NULL CHECK (core.is_ulid(repair_batch_id)),
  repair_sync_run_id text NOT NULL CHECK (core.is_ulid(repair_sync_run_id)),
  repair_stream text NOT NULL CHECK (repair_stream IN ('vendors','orders')),
  supplier_source_record_id text NOT NULL,
  source_order_namespaced_key text NOT NULL,
  source_order_record_id text NOT NULL,
  source_order_payload_hash text NOT NULL
    CHECK (source_order_payload_hash ~ '^[a-f0-9]{64}$'),
  source_order_mapping_version text NOT NULL,
  source_order_batch_id text NOT NULL CHECK (core.is_ulid(source_order_batch_id)),
  source_order_sync_run_id text NOT NULL CHECK (core.is_ulid(source_order_sync_run_id)),
  legacy_origin_batch_id text NOT NULL CHECK (core.is_ulid(legacy_origin_batch_id)),
  legacy_origin_sync_run_id text NOT NULL CHECK (core.is_ulid(legacy_origin_sync_run_id)),
  legacy_normalized_schema_version text NOT NULL
    CHECK (legacy_normalized_schema_version='1.0.0'),
  materialized_command_count integer NOT NULL CHECK (materialized_command_count>0),
  result text NOT NULL CHECK (result='materialized'),
  reason text NOT NULL CHECK (reason='vendor_stream_introduction'),
  replayed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (
    tenant_id,connection_id,connection_generation,source_order_namespaced_key,
    source_order_payload_hash,source_order_mapping_version
  ),
  FOREIGN KEY (tenant_id,repair_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id,batch_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,source_order_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id,batch_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,legacy_origin_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id,batch_id) ON DELETE RESTRICT,
  CHECK (length(btrim(supplier_source_record_id)) BETWEEN 1 AND 300),
  CHECK (length(btrim(source_order_namespaced_key)) BETWEEN 1 AND 1000),
  CHECK (length(btrim(source_order_record_id)) BETWEEN 1 AND 300),
  CHECK (length(btrim(source_order_mapping_version)) BETWEEN 1 AND 100)
);

COMMENT ON TABLE semantic_internal.lightspeed_order_dependency_replay_audit IS
  'Append-only exact-lineage evidence for the bounded pack-1.0 Order supplier repair.';

CREATE INDEX lightspeed_order_dependency_replay_connection_idx
  ON semantic_internal.lightspeed_order_dependency_replay_audit(
    tenant_id,connection_id,connection_generation,replayed_at DESC
  );

ALTER TABLE semantic_internal.lightspeed_order_dependency_replay_audit
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE semantic_internal.lightspeed_order_dependency_replay_audit
  FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation
  ON semantic_internal.lightspeed_order_dependency_replay_audit
  USING (tenant_id=core.current_tenant_id())
  WITH CHECK (tenant_id=core.current_tenant_id());

CREATE TRIGGER lightspeed_order_dependency_replay_audit_immutable
  BEFORE UPDATE OR DELETE
  ON semantic_internal.lightspeed_order_dependency_replay_audit
  FOR EACH ROW EXECUTE FUNCTION semantic_internal.reject_audit_mutation();

-- Like connector_pack_evidence_index, this is a non-sensitive global release
-- index: opaque tenant/connection IDs, generations, timestamps and counts only.
-- It intentionally has no tenant RLS so the migration-owner activation gate
-- can prove fleet-wide completion without acquiring a tenant capability.
CREATE TABLE semantic_internal.lightspeed_supplier_replay_gate_index (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  connection_id text NOT NULL CHECK (core.is_ulid(connection_id)),
  connection_generation bigint NOT NULL CHECK (connection_generation>0),
  vendor_backfill_complete boolean NOT NULL DEFAULT false,
  vendor_reconciliation_completed_at timestamptz,
  order_backfill_complete boolean NOT NULL DEFAULT false,
  order_reconciliation_completed_at timestamptz,
  legacy_candidate_count bigint NOT NULL DEFAULT 0 CHECK (legacy_candidate_count>=0),
  replay_audit_count bigint NOT NULL DEFAULT 0 CHECK (replay_audit_count>=0),
  ready boolean NOT NULL DEFAULT false,
  evidence_batch_id text,
  evaluated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,connection_id),
  FOREIGN KEY (tenant_id,evidence_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id,batch_id) ON DELETE RESTRICT,
  CHECK (replay_audit_count<=legacy_candidate_count),
  CHECK (
    NOT ready OR (
      vendor_backfill_complete
      AND vendor_reconciliation_completed_at IS NOT NULL
      AND order_backfill_complete
      AND order_reconciliation_completed_at IS NOT NULL
      AND replay_audit_count=legacy_candidate_count
      AND evidence_batch_id IS NOT NULL
    )
  )
);

COMMENT ON TABLE semantic_internal.lightspeed_supplier_replay_gate_index IS
  'Opaque global release evidence. Pack 1.1 activation requires one current, ready row for every predecessor Lightspeed connection.';

REVOKE ALL ON semantic_internal.lightspeed_order_dependency_replay_audit,
  semantic_internal.lightspeed_supplier_replay_gate_index
FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT SELECT ON semantic_internal.lightspeed_order_dependency_replay_audit
  TO transform_rw,diagnostic_ro;

-- One transaction-scoped lock serializes generation changes, legacy arrivals,
-- replay evidence and gate finalization for a connection. This prevents a
-- finalizer from overwriting a concurrent invalidation with stale counts.
CREATE FUNCTION semantic_internal.lock_lightspeed_supplier_replay(
  p_tenant_id text,p_connection_id text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF NOT core.is_ulid(p_tenant_id) OR NOT core.is_ulid(p_connection_id) THEN
    RAISE EXCEPTION 'Lightspeed supplier replay lock scope is invalid'
      USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'lightspeed-supplier-replay:'||p_tenant_id||':'||p_connection_id,0
  ));
END;
$$;

-- Maintain the global generation/backfill/reconciliation summary whenever
-- durable stream health moves. A new generation or regressed health always
-- clears readiness; only the exact replay finalizer below can set it true.
CREATE FUNCTION semantic_internal.sync_lightspeed_supplier_replay_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  target_tenant text;
  target_connection text;
  target_connector text;
  target_stream text;
  current_generation bigint;
  vendor_state record;
  order_state record;
  streams_ready boolean;
BEGIN
  IF TG_OP='DELETE' THEN
    target_tenant:=OLD.tenant_id;
    target_connection:=OLD.connection_id;
    target_connector:=OLD.connector_id;
    target_stream:=OLD.stream;
  ELSE
    target_tenant:=NEW.tenant_id;
    target_connection:=NEW.connection_id;
    target_connector:=NEW.connector_id;
    target_stream:=NEW.stream;
  END IF;
  IF target_connector<>'lightspeed-r'
     OR target_stream NOT IN ('vendors','orders') THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  -- The signed purge deletes this gate before delegating to the established
  -- reconciliation cleanup, which then deletes connector_stream_state. Do not
  -- let those AFTER DELETE triggers recreate the erased gate from sibling
  -- rows that have not yet been visited by the same DELETE statement. Runtime
  -- roles have no table DELETE privilege; the established migration-owner
  -- deletion fence is the only path through this branch.
  IF TG_OP='DELETE' AND deletion_internal.mutation_authorized() THEN
    DELETE FROM semantic_internal.lightspeed_supplier_replay_gate_index gate
     WHERE gate.tenant_id=target_tenant
       AND gate.connection_id=target_connection;
    RETURN OLD;
  END IF;

  -- Acquire the release fence before waiting on replay serialization.  If a
  -- finalizer currently owns the replay lock, this SHARE lock is compatible
  -- with its release lock but queues activation's FOR UPDATE behind this
  -- health mutation.  Taking the locks in the opposite order would leave a
  -- wake-up race in which activation could observe the old ready gate before
  -- this trigger had requested its release lock.
  PERFORM 1
    FROM semantic_internal.connector_pack_release release
   WHERE release.connector_id='lightspeed-r'
     AND release.pack_version='1.1.0'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'connector_pack_unregistered:lightspeed-r:1.1.0'
      USING ERRCODE='55000';
  END IF;
  PERFORM semantic_internal.lock_lightspeed_supplier_replay(
    target_tenant,target_connection
  );

  SELECT max(state.connection_generation)
    INTO current_generation
    FROM quality.connector_stream_state state
   WHERE state.tenant_id=target_tenant
     AND state.connection_id=target_connection
     AND state.connector_id='lightspeed-r';
  IF current_generation IS NULL THEN
    DELETE FROM semantic_internal.lightspeed_supplier_replay_gate_index gate
     WHERE gate.tenant_id=target_tenant AND gate.connection_id=target_connection;
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  SELECT state.* INTO vendor_state
    FROM quality.connector_stream_state state
   WHERE state.tenant_id=target_tenant
     AND state.connection_id=target_connection
     AND state.connection_generation=current_generation
     AND state.connector_id='lightspeed-r' AND state.stream='vendors';
  SELECT state.* INTO order_state
    FROM quality.connector_stream_state state
   WHERE state.tenant_id=target_tenant
     AND state.connection_id=target_connection
     AND state.connection_generation=current_generation
     AND state.connector_id='lightspeed-r' AND state.stream='orders';
  streams_ready:=vendor_state.connection_generation IS NOT NULL
    AND order_state.connection_generation IS NOT NULL
    AND vendor_state.backfill_complete AND order_state.backfill_complete
    AND vendor_state.cursor_complete AND order_state.cursor_complete
    AND vendor_state.cursor_chain_valid AND order_state.cursor_chain_valid
    AND vendor_state.reconciliation_completed_at IS NOT NULL
    AND order_state.reconciliation_completed_at IS NOT NULL
    AND vendor_state.reconciliation_gap_count=0
    AND order_state.reconciliation_gap_count=0
    AND vendor_state.unresolved_schema_drift_count=0
    AND order_state.unresolved_schema_drift_count=0
    AND vendor_state.unresolved_enum_drift_count=0
    AND order_state.unresolved_enum_drift_count=0
    AND vendor_state.unresolved_quarantine_count=0
    AND order_state.unresolved_quarantine_count=0;

  INSERT INTO semantic_internal.lightspeed_supplier_replay_gate_index (
    tenant_id,connection_id,connection_generation,
    vendor_backfill_complete,vendor_reconciliation_completed_at,
    order_backfill_complete,order_reconciliation_completed_at,ready
  ) VALUES (
    target_tenant,target_connection,current_generation,
    coalesce(vendor_state.backfill_complete,false),vendor_state.reconciliation_completed_at,
    coalesce(order_state.backfill_complete,false),order_state.reconciliation_completed_at,false
  ) ON CONFLICT (tenant_id,connection_id) DO UPDATE SET
    connection_generation=excluded.connection_generation,
    vendor_backfill_complete=excluded.vendor_backfill_complete,
    vendor_reconciliation_completed_at=excluded.vendor_reconciliation_completed_at,
    order_backfill_complete=excluded.order_backfill_complete,
    order_reconciliation_completed_at=excluded.order_reconciliation_completed_at,
    legacy_candidate_count=CASE
      WHEN semantic_internal.lightspeed_supplier_replay_gate_index.connection_generation=excluded.connection_generation
        THEN semantic_internal.lightspeed_supplier_replay_gate_index.legacy_candidate_count
      ELSE 0 END,
    replay_audit_count=CASE
      WHEN semantic_internal.lightspeed_supplier_replay_gate_index.connection_generation=excluded.connection_generation
        THEN semantic_internal.lightspeed_supplier_replay_gate_index.replay_audit_count
      ELSE 0 END,
    ready=semantic_internal.lightspeed_supplier_replay_gate_index.connection_generation=excluded.connection_generation
      AND semantic_internal.lightspeed_supplier_replay_gate_index.ready
      AND streams_ready,
    evidence_batch_id=CASE
      WHEN semantic_internal.lightspeed_supplier_replay_gate_index.connection_generation=excluded.connection_generation
       AND semantic_internal.lightspeed_supplier_replay_gate_index.ready
       AND streams_ready
        THEN semantic_internal.lightspeed_supplier_replay_gate_index.evidence_batch_id
      ELSE NULL END,
    evaluated_at=clock_timestamp();
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

CREATE TRIGGER connector_stream_state_lightspeed_supplier_replay_gate
  AFTER INSERT OR UPDATE OR DELETE ON quality.connector_stream_state
  FOR EACH ROW EXECUTE FUNCTION semantic_internal.sync_lightspeed_supplier_replay_gate();

-- Seed existing Lightspeed generations as explicitly not ready. Runtime code
-- never receives an RLS bypass; FORCE is relaxed only inside this DDL-owner
-- transaction and restored before commit.
ALTER TABLE quality.connector_stream_state NO FORCE ROW LEVEL SECURITY;
INSERT INTO semantic_internal.lightspeed_supplier_replay_gate_index (
  tenant_id,connection_id,connection_generation,
  vendor_backfill_complete,vendor_reconciliation_completed_at,
  order_backfill_complete,order_reconciliation_completed_at,ready
)
SELECT state.tenant_id,state.connection_id,state.connection_generation,
       coalesce(bool_or(state.backfill_complete) FILTER (WHERE state.stream='vendors'),false),
       max(state.reconciliation_completed_at) FILTER (WHERE state.stream='vendors'),
       coalesce(bool_or(state.backfill_complete) FILTER (WHERE state.stream='orders'),false),
       max(state.reconciliation_completed_at) FILTER (WHERE state.stream='orders'),false
  FROM quality.connector_stream_state state
  JOIN (
    SELECT tenant_id,connection_id,max(connection_generation) AS connection_generation
      FROM quality.connector_stream_state
     WHERE connector_id='lightspeed-r'
     GROUP BY tenant_id,connection_id
  ) latest USING (tenant_id,connection_id,connection_generation)
 WHERE state.connector_id='lightspeed-r'
 GROUP BY state.tenant_id,state.connection_id,state.connection_generation
ON CONFLICT (tenant_id,connection_id) DO NOTHING;
ALTER TABLE quality.connector_stream_state FORCE ROW LEVEL SECURITY;

-- Any genuine legacy Order arrival or reprojection invalidates a completed
-- gate. Taking the release-row SHARE lock makes this atomic with activation:
-- activation either drains and observes the invalidation, or a retired 1.0
-- writer is rejected before its landing transaction can commit.
CREATE FUNCTION semantic_internal.invalidate_lightspeed_supplier_replay_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE observed_pack_version text;release_state text;legacy_projection boolean:=false;
BEGIN
  IF TG_TABLE_SCHEMA='ingestion' THEN
    IF NEW.connector_key<>'lightspeed-r' OR NEW.stream<>'orders'
       OR coalesce(NEW.normalized_schema_version,'')<>'1.0.0'
          AND coalesce(OLD.normalized_schema_version,'')<>'1.0.0' THEN
      RETURN NEW;
    END IF;
    PERFORM semantic_internal.lock_lightspeed_supplier_replay(
      NEW.tenant_id,NEW.connection_id
    );
    legacy_projection:=true;
    SELECT manifest.connector_version INTO observed_pack_version
      FROM ingestion.batch_manifests manifest
     WHERE manifest.tenant_id=NEW.tenant_id AND manifest.batch_id=NEW.payload_batch_id;
  ELSE
    PERFORM semantic_internal.lock_lightspeed_supplier_replay(
      NEW.tenant_id,NEW.connection_id
    );
    SELECT source.normalized_schema_version='1.0.0',manifest.connector_version
      INTO legacy_projection,observed_pack_version
      FROM ingestion.source_records source
      JOIN ingestion.batch_manifests manifest
        ON manifest.tenant_id=NEW.tenant_id AND manifest.batch_id=NEW.payload_batch_id
     WHERE source.tenant_id=NEW.tenant_id
       AND source.namespaced_source_key=NEW.namespaced_source_key
       AND source.connection_id=NEW.connection_id
       AND source.connector_key='lightspeed-r' AND source.stream='orders';
    IF NOT coalesce(legacy_projection,false) THEN RETURN NEW; END IF;
  END IF;

  SELECT release.state INTO release_state
    FROM semantic_internal.connector_pack_release release
   WHERE release.connector_id='lightspeed-r'
     AND release.pack_version=observed_pack_version
   FOR SHARE;
  IF release_state IS NULL OR release_state NOT IN ('candidate','active') THEN
    RAISE EXCEPTION 'connector_pack_retired:lightspeed-r:%',observed_pack_version
      USING ERRCODE='55000';
  END IF;
  UPDATE semantic_internal.lightspeed_supplier_replay_gate_index gate
     SET ready=false,evidence_batch_id=NULL,evaluated_at=clock_timestamp()
   WHERE gate.tenant_id=NEW.tenant_id AND gate.connection_id=NEW.connection_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER source_record_lightspeed_supplier_replay_invalidation
  AFTER INSERT OR UPDATE OF payload_hash,normalized_schema_version,tombstone,payload_batch_id
  ON ingestion.source_records
  FOR EACH ROW EXECUTE FUNCTION semantic_internal.invalidate_lightspeed_supplier_replay_gate();
CREATE TRIGGER typed_order_lightspeed_supplier_replay_invalidation
  AFTER INSERT OR UPDATE OF payload_hash,mapping_version,tombstone,payload_batch_id
  ON source_lightspeed.orders
  FOR EACH ROW EXECUTE FUNCTION semantic_internal.invalidate_lightspeed_supplier_replay_gate();

-- Return the current generation only for a pack-1.1 terminal backfill or
-- reconciliation page after both dependency streams are complete and clean.
-- Returning NULL is an intentional no-op: whichever of Vendor/Order finishes
-- the second prerequisite will invoke the same check again.
CREATE FUNCTION semantic_internal.lightspeed_supplier_replay_generation(
  p_tenant_id text,p_connection_id text,p_batch_id text
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE page_generation bigint;release_state text;streams_ready boolean;already_ready boolean;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id()
     OR NOT core.is_ulid(p_tenant_id)
     OR NOT core.is_ulid(p_connection_id)
     OR NOT core.is_ulid(p_batch_id) THEN
    RAISE EXCEPTION 'Lightspeed dependency replay scope is invalid' USING ERRCODE='22023';
  END IF;
  PERFORM semantic_internal.lock_lightspeed_supplier_replay(
    p_tenant_id,p_connection_id
  );
  SELECT release.state INTO release_state
    FROM semantic_internal.connector_pack_release release
   WHERE release.connector_id='lightspeed-r' AND release.pack_version='1.1.0'
   FOR SHARE;
  IF release_state IS NULL OR release_state NOT IN ('candidate','active') THEN RETURN NULL; END IF;

  SELECT page.connection_generation INTO page_generation
    FROM quality.connector_stream_page_evidence page
    JOIN ingestion.batch_manifests manifest
      ON manifest.tenant_id=page.tenant_id AND manifest.batch_id=page.batch_id
   WHERE page.tenant_id=p_tenant_id AND page.batch_id=p_batch_id
     AND page.connection_id=p_connection_id
     AND page.stream IN ('vendors','orders')
     AND manifest.connection_id=p_connection_id
     AND manifest.connector_key='lightspeed-r'
     AND manifest.connector_version='1.1.0'
     AND manifest.stream=page.stream
     AND coalesce((page.evidence->>'cursorComplete')::boolean,false)
     AND (
       (page.evidence->>'jobType'='InitialBackfill'
        AND coalesce((page.evidence->>'backfillComplete')::boolean,false))
       OR
       (page.evidence->>'jobType'='ReconciliationSweep'
        AND page.evidence->>'reconciliationPhase'='apply_tombstones')
     );
  IF page_generation IS NULL THEN RETURN NULL; END IF;
  IF EXISTS (
    SELECT 1 FROM quality.connector_stream_state newer
     WHERE newer.tenant_id=p_tenant_id AND newer.connection_id=p_connection_id
       AND newer.connector_id='lightspeed-r'
       AND newer.connection_generation>page_generation
  ) THEN RETURN NULL; END IF;

  SELECT count(*)=2 AND bool_and(
           state.backfill_complete AND state.cursor_complete AND state.cursor_chain_valid
           AND state.reconciliation_completed_at IS NOT NULL
           AND state.reconciliation_gap_count=0
           AND state.unresolved_schema_drift_count=0
           AND state.unresolved_enum_drift_count=0
           AND state.unresolved_quarantine_count=0
         ) INTO streams_ready
    FROM quality.connector_stream_state state
   WHERE state.tenant_id=p_tenant_id AND state.connection_id=p_connection_id
     AND state.connection_generation=page_generation
     AND state.connector_id='lightspeed-r' AND state.stream IN ('vendors','orders');
  SELECT gate.ready AND gate.connection_generation=page_generation INTO already_ready
    FROM semantic_internal.lightspeed_supplier_replay_gate_index gate
   WHERE gate.tenant_id=p_tenant_id AND gate.connection_id=p_connection_id;
  RETURN CASE WHEN coalesce(streams_ready,false) AND NOT coalesce(already_ready,false)
    THEN page_generation ELSE NULL END;
END;
$$;

-- The transform runtime has no direct audit INSERT grant. This fixed entry
-- point re-validates repair eligibility, immutable Order lineage, legacy pack
-- origin and the source-owned supplier before it can append evidence.
CREATE FUNCTION semantic_internal.record_lightspeed_order_dependency_replay(
  p_tenant_id text,p_connection_id text,p_repair_batch_id text,p_repair_sync_run_id text,
  p_source_order_namespaced_key text,p_source_order_payload_hash text,
  p_source_order_mapping_version text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE order_row record;repair_generation bigint;inserted_count integer;
DECLARE supplier_id text;raw_line_count bigint;expected_line_count bigint;
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

  SELECT supplier_state.canonical_id INTO STRICT supplier_id
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
     AND fact.supplier_id=supplier_id;
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

-- Finalization recomputes the complete candidate set under the tenant lock.
-- A missing audit, stale tombstone, missing supplier or later generation keeps
-- the global activation gate closed.
CREATE FUNCTION semantic_internal.finalize_lightspeed_supplier_replay_gate(
  p_tenant_id text,p_connection_id text,p_repair_batch_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE repair_generation bigint;candidate_count bigint;audit_count bigint;
DECLARE vendor_state record;order_state record;
BEGIN
  PERFORM semantic_internal.lock_lightspeed_supplier_replay(
    p_tenant_id,p_connection_id
  );
  repair_generation:=semantic_internal.lightspeed_supplier_replay_generation(
    p_tenant_id,p_connection_id,p_repair_batch_id
  );
  IF repair_generation IS NULL THEN
    RAISE EXCEPTION 'Lightspeed supplier replay is not eligible for finalization'
      USING ERRCODE='55000';
  END IF;

  SELECT count(*) INTO candidate_count
    FROM source_lightspeed.orders staged
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
   WHERE staged.tenant_id=p_tenant_id AND staged.connection_id=p_connection_id
     AND NOT staged.tombstone AND nullif(btrim(staged.vendor_id),'') IS NOT NULL
     AND btrim(staged.vendor_id)<>'0'
     AND (
       jsonb_typeof(staged.order_lines->'OrderLine')='object'
       OR (jsonb_typeof(staged.order_lines->'OrderLine')='array'
           AND jsonb_array_length(staged.order_lines->'OrderLine')>0)
       OR (jsonb_typeof(staged.order_lines)='array'
           AND jsonb_array_length(staged.order_lines)>0)
     );
  SELECT count(*) INTO audit_count
    FROM semantic_internal.lightspeed_order_dependency_replay_audit audit
   WHERE audit.tenant_id=p_tenant_id AND audit.connection_id=p_connection_id
     AND audit.connection_generation=repair_generation
     AND EXISTS (
       SELECT 1 FROM source_lightspeed.orders staged
        WHERE staged.tenant_id=audit.tenant_id
          AND staged.connection_id=audit.connection_id
          AND staged.namespaced_source_key=audit.source_order_namespaced_key
          AND staged.payload_hash=audit.source_order_payload_hash
          AND staged.mapping_version=audit.source_order_mapping_version
          AND NOT staged.tombstone
     );
  IF audit_count<>candidate_count THEN
    RAISE EXCEPTION 'Lightspeed supplier replay remains incomplete: % of %',audit_count,candidate_count
      USING ERRCODE='55000';
  END IF;

  SELECT state.* INTO STRICT vendor_state
    FROM quality.connector_stream_state state
   WHERE state.tenant_id=p_tenant_id AND state.connection_id=p_connection_id
     AND state.connection_generation=repair_generation
     AND state.connector_id='lightspeed-r' AND state.stream='vendors';
  SELECT state.* INTO STRICT order_state
    FROM quality.connector_stream_state state
   WHERE state.tenant_id=p_tenant_id AND state.connection_id=p_connection_id
     AND state.connection_generation=repair_generation
     AND state.connector_id='lightspeed-r' AND state.stream='orders';
  UPDATE semantic_internal.lightspeed_supplier_replay_gate_index gate
     SET connection_generation=repair_generation,
         vendor_backfill_complete=vendor_state.backfill_complete,
         vendor_reconciliation_completed_at=vendor_state.reconciliation_completed_at,
         order_backfill_complete=order_state.backfill_complete,
         order_reconciliation_completed_at=order_state.reconciliation_completed_at,
         legacy_candidate_count=candidate_count,replay_audit_count=audit_count,
         ready=true,evidence_batch_id=p_repair_batch_id,evaluated_at=clock_timestamp()
   WHERE gate.tenant_id=p_tenant_id AND gate.connection_id=p_connection_id
     AND gate.connection_generation=repair_generation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lightspeed supplier replay gate generation changed during finalization'
      USING ERRCODE='40001';
  END IF;
  RETURN jsonb_build_object(
    'ready',true,'connectionGeneration',repair_generation,
    'legacyCandidateCount',candidate_count,'replayAuditCount',audit_count
  );
END;
$$;

REVOKE ALL ON FUNCTION
  semantic_internal.lock_lightspeed_supplier_replay(text,text),
  semantic_internal.sync_lightspeed_supplier_replay_gate(),
  semantic_internal.invalidate_lightspeed_supplier_replay_gate(),
  semantic_internal.lightspeed_supplier_replay_generation(text,text,text),
  semantic_internal.record_lightspeed_order_dependency_replay(
    text,text,text,text,text,text,text
  ),
  semantic_internal.finalize_lightspeed_supplier_replay_gate(text,text,text)
FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT EXECUTE ON FUNCTION
  semantic_internal.lightspeed_supplier_replay_generation(text,text,text),
  semantic_internal.record_lightspeed_order_dependency_replay(
    text,text,text,text,text,text,text
  ),
  semantic_internal.finalize_lightspeed_supplier_replay_gate(text,text,text)
TO transform_rw;

-- Extend 0095's activation hook. The base activation checks candidate
-- capabilities and fields; this gate additionally requires reconciled Vendor
-- and Order state plus complete legacy replay for every predecessor connection.
CREATE OR REPLACE FUNCTION semantic_internal.connector_pack_release_external_gate_status(
  p_connector_id text,p_candidate_pack_version text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE expected_connections bigint;ready_connections bigint;
BEGIN
  IF p_connector_id<>'lightspeed-r' OR p_candidate_pack_version<>'1.1.0' THEN
    RETURN jsonb_build_object('ready',true,'gates','[]'::jsonb);
  END IF;
  SELECT count(*) INTO expected_connections FROM (
    SELECT DISTINCT evidence.tenant_id,evidence.connection_id
      FROM semantic_internal.connector_pack_evidence_index evidence
     WHERE evidence.connector_id='lightspeed-r' AND evidence.pack_version='1.0.0'
       AND semantic_internal.connector_pack_connection_requires_candidate(
         evidence.tenant_id,evidence.connection_id,'lightspeed-r','1.1.0'
       )
  ) expected;
  SELECT count(*) INTO ready_connections FROM (
    SELECT DISTINCT evidence.tenant_id,evidence.connection_id
      FROM semantic_internal.connector_pack_evidence_index evidence
      JOIN semantic_internal.lightspeed_supplier_replay_gate_index gate
        ON gate.tenant_id=evidence.tenant_id
       AND gate.connection_id=evidence.connection_id AND gate.ready
     WHERE evidence.connector_id='lightspeed-r' AND evidence.pack_version='1.0.0'
       AND semantic_internal.connector_pack_connection_requires_candidate(
         evidence.tenant_id,evidence.connection_id,'lightspeed-r','1.1.0'
       )
  ) ready;
  RETURN jsonb_build_object(
    'ready',ready_connections=expected_connections,
    'gates',jsonb_build_array(jsonb_build_object(
      'gate','lightspeed_vendor_backfill_and_legacy_order_replay',
      'expectedConnections',expected_connections,
      'readyConnections',ready_connections,
      'missingConnections',expected_connections-ready_connections,
      'ready',ready_connections=expected_connections
    ))
  );
END;
$$;

REVOKE ALL ON FUNCTION
  semantic_internal.connector_pack_release_external_gate_status(text,text)
FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT EXECUTE ON FUNCTION
  semantic_internal.connector_pack_release_external_gate_status(text,text)
TO albert_migration_owner;

-- Connection deletion predates these tables. Insert one private layer beneath
-- the existing signed one-use wrapper so RESTRICT lineage anchors can then be
-- removed by the established deletion procedure.
ALTER FUNCTION deletion_internal.purge_connection_pre_capability(text,text)
  RENAME TO purge_connection_before_lightspeed_dependency_replay;

CREATE FUNCTION deletion_internal.purge_connection_pre_capability(
  p_tenant_id text,p_connection_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE removed bigint;added bigint;result jsonb;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) OR NOT core.is_ulid(p_connection_id) THEN
    RAISE EXCEPTION 'deletion scope identifiers must be ULIDs' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('albert.tenant_id',p_tenant_id,true);
  PERFORM set_config('albert.deletion_authorized','on',true);
  PERFORM pg_advisory_xact_lock(hashtextextended('deletion:'||p_tenant_id,0));
  DELETE FROM semantic_internal.lightspeed_order_dependency_replay_audit
   WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  GET DIAGNOSTICS removed=ROW_COUNT;
  DELETE FROM semantic_internal.lightspeed_supplier_replay_gate_index
   WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  GET DIAGNOSTICS added=ROW_COUNT;removed:=removed+added;
  result:=deletion_internal.purge_connection_before_lightspeed_dependency_replay(
    p_tenant_id,p_connection_id
  );
  RETURN jsonb_set(
    result,'{rowsRemoved}',
    to_jsonb(coalesce((result->>'rowsRemoved')::bigint,0)+removed),true
  );
END;
$$;

REVOKE ALL ON FUNCTION
  deletion_internal.purge_connection_before_lightspeed_dependency_replay(text,text),
  deletion_internal.purge_connection_pre_capability(text,text)
FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT EXECUTE ON FUNCTION deletion_internal.purge_connection_pre_capability(text,text)
  TO albert_migration_owner;

COMMIT;
