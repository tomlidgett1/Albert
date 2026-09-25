-- Admit the fail-safe policy for mutable streams whose reconciliation scan is
-- intentionally bounded. Snapshot evidence remains useful for late-edit and
-- quality checks, but only authoritative_identity_scan can select inferred
-- tombstones in quality.reconciliation_tombstone_candidates.

BEGIN;

ALTER TABLE quality.connector_stream_state
  DROP CONSTRAINT IF EXISTS connector_stream_state_deletion_strategy_check;
ALTER TABLE quality.connector_stream_state
  ADD CONSTRAINT connector_stream_state_deletion_strategy_check CHECK (
    deletion_strategy IN (
      'soft_delete','verified_delete_feed','authoritative_identity_scan',
      'no_absence_deletes','immutable_append_only'
    )
  );

ALTER TABLE quality.connector_stream_state
  DROP CONSTRAINT IF EXISTS connector_stream_state_source_total_strategy_check;
ALTER TABLE quality.connector_stream_state
  ADD CONSTRAINT connector_stream_state_source_total_strategy_check CHECK (
    source_total_strategy IN (
      'provider_reported','count_distinct_complete_scan','count_distinct_bounded_scan'
    )
  );
ALTER TABLE quality.connector_stream_state
  DROP CONSTRAINT IF EXISTS connector_stream_state_authoritative_total_check;
ALTER TABLE quality.connector_stream_state
  ADD CONSTRAINT connector_stream_state_authoritative_total_check CHECK (
    deletion_strategy<>'authoritative_identity_scan'
    OR source_total_strategy<>'count_distinct_bounded_scan'
  );

ALTER TABLE quality.reconciliation_snapshot
  DROP CONSTRAINT IF EXISTS reconciliation_snapshot_deletion_strategy_check;
ALTER TABLE quality.reconciliation_snapshot
  ADD CONSTRAINT reconciliation_snapshot_deletion_strategy_check CHECK (
    deletion_strategy IN (
      'soft_delete','verified_delete_feed','authoritative_identity_scan',
      'no_absence_deletes','immutable_append_only'
    )
  );

ALTER TABLE quality.reconciliation_snapshot
  DROP CONSTRAINT IF EXISTS reconciliation_snapshot_source_total_strategy_check;
ALTER TABLE quality.reconciliation_snapshot
  ADD CONSTRAINT reconciliation_snapshot_source_total_strategy_check CHECK (
    source_total_strategy IN (
      'provider_reported','count_distinct_complete_scan','count_distinct_bounded_scan'
    )
  );
ALTER TABLE quality.reconciliation_snapshot
  DROP CONSTRAINT IF EXISTS reconciliation_snapshot_authoritative_total_check;
ALTER TABLE quality.reconciliation_snapshot
  ADD CONSTRAINT reconciliation_snapshot_authoritative_total_check CHECK (
    deletion_strategy<>'authoritative_identity_scan'
    OR source_total_strategy<>'count_distinct_bounded_scan'
  );

DO $$
DECLARE required_functions CONSTANT regprocedure[]:=ARRAY[
  'quality.register_connector_streams(text,text,bigint,text,jsonb)'::regprocedure,
  'quality.record_reconciliation_snapshot_page(text,text,bigint,text,text,text,integer,text,text,text,jsonb,bigint,bigint,boolean,bigint)'::regprocedure
];
DECLARE function_oid regprocedure;
DECLARE original_definition text;
DECLARE patched_definition text;
DECLARE deletion_patched_definition text;
DECLARE patched_count integer:=0;
BEGIN
  FOREACH function_oid IN ARRAY required_functions LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc procedure
       WHERE procedure.oid=function_oid AND procedure.prokind='f'
    ) THEN
      RAISE EXCEPTION 'Quality reconciliation vocabulary target is not an ordinary function: %',
        function_oid USING ERRCODE='55000';
    END IF;
    original_definition:=pg_get_functiondef(function_oid);
    deletion_patched_definition:=replace(
      original_definition,
      '''soft_delete'',''verified_delete_feed'',''authoritative_identity_scan'',''immutable_append_only''',
      '''soft_delete'',''verified_delete_feed'',''authoritative_identity_scan'',''no_absence_deletes'',''immutable_append_only'''
    );
    IF deletion_patched_definition=original_definition THEN
      RAISE EXCEPTION 'Quality deletion vocabulary made no change for %',
        function_oid USING ERRCODE='55000';
    END IF;
    patched_definition:=replace(
      deletion_patched_definition,
      '''provider_reported'',''count_distinct_complete_scan''',
      '''provider_reported'',''count_distinct_complete_scan'',''count_distinct_bounded_scan'''
    );
    IF patched_definition=deletion_patched_definition THEN
      RAISE EXCEPTION 'Quality source-total vocabulary made no change for %',
        function_oid USING ERRCODE='55000';
    END IF;
    EXECUTE patched_definition;
    patched_count:=patched_count+1;
  END LOOP;
  IF patched_count<>2 THEN
    RAISE EXCEPTION 'Expected two quality reconciliation functions, patched %',patched_count;
  END IF;
