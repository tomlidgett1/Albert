-- Square pack 1.0 is a production ingesting connector. Its source schema is
-- provisioned separately, but the shared reconciliation, immutable-transform,
-- quality and release-authority boundaries remain closed until this exact
-- connector/version is admitted everywhere as one additive change.

BEGIN;

ALTER TABLE quality.connector_check_observation
  DROP CONSTRAINT IF EXISTS connector_check_observation_connector_id_check;
ALTER TABLE quality.connector_check_observation
  ADD CONSTRAINT connector_check_observation_connector_id_check
  CHECK (connector_id IN ('lightspeed-r','xero','deputy','momence','square'));

ALTER TABLE quality.connector_stream_state
  DROP CONSTRAINT IF EXISTS connector_stream_state_connector_id_check;
ALTER TABLE quality.connector_stream_state
  ADD CONSTRAINT connector_stream_state_connector_id_check
  CHECK (connector_id IN ('lightspeed-r','xero','deputy','momence','square'));

ALTER TABLE quality.reconciliation_snapshot
  DROP CONSTRAINT IF EXISTS reconciliation_snapshot_connector_id_check;
ALTER TABLE quality.reconciliation_snapshot
  ADD CONSTRAINT reconciliation_snapshot_connector_id_check
  CHECK (connector_id IN ('lightspeed-r','xero','deputy','momence','square'));

ALTER TABLE ingestion.canonical_staging_batch_records
  DROP CONSTRAINT IF EXISTS canonical_staging_batch_records_connector_id_check;
ALTER TABLE ingestion.canonical_staging_batch_records
  ADD CONSTRAINT canonical_staging_batch_records_connector_id_check
  CHECK (connector_id IN ('lightspeed-r','xero','deputy','momence','square'));

ALTER TABLE semantic_internal.canonical_transform_commits
  DROP CONSTRAINT IF EXISTS canonical_transform_commits_connector_id_check;
ALTER TABLE semantic_internal.canonical_transform_commits
  ADD CONSTRAINT canonical_transform_commits_connector_id_check
  CHECK (connector_id IN ('lightspeed-r','xero','deputy','momence','square'));

ALTER TABLE semantic_internal.connector_pack_release
  DROP CONSTRAINT IF EXISTS connector_pack_release_connector_id_check;
ALTER TABLE semantic_internal.connector_pack_release
  ADD CONSTRAINT connector_pack_release_connector_id_check
  CHECK (connector_id IN ('lightspeed-r','xero','deputy','momence','square'));

INSERT INTO semantic_internal.connector_pack_release (
  connector_id,pack_version,release_sequence,predecessor_version,state,
  registered_by_migration,activated_at
) VALUES (
  'square','1.0.0',1,NULL,'active',
  '0150_m3_square_production_admission.sql',now()
)
ON CONFLICT (connector_id,pack_version) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM semantic_internal.connector_pack_release release
     WHERE release.connector_id='square'
       AND release.pack_version='1.0.0'
       AND release.release_sequence=1
       AND release.predecessor_version IS NULL
       AND release.state='active'
  ) THEN
    RAISE EXCEPTION 'Square connector pack 1.0.0 conflicts with durable release authority';
  END IF;
END
$$;

DO $$
DECLARE required_functions CONSTANT regprocedure[]:=ARRAY[
  'quality.register_connector_streams(text,text,bigint,text,jsonb)'::regprocedure,
  'quality.record_reconciliation_snapshot_page(text,text,bigint,text,text,text,integer,text,text,text,jsonb,bigint,bigint,boolean,bigint)'::regprocedure,
  'quality.publish_connector_quality_results(text,text,text,text,text,text,jsonb)'::regprocedure,
  'semantic_internal.publish_connector_capability_observations(text,text,text,text,text,timestamp with time zone,jsonb)'::regprocedure
];
DECLARE predecessor_guard CONSTANT text:=
  'p_connector_id NOT IN (''lightspeed-r'',''xero'',''deputy'',''momence'')';
DECLARE admitted_guard CONSTANT text:=
  'p_connector_id NOT IN (''lightspeed-r'',''xero'',''deputy'',''momence'',''square'')';
DECLARE function_oid regprocedure;
DECLARE original_definition text;
DECLARE patched_definition text;
DECLARE patched_count integer:=0;
BEGIN
  -- CREATE OR REPLACE preserves each function's owner, grants, signature,
  -- security mode and configuration while changing only the exact latest
  -- closed connector vocabulary. Resolve only the four reviewed signatures;
  -- pg_get_functiondef is undefined for aggregate/window catalogue entries.
  FOREACH function_oid IN ARRAY required_functions LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc procedure
       WHERE procedure.oid=function_oid AND procedure.prokind='f'
    ) THEN
      RAISE EXCEPTION 'Square connector admission target is not an ordinary function: %',
        function_oid USING ERRCODE='55000';
    END IF;
    original_definition:=pg_get_functiondef(function_oid);
    IF position(predecessor_guard IN original_definition)=0 THEN
      RAISE EXCEPTION 'Square connector admission target lacks the exact predecessor guard: %',
        function_oid USING ERRCODE='55000';
    END IF;
    patched_definition:=replace(
      original_definition,predecessor_guard,admitted_guard
    );
    IF patched_definition=original_definition THEN
      RAISE EXCEPTION 'Square connector function admission made no change for %',
        function_oid USING ERRCODE='55000';
    END IF;
    EXECUTE patched_definition;
    patched_count:=patched_count+1;
  END LOOP;

  IF patched_count<>4 THEN
    RAISE EXCEPTION 'Square connector admission expected exactly four runtime function guards; patched %',
      patched_count USING ERRCODE='55000';
  END IF;

  FOREACH function_oid IN ARRAY required_functions LOOP
    original_definition:=pg_get_functiondef(function_oid);
    IF position(predecessor_guard IN original_definition)>0
       OR position(admitted_guard IN original_definition)=0 THEN
      RAISE EXCEPTION 'A production Square runtime function retained an invalid connector guard: %',
        function_oid USING ERRCODE='55000';
    END IF;
  END LOOP;
END
$$;

COMMIT;
