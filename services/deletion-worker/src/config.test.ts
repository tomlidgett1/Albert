import assert from "node:assert/strict";
import test from "node:test";
import { loadDeletionWorkerConfig } from "./config.js";

const valid: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  CONTROL_PLANE_DATABASE_URL: "postgresql://deletion_control:secret@control.example:5432/postgres?sslmode=require",
  DELETION_ANALYTICAL_DATABASE_URL: "postgresql://deletion_analytics:secret@analytics.example:5432/postgres?sslmode=require",
  SUPABASE_STORAGE_S3_ENDPOINT: "https://project.storage.supabase.co/storage/v1/s3",
  SUPABASE_STORAGE_S3_REGION: "ap-southeast-2",
  SUPABASE_STORAGE_S3_ACCESS_KEY_ID: "deletion-storage-access-key",
  SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY: "deletion-storage-secret-key",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString("base64url"),
  TOKEN_ENCRYPTION_KEY_ID: "deletion-v1",
  LIGHTSPEED_CLIENT_ID: "lightspeed-client",
  LIGHTSPEED_CLIENT_SECRET: "lightspeed-secret",
  XERO_CLIENT_ID: "xero-client",
  DELETION_PROOF_HMAC_KEY: "p".repeat(48),
  ALBERT_DELETION_WORKER_ID: "deletion-worker-01",
  ALBERT_SERVICE_VERSION: "test",
};

test("deletion config requires a dedicated analytical login", () => {
  const source = { ...valid };
  delete source.DELETION_ANALYTICAL_DATABASE_URL;
  source.ANALYTICAL_DATABASE_URL = "postgresql://ingest:secret@analytics.example/postgres";
  assert.throws(
    () => loadDeletionWorkerConfig(source),
    /DELETION_ANALYTICAL_DATABASE_URL/,
  );
});

test("deletion config excludes service-role, webhook, and sync settings", () => {
  const config = loadDeletionWorkerConfig({
    ...valid,
    SUPABASE_SERVICE_ROLE_KEY: "must-not-load",
    XERO_WEBHOOK_SIGNING_KEY: "must-not-load",
    DEPUTY_WEBHOOK_SHARED_SECRET: "must-not-load",
    MAPPING_VERSION: "must-not-load",
  });
  const serialized = JSON.stringify(config);
  assert.doesNotMatch(serialized, /must-not-load/);
  assert.equal(config.analyticalDatabaseUrl, valid.DELETION_ANALYTICAL_DATABASE_URL);
  assert.equal(config.rawStorage.bucket, "raw-payloads");
});