END
$$;

-- A bounded total is evidence about the scan window, not the entire staged
-- population. Complete the stable two-pass reconciliation without comparing
-- that window count to all historical source records. Keep the local total
-- NULL so it can never be mistaken for an all-history equality assertion.
CREATE OR REPLACE FUNCTION quality.complete_connector_reconciliation(
  p_tenant_id text,p_connection_id text,p_connection_generation bigint,
  p_reconciliation_sweep_id text,p_stream text
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,core,quality,ingestion
AS $$
DECLARE source_count bigint;tombstone_count bigint;verified_source_total bigint;
DECLARE verified_deletion_strategy text;verified_source_total_strategy text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'connector reconciliation completion is invalid' USING ERRCODE='22023';
  END IF;
  SELECT count(*) INTO tombstone_count
    FROM quality.reconciliation_tombstone_application
   WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id
     AND connection_generation=p_connection_generation
     AND reconciliation_sweep_id=p_reconciliation_sweep_id AND stream=p_stream;
  SELECT source_total,deletion_strategy,source_total_strategy
    INTO verified_source_total,verified_deletion_strategy,verified_source_total_strategy
    FROM quality.reconciliation_snapshot verified
   WHERE verified.tenant_id=p_tenant_id AND verified.connection_id=p_connection_id
     AND verified.connection_generation=p_connection_generation
     AND verified.reconciliation_sweep_id=p_reconciliation_sweep_id
     AND verified.stream=p_stream AND verified.scan_ordinal=2
     AND verified.status='complete' AND verified.membership_delta_count=0;
  IF verified_source_total IS NULL THEN
    RAISE EXCEPTION 'reconciliation evidence is incomplete or unstable' USING ERRCODE='55000';
  END IF;
  IF verified_deletion_strategy IN ('no_absence_deletes','immutable_append_only')
     AND tombstone_count<>0 THEN
    RAISE EXCEPTION 'non-authoritative reconciliation cannot contain absence tombstones'
      USING ERRCODE='55000';
  END IF;

  IF verified_source_total_strategy='count_distinct_bounded_scan' THEN
    UPDATE quality.connector_stream_state state
       SET reconciliation_completed_at=now(),reconciliation_sweep_id=p_reconciliation_sweep_id,
           reconciliation_gap_count=0,
           deletion_evidence_count=greatest(state.deletion_evidence_count,tombstone_count),
           source_total=verified_source_total,local_live_total=NULL,updated_at=now()
     WHERE state.tenant_id=p_tenant_id AND state.connection_id=p_connection_id
       AND state.connection_generation=p_connection_generation AND state.stream=p_stream
       AND state.deletion_strategy=verified_deletion_strategy
       AND state.source_total_strategy=verified_source_total_strategy;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reconciliation evidence is incomplete or unstable' USING ERRCODE='55000';
    END IF;
    RETURN tombstone_count;
  END IF;

  SELECT count(*) INTO source_count FROM ingestion.source_records source
   WHERE source.tenant_id=p_tenant_id AND source.connection_id=p_connection_id
     AND source.stream=p_stream
     AND (verified_deletion_strategy='soft_delete' OR NOT source.tombstone);
  IF source_count<>verified_source_total THEN
    RAISE EXCEPTION 'reconciliation source total does not match the landed population'
      USING ERRCODE='55000',DETAIL=jsonb_build_object(
        'verifiedSourceTotal',verified_source_total,'landedPopulation',source_count
      )::text;
  END IF;
  UPDATE quality.connector_stream_state state
     SET reconciliation_completed_at=now(),reconciliation_sweep_id=p_reconciliation_sweep_id,
         reconciliation_gap_count=0,
         deletion_evidence_count=greatest(state.deletion_evidence_count,tombstone_count),
         source_total=verified_source_total,local_live_total=source_count,updated_at=now()
   WHERE state.tenant_id=p_tenant_id AND state.connection_id=p_connection_id
     AND state.connection_generation=p_connection_generation AND state.stream=p_stream
     AND state.deletion_strategy=verified_deletion_strategy
     AND state.source_total_strategy=verified_source_total_strategy;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconciliation evidence is incomplete or unstable' USING ERRCODE='55000';
  END IF;
  RETURN tombstone_count;
END;
$$;

-- The durable health rollup must neither compare nor call "unmeasured" a
-- source total that explicitly describes a bounded population. Reconciliation
-- stability and defects remain required independently of source-total parity.
DO $$
DECLARE function_oid CONSTANT regprocedure:=
  'quality.refresh_connector_quality_rollup(text,text)'::regprocedure;
DECLARE original_definition text;
DECLARE patched_definition text;
DECLARE mismatch_patched_definition text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc procedure
     WHERE procedure.oid=function_oid AND procedure.prokind='f'
  ) THEN
    RAISE EXCEPTION 'refresh_connector_quality_rollup runtime target is not an ordinary function'
      USING ERRCODE='55000';
  END IF;
  original_definition:=pg_get_functiondef(function_oid);
  mismatch_patched_definition:=replace(
    original_definition,
    'WHERE source_total IS NOT NULL AND local_live_total IS NOT NULL
            AND source_total<>local_live_total',
    'WHERE source_total_strategy<>''count_distinct_bounded_scan''
            AND source_total IS NOT NULL AND local_live_total IS NOT NULL
            AND source_total<>local_live_total'
  );
  IF mismatch_patched_definition=original_definition THEN
    RAISE EXCEPTION 'Quality rollup bounded-total mismatch guard made no change';
  END IF;
  patched_definition:=replace(
    mismatch_patched_definition,
    'WHERE source_total IS NULL OR local_live_total IS NULL',
    'WHERE source_total_strategy<>''count_distinct_bounded_scan''
            AND (source_total IS NULL OR local_live_total IS NULL)'
  );
  IF patched_definition=mismatch_patched_definition THEN
    RAISE EXCEPTION 'Quality rollup bounded-total measurement guard made no change';
  END IF;
  EXECUTE patched_definition;
