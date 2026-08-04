BEGIN;

-- Identical source snapshots in different scheduled runs are different
-- observations: each needs its own raw object, manifest, landing, transform,
-- and quality lineage. Only a retry inside one sync run may reuse an already
-- registered page.
ALTER TABLE control_plane.raw_batch_manifests
  DROP CONSTRAINT IF EXISTS raw_batch_manifests_tenant_id_connection_id_content_hash_st_key;

ALTER TABLE control_plane.raw_batch_manifests
  ADD CONSTRAINT raw_batch_manifests_run_content_identity_key
  UNIQUE (
    tenant_id,sync_run_id,connection_id,stream,content_hash,cursor_start,cursor_end
  );

COMMENT ON CONSTRAINT raw_batch_manifests_run_content_identity_key
  ON control_plane.raw_batch_manifests IS
  'Deduplicates a crash-replayed page only inside its exact sync run; distinct runs retain distinct immutable lineage.';

-- ADR 0056 originally left a chunk run open whenever its last page had a
-- continuation. Once the queue request is terminal no worker can legitimately
-- keep using that run, so repair the stranded ledger rows without changing
-- their accumulated page counts or cursors.
UPDATE control_plane.sync_runs run
   SET status=request.status,
       error_code=CASE WHEN request.status='failed'
         THEN coalesce(run.error_code,request.last_error->>'code','unexpected_sync_failure')
         ELSE NULL END,
       error_summary=CASE WHEN request.status='failed'
         THEN coalesce(run.error_summary,request.last_error->>'code','unexpected_sync_failure')
         ELSE NULL END,
       finished_at=coalesce(request.completed_at,request.updated_at,now())
  FROM control_plane.sync_job_requests request
 WHERE request.tenant_id=run.tenant_id
   AND request.job_request_id=run.queue_job_reference
   AND request.status IN ('succeeded','failed')
   AND run.status IN ('running','retry_wait');

COMMIT;
