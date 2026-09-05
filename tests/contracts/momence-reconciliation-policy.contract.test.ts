import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MomenceConnector } from "../../connectors/momence/index.js";
import { momenceManifest } from "../../connectors/momence/manifest.js";
import {
  MOMENCE_READ_STREAMS,
  momenceDeletionContract,
  momenceSourceTotalContract,
} from "../../connectors/momence/streams.js";
import {
  assertConnectorManifestReconciliationPolicy,
  type ConnectorContext,
  type WorkerCredentialVault,
} from "../../packages/connector-sdk/src/index.js";

const root = new URL("../../", import.meta.url);
const boundedStreamIds = [
  "momence_appointments",
  "momence_sessions",
  "momence_session_details",
  "momence_session_bookings",
  "momence_member_sessions",
  "momence_member_appointments",
  "momence_public_sessions",
] as const;

test("all seven Momence time-filtered populations forbid absence tombstones", () => {
  assert.doesNotThrow(() => assertConnectorManifestReconciliationPolicy(momenceManifest));
  const manifestById = new Map(momenceManifest.streams.map((stream) => [stream.id, stream]));
  const actualBoundedIds = MOMENCE_READ_STREAMS
    .filter((stream) => "timeFilter" in stream && stream.timeFilter)
    .map((stream) => stream.id);

  assert.deepEqual(actualBoundedIds, [...boundedStreamIds]);
  for (const id of boundedStreamIds) {
    const stream = MOMENCE_READ_STREAMS.find((candidate) => candidate.id === id);
    const contract = manifestById.get(id);
    assert.ok(stream, id);
    assert.equal(momenceDeletionContract(stream), "no_absence_deletes", id);
    assert.equal(momenceSourceTotalContract(stream), "count_distinct_bounded_scan", id);
    assert.equal(contract?.deletionStrategy, "no_absence_deletes", id);
    assert.equal(contract?.sourceTotalStrategy, "count_distinct_bounded_scan", id);
  }
  assert.match(
    momenceManifest.limitations.join(" "),
    /Absence from that bounded scan is never treated as evidence.*deleted/iu,
  );
});

test("note-discovered payment transactions forbid absence tombstones", () => {
  const stream = MOMENCE_READ_STREAMS.find(
    (candidate) => candidate.id === "momence_payment_transactions",
  );
  const contract = momenceManifest.streams.find(
    (candidate) => candidate.id === "momence_payment_transactions",
  );

  assert.ok(stream);
  assert.equal(momenceDeletionContract(stream), "no_absence_deletes");
  assert.equal(momenceSourceTotalContract(stream), "count_distinct_bounded_scan");
  assert.equal(contract?.deletionStrategy, "no_absence_deletes");
  assert.equal(contract?.sourceTotalStrategy, "count_distinct_bounded_scan");
  assert.match(
    momenceManifest.limitations.join(" "),
    /Payment-transaction reconciliation covers only transaction ids currently discoverable[\s\S]+never treated as evidence.*transaction was deleted/iu,
  );
});

test("Momence runtime stream registration uses the exact manifest reconciliation policy", async () => {
  const connector = new MomenceConnector({
    clientId: "momence-policy-test",
    clientSecret: "momence-policy-secret",
    redirectUri: "https://albert.example/api/oauth/momence/callback",
    vault: {} as WorkerCredentialVault,
  });
  const context: ConnectorContext = {
    tenantId: "tenant-policy-test",
    connectionId: "connection-policy-test",
    credentialRef: "credential-policy-test",
  };
  const runtimeById = new Map(
    (await connector.list_streams(context)).map((stream) => [stream.id, stream]),
  );

  for (const contract of momenceManifest.streams) {
    const runtime = runtimeById.get(contract.id);
    assert.ok(runtime, contract.id);
    assert.equal(runtime.deletionStrategy, contract.deletionStrategy, contract.id);
    assert.equal(runtime.sourceTotalStrategy, contract.sourceTotalStrategy, contract.id);
  }
});

