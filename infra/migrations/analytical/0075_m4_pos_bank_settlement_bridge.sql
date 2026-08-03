BEGIN;

-- A settlement bridge is evidence, not an amount-only join in a consumer.
-- Match independently aggregated POS tenders and Xero bank receipts only when
-- date/location/currency candidates have a unique, reciprocal best match and
-- their totals agree within the governed tolerance.  A bank receipt may settle
-- many tenders, so the durable event links are deliberately many-to-many.
CREATE OR REPLACE FUNCTION core.refresh_daily_settlement_links(
  p_tenant_id text,
  p_changed_from date,
  p_changed_to date,
  p_sync_run_id text,
  p_tolerance numeric DEFAULT 0.05,
  p_max_lag_days integer DEFAULT 7
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog,core,semantic_internal
AS $$
DECLARE
  rebuilt_from date;
  inserted_count integer:=0;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501';
  END IF;
  IF NOT core.is_ulid(p_tenant_id) OR NOT core.is_ulid(p_sync_run_id) THEN
    RAISE EXCEPTION 'tenant and sync run must be ULIDs' USING ERRCODE='22023';
  END IF;
  IF p_changed_from IS NULL OR p_changed_to IS NULL
     OR p_changed_to<p_changed_from OR p_changed_to-p_changed_from>400 THEN
    RAISE EXCEPTION 'invalid settlement refresh range' USING ERRCODE='22023';
  END IF;
  IF p_tolerance<0 OR p_tolerance>100 OR p_max_lag_days<0 OR p_max_lag_days>31 THEN
    RAISE EXCEPTION 'invalid settlement matching policy' USING ERRCODE='22023';
  END IF;

  -- A newly arrived bank line can settle a prior trading day. Rebuild that
  -- bounded lookback and replace only links created by this deterministic rule.
  rebuilt_from:=p_changed_from-p_max_lag_days;
  DELETE FROM core.event_link AS link
  WHERE link.tenant_id=p_tenant_id
    AND link.rule_version='settlement-daily-exact-v1'
    AND EXISTS (
      SELECT 1
      FROM core.commerce_payment AS payment
      WHERE payment.tenant_id=link.tenant_id
        AND payment.primary_connection_id=link.to_connection_id
        AND payment.primary_source_record_id=link.to_source_record_id
        AND link.to_object_type='SalePayment'
        AND payment.business_date BETWEEN rebuilt_from AND p_changed_to
    );

  WITH pos_rows AS (
    SELECT payment.*,
           coalesce(resolution.resolved_entity_id,payment.location_id) AS resolved_location_id,
           md5(concat_ws('|',payment.tenant_id,payment.business_date,
             coalesce(resolution.resolved_entity_id,payment.location_id),payment.currency)) AS pos_group_key
    FROM core.commerce_payment AS payment
    LEFT JOIN core.entity_resolution AS resolution
      ON resolution.tenant_id=payment.tenant_id
     AND resolution.entity_type='location'
     AND resolution.member_entity_id=payment.location_id
    WHERE payment.tenant_id=p_tenant_id
      AND payment.business_date BETWEEN rebuilt_from AND p_changed_to
      AND payment.status IN ('captured','refunded')
  ),
  pos_groups AS (
    SELECT tenant_id,pos_group_key,business_date,resolved_location_id,currency,
           sum(amount)::numeric(19,4) AS tender_amount,
           count(*)::bigint AS tender_count
    FROM pos_rows
    GROUP BY tenant_id,pos_group_key,business_date,resolved_location_id,currency
    HAVING sum(amount)>0
  ),
  pos_location_counts AS (
    SELECT tenant_id,business_date,currency,count(*) AS location_count
    FROM pos_groups
    GROUP BY tenant_id,business_date,currency
  ),
  bank_rows AS (
    SELECT bank.*,
           coalesce(resolution.resolved_entity_id,bank.location_id) AS resolved_location_id,
           md5(concat_ws('|',bank.tenant_id,bank.business_date,
             coalesce(resolution.resolved_entity_id,bank.location_id),bank.currency)) AS bank_group_key
    FROM core.finance_bank_transaction AS bank
    LEFT JOIN core.entity_resolution AS resolution
      ON resolution.tenant_id=bank.tenant_id
     AND resolution.entity_type='location'
     AND resolution.member_entity_id=bank.location_id
    WHERE bank.tenant_id=p_tenant_id
      AND bank.business_date BETWEEN rebuilt_from AND p_changed_to+p_max_lag_days
      AND bank.status IN ('authorised','paid','posted','reconciled')
      AND bank.amount>0
  ),
  bank_groups AS (
    SELECT tenant_id,bank_group_key,business_date,resolved_location_id,currency,
           sum(amount)::numeric(19,4) AS bank_amount,
           count(*)::bigint AS bank_transaction_count
    FROM bank_rows
    GROUP BY tenant_id,bank_group_key,business_date,resolved_location_id,currency
  ),
  candidates AS (
    SELECT pos.*,bank.bank_group_key,bank.business_date AS settlement_date,
           bank.resolved_location_id AS bank_location_id,bank.bank_amount,
           bank.bank_transaction_count,
           abs(pos.tender_amount-bank.bank_amount)::numeric(19,4) AS amount_difference,
           (bank.business_date-pos.business_date)::integer AS lag_days
    FROM pos_groups AS pos
    JOIN pos_location_counts AS location_count
      ON location_count.tenant_id=pos.tenant_id
     AND location_count.business_date=pos.business_date
     AND location_count.currency=pos.currency
    JOIN bank_groups AS bank
      ON bank.tenant_id=pos.tenant_id
     AND bank.currency=pos.currency
     AND bank.business_date BETWEEN pos.business_date AND pos.business_date+p_max_lag_days
     AND (
       bank.resolved_location_id=pos.resolved_location_id
       OR (bank.resolved_location_id IS NULL AND location_count.location_count=1)
     )
    WHERE abs(pos.tender_amount-bank.bank_amount)<=p_tolerance
  ),
  ranked AS (
    SELECT candidate.*,
           rank() OVER (
             PARTITION BY candidate.pos_group_key
             ORDER BY candidate.amount_difference,candidate.lag_days
           ) AS pos_rank,
           rank() OVER (
             PARTITION BY candidate.bank_group_key
             ORDER BY candidate.amount_difference,candidate.lag_days
           ) AS bank_rank
    FROM candidates AS candidate
  ),
  reciprocal_best AS (
    SELECT ranked.*,
           count(*) OVER (PARTITION BY ranked.pos_group_key) AS pos_best_count,
           count(*) OVER (PARTITION BY ranked.bank_group_key) AS bank_best_count
    FROM ranked
    WHERE ranked.pos_rank=1 AND ranked.bank_rank=1
  ),
  matches AS (
    SELECT * FROM reciprocal_best
    WHERE pos_best_count=1 AND bank_best_count=1
  ),
  link_rows AS (
    SELECT DISTINCT
      match.tenant_id,match.business_date AS tender_business_date,
      match.settlement_date,match.resolved_location_id,match.currency,
      match.tender_amount,match.bank_amount,match.amount_difference,
      match.lag_days,match.tender_count,match.bank_transaction_count,
      payment.primary_connection_id AS payment_connection_id,
      payment.primary_source_record_id AS payment_source_record_id,
      bank.primary_connection_id AS bank_connection_id,
      bank.primary_source_record_id AS bank_source_record_id
    FROM matches AS match
    JOIN pos_rows AS payment
      ON payment.tenant_id=match.tenant_id
     AND payment.pos_group_key=match.pos_group_key
    JOIN bank_rows AS bank
      ON bank.tenant_id=match.tenant_id
     AND bank.bank_group_key=match.bank_group_key
  )
  INSERT INTO core.event_link (
    tenant_id,id,link_type,
    from_connection_id,from_object_type,from_source_record_id,
    to_connection_id,to_object_type,to_source_record_id,
    evidence,rule_version,sync_run_id
  )
  SELECT
    row_value.tenant_id,
    semantic_internal.deterministic_ulid(concat_ws('|',
      'settlement-daily-exact-v1',row_value.tenant_id,
      row_value.bank_connection_id,row_value.bank_source_record_id,
      row_value.payment_connection_id,row_value.payment_source_record_id
    )),
    'settlement_of',
    row_value.bank_connection_id,'BankTransactions',row_value.bank_source_record_id,
    row_value.payment_connection_id,'SalePayment',row_value.payment_source_record_id,
    jsonb_build_object(
      'match_method','aggregate_amount_date_location_currency',
      'tender_business_date',row_value.tender_business_date,
      'settlement_business_date',row_value.settlement_date,
      'location_id',row_value.resolved_location_id,
      'currency',row_value.currency,
      'tender_total',row_value.tender_amount,
      'bank_total',row_value.bank_amount,
      'variance',row_value.tender_amount-row_value.bank_amount,
      'settlement_lag_days',row_value.lag_days,
      'tender_count',row_value.tender_count,
      'bank_transaction_count',row_value.bank_transaction_count
    ),
    'settlement-daily-exact-v1',p_sync_run_id
  FROM link_rows AS row_value
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS inserted_count=ROW_COUNT;
  RETURN inserted_count;
END $$;

-- The aligned view keeps a short or missing deposit visible even when it was
-- not safe to manufacture a settlement link. Exact delayed settlements use
-- the durable links; an unlinked same-day receipt remains qualified evidence.
CREATE OR REPLACE VIEW mart.settlement_reconciliation_aligned
WITH (security_barrier=true,security_invoker=true)
AS
WITH pos_rows AS (
  SELECT payment.*,
         coalesce(resolution.resolved_entity_id,payment.location_id) AS resolved_location_id
  FROM core.commerce_payment AS payment
  LEFT JOIN core.entity_resolution AS resolution
    ON resolution.tenant_id=payment.tenant_id
   AND resolution.entity_type='location'
   AND resolution.member_entity_id=payment.location_id
  WHERE payment.status IN ('captured','refunded')
),
pos AS (
  SELECT tenant_id,business_date,resolved_location_id AS location_id,currency,
         sum(amount)::numeric(19,4) AS pos_tender_amount,
         count(*)::bigint AS tender_count
  FROM pos_rows
  GROUP BY tenant_id,business_date,resolved_location_id,currency
  HAVING sum(amount)>0
),
pos_location_counts AS (
  SELECT tenant_id,business_date,currency,count(*) AS location_count
  FROM pos
  GROUP BY tenant_id,business_date,currency
),
bank_rows AS (
  SELECT bank.*,
         coalesce(resolution.resolved_entity_id,bank.location_id) AS resolved_location_id
  FROM core.finance_bank_transaction AS bank
  LEFT JOIN core.entity_resolution AS resolution
    ON resolution.tenant_id=bank.tenant_id
   AND resolution.entity_type='location'
   AND resolution.member_entity_id=bank.location_id
  WHERE bank.status IN ('authorised','paid','posted','reconciled')
    AND bank.amount>0
),
linked_bank_rows AS (
  SELECT DISTINCT
    payment.tenant_id,payment.business_date AS tender_business_date,
    payment.resolved_location_id AS location_id,payment.currency,
    payment.id AS payment_id,bank.id AS bank_id,
    bank.business_date AS settlement_date,bank.amount AS bank_amount
  FROM core.event_link AS link
  JOIN pos_rows AS payment
    ON payment.tenant_id=link.tenant_id
   AND payment.primary_connection_id=link.to_connection_id
   AND payment.primary_source_record_id=link.to_source_record_id
  JOIN bank_rows AS bank
    ON bank.tenant_id=link.tenant_id
   AND bank.primary_connection_id=link.from_connection_id
   AND bank.primary_source_record_id=link.from_source_record_id
  WHERE link.link_type='settlement_of'
    AND link.to_object_type='SalePayment'
    AND link.from_object_type='BankTransactions'
),
linked_bank AS (
  SELECT tenant_id,tender_business_date,location_id,currency,
         min(settlement_date) AS settlement_date,
         sum(bank_amount)::numeric(19,4) AS bank_settlement_amount,
         count(*)::bigint AS bank_transaction_count
  FROM (
    SELECT DISTINCT tenant_id,tender_business_date,location_id,currency,
           settlement_date,bank_id,bank_amount
    FROM linked_bank_rows
  ) AS distinct_banks
  GROUP BY tenant_id,tender_business_date,location_id,currency
),
linked_tenders AS (
  SELECT tenant_id,tender_business_date,location_id,currency,
         count(DISTINCT payment_id)::bigint AS linked_tender_count
  FROM linked_bank_rows
  GROUP BY tenant_id,tender_business_date,location_id,currency
),
linked AS (
  SELECT linked_bank.*,linked_tenders.linked_tender_count
  FROM linked_bank
  JOIN linked_tenders USING (tenant_id,tender_business_date,location_id,currency)
),
bank_day AS (
  SELECT tenant_id,business_date,resolved_location_id AS location_id,currency,
         sum(amount)::numeric(19,4) AS bank_amount,
         count(*)::bigint AS bank_transaction_count
  FROM bank_rows
  GROUP BY tenant_id,business_date,resolved_location_id,currency
)
SELECT
  pos.tenant_id,
  md5(concat_ws('|','settlement',pos.tenant_id,pos.business_date,pos.location_id,pos.currency)) AS id,
  pos.business_date,
  coalesce(linked.settlement_date,pos.business_date) AS settlement_date,
  pos.location_id,pos.currency,pos.pos_tender_amount,
  coalesce(linked.bank_settlement_amount,fallback.bank_amount) AS bank_settlement_amount,
  pos.pos_tender_amount AS tender_amount,
  coalesce(linked.bank_settlement_amount,fallback.bank_amount) AS cash_receipts,
  (
    pos.pos_tender_amount
    - coalesce(linked.bank_settlement_amount,fallback.bank_amount,0)
  )::numeric(19,4) AS settlement_variance,
  pos.tender_count,
  coalesce(linked.bank_transaction_count,fallback.bank_transaction_count,0)::bigint AS bank_transaction_count,
  coalesce(linked.linked_tender_count,0)::bigint AS linked_tender_count,
  CASE
    WHEN linked.bank_transaction_count>0
      AND abs(pos.pos_tender_amount-linked.bank_settlement_amount)<=0.05 THEN 'linked_exact'
    WHEN linked.bank_transaction_count>0 THEN 'linked_variance'
    WHEN fallback.bank_transaction_count>0 THEN 'same_day_unlinked'
    ELSE 'no_bank_evidence'
  END AS evidence_status
FROM pos
JOIN pos_location_counts AS location_count
  ON location_count.tenant_id=pos.tenant_id
 AND location_count.business_date=pos.business_date
 AND location_count.currency=pos.currency
LEFT JOIN linked
  ON linked.tenant_id=pos.tenant_id
 AND linked.tender_business_date=pos.business_date
 AND linked.location_id=pos.location_id
 AND linked.currency=pos.currency
LEFT JOIN LATERAL (
  SELECT sum(bank_day.bank_amount)::numeric(19,4) AS bank_amount,
         sum(bank_day.bank_transaction_count)::bigint AS bank_transaction_count
  FROM bank_day
  WHERE linked.bank_transaction_count IS NULL
    AND bank_day.tenant_id=pos.tenant_id
    AND bank_day.business_date=pos.business_date
    AND bank_day.currency=pos.currency
    AND (
      bank_day.location_id=pos.location_id
      OR (bank_day.location_id IS NULL AND location_count.location_count=1)
    )
) AS fallback ON true;

REVOKE ALL ON FUNCTION core.refresh_daily_settlement_links(text,date,date,text,numeric,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.refresh_daily_settlement_links(text,date,date,text,numeric,integer) TO transform_rw;
GRANT SELECT ON mart.settlement_reconciliation_aligned TO semantic_ro,transform_rw,diagnostic_ro;

COMMIT;
