import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  createTransformFleetCapacityAttestation,
  verifyTransformFleetCapacityAttestation,
} from "../../scripts/transform-fleet-capacity-attestation.mjs";

const candidateSha = "a".repeat(40);
const repository = "tomlidgett1/Albert";
const workflowRunId = "123456789";
const workflowRunAttempt = 2;
const workflowRef = `${repository}/.github/workflows/release.yml@refs/heads/main`;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

export function validCapacityPayload() {
  return {
    schemaVersion: 1,
    kind: "albert_transform_fleet_capacity",
    stagingEnvironment: "staging",
    stagingCellId: "sydney-capacity-01",
    candidateSha,
    nonce: "b".repeat(64),
    startedAt: "2026-08-03T00:10:00.000Z",
    completedAt: "2026-08-03T00:30:00.000Z",
    generatedAt: "2026-08-03T00:31:00.000Z",
    expiresAt: "2026-08-03T02:30:00.000Z",
    passed: true,
    producer: {
      toolRef: `tomlidgett1/albert-release-trust@${"d".repeat(40)}`,
      buildDigest: `sha256:${"e".repeat(64)}`,
    },
    workflow: {
      repository,
      runId: workflowRunId,
      runAttempt: workflowRunAttempt,
      job: "attest-transform-fleet-capacity",
      workflowRef,
    },
    workload: {
      designTenants: 20_000,
      completedTenants: 20_000,
      distinctTenants: 20_000,
      corpusContractDigest: "82895eb48467068eabdb9b4c511e85242cedbc2584d0127ee700e791e4bdcf4a",
      corpusFingerprint: "f".repeat(64),
      sourceRows: { p50: 4_000, p95: 20_000, max: 80_000 },
      canonicalRows: { p50: 2_000, p95: 10_000, max: 40_000 },
      strata: [
        { id: "micro", minRows: 1, maxRows: 999, count: 2_000 },
        { id: "small", minRows: 1_000, maxRows: 9_999, count: 14_000 },
        { id: "medium", minRows: 10_000, maxRows: null, count: 4_000 },
      ],
    },
    fleet: {
      requestedMachineFloor: 4,
      observedWorkerProcesses: 4,
      minRunningMachines: 4,
      maxRunningMachines: 4,
      completedClaims: 20_000,
      errorCount: 0,
      p95TenantMs: 120,
      p99TenantMs: 180,
      sweepDurationMs: 1_200_000,
      participantDigest: "c".repeat(64),
    },
    queue: {
      maintenanceDueAtStart: 20_000,
      maintenanceDueAtEnd: 0,
      maxActiveMaintenanceLeases: 32,
      transformJobQueueDepthAtStart: 0,
      transformJobQueueDepthAtEnd: 0,
      oldestVisibleJobAgeSecondsAtEnd: 0,
      sampleCount: 120,
    },
    databases: {
      control: {
        maxConnections: 100,
        peakConnections: 50,
        peakUtilization: 0.5,
        poolAcquireP95Ms: 20,
        maxLockWaiters: 0,
        deadlocksDelta: 0,
        sampleCount: 120,
      },
      analytical: {
        maxConnections: 200,
        peakConnections: 100,
        peakUtilization: 0.5,
        poolAcquireP95Ms: 30,
        maxLockWaiters: 1,
        deadlocksDelta: 0,
        sampleCount: 120,
      },
    },
    autoscaler: {
      appName: "albert-transform-capacity-autoscaler",
      minDesiredMachines: 4,
      maxDesiredMachines: 4,
      minObservedMachines: 1,
      maxObservedMachines: 4,
      reachedRequestedFloorAt: "2026-08-03T00:00:00.000Z",
      stableAtOrAboveFloorSeconds: 1_800,
      sampleCount: 180,
      errorCount: 0,
    },
    stagingDeployment: {
      appName: "albert-transform-capacity",
      imageDigest: `sha256:${"9".repeat(64)}`,
      releaseSha: candidateSha,
      appliedFloor: 4,
      verifiedRunningMachines: 4,
      verifiedAt: "2026-08-03T00:30:30.000Z",
    },
    recommendedProductionFloor: 4,
  };
}

function expected(overrides = {}) {
  return {
    publicKey,
    candidateSha,
    repository,
    workflowRunId,
    workflowRunAttempt,
    workflowRef,
    stagingCellId: "sydney-capacity-01",
    corpusFingerprint: "f".repeat(64),
    producerToolRef: `tomlidgett1/albert-release-trust@${"d".repeat(40)}`,
    producerBuildDigest: `sha256:${"e".repeat(64)}`,
    now: new Date("2026-08-03T00:40:00.000Z"),
    ...overrides,
  };
}

test("a protected Ed25519 envelope binds a passing fleet run to the exact promotion", () => {
  const envelope = createTransformFleetCapacityAttestation(validCapacityPayload(), privateKey);
  const result = verifyTransformFleetCapacityAttestation(envelope, expected());
  assert.equal(result.candidateSha, candidateSha);
  assert.equal(result.recommendedProductionFloor, 4);
  assert.equal(result.workflowRunId, workflowRunId);
  assert.match(result.envelopeDigest, /^[a-f0-9]{64}$/u);
});

test("tampering, cross-run replay, expiry, and an unmeasured floor fail closed", () => {
  const envelope = createTransformFleetCapacityAttestation(validCapacityPayload(), privateKey);
  const tampered = structuredClone(envelope);
  tampered.payload.fleet.p95TenantMs = 1;
  assert.throws(() => verifyTransformFleetCapacityAttestation(tampered, expected()), /signature is invalid/u);
  assert.throws(() => verifyTransformFleetCapacityAttestation(envelope, expected({ workflowRunId: "987654321" })),
    /another workflow run/u);
  assert.throws(() => verifyTransformFleetCapacityAttestation(envelope,
    expected({ now: new Date("2026-08-03T02:31:00.000Z") })), /expired/u);
  assert.throws(() => verifyTransformFleetCapacityAttestation(envelope,
    expected({ producerToolRef: `tomlidgett1/albert-release-trust@${"1".repeat(40)}` })),
  /pinned independent tooling/u);
  assert.throws(() => verifyTransformFleetCapacityAttestation(envelope,
    expected({ producerBuildDigest: `sha256:${"1".repeat(64)}` })),
  /pinned independent build/u);
  assert.throws(() => verifyTransformFleetCapacityAttestation(envelope,
    expected({ corpusFingerprint: "1".repeat(64) })), /approved staging corpus/u);
  const wrongFloor = validCapacityPayload();
  wrongFloor.recommendedProductionFloor = 5;
  assert.throws(() => createTransformFleetCapacityAttestation(wrongFloor, privateKey), /was not measured/u);
});

test("representativeness, shared database pressure, and autoscaler failures are signed gates", () => {
  const thin = validCapacityPayload();
  thin.workload.strata[2].count = 3_999;
  thin.workload.strata[1].count = 14_001;
  assert.throws(() => createTransformFleetCapacityAttestation(thin, privateKey), /medium stratum count/u);

  const saturated = validCapacityPayload();
  saturated.databases.control.peakConnections = 71;
  saturated.databases.control.peakUtilization = 0.71;
  assert.throws(() => createTransformFleetCapacityAttestation(saturated, privateKey), /exceeded 70%/u);

  const scalerFailure = validCapacityPayload();
  scalerFailure.autoscaler.errorCount = 1;
  assert.throws(() => createTransformFleetCapacityAttestation(scalerFailure, privateKey), /recorded errors/u);
});
