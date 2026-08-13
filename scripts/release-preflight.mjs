import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  ALBERT_BLOCKING_QUESTIONS_CONTRACT_DIGEST,
} from "../contracts/blocking-questions.mjs";
import {
  assertSupabaseAuthProductionPolicy,
  fetchSupabaseAuthConfig,
} from "./supabase-auth-production-policy.mjs";
import { verifyTransformFleetCapacityAttestation } from "./transform-fleet-capacity-attestation.mjs";

const SYDNEY_REGION = "ap-southeast-2";
const AU_OPENAI_BASE_URL = "https://au.api.openai.com/v1";
const DESIGN_TENANTS = 20_000;
const TRANSFORM_LANES_PER_MACHINE = 8;
const TRANSFORM_MAX_MACHINES = 40;
const SNAPSHOT_SWEEP_SECONDS = 3_600;
const CAPACITY_UTILIZATION = 0.7;

function required(source, name) {
  const value = source[name]?.trim();
  assert.ok(value, `${name} is required by the protected release environment.`);
  return value;
}

function positiveNumber(source, name) {
  const value = Number(required(source, name));
  assert.ok(Number.isFinite(value) && value > 0, `${name} must be a positive number.`);
  return value;
}

function decodedPublicKey(source) {
  const value = Buffer.from(
    required(source, "ALBERT_CAPACITY_ED25519_PUBLIC_KEY_BASE64"),
    "base64",
  ).toString("utf8");
  assert.match(value, /-----BEGIN PUBLIC KEY-----/u, "Capacity public key is not SPKI PEM.");
  return value;
}

function immutableServicesImageDigest(source) {
  const value = required(source, "ALBERT_RELEASE_SERVICES_IMAGE");
  const match = /^ghcr\.io\/[a-z0-9][a-z0-9._/-]{1,200}@(sha256:[a-f0-9]{64})$/u.exec(value);
  assert.ok(match, "ALBERT_RELEASE_SERVICES_IMAGE must be an immutable GHCR digest reference.");
  return match[1];
}

function requireTrustedFleetCapacityEvidence(source, releaseEnvironment, commitSha) {
  if (releaseEnvironment !== "production") return null;
  const encoded = required(source, "ALBERT_TRANSFORM_FLEET_CAPACITY_ATTESTATION_BASE64");
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    assert.fail("Production requires a valid protected transform fleet capacity attestation envelope.");
  }
  const authoritySha = required(source, "ALBERT_RELEASE_AUTHORITY_TOOLING_SHA");
  const workflowRef = required(source, "ALBERT_RELEASE_AUTHORITY_WORKFLOW_REF");
  assert.equal(authoritySha, required(source, "GITHUB_SHA"),
    "Release authority SHA differs from the executing workflow.");
  assert.equal(workflowRef, required(source, "GITHUB_WORKFLOW_REF"),
    "Release authority workflow ref differs from the executing workflow.");
  return verifyTransformFleetCapacityAttestation(envelope, {
    publicKey: decodedPublicKey(source),
    authoritySha,
    authorityRef: required(source, "GITHUB_REF"),
    candidateSha: commitSha,
    candidateTransformImageDigest: immutableServicesImageDigest(source),
    releasePlanDigest: required(source, "ALBERT_RELEASE_PLAN_DIGEST"),
    repository: required(source, "GITHUB_REPOSITORY"),
    workflowRunId: required(source, "GITHUB_RUN_ID"),
    workflowRunAttempt: Number(required(source, "GITHUB_RUN_ATTEMPT")),
    workflowRef,
    stagingCellId: required(source, "ALBERT_CAPACITY_STAGING_CELL_ID"),
    corpusFingerprint: required(source, "ALBERT_CAPACITY_CORPUS_FINGERPRINT"),
    producerToolRef: required(source, "ALBERT_CAPACITY_ATTESTOR_TOOL_REF"),
    producerBuildDigest: required(source, "ALBERT_CAPACITY_ATTESTOR_BUILD_DIGEST"),
  });
}

