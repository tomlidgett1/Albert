\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean,message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'connector-pack activation assertion failed: %',message;
  END IF;
END;
$$;

SET LOCAL ROLE albert_migration_owner;
INSERT INTO semantic_internal.connector_pack_release (
  connector_id,pack_version,release_sequence,predecessor_version,state,
  registered_by_migration
) VALUES (
  'xero','1.1.0',2,'1.0.0','candidate','9999_test_pack.sql'
);

RESET ROLE;
SET LOCAL ROLE transform_rw;
SELECT set_config('albert.tenant_id','01K80000000000000000000000',true);

INSERT INTO semantic_internal.tenant_capability (
  tenant_id,capability,source_key,connection_id,connector_id,available,
  support,reason_code,coverage,pack_version,source_watermark
) VALUES
  ('01K80000000000000000000000','finance.journals','xero:fixture:canonical:journals',
   '01K80000000000000000000001','xero',true,'full','canonical_stream_observed',
   '{"stream":"journals"}'::jsonb,'1.0.0','2026-08-03T00:00:00Z'),
  ('01K80000000000000000000000','finance.invoices','xero:fixture:canonical:invoices',
   '01K80000000000000000000001','xero',true,'full','canonical_stream_observed',
   '{"stream":"invoices"}'::jsonb,'1.0.0','2026-08-03T00:00:00Z'),
  ('01K80000000000000000000000','finance.journals','xero:fixture:canonical:journals',
   '01K80000000000000000000001','xero',true,'full','canonical_stream_observed',
   '{"stream":"journals"}'::jsonb,'1.1.0','2026-08-04T00:00:00Z')
ON CONFLICT (tenant_id,capability,source_key) DO UPDATE SET
  available=excluded.available,support=excluded.support,
  reason_code=excluded.reason_code,coverage=excluded.coverage,
  source_watermark=greatest(
    semantic_internal.tenant_capability.source_watermark,excluded.source_watermark
  ),evaluated_at=now();

-- A disconnected predecessor cannot publish a candidate. It remains blocking
-- until a migration-owner records exact control-plane retirement evidence.
INSERT INTO semantic_internal.tenant_capability (
  tenant_id,capability,source_key,connection_id,connector_id,available,
  support,reason_code,coverage,pack_version,source_watermark
) VALUES
  ('01K80000000000000000000000','finance.bank_transactions',
   'xero:retired:canonical:bank_transactions','01K80000000000000000000002',
   'xero',true,'full','canonical_stream_observed','{"stream":"bank_transactions"}'::jsonb,
   '1.0.0','2026-08-03T00:00:00Z'),
  ('01K80000000000000000000000','finance.payments',
   'xero:retired:canonical:payments','01K80000000000000000000002',
   'xero',true,'full','canonical_stream_observed','{"stream":"payments"}'::jsonb,
   '1.0.0','2026-08-03T00:00:00Z');

INSERT INTO semantic_internal.source_field_allowlist (
  tenant_id,connection_id,connector_id,source_schema,source_table,source_field,
  field_type,disposition,pii_class,authority_concept,documented_definition,
  pack_version,active
) VALUES
  ('01K80000000000000000000000','01K80000000000000000000001','xero',
   'source_xero','journals','source_type','text','governed_source_extension',
   'none','statutory_finance','Xero journal source type.','1.0.0',true),
  ('01K80000000000000000000000','01K80000000000000000000001','xero',
   'source_xero','journals','source_type','text','governed_source_extension',
   'none','statutory_finance','Xero journal source type.','1.1.0',true)
ON CONFLICT (tenant_id,connection_id,source_table,source_field) DO UPDATE SET
  connector_id=excluded.connector_id,active=excluded.active;

-- These are the exact conflict targets used by an already-running 1.0 worker.
-- Candidate rows must route before conflict resolution, leaving the base key
-- and predecessor contents intact while producing versioned shadow evidence.
SELECT pg_temp.assert_true(
  (SELECT count(*)=0
     FROM semantic_internal.tenant_capability
    WHERE tenant_id='01K80000000000000000000000' AND pack_version='1.1.0')
  AND (SELECT count(*)=1
     FROM semantic_internal.connector_pack_tenant_capability_snapshot
    WHERE tenant_id='01K80000000000000000000000' AND pack_version='1.1.0'),
  'candidate capabilities must route without replacing the old-worker base row'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=0
     FROM semantic_internal.source_field_allowlist
    WHERE tenant_id='01K80000000000000000000000' AND pack_version='1.1.0')
  AND (SELECT count(*)=1
     FROM semantic_internal.connector_pack_source_field_snapshot
    WHERE tenant_id='01K80000000000000000000000' AND pack_version='1.1.0'),
  'candidate allowlist fields must route without replacing the old-worker base row'
);
UPDATE semantic_internal.connector_pack_source_field_snapshot
   SET active=false,deactivated_at=now(),
       deactivation_reason='pack_reclassified_or_removed'
 WHERE tenant_id='01K80000000000000000000000'
   AND connection_id='01K80000000000000000000001'
   AND connector_id='xero' AND pack_version='1.1.0';
