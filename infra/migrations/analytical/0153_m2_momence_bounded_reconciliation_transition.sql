-- Momence operational windows and note-discovered payment transactions were
-- initially admitted as authoritative identity scans. Transition existing
-- generations without allowing cached two-pass evidence, an already-enqueued
-- apply phase, or an older worker binary to infer deletion from those bounded
-- populations.

BEGIN;

-- Serialize the policy cutover with every source landing transaction before
-- invalidating evidence. The trigger installed later in this same transaction
-- then governs all writes after this lock is released.
-- Landing acquires manifest lineage before current-source state; use that same
-- order here so the fleet cutover cannot deadlock an in-flight page commit.
LOCK TABLE ingestion.batch_manifests IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ingestion.source_records IN SHARE ROW EXCLUSIVE MODE;
-- ACCESS EXCLUSIVE drains canonical readers as well as landing writers. A
-- transform which already consumed an invalid immutable envelope must finish
-- (and become visible to the fail-closed check below) before repair proceeds.
LOCK TABLE ingestion.canonical_staging_batch_records IN ACCESS EXCLUSIVE MODE;
LOCK TABLE ingestion.landing_commits IN SHARE ROW EXCLUSIVE MODE;
-- Canonical transforms acquire current-state, dimension/link and commit locks
-- after reading immutable staging. Taking the same order drains every transform
-- which could already have consumed a legacy tombstone and prevents a queued
-- old binary from racing the repair below.
LOCK TABLE semantic_internal.canonical_record_state IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE core.worker IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE core.location IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE core.entity_source_link IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE semantic_internal.canonical_transform_commits IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE stream_name text;
BEGIN
  FOREACH stream_name IN ARRAY ARRAY[
    'momence_appointments','momence_sessions','momence_session_details',
    'momence_session_bookings','momence_member_sessions',
    'momence_member_appointments','momence_public_sessions',
    'momence_payment_transactions'
  ] LOOP
    EXECUTE format(
      'LOCK TABLE source_momence.%I IN SHARE ROW EXCLUSIVE MODE',stream_name
    );
  END LOOP;
END
$$;
LOCK TABLE quality.connector_stream_state IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE quality.reconciliation_snapshot IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE quality.reconciliation_tombstone_application IN SHARE ROW EXCLUSIVE MODE;

-- The former authoritative policy may already have hidden a live row solely
-- because it was absent from a bounded window (or from the current set of
-- note-linked payment ids). A flag-only resurrection is unsafe: the invalid
-- reconciliation row carries a synthetic source timestamp, hash, batch and
-- sync run which can outrank a later vendor observation. Restore the complete
-- last live envelope and typed projection from the append-only canonical
-- staging history instead. The invalid and restored envelopes remain
-- immutable, as does reconciliation_tombstone_application, so the repair has
-- exact before/after audit lineage.

-- albert_migration_owner deliberately has neither BYPASSRLS nor a tenant
-- capability. Lift FORCE only while this table-owner transaction performs the
-- fleet-wide repair; a failure rolls the DDL back with the data changes.
ALTER TABLE ingestion.source_records NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ingestion.canonical_staging_batch_records NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ingestion.batch_manifests NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ingestion.landing_commits NO FORCE ROW LEVEL SECURITY;
ALTER TABLE semantic_internal.canonical_transform_commits NO FORCE ROW LEVEL SECURITY;
ALTER TABLE semantic_internal.canonical_record_state NO FORCE ROW LEVEL SECURITY;
ALTER TABLE core.worker NO FORCE ROW LEVEL SECURITY;
ALTER TABLE core.location NO FORCE ROW LEVEL SECURITY;
ALTER TABLE core.entity_source_link NO FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.connector_stream_state NO FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.reconciliation_snapshot NO FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.reconciliation_tombstone_application NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE stream_name text;
BEGIN
  FOREACH stream_name IN ARRAY ARRAY[
    'momence_appointments','momence_sessions','momence_session_details',
    'momence_session_bookings','momence_member_sessions',
    'momence_member_appointments','momence_public_sessions',
    'momence_payment_transactions'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE source_momence.%I NO FORCE ROW LEVEL SECURITY',stream_name
    );
  END LOOP;
END
$$;

CREATE TEMPORARY TABLE momence_bounded_tombstone_repair
ON COMMIT DROP
AS
WITH affected AS MATERIALIZED (
  SELECT source.*
    FROM ingestion.source_records source
   WHERE source.connector_key='momence'
     AND source.tombstone
     AND source.stream IN (
       'momence_appointments','momence_sessions','momence_session_details',
       'momence_session_bookings','momence_member_sessions',
       'momence_member_appointments','momence_public_sessions',
       'momence_payment_transactions'
     )
), repair_lineage AS (
  SELECT
    affected.tenant_id,affected.namespaced_source_key,
    affected.connection_id,affected.stream,
    affected.source_object_type,affected.source_record_id,
    affected.payload_batch_id AS invalid_batch_id,
    affected.sync_run_id AS invalid_sync_run_id,
    affected.payload_hash AS invalid_payload_hash,
    application_count.candidate_count AS tombstone_application_count,
    application.connection_generation AS tombstone_connection_generation,
    application.reconciliation_sweep_id AS tombstone_reconciliation_sweep_id,
    application.first_snapshot_batch_id AS tombstone_first_snapshot_batch_id,
    application.verification_snapshot_batch_id AS tombstone_verification_snapshot_batch_id,
    application.applied_at AS tombstone_applied_at,
    invalid_count.candidate_count AS invalid_lineage_count,
    invalid.staging_row AS invalid_staging_row,
    invalid.mapping_version AS invalid_mapping_version,
    invalid.created_at AS invalid_staged_at,
    invalid.committed_at AS invalid_committed_at,
    restored.batch_id AS restored_batch_id,
    restored.sync_run_id AS restored_sync_run_id,
    restored.payload_hash AS restored_payload_hash,
    restored.mapping_version AS restored_mapping_version,
    restored.staging_row AS restored_staging_row,
    restored.created_at AS restored_staged_at,
    restored.committed_at AS restored_committed_at
  FROM affected
  LEFT JOIN LATERAL (
    SELECT count(*)::integer AS candidate_count
      FROM quality.reconciliation_tombstone_application applied
     WHERE applied.tenant_id=affected.tenant_id
       AND applied.connection_id=affected.connection_id
       AND applied.stream=affected.stream
       AND applied.namespaced_source_key=affected.namespaced_source_key
       AND applied.source_object_type=affected.source_object_type
       AND applied.source_record_id=affected.source_record_id
       AND applied.tombstone_batch_id=affected.payload_batch_id
  ) application_count ON true
  LEFT JOIN LATERAL (
    SELECT applied.*
      FROM quality.reconciliation_tombstone_application applied
     WHERE applied.tenant_id=affected.tenant_id
       AND applied.connection_id=affected.connection_id
       AND applied.stream=affected.stream
       AND applied.namespaced_source_key=affected.namespaced_source_key
       AND applied.source_object_type=affected.source_object_type
       AND applied.source_record_id=affected.source_record_id
       AND applied.tombstone_batch_id=affected.payload_batch_id
     ORDER BY applied.applied_at DESC,applied.reconciliation_sweep_id DESC
     LIMIT 1
  ) application ON application_count.candidate_count<=1
  LEFT JOIN LATERAL (
    SELECT count(*)::integer AS candidate_count
      FROM ingestion.canonical_staging_batch_records staged
      JOIN ingestion.landing_commits landing
        ON landing.tenant_id=staged.tenant_id
       AND landing.batch_id=staged.batch_id
       AND landing.sync_run_id=staged.sync_run_id
       AND landing.mapping_version=staged.mapping_version
       AND landing.status='committed'
     WHERE staged.tenant_id=affected.tenant_id
       AND staged.batch_id=affected.payload_batch_id
       AND staged.namespaced_source_key=affected.namespaced_source_key
       AND staged.connection_id=affected.connection_id
       AND staged.sync_run_id=affected.sync_run_id
       AND staged.connector_id='momence'
       AND staged.stream=affected.stream
       AND staged.source_object_type=affected.source_object_type
       AND staged.source_record_id=affected.source_record_id
       AND staged.payload_hash=affected.payload_hash
       AND staged.staging_row->>'tombstone'='true'
  ) invalid_count ON true
  LEFT JOIN LATERAL (
    SELECT staged.*,landing.committed_at
      FROM ingestion.canonical_staging_batch_records staged
      JOIN ingestion.landing_commits landing
        ON landing.tenant_id=staged.tenant_id
       AND landing.batch_id=staged.batch_id
       AND landing.sync_run_id=staged.sync_run_id
       AND landing.mapping_version=staged.mapping_version
       AND landing.status='committed'
     WHERE staged.tenant_id=affected.tenant_id
       AND staged.batch_id=affected.payload_batch_id
       AND staged.namespaced_source_key=affected.namespaced_source_key
       AND staged.connection_id=affected.connection_id
       AND staged.sync_run_id=affected.sync_run_id
       AND staged.connector_id='momence'
       AND staged.stream=affected.stream
       AND staged.source_object_type=affected.source_object_type
       AND staged.source_record_id=affected.source_record_id
       AND staged.payload_hash=affected.payload_hash
       AND staged.staging_row->>'tombstone'='true'
     ORDER BY staged.mapping_version
     LIMIT 1
  ) invalid ON invalid_count.candidate_count=1
  LEFT JOIN LATERAL (
    SELECT staged.*,landing.committed_at
      FROM ingestion.canonical_staging_batch_records staged
      JOIN ingestion.landing_commits landing
        ON landing.tenant_id=staged.tenant_id
       AND landing.batch_id=staged.batch_id
       AND landing.sync_run_id=staged.sync_run_id
       AND landing.mapping_version=staged.mapping_version
       AND landing.status='committed'
      JOIN ingestion.batch_manifests manifest
        ON manifest.tenant_id=staged.tenant_id
       AND manifest.batch_id=staged.batch_id
       AND manifest.connection_id=staged.connection_id
       AND manifest.sync_run_id=staged.sync_run_id
       AND manifest.connector_key='momence'
       AND manifest.stream=staged.stream
     WHERE staged.tenant_id=affected.tenant_id
       AND staged.namespaced_source_key=affected.namespaced_source_key
       AND staged.connection_id=affected.connection_id
       AND staged.connector_id='momence'
       AND staged.stream=affected.stream
       AND staged.source_object_type=affected.source_object_type
       AND staged.source_record_id=affected.source_record_id
       AND staged.batch_id<>affected.payload_batch_id
       AND staged.staging_row->>'tombstone'='false'
       AND (
         landing.committed_at<invalid.committed_at
         OR landing.committed_at=invalid.committed_at
            AND staged.created_at<invalid.created_at
       )
       AND staged.staging_row-ARRAY[
         'tenant_id','namespaced_source_key','connection_id',
         'external_account_reference','source_object_type','source_record_id',
         'source_version','source_updated_at','payload_hash','payload_batch_id',
         'sync_run_id','tombstone','mapping_version','first_ingested_at','ingested_at'
       ]::text[]=invalid.staging_row-ARRAY[
         'tenant_id','namespaced_source_key','connection_id',
         'external_account_reference','source_object_type','source_record_id',
         'source_version','source_updated_at','payload_hash','payload_batch_id',
         'sync_run_id','tombstone','mapping_version','first_ingested_at','ingested_at'
       ]::text[]
     ORDER BY landing.committed_at DESC,staged.created_at DESC,
              manifest.extracted_at DESC,staged.batch_id DESC,staged.mapping_version DESC
     LIMIT 1
  ) restored ON invalid_count.candidate_count=1
)
SELECT * FROM repair_lineage;

