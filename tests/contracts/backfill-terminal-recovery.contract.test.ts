import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rawIdentity = readFileSync(
  "infra/migrations/control-plane/0078_m2_run_scoped_raw_batch_identity.sql","utf8",
);
const referenceBarrier = readFileSync(
  "infra/migrations/control-plane/0079_m4_reference_dependency_retry_barrier.sql","utf8",
);
const stagingAcl = readFileSync(
  "infra/migrations/analytical/0108_m2_ingest_canonical_staging_validator_acl.sql","utf8",
);
const rawWriter = readFileSync("packages/storage/src/raw-batch.ts","utf8");
const controlStore = readFileSync("services/sync-workers/src/control-plane-store.ts","utf8");
const worker = readFileSync("services/sync-workers/src/worker.ts","utf8");

test("identical snapshots deduplicate only inside the exact sync run", () => {
  assert.match(
    rawIdentity,
    /DROP CONSTRAINT IF EXISTS raw_batch_manifests_tenant_id_connection_id_content_hash_st_key/u,
  );
  assert.match(
    rawIdentity,
    /UNIQUE \([\s\S]*tenant_id,sync_run_id,connection_id,stream,content_hash,cursor_start,cursor_end/u,
  );
  assert.match(rawWriter,/RawBatchContentIdentity[\s\S]*syncRunId: string/u);
  assert.match(rawWriter,/syncRunId: context\.syncRunId/u);
  assert.match(
    controlStore,
    /where tenant_id=\$1 and sync_run_id=\$2 and connection_id=\$3[\s\S]*content_hash=\$5/u,
  );
});

test("multi-page claims resume their committed cursor and close only after successor publication", () => {
  assert.match(controlStore,/resumeInitialBackfillCursor[\s\S]*select cursor_end/u);
  assert.match(worker,/runResumeCursor[\s\S]*connector\.initial_sync\([\s\S]*runResumeCursor \?\? job\.cursor/u);
  assert.match(worker,/pageStartCursor = currentPage\.nextCursor/u);
  assert.match(worker,/keepRunOpen: true/u);
  const successor = worker.indexOf("await this.enqueueContinuation(job, currentPage.nextCursor)");
  const runCompletion = worker.indexOf("await this.control.completePageRun(job)");
  const queueCompletion = worker.indexOf("await this.queue.complete(claim",runCompletion);
  assert.ok(successor >= 0 && successor < runCompletion);
  assert.ok(runCompletion < queueCompletion);
  assert.match(
    rawIdentity,
    /request\.status IN \('succeeded','failed'\)[\s\S]*run\.status IN \('running','retry_wait'\)/u,
  );
});

test("reference waiters do not burn the failure budget while ordinary sibling pages remain", () => {
  assert.match(referenceBarrier,/p_error->>'code'='canonical_reference_missing'/u);
  assert.match(
    referenceBarrier,
    /sibling\.status='queued'[\s\S]*sibling\.status='retry_wait'[\s\S]*IS DISTINCT FROM 'canonical_reference_missing'/u,
  );
  assert.match(
    referenceBarrier,
    /attempt_count=CASE WHEN reference_backlog[\s\S]*greatest\(job\.attempt_count-1,0\)/u,
  );
  assert.match(referenceBarrier,/WHEN NOT reference_backlog[\s\S]*THEN now\(\)/u);
});

test("the declared immutable-staging writer can execute its ULID validator", () => {
  assert.match(stagingAcl,/REVOKE ALL ON FUNCTION core\.is_ulid\(text\) FROM PUBLIC/u);
  assert.match(stagingAcl,/GRANT EXECUTE ON FUNCTION core\.is_ulid\(text\) TO ingest_rw/u);
  assert.doesNotMatch(stagingAcl,/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|ALL)/iu);
});
