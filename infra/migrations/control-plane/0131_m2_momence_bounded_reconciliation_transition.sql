-- Retire Momence reconciliation work planned under the former authoritative
-- identity policy. A fresh nightly sweep will be registered with the bounded,
-- no-absence-delete contract after the connector deployment is active.

BEGIN;

-- Stop transform claims/enqueues before retiring their source requests.  The
-- table locks drain any transaction already claiming, completing or enqueueing
-- a transform, and make the request invalidation plus transform retirement one
-- atomic cutover.  The insert trigger below closes the only remaining race: an
-- old sync worker that landed analytically before these locks, but reaches its
-- separate control-plane commit only after they are released.
LOCK TABLE control_plane.canonical_transform_jobs,
  control_plane.sync_job_requests,
  control_plane.reconciliation_stream_sweeps
  IN SHARE ROW EXCLUSIVE MODE;

UPDATE control_plane.sync_job_requests request
   SET status='failed',completed_at=coalesce(request.completed_at,clock_timestamp()),
       last_error=jsonb_build_object(
         'code','reconciliation_policy_superseded',
         'retryable',false,
         'connectorId','momence'
       ),
       updated_at=clock_timestamp()
 WHERE request.job_type='ReconciliationSweep'
   AND request.status IN ('queued','running','retry_wait')
   AND request.payload->>'connectorId'='momence'
   AND request.payload->>'stream' IN (
     'momence_appointments','momence_sessions','momence_session_details',
     'momence_session_bookings','momence_member_sessions',
     'momence_member_appointments','momence_public_sessions',
     'momence_payment_transactions'
   );

-- A canonical job does not carry job_request_id directly.  Resolve its exact
-- immutable request through sync_runs.queue_job_reference and require every
-- payload identity to agree with the transform lineage.  In particular, the
-- connection-generation equality prevents a reconnect epoch from being
-- retired merely because a vendor reused an object identity.
UPDATE control_plane.canonical_transform_jobs job
   SET status='failed',
       completed_at=coalesce(job.completed_at,clock_timestamp()),
       last_error=jsonb_build_object(
         'code','reconciliation_policy_superseded',
         'retryable',false,
         'connectorId','momence',
         'phase','apply_tombstones',
         'connectionGeneration',job.connection_generation,
         'syncRunId',job.sync_run_id,
         'batchId',job.batch_id
       ),
       lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
       updated_at=clock_timestamp()
 WHERE job.status IN ('queued','running','retry_wait')
   AND job.connector_id='momence'
   AND job.stream IN (
     'momence_appointments','momence_sessions','momence_session_details',
     'momence_session_bookings','momence_member_sessions',
     'momence_member_appointments','momence_public_sessions',
     'momence_payment_transactions'
   )
   AND EXISTS (
     SELECT 1
       FROM control_plane.sync_runs run
       JOIN control_plane.sync_job_requests request
         ON request.tenant_id=run.tenant_id
        AND request.job_request_id=run.queue_job_reference
        AND request.connection_id=run.connection_id
      WHERE run.tenant_id=job.tenant_id
        AND run.sync_run_id=job.sync_run_id
        AND run.connection_id=job.connection_id
        AND run.connection_generation=job.connection_generation
        AND request.job_type='ReconciliationSweep'
        AND request.payload->>'tenantId'=job.tenant_id
        AND request.payload->>'connectionId'=job.connection_id
        AND request.payload->>'connectionGeneration'=job.connection_generation::text
        AND request.payload->>'connectorId'=job.connector_id
        AND request.payload->>'stream'=job.stream
        AND request.payload->>'syncRunId'=job.sync_run_id
        AND request.payload->>'batchId'=job.batch_id
        AND request.payload->>'phase'='apply_tombstones'
   );