SELECT pg_temp.assert_true(
  (SELECT active=false
     FROM semantic_internal.connector_pack_source_field_snapshot
    WHERE tenant_id='01K80000000000000000000000'
      AND connection_id='01K80000000000000000000001'
      AND connector_id='xero' AND pack_version='1.1.0'),
  'candidate deactivation must target the shadow snapshot'
);

RESET ROLE;
SET LOCAL ROLE albert_migration_owner;
SELECT pg_temp.assert_true(
  (SELECT included=false
     FROM semantic_internal.connector_pack_evidence_index
    WHERE tenant_id='01K80000000000000000000000'
      AND connection_id='01K80000000000000000000001'
      AND connector_id='xero' AND pack_version='1.1.0'
      AND evidence_kind='source_field'),
  'candidate deactivation must update its shadow evidence index'
);

RESET ROLE;
SET LOCAL ROLE transform_rw;
SELECT set_config('albert.tenant_id','01K80000000000000000000000',true);
UPDATE semantic_internal.connector_pack_source_field_snapshot
   SET active=true,deactivated_at=NULL,deactivation_reason=NULL
 WHERE tenant_id='01K80000000000000000000000'
   AND connection_id='01K80000000000000000000001'
   AND connector_id='xero' AND pack_version='1.1.0';

RESET ROLE;
SET LOCAL ROLE semantic_ro;
SELECT set_config('albert.tenant_id','01K80000000000000000000000',true);

SELECT pg_temp.assert_true(
  (SELECT count(*)=4 AND bool_and(pack_version='1.0.0')
     FROM semantic_internal.active_tenant_capability
    WHERE tenant_id='01K80000000000000000000000'),
  'candidate capability rows must remain invisible before activation'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=1 AND bool_and(pack_version='1.0.0')
     FROM semantic_internal.active_source_field_allowlist
    WHERE tenant_id='01K80000000000000000000000'),
  'candidate source fields must remain invisible before activation'
);

RESET ROLE;
SET LOCAL ROLE albert_migration_owner;
SELECT pg_temp.assert_true(
  NOT coalesce((semantic_internal.connector_pack_activation_status(
    'xero','1.1.0','1.0.0'
  )->>'ready')::boolean,false),
  'activation must fail while predecessor capability keys are absent'
);
SELECT pg_temp.assert_true(
  (semantic_internal.connector_pack_activation_status(
    'xero','1.1.0','1.0.0'
  )->>'missingPredecessorCapabilityRows')::bigint=3,
  'preflight must identify missing rows across active and disconnected connections'
);

RESET ROLE;
SET LOCAL ROLE transform_rw;
SELECT set_config('albert.tenant_id','01K80000000000000000000000',true);
INSERT INTO semantic_internal.tenant_capability (
  tenant_id,capability,source_key,connection_id,connector_id,available,
  support,reason_code,coverage,pack_version,source_watermark
) VALUES (
  '01K80000000000000000000000','finance.invoices','xero:fixture:canonical:invoices',
  '01K80000000000000000000001','xero',true,'full','canonical_stream_observed',
  '{"stream":"invoices"}'::jsonb,'1.1.0','2026-08-04T00:00:00Z'
);

RESET ROLE;
SET LOCAL ROLE albert_migration_owner;
SELECT pg_temp.assert_true(
  NOT coalesce((semantic_internal.connector_pack_activation_status(
    'xero','1.1.0','1.0.0'
  )->>'ready')::boolean,false),
  'a disconnected predecessor must remain fail-closed without a retirement audit'
);
SELECT pg_temp.assert_true(
  (semantic_internal.connector_pack_activation_status(
    'xero','1.1.0','1.0.0'
  )->>'missingPredecessorCapabilityRows')::bigint=2,
  'only the disconnected connection should remain incomplete'
);
SELECT semantic_internal.retire_connector_pack_connection(
  '01K80000000000000000000000','01K80000000000000000000002','xero',
  '1.1.0','1.0.0','disconnected','01K80000000000000000000009',
  repeat('a',64)
);
SELECT pg_temp.assert_true(
  coalesce((semantic_internal.retire_connector_pack_connection(
    '01K80000000000000000000000','01K80000000000000000000002','xero',
    '1.1.0','1.0.0','disconnected','01K80000000000000000000009',
    repeat('a',64)
  )->>'idempotentReplay')::boolean,false),
  'an exact retirement retry must return the original durable evidence'
);
DO $$
BEGIN
  BEGIN
    PERFORM semantic_internal.retire_connector_pack_connection(
      '01K80000000000000000000000','01K80000000000000000000002','xero',
      '1.1.0','1.0.0','disconnected','01K80000000000000000000009',
      repeat('b',64)
    );
    RAISE EXCEPTION 'conflicting retirement evidence unexpectedly replaced the audit';
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM NOT LIKE 'connector pack retirement evidence conflicts%' THEN RAISE; END IF;
  END;
