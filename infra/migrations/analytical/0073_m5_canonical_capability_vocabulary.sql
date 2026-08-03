BEGIN;

CREATE TABLE IF NOT EXISTS semantic_internal.capability_vocabulary (
  capability text PRIMARY KEY CHECK (capability ~ '^[a-z][a-z0-9_.]*$'),
  semantic_required boolean NOT NULL,
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500)
);

INSERT INTO semantic_internal.capability_vocabulary (capability,semantic_required,description) VALUES
  ('commerce.order_lines',true,'Canonical sellable order-line observations are queryable.'),
  ('commerce.order_lines.cost',true,'Order-line unit or total cost is available with measured coverage.'),
  ('commerce.order_lines.discounts',true,'Order-line gross and discount components are available.'),
  ('commerce.orders',true,'Canonical commercial order headers are queryable.'),
  ('commerce.orders.customer',true,'Orders support customer attribution with measured coverage.'),
  ('commerce.payments',true,'Canonical POS tender or payment events are queryable.'),
  ('commerce.refunds',true,'Canonical refund allocations linked to original lines are queryable.'),
  ('finance.bank_transactions',true,'Canonical bank transaction facts are queryable.'),
  ('finance.invoices',true,'Canonical sales invoice and supplier bill lines are queryable.'),
  ('finance.journals',true,'Posted statutory journal lines are queryable.'),
  ('finance.journals.tax',true,'Posted journal tax components are queryable.'),
  ('inventory.balances',true,'Canonical stock balance snapshots are queryable.'),
  ('inventory.cost',true,'Inventory cost or value has measured non-null coverage.'),
  ('inventory.movements',true,'Canonical stock movement events are queryable.'),
  ('inventory.stocktakes',true,'Stocktake-linked movement observations have measured coverage.'),
  ('workforce.shifts',true,'Canonical planned work intervals are queryable.'),
  ('workforce.time_entries',true,'Canonical actual worked intervals are queryable.'),
  ('workforce.time_entries.cost',true,'Time-entry labour cost has measured non-null coverage.'),
  ('workforce.time_entries.overtime',true,'Observed overtime duration is queryable without synthetic values.'),
  ('connector.variant.r_series',false,'The connected Lightspeed account is verified as Retail R-Series.'),
  ('commerce.order_lines.worker_attribution',false,'Order lines support worker attribution with measured coverage.'),
  ('finance.settings',false,'Accounting organisation and tax settings are available.'),
  ('finance.payments',false,'Source settlement allocation observations are available.'),
  ('workforce.leave',false,'Canonical workforce leave intervals are queryable.'),
  ('source.webhooks',false,'Authenticated source webhooks are provisioned.'),
  ('source.webhooks.contacts',false,'Authenticated contact webhooks are supported.'),
  ('source.webhooks.invoices',false,'Authenticated invoice webhooks are supported.'),
  ('source.webhooks.credit_notes',false,'Authenticated credit-note webhooks are supported.')
ON CONFLICT (capability) DO UPDATE SET
  semantic_required=excluded.semantic_required,
  description=excluded.description;

ALTER TABLE semantic_internal.source_field_allowlist
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz,
  ADD COLUMN IF NOT EXISTS deactivation_reason text;

-- Preserve every connector page/stream observation. quality.check_result is a
-- run-level roll-up whose key deliberately has no stream, so writing pages
-- directly to it would allow the last stream to erase an earlier blocked result.
CREATE TABLE IF NOT EXISTS quality.connector_check_observation (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  run_id text NOT NULL CHECK (core.is_ulid(run_id)),
  batch_id text NOT NULL CHECK (core.is_ulid(batch_id)),
  check_id text NOT NULL CHECK (check_id IN (
    'cursor_completeness','scope_available','retention_limit_recorded',
    'webhook_gap_recovered','delete_handling','schema_drift','enum_drift'
  )),
  connection_id text NOT NULL CHECK (core.is_ulid(connection_id)),
  connector_id text NOT NULL CHECK (connector_id IN ('lightspeed-r','xero','deputy')),
  stream text NOT NULL CHECK (stream ~ '^[a-z][a-z0-9_]*$'),
  status text NOT NULL REFERENCES quality.check_status_lookup(value),
  observed numeric(19,4),
  threshold numeric(19,4),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details)='object'),
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,run_id,batch_id,check_id,connection_id,stream)
);

ALTER TABLE quality.connector_check_observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.connector_check_observation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON quality.connector_check_observation;
CREATE POLICY tenant_isolation ON quality.connector_check_observation
  USING (tenant_id=core.current_tenant_id())
  WITH CHECK (tenant_id=core.current_tenant_id());