-- commitPage and queue completion are deliberately separate transactions.  A
-- worker may therefore have finished its last analytical write before this
-- migration invalidates the request, then attempt to enqueue its transform
-- after the table locks are released.  Reject only that exact superseded
-- request lineage; fresh bounded-policy reconciliation remains admissible.
CREATE OR REPLACE FUNCTION control_plane.guard_superseded_momence_tombstone_transform()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF NEW.status IN ('queued','running','retry_wait')
     AND NEW.connector_id='momence'
     AND NEW.stream IN (
       'momence_appointments','momence_sessions','momence_session_details',
       'momence_session_bookings','momence_member_sessions',
       'momence_member_appointments','momence_public_sessions',
       'momence_payment_transactions'
     )
     AND EXISTS (
       SELECT 1
         FROM control_plane.sync_runs run
         JOIN control_plane.sync_job_requests request
           ON request.tenant_id=run.tenant_id
          AND request.job_request_id=run.queue_job_reference
          AND request.connection_id=run.connection_id
        WHERE run.tenant_id=NEW.tenant_id
          AND run.sync_run_id=NEW.sync_run_id
          AND run.connection_id=NEW.connection_id
          AND run.connection_generation=NEW.connection_generation
          AND request.job_type='ReconciliationSweep'
          AND request.last_error->>'code'='reconciliation_policy_superseded'
          AND request.payload->>'tenantId'=NEW.tenant_id
          AND request.payload->>'connectionId'=NEW.connection_id
          AND request.payload->>'connectionGeneration'=NEW.connection_generation::text
          AND request.payload->>'connectorId'=NEW.connector_id
          AND request.payload->>'stream'=NEW.stream
          AND request.payload->>'syncRunId'=NEW.sync_run_id
          AND request.payload->>'batchId'=NEW.batch_id
          AND request.payload->>'phase'='apply_tombstones'
     ) THEN
    RAISE EXCEPTION 'canonical transform is fenced by superseded Momence tombstone policy'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_superseded_momence_tombstone_transform_insert
  ON control_plane.canonical_transform_jobs;
CREATE TRIGGER guard_superseded_momence_tombstone_transform_insert
  BEFORE INSERT ON control_plane.canonical_transform_jobs
  FOR EACH ROW EXECUTE FUNCTION control_plane.guard_superseded_momence_tombstone_transform();

REVOKE ALL ON FUNCTION control_plane.guard_superseded_momence_tombstone_transform()
  FROM PUBLIC,anon,authenticated,service_role,albert_webhook_control,
       albert_sync_control,albert_transform_control,albert_semantic_control,
       albert_operator_diagnostic_control,albert_deletion_control;

UPDATE control_plane.reconciliation_stream_sweeps sweep
   SET status='blocked',
       last_error=jsonb_build_object(
         'code','reconciliation_policy_superseded',
         'retryable',false,
         'previousDeletionStrategy',sweep.deletion_strategy,
         'previousSourceTotalStrategy',sweep.source_total_strategy
       ),
       active_queue_name=NULL,active_message_id=NULL,
       active_worker_id=NULL,active_read_count=NULL,
       updated_at=clock_timestamp()
 WHERE sweep.connector_id='momence'
   AND sweep.stream IN (
     'momence_appointments','momence_sessions','momence_session_details',
     'momence_session_bookings','momence_member_sessions',
     'momence_member_appointments','momence_public_sessions',
     'momence_payment_transactions'
   )
   AND sweep.status IN ('planned','running');

-- Completed and explicitly blocked rows remain immutable historical evidence.
-- Any future active row, including one attempted by an older worker binary,
-- must use the new bounded policy.
ALTER TABLE control_plane.reconciliation_stream_sweeps
  DROP CONSTRAINT IF EXISTS reconciliation_stream_sweeps_momence_bounded_policy_check;
ALTER TABLE control_plane.reconciliation_stream_sweeps
  ADD CONSTRAINT reconciliation_stream_sweeps_momence_bounded_policy_check CHECK (
    connector_id<>'momence'
    OR stream NOT IN (
      'momence_appointments','momence_sessions','momence_session_details',
      'momence_session_bookings','momence_member_sessions',
      'momence_member_appointments','momence_public_sessions',
      'momence_payment_transactions'
    )
    OR status IN ('complete','blocked')
    OR (
      deletion_strategy='no_absence_deletes'
      AND source_total_strategy='count_distinct_bounded_scan'
    )
  ) NOT VALID;
ALTER TABLE control_plane.reconciliation_stream_sweeps
  VALIDATE CONSTRAINT reconciliation_stream_sweeps_momence_bounded_policy_check;

COMMIT;