test("durable reconciliation admits bounded totals but selects tombstones only for authoritative scans", async () => {
  const [control, analytical] = await Promise.all([
    readFile(new URL("infra/migrations/control-plane/0128_m2_no_absence_delete_reconciliation.sql", root), "utf8"),
    readFile(new URL("infra/migrations/analytical/0151_m2_no_absence_delete_reconciliation.sql", root), "utf8"),
  ]);

  for (const migration of [control, analytical]) {
    assert.match(migration, /no_absence_deletes/u);
    assert.match(migration, /count_distinct_bounded_scan/u);
    assert.match(
      migration,
      /deletion_strategy<>'authoritative_identity_scan'[\s\S]+source_total_strategy<>'count_distinct_bounded_scan'/u,
    );
  }
  assert.match(
    analytical,
    /first_scan\.deletion_strategy=''authoritative_identity_scan''/u,
  );
  assert.match(
    analytical,
    /verified_deletion_strategy IN \('no_absence_deletes','immutable_append_only'\)[\s\S]+tombstone_count<>0/u,
  );
  assert.match(
    analytical,
    /verified_source_total_strategy='count_distinct_bounded_scan'[\s\S]+source_total=verified_source_total,local_live_total=NULL/u,
  );
  assert.match(
    analytical,
    /source_total_strategy<>''count_distinct_bounded_scan''/u,
  );
});

