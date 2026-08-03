BEGIN;

INSERT INTO core.event_link_type_lookup (value,description)
VALUES ('settlement_of','Cash settlement evidence for an invoice, credit note, or commercial event')
ON CONFLICT (value) DO UPDATE SET description=excluded.description;

CREATE TABLE IF NOT EXISTS core.employment_status_lookup (value text PRIMARY KEY,description text NOT NULL);
CREATE TABLE IF NOT EXISTS core.purchase_order_status_lookup (value text PRIMARY KEY,description text NOT NULL);
CREATE TABLE IF NOT EXISTS core.finance_status_lookup (value text PRIMARY KEY,description text NOT NULL);
CREATE TABLE IF NOT EXISTS core.workforce_shift_status_lookup (value text PRIMARY KEY,description text NOT NULL);
CREATE TABLE IF NOT EXISTS core.workforce_time_status_lookup (value text PRIMARY KEY,description text NOT NULL);
CREATE TABLE IF NOT EXISTS core.workforce_leave_status_lookup (value text PRIMARY KEY,description text NOT NULL);
CREATE TABLE IF NOT EXISTS core.inventory_movement_type_lookup (value text PRIMARY KEY,description text NOT NULL);

INSERT INTO core.employment_status_lookup VALUES
  ('active','Active employment episode'),('terminated','Ended employment episode') ON CONFLICT DO NOTHING;
INSERT INTO core.purchase_order_status_lookup VALUES
  ('open','Open purchase order'),('partially_received','Partially received purchase order'),
  ('completed','Completed purchase order'),('cancelled','Cancelled purchase order') ON CONFLICT DO NOTHING;
INSERT INTO core.finance_status_lookup VALUES
  ('draft','Draft finance document'),('submitted','Submitted finance document'),
  ('authorised','Authorised finance document'),('paid','Paid finance document'),
  ('posted','Posted finance document'),('reconciled','Reconciled finance document'),
  ('voided','Voided finance document'),('deleted','Deleted source document'),
  ('unknown','Unmapped source status retained as an explicit governed value') ON CONFLICT DO NOTHING;
INSERT INTO core.workforce_shift_status_lookup VALUES
  ('draft','Draft roster'),('published','Published roster'),('open','Open roster'),
  ('cancelled','Cancelled roster') ON CONFLICT DO NOTHING;
INSERT INTO core.workforce_time_status_lookup VALUES
  ('pending','Pending approval'),('approved','Approved time'),('leave','Leave time entry'),
  ('discarded','Discarded time entry') ON CONFLICT DO NOTHING;
INSERT INTO core.workforce_leave_status_lookup VALUES
  ('awaiting_approval','Awaiting approval'),('approved','Approved leave'),
  ('declined','Declined leave'),('cancelled','Cancelled leave'),
  ('date_approved','Dates approved'),('pay_approved','Pay approved'),
  ('unknown','Unmapped source leave status') ON CONFLICT DO NOTHING;
INSERT INTO core.inventory_movement_type_lookup VALUES
  ('receipt','Stock receipt'),('sale','Sale depletion'),('return','Returned stock'),
  ('transfer','Stock transfer'),('stocktake','Stocktake correction'),
  ('adjustment','Manual stock adjustment'),('automated','Automated stock adjustment'),
  ('unknown','Unmapped stock movement') ON CONFLICT DO NOTHING;

ALTER TABLE core.employment_episode DROP CONSTRAINT IF EXISTS employment_episode_status_fk;
ALTER TABLE core.employment_episode ADD CONSTRAINT employment_episode_status_fk
  FOREIGN KEY (status) REFERENCES core.employment_status_lookup(value);
ALTER TABLE core.purchase_order_line DROP CONSTRAINT IF EXISTS purchase_order_line_status_fk;
ALTER TABLE core.purchase_order_line ADD CONSTRAINT purchase_order_line_status_fk
  FOREIGN KEY (status) REFERENCES core.purchase_order_status_lookup(value);
ALTER TABLE core.finance_journal_line DROP CONSTRAINT IF EXISTS finance_journal_line_status_fk;
ALTER TABLE core.finance_journal_line ADD CONSTRAINT finance_journal_line_status_fk
  FOREIGN KEY (status) REFERENCES core.finance_status_lookup(value);
ALTER TABLE core.finance_invoice_line DROP CONSTRAINT IF EXISTS finance_invoice_line_status_fk;
ALTER TABLE core.finance_invoice_line ADD CONSTRAINT finance_invoice_line_status_fk
  FOREIGN KEY (status) REFERENCES core.finance_status_lookup(value);
ALTER TABLE core.finance_bank_transaction DROP CONSTRAINT IF EXISTS finance_bank_transaction_status_fk;
ALTER TABLE core.finance_bank_transaction ADD CONSTRAINT finance_bank_transaction_status_fk
  FOREIGN KEY (status) REFERENCES core.finance_status_lookup(value);