function cleanHttpsOrigin(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    assert.fail(`${name} must be a valid HTTPS origin.`);
  }
  assert.equal(url.protocol, "https:", `${name} must use HTTPS.`);
  assert.equal(url.username, "", `${name} must not contain credentials.`);
  assert.equal(url.password, "", `${name} must not contain credentials.`);
  assert.equal(url.pathname, "/", `${name} must be an origin without a path.`);
  assert.equal(url.search, "", `${name} must not contain a query.`);
  assert.equal(url.hash, "", `${name} must not contain a fragment.`);
  assert.equal(["localhost", "127.0.0.1", "::1"].includes(url.hostname), false, `${name} must not be local.`);
  return url.origin;
}

function postgresTarget(value, name, expectedLogin, expectedProjectRef) {
  let url;
  try {
    url = new URL(value);
  } catch {
    assert.fail(`${name} must be a PostgreSQL URL.`);
  }
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol), `${name} must be a PostgreSQL URL.`);
  assert.equal(["localhost", "127.0.0.1", "::1"].includes(url.hostname), false, `${name} must not be local.`);
  const sslMode = url.searchParams.get("sslmode")?.toLowerCase();
  assert.ok(["require", "verify-ca", "verify-full"].includes(sslMode), `${name} must require TLS.`);
  let login;
  try {
    login = decodeURIComponent(url.username);
  } catch {
    assert.fail(`${name} contains an invalid login name.`);
  }
  assert.match(
    login,
    new RegExp(`^${expectedLogin}(?:\\.[a-z0-9]{20})?$`, "u"),
    `${name} must use the ${expectedLogin} login.`,
  );
  if (expectedProjectRef) {
    assert.ok(
      url.hostname === `db.${expectedProjectRef}.supabase.co` ||
        login.endsWith(`.${expectedProjectRef}`),
      `${name} does not target the selected Supabase project.`,
    );
  }
  const database = url.pathname.replace(/^\/+/, "") || "postgres";
  const poolerProjectRef = /\.([a-z0-9]{20})$/u.exec(login)?.[1];
  return `${url.hostname.toLowerCase()}:${url.port || "5432"}/${database}` +
    (poolerProjectRef ? `#${poolerProjectRef}` : "");
}