DO $$
DECLARE expected_count bigint;
DECLARE repair_count bigint;
DECLARE repaired_application_count bigint;
BEGIN
  SELECT count(*) INTO expected_count
    FROM ingestion.source_records source
   WHERE source.connector_key='momence'
     AND source.tombstone
     AND source.stream IN (
       'momence_appointments','momence_sessions','momence_session_details',
       'momence_session_bookings','momence_member_sessions',
       'momence_member_appointments','momence_public_sessions',
       'momence_payment_transactions'
     );
  SELECT count(*) INTO repair_count FROM momence_bounded_tombstone_repair;
  IF repair_count<>expected_count THEN
    RAISE EXCEPTION 'Momence bounded tombstone repair population changed under lock: expected %, found %',
      expected_count,repair_count;
  END IF;
  IF EXISTS (
    SELECT 1 FROM momence_bounded_tombstone_repair
     WHERE invalid_lineage_count<>1 OR invalid_staging_row IS NULL
  ) THEN
    RAISE EXCEPTION 'Momence bounded tombstone has no unique committed invalid staging envelope';
  END IF;
  IF EXISTS (
    SELECT 1 FROM momence_bounded_tombstone_repair
     WHERE tombstone_application_count>1
  ) THEN
    RAISE EXCEPTION 'Momence bounded tombstone has ambiguous application audit lineage';
  END IF;
  SELECT count(*) INTO repaired_application_count
    FROM momence_bounded_tombstone_repair
   WHERE tombstone_application_count=1;
  IF repaired_application_count<>(
    SELECT count(*)
      FROM quality.reconciliation_tombstone_application applied
      JOIN momence_bounded_tombstone_repair repair
        ON repair.tenant_id=applied.tenant_id
       AND repair.connection_id=applied.connection_id
       AND repair.stream=applied.stream
       AND repair.namespaced_source_key=applied.namespaced_source_key
       AND repair.source_object_type=applied.source_object_type
       AND repair.source_record_id=applied.source_record_id
       AND repair.invalid_batch_id=applied.tombstone_batch_id
  ) THEN
    RAISE EXCEPTION 'Momence bounded tombstone application audit changed while repair was locked';
  END IF;
  IF EXISTS (
    SELECT 1 FROM momence_bounded_tombstone_repair
     WHERE restored_staging_row IS NULL
       OR restored_staging_row->>'tombstone' IS DISTINCT FROM 'false'
       OR restored_batch_id IS NULL OR restored_sync_run_id IS NULL
       OR restored_payload_hash IS NULL OR restored_mapping_version IS NULL
       OR restored_staging_row->>'ingested_at' IS NULL
  ) THEN
    RAISE EXCEPTION 'Momence bounded tombstone lacks exact committed pre-tombstone staging lineage';
  END IF;
  IF EXISTS (
    SELECT 1 FROM momence_bounded_tombstone_repair repair
     JOIN ingestion.source_records source
       ON source.tenant_id=repair.tenant_id
      AND source.namespaced_source_key=repair.namespaced_source_key
    WHERE source.normalized_payload->>'tombstone' IS DISTINCT FROM 'true'
       OR source.payload_batch_id<>repair.invalid_batch_id
       OR source.sync_run_id<>repair.invalid_sync_run_id
       OR source.payload_hash<>repair.invalid_payload_hash
  ) THEN
    RAISE EXCEPTION 'Momence bounded tombstone current source lineage conflicts with immutable staging';
  END IF;
END
$$;

