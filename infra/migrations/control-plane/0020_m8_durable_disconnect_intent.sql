BEGIN;

-- A connection disconnect is queued before the deletion worker performs any
-- irreversible credential operation. `pending` records that durable interval
-- truthfully; worker evidence later records the per-provider outcome.
ALTER TABLE control_plane.deletion_requests
  DROP CONSTRAINT IF EXISTS deletion_requests_remote_revocation_status_check;

ALTER TABLE control_plane.deletion_requests
  ADD CONSTRAINT deletion_requests_remote_revocation_status_check CHECK (
    remote_revocation_status IN (
      'pending', 'succeeded', 'unsupported', 'failed', 'not_applicable'
    )
  );

COMMENT ON COLUMN control_plane.deletion_requests.remote_revocation_status IS
  'Lifecycle summary. pending means the durable deletion intent exists and the deletion worker has not yet completed best-effort provider revocation.';

-- The existing key-destruction watchdog covered whole-tenant erasure only.
-- Apply the same bounded grace period to a connection disconnect: the worker
-- gets a chance to revoke remotely, but a worker/vendor outage can never retain
-- usable local credentials indefinitely.
CREATE OR REPLACE FUNCTION control_plane.force_overdue_deletion_credential_destruction(
  p_now timestamptz DEFAULT now()
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE request_row record; destroyed integer := 0;
BEGIN
  FOR request_row IN
    SELECT deletion_request_id FROM control_plane.deletion_requests
    WHERE status IN ('queued', 'running', 'retry_wait', 'failed')
      AND credential_destroyed_at IS NULL
      AND credential_destruction_due_at <= p_now
    ORDER BY credential_destruction_due_at
    FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM control_plane.destroy_deletion_credentials(
      request_row.deletion_request_id,
      jsonb_build_object(
        'forcedLocalDestruction', true,
        'reason', 'remote_revocation_grace_expired'
      )
    );
    UPDATE control_plane.deletion_requests
       SET remote_revocation_status='failed'
     WHERE deletion_request_id=request_row.deletion_request_id;
    destroyed := destroyed + 1;
  END LOOP;
  RETURN destroyed;
END;
$$;

-- Collapse the detailed per-provider evidence into the lifecycle summary while
-- retaining the complete evidence document in progress/deletion proof.
CREATE OR REPLACE FUNCTION control_plane.destroy_claimed_deletion_credentials(
  p_message_id bigint,
  p_deletion_request_id text,
  p_worker_id text,
  p_read_count integer,
  p_remote_revocation jsonb
) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  request_row control_plane.deletion_requests%ROWTYPE;
  destroyed_at timestamptz;
  target_count integer;
  failure_count integer;
  success_count integer;
  unsupported_count integer;
  summary_status text;
BEGIN
  IF p_remote_revocation IS NULL
     OR jsonb_typeof(p_remote_revocation) <> 'object'
     OR jsonb_typeof(p_remote_revocation->'targets') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'remote revocation evidence is invalid' USING ERRCODE='22023';
  END IF;
  request_row := control_plane.require_active_deletion_lease(
    p_message_id,p_deletion_request_id,p_worker_id,p_read_count
  );
  SELECT count(*),
         count(*) FILTER (WHERE target->>'status'='failed'),
         count(*) FILTER (WHERE target->>'status'='succeeded'),
         count(*) FILTER (WHERE target->>'status'='unsupported')
    INTO target_count,failure_count,success_count,unsupported_count
    FROM jsonb_array_elements(p_remote_revocation->'targets') AS item(target);
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_remote_revocation->'targets') AS item(target)
     WHERE target->>'status' NOT IN ('failed','succeeded','unsupported')
  ) THEN
    RAISE EXCEPTION 'remote revocation target status is invalid' USING ERRCODE='22023';
  END IF;
  summary_status := CASE
    WHEN target_count=0 THEN 'not_applicable'
    WHEN failure_count>0 THEN 'failed'
    WHEN success_count>0 THEN 'succeeded'
    WHEN unsupported_count=target_count THEN 'unsupported'
    ELSE 'failed'
  END;
  destroyed_at := control_plane.destroy_deletion_credentials(
    p_deletion_request_id,p_remote_revocation
  );
  UPDATE control_plane.deletion_requests
     SET remote_revocation_status=summary_status
   WHERE tenant_id=request_row.tenant_id
     AND deletion_request_id=request_row.deletion_request_id;
  RETURN destroyed_at;
END;
$$;

COMMIT;
