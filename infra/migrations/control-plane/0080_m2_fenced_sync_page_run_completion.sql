-- Page-run completion must not close a sync run whose queue request is already
-- terminal, so the closing UPDATE reads control_plane.sync_job_requests. That
-- table is deliberately ungranted to every runtime role: the request ledger is
-- reachable only through SECURITY DEFINER entry points. Reading it directly as
-- albert_sync_control raised 42501, which the worker maps to the permanent
-- database_permission_denied code, so every sync page failed at completion.
--
-- Keep the boundary and move the fence behind a definer function, matching how
-- every other request-ledger read from a worker is already mediated.

BEGIN;

CREATE OR REPLACE FUNCTION control_plane.complete_sync_page_run(
  p_tenant_id text,
  p_sync_run_id text,
  p_connection_id text,
  p_connection_generation bigint
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE completed_sync_run_id text;
BEGIN
  IF NOT control_plane.is_ulid(p_tenant_id)
     OR NOT control_plane.is_ulid(p_sync_run_id)
     OR NOT control_plane.is_ulid(p_connection_id)
     OR p_connection_generation<1 THEN
    RAISE EXCEPTION 'sync page run completion input is invalid' USING ERRCODE='22023';
  END IF;

  UPDATE control_plane.sync_runs AS run
     SET status='succeeded',finished_at=now(),error_code=null,error_summary=null
   WHERE run.tenant_id=p_tenant_id
     AND run.sync_run_id=p_sync_run_id
     AND run.connection_id=p_connection_id
     AND run.connection_generation=p_connection_generation
     AND run.status='running'
     AND EXISTS (
       SELECT 1
         FROM control_plane.sync_job_requests AS request
        WHERE request.tenant_id=run.tenant_id
          AND request.job_request_id=run.queue_job_reference
          AND request.status='running'
     )
  RETURNING run.sync_run_id INTO completed_sync_run_id;

  RETURN completed_sync_run_id;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.complete_sync_page_run(text,text,text,bigint)
  FROM PUBLIC,anon,authenticated,service_role,albert_webhook_control,
       albert_transform_control,albert_semantic_control,
       albert_operator_diagnostic_control,albert_deletion_control;
GRANT EXECUTE ON FUNCTION control_plane.complete_sync_page_run(text,text,text,bigint)
  TO albert_sync_control;

COMMENT ON FUNCTION control_plane.complete_sync_page_run(text,text,text,bigint) IS
  'Closes a running sync run only while its queue request is still running; keeps the request ledger unreadable by runtime roles.';

COMMIT;
