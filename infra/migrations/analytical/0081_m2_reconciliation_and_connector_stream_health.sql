BEGIN;

CREATE TABLE IF NOT EXISTS quality.connector_stream_state (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  connection_id text NOT NULL CHECK (core.is_ulid(connection_id)),
  connection_generation bigint NOT NULL CHECK (connection_generation > 0),
  connector_id text NOT NULL CHECK (connector_id IN ('lightspeed-r','xero','deputy')),
  stream text NOT NULL CHECK (stream ~ '^[a-z][a-z0-9_]*$'),
  required boolean NOT NULL,
  late_edit_strategy text NOT NULL CHECK (
    late_edit_strategy IN ('modified_field','full_snapshot','append_only')
  ),
  deletion_strategy text NOT NULL CHECK (
    deletion_strategy IN (
      'soft_delete','verified_delete_feed','authoritative_identity_scan','immutable_append_only'
    )
  ),
  source_total_strategy text NOT NULL CHECK (
    source_total_strategy IN ('provider_reported','count_distinct_complete_scan')
  ),
  observed_page_count bigint NOT NULL DEFAULT 0 CHECK (observed_page_count >= 0),
  cursor_chain_valid boolean NOT NULL DEFAULT true,
  cursor_complete boolean NOT NULL DEFAULT false,
  backfill_complete boolean NOT NULL DEFAULT false,
  retention_evidence jsonb CHECK (
    retention_evidence IS NULL OR jsonb_typeof(retention_evidence)='object'
  ),
  reconciliation_completed_at timestamptz,
  reconciliation_sweep_id text CHECK (
    reconciliation_sweep_id IS NULL OR core.is_ulid(reconciliation_sweep_id)
  ),
  reconciliation_gap_count bigint NOT NULL DEFAULT 0 CHECK (reconciliation_gap_count >= 0),
  deletion_evidence_count bigint NOT NULL DEFAULT 0 CHECK (deletion_evidence_count >= 0),
  source_total bigint CHECK (source_total IS NULL OR source_total >= 0),
  local_live_total bigint CHECK (local_live_total IS NULL OR local_live_total >= 0),
  unresolved_schema_drift_count bigint NOT NULL DEFAULT 0
    CHECK (unresolved_schema_drift_count >= 0),
  unresolved_enum_drift_count bigint NOT NULL DEFAULT 0
    CHECK (unresolved_enum_drift_count >= 0),
  unresolved_quarantine_count bigint NOT NULL DEFAULT 0
    CHECK (unresolved_quarantine_count >= 0),
  last_page_at timestamptz,
  registered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,connection_id,connection_generation,stream),
  CHECK (deletion_strategy<>'immutable_append_only' OR late_edit_strategy='append_only')
);

CREATE TABLE IF NOT EXISTS quality.reconciliation_snapshot (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  connection_id text NOT NULL CHECK (core.is_ulid(connection_id)),
  connection_generation bigint NOT NULL CHECK (connection_generation > 0),
  reconciliation_sweep_id text NOT NULL CHECK (core.is_ulid(reconciliation_sweep_id)),
  connector_id text NOT NULL CHECK (connector_id IN ('lightspeed-r','xero','deputy')),
  stream text NOT NULL CHECK (stream ~ '^[a-z][a-z0-9_]*$'),
  scan_ordinal smallint NOT NULL CHECK (scan_ordinal IN (1,2)),
  deletion_strategy text NOT NULL CHECK (
    deletion_strategy IN (
      'soft_delete','verified_delete_feed','authoritative_identity_scan','immutable_append_only'
    )
  ),
  source_total_strategy text NOT NULL CHECK (
    source_total_strategy IN ('provider_reported','count_distinct_complete_scan')
  ),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','complete','failed')),
  page_count bigint NOT NULL DEFAULT 0 CHECK (page_count >= 0),
  observed_count bigint NOT NULL DEFAULT 0 CHECK (observed_count >= 0),
  unique_count bigint NOT NULL DEFAULT 0 CHECK (unique_count >= 0),
  duplicate_count bigint NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  invalid_count bigint NOT NULL DEFAULT 0 CHECK (invalid_count >= 0),
  quarantine_count bigint NOT NULL DEFAULT 0 CHECK (quarantine_count >= 0),
  source_total bigint CHECK (source_total IS NULL OR source_total >= 0),
  membership_delta_count bigint NOT NULL DEFAULT 0 CHECK (membership_delta_count >= 0),
  last_batch_id text CHECK (last_batch_id IS NULL OR core.is_ulid(last_batch_id)),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (
    tenant_id,connection_id,connection_generation,reconciliation_sweep_id,stream,scan_ordinal
  ),
  FOREIGN KEY (tenant_id,last_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id,batch_id) ON DELETE CASCADE,
  CHECK ((status='running')=(completed_at IS NULL))
);