ALTER TABLE core.workforce_shift DROP CONSTRAINT IF EXISTS workforce_shift_status_fk;
ALTER TABLE core.workforce_shift ADD CONSTRAINT workforce_shift_status_fk
  FOREIGN KEY (status) REFERENCES core.workforce_shift_status_lookup(value);
ALTER TABLE core.workforce_time_entry DROP CONSTRAINT IF EXISTS workforce_time_entry_status_fk;
ALTER TABLE core.workforce_time_entry ADD CONSTRAINT workforce_time_entry_status_fk
  FOREIGN KEY (status) REFERENCES core.workforce_time_status_lookup(value);
ALTER TABLE core.workforce_leave DROP CONSTRAINT IF EXISTS workforce_leave_status_fk;
ALTER TABLE core.workforce_leave ADD CONSTRAINT workforce_leave_status_fk
  FOREIGN KEY (status) REFERENCES core.workforce_leave_status_lookup(value);
ALTER TABLE core.inventory_movement DROP CONSTRAINT IF EXISTS inventory_movement_type_fk;
ALTER TABLE core.inventory_movement ADD CONSTRAINT inventory_movement_type_fk
  FOREIGN KEY (movement_type) REFERENCES core.inventory_movement_type_lookup(value);

CREATE OR REPLACE FUNCTION semantic_internal.deterministic_ulid(value text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path=pg_catalog
AS $$ SELECT '0' || upper(substr(md5(value),1,25)) $$;

CREATE OR REPLACE FUNCTION semantic_internal.assert_transform_runtime_boundary()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  login_role name:=session_user;
  login_oid oid;
  privileged boolean;
BEGIN
  SELECT role.oid,
         role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
           OR role.rolreplication OR role.rolbypassrls
    INTO login_oid,privileged
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname=login_role;
  IF login_oid IS NULL OR privileged
     OR NOT pg_catalog.pg_has_role(login_role,'transform_rw','member') THEN
    RAISE EXCEPTION 'transform login is over-privileged or lacks transform_rw'
      USING ERRCODE='42501';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid=membership.roleid
     WHERE membership.member=login_oid AND granted_role.rolname<>'transform_rw'
  ) THEN
    RAISE EXCEPTION 'transform login must be a member only of transform_rw'
      USING ERRCODE='42501';
  END IF;
  IF pg_catalog.has_schema_privilege(login_role,'core','CREATE')
     OR pg_catalog.has_schema_privilege(login_role,'mart','CREATE')
     OR pg_catalog.has_schema_privilege(login_role,'quality','CREATE')
     OR pg_catalog.has_table_privilege(login_role,'ingestion.source_records','INSERT')
     OR pg_catalog.has_table_privilege(login_role,'ingestion.source_records','UPDATE')
     OR pg_catalog.has_table_privilege(login_role,'ingestion.source_records','DELETE')
     OR pg_catalog.has_table_privilege(login_role,'ingestion.batch_manifests','INSERT')
     OR pg_catalog.has_table_privilege(login_role,'ingestion.batch_manifests','UPDATE')
     OR pg_catalog.has_table_privilege(login_role,'ingestion.batch_manifests','DELETE') THEN
    RAISE EXCEPTION 'transform login has forbidden DDL or ingestion-write privilege'
      USING ERRCODE='42501';
  END IF;
END $$;

-- calendar_day is the sole global canonical dimension. Every tenant-owned
-- canonical dimension, bridge, evidence link, and authority row retains the
-- immutable sync run that first established it.
DO $$
DECLARE canonical_table text;
BEGIN
  FOREACH canonical_table IN ARRAY ARRAY[
    'location','register','channel','legal_entity','person','customer_account',
    'worker','employment_episode','supplier','product','product_variant',
    'product_category','gl_account','tax_code','stock_location',
    'product_category_assignment','order_source_observation',
    'order_line_source_observation','event_link','entity_source_link',
    'source_authority'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE core.%I ADD COLUMN IF NOT EXISTS sync_run_id text CHECK (core.is_ulid(sync_run_id))',
      canonical_table
    );
    EXECUTE format(
      'ALTER TABLE core.%I ALTER COLUMN sync_run_id SET NOT NULL',
      canonical_table
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION core.protect_canonical_sync_run()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,core AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.sync_run_id IS DISTINCT FROM OLD.sync_run_id THEN
    RAISE EXCEPTION 'canonical row lineage is immutable' USING ERRCODE='22000';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE canonical_table text;
BEGIN
  FOREACH canonical_table IN ARRAY ARRAY[
    'location','register','channel','legal_entity','person','customer_account',
    'worker','employment_episode','supplier','product','product_variant',
    'product_category','gl_account','tax_code','stock_location',
    'product_category_assignment','order_source_observation',
    'order_line_source_observation','event_link','entity_source_link',
    'source_authority'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS protect_sync_run ON core.%I',canonical_table);
    EXECUTE format(
      'CREATE TRIGGER protect_sync_run BEFORE UPDATE ON core.%I FOR EACH ROW EXECUTE FUNCTION core.protect_canonical_sync_run()',
      canonical_table
    );
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS semantic_internal.canonical_transform_commits (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  batch_id text NOT NULL CHECK (core.is_ulid(batch_id)),
  sync_run_id text NOT NULL CHECK (core.is_ulid(sync_run_id)),
  connection_id text NOT NULL CHECK (core.is_ulid(connection_id)),
  connector_id text NOT NULL CHECK (connector_id IN ('lightspeed-r','xero','deputy')),
  stream text NOT NULL,
  mapping_version text NOT NULL,
  staged_rows bigint NOT NULL CHECK (staged_rows>=0),
  command_count bigint NOT NULL CHECK (command_count>=0),
  canonical_rows bigint NOT NULL CHECK (canonical_rows>=0),
  metadata_rows bigint NOT NULL CHECK (metadata_rows>=0),
  quality_status text NOT NULL REFERENCES quality.check_status_lookup(value),
  data_ready_through timestamptz,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,batch_id,mapping_version)
);

CREATE TABLE IF NOT EXISTS semantic_internal.canonical_record_state (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  canonical_table text NOT NULL,
  canonical_id text NOT NULL CHECK (core.is_ulid(canonical_id)),
  source_updated_at timestamptz NOT NULL,
  source_version text,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  batch_id text NOT NULL CHECK (core.is_ulid(batch_id)),
  sync_run_id text NOT NULL CHECK (core.is_ulid(sync_run_id)),
  connection_id text NOT NULL CHECK (core.is_ulid(connection_id)),
  source_object_type text NOT NULL,
  source_record_id text NOT NULL,
  mapping_version text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,canonical_table,canonical_id)
);

