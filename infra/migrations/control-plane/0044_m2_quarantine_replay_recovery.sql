BEGIN;

-- A corrected mapper/schema followed by a valid replay must heal both cells.
-- The worker cannot update arbitrary quarantine rows: this function is bound
-- to the exact live queue attempt through its generation-fenced write permit,
-- and accepts only source identities from that attempt's stream.
CREATE INDEX IF NOT EXISTS quarantine_items_open_identity_idx
  ON control_plane.quarantine_items(
    tenant_id,connection_id,stream,source_object_type,source_record_id
  ) WHERE status='open' AND source_record_id IS NOT NULL;

CREATE OR REPLACE FUNCTION control_plane.resolve_quarantine_items(
  p_permit_id text,
  p_worker_id text,
  p_stream text,
  p_resolutions jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  permit control_plane.sync_write_permits%ROWTYPE;
  resolved_count integer:=0;
BEGIN
  -- Reuse the complete active-lease, connection-generation, deletion, and
  -- runtime-login proof used before every analytical write.
  PERFORM control_plane.assert_sync_write_permit_and_issue_capability(
    p_permit_id,p_worker_id
  );
  SELECT * INTO permit
    FROM control_plane.sync_write_permits candidate
   WHERE candidate.permit_id=p_permit_id
     AND candidate.worker_id=p_worker_id
     AND candidate.expires_at>clock_timestamp()
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quarantine resolution permit is not active'
      USING ERRCODE='55000';
  END IF;
  IF p_stream !~ '^[a-z][a-z0-9_]*$'
     OR p_resolutions IS NULL
     OR jsonb_typeof(p_resolutions)<>'array'
     OR jsonb_array_length(p_resolutions) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'quarantine resolutions are invalid' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM control_plane.sync_job_requests request
     WHERE request.tenant_id=permit.tenant_id
       AND request.job_request_id=permit.job_request_id
       AND request.connection_id=permit.connection_id
       AND request.payload->>'syncRunId'=permit.sync_run_id
       AND request.payload->>'stream'=p_stream
  ) THEN
    RAISE EXCEPTION 'quarantine resolution stream does not match the leased job'
      USING ERRCODE='42501';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_resolutions) item(value)
     WHERE jsonb_typeof(item.value)<>'object'
        OR (SELECT count(*) FROM jsonb_object_keys(item.value))<>2
        OR NOT item.value ?& ARRAY['sourceObjectType','sourceRecordId']
        OR length(btrim(coalesce(item.value->>'sourceObjectType',''))) NOT BETWEEN 1 AND 200
        OR length(btrim(coalesce(item.value->>'sourceRecordId',''))) NOT BETWEEN 1 AND 500
  ) OR (
    SELECT count(*)<>count(DISTINCT (
      item.value->>'sourceObjectType',item.value->>'sourceRecordId'
    ))
      FROM jsonb_array_elements(p_resolutions) item(value)
  ) THEN
    RAISE EXCEPTION 'quarantine resolution identities are invalid or duplicated'
      USING ERRCODE='22023';
  END IF;

  UPDATE control_plane.quarantine_items quarantine
     SET status='resolved',
         replayed_in_sync_run_id=permit.sync_run_id,
         resolution_reason='validated_replay',
         resolved_at=clock_timestamp(),
         updated_at=clock_timestamp()
    FROM jsonb_to_recordset(p_resolutions) AS resolution(
      "sourceObjectType" text,"sourceRecordId" text
    )
   WHERE quarantine.tenant_id=permit.tenant_id
     AND quarantine.connection_id=permit.connection_id
     AND quarantine.stream=p_stream
     AND quarantine.source_object_type=resolution."sourceObjectType"
     AND quarantine.source_record_id=resolution."sourceRecordId"
     AND quarantine.status='open';
  GET DIAGNOSTICS resolved_count=ROW_COUNT;
  RETURN resolved_count;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.resolve_quarantine_items(text,text,text,jsonb)
  FROM PUBLIC,anon,authenticated,service_role,
       albert_transform_control,albert_semantic_control,albert_webhook_control,
       albert_deletion_control,albert_operator_diagnostic_control;
GRANT EXECUTE ON FUNCTION control_plane.resolve_quarantine_items(text,text,text,jsonb)
  TO albert_sync_control;

COMMIT;
