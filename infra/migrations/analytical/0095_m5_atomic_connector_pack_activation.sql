BEGIN;

-- Connector releases are staged before they become query-visible. Pack-version
-- is part of each snapshot key so a rolling fleet can publish the candidate
-- beside the active release without erasing the snapshot that is still serving
-- users. Only the migration owner can perform the final, atomic activation.

CREATE TABLE semantic_internal.connector_pack_release (
  connector_id text NOT NULL CHECK (connector_id IN ('lightspeed-r','xero','deputy')),
  pack_version text NOT NULL CHECK (
    length(pack_version)<=120 AND pack_version ~
    '^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)([.](0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?([+][0-9A-Za-z-]+([.][0-9A-Za-z-]+)*)?$'
  ),
  release_sequence bigint NOT NULL CHECK (release_sequence>0),
  predecessor_version text,
  state text NOT NULL CHECK (state IN ('candidate','active','retired')),
  registered_by_migration text NOT NULL CHECK (
    registered_by_migration ~ '^[0-9]{4}_[a-z0-9_]+[.]sql$'
  ),
  registered_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  retired_at timestamptz,
  PRIMARY KEY (connector_id,pack_version),
  UNIQUE (connector_id,release_sequence),
  UNIQUE (connector_id,release_sequence,pack_version),
  FOREIGN KEY (connector_id,predecessor_version)
    REFERENCES semantic_internal.connector_pack_release(connector_id,pack_version),
  CHECK (
    (release_sequence=1 AND predecessor_version IS NULL)
    OR (release_sequence>1 AND predecessor_version IS NOT NULL)
  ),
  CHECK (
    (state='candidate' AND activated_at IS NULL AND retired_at IS NULL)
    OR (state='active' AND activated_at IS NOT NULL AND retired_at IS NULL)
    OR (state='retired' AND activated_at IS NOT NULL AND retired_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX connector_pack_release_one_active_idx
  ON semantic_internal.connector_pack_release (connector_id)
  WHERE state='active';

CREATE TABLE semantic_internal.connector_pack_release_requirement (
  connector_id text NOT NULL,
  pack_version text NOT NULL,
  requirement_kind text NOT NULL CHECK (
    requirement_kind IN ('capability','source_table')
  ),
  requirement_value text NOT NULL CHECK (
    requirement_value ~ '^[a-z][a-z0-9_.]*$'
  ),
  PRIMARY KEY (connector_id,pack_version,requirement_kind,requirement_value),
  FOREIGN KEY (connector_id,pack_version)
    REFERENCES semantic_internal.connector_pack_release(connector_id,pack_version)
);

-- A non-sensitive global index lets the migration owner prove fleet-wide
-- candidate completeness without bypassing tenant RLS. Row triggers maintain
-- it transactionally, including disconnect/deletion cleanup.
CREATE TABLE semantic_internal.connector_pack_evidence_index (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  connection_id text NOT NULL CHECK (core.is_ulid(connection_id)),
  connector_id text NOT NULL,
  pack_version text NOT NULL,
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('capability','source_field')),
  evidence_key text NOT NULL CHECK (length(evidence_key) BETWEEN 3 AND 1000),
  capability text,
  source_table text,
  source_field text,
  included boolean NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (
    tenant_id,connection_id,connector_id,pack_version,evidence_kind,evidence_key
  ),
  FOREIGN KEY (connector_id,pack_version)
    REFERENCES semantic_internal.connector_pack_release(connector_id,pack_version),
  CHECK (
    (evidence_kind='capability' AND capability IS NOT NULL
      AND source_table IS NULL AND source_field IS NULL)
    OR
    (evidence_kind='source_field' AND capability IS NULL
      AND source_table IS NOT NULL AND source_field IS NOT NULL)
  )
);

CREATE TABLE semantic_internal.connector_pack_activation_event (
  connector_id text NOT NULL,
  release_sequence bigint NOT NULL,
  previous_pack_version text NOT NULL,
  activated_pack_version text NOT NULL,
  predecessor_capability_rows bigint NOT NULL CHECK (predecessor_capability_rows>=0),
  candidate_capability_rows bigint NOT NULL CHECK (candidate_capability_rows>=0),
  candidate_source_fields bigint NOT NULL CHECK (candidate_source_fields>=0),
  activation_evidence jsonb NOT NULL CHECK (
    jsonb_typeof(activation_evidence)='object'
    AND activation_evidence->'ready'='true'::jsonb
    AND activation_evidence->'activationRequired'='true'::jsonb
  ),
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  activated_by text NOT NULL,
  PRIMARY KEY (connector_id,release_sequence),
  FOREIGN KEY (connector_id,release_sequence,activated_pack_version)
    REFERENCES semantic_internal.connector_pack_release(
      connector_id,release_sequence,pack_version
    ),
  FOREIGN KEY (connector_id,previous_pack_version)
    REFERENCES semantic_internal.connector_pack_release(connector_id,pack_version),
  CHECK (previous_pack_version<>activated_pack_version)
);

CREATE TABLE semantic_internal.connector_pack_connection_retirement (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  connection_id text NOT NULL CHECK (core.is_ulid(connection_id)),
  connector_id text NOT NULL,
  predecessor_pack_version text NOT NULL,
  candidate_pack_version text NOT NULL,
  retirement_reason text NOT NULL CHECK (
    retirement_reason IN ('disconnected','tenant_deleting')
  ),
  control_plane_audit_id text NOT NULL CHECK (core.is_ulid(control_plane_audit_id)),
  control_plane_evidence_sha256 text NOT NULL CHECK (
    control_plane_evidence_sha256 ~ '^[0-9a-f]{64}$'
  ),
  retired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_by text NOT NULL,
  PRIMARY KEY (tenant_id,connection_id,connector_id,candidate_pack_version),
  FOREIGN KEY (connector_id,predecessor_pack_version)
    REFERENCES semantic_internal.connector_pack_release(connector_id,pack_version),
  FOREIGN KEY (connector_id,candidate_pack_version)
    REFERENCES semantic_internal.connector_pack_release(connector_id,pack_version),
  CHECK (predecessor_pack_version<>candidate_pack_version)
);

INSERT INTO semantic_internal.connector_pack_release (
  connector_id,pack_version,release_sequence,predecessor_version,state,
  registered_by_migration,activated_at
) VALUES
  ('lightspeed-r','1.0.0',1,NULL,'active',
   '0095_m5_atomic_connector_pack_activation.sql',now()),
  ('lightspeed-r','1.1.0',2,'1.0.0','candidate',
   '0095_m5_atomic_connector_pack_activation.sql',NULL),
  ('xero','1.0.0',1,NULL,'active',
   '0095_m5_atomic_connector_pack_activation.sql',now()),
  ('deputy','1.0.0',1,NULL,'active',
   '0095_m5_atomic_connector_pack_activation.sql',now());

-- 1.1 adds supplier and purchase-order topology. These expectations prevent an
-- operator from activating after replaying only the predecessor streams.
INSERT INTO semantic_internal.connector_pack_release_requirement (
  connector_id,pack_version,requirement_kind,requirement_value
) VALUES
  ('lightspeed-r','1.1.0','capability','inventory.purchase_orders'),
  ('lightspeed-r','1.1.0','source_table','vendors'),
  ('lightspeed-r','1.1.0','source_table','orders');

-- Preserve the sequence-1 table keys so already-running workers keep using
-- their three/four-column ON CONFLICT targets during a rolling deploy. A
-- BEFORE trigger routes every sequence>1 write into the versioned shadow
-- snapshots. This is the compatibility seam that permits true old/new worker
-- coexistence without allowing the candidate to overwrite the active rows.
CREATE TABLE semantic_internal.connector_pack_tenant_capability_snapshot (
  LIKE semantic_internal.tenant_capability
    INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING CONSTRAINTS INCLUDING STORAGE
);
ALTER TABLE semantic_internal.connector_pack_tenant_capability_snapshot
  ADD PRIMARY KEY (tenant_id,capability,source_key,pack_version),
  ADD FOREIGN KEY (capability)
    REFERENCES semantic_internal.capability_vocabulary(capability),
  ADD FOREIGN KEY (connector_id,pack_version)
    REFERENCES semantic_internal.connector_pack_release(connector_id,pack_version);

CREATE TABLE semantic_internal.connector_pack_source_field_snapshot (
  LIKE semantic_internal.source_field_allowlist
    INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING CONSTRAINTS INCLUDING STORAGE
);
ALTER TABLE semantic_internal.connector_pack_source_field_snapshot
  ADD PRIMARY KEY (tenant_id,connection_id,source_table,source_field,pack_version),
  ADD FOREIGN KEY (authority_concept)
    REFERENCES core.authority_concept_lookup(value),
  ADD FOREIGN KEY (connector_id,pack_version)
    REFERENCES semantic_internal.connector_pack_release(connector_id,pack_version);

CREATE INDEX connector_pack_capability_lookup_idx
  ON semantic_internal.connector_pack_tenant_capability_snapshot (
    tenant_id,connector_id,pack_version,capability
  );
CREATE INDEX connector_pack_source_allowlist_lookup_idx
  ON semantic_internal.connector_pack_source_field_snapshot (
    tenant_id,connector_id,pack_version,connection_id,active
  );

ALTER TABLE semantic_internal.connector_pack_tenant_capability_snapshot
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE semantic_internal.connector_pack_tenant_capability_snapshot
  FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation
  ON semantic_internal.connector_pack_tenant_capability_snapshot
  USING (tenant_id=core.current_tenant_id())
  WITH CHECK (tenant_id=core.current_tenant_id());

ALTER TABLE semantic_internal.connector_pack_source_field_snapshot
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE semantic_internal.connector_pack_source_field_snapshot
  FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation
  ON semantic_internal.connector_pack_source_field_snapshot
  USING (tenant_id=core.current_tenant_id())
  WITH CHECK (tenant_id=core.current_tenant_id());

-- The DDL owner performs one bounded metadata-only backfill, then FORCE is
-- restored before commit. Runtime activation never receives an RLS bypass.
ALTER TABLE semantic_internal.tenant_capability NO FORCE ROW LEVEL SECURITY;
ALTER TABLE semantic_internal.source_field_allowlist NO FORCE ROW LEVEL SECURITY;

INSERT INTO semantic_internal.connector_pack_evidence_index (
  tenant_id,connection_id,connector_id,pack_version,evidence_kind,evidence_key,
  capability,source_table,source_field,included,observed_at
)
SELECT capability.tenant_id,capability.connection_id,capability.connector_id,
       capability.pack_version,'capability',
       jsonb_build_array(capability.capability,capability.source_key)::text,
       capability.capability,NULL,NULL,true,capability.evaluated_at
  FROM semantic_internal.tenant_capability capability
 WHERE capability.connection_id IS NOT NULL
UNION ALL
SELECT field.tenant_id,field.connection_id,field.connector_id,field.pack_version,
       'source_field',jsonb_build_array(field.source_table,field.source_field)::text,
       NULL,field.source_table,field.source_field,field.active,
       coalesce(field.deactivated_at,field.created_at)
  FROM semantic_internal.source_field_allowlist field;

ALTER TABLE semantic_internal.tenant_capability FORCE ROW LEVEL SECURITY;
ALTER TABLE semantic_internal.source_field_allowlist FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION semantic_internal.route_connector_pack_capability_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE release_sequence bigint;
BEGIN
  SELECT release.release_sequence INTO release_sequence
    FROM semantic_internal.connector_pack_release release
   WHERE release.connector_id=NEW.connector_id
     AND release.pack_version=NEW.pack_version;
  IF coalesce(release_sequence,1)=1 THEN
    RETURN NEW;
  END IF;
  INSERT INTO semantic_internal.connector_pack_tenant_capability_snapshot (
    tenant_id,capability,source_key,connection_id,connector_id,available,
    reason_code,pack_version,source_watermark,evaluated_at,support,reason_detail,
    coverage,required_scopes
  ) VALUES (
    NEW.tenant_id,NEW.capability,NEW.source_key,NEW.connection_id,NEW.connector_id,
    NEW.available,NEW.reason_code,NEW.pack_version,NEW.source_watermark,
    NEW.evaluated_at,NEW.support,NEW.reason_detail,NEW.coverage,NEW.required_scopes
  ) ON CONFLICT (tenant_id,capability,source_key,pack_version) DO UPDATE SET
    connection_id=excluded.connection_id,connector_id=excluded.connector_id,
    available=CASE
      WHEN right(excluded.source_key,5)=':live'
       AND semantic_internal.connector_pack_tenant_capability_snapshot.support='full'
       AND excluded.support IN ('partial','unknown')
        THEN semantic_internal.connector_pack_tenant_capability_snapshot.available
      WHEN right(excluded.source_key,5)=':live'
       AND semantic_internal.connector_pack_tenant_capability_snapshot.support='partial'
       AND excluded.support='unknown'
        THEN semantic_internal.connector_pack_tenant_capability_snapshot.available
      ELSE excluded.available
    END,
    support=CASE
      WHEN right(excluded.source_key,5)=':live'
       AND semantic_internal.connector_pack_tenant_capability_snapshot.support='full'
       AND excluded.support IN ('partial','unknown')
        THEN semantic_internal.connector_pack_tenant_capability_snapshot.support
      WHEN right(excluded.source_key,5)=':live'
       AND semantic_internal.connector_pack_tenant_capability_snapshot.support='partial'
       AND excluded.support='unknown'
        THEN semantic_internal.connector_pack_tenant_capability_snapshot.support
      ELSE excluded.support
    END,
    reason_code=CASE
      WHEN right(excluded.source_key,5)=':live'
       AND semantic_internal.connector_pack_tenant_capability_snapshot.support='full'
       AND excluded.support IN ('partial','unknown')
        THEN semantic_internal.connector_pack_tenant_capability_snapshot.reason_code
      WHEN right(excluded.source_key,5)=':live'
       AND semantic_internal.connector_pack_tenant_capability_snapshot.support='partial'
       AND excluded.support='unknown'
        THEN semantic_internal.connector_pack_tenant_capability_snapshot.reason_code
      ELSE excluded.reason_code
    END,
    reason_detail=CASE
      WHEN right(excluded.source_key,5)=':live'
       AND semantic_internal.connector_pack_tenant_capability_snapshot.support='full'
       AND excluded.support IN ('partial','unknown')
        THEN semantic_internal.connector_pack_tenant_capability_snapshot.reason_detail
      WHEN right(excluded.source_key,5)=':live'
       AND semantic_internal.connector_pack_tenant_capability_snapshot.support='partial'
       AND excluded.support='unknown'
        THEN semantic_internal.connector_pack_tenant_capability_snapshot.reason_detail
      ELSE excluded.reason_detail
    END,
    coverage=CASE
      WHEN right(excluded.source_key,5)=':live'
       AND semantic_internal.connector_pack_tenant_capability_snapshot.support='full'
       AND excluded.support IN ('partial','unknown')
        THEN semantic_internal.connector_pack_tenant_capability_snapshot.coverage
      WHEN right(excluded.source_key,5)=':live'
       AND semantic_internal.connector_pack_tenant_capability_snapshot.support='partial'
       AND excluded.support='unknown'
        THEN semantic_internal.connector_pack_tenant_capability_snapshot.coverage
      ELSE excluded.coverage
    END,
    required_scopes=excluded.required_scopes,
    source_watermark=greatest(
      semantic_internal.connector_pack_tenant_capability_snapshot.source_watermark,
      excluded.source_watermark
    ),
    evaluated_at=excluded.evaluated_at;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION semantic_internal.route_connector_pack_source_field_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE release_sequence bigint;
BEGIN
  SELECT release.release_sequence INTO release_sequence
    FROM semantic_internal.connector_pack_release release
   WHERE release.connector_id=NEW.connector_id
     AND release.pack_version=NEW.pack_version;
  IF coalesce(release_sequence,1)=1 THEN
    RETURN NEW;
  END IF;
  INSERT INTO semantic_internal.connector_pack_source_field_snapshot (
    tenant_id,connection_id,connector_id,source_schema,source_table,source_field,
    field_type,disposition,pii_class,authority_concept,documented_definition,
    pack_version,active,created_at,deactivated_at,deactivation_reason
  ) VALUES (
    NEW.tenant_id,NEW.connection_id,NEW.connector_id,NEW.source_schema,
    NEW.source_table,NEW.source_field,NEW.field_type,NEW.disposition,NEW.pii_class,
    NEW.authority_concept,NEW.documented_definition,NEW.pack_version,NEW.active,
    NEW.created_at,NEW.deactivated_at,NEW.deactivation_reason
  ) ON CONFLICT (
    tenant_id,connection_id,source_table,source_field,pack_version
  ) DO UPDATE SET
    connector_id=excluded.connector_id,source_schema=excluded.source_schema,
    field_type=excluded.field_type,disposition=excluded.disposition,
    pii_class=excluded.pii_class,authority_concept=excluded.authority_concept,
    documented_definition=excluded.documented_definition,active=excluded.active,
    deactivated_at=excluded.deactivated_at,
    deactivation_reason=excluded.deactivation_reason;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION semantic_internal.guard_connector_pack_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE release_state text;
BEGIN
  -- FOR SHARE drains every in-flight publication before activation can update
  -- this release row. Once activation commits, a stale predecessor writer sees
  -- retired and fails rather than reviving query-visible evidence.
  SELECT release.state
    INTO release_state
    FROM semantic_internal.connector_pack_release release
   WHERE release.connector_id=NEW.connector_id
     AND release.pack_version=NEW.pack_version
   FOR SHARE;
  IF release_state IS NULL THEN
    RAISE EXCEPTION 'connector_pack_unregistered:%:%',NEW.connector_id,NEW.pack_version
      USING ERRCODE='55000';
  END IF;
  IF release_state NOT IN ('candidate','active') THEN
    RAISE EXCEPTION 'connector_pack_retired:%:%',NEW.connector_id,NEW.pack_version
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER connector_pack_tenant_capability_route
BEFORE INSERT OR UPDATE ON semantic_internal.tenant_capability
FOR EACH ROW EXECUTE FUNCTION semantic_internal.route_connector_pack_capability_snapshot();

CREATE TRIGGER connector_pack_source_field_route
BEFORE INSERT OR UPDATE ON semantic_internal.source_field_allowlist
FOR EACH ROW EXECUTE FUNCTION semantic_internal.route_connector_pack_source_field_snapshot();

CREATE TRIGGER tenant_capability_pack_release_guard
BEFORE INSERT OR UPDATE
ON semantic_internal.tenant_capability
FOR EACH ROW EXECUTE FUNCTION semantic_internal.guard_connector_pack_evidence();

CREATE TRIGGER connector_pack_capability_release_guard
BEFORE INSERT OR UPDATE
ON semantic_internal.connector_pack_tenant_capability_snapshot
FOR EACH ROW EXECUTE FUNCTION semantic_internal.guard_connector_pack_evidence();

CREATE TRIGGER connector_pack_source_field_release_guard
BEFORE INSERT OR UPDATE
ON semantic_internal.connector_pack_source_field_snapshot
FOR EACH ROW EXECUTE FUNCTION semantic_internal.guard_connector_pack_evidence();

CREATE TRIGGER source_field_allowlist_pack_release_guard
BEFORE INSERT OR UPDATE
ON semantic_internal.source_field_allowlist
FOR EACH ROW EXECUTE FUNCTION semantic_internal.guard_connector_pack_evidence();

CREATE OR REPLACE FUNCTION semantic_internal.sync_connector_pack_evidence_index()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE old_row jsonb;
DECLARE new_row jsonb;
BEGIN
  -- One trigger serves two record types. Resolve fields through jsonb so the
  -- function never dereferences a column that does not exist on the other
  -- relation (for example capability on source_field_allowlist).
  IF TG_OP IN ('UPDATE','DELETE') THEN
    old_row:=to_jsonb(OLD);
  END IF;
  IF TG_OP IN ('UPDATE','DELETE') AND old_row->>'connection_id' IS NOT NULL THEN
    DELETE FROM semantic_internal.connector_pack_evidence_index evidence
     WHERE evidence.tenant_id=old_row->>'tenant_id'
       AND evidence.connection_id=old_row->>'connection_id'
       AND evidence.connector_id=old_row->>'connector_id'
       AND evidence.pack_version=old_row->>'pack_version'
       AND evidence.evidence_kind=CASE
             WHEN TG_TABLE_NAME IN (
               'tenant_capability','connector_pack_tenant_capability_snapshot'
             ) THEN 'capability'
             ELSE 'source_field'
           END
       AND evidence.evidence_key=CASE
             WHEN TG_TABLE_NAME IN (
               'tenant_capability','connector_pack_tenant_capability_snapshot'
             )
               THEN jsonb_build_array(old_row->>'capability',old_row->>'source_key')::text
             ELSE jsonb_build_array(old_row->>'source_table',old_row->>'source_field')::text
           END;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    new_row:=to_jsonb(NEW);
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') AND new_row->>'connection_id' IS NOT NULL THEN
    INSERT INTO semantic_internal.connector_pack_evidence_index (
      tenant_id,connection_id,connector_id,pack_version,evidence_kind,evidence_key,
      capability,source_table,source_field,included,observed_at
    ) VALUES (
      new_row->>'tenant_id',new_row->>'connection_id',new_row->>'connector_id',
      new_row->>'pack_version',
      CASE WHEN TG_TABLE_NAME IN (
        'tenant_capability','connector_pack_tenant_capability_snapshot'
      ) THEN 'capability' ELSE 'source_field' END,
      CASE WHEN TG_TABLE_NAME IN (
        'tenant_capability','connector_pack_tenant_capability_snapshot'
      )
        THEN jsonb_build_array(new_row->>'capability',new_row->>'source_key')::text
        ELSE jsonb_build_array(new_row->>'source_table',new_row->>'source_field')::text END,
      CASE WHEN TG_TABLE_NAME IN (
        'tenant_capability','connector_pack_tenant_capability_snapshot'
      ) THEN new_row->>'capability' ELSE NULL END,
      CASE WHEN TG_TABLE_NAME IN (
        'source_field_allowlist','connector_pack_source_field_snapshot'
      ) THEN new_row->>'source_table' ELSE NULL END,
      CASE WHEN TG_TABLE_NAME IN (
        'source_field_allowlist','connector_pack_source_field_snapshot'
      ) THEN new_row->>'source_field' ELSE NULL END,
      CASE WHEN TG_TABLE_NAME IN (
        'tenant_capability','connector_pack_tenant_capability_snapshot'
      )
        THEN true ELSE (new_row->>'active')::boolean END,
      -- This is a publication-order fence, not a source business watermark.
      -- A write committed after an audited retirement must make that connection
      -- eligible again even when it reuses an older source timestamp.
      clock_timestamp()
    )
    ON CONFLICT (
      tenant_id,connection_id,connector_id,pack_version,evidence_kind,evidence_key
    ) DO UPDATE SET
      capability=excluded.capability,source_table=excluded.source_table,
      source_field=excluded.source_field,included=excluded.included,
      observed_at=excluded.observed_at;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_capability_pack_evidence_index
AFTER INSERT OR UPDATE OR DELETE ON semantic_internal.tenant_capability
FOR EACH ROW EXECUTE FUNCTION semantic_internal.sync_connector_pack_evidence_index();

CREATE TRIGGER source_field_allowlist_pack_evidence_index
AFTER INSERT OR UPDATE OR DELETE ON semantic_internal.source_field_allowlist
FOR EACH ROW EXECUTE FUNCTION semantic_internal.sync_connector_pack_evidence_index();

CREATE TRIGGER connector_pack_capability_evidence_index
AFTER INSERT OR UPDATE OR DELETE
ON semantic_internal.connector_pack_tenant_capability_snapshot
FOR EACH ROW EXECUTE FUNCTION semantic_internal.sync_connector_pack_evidence_index();

CREATE TRIGGER connector_pack_source_field_evidence_index
AFTER INSERT OR UPDATE OR DELETE
ON semantic_internal.connector_pack_source_field_snapshot
FOR EACH ROW EXECUTE FUNCTION semantic_internal.sync_connector_pack_evidence_index();

CREATE OR REPLACE FUNCTION semantic_internal.guard_connector_pack_release_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'connector pack releases are append-only' USING ERRCODE='55000';
  END IF;
  IF NEW.connector_id<>OLD.connector_id
     OR NEW.pack_version<>OLD.pack_version
     OR NEW.release_sequence<>OLD.release_sequence
     OR NEW.predecessor_version IS DISTINCT FROM OLD.predecessor_version
     OR NEW.registered_by_migration<>OLD.registered_by_migration
     OR NEW.registered_at<>OLD.registered_at THEN
    RAISE EXCEPTION 'connector pack release identity is immutable' USING ERRCODE='55000';
  END IF;
  IF NOT (
    (OLD.state='candidate' AND NEW.state='active'
      AND OLD.activated_at IS NULL AND NEW.activated_at IS NOT NULL
      AND NEW.retired_at IS NULL)
    OR
    (OLD.state='active' AND NEW.state='retired'
      AND NEW.activated_at=OLD.activated_at AND NEW.retired_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'invalid connector pack release transition: % to %',OLD.state,NEW.state
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER connector_pack_release_transition_guard
BEFORE UPDATE OR DELETE ON semantic_internal.connector_pack_release
FOR EACH ROW EXECUTE FUNCTION semantic_internal.guard_connector_pack_release_transition();

CREATE OR REPLACE FUNCTION semantic_internal.reject_connector_pack_activation_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'connector pack activation events are append-only' USING ERRCODE='55000';
END;
$$;

CREATE TRIGGER connector_pack_activation_event_append_only
BEFORE UPDATE OR DELETE ON semantic_internal.connector_pack_activation_event
FOR EACH ROW EXECUTE FUNCTION semantic_internal.reject_connector_pack_activation_event_mutation();

CREATE OR REPLACE FUNCTION semantic_internal.reject_connector_pack_connection_retirement_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog
AS $$
BEGIN
  IF TG_OP='DELETE' AND deletion_internal.mutation_authorized() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'connector pack connection retirements are append-only'
    USING ERRCODE='55000';
END;
$$;

CREATE TRIGGER connector_pack_connection_retirement_append_only
BEFORE UPDATE OR DELETE ON semantic_internal.connector_pack_connection_retirement
FOR EACH ROW EXECUTE FUNCTION semantic_internal.reject_connector_pack_connection_retirement_mutation();

CREATE OR REPLACE FUNCTION semantic_internal.connector_pack_connection_requires_candidate(
  p_tenant_id text,
  p_connection_id text,
  p_connector_id text,
  p_candidate_pack_version text
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
  SELECT NOT EXISTS (
    SELECT 1
      FROM semantic_internal.connector_pack_connection_retirement retirement
     WHERE retirement.tenant_id=p_tenant_id
       AND retirement.connection_id=p_connection_id
       AND retirement.connector_id=p_connector_id
       AND retirement.candidate_pack_version=p_candidate_pack_version
       AND NOT EXISTS (
         -- A reconnect that publishes any evidence after retirement becomes
         -- eligible again and must complete the whole candidate snapshot.
         SELECT 1
           FROM semantic_internal.connector_pack_evidence_index evidence
          WHERE evidence.tenant_id=p_tenant_id
            AND evidence.connection_id=p_connection_id
            AND evidence.connector_id=p_connector_id
            AND evidence.pack_version=p_candidate_pack_version
            AND evidence.observed_at>retirement.retired_at
       )
  )
$$;

CREATE OR REPLACE FUNCTION semantic_internal.retire_connector_pack_connection(
  p_tenant_id text,
  p_connection_id text,
  p_connector_id text,
  p_candidate_pack_version text,
  p_expected_active_pack_version text,
  p_retirement_reason text,
  p_control_plane_audit_id text,
  p_control_plane_evidence_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE retired_at timestamptz:=clock_timestamp();
DECLARE inserted_count integer;
DECLARE retirement semantic_internal.connector_pack_connection_retirement%ROWTYPE;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) OR NOT core.is_ulid(p_connection_id)
     OR p_connector_id NOT IN ('lightspeed-r','xero','deputy')
     OR p_candidate_pack_version IS NULL OR p_expected_active_pack_version IS NULL
     OR p_retirement_reason NOT IN ('disconnected','tenant_deleting')
     OR NOT core.is_ulid(p_control_plane_audit_id)
     OR p_control_plane_evidence_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'connector pack connection retirement input is invalid'
      USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('connector-pack-activation:'||p_connector_id,0)
  );
  PERFORM 1
    FROM semantic_internal.connector_pack_release release
   WHERE release.connector_id=p_connector_id
     AND release.pack_version IN (
       p_expected_active_pack_version,p_candidate_pack_version
     )
   ORDER BY release.release_sequence
   FOR UPDATE;
  IF NOT EXISTS (
       SELECT 1 FROM semantic_internal.connector_pack_release release
        WHERE release.connector_id=p_connector_id
          AND release.pack_version=p_expected_active_pack_version
          AND release.state='active'
     ) OR NOT EXISTS (
       SELECT 1 FROM semantic_internal.connector_pack_release release
        WHERE release.connector_id=p_connector_id
          AND release.pack_version=p_candidate_pack_version
          AND release.predecessor_version=p_expected_active_pack_version
          AND release.state='candidate'
     ) THEN
    RAISE EXCEPTION 'connector pack retirement release state changed'
      USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM semantic_internal.connector_pack_evidence_index evidence
     WHERE evidence.tenant_id=p_tenant_id
       AND evidence.connection_id=p_connection_id
       AND evidence.connector_id=p_connector_id
       AND evidence.pack_version=p_expected_active_pack_version
  ) THEN
    RAISE EXCEPTION 'connector pack retirement predecessor evidence is absent'
      USING ERRCODE='55000';
  END IF;

  INSERT INTO semantic_internal.connector_pack_connection_retirement (
    tenant_id,connection_id,connector_id,predecessor_pack_version,
    candidate_pack_version,retirement_reason,control_plane_audit_id,
    control_plane_evidence_sha256,retired_at,retired_by
  ) VALUES (
    p_tenant_id,p_connection_id,p_connector_id,p_expected_active_pack_version,
    p_candidate_pack_version,p_retirement_reason,p_control_plane_audit_id,
    p_control_plane_evidence_sha256,retired_at,session_user
  ) ON CONFLICT (
    tenant_id,connection_id,connector_id,candidate_pack_version
  ) DO NOTHING;
  GET DIAGNOSTICS inserted_count=ROW_COUNT;

  SELECT existing.* INTO STRICT retirement
    FROM semantic_internal.connector_pack_connection_retirement existing
   WHERE existing.tenant_id=p_tenant_id
     AND existing.connection_id=p_connection_id
     AND existing.connector_id=p_connector_id
     AND existing.candidate_pack_version=p_candidate_pack_version;
  IF retirement.predecessor_pack_version<>p_expected_active_pack_version
     OR retirement.retirement_reason<>p_retirement_reason
     OR retirement.control_plane_audit_id<>p_control_plane_audit_id
     OR retirement.control_plane_evidence_sha256<>p_control_plane_evidence_sha256 THEN
    RAISE EXCEPTION 'connector pack retirement evidence conflicts with the existing audit'
      USING ERRCODE='23505';
  END IF;
  RETURN jsonb_build_object(
    'tenantId',p_tenant_id,'connectionId',p_connection_id,
    'connectorId',p_connector_id,'candidatePackVersion',p_candidate_pack_version,
    'retirementReason',p_retirement_reason,'controlPlaneAuditId',p_control_plane_audit_id,
    'controlPlaneEvidenceSha256',p_control_plane_evidence_sha256,
    'retiredAt',retirement.retired_at,'idempotentReplay',inserted_count=0
  );
END;
$$;

CREATE VIEW semantic_internal.active_tenant_capability
WITH (security_invoker=true,security_barrier=true)
AS
SELECT capability.*
  FROM semantic_internal.tenant_capability capability
  JOIN semantic_internal.connector_pack_release release
    ON release.connector_id=capability.connector_id
   AND release.pack_version=capability.pack_version
   AND release.state='active'
UNION ALL
SELECT capability.*
  FROM semantic_internal.connector_pack_tenant_capability_snapshot capability
  JOIN semantic_internal.connector_pack_release release
    ON release.connector_id=capability.connector_id
   AND release.pack_version=capability.pack_version
   AND release.state='active';

CREATE VIEW semantic_internal.active_source_field_allowlist
WITH (security_invoker=true,security_barrier=true)
AS
SELECT field.*
  FROM semantic_internal.source_field_allowlist field
 JOIN semantic_internal.connector_pack_release release
    ON release.connector_id=field.connector_id
   AND release.pack_version=field.pack_version
   AND release.state='active'
 WHERE field.active
UNION ALL
SELECT field.*
  FROM semantic_internal.connector_pack_source_field_snapshot field
  JOIN semantic_internal.connector_pack_release release
    ON release.connector_id=field.connector_id
   AND release.pack_version=field.pack_version
   AND release.state='active'
 WHERE field.active;

-- Later additive migrations may replace this hook with release-specific data
-- repair gates. Activation always consumes it under the release-row lock.
CREATE OR REPLACE FUNCTION semantic_internal.connector_pack_release_external_gate_status(
  p_connector_id text,
  p_candidate_pack_version text
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
  SELECT jsonb_build_object(
    'connectorId',p_connector_id,
    'candidatePackVersion',p_candidate_pack_version,
    'ready',true,
    'gates','[]'::jsonb
  )
$$;

CREATE OR REPLACE FUNCTION semantic_internal.connector_pack_activation_status(
  p_connector_id text,
  p_candidate_pack_version text,
  p_expected_active_pack_version text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE current_version text;
DECLARE candidate_state text;
DECLARE candidate_predecessor text;
DECLARE predecessor_rows bigint;
DECLARE candidate_rows bigint;
DECLARE candidate_fields bigint;
DECLARE missing_rows bigint;
DECLARE missing_fields bigint;
DECLARE missing_requirements bigint;
DECLARE retired_connections bigint;
DECLARE external_gate jsonb;
DECLARE already_active boolean;
BEGIN
  IF p_connector_id NOT IN ('lightspeed-r','xero','deputy')
     OR p_candidate_pack_version IS NULL
     OR p_expected_active_pack_version IS NULL
     OR p_candidate_pack_version=p_expected_active_pack_version THEN
    RAISE EXCEPTION 'connector pack activation input is invalid' USING ERRCODE='22023';
  END IF;

  SELECT release.pack_version INTO current_version
    FROM semantic_internal.connector_pack_release release
   WHERE release.connector_id=p_connector_id AND release.state='active';
  SELECT release.state,release.predecessor_version
    INTO candidate_state,candidate_predecessor
    FROM semantic_internal.connector_pack_release release
   WHERE release.connector_id=p_connector_id
     AND release.pack_version=p_candidate_pack_version;

  SELECT count(*) INTO predecessor_rows
    FROM semantic_internal.connector_pack_evidence_index evidence
   WHERE evidence.connector_id=p_connector_id
     AND evidence.pack_version=p_expected_active_pack_version
     AND evidence.evidence_kind='capability';
  SELECT count(*) INTO candidate_rows
    FROM semantic_internal.connector_pack_evidence_index evidence
   WHERE evidence.connector_id=p_connector_id
     AND evidence.pack_version=p_candidate_pack_version
     AND evidence.evidence_kind='capability';
  SELECT count(*) INTO candidate_fields
    FROM semantic_internal.connector_pack_evidence_index evidence
   WHERE evidence.connector_id=p_connector_id
     AND evidence.pack_version=p_candidate_pack_version
     AND evidence.evidence_kind='source_field'
     AND evidence.included;
  SELECT count(*) INTO missing_rows
    FROM semantic_internal.connector_pack_evidence_index predecessor
   WHERE predecessor.connector_id=p_connector_id
     AND predecessor.pack_version=p_expected_active_pack_version
     AND predecessor.evidence_kind='capability'
     AND semantic_internal.connector_pack_connection_requires_candidate(
       predecessor.tenant_id,predecessor.connection_id,p_connector_id,
       p_candidate_pack_version
     )
     AND NOT EXISTS (
       SELECT 1
         FROM semantic_internal.connector_pack_evidence_index candidate
        WHERE candidate.tenant_id=predecessor.tenant_id
          AND candidate.connection_id=predecessor.connection_id
          AND candidate.connector_id=predecessor.connector_id
          AND candidate.pack_version=p_candidate_pack_version
          AND candidate.evidence_kind='capability'
          AND candidate.evidence_key=predecessor.evidence_key
     );
  SELECT count(*) INTO missing_fields
    FROM semantic_internal.connector_pack_evidence_index predecessor
   WHERE predecessor.connector_id=p_connector_id
     AND predecessor.pack_version=p_expected_active_pack_version
     AND predecessor.evidence_kind='source_field'
     AND predecessor.included
     AND semantic_internal.connector_pack_connection_requires_candidate(
       predecessor.tenant_id,predecessor.connection_id,p_connector_id,
       p_candidate_pack_version
     )
     AND NOT EXISTS (
       SELECT 1
         FROM semantic_internal.connector_pack_evidence_index candidate
        WHERE candidate.tenant_id=predecessor.tenant_id
          AND candidate.connection_id=predecessor.connection_id
          AND candidate.connector_id=predecessor.connector_id
          AND candidate.pack_version=p_candidate_pack_version
          AND candidate.evidence_kind='source_field'
          AND candidate.evidence_key=predecessor.evidence_key
     );
  WITH predecessor_connection AS (
    SELECT DISTINCT evidence.tenant_id,evidence.connection_id
      FROM semantic_internal.connector_pack_evidence_index evidence
     WHERE evidence.connector_id=p_connector_id
       AND evidence.pack_version=p_expected_active_pack_version
       AND semantic_internal.connector_pack_connection_requires_candidate(
         evidence.tenant_id,evidence.connection_id,p_connector_id,
         p_candidate_pack_version
       )
  ), required_evidence AS (
    SELECT connection.tenant_id,connection.connection_id,
           requirement.requirement_kind,requirement.requirement_value
      FROM predecessor_connection connection
      CROSS JOIN semantic_internal.connector_pack_release_requirement requirement
     WHERE requirement.connector_id=p_connector_id
       AND requirement.pack_version=p_candidate_pack_version
  )
  SELECT count(*) INTO missing_requirements
    FROM required_evidence requirement
   WHERE (requirement.requirement_kind='capability' AND NOT EXISTS (
           SELECT 1
             FROM semantic_internal.connector_pack_evidence_index candidate
            WHERE candidate.tenant_id=requirement.tenant_id
              AND candidate.connection_id=requirement.connection_id
              AND candidate.connector_id=p_connector_id
              AND candidate.pack_version=p_candidate_pack_version
              AND candidate.evidence_kind='capability'
              AND candidate.capability=requirement.requirement_value
         ))
      OR (requirement.requirement_kind='source_table' AND NOT EXISTS (
           SELECT 1
             FROM semantic_internal.connector_pack_evidence_index candidate
            WHERE candidate.tenant_id=requirement.tenant_id
              AND candidate.connection_id=requirement.connection_id
              AND candidate.connector_id=p_connector_id
              AND candidate.pack_version=p_candidate_pack_version
              AND candidate.evidence_kind='source_field'
              AND candidate.source_table=requirement.requirement_value
              AND candidate.included
         ));
  SELECT count(*) INTO retired_connections
    FROM (
      SELECT DISTINCT evidence.tenant_id,evidence.connection_id
        FROM semantic_internal.connector_pack_evidence_index evidence
       WHERE evidence.connector_id=p_connector_id
         AND evidence.pack_version=p_expected_active_pack_version
    ) connection
   WHERE NOT semantic_internal.connector_pack_connection_requires_candidate(
     connection.tenant_id,connection.connection_id,p_connector_id,
     p_candidate_pack_version
   );
  external_gate:=semantic_internal.connector_pack_release_external_gate_status(
    p_connector_id,p_candidate_pack_version
  );
  IF jsonb_typeof(external_gate)<>'object' OR NOT (external_gate ? 'ready') THEN
    RAISE EXCEPTION 'connector pack external readiness gate returned invalid evidence'
      USING ERRCODE='55000';
  END IF;
  already_active:=coalesce(current_version=p_candidate_pack_version
    AND candidate_state='active'
    AND candidate_predecessor=p_expected_active_pack_version
    AND EXISTS (
      SELECT 1
        FROM semantic_internal.connector_pack_activation_event event
       WHERE event.connector_id=p_connector_id
         AND event.previous_pack_version=p_expected_active_pack_version
         AND event.activated_pack_version=p_candidate_pack_version
    ),false);

  RETURN jsonb_build_object(
    'connectorId',p_connector_id,
    'expectedActivePackVersion',p_expected_active_pack_version,
    'currentActivePackVersion',current_version,
    'candidatePackVersion',p_candidate_pack_version,
    'candidateState',candidate_state,
    'candidatePredecessorVersion',candidate_predecessor,
    'predecessorCapabilityRows',predecessor_rows,
    'candidateCapabilityRows',candidate_rows,
    'candidateSourceFields',candidate_fields,
    'missingPredecessorCapabilityRows',missing_rows,
    'missingPredecessorSourceFields',missing_fields,
    'missingReleaseRequirements',missing_requirements,
    'auditedRetiredConnections',retired_connections,
    'externalGate',external_gate,
    'alreadyActive',already_active,
    'activationRequired',NOT already_active,
    'ready',already_active OR (
      current_version=p_expected_active_pack_version
      AND candidate_state='candidate'
      AND candidate_predecessor=p_expected_active_pack_version
      AND missing_rows=0
      AND missing_fields=0
      AND missing_requirements=0
      AND coalesce((external_gate->>'ready')::boolean,false)
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION semantic_internal.activate_connector_pack(
  p_connector_id text,
  p_candidate_pack_version text,
  p_expected_active_pack_version text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE status jsonb;
DECLARE candidate_sequence bigint;
DECLARE activated_at timestamptz:=clock_timestamp();
DECLARE prior_activated_at timestamptz;
BEGIN
  IF p_connector_id NOT IN ('lightspeed-r','xero','deputy')
     OR p_candidate_pack_version IS NULL
     OR p_expected_active_pack_version IS NULL
     OR p_candidate_pack_version=p_expected_active_pack_version THEN
    RAISE EXCEPTION 'connector pack activation input is invalid' USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('connector-pack-activation:'||p_connector_id,0)
  );
  -- Lock every release in sequence order. Publication triggers hold FOR SHARE,
  -- so this waits for predecessor work already in flight and blocks new writes
  -- until the active pointer has changed atomically.
  PERFORM 1
    FROM semantic_internal.connector_pack_release release
   WHERE release.connector_id=p_connector_id
   ORDER BY release.release_sequence
   FOR UPDATE;

  status:=semantic_internal.connector_pack_activation_status(
    p_connector_id,p_candidate_pack_version,p_expected_active_pack_version
  );
  IF coalesce((status->>'ready')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'connector_pack_candidate_not_ready:%',status::text
      USING ERRCODE='55000';
  END IF;
  IF coalesce((status->>'alreadyActive')::boolean,false) THEN
    SELECT event.activated_at INTO STRICT prior_activated_at
      FROM semantic_internal.connector_pack_activation_event event
     WHERE event.connector_id=p_connector_id
       AND event.previous_pack_version=p_expected_active_pack_version
       AND event.activated_pack_version=p_candidate_pack_version;
    RETURN status || jsonb_build_object(
      'ready',true,'activationRequired',false,'activatedAt',prior_activated_at
    );
  END IF;

  SELECT release.release_sequence INTO candidate_sequence
    FROM semantic_internal.connector_pack_release release
   WHERE release.connector_id=p_connector_id
     AND release.pack_version=p_candidate_pack_version;

  UPDATE semantic_internal.connector_pack_release
     SET state='retired',retired_at=activated_at
   WHERE connector_id=p_connector_id
     AND pack_version=p_expected_active_pack_version
     AND state='active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'connector pack active predecessor changed during activation'
      USING ERRCODE='40001';
  END IF;

  UPDATE semantic_internal.connector_pack_release
     SET state='active',activated_at=activated_at
   WHERE connector_id=p_connector_id
     AND pack_version=p_candidate_pack_version
     AND state='candidate';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'connector pack candidate changed during activation'
      USING ERRCODE='40001';
  END IF;

  INSERT INTO semantic_internal.connector_pack_activation_event (
    connector_id,release_sequence,previous_pack_version,activated_pack_version,
    predecessor_capability_rows,candidate_capability_rows,candidate_source_fields,
    activation_evidence,activated_at,activated_by
  ) VALUES (
    p_connector_id,candidate_sequence,p_expected_active_pack_version,
    p_candidate_pack_version,(status->>'predecessorCapabilityRows')::bigint,
    (status->>'candidateCapabilityRows')::bigint,
    (status->>'candidateSourceFields')::bigint,status,activated_at,session_user
  );

  RETURN status || jsonb_build_object('ready',true,'activatedAt',activated_at);
END;
$$;

-- Replace the live-probe writer with the same compatibility conflict target
-- used by the pre-migration fleet. The base-table router diverts sequence>1
-- observations into the versioned shadow snapshot before conflict resolution;
-- same-version live observations remain monotonic inside that shadow table.
CREATE OR REPLACE FUNCTION semantic_internal.publish_connector_capability_observations(
  p_tenant_id text,
  p_connection_id text,
  p_connector_id text,
  p_pack_version text,
  p_stream text,
  p_source_watermark timestamptz,
  p_observations jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE published integer;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id<>core.current_tenant_id()
     OR NOT core.is_ulid(p_tenant_id)
     OR NOT core.is_ulid(p_connection_id)
     OR p_connector_id NOT IN ('lightspeed-r','xero','deputy')
     OR p_pack_version IS NULL OR length(btrim(p_pack_version)) NOT BETWEEN 1 AND 120
     OR p_stream IS NULL OR p_stream !~ '^[a-z][a-z0-9_]*$'
     OR p_observations IS NULL OR jsonb_typeof(p_observations)<>'array'
     OR jsonb_array_length(p_observations)>64 THEN
    RAISE EXCEPTION 'connector capability observation input is invalid' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_observations) AS item(value)
      LEFT JOIN semantic_internal.capability_vocabulary AS vocabulary
        ON vocabulary.capability=item.value->>'id'
     WHERE jsonb_typeof(item.value)<>'object'
        OR vocabulary.capability IS NULL
        OR item.value->>'support' NOT IN ('full','partial','unavailable','unknown')
        OR coalesce(item.value->>'reasonCode','') !~ '^[a-z][a-z0-9_]{0,119}$'
        OR (item.value ? 'coverage' AND jsonb_typeof(item.value->'coverage')<>'object')
        OR (item.value ? 'requiredScopes' AND jsonb_typeof(item.value->'requiredScopes')<>'array')
  ) THEN
    RAISE EXCEPTION 'connector capability observation contains an unknown or invalid capability' USING ERRCODE='22023';
  END IF;

  WITH observations AS (
    SELECT item.value->>'id' AS capability,
           item.value->>'support' AS support,
           item.value->>'reasonCode' AS reason_code,
           nullif(left(item.value->>'notes',500),'') AS reason_detail,
           coalesce(item.value->'coverage','{}'::jsonb)
             || jsonb_build_object('stream',p_stream) AS coverage,
           coalesce(ARRAY(
             SELECT scope.value
               FROM jsonb_array_elements_text(coalesce(item.value->'requiredScopes','[]'::jsonb)) AS scope(value)
              WHERE length(scope.value) BETWEEN 1 AND 200
              ORDER BY scope.value
           ),'{}'::text[]) AS required_scopes
      FROM jsonb_array_elements(p_observations) AS item(value)
  )
  INSERT INTO semantic_internal.tenant_capability (
    tenant_id,capability,source_key,connection_id,connector_id,available,support,
    reason_code,reason_detail,coverage,required_scopes,pack_version,source_watermark,evaluated_at
  )
  SELECT p_tenant_id,capability,p_connector_id||':'||p_connection_id||':live',
         p_connection_id,p_connector_id,support IN ('full','partial'),support,
         reason_code,reason_detail,coverage,required_scopes,p_pack_version,p_source_watermark,now()
    FROM observations
  ON CONFLICT (tenant_id,capability,source_key) DO UPDATE SET
    available=CASE
      WHEN semantic_internal.tenant_capability.support='full'
       AND excluded.support IN ('partial','unknown')
        THEN semantic_internal.tenant_capability.available
      WHEN semantic_internal.tenant_capability.support='partial'
       AND excluded.support='unknown'
        THEN semantic_internal.tenant_capability.available
      ELSE excluded.available
    END,
    support=CASE
      WHEN semantic_internal.tenant_capability.support='full'
       AND excluded.support IN ('partial','unknown')
        THEN semantic_internal.tenant_capability.support
      WHEN semantic_internal.tenant_capability.support='partial'
       AND excluded.support='unknown'
        THEN semantic_internal.tenant_capability.support
      ELSE excluded.support
    END,
    reason_code=CASE
      WHEN semantic_internal.tenant_capability.support='full'
       AND excluded.support IN ('partial','unknown')
        THEN semantic_internal.tenant_capability.reason_code
      WHEN semantic_internal.tenant_capability.support='partial'
       AND excluded.support='unknown'
        THEN semantic_internal.tenant_capability.reason_code
      ELSE excluded.reason_code
    END,
    reason_detail=CASE
      WHEN semantic_internal.tenant_capability.support='full'
       AND excluded.support IN ('partial','unknown')
        THEN semantic_internal.tenant_capability.reason_detail
      WHEN semantic_internal.tenant_capability.support='partial'
       AND excluded.support='unknown'
        THEN semantic_internal.tenant_capability.reason_detail
      ELSE excluded.reason_detail
    END,
    coverage=CASE
      WHEN semantic_internal.tenant_capability.support='full'
       AND excluded.support IN ('partial','unknown')
        THEN semantic_internal.tenant_capability.coverage
      WHEN semantic_internal.tenant_capability.support='partial'
       AND excluded.support='unknown'
        THEN semantic_internal.tenant_capability.coverage
      ELSE excluded.coverage
    END,
    required_scopes=excluded.required_scopes,
    source_watermark=greatest(semantic_internal.tenant_capability.source_watermark,excluded.source_watermark),
    evaluated_at=now();
  GET DIAGNOSTICS published=ROW_COUNT;
  -- A BEFORE trigger that returns NULL correctly reports zero affected base
  -- rows even though every candidate observation was durably upserted into the
  -- shadow snapshot. Preserve the function's published-count contract.
  IF published=0 AND EXISTS (
    SELECT 1
      FROM semantic_internal.connector_pack_release release
     WHERE release.connector_id=p_connector_id
       AND release.pack_version=p_pack_version
       AND release.release_sequence>1
  ) THEN
    published:=jsonb_array_length(p_observations);
  END IF;
  RETURN published;
END;
$$;

-- Topic health must resolve contributors from the same atomically active
-- pack snapshot used by semantic context and source exploration.
CREATE OR REPLACE FUNCTION quality.current_scoped_health(
  p_tenant_id text,
  p_domains text[],
  p_capabilities text[]
) RETURNS TABLE (
  check_id text,
  domain text,
  status text,
  details jsonb,
  checked_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,core,quality,semantic_internal
AS $$
DECLARE non_connector_domains text[];
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501';
  END IF;
  IF coalesce(cardinality(p_domains),0)=0 OR EXISTS (
    SELECT 1 FROM unnest(p_domains) value
     WHERE value !~ '^[a-z][a-z0-9_.-]{0,99}$'
  ) OR coalesce(cardinality(p_capabilities),0)=0 OR EXISTS (
    SELECT 1 FROM unnest(p_capabilities) value
     WHERE value !~ '^[a-z][a-z0-9_.]{0,119}$'
  ) THEN
    RAISE EXCEPTION 'scoped health inputs are invalid' USING ERRCODE='22023';
  END IF;

  IF 'connector'=ANY(p_domains) THEN
    RETURN QUERY
    WITH requested_capability AS (
      SELECT DISTINCT value AS capability FROM unnest(p_capabilities) value
    ), candidates AS (
      SELECT capability.capability,capability.connection_id,capability.connector_id,
             capability.coverage->>'stream' AS stream,capability.evaluated_at,
             CASE
               WHEN capability.capability LIKE 'inventory.%' THEN 'stock'
               WHEN capability.capability LIKE 'workforce.shifts%' THEN 'planned_shifts'
               WHEN capability.capability LIKE 'workforce.%' THEN 'worked_hours'
               WHEN capability.capability IN ('finance.bank_transactions','finance.payments')
                 THEN 'cash_settlement'
               WHEN capability.capability LIKE 'finance.%' THEN 'statutory_finance'
               WHEN capability.capability='commerce.orders.customer' THEN 'customer_master'
               ELSE 'operational_sales'
             END AS authority_concept
        FROM semantic_internal.active_tenant_capability capability
        JOIN requested_capability requested USING (capability)
       WHERE capability.tenant_id=p_tenant_id AND capability.available
         AND capability.connection_id IS NOT NULL
         AND capability.coverage->>'stream' ~ '^[a-z][a-z0-9_]*$'
    ), authority_scoped AS (
      SELECT candidate.*,
             EXISTS (
               SELECT 1 FROM core.source_authority authority
                WHERE authority.tenant_id=p_tenant_id
                  AND authority.concept=candidate.authority_concept
                  AND authority.authoritative_connection_id=candidate.connection_id
                  AND authority.effective_from<=now()
                  AND (authority.effective_to IS NULL OR authority.effective_to>now())
             ) AS is_authoritative,
             EXISTS (
               SELECT 1 FROM core.source_authority authority
                WHERE authority.tenant_id=p_tenant_id
                  AND authority.concept=candidate.authority_concept
                  AND authority.effective_from<=now()
                  AND (authority.effective_to IS NULL OR authority.effective_to>now())
             ) AS has_configured_authority
        FROM candidates candidate
    ), capability_contributors AS (
      SELECT capability,connection_id,connector_id,stream,evaluated_at
        FROM authority_scoped
       WHERE is_authoritative OR NOT has_configured_authority
    ), contributors AS (
      SELECT connection_id,connector_id,stream,max(evaluated_at) AS capability_evaluated_at
        FROM capability_contributors
       GROUP BY connection_id,connector_id,stream
    ), capability_coverage AS (
      SELECT count(*)::integer AS requested_count,
             count(DISTINCT contributor.capability)::integer AS represented_count,
             coalesce(jsonb_agg(requested.capability ORDER BY requested.capability)
               FILTER (WHERE contributor.capability IS NULL),'[]'::jsonb) AS missing
        FROM requested_capability requested
        LEFT JOIN capability_contributors contributor
          ON contributor.capability=requested.capability
    ), expected AS (
      SELECT expectation.check_id,expectation.max_age
        FROM quality.check_expectation expectation
       WHERE expectation.domain='connector' AND expectation.required
    ), current_state AS (
      SELECT DISTINCT ON (state.connection_id,state.connector_id,state.stream)
             state.*
        FROM quality.connector_stream_state state
        JOIN contributors contributor
          ON contributor.connection_id=state.connection_id
         AND contributor.connector_id=state.connector_id
         AND contributor.stream=state.stream
       WHERE state.tenant_id=p_tenant_id
       ORDER BY state.connection_id,state.connector_id,state.stream,
                state.connection_generation DESC
    ), observed AS (
      SELECT expected.check_id,expected.max_age,
             contributor.connection_id,contributor.connector_id,contributor.stream,
             state.connection_generation,
             CASE
               WHEN state.connection_id IS NULL OR state.observed_page_count=0
                 OR state.last_page_at IS NULL THEN 'blocked'
               WHEN expected.check_id IN (
                 'cursor_completeness','scope_available','retention_limit_recorded',
                 'schema_drift','enum_drift'
               ) AND state.last_page_at<now()-expected.max_age THEN 'blocked'
               WHEN expected.check_id='cursor_completeness' THEN CASE
                 WHEN state.cursor_complete AND state.cursor_chain_valid THEN 'passed'
                 ELSE 'blocked' END
               WHEN expected.check_id='scope_available' THEN 'passed'
               WHEN expected.check_id='retention_limit_recorded' THEN CASE
                 WHEN state.backfill_complete AND state.retention_evidence IS NOT NULL THEN 'passed'
                 WHEN state.backfill_complete THEN 'blocked'
                 ELSE 'warning' END
               WHEN expected.check_id='webhook_gap_recovered' THEN CASE
                 WHEN state.reconciliation_gap_count>0 THEN 'blocked'
                 WHEN state.reconciliation_completed_at IS NULL
                   OR state.reconciliation_completed_at<now()-expected.max_age THEN 'warning'
                 ELSE 'passed' END
               WHEN expected.check_id='delete_handling' THEN CASE
                 WHEN state.reconciliation_gap_count>0
                   OR (state.source_total IS NOT NULL AND state.local_live_total IS NOT NULL
                       AND state.source_total<>state.local_live_total) THEN 'blocked'
                 WHEN state.reconciliation_completed_at IS NULL
                   OR state.reconciliation_completed_at<now()-expected.max_age
                   OR state.source_total IS NULL OR state.local_live_total IS NULL THEN 'warning'
                 ELSE 'passed' END
               WHEN expected.check_id='schema_drift' THEN CASE
                 WHEN state.unresolved_schema_drift_count=0 THEN 'passed' ELSE 'blocked' END
               ELSE CASE
                 WHEN state.unresolved_enum_drift_count+state.unresolved_quarantine_count=0
                   THEN 'passed' ELSE 'blocked' END
             END AS observed_status,
             jsonb_build_object(
               'reason_code',CASE
                 WHEN state.connection_id IS NULL THEN 'durable_stream_state_missing'
                 WHEN state.observed_page_count=0 OR state.last_page_at IS NULL
                   THEN 'durable_stream_unobserved'
                 WHEN expected.check_id IN (
                   'cursor_completeness','scope_available','retention_limit_recorded',
                   'schema_drift','enum_drift'
                 ) AND state.last_page_at<now()-expected.max_age
                   THEN 'durable_stream_state_stale'
                 WHEN expected.check_id='retention_limit_recorded' AND NOT state.backfill_complete
                   THEN 'full_history_pending'
                 WHEN expected.check_id IN ('webhook_gap_recovered','delete_handling')
                   AND (state.reconciliation_completed_at IS NULL
                        OR state.reconciliation_completed_at<now()-expected.max_age)
                   THEN 'reconciliation_pending_or_stale'
                 ELSE 'durable_stream_check'
               END,
               'connection_generation',state.connection_generation,
               'observed_page_count',coalesce(state.observed_page_count,0),
               'cursor_complete',coalesce(state.cursor_complete,false),
               'cursor_chain_valid',coalesce(state.cursor_chain_valid,false),
               'backfill_complete',coalesce(state.backfill_complete,false),
               'retention_evidence_recorded',state.retention_evidence IS NOT NULL,
               'reconciliation_completed_at',state.reconciliation_completed_at,
               'reconciliation_gap_count',coalesce(state.reconciliation_gap_count,0),
               'source_total',state.source_total,
               'local_live_total',state.local_live_total,
               'unresolved_schema_drift',coalesce(state.unresolved_schema_drift_count,0),
               'unresolved_enum_or_quarantine',
                 coalesce(state.unresolved_enum_drift_count,0)
                 +coalesce(state.unresolved_quarantine_count,0)
             ) AS observed_details,
             CASE
               WHEN expected.check_id IN ('webhook_gap_recovered','delete_handling')
                 THEN coalesce(state.reconciliation_completed_at,state.last_page_at)
               ELSE state.last_page_at
             END AS observed_at
        FROM expected
        LEFT JOIN contributors contributor ON true
        LEFT JOIN current_state state
          ON state.connection_id=contributor.connection_id
         AND state.connector_id=contributor.connector_id
         AND state.stream=contributor.stream
    )
    SELECT observed.check_id,'connector'::text,
           CASE
             WHEN capability_coverage.represented_count<>capability_coverage.requested_count
               OR count(observed.connection_id)=0
               OR bool_or(observed.observed_status IS NULL)
               OR bool_or(observed.observed_status='blocked') THEN 'blocked'
             WHEN bool_or(observed.observed_status='failed') THEN 'failed'
             WHEN bool_or(observed.observed_status='warning') THEN 'warning'
             ELSE 'passed'
           END,
           jsonb_build_object(
             'reason_code','capability_scoped_durable_connector_health',
             'requested_capabilities',to_jsonb(p_capabilities),
             'represented_capability_count',capability_coverage.represented_count,
             'missing_capabilities',capability_coverage.missing,
             'contributor_count',count(observed.connection_id),
             'contributors',coalesce(jsonb_agg(jsonb_build_object(
               'connection_id',observed.connection_id,
               'connector_id',observed.connector_id,
               'stream',observed.stream,
               'connection_generation',observed.connection_generation,
               'status',coalesce(observed.observed_status,'blocked'),
               'checked_at',observed.observed_at,
               'details',coalesce(observed.observed_details,'{}'::jsonb)
             ) ORDER BY observed.connector_id,observed.connection_id,observed.stream)
             FILTER (WHERE observed.connection_id IS NOT NULL),'[]'::jsonb)
           ),
           max(observed.observed_at)
      FROM observed CROSS JOIN capability_coverage
     GROUP BY observed.check_id,capability_coverage.requested_count,
              capability_coverage.represented_count,capability_coverage.missing
     ORDER BY observed.check_id;
  END IF;

  non_connector_domains:=ARRAY(
    SELECT DISTINCT value FROM unnest(p_domains) value
     WHERE value<>'connector' ORDER BY value
  );
  IF cardinality(non_connector_domains)>0 THEN
    RETURN QUERY
    SELECT health.check_id,health.domain,health.status,health.details,health.checked_at
      FROM quality.current_health(p_tenant_id,non_connector_domains) health;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION quality.current_scoped_health(text,text[],text[])
  FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT EXECUTE ON FUNCTION quality.current_scoped_health(text,text[],text[])
  TO semantic_ro,transform_rw,diagnostic_ro;

-- The signed one-use deletion entry point delegates through this private
-- layer. Remove tenant-scoped retirement evidence under the same authorized
-- deletion fence before the established catalog-driven purge deletes the
-- capability/allowlist rows (whose triggers remove the global evidence index).
ALTER FUNCTION deletion_internal.purge_connection_pre_capability(text,text)
  RENAME TO purge_connection_before_connector_pack_retirement;

CREATE FUNCTION deletion_internal.purge_connection_pre_capability(
  p_tenant_id text,p_connection_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE removed bigint:=0;added bigint;result jsonb;
BEGIN
  IF NOT core.is_ulid(p_tenant_id) OR NOT core.is_ulid(p_connection_id) THEN
    RAISE EXCEPTION 'deletion scope identifiers must be ULIDs' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('albert.tenant_id',p_tenant_id,true);
  PERFORM set_config('albert.deletion_authorized','on',true);
  PERFORM pg_advisory_xact_lock(hashtextextended('deletion:'||p_tenant_id,0));
  DELETE FROM semantic_internal.connector_pack_connection_retirement
   WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  GET DIAGNOSTICS added=ROW_COUNT;removed:=removed+added;
  DELETE FROM semantic_internal.connector_pack_tenant_capability_snapshot
   WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  GET DIAGNOSTICS added=ROW_COUNT;removed:=removed+added;
  DELETE FROM semantic_internal.connector_pack_source_field_snapshot
   WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  GET DIAGNOSTICS added=ROW_COUNT;removed:=removed+added;
  result:=deletion_internal.purge_connection_before_connector_pack_retirement(
    p_tenant_id,p_connection_id
  );
  RETURN jsonb_set(
    result,'{rowsRemoved}',
    to_jsonb(coalesce((result->>'rowsRemoved')::bigint,0)+removed),true
  );
END;
$$;

REVOKE ALL ON FUNCTION
  deletion_internal.purge_connection_before_connector_pack_retirement(text,text),
  deletion_internal.purge_connection_pre_capability(text,text)
FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT EXECUTE ON FUNCTION deletion_internal.purge_connection_pre_capability(text,text)
  TO albert_migration_owner;

REVOKE ALL ON TABLE
  semantic_internal.connector_pack_release,
  semantic_internal.connector_pack_release_requirement,
  semantic_internal.connector_pack_evidence_index,
  semantic_internal.connector_pack_activation_event,
  semantic_internal.connector_pack_connection_retirement,
  semantic_internal.connector_pack_tenant_capability_snapshot,
  semantic_internal.connector_pack_source_field_snapshot
FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT SELECT ON semantic_internal.connector_pack_release
  TO semantic_ro,transform_rw,semantic_meta_rw,diagnostic_ro;
GRANT SELECT ON semantic_internal.connector_pack_release_requirement
  TO diagnostic_ro;
GRANT SELECT ON semantic_internal.connector_pack_activation_event
  TO diagnostic_ro;
GRANT SELECT ON semantic_internal.connector_pack_connection_retirement
  TO diagnostic_ro;
GRANT SELECT ON semantic_internal.connector_pack_tenant_capability_snapshot
  TO semantic_ro,transform_rw,semantic_meta_rw,diagnostic_ro;
GRANT SELECT ON semantic_internal.connector_pack_source_field_snapshot
  TO semantic_ro,transform_rw,semantic_meta_rw,diagnostic_ro;
GRANT UPDATE (active,deactivated_at,deactivation_reason)
  ON semantic_internal.connector_pack_source_field_snapshot TO transform_rw;
GRANT SELECT ON semantic_internal.active_tenant_capability
  TO semantic_ro,transform_rw,diagnostic_ro;
GRANT SELECT ON semantic_internal.active_source_field_allowlist
  TO semantic_ro,transform_rw,diagnostic_ro;

REVOKE ALL ON FUNCTION
  semantic_internal.route_connector_pack_capability_snapshot(),
  semantic_internal.route_connector_pack_source_field_snapshot(),
  semantic_internal.guard_connector_pack_evidence(),
  semantic_internal.sync_connector_pack_evidence_index(),
  semantic_internal.guard_connector_pack_release_transition(),
  semantic_internal.reject_connector_pack_activation_event_mutation(),
  semantic_internal.reject_connector_pack_connection_retirement_mutation(),
  semantic_internal.connector_pack_connection_requires_candidate(text,text,text,text),
  semantic_internal.retire_connector_pack_connection(text,text,text,text,text,text,text,text),
  semantic_internal.connector_pack_release_external_gate_status(text,text),
  semantic_internal.connector_pack_activation_status(text,text,text),
  semantic_internal.activate_connector_pack(text,text,text)
FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT EXECUTE ON FUNCTION
  semantic_internal.connector_pack_connection_requires_candidate(text,text,text,text),
  semantic_internal.retire_connector_pack_connection(text,text,text,text,text,text,text,text),
  semantic_internal.connector_pack_release_external_gate_status(text,text),
  semantic_internal.connector_pack_activation_status(text,text,text),
  semantic_internal.activate_connector_pack(text,text,text)
TO albert_migration_owner;

COMMIT;