export function validateReleaseEnvironment(source, project, authConfig = null) {
  const releaseEnvironment = required(source, "ALBERT_RELEASE_ENVIRONMENT");
  assert.ok(["staging", "production"].includes(releaseEnvironment), "ALBERT_RELEASE_ENVIRONMENT is invalid.");
  const commitSha = required(source, "ALBERT_RELEASE_COMMIT_SHA");
  assert.match(commitSha, /^[a-f0-9]{40}$/u, "ALBERT_RELEASE_COMMIT_SHA must be a full Git commit SHA.");
  if (releaseEnvironment === "production") {
    assert.equal(
      required(source, "ALBERT_BLOCKING_QUESTIONS_APPROVED_DIGEST"),
      ALBERT_BLOCKING_QUESTIONS_CONTRACT_DIGEST,
      "The protected blocking-question approval digest does not match the code-owned contract.",
    );
  }

  const projectRef = required(source, "ALBERT_CONTROL_PLANE_PROJECT_REF");
  assert.match(projectRef, /^[a-z0-9]{20}$/u, "ALBERT_CONTROL_PLANE_PROJECT_REF is invalid.");
  assert.equal(required(source, "ALBERT_CONTROL_PLANE_REGION"), SYDNEY_REGION, "The control plane must be in Sydney.");
  assert.equal(required(source, "ALBERT_ANALYTICAL_REGION"), SYDNEY_REGION, "The analytical cell must be in Sydney.");
  assert.equal(required(source, "SUPABASE_STORAGE_S3_REGION"), SYDNEY_REGION, "Raw storage must be in Sydney.");
  assert.equal(
    required(source, "ALBERT_MODEL_DATA_RESIDENCY_REGION"),
    "au",
    "The model endpoint must be approved for Australian data residency.",
  );
  assert.equal(required(source, "ALBERT_MODEL_DATA_CONTROL_APPROVED"), "true", "Model data controls require explicit approval.");
  assert.equal(required(source, "ALBERT_LIGHTSPEED_PRODUCT"), "r-series", "Lightspeed R-Series must be explicitly confirmed.");
  assert.equal(
    required(source, "OPENAI_BASE_URL").replace(/\/+$/u, ""),
    AU_OPENAI_BASE_URL,
    "OPENAI_BASE_URL must be the approved OpenAI AU data-residency endpoint.",
  );

  const supabaseOrigin = cleanHttpsOrigin(required(source, "NEXT_PUBLIC_SUPABASE_URL"), "NEXT_PUBLIC_SUPABASE_URL");
  assert.equal(supabaseOrigin, `https://${projectRef}.supabase.co`, "The web Supabase URL does not match the selected project ref.");
  const storageEndpoint = new URL(required(source, "SUPABASE_STORAGE_S3_ENDPOINT"));
  assert.equal(storageEndpoint.protocol, "https:", "Raw Storage S3 must use HTTPS.");
  assert.equal(
    storageEndpoint.hostname,
    `${projectRef}.storage.supabase.co`,
    "Raw Storage S3 must use the selected project's direct Storage hostname.",
  );
  assert.equal(
    storageEndpoint.pathname.replace(/\/+$/u, ""),
    "/storage/v1/s3",
    "Raw Storage S3 endpoint path is invalid.",
  );
  assert.equal(storageEndpoint.username, "", "Raw Storage S3 endpoint must not contain credentials.");
  assert.equal(storageEndpoint.password, "", "Raw Storage S3 endpoint must not contain credentials.");
  assert.equal(storageEndpoint.search, "", "Raw Storage S3 endpoint must not contain a query.");
  assert.equal(storageEndpoint.hash, "", "Raw Storage S3 endpoint must not contain a fragment.");

  assert.ok(project && typeof project === "object" && !Array.isArray(project), "Supabase returned invalid project metadata.");
  assert.equal(project.ref ?? project.id, projectRef, "Supabase project metadata does not match the selected project ref.");
  assert.equal(project.region, SYDNEY_REGION, "The selected Supabase project is not in Sydney.");
  assert.equal(project.status, "ACTIVE_HEALTHY", "The selected Supabase project is not healthy and active.");

  const publicOrigin = cleanHttpsOrigin(required(source, "ALBERT_PUBLIC_ORIGIN"), "ALBERT_PUBLIC_ORIGIN");
  const origins = [
    publicOrigin,
    cleanHttpsOrigin(required(source, "ANTHROPIC_ANALYTICS_SERVICE_URL"), "ANTHROPIC_ANALYTICS_SERVICE_URL"),
    cleanHttpsOrigin(required(source, "SEMANTIC_QUERY_SERVICE_URL"), "SEMANTIC_QUERY_SERVICE_URL"),
    cleanHttpsOrigin(required(source, "CUBE_API_URL"), "CUBE_API_URL"),
    cleanHttpsOrigin(required(source, "OPERATOR_DIAGNOSTIC_SERVICE_URL"), "OPERATOR_DIAGNOSTIC_SERVICE_URL"),
    cleanHttpsOrigin(required(source, "SYNC_WORKER_INTERNAL_URL"), "SYNC_WORKER_INTERNAL_URL"),
    cleanHttpsOrigin(required(source, "WEBHOOK_GATEWAY_PUBLIC_URL"), "WEBHOOK_GATEWAY_PUBLIC_URL"),
  ];
  assert.equal(new Set(origins).size, origins.length, "Public and service origins must be distinct.");
  if (releaseEnvironment === "production") {
    assert.ok(authConfig && typeof authConfig === "object" && !Array.isArray(authConfig),
      "Production requires live Supabase Auth configuration metadata.");
    assertSupabaseAuthProductionPolicy(authConfig, publicOrigin);
  }

  const controlTarget = postgresTarget(
    required(source, "CONTROL_PLANE_MIGRATION_URL"),
    "CONTROL_PLANE_MIGRATION_URL",
    "albert_control_deployer",
    projectRef,
  );
  const analyticalTarget = postgresTarget(
    required(source, "ANALYTICAL_MIGRATION_URL"),
    "ANALYTICAL_MIGRATION_URL",
    "albert_analytical_deployer",
  );
  assert.notEqual(controlTarget, analyticalTarget, "Control and analytical migrations must target separate databases.");

  const flyApps = [
    "FLY_ANTHROPIC_APP",
    "FLY_SEMANTIC_APP",
    "FLY_CUBE_APP",
    "FLY_SYNC_APP",
    "FLY_TRANSFORM_APP",
    "FLY_WEBHOOK_APP",
    "FLY_DELETION_APP",
    "FLY_OPERATOR_DIAGNOSTIC_APP",
    "FLY_SYNC_AUTOSCALER_APP",
    "FLY_TRANSFORM_AUTOSCALER_APP",
  ].map((name) => {
    const value = required(source, name);
    assert.match(value, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u, `${name} is not a valid explicit app target.`);
    return value;
  });
  assert.equal(new Set(flyApps).size, flyApps.length, "Each runtime must target a different Fly app.");
  assert.match(
    required(source, "FLY_ORGANIZATION_SLUG"),
    /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u,
    "FLY_ORGANIZATION_SLUG is invalid.",
  );

  const snapshotP95Ms = positiveNumber(source, "ALBERT_SNAPSHOT_P95_MS");
  const requiredTransformMachines = Math.ceil(
    DESIGN_TENANTS * snapshotP95Ms /
      (SNAPSHOT_SWEEP_SECONDS * 1_000 * TRANSFORM_LANES_PER_MACHINE * CAPACITY_UTILIZATION),
  );
  assert.ok(
    requiredTransformMachines <= TRANSFORM_MAX_MACHINES,
    `Measured snapshot p95 requires ${requiredTransformMachines} transform Machines, above the reviewed maximum of ${TRANSFORM_MAX_MACHINES}.`,
  );
  const capacity = requireTrustedFleetCapacityEvidence(source, releaseEnvironment, commitSha);
  const transformMachineFloor = capacity?.recommendedProductionFloor
    ?? Math.max(2, requiredTransformMachines);

  return Object.freeze({
    releaseEnvironment,
    commitSha,
    projectRef,
    transformMachineFloor,
    capacityAttestationDigest: capacity?.envelopeDigest ?? null,
  });
}

