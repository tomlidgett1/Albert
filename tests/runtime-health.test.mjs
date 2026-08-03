import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  inspectRuntimeEnvironment,
  runtimeEnvironmentRequirementNames,
} from "../packages/config/src/env.ts";
import { inspectWebDependencies } from "../packages/config/src/health.ts";

const deploymentContract = JSON.parse(await readFile(
  new URL("../deploy/runtime-contract.json", import.meta.url),
  "utf8",
));

const webEnvironment = Object.freeze({
  NEXT_PUBLIC_SUPABASE_URL: "https://control.example",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable",
  ALBERT_OAUTH_STATE_SECRET: "s".repeat(32),
  ALBERT_OAUTH_WORKER_SIGNING_SECRET: "o".repeat(32),
  ALBERT_SEMANTIC_SIGNING_SECRET: "m".repeat(32),
  ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET: "d".repeat(32),
  ALBERT_USER_HASH_SECRET: "u".repeat(32),
  ALBERT_PUBLIC_ORIGIN: "https://albert.example",
  SYNC_WORKER_INTERNAL_URL: "https://sync.example",
  SEMANTIC_QUERY_SERVICE_URL: "https://semantic.example",
  OPERATOR_DIAGNOSTIC_SERVICE_URL: "https://diagnostic.example",
  OPENAI_API_KEY: "test-only",
  OPENAI_BASE_URL: "https://au.api.openai.com/v1",
  LIGHTSPEED_CLIENT_ID: "lightspeed",
  XERO_CLIENT_ID: "xero",
  DEPUTY_CLIENT_ID: "deputy",
  ALBERT_BUILD_SHA: "a".repeat(40),
  ALBERT_SERVICE_VERSION: "a".repeat(40),
  ALBERT_DEPLOYMENT_ID: "release-1",
});

const productionWebEnvironment = Object.freeze({
  ...webEnvironment,
  NODE_ENV: "production",
  NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  ALBERT_CONTROL_PLANE_PROJECT_REF: "abcdefghijklmnopqrst",
  ALBERT_CONTROL_PLANE_REGION: "ap-southeast-2",
  ALBERT_MODEL_DATA_RESIDENCY_REGION: "au",
  ALBERT_MODEL_DATA_CONTROL_APPROVED: "true",
  ALBERT_LIGHTSPEED_PRODUCT: "r-series",
  ALBERT_CONVERSATION_RUNTIME: "live",
  ALBERT_ALLOW_FIXTURE_RUNTIME: "false",
  ALBERT_SERVICE_VERSION: "a".repeat(40),
  ALBERT_DEPLOYMENT_ID: "release-1",
});

