-- Post-upgrade assertions execute as the same deliberately non-BYPASSRLS
-- albert_migration_owner that applied 0153.
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean,message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Momence 0153 upgrade assertion failed: %',message;
  END IF;
END;
$$;

SELECT pg_temp.assert_true(
  current_user='albert_migration_owner',
  'the upgrade and its assertions must execute as albert_migration_owner'
);
SELECT pg_temp.assert_true(
  NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user),
  'the migration owner must not gain BYPASSRLS'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
      FROM (VALUES
        ('ingestion','batch_manifests'),
        ('ingestion','source_records'),
        ('ingestion','landing_commits'),
        ('ingestion','canonical_staging_batch_records'),
        ('source_momence','momence_sessions'),
        ('quality','connector_stream_state'),
        ('quality','reconciliation_snapshot'),
        ('quality','reconciliation_tombstone_application'),
        ('semantic_internal','canonical_transform_commits'),
        ('semantic_internal','canonical_record_state'),
        ('core','worker'),
        ('core','location'),
        ('core','entity_source_link')
      ) required(schema_name,table_name)
      LEFT JOIN pg_namespace namespace ON namespace.nspname=required.schema_name
      LEFT JOIN pg_class relation
        ON relation.relnamespace=namespace.oid
       AND relation.relname=required.table_name
     WHERE relation.oid IS NULL
        OR NOT relation.relrowsecurity
        OR NOT relation.relforcerowsecurity
  ),
  'every table temporarily opened by 0153 must finish with enabled and forced RLS'
);

-- With no tenant capability, the hardened RLS predicate fails closed even for
-- the table owner. It raises rather than silently presenting an empty scope.
DO $$
DECLARE record_count bigint;
BEGIN
  BEGIN
    SELECT count(*) INTO record_count FROM ingestion.source_records;
    RAISE EXCEPTION 'migration owner read landing rows without tenant context';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
  BEGIN
    SELECT count(*) INTO record_count FROM source_momence.momence_sessions;
    RAISE EXCEPTION 'migration owner read typed rows without tenant context';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
END;
$$;

SELECT set_config('albert.tenant_id','01H00000000000000000000Q01',true);

SELECT pg_temp.assert_true(
  (SELECT
     NOT source.tombstone
     AND source.external_account_reference='user:upgrade-fixture'
     AND source.source_version='2026-07-01T08:59:00Z'
     AND source.source_updated_at='2026-07-01T08:59:00Z'::timestamptz
     AND source.payload_hash=repeat('1',64)
     AND source.payload_batch_id='01H00000000000000000000Q03'
     AND source.sync_run_id='01H00000000000000000000Q04'
     AND source.first_ingested_at='2026-07-01T09:00:00Z'::timestamptz
     AND source.ingested_at='2026-07-01T09:00:00Z'::timestamptz
     AND source.normalized_payload=
       '{"schemaVersion":"momence-v1","tombstone":false,"metadata":{"id":501,"name":"Sunrise Yoga"}}'::jsonb
   FROM ingestion.source_records source
   WHERE source.tenant_id='01H00000000000000000000Q01'
     AND source.namespaced_source_key='momence:user:upgrade-fixture:Session:501'),
  'landing current state must exactly match the last committed live envelope'
);

SELECT pg_temp.assert_true(
  (SELECT
     to_jsonb(typed)-'first_ingested_at'
       =to_jsonb(jsonb_populate_record(
          NULL::source_momence.momence_sessions,live.staging_row
        ))-'first_ingested_at'
     AND typed.first_ingested_at='2026-07-01T09:00:00Z'::timestamptz
   FROM source_momence.momence_sessions typed
   JOIN ingestion.canonical_staging_batch_records live
     ON live.tenant_id=typed.tenant_id
    AND live.namespaced_source_key=typed.namespaced_source_key
    AND live.batch_id='01H00000000000000000000Q03'
    AND live.mapping_version='momence-v1'
   WHERE typed.tenant_id='01H00000000000000000000Q01'
     AND typed.namespaced_source_key='momence:user:upgrade-fixture:Session:501'),
  'every mutable typed field must exactly match the last committed live envelope'
);

