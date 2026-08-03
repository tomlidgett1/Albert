import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateReleaseEnvironment } from "../scripts/release-preflight.mjs";
import { createTransformFleetCapacityAttestation } from "../scripts/transform-fleet-capacity-attestation.mjs";
import { validateRuntimeSecretNames } from "../scripts/validate-runtime-secrets.mjs";

const projectRef = "abcdefghijklmnopqrst";
const releaseSha = "a".repeat(40);
const capacityP95Ms = 2_500;
const repository = "tomlidgett1/Albert";
const workflowRunId = "123456789";
const workflowRunAttempt = "2";
const workflowRef = `${repository}/.github/workflows/release.yml@refs/heads/main`;
const capacityKeys = generateKeyPairSync("ed25519");
const capacityProducerRef = `tomlidgett1/albert-release-trust@${"d".repeat(40)}`;
const capacityProducerBuildDigest = `sha256:${"e".repeat(64)}`;
const capacityCorpusFingerprint = "f".repeat(64);
const validRelease = Object.freeze({
  ALBERT_RELEASE_ENVIRONMENT: "staging",
  ALBERT_RELEASE_COMMIT_SHA: releaseSha,
  ALBERT_CONTROL_PLANE_PROJECT_REF: projectRef,
  ALBERT_CONTROL_PLANE_REGION: "ap-southeast-2",
  ALBERT_ANALYTICAL_REGION: "ap-southeast-2",
  SUPABASE_STORAGE_S3_ENDPOINT: `https://${projectRef}.storage.supabase.co/storage/v1/s3`,
  SUPABASE_STORAGE_S3_REGION: "ap-southeast-2",
  ALBERT_MODEL_DATA_RESIDENCY_REGION: "au",
  ALBERT_MODEL_DATA_CONTROL_APPROVED: "true",
  ALBERT_LIGHTSPEED_PRODUCT: "r-series",
  OPENAI_BASE_URL: "https://au.api.openai.com/v1",
  NEXT_PUBLIC_SUPABASE_URL: `https://${projectRef}.supabase.co`,
  ALBERT_PUBLIC_ORIGIN: "https://albert.example",
  SEMANTIC_QUERY_SERVICE_URL: "https://semantic.albert.example",
  OPERATOR_DIAGNOSTIC_SERVICE_URL: "https://diagnostic.albert.example",
  SYNC_WORKER_INTERNAL_URL: "https://sync.albert.example",
  WEBHOOK_GATEWAY_PUBLIC_URL: "https://webhooks.albert.example",
  CONTROL_PLANE_MIGRATION_URL:
    `postgresql://albert_control_deployer.${projectRef}:secret@control.example/postgres?sslmode=verify-full`,
  ANALYTICAL_MIGRATION_URL:
    "postgresql://albert_analytical_deployer:secret@analytics.example/postgres?sslmode=require",
  FLY_SEMANTIC_APP: "albert-semantic-prod",
  FLY_SYNC_APP: "albert-sync-prod",
  FLY_TRANSFORM_APP: "albert-transform-prod",
  FLY_WEBHOOK_APP: "albert-webhook-prod",
  FLY_DELETION_APP: "albert-deletion-prod",
  FLY_OPERATOR_DIAGNOSTIC_APP: "albert-diagnostic-prod",
  FLY_SYNC_AUTOSCALER_APP: "albert-sync-autoscaler-prod",
  FLY_TRANSFORM_AUTOSCALER_APP: "albert-transform-autoscaler-prod",
  FLY_ORGANIZATION_SLUG: "albert-production",
  ALBERT_SNAPSHOT_P95_MS: String(capacityP95Ms),
  GITHUB_REPOSITORY: repository,
  GITHUB_RUN_ID: workflowRunId,
  GITHUB_RUN_ATTEMPT: workflowRunAttempt,
  GITHUB_WORKFLOW_REF: workflowRef,
  ALBERT_CAPACITY_STAGING_CELL_ID: "sydney-capacity-01",
  ALBERT_CAPACITY_CORPUS_FINGERPRINT: capacityCorpusFingerprint,
  ALBERT_CAPACITY_ATTESTOR_TOOL_REF: capacityProducerRef,
  ALBERT_CAPACITY_ATTESTOR_BUILD_DIGEST: capacityProducerBuildDigest,
  ALBERT_CAPACITY_ED25519_PUBLIC_KEY_BASE64: Buffer.from(
    capacityKeys.publicKey.export({ format: "pem", type: "spki" }),
  ).toString("base64"),
});

