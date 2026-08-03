import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildTransformCapacityEvidence,
  loadTransformCapacityHarnessConfig,
} from "../../scripts/transform-capacity-harness.js";

const releaseSha = "a".repeat(40);
const baseEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  ALBERT_CAPACITY_ENVIRONMENT: "staging",
  ALBERT_CAPACITY_MODE: "load",
  ALBERT_CAPACITY_RUN_APPROVED: `load-staging:${releaseSha}`,
  ALBERT_CAPACITY_RUN_ID: "github-1234-1",
  ALBERT_CAPACITY_MIN_SAMPLES: "500",
  ALBERT_CAPACITY_MAX_CLAIMS: "20000",
  ALBERT_SERVICE_VERSION: releaseSha,
  ALBERT_DEPLOYMENT_ID: "github-1234-1",
  ALBERT_CONTROL_PLANE_PROJECT_REF: "abcdefghijklmnopqrst",
  ALBERT_CONTROL_PLANE_REGION: "ap-southeast-2",
  ALBERT_ANALYTICAL_REGION: "ap-southeast-2",
  ALBERT_TRANSFORM_WORKER_ID: "transform-worker",
  ALBERT_WORKER_CONCURRENCY: "8",
  ALBERT_SNAPSHOT_CLAIM_BATCH_SIZE: "8",
  ALBERT_SNAPSHOT_MAX_CLAIMS_PER_RUN: "20000",
  FLY_MACHINE_ID: "abcdef12345678",
  ALBERT_CAPACITY_NOT_BEFORE: new Date(Date.now() + 60_000).toISOString(),
  ALBERT_CAPACITY_HOLD_UNTIL: new Date(Date.now() + 120_000).toISOString(),
  TRANSFORM_CONTROL_PLANE_DATABASE_URL:
    "postgresql://albert_transform_control_runtime:secret@db.abcdefghijklmnopqrst.supabase.co/postgres?sslmode=verify-full",
  TRANSFORM_DATABASE_URL:
    "postgresql://albert_transform_analytical_runtime:secret@analytical.invalid/postgres?sslmode=require",
};

test("capacity evidence is an explicit single-process projection, never release evidence", () => {
  const evidence = buildTransformCapacityEvidence({
    environment: "staging",
    mode: "load",
    releaseSha,
    runId: "github-1234-1",
    sampleCount: 500,
    minimumSampleCount: 500,
    completedByHarness: 500,
    observedP95Ms: 2_500,
    generatedAt: "2026-08-03T00:00:00.000Z",
  });
  assert.equal(evidence.projectedRequiredMachines, 3);
  assert.equal(evidence.projectedMachineFloor, 3);
  assert.equal(evidence.maximumSupportedP95Ms, 40_320);
  assert.equal(evidence.releaseEligible, false);
  assert.equal(evidence.diagnosticPassed, true);
  assert.equal(evidence.measurementScope, "single_process_diagnostic");
  assert.equal(evidence.workerProcesses, 1);
  assert.equal(evidence.claimBatchSize, 8);
  assert.deepEqual(evidence.blockingLimitations, [
    "single_process_shared_fleet_database_saturation_not_measured",
    "single_process_workload_profile_not_attested",
    "single_process_not_bound_to_protected_staging_orchestration",
    "single_process_cannot_satisfy_independent_fleet_attestation",
  ]);
  assert.equal(evidence.designTenants, 20_000);
  assert.equal(evidence.lanesPerProcess, 8);
  assert.equal(evidence.targetUtilization, 0.7);
  assert.equal(evidence.maximumMachines, 40);
});