test("runtime requirements match each production process boundary", () => {
  assert.deepEqual(
    [...runtimeEnvironmentRequirementNames("web", true)].sort(),
    [...deploymentContract.runtimes.web.requiredRuntimeValues].sort(),
  );
  assert.equal(inspectRuntimeEnvironment("web", webEnvironment).ready, true);
  const semantic = inspectRuntimeEnvironment("semantic-query", {
    CONTROL_PLANE_DATABASE_URL: "postgresql://control.invalid/albert",
    ANALYTICAL_DATABASE_URL: "postgresql://analytics.invalid/albert",
    ALBERT_SEMANTIC_METADATA_DATABASE_URL: "postgresql://semantic-metadata.invalid/albert",
    ALBERT_SEMANTIC_SIGNING_SECRET: "m".repeat(32),
    OPENAI_API_KEY: "test-only",
    OPENAI_BASE_URL: "https://au.api.openai.com/v1",
  });
  assert.equal(semantic.ready, true);

  const transform = inspectRuntimeEnvironment("transform-worker", {
    TRANSFORM_CONTROL_PLANE_DATABASE_URL: "postgresql://transform-control.invalid/albert",
    TRANSFORM_DATABASE_URL: "postgresql://transform.invalid/albert",
    ALBERT_TRANSFORM_WORKER_ID: "canonical-1",
  });
  assert.equal(transform.ready, true);

  const diagnostic = inspectRuntimeEnvironment("operator-diagnostic", {
    OPERATOR_DIAGNOSTIC_CONTROL_PLANE_DATABASE_URL: "postgresql://control.invalid/albert",
    OPERATOR_DIAGNOSTIC_ANALYTICAL_DATABASE_URL: "postgresql://analytics.invalid/albert",
    ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET: "d".repeat(32),
  });
  assert.equal(diagnostic.ready, true);

  const gateway = inspectRuntimeEnvironment("webhook-gateway", {
    SUPABASE_STORAGE_S3_ENDPOINT: "https://project.storage.supabase.co/storage/v1/s3",
    SUPABASE_STORAGE_S3_REGION: "ap-southeast-2",
    SUPABASE_STORAGE_S3_ACCESS_KEY_ID: "storage-access-key",
    SUPABASE_STORAGE_S3_LEGACY_ANON_KEY: "legacy-anon-jwt",
    ALBERT_RAW_STORAGE_WEBHOOK_PASSWORD: "webhook-machine-password-material-000001",
    CONTROL_PLANE_DATABASE_URL: "postgresql://control.invalid/albert",
    XERO_WEBHOOK_SIGNING_KEY: "xero",
    WEBHOOK_ATTESTATION_KEY_ID: "webhook-attestation-v1",
    WEBHOOK_ATTESTATION_SECRET: Buffer.alloc(32, 11).toString("base64url"),
    WEBHOOK_INBOX_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64url"),
    WEBHOOK_INBOX_ENCRYPTION_KEY_ID: "xero-inbox-v1",
    ALBERT_WEBHOOK_WORKER_ID: "webhook-worker-1",
    DEPUTY_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64url"),
    DEPUTY_WEBHOOK_ENCRYPTION_KEY_ID: "deputy-webhook-v1",
  });
  assert.equal(gateway.ready, true);
  assert.deepEqual(gateway.missing, []);
  const invalidRotation = inspectRuntimeEnvironment("webhook-gateway", {
    SUPABASE_STORAGE_S3_ENDPOINT: "https://project.storage.supabase.co/storage/v1/s3",
    SUPABASE_STORAGE_S3_REGION: "ap-southeast-2",
    SUPABASE_STORAGE_S3_ACCESS_KEY_ID: "storage-access-key",
    SUPABASE_STORAGE_S3_LEGACY_ANON_KEY: "legacy-anon-jwt",
    ALBERT_RAW_STORAGE_WEBHOOK_PASSWORD: "webhook-machine-password-material-000001",
    CONTROL_PLANE_DATABASE_URL: "postgresql://control.invalid/albert",
    XERO_WEBHOOK_SIGNING_KEY: "xero",
    WEBHOOK_ATTESTATION_KEY_ID: "webhook-attestation-v1",
    WEBHOOK_ATTESTATION_SECRET: Buffer.alloc(32, 11).toString("base64url"),
    WEBHOOK_INBOX_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64url"),
    WEBHOOK_INBOX_ENCRYPTION_KEY_ID: "xero-inbox-v1",
    ALBERT_WEBHOOK_WORKER_ID: "webhook-worker-1",
    DEPUTY_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64url"),
    DEPUTY_WEBHOOK_ENCRYPTION_KEY_ID: "deputy-webhook-v2",
    DEPUTY_WEBHOOK_PREVIOUS_ENCRYPTION_KEYS: JSON.stringify({
      "deputy-webhook-v1": Buffer.alloc(32, 9).toString("base64url"),
    }),
  });
  assert.equal(invalidRotation.ready, false);
  assert.ok(invalidRotation.invalid.includes("DEPUTY_WEBHOOK_PREVIOUS_ENCRYPTION_KEYS"));

  const reusedAcrossWebhookTrustZones = inspectRuntimeEnvironment("webhook-gateway", {
    SUPABASE_STORAGE_S3_ENDPOINT: "https://project.storage.supabase.co/storage/v1/s3",
    SUPABASE_STORAGE_S3_REGION: "ap-southeast-2",
    SUPABASE_STORAGE_S3_ACCESS_KEY_ID: "storage-access-key",
    SUPABASE_STORAGE_S3_LEGACY_ANON_KEY: "legacy-anon-jwt",
    ALBERT_RAW_STORAGE_WEBHOOK_PASSWORD: "webhook-machine-password-material-000001",
    CONTROL_PLANE_DATABASE_URL: "postgresql://control.invalid/albert",
    XERO_WEBHOOK_SIGNING_KEY: "xero",
    WEBHOOK_ATTESTATION_KEY_ID: "webhook-attestation-v1",
    WEBHOOK_ATTESTATION_SECRET: Buffer.alloc(32, 11).toString("base64url"),
    WEBHOOK_INBOX_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64url"),
    WEBHOOK_INBOX_ENCRYPTION_KEY_ID: "xero-inbox-v2",
    WEBHOOK_INBOX_PREVIOUS_ENCRYPTION_KEYS: JSON.stringify({
      "xero-inbox-v1": Buffer.alloc(32, 9).toString("base64url"),
    }),
    ALBERT_WEBHOOK_WORKER_ID: "webhook-worker-1",
    DEPUTY_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64url"),
    DEPUTY_WEBHOOK_ENCRYPTION_KEY_ID: "deputy-webhook-v1",
  });
  assert.equal(reusedAcrossWebhookTrustZones.ready, false);
  assert.ok(reusedAcrossWebhookTrustZones.invalid.includes("WEBHOOK_INBOX_ENCRYPTION_KEY"));
});

