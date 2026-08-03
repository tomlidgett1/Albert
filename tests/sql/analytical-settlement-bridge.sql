\set ON_ERROR_STOP on

-- Exercise both honest variance evidence and a deterministic delayed
-- settlement match. Everything is rolled back so the harness is repeatable.
BEGIN;

SET ROLE transform_rw;
SET LOCAL albert.tenant_id = '01H00000000000000000000751';

INSERT INTO core.legal_entity (
  tenant_id,id,name,base_currency,sync_run_id
) VALUES (
  '01H00000000000000000000751','01H00000000000000000000753',
  'Settlement harness entity','AUD','01H00000000000000000000752'
);

INSERT INTO core.location (
  tenant_id,id,name,timezone,legal_entity_id,sync_run_id
) VALUES
  (
    '01H00000000000000000000751','01H00000000000000000000754',
    'POS location','Australia/Melbourne','01H00000000000000000000753',
    '01H00000000000000000000752'
  ),
  (
    '01H00000000000000000000751','01H00000000000000000000755',
    'Finance tracking location','Australia/Melbourne','01H00000000000000000000753',
    '01H00000000000000000000752'
  );

-- Identity graph projections are written by their SECURITY DEFINER projector,
-- not directly by transform_rw. The administrative harness seeds its output.
RESET ROLE;
INSERT INTO core.entity_resolution (
  tenant_id,entity_type,member_entity_id,resolved_entity_id
) VALUES
  (
    '01H00000000000000000000751','location',
    '01H00000000000000000000754','01H00000000000000000000754'
  ),
  (
    '01H00000000000000000000751','location',
    '01H00000000000000000000755','01H00000000000000000000754'
  );
SET ROLE transform_rw;

INSERT INTO core.channel (
  tenant_id,id,name,channel_type,sync_run_id
) VALUES (
  '01H00000000000000000000751','01H00000000000000000000756',
  'In store','in_store','01H00000000000000000000752'
);

INSERT INTO core.commerce_order (
  tenant_id,id,location_id,channel_id,ordered_at,completed_at,business_date,
  status,voided,internal_transaction,gross_amount,discount_amount,
  net_amount_inc_tax,tax_amount,net_amount_ex_tax,total_cost,currency,
  primary_connection_id,primary_source_record_id,sync_run_id
) VALUES
  (
    '01H00000000000000000000751','01H00000000000000000000757',
    '01H00000000000000000000754','01H00000000000000000000756',
    '2026-02-10T10:00:00+11','2026-02-10T10:01:00+11','2026-02-10',
    'completed',false,false,165,0,165,15,150,60,'AUD',
    '01H00000000000000000000763','sale-tuesday','01H00000000000000000000752'
  ),
  (
    '01H00000000000000000000751','01H00000000000000000000758',
    '01H00000000000000000000754','01H00000000000000000000756',
    '2026-02-11T10:00:00+11','2026-02-11T10:01:00+11','2026-02-11',
    'completed',false,false,200,0,200,18.1818,181.8182,80,'AUD',
    '01H00000000000000000000763','sale-wednesday','01H00000000000000000000752'
  );

INSERT INTO core.commerce_payment (
  tenant_id,id,order_id,location_id,channel_id,paid_at,business_date,
  tender_type,status,amount,currency,primary_connection_id,
  primary_source_record_id,sync_run_id
) VALUES
  (
    '01H00000000000000000000751','01H00000000000000000000759',
    '01H00000000000000000000757','01H00000000000000000000754',
    '01H00000000000000000000756','2026-02-10T10:01:00+11','2026-02-10',
    'card','captured',165,'AUD','01H00000000000000000000763',
    'payment-tuesday','01H00000000000000000000752'
  ),
  (
    '01H00000000000000000000751','01H00000000000000000000760',
    '01H00000000000000000000758','01H00000000000000000000754',
    '01H00000000000000000000756','2026-02-11T10:01:00+11','2026-02-11',
    'card','captured',200,'AUD','01H00000000000000000000763',
    'payment-wednesday','01H00000000000000000000752'
  );

