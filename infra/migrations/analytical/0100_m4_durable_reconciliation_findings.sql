BEGIN;

-- Reconciliation findings are user-facing daily exceptions. Their severity,
-- lifecycle and tolerance are migration-owned vocabularies rather than
-- application literals.
CREATE TABLE IF NOT EXISTS quality.finding_severity_lookup (
  value text PRIMARY KEY,
  description text NOT NULL
);
INSERT INTO quality.finding_severity_lookup(value,description) VALUES
  ('info','Informational finding'),
  ('warning','Finding requires review'),
  ('error','Finding blocks a governed result')
ON CONFLICT(value) DO UPDATE SET description=excluded.description;

CREATE TABLE IF NOT EXISTS quality.finding_status_lookup (
  value text PRIMARY KEY,
  description text NOT NULL
);
INSERT INTO quality.finding_status_lookup(value,description) VALUES
  ('open','The variance is present in the latest reconciliation run'),
  ('resolved','A later reconciliation run no longer observes the variance')
ON CONFLICT(value) DO UPDATE SET description=excluded.description;

CREATE TABLE IF NOT EXISTS quality.reconciliation_finding_policy (
  check_id text PRIMARY KEY REFERENCES quality.check_expectation(check_id),
  tolerance numeric(19,4) NOT NULL CHECK (tolerance>=0),
  description text NOT NULL
);
INSERT INTO quality.reconciliation_finding_policy(check_id,tolerance,description) VALUES
  ('pos_ledger_tolerance',1.0000,'Absolute POS-to-ledger daily variance in account currency.'),
  ('pos_bank_tolerance',0.0500,'Absolute POS-tender-to-bank-settlement daily variance in account currency.')
ON CONFLICT(check_id) DO UPDATE SET
  tolerance=excluded.tolerance,
  description=excluded.description;

ALTER TABLE quality.finding
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS last_observed_run_id text,
  ADD COLUMN IF NOT EXISTS last_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolution_run_id text;
-- The migration owner is also the table owner, but FORCE RLS deliberately
-- subjects it to the tenant policy. This one-time, all-tenant lifecycle
-- backfill therefore runs with FORCE disabled inside the migration's atomic
-- transaction. RLS remains enabled for every non-owner role throughout, and
-- FORCE is restored before the DDL can become visible to another session.
ALTER TABLE quality.finding NO FORCE ROW LEVEL SECURITY;
UPDATE quality.finding
   SET last_observed_run_id=coalesce(last_observed_run_id,run_id),
       last_observed_at=coalesce(last_observed_at,created_at);
ALTER TABLE quality.finding FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.finding
  ALTER COLUMN last_observed_run_id SET NOT NULL,
  ALTER COLUMN last_observed_at SET NOT NULL;

ALTER TABLE quality.finding
  DROP CONSTRAINT IF EXISTS quality_finding_severity_fk,
  ADD CONSTRAINT quality_finding_severity_fk
    FOREIGN KEY(severity) REFERENCES quality.finding_severity_lookup(value) NOT VALID;
ALTER TABLE quality.finding VALIDATE CONSTRAINT quality_finding_severity_fk;
ALTER TABLE quality.finding DROP CONSTRAINT IF EXISTS finding_severity_check;

ALTER TABLE quality.finding
  DROP CONSTRAINT IF EXISTS quality_finding_status_fk,
  ADD CONSTRAINT quality_finding_status_fk
    FOREIGN KEY(status) REFERENCES quality.finding_status_lookup(value) NOT VALID;
ALTER TABLE quality.finding VALIDATE CONSTRAINT quality_finding_status_fk;
ALTER TABLE quality.finding
  DROP CONSTRAINT IF EXISTS quality_finding_lifecycle_check,
  ADD CONSTRAINT quality_finding_lifecycle_check CHECK (
    (status='open' AND resolved_at IS NULL AND resolution_run_id IS NULL)
    OR
    (status='resolved' AND resolved_at IS NOT NULL AND resolution_run_id IS NOT NULL)
  );
