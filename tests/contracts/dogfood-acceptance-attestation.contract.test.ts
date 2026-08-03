import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  hmacReference,
  signDogfoodAcceptance,
  verifyDogfoodAcceptance,
} from "../../scripts/dogfood-acceptance-attestation.mjs";
import {
  validatePrivateFlyEvidence,
  validateRuntimePlan,
} from "../../scripts/collect-dogfood-acceptance.mjs";

const candidateSha = "a".repeat(40);
const digest = (character: string) => character.repeat(64);
const repository = "tomlidgett1/Albert";
const workflowRef = "refs/tags/dogfood-attestor-v1";
const toolingSha = "b".repeat(40);
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateKeyBase64Url = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
const publicKeyBase64Url = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const zeroResiduals = {
  rawObjects: 0, stagingRows: 0, canonicalRows: 0, bridgeRows: 0,
  linkRows: 0, embeddingRows: 0, cacheRows: 0, otherAnalyticalRows: 0,
  controlRows: 0, derivedArtifacts: 0, queueMessages: 0,
  credentialReferences: 0, credentialEnvelopes: 0, sessionEnvelopes: 0,
};

function proof(seed: string) {
  return {
    subjectRef: digest(seed),
    proofDigest: digest(seed),
    completedAt: "2026-08-03T00:20:00.000Z",
    providerGenerationsDigest: digest(seed),
    remoteRevocationVerified: true as const,
    storesVerified: true as const,
    residuals: zeroResiduals,
  };
}

function validBody() {
  return {
    schemaVersion: 1,
    kind: "albert.protected-dogfood-acceptance",
    attestationId: "01K2ZZZZZZ0000000000000001",
    candidateSha,
    sourceEnvironment: "staging",
    targetEnvironment: "production",
    repository,
    workflow: {
      file: "dogfood-acceptance.yml",
      runId: "123456789",
      runAttempt: 1,
      actorId: "42",
      ref: workflowRef,
      toolingSha,
    },
    issuedAt: "2026-08-03T00:30:00.000Z",
    expiresAt: "2026-08-03T02:30:00.000Z",
    nonceDigest: digest("1"),
    controlSnapshotDigest: digest("2"),
    subjects: {
      dogfoodTenantRef: digest("3"),
      onboardingTenantRef: digest("4"),
      deletionTenantRef: digest("5"),
    },
    runtimes: {
      checkedCount: 7,
      requiredServices: [
        "deletion-worker", "operator-diagnostic", "semantic-query", "sync-worker",
        "transform-worker", "web", "webhook-gateway",
      ] as const,
      deploymentId: "staging-20260803-001",
      barrierAt: "2026-08-03T00:00:00.000Z",
      identityDigest: digest("6"),
    },
    connectionGenerations: [
      { connector: "deputy", connectionRef: digest("7"), generation: 1 },
      { connector: "lightspeed-r", connectionRef: digest("8"), generation: 2 },
      { connector: "xero", connectionRef: digest("9"), generation: 3 },
    ],
    milestones: {
      m3: {
        passed: true, streamCount: 30, liveRecordedStreams: 30,
        backfillCompleteStreams: 30, reconciledStreams: 30,
        qualityCheckCount: 14, evidenceDigest: digest("a"),
      },
      m4: {
        passed: true, invariantCount: 14, identitySuggestionCount: 1,
        xeroPostingBridgeVerified: true, evidenceDigest: digest("b"),
      },
      m5: {
        passed: true, planDigest: digest("c"), evidenceDigest: digest("d"),
        cases: [
          { caseId: "numeric_golden", kind: "golden", answerState: "verified", rowCount: 1, resultDigest: digest("e"), bundleHash: digest("f") },
          { caseId: "cross_source", kind: "composite", answerState: "qualified", rowCount: 2, resultDigest: digest("0"), bundleHash: digest("1") },
        ],
      },
      m6: {
        passed: true,
        flagship: {
          artifactDigest: digest("2"), traceDigest: digest("3"), answerState: "verified",
          queryCount: 2, provenanceComplete: true, sequentialNarrative: true,
        },
        category: {
          artifactDigest: digest("4"), traceDigest: digest("5"), answerState: "qualified",
          queryCount: 1, provenanceComplete: true, sequentialNarrative: true, chartPresent: true,
        },
        evidenceDigest: digest("6"),
      },
      m7: {
        passed: true, onboardingMinutes: 18.5, targetMinutes: 30,
        readyPartialDomainCount: 7, blockingAnswerCount: 4,
        overlayDigest: digest("7"), evidenceDigest: digest("8"),
      },
      m8: {
        passed: true,
        disconnect: { ...proof("9"), provider: "xero", connectionGeneration: 4 },
        tenantDeletion: proof("a"),
        evidenceDigest: digest("b"),
      },
    },
    evidenceDigest: digest("c"),
  };
}