-- Validate that the current typed projection is the exact invalid immutable
-- envelope, then replace every mutable column from the exact last live row.
-- first_ingested_at is intentionally retained: reconciliation upserts never
-- changed that original observation timestamp.
DO $$
DECLARE stream_name text;
DECLARE assignment_list text;
DECLARE mismatch_count bigint;
DECLARE repaired_count bigint:=0;
DECLARE current_count bigint;
BEGIN
  FOREACH stream_name IN ARRAY ARRAY[
    'momence_appointments','momence_sessions','momence_session_details',
    'momence_session_bookings','momence_member_sessions',
    'momence_member_appointments','momence_public_sessions',
    'momence_payment_transactions'
  ] LOOP
    SELECT string_agg(
      format('%1$I=(repair.restored_row).%1$I',attribute.attname),
      ',' ORDER BY attribute.attnum
    ) INTO assignment_list
      FROM pg_attribute attribute
     WHERE attribute.attrelid=format('source_momence.%I',stream_name)::regclass
       AND attribute.attnum>0 AND NOT attribute.attisdropped
       AND attribute.attname NOT IN (
         'tenant_id','namespaced_source_key','first_ingested_at'
       );
    IF assignment_list IS NULL THEN
      RAISE EXCEPTION 'Momence bounded tombstone repair found no mutable columns for %',stream_name;
    END IF;

    EXECUTE format($sql$
      SELECT count(*)
        FROM momence_bounded_tombstone_repair lineage
        LEFT JOIN source_momence.%1$I typed
          ON typed.tenant_id=lineage.tenant_id
         AND typed.namespaced_source_key=lineage.namespaced_source_key
        CROSS JOIN LATERAL (
          SELECT jsonb_populate_record(
            NULL::source_momence.%1$I,lineage.invalid_staging_row
          ) AS invalid_row
        ) expected
       WHERE lineage.stream=%2$L
         AND (
           typed.namespaced_source_key IS NULL
           OR to_jsonb(typed)-'first_ingested_at'
              IS DISTINCT FROM to_jsonb(expected.invalid_row)-'first_ingested_at'
         )
    $sql$,stream_name,stream_name) INTO mismatch_count;
    IF mismatch_count<>0 THEN
      RAISE EXCEPTION 'Momence bounded tombstone typed lineage conflicts in % (% rows)',
        stream_name,mismatch_count;
    END IF;

    EXECUTE format($sql$
      UPDATE source_momence.%1$I typed
         SET %2$s
        FROM (
          SELECT lineage.*,
                 jsonb_populate_record(
                   NULL::source_momence.%1$I,lineage.restored_staging_row
                 ) AS restored_row
            FROM momence_bounded_tombstone_repair lineage
           WHERE lineage.stream=%3$L
        ) repair
       WHERE typed.tenant_id=repair.tenant_id
         AND typed.namespaced_source_key=repair.namespaced_source_key
    $sql$,stream_name,assignment_list,stream_name);
    GET DIAGNOSTICS current_count=ROW_COUNT;
    repaired_count:=repaired_count+current_count;

    EXECUTE format($sql$
      SELECT count(*)
        FROM momence_bounded_tombstone_repair lineage
        LEFT JOIN source_momence.%1$I typed
          ON typed.tenant_id=lineage.tenant_id
         AND typed.namespaced_source_key=lineage.namespaced_source_key
        CROSS JOIN LATERAL (
          SELECT jsonb_populate_record(
            NULL::source_momence.%1$I,lineage.restored_staging_row
          ) AS restored_row
        ) expected
       WHERE lineage.stream=%2$L
         AND (
           typed.namespaced_source_key IS NULL
           OR to_jsonb(typed)-'first_ingested_at'
              IS DISTINCT FROM to_jsonb(expected.restored_row)-'first_ingested_at'
         )
    $sql$,stream_name,stream_name) INTO mismatch_count;
    IF mismatch_count<>0 THEN
      RAISE EXCEPTION 'Momence bounded tombstone typed restore failed in % (% rows)',
        stream_name,mismatch_count;
    END IF;
  END LOOP;

  UPDATE ingestion.source_records source
     SET external_account_reference=repair.restored_staging_row->>'external_account_reference',
         source_version=repair.restored_staging_row->>'source_version',
         source_updated_at=(repair.restored_staging_row->>'source_updated_at')::timestamptz,
         payload_hash=repair.restored_payload_hash,
         normalized_payload=jsonb_set(
           source.normalized_payload,'{tombstone}','false'::jsonb,true
         ),
         tombstone=false,
         payload_batch_id=repair.restored_batch_id,
         sync_run_id=repair.restored_sync_run_id,
         ingested_at=(repair.restored_staging_row->>'ingested_at')::timestamptz
    FROM momence_bounded_tombstone_repair repair
   WHERE source.tenant_id=repair.tenant_id
     AND source.namespaced_source_key=repair.namespaced_source_key;
  GET DIAGNOSTICS current_count=ROW_COUNT;
  IF current_count<>repaired_count THEN
    RAISE EXCEPTION 'Momence bounded tombstone source/typed repair counts disagree: source %, typed %',
      current_count,repaired_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM ingestion.source_records source
     WHERE source.connector_key='momence'
       AND source.tombstone
       AND source.stream IN (
         'momence_appointments','momence_sessions','momence_session_details',
         'momence_session_bookings','momence_member_sessions',
         'momence_member_appointments','momence_public_sessions',
         'momence_payment_transactions'
       )
  ) THEN
    RAISE EXCEPTION 'Momence bounded-policy source tombstones remain after repair';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM ingestion.source_records source
     WHERE source.connector_key='momence'
       AND source.stream IN (
         'momence_appointments','momence_sessions','momence_session_details',
         'momence_session_bookings','momence_member_sessions',
         'momence_member_appointments','momence_public_sessions',
         'momence_payment_transactions'
       )
       AND source.normalized_payload->>'tombstone' IS DISTINCT FROM 'false'
  ) THEN
    RAISE EXCEPTION 'Momence bounded-policy normalized tombstones remain after repair';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM momence_bounded_tombstone_repair repair
      JOIN ingestion.source_records source
        ON source.tenant_id=repair.tenant_id
       AND source.namespaced_source_key=repair.namespaced_source_key
     WHERE source.tombstone
        OR source.payload_batch_id<>repair.restored_batch_id
        OR source.sync_run_id<>repair.restored_sync_run_id
        OR source.payload_hash<>repair.restored_payload_hash
        OR source.source_version IS DISTINCT FROM
           repair.restored_staging_row->>'source_version'
        OR source.source_updated_at IS DISTINCT FROM
           (repair.restored_staging_row->>'source_updated_at')::timestamptz
        OR source.ingested_at IS DISTINCT FROM
           (repair.restored_staging_row->>'ingested_at')::timestamptz
  ) THEN
    RAISE EXCEPTION 'Momence bounded-policy exact source lineage restore failed';
  END IF;

  RAISE NOTICE 'Restored % Momence records from invalid bounded tombstones using exact immutable staging lineage',
    current_count;
END
$$;