END
$$;

-- Topic-scoped health is the other production consumer of the same durable
-- state. It applies identical semantics: a bounded total proves that the
-- requested window was stable, but is neither an all-history mismatch nor an
-- unmeasured complete total.
DO $$
DECLARE function_oid CONSTANT regprocedure:=
  'quality.current_scoped_health(text,text[],text[])'::regprocedure;
DECLARE original_definition text;
DECLARE patched_definition text;
DECLARE mismatch_patched_definition text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc procedure
     WHERE procedure.oid=function_oid AND procedure.prokind='f'
  ) THEN
    RAISE EXCEPTION 'current_scoped_health runtime target is not an ordinary function'
      USING ERRCODE='55000';
  END IF;
  original_definition:=pg_get_functiondef(function_oid);
  mismatch_patched_definition:=replace(
    original_definition,
    'OR (state.source_total IS NOT NULL AND state.local_live_total IS NOT NULL
                       AND state.source_total<>state.local_live_total)',
    'OR (state.source_total_strategy<>''count_distinct_bounded_scan''
                       AND state.source_total IS NOT NULL AND state.local_live_total IS NOT NULL
                       AND state.source_total<>state.local_live_total)'
  );
  IF mismatch_patched_definition=original_definition THEN
    RAISE EXCEPTION 'Scoped health bounded-total mismatch guard made no change';
  END IF;
  patched_definition:=replace(
    mismatch_patched_definition,
    'OR state.source_total IS NULL OR state.local_live_total IS NULL',
    'OR (state.source_total_strategy<>''count_distinct_bounded_scan''
                       AND (state.source_total IS NULL OR state.local_live_total IS NULL))'
  );
  IF patched_definition=mismatch_patched_definition THEN
    RAISE EXCEPTION 'Scoped health bounded-total measurement guard made no change';
  END IF;
  EXECUTE patched_definition;
END
$$;

-- Defence in depth: the selector remains positively gated on the one policy
-- that is allowed to infer deletion from stable absence. A future refactor
-- must not broaden it merely because no_absence_deletes is now valid storage.
DO $$
DECLARE required_functions CONSTANT regprocedure[]:=ARRAY[
  'quality.reconciliation_tombstone_candidates(text,text,bigint,text,text,text,integer)'::regprocedure,
  'quality.record_reconciliation_tombstone_applications(text,text,bigint,text,text,text,jsonb)'::regprocedure
];
DECLARE function_oid regprocedure;
DECLARE function_definition text;
BEGIN
  FOREACH function_oid IN ARRAY required_functions LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc procedure
       WHERE procedure.oid=function_oid AND procedure.prokind='f'
    ) THEN
      RAISE EXCEPTION 'Reconciliation tombstone gate target is not an ordinary function: %',
        function_oid USING ERRCODE='55000';
    END IF;
    function_definition:=pg_get_functiondef(function_oid);
    IF function_definition NOT LIKE
       '%first_scan.deletion_strategy=''authoritative_identity_scan''%' THEN
      RAISE EXCEPTION 'Reconciliation tombstone function lost the authoritative-scan gate: %',
        function_oid USING ERRCODE='55000';
    END IF;
  END LOOP;
END
$$;

COMMIT;
