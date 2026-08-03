BEGIN;

INSERT INTO core.authority_scope_lookup(value,description)
VALUES ('account','One connector account or provider organisation')
ON CONFLICT (value) DO UPDATE SET description=excluded.description;

ALTER TABLE core.source_authority
  DROP CONSTRAINT IF EXISTS source_authority_scope_id_is_ulid;
ALTER TABLE core.source_authority
  ADD CONSTRAINT source_authority_scope_id_is_ulid
  CHECK (core.is_ulid(scope_id)) NOT VALID;
ALTER TABLE core.source_authority
  VALIDATE CONSTRAINT source_authority_scope_id_is_ulid;

CREATE OR REPLACE FUNCTION core.enforce_source_authority_interval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog,core
AS $$
BEGIN
  -- Serialise writers for the exact authority scope.  The partial unique index
  -- protects the open interval; this lock plus the overlap check protects all
  -- closed and future intervals without requiring btree_gist in a managed cell.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws('|','source-authority',NEW.tenant_id,NEW.concept,NEW.scope_type,NEW.scope_id),0
  ));
  IF EXISTS (
    SELECT 1
      FROM core.source_authority AS existing
     WHERE existing.tenant_id=NEW.tenant_id
       AND existing.concept=NEW.concept
       AND existing.scope_type=NEW.scope_type
       AND existing.scope_id=NEW.scope_id
       AND existing.id<>NEW.id
       AND tstzrange(existing.effective_from,existing.effective_to,'[)')
           && tstzrange(NEW.effective_from,NEW.effective_to,'[)')
  ) THEN
    RAISE EXCEPTION 'source authority intervals overlap for %/%/%',
      NEW.concept,NEW.scope_type,NEW.scope_id
      USING ERRCODE='23P01';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS source_authority_reject_overlap ON core.source_authority;
CREATE TRIGGER source_authority_reject_overlap
  BEFORE INSERT OR UPDATE OF concept,scope_type,scope_id,effective_from,effective_to
  ON core.source_authority
  FOR EACH ROW EXECUTE FUNCTION core.enforce_source_authority_interval();