-- A legacy tombstone may already have been transformed before the cutover. In
-- that case the synthetic reconciliation timestamp can have claimed shared
-- Teacher/Location state, deactivated the canonical dimension, and closed its
-- deterministic direct source link. Rebuild only state which still points at
-- an invalid tombstone. Replay immutable, successfully transformed observations
-- in transform order with the exact canonical-record admission rule. Selecting
-- the greatest source timestamp is not equivalent: a later identical replay is
-- a no-op and must not suppress an intervening changed observation.
CREATE TEMPORARY TABLE momence_bounded_canonical_repair
ON COMMIT DROP
AS
WITH invalid_transforms AS MATERIALIZED (
  SELECT application.tenant_id,application.connection_id,application.stream,
         application.namespaced_source_key,application.source_object_type,
         application.source_record_id,
         staged.batch_id AS invalid_batch_id,
         staged.sync_run_id AS invalid_sync_run_id,
         staged.payload_hash AS invalid_payload_hash,
         staged.mapping_version AS invalid_mapping_version,
         committed.completed_at AS invalid_transform_completed_at
    FROM quality.reconciliation_tombstone_application application
    JOIN ingestion.canonical_staging_batch_records staged
      ON staged.tenant_id=application.tenant_id
     AND staged.connection_id=application.connection_id
     AND staged.batch_id=application.tombstone_batch_id
     AND staged.stream=application.stream
     AND staged.namespaced_source_key=application.namespaced_source_key
     AND staged.source_object_type=application.source_object_type
     AND staged.source_record_id=application.source_record_id
     AND staged.connector_id='momence'
     AND staged.staging_row->>'tombstone'='true'
    JOIN ingestion.landing_commits landing
      ON landing.tenant_id=staged.tenant_id
     AND landing.batch_id=staged.batch_id
     AND landing.sync_run_id=staged.sync_run_id
     AND landing.mapping_version=staged.mapping_version
     AND landing.status='committed'
    JOIN semantic_internal.canonical_transform_commits committed
      ON committed.tenant_id=staged.tenant_id
     AND committed.batch_id=staged.batch_id
     AND committed.sync_run_id=staged.sync_run_id
     AND committed.connection_id=staged.connection_id
     AND committed.connector_id='momence'
     AND committed.stream=staged.stream
     AND committed.mapping_version=staged.mapping_version
   WHERE application.stream IN (
     'momence_appointments','momence_sessions','momence_session_details',
     'momence_session_bookings','momence_member_sessions',
     'momence_member_appointments','momence_public_sessions',
     'momence_payment_transactions'
   )
), impacted AS MATERIALIZED (
  SELECT state.*,invalid.invalid_transform_completed_at
    FROM invalid_transforms invalid
    JOIN semantic_internal.canonical_record_state state
      ON state.tenant_id=invalid.tenant_id
     AND state.batch_id=invalid.invalid_batch_id
     AND state.sync_run_id=invalid.invalid_sync_run_id
     AND state.connection_id=invalid.connection_id
     AND state.payload_hash=invalid.invalid_payload_hash
     AND state.mapping_version=invalid.invalid_mapping_version
   WHERE (state.canonical_table='worker' AND state.source_object_type='Teacher')
      OR (state.canonical_table='location' AND state.source_object_type='Location')
), candidate_staging AS MATERIALIZED (
  SELECT staged.*,committed.completed_at AS transform_completed_at,
         staged.staging_row->'payload_json' AS payload_json,
         staged.staging_row->>'source_version' AS candidate_source_version,
         coalesce(
           nullif(staged.staging_row->>'source_updated_at','')::timestamptz,
           nullif(staged.staging_row->>'ingested_at','')::timestamptz,
           '1970-01-01T00:00:00Z'::timestamptz
         ) AS candidate_effective_at,
         staged.staging_row->>'tombstone'='true' AS candidate_tombstone
    FROM ingestion.canonical_staging_batch_records staged
    JOIN semantic_internal.canonical_transform_commits committed
      ON committed.tenant_id=staged.tenant_id
     AND committed.batch_id=staged.batch_id
     AND committed.sync_run_id=staged.sync_run_id
     AND committed.connection_id=staged.connection_id
     AND committed.connector_id=staged.connector_id
     AND committed.stream=staged.stream
     AND committed.mapping_version=staged.mapping_version
   WHERE staged.connector_id='momence'
     AND staged.stream IN (
       'momence_appointments','momence_sessions','momence_session_details',
       'momence_public_sessions','momence_public_locations'
     )
     AND jsonb_typeof(staged.staging_row->'payload_json')='object'
), candidate_objects AS MATERIALIZED (
  SELECT staged.*,'Teacher'::text AS object_type,object.value AS object_json,
         object.object_ordinal
    FROM candidate_staging staged
    CROSS JOIN LATERAL (
      SELECT staged.payload_json->'teacher' AS value,1::bigint AS object_ordinal
       WHERE staged.stream IN (
         'momence_appointments','momence_sessions','momence_session_details',
         'momence_public_sessions'
       )
      UNION ALL
      SELECT staged.payload_json->'originalTeacher',2::bigint
       WHERE staged.stream IN (
         'momence_sessions','momence_session_details','momence_public_sessions'
       )
      UNION ALL
      SELECT staged.payload_json->'additionalTeacher',2::bigint
       WHERE staged.stream='momence_appointments'
      UNION ALL
      SELECT item.value,1000::bigint+item.ordinality::bigint
        FROM jsonb_array_elements(
          CASE WHEN staged.stream IN (
                        'momence_sessions','momence_session_details',
                        'momence_public_sessions'
                      )
                     AND jsonb_typeof(staged.payload_json->'additionalTeachers')='array'
               THEN staged.payload_json->'additionalTeachers'
               ELSE '[]'::jsonb END
        ) WITH ORDINALITY item(value,ordinality)
    ) object
   WHERE jsonb_typeof(object.value)='object'
  UNION ALL
  SELECT staged.*,'Location'::text,staged.payload_json->'inPersonLocation',1::bigint
    FROM candidate_staging staged
   WHERE staged.stream IN (
           'momence_appointments','momence_sessions','momence_session_details',
           'momence_public_sessions'
         )
     AND jsonb_typeof(staged.payload_json->'inPersonLocation')='object'
  UNION ALL
  SELECT staged.*,'Location'::text,staged.payload_json,1::bigint
    FROM candidate_staging staged
   WHERE staged.stream='momence_public_locations'
), candidates AS MATERIALIZED (
  SELECT object.*,
         nullif(btrim(object.object_json->>'id'),'') AS object_id,
         CASE object.object_type
           WHEN 'Teacher' THEN coalesce(
             nullif(btrim(concat_ws(' ',
               nullif(btrim(object.object_json->>'firstName'),''),
               nullif(btrim(object.object_json->>'lastName'),'')
             )),''),
             nullif(btrim(object.object_json->>'name'),''),
             'Teacher '||nullif(btrim(object.object_json->>'id'),'')
           )
           ELSE coalesce(
             nullif(btrim(object.object_json->>'name'),''),
             nullif(btrim(object.object_json->>'fullAddress'),''),
             'Location '||nullif(btrim(object.object_json->>'id'),'')
           )
         END AS canonical_name,
         nullif(btrim(object.object_json->>'timeZone'),'') AS candidate_timezone
    FROM candidate_objects object
   WHERE nullif(btrim(object.object_json->>'id'),'') IS NOT NULL
     AND nullif(btrim(object.object_json->>'id'),'')<>'0'
     AND (
       object.stream<>'momence_public_locations'
       OR object.source_record_id=nullif(btrim(object.object_json->>'id'),'')
     )
)
SELECT impacted.tenant_id,impacted.canonical_table,impacted.canonical_id,
       impacted.connection_id,impacted.source_object_type,
       impacted.source_record_id,impacted.batch_id AS invalid_batch_id,
       impacted.sync_run_id AS invalid_sync_run_id,
       impacted.payload_hash AS invalid_payload_hash,
       impacted.mapping_version AS invalid_mapping_version,
       impacted.invalid_transform_completed_at,
       candidate.batch_id AS restored_batch_id,
       candidate.sync_run_id AS restored_sync_run_id,
       candidate.payload_hash AS restored_payload_hash,
       candidate.mapping_version AS restored_mapping_version,
       candidate.candidate_source_version AS restored_source_version,
       candidate.candidate_effective_at AS restored_source_updated_at,
       candidate.transform_completed_at AS restored_transform_completed_at,
       candidate.candidate_tombstone AS restored_tombstone,
       candidate.canonical_name AS restored_name,
       candidate.ambiguous_transform_order,
       CASE WHEN impacted.canonical_table='location'
            THEN coalesce(candidate.candidate_timezone,current_location.timezone)
            ELSE NULL END AS restored_timezone
  FROM impacted
  LEFT JOIN core.location current_location
    ON impacted.canonical_table='location'
   AND current_location.tenant_id=impacted.tenant_id
   AND current_location.id=impacted.canonical_id
  LEFT JOIN LATERAL (
    WITH RECURSIVE eligible AS MATERIALIZED (
      SELECT candidate.*
        FROM candidates candidate
       WHERE candidate.tenant_id=impacted.tenant_id
         AND candidate.connection_id=impacted.connection_id
         AND candidate.object_type=impacted.source_object_type
         AND candidate.object_id=impacted.source_record_id
         AND NOT (
           candidate.stream IN (
             'momence_appointments','momence_sessions','momence_session_details',
             'momence_public_sessions'
           ) AND candidate.candidate_tombstone
         )
         AND (
           NOT candidate.candidate_tombstone
           OR candidate.stream='momence_public_locations'
              AND EXISTS (
                SELECT 1
                  FROM quality.reconciliation_tombstone_application application
                 WHERE application.tenant_id=candidate.tenant_id
                   AND application.connection_id=candidate.connection_id
                   AND application.stream=candidate.stream
                   AND application.namespaced_source_key=candidate.namespaced_source_key
                   AND application.source_object_type=candidate.source_object_type
                   AND application.source_record_id=candidate.source_record_id
                   AND application.tombstone_batch_id=candidate.batch_id
              )
         )
    ), transform_order AS MATERIALIZED (
      SELECT EXISTS (
        SELECT 1
          FROM eligible candidate
         GROUP BY candidate.transform_completed_at
        HAVING count(DISTINCT (candidate.batch_id,candidate.mapping_version))>1
      ) AS ambiguous_transform_order
    ), ordered AS MATERIALIZED (
      SELECT candidate.*,
             row_number() OVER (
               ORDER BY candidate.transform_completed_at ASC,
                        candidate.batch_id ASC,candidate.mapping_version ASC,
                        candidate.namespaced_source_key ASC,
                        candidate.object_ordinal ASC,candidate.created_at ASC
             ) AS observation_ordinal
        FROM eligible candidate
    ), replay (
      observation_ordinal,winner_ordinal,claimed_effective_at,
      claimed_payload_hash,claimed_source_version,claimed_mapping_version
    ) AS (
      SELECT candidate.observation_ordinal,candidate.observation_ordinal,
             candidate.candidate_effective_at,candidate.payload_hash,
             candidate.candidate_source_version,candidate.mapping_version
        FROM ordered candidate
       WHERE candidate.observation_ordinal=1
      UNION ALL
      SELECT candidate.observation_ordinal,
             CASE WHEN admission.claims
                  THEN candidate.observation_ordinal
                  ELSE replay.winner_ordinal END,
             CASE WHEN admission.claims
                  THEN candidate.candidate_effective_at
                  ELSE replay.claimed_effective_at END,
             CASE WHEN admission.claims
                  THEN candidate.payload_hash
                  ELSE replay.claimed_payload_hash END,
             CASE WHEN admission.claims
                  THEN candidate.candidate_source_version
                  ELSE replay.claimed_source_version END,
             CASE WHEN admission.claims
                  THEN candidate.mapping_version
                  ELSE replay.claimed_mapping_version END
        FROM replay
        JOIN ordered candidate
          ON candidate.observation_ordinal=replay.observation_ordinal+1
       CROSS JOIN LATERAL (
         VALUES (
           candidate.candidate_effective_at>=replay.claimed_effective_at
           AND (
             candidate.payload_hash<>replay.claimed_payload_hash
             OR candidate.candidate_source_version
                  IS DISTINCT FROM replay.claimed_source_version
             OR candidate.mapping_version
                  IS DISTINCT FROM replay.claimed_mapping_version
           )
         )
       ) admission(claims)
    ), final_claim AS MATERIALIZED (
      SELECT replay.winner_ordinal
        FROM replay
       ORDER BY replay.observation_ordinal DESC
       LIMIT 1
    )
    SELECT candidate.*,transform_order.ambiguous_transform_order
      FROM final_claim
      JOIN ordered candidate
        ON candidate.observation_ordinal=final_claim.winner_ordinal
     CROSS JOIN transform_order
  ) candidate ON true;