CREATE INDEX IF NOT EXISTS quality_finding_open_check_idx
  ON quality.finding(tenant_id,check_id,entity_type,entity_id)
  WHERE status='open';

-- Only the migration-owned materialiser calls this function. The identifier
-- excludes run_id so the same day/location exception is reopened or refreshed,
-- never duplicated on retries or subsequent nightly runs.
CREATE OR REPLACE FUNCTION quality.upsert_reconciliation_finding(
  p_tenant_id text,
  p_run_id text,
  p_check_id text,
  p_entity_id text,
  p_business_date date,
  p_location_id text,
  p_currency text,
  p_variance numeric,
  p_details jsonb
) RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE finding_id text;
DECLARE tolerance_value numeric;
DECLARE affected integer;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id()
     OR p_run_id IS NULL OR NOT core.is_ulid(p_run_id)
     OR p_entity_id IS NULL OR p_entity_id !~ '^[a-f0-9]{32}$'
     OR p_business_date IS NULL
     OR (p_location_id IS NOT NULL AND NOT core.is_ulid(p_location_id))
     OR (p_currency IS NOT NULL AND NOT core.is_currency(p_currency))
     OR p_variance IS NULL
     OR jsonb_typeof(p_details) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'reconciliation finding input is invalid' USING ERRCODE='22023';
  END IF;
  SELECT policy.tolerance INTO tolerance_value
    FROM quality.reconciliation_finding_policy policy
   WHERE policy.check_id=p_check_id;
  IF tolerance_value IS NULL OR abs(p_variance)<=tolerance_value THEN
    RAISE EXCEPTION 'reconciliation finding is not above its governed tolerance'
      USING ERRCODE='22023';
  END IF;

  finding_id:=semantic_internal.deterministic_ulid(
    'reconciliation-finding|'||p_tenant_id||'|'||p_check_id||'|'||p_entity_id
  );
  INSERT INTO quality.finding AS existing(
    tenant_id,id,run_id,check_id,entity_type,entity_id,severity,evidence,created_at,
    status,last_observed_run_id,last_observed_at,resolved_at,resolution_run_id
  ) VALUES (
    p_tenant_id,finding_id,p_run_id,p_check_id,'reconciliation_day_location',p_entity_id,
    'warning',
    jsonb_strip_nulls(jsonb_build_object(
      'schemaVersion',2,
      'businessDate',p_business_date,
      'locationId',p_location_id,
      'currency',p_currency,
      'variance',p_variance,
      'absoluteVariance',abs(p_variance),
      'tolerance',tolerance_value,
      'aboveTolerance',true,
      'details',p_details
    )),
    now(),'open',p_run_id,now(),NULL,NULL
  )
  ON CONFLICT(tenant_id,id) DO UPDATE SET
    severity=excluded.severity,
    evidence=excluded.evidence,
    status='open',
    last_observed_run_id=excluded.last_observed_run_id,
    last_observed_at=excluded.last_observed_at,
    resolved_at=NULL,
    resolution_run_id=NULL
  WHERE existing.check_id=excluded.check_id
    AND existing.entity_type=excluded.entity_type
    AND existing.entity_id=excluded.entity_id;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>1 THEN
    RAISE EXCEPTION 'deterministic reconciliation finding identity collided'
      USING ERRCODE='23505';
  END IF;
  RETURN finding_id;
END;
$$;