CREATE TABLE IF NOT EXISTS semantic_internal.identity_observation (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  observation_id text NOT NULL CHECK (core.is_ulid(observation_id)),
  entity_type text NOT NULL REFERENCES core.entity_type_lookup(value),
  connection_id text NOT NULL CHECK (core.is_ulid(connection_id)),
  source_object_type text NOT NULL,
  source_record_id text NOT NULL,
  external_id_digest text CHECK (external_id_digest IS NULL OR external_id_digest ~ '^[a-f0-9]{64}$'),
  deterministic_key_digests jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(deterministic_key_digests)='object'),
  normalized_name_digest text CHECK (normalized_name_digest IS NULL OR normalized_name_digest ~ '^[a-f0-9]{64}$'),
  corroborating_scope_digest text CHECK (corroborating_scope_digest IS NULL OR corroborating_scope_digest ~ '^[a-f0-9]{64}$'),
  sync_run_id text NOT NULL CHECK (core.is_ulid(sync_run_id)),
  source_updated_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,observation_id),
  UNIQUE (tenant_id,entity_type,connection_id,source_object_type,source_record_id)
);

CREATE TABLE IF NOT EXISTS semantic_internal.identity_review_projection_outbox (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  projection_id text NOT NULL CHECK (core.is_ulid(projection_id)),
  task_id text NOT NULL CHECK (core.is_ulid(task_id)),
  suggestion_key text NOT NULL CHECK (suggestion_key ~ '^[a-f0-9]{64}$'),
  entity_type text NOT NULL REFERENCES core.entity_type_lookup(value),
  confidence_band text NOT NULL REFERENCES core.confidence_band_lookup(value),
  candidate_links jsonb NOT NULL CHECK (jsonb_typeof(candidate_links)='array'),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object'),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,projection_id),
  UNIQUE (tenant_id,suggestion_key)
);

CREATE TABLE IF NOT EXISTS semantic_internal.readiness_projection_outbox (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  projection_id text NOT NULL CHECK (core.is_ulid(projection_id)),
  batch_id text NOT NULL CHECK (core.is_ulid(batch_id)),
  connection_id text NOT NULL CHECK (core.is_ulid(connection_id)),
  domain text NOT NULL CHECK (domain ~ '^[a-z][a-z0-9_]*$'),
  state text NOT NULL CHECK (state IN ('validating','ready_partial','ready_complete','degraded','blocked')),
  progress numeric(5,4) NOT NULL CHECK (progress BETWEEN 0 AND 1),
  data_ready_through timestamptz,
  backfill_complete boolean NOT NULL,
  reason_code text,
  reason_detail text,
  evaluated_at timestamptz NOT NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,projection_id)
);

CREATE TABLE IF NOT EXISTS semantic_internal.pipeline_table_stats_projection_outbox (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  projection_id text NOT NULL CHECK (core.is_ulid(projection_id)),
  snapshot_at timestamptz NOT NULL,
  schema_name text NOT NULL CHECK (schema_name IN ('source_lightspeed','source_xero','source_deputy','core','mart')),
  table_name text NOT NULL CHECK (table_name ~ '^[a-z_][a-z0-9_]*$'),
  row_count bigint NOT NULL CHECK (row_count>=0),
  max_event_at timestamptz,
  max_ingested_at timestamptz,
  invariant_status jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(invariant_status)='object'),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,projection_id),
  UNIQUE (tenant_id,snapshot_at,schema_name,table_name)
);