DO $$
DECLARE expected_count bigint;
DECLARE repair_count bigint;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM momence_bounded_canonical_repair
     WHERE ambiguous_transform_order
  ) THEN
    RAISE EXCEPTION 'Momence canonical tombstone repair transform order is ambiguous';
  END IF;
  SELECT count(*) INTO expected_count
    FROM momence_bounded_canonical_repair;
  SELECT count(*) INTO repair_count
    FROM momence_bounded_canonical_repair
   WHERE restored_batch_id IS NOT NULL
     AND restored_sync_run_id IS NOT NULL
     AND restored_payload_hash IS NOT NULL
     AND restored_mapping_version IS NOT NULL
     AND restored_source_updated_at IS NOT NULL
     AND restored_name IS NOT NULL
     AND (canonical_table<>'location' OR restored_timezone IS NOT NULL);
  IF repair_count<>expected_count THEN
    RAISE EXCEPTION 'Momence canonical tombstone repair lacks exact transformed predecessor: expected %, found %',
      expected_count,repair_count;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM momence_bounded_canonical_repair repair
      LEFT JOIN core.worker worker
        ON repair.canonical_table='worker'
       AND worker.tenant_id=repair.tenant_id AND worker.id=repair.canonical_id
      LEFT JOIN core.location location
        ON repair.canonical_table='location'
       AND location.tenant_id=repair.tenant_id AND location.id=repair.canonical_id
     WHERE repair.canonical_table='worker' AND worker.id IS NULL
        OR repair.canonical_table='location' AND location.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Momence invalid canonical tombstone has no materialized dimension';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM momence_bounded_canonical_repair repair
      LEFT JOIN LATERAL (
        SELECT count(*)::integer AS link_count,min(link.valid_from) AS valid_from
          FROM core.entity_source_link link
         WHERE link.tenant_id=repair.tenant_id
           AND link.entity_type=repair.canonical_table
           AND link.canonical_entity_id=repair.canonical_id
           AND link.connection_id=repair.connection_id
           AND link.source_object_type=repair.source_object_type
           AND link.source_record_id=repair.source_record_id
           AND link.match_method='external_id'
           AND link.valid_from='1970-01-01T00:00:00Z'::timestamptz
      ) direct ON true
     WHERE direct.link_count<>1
        OR repair.restored_tombstone
           AND repair.restored_source_updated_at<=direct.valid_from
  ) THEN
    RAISE EXCEPTION 'Momence invalid canonical tombstone has no unique repairable direct source link';
  END IF;
END
$$;

-- Restore the exact predecessor claim first, then materialize the values which
-- the Momence mapper would have produced from that committed object. Canonical
-- row/link sync_run_id remains unchanged because it records first creation and
-- is intentionally protected by the canonical immutability trigger.
UPDATE semantic_internal.canonical_record_state state
   SET source_updated_at=repair.restored_source_updated_at,
       source_version=repair.restored_source_version,
       payload_hash=repair.restored_payload_hash,
       batch_id=repair.restored_batch_id,
       sync_run_id=repair.restored_sync_run_id,
       connection_id=repair.connection_id,
       source_object_type=repair.source_object_type,
       source_record_id=repair.source_record_id,
       mapping_version=repair.restored_mapping_version,
       updated_at=clock_timestamp()
  FROM momence_bounded_canonical_repair repair
 WHERE state.tenant_id=repair.tenant_id
   AND state.canonical_table=repair.canonical_table
   AND state.canonical_id=repair.canonical_id
   AND state.batch_id=repair.invalid_batch_id
   AND state.sync_run_id=repair.invalid_sync_run_id
   AND state.payload_hash=repair.invalid_payload_hash
   AND state.mapping_version=repair.invalid_mapping_version;

UPDATE core.worker worker
   SET person_id=NULL,display_name=repair.restored_name,
       active=NOT repair.restored_tombstone,updated_at=clock_timestamp()
  FROM momence_bounded_canonical_repair repair
 WHERE repair.canonical_table='worker'
   AND worker.tenant_id=repair.tenant_id AND worker.id=repair.canonical_id;

UPDATE core.location location
   SET name=repair.restored_name,timezone=repair.restored_timezone,
       legal_entity_id=NULL,active=NOT repair.restored_tombstone,
       updated_at=clock_timestamp()
  FROM momence_bounded_canonical_repair repair
 WHERE repair.canonical_table='location'
   AND location.tenant_id=repair.tenant_id AND location.id=repair.canonical_id;

