import {
  loadRawStorageS3Config,
  type RawStorageS3Config,
} from "../../../packages/storage/src/s3.js";
import { loadEncodedAes256Keyring } from "../../../packages/security/src/index.js";
import { loadReplicaWorkerId } from "../../../packages/shared/src/index.js";
import { assertProductionRuntimeBoundary } from "../../../packages/config/src/production-boundary.js";
import {
  loadXeroWebhookInboxKeyring,
  type XeroWebhookInboxKeyring,
} from "./xero-crypto.js";

export type WebhookGatewayConfig = Readonly<{
  controlPlaneDatabaseUrl: string;
  rawStorage: RawStorageS3Config;
  xeroWebhookSigningKey: string;
  xeroWebhookInboxKeyring: XeroWebhookInboxKeyring;
  xeroWebhookEncryptedRetentionDays: number;
  xeroWebhookMetadataRetentionDays: number;
  xeroWebhookPersistenceTimeoutMs: number;
  webhookAttestationKeyId: string;
  webhookAttestationSecret: string;
  xeroWebhookProcessor: Readonly<{
    workerId: string;
    leaseSeconds: number;
    pollIntervalMs: number;
    maxAttempts: number;
    retryBaseSeconds: number;
    retryMaxSeconds: number;
  }>;
  deputyWebhookEncryptionKey: string;
  deputyWebhookEncryptionKeyId: string;
  deputyWebhookEncryptionKeys: ReadonlyMap<string, string>;
  deputyWebhookMaxSkewMs: number;
  serviceVersion: string;
  deploymentId?: string;
  port: number;
}>;

function required(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name]?.trim();
  if (!value) throw new Error(`Albert webhook gateway is missing ${name}.`);
  return value;
}