export async function fetchSupabaseReleaseMetadata(source, fetchImpl = fetch) {
  const projectRef = required(source, "ALBERT_CONTROL_PLANE_PROJECT_REF");
  const token = required(source, "SUPABASE_MANAGEMENT_TOKEN");
  const projectRequest = fetchImpl(`https://api.supabase.com/v1/projects/${projectRef}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const authRequest = source.ALBERT_RELEASE_ENVIRONMENT?.trim() === "production"
    ? fetchSupabaseAuthConfig({ projectRef, token, fetchImpl })
    : Promise.resolve(null);
  const [response, authConfig] = await Promise.all([projectRequest, authRequest]);
  assert.equal(response.ok, true, `Supabase project verification failed with status ${response.status}.`);
  return Object.freeze({ project: await response.json(), authConfig });
}

async function main() {
  const { project, authConfig } = await fetchSupabaseReleaseMetadata(process.env);
  const result = validateReleaseEnvironment(process.env, project, authConfig);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, [
      `transform_machine_floor=${result.transformMachineFloor}`,
      `capacity_attestation_digest=${result.capacityAttestationDigest ?? "not-required"}`,
      "",
    ].join("\n"));
  }
  process.stdout.write(`release preflight passed for ${result.releaseEnvironment} at ${result.commitSha}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
