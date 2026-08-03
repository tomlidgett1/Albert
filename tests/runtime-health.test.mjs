import assert from "node:assert/strict";
import test from "node:test";
import { inspectRuntimeEnvironment } from "../packages/config/src/env.ts";
import { inspectWebDependencies } from "../packages/config/src/health.ts";

const webEnvironment = Object.freeze({
  NEXT_PUBLIC_SUPABASE_URL: "https://control.example",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable",
  ALBERT_OAUTH_STATE_SECRET: "s".repeat(32),
  ALBERT_OAUTH_WORKER_SIGNING_SECRET: "o".repeat(32),
  ALBERT_SEMANTIC_SIGNING_SECRET: "m".repeat(32),
  ALBERT_USER_HASH_SECRET: "u".repeat(32),
  ALBERT_PUBLIC_ORIGIN: "https://albert.example",
  SYNC_WORKER_INTERNAL_URL: "https://sync.example",
  SEMANTIC_QUERY_SERVICE_URL: "https://semantic.example",
  OPENAI_API_KEY: "test-only",
  OPENAI_BASE_URL: "https://au.api.openai.com/v1",
  LIGHTSPEED_CLIENT_ID: "lightspeed",
  XERO_CLIENT_ID: "xero",
  DEPUTY_CLIENT_ID: "deputy",
});

test("runtime requirements match each production process boundary", () => {
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

  const gateway = inspectRuntimeEnvironment("webhook-gateway", {
    SUPABASE_STORAGE_S3_ENDPOINT: "https://project.storage.supabase.co/storage/v1/s3",
    SUPABASE_STORAGE_S3_REGION: "ap-southeast-2",
    SUPABASE_STORAGE_S3_ACCESS_KEY_ID: "storage-access-key",
    SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY: "storage-secret-key-value",
    CONTROL_PLANE_DATABASE_URL: "postgresql://control.invalid/albert",
    XERO_WEBHOOK_SIGNING_KEY: "xero",
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
    SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY: "storage-secret-key-value",
    CONTROL_PLANE_DATABASE_URL: "postgresql://control.invalid/albert",
    XERO_WEBHOOK_SIGNING_KEY: "xero",
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
    SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY: "storage-secret-key-value",
    CONTROL_PLANE_DATABASE_URL: "postgresql://control.invalid/albert",
    XERO_WEBHOOK_SIGNING_KEY: "xero",
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

test("web readiness probes all real dependencies without exposing configuration", async () => {
  const requested = [];
  const readiness = await inspectWebDependencies(webEnvironment, async (input, init) => {
    requested.push({ url: String(input), apikey: init?.headers?.apikey });
    return new Response(null, { status: 204 });
  });

  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.checks, {
    configuration: true,
    supabaseAuth: true,
    syncWorker: true,
    semanticQuery: true,
  });
  assert.deepEqual(requested.map(({ url }) => url), [
    "https://control.example/auth/v1/health",
    "https://sync.example/readyz",
    "https://semantic.example/readyz",
  ]);
  assert.equal(requested[0].apikey, "publishable");
  assert.equal("url" in readiness, false);
});

test("web readiness fails closed when a dependency is unhealthy", async () => {
  const readiness = await inspectWebDependencies(webEnvironment, async (input) =>
    new Response(null, { status: String(input).includes("semantic") ? 503 : 204 })
  );
  assert.equal(readiness.ready, false);
  assert.equal(readiness.checks.semanticQuery, false);
});