CREATE TABLE IF NOT EXISTS quality.connector_stream_page_evidence (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  batch_id text NOT NULL CHECK (core.is_ulid(batch_id)),
  connection_id text NOT NULL CHECK (core.is_ulid(connection_id)),
  connection_generation bigint NOT NULL CHECK (connection_generation > 0),
  stream text NOT NULL CHECK (stream ~ '^[a-z][a-z0-9_]*$'),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,batch_id),
  FOREIGN KEY (tenant_id,batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id,batch_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quality.reconciliation_snapshot_page (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  connection_id text NOT NULL CHECK (core.is_ulid(connection_id)),
  connection_generation bigint NOT NULL CHECK (connection_generation > 0),
  reconciliation_sweep_id text NOT NULL CHECK (core.is_ulid(reconciliation_sweep_id)),
  stream text NOT NULL CHECK (stream ~ '^[a-z][a-z0-9_]*$'),
  scan_ordinal smallint NOT NULL CHECK (scan_ordinal IN (1,2)),
  batch_id text NOT NULL CHECK (core.is_ulid(batch_id)),
  identity_evidence jsonb NOT NULL CHECK (jsonb_typeof(identity_evidence)='array'),
  observed_count bigint NOT NULL CHECK (observed_count >= 0),
  inserted_identity_count bigint NOT NULL CHECK (inserted_identity_count >= 0),
  duplicate_count bigint NOT NULL CHECK (duplicate_count >= 0),
  invalid_count bigint NOT NULL CHECK (invalid_count >= 0),
  quarantine_count bigint NOT NULL CHECK (quarantine_count >= 0),
  has_more boolean NOT NULL,
  page_source_total bigint CHECK (page_source_total IS NULL OR page_source_total >= 0),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,batch_id),
  FOREIGN KEY (tenant_id,batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id,batch_id) ON DELETE CASCADE,
  FOREIGN KEY (
    tenant_id,connection_id,connection_generation,reconciliation_sweep_id,stream,scan_ordinal
  ) REFERENCES quality.reconciliation_snapshot(
    tenant_id,connection_id,connection_generation,reconciliation_sweep_id,stream,scan_ordinal
  ) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quality.reconciliation_identity_evidence (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  connection_id text NOT NULL CHECK (core.is_ulid(connection_id)),
  connection_generation bigint NOT NULL CHECK (connection_generation > 0),
  reconciliation_sweep_id text NOT NULL CHECK (core.is_ulid(reconciliation_sweep_id)),
  stream text NOT NULL CHECK (stream ~ '^[a-z][a-z0-9_]*$'),
  scan_ordinal smallint NOT NULL CHECK (scan_ordinal IN (1,2)),
  source_object_type text NOT NULL CHECK (length(btrim(source_object_type)) BETWEEN 1 AND 200),
  source_record_id text NOT NULL CHECK (length(btrim(source_record_id)) BETWEEN 1 AND 300),
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  batch_id text NOT NULL CHECK (core.is_ulid(batch_id)),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (
    tenant_id,connection_id,connection_generation,reconciliation_sweep_id,stream,
    scan_ordinal,source_object_type,source_record_id
  ),
  FOREIGN KEY (tenant_id,batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id,batch_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quality.reconciliation_tombstone_application (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  connection_id text NOT NULL CHECK (core.is_ulid(connection_id)),
  connection_generation bigint NOT NULL CHECK (connection_generation > 0),
  reconciliation_sweep_id text NOT NULL CHECK (core.is_ulid(reconciliation_sweep_id)),
  stream text NOT NULL CHECK (stream ~ '^[a-z][a-z0-9_]*$'),
  namespaced_source_key text NOT NULL,
  source_object_type text NOT NULL,
  source_record_id text NOT NULL,
  tombstone_batch_id text NOT NULL CHECK (core.is_ulid(tombstone_batch_id)),
  first_snapshot_batch_id text NOT NULL CHECK (core.is_ulid(first_snapshot_batch_id)),
  verification_snapshot_batch_id text NOT NULL CHECK (core.is_ulid(verification_snapshot_batch_id)),
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (
    tenant_id,connection_id,connection_generation,reconciliation_sweep_id,stream,namespaced_source_key
  ),
  FOREIGN KEY (tenant_id,tombstone_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id,batch_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS reconciliation_identity_membership_idx
  ON quality.reconciliation_identity_evidence (
    tenant_id,connection_id,connection_generation,reconciliation_sweep_id,stream,
    source_object_type,source_record_id,scan_ordinal
  );
CREATE INDEX IF NOT EXISTS connector_stream_state_rollup_idx
  ON quality.connector_stream_state (
    tenant_id,connection_id,connection_generation,required,updated_at
  );

ALTER TABLE quality.connector_stream_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.connector_stream_state FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.reconciliation_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.reconciliation_snapshot FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.connector_stream_page_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.connector_stream_page_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.reconciliation_snapshot_page ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.reconciliation_snapshot_page FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.reconciliation_identity_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.reconciliation_identity_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.reconciliation_tombstone_application ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.reconciliation_tombstone_application FORCE ROW LEVEL SECURITY;

DO $$
DECLARE relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'connector_stream_state','connector_stream_page_evidence','reconciliation_snapshot','reconciliation_snapshot_page',
    'reconciliation_identity_evidence','reconciliation_tombstone_application'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON quality.%I',relation_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON quality.%I USING (tenant_id=core.current_tenant_id()) WITH CHECK (tenant_id=core.current_tenant_id())',
      relation_name
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION quality.register_connector_streams(
  p_tenant_id text,p_connection_id text,p_connection_generation bigint,
  p_connector_id text,p_streams jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,core,quality
AS $$
DECLARE published integer;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id()
     OR NOT core.is_ulid(p_connection_id) OR p_connection_generation<1
     OR p_connector_id NOT IN ('lightspeed-r','xero','deputy')
     OR p_streams IS NULL OR jsonb_typeof(p_streams)<>'array'
     OR jsonb_array_length(p_streams) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'connector stream registration is invalid' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_streams) item(value)
     WHERE jsonb_typeof(item.value)<>'object'
        OR coalesce(item.value->>'stream','') !~ '^[a-z][a-z0-9_]*$'
        OR jsonb_typeof(item.value->'required')<>'boolean'
        OR item.value->>'lateEditStrategy' NOT IN ('modified_field','full_snapshot','append_only')
        OR item.value->>'deletionStrategy' NOT IN (
          'soft_delete','verified_delete_feed','authoritative_identity_scan','immutable_append_only'
        )
        OR item.value->>'sourceTotalStrategy' NOT IN (
          'provider_reported','count_distinct_complete_scan'
        )
        OR (
          item.value->>'deletionStrategy'='immutable_append_only'
          AND item.value->>'lateEditStrategy'<>'append_only'
        )
  ) OR (
    SELECT count(*)<>count(DISTINCT item.value->>'stream')
      FROM jsonb_array_elements(p_streams) item(value)
  ) THEN
    RAISE EXCEPTION 'connector stream policy is missing, invalid, or duplicated' USING ERRCODE='22023';
  END IF;

  INSERT INTO quality.connector_stream_state (
    tenant_id,connection_id,connection_generation,connector_id,stream,required,
    late_edit_strategy,deletion_strategy,source_total_strategy
  )
  SELECT p_tenant_id,p_connection_id,p_connection_generation,p_connector_id,
         item.value->>'stream',(item.value->>'required')::boolean,
         item.value->>'lateEditStrategy',item.value->>'deletionStrategy',
         item.value->>'sourceTotalStrategy'
    FROM jsonb_array_elements(p_streams) item(value)
  ON CONFLICT (tenant_id,connection_id,connection_generation,stream) DO UPDATE SET
    connector_id=excluded.connector_id,
    required=excluded.required,
    late_edit_strategy=excluded.late_edit_strategy,
    deletion_strategy=excluded.deletion_strategy,
    source_total_strategy=excluded.source_total_strategy,
    updated_at=now()
  WHERE quality.connector_stream_state.connector_id=excluded.connector_id
    AND quality.connector_stream_state.late_edit_strategy=excluded.late_edit_strategy
    AND quality.connector_stream_state.deletion_strategy=excluded.deletion_strategy
    AND quality.connector_stream_state.source_total_strategy=excluded.source_total_strategy;
  GET DIAGNOSTICS published=ROW_COUNT;
  IF published<>jsonb_array_length(p_streams) THEN
    RAISE EXCEPTION 'connector stream registration conflicts with durable policy' USING ERRCODE='55000';
  END IF;
  RETURN published;
END;
$$;

CREATE OR REPLACE FUNCTION quality.record_connector_stream_page(
  p_tenant_id text,p_connection_id text,p_connection_generation bigint,
  p_stream text,p_batch_id text,p_evidence jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,core,quality,ingestion
AS $$
DECLARE coverage jsonb:=nullif(p_evidence->'coverage','null'::jsonb);
DECLARE open_schema_drift bigint:=0;open_enum_drift bigint:=0;open_quarantine bigint:=0;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id()
     OR NOT core.is_ulid(p_batch_id)
     OR p_evidence IS NULL OR jsonb_typeof(p_evidence)<>'object'
     OR octet_length(p_evidence::text)>32768
     OR coalesce((p_evidence->>'recordCount')::bigint,-1)<0
     OR coalesce((p_evidence->>'quarantineCount')::bigint,-1)<0
     OR coalesce((p_evidence->>'schemaDriftCount')::bigint,-1)<0
     OR coalesce((p_evidence->>'enumDriftCount')::bigint,-1)<0
     OR jsonb_typeof(p_evidence->'cursorLinkValid')<>'boolean'
     OR jsonb_typeof(p_evidence->'cursorComplete')<>'boolean'
     OR jsonb_typeof(p_evidence->'backfillComplete')<>'boolean'
     OR (coverage IS NOT NULL AND jsonb_typeof(coverage)<>'object') THEN
    RAISE EXCEPTION 'connector stream page evidence is invalid' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM quality.connector_stream_page_evidence page
     WHERE page.tenant_id=p_tenant_id AND page.batch_id=p_batch_id
       AND page.connection_id=p_connection_id
       AND page.connection_generation=p_connection_generation
       AND page.stream=p_stream AND page.evidence=p_evidence
  ) THEN
    RETURN;
  ELSIF EXISTS (
    SELECT 1 FROM quality.connector_stream_page_evidence page
     WHERE page.tenant_id=p_tenant_id AND page.batch_id=p_batch_id
  ) THEN
    RAISE EXCEPTION 'connector stream page replay conflicts with durable evidence' USING ERRCODE='55000';
  END IF;
  INSERT INTO quality.connector_stream_page_evidence (
    tenant_id,batch_id,connection_id,connection_generation,stream,evidence
  ) VALUES (
    p_tenant_id,p_batch_id,p_connection_id,p_connection_generation,p_stream,p_evidence
  );

  -- Quarantine rows do not carry a connection generation directly. Batch
  -- evidence does, so obsolete generations cannot poison current health.
  SELECT
    count(*) FILTER (WHERE quarantine.error_code='schema_drift'),
    count(*) FILTER (
      WHERE quarantine.error_code IN ('schema_invalid','normalization_invalid')
    ),
    count(*)
    INTO open_schema_drift,open_enum_drift,open_quarantine
    FROM ingestion.quarantine_records quarantine
    JOIN quality.connector_stream_page_evidence page
      ON page.tenant_id=quarantine.tenant_id
     AND page.batch_id=quarantine.payload_batch_id
     AND page.connection_id=quarantine.connection_id AND page.stream=quarantine.stream
   WHERE quarantine.tenant_id=p_tenant_id
     AND quarantine.connection_id=p_connection_id
     AND quarantine.stream=p_stream AND quarantine.status='open'
     AND page.connection_generation=p_connection_generation;

  UPDATE quality.connector_stream_state state
     SET observed_page_count=state.observed_page_count+1,
         cursor_chain_valid=state.cursor_chain_valid
           AND (p_evidence->>'cursorLinkValid')::boolean,
         cursor_complete=state.cursor_complete OR (p_evidence->>'cursorComplete')::boolean,
         backfill_complete=state.backfill_complete OR (p_evidence->>'backfillComplete')::boolean,
         retention_evidence=CASE WHEN coverage IS NOT NULL THEN coverage ELSE state.retention_evidence END,
         -- Current open quarantine state, not a lifetime counter. Resolving and
         -- replaying a quarantined record can restore health on the next page.
         unresolved_schema_drift_count=open_schema_drift,
         unresolved_enum_drift_count=open_enum_drift,
         unresolved_quarantine_count=open_quarantine,
         deletion_evidence_count=state.deletion_evidence_count+
           coalesce((p_evidence->>'tombstoneCount')::bigint,0),
         source_total=coalesce((p_evidence->>'sourceTotal')::bigint,state.source_total),
         last_page_at=now(),updated_at=now()
   WHERE state.tenant_id=p_tenant_id AND state.connection_id=p_connection_id
     AND state.connection_generation=p_connection_generation AND state.stream=p_stream;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'connector stream was not registered for this generation' USING ERRCODE='55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION quality.record_reconciliation_snapshot_page(
  p_tenant_id text,p_connection_id text,p_connection_generation bigint,
  p_reconciliation_sweep_id text,p_connector_id text,p_stream text,
  p_scan_ordinal integer,p_deletion_strategy text,p_source_total_strategy text,
  p_batch_id text,p_identities jsonb,p_invalid_count bigint,p_quarantine_count bigint,
  p_has_more boolean,p_page_source_total bigint DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,core,quality,ingestion
AS $$
DECLARE observed bigint;inserted bigint:=0;within_duplicates bigint:=0;
DECLARE cross_page_duplicates bigint:=0;unique_total bigint:=0;effective_total bigint:=NULL;
DECLARE membership_delta bigint:=0;snapshot_status text;snapshot_started timestamptz;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id()
     OR NOT core.is_ulid(p_connection_id) OR p_connection_generation<1
     OR NOT core.is_ulid(p_reconciliation_sweep_id) OR NOT core.is_ulid(p_batch_id)
     OR p_connector_id NOT IN ('lightspeed-r','xero','deputy')
     OR p_stream !~ '^[a-z][a-z0-9_]*$' OR p_scan_ordinal NOT IN (1,2)
     OR p_deletion_strategy NOT IN (
       'soft_delete','verified_delete_feed','authoritative_identity_scan','immutable_append_only'
     )
     OR p_source_total_strategy NOT IN ('provider_reported','count_distinct_complete_scan')
     OR p_identities IS NULL OR jsonb_typeof(p_identities)<>'array'
     OR jsonb_array_length(p_identities)>5000
     OR p_invalid_count<0 OR p_quarantine_count<0
     OR (p_page_source_total IS NOT NULL AND p_page_source_total<0) THEN
    RAISE EXCEPTION 'reconciliation snapshot page is invalid' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_identities) identity(value)
     WHERE jsonb_typeof(identity.value)<>'object'
        OR length(btrim(coalesce(identity.value->>'sourceObjectType',''))) NOT BETWEEN 1 AND 200
        OR length(btrim(coalesce(identity.value->>'sourceRecordId',''))) NOT BETWEEN 1 AND 300
        OR (identity.value->>'sourceRecordId') ~ '[[:cntrl:]]'
        OR coalesce(identity.value->>'payloadHash','') !~ '^[0-9a-f]{64}$'
        OR (
          identity.value ? 'sourceUpdatedAt' AND identity.value->>'sourceUpdatedAt' IS NOT NULL
          AND (identity.value->>'sourceUpdatedAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
        )
  ) THEN
    RAISE EXCEPTION 'reconciliation identity evidence is malformed' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM quality.connector_stream_state state
     WHERE state.tenant_id=p_tenant_id
       AND state.connection_id=p_connection_id
       AND state.connection_generation=p_connection_generation
       AND state.connector_id=p_connector_id AND state.stream=p_stream
       AND state.deletion_strategy=p_deletion_strategy
       AND state.source_total_strategy=p_source_total_strategy
  ) THEN
    RAISE EXCEPTION 'reconciliation snapshot stream policy is not registered'
      USING ERRCODE='55000';
  END IF;

  observed:=jsonb_array_length(p_identities);
  IF EXISTS (
    SELECT 1 FROM quality.reconciliation_snapshot_page
     WHERE tenant_id=p_tenant_id AND batch_id=p_batch_id
  ) THEN
    SELECT snapshot.status,snapshot.unique_count INTO snapshot_status,unique_total
      FROM quality.reconciliation_snapshot_page page
      JOIN quality.reconciliation_snapshot snapshot
        ON snapshot.tenant_id=page.tenant_id
       AND snapshot.connection_id=page.connection_id
       AND snapshot.connection_generation=page.connection_generation
       AND snapshot.reconciliation_sweep_id=page.reconciliation_sweep_id
       AND snapshot.stream=page.stream AND snapshot.scan_ordinal=page.scan_ordinal
     WHERE page.tenant_id=p_tenant_id AND page.batch_id=p_batch_id
       AND page.connection_id=p_connection_id
       AND page.connection_generation=p_connection_generation
       AND page.reconciliation_sweep_id=p_reconciliation_sweep_id
       AND page.stream=p_stream AND page.scan_ordinal=p_scan_ordinal
       AND page.identity_evidence=p_identities
       AND page.observed_count=observed
       AND page.invalid_count=p_invalid_count
       AND page.quarantine_count=p_quarantine_count
       AND page.has_more=p_has_more
       AND page.page_source_total IS NOT DISTINCT FROM p_page_source_total
       AND snapshot.connector_id=p_connector_id
       AND snapshot.deletion_strategy=p_deletion_strategy
       AND snapshot.source_total_strategy=p_source_total_strategy;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reconciliation snapshot page replay conflicts with durable evidence'
        USING ERRCODE='55000';
    END IF;
    RETURN jsonb_build_object(
      'status',snapshot_status,'uniqueCount',unique_total,'idempotentReplay',true
    );
  END IF;

  IF p_scan_ordinal=2 AND NOT EXISTS (
    SELECT 1 FROM quality.reconciliation_snapshot prior
     WHERE prior.tenant_id=p_tenant_id AND prior.connection_id=p_connection_id
       AND prior.connection_generation=p_connection_generation
       AND prior.reconciliation_sweep_id=p_reconciliation_sweep_id
       AND prior.stream=p_stream AND prior.scan_ordinal=1 AND prior.status='complete'
  ) THEN
    RAISE EXCEPTION 'verification snapshot requires a completed first snapshot' USING ERRCODE='55000';
  END IF;

  INSERT INTO quality.reconciliation_snapshot (
    tenant_id,connection_id,connection_generation,reconciliation_sweep_id,
    connector_id,stream,scan_ordinal,deletion_strategy,source_total_strategy
  ) VALUES (
    p_tenant_id,p_connection_id,p_connection_generation,p_reconciliation_sweep_id,
    p_connector_id,p_stream,p_scan_ordinal,p_deletion_strategy,p_source_total_strategy
  ) ON CONFLICT DO NOTHING;

  SELECT observed-count(*) INTO within_duplicates FROM (
    SELECT identity.value->>'sourceObjectType',identity.value->>'sourceRecordId'
      FROM jsonb_array_elements(p_identities) identity(value)
     GROUP BY identity.value->>'sourceObjectType',identity.value->>'sourceRecordId'
  ) distinct_identity;

  WITH distinct_input AS (
    SELECT DISTINCT ON (identity.value->>'sourceObjectType',identity.value->>'sourceRecordId')
           identity.value
      FROM jsonb_array_elements(p_identities) identity(value)
     ORDER BY identity.value->>'sourceObjectType',identity.value->>'sourceRecordId'
  ), inserted_rows AS (
    INSERT INTO quality.reconciliation_identity_evidence (
      tenant_id,connection_id,connection_generation,reconciliation_sweep_id,stream,
      scan_ordinal,source_object_type,source_record_id,source_updated_at,payload_hash,batch_id
    )
    SELECT p_tenant_id,p_connection_id,p_connection_generation,p_reconciliation_sweep_id,p_stream,
           p_scan_ordinal,value->>'sourceObjectType',value->>'sourceRecordId',
           nullif(value->>'sourceUpdatedAt','')::timestamptz,value->>'payloadHash',p_batch_id
      FROM distinct_input
    ON CONFLICT DO NOTHING
    RETURNING 1
  ) SELECT count(*) INTO inserted FROM inserted_rows;
  cross_page_duplicates:=observed-within_duplicates-inserted;

  INSERT INTO quality.reconciliation_snapshot_page (
    tenant_id,connection_id,connection_generation,reconciliation_sweep_id,stream,
    scan_ordinal,batch_id,identity_evidence,observed_count,inserted_identity_count,duplicate_count,
    invalid_count,quarantine_count,has_more,page_source_total
  ) VALUES (
    p_tenant_id,p_connection_id,p_connection_generation,p_reconciliation_sweep_id,p_stream,
    p_scan_ordinal,p_batch_id,p_identities,observed,inserted,within_duplicates+cross_page_duplicates,
    p_invalid_count,p_quarantine_count,p_has_more,p_page_source_total
  );

  UPDATE quality.reconciliation_snapshot snapshot
     SET page_count=snapshot.page_count+1,observed_count=snapshot.observed_count+observed,
         unique_count=snapshot.unique_count+inserted,
         duplicate_count=snapshot.duplicate_count+within_duplicates+cross_page_duplicates,
         invalid_count=snapshot.invalid_count+p_invalid_count,
         quarantine_count=snapshot.quarantine_count+p_quarantine_count,
         source_total=coalesce(p_page_source_total,snapshot.source_total),last_batch_id=p_batch_id
   WHERE snapshot.tenant_id=p_tenant_id AND snapshot.connection_id=p_connection_id
     AND snapshot.connection_generation=p_connection_generation
     AND snapshot.reconciliation_sweep_id=p_reconciliation_sweep_id
     AND snapshot.stream=p_stream AND snapshot.scan_ordinal=p_scan_ordinal
   RETURNING unique_count,started_at INTO unique_total,snapshot_started;

  IF NOT p_has_more THEN
    effective_total:=CASE p_source_total_strategy
      WHEN 'provider_reported' THEN p_page_source_total
      ELSE unique_total
    END;
    IF p_scan_ordinal=2 THEN
      SELECT count(*) INTO membership_delta FROM (
        (SELECT source_object_type,source_record_id
           FROM quality.reconciliation_identity_evidence
          WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id
            AND connection_generation=p_connection_generation
            AND reconciliation_sweep_id=p_reconciliation_sweep_id
            AND stream=p_stream AND scan_ordinal=1
         EXCEPT
         SELECT source_object_type,source_record_id
           FROM quality.reconciliation_identity_evidence
          WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id
            AND connection_generation=p_connection_generation
            AND reconciliation_sweep_id=p_reconciliation_sweep_id
            AND stream=p_stream AND scan_ordinal=2)
        UNION ALL
        (SELECT source_object_type,source_record_id
           FROM quality.reconciliation_identity_evidence
          WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id
            AND connection_generation=p_connection_generation
            AND reconciliation_sweep_id=p_reconciliation_sweep_id
            AND stream=p_stream AND scan_ordinal=2
         EXCEPT
         SELECT source_object_type,source_record_id
           FROM quality.reconciliation_identity_evidence
          WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id
            AND connection_generation=p_connection_generation
            AND reconciliation_sweep_id=p_reconciliation_sweep_id
            AND stream=p_stream AND scan_ordinal=1)
      ) delta;
    END IF;
    UPDATE quality.reconciliation_snapshot snapshot
       SET source_total=effective_total,membership_delta_count=membership_delta,
           status=CASE
             WHEN snapshot.duplicate_count>0 OR snapshot.invalid_count>0
               OR snapshot.quarantine_count>0 OR effective_total IS NULL
               OR effective_total<>snapshot.unique_count OR membership_delta>0
             THEN 'failed' ELSE 'complete' END,
           completed_at=now()
     WHERE snapshot.tenant_id=p_tenant_id AND snapshot.connection_id=p_connection_id
       AND snapshot.connection_generation=p_connection_generation
       AND snapshot.reconciliation_sweep_id=p_reconciliation_sweep_id
       AND snapshot.stream=p_stream AND snapshot.scan_ordinal=p_scan_ordinal
     RETURNING status INTO snapshot_status;
  ELSE snapshot_status:='running';
  END IF;
  RETURN jsonb_build_object(
    'status',snapshot_status,'uniqueCount',unique_total,
    'duplicateCount',within_duplicates+cross_page_duplicates,
    'membershipDeltaCount',membership_delta,'sourceTotal',effective_total,
    'startedAt',snapshot_started
  );
END;
$$;

CREATE OR REPLACE FUNCTION quality.reconciliation_tombstone_candidates(
  p_tenant_id text,p_connection_id text,p_connection_generation bigint,
  p_reconciliation_sweep_id text,p_stream text,p_after_key text,p_limit integer
) RETURNS TABLE (
  namespaced_source_key text,source_object_type text,source_record_id text,
  normalized_payload jsonb,expected_payload_hash text,
  expected_source_updated_at timestamptz,expected_ingested_at timestamptz,
  first_snapshot_batch_id text,verification_snapshot_batch_id text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,core,quality,ingestion
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'reconciliation tombstone request is invalid' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  SELECT source.namespaced_source_key,source.source_object_type,source.source_record_id,
         source.normalized_payload,source.payload_hash,source.source_updated_at,
         source.ingested_at,first_scan.last_batch_id,verification.last_batch_id
    FROM ingestion.source_records source
    JOIN quality.reconciliation_snapshot first_scan
      ON first_scan.tenant_id=source.tenant_id
     AND first_scan.connection_id=source.connection_id
     AND first_scan.connection_generation=p_connection_generation
     AND first_scan.reconciliation_sweep_id=p_reconciliation_sweep_id
     AND first_scan.stream=source.stream AND first_scan.scan_ordinal=1
     AND first_scan.status='complete'
    JOIN quality.reconciliation_snapshot verification
      ON verification.tenant_id=first_scan.tenant_id
     AND verification.connection_id=first_scan.connection_id
     AND verification.connection_generation=first_scan.connection_generation
     AND verification.reconciliation_sweep_id=first_scan.reconciliation_sweep_id
     AND verification.stream=first_scan.stream AND verification.scan_ordinal=2
     AND verification.status='complete' AND verification.membership_delta_count=0
     AND first_scan.completed_at<=verification.started_at
   WHERE source.tenant_id=p_tenant_id AND source.connection_id=p_connection_id
     AND source.stream=p_stream AND NOT source.tombstone
     AND first_scan.deletion_strategy='authoritative_identity_scan'
     AND source.ingested_at<=first_scan.started_at
     AND (
       source.source_updated_at IS NULL
       OR source.source_updated_at<=verification.completed_at
     )
     AND source.namespaced_source_key>coalesce(p_after_key,'')
     AND NOT EXISTS (
       SELECT 1 FROM quality.reconciliation_identity_evidence identity
        WHERE identity.tenant_id=source.tenant_id
          AND identity.connection_id=source.connection_id
          AND identity.connection_generation=p_connection_generation
          AND identity.reconciliation_sweep_id=p_reconciliation_sweep_id
          AND identity.stream=source.stream
          AND identity.source_object_type=source.source_object_type
          AND identity.source_record_id=source.source_record_id
          AND identity.scan_ordinal IN (1,2)
     )
     AND NOT EXISTS (
       SELECT 1 FROM quality.reconciliation_tombstone_application applied
        WHERE applied.tenant_id=source.tenant_id
          AND applied.connection_id=source.connection_id
          AND applied.connection_generation=p_connection_generation
          AND applied.reconciliation_sweep_id=p_reconciliation_sweep_id
          AND applied.stream=source.stream
          AND applied.namespaced_source_key=source.namespaced_source_key
     )
   ORDER BY source.namespaced_source_key
   LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION quality.record_reconciliation_tombstone_applications(
  p_tenant_id text,p_connection_id text,p_connection_generation bigint,
  p_reconciliation_sweep_id text,p_stream text,p_tombstone_batch_id text,p_applications jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,core,quality,ingestion
AS $$
DECLARE published integer;requested integer;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id()
     OR NOT core.is_ulid(p_tombstone_batch_id)
     OR p_applications IS NULL OR jsonb_typeof(p_applications)<>'array'
     OR jsonb_array_length(p_applications)>500 THEN
    RAISE EXCEPTION 'reconciliation tombstone applications are invalid' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_applications) item(value)
     WHERE jsonb_typeof(item.value)<>'object'
        OR length(btrim(coalesce(item.value->>'namespacedSourceKey',''))) NOT BETWEEN 1 AND 700
        OR length(btrim(coalesce(item.value->>'sourceObjectType',''))) NOT BETWEEN 1 AND 200
        OR length(btrim(coalesce(item.value->>'sourceRecordId',''))) NOT BETWEEN 1 AND 300
        OR NOT core.is_ulid(coalesce(item.value->>'firstSnapshotBatchId',''))
        OR NOT core.is_ulid(coalesce(item.value->>'verificationSnapshotBatchId',''))
  ) OR (
    SELECT count(*)<>count(DISTINCT item.value->>'namespacedSourceKey')
      FROM jsonb_array_elements(p_applications) item(value)
  ) THEN
    RAISE EXCEPTION 'reconciliation tombstone application evidence is malformed'
      USING ERRCODE='22023';
  END IF;
  requested:=jsonb_array_length(p_applications);

  -- Mark an application durable only after the ordinary landing path has made
  -- this exact batch the current tombstoned source version.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_applications) item(value)
     WHERE NOT EXISTS (
       SELECT 1
         FROM ingestion.source_records source
         JOIN quality.reconciliation_snapshot first_scan
           ON first_scan.tenant_id=source.tenant_id
          AND first_scan.connection_id=source.connection_id
          AND first_scan.connection_generation=p_connection_generation
          AND first_scan.reconciliation_sweep_id=p_reconciliation_sweep_id
          AND first_scan.stream=source.stream AND first_scan.scan_ordinal=1
          AND first_scan.status='complete'
          AND first_scan.deletion_strategy='authoritative_identity_scan'
          AND first_scan.last_batch_id=item.value->>'firstSnapshotBatchId'
         JOIN quality.reconciliation_snapshot verification
           ON verification.tenant_id=first_scan.tenant_id
          AND verification.connection_id=first_scan.connection_id
          AND verification.connection_generation=first_scan.connection_generation
          AND verification.reconciliation_sweep_id=first_scan.reconciliation_sweep_id
          AND verification.stream=first_scan.stream AND verification.scan_ordinal=2
          AND verification.status='complete' AND verification.membership_delta_count=0
          AND verification.last_batch_id=item.value->>'verificationSnapshotBatchId'
          AND first_scan.completed_at<=verification.started_at
        WHERE source.tenant_id=p_tenant_id
          AND source.connection_id=p_connection_id
          AND source.stream=p_stream
          AND source.namespaced_source_key=item.value->>'namespacedSourceKey'
          AND source.source_object_type=item.value->>'sourceObjectType'
          AND source.source_record_id=item.value->>'sourceRecordId'
          AND source.payload_batch_id=p_tombstone_batch_id
          AND source.tombstone
          AND source.first_ingested_at<=first_scan.started_at
          AND NOT EXISTS (
            SELECT 1 FROM quality.reconciliation_identity_evidence identity
             WHERE identity.tenant_id=source.tenant_id
               AND identity.connection_id=source.connection_id
               AND identity.connection_generation=p_connection_generation
               AND identity.reconciliation_sweep_id=p_reconciliation_sweep_id
               AND identity.stream=source.stream
               AND identity.source_object_type=source.source_object_type
               AND identity.source_record_id=source.source_record_id
               AND identity.scan_ordinal IN (1,2)
          )
     )
  ) THEN
    RAISE EXCEPTION 'reconciliation tombstone was not landed by the exact batch'
      USING ERRCODE='55000';
  END IF;
  INSERT INTO quality.reconciliation_tombstone_application (
    tenant_id,connection_id,connection_generation,reconciliation_sweep_id,stream,
    namespaced_source_key,source_object_type,source_record_id,tombstone_batch_id,
    first_snapshot_batch_id,verification_snapshot_batch_id
  )
  SELECT p_tenant_id,p_connection_id,p_connection_generation,p_reconciliation_sweep_id,p_stream,
         item.value->>'namespacedSourceKey',item.value->>'sourceObjectType',
         item.value->>'sourceRecordId',p_tombstone_batch_id,
         item.value->>'firstSnapshotBatchId',item.value->>'verificationSnapshotBatchId'
    FROM jsonb_array_elements(p_applications) item(value)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS published=ROW_COUNT;
  IF (
    SELECT count(*) FROM jsonb_array_elements(p_applications) item(value)
     JOIN quality.reconciliation_tombstone_application applied
       ON applied.tenant_id=p_tenant_id
      AND applied.connection_id=p_connection_id
      AND applied.connection_generation=p_connection_generation
      AND applied.reconciliation_sweep_id=p_reconciliation_sweep_id
      AND applied.stream=p_stream
      AND applied.namespaced_source_key=item.value->>'namespacedSourceKey'
      AND applied.source_object_type=item.value->>'sourceObjectType'
      AND applied.source_record_id=item.value->>'sourceRecordId'
      AND applied.tombstone_batch_id=p_tombstone_batch_id
      AND applied.first_snapshot_batch_id=item.value->>'firstSnapshotBatchId'
      AND applied.verification_snapshot_batch_id=item.value->>'verificationSnapshotBatchId'
  )<>requested THEN
    RAISE EXCEPTION 'reconciliation tombstone replay conflicts with durable evidence'
      USING ERRCODE='55000';
  END IF;
  RETURN published;