ALTER TABLE semantic_internal.tenant_capability
  ADD COLUMN IF NOT EXISTS support text,
  ADD COLUMN IF NOT EXISTS reason_detail text,
  ADD COLUMN IF NOT EXISTS coverage jsonb,
  ADD COLUMN IF NOT EXISTS required_scopes text[];

UPDATE semantic_internal.tenant_capability
   SET support=CASE
         WHEN available AND reason_code='partial_coverage' THEN 'partial'
         WHEN available THEN 'full'
         WHEN reason_code='live_probe_required' THEN 'unknown'
         ELSE 'unavailable'
       END,
       coverage=coalesce(coverage,'{}'::jsonb),
       required_scopes=coalesce(required_scopes,'{}'::text[])
 WHERE support IS NULL OR coverage IS NULL OR required_scopes IS NULL;

ALTER TABLE semantic_internal.tenant_capability
  ALTER COLUMN support SET DEFAULT 'unknown',
  ALTER COLUMN support SET NOT NULL,
  ALTER COLUMN coverage SET DEFAULT '{}'::jsonb,
  ALTER COLUMN coverage SET NOT NULL,
  ALTER COLUMN required_scopes SET DEFAULT '{}'::text[],
  ALTER COLUMN required_scopes SET NOT NULL;

WITH legacy AS (
  SELECT tenant_id,
         CASE capability
           WHEN 'commerce.order_lines.unit_cost' THEN 'commerce.order_lines.cost'
           WHEN 'inventory.current_stock' THEN 'inventory.balances'
           WHEN 'inventory.historical_movements' THEN 'inventory.movements'
           WHEN 'workforce.rosters' THEN 'workforce.shifts'
           WHEN 'workforce.timesheets' THEN 'workforce.time_entries'
           WHEN 'workforce.timesheets.cost' THEN 'workforce.time_entries.cost'
           WHEN 'finance.general_ledger' THEN 'finance.journals'
         END AS capability,
         source_key,connection_id,connector_id,available,support,reason_code,
         reason_detail,coverage,required_scopes,pack_version,source_watermark,evaluated_at
    FROM semantic_internal.tenant_capability
   WHERE capability IN (
     'commerce.order_lines.unit_cost','inventory.current_stock',
     'inventory.historical_movements','workforce.rosters','workforce.timesheets',
     'workforce.timesheets.cost','finance.general_ledger'
   )
)
INSERT INTO semantic_internal.tenant_capability (
  tenant_id,capability,source_key,connection_id,connector_id,available,support,
  reason_code,reason_detail,coverage,required_scopes,pack_version,source_watermark,evaluated_at
)
SELECT tenant_id,capability,source_key,connection_id,connector_id,available,support,
       reason_code,reason_detail,coverage,required_scopes,pack_version,source_watermark,evaluated_at
  FROM legacy
 WHERE capability IS NOT NULL
ON CONFLICT (tenant_id,capability,source_key) DO UPDATE SET
  available=excluded.available,support=excluded.support,reason_code=excluded.reason_code,
  reason_detail=excluded.reason_detail,coverage=excluded.coverage,
  required_scopes=excluded.required_scopes,pack_version=excluded.pack_version,
  source_watermark=greatest(semantic_internal.tenant_capability.source_watermark,excluded.source_watermark),
  evaluated_at=greatest(semantic_internal.tenant_capability.evaluated_at,excluded.evaluated_at);

DELETE FROM semantic_internal.tenant_capability
 WHERE capability IN (
   'commerce.order_lines.unit_cost','inventory.current_stock',
   'inventory.historical_movements','workforce.rosters','workforce.timesheets',
   'workforce.timesheets.cost','finance.general_ledger'
 );

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid='semantic_internal.tenant_capability'::regclass
       AND conname='tenant_capability_support_check'
  ) THEN
    ALTER TABLE semantic_internal.tenant_capability
      ADD CONSTRAINT tenant_capability_support_check
      CHECK (support IN ('full','partial','unavailable','unknown'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid='semantic_internal.tenant_capability'::regclass
       AND conname='tenant_capability_available_support_check'
  ) THEN
    ALTER TABLE semantic_internal.tenant_capability
      ADD CONSTRAINT tenant_capability_available_support_check
      CHECK (available=(support IN ('full','partial')));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid='semantic_internal.tenant_capability'::regclass
       AND conname='tenant_capability_coverage_object_check'
  ) THEN
    ALTER TABLE semantic_internal.tenant_capability
      ADD CONSTRAINT tenant_capability_coverage_object_check
      CHECK (jsonb_typeof(coverage)='object');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid='semantic_internal.tenant_capability'::regclass
       AND conname='tenant_capability_vocabulary_fkey'
  ) THEN
    ALTER TABLE semantic_internal.tenant_capability
      ADD CONSTRAINT tenant_capability_vocabulary_fkey
      FOREIGN KEY (capability)
      REFERENCES semantic_internal.capability_vocabulary(capability);
  END IF;
