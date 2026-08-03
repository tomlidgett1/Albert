import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DESIGN_TENANTS = 20_000;
const MINIMUM_MACHINES = 2;
const MAXIMUM_MACHINES = 40;
const MAXIMUM_SWEEP_MS_AT_TARGET_UTILIZATION = 2_520_000;
const MAXIMUM_ATTESTATION_AGE_MS = 2 * 60 * 60 * 1_000;
const MAXIMUM_POOL_ACQUIRE_P95_MS = 250;
const MAXIMUM_DATABASE_UTILIZATION = 0.7;
const MINIMUM_AUTOSCALER_STABLE_SECONDS = 300;
export const TRANSFORM_CAPACITY_CORPUS_CONTRACT_DIGEST =
  "82895eb48467068eabdb9b4c511e85242cedbc2584d0127ee700e791e4bdcf4a";

const PAYLOAD_KEYS = [
  "authority",
  "autoscaler",
  "candidate",
  "completedAt",
  "databases",
  "expiresAt",
  "fleet",
  "generatedAt",
  "kind",
  "nonce",
  "passed",
  "producer",
  "queue",
  "recommendedProductionFloor",
  "schemaVersion",
  "stagingCellId",
  "stagingDeployment",
  "stagingEnvironment",
  "startedAt",
  "workload",
];

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function capacityAttestationKeyId(keyInput) {
  const publicKey = keyInput?.type === "public" ? keyInput : createPublicKey(keyInput);
  assert.equal(publicKey.asymmetricKeyType, "ed25519", "Capacity attestation key must be Ed25519.");
  return `ed25519:${createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex")}`;
}

export function createCapacityNonce() {
  return randomBytes(32).toString("hex");
}

