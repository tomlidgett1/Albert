\set ON_ERROR_STOP on

BEGIN;
SET LOCAL ROLE albert_semantic_control;

DO $$
BEGIN
  IF session_user<>'albert_semantic_control_runtime' THEN
    RAISE EXCEPTION 'semantic promotion test did not use the exact runtime login';
  END IF;
  BEGIN
    PERFORM 1 FROM control_plane.semantic_promotion_deliveries;
    RAISE EXCEPTION 'semantic runtime read the private delivery ledger directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO control_plane.semantic_promotion_relay_tenants(tenant_id)
    VALUES('01H00000000000000000004301');
    RAISE EXCEPTION 'semantic runtime mutated the relay scan ledger directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;

SELECT *
FROM control_plane.claim_semantic_promotion_relay_tenants(
  'semantic-relay:sql-test',50,90
)
WHERE tenant_id='01H00000000000000000004301'
\gset relay_

-- psql values are copied into transaction-local settings so the assertions
-- can parse them without disclosing the capability in test output.
SELECT set_config('relay.capability',:'relay_analytical_capability',true);

DO $$
DECLARE token jsonb:=current_setting('relay.capability',true)::jsonb;
BEGIN
  IF token->'payload'->>'tenant_id'<>'01H00000000000000000004301'
     OR token->'payload'->>'audience'<>'analytical:semantic-metadata'
     OR token->'payload'->>'scope'<>'semantic_metadata'
     OR token->'payload'->'evidence'->>'kind'<>'semantic_promotion_recovery'
     OR token->>'signature' !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'recovery tenant claim returned invalid signed evidence';
  END IF;
END;
$$;

SELECT * FROM control_plane.accept_semantic_promotion_candidate(
  '01H00000000000000000004301','01H00000000000000000004303',
  '01H00000000000000000004304','01H00000000000000000004302',
  'xero','invoices',ARRAY['reference'],repeat('c',64),
  'finance.invoice_reference',
  '0900aece7b11be1909b609fee3054118f65896ed0f73d03eb3fd674db1eed1fc'
) \gset first_

SELECT * FROM control_plane.accept_semantic_promotion_candidate(
  '01H00000000000000000004301','01H00000000000000000004303',
  '01H00000000000000000004304','01H00000000000000000004302',
  'xero','invoices',ARRAY['reference'],repeat('c',64),
  'finance.invoice_reference',
  '0900aece7b11be1909b609fee3054118f65896ed0f73d03eb3fd674db1eed1fc'
) \gset replay_

SELECT * FROM control_plane.accept_semantic_promotion_candidate(
  '01H00000000000000000004301','01H00000000000000000004305',
  '01H00000000000000000004306','01H00000000000000000004302',
  'xero','invoices',ARRAY['reference'],repeat('d',64),
  'finance.invoice_reference',
  'ddbcb531e5b1c16cedadd4321153a0bdd7284ef07406ee46b0c9bfcd7ed4bf93'
) \gset second_

SELECT set_config('test.first_item',:'first_semantic_inbox_item_id',true);
SELECT set_config('test.first_count',:'first_occurrence_count',true);
SELECT set_config('test.first_replayed',:'first_replayed',true);
SELECT set_config('test.replay_item',:'replay_semantic_inbox_item_id',true);
SELECT set_config('test.replay_count',:'replay_occurrence_count',true);
SELECT set_config('test.replay_replayed',:'replay_replayed',true);
SELECT set_config('test.second_item',:'second_semantic_inbox_item_id',true);
SELECT set_config('test.second_count',:'second_occurrence_count',true);
SELECT set_config('test.second_replayed',:'second_replayed',true);

DO $$
BEGIN
  IF current_setting('test.first_item')<>'01H00000000000000000004303'
     OR current_setting('test.first_count')<>'1'
     OR current_setting('test.first_replayed')<>'f'
     OR current_setting('test.replay_item')<>current_setting('test.first_item')
     OR current_setting('test.replay_count')<>'1'
     OR current_setting('test.replay_replayed')<>'t'
     OR current_setting('test.second_item')<>current_setting('test.first_item')
     OR current_setting('test.second_count')<>'2'
     OR current_setting('test.second_replayed')<>'f' THEN
    RAISE EXCEPTION 'candidate idempotency or occurrence aggregation failed';
  END IF;
END;
$$;

DO $$
BEGIN
  BEGIN
    PERFORM * FROM control_plane.accept_semantic_promotion_candidate(
      '01H00000000000000000004301','01H00000000000000000004303',
      '01H00000000000000000004304','01H00000000000000000004302',
      'xero','invoices',ARRAY['reference'],repeat('c',64),
      'finance.invoice_reference',repeat('f',64)
    );
    RAISE EXCEPTION 'a tampered candidate digest was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM * FROM control_plane.accept_semantic_promotion_candidate(
      '01H00000000000000000004301','01H00000000000000000004307',
      '01H00000000000000000004308','01H00000000000000000004309',
      'xero','invoices',ARRAY['reference'],repeat('e',64),
      'finance.invoice_reference',
      '9f0b5f5df3e12b5ed26f19a88f306fd8bf7cbc470a48c8e55ed66ef87476c503'
    );
    RAISE EXCEPTION 'a disconnected connection accepted a promotion candidate';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END;
$$;

SELECT control_plane.complete_semantic_promotion_relay_tenant(
  '01H00000000000000000004301','semantic-relay:sql-test',
  :'relay_lease_token',0,0,0
);

COMMIT;