UPDATE core.entity_source_link link
   SET canonical_entity_id=repair.canonical_id,
       match_method='external_id',
       match_status=CASE WHEN repair.restored_tombstone
                         THEN 'superseded' ELSE 'accepted' END,
       confidence_band='high',
       evidence=jsonb_build_object(
         'payload_hash',repair.restored_payload_hash,
         'mapping_version',repair.restored_mapping_version
       ),
       valid_to=CASE WHEN repair.restored_tombstone
                     THEN repair.restored_source_updated_at ELSE NULL END,
       confirmed_by=NULL,superseded_by=NULL
  FROM momence_bounded_canonical_repair repair
 WHERE link.tenant_id=repair.tenant_id
   AND link.entity_type=repair.canonical_table
   AND link.canonical_entity_id=repair.canonical_id
   AND link.connection_id=repair.connection_id
   AND link.source_object_type=repair.source_object_type
   AND link.source_record_id=repair.source_record_id
   AND link.match_method='external_id'
   AND link.valid_from='1970-01-01T00:00:00Z'::timestamptz;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM momence_bounded_canonical_repair repair
      LEFT JOIN semantic_internal.canonical_record_state state
        ON state.tenant_id=repair.tenant_id
       AND state.canonical_table=repair.canonical_table
       AND state.canonical_id=repair.canonical_id
     WHERE state.canonical_id IS NULL
        OR state.source_updated_at IS DISTINCT FROM repair.restored_source_updated_at
        OR state.source_version IS DISTINCT FROM repair.restored_source_version
        OR state.payload_hash IS DISTINCT FROM repair.restored_payload_hash
        OR state.batch_id IS DISTINCT FROM repair.restored_batch_id
        OR state.sync_run_id IS DISTINCT FROM repair.restored_sync_run_id
        OR state.connection_id IS DISTINCT FROM repair.connection_id
        OR state.source_object_type IS DISTINCT FROM repair.source_object_type
        OR state.source_record_id IS DISTINCT FROM repair.source_record_id
        OR state.mapping_version IS DISTINCT FROM repair.restored_mapping_version
  ) THEN
    RAISE EXCEPTION 'Momence exact canonical record-state restoration failed';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM momence_bounded_canonical_repair repair
      LEFT JOIN core.worker worker
        ON repair.canonical_table='worker'
       AND worker.tenant_id=repair.tenant_id AND worker.id=repair.canonical_id
      LEFT JOIN core.location location
        ON repair.canonical_table='location'
       AND location.tenant_id=repair.tenant_id AND location.id=repair.canonical_id
     WHERE repair.canonical_table='worker' AND (
             worker.id IS NULL
             OR worker.person_id IS NOT NULL
             OR worker.display_name IS DISTINCT FROM repair.restored_name
             OR worker.active IS DISTINCT FROM NOT repair.restored_tombstone
           )
        OR repair.canonical_table='location' AND (
             location.id IS NULL
             OR location.name IS DISTINCT FROM repair.restored_name
             OR location.timezone IS DISTINCT FROM repair.restored_timezone
             OR location.legal_entity_id IS NOT NULL
             OR location.active IS DISTINCT FROM NOT repair.restored_tombstone
           )
  ) THEN
    RAISE EXCEPTION 'Momence exact canonical dimension restoration failed';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM momence_bounded_canonical_repair repair
      LEFT JOIN core.entity_source_link link
        ON link.tenant_id=repair.tenant_id
       AND link.entity_type=repair.canonical_table
       AND link.canonical_entity_id=repair.canonical_id
       AND link.connection_id=repair.connection_id
       AND link.source_object_type=repair.source_object_type
       AND link.source_record_id=repair.source_record_id
       AND link.match_method='external_id'
       AND link.valid_from='1970-01-01T00:00:00Z'::timestamptz
     WHERE link.link_id IS NULL
        OR link.match_status IS DISTINCT FROM
           CASE WHEN repair.restored_tombstone THEN 'superseded' ELSE 'accepted' END
        OR link.confidence_band IS DISTINCT FROM 'high'
        OR link.evidence IS DISTINCT FROM jsonb_build_object(
             'payload_hash',repair.restored_payload_hash,
             'mapping_version',repair.restored_mapping_version
           )
        OR link.valid_to IS DISTINCT FROM
           CASE WHEN repair.restored_tombstone
                THEN repair.restored_source_updated_at ELSE NULL END
        OR link.confirmed_by IS NOT NULL OR link.superseded_by IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Momence exact canonical direct-link restoration failed';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM quality.reconciliation_tombstone_application application
      JOIN ingestion.canonical_staging_batch_records staged
        ON staged.tenant_id=application.tenant_id
       AND staged.connection_id=application.connection_id
       AND staged.batch_id=application.tombstone_batch_id
       AND staged.stream=application.stream
       AND staged.namespaced_source_key=application.namespaced_source_key
       AND staged.source_object_type=application.source_object_type
       AND staged.source_record_id=application.source_record_id
       AND staged.connector_id='momence'
       AND staged.staging_row->>'tombstone'='true'
      JOIN semantic_internal.canonical_record_state state
        ON state.tenant_id=staged.tenant_id
       AND state.batch_id=staged.batch_id
       AND state.sync_run_id=staged.sync_run_id
       AND state.connection_id=staged.connection_id
       AND state.payload_hash=staged.payload_hash
       AND state.mapping_version=staged.mapping_version
     WHERE application.stream IN (
       'momence_appointments','momence_sessions','momence_session_details',
       'momence_session_bookings','momence_member_sessions',
       'momence_member_appointments','momence_public_sessions',
       'momence_payment_transactions'
     )
       AND (
         state.canonical_table='worker' AND state.source_object_type='Teacher'
         OR state.canonical_table='location' AND state.source_object_type='Location'
       )
  ) THEN
    RAISE EXCEPTION 'Momence bounded tombstone lineage still owns canonical state';
  END IF;
END
$$;

-- A queued old transform can still read the immutable audit envelope after the
-- migration. Reject its state claim before it can deactivate a dimension. The
-- definer remains subject to FORCE RLS and therefore sees only the transaction's
-- trusted tenant, while callers receive no direct EXECUTE privilege.
CREATE OR REPLACE FUNCTION quality.guard_momence_bounded_canonical_tombstone()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,core,ingestion
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM ingestion.canonical_staging_batch_records staged
     WHERE staged.tenant_id=NEW.tenant_id
       AND staged.batch_id=NEW.batch_id
       AND staged.sync_run_id=NEW.sync_run_id
       AND staged.connection_id=NEW.connection_id
       AND staged.mapping_version=NEW.mapping_version
       AND staged.payload_hash=NEW.payload_hash
       AND staged.connector_id='momence'
       AND staged.stream IN (
         'momence_appointments','momence_sessions','momence_session_details',
         'momence_session_bookings','momence_member_sessions',
         'momence_member_appointments','momence_public_sessions',
         'momence_payment_transactions'
       )
       AND staged.staging_row->>'tombstone'='true'
  ) THEN
    RAISE EXCEPTION 'canonical_momence_bounded_tombstone_invalid'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS guard_momence_bounded_canonical_tombstone
  ON semantic_internal.canonical_record_state;
CREATE TRIGGER guard_momence_bounded_canonical_tombstone
BEFORE INSERT OR UPDATE ON semantic_internal.canonical_record_state
FOR EACH ROW EXECUTE FUNCTION quality.guard_momence_bounded_canonical_tombstone();
REVOKE ALL ON FUNCTION quality.guard_momence_bounded_canonical_tombstone()
  FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,diagnostic_ro;

ALTER TABLE core.entity_source_link FORCE ROW LEVEL SECURITY;
ALTER TABLE core.location FORCE ROW LEVEL SECURITY;
ALTER TABLE core.worker FORCE ROW LEVEL SECURITY;
ALTER TABLE semantic_internal.canonical_record_state FORCE ROW LEVEL SECURITY;

DO $$
DECLARE stream_name text;
BEGIN
  FOREACH stream_name IN ARRAY ARRAY[
    'momence_appointments','momence_sessions','momence_session_details',
    'momence_session_bookings','momence_member_sessions',
    'momence_member_appointments','momence_public_sessions',
    'momence_payment_transactions'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE source_momence.%I FORCE ROW LEVEL SECURITY',stream_name
    );
  END LOOP;
END
$$;
ALTER TABLE ingestion.canonical_staging_batch_records FORCE ROW LEVEL SECURITY;
ALTER TABLE ingestion.landing_commits FORCE ROW LEVEL SECURITY;
ALTER TABLE ingestion.batch_manifests FORCE ROW LEVEL SECURITY;
ALTER TABLE ingestion.source_records FORCE ROW LEVEL SECURITY;
ALTER TABLE semantic_internal.canonical_transform_commits FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.reconciliation_tombstone_application FORCE ROW LEVEL SECURITY;

-- Payment transaction detail is discovered through member notes. The same
-- transaction can be referenced by several notes, so repeated observations
-- are legitimate source evidence rather than a pagination defect. Keep the
-- durable identity table authoritative for the exact distinct total, while
-- retaining duplicate-fails-closed behavior for every other connector/stream.
DO $$
DECLARE function_row record;
DECLARE original_definition text;
DECLARE patched_definition text;
DECLARE patched_count integer:=0;
BEGIN
  FOR function_row IN
    SELECT procedure.oid
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
     WHERE namespace.nspname='quality'
       AND procedure.proname='record_reconciliation_snapshot_page'
       AND procedure.prokind='f'
       AND pg_get_function_identity_arguments(procedure.oid)=
           'p_tenant_id text, p_connection_id text, p_connection_generation bigint, p_reconciliation_sweep_id text, p_connector_id text, p_stream text, p_scan_ordinal integer, p_deletion_strategy text, p_source_total_strategy text, p_batch_id text, p_identities jsonb, p_invalid_count bigint, p_quarantine_count bigint, p_has_more boolean, p_page_source_total bigint'
     ORDER BY procedure.oid
  LOOP
    original_definition:=pg_get_functiondef(function_row.oid);
    patched_definition:=replace(
      original_definition,
      'WHEN snapshot.duplicate_count>0 OR snapshot.invalid_count>0',
      'WHEN (snapshot.duplicate_count>0 AND NOT (' ||
      'p_connector_id=''momence'' AND p_stream=''momence_payment_transactions'' ' ||
      'AND p_deletion_strategy=''no_absence_deletes'' ' ||
      'AND p_source_total_strategy=''count_distinct_bounded_scan'')) ' ||
      'OR snapshot.invalid_count>0'
    );
    IF patched_definition=original_definition THEN
      RAISE EXCEPTION 'Momence payment distinct-evidence patch made no change for %',
        function_row.oid::regprocedure;
    END IF;
    EXECUTE patched_definition;
    patched_count:=patched_count+1;
  END LOOP;
  IF patched_count<>1 THEN
    RAISE EXCEPTION 'Expected one reconciliation snapshot function, patched %',patched_count;
  END IF;
END
$$;