const expected = {
  candidateSha,
  repository,
  targetEnvironment: "production",
  expectedWorkflowRef: workflowRef,
  expectedToolingSha: toolingSha,
  encodedPublicKey: publicKeyBase64Url,
  now: Date.parse("2026-08-03T00:40:00.000Z"),
};

test("Ed25519 dogfood evidence binds live milestones to the candidate and protected ref", () => {
  const envelope = signDogfoodAcceptance(validBody(), privateKeyBase64Url);
  const result = verifyDogfoodAcceptance(envelope, expected);
  assert.equal(result.candidateSha, candidateSha);
  assert.equal(result.attestationId, "01K2ZZZZZZ0000000000000001");
  assert.equal(result.controlSnapshotDigest, digest("2"));
});

test("tampering, wrong ref, expiry, and incomplete milestones fail closed", () => {
  const envelope = signDogfoodAcceptance(validBody(), privateKeyBase64Url);
  const tampered = structuredClone(envelope);
  tampered.attestation.milestones.m7.onboardingMinutes = 1;
  assert.throws(() => verifyDogfoodAcceptance(tampered, expected), /digest is inconsistent|signature is invalid/u);
  assert.throws(() => verifyDogfoodAcceptance(envelope, { ...expected, expectedWorkflowRef: "refs/heads/release" }), /protected workflow ref/u);
  assert.throws(() => verifyDogfoodAcceptance(envelope, { ...expected, expectedToolingSha: "c".repeat(40) }), /trusted tooling commit/u);
  assert.throws(() => verifyDogfoodAcceptance(envelope, { ...expected, now: Date.parse("2026-08-03T02:31:00.000Z") }), /expired/u);

  const incomplete = validBody();
  incomplete.milestones.m3.reconciledStreams = 29;
  assert.throws(() => signDogfoodAcceptance(incomplete, privateKeyBase64Url), /Every planned stream/u);

  const partialFleet = validBody();
  partialFleet.runtimes.checkedCount = 6 as 7;
  assert.throws(() => signDogfoodAcceptance(partialFleet, privateKeyBase64Url));
});

test("subject pseudonyms are keyed and domain separated", () => {
  const key = Buffer.alloc(32, 7).toString("base64url");
  assert.notEqual(hmacReference(key, "tenant", "same"), hmacReference(key, "connection", "same"));
  assert.doesNotMatch(hmacReference(key, "tenant", "customer-id"), /customer/u);
});

test("private worker evidence uses Fly control-plane checks without public ingress", () => {
  const plan = validateRuntimePlan([
    { name: "web", url: "https://web.example" },
    { name: "sync-worker", url: "https://sync.example" },
    { name: "transform-worker", flyApp: "albert-transform-staging" },
    { name: "webhook-gateway", url: "https://webhooks.example" },
    { name: "semantic-query", url: "https://semantic.example" },
    { name: "operator-diagnostic", url: "https://diagnostic.example" },
    { name: "deletion-worker", flyApp: "albert-deletion-staging" },
  ]);
  assert.equal(plan.find(({ name }) => name === "transform-worker")?.mode, "fly-private");
  assert.throws(() => validateRuntimePlan(plan.map((item) => (
    item.name === "transform-worker" ? { name: item.name, url: "https://private.example" } :
      item.mode === "https" ? { name: item.name, url: item.url } : { name: item.name, flyApp: item.flyApp }
  ))));
  assert.throws(() => validateRuntimePlan([
    { name: "web", url: "https://web.example" },
    { name: "sync-worker", url: "https://sync.example" },
    { name: "transform-worker", flyApp: "same-private-app" },
    { name: "webhook-gateway", url: "https://webhooks.example" },
    { name: "semantic-query", url: "https://semantic.example" },
    { name: "operator-diagnostic", url: "https://diagnostic.example" },
    { name: "deletion-worker", flyApp: "same-private-app" },
  ]), /distinct Fly app/u);

  const machine = (id: string, runtimeIdentity = "transform-worker") => ({
    id,
    state: "started",
    region: "syd",
    instance_id: `instance-${id}`,
    image_ref: { digest: digest("a") },
    config: {
      env: {
        ALBERT_SERVICE_VERSION: candidateSha,
        ALBERT_DEPLOYMENT_ID: "staging-release-1",
        ALBERT_TRANSFORM_WORKER_ID: runtimeIdentity,
      },
      checks: { readiness: { type: "http", path: "/readyz" } },
    },
  });
  const machines = [machine("abcdef01234567"), machine("0123456789abcd")];
  const checks = Object.fromEntries(machines.map(({ id }) => [id, [
    { name: "readiness", status: "passing", updated_at: "2026-08-03T00:00:00Z" },
  ]]));
  const result = validatePrivateFlyEvidence(
    { machines, checks, ips: [] },
    { name: "transform-worker", mode: "fly-private", flyApp: "albert-transform-staging" },
    { candidateSha, deploymentId: "staging-release-1" },
  );
  assert.equal(result.machineCount, 2);
  assert.throws(() => validatePrivateFlyEvidence(
    { machines, checks, ips: [{ type: "v6" }] },
    { name: "transform-worker", mode: "fly-private", flyApp: "albert-transform-staging" },
    { candidateSha, deploymentId: "staging-release-1" },
  ), /public IP/u);
  assert.throws(() => validatePrivateFlyEvidence(
    { machines: [machine("abcdef01234567", "deletion-worker"), machines[1]], checks, ips: [] },
    { name: "transform-worker", mode: "fly-private", flyApp: "albert-transform-staging" },
    { candidateSha, deploymentId: "staging-release-1" },
  ), /expected transform-worker process identity/u);
});