END;
$$;
SELECT pg_temp.assert_true(
  coalesce((semantic_internal.connector_pack_activation_status(
    'xero','1.1.0','1.0.0'
  )->>'ready')::boolean,false)
  AND (semantic_internal.connector_pack_activation_status(
    'xero','1.1.0','1.0.0'
  )->>'auditedRetiredConnections')::bigint=1,
  'an exact migration-owner retirement audit should unblock only that connection'
);
SELECT semantic_internal.activate_connector_pack('xero','1.1.0','1.0.0');

RESET ROLE;
SET LOCAL ROLE semantic_ro;
SELECT set_config('albert.tenant_id','01K80000000000000000000000',true);
SELECT pg_temp.assert_true(
  (SELECT count(*)=2 AND bool_and(pack_version='1.1.0')
     FROM semantic_internal.active_tenant_capability
    WHERE tenant_id='01K80000000000000000000000'),
  'one activation transaction must switch every capability key to 1.1.0'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=1 AND bool_and(pack_version='1.1.0')
     FROM semantic_internal.active_source_field_allowlist
    WHERE tenant_id='01K80000000000000000000000'),
  'source exploration must switch in the same activation transaction'
);

RESET ROLE;
SET LOCAL ROLE transform_rw;
SELECT set_config('albert.tenant_id','01K80000000000000000000000',true);
DO $$
BEGIN
  BEGIN
    INSERT INTO semantic_internal.tenant_capability (
      tenant_id,capability,source_key,connection_id,connector_id,available,
      support,reason_code,coverage,pack_version,source_watermark
    ) VALUES (
      '01K80000000000000000000000','finance.payments','xero:stale:canonical:payments',
      '01K80000000000000000000001','xero',true,'full',
      'canonical_stream_observed','{"stream":"payments"}'::jsonb,'1.0.0',now()
    );
    RAISE EXCEPTION 'retired capability evidence unexpectedly accepted an insert';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    IF SQLERRM NOT LIKE 'connector_pack_retired:xero:1.0.0%' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE semantic_internal.tenant_capability
       SET evaluated_at=now()
     WHERE tenant_id='01K80000000000000000000000'
       AND connector_id='xero' AND pack_version='1.0.0';
    RAISE EXCEPTION 'retired capability evidence unexpectedly remained writable';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    IF SQLERRM NOT LIKE 'connector_pack_retired:xero:1.0.0%' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE semantic_internal.source_field_allowlist
       SET active=false
     WHERE tenant_id='01K80000000000000000000000'
       AND connector_id='xero' AND pack_version='1.0.0';
    RAISE EXCEPTION 'retired source-field evidence unexpectedly remained writable';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    IF SQLERRM NOT LIKE 'connector_pack_retired:xero:1.0.0%' THEN RAISE; END IF;
  END;
END;
$$;

-- Active sequence>1 writes continue landing in the shadow snapshots. Seed
-- both record types for the retired connection so the deletion assertion below
-- proves the signed purge removes the new storage as well as legacy base rows.
INSERT INTO semantic_internal.tenant_capability (
  tenant_id,capability,source_key,connection_id,connector_id,available,
  support,reason_code,coverage,pack_version,source_watermark
) VALUES (
  '01K80000000000000000000000','finance.payments','xero:retired:canonical:payments',
  '01K80000000000000000000002','xero',true,'full','canonical_stream_observed',
  '{"stream":"payments"}'::jsonb,'1.1.0',now()
) ON CONFLICT (tenant_id,capability,source_key) DO UPDATE SET
  available=excluded.available,support=excluded.support,
  reason_code=excluded.reason_code,coverage=excluded.coverage,
  source_watermark=excluded.source_watermark,evaluated_at=now();
INSERT INTO semantic_internal.source_field_allowlist (
  tenant_id,connection_id,connector_id,source_schema,source_table,source_field,
  field_type,disposition,pii_class,authority_concept,documented_definition,
  pack_version,active
) VALUES (
  '01K80000000000000000000000','01K80000000000000000000002','xero',
  'source_xero','payments','source_type','text','governed_source_extension',
  'none','statutory_finance','Xero payment source type.','1.1.0',true
) ON CONFLICT (tenant_id,connection_id,source_table,source_field) DO UPDATE SET
  connector_id=excluded.connector_id,active=excluded.active;