CREATE OR REPLACE FUNCTION core.source_is_authoritative(
  p_tenant_id text,
  p_concept text,
  p_scope_type text,
  p_scope_id text,
  p_connection_id text,
  p_effective_at timestamptz
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path=pg_catalog,core
AS $$
  SELECT count(*)=1
     AND min(authority.authoritative_connection_id)=p_connection_id
    FROM core.source_authority AS authority
   WHERE authority.tenant_id=p_tenant_id
     AND authority.concept=p_concept
     AND authority.scope_type=p_scope_type
     AND authority.scope_id=p_scope_id
     AND authority.effective_from<=p_effective_at
     AND (authority.effective_to IS NULL OR authority.effective_to>p_effective_at)
$$;

CREATE OR REPLACE FUNCTION core.install_default_source_authority(
  p_tenant_id text,
  p_concept text,
  p_scope_type text,
  p_scope_id text,
  p_connection_id text,
  p_sync_run_id text,
  p_effective_from timestamptz DEFAULT '1970-01-01T00:00:00Z'
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog,core,semantic_internal
AS $$
DECLARE inserted_count integer:=0;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501';
  END IF;
  IF NOT core.is_ulid(p_tenant_id)
     OR NOT core.is_ulid(p_scope_id)
     OR NOT core.is_ulid(p_connection_id)
     OR NOT core.is_ulid(p_sync_run_id)
     OR p_effective_from IS NULL THEN
    RAISE EXCEPTION 'source authority lineage is invalid' USING ERRCODE='22023';
  END IF;
  IF p_concept NOT IN (
       'operational_sales','stock','product_master','customer_master',
       'statutory_finance','cash_settlement','planned_shifts','worked_hours'
     ) OR p_scope_type NOT IN ('tenant','account','location','legal_entity') THEN
    RAISE EXCEPTION 'source authority concept or scope is invalid' USING ERRCODE='22023';
  END IF;
  IF (p_concept IN ('statutory_finance','cash_settlement') AND p_scope_type<>'legal_entity')
     OR (p_concept IN ('product_master','customer_master') AND p_scope_type<>'account')
     OR (p_concept IN ('operational_sales','stock','planned_shifts','worked_hours')
         AND p_scope_type NOT IN ('location','account')) THEN
    RAISE EXCEPTION 'source authority scope is incompatible with concept'
      USING ERRCODE='22023';
  END IF;
  IF p_scope_type='account' AND p_scope_id<>p_connection_id THEN
    RAISE EXCEPTION 'account authority must be scoped to its own connection'
      USING ERRCODE='42501';
  END IF;
  IF p_scope_type IN ('location','legal_entity') AND NOT EXISTS (
    SELECT 1
      FROM semantic_internal.canonical_record_state AS native_scope
     WHERE native_scope.tenant_id=p_tenant_id
       AND native_scope.canonical_table=p_scope_type
       AND native_scope.canonical_id=p_scope_id
       AND native_scope.connection_id=p_connection_id
  ) THEN
    RAISE EXCEPTION 'connection does not own canonical authority scope %/%',
      p_scope_type,p_scope_id USING ERRCODE='42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws('|','source-authority',p_tenant_id,p_concept,p_scope_type,p_scope_id),0
  ));
  INSERT INTO core.source_authority(
    tenant_id,id,concept,scope_type,scope_id,authoritative_connection_id,
    effective_from,sync_run_id
  )
  SELECT p_tenant_id,
         semantic_internal.deterministic_ulid(concat_ws('|',
           'authority-v2',p_tenant_id,p_concept,p_scope_type,p_scope_id,p_connection_id,
           p_effective_from::text
         )),
         p_concept,p_scope_type,p_scope_id,p_connection_id,p_effective_from,p_sync_run_id
   WHERE NOT EXISTS (
     SELECT 1 FROM core.source_authority AS history
      WHERE history.tenant_id=p_tenant_id
        AND history.concept=p_concept
        AND history.scope_type=p_scope_type
        AND history.scope_id=p_scope_id
   );
  GET DIAGNOSTICS inserted_count=ROW_COUNT;
  RETURN inserted_count=1;
END;
$$;

CREATE OR REPLACE FUNCTION core.assert_source_authority(
  p_tenant_id text,
  p_concept text,
  p_scope_type text,
  p_scope_id text,
  p_connection_id text,
  p_effective_at timestamptz
) RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path=pg_catalog,core
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501';
  END IF;
  IF NOT core.source_is_authoritative(
    p_tenant_id,p_concept,p_scope_type,p_scope_id,p_connection_id,p_effective_at
  ) THEN
    RAISE EXCEPTION 'canonical_non_authoritative:%:%:%:%',
      p_concept,p_scope_type,p_scope_id,p_connection_id USING ERRCODE='42501';
  END IF;
END;
$$;

-- Convert automatic tenant-wide first-connection defaults into scoped
-- defaults.  Existing explicit scoped history is never superseded.
-- FORCE RLS is restored before this transaction commits.  The migration owner
-- needs this bounded owner bypass to backfill every tenant atomically; runtime
-- roles never receive it.
DO $$
DECLARE relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'source_authority','commerce_order','commerce_order_line','commerce_payment',
    'commerce_refund_line','inventory_movement','inventory_balance_snapshot',
    'purchase_order_line','finance_journal_line','finance_invoice_line',
    'finance_bank_transaction','workforce_shift','workforce_time_entry',
    'workforce_leave','stock_location'
  ] LOOP
    EXECUTE format('ALTER TABLE core.%I NO FORCE ROW LEVEL SECURITY',relation_name);
  END LOOP;
  ALTER TABLE semantic_internal.canonical_transform_commits NO FORCE ROW LEVEL SECURITY;
END;
$$;

UPDATE core.source_authority
   SET effective_to=greatest(effective_from+interval '1 microsecond',clock_timestamp()),
       updated_at=clock_timestamp()
 WHERE scope_type='tenant' AND effective_to IS NULL;

CREATE TEMP TABLE source_authority_backfill_candidate (
  tenant_id text NOT NULL,
  concept text NOT NULL,
  scope_type text NOT NULL,
  scope_id text NOT NULL,
  connection_id text NOT NULL,
  sync_run_id text NOT NULL
) ON COMMIT DROP;