SELECT pg_temp.assert_true(
  (SELECT
     NOT source.tombstone
     AND source.source_version='2026-07-15T08:00:00Z'
     AND source.source_updated_at='2026-07-15T08:00:00Z'::timestamptz
     AND source.payload_hash=repeat('7',64)
     AND source.payload_batch_id='01H00000000000000000000Q0Q'
     AND source.sync_run_id='01H00000000000000000000Q0R'
     AND source.ingested_at='2026-08-03T12:00:00Z'::timestamptz
   FROM ingestion.source_records source
   WHERE source.tenant_id='01H00000000000000000000Q01'
     AND source.namespaced_source_key='momence:user:upgrade-fixture:Session:502'),
  'the later live landing with an older vendor timestamp must remain current'
);
SELECT pg_temp.assert_true(
  (SELECT
     to_jsonb(typed)-'first_ingested_at'
       =to_jsonb(jsonb_populate_record(
          NULL::source_momence.momence_sessions,live.staging_row
        ))-'first_ingested_at'
     AND typed.first_ingested_at='2026-07-02T09:00:00Z'::timestamptz
   FROM source_momence.momence_sessions typed
   JOIN ingestion.canonical_staging_batch_records live
     ON live.tenant_id=typed.tenant_id
    AND live.namespaced_source_key=typed.namespaced_source_key
    AND live.batch_id='01H00000000000000000000Q0Q'
    AND live.mapping_version='momence-v1'
   WHERE typed.tenant_id='01H00000000000000000000Q01'
     AND typed.namespaced_source_key='momence:user:upgrade-fixture:Session:502'),
  'the already-live typed row must remain the exact later committed envelope'
);

SELECT pg_temp.assert_true(
  (SELECT count(*)=2
     FROM ingestion.canonical_staging_batch_records
    WHERE tenant_id='01H00000000000000000000Q01'
      AND namespaced_source_key='momence:user:upgrade-fixture:Session:501'),
  'the append-only live and invalid staging envelopes must remain immutable'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=4
     FROM ingestion.canonical_staging_batch_records
    WHERE tenant_id='01H00000000000000000000Q01'
      AND namespaced_source_key='momence:user:upgrade-fixture:Session:502'),
  'Session 502 must retain A, identical replay A-prime, invalid tombstone, and B'
);
SELECT pg_temp.assert_true(
  (SELECT
     replay.payload_hash=original.payload_hash
     AND replay.mapping_version=original.mapping_version
     AND replay.staging_row->>'source_version'
         =original.staging_row->>'source_version'
     AND (replay.staging_row->>'source_updated_at')::timestamptz
         >(best_live.staging_row->>'source_updated_at')::timestamptz
     AND NOT (replay.staging_row->>'tombstone')::boolean
     AND replay_commit.canonical_rows=0
   FROM ingestion.canonical_staging_batch_records replay
   JOIN ingestion.canonical_staging_batch_records original
     ON original.tenant_id=replay.tenant_id
    AND original.batch_id='01H00000000000000000000Q0E'
    AND original.namespaced_source_key=replay.namespaced_source_key
   JOIN ingestion.canonical_staging_batch_records best_live
     ON best_live.tenant_id=replay.tenant_id
    AND best_live.batch_id='01H00000000000000000000Q0Q'
    AND best_live.namespaced_source_key=replay.namespaced_source_key
   JOIN semantic_internal.canonical_transform_commits replay_commit
     ON replay_commit.tenant_id=replay.tenant_id
    AND replay_commit.batch_id=replay.batch_id
    AND replay_commit.mapping_version=replay.mapping_version
   WHERE replay.tenant_id='01H00000000000000000000Q01'
     AND replay.batch_id='01H00000000000000000000Q0T'
     AND replay.namespaced_source_key='momence:user:upgrade-fixture:Session:502'),
  'A-prime must remain an audited identical no-op replay even though its timestamp exceeds B'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=2
     FROM ingestion.landing_commits
    WHERE tenant_id='01H00000000000000000000Q01'
      AND batch_id IN (
        '01H00000000000000000000Q03','01H00000000000000000000Q09'
      )),
  'the original landing commit audit trail must remain immutable'
);

