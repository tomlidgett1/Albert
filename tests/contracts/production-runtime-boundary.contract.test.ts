import assert from "node:assert/strict";
import test from "node:test";
import { assertProductionRuntimeBoundary } from "../../packages/config/src/production-boundary.js";

const projectRef = "abcdefghijklmnopqrst";
const base: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  ALBERT_CONTROL_PLANE_PROJECT_REF: projectRef,
  ALBERT_CONTROL_PLANE_REGION: "ap-southeast-2",
  ALBERT_ANALYTICAL_REGION: "ap-southeast-2",
  SUPABASE_STORAGE_S3_REGION: "ap-southeast-2",
  SUPABASE_STORAGE_S3_ENDPOINT:
    `https://${projectRef}.storage.supabase.co/storage/v1/s3`,
  ALBERT_MODEL_DATA_RESIDENCY_REGION: "au",
  ALBERT_MODEL_DATA_CONTROL_APPROVED: "true",
  OPENAI_BASE_URL: "https://au.api.openai.com/v1",
  ALBERT_LIGHTSPEED_PRODUCT: "r-series",
  ALBERT_SERVICE_VERSION: "a".repeat(40),
  ALBERT_DEPLOYMENT_ID: "release-1",
  CONTROL_PLANE_DATABASE_URL:
    `postgresql://albert_sync_control_runtime.${projectRef}:secret@control.example/postgres?sslmode=require`,
  ANALYTICAL_DATABASE_URL:
    "postgresql://albert_ingest_runtime:secret@analytics.example/postgres?sslmode=verify-full",
};

const boundary = Object.freeze({
  label: "sync worker",
  controlProject: true,
  analyticalRegion: true,
  storageRegion: true,
  modelDataResidency: false,
  lightspeedProduct: true,
  databaseLogins: Object.freeze({
    CONTROL_PLANE_DATABASE_URL: "albert_sync_control_runtime",
    ANALYTICAL_DATABASE_URL: "albert_ingest_runtime",
  }),
  distinctDatabaseVariables: [
    "CONTROL_PLANE_DATABASE_URL",
    "ANALYTICAL_DATABASE_URL",
  ] as const,
});

test("production runtime boundary accepts only the declared Sydney least-privilege cell", () => {
  assert.doesNotThrow(() => assertProductionRuntimeBoundary(base, boundary));
  assert.throws(
    () => assertProductionRuntimeBoundary({
      ...base,
      CONTROL_PLANE_DATABASE_URL:
        `postgresql://postgres.${projectRef}:secret@control.example/postgres?sslmode=require`,
    }, boundary),
    /albert_sync_control_runtime/,
  );
  assert.throws(
    () => assertProductionRuntimeBoundary({
      ...base,
      ALBERT_CONTROL_PLANE_REGION: "ap-northeast-1",
    }, boundary),
    /ap-southeast-2/,
  );
  assert.throws(
    () => assertProductionRuntimeBoundary({
      ...base,
      SUPABASE_STORAGE_S3_ENDPOINT:
        "https://wrongprojectrefxxxx.storage.supabase.co/storage/v1/s3",
    }, boundary),
    /selected control project/,
  );
  assert.throws(
    () => assertProductionRuntimeBoundary({
      ...base,
      ANALYTICAL_DATABASE_URL:
        `postgresql://albert_ingest_runtime.${projectRef}:secret@control.example/postgres?sslmode=require`,
    }, boundary),
    /separate databases/,
  );
});

test("development remains usable without production deployment metadata", () => {
  assert.doesNotThrow(() => assertProductionRuntimeBoundary(
    { NODE_ENV: "development" },
    boundary,
  ));
});