CREATE INDEX IF NOT EXISTS identity_observation_match_idx
  ON semantic_internal.identity_observation (tenant_id,entity_type,active,connection_id);
CREATE INDEX IF NOT EXISTS identity_observation_external_id_idx
  ON semantic_internal.identity_observation (tenant_id,entity_type,external_id_digest,connection_id)
  WHERE active AND external_id_digest IS NOT NULL;
CREATE INDEX IF NOT EXISTS identity_observation_name_scope_idx
  ON semantic_internal.identity_observation (
    tenant_id,entity_type,normalized_name_digest,corroborating_scope_digest,connection_id
  ) WHERE active AND normalized_name_digest IS NOT NULL
      AND corroborating_scope_digest IS NOT NULL;
CREATE INDEX IF NOT EXISTS readiness_projection_pending_idx
  ON semantic_internal.readiness_projection_outbox (tenant_id,created_at) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS identity_projection_pending_idx
  ON semantic_internal.identity_review_projection_outbox (tenant_id,created_at) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS pipeline_projection_pending_idx
  ON semantic_internal.pipeline_table_stats_projection_outbox (tenant_id,snapshot_at) WHERE published_at IS NULL;

CREATE OR REPLACE FUNCTION semantic_internal.generate_identity_review_candidates(p_tenant_id text)
RETURNS bigint LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,core,semantic_internal AS $$
DECLARE inserted_count bigint;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501';
  END IF;
  WITH candidates AS (
    SELECT
      left_row.entity_type,
      left_row.connection_id AS left_connection_id,
      left_row.source_object_type AS left_object_type,
      left_row.source_record_id AS left_record_id,
      right_row.connection_id AS right_connection_id,
      right_row.source_object_type AS right_object_type,
      right_row.source_record_id AS right_record_id,
      CASE
        WHEN left_row.external_id_digest IS NOT NULL AND left_row.external_id_digest=right_row.external_id_digest THEN 'external_id'
        WHEN EXISTS (
          SELECT 1 FROM jsonb_each_text(left_row.deterministic_key_digests) l
          JOIN jsonb_each_text(right_row.deterministic_key_digests) r ON r.key=l.key AND r.value=l.value
        ) THEN 'deterministic_key'
        ELSE 'composite_suggestion'
      END AS method
    FROM semantic_internal.identity_observation left_row
    JOIN semantic_internal.identity_observation right_row
      ON right_row.tenant_id=left_row.tenant_id
     AND right_row.entity_type=left_row.entity_type
     AND right_row.connection_id>left_row.connection_id
     AND right_row.active AND left_row.active
    WHERE left_row.tenant_id=p_tenant_id
      AND (
        (left_row.external_id_digest IS NOT NULL AND left_row.external_id_digest=right_row.external_id_digest)
        OR EXISTS (
          SELECT 1 FROM jsonb_each_text(left_row.deterministic_key_digests) l
          JOIN jsonb_each_text(right_row.deterministic_key_digests) r ON r.key=l.key AND r.value=l.value
        )
        OR (
          left_row.normalized_name_digest IS NOT NULL
          AND left_row.normalized_name_digest=right_row.normalized_name_digest
          AND left_row.corroborating_scope_digest IS NOT NULL
          AND left_row.corroborating_scope_digest=right_row.corroborating_scope_digest
        )
      )
  ), linked AS (
    SELECT candidate.*,
      left_link.canonical_entity_id AS left_entity_id,
      right_link.canonical_entity_id AS right_entity_id,
      md5('identity-review-a|'||concat_ws('|',candidate.entity_type,candidate.left_connection_id,candidate.left_object_type,candidate.left_record_id,candidate.right_connection_id,candidate.right_object_type,candidate.right_record_id,candidate.method))
      ||md5('identity-review-b|'||concat_ws('|',candidate.entity_type,candidate.left_connection_id,candidate.left_object_type,candidate.left_record_id,candidate.right_connection_id,candidate.right_object_type,candidate.right_record_id,candidate.method)) AS suggestion_key
    FROM candidates candidate
    JOIN core.entity_source_link left_link
      ON left_link.tenant_id=p_tenant_id AND left_link.entity_type=candidate.entity_type
     AND left_link.connection_id=candidate.left_connection_id AND left_link.source_object_type=candidate.left_object_type
     AND left_link.source_record_id=candidate.left_record_id AND left_link.match_status='accepted' AND left_link.valid_to IS NULL
    JOIN core.entity_source_link right_link
      ON right_link.tenant_id=p_tenant_id AND right_link.entity_type=candidate.entity_type
     AND right_link.connection_id=candidate.right_connection_id AND right_link.source_object_type=candidate.right_object_type
     AND right_link.source_record_id=candidate.right_record_id AND right_link.match_status='accepted' AND right_link.valid_to IS NULL
    WHERE left_link.canonical_entity_id<>right_link.canonical_entity_id
  )
  INSERT INTO semantic_internal.identity_review_projection_outbox (
    tenant_id,projection_id,task_id,suggestion_key,entity_type,confidence_band,candidate_links,evidence
  )
  SELECT p_tenant_id,
    semantic_internal.deterministic_ulid('identity-projection|'||p_tenant_id||'|'||suggestion_key),
    semantic_internal.deterministic_ulid('identity-task|'||p_tenant_id||'|'||suggestion_key),
    suggestion_key,entity_type,CASE WHEN method='composite_suggestion' THEN 'medium' ELSE 'high' END,
    jsonb_build_array(
      jsonb_build_object('canonical_entity_id',left_entity_id,'connection_id',left_connection_id,'source_object_type',left_object_type,'source_record_id',left_record_id),
      jsonb_build_object('canonical_entity_id',right_entity_id,'connection_id',right_connection_id,'source_object_type',right_object_type,'source_record_id',right_record_id)
    ),
    jsonb_build_object('suggestion_key',suggestion_key,'match_method',method,'summary',CASE WHEN method='composite_suggestion' THEN 'Normalized name and confirmed organisational scope match.' ELSE 'A deterministic cross-source identity key matches.' END)
  FROM linked ON CONFLICT (tenant_id,suggestion_key) DO NOTHING;
  GET DIAGNOSTICS inserted_count=ROW_COUNT;
  RETURN inserted_count;
