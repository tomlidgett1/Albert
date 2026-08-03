BEGIN;

-- The activation routine's local `activated_at` collided with identically
-- named release/event columns when PostgreSQL lazily compiled its UPDATE.
-- Preserve the immutable release migration and use an explicit event time.
CREATE OR REPLACE FUNCTION semantic_internal.activate_connector_pack(
  p_connector_id text,
  p_candidate_pack_version text,
  p_expected_active_pack_version text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE status jsonb;
DECLARE candidate_sequence bigint;
DECLARE activation_time timestamptz:=clock_timestamp();
DECLARE prior_activated_at timestamptz;
BEGIN
  IF p_connector_id NOT IN ('lightspeed-r','xero','deputy')
     OR p_candidate_pack_version IS NULL
     OR p_expected_active_pack_version IS NULL
     OR p_candidate_pack_version=p_expected_active_pack_version THEN
    RAISE EXCEPTION 'connector pack activation input is invalid' USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('connector-pack-activation:'||p_connector_id,0)
  );
  -- Lock every release in sequence order. Publication triggers hold FOR SHARE,
  -- so this waits for predecessor work already in flight and blocks new writes
  -- until the active pointer has changed atomically.
  PERFORM 1
    FROM semantic_internal.connector_pack_release release
   WHERE release.connector_id=p_connector_id
   ORDER BY release.release_sequence
   FOR UPDATE;

  status:=semantic_internal.connector_pack_activation_status(
    p_connector_id,p_candidate_pack_version,p_expected_active_pack_version
  );
  IF coalesce((status->>'ready')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'connector_pack_candidate_not_ready:%',status::text
      USING ERRCODE='55000';
  END IF;
  IF coalesce((status->>'alreadyActive')::boolean,false) THEN
    SELECT event.activated_at INTO STRICT prior_activated_at
      FROM semantic_internal.connector_pack_activation_event event
     WHERE event.connector_id=p_connector_id
       AND event.previous_pack_version=p_expected_active_pack_version
       AND event.activated_pack_version=p_candidate_pack_version;
    RETURN status || jsonb_build_object(
      'ready',true,'activationRequired',false,'activatedAt',prior_activated_at
    );
  END IF;

  SELECT release.release_sequence INTO candidate_sequence
    FROM semantic_internal.connector_pack_release release
   WHERE release.connector_id=p_connector_id
     AND release.pack_version=p_candidate_pack_version;

  UPDATE semantic_internal.connector_pack_release AS release
     SET state='retired',retired_at=activation_time
   WHERE release.connector_id=p_connector_id
     AND release.pack_version=p_expected_active_pack_version
     AND release.state='active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'connector pack active predecessor changed during activation'
      USING ERRCODE='40001';
  END IF;

  UPDATE semantic_internal.connector_pack_release AS release
     SET state='active',activated_at=activation_time
   WHERE release.connector_id=p_connector_id
     AND release.pack_version=p_candidate_pack_version
     AND release.state='candidate';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'connector pack candidate changed during activation'
      USING ERRCODE='40001';
  END IF;

  INSERT INTO semantic_internal.connector_pack_activation_event (
    connector_id,release_sequence,previous_pack_version,activated_pack_version,
    predecessor_capability_rows,candidate_capability_rows,candidate_source_fields,
    activation_evidence,activated_at,activated_by
  ) VALUES (
    p_connector_id,candidate_sequence,p_expected_active_pack_version,
    p_candidate_pack_version,(status->>'predecessorCapabilityRows')::bigint,
    (status->>'candidateCapabilityRows')::bigint,
    (status->>'candidateSourceFields')::bigint,status,activation_time,session_user
  );

  RETURN status || jsonb_build_object('ready',true,'activatedAt',activation_time);
END;
$$;

REVOKE ALL ON FUNCTION semantic_internal.activate_connector_pack(text,text,text)
FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT EXECUTE ON FUNCTION semantic_internal.activate_connector_pack(text,text,text)
TO albert_migration_owner;

COMMIT;