INSERT INTO core.finance_bank_transaction (
  tenant_id,id,legal_entity_id,location_id,transaction_at,posted_at,
  business_date,status,amount,tax_amount,currency,primary_connection_id,
  primary_source_record_id,sync_run_id
) VALUES
  (
    '01H00000000000000000000751','01H00000000000000000000761',
    '01H00000000000000000000753','01H00000000000000000000755',
    '2026-02-10T12:00:00+11','2026-02-10T12:00:00+11','2026-02-10',
    'reconciled',150,0,'AUD','01H00000000000000000000764',
    'bank-tuesday','01H00000000000000000000752'
  ),
  (
    '01H00000000000000000000751','01H00000000000000000000762',
    '01H00000000000000000000753','01H00000000000000000000755',
    '2026-02-12T12:00:00+11','2026-02-12T12:00:00+11','2026-02-12',
    'reconciled',200,0,'AUD','01H00000000000000000000764',
    'bank-thursday','01H00000000000000000000752'
  );

DO $$
DECLARE
  inserted_links integer;
  tuesday record;
  wednesday record;
  durable_links integer;
BEGIN
  inserted_links:=core.refresh_daily_settlement_links(
    '01H00000000000000000000751','2026-02-10','2026-02-12',
    '01H00000000000000000000752'
  );
  IF inserted_links<>1 THEN
    RAISE EXCEPTION 'expected one exact delayed settlement link, found %',inserted_links;
  END IF;

  SELECT * INTO STRICT tuesday
  FROM mart.settlement_reconciliation_aligned
  WHERE tenant_id='01H00000000000000000000751'
    AND business_date='2026-02-10';
  IF tuesday.pos_tender_amount<>165 OR tuesday.bank_settlement_amount<>150
     OR tuesday.settlement_variance<>15
     OR tuesday.evidence_status<>'same_day_unlinked' THEN
    RAISE EXCEPTION 'Tuesday shortfall was not preserved as qualified evidence: %',row_to_json(tuesday);
  END IF;

  SELECT * INTO STRICT wednesday
  FROM mart.settlement_reconciliation_aligned
  WHERE tenant_id='01H00000000000000000000751'
    AND business_date='2026-02-11';
  IF wednesday.pos_tender_amount<>200 OR wednesday.bank_settlement_amount<>200
     OR wednesday.settlement_variance<>0
     OR wednesday.settlement_date<>'2026-02-12'
     OR wednesday.evidence_status<>'linked_exact'
     OR wednesday.linked_tender_count<>1 THEN
    RAISE EXCEPTION 'delayed exact settlement did not bridge correctly: %',row_to_json(wednesday);
  END IF;

  SELECT count(*) INTO durable_links
  FROM core.event_link
  WHERE tenant_id='01H00000000000000000000751'
    AND link_type='settlement_of'
    AND rule_version='settlement-daily-exact-v1'
    AND from_source_record_id='bank-thursday'
    AND to_source_record_id='payment-wednesday';
  IF durable_links<>1 THEN
    RAISE EXCEPTION 'durable source-to-source settlement evidence is missing';
  END IF;
END $$;

SELECT quality.run_all_invariants(
  '01H00000000000000000000751','01H00000000000000000000765'
);

DO $$
DECLARE
  tolerance_status text;
  bridge_status text;
BEGIN
  SELECT status INTO STRICT tolerance_status
  FROM quality.check_result
  WHERE tenant_id='01H00000000000000000000751'
    AND run_id='01H00000000000000000000765'
    AND check_id='pos_bank_tolerance';
  SELECT status INTO STRICT bridge_status
  FROM quality.check_result
  WHERE tenant_id='01H00000000000000000000751'
    AND run_id='01H00000000000000000000765'
    AND check_id='settlement_bridge_coverage';
  IF tolerance_status<>'warning' OR bridge_status<>'warning' THEN
    RAISE EXCEPTION 'settlement findings were not surfaced as warnings: tolerance %, bridge %',
      tolerance_status,bridge_status;
  END IF;
END $$;

ROLLBACK;