SELECT pg_temp.assert_true(
  (SELECT display_name='Asha Rao' AND active
          AND sync_run_id='01H00000000000000000000Q04'
     FROM core.worker
    WHERE tenant_id='01H00000000000000000000Q01'
      AND id='0BG8CP7M2D2FFQBZM9SMX68EJ1'),
  'the worker dimension must be restored while retaining its immutable first sync run'
);
SELECT pg_temp.assert_true(
  (SELECT name='Harbour Studio' AND timezone='Australia/Melbourne' AND active
          AND legal_entity_id IS NULL
          AND sync_run_id='01H00000000000000000000Q04'
     FROM core.location
    WHERE tenant_id='01H00000000000000000000Q01'
      AND id='29KHMKKBAZNXCSVGQWB8DEMEXR'),
  'the location dimension must be restored while retaining its immutable first sync run'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=2 AND bool_and(
     source_updated_at='2026-07-01T08:59:00Z'::timestamptz
     AND source_version='2026-07-01T08:59:00Z'
     AND payload_hash=repeat('1',64)
     AND batch_id='01H00000000000000000000Q03'
     AND sync_run_id='01H00000000000000000000Q04'
     AND connection_id='01H00000000000000000000Q02'
     AND mapping_version='momence-v1'
   )
   FROM semantic_internal.canonical_record_state
   WHERE tenant_id='01H00000000000000000000Q01'
     AND canonical_table IN ('worker','location')
     AND canonical_id IN (
       '0BG8CP7M2D2FFQBZM9SMX68EJ1','29KHMKKBAZNXCSVGQWB8DEMEXR'
     )),
  'canonical state must point to the exact restored live immutable envelope'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=2 AND bool_and(
     match_method='external_id'
     AND match_status='accepted'
     AND confidence_band='high'
     AND evidence=jsonb_build_object(
       'payload_hash',repeat('1',64),'mapping_version','momence-v1'
     )
     AND valid_from='1970-01-01T00:00:00Z'::timestamptz
     AND valid_to IS NULL
     AND confirmed_by IS NULL
     AND superseded_by IS NULL
     AND sync_run_id='01H00000000000000000000Q04'
   )
   FROM core.entity_source_link
   WHERE tenant_id='01H00000000000000000000Q01'
     AND link_id IN (
       '6WY5NDDK33W5BT4SFPT4FB792A','7QGJBTZ73CEDNDN5NCG1S97J1H'
     )),
  'deterministic native links must reopen with exact live evidence'
);
SELECT pg_temp.assert_true(
  (SELECT display_name='Mina Patel' AND active
          AND sync_run_id='01H00000000000000000000Q0F'
     FROM core.worker
    WHERE tenant_id='01H00000000000000000000Q01'
      AND id='13N16H2NPMN3NRBH65YYCHYH0S'),
  'canonical worker damage must heal from the best later live observation'
);
SELECT pg_temp.assert_true(
  (SELECT name='Garden Studio East' AND timezone='Australia/Sydney' AND active
          AND sync_run_id='01H00000000000000000000Q0F'
     FROM core.location
    WHERE tenant_id='01H00000000000000000000Q01'
      AND id='7P2HFJ8174CW6J8A26Y7HMY4T2'),
  'canonical location damage must heal from the best later live observation'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=2 AND bool_and(
     source_updated_at='2026-07-15T08:00:00Z'::timestamptz
     AND source_version='2026-07-15T08:00:00Z'
     AND payload_hash=repeat('7',64)
     AND batch_id='01H00000000000000000000Q0Q'
     AND sync_run_id='01H00000000000000000000Q0R'
     AND mapping_version='momence-v1'
   )
   FROM semantic_internal.canonical_record_state
   WHERE tenant_id='01H00000000000000000000Q01'
     AND canonical_id IN (
       '13N16H2NPMN3NRBH65YYCHYH0S','7P2HFJ8174CW6J8A26Y7HMY4T2'
     )),
  'canonical state must select the best transformed live observation despite its older vendor timestamp'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
      FROM semantic_internal.canonical_record_state
     WHERE tenant_id='01H00000000000000000000Q01'
       AND canonical_id IN (
         '13N16H2NPMN3NRBH65YYCHYH0S','7P2HFJ8174CW6J8A26Y7HMY4T2'
       )
       AND (
         batch_id='01H00000000000000000000Q0T'
         OR sync_run_id='01H00000000000000000000Q0V'
       )
  ),
  'A-prime must remain immutable audit evidence and never become canonical lineage'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=2 AND bool_and(
     match_status='accepted'
     AND evidence=jsonb_build_object(
       'payload_hash',repeat('7',64),'mapping_version','momence-v1'
     )
     AND valid_to IS NULL
     AND sync_run_id='01H00000000000000000000Q0F'
   )
   FROM core.entity_source_link
   WHERE tenant_id='01H00000000000000000000Q01'
     AND link_id IN (
       '2WPF311JQ4W42PH4ZT351N5CSA','6JRVQDM9BA80SA71HC2GXFJEMV'
     )),
  'canonical direct links must reopen on the best transformed live evidence'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
      FROM semantic_internal.canonical_record_state
     WHERE tenant_id='01H00000000000000000000Q01'
       AND (
         batch_id IN (
           '01H00000000000000000000Q09','01H00000000000000000000Q0H'
         )
         OR sync_run_id IN (
           '01H00000000000000000000Q0A','01H00000000000000000000Q0J'
         )
         OR payload_hash IN (repeat('4',64),repeat('6',64))
       )
  ),
  'no canonical state may retain the invalid bounded tombstone lineage'
);