const healthyProject = Object.freeze({
  ref: projectRef,
  region: "ap-southeast-2",
  status: "ACTIVE_HEALTHY",
});

test("release preflight binds a healthy Sydney control plane to distinct least-privilege targets", () => {
  assert.deepEqual(validateReleaseEnvironment(validRelease, healthyProject), {
    releaseEnvironment: "staging",
    commitSha: releaseSha,
    projectRef,
    transformMachineFloor: 3,
    capacityAttestationDigest: null,
  });
});

function productionCapacityEnvelope() {
  const now = Date.now();
  const startedAt = new Date(now - 21 * 60_000);
  const completedAt = new Date(now - 2 * 60_000);
  const generatedAt = new Date(now - 60_000);
  return createTransformFleetCapacityAttestation({
    schemaVersion: 1, kind: "albert_transform_fleet_capacity", stagingEnvironment: "staging",
    stagingCellId: "sydney-capacity-01", candidateSha: releaseSha, nonce: "b".repeat(64), passed: true,
    producer: { toolRef: capacityProducerRef, buildDigest: capacityProducerBuildDigest },
    startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(),
    generatedAt: generatedAt.toISOString(), expiresAt: new Date(now + 60 * 60_000).toISOString(),
    workflow: { repository, runId: workflowRunId, runAttempt: Number(workflowRunAttempt),
      job: "attest-transform-fleet-capacity", workflowRef },
    workload: {
      designTenants: 20_000, completedTenants: 20_000, distinctTenants: 20_000,
      corpusContractDigest: "82895eb48467068eabdb9b4c511e85242cedbc2584d0127ee700e791e4bdcf4a",
      corpusFingerprint: capacityCorpusFingerprint,
      sourceRows: { p50: 4_000, p95: 20_000, max: 80_000 },
      canonicalRows: { p50: 2_000, p95: 10_000, max: 40_000 },
      strata: [
        { id: "micro", minRows: 1, maxRows: 999, count: 2_000 },
        { id: "small", minRows: 1_000, maxRows: 9_999, count: 14_000 },
        { id: "medium", minRows: 10_000, maxRows: null, count: 4_000 },
      ],
    },
    fleet: { requestedMachineFloor: 4, observedWorkerProcesses: 4, minRunningMachines: 4,
      maxRunningMachines: 4, completedClaims: 20_000, errorCount: 0, p95TenantMs: 120,
      p99TenantMs: 180, sweepDurationMs: completedAt.getTime() - startedAt.getTime(),
      participantDigest: "c".repeat(64) },
    queue: { maintenanceDueAtStart: 20_000, maintenanceDueAtEnd: 0,
      maxActiveMaintenanceLeases: 32, transformJobQueueDepthAtStart: 0,
      transformJobQueueDepthAtEnd: 0, oldestVisibleJobAgeSecondsAtEnd: 0, sampleCount: 120 },
    databases: {
      control: { maxConnections: 100, peakConnections: 50, peakUtilization: 0.5,
        poolAcquireP95Ms: 20, maxLockWaiters: 0, deadlocksDelta: 0, sampleCount: 120 },
      analytical: { maxConnections: 200, peakConnections: 100, peakUtilization: 0.5,
        poolAcquireP95Ms: 30, maxLockWaiters: 1, deadlocksDelta: 0, sampleCount: 120 },
    },
    autoscaler: { appName: "albert-transform-capacity-autoscaler", minDesiredMachines: 4,
      maxDesiredMachines: 4, minObservedMachines: 1, maxObservedMachines: 4,
      reachedRequestedFloorAt: new Date(now - 31 * 60_000).toISOString(),
      stableAtOrAboveFloorSeconds: 29 * 60, sampleCount: 180, errorCount: 0 },
    stagingDeployment: { appName: "albert-transform-capacity", imageDigest: `sha256:${"9".repeat(64)}`, releaseSha, appliedFloor: 4,
      verifiedRunningMachines: 4, verifiedAt: new Date(now - 90_000).toISOString() },
    recommendedProductionFloor: 4,
  }, capacityKeys.privateKey);
}

