import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ALBERT_BLOCKING_QUESTIONS_CONTRACT_DIGEST,
} from "../contracts/blocking-questions.mjs";
import {
  fetchSupabaseReleaseMetadata,
  validateReleaseEnvironment,
} from "../scripts/release-preflight.mjs";
import {
  ALBERT_AUTH_PASSWORD_MIN_LENGTH,
  ALBERT_AUTH_PASSWORD_REQUIRED_CHARACTERS,
  expectedSupabaseAuthRedirects,
} from "../scripts/supabase-auth-production-policy.mjs";
import { createTransformFleetCapacityAttestation } from "../scripts/transform-fleet-capacity-attestation.mjs";
import { validateRuntimeSecretNames } from "../scripts/validate-runtime-secrets.mjs";

const projectRef = "abcdefghijklmnopqrst";
const releaseSha = "a".repeat(40);
const authoritySha = "b".repeat(40);
const authorityRef = "refs/tags/albert-release-authority-v1";
const releasePlanDigest = "7".repeat(64);
const candidateTransformImageDigest = `sha256:${"9".repeat(64)}`;
const servicesImage = `ghcr.io/tomlidgett1/albert-services@${candidateTransformImageDigest}`;
const capacityP95Ms = 2_500;
const repository = "tomlidgett1/Albert";
const workflowRunId = "123456789";
const workflowRunAttempt = "2";
const workflowRef = `${repository}/.github/workflows/release-authority.yml@${authorityRef}`;
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
  ALBERT_BLOCKING_QUESTIONS_APPROVED_DIGEST: ALBERT_BLOCKING_QUESTIONS_CONTRACT_DIGEST,
  ALBERT_LIGHTSPEED_PRODUCT: "r-series",
  OPENAI_BASE_URL: "https://au.api.openai.com/v1",
  NEXT_PUBLIC_SUPABASE_URL: `https://${projectRef}.supabase.co`,
  ALBERT_PUBLIC_ORIGIN: "https://albert.example",
  ANTHROPIC_ANALYTICS_SERVICE_URL: "https://anthropic.albert.example",
  SEMANTIC_QUERY_SERVICE_URL: "https://semantic.albert.example",
  CUBE_API_URL: "https://cube.albert.example",
  OPERATOR_DIAGNOSTIC_SERVICE_URL: "https://diagnostic.albert.example",
  CODEX_RUNTIME_SERVICE_URL: "https://codex.albert.example",
  SYNC_WORKER_INTERNAL_URL: "https://sync.albert.example",
  WEBHOOK_GATEWAY_PUBLIC_URL: "https://webhooks.albert.example",
  CONTROL_PLANE_MIGRATION_URL:
    `postgresql://albert_control_deployer.${projectRef}:secret@control.example/postgres?sslmode=verify-full`,
  ANALYTICAL_MIGRATION_URL:
    "postgresql://albert_analytical_deployer:secret@analytics.example/postgres?sslmode=require",
  FLY_SEMANTIC_APP: "albert-semantic-prod",
  FLY_CUBE_APP: "albert-cube-prod",
  FLY_ANTHROPIC_APP: "albert-anthropic-prod",
  FLY_SYNC_APP: "albert-sync-prod",
  FLY_TRANSFORM_APP: "albert-transform-prod",
  FLY_WEBHOOK_APP: "albert-webhook-prod",
  FLY_DELETION_APP: "albert-deletion-prod",
  FLY_OPERATOR_DIAGNOSTIC_APP: "albert-diagnostic-prod",
  FLY_CODEX_RUNTIME_APP: "albert-codex-runtime-prod",
  FLY_SYNC_AUTOSCALER_APP: "albert-sync-autoscaler-prod",
  FLY_TRANSFORM_AUTOSCALER_APP: "albert-transform-autoscaler-prod",
  FLY_ORGANIZATION_SLUG: "albert-production",
  ALBERT_SNAPSHOT_P95_MS: String(capacityP95Ms),
  GITHUB_REPOSITORY: repository,
  GITHUB_SHA: authoritySha,
  GITHUB_REF: authorityRef,
  GITHUB_RUN_ID: workflowRunId,
  GITHUB_RUN_ATTEMPT: workflowRunAttempt,
  GITHUB_WORKFLOW_REF: workflowRef,
  ALBERT_RELEASE_AUTHORITY_TOOLING_SHA: authoritySha,
  ALBERT_RELEASE_AUTHORITY_WORKFLOW_REF: workflowRef,
  ALBERT_RELEASE_PLAN_DIGEST: releasePlanDigest,
  ALBERT_RELEASE_SERVICES_IMAGE: servicesImage,
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