test("production runtimes reject local HTTP and credential-bearing service URLs", () => {
  const localHttp = inspectRuntimeEnvironment("web", {
    ...webEnvironment,
    NODE_ENV: "production",
    ALBERT_PUBLIC_ORIGIN: "http://localhost:3000",
  });
  assert.equal(localHttp.ready, false);
  assert.ok(localHttp.invalid.includes("ALBERT_PUBLIC_ORIGIN"));

  const nonOriginPublicUrl = inspectRuntimeEnvironment("web", {
    ...webEnvironment,
    NODE_ENV: "production",
    ALBERT_PUBLIC_ORIGIN: "https://albert.example/callback?unsafe=true",
  });
  assert.equal(nonOriginPublicUrl.ready, false);
  assert.ok(nonOriginPublicUrl.invalid.includes("ALBERT_PUBLIC_ORIGIN"));

  const embeddedCredentials = inspectRuntimeEnvironment("web", {
    ...webEnvironment,
    NODE_ENV: "production",
    SEMANTIC_QUERY_SERVICE_URL: "https://runtime-user:runtime-secret@semantic.example",
  });
  assert.equal(embeddedCredentials.ready, false);
  assert.ok(embeddedCredentials.invalid.includes("SEMANTIC_QUERY_SERVICE_URL"));

  const diagnosticCredentials = inspectRuntimeEnvironment("web", {
    ...productionWebEnvironment,
    OPERATOR_DIAGNOSTIC_SERVICE_URL: "https://runtime-user:runtime-secret@diagnostic.example",
  });
  assert.equal(diagnosticCredentials.ready, false);
  assert.ok(diagnosticCredentials.invalid.includes("OPERATOR_DIAGNOSTIC_SERVICE_URL"));

  const insecureDiagnostic = inspectRuntimeEnvironment("web", {
    ...productionWebEnvironment,
    OPERATOR_DIAGNOSTIC_SERVICE_URL: "http://diagnostic.example",
  });
  assert.equal(insecureDiagnostic.ready, false);
  assert.ok(insecureDiagnostic.invalid.includes("OPERATOR_DIAGNOSTIC_SERVICE_URL"));

  const reusedDiagnosticSecret = inspectRuntimeEnvironment("web", {
    ...productionWebEnvironment,
    ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET: productionWebEnvironment.ALBERT_SEMANTIC_SIGNING_SECRET,
  });
  assert.equal(reusedDiagnosticSecret.ready, false);
  assert.ok(reusedDiagnosticSecret.invalid.includes("ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET"));

  const localDevelopment = inspectRuntimeEnvironment("web", {
    ...webEnvironment,
    NODE_ENV: "development",
    ALBERT_PUBLIC_ORIGIN: "http://localhost:3000",
  });
  assert.equal(localDevelopment.ready, true);
});

test("production web and semantic runtimes bind Sydney, AU data residency, live data, and exact database logins", () => {
  assert.equal(inspectRuntimeEnvironment("web", productionWebEnvironment).ready, true);
  for (const [name, value] of [
    ["ALBERT_CONTROL_PLANE_REGION", "ap-northeast-1"],
    ["ALBERT_MODEL_DATA_CONTROL_APPROVED", "false"],
    ["ALBERT_LIGHTSPEED_PRODUCT", "x-series"],
    ["ALBERT_CONVERSATION_RUNTIME", "fixture"],
    ["ALBERT_ALLOW_FIXTURE_RUNTIME", "true"],
  ]) {
    const result = inspectRuntimeEnvironment("web", {
      ...productionWebEnvironment,
      [name]: value,
    });
    assert.equal(result.ready, false);
    assert.ok(result.invalid.includes(name));
  }
  const overprivilegedWeb = inspectRuntimeEnvironment("web", {
    ...productionWebEnvironment,
    CONTROL_PLANE_DATABASE_URL:
      "postgresql://postgres:secret@control.example/postgres?sslmode=require",
  });
  assert.equal(overprivilegedWeb.ready, false);
  assert.ok(overprivilegedWeb.invalid.includes("CONTROL_PLANE_DATABASE_URL"));

  const semantic = {
    NODE_ENV: "production",
    ALBERT_CONTROL_PLANE_PROJECT_REF: "abcdefghijklmnopqrst",
    CONTROL_PLANE_DATABASE_URL:
      "postgresql://albert_semantic_control_runtime.abcdefghijklmnopqrst:secret@control.example/postgres?sslmode=require",
    ANALYTICAL_DATABASE_URL:
      "postgresql://albert_semantic_read_runtime:secret@analytics.example/postgres?sslmode=verify-full",
    ALBERT_SEMANTIC_METADATA_DATABASE_URL:
      "postgresql://albert_semantic_metadata_runtime:secret@analytics.example/postgres?sslmode=verify-full",
    ALBERT_SEMANTIC_SIGNING_SECRET: "m".repeat(32),
    OPENAI_API_KEY: "test-only",
    OPENAI_BASE_URL: "https://au.api.openai.com/v1",
    ALBERT_CONTROL_PLANE_REGION: "ap-southeast-2",
    ALBERT_ANALYTICAL_REGION: "ap-southeast-2",
    ALBERT_MODEL_DATA_RESIDENCY_REGION: "au",
    ALBERT_MODEL_DATA_CONTROL_APPROVED: "true",
    ALBERT_SERVICE_VERSION: "b".repeat(40),
    ALBERT_DEPLOYMENT_ID: "release-2",
  };
  assert.equal(inspectRuntimeEnvironment("semantic-query", semantic).ready, true);
  const adminCredential = inspectRuntimeEnvironment("semantic-query", {
    ...semantic,
    ANALYTICAL_DATABASE_URL:
      "postgresql://postgres:secret@analytics.example/postgres?sslmode=verify-full",
  });
  assert.equal(adminCredential.ready, false);
  assert.ok(adminCredential.invalid.includes("ANALYTICAL_DATABASE_URL"));
});