test("Momence policy rollout invalidates old authority and fences in-flight tombstones", async () => {
  const [control, analytical, executableProof] = await Promise.all([
    readFile(
      new URL("infra/migrations/control-plane/0131_m2_momence_bounded_reconciliation_transition.sql", root),
      "utf8",
    ),
    readFile(
      new URL("infra/migrations/analytical/0153_m2_momence_bounded_reconciliation_transition.sql", root),
      "utf8",
    ),
    readFile(
      new URL("tests/sql/analytical-momence-reconciliation-policy.sql", root),
      "utf8",
    ),
  ]);
  const transitionedStreamIds = [...boundedStreamIds, "momence_payment_transactions"];

  for (const id of transitionedStreamIds) {
    assert.match(control, new RegExp(`'${id}'`, "u"), id);
    assert.match(analytical, new RegExp(`'${id}'`, "u"), id);
  }
  assert.match(
    control,
    /sync_job_requests[\s\S]+status='failed'[\s\S]+reconciliation_policy_superseded/iu,
  );
  assert.match(
    control,
    /LOCK TABLE control_plane\.canonical_transform_jobs,\s*control_plane\.sync_job_requests,\s*control_plane\.reconciliation_stream_sweeps\s+IN SHARE ROW EXCLUSIVE MODE/u,
    "the cutover must drain transform claims/enqueues and source-request mutations atomically",
  );
  assert.match(
    control,
    /UPDATE control_plane\.canonical_transform_jobs job[\s\S]+SET status='failed'[\s\S]+lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL[\s\S]+WHERE job\.status IN \('queued','running','retry_wait'\)[\s\S]+job\.connector_id='momence'/u,
    "every active canonical projection of a superseded Momence tombstone batch must be terminal and unleased",
  );
  assert.match(
    control,
    /FROM control_plane\.sync_runs run[\s\S]+request\.job_request_id=run\.queue_job_reference[\s\S]+run\.tenant_id=job\.tenant_id[\s\S]+run\.sync_run_id=job\.sync_run_id[\s\S]+run\.connection_id=job\.connection_id[\s\S]+run\.connection_generation=job\.connection_generation[\s\S]+request\.payload->>'tenantId'=job\.tenant_id[\s\S]+request\.payload->>'connectionId'=job\.connection_id[\s\S]+request\.payload->>'connectionGeneration'=job\.connection_generation::text[\s\S]+request\.payload->>'connectorId'=job\.connector_id[\s\S]+request\.payload->>'stream'=job\.stream[\s\S]+request\.payload->>'syncRunId'=job\.sync_run_id[\s\S]+request\.payload->>'batchId'=job\.batch_id[\s\S]+request\.payload->>'phase'='apply_tombstones'/u,
    "canonical retirement must resolve the originating request and match its complete generation-fenced immutable lineage",
  );
  assert.match(
    control,
    /CREATE OR REPLACE FUNCTION control_plane\.guard_superseded_momence_tombstone_transform\(\)[\s\S]+request\.last_error->>'code'='reconciliation_policy_superseded'[\s\S]+request\.payload->>'connectionGeneration'=NEW\.connection_generation::text[\s\S]+request\.payload->>'syncRunId'=NEW\.sync_run_id[\s\S]+request\.payload->>'batchId'=NEW\.batch_id[\s\S]+request\.payload->>'phase'='apply_tombstones'[\s\S]+CREATE TRIGGER guard_superseded_momence_tombstone_transform_insert\s+BEFORE INSERT ON control_plane\.canonical_transform_jobs/u,
    "a pre-landed stale page must not enqueue canonical work after the cutover locks release",
  );
  const transformQueueLock = control.indexOf(
    "LOCK TABLE control_plane.canonical_transform_jobs,",
  );
  const requestRetirement = control.indexOf("UPDATE control_plane.sync_job_requests request");
  const transformRetirement = control.indexOf(
    "UPDATE control_plane.canonical_transform_jobs job",
  );
  const lateInsertGuard = control.indexOf(
    "CREATE TRIGGER guard_superseded_momence_tombstone_transform_insert",
  );
  const controlCommit = control.lastIndexOf("COMMIT;");
  assert.ok(transformQueueLock >= 0, "the canonical queue must be locked");
  assert.ok(transformQueueLock < requestRetirement, "locks must precede request retirement");
  assert.ok(requestRetirement < transformRetirement, "requests must be stamped before transforms retire");
  assert.ok(transformRetirement < lateInsertGuard, "existing work must retire before the late-insert guard installs");
  assert.ok(lateInsertGuard < controlCommit, "the late-insert guard must commit atomically with retirement");
  assert.match(
    control,
    /reconciliation_stream_sweeps[\s\S]+status='blocked'[\s\S]+active_queue_name=NULL/iu,
  );
  assert.match(
    control,
    /reconciliation_stream_sweeps_momence_bounded_policy_check[\s\S]+status IN \('complete','blocked'\)[\s\S]+deletion_strategy='no_absence_deletes'[\s\S]+source_total_strategy='count_distinct_bounded_scan'/u,
  );

  assert.match(
    analytical,
    /UPDATE quality\.reconciliation_snapshot[\s\S]+SET status='failed'[\s\S]+snapshot\.connector_id='momence'/u,
  );
  assert.match(
    analytical,
    /CREATE TEMPORARY TABLE momence_bounded_tombstone_repair[\s\S]+ingestion\.canonical_staging_batch_records staged[\s\S]+staged\.staging_row->>'tombstone'='false'[\s\S]+UPDATE ingestion\.source_records source[\s\S]+source_version=repair\.restored_staging_row->>'source_version'[\s\S]+source_updated_at=\(repair\.restored_staging_row->>'source_updated_at'\)::timestamptz[\s\S]+payload_hash=repair\.restored_payload_hash[\s\S]+normalized_payload=jsonb_set\([\s\S]+tombstone=false[\s\S]+payload_batch_id=repair\.restored_batch_id[\s\S]+sync_run_id=repair\.restored_sync_run_id/u,
    "the upgrade must restore exact landing lineage from the last committed live immutable staging envelope",
  );
  assert.match(
    analytical,
    /UPDATE source_momence\.%1\$I typed[\s\S]+SET %2\$s[\s\S]+jsonb_populate_record\([\s\S]+NULL::source_momence\.%1\$I,lineage\.restored_staging_row/u,
    "the upgrade must restore every mutable typed field from exact immutable staging",
  );
  assert.match(
    analytical,
    /Momence bounded tombstone has no unique committed invalid staging envelope[\s\S]+Momence bounded tombstone lacks exact committed pre-tombstone staging lineage[\s\S]+Momence bounded-policy exact source lineage restore failed/u,
    "the transition must fail closed if either landing projection remains hidden",
  );
  assert.match(
    analytical,
    /WITH RECURSIVE eligible AS MATERIALIZED[\s\S]+row_number\(\) OVER[\s\S]+replay \([\s\S]+candidate\.candidate_effective_at>=replay\.claimed_effective_at[\s\S]+candidate\.payload_hash<>replay\.claimed_payload_hash[\s\S]+candidate\.candidate_source_version[\s\S]+IS DISTINCT FROM replay\.claimed_source_version[\s\S]+candidate\.mapping_version[\s\S]+IS DISTINCT FROM replay\.claimed_mapping_version/u,
    "canonical recovery must replay transformed observations with the exact state-claim predicate",
  );
  assert.match(
    analytical,
    /count\(DISTINCT \(candidate\.batch_id,candidate\.mapping_version\)\)>1[\s\S]+Momence canonical tombstone repair transform order is ambiguous/u,
    "canonical recovery must fail closed when durable transform order is ambiguous",
  );
  assert.doesNotMatch(
    analytical,
    /ORDER BY candidate\.candidate_effective_at DESC/u,
    "a higher-timestamp identical replay is not a canonical state claim",
  );
  for (const table of [
    "ingestion.source_records",
    "ingestion.canonical_staging_batch_records",
    "ingestion.batch_manifests",
    "ingestion.landing_commits",
    "semantic_internal.canonical_transform_commits",
    "quality.connector_stream_state",
    "quality.reconciliation_snapshot",
    "quality.reconciliation_tombstone_application",
  ]) {
    assert.match(analytical, new RegExp(`ALTER TABLE ${table.replaceAll(".", "\\.")} NO FORCE ROW LEVEL SECURITY`, "u"), table);
    assert.match(analytical, new RegExp(`ALTER TABLE ${table.replaceAll(".", "\\.")} FORCE ROW LEVEL SECURITY`, "u"), table);
  }
  assert.match(
    analytical,
    /ALTER TABLE source_momence\.%I NO FORCE ROW LEVEL SECURITY[\s\S]+ALTER TABLE source_momence\.%I FORCE ROW LEVEL SECURITY/u,
    "the table-owner repair must temporarily and transactionally bypass FORCE RLS on every typed table",
  );
  assert.match(
    analytical,
    /quality\.reconciliation_tombstone_application applied[\s\S]+application_count\.candidate_count<=1[\s\S]+Momence bounded tombstone has ambiguous application audit lineage/u,
    "the repair mapping must retain exact application evidence without deleting the audit row",
  );
  assert.match(
    analytical,
    /snapshot\.duplicate_count>0 AND NOT \('[\s\S]+p_connector_id=''momence''[\s\S]+p_stream=''momence_payment_transactions''[\s\S]+p_deletion_strategy=''no_absence_deletes''[\s\S]+p_source_total_strategy=''count_distinct_bounded_scan''/u,
    "only note-discovered Momence payments may use durable distinct identity evidence across duplicate observations",
  );
  const sourceLandingLock = analytical.indexOf(
    "LOCK TABLE ingestion.source_records IN SHARE ROW EXCLUSIVE MODE;",
  );
  const snapshotInvalidation = analytical.indexOf("UPDATE quality.reconciliation_snapshot");
  const landingTrigger = analytical.indexOf(
    "CREATE TRIGGER guard_momence_bounded_reconciliation_tombstone_insert",
  );
  assert.ok(sourceLandingLock >= 0, "the policy cutover must lock source landing");
  assert.ok(sourceLandingLock < snapshotInvalidation, "source landing must lock before invalidation");
  assert.ok(snapshotInvalidation < landingTrigger, "the landing guard must install before lock release");
  assert.match(
    analytical,
    /UPDATE quality\.connector_stream_state[\s\S]+deletion_strategy='no_absence_deletes'[\s\S]+source_total_strategy='count_distinct_bounded_scan'[\s\S]+reconciliation_completed_at=NULL[\s\S]+local_live_total=NULL/u,
  );
  assert.match(
    analytical,
    /JOIN quality\.connector_stream_state current_policy[\s\S]+current_policy\.deletion_strategy='authoritative_identity_scan'[\s\S]+current_policy\.source_total_strategy<>'count_distinct_bounded_scan'/u,
  );
  assert.match(
    analytical,
    /CREATE TRIGGER guard_momence_bounded_reconciliation_tombstone_insert[\s\S]+CREATE TRIGGER guard_momence_bounded_reconciliation_tombstone_update/u,
  );
  assert.match(
    analytical,
    /NEW\.connector_key='momence'[\s\S]+NEW\.tombstone[\s\S]+NEW\.stream IN[\s\S]+ERRCODE='55000'/u,
  );
  assert.doesNotMatch(
    analytical,
    /snapshot\.reconciliation_sweep_id=NEW\.sync_run_id/u,
    "successor phases have distinct sync-run ids and must not weaken the landing fence",
  );
  assert.match(
    executableProof,
    /'01H00000000000000000000M03','momence','momence_sessions',1/u,
    "the SQL proof must use a durable sweep id",
  );
  assert.match(
    executableProof,
    /payload_batch_id='01H00000000000000000000M07',[\s\S]+sync_run_id='01H00000000000000000000M0B'/u,
    "the stale apply-phase landing must use a distinct sync-run id",
  );
  assert.doesNotMatch(
    executableProof,
    /payload_batch_id='01H00000000000000000000M07',[\s\S]+sync_run_id='01H00000000000000000000M03'/u,
  );
  assert.match(
    executableProof,
    /duplicate payment references must reduce to one exact durable identity[\s\S]+payment source total must be the exact durable distinct identity count/u,
  );
});