const validAuthConfig = Object.freeze({
  site_url: validRelease.ALBERT_PUBLIC_ORIGIN,
  uri_allow_list: expectedSupabaseAuthRedirects(validRelease.ALBERT_PUBLIC_ORIGIN).join(","),
  external_anonymous_users_enabled: false,
  disable_signup: false,
  external_email_enabled: true,
  mailer_autoconfirm: false,
  mailer_allow_unverified_email_sign_ins: false,
  smtp_admin_email: "no-reply@auth.albert.example",
  smtp_host: "smtp.auth.albert.example",
  smtp_port: "587",
  smtp_user: "albert-production",
  smtp_sender_name: "Albert",
  password_min_length: ALBERT_AUTH_PASSWORD_MIN_LENGTH,
  password_required_characters: ALBERT_AUTH_PASSWORD_REQUIRED_CHARACTERS,
  password_hibp_enabled: true,
  refresh_token_rotation_enabled: true,
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
    schemaVersion: 2, kind: "albert_transform_fleet_capacity", stagingEnvironment: "staging",
    stagingCellId: "sydney-capacity-01", nonce: "c".repeat(64), passed: true,
    authority: {
      repository, sha: authoritySha, ref: authorityRef, runId: workflowRunId,
      runAttempt: Number(workflowRunAttempt), job: "attest-transform-fleet-capacity", workflowRef,
    },
    candidate: {
      sha: releaseSha,
      transformImageDigest: candidateTransformImageDigest,
      releasePlanDigest,
    },
    producer: { toolRef: capacityProducerRef, buildDigest: capacityProducerBuildDigest },
    startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(),
    generatedAt: generatedAt.toISOString(), expiresAt: new Date(now + 60 * 60_000).toISOString(),
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
    stagingDeployment: { appName: "albert-transform-capacity", imageDigest: candidateTransformImageDigest, releaseSha, appliedFloor: 4,
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
    }, healthyProject, validAuthConfig),
    /ALBERT_TRANSFORM_FLEET_CAPACITY_ATTESTATION_BASE64/u,
  );
  const envelope = productionCapacityEnvelope();
  const encodedEnvelope = Buffer.from(JSON.stringify(envelope)).toString("base64");
  const result = validateReleaseEnvironment({
    ...validRelease,
    ALBERT_RELEASE_ENVIRONMENT: "production",
    ALBERT_TRANSFORM_FLEET_CAPACITY_ATTESTATION_BASE64: encodedEnvelope,
  }, healthyProject, validAuthConfig);
  assert.equal(result.transformMachineFloor, 4);
  assert.match(result.capacityAttestationDigest, /^[a-f0-9]{64}$/u);

  const replayed = { ...validRelease, ALBERT_RELEASE_ENVIRONMENT: "production",
    GITHUB_RUN_ID: "987654321", ALBERT_TRANSFORM_FLEET_CAPACITY_ATTESTATION_BASE64:
      Buffer.from(JSON.stringify(envelope)).toString("base64") };
  assert.throws(() => validateReleaseEnvironment(replayed, healthyProject, validAuthConfig), /another workflow run/u);
  assert.throws(() => validateReleaseEnvironment({
    ...validRelease,
    ALBERT_RELEASE_ENVIRONMENT: "production",
    ALBERT_CAPACITY_ATTESTOR_BUILD_DIGEST: `sha256:${"1".repeat(64)}`,
    ALBERT_TRANSFORM_FLEET_CAPACITY_ATTESTATION_BASE64:
      Buffer.from(JSON.stringify(envelope)).toString("base64"),
  }, healthyProject, validAuthConfig), /pinned independent build/u);
  assert.throws(() => validateReleaseEnvironment({
    ...validRelease,
    ALBERT_RELEASE_ENVIRONMENT: "production",
    ALBERT_RELEASE_AUTHORITY_TOOLING_SHA: "d".repeat(40),
    ALBERT_TRANSFORM_FLEET_CAPACITY_ATTESTATION_BASE64: encodedEnvelope,
  }, healthyProject, validAuthConfig), /differs from the executing workflow/u);
  assert.throws(() => validateReleaseEnvironment({
    ...validRelease,
    ALBERT_RELEASE_ENVIRONMENT: "production",
    ALBERT_RELEASE_SERVICES_IMAGE:
      `ghcr.io/tomlidgett1/albert-services@sha256:${"8".repeat(64)}`,
    ALBERT_TRANSFORM_FLEET_CAPACITY_ATTESTATION_BASE64: encodedEnvelope,
  }, healthyProject, validAuthConfig), /approved candidate image/u);
  assert.throws(() => validateReleaseEnvironment({
    ...validRelease,
    ALBERT_RELEASE_ENVIRONMENT: "production",
    ALBERT_RELEASE_PLAN_DIGEST: "6".repeat(64),
    ALBERT_TRANSFORM_FLEET_CAPACITY_ATTESTATION_BASE64: encodedEnvelope,
  }, healthyProject, validAuthConfig), /approved release plan/u);
});