END $$;

CREATE OR REPLACE FUNCTION quality.run_all_invariants(p_tenant_id text,p_run_id text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,core,mart,quality,ingestion AS $$
DECLARE
  failures bigint;
  total_count bigint;
  matched_count bigint;
  staged_count bigint;
  quarantine_count bigint;
  ratio numeric(19,4);
  difference numeric(19,4);
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501'; END IF;
  IF NOT core.is_ulid(p_run_id) THEN RAISE EXCEPTION 'run id must be a ULID' USING ERRCODE='22023'; END IF;
  PERFORM quality.run_domain_invariants(p_tenant_id,p_run_id);

  INSERT INTO quality.check_result VALUES
    (p_tenant_id,p_run_id,'pk_unique','canonical','passed',0,0,'{"enforced_by":"primary_and_unique_constraints"}',now()),
    (p_tenant_id,p_run_id,'orphan_rate','canonical','passed',0,0,'{"enforced_by":"foreign_keys"}',now()),
    (p_tenant_id,p_run_id,'no_orphan_observations','canonical','passed',0,0,'{"enforced_by":"foreign_keys"}',now())
  ON CONFLICT (tenant_id,run_id,check_id) DO UPDATE SET
    status=excluded.status,observed=excluded.observed,threshold=excluded.threshold,
    details=excluded.details,checked_at=excluded.checked_at;

  SELECT count(*) INTO failures FROM core.location location
  WHERE location.tenant_id=p_tenant_id AND NOT EXISTS (SELECT 1 FROM pg_timezone_names timezone WHERE timezone.name=location.timezone);
  INSERT INTO quality.check_result VALUES (p_tenant_id,p_run_id,'tz_validity','canonical',CASE WHEN failures=0 THEN 'passed' ELSE 'failed' END,failures,0,'{}',now()) ON CONFLICT (tenant_id,run_id,check_id) DO UPDATE SET status=excluded.status,observed=excluded.observed,threshold=excluded.threshold,details=excluded.details,checked_at=excluded.checked_at;

  SELECT count(*) INTO failures FROM core.commerce_order_line line
  WHERE line.tenant_id=p_tenant_id AND abs((line.net_amount_ex_tax+line.tax_amount)-line.net_amount_inc_tax)>0.0001;
  INSERT INTO quality.check_result VALUES (p_tenant_id,p_run_id,'tax_consistency','canonical',CASE WHEN failures=0 THEN 'passed' ELSE 'failed' END,failures,0,'{}',now()) ON CONFLICT (tenant_id,run_id,check_id) DO UPDATE SET status=excluded.status,observed=excluded.observed,threshold=excluded.threshold,details=excluded.details,checked_at=excluded.checked_at;

  SELECT count(*) INTO failures FROM ingestion.quarantine_records quarantine
  WHERE quarantine.tenant_id=p_tenant_id AND quarantine.sync_run_id=p_run_id AND quarantine.error_code='schema_drift' AND quarantine.status='open';
  INSERT INTO quality.check_result VALUES (p_tenant_id,p_run_id,'field_coverage_vs_manifest','canonical',CASE WHEN failures=0 THEN 'passed' ELSE 'blocked' END,failures,0,'{}',now()) ON CONFLICT (tenant_id,run_id,check_id) DO UPDATE SET status=excluded.status,observed=excluded.observed,threshold=excluded.threshold,details=excluded.details,checked_at=excluded.checked_at;

  SELECT coalesce(sum(landing.staged_record_count),0),coalesce(sum(landing.quarantine_count),0)
    INTO staged_count,quarantine_count
    FROM ingestion.landing_commits AS landing
   WHERE landing.tenant_id=p_tenant_id AND landing.sync_run_id=p_run_id AND landing.status='committed';
  INSERT INTO quality.check_result VALUES (
    p_tenant_id,p_run_id,'staging_acceptance','canonical',
    CASE WHEN quarantine_count=0 THEN 'passed' WHEN staged_count=0 THEN 'blocked' ELSE 'warning' END,
    quarantine_count,0,jsonb_build_object('staged_records',staged_count,'quarantined_records',quarantine_count),now()
  ) ON CONFLICT (tenant_id,run_id,check_id) DO UPDATE SET
    status=excluded.status,observed=excluded.observed,threshold=excluded.threshold,
    details=excluded.details,checked_at=excluded.checked_at;

  SELECT count(*) INTO failures FROM core.commerce_order order_row
  WHERE order_row.tenant_id=p_tenant_id AND order_row.status='completed' AND NOT order_row.voided
    AND abs(order_row.net_amount_inc_tax-coalesce((SELECT sum(payment.amount) FROM core.commerce_payment payment WHERE payment.tenant_id=order_row.tenant_id AND payment.order_id=order_row.id AND payment.status='captured'),0))>0.01;
  INSERT INTO quality.check_result VALUES (p_tenant_id,p_run_id,'tender_reconciles','commerce',CASE WHEN failures=0 THEN 'passed' ELSE 'failed' END,failures,0,'{}',now()) ON CONFLICT (tenant_id,run_id,check_id) DO UPDATE SET status=excluded.status,observed=excluded.observed,threshold=excluded.threshold,details=excluded.details,checked_at=excluded.checked_at;

  SELECT count(*) INTO failures FROM core.inventory_balance_snapshot snapshot WHERE snapshot.tenant_id=p_tenant_id AND snapshot.quantity_on_hand<0;
  INSERT INTO quality.check_result VALUES (p_tenant_id,p_run_id,'stock_continuity','inventory',CASE WHEN failures=0 THEN 'passed' ELSE 'warning' END,failures,0,'{"interpretation":"negative on-hand snapshots require review"}',now()) ON CONFLICT (tenant_id,run_id,check_id) DO UPDATE SET status=excluded.status,observed=excluded.observed,threshold=excluded.threshold,details=excluded.details,checked_at=excluded.checked_at;

  SELECT count(*) INTO total_count FROM core.workforce_shift shift_row WHERE shift_row.tenant_id=p_tenant_id AND shift_row.status NOT IN ('cancelled','voided');
  SELECT count(*) INTO matched_count FROM core.workforce_shift shift_row WHERE shift_row.tenant_id=p_tenant_id AND shift_row.status NOT IN ('cancelled','voided') AND EXISTS (
    SELECT 1 FROM core.workforce_time_entry entry WHERE entry.tenant_id=shift_row.tenant_id AND entry.worker_id=shift_row.worker_id AND entry.business_date=shift_row.business_date AND entry.location_id=shift_row.location_id AND entry.status NOT IN ('rejected','voided')
  );
  ratio=CASE WHEN total_count=0 THEN 1 ELSE matched_count::numeric/total_count END;
  INSERT INTO quality.check_result VALUES (p_tenant_id,p_run_id,'shift_timesheet_coverage','workforce',CASE WHEN ratio>=0.8 THEN 'passed' ELSE 'warning' END,ratio,0.8,jsonb_build_object('matched',matched_count,'total',total_count),now()) ON CONFLICT (tenant_id,run_id,check_id) DO UPDATE SET status=excluded.status,observed=excluded.observed,threshold=excluded.threshold,details=excluded.details,checked_at=excluded.checked_at;

  SELECT abs(coalesce(sum(pos.pos_net_sales_ex_gst),0)-coalesce(sum(pos.ledger_accrued_revenue),0)) INTO difference FROM mart.reconciliation_aligned pos WHERE pos.tenant_id=p_tenant_id;
  INSERT INTO quality.check_result VALUES (p_tenant_id,p_run_id,'pos_ledger_tolerance','reconciliation',CASE WHEN difference<=1 THEN 'passed' ELSE 'warning' END,difference,1,'{}',now()) ON CONFLICT (tenant_id,run_id,check_id) DO UPDATE SET status=excluded.status,observed=excluded.observed,threshold=excluded.threshold,details=excluded.details,checked_at=excluded.checked_at;

  INSERT INTO quality.check_result VALUES (p_tenant_id,p_run_id,'status_mapping_total','canonical','passed',0,0,'{"enforced_by":"lookup_constraints_and_pack_mappers"}',now()) ON CONFLICT (tenant_id,run_id,check_id) DO UPDATE SET status=excluded.status,observed=excluded.observed,threshold=excluded.threshold,details=excluded.details,checked_at=excluded.checked_at;
END $$;

CREATE OR REPLACE FUNCTION quality.snapshot_all_pipeline_stats(
  p_tenant_id text,p_snapshot_at timestamptz,p_domains text[],p_source_watermarks jsonb
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,core,quality,semantic_internal AS $$
DECLARE
  item record;
  row_total bigint;
  max_event timestamptz;
  max_ingested timestamptz;
  status jsonb;
  source_total bigint:=0;
  rejected_total bigint:=0;
  observed_total bigint:=0;
  linked_total bigint:=0;
  canonical_total bigint:=0;
  domain_name text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_source_watermarks)<>'object' THEN RAISE EXCEPTION 'source watermarks must be an object' USING ERRCODE='22023'; END IF;
  SELECT coalesce(jsonb_object_agg(latest.check_id,latest.status),'{}'::jsonb) INTO status FROM (
    SELECT DISTINCT ON (check_id) check_id,status FROM quality.check_result WHERE tenant_id=p_tenant_id ORDER BY check_id,checked_at DESC
  ) latest;
  FOR item IN SELECT * FROM (VALUES
    ('core','location','updated_at'),('core','register','updated_at'),('core','channel','updated_at'),('core','legal_entity','updated_at'),
    ('core','person','updated_at'),('core','customer_account','updated_at'),('core','worker','updated_at'),('core','employment_episode','updated_at'),
    ('core','supplier','updated_at'),('core','product','updated_at'),('core','product_variant','updated_at'),('core','product_category','updated_at'),
    ('core','gl_account','updated_at'),('core','tax_code','updated_at'),('core','stock_location','updated_at'),
    ('core','commerce_order','completed_at'),('core','commerce_order_line','completed_at'),('core','commerce_payment','paid_at'),
    ('core','commerce_refund_line','refunded_at'),('core','inventory_movement','occurred_at'),('core','inventory_balance_snapshot','snapshot_at'),
    ('core','purchase_order_line','ordered_at'),('core','finance_journal_line','posted_at'),('core','finance_invoice_line','issued_at'),
    ('core','finance_bank_transaction','transaction_at'),('core','workforce_shift','starts_at'),('core','workforce_time_entry','starts_at'),('core','workforce_leave','starts_at'),
    ('core','product_category_assignment','effective_from'),('core','order_source_observation','valid_from'),
    ('core','order_line_source_observation','created_at'),('core','event_link','created_at'),
    ('core','entity_source_link','valid_from'),('core','source_authority','effective_from'),
    ('mart','sales_day_location','refreshed_at'),('mart','labour_day_location','refreshed_at')
  ) AS tables(schema_name,table_name,event_column)
  LOOP
    IF item.schema_name='mart' THEN
      EXECUTE format('SELECT count(*),max(%I)::timestamptz,max(refreshed_at)::timestamptz FROM %I.%I WHERE tenant_id=$1',item.event_column,item.schema_name,item.table_name)
        INTO row_total,max_event,max_ingested USING p_tenant_id;
    ELSIF item.table_name=ANY(ARRAY[
      'product_category_assignment','order_source_observation',
      'order_line_source_observation','event_link','entity_source_link'
    ]) THEN
      EXECUTE format('SELECT count(*),max(%I)::timestamptz,max(created_at)::timestamptz FROM %I.%I WHERE tenant_id=$1',item.event_column,item.schema_name,item.table_name)
        INTO row_total,max_event,max_ingested USING p_tenant_id;
    ELSE
      EXECUTE format('SELECT count(*),max(%I)::timestamptz,max(updated_at)::timestamptz FROM %I.%I WHERE tenant_id=$1',item.event_column,item.schema_name,item.table_name)
        INTO row_total,max_event,max_ingested USING p_tenant_id;
    END IF;
    INSERT INTO semantic_internal.pipeline_table_stats_projection_outbox (
      tenant_id,projection_id,snapshot_at,schema_name,table_name,row_count,max_event_at,max_ingested_at,invariant_status
    ) VALUES (
      p_tenant_id,semantic_internal.deterministic_ulid('pipeline-stat|'||p_tenant_id||'|'||p_snapshot_at::text||'|'||item.schema_name||'|'||item.table_name),
      p_snapshot_at,item.schema_name,item.table_name,row_total,max_event,max_ingested,status
    ) ON CONFLICT (tenant_id,snapshot_at,schema_name,table_name) DO NOTHING;
  END LOOP;
  FOR item IN
    SELECT table_schema AS schema_name,table_name
    FROM information_schema.tables
    WHERE table_schema IN ('source_lightspeed','source_xero','source_deputy') AND table_type='BASE TABLE'
    ORDER BY table_schema,table_name
  LOOP
    EXECUTE format('SELECT count(*),max(source_updated_at),max(ingested_at) FROM %I.%I WHERE tenant_id=$1',item.schema_name,item.table_name)
      INTO row_total,max_event,max_ingested USING p_tenant_id;
    source_total:=source_total+row_total;
    INSERT INTO semantic_internal.pipeline_table_stats_projection_outbox (
      tenant_id,projection_id,snapshot_at,schema_name,table_name,row_count,max_event_at,max_ingested_at,invariant_status
    ) VALUES (
      p_tenant_id,semantic_internal.deterministic_ulid('pipeline-stat|'||p_tenant_id||'|'||p_snapshot_at::text||'|'||item.schema_name||'|'||item.table_name),
      p_snapshot_at,item.schema_name,item.table_name,row_total,max_event,max_ingested,status
    ) ON CONFLICT (tenant_id,snapshot_at,schema_name,table_name) DO NOTHING;
  END LOOP;
  SELECT count(*) INTO rejected_total FROM ingestion.quarantine_records
   WHERE tenant_id=p_tenant_id AND status='open';
  SELECT count(*) INTO observed_total FROM semantic_internal.identity_observation
   WHERE tenant_id=p_tenant_id AND active;
  SELECT count(*) INTO linked_total FROM core.entity_source_link
   WHERE tenant_id=p_tenant_id AND match_status='accepted' AND valid_to IS NULL;
  FOREACH domain_name IN ARRAY (
    CASE WHEN cardinality(p_domains)>0 THEN p_domains
         ELSE ARRAY['canonical']::text[] END
  ) LOOP
    IF domain_name=ANY(ARRAY[
      'location','register','channel','legal_entity','person','customer_account','worker','employment_episode',
      'supplier','product','product_variant','product_category','gl_account','tax_code','stock_location',
      'commerce_order','commerce_order_line','commerce_payment','commerce_refund_line','inventory_movement',
      'inventory_balance_snapshot','purchase_order_line','finance_journal_line','finance_invoice_line',
      'finance_bank_transaction','workforce_shift','workforce_time_entry','workforce_leave',
      'product_category_assignment','order_source_observation','order_line_source_observation',
      'event_link','entity_source_link','source_authority'
    ]) THEN
      EXECUTE format('SELECT count(*) FROM core.%I WHERE tenant_id=$1',domain_name)
        INTO canonical_total USING p_tenant_id;
    ELSE
      SELECT coalesce(sum(latest_count),0) INTO canonical_total FROM (
        SELECT row_count AS latest_count
          FROM semantic_internal.pipeline_table_stats_projection_outbox
         WHERE tenant_id=p_tenant_id AND snapshot_at=p_snapshot_at AND schema_name='core'
      ) AS totals;
    END IF;
    PERFORM quality.snapshot_pipeline_stats(
      p_tenant_id,p_snapshot_at,domain_name,source_total,canonical_total,rejected_total,
      observed_total,linked_total,p_source_watermarks,status
    );
  END LOOP;
END $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'canonical_transform_commits','canonical_record_state','identity_observation','identity_review_projection_outbox',
    'readiness_projection_outbox','pipeline_table_stats_projection_outbox'
  ] LOOP
    EXECUTE format('ALTER TABLE semantic_internal.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE semantic_internal.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON semantic_internal.%I',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON semantic_internal.%I USING (tenant_id=core.current_tenant_id()) WITH CHECK (tenant_id=core.current_tenant_id())',table_name);
  END LOOP;
END $$;

REVOKE ALL ON semantic_internal.canonical_transform_commits,semantic_internal.canonical_record_state,semantic_internal.identity_observation,
  semantic_internal.identity_review_projection_outbox,semantic_internal.readiness_projection_outbox,
  semantic_internal.pipeline_table_stats_projection_outbox FROM PUBLIC,semantic_ro;
GRANT SELECT,INSERT,UPDATE,DELETE ON semantic_internal.canonical_transform_commits,semantic_internal.canonical_record_state,semantic_internal.identity_observation,
  semantic_internal.identity_review_projection_outbox,semantic_internal.readiness_projection_outbox,
  semantic_internal.pipeline_table_stats_projection_outbox,semantic_internal.source_field_allowlist TO transform_rw;
GRANT SELECT ON semantic_internal.canonical_transform_commits,semantic_internal.canonical_record_state,semantic_internal.identity_observation,
  semantic_internal.identity_review_projection_outbox,semantic_internal.readiness_projection_outbox,
  semantic_internal.pipeline_table_stats_projection_outbox TO diagnostic_ro;
GRANT SELECT ON core.employment_status_lookup,core.purchase_order_status_lookup,
  core.finance_status_lookup,core.workforce_shift_status_lookup,
  core.workforce_time_status_lookup,core.workforce_leave_status_lookup,
  core.inventory_movement_type_lookup TO transform_rw,semantic_ro,diagnostic_ro;
REVOKE ALL ON FUNCTION semantic_internal.assert_transform_runtime_boundary() FROM PUBLIC;
GRANT USAGE ON SCHEMA semantic_internal TO transform_rw;
GRANT EXECUTE ON FUNCTION semantic_internal.assert_transform_runtime_boundary(),
  semantic_internal.generate_identity_review_candidates(text),
  quality.run_all_invariants(text,text),quality.snapshot_all_pipeline_stats(text,timestamptz,text[],jsonb) TO transform_rw;

COMMIT;