CREATE OR REPLACE FUNCTION quality.resolve_reconciliation_findings(
  p_tenant_id text,
  p_run_id text,
  p_check_id text,
  p_active_entity_ids text[]
) RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE resolved_count integer;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id()
     OR p_run_id IS NULL OR NOT core.is_ulid(p_run_id)
     OR NOT EXISTS (
       SELECT 1 FROM quality.reconciliation_finding_policy policy
        WHERE policy.check_id=p_check_id
     )
     OR p_active_entity_ids IS NULL
     OR EXISTS (
       SELECT 1 FROM unnest(p_active_entity_ids) AS active(entity_id)
        WHERE active.entity_id IS NULL OR active.entity_id !~ '^[a-f0-9]{32}$'
     ) THEN
    RAISE EXCEPTION 'reconciliation finding resolution input is invalid' USING ERRCODE='22023';
  END IF;
  UPDATE quality.finding finding
     SET status='resolved',resolved_at=now(),resolution_run_id=p_run_id
   WHERE finding.tenant_id=p_tenant_id
     AND finding.check_id=p_check_id
     AND finding.entity_type='reconciliation_day_location'
     AND finding.status='open'
     AND NOT (finding.entity_id=ANY(p_active_entity_ids));
  GET DIAGNOSTICS resolved_count=ROW_COUNT;
  RETURN resolved_count;
END;
$$;

CREATE OR REPLACE FUNCTION quality.materialise_reconciliation_findings(
  p_tenant_id text,
  p_run_id text,
  p_check_id text
) RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE row_value record;
DECLARE active_ids text[]:=ARRAY[]::text[];
DECLARE finding_count integer:=0;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id()
     OR p_run_id IS NULL OR NOT core.is_ulid(p_run_id)
     OR NOT EXISTS (
       SELECT 1 FROM quality.reconciliation_finding_policy policy
        WHERE policy.check_id=p_check_id
     ) THEN
    RAISE EXCEPTION 'reconciliation materialisation input is invalid' USING ERRCODE='22023';
  END IF;

  IF p_check_id='pos_ledger_tolerance' THEN
    FOR row_value IN
      SELECT aligned.id,aligned.business_date,aligned.location_id,
             aligned.pos_net_sales_ex_gst,aligned.ledger_accrued_revenue,
             aligned.pos_net_sales_ex_gst-aligned.ledger_accrued_revenue AS variance
        FROM mart.reconciliation_aligned aligned
        JOIN quality.reconciliation_finding_policy policy
          ON policy.check_id=p_check_id
       WHERE aligned.tenant_id=p_tenant_id
         AND abs(aligned.pos_net_sales_ex_gst-aligned.ledger_accrued_revenue)>policy.tolerance
       ORDER BY aligned.business_date,aligned.location_id,aligned.id
    LOOP
      active_ids:=array_append(active_ids,row_value.id);
      PERFORM quality.upsert_reconciliation_finding(
        p_tenant_id,p_run_id,p_check_id,row_value.id,row_value.business_date,
        row_value.location_id,NULL,row_value.variance,
        jsonb_build_object(
          'measurement','daily_pos_ledger_variance',
          'posNetSalesExGst',row_value.pos_net_sales_ex_gst,
          'ledgerAccruedRevenue',row_value.ledger_accrued_revenue
        )
      );
      finding_count:=finding_count+1;
    END LOOP;
  ELSIF p_check_id='pos_bank_tolerance' THEN
    FOR row_value IN
      SELECT aligned.id,aligned.business_date,aligned.settlement_date,
             aligned.location_id,aligned.currency,aligned.pos_tender_amount,
             aligned.bank_settlement_amount,aligned.settlement_variance,
             aligned.evidence_status
        FROM mart.settlement_reconciliation_aligned aligned
        JOIN quality.reconciliation_finding_policy policy
          ON policy.check_id=p_check_id
       WHERE aligned.tenant_id=p_tenant_id
         AND aligned.bank_settlement_amount IS NOT NULL
         AND abs(aligned.settlement_variance)>policy.tolerance
       ORDER BY aligned.business_date,aligned.location_id,aligned.currency,aligned.id
    LOOP
      active_ids:=array_append(active_ids,row_value.id);
      PERFORM quality.upsert_reconciliation_finding(
        p_tenant_id,p_run_id,p_check_id,row_value.id,row_value.business_date,
        row_value.location_id,row_value.currency,row_value.settlement_variance,
        jsonb_build_object(
          'measurement','daily_tender_bank_variance',
          'settlementDate',row_value.settlement_date,
          'posTenderAmount',row_value.pos_tender_amount,
          'bankSettlementAmount',row_value.bank_settlement_amount,
          'evidenceStatus',row_value.evidence_status
        )
      );
      finding_count:=finding_count+1;
    END LOOP;
  END IF;

  PERFORM quality.resolve_reconciliation_findings(
    p_tenant_id,p_run_id,p_check_id,active_ids
  );
  RETURN finding_count;