END;
$$;

CREATE OR REPLACE FUNCTION quality.complete_connector_reconciliation(
  p_tenant_id text,p_connection_id text,p_connection_generation bigint,
  p_reconciliation_sweep_id text,p_stream text
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,core,quality,ingestion
AS $$
DECLARE source_count bigint;tombstone_count bigint;verified_source_total bigint;
DECLARE verified_deletion_strategy text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'connector reconciliation completion is invalid' USING ERRCODE='22023';
  END IF;
  SELECT count(*) INTO tombstone_count
    FROM quality.reconciliation_tombstone_application
   WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id
     AND connection_generation=p_connection_generation
     AND reconciliation_sweep_id=p_reconciliation_sweep_id AND stream=p_stream;
  SELECT source_total,deletion_strategy
    INTO verified_source_total,verified_deletion_strategy
    FROM quality.reconciliation_snapshot verified
   WHERE verified.tenant_id=p_tenant_id AND verified.connection_id=p_connection_id
     AND verified.connection_generation=p_connection_generation
     AND verified.reconciliation_sweep_id=p_reconciliation_sweep_id
     AND verified.stream=p_stream AND verified.scan_ordinal=2
     AND verified.status='complete' AND verified.membership_delta_count=0;
  IF verified_source_total IS NULL THEN
    RAISE EXCEPTION 'reconciliation evidence is incomplete or unstable' USING ERRCODE='55000';
  END IF;
  SELECT count(*) INTO source_count FROM ingestion.source_records source
   WHERE source.tenant_id=p_tenant_id AND source.connection_id=p_connection_id
     AND source.stream=p_stream
     AND (verified_deletion_strategy='soft_delete' OR NOT source.tombstone);
  IF source_count<>verified_source_total THEN
    RAISE EXCEPTION 'reconciliation source total does not match the landed population'
      USING ERRCODE='55000',DETAIL=jsonb_build_object(
        'verifiedSourceTotal',verified_source_total,'landedPopulation',source_count
      )::text;
  END IF;
  UPDATE quality.connector_stream_state state
     SET reconciliation_completed_at=now(),reconciliation_sweep_id=p_reconciliation_sweep_id,
         reconciliation_gap_count=0,
         deletion_evidence_count=greatest(state.deletion_evidence_count,tombstone_count),
         source_total=verified_source_total,local_live_total=source_count,updated_at=now()
   WHERE state.tenant_id=p_tenant_id AND state.connection_id=p_connection_id
     AND state.connection_generation=p_connection_generation AND state.stream=p_stream
     ;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconciliation evidence is incomplete or unstable' USING ERRCODE='55000';
  END IF;
  RETURN tombstone_count;
END;
$$;

CREATE OR REPLACE FUNCTION quality.refresh_connector_quality_rollup(
  p_tenant_id text,p_run_id text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,core,quality
AS $$
DECLARE check_name text;check_status text;check_details jsonb;observed numeric;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() OR NOT core.is_ulid(p_run_id) THEN
    RAISE EXCEPTION 'connector quality rollup input is invalid' USING ERRCODE='22023';
  END IF;
  FOR check_name IN SELECT unnest(ARRAY[
    'cursor_completeness','scope_available','retention_limit_recorded',
    'webhook_gap_recovered','delete_handling','schema_drift','enum_drift'
  ]) LOOP
    WITH current_generation AS (
      SELECT connection_id,max(connection_generation) AS connection_generation
        FROM quality.connector_stream_state WHERE tenant_id=p_tenant_id GROUP BY connection_id
    ), required_state AS (
      SELECT state.* FROM quality.connector_stream_state state
      JOIN current_generation current USING (connection_id,connection_generation)
      WHERE state.tenant_id=p_tenant_id AND state.required
    ), measured AS (
      SELECT count(*) AS expected,
        count(*) FILTER (WHERE observed_page_count=0) AS missing,
        count(*) FILTER (WHERE NOT cursor_complete OR NOT cursor_chain_valid) AS cursor_gap,
        count(*) FILTER (WHERE NOT backfill_complete OR retention_evidence IS NULL) AS retention_gap,
        count(*) FILTER (
          WHERE reconciliation_completed_at IS NULL
             OR reconciliation_completed_at<now()-interval '26 hours'
        ) AS reconciliation_gap,
        count(*) FILTER (
          WHERE source_total IS NULL OR local_live_total IS NULL
             OR source_total<>local_live_total
        ) AS source_total_gap,
        sum(unresolved_schema_drift_count) AS schema_drift,
        sum(unresolved_enum_drift_count+unresolved_quarantine_count) AS enum_drift
      FROM required_state
    ) SELECT
      CASE check_name
        WHEN 'cursor_completeness' THEN CASE WHEN expected>0 AND missing=0 AND cursor_gap=0 THEN 'passed' ELSE 'blocked' END
        WHEN 'scope_available' THEN CASE WHEN expected>0 AND missing=0 THEN 'passed' ELSE 'blocked' END
        WHEN 'retention_limit_recorded' THEN CASE WHEN expected>0 AND retention_gap=0 THEN 'passed' ELSE 'blocked' END
        WHEN 'webhook_gap_recovered' THEN CASE WHEN expected>0 AND reconciliation_gap=0 THEN 'passed' ELSE 'blocked' END
        WHEN 'delete_handling' THEN CASE
          WHEN expected>0 AND reconciliation_gap=0 AND source_total_gap=0 THEN 'passed' ELSE 'blocked' END
        WHEN 'schema_drift' THEN CASE WHEN expected>0 AND schema_drift=0 THEN 'passed' ELSE 'blocked' END
        ELSE CASE WHEN expected>0 AND enum_drift=0 THEN 'passed' ELSE 'blocked' END
      END,
      jsonb_build_object(
        'reason_code','durable_required_stream_rollup','expected_required_streams',expected,
        'unobserved_required_streams',missing,'cursor_gaps',cursor_gap,
        'retention_gaps',retention_gap,'reconciliation_gaps',reconciliation_gap,
        'source_total_gaps',source_total_gap,
        'unresolved_schema_drift',schema_drift,'unresolved_enum_or_quarantine',enum_drift
      ),
      CASE check_name
        WHEN 'schema_drift' THEN schema_drift
        WHEN 'enum_drift' THEN enum_drift
        WHEN 'retention_limit_recorded' THEN retention_gap
        WHEN 'webhook_gap_recovered' THEN reconciliation_gap
        WHEN 'delete_handling' THEN reconciliation_gap+source_total_gap
        WHEN 'cursor_completeness' THEN cursor_gap
        ELSE missing
      END
      INTO check_status,check_details,observed FROM measured;
    PERFORM quality.record_check(
      p_tenant_id,p_run_id,check_name,'connector',check_status,observed,0,check_details
    );
  END LOOP;
END;
$$;

-- Extend M8 connection deletion without copying its large canonical-closure
-- implementation. The wrapper removes reconciliation state transactionally,
-- then delegates to the previously reviewed purge and verification routines.
ALTER FUNCTION deletion_internal.purge_connection(text,text)
  RENAME TO purge_connection_pre_reconciliation;
ALTER FUNCTION deletion_internal.verify_connection(text,text)
  RENAME TO verify_connection_pre_reconciliation;

CREATE OR REPLACE FUNCTION deletion_internal.purge_connection(
  p_tenant_id text,p_connection_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,core,quality,deletion_internal
AS $$
DECLARE result jsonb;removed bigint:=0;affected bigint;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) OR NOT core.is_ulid(p_connection_id) THEN
    RAISE EXCEPTION 'deletion scope identifiers must be ULIDs' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('albert.tenant_id',p_tenant_id,true);
  PERFORM set_config('albert.deletion_authorized','on',true);
  DELETE FROM quality.reconciliation_tombstone_application
   WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  GET DIAGNOSTICS affected=ROW_COUNT;removed:=removed+affected;
  DELETE FROM quality.reconciliation_snapshot_page
   WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  GET DIAGNOSTICS affected=ROW_COUNT;removed:=removed+affected;
  DELETE FROM quality.reconciliation_identity_evidence
   WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  GET DIAGNOSTICS affected=ROW_COUNT;removed:=removed+affected;
  DELETE FROM quality.reconciliation_snapshot
   WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  GET DIAGNOSTICS affected=ROW_COUNT;removed:=removed+affected;
  DELETE FROM quality.connector_stream_page_evidence
   WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  GET DIAGNOSTICS affected=ROW_COUNT;removed:=removed+affected;
  DELETE FROM quality.connector_stream_state
   WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  GET DIAGNOSTICS affected=ROW_COUNT;removed:=removed+affected;
  result:=deletion_internal.purge_connection_pre_reconciliation(p_tenant_id,p_connection_id);
  RETURN result||jsonb_build_object(
    'reconciliationRowsRemoved',removed,
    'verified',coalesce((result->>'verified')::boolean,false)
  );
END;
$$;

CREATE OR REPLACE FUNCTION deletion_internal.verify_connection(
  p_tenant_id text,p_connection_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,core,quality,deletion_internal
AS $$
DECLARE result jsonb;remaining bigint;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) OR NOT core.is_ulid(p_connection_id) THEN
    RAISE EXCEPTION 'deletion scope identifiers must be ULIDs' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('albert.tenant_id',p_tenant_id,true);
  result:=deletion_internal.verify_connection_pre_reconciliation(p_tenant_id,p_connection_id);
  SELECT
    (SELECT count(*) FROM quality.connector_stream_state WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id)
    +(SELECT count(*) FROM quality.connector_stream_page_evidence WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id)
    +(SELECT count(*) FROM quality.reconciliation_snapshot WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id)
    +(SELECT count(*) FROM quality.reconciliation_snapshot_page WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id)
    +(SELECT count(*) FROM quality.reconciliation_identity_evidence WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id)
    +(SELECT count(*) FROM quality.reconciliation_tombstone_application WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id)
    INTO remaining;
  RETURN result||jsonb_build_object(
    'reconciliationRemainingRows',remaining,
    'remainingRows',coalesce((result->>'remainingRows')::bigint,0)+remaining,
    'verified',coalesce((result->>'verified')::boolean,false) AND remaining=0
  );
END;
$$;

REVOKE ALL ON FUNCTION deletion_internal.purge_connection_pre_reconciliation(text,text),
  deletion_internal.verify_connection_pre_reconciliation(text,text),
  deletion_internal.purge_connection(text,text),
  deletion_internal.verify_connection(text,text) FROM PUBLIC,deletion_rw;
GRANT EXECUTE ON FUNCTION deletion_internal.purge_connection(text,text),
  deletion_internal.verify_connection(text,text) TO deletion_rw;

REVOKE ALL ON quality.connector_stream_state,quality.connector_stream_page_evidence,quality.reconciliation_snapshot,
  quality.reconciliation_snapshot_page,quality.reconciliation_identity_evidence,
  quality.reconciliation_tombstone_application FROM PUBLIC;
GRANT SELECT ON quality.connector_stream_state,quality.connector_stream_page_evidence,quality.reconciliation_snapshot,
  quality.reconciliation_snapshot_page,quality.reconciliation_identity_evidence,
  quality.reconciliation_tombstone_application TO transform_rw,diagnostic_ro;
REVOKE ALL ON quality.connector_stream_state,quality.connector_stream_page_evidence,quality.reconciliation_snapshot,
  quality.reconciliation_snapshot_page,quality.reconciliation_identity_evidence,
  quality.reconciliation_tombstone_application FROM ingest_rw,semantic_ro,semantic_meta_rw;
REVOKE ALL ON FUNCTION quality.register_connector_streams(text,text,bigint,text,jsonb),
  quality.record_connector_stream_page(text,text,bigint,text,text,jsonb),
  quality.record_reconciliation_snapshot_page(text,text,bigint,text,text,text,integer,text,text,text,jsonb,bigint,bigint,boolean,bigint),
  quality.reconciliation_tombstone_candidates(text,text,bigint,text,text,text,integer),
  quality.record_reconciliation_tombstone_applications(text,text,bigint,text,text,text,jsonb),
  quality.complete_connector_reconciliation(text,text,bigint,text,text),
  quality.refresh_connector_quality_rollup(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quality.register_connector_streams(text,text,bigint,text,jsonb),
  quality.record_connector_stream_page(text,text,bigint,text,text,jsonb),
  quality.record_reconciliation_snapshot_page(text,text,bigint,text,text,text,integer,text,text,text,jsonb,bigint,bigint,boolean,bigint),
  quality.reconciliation_tombstone_candidates(text,text,bigint,text,text,text,integer),
  quality.record_reconciliation_tombstone_applications(text,text,bigint,text,text,text,jsonb),
  quality.complete_connector_reconciliation(text,text,bigint,text,text),
  quality.refresh_connector_quality_rollup(text,text) TO ingest_rw;

COMMIT;