RESET ROLE;
SET LOCAL ROLE albert_migration_owner;
SELECT pg_temp.assert_true(
  (SELECT count(*)=1
     FROM semantic_internal.connector_pack_activation_event
    WHERE connector_id='xero' AND release_sequence=2
      AND previous_pack_version='1.0.0'
      AND activated_pack_version='1.1.0'
      AND activation_evidence->'ready'='true'::jsonb
      AND activation_evidence->'activationRequired'='true'::jsonb
      AND (activation_evidence->>'auditedRetiredConnections')::bigint=1),
  'activation must append sequence-bound audit evidence'
);

DO $$
DECLARE purge_result jsonb;verification jsonb;
BEGIN
  BEGIN
    DELETE FROM semantic_internal.connector_pack_connection_retirement
     WHERE tenant_id='01K80000000000000000000000'
       AND connection_id='01K80000000000000000000002';
    RAISE EXCEPTION 'retirement evidence unexpectedly allowed an ordinary delete';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    IF SQLERRM NOT LIKE 'connector pack connection retirements are append-only%' THEN
      RAISE;
    END IF;
  END;

  purge_result:=deletion_internal.purge_connection_pre_capability(
    '01K80000000000000000000000','01K80000000000000000000002'
  );
  verification:=deletion_internal.verify_connection_pre_capability(
    '01K80000000000000000000000','01K80000000000000000000002'
  );
  IF coalesce((purge_result->>'verified')::boolean,false) IS NOT TRUE
     OR coalesce((verification->>'verified')::boolean,false) IS NOT TRUE
     OR coalesce((verification->>'remainingRows')::bigint,-1)<>0
     OR EXISTS (
       SELECT 1 FROM semantic_internal.connector_pack_connection_retirement
        WHERE tenant_id='01K80000000000000000000000'
          AND connection_id='01K80000000000000000000002'
     ) OR EXISTS (
       SELECT 1 FROM semantic_internal.connector_pack_evidence_index
        WHERE tenant_id='01K80000000000000000000000'
          AND connection_id='01K80000000000000000000002'
     ) OR EXISTS (
       SELECT 1 FROM semantic_internal.tenant_capability
        WHERE tenant_id='01K80000000000000000000000'
          AND connection_id='01K80000000000000000000002'
     ) OR EXISTS (
       SELECT 1 FROM semantic_internal.connector_pack_tenant_capability_snapshot
        WHERE tenant_id='01K80000000000000000000000'
          AND connection_id='01K80000000000000000000002'
     ) OR EXISTS (
       SELECT 1 FROM semantic_internal.connector_pack_source_field_snapshot
        WHERE tenant_id='01K80000000000000000000000'
          AND connection_id='01K80000000000000000000002'
     ) THEN
    RAISE EXCEPTION 'connector-pack connection deletion left residual evidence: purge %, verify %',
      purge_result,verification;
  END IF;
END;
$$;

-- The signed purge removes replay gates before the older reconciliation layer
-- deletes stream state. An authorized row delete must keep that gate absent
-- even while sibling Lightspeed streams still exist.
SELECT set_config('albert.tenant_id','01K80000000000000000000010',true);
INSERT INTO quality.connector_stream_state (
  tenant_id,connection_id,connection_generation,connector_id,stream,required,
  late_edit_strategy,deletion_strategy,source_total_strategy
) VALUES
  ('01K80000000000000000000010','01K80000000000000000000011',1,
   'lightspeed-r','vendors',true,'modified_field','soft_delete','provider_reported'),
  ('01K80000000000000000000010','01K80000000000000000000011',1,
   'lightspeed-r','orders',true,'modified_field','soft_delete','provider_reported'),
  ('01K80000000000000000000010','01K80000000000000000000011',1,
   'lightspeed-r','sales',true,'modified_field','soft_delete','provider_reported');
SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1 FROM semantic_internal.lightspeed_supplier_replay_gate_index
     WHERE tenant_id='01K80000000000000000000010'
       AND connection_id='01K80000000000000000000011'
  ),
  'Lightspeed stream health must create its fail-closed replay gate'
);
SELECT set_config('albert.deletion_authorized','on',true);
DELETE FROM quality.connector_stream_state
 WHERE tenant_id='01K80000000000000000000010'
   AND connection_id='01K80000000000000000000011'
   AND stream='vendors';
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM semantic_internal.lightspeed_supplier_replay_gate_index
     WHERE tenant_id='01K80000000000000000000010'
       AND connection_id='01K80000000000000000000011'
  ),
  'authorized stream-state erasure must not resurrect a deleted replay gate'
);

RESET ROLE;
ROLLBACK;