export function createTransformFleetCapacityAttestation(payloadInput, privateKeyInput) {
  const payload = validateTransformFleetCapacityPayload(payloadInput);
  const privateKey = privateKeyInput?.type === "private"
    ? privateKeyInput
    : createPrivateKey(privateKeyInput);
  assert.equal(privateKey.asymmetricKeyType, "ed25519", "Capacity attestation private key must be Ed25519.");
  const keyId = capacityAttestationKeyId(privateKey);
  const value = signBytes(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64");
  return Object.freeze({
    payload,
    signature: Object.freeze({ algorithm: "Ed25519", keyId, value }),
  });
}

export function verifyTransformFleetCapacityAttestation(envelopeInput, expected) {
  assertRecord(envelopeInput, "Capacity attestation envelope");
  exactKeys(envelopeInput, ["payload", "signature"], "Capacity attestation envelope");
  const payload = validateTransformFleetCapacityPayload(envelopeInput.payload);
  const signature = envelopeInput.signature;
  assertRecord(signature, "Capacity attestation signature");
  exactKeys(signature, ["algorithm", "keyId", "value"], "Capacity attestation signature");
  assert.equal(signature.algorithm, "Ed25519", "Capacity attestation signature algorithm is invalid.");
  assert.match(signature.value, /^[A-Za-z0-9+/]{86}==$/u, "Capacity attestation signature encoding is invalid.");

  const publicKey = expected.publicKey?.type === "public"
    ? expected.publicKey
    : createPublicKey(expected.publicKey);
  const expectedKeyId = capacityAttestationKeyId(publicKey);
  assert.equal(signature.keyId, expectedKeyId, "Capacity attestation signer key is not trusted.");
  assert.equal(
    verifyBytes(null, Buffer.from(canonicalJson(payload)), publicKey, Buffer.from(signature.value, "base64")),
    true,
    "Capacity attestation signature is invalid.",
  );

  assert.equal(payload.authority.sha, expected.authoritySha,
    "Capacity attestation does not match the release authority SHA.");
  assert.equal(payload.authority.ref, expected.authorityRef,
    "Capacity attestation does not match the release authority ref.");
  assert.equal(payload.authority.repository, expected.repository, "Capacity attestation repository is invalid.");
  assert.equal(payload.authority.runId, expected.workflowRunId, "Capacity attestation is bound to another workflow run.");
  assert.equal(payload.authority.runAttempt, expected.workflowRunAttempt, "Capacity attestation is bound to another workflow attempt.");
  assert.equal(payload.authority.workflowRef, expected.workflowRef, "Capacity attestation workflow ref is invalid.");
  assert.equal(payload.candidate.sha, expected.candidateSha,
    "Capacity attestation does not match the candidate SHA.");
  assert.equal(payload.candidate.transformImageDigest, expected.candidateTransformImageDigest,
    "Capacity attestation does not match the approved candidate image.");
  assert.equal(payload.candidate.releasePlanDigest, expected.releasePlanDigest,
    "Capacity attestation does not match the approved release plan.");
  if (expected.stagingCellId) {
    assert.equal(payload.stagingCellId, expected.stagingCellId, "Capacity attestation staging cell is invalid.");
  }
  if (expected.corpusFingerprint) {
    assert.equal(
      payload.workload.corpusFingerprint,
      expected.corpusFingerprint,
      "Capacity attestation corpus fingerprint is not the approved staging corpus.",
    );
  }
  assert.match(expected.producerToolRef ?? "",
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/u,
    "Expected capacity producer tool ref is not pinned.");
  assert.equal(payload.producer.toolRef, expected.producerToolRef,
    "Capacity attestation was not produced by the pinned independent tooling.");
  assert.match(expected.producerBuildDigest ?? "", /^sha256:[a-f0-9]{64}$/u,
    "Expected capacity producer build digest is not pinned.");
  assert.equal(payload.producer.buildDigest, expected.producerBuildDigest,
    "Capacity attestation was not produced by the pinned independent build.");
  const now = expected.now ?? new Date();
  const nowMs = now.getTime();
  const generatedAt = Date.parse(payload.generatedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  assert.ok(generatedAt <= nowMs + 5 * 60 * 1_000, "Capacity attestation was generated in the future.");
  assert.ok(nowMs <= expiresAt, "Capacity attestation has expired.");

  return Object.freeze({
    authoritySha: payload.authority.sha,
    authorityRef: payload.authority.ref,
    candidateSha: payload.candidate.sha,
    candidateTransformImageDigest: payload.candidate.transformImageDigest,
    releasePlanDigest: payload.candidate.releasePlanDigest,
    workflowRunId: payload.authority.runId,
    workflowRunAttempt: payload.authority.runAttempt,
    recommendedProductionFloor: payload.recommendedProductionFloor,
    nonce: payload.nonce,
    expiresAt: payload.expiresAt,
    envelopeDigest: createHash("sha256").update(canonicalJson(envelopeInput)).digest("hex"),
  });
}

export function validateTransformFleetCapacityPayload(input) {
  assertRecord(input, "Capacity attestation payload");
  exactKeys(input, PAYLOAD_KEYS, "Capacity attestation payload");
  assert.equal(input.schemaVersion, 2, "Capacity attestation schema is unsupported.");
  assert.equal(input.kind, "albert_transform_fleet_capacity", "Capacity attestation kind is invalid.");
  assert.equal(input.stagingEnvironment, "staging", "Capacity attestation must originate in staging.");
  assert.match(input.stagingCellId, /^[a-z0-9][a-z0-9-]{2,62}$/u, "Capacity staging cell id is invalid.");
  assert.match(input.nonce, /^[a-f0-9]{64}$/u, "Capacity attestation nonce is invalid.");
  assert.equal(input.passed, true, "Capacity attestation did not pass.");
  const startedAt = timestamp(input.startedAt, "startedAt");
  const completedAt = timestamp(input.completedAt, "completedAt");
  const generatedAt = timestamp(input.generatedAt, "generatedAt");
  const expiresAt = timestamp(input.expiresAt, "expiresAt");
  assert.ok(startedAt <= completedAt, "Capacity attestation completed before it started.");
  assert.ok(completedAt <= generatedAt, "Capacity attestation was generated before completion.");
  assert.ok(expiresAt > generatedAt, "Capacity attestation expiry is invalid.");
  assert.ok(expiresAt - generatedAt <= MAXIMUM_ATTESTATION_AGE_MS, "Capacity attestation expiry exceeds two hours.");

  validateAuthority(input.authority);
  validateCandidate(input.candidate);
  validateProducer(input.producer);
  validateWorkload(input.workload);
  validateFleet(input.fleet, input.workload, startedAt, completedAt);
  validateQueue(input.queue, input.fleet.requestedMachineFloor);
  validateDatabase("control", input.databases?.control);
  validateDatabase("analytical", input.databases?.analytical);
  validateAutoscaler(input.autoscaler, input.fleet.requestedMachineFloor, startedAt, completedAt);
  validateStagingDeployment(
    input.stagingDeployment,input.candidate,input.fleet.requestedMachineFloor,
    startedAt,generatedAt,
  );
  integer(input.recommendedProductionFloor, MINIMUM_MACHINES, MAXIMUM_MACHINES, "recommended production floor");
  assert.equal(
    input.recommendedProductionFloor,
    input.fleet.requestedMachineFloor,
    "Recommended production floor was not measured by the fleet run.",
  );
  return deepFreeze(structuredClone(input));
}

function validateProducer(value) {
  assertRecord(value, "Capacity independent producer");
  exactKeys(value, ["buildDigest", "toolRef"], "Capacity independent producer");
  assert.match(value.toolRef,
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/u,
    "Capacity producer tool ref is not immutable.");
  assert.match(value.buildDigest, /^sha256:[a-f0-9]{64}$/u,
    "Capacity producer build digest is invalid.");
}

function validateAuthority(value) {
  assertRecord(value, "Capacity release authority identity");
  exactKeys(value, ["job", "ref", "repository", "runAttempt", "runId", "sha", "workflowRef"],
    "Capacity release authority identity");
  assert.match(value.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
    "Capacity authority repository is invalid.");
  assert.match(value.sha, /^[a-f0-9]{40}$/u, "Capacity authority SHA is invalid.");
  assert.match(value.ref,
    /^refs\/tags\/albert-release-authority-v[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u,
    "Capacity authority ref is invalid.");
  assert.match(value.runId, /^[1-9][0-9]{0,19}$/u, "Capacity authority workflow run id is invalid.");
  integer(value.runAttempt, 1, 10_000, "Capacity authority workflow run attempt");
  assert.equal(value.job, "attest-transform-fleet-capacity", "Capacity authority workflow job is invalid.");
  assert.equal(
    value.workflowRef,
    `${value.repository}/.github/workflows/release-authority.yml@${value.ref}`,
    "Capacity authority workflow ref is invalid.",
  );
}

function validateCandidate(value) {
  assertRecord(value, "Capacity candidate identity");
  exactKeys(value, ["releasePlanDigest", "sha", "transformImageDigest"], "Capacity candidate identity");
  assert.match(value.sha, /^[a-f0-9]{40}$/u, "Capacity candidate SHA is invalid.");
  assert.match(value.transformImageDigest, /^sha256:[a-f0-9]{64}$/u,
    "Capacity candidate transform image digest is invalid.");
  assert.match(value.releasePlanDigest, /^[a-f0-9]{64}$/u,
    "Capacity candidate release plan digest is invalid.");
}

function validateWorkload(value) {
  assertRecord(value, "Capacity workload profile");
  exactKeys(value, [
    "canonicalRows", "completedTenants", "corpusContractDigest", "corpusFingerprint",
    "designTenants", "distinctTenants", "sourceRows", "strata",
  ], "Capacity workload profile");
  assert.equal(value.designTenants, DESIGN_TENANTS, "Capacity design tenant count drifted.");
  assert.equal(value.corpusContractDigest, TRANSFORM_CAPACITY_CORPUS_CONTRACT_DIGEST,
    "Capacity corpus contract digest is invalid.");
  assert.match(value.corpusFingerprint, /^[a-f0-9]{64}$/u, "Capacity corpus fingerprint is invalid.");
  integer(value.completedTenants, DESIGN_TENANTS, DESIGN_TENANTS, "Capacity completed tenants");
  assert.equal(value.distinctTenants, value.completedTenants, "Capacity run repeated a tenant.");
  validateQuantiles(value.sourceRows, "source rows");
  validateQuantiles(value.canonicalRows, "canonical rows");
  assert.ok(value.sourceRows.p50 > 0 && value.canonicalRows.p50 > 0, "Capacity workload cannot contain empty fixture tenants.");
  assert.ok(Array.isArray(value.strata) && value.strata.length === 3, "Capacity workload strata are invalid.");
  const expected = [
    { id: "micro", minRows: 1, maxRows: 999, minimumCount: 2_000 },
    { id: "small", minRows: 1_000, maxRows: 9_999, minimumCount: 10_000 },
    { id: "medium", minRows: 10_000, maxRows: null, minimumCount: 4_000 },
  ];
  let total = 0;
  for (let index = 0; index < expected.length; index += 1) {
    const observed = value.strata[index];
    const contract = expected[index];
    assertRecord(observed, `Capacity workload stratum ${index + 1}`);
    exactKeys(observed, ["count", "id", "maxRows", "minRows"], `Capacity workload stratum ${index + 1}`);
    assert.equal(observed.id, contract.id, "Capacity workload stratum order or id drifted.");
    assert.equal(observed.minRows, contract.minRows, "Capacity workload stratum lower bound drifted.");
    assert.equal(observed.maxRows, contract.maxRows, "Capacity workload stratum upper bound drifted.");
    integer(observed.count, contract.minimumCount, DESIGN_TENANTS, `Capacity ${contract.id} stratum count`);
    total += observed.count;
  }
  assert.equal(total, value.completedTenants, "Capacity workload strata do not cover the completed tenants exactly.");
}

function validateQuantiles(value, label) {
  assertRecord(value, `Capacity ${label}`);
  exactKeys(value, ["max", "p50", "p95"], `Capacity ${label}`);
  for (const key of ["p50", "p95", "max"]) finite(value[key], 0, Number.MAX_SAFE_INTEGER, `Capacity ${label} ${key}`);
  assert.ok(value.p50 <= value.p95 && value.p95 <= value.max, `Capacity ${label} quantiles are not monotonic.`);
}

function validateFleet(value, workload, startedAt, completedAt) {
  assertRecord(value, "Capacity fleet result");
  exactKeys(value, [
    "completedClaims", "errorCount", "maxRunningMachines", "minRunningMachines",
    "observedWorkerProcesses", "p95TenantMs", "p99TenantMs", "participantDigest",
    "requestedMachineFloor", "sweepDurationMs",
  ], "Capacity fleet result");
  integer(value.requestedMachineFloor, MINIMUM_MACHINES, MAXIMUM_MACHINES, "Capacity requested Machine floor");
  assert.equal(value.observedWorkerProcesses, value.requestedMachineFloor, "Capacity did not run the requested number of worker processes.");
  assert.equal(value.minRunningMachines, value.requestedMachineFloor, "Capacity Machine floor was not continuously applied.");
  integer(value.maxRunningMachines, value.requestedMachineFloor, MAXIMUM_MACHINES, "Capacity maximum running Machines");
  assert.equal(value.completedClaims, workload.completedTenants, "Capacity fleet completion count differs from the workload profile.");
  assert.equal(value.errorCount, 0, "Capacity fleet recorded errors.");
  finite(value.p95TenantMs, 0.001, Number.MAX_SAFE_INTEGER, "Capacity tenant p95");
  finite(value.p99TenantMs, value.p95TenantMs, Number.MAX_SAFE_INTEGER, "Capacity tenant p99");
  integer(value.sweepDurationMs, 1, MAXIMUM_SWEEP_MS_AT_TARGET_UTILIZATION, "Capacity sweep duration");
  assert.ok(Math.abs(value.sweepDurationMs - (completedAt - startedAt)) <= 5_000, "Capacity sweep duration does not match its signed timestamps.");
  assert.match(value.participantDigest, /^[a-f0-9]{64}$/u, "Capacity participant digest is invalid.");
}

function validateQueue(value, requestedFloor) {
  assertRecord(value, "Capacity queue observation");
  exactKeys(value, [
    "maintenanceDueAtEnd", "maintenanceDueAtStart", "maxActiveMaintenanceLeases",
    "oldestVisibleJobAgeSecondsAtEnd", "sampleCount", "transformJobQueueDepthAtEnd",
    "transformJobQueueDepthAtStart",
  ], "Capacity queue observation");
  assert.equal(value.maintenanceDueAtStart, DESIGN_TENANTS,
    "Capacity run did not begin with the full maintenance workload.");
  assert.equal(value.maintenanceDueAtEnd, 0, "Capacity run did not drain maintenance work.");
  integer(value.maxActiveMaintenanceLeases, requestedFloor,
    requestedFloor * 8, "Capacity maximum active maintenance leases");
  assert.equal(value.transformJobQueueDepthAtStart, 0,
    "Capacity cell was not quiescent before the maintenance run.");
  assert.equal(value.transformJobQueueDepthAtEnd, 0,
    "Capacity run left transform jobs queued.");
  assert.equal(value.oldestVisibleJobAgeSecondsAtEnd, 0,
    "Capacity run left an aged transform job visible.");
  integer(value.sampleCount, 20, 100_000, "Capacity queue sample count");
}

function validateDatabase(label, value) {
  assertRecord(value, `Capacity ${label} database observation`);
  exactKeys(value, ["deadlocksDelta", "maxConnections", "maxLockWaiters", "peakConnections", "peakUtilization", "poolAcquireP95Ms", "sampleCount"], `Capacity ${label} database observation`);
  integer(value.maxConnections, 1, 1_000_000, `Capacity ${label} max connections`);
  integer(value.peakConnections, 1, value.maxConnections, `Capacity ${label} peak connections`);
  finite(value.peakUtilization, 0, 1, `Capacity ${label} peak utilization`);
  assert.ok(value.peakUtilization <= MAXIMUM_DATABASE_UTILIZATION, `Capacity ${label} database exceeded 70% connection utilization.`);
  assert.ok(Math.abs(value.peakUtilization - value.peakConnections / value.maxConnections) <= 0.000_001, `Capacity ${label} connection utilization is inconsistent.`);
  finite(value.poolAcquireP95Ms, 0, MAXIMUM_POOL_ACQUIRE_P95_MS, `Capacity ${label} pool-acquire p95`);
  integer(value.maxLockWaiters, 0, 1, `Capacity ${label} lock waiters`);
  assert.equal(value.deadlocksDelta, 0, `Capacity ${label} database recorded deadlocks.`);
  integer(value.sampleCount, 20, 100_000, `Capacity ${label} observation samples`);
}

function validateAutoscaler(value, requestedFloor, startedAt, completedAt) {
  assertRecord(value, "Capacity autoscaler observation");
  exactKeys(value, [
    "appName", "errorCount", "maxDesiredMachines", "maxObservedMachines",
    "minDesiredMachines", "minObservedMachines", "reachedRequestedFloorAt",
    "sampleCount", "stableAtOrAboveFloorSeconds",
  ], "Capacity autoscaler observation");
  assert.match(value.appName, /^[a-z0-9][a-z0-9-]{1,62}$/u, "Capacity autoscaler app is invalid.");
  integer(value.minDesiredMachines, MINIMUM_MACHINES, requestedFloor, "Capacity autoscaler minimum desired Machines");
  integer(value.maxDesiredMachines, requestedFloor, MAXIMUM_MACHINES, "Capacity autoscaler maximum desired Machines");
  integer(value.minObservedMachines, 1, requestedFloor, "Capacity autoscaler minimum observed Machines");
  integer(value.maxObservedMachines, requestedFloor, MAXIMUM_MACHINES, "Capacity autoscaler maximum observed Machines");
  const reachedAt = timestamp(value.reachedRequestedFloorAt, "autoscaler reachedRequestedFloorAt");
  assert.ok(reachedAt <= startedAt, "Capacity autoscaler did not establish the floor before the measured sweep.");
  assert.ok(
    reachedAt + value.stableAtOrAboveFloorSeconds * 1_000 <= completedAt + 5_000,
    "Capacity autoscaler stable duration exceeds the observed run window.",
  );
  integer(value.stableAtOrAboveFloorSeconds, MINIMUM_AUTOSCALER_STABLE_SECONDS, 3_600, "Capacity autoscaler stable duration");
  integer(value.sampleCount, 20, 100_000, "Capacity autoscaler sample count");
  assert.equal(value.errorCount, 0, "Capacity autoscaler observation recorded errors.");
}

function validateStagingDeployment(value, candidate, requestedFloor, startedAt, generatedAt) {
  assertRecord(value, "Capacity staging deployment");
  exactKeys(value, ["appName", "appliedFloor", "imageDigest", "releaseSha", "verifiedAt", "verifiedRunningMachines"], "Capacity staging deployment");
  assert.match(value.appName, /^[a-z0-9][a-z0-9-]{1,62}$/u, "Capacity staging transform app is invalid.");
  assert.match(value.imageDigest, /^sha256:[a-f0-9]{64}$/u, "Capacity staging image digest is invalid.");
  assert.equal(value.releaseSha, candidate.sha, "Capacity staging deployment is not the candidate release.");
  assert.equal(value.imageDigest, candidate.transformImageDigest,
    "Capacity staging deployment is not the approved candidate image.");
  assert.equal(value.appliedFloor, requestedFloor, "Capacity staging floor differs from the measured floor.");
  assert.equal(value.verifiedRunningMachines, requestedFloor, "Capacity staging did not verify the exact requested Machine floor.");
  const verifiedAt = timestamp(value.verifiedAt, "staging deployment verifiedAt");
  assert.ok(
    verifiedAt >= startedAt - 60 * 60 * 1_000 && verifiedAt <= generatedAt,
    "Capacity staging deployment verification is outside the measured run.",
  );
}

function exactKeys(value, expected, label) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} shape is invalid.`);
}

function assertRecord(value, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
}

function integer(value, minimum, maximum, label) {
  assert.ok(Number.isInteger(value) && value >= minimum && value <= maximum, `${label} must be an integer between ${minimum} and ${maximum}.`);
}

function finite(value, minimum, maximum, label) {
  assert.ok(Number.isFinite(value) && value >= minimum && value <= maximum, `${label} must be between ${minimum} and ${maximum}.`);
}

function timestamp(value, label) {
  assert.equal(typeof value, "string", `Capacity ${label} must be an ISO timestamp.`);
  const parsed = Date.parse(value);
  assert.ok(Number.isFinite(parsed), `Capacity ${label} must be an ISO timestamp.`);
  return parsed;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function decodedKey(name) {
  const value = requiredEnvironment(name);
  return Buffer.from(value, "base64").toString("utf8");
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required.`);
  return value;
}