END;
$$;

CREATE OR REPLACE FUNCTION quality.record_check(
  p_tenant_id text,
  p_run_id text,
  p_check_id text,
  p_domain text,
  p_status text,
  p_observed numeric,
  p_threshold numeric,
  p_details jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog,core,quality
AS $$
DECLARE stock record;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501';
  END IF;
  IF NOT core.is_ulid(p_run_id) THEN
    RAISE EXCEPTION 'run id must be a ULID' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(p_details) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'quality details must be an object' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM quality.check_expectation expectation
     WHERE expectation.check_id=p_check_id AND expectation.domain=p_domain
  ) THEN
    RAISE EXCEPTION 'unknown quality check % for domain %',p_check_id,p_domain
      USING ERRCODE='22023';
  END IF;

  -- Migration 0085 deliberately replaced the broad invariant runner's legacy
  -- negative-only inventory result at this single write seam. Carry that
  -- behavior forward whenever this function is replaced; otherwise a later
  -- CREATE OR REPLACE silently reintroduces the incomplete stock check.
  IF p_check_id='stock_continuity' AND p_domain='inventory' THEN
    SELECT * INTO STRICT stock FROM quality.compute_stock_continuity(p_tenant_id);
    p_status:=stock.status;
    p_observed:=stock.observed;
    p_threshold:=0;
    p_details:=stock.details;
  END IF;

  INSERT INTO quality.check_result(
    tenant_id,run_id,check_id,domain,status,observed,threshold,details,checked_at
  ) VALUES (
    p_tenant_id,p_run_id,p_check_id,p_domain,p_status,p_observed,p_threshold,p_details,now()
  )
  ON CONFLICT(tenant_id,run_id,check_id) DO UPDATE SET
    domain=excluded.domain,status=excluded.status,observed=excluded.observed,
    threshold=excluded.threshold,details=excluded.details,checked_at=excluded.checked_at;

  IF p_domain='reconciliation' AND EXISTS (
    SELECT 1 FROM quality.reconciliation_finding_policy policy
     WHERE policy.check_id=p_check_id
  ) THEN
    PERFORM quality.materialise_reconciliation_findings(p_tenant_id,p_run_id,p_check_id);
  END IF;
END;
$$;

COMMENT ON TABLE quality.reconciliation_finding_policy IS
  'Reviewed per-grain tolerances used to open and resolve user-facing reconciliation findings.';
COMMENT ON FUNCTION quality.materialise_reconciliation_findings(text,text,text) IS
  'Materialises and resolves deterministic day/location reconciliation findings from current governed marts.';

REVOKE ALL ON TABLE
  quality.finding_severity_lookup,
  quality.finding_status_lookup,
  quality.reconciliation_finding_policy
FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT SELECT ON
  quality.finding_severity_lookup,
  quality.finding_status_lookup,
  quality.reconciliation_finding_policy
TO transform_rw,semantic_ro,diagnostic_ro;
REVOKE INSERT,UPDATE,DELETE ON quality.finding FROM transform_rw;
GRANT SELECT ON quality.finding TO transform_rw;
REVOKE ALL ON FUNCTION
  quality.upsert_reconciliation_finding(text,text,text,text,date,text,text,numeric,jsonb),
  quality.resolve_reconciliation_findings(text,text,text,text[]),
  quality.materialise_reconciliation_findings(text,text,text),
  quality.record_check(text,text,text,text,text,numeric,numeric,jsonb)
FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT EXECUTE ON FUNCTION
  quality.materialise_reconciliation_findings(text,text,text),
  quality.record_check(text,text,text,text,text,numeric,numeric,jsonb)
TO transform_rw;

COMMIT;