-- Account scope is a deliberate fallback for concepts that do not always
-- expose a legal entity or location.  Xero statutory facts never use it.
INSERT INTO source_authority_backfill_candidate
SELECT DISTINCT commit.tenant_id,concept.value,'account',commit.connection_id,
       commit.connection_id,commit.sync_run_id
  FROM semantic_internal.canonical_transform_commits AS commit
  CROSS JOIN LATERAL unnest(
    CASE commit.connector_id
      WHEN 'lightspeed-r' THEN ARRAY[
        'operational_sales','stock','product_master','customer_master'
      ]::text[]
      WHEN 'deputy' THEN ARRAY['planned_shifts','worked_hours']::text[]
      ELSE '{}'::text[]
    END
  ) AS concept(value);

INSERT INTO source_authority_backfill_candidate
SELECT tenant_id,'operational_sales','location',location_id,
       primary_connection_id,sync_run_id FROM core.commerce_order
UNION ALL
SELECT tenant_id,'operational_sales','location',location_id,
       primary_connection_id,sync_run_id FROM core.commerce_order_line
UNION ALL
SELECT tenant_id,'operational_sales','location',location_id,
       primary_connection_id,sync_run_id FROM core.commerce_payment
UNION ALL
SELECT tenant_id,'operational_sales','location',location_id,
       primary_connection_id,sync_run_id FROM core.commerce_refund_line
UNION ALL
SELECT movement.tenant_id,'stock','location',stock_location.location_id,
       movement.primary_connection_id,movement.sync_run_id
  FROM core.inventory_movement movement
  JOIN core.stock_location stock_location
    ON stock_location.tenant_id=movement.tenant_id
   AND stock_location.id=movement.stock_location_id
UNION ALL
SELECT snapshot.tenant_id,'stock','location',stock_location.location_id,
       snapshot.primary_connection_id,snapshot.sync_run_id
  FROM core.inventory_balance_snapshot snapshot
  JOIN core.stock_location stock_location
    ON stock_location.tenant_id=snapshot.tenant_id
   AND stock_location.id=snapshot.stock_location_id
UNION ALL
SELECT purchase.tenant_id,'stock','location',stock_location.location_id,
       purchase.primary_connection_id,purchase.sync_run_id
  FROM core.purchase_order_line purchase
  JOIN core.stock_location stock_location
    ON stock_location.tenant_id=purchase.tenant_id
   AND stock_location.id=purchase.stock_location_id
UNION ALL
SELECT tenant_id,'stock','account',primary_connection_id,
       primary_connection_id,sync_run_id
  FROM core.purchase_order_line WHERE stock_location_id IS NULL
UNION ALL
SELECT tenant_id,'statutory_finance','legal_entity',legal_entity_id,
       primary_connection_id,sync_run_id FROM core.finance_journal_line
UNION ALL
SELECT tenant_id,'statutory_finance','legal_entity',legal_entity_id,
       primary_connection_id,sync_run_id FROM core.finance_invoice_line
UNION ALL
SELECT tenant_id,'cash_settlement','legal_entity',legal_entity_id,
       primary_connection_id,sync_run_id FROM core.finance_bank_transaction
UNION ALL
SELECT tenant_id,'planned_shifts','location',location_id,
       primary_connection_id,sync_run_id FROM core.workforce_shift
UNION ALL
SELECT tenant_id,'worked_hours','location',location_id,
       primary_connection_id,sync_run_id FROM core.workforce_time_entry
UNION ALL
SELECT tenant_id,'worked_hours','location',location_id,
       primary_connection_id,sync_run_id FROM core.workforce_leave
 WHERE location_id IS NOT NULL
UNION ALL
SELECT tenant_id,'worked_hours','account',primary_connection_id,
       primary_connection_id,sync_run_id FROM core.workforce_leave
 WHERE location_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM source_authority_backfill_candidate
     GROUP BY tenant_id,concept,scope_type,scope_id
    HAVING count(DISTINCT connection_id)>1
  ) THEN
    RAISE EXCEPTION 'existing canonical facts contain conflicting scoped authority owners'
      USING ERRCODE='23514';
  END IF;
