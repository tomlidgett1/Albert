import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createHmac, createPrivateKey, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import {
  DOGFOOD_REQUIRED_RUNTIMES,
  computeDogfoodM5EvidenceDigest,
  dogfoodAcceptanceKeyId,
  hmacReference,
  sha256,
  signDogfoodAcceptance,
} from "./dogfood-acceptance-attestation.mjs";
import { collectFlyPlatformProvenance } from "./collect-fly-platform-provenance.mjs";
import { verifyDogfoodReferencePlan } from "./dogfood-reference-plan.mjs";
import { platformSha256, verifySitesPlatformProvenance } from "./platform-provenance.mjs";
import {
  dogfoodSemanticCollectionAnchor,
  validateDogfoodSemanticPlanAtCollectionAnchor,
} from "../evals/golden/dogfood-semantic-suite.mjs";

const { Client } = pg;
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const CONNECTORS = ["deputy", "lightspeed-r", "xero"];
const DEPLOYMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const FLY_APP = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const PRIVATE_FLY_RUNTIMES = new Set(["deletion-worker", "transform-worker"]);
const PRIVATE_FLY_RUNTIME_IDENTITY = Object.freeze({
  "deletion-worker": ["ALBERT_DELETION_WORKER_ID", "deletion-worker"],
  "transform-worker": ["ALBERT_TRANSFORM_WORKER_ID", "transform-worker"],
});
const execFileAsync = promisify(execFile);
const SITES_PROJECT_ID = JSON.parse(readFileSync(new URL("../.openai/hosting.json", import.meta.url), "utf8")).project_id;

function required(source, name) {
  const value = source[name]?.trim();
  assert.ok(value, `${name} is required.`);
  return value;
}

function jsonEnvironment(source, name) {
  const raw = required(source, name);
  try { return JSON.parse(raw); } catch { assert.fail(`${name} must be valid JSON.`); }
}

