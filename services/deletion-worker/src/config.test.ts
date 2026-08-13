import assert from "node:assert/strict";
import test from "node:test";
import { loadDeletionWorkerConfig } from "./config.js";

const legacyAnonKey = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.signature";

const valid: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  CONTROL_PLANE_DATABASE_URL: "postgresql://albert_deletion_control_runtime.abcdefghijklmnopqrst:secret@control.example:5432/postgres?sslmode=require",
  DELETION_ANALYTICAL_DATABASE_URL: "postgresql://albert_deletion_analytical_runtime:secret@analytics.example:5432/postgres?sslmode=require",
  ALBERT_CONTROL_PLANE_PROJECT_REF: "abcdefghijklmnopqrst",
  ALBERT_CONTROL_PLANE_REGION: "ap-southeast-2",
  ALBERT_ANALYTICAL_REGION: "ap-southeast-2",
  SUPABASE_STORAGE_S3_ENDPOINT: "https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/s3",
  SUPABASE_STORAGE_S3_REGION: "ap-southeast-2",
  SUPABASE_STORAGE_S3_ACCESS_KEY_ID: "abcdefghijklmnopqrst",
  SUPABASE_STORAGE_S3_LEGACY_ANON_KEY: legacyAnonKey,
  ALBERT_RAW_STORAGE_DELETION_PASSWORD: "deletion-machine-password-material-00001",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString("base64url"),
  TOKEN_ENCRYPTION_KEY_ID: "deletion-v1",
  LIGHTSPEED_CLIENT_ID: "lightspeed-client",
  LIGHTSPEED_CLIENT_SECRET: "lightspeed-secret",
  ALBERT_PUBLIC_ORIGIN: "https://albert.example",
  SQUARE_CLIENT_ID: "square-client",
  SQUARE_CLIENT_SECRET: "square-secret",
  XERO_CLIENT_ID: "xero-client",
  DELETION_PROOF_HMAC_KEY: "p".repeat(48),
  ALBERT_DELETION_WORKER_ID: "deletion-worker-01",
  ALBERT_WORKER_INSTANCE_ID: "deletion-test-01",
  ALBERT_SERVICE_VERSION: "a".repeat(40),
  ALBERT_DEPLOYMENT_ID: "test-deployment-1",
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
    SHOPIFY_CLIENT_ID: "must-not-load",
    SHOPIFY_CLIENT_SECRET: "must-not-load",
    MAPPING_VERSION: "must-not-load",
  });
  const serialized = JSON.stringify(config);
  assert.doesNotMatch(serialized, /must-not-load/);
  assert.equal(config.analyticalDatabaseUrl, valid.DELETION_ANALYTICAL_DATABASE_URL);
  assert.equal(config.rawStorage.bucket, "raw-payloads");
});

test("Shopify local destruction does not grant the deletion worker app-wide credentials", () => {
  const config = loadDeletionWorkerConfig({
    ...valid,
    SHOPIFY_CLIENT_ID: "shopify-client-must-not-load",
    SHOPIFY_CLIENT_SECRET: "shopify-secret-must-not-load",
  });
  assert.doesNotMatch(JSON.stringify(config), /shopify-(?:client|secret)-must-not-load/u);
});

test("deletion config requires the Square revocation registration and exact callback origin", () => {
  const missingSquare = { ...valid };
  delete missingSquare.SQUARE_CLIENT_SECRET;
  assert.throws(
    () => loadDeletionWorkerConfig(missingSquare),
    /SQUARE_CLIENT_SECRET/u,
  );
  assert.throws(
    () => loadDeletionWorkerConfig({ ...valid, ALBERT_PUBLIC_ORIGIN: "http://albert.example" }),
    /clean HTTPS origin/u,
  );
  assert.equal(
    loadDeletionWorkerConfig(valid).squareRedirectUri,
    "https://albert.example/api/oauth/square/callback",
  );
});

test("deletion config namespaces leases to the running Fly machine", () => {
  const config = loadDeletionWorkerConfig({ ...valid, FLY_MACHINE_ID: "90801abcdef123" });
  assert.equal(config.workerId, "deletion-worker-01:90801abcdef123");
});

test("deletion worker retains decrypt access to overlap token KEKs", () => {
  const previous = Buffer.alloc(32, 10).toString("base64url");
  const config = loadDeletionWorkerConfig({
    ...valid,
    TOKEN_PREVIOUS_ENCRYPTION_KEYS: JSON.stringify({ "deletion-v0": previous }),
  });
  assert.equal(config.tokenEncryptionKeys.get("deletion-v0"), previous);
  assert.equal(config.tokenEncryptionKeys.get("deletion-v1"), valid.TOKEN_ENCRYPTION_KEY);

  assert.throws(
    () => loadDeletionWorkerConfig({
      ...valid,
      TOKEN_PREVIOUS_ENCRYPTION_KEYS: JSON.stringify({
        "deletion-v0": valid.TOKEN_ENCRYPTION_KEY,
      }),
    }),
    /reuse key material/,
  );
});