END;
$$;

INSERT INTO core.source_authority(
  tenant_id,id,concept,scope_type,scope_id,authoritative_connection_id,
  effective_from,sync_run_id
)
SELECT candidate.tenant_id,
       semantic_internal.deterministic_ulid(concat_ws('|',
         'authority-v2',candidate.tenant_id,candidate.concept,candidate.scope_type,
         candidate.scope_id,candidate.connection_id,'1970-01-01 00:00:00+00'
       )),
       candidate.concept,candidate.scope_type,candidate.scope_id,
       candidate.connection_id,'1970-01-01T00:00:00Z',min(candidate.sync_run_id)
  FROM source_authority_backfill_candidate AS candidate
 WHERE NOT EXISTS (
   SELECT 1 FROM core.source_authority AS history
    WHERE history.tenant_id=candidate.tenant_id
      AND history.concept=candidate.concept
      AND history.scope_type=candidate.scope_type
      AND history.scope_id=candidate.scope_id
 )
 GROUP BY candidate.tenant_id,candidate.concept,candidate.scope_type,
          candidate.scope_id,candidate.connection_id;

DO $$
DECLARE relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'source_authority','commerce_order','commerce_order_line','commerce_payment',
    'commerce_refund_line','inventory_movement','inventory_balance_snapshot',
    'purchase_order_line','finance_journal_line','finance_invoice_line',
    'finance_bank_transaction','workforce_shift','workforce_time_entry',
    'workforce_leave','stock_location'
  ] LOOP
    EXECUTE format('ALTER TABLE core.%I FORCE ROW LEVEL SECURITY',relation_name);
  END LOOP;
  ALTER TABLE semantic_internal.canonical_transform_commits FORCE ROW LEVEL SECURITY;
END;
$$;