function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} shape is invalid.`);
}

function configuration(source) {
  const candidateSha = required(source, "ALBERT_DOGFOOD_CANDIDATE_SHA");
  assert.match(candidateSha, SHA, "Candidate SHA must be a full commit SHA.");
  const protectedRef = required(source, "ALBERT_DOGFOOD_ACCEPTANCE_WORKFLOW_REF");
  assert.equal(required(source, "GITHUB_REF"), protectedRef, "Collector is not running from the protected tooling ref.");
  assert.match(protectedRef, /^refs\/tags\//u, "Protected collector ref must be an immutable tag.");
  const trustedToolingSha = required(source, "ALBERT_DOGFOOD_TRUSTED_TOOLING_SHA");
  assert.match(trustedToolingSha, SHA, "Trusted tooling SHA must be a full commit SHA.");
  assert.equal(required(source, "GITHUB_SHA"), trustedToolingSha, "Secret-bearing workflow is not the trusted tooling commit.");
  const runAttempt = Number(required(source, "GITHUB_RUN_ATTEMPT"));
  assert.ok(Number.isSafeInteger(runAttempt) && runAttempt >= 1 && runAttempt <= 10_000, "Workflow run attempt is invalid.");
  const privateKey = required(source, "ALBERT_DOGFOOD_ACCEPTANCE_ED25519_PRIVATE_KEY_BASE64URL");
  const acceptancePrivateKey = createPrivateKey({
    key: Buffer.from(privateKey, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  assert.equal(acceptancePrivateKey.asymmetricKeyType, "ed25519",
    "Dogfood acceptance private key must be Ed25519.");
  const referencePlan = verifyDogfoodReferencePlan(
    jsonEnvironment(source, "ALBERT_DOGFOOD_REFERENCE_PLAN_ENVELOPE_JSON"),
    {
      encodedPublicKey: required(source, "ALBERT_DOGFOOD_REFERENCE_PLAN_ED25519_PUBLIC_KEY_BASE64URL"),
      candidateSha,
      forbiddenDogfoodSignerKeyId: dogfoodAcceptanceKeyId(acceptancePrivateKey),
    },
  );
  assert.match(SITES_PROJECT_ID ?? "", /^appgprj_[a-f0-9]{32}$/u,
    ".openai/hosting.json does not contain the exact Sites project id.");
  const sitesManifest = verifySitesPlatformProvenance(
    jsonEnvironment(source, "ALBERT_DOGFOOD_SITES_PROVENANCE_ENVELOPE_JSON"),
    {
      encodedPublicKey: required(source, "ALBERT_DOGFOOD_SITES_PROVENANCE_ED25519_PUBLIC_KEY_BASE64URL"),
      projectId: SITES_PROJECT_ID,
      candidateSha,
    },
  );
  const semanticPlan = referencePlan.semanticPlan;
  const semanticCollectionAnchor = dogfoodSemanticCollectionAnchor(new Date());
  validateDogfoodSemanticPlanAtCollectionAnchor(semanticPlan, semanticCollectionAnchor);
  return Object.freeze({
    candidateSha,
    protectedRef,
    trustedToolingSha,
    repository: required(source, "GITHUB_REPOSITORY"),
    runId: required(source, "GITHUB_RUN_ID"),
    runAttempt,
    actorId: required(source, "GITHUB_ACTOR_ID"),
    databaseUrl: required(source, "ALBERT_DOGFOOD_CONTROL_DATABASE_URL"),
    tenantId: required(source, "ALBERT_DOGFOOD_TENANT_ID"),
    connections: Object.freeze({
      "lightspeed-r": required(source, "ALBERT_DOGFOOD_LIGHTSPEED_CONNECTION_ID"),
      xero: required(source, "ALBERT_DOGFOOD_XERO_CONNECTION_ID"),
      deputy: required(source, "ALBERT_DOGFOOD_DEPUTY_CONNECTION_ID"),
    }),
    onboardingTenantId: required(source, "ALBERT_DOGFOOD_ONBOARDING_TENANT_ID"),
    onboardingJourneyId: required(source, "ALBERT_DOGFOOD_ONBOARDING_JOURNEY_ID"),
    onboardingTargetMinutes: Number(required(source, "ALBERT_DOGFOOD_ONBOARDING_TARGET_MINUTES")),
    flagshipArtifactId: required(source, "ALBERT_DOGFOOD_FLAGSHIP_ARTIFACT_ID"),
    categoryArtifactId: required(source, "ALBERT_DOGFOOD_CATEGORY_ARTIFACT_ID"),
    categoryTopic: required(source, "ALBERT_DOGFOOD_CATEGORY_TOPIC"),
    disconnectProofId: required(source, "ALBERT_DOGFOOD_DISCONNECT_PROOF_ID"),
    tenantDeletionProofId: required(source, "ALBERT_DOGFOOD_TENANT_DELETION_PROOF_ID"),
    semanticSigningSecret: required(source, "ALBERT_DOGFOOD_SEMANTIC_SIGNING_SECRET"),
    semanticPlan,
    referencePlan,
    sitesManifest,
    semanticCollectionAnchor,
    flyReadonlyToken: required(source, "ALBERT_DOGFOOD_FLY_READONLY_TOKEN"),
    referenceKey: required(source, "ALBERT_DOGFOOD_REFERENCE_HMAC_KEY_BASE64URL"),
    privateKey,
  });
}

export function validateRuntimePlan(input) {
  assert.ok(Array.isArray(input), "Runtime probe plan must be an array.");
  const names = new Set();
  const plan = input.map((item) => {
    assert.ok(item && typeof item === "object" && !Array.isArray(item), "Runtime probe must be an object.");
    assert.match(item.name, /^[a-z][a-z0-9-]{1,63}$/u, "Runtime probe name is invalid.");
    assert.ok(!names.has(item.name), "Runtime probe names must be unique.");
    names.add(item.name);
    if (PRIVATE_FLY_RUNTIMES.has(item.name)) {
      exactKeys(item, ["flyApp", "name"], "Private Fly runtime probe");
      assert.match(item.flyApp, FLY_APP, "Private Fly app name is invalid.");
      return Object.freeze({ name: item.name, mode: "fly-private", flyApp: item.flyApp });
    }
    exactKeys(item, ["name", "url"], "HTTPS runtime probe");
    const url = new URL(item.url);
    assert.equal(url.protocol, "https:", "Protected runtime probes must use HTTPS.");
    assert.equal(url.username, "", "Runtime probe URL must not contain credentials.");
    assert.equal(url.password, "", "Runtime probe URL must not contain credentials.");
    url.pathname = item.name === "web" ? "/api/health" : "/readyz";
    url.search = ""; url.hash = "";
    return Object.freeze({ name: item.name, mode: "https", url: url.toString() });
  });
  assert.deepEqual([...names].sort(), DOGFOOD_REQUIRED_RUNTIMES, "Runtime probe plan must contain the exact production runtime set.");
  const publicProbes = plan.filter(({ mode }) => mode === "https");
  const privateProbes = plan.filter(({ mode }) => mode === "fly-private");
  assert.equal(
    publicProbes.length,
    DOGFOOD_REQUIRED_RUNTIMES.length - PRIVATE_FLY_RUNTIMES.size,
    "Only the declared public runtimes may use HTTPS probes.",
  );
  assert.equal(
    new Set(privateProbes.map(({ flyApp }) => flyApp)).size,
    privateProbes.length,
    "Each private runtime probe must use a distinct Fly app.",
  );
  assert.equal(
    new Set(publicProbes.map(({ url }) => new URL(url).origin)).size,
    publicProbes.length,
    "Every public runtime probe must use a distinct service origin.",
  );
  return Object.freeze(plan.sort((left, right) => left.name.localeCompare(right.name)));
}

async function captureControlEvidence(config) {
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE albert_operator_diagnostic_control");
    const result = await client.query(
      `select control_plane.capture_protected_dogfood_acceptance(
        $1::text,$2::text,$3::text,$4::jsonb,$5::text,$6::integer,
        $7::text,$8::text,$9::text,$10::text,$11::text,$12::text
      ) as snapshot`,
      [
        config.candidateSha,config.deploymentId,config.tenantId,JSON.stringify(config.connections),
        config.onboardingTenantId,config.onboardingTargetMinutes,
        config.flagshipArtifactId,config.categoryArtifactId,config.categoryTopic,
        config.disconnectProofId,config.tenantDeletionProofId,
        config.onboardingJourneyId,
      ],
    );
    const snapshot = validateControlSnapshot(result.rows[0]?.snapshot, config.candidateSha, config.deploymentId);
    await client.query("COMMIT");
    return snapshot;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function completeLiveVendorAttestations(config) {
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  let challenges;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE albert_operator_diagnostic_control");
    challenges = [];
    for (const provider of CONNECTORS) {
      const issued = await client.query(
        `select control_plane.issue_live_vendor_connection_attestation(
           $1::text,$2::text,$3::text,$4::text
         ) as challenge`,
        [config.onboardingJourneyId, config.candidateSha, config.deploymentId, provider],
      );
      const challenge = issued.rows[0]?.challenge;
      exactKeys(challenge, [
        "schemaVersion", "challengeId", "journeyId", "candidateSha",
        "deploymentId", "tenantId", "provider", "connectionId",
        "connectionGeneration", "selectedExternalAccountDigest",
        "credentialReferenceDigest", "challengeNonceDigest", "issuedAt", "expiresAt",
      ], `Live ${provider} challenge`);
      assert.equal(challenge.schemaVersion, 1);
      assert.equal(challenge.journeyId, config.onboardingJourneyId);
      assert.equal(challenge.candidateSha, config.candidateSha);
      assert.equal(challenge.deploymentId, config.deploymentId);
      assert.equal(challenge.tenantId, config.onboardingTenantId);
      assert.equal(challenge.provider, provider);
      assert.match(challenge.challengeId, ULID);
      assert.match(challenge.connectionId, ULID);
      assert.ok(Number.isSafeInteger(challenge.connectionGeneration) && challenge.connectionGeneration > 0);
      for (const key of [
        "selectedExternalAccountDigest", "credentialReferenceDigest", "challengeNonceDigest",
      ]) assert.match(challenge[key], DIGEST, `Live ${provider} ${key} is invalid.`);
      assert.ok(Date.parse(challenge.expiresAt) > Date.now() + 30_000,
        `Live ${provider} challenge has insufficient relay time.`);
      challenges.push(Object.freeze(challenge));
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
    throw error;
  }

  try {
    const challengeById = new Map(challenges.map((challenge) => [challenge.challengeId, challenge]));
    const pending = new Set(challengeById.keys());
    const deadline = Math.min(
      Date.now() + 100_000,
      ...challenges.map((challenge) => Date.parse(challenge.expiresAt) - 2_000),
    );
    while (pending.size > 0 && Date.now() < deadline) {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE albert_operator_diagnostic_control");
        const result = await client.query(
          `select control_plane.live_vendor_connection_attestation_status(
             $1::text,$2::text,$3::text,$4::text
           ) as status`,
          [
            config.onboardingJourneyId, config.candidateSha,
            config.deploymentId, config.onboardingTenantId,
          ],
        );
        await client.query("COMMIT");
        const status = result.rows[0]?.status;
        exactKeys(status, [
          "journeyId", "candidateSha", "deploymentId", "tenantId", "providers",
        ], "Live vendor attestation status");
        assert.ok(Array.isArray(status.providers));
        for (const providerStatus of status.providers) {
          if (!pending.has(providerStatus.challengeId)) continue;
          exactKeys(providerStatus, [
            "provider", "challengeId", "status", "issuedAt", "expiresAt",
            "resultStatus", "resultDigest",
          ], "Live vendor provider status");
          const expected = challengeById.get(providerStatus.challengeId);
          assert.equal(providerStatus.provider, expected.provider);
          if (providerStatus.resultStatus === "failed") {
            assert.fail(`Independent live ${providerStatus.provider} probe failed.`);
          }
          if (providerStatus.resultStatus === "passed") {
            assert.match(providerStatus.resultDigest, DIGEST);
            pending.delete(providerStatus.challengeId);
          }
        }
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
      if (pending.size > 0) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(pending.size, 0, "Independent live vendor attestations did not complete before expiry.");
    return Object.freeze(challenges.map((challenge) => Object.freeze({
      provider: challenge.provider,
      challengeId: challenge.challengeId,
      connectionId: challenge.connectionId,
      connectionGeneration: challenge.connectionGeneration,
    })));
  } finally {
    await client.end();
  }
}

function validateControlSnapshot(snapshot, candidateSha, deploymentId) {
  exactKeys(snapshot, ["snapshotId", "capturedAt", "evidenceDigest", "evidence"], "Control snapshot");
  assert.match(snapshot.snapshotId, ULID, "Control snapshot id is invalid.");
  assert.match(snapshot.evidenceDigest, DIGEST, "Control snapshot digest is invalid.");
  exactKeys(snapshot.evidence, ["schemaVersion", "capturedAt", "candidateSha", "deployment", "connections", "milestones", "references"], "Control evidence");
  assert.equal(snapshot.evidence.schemaVersion, 1);
  assert.equal(snapshot.evidence.candidateSha, candidateSha, "Control evidence is for another candidate.");
  assert.equal(snapshot.evidence.capturedAt, snapshot.capturedAt, "Control snapshot timestamps disagree.");
  exactKeys(snapshot.evidence.deployment, ["deploymentId", "barrierAt", "candidateWorkerCount"], "Control deployment barrier");
  assert.match(snapshot.evidence.deployment.deploymentId, DEPLOYMENT_ID);
  assert.equal(snapshot.evidence.deployment.deploymentId, deploymentId, "Control snapshot is for another deployment.");
  assert.equal(snapshot.evidence.deployment.candidateWorkerCount, 3);
  assert.ok(Date.parse(snapshot.evidence.deployment.barrierAt) <= Date.parse(snapshot.capturedAt), "Control deployment barrier is in the future.");
  assert.ok(Date.now() - Date.parse(snapshot.capturedAt) < 15 * 60 * 1_000, "Control snapshot is not fresh.");
  assert.ok(Array.isArray(snapshot.evidence.connections) && snapshot.evidence.connections.length === 3, "Control snapshot must bind three connections.");
  assert.deepEqual(snapshot.evidence.connections.map(({ connector }) => connector).sort(), CONNECTORS);
  exactKeys(snapshot.evidence.milestones, ["m3", "m4", "m6", "m7", "m8"], "Control milestones");
  exactKeys(snapshot.evidence.milestones.m7, [
    "passed", "journeyId", "journeyIssuedAt", "claimedAt", "browserReceiptAt",
    "onboardingMinutes", "targetMinutes", "readyPartialDomainCount",
    "readinessBindingDigest", "liveVendorAttestationConsumptionId",
    "liveVendorAttestationEvidenceDigest", "liveVendorAttestationProviderCount",
    "blockingAnswerCount", "blockingQuestionContractDigest", "blockingResponseDigest", "overlayDigest",
    "oauthConnectionCount", "claimDigest", "browserReceiptDigest",
    "authAuditProofDigest", "oauthBindingDigest", "journeyBindingDigest", "evidenceDigest",
  ], "Control M7 journey evidence");
  assert.match(snapshot.evidence.milestones.m7.journeyId, ULID, "Control M7 journey id is invalid.");
  for (const key of [
    "readinessBindingDigest", "liveVendorAttestationEvidenceDigest",
    "blockingQuestionContractDigest", "blockingResponseDigest", "overlayDigest", "claimDigest", "browserReceiptDigest",
    "authAuditProofDigest", "oauthBindingDigest", "journeyBindingDigest", "evidenceDigest",
  ]) assert.match(snapshot.evidence.milestones.m7[key], DIGEST, `Control M7 ${key} is invalid.`);
  assert.equal(snapshot.evidence.milestones.m7.oauthConnectionCount, 3);
  assert.match(
    snapshot.evidence.milestones.m7.liveVendorAttestationConsumptionId,
    ULID,
    "Control M7 live vendor attestation consumption id is invalid.",
  );
  assert.equal(snapshot.evidence.milestones.m7.liveVendorAttestationProviderCount, 3);
  exactKeys(snapshot.evidence.references, ["disconnectConnectionReferenceHash", "deletionTenantReferenceHash"], "Control references");
  assert.match(snapshot.evidence.references.disconnectConnectionReferenceHash, DIGEST);
  assert.match(snapshot.evidence.references.deletionTenantReferenceHash, DIGEST);
  return snapshot;
}

async function issueSemanticTurn(config, leaseCaseId, pass) {
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE albert_operator_diagnostic_control");
    const result = await client.query(
      `select control_plane.issue_protected_dogfood_semantic_turn(
         $1::text,$2::text,$3::text,$4::text,$5::integer,$6::text,$7::integer
       ) as lease`,
      [
        config.tenantId, config.candidateSha, config.deploymentId,
        config.runId, config.runAttempt, leaseCaseId, pass,
      ],
    );
    const lease = result.rows[0]?.lease;
    exactKeys(lease, ["leaseId", "conversationId", "turnId", "expiresAt"], "Dogfood semantic turn lease");
    assert.match(lease.leaseId, ULID);
    assert.match(lease.conversationId, ULID);
    assert.match(lease.turnId, ULID);
    assert.ok(Date.parse(lease.expiresAt) > Date.now(), "Dogfood semantic turn lease is already expired.");
    await client.query("COMMIT");
    return lease;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function finishSemanticTurn(config, lease, succeeded, resultDigest) {
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE albert_operator_diagnostic_control");
    const result = await client.query(
      `select control_plane.finish_protected_dogfood_semantic_turn(
         $1::text,$2::boolean,$3::text
       ) as finished`,
      [lease.leaseId, succeeded, resultDigest],
    );
    assert.equal(result.rows[0]?.finished, true, "Dogfood semantic turn lease was not finalized.");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function probeRuntimes(config, flyManifest) {
  const publicFlyApps = flyManifest.apps.filter(({ exposure }) => exposure === "public");
  await Promise.all(publicFlyApps.map(async ({ service, origin }) => {
    const response = await fetch(new URL("/readyz", origin), {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200, `Platform-attested Fly runtime ${service} is not ready.`);
    await response.body?.cancel().catch(() => undefined);
  }));
  const webResponse = await fetch(new URL("/api/health", config.sitesManifest.deploymentUrl), {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(webResponse.status, 200, "Platform-attested Sites deployment is not ready.");
  await webResponse.body?.cancel().catch(() => undefined);
  const platformBinding = {
    fly: flyManifest,
    sites: config.sitesManifest,
  };
  return Object.freeze({
    checkedCount: DOGFOOD_REQUIRED_RUNTIMES.length,
    requiredServices: DOGFOOD_REQUIRED_RUNTIMES,
    deploymentId: flyManifest.deploymentId,
    identityDigest: platformSha256(platformBinding),
    ...platformBinding,
  });
}

async function flyctlJson(token, args) {
  const { stdout } = await execFileAsync("flyctl", args, {
    encoding: "utf8",
    env: {
      FLY_API_TOKEN: token,
      PATH: process.env.PATH,
    },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 20_000,
  });
  try { return JSON.parse(stdout); } catch { assert.fail(`flyctl ${args[0]} returned invalid JSON.`); }
}

export function validatePrivateFlyEvidence(input, probe, config) {
  assert.ok(Array.isArray(input.machines), `Private runtime ${probe.name} machine evidence is invalid.`);
  assert.ok(input.checks && typeof input.checks === "object" && !Array.isArray(input.checks), `Private runtime ${probe.name} check evidence is invalid.`);
  assert.ok(Array.isArray(input.ips) && input.ips.length === 0, `Private runtime ${probe.name} unexpectedly has a public IP.`);
  const machines = input.machines.filter(({ state }) => state === "started");
  assert.ok(machines.length >= 2, `Private runtime ${probe.name} has insufficient running capacity.`);
  const identities = machines.map((machine) => {
    const [identityName, identityValue] = PRIVATE_FLY_RUNTIME_IDENTITY[probe.name] ?? [];
    assert.ok(identityName && identityValue, `Private runtime ${probe.name} identity contract is absent.`);
    assert.match(machine.id ?? "", /^[a-f0-9]{14}$/u, `Private runtime ${probe.name} machine id is invalid.`);
    assert.equal(machine.region, "syd", `Private runtime ${probe.name} is outside Sydney.`);
    assert.equal(machine.config?.env?.ALBERT_SERVICE_VERSION, config.candidateSha, `Private runtime ${probe.name} is not the candidate SHA.`);
    assert.equal(machine.config?.env?.ALBERT_DEPLOYMENT_ID, config.deploymentId, `Private runtime ${probe.name} is not the candidate deployment.`);
    assert.equal(machine.config?.env?.[identityName], identityValue, `Private Fly app does not contain the expected ${probe.name} process identity.`);
    assert.equal(machine.config?.checks?.readiness?.type, "http", `Private runtime ${probe.name} lacks its platform HTTP readiness check.`);
    assert.equal(machine.config?.checks?.readiness?.path, "/readyz", `Private runtime ${probe.name} readiness path drifted.`);
    const readiness = input.checks[machine.id];
    assert.ok(Array.isArray(readiness), `Private runtime ${probe.name} has no platform check result.`);
    assert.ok(
      readiness.some((check) => check?.name === "readiness" && check?.status === "passing"),
      `Private runtime ${probe.name} is not passing its platform readiness check.`,
    );
    return {
      id: machine.id,
      imageDigest: machine.image_ref?.digest ?? null,
      instanceId: machine.instance_id ?? null,
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  return Object.freeze({
    name: probe.name,
    mode: probe.mode,
    releaseSha: config.candidateSha,
    deploymentId: config.deploymentId,
    machineCount: machines.length,
    identityDigest: sha256(identities),
  });
}

function semanticSignature(path, body, secret) {
  assert.ok(Buffer.byteLength(secret, "utf8") >= 32, "Semantic signing secret is too short.");
  const timestamp = String(Date.now());
  const digest = createHash("sha256").update(body).digest("base64url");
  const value = createHmac("sha256", secret)
    .update(["POST", path, timestamp, digest].join("\n"))
    .digest("base64url");
  return { "x-albert-timestamp": timestamp, "x-albert-signature": value };
}

async function executeSemanticQuery(config, testCase, query, pass) {
  const queryLabel = `${testCase.caseId}/${query.queryId}`;
  const leaseCaseId = query.queryId === "primary" ? testCase.caseId : `${testCase.caseId}-${query.queryId}`;
  const lease = await issueSemanticTurn(config, leaseCaseId, pass);
  const path = "/v1/tools/run_semantic_query";
  const body = JSON.stringify({
    tenantId: config.tenantId,
    conversationId: lease.conversationId,
    turnId: lease.turnId,
    role: "owner",
    input: query.input,
  });
  let succeeded = false;
  let terminalDigest = sha256({ caseId: testCase.caseId, queryId: query.queryId, pass, outcome: "failed" });
  try {
    const response = await fetch(new URL(path, config.semanticBaseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...semanticSignature(path, body, config.semanticSigningSecret),
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(40_000),
    });
    assert.equal(response.status, 200, `Semantic query ${queryLabel} pass ${pass} failed with HTTP ${response.status}.`);
    const result = await response.json().catch(() => null);
    assert.ok(result && typeof result === "object" && !Array.isArray(result), `Semantic query ${queryLabel} response is invalid.`);
    assert.equal(
      result.state,
      testCase.expectedState,
      `Semantic query ${queryLabel} did not return its reviewed answer state.`,
    );
    assert.ok(Array.isArray(result.data?.rows), `Semantic query ${queryLabel} returned no table.`);
    assert.ok(result.data.rows.length <= 10_000, `Semantic query ${queryLabel} returned too many rows.`);
    if (query.rowRequirement === "nonempty") {
      assert.ok(result.data.rows.length > 0, `Semantic query ${queryLabel} must return a nonempty result table.`);
    } else {
      assert.equal(query.rowRequirement, "allow-empty", `Semantic query ${queryLabel} has an invalid row contract.`);
    }
    assert.match(result.queryAudit?.resultDigest ?? "", DIGEST, `Semantic query ${queryLabel} result digest is invalid.`);
    assert.match(result.queryAudit?.bundleHash ?? "", DIGEST, `Semantic query ${queryLabel} bundle hash is invalid.`);
    assert.equal(result.queryAudit?.route, "semantic", `Semantic query ${queryLabel} used source exploration.`);
    assert.ok(Array.isArray(result.provenance?.sources) && result.provenance.sources.length > 0, `Semantic query ${queryLabel} lacks provenance.`);
    assert.ok(result.validation?.status === "passed" || result.validation?.status === "warning", `Semantic query ${queryLabel} failed validation.`);
    succeeded = true;
    terminalDigest = result.queryAudit.resultDigest;
    return Object.freeze({
      queryId: query.queryId,
      rowRequirement: query.rowRequirement,
      rowCount: result.data.rows.length,
      resultDigest: result.queryAudit.resultDigest,
      bundleHash: result.queryAudit.bundleHash,
    });
  } finally {
    await finishSemanticTurn(config, lease, succeeded, terminalDigest);
  }
}

async function executeSemanticPlan(config) {
  const cases = [];
  for (const testCase of config.semanticPlan.cases) {
    const queries = [];
    for (const query of testCase.queries) {
      const first = await executeSemanticQuery(config, testCase, query, 1);
      const second = await executeSemanticQuery(config, testCase, query, 2);
      assert.deepEqual(second, first, `Semantic query ${testCase.caseId}/${query.queryId} was not repeatable.`);
      assert.equal(
        first.resultDigest,
        query.expectedResultDigest,
        `Semantic query ${testCase.caseId}/${query.queryId} drifted from its protected expected result.`,
      );
      queries.push(first);
    }
    cases.push(Object.freeze({
      caseId: testCase.caseId,
      kind: testCase.kind,
      answerState: testCase.expectedState,
      queries: Object.freeze(queries),
    }));
  }
  const milestone = {
    passed: true,
    suiteVersion: config.semanticPlan.suiteVersion,
    suiteDigest: config.semanticPlan.suiteDigest,
    caseCount: config.semanticPlan.cases.length,
    collectionAnchor: config.semanticCollectionAnchor,
    planDigest: config.referencePlan.semanticPlanDigest,
    referencePlanDigest: config.referencePlan.referencePlanDigest,
    referenceSignerKeyId: config.referencePlan.signerKeyId,
    seedOutcomeSuiteVersion: config.referencePlan.seedOutcomeManifest.suiteVersion,
    seedOutcomeSuiteDigest: config.referencePlan.seedOutcomeManifest.suiteDigest,
    seedOutcomeCaseCount: config.referencePlan.seedOutcomeManifest.cases.length,
    seedOutcomeManifestDigest: config.referencePlan.seedOutcomeManifestDigest,
    seedOutcomeEvidenceDigest: config.referencePlan.seedOutcomeEvidenceDigest,
    seedOutcomes: config.referencePlan.seedOutcomeEvidence.cases,
    cases,
  };
  return Object.freeze({ ...milestone, evidenceDigest: computeDogfoodM5EvidenceDigest(milestone) });
}

async function collect(source = process.env) {
  const initialConfig = configuration(source);
  const flyManifest = await collectFlyPlatformProvenance({
    candidateSha: initialConfig.candidateSha,
    token: initialConfig.flyReadonlyToken,
    flyctlJson,
  });
  const semanticOrigin = flyManifest.apps.find(({ service }) => service === "semantic-query")?.origin;
  assert.ok(semanticOrigin, "Fly platform evidence contains no semantic-query public origin.");
  const config = Object.freeze({
    ...initialConfig,
    deploymentId: flyManifest.deploymentId,
    semanticBaseUrl: `${semanticOrigin}/`,
  });
  const runtimeProbe = await probeRuntimes(config, flyManifest);
  await completeLiveVendorAttestations(config);
  const snapshot = await captureControlEvidence(config);
  const m5 = await executeSemanticPlan(config);
  const issuedAt = new Date();
  const evidence = snapshot.evidence;
  const {
    journeyId: internalJourneyId,
    liveVendorAttestationConsumptionId: internalVendorAttestationConsumptionId,
    evidenceDigest: controlM7EvidenceDigest,
    ...signedM7
  } = evidence.milestones.m7;
  assert.equal(
    internalJourneyId,
    config.onboardingJourneyId,
    "Control snapshot is bound to another protected onboarding journey.",
  );
  const signedM7Content = Object.freeze({
    ...signedM7,
    controlEvidenceDigest: controlM7EvidenceDigest,
    journeyRef: hmacReference(config.referenceKey, "onboarding-journey", config.onboardingJourneyId),
    liveVendorAttestationConsumptionRef: hmacReference(
      config.referenceKey,
      "live-vendor-attestation-consumption",
      internalVendorAttestationConsumptionId,
    ),
  });
  const runtimes = Object.freeze({
    ...runtimeProbe,
    barrierAt: evidence.deployment.barrierAt,
  });
  const connectorByName = new Map(evidence.connections.map((item) => [item.connector, item]));
  const body = {
    schemaVersion: 4,
    kind: "albert.protected-dogfood-acceptance",
    attestationId: snapshot.snapshotId,
    candidateSha: config.candidateSha,
    sourceEnvironment: "staging",
    targetEnvironment: "production",
    repository: config.repository,
    workflow: {
      file: "dogfood-acceptance.yml",
      runId: config.runId,
      runAttempt: config.runAttempt,
      actorId: config.actorId,
      ref: config.protectedRef,
      toolingSha: config.trustedToolingSha,
    },
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 2 * 60 * 60 * 1_000).toISOString(),
    nonceDigest: sha256(randomBytes(32).toString("base64url")),
    controlSnapshotDigest: snapshot.evidenceDigest,
    subjects: {
      dogfoodTenantRef: hmacReference(config.referenceKey, "tenant", config.tenantId),
      onboardingTenantRef: hmacReference(config.referenceKey, "tenant", config.onboardingTenantId),
      deletionTenantRef: hmacReference(config.referenceKey, "deletion-proof", evidence.references.deletionTenantReferenceHash),
    },
    runtimes,
    connectionGenerations: CONNECTORS.map((connector) => ({
      connector,
      connectionRef: hmacReference(config.referenceKey, "connection", config.connections[connector]),
      generation: connectorByName.get(connector)?.generation,
    })),
    milestones: {
      m3: evidence.milestones.m3,
      m4: evidence.milestones.m4,
      m5,
      m6: evidence.milestones.m6,
      m7: {
        ...signedM7Content,
        evidenceDigest: sha256(signedM7Content),
      },
      m8: {
        ...evidence.milestones.m8,
        disconnect: {
          subjectRef: hmacReference(config.referenceKey, "deletion-proof", evidence.references.disconnectConnectionReferenceHash),
          ...evidence.milestones.m8.disconnect,
        },
        tenantDeletion: {
          subjectRef: hmacReference(config.referenceKey, "deletion-proof", evidence.references.deletionTenantReferenceHash),
          ...evidence.milestones.m8.tenantDeletion,
        },
      },
    },
  };
  return signDogfoodAcceptance(body, config.privateKey);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputPath = process.argv[2];
  assert.ok(outputPath, "Collector requires an output file path.");
  const envelope = await collect();
  await writeFile(outputPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(`protected dogfood acceptance captured for ${envelope.attestation.candidateSha}\n`);
}