-- A completed or in-flight snapshot carrying the former policy must never be
-- candidate evidence after the deployment. Preserve it for audit, but mark it
-- failed before changing the generation's current registered policy.
UPDATE quality.reconciliation_snapshot snapshot
   SET status='failed',completed_at=coalesce(snapshot.completed_at,clock_timestamp())
 WHERE snapshot.connector_id='momence'
   AND snapshot.stream IN (
     'momence_appointments','momence_sessions','momence_session_details',
     'momence_session_bookings','momence_member_sessions',
     'momence_member_appointments','momence_public_sessions',
     'momence_payment_transactions'
   )
   AND snapshot.status<>'failed';

UPDATE quality.connector_stream_state state
   SET deletion_strategy='no_absence_deletes',
       source_total_strategy='count_distinct_bounded_scan',
       reconciliation_completed_at=NULL,reconciliation_sweep_id=NULL,
       reconciliation_gap_count=0,deletion_evidence_count=0,
       source_total=NULL,local_live_total=NULL,
       updated_at=clock_timestamp()
 WHERE state.connector_id='momence'
   AND state.stream IN (
     'momence_appointments','momence_sessions','momence_session_details',
     'momence_session_bookings','momence_member_sessions',
     'momence_member_appointments','momence_public_sessions',
     'momence_payment_transactions'
   )
   AND (
     state.deletion_strategy IS DISTINCT FROM 'no_absence_deletes'
     OR state.source_total_strategy IS DISTINCT FROM 'count_distinct_bounded_scan'
   );

ALTER TABLE quality.reconciliation_snapshot FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.connector_stream_state FORCE ROW LEVEL SECURITY;

-- This targeted invariant also rejects a stale, pre-deploy worker attempting
-- to register the old policy for a new Momence generation.
ALTER TABLE quality.connector_stream_state
  DROP CONSTRAINT IF EXISTS connector_stream_state_momence_bounded_policy_check;
ALTER TABLE quality.connector_stream_state
  ADD CONSTRAINT connector_stream_state_momence_bounded_policy_check CHECK (
    connector_id<>'momence'
    OR stream NOT IN (
      'momence_appointments','momence_sessions','momence_session_details',
      'momence_session_bookings','momence_member_sessions',
      'momence_member_appointments','momence_public_sessions',
      'momence_payment_transactions'
    )
    OR (
      deletion_strategy='no_absence_deletes'
      AND source_total_strategy='count_distinct_bounded_scan'
    )
  ) NOT VALID;
ALTER TABLE quality.connector_stream_state
  VALIDATE CONSTRAINT connector_stream_state_momence_bounded_policy_check;

-- Failed historical rows retain the exact policy under which they were
-- captured. Any newly usable Momence snapshot must carry the safe policy.
ALTER TABLE quality.reconciliation_snapshot
  DROP CONSTRAINT IF EXISTS reconciliation_snapshot_momence_bounded_policy_check;
ALTER TABLE quality.reconciliation_snapshot
  ADD CONSTRAINT reconciliation_snapshot_momence_bounded_policy_check CHECK (
    connector_id<>'momence'
    OR stream NOT IN (
      'momence_appointments','momence_sessions','momence_session_details',
      'momence_session_bookings','momence_member_sessions',
      'momence_member_appointments','momence_public_sessions',
      'momence_payment_transactions'
    )
    OR status='failed'
    OR (
      deletion_strategy='no_absence_deletes'
      AND source_total_strategy='count_distinct_bounded_scan'
    )
  ) NOT VALID;
ALTER TABLE quality.reconciliation_snapshot
  VALIDATE CONSTRAINT reconciliation_snapshot_momence_bounded_policy_check;