function immutableServicesImageDigest() {
  const value = process.env.ALBERT_RELEASE_SERVICES_IMAGE?.trim();
  const match = /^ghcr\.io\/[a-z0-9][a-z0-9._/-]{1,200}@(sha256:[a-f0-9]{64})$/u.exec(value ?? "");
  assert.ok(match, "ALBERT_RELEASE_SERVICES_IMAGE must be an immutable GHCR digest reference.");
  return match[1];
}

async function main() {
  const [action, inputPath] = process.argv.slice(2);
  assert.ok(inputPath, "Capacity attestation CLI requires an input path.");
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  if (action === "verify") {
    const authoritySha = requiredEnvironment("ALBERT_RELEASE_AUTHORITY_TOOLING_SHA");
    const authorityRef = requiredEnvironment("GITHUB_REF");
    const workflowRef = requiredEnvironment("ALBERT_RELEASE_AUTHORITY_WORKFLOW_REF");
    assert.equal(authoritySha, requiredEnvironment("GITHUB_SHA"),
      "Release authority SHA differs from the executing workflow.");
    assert.equal(workflowRef, requiredEnvironment("GITHUB_WORKFLOW_REF"),
      "Release authority workflow ref differs from the executing workflow.");
    const result = verifyTransformFleetCapacityAttestation(input, {
      publicKey: decodedKey("ALBERT_CAPACITY_ED25519_PUBLIC_KEY_BASE64"),
      authoritySha,
      authorityRef,
      candidateSha: requiredEnvironment("ALBERT_RELEASE_COMMIT_SHA"),
      candidateTransformImageDigest: immutableServicesImageDigest(),
      releasePlanDigest: requiredEnvironment("ALBERT_RELEASE_PLAN_DIGEST"),
      repository: requiredEnvironment("GITHUB_REPOSITORY"),
      workflowRunId: requiredEnvironment("GITHUB_RUN_ID"),
      workflowRunAttempt: Number(requiredEnvironment("GITHUB_RUN_ATTEMPT")),
      workflowRef,
      stagingCellId: requiredEnvironment("ALBERT_CAPACITY_STAGING_CELL_ID"),
      corpusFingerprint: requiredEnvironment("ALBERT_CAPACITY_CORPUS_FINGERPRINT"),
      producerToolRef: requiredEnvironment("ALBERT_CAPACITY_ATTESTOR_TOOL_REF"),
      producerBuildDigest: requiredEnvironment("ALBERT_CAPACITY_ATTESTOR_BUILD_DIGEST"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, [
        `transform_machine_floor=${result.recommendedProductionFloor}`,
        `capacity_attestation_digest=${result.envelopeDigest}`,
        `capacity_attestation_nonce=${result.nonce}`,
        "",
      ].join("\n"));
    }
    return;
  }
  assert.fail("Capacity attestation CLI action must be verify; only the protected collector can sign measurements.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`transform fleet capacity attestation failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
