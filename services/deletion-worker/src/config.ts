import {
  loadRawStorageS3Config,
  type RawStorageS3Config,
} from "../../../packages/storage/src/s3.js";
import { loadReplicaWorkerId } from "../../../packages/shared/src/index.js";
import { assertProductionRuntimeBoundary } from "../../../packages/config/src/production-boundary.js";
import { loadEncodedAes256Keyring } from "../../../packages/security/src/index.js";

export type DeletionWorkerConfig = Readonly<{
  controlPlaneDatabaseUrl: string;
  analyticalDatabaseUrl: string;
  rawStorage: RawStorageS3Config;
  tokenEncryptionKey: string;
  tokenEncryptionKeys: ReadonlyMap<string, string>;
  tokenKeyReference: string;
  tokenKeyVersion: string;
  lightspeedClientId: string;
  lightspeedClientSecret: string;
  xeroClientId: string;
  proofHmacKey: string;
  workerId: string;
  serviceVersion: string;
  port: number;
  pollDelayMs: number;
}>;

function required(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name]?.trim();
  if (!value) throw new Error(`Albert deletion worker is missing ${name}.`);
  return value;
}

function databaseUrl(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL.`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${name} must be a PostgreSQL URL.`);
  }
  return value;
}

export function loadDeletionWorkerConfig(
  source: NodeJS.ProcessEnv = process.env,
): DeletionWorkerConfig {
  assertProductionRuntimeBoundary(source, {
    label: "deletion worker",
    controlProject: true,
    analyticalRegion: true,
    storageRegion: true,
    modelDataResidency: false,
    lightspeedProduct: false,
    databaseLogins: {
      CONTROL_PLANE_DATABASE_URL: "albert_deletion_control_runtime",
      DELETION_ANALYTICAL_DATABASE_URL: "albert_deletion_analytical_runtime",
    },
    distinctDatabaseVariables: ["CONTROL_PLANE_DATABASE_URL", "DELETION_ANALYTICAL_DATABASE_URL"],
  });
  const tokenEncryptionKey = required(source, "TOKEN_ENCRYPTION_KEY");
  const tokenKeyVersion = required(source, "TOKEN_ENCRYPTION_KEY_ID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(tokenKeyVersion)) {
    throw new Error("TOKEN_ENCRYPTION_KEY_ID is invalid.");
  }
  const tokenKeyring = loadEncodedAes256Keyring({
    currentKey: tokenEncryptionKey,
    currentKeyId: tokenKeyVersion,
    previousKeysJson: source.TOKEN_PREVIOUS_ENCRYPTION_KEYS,
    keyName: "TOKEN_ENCRYPTION_KEY",
    keyIdName: "TOKEN_ENCRYPTION_KEY_ID",
    previousKeysName: "TOKEN_PREVIOUS_ENCRYPTION_KEYS",
    maxPreviousKeys: 4,
  });
  const proofHmacKey = required(source, "DELETION_PROOF_HMAC_KEY");
  if (Buffer.byteLength(proofHmacKey, "utf8") < 32) {
    throw new Error("DELETION_PROOF_HMAC_KEY must contain at least 32 bytes.");
  }
  const workerId = loadReplicaWorkerId(
    source,
    "ALBERT_DELETION_WORKER_ID",
    "Albert deletion worker is missing ALBERT_DELETION_WORKER_ID.",
  );
  const port = Number(source.DELETION_WORKER_PORT ?? "8083");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("DELETION_WORKER_PORT is invalid.");
  }
  const pollDelayMs = Number(source.DELETION_WORKER_POLL_MS ?? "1000");
  if (!Number.isInteger(pollDelayMs) || pollDelayMs < 100 || pollDelayMs > 60_000) {
    throw new Error("DELETION_WORKER_POLL_MS must be an integer from 100 to 60000.");
  }
  return Object.freeze({
    controlPlaneDatabaseUrl: databaseUrl(
      required(source, "CONTROL_PLANE_DATABASE_URL"),
      "CONTROL_PLANE_DATABASE_URL",
    ),
    analyticalDatabaseUrl: databaseUrl(
      required(source, "DELETION_ANALYTICAL_DATABASE_URL"),
      "DELETION_ANALYTICAL_DATABASE_URL",
    ),
    rawStorage: loadRawStorageS3Config(source, {
      machinePurpose: "deletion",
      passwordEnvironmentName: "ALBERT_RAW_STORAGE_DELETION_PASSWORD",
    }),
    tokenEncryptionKey: tokenKeyring.currentKey,
    tokenEncryptionKeys: tokenKeyring.keys,
    tokenKeyReference: "env:TOKEN_ENCRYPTION_KEY",
    tokenKeyVersion,
    lightspeedClientId: required(source, "LIGHTSPEED_CLIENT_ID"),
    lightspeedClientSecret: required(source, "LIGHTSPEED_CLIENT_SECRET"),
    xeroClientId: required(source, "XERO_CLIENT_ID"),
    proofHmacKey,
    workerId,
    serviceVersion: source.ALBERT_SERVICE_VERSION?.trim() || "development",
    port,
    pollDelayMs,
  });
}