END $$;

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
      -- Live observations are page-local and workers are replicated. For the
      -- same pack, a later page/restarted replica that simply does not observe
      -- an optional field must not erase stronger prior evidence. Explicit
      -- unavailable evidence still revokes support, and a new pack version may
      -- legitimately publish a downgrade.
      WHEN semantic_internal.tenant_capability.pack_version=excluded.pack_version
       AND (
         (semantic_internal.tenant_capability.support='full' AND excluded.support IN ('partial','unknown'))
         OR (semantic_internal.tenant_capability.support='partial' AND excluded.support='unknown')
       )
        THEN semantic_internal.tenant_capability.available
      ELSE excluded.available
    END,
    support=CASE
      WHEN semantic_internal.tenant_capability.pack_version=excluded.pack_version
       AND (
         (semantic_internal.tenant_capability.support='full' AND excluded.support IN ('partial','unknown'))
         OR (semantic_internal.tenant_capability.support='partial' AND excluded.support='unknown')
       )
        THEN semantic_internal.tenant_capability.support
      ELSE excluded.support
    END,
    reason_code=CASE
      WHEN semantic_internal.tenant_capability.pack_version=excluded.pack_version
       AND (
         (semantic_internal.tenant_capability.support='full' AND excluded.support IN ('partial','unknown'))
         OR (semantic_internal.tenant_capability.support='partial' AND excluded.support='unknown')
       )
        THEN semantic_internal.tenant_capability.reason_code
      ELSE excluded.reason_code
    END,
    reason_detail=CASE
      WHEN semantic_internal.tenant_capability.pack_version=excluded.pack_version
       AND (
         (semantic_internal.tenant_capability.support='full' AND excluded.support IN ('partial','unknown'))
         OR (semantic_internal.tenant_capability.support='partial' AND excluded.support='unknown')
       )
        THEN semantic_internal.tenant_capability.reason_detail
      ELSE excluded.reason_detail
    END,
    coverage=CASE
      WHEN semantic_internal.tenant_capability.pack_version=excluded.pack_version
       AND (
         (semantic_internal.tenant_capability.support='full' AND excluded.support IN ('partial','unknown'))
         OR (semantic_internal.tenant_capability.support='partial' AND excluded.support='unknown')
       )
        THEN semantic_internal.tenant_capability.coverage
      ELSE excluded.coverage
    END,
    required_scopes=excluded.required_scopes,
    pack_version=excluded.pack_version,
    source_watermark=greatest(semantic_internal.tenant_capability.source_watermark,excluded.source_watermark),
    evaluated_at=now();
  GET DIAGNOSTICS published=ROW_COUNT;
  RETURN published;
END;
$$;

