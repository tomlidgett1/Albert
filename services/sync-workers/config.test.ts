import assert from "node:assert/strict";
import test from "node:test";
import { loadSyncWorkerConfig } from "./src/config.js";

const valid: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  CONTROL_PLANE_DATABASE_URL: "postgresql://worker:secret@control.example:5432/postgres?sslmode=require",
  ANALYTICAL_DATABASE_URL: "postgresql://ingest:secret@analytics.example:5432/postgres?sslmode=require",
  SUPABASE_STORAGE_S3_ENDPOINT: "https://project.storage.supabase.co/storage/v1/s3",
  SUPABASE_STORAGE_S3_REGION: "ap-southeast-2",
  SUPABASE_STORAGE_S3_ACCESS_KEY_ID: "storage-access-key",
  SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY: "storage-secret-key-value",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
  TOKEN_ENCRYPTION_KEY_ID: "v1",
  ALBERT_OAUTH_WORKER_SIGNING_SECRET: "s".repeat(48),
  ALBERT_PUBLIC_ORIGIN: "https://albert.example",
  LIGHTSPEED_CLIENT_ID: "lightspeed-client",
  LIGHTSPEED_CLIENT_SECRET: "lightspeed-secret",
  XERO_CLIENT_ID: "xero-client",
  XERO_WEBHOOK_SIGNING_KEY: "xero-webhook-secret",
  DEPUTY_CLIENT_ID: "deputy-client",
  DEPUTY_CLIENT_SECRET: "deputy-secret",
  DEPUTY_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64url"),
  DEPUTY_WEBHOOK_ENCRYPTION_KEY_ID: "deputy-webhook-v1",
  WEBHOOK_GATEWAY_PUBLIC_URL: "https://webhooks.albert.example",
  ALBERT_WORKER_ID: "sync-worker-01",
  ALBERT_SERVICE_VERSION: "test",
  PORT: "8080",
};

test("sync worker config fails closed when the OAuth-specific HMAC secret is absent", () => {
  const source = { ...valid };
  delete (source as Partial<typeof valid>).ALBERT_OAUTH_WORKER_SIGNING_SECRET;
  assert.throws(() => loadSyncWorkerConfig(source), /ALBERT_OAUTH_WORKER_SIGNING_SECRET/);
});

test("sync worker config accepts only exact HTTPS OAuth callbacks in production", () => {
  const config = loadSyncWorkerConfig(valid);
  assert.ok(config.oauthRedirectUris.has("https://albert.example/api/oauth/xero/callback"));
  assert.equal(config.webhookGatewayPublicUrl, "https://webhooks.albert.example/");
  assert.equal(config.deputyWebhookEncryptionKeys.size, 1);
  assert.equal(config.xeroDailyRequestLimit, 1000);
  assert.throws(
    () => loadSyncWorkerConfig({ ...valid, ALBERT_PUBLIC_ORIGIN: "http://localhost" }),
    /unsupported protocol/,
  );
  assert.equal(loadSyncWorkerConfig({ ...valid, XERO_DAILY_REQUEST_LIMIT: "5000" }).xeroDailyRequestLimit, 5000);
  assert.throws(
    () => loadSyncWorkerConfig({ ...valid, XERO_DAILY_REQUEST_LIMIT: "2500" }),
    /XERO_DAILY_REQUEST_LIMIT/,
  );
  assert.throws(
    () => loadSyncWorkerConfig({
      ...valid,
      DEPUTY_WEBHOOK_ENCRYPTION_KEY: valid.TOKEN_ENCRYPTION_KEY,
    }),
    /distinct encryption keys/,
  );
  assert.throws(
    () => loadSyncWorkerConfig({
      ...valid,
      DEPUTY_WEBHOOK_ENCRYPTION_KEY: `${valid.DEPUTY_WEBHOOK_ENCRYPTION_KEY}!`,
    }),
    /base64url-encoded 256-bit key/,
  );
  const previousKey = Buffer.alloc(32, 9).toString("base64url");
  const rotated = loadSyncWorkerConfig({
    ...valid,
    DEPUTY_WEBHOOK_PREVIOUS_ENCRYPTION_KEYS: JSON.stringify({
      "deputy-webhook-v0": previousKey,
    }),
  });
  assert.equal(rotated.deputyWebhookEncryptionKeys.get("deputy-webhook-v0"), previousKey);
  assert.throws(() => loadSyncWorkerConfig({
    ...valid,
    DEPUTY_WEBHOOK_PREVIOUS_ENCRYPTION_KEYS: JSON.stringify({
      "deputy-webhook-v0": valid.DEPUTY_WEBHOOK_ENCRYPTION_KEY,
    }),
  }), /must not reuse key material/);
  assert.throws(() => loadSyncWorkerConfig({
    ...valid,
    DEPUTY_WEBHOOK_PREVIOUS_ENCRYPTION_KEYS: JSON.stringify({
      "deputy-webhook-v0": valid.TOKEN_ENCRYPTION_KEY,
    }),
  }), /OAuth tokens must use distinct encryption keys/);
});