test("web readiness probes all real dependencies without exposing configuration", async () => {
  const requested = [];
  const readiness = await inspectWebDependencies(webEnvironment, async (input, init) => {
    requested.push({ url: String(input), apikey: init?.headers?.apikey });
    return String(input).includes("/auth/v1/health")
      ? new Response(null, { status: 204 })
      : Response.json({
          ready: true,
          status: "ready",
          releaseSha: "a".repeat(40),
          deploymentId: "release-1",
        });
  }, webEnvironment.ALBERT_BUILD_SHA);

  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.checks, {
    configuration: true,
    releaseIdentity: true,
    supabaseAuth: true,
    syncWorker: true,
    semanticQuery: true,
    operatorDiagnostic: true,
  });
  assert.deepEqual(requested.map(({ url }) => url), [
    "https://control.example/auth/v1/health",
    "https://sync.example/readyz",
    "https://semantic.example/readyz",
    "https://diagnostic.example/readyz",
  ]);
  assert.equal(requested[0].apikey, "publishable");
  assert.equal("url" in readiness, false);
});

test("web readiness fails closed when a dependency is unhealthy", async () => {
  const readiness = await inspectWebDependencies(webEnvironment, async (input) => {
    if (String(input).includes("/auth/v1/health")) return new Response(null, { status: 204 });
    return Response.json({
      ready: true,
      releaseSha: "a".repeat(40),
      deploymentId: "release-1",
    }, { status: String(input).includes("semantic") ? 503 : 200 });
  }, webEnvironment.ALBERT_BUILD_SHA);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.checks.semanticQuery, false);
});

test("web readiness rejects runtime relabelling and mixed service deployments", async () => {
  let calls = 0;
  const relabelled = await inspectWebDependencies(webEnvironment, async () => {
    calls += 1;
    return Response.json({ ready: true });
  }, "b".repeat(40));
  assert.equal(relabelled.ready, false);
  assert.equal(relabelled.checks.configuration, true);
  assert.equal(relabelled.checks.releaseIdentity, false);
  assert.equal(calls, 0, "a relabelled web bundle must fail before dependency probes");

  const mixed = await inspectWebDependencies(webEnvironment, async (input) => {
    if (String(input).includes("/auth/v1/health")) return new Response(null, { status: 204 });
    return Response.json({
      ready: true,
      releaseSha: String(input).includes("semantic") ? "b".repeat(40) : "a".repeat(40),
      deploymentId: String(input).includes("diagnostic") ? "older-release" : "release-1",
    });
  }, webEnvironment.ALBERT_BUILD_SHA);
  assert.equal(mixed.ready, false);
  assert.equal(mixed.checks.semanticQuery, false);
  assert.equal(mixed.checks.operatorDiagnostic, false);
});

test("web readiness rejects oversized or malformed service evidence", async () => {
  for (const body of ["not-json", JSON.stringify({ padding: "x".repeat(4_096) })]) {
    const readiness = await inspectWebDependencies(webEnvironment, async (input) => {
      if (String(input).includes("/auth/v1/health")) return new Response(null, { status: 204 });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }, webEnvironment.ALBERT_BUILD_SHA);
    assert.equal(readiness.ready, false);
    assert.equal(readiness.checks.syncWorker, false);
  }
});