test("production release requires explicit approval of the exact blocking-question contract", () => {
  const production = {
    ...validRelease,
    ALBERT_RELEASE_ENVIRONMENT: "production",
    ALBERT_TRANSFORM_FLEET_CAPACITY_ATTESTATION_BASE64:
      Buffer.from(JSON.stringify(productionCapacityEnvelope())).toString("base64"),
  };
  const missing = { ...production };
  delete missing.ALBERT_BLOCKING_QUESTIONS_APPROVED_DIGEST;
  assert.throws(
    () => validateReleaseEnvironment(missing, healthyProject, validAuthConfig),
    /ALBERT_BLOCKING_QUESTIONS_APPROVED_DIGEST is required/u,
  );
  assert.throws(
    () => validateReleaseEnvironment({
      ...production,
      ALBERT_BLOCKING_QUESTIONS_APPROVED_DIGEST: "0".repeat(64),
    }, healthyProject, validAuthConfig),
    /approval digest does not match/u,
  );
});

test("production release fails closed without the exact live Supabase Auth policy", () => {
  const source = {
    ...validRelease,
    ALBERT_RELEASE_ENVIRONMENT: "production",
    ALBERT_TRANSFORM_FLEET_CAPACITY_ATTESTATION_BASE64:
      Buffer.from(JSON.stringify(productionCapacityEnvelope())).toString("base64"),
  };
  assert.throws(
    () => validateReleaseEnvironment(source, healthyProject),
    /live Supabase Auth configuration metadata/u,
  );
  assert.throws(
    () => validateReleaseEnvironment(source, healthyProject, {
      ...validAuthConfig,
      external_anonymous_users_enabled: true,
    }),
    /anonymous users must be disabled/u,
  );
  assert.throws(
    () => validateReleaseEnvironment(source, healthyProject, {
      ...validAuthConfig,
      uri_allow_list: `${validAuthConfig.uri_allow_list},https://attacker.example/callback`,
    }),
    /exact canonical signup and recovery callbacks/u,
  );
});

test("production release metadata fetch reads the exact project and Auth endpoints", async () => {
  const calls = [];
  const source = {
    ALBERT_CONTROL_PLANE_PROJECT_REF: projectRef,
    SUPABASE_MANAGEMENT_TOKEN: "management-token-canary",
    ALBERT_RELEASE_ENVIRONMENT: "production",
  };
  const metadata = await fetchSupabaseReleaseMetadata(source, async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/config/auth")) {
      return new Response(JSON.stringify({
        ...validAuthConfig,
        smtp_pass: "NEVER-OUTPUT-SMTP-PASSWORD",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(healthyProject), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  assert.deepEqual(calls.map(({ url }) => url).sort(), [
    `https://api.supabase.com/v1/projects/${projectRef}`,
    `https://api.supabase.com/v1/projects/${projectRef}/config/auth`,
  ]);
  assert.ok(calls.every(({ init }) => init.method === "GET" && init.redirect === "error"));
  assert.ok(calls.every(({ init }) => init.headers.authorization === "Bearer management-token-canary"));
  assert.deepEqual(metadata.project, healthyProject);
  assert.doesNotMatch(JSON.stringify(metadata.authConfig), /smtp_pass|NEVER-OUTPUT/u);

  calls.length = 0;
  const staging = await fetchSupabaseReleaseMetadata({
    ...source,
    ALBERT_RELEASE_ENVIRONMENT: "staging",
  }, async (url) => {
    calls.push({ url });
    return new Response(JSON.stringify(healthyProject), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  assert.equal(calls.length, 1);
  assert.equal(staging.authConfig, null);
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
  const cube = contract.runtimes.cube;
  const cubeInventory = cube.requiredSecretNames.map((Name) => ({
    Name,
    Digest: "not-a-secret-value",
  }));
  assert.deepEqual(
    validateRuntimeSecretNames(contract, "cube", cubeInventory),
    { runtimeName: "cube", count: cubeInventory.length },
  );
  assert.throws(
    () => validateRuntimeSecretNames(contract, "cube", [
      ...cubeInventory,
      { Name: "ANALYTICAL_MIGRATION_URL", Digest: "forbidden" },
    ]),
    /prohibited secret names/,
  );
  const codex = contract.runtimes["codex-runtime"];
  const codexInventory = codex.requiredSecretNames.map((Name) => ({
    Name,
    Digest: "not-a-secret-value",
  }));
  assert.deepEqual(
    validateRuntimeSecretNames(contract, "codex-runtime", codexInventory),
    { runtimeName: "codex-runtime", count: codexInventory.length },
  );
  assert.throws(
    () => validateRuntimeSecretNames(contract, "codex-runtime", [
      ...codexInventory,
      { Name: "CUBEJS_API_SECRET", Digest: "forbidden" },
    ]),
    /prohibited secret names/,
  );
});