function boundedInteger(
  source: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(source[name] ?? String(fallback));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function loadWebhookGatewayConfig(
  source: NodeJS.ProcessEnv = process.env,
): WebhookGatewayConfig {
  assertProductionRuntimeBoundary(source, {
    label: "webhook gateway",
    controlProject: true,
    analyticalRegion: false,
    storageRegion: true,
    modelDataResidency: false,
    lightspeedProduct: false,
    databaseLogins: {
      CONTROL_PLANE_DATABASE_URL: "albert_webhook_control_runtime",
    },
  });
  const controlPlaneDatabaseUrl = required(source, "CONTROL_PLANE_DATABASE_URL");
  try {
    if (!["postgres:", "postgresql:"].includes(new URL(controlPlaneDatabaseUrl).protocol)) {
      throw new Error();
    }
  } catch {
    throw new Error("CONTROL_PLANE_DATABASE_URL is not a PostgreSQL URL.");
  }
  const deputyWebhookKeyring = loadEncodedAes256Keyring({
    currentKey: required(source, "DEPUTY_WEBHOOK_ENCRYPTION_KEY"),
    currentKeyId: required(source, "DEPUTY_WEBHOOK_ENCRYPTION_KEY_ID"),
    previousKeysJson: source.DEPUTY_WEBHOOK_PREVIOUS_ENCRYPTION_KEYS,
    keyName: "DEPUTY_WEBHOOK_ENCRYPTION_KEY",
    keyIdName: "DEPUTY_WEBHOOK_ENCRYPTION_KEY_ID",
    previousKeysName: "DEPUTY_WEBHOOK_PREVIOUS_ENCRYPTION_KEYS",
  });
  const deputyWebhookEncryptionKey = deputyWebhookKeyring.currentKey;
  const deputyWebhookEncryptionKeyId = deputyWebhookKeyring.currentKeyId;
  const xeroWebhookInboxKeyring = loadXeroWebhookInboxKeyring(source);
  const deputyKeys = new Set(deputyWebhookKeyring.keys.values());
  const xeroInboxKeys = [...xeroWebhookInboxKeyring.keys.values()]
    .map((key) => Buffer.from(key).toString("base64url"));
  if (xeroInboxKeys.some((key) => deputyKeys.has(key))) {
    throw new Error("Xero inbox and Deputy webhook material must use distinct encryption keys.");
  }
  const xeroWebhookSigningKey = required(source, "XERO_WEBHOOK_SIGNING_KEY");
  const webhookAttestationKeyId = required(source, "WEBHOOK_ATTESTATION_KEY_ID");
  if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(webhookAttestationKeyId)) {
    throw new Error("WEBHOOK_ATTESTATION_KEY_ID is invalid.");
  }
  const webhookAttestationSecret = required(source, "WEBHOOK_ATTESTATION_SECRET");
  const decodedAttestationSecret = Buffer.from(webhookAttestationSecret, "base64url");
  if (!/^[A-Za-z0-9_-]{43}$/u.test(webhookAttestationSecret) ||
      decodedAttestationSecret.byteLength !== 32 ||
      decodedAttestationSecret.toString("base64url") !== webhookAttestationSecret) {
    throw new Error(
      "WEBHOOK_ATTESTATION_SECRET must encode exactly 32 bytes as unpadded base64url.",
    );
  }
  if (xeroInboxKeys.includes(xeroWebhookSigningKey)) {
    throw new Error("The Xero signing key and webhook inbox encryption key must be distinct.");
  }
  if (deputyKeys.has(xeroWebhookSigningKey)) {
    throw new Error("The Xero signing key and Deputy webhook encryption keys must be distinct.");
  }
  if (xeroInboxKeys.includes(webhookAttestationSecret) ||
      deputyKeys.has(webhookAttestationSecret) ||
      webhookAttestationSecret === xeroWebhookSigningKey) {
    throw new Error("Webhook attestation material must be independent from vendor and payload keys.");
  }
  const xeroWebhookEncryptedRetentionDays = boundedInteger(
    source,
    "WEBHOOK_INBOX_ENCRYPTED_RETENTION_DAYS",
    3,
    1,
    7,
  );
  const xeroWebhookMetadataRetentionDays = boundedInteger(
    source,
    "WEBHOOK_INBOX_METADATA_RETENTION_DAYS",
    14,
    xeroWebhookEncryptedRetentionDays,
    30,
  );
  const workerId = loadReplicaWorkerId(
    source,
    "ALBERT_WEBHOOK_WORKER_ID",
    "Albert webhook gateway is missing ALBERT_WEBHOOK_WORKER_ID.",
  );
  const retryBaseSeconds = boundedInteger(
    source,
    "WEBHOOK_INBOX_RETRY_BASE_SECONDS",
    5,
    1,
    300,
  );
  const retryMaxSeconds = boundedInteger(
    source,
    "WEBHOOK_INBOX_RETRY_MAX_SECONDS",
    3_600,
    retryBaseSeconds,
    86_400,
  );
  const deputyWebhookMaxSkewSeconds = Number(source.DEPUTY_WEBHOOK_MAX_SKEW_SECONDS ?? "300");
  if (!Number.isInteger(deputyWebhookMaxSkewSeconds) || deputyWebhookMaxSkewSeconds < 30 || deputyWebhookMaxSkewSeconds > 900) {
    throw new Error("DEPUTY_WEBHOOK_MAX_SKEW_SECONDS must be between 30 and 900.");
  }
  const port = Number(source.WEBHOOK_GATEWAY_PORT ?? "8081");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("WEBHOOK_GATEWAY_PORT is invalid.");
  }
  return Object.freeze({
    controlPlaneDatabaseUrl,
    rawStorage: loadRawStorageS3Config(source, {
      machinePurpose: "webhook",
      passwordEnvironmentName: "ALBERT_RAW_STORAGE_WEBHOOK_PASSWORD",
    }),
    xeroWebhookSigningKey,
    xeroWebhookInboxKeyring,
    xeroWebhookEncryptedRetentionDays,
    xeroWebhookMetadataRetentionDays,
    xeroWebhookPersistenceTimeoutMs: boundedInteger(
      source,
      "WEBHOOK_INBOX_PERSISTENCE_TIMEOUT_MS",
      3_500,
      500,
      4_000,
    ),
    webhookAttestationKeyId,
    webhookAttestationSecret,
    xeroWebhookProcessor: Object.freeze({
      workerId,
      leaseSeconds: boundedInteger(source, "WEBHOOK_INBOX_LEASE_SECONDS", 90, 30, 300),
      pollIntervalMs: boundedInteger(source, "WEBHOOK_INBOX_POLL_MS", 500, 100, 10_000),
      maxAttempts: boundedInteger(source, "WEBHOOK_INBOX_MAX_ATTEMPTS", 12, 1, 100),
      retryBaseSeconds,
      retryMaxSeconds,
    }),
    deputyWebhookEncryptionKey,
    deputyWebhookEncryptionKeyId,
    deputyWebhookEncryptionKeys: deputyWebhookKeyring.keys,
    deputyWebhookMaxSkewMs: deputyWebhookMaxSkewSeconds * 1_000,
    serviceVersion: source.ALBERT_SERVICE_VERSION?.trim() || "development",
    ...(source.ALBERT_DEPLOYMENT_ID?.trim()
      ? { deploymentId: source.ALBERT_DEPLOYMENT_ID.trim() }
      : {}),
    port,
  });
}