-- Supersede the founding observation invariant so payments and refunds prove
-- the location authority that admitted the fact.  Orders and lines retain
-- their explicit many-to-many observation bridges.
CREATE OR REPLACE FUNCTION quality.run_domain_invariants(
  p_tenant_id text,p_run_id text
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog,core,quality,semantic_internal
AS $$
DECLARE
  line_component_failures bigint:=0;
  header_failures bigint:=0;
  refund_component_failures bigint:=0;
  refund_link_failures bigint:=0;
  line_failures bigint:=0;
  journal_failures bigint:=0;
  total_commerce_facts bigint:=0;
  missing_order_observations bigint:=0;
  missing_line_observations bigint:=0;
  missing_payment_observations bigint:=0;
  missing_refund_observations bigint:=0;
  missing_observations bigint:=0;
  coverage numeric(19,4):=1;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501';
  END IF;
  IF NOT core.is_ulid(p_run_id) THEN
    RAISE EXCEPTION 'run id must be a ULID' USING ERRCODE='22023';
  END IF;

  SELECT count(*) INTO line_component_failures
    FROM core.commerce_order_line line
   WHERE line.tenant_id=p_tenant_id AND (
     abs((line.gross_amount-line.discount_amount)-line.net_amount_inc_tax)>0.0001
     OR abs((line.net_amount_ex_tax+line.tax_amount)-line.net_amount_inc_tax)>0.0001
   );
  SELECT count(*) INTO header_failures
    FROM core.commerce_order order_row
    LEFT JOIN LATERAL (
      SELECT coalesce(sum(line.gross_amount),0) gross_amount,
             coalesce(sum(line.discount_amount),0) discount_amount,
             coalesce(sum(line.net_amount_inc_tax),0) net_amount_inc_tax,
             coalesce(sum(line.tax_amount),0) tax_amount,
             coalesce(sum(line.net_amount_ex_tax),0) net_amount_ex_tax,
             count(*) line_count
        FROM core.commerce_order_line line
       WHERE line.tenant_id=order_row.tenant_id AND line.order_id=order_row.id
    ) lines ON true
   WHERE order_row.tenant_id=p_tenant_id AND (
     abs(order_row.gross_amount-lines.gross_amount)>0.01
     OR abs(order_row.discount_amount-lines.discount_amount)>0.01
     OR abs(order_row.net_amount_inc_tax-lines.net_amount_inc_tax)>0.01
     OR abs(order_row.tax_amount-lines.tax_amount)>0.01
     OR abs(order_row.net_amount_ex_tax-lines.net_amount_ex_tax)>0.01
   );
  SELECT count(*) INTO refund_component_failures
    FROM core.commerce_refund_line refund
   WHERE refund.tenant_id=p_tenant_id
     AND abs((refund.refund_amount_ex_tax+refund.tax_amount)-refund.refund_amount_inc_tax)>0.0001;
  SELECT count(*) INTO refund_link_failures
    FROM core.commerce_refund_line refund
    JOIN core.commerce_order_line original
      ON original.tenant_id=refund.tenant_id AND original.id=refund.original_order_line_id
   WHERE refund.tenant_id=p_tenant_id
     AND NOT EXISTS (
       SELECT 1 FROM core.event_link link
        WHERE link.tenant_id=refund.tenant_id
          AND link.link_type='reversal_of'
          AND link.from_connection_id=refund.primary_connection_id
          AND link.from_source_record_id=refund.primary_source_record_id
          AND link.to_connection_id=original.primary_connection_id
          AND link.to_source_record_id=original.primary_source_record_id
     );
  line_failures:=line_component_failures+header_failures+
    refund_component_failures+refund_link_failures;
  INSERT INTO quality.check_result VALUES (
    p_tenant_id,p_run_id,'line_maths','commerce',
    CASE WHEN line_failures=0 THEN 'passed' ELSE 'failed' END,
    line_failures,0,
    jsonb_build_object(
      'measurement','line_header_refund_reconciliation',
      'line_component_failures',line_component_failures,
      'header_failures',header_failures,
      'refund_component_failures',refund_component_failures,
      'refund_reversal_link_failures',refund_link_failures,
      'header_tolerance','0.0100','component_tolerance','0.0001'
    ),now()
  ) ON CONFLICT (tenant_id,run_id,check_id) DO UPDATE SET
    status=excluded.status,observed=excluded.observed,threshold=excluded.threshold,
    details=excluded.details,checked_at=excluded.checked_at;

  SELECT count(*) INTO journal_failures FROM (
    SELECT journal_id FROM core.finance_journal_line WHERE tenant_id=p_tenant_id
    GROUP BY journal_id HAVING abs(sum(debit_amount)-sum(credit_amount))>0.01
  ) unbalanced;
  INSERT INTO quality.check_result VALUES (
    p_tenant_id,p_run_id,'journal_balances','finance',
    CASE WHEN journal_failures=0 THEN 'passed' ELSE 'failed' END,
    journal_failures,0,'{"measurement":"journal_debits_equal_credits","tolerance":"0.0100"}'::jsonb,now()
  ) ON CONFLICT (tenant_id,run_id,check_id) DO UPDATE SET
    status=excluded.status,observed=excluded.observed,threshold=excluded.threshold,
    details=excluded.details,checked_at=excluded.checked_at;

  SELECT count(*) INTO missing_order_observations
    FROM core.commerce_order fact
   WHERE fact.tenant_id=p_tenant_id
     AND (
       NOT EXISTS (
         SELECT 1 FROM core.order_source_observation observation
          WHERE observation.tenant_id=fact.tenant_id
            AND observation.order_id=fact.id
            AND observation.relationship='authoritative'
       ) OR NOT EXISTS (
         SELECT 1 FROM semantic_internal.canonical_record_state state
          WHERE state.tenant_id=fact.tenant_id
            AND state.canonical_table='commerce_order'
            AND state.canonical_id=fact.id
            AND state.connection_id=fact.primary_connection_id
            AND state.source_record_id=fact.primary_source_record_id
       )
     );
  SELECT count(*) INTO missing_line_observations
    FROM core.commerce_order_line fact
   WHERE fact.tenant_id=p_tenant_id
     AND (
       NOT EXISTS (
         SELECT 1 FROM core.order_line_source_observation observation
          WHERE observation.tenant_id=fact.tenant_id
            AND observation.order_line_id=fact.id
            AND observation.relationship='authoritative'
       ) OR NOT EXISTS (
         SELECT 1 FROM semantic_internal.canonical_record_state state
          WHERE state.tenant_id=fact.tenant_id
            AND state.canonical_table='commerce_order_line'
            AND state.canonical_id=fact.id
            AND state.connection_id=fact.primary_connection_id
            AND state.source_record_id=fact.primary_source_record_id
       )
     );
  SELECT count(*) INTO missing_payment_observations
    FROM core.commerce_payment fact
   WHERE fact.tenant_id=p_tenant_id
     AND NOT EXISTS (
       SELECT 1
         FROM semantic_internal.canonical_record_state state
        WHERE state.tenant_id=fact.tenant_id
          AND state.canonical_table='commerce_payment'
          AND state.canonical_id=fact.id
          AND state.connection_id=fact.primary_connection_id
          AND state.source_record_id=fact.primary_source_record_id
          AND core.source_is_authoritative(
            state.tenant_id,'operational_sales','location',fact.location_id,
            state.connection_id,fact.paid_at
          )
     );
  SELECT count(*) INTO missing_refund_observations
    FROM core.commerce_refund_line fact
   WHERE fact.tenant_id=p_tenant_id
     AND NOT EXISTS (
       SELECT 1
         FROM semantic_internal.canonical_record_state state
        WHERE state.tenant_id=fact.tenant_id
          AND state.canonical_table='commerce_refund_line'
          AND state.canonical_id=fact.id
          AND state.connection_id=fact.primary_connection_id
          AND state.source_record_id=fact.primary_source_record_id
          AND core.source_is_authoritative(
            state.tenant_id,'operational_sales','location',fact.location_id,
            state.connection_id,fact.refunded_at
          )
     );
  SELECT
    (SELECT count(*) FROM core.commerce_order WHERE tenant_id=p_tenant_id)+
    (SELECT count(*) FROM core.commerce_order_line WHERE tenant_id=p_tenant_id)+
    (SELECT count(*) FROM core.commerce_payment WHERE tenant_id=p_tenant_id)+
    (SELECT count(*) FROM core.commerce_refund_line WHERE tenant_id=p_tenant_id)
    INTO total_commerce_facts;
  missing_observations:=missing_order_observations+missing_line_observations+
    missing_payment_observations+missing_refund_observations;
  coverage:=CASE WHEN total_commerce_facts=0 THEN 1
    ELSE (total_commerce_facts-missing_observations)::numeric/total_commerce_facts END;
  INSERT INTO quality.check_result VALUES (
    p_tenant_id,p_run_id,'observation_coverage','canonical',
    CASE WHEN missing_observations=0 THEN 'passed' ELSE 'failed' END,
    coverage,1,
    jsonb_build_object(
      'measurement','authoritative_commerce_fact_observation_coverage',
      'total_commerce_facts',total_commerce_facts,
      'missing_observations',missing_observations,
      'orders_missing',missing_order_observations,
      'order_lines_missing',missing_line_observations,
      'payments_missing',missing_payment_observations,
      'refund_lines_missing',missing_refund_observations
    ),now()
  ) ON CONFLICT (tenant_id,run_id,check_id) DO UPDATE SET
    status=excluded.status,observed=excluded.observed,threshold=excluded.threshold,
    details=excluded.details,checked_at=excluded.checked_at;
END;
$$;

REVOKE ALL ON FUNCTION core.enforce_source_authority_interval(),
  core.source_is_authoritative(text,text,text,text,text,timestamptz),
  core.install_default_source_authority(text,text,text,text,text,text,timestamptz),
  core.assert_source_authority(text,text,text,text,text,timestamptz)
  FROM PUBLIC,ingest_rw,semantic_meta_rw,deletion_rw;
GRANT EXECUTE ON FUNCTION
  core.source_is_authoritative(text,text,text,text,text,timestamptz)
  TO transform_rw,semantic_ro,diagnostic_ro;
GRANT EXECUTE ON FUNCTION
  core.install_default_source_authority(text,text,text,text,text,text,timestamptz),
  core.assert_source_authority(text,text,text,text,text,timestamptz),
  semantic_internal.deterministic_ulid(text)
  TO transform_rw;

COMMIT;