DO $$
BEGIN
  UPDATE semantic_internal.canonical_record_state
     SET source_updated_at='2026-08-01T11:00:00Z',
         source_version='2026-08-01T11:00:00Z',
         payload_hash=repeat('4',64),
         batch_id='01H00000000000000000000Q09',
         sync_run_id='01H00000000000000000000Q0A',
         mapping_version='momence-v1'
   WHERE tenant_id='01H00000000000000000000Q01'
     AND canonical_table='worker'
     AND canonical_id='0BG8CP7M2D2FFQBZM9SMX68EJ1';
  RAISE EXCEPTION 'stale canonical Momence tombstone claim was accepted';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;
SELECT pg_temp.assert_true(
  (SELECT batch_id='01H00000000000000000000Q03'
          AND sync_run_id='01H00000000000000000000Q04'
          AND payload_hash=repeat('1',64)
     FROM semantic_internal.canonical_record_state
    WHERE tenant_id='01H00000000000000000000Q01'
      AND canonical_table='worker'
      AND canonical_id='0BG8CP7M2D2FFQBZM9SMX68EJ1'),
  'the canonical guard must reject and roll back stale invalid lineage claims'
);

SELECT pg_temp.assert_true(
  (SELECT
     deletion_strategy='no_absence_deletes'
     AND source_total_strategy='count_distinct_bounded_scan'
     AND reconciliation_completed_at IS NULL
     AND reconciliation_sweep_id IS NULL
     AND reconciliation_gap_count=0
     AND source_total IS NULL
     AND local_live_total IS NULL
   FROM quality.connector_stream_state
   WHERE tenant_id='01H00000000000000000000Q01'
     AND connection_id='01H00000000000000000000Q02'
     AND connection_generation=1
     AND stream='momence_sessions'),
  'the registered generation must transition to the bounded non-deleting policy'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=2 AND bool_and(status='failed')
     FROM quality.reconciliation_snapshot
    WHERE tenant_id='01H00000000000000000000Q01'
      AND connection_id='01H00000000000000000000Q02'
      AND connection_generation=1
      AND reconciliation_sweep_id='01H00000000000000000000Q0C'
      AND stream='momence_sessions'),
  'both scans captured under the superseded policy must be invalidated'
);

DO $$
BEGIN
  UPDATE ingestion.source_records
     SET tombstone=true,
         payload_batch_id='01H00000000000000000000Q09',
         sync_run_id='01H00000000000000000000Q0A',
         payload_hash=repeat('4',64),
         normalized_payload=jsonb_set(
           normalized_payload,'{tombstone}','true'::jsonb,true
         )
   WHERE tenant_id='01H00000000000000000000Q01'
     AND namespaced_source_key='momence:user:upgrade-fixture:Session:501';
  RAISE EXCEPTION 'stale Momence tombstone landing write was accepted';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;
SELECT pg_temp.assert_true(
  (SELECT NOT tombstone
     FROM ingestion.source_records
    WHERE tenant_id='01H00000000000000000000Q01'
      AND namespaced_source_key='momence:user:upgrade-fixture:Session:501'),
  'the landing guard must reject and roll back a stale authoritative worker write'
);

DO $$
BEGIN
  UPDATE quality.connector_stream_state
     SET deletion_strategy='authoritative_identity_scan',
         source_total_strategy='count_distinct_complete_scan'
   WHERE tenant_id='01H00000000000000000000Q01'
     AND connection_id='01H00000000000000000000Q02'
     AND connection_generation=1
     AND stream='momence_sessions';
  RAISE EXCEPTION 'superseded Momence stream policy was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END;
$$;
SELECT pg_temp.assert_true(
  (SELECT deletion_strategy='no_absence_deletes'
     FROM quality.connector_stream_state
    WHERE tenant_id='01H00000000000000000000Q01'
      AND connection_id='01H00000000000000000000Q02'
      AND connection_generation=1
      AND stream='momence_sessions'),
  'the policy constraint must reject stale authoritative registration'
);

ROLLBACK;
