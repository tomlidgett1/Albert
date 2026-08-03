import { loadEncodedAes256Keyring } from "../../../packages/security/src/index.js";
import { loadRawStorageS3Config,type RawStorageS3Config } from "../../../packages/storage/src/index.js";

export type SyncWorkerConfig = Readonly<{
  controlPlaneDatabaseUrl: string;
  analyticalDatabaseUrl: string;
  rawStorage: RawStorageS3Config;
  tokenEncryptionKey: string;
  tokenKeyReference: string;
  tokenKeyVersion: string;
  oauthWorkerSigningSecret: string;
  oauthRedirectUris: ReadonlySet<string>;
  lightspeedClientId: string;
  lightspeedClientSecret: string;
  xeroClientId: string;
  xeroWebhookSigningKey: string;
  xeroEnableAdvancedJournals: boolean;
  xeroDailyRequestLimit: 1000 | 5000;
  deputyClientId: string;
  deputyClientSecret: string;
  deputyRedirectUri: string;
  deputyWebhookEncryptionKey: string;
  deputyWebhookEncryptionKeyId: string;
  deputyWebhookEncryptionKeys: ReadonlyMap<string, string>;
  webhookGatewayPublicUrl: string;
  mappingVersion: string;
  workerId: string;
  serviceVersion: string;
  port: number;
}>;

function required(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name]?.trim();
  if (!value) throw new Error(`Albert sync worker is missing ${name}.`);
  return value;
}

function url(value: string, name: string, protocols: readonly string[]) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL.`);
  }
  if (!protocols.includes(parsed.protocol)) throw new Error(`${name} uses an unsupported protocol.`);
  return parsed;
}

export function loadSyncWorkerConfig(source: NodeJS.ProcessEnv = process.env): SyncWorkerConfig {
  const control = required(source, "CONTROL_PLANE_DATABASE_URL");
  const analytical = required(source, "ANALYTICAL_DATABASE_URL");
  url(control, "CONTROL_PLANE_DATABASE_URL", ["postgres:", "postgresql:"]);
  url(analytical, "ANALYTICAL_DATABASE_URL", ["postgres:", "postgresql:"]);
  const publicOrigin = url(
    required(source, "ALBERT_PUBLIC_ORIGIN"),
    "ALBERT_PUBLIC_ORIGIN",
    source.NODE_ENV === "production" ? ["https:"] : ["https:", "http:"],
  );
  if (
    publicOrigin.pathname !== "/" || publicOrigin.search || publicOrigin.hash ||
    publicOrigin.username || publicOrigin.password
  ) {
    throw new Error("ALBERT_PUBLIC_ORIGIN must be a clean public origin.");
  }
  const redirectValues = ["lightspeed", "xero", "deputy"].map((provider) =>
    new URL(`/api/oauth/${provider}/callback`, publicOrigin).toString()
  );
  const port = Number(source.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT is invalid.");

  const tokenEncryptionKey = required(source, "TOKEN_ENCRYPTION_KEY");
  if (Buffer.from(tokenEncryptionKey, "base64url").byteLength !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a base64url-encoded 256-bit KEK.");
  }
  const oauthWorkerSigningSecret = required(source, "ALBERT_OAUTH_WORKER_SIGNING_SECRET");
  if (Buffer.byteLength(oauthWorkerSigningSecret, "utf8") < 32) {
    throw new Error("ALBERT_OAUTH_WORKER_SIGNING_SECRET must contain at least 32 bytes.");
  }
  const tokenKeyVersion = required(source, "TOKEN_ENCRYPTION_KEY_ID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(tokenKeyVersion)) {
    throw new Error("TOKEN_ENCRYPTION_KEY_ID is invalid.");
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
  if ([...deputyWebhookKeyring.keys.values()].includes(tokenEncryptionKey)) {
    throw new Error("Deputy webhook material and OAuth tokens must use distinct encryption keys.");
  }
  const deputyWebhookEncryptionKeyId = deputyWebhookKeyring.currentKeyId;
  const webhookGatewayPublicUrl = url(
    required(source, "WEBHOOK_GATEWAY_PUBLIC_URL"),
    "WEBHOOK_GATEWAY_PUBLIC_URL",
    ["https:"],
  );
  if (
    webhookGatewayPublicUrl.pathname !== "/" || webhookGatewayPublicUrl.search ||
    webhookGatewayPublicUrl.hash || webhookGatewayPublicUrl.username || webhookGatewayPublicUrl.password
  ) throw new Error("WEBHOOK_GATEWAY_PUBLIC_URL must be a clean HTTPS origin.");
  const workerId = required(source, "ALBERT_WORKER_ID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(workerId)) {
    throw new Error("ALBERT_WORKER_ID is invalid.");
  }
  const mappingVersion = source.ALBERT_MAPPING_VERSION?.trim() || "m2-v1";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(mappingVersion)) {
    throw new Error("ALBERT_MAPPING_VERSION is invalid.");
  }
  const xeroAdvancedJournals = source.XERO_ENABLE_ADVANCED_JOURNALS ?? "false";
  if (xeroAdvancedJournals !== "true" && xeroAdvancedJournals !== "false") {
    throw new Error("XERO_ENABLE_ADVANCED_JOURNALS must be true or false.");
  }
  const xeroDailyRequestLimit = Number(source.XERO_DAILY_REQUEST_LIMIT ?? "1000");
  if (xeroDailyRequestLimit !== 1000 && xeroDailyRequestLimit !== 5000) {
    throw new Error("XERO_DAILY_REQUEST_LIMIT must match the Xero tier limit: 1000 or 5000.");
  }
  const xeroWebhookSigningKey = required(source, "XERO_WEBHOOK_SIGNING_KEY");
  if ([...deputyWebhookKeyring.keys.values()].includes(xeroWebhookSigningKey)) {
    throw new Error("Deputy webhook encryption and Xero signing keys must be distinct.");
  }

  return Object.freeze({
    controlPlaneDatabaseUrl: control,
    analyticalDatabaseUrl: analytical,
    rawStorage: loadRawStorageS3Config(source),
    tokenEncryptionKey,
    tokenKeyReference: "env:TOKEN_ENCRYPTION_KEY",
    tokenKeyVersion,
    oauthWorkerSigningSecret,
    oauthRedirectUris: new Set(redirectValues),
    lightspeedClientId: required(source, "LIGHTSPEED_CLIENT_ID"),
    lightspeedClientSecret: required(source, "LIGHTSPEED_CLIENT_SECRET"),
    xeroClientId: required(source, "XERO_CLIENT_ID"),
    xeroWebhookSigningKey,
    xeroEnableAdvancedJournals: xeroAdvancedJournals === "true",
    xeroDailyRequestLimit: xeroDailyRequestLimit as 1000 | 5000,
    deputyClientId: required(source, "DEPUTY_CLIENT_ID"),
    deputyClientSecret: required(source, "DEPUTY_CLIENT_SECRET"),
    deputyRedirectUri: redirectValues[2]!,
    deputyWebhookEncryptionKey,
    deputyWebhookEncryptionKeyId,
    deputyWebhookEncryptionKeys: deputyWebhookKeyring.keys,
    webhookGatewayPublicUrl: webhookGatewayPublicUrl.toString(),
    mappingVersion,
    workerId,
    serviceVersion: source.ALBERT_SERVICE_VERSION?.trim() || "development",
    port,
  });
}