test("production release requires and consumes trusted distributed capacity attestation", () => {
  assert.throws(
    () => validateReleaseEnvironment({
      ...validRelease,
      ALBERT_RELEASE_ENVIRONMENT: "production",
      ALBERT_TRANSFORM_CAPACITY_EVIDENCE: JSON.stringify({ releaseEligible: true }),
    }, healthyProject),
    /ALBERT_TRANSFORM_FLEET_CAPACITY_ATTESTATION_BASE64/u,
  );
  const envelope = productionCapacityEnvelope();
  const result = validateReleaseEnvironment({
    ...validRelease,
    ALBERT_RELEASE_ENVIRONMENT: "production",
    ALBERT_TRANSFORM_FLEET_CAPACITY_ATTESTATION_BASE64:
      Buffer.from(JSON.stringify(envelope)).toString("base64"),
  }, healthyProject);
  assert.equal(result.transformMachineFloor, 4);
  assert.match(result.capacityAttestationDigest, /^[a-f0-9]{64}$/u);

  const replayed = { ...validRelease, ALBERT_RELEASE_ENVIRONMENT: "production",
    GITHUB_RUN_ID: "987654321", ALBERT_TRANSFORM_FLEET_CAPACITY_ATTESTATION_BASE64:
      Buffer.from(JSON.stringify(envelope)).toString("base64") };
  assert.throws(() => validateReleaseEnvironment(replayed, healthyProject), /another workflow run/u);
  assert.throws(() => validateReleaseEnvironment({
    ...validRelease,
    ALBERT_RELEASE_ENVIRONMENT: "production",
    ALBERT_CAPACITY_ATTESTOR_BUILD_DIGEST: `sha256:${"1".repeat(64)}`,
    ALBERT_TRANSFORM_FLEET_CAPACITY_ATTESTATION_BASE64:
      Buffer.from(JSON.stringify(envelope)).toString("base64"),
  }, healthyProject), /pinned independent build/u);
});

test("release preflight rejects Tokyo, localhost, duplicate apps, and administrator credentials", () => {
  assert.throws(
    () => validateReleaseEnvironment(validRelease, { ...healthyProject, region: "ap-northeast-1" }),
    /not in Sydney/,
  );
  assert.throws(
    () => validateReleaseEnvironment({ ...validRelease, ALBERT_PUBLIC_ORIGIN: "http://localhost:3000" }, healthyProject),
    /must use HTTPS/,
  );
  assert.throws(
    () => validateReleaseEnvironment({ ...validRelease, FLY_SYNC_APP: validRelease.FLY_SEMANTIC_APP }, healthyProject),
    /different Fly app/,
  );
  assert.throws(
    () => validateReleaseEnvironment({
      ...validRelease,
      SUPABASE_STORAGE_S3_ENDPOINT: "https://otherprojectref00001.storage.supabase.co/storage/v1/s3",
    }, healthyProject),
    /selected project's direct Storage hostname/,
  );
  assert.throws(
    () => validateReleaseEnvironment({
      ...validRelease,
      CONTROL_PLANE_MIGRATION_URL: "postgresql://postgres:secret@control.example/postgres?sslmode=require",
    }, healthyProject),
    /albert_control_deployer/,
  );
  assert.throws(
    () => validateReleaseEnvironment({
      ...validRelease,
      ALBERT_SNAPSHOT_P95_MS: "600000",
    }, healthyProject),
    /above the reviewed maximum/,
  );
});

test("Fly secret inventory is exact per runtime and rejects undeclared privilege", async () => {
  const contract = JSON.parse(await readFile(
    new URL("../deploy/runtime-contract.json", import.meta.url),
    "utf8",
  ));
  const sync = contract.runtimes["sync-worker"];
  const validInventory = [
    ...sync.requiredSecretNames,
    ...sync.optionalSecretNames,
  ].map((Name) => ({ Name, Digest: "not-a-secret-value" }));
  assert.deepEqual(
    validateRuntimeSecretNames(contract, "sync-worker", validInventory),
    { runtimeName: "sync-worker", count: validInventory.length },
  );
  assert.throws(
    () => validateRuntimeSecretNames(contract, "sync-worker", validInventory.slice(1)),
    /missing required secret names/,
  );
  assert.throws(
    () => validateRuntimeSecretNames(contract, "sync-worker", [
      ...validInventory,
      { Name: "SUPABASE_SERVICE_ROLE_KEY" },
    ]),
    /prohibited secret names/,
  );
  assert.throws(
    () => validateRuntimeSecretNames(contract, "sync-worker", [
      ...validInventory,
      { Name: "UNDECLARED_SECRET" },
    ]),
    /undeclared secret names/,
  );
});