-- Candidate evidence is valid only while it still agrees with the current
-- registered generation policy. This closes policy transitions generically,
-- while retaining authoritative deletion for Square, Lightspeed and Xero.
CREATE OR REPLACE FUNCTION quality.reconciliation_tombstone_candidates(
  p_tenant_id text,p_connection_id text,p_connection_generation bigint,
  p_reconciliation_sweep_id text,p_stream text,p_after_key text,p_limit integer
) RETURNS TABLE (
  namespaced_source_key text,source_object_type text,source_record_id text,
  normalized_payload jsonb,expected_payload_hash text,
  expected_source_updated_at timestamptz,expected_ingested_at timestamptz,
  first_snapshot_batch_id text,verification_snapshot_batch_id text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,core,quality,ingestion
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'reconciliation tombstone request is invalid' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  SELECT source.namespaced_source_key,source.source_object_type,source.source_record_id,
         source.normalized_payload,source.payload_hash,source.source_updated_at,
         source.ingested_at,first_scan.last_batch_id,verification.last_batch_id
    FROM ingestion.source_records source
    JOIN quality.connector_stream_state current_policy
      ON current_policy.tenant_id=source.tenant_id
     AND current_policy.connection_id=source.connection_id
     AND current_policy.connection_generation=p_connection_generation
     AND current_policy.stream=source.stream
     AND current_policy.deletion_strategy='authoritative_identity_scan'
     AND current_policy.source_total_strategy<>'count_distinct_bounded_scan'
    JOIN quality.reconciliation_snapshot first_scan
      ON first_scan.tenant_id=source.tenant_id
     AND first_scan.connection_id=source.connection_id
     AND first_scan.connection_generation=current_policy.connection_generation
     AND first_scan.reconciliation_sweep_id=p_reconciliation_sweep_id
     AND first_scan.connector_id=current_policy.connector_id
     AND first_scan.stream=source.stream AND first_scan.scan_ordinal=1
     AND first_scan.status='complete'
     AND first_scan.deletion_strategy=current_policy.deletion_strategy
     AND first_scan.source_total_strategy=current_policy.source_total_strategy
    JOIN quality.reconciliation_snapshot verification
      ON verification.tenant_id=first_scan.tenant_id
     AND verification.connection_id=first_scan.connection_id
     AND verification.connection_generation=first_scan.connection_generation
     AND verification.reconciliation_sweep_id=first_scan.reconciliation_sweep_id
     AND verification.connector_id=first_scan.connector_id
     AND verification.stream=first_scan.stream AND verification.scan_ordinal=2
     AND verification.status='complete' AND verification.membership_delta_count=0
     AND verification.deletion_strategy=first_scan.deletion_strategy
     AND verification.source_total_strategy=first_scan.source_total_strategy
     AND first_scan.completed_at<=verification.started_at
   WHERE source.tenant_id=p_tenant_id AND source.connection_id=p_connection_id
     AND source.stream=p_stream AND NOT source.tombstone
     AND source.ingested_at<=first_scan.started_at
     AND (
       source.source_updated_at IS NULL
       OR source.source_updated_at<=verification.completed_at
     )
     AND source.namespaced_source_key>coalesce(p_after_key,'')
     AND NOT EXISTS (
       SELECT 1 FROM quality.reconciliation_identity_evidence identity
        WHERE identity.tenant_id=source.tenant_id
          AND identity.connection_id=source.connection_id
          AND identity.connection_generation=p_connection_generation
          AND identity.reconciliation_sweep_id=p_reconciliation_sweep_id
          AND identity.stream=source.stream
          AND identity.source_object_type=source.source_object_type
          AND identity.source_record_id=source.source_record_id
          AND identity.scan_ordinal IN (1,2)
     )
     AND NOT EXISTS (
       SELECT 1 FROM quality.reconciliation_tombstone_application applied
        WHERE applied.tenant_id=source.tenant_id
          AND applied.connection_id=source.connection_id
          AND applied.connection_generation=p_connection_generation
          AND applied.reconciliation_sweep_id=p_reconciliation_sweep_id
          AND applied.stream=source.stream
          AND applied.namespaced_source_key=source.namespaced_source_key
     )
   ORDER BY source.namespaced_source_key
   LIMIT p_limit;
END;
$$;

-- Revalidate the same current policy after landing and before recording an
-- application. A stale application cannot become durable merely because its
-- two old snapshot batch ids remain syntactically valid.
CREATE OR REPLACE FUNCTION quality.record_reconciliation_tombstone_applications(
  p_tenant_id text,p_connection_id text,p_connection_generation bigint,
  p_reconciliation_sweep_id text,p_stream text,p_tombstone_batch_id text,p_applications jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,core,quality,ingestion
AS $$
DECLARE published integer;requested integer;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id()
     OR NOT core.is_ulid(p_tombstone_batch_id)
     OR p_applications IS NULL OR jsonb_typeof(p_applications)<>'array'
     OR jsonb_array_length(p_applications)>500 THEN
    RAISE EXCEPTION 'reconciliation tombstone applications are invalid' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_applications) item(value)
     WHERE jsonb_typeof(item.value)<>'object'
        OR length(btrim(coalesce(item.value->>'namespacedSourceKey',''))) NOT BETWEEN 1 AND 700
        OR length(btrim(coalesce(item.value->>'sourceObjectType',''))) NOT BETWEEN 1 AND 200
        OR length(btrim(coalesce(item.value->>'sourceRecordId',''))) NOT BETWEEN 1 AND 300
        OR NOT core.is_ulid(coalesce(item.value->>'firstSnapshotBatchId',''))
        OR NOT core.is_ulid(coalesce(item.value->>'verificationSnapshotBatchId',''))
  ) OR (
    SELECT count(*)<>count(DISTINCT item.value->>'namespacedSourceKey')
      FROM jsonb_array_elements(p_applications) item(value)
  ) THEN
    RAISE EXCEPTION 'reconciliation tombstone application evidence is malformed'
      USING ERRCODE='22023';
  END IF;
  requested:=jsonb_array_length(p_applications);

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_applications) item(value)
     WHERE NOT EXISTS (
       SELECT 1
         FROM ingestion.source_records source
         JOIN quality.connector_stream_state current_policy
           ON current_policy.tenant_id=source.tenant_id
          AND current_policy.connection_id=source.connection_id
          AND current_policy.connection_generation=p_connection_generation
          AND current_policy.connector_id=source.connector_key
          AND current_policy.stream=source.stream
          AND current_policy.deletion_strategy='authoritative_identity_scan'
          AND current_policy.source_total_strategy<>'count_distinct_bounded_scan'
         JOIN quality.reconciliation_snapshot first_scan
           ON first_scan.tenant_id=source.tenant_id
          AND first_scan.connection_id=source.connection_id
          AND first_scan.connection_generation=current_policy.connection_generation
          AND first_scan.reconciliation_sweep_id=p_reconciliation_sweep_id
          AND first_scan.connector_id=current_policy.connector_id
          AND first_scan.stream=source.stream AND first_scan.scan_ordinal=1
          AND first_scan.status='complete'
          AND first_scan.deletion_strategy=current_policy.deletion_strategy
          AND first_scan.source_total_strategy=current_policy.source_total_strategy
          AND first_scan.last_batch_id=item.value->>'firstSnapshotBatchId'
         JOIN quality.reconciliation_snapshot verification
           ON verification.tenant_id=first_scan.tenant_id
          AND verification.connection_id=first_scan.connection_id
          AND verification.connection_generation=first_scan.connection_generation
          AND verification.reconciliation_sweep_id=first_scan.reconciliation_sweep_id
          AND verification.connector_id=first_scan.connector_id
          AND verification.stream=first_scan.stream AND verification.scan_ordinal=2
          AND verification.status='complete' AND verification.membership_delta_count=0
          AND verification.deletion_strategy=first_scan.deletion_strategy
          AND verification.source_total_strategy=first_scan.source_total_strategy
          AND verification.last_batch_id=item.value->>'verificationSnapshotBatchId'
          AND first_scan.completed_at<=verification.started_at
        WHERE source.tenant_id=p_tenant_id
          AND source.connection_id=p_connection_id
          AND source.stream=p_stream
          AND source.namespaced_source_key=item.value->>'namespacedSourceKey'
          AND source.source_object_type=item.value->>'sourceObjectType'
          AND source.source_record_id=item.value->>'sourceRecordId'
          AND source.payload_batch_id=p_tombstone_batch_id
          AND source.tombstone
          AND source.first_ingested_at<=first_scan.started_at
          AND NOT EXISTS (
            SELECT 1 FROM quality.reconciliation_identity_evidence identity
             WHERE identity.tenant_id=source.tenant_id
               AND identity.connection_id=source.connection_id
               AND identity.connection_generation=p_connection_generation
               AND identity.reconciliation_sweep_id=p_reconciliation_sweep_id
               AND identity.stream=source.stream
               AND identity.source_object_type=source.source_object_type
               AND identity.source_record_id=source.source_record_id
               AND identity.scan_ordinal IN (1,2)
          )
     )
  ) THEN
    RAISE EXCEPTION 'reconciliation tombstone was not landed by the exact batch'
      USING ERRCODE='55000';
  END IF;
  INSERT INTO quality.reconciliation_tombstone_application (
    tenant_id,connection_id,connection_generation,reconciliation_sweep_id,stream,
    namespaced_source_key,source_object_type,source_record_id,tombstone_batch_id,
    first_snapshot_batch_id,verification_snapshot_batch_id
  )
  SELECT p_tenant_id,p_connection_id,p_connection_generation,p_reconciliation_sweep_id,p_stream,
         item.value->>'namespacedSourceKey',item.value->>'sourceObjectType',
         item.value->>'sourceRecordId',p_tombstone_batch_id,
         item.value->>'firstSnapshotBatchId',item.value->>'verificationSnapshotBatchId'
    FROM jsonb_array_elements(p_applications) item(value)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS published=ROW_COUNT;
  IF (
    SELECT count(*) FROM jsonb_array_elements(p_applications) item(value)
     JOIN quality.reconciliation_tombstone_application applied
       ON applied.tenant_id=p_tenant_id
      AND applied.connection_id=p_connection_id
      AND applied.connection_generation=p_connection_generation
      AND applied.reconciliation_sweep_id=p_reconciliation_sweep_id
      AND applied.stream=p_stream
      AND applied.namespaced_source_key=item.value->>'namespacedSourceKey'
      AND applied.source_object_type=item.value->>'sourceObjectType'
      AND applied.source_record_id=item.value->>'sourceRecordId'
      AND applied.tombstone_batch_id=p_tombstone_batch_id
      AND applied.first_snapshot_batch_id=item.value->>'firstSnapshotBatchId'
      AND applied.verification_snapshot_batch_id=item.value->>'verificationSnapshotBatchId'
  )<>requested THEN
    RAISE EXCEPTION 'reconciliation tombstone replay conflicts with durable evidence'
      USING ERRCODE='55000';
  END IF;
  RETURN published;
END;
$$;

-- A worker may have fetched candidates just before this migration acquired its
-- locks. The final source-record write therefore has its own Momence-specific
-- fence. These streams expose neither a verified delete feed nor source-owned
-- tombstone events (cancellations remain live status changes), so no tombstone
-- is valid for their bounded populations, regardless of worker job identity.
CREATE OR REPLACE FUNCTION quality.guard_momence_bounded_reconciliation_tombstone()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,core,quality
AS $$
BEGIN
  IF NEW.connector_key='momence'
     AND NEW.tombstone
     AND NEW.stream IN (
       'momence_appointments','momence_sessions','momence_session_details',
       'momence_session_bookings','momence_member_sessions',
       'momence_member_appointments','momence_public_sessions',
       'momence_payment_transactions'
     ) THEN
    RAISE EXCEPTION 'Momence bounded reconciliation cannot land absence tombstones'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_momence_bounded_reconciliation_tombstone_insert
  ON ingestion.source_records;
CREATE TRIGGER guard_momence_bounded_reconciliation_tombstone_insert
  BEFORE INSERT ON ingestion.source_records
  FOR EACH ROW EXECUTE FUNCTION quality.guard_momence_bounded_reconciliation_tombstone();

DROP TRIGGER IF EXISTS guard_momence_bounded_reconciliation_tombstone_update
  ON ingestion.source_records;
CREATE TRIGGER guard_momence_bounded_reconciliation_tombstone_update
  BEFORE UPDATE OF tombstone,payload_batch_id,sync_run_id,stream,connection_id
  ON ingestion.source_records
  FOR EACH ROW EXECUTE FUNCTION quality.guard_momence_bounded_reconciliation_tombstone();

REVOKE ALL ON FUNCTION quality.guard_momence_bounded_reconciliation_tombstone()
  FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
REVOKE ALL ON FUNCTION quality.reconciliation_tombstone_candidates(
  text,text,bigint,text,text,text,integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION quality.record_reconciliation_tombstone_applications(
  text,text,bigint,text,text,text,jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quality.reconciliation_tombstone_candidates(
  text,text,bigint,text,text,text,integer
) TO ingest_rw;
GRANT EXECUTE ON FUNCTION quality.record_reconciliation_tombstone_applications(
  text,text,bigint,text,text,text,jsonb
) TO ingest_rw;

COMMIT;