CREATE OR REPLACE FUNCTION quality.publish_connector_quality_results(
  p_tenant_id text,
  p_run_id text,
  p_batch_id text,
  p_connection_id text,
  p_connector_id text,
  p_stream text,
  p_results jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE published integer;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id<>core.current_tenant_id()
     OR NOT core.is_ulid(p_tenant_id) OR NOT core.is_ulid(p_run_id)
     OR NOT core.is_ulid(p_batch_id)
     OR NOT core.is_ulid(p_connection_id)
     OR p_connector_id NOT IN ('lightspeed-r','xero','deputy')
     OR p_stream IS NULL OR p_stream !~ '^[a-z][a-z0-9_]*$'
     OR p_results IS NULL OR jsonb_typeof(p_results)<>'array'
     OR jsonb_array_length(p_results)<>7 THEN
    RAISE EXCEPTION 'connector quality publication input is invalid' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_results) AS item(value)
     WHERE jsonb_typeof(item.value)<>'object'
        OR item.value->>'checkId' NOT IN (
          'cursor_completeness','scope_available','retention_limit_recorded',
          'webhook_gap_recovered','delete_handling','schema_drift','enum_drift'
        )
        OR item.value->>'status' NOT IN ('passed','warning','failed','blocked')
        OR jsonb_typeof(coalesce(item.value->'details','{}'::jsonb))<>'object'
        OR (item.value ? 'observed' AND (item.value->>'observed') !~ '^-?[0-9]+([.][0-9]+)?$')
        OR (item.value ? 'threshold' AND (item.value->>'threshold') !~ '^-?[0-9]+([.][0-9]+)?$')
  ) OR (
    SELECT count(DISTINCT item.value->>'checkId')
      FROM jsonb_array_elements(p_results) AS item(value)
  )<>7 THEN
    RAISE EXCEPTION 'connector quality publication contains invalid or duplicate results' USING ERRCODE='22023';
  END IF;

  INSERT INTO quality.connector_check_observation (
    tenant_id,run_id,batch_id,check_id,connection_id,connector_id,stream,
    status,observed,threshold,details,checked_at
  )
  SELECT p_tenant_id,p_run_id,p_batch_id,item.value->>'checkId',p_connection_id,
         p_connector_id,p_stream,item.value->>'status',
         CASE WHEN item.value ? 'observed' THEN (item.value->>'observed')::numeric ELSE NULL END,
         CASE WHEN item.value ? 'threshold' THEN (item.value->>'threshold')::numeric ELSE NULL END,
         coalesce(item.value->'details','{}'::jsonb),now()
    FROM jsonb_array_elements(p_results) AS item(value)
  ON CONFLICT (tenant_id,run_id,batch_id,check_id,connection_id,stream) DO UPDATE SET
    connector_id=excluded.connector_id,status=excluded.status,observed=excluded.observed,
    threshold=excluded.threshold,details=excluded.details,checked_at=excluded.checked_at;
  GET DIAGNOSTICS published=ROW_COUNT;

  -- Rebuild all seven current-run roll-ups from the immutable page/stream
  -- evidence. The status order matches semantic health evaluation: blocked is
  -- worst, followed by failed, warning, and passed.
  WITH requested AS (
    SELECT DISTINCT item.value->>'checkId' AS check_id
      FROM jsonb_array_elements(p_results) AS item(value)
  ), rollup AS (
    SELECT observation.check_id,
           CASE
             WHEN bool_or(observation.status='blocked') THEN 'blocked'
             WHEN bool_or(observation.status='failed') THEN 'failed'
             WHEN bool_or(observation.status='warning') THEN 'warning'
             ELSE 'passed'
           END AS status,
           sum(observation.observed) AS observed,
           max(observation.threshold) AS threshold,
           jsonb_build_object(
             'reason_code','connector_run_rollup',
             'observation_count',count(*),
             'observations',jsonb_agg(jsonb_build_object(
               'batch_id',observation.batch_id,
               'connection_id',observation.connection_id,
               'connector_id',observation.connector_id,
               'stream',observation.stream,
               'status',observation.status,
               'observed',observation.observed,
               'threshold',observation.threshold,
               'details',observation.details,
               'checked_at',observation.checked_at
             ) ORDER BY observation.connector_id,observation.connection_id,
                        observation.stream,observation.batch_id)
           ) AS details,
           max(observation.checked_at) AS checked_at
      FROM quality.connector_check_observation AS observation
      JOIN requested USING (check_id)
     WHERE observation.tenant_id=p_tenant_id
       AND observation.run_id=p_run_id
     GROUP BY observation.check_id
  )
  INSERT INTO quality.check_result (
    tenant_id,run_id,check_id,domain,status,observed,threshold,details,checked_at
  )
  SELECT p_tenant_id,p_run_id,check_id,'connector',status,observed,threshold,details,checked_at
    FROM rollup
  ON CONFLICT (tenant_id,run_id,check_id) DO UPDATE SET
    domain=excluded.domain,status=excluded.status,observed=excluded.observed,
    threshold=excluded.threshold,details=excluded.details,checked_at=excluded.checked_at;
  RETURN published;
END;
$$;

REVOKE ALL ON semantic_internal.capability_vocabulary,quality.connector_check_observation FROM PUBLIC;
GRANT USAGE ON SCHEMA semantic_internal,quality TO ingest_rw;
GRANT SELECT ON semantic_internal.capability_vocabulary TO ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro;
GRANT SELECT ON quality.connector_check_observation TO transform_rw,semantic_ro,diagnostic_ro;
REVOKE ALL ON FUNCTION semantic_internal.publish_connector_capability_observations(text,text,text,text,text,timestamptz,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION semantic_internal.publish_connector_capability_observations(text,text,text,text,text,timestamptz,jsonb) TO ingest_rw;
REVOKE ALL ON FUNCTION quality.publish_connector_quality_results(text,text,text,text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quality.publish_connector_quality_results(text,text,text,text,text,text,jsonb) TO ingest_rw;

COMMIT;