test("the database snapshot is immutable and production consumption is one-use", async () => {
  const migration = await readFile(new URL(
    "../../infra/migrations/control-plane/0054_m3_m8_protected_dogfood_acceptance.sql",
    import.meta.url,
  ), "utf8");
  assert.match(migration, /protected_dogfood_acceptance_snapshots/u);
  assert.match(migration, /protected_dogfood_acceptance_consumptions[\s\S]*snapshot_id text PRIMARY KEY/u);
  assert.match(migration, /snapshot was already consumed/u);
  assert.match(migration, /snapshot\.captured_at<=clock_timestamp\(\)-interval '6 hours'/u);
  assert.match(migration, /assert_operator_diagnostic_control_ready/u);
  assert.match(migration, /protected_dogfood_deployment_barrier/u);
  assert.match(migration, /protected_dogfood_runtime_observations/u);
  assert.match(migration, /WHEN 'albert_sync_control_runtime' THEN 'sync-worker'/u);
  assert.match(migration, /WHEN 'albert_transform_control_runtime' THEN 'transform-worker'/u);
  assert.match(migration, /WHEN 'albert_deletion_control_runtime' THEN 'deletion-worker'/u);
  assert.match(migration, /clock_timestamp\(\)[\s\S]*ON CONFLICT ON CONSTRAINT protected_dogfood_runtime_observations_pkey DO NOTHING/u);
  assert.match(migration, /manifest\.created_at>=barrier_at/u);
  assert.match(migration, /artifact\.finalized_at<p_barrier_at/u);
  assert.match(migration, /onboarding_created<barrier_at/u);
  assert.match(migration, /ready_connection_count<>3/u);
  assert.match(migration, /protected_dogfood_semantic_turn_leases/u);
  assert.match(migration, /issue_protected_dogfood_semantic_turn/u);
  assert.match(migration, /turn_record\.status='running'/u);
  assert.doesNotMatch(migration, /GRANT SELECT ON (?:TABLE )?control_plane\.protected_dogfood/iu);

  const workflow = await readFile(new URL(
    "../../.github/workflows/dogfood-acceptance.yml",
    import.meta.url,
  ), "utf8");
  assert.doesNotMatch(workflow, /name: Collect live M3-M8 acceptance evidence\s+if:/u);
  assert.match(workflow, /test "\$GITHUB_SHA" = "\$TRUSTED_TOOLING_SHA"/u);
  assert.match(workflow, /case "\$GITHUB_REF" in refs\/tags\/\*/u);
  assert.match(workflow, /ALBERT_DOGFOOD_DEPLOYMENT_ID/u);

  const collector = await readFile(new URL(
    "../../scripts/collect-dogfood-acceptance.mjs",
    import.meta.url,
  ), "utf8");
  assert.match(collector, /Every public runtime probe must use a distinct service origin/u);
  assert.match(collector, /body\.runtime, probe\.name/u);
  assert.match(collector, /Semantic cases must execute against the probed candidate semantic runtime/u);
  assert.match(collector, /flyctl[\s\S]*machines[\s\S]*checks[\s\S]*ips/u);
});
