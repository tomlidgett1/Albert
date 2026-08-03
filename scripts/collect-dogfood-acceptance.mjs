import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import {
  DOGFOOD_REQUIRED_RUNTIMES,
  dogfoodSemanticPlanSchema,
  hmacReference,
  sha256,
  signDogfoodAcceptance,
} from "./dogfood-acceptance-attestation.mjs";

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
  const deploymentId = required(source, "ALBERT_DOGFOOD_DEPLOYMENT_ID");
  assert.match(deploymentId, DEPLOYMENT_ID, "Dogfood deployment id is invalid.");
  const runAttempt = Number(required(source, "GITHUB_RUN_ATTEMPT"));
  assert.ok(Number.isSafeInteger(runAttempt) && runAttempt >= 1 && runAttempt <= 10_000, "Workflow run attempt is invalid.");
  const runtimeProbes = validateRuntimePlan(jsonEnvironment(source, "ALBERT_DOGFOOD_RUNTIME_PROBES_JSON"));
  const semanticBaseUrl = validateSemanticBaseUrl(
    required(source, "ALBERT_DOGFOOD_SEMANTIC_QUERY_URL"),
    runtimeProbes,
  );
  return Object.freeze({
    candidateSha,
    deploymentId,
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
    onboardingTargetMinutes: Number(required(source, "ALBERT_DOGFOOD_ONBOARDING_TARGET_MINUTES")),
    flagshipArtifactId: required(source, "ALBERT_DOGFOOD_FLAGSHIP_ARTIFACT_ID"),
    categoryArtifactId: required(source, "ALBERT_DOGFOOD_CATEGORY_ARTIFACT_ID"),
    categoryTopic: required(source, "ALBERT_DOGFOOD_CATEGORY_TOPIC"),
    disconnectProofId: required(source, "ALBERT_DOGFOOD_DISCONNECT_PROOF_ID"),
    tenantDeletionProofId: required(source, "ALBERT_DOGFOOD_TENANT_DELETION_PROOF_ID"),
    semanticBaseUrl,
    semanticSigningSecret: required(source, "ALBERT_DOGFOOD_SEMANTIC_SIGNING_SECRET"),
    semanticCases: dogfoodSemanticPlanSchema.parse(jsonEnvironment(source, "ALBERT_DOGFOOD_SEMANTIC_CASE_PLAN_JSON")),
    runtimeProbes,
    flyReadonlyToken: required(source, "ALBERT_DOGFOOD_FLY_READONLY_TOKEN"),
    referenceKey: required(source, "ALBERT_DOGFOOD_REFERENCE_HMAC_KEY_BASE64URL"),
    privateKey: required(source, "ALBERT_DOGFOOD_ACCEPTANCE_ED25519_PRIVATE_KEY_BASE64URL"),
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
  assert.equal(publicProbes.length, 5, "Only the five public runtimes may use HTTPS probes.");
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

function validateSemanticBaseUrl(input, runtimeProbes) {
  const url = new URL(input);
  assert.equal(url.protocol, "https:", "Protected semantic execution must use HTTPS.");
  assert.equal(url.username, "", "Semantic service URL must not contain credentials.");
  assert.equal(url.password, "", "Semantic service URL must not contain credentials.");
  const semanticProbe = runtimeProbes.find(({ name }) => name === "semantic-query");
  assert.ok(semanticProbe, "Semantic runtime probe is missing.");
  assert.equal(
    url.origin,
    new URL(semanticProbe.url).origin,
    "Semantic cases must execute against the probed candidate semantic runtime.",
  );
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
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
        $7::text,$8::text,$9::text,$10::text,$11::text
      ) as snapshot`,
      [
        config.candidateSha,config.deploymentId,config.tenantId,JSON.stringify(config.connections),
        config.onboardingTenantId,config.onboardingTargetMinutes,
        config.flagshipArtifactId,config.categoryArtifactId,config.categoryTopic,
        config.disconnectProofId,config.tenantDeletionProofId,
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
  exactKeys(snapshot.evidence.references, ["disconnectConnectionReferenceHash", "deletionTenantReferenceHash"], "Control references");
  assert.match(snapshot.evidence.references.disconnectConnectionReferenceHash, DIGEST);
  assert.match(snapshot.evidence.references.deletionTenantReferenceHash, DIGEST);
  return snapshot;
}

async function issueSemanticTurn(config, testCase, pass) {
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
        config.runId, config.runAttempt, testCase.caseId, pass,
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

async function probeRuntimes(config) {
  const observations = await Promise.all(config.runtimeProbes.map(async (probe) => {
    if (probe.mode === "fly-private") {
      return probePrivateFlyRuntime(config, probe);
    }
    const response = await fetch(probe.url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200, `Runtime ${probe.name} is not ready.`);
    const body = await response.json().catch(() => null);
    assert.ok(body && typeof body === "object" && !Array.isArray(body), `Runtime ${probe.name} readiness is invalid.`);
    assert.equal(body.releaseSha, config.candidateSha, `Runtime ${probe.name} is not the candidate SHA.`);
    assert.equal(body.deploymentId, config.deploymentId, `Runtime ${probe.name} is not the candidate deployment.`);
    assert.equal(body.runtime, probe.name, `Runtime ${probe.name} reported a different service identity.`);
    assert.ok(body.ready === true || body.status === "ready", `Runtime ${probe.name} did not report ready.`);
    return Object.freeze({
      name: probe.name,
      mode: probe.mode,
      releaseSha: body.releaseSha,
      deploymentId: body.deploymentId,
      originDigest: sha256(new URL(probe.url).origin),
    });
  }));
  return Object.freeze({
    checkedCount: observations.length,
    requiredServices: DOGFOOD_REQUIRED_RUNTIMES,
    deploymentId: config.deploymentId,
    identityDigest: sha256(observations.sort((left, right) => left.name.localeCompare(right.name))),
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

async function probePrivateFlyRuntime(config, probe) {
  const [machines, checks, ips] = await Promise.all([
    flyctlJson(config.flyReadonlyToken, ["machines", "list", "--app", probe.flyApp, "--json"]),
    flyctlJson(config.flyReadonlyToken, ["checks", "list", "--app", probe.flyApp, "--json"]),
    flyctlJson(config.flyReadonlyToken, ["ips", "list", "--app", probe.flyApp, "--json"]),
  ]);
  return validatePrivateFlyEvidence({ machines, checks, ips }, probe, config);
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

async function executeSemanticCase(config, testCase, pass) {
  const lease = await issueSemanticTurn(config, testCase, pass);
  const path = "/v1/tools/run_semantic_query";
  const body = JSON.stringify({
    tenantId: config.tenantId,
    conversationId: lease.conversationId,
    turnId: lease.turnId,
    role: "owner",
    input: testCase.input,
  });
  let succeeded = false;
  let terminalDigest = sha256({ caseId: testCase.caseId, pass, outcome: "failed" });
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
    assert.equal(response.status, 200, `Semantic case ${testCase.caseId} pass ${pass} failed with HTTP ${response.status}.`);
    const result = await response.json().catch(() => null);
    assert.ok(result && typeof result === "object" && !Array.isArray(result), `Semantic case ${testCase.caseId} response is invalid.`);
    assert.ok(result.state === "verified" || result.state === "qualified", `Semantic case ${testCase.caseId} is not governed.`);
    assert.ok(Array.isArray(result.data?.rows), `Semantic case ${testCase.caseId} returned no table.`);
    assert.match(result.queryAudit?.resultDigest ?? "", DIGEST, `Semantic case ${testCase.caseId} result digest is invalid.`);
    assert.match(result.queryAudit?.bundleHash ?? "", DIGEST, `Semantic case ${testCase.caseId} bundle hash is invalid.`);
    assert.equal(result.queryAudit?.route, "semantic", `Semantic case ${testCase.caseId} used source exploration.`);
    assert.ok(Array.isArray(result.provenance?.sources) && result.provenance.sources.length > 0, `Semantic case ${testCase.caseId} lacks provenance.`);
    assert.ok(result.validation?.status === "passed" || result.validation?.status === "warning", `Semantic case ${testCase.caseId} failed validation.`);
    succeeded = true;
    terminalDigest = result.queryAudit.resultDigest;
    return Object.freeze({
      answerState: result.state,
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
  for (const testCase of config.semanticCases) {
    const first = await executeSemanticCase(config, testCase, 1);
    const second = await executeSemanticCase(config, testCase, 2);
    assert.deepEqual(second, first, `Semantic case ${testCase.caseId} was not repeatable.`);
    assert.equal(first.resultDigest, testCase.expectedResultDigest, `Semantic case ${testCase.caseId} drifted from its protected expected result.`);
    cases.push(Object.freeze({ caseId: testCase.caseId, kind: testCase.kind, ...first }));
  }
  const milestone = {
    passed: true,
    planDigest: sha256(config.semanticCases),
    cases,
  };
  return Object.freeze({ ...milestone, evidenceDigest: sha256(milestone) });
}

async function collect(source = process.env) {
  const config = configuration(source);
  const runtimeProbe = await probeRuntimes(config);
  const snapshot = await captureControlEvidence(config);
  const m5 = await executeSemanticPlan(config);
  const issuedAt = new Date();
  const evidence = snapshot.evidence;
  const runtimes = Object.freeze({
    ...runtimeProbe,
    barrierAt: evidence.deployment.barrierAt,
  });
  const connectorByName = new Map(evidence.connections.map((item) => [item.connector, item]));
  const body = {
    schemaVersion: 1,
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
      m7: evidence.milestones.m7,
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