test("capacity diagnostics cannot pass an undersized sample or the reviewed projection ceiling", () => {
  const tooSmall = buildTransformCapacityEvidence({
    environment: "staging",
    mode: "load",
    releaseSha,
    runId: "github-1234-1",
    sampleCount: 499,
    minimumSampleCount: 500,
    completedByHarness: 499,
    observedP95Ms: 2_500,
  });
  assert.equal(tooSmall.diagnosticPassed, false);
  assert.equal(tooSmall.releaseEligible, false);

  const tooSlow = buildTransformCapacityEvidence({
    environment: "staging",
    mode: "load",
    releaseSha,
    runId: "github-1234-1",
    sampleCount: 500,
    minimumSampleCount: 500,
    completedByHarness: 500,
    observedP95Ms: 600_000,
  });
  assert.ok(tooSlow.projectedRequiredMachines > tooSlow.maximumMachines);
  assert.equal(tooSlow.diagnosticPassed, false);
  assert.equal(tooSlow.releaseEligible, false);
});

test("managed capacity runs require reviewed lanes, sample size, and SHA-bound approval", () => {
  const staging = loadTransformCapacityHarnessConfig({ ...baseEnvironment });
  assert.equal(staging.environment, "staging");
  assert.equal(staging.mode, "load");
  assert.equal(staging.minimumSamples, 500);
  assert.equal(staging.workerConcurrency, 8);
  assert.equal(staging.snapshotClaimBatchSize, 8);
  assert.equal(staging.participantId, "abcdef12345678");
  assert.equal(staging.workerId, "capacity:github-1234-1:abcdef12345678");

  assert.throws(
    () => loadTransformCapacityHarnessConfig({
      ...baseEnvironment,
      ALBERT_CAPACITY_RUN_APPROVED: "load-staging:not-the-release",
    }),
    /bound to the exact release SHA/,
  );
  assert.throws(
    () => loadTransformCapacityHarnessConfig({
      ...baseEnvironment,
      ALBERT_WORKER_CONCURRENCY: "7",
    }),
    /reviewed 8 transform lanes/,
  );
  assert.throws(
    () => loadTransformCapacityHarnessConfig({
      ...baseEnvironment,
      ALBERT_SNAPSHOT_CLAIM_BATCH_SIZE: "7",
    }),
    /reviewed 8-claim batch/,
  );
  assert.throws(
    () => loadTransformCapacityHarnessConfig({
      ...baseEnvironment,
      ALBERT_CAPACITY_MIN_SAMPLES: "499",
    }),
    /at least 500 completed tenants/,
  );
  assert.throws(
    () => loadTransformCapacityHarnessConfig({
      ...baseEnvironment,
      ALBERT_CAPACITY_ENVIRONMENT: "production",
    }),
    /must be local or staging/,
  );
  assert.throws(
    () => loadTransformCapacityHarnessConfig({
      ...baseEnvironment,
      TRANSFORM_CONTROL_PLANE_DATABASE_URL: "postgresql://postgres:secret@localhost/postgres",
    }),
    /must not target a local database|albert_transform_control_runtime/,
  );
});

test("the harness uses run-scoped durable metrics and bounded maintenance retention", async () => {
  const source = await readFile(
    new URL("../../scripts/transform-capacity-harness.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /pipeline\.snapshotAllTenants\(config\.workerId/u);
  assert.match(source, /pipeline\.transformMaintenanceMetrics\(\)/u);
  assert.match(source, /pipeline\.transformCapacityRunMetrics\(config\.workerId, startedAt\)/u);
  assert.match(source, /after\.completed[\s\S]*completedByHarness/u);
  assert.doesNotMatch(source, /from\s+control_plane\.transform_maintenance_leases/iu);
  assert.doesNotMatch(source, /set\s+(?:local\s+)?role/iu);

  const migration = await readFile(
    new URL("../../infra/migrations/control-plane/0051_m2_transform_maintenance_capacity_retention.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /transform_maintenance_completed_at_idx/u);
  assert.match(migration, /transform_maintenance_worker_completed_at_idx/u);
  assert.match(migration, /completed_at<statement_timestamp\(\)-interval '48 hours'/u);
  assert.match(migration, /transform_capacity_run_metrics/u);
});
