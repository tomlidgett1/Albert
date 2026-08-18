import { loadReplicaWorkerId } from "../../../packages/shared/src/index.js";
import {
  loadRawStorageS3Config,
  type RawStorageS3Config,
} from "../../../packages/storage/src/s3.js";
import { assertProductionRuntimeBoundary } from "../../../packages/config/src/production-boundary.js";
import { loadEncodedAes256Keyring } from "../../../packages/security/src/index.js";
import { isFivetranDestinationSchema } from "../../../packages/fivetran/src/index.js";
import type { FivetranWorkerConfig } from "./fivetran-http.js";

const CONNECTOR_PROVIDERS = ["lightspeed-r", "lightspeed-x", "xero", "deputy", "square", "shopify", "stripe", "momence", "meta-ads", "google-ads"] as const;
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];

/**
 * Connectors that authorise and store credentials but never enqueue the
 * initial backfill. Unknown ids throw rather than resolving to "suppress
 * nothing", so a typo cannot silently leave a pack ingesting. The web slug
 * `lightspeed` is deliberately not accepted; the connector id is `lightspeed-r`.
 */
export function parseSuppressedInitialBackfillConnectors(
  value: string | undefined,
): ReadonlySet<ConnectorProvider> {
  const requested = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const unknown = requested.filter(
    (entry) => !(CONNECTOR_PROVIDERS as readonly string[]).includes(entry),
  );
  if (unknown.length > 0) {
    throw new Error(
      `ALBERT_OAUTH_SUPPRESS_INITIAL_BACKFILL lists unknown connectors: ${unknown.join(", ")}.`,
    );
  }
  return new Set(requested as readonly ConnectorProvider[]);
}

export type SyncWorkerConfig = Readonly<{
  controlPlaneDatabaseUrl: string;
  analyticalDatabaseUrl: string;
  rawStorage: RawStorageS3Config;
  tokenEncryptionKey: string;
  tokenEncryptionKeys: ReadonlyMap<string, string>;
  tokenKeyReference: string;
  tokenKeyVersion: string;
  oauthWorkerSigningSecret: string;
  shopifyQLSigningSecret: string;
  shopifyAdminSigningSecret: string;
  oauthRedirectUris: ReadonlySet<string>;
  oauthSuppressInitialBackfill: ReadonlySet<ConnectorProvider>;
  lightspeedClientId: string;
  lightspeedClientSecret: string;
  lightspeedXClientId: string;
  lightspeedXClientSecret: string;
  lightspeedXRedirectUri: string;
  xeroClientId: string;
  xeroEnableAdvancedJournals: boolean;
  xeroDailyRequestLimit: 1000 | 5000;
  deputyClientId: string;
  deputyClientSecret: string;
  deputyRedirectUri: string;
  squareClientId: string;
  squareClientSecret: string;
  squareRedirectUri: string;
  shopifyClientId: string;
  shopifyClientSecret: string;
  shopifyRedirectUri: string;
  stripeClientId: string;
  stripeSecretKey: string;
  stripeRedirectUri: string;
  momenceClientId: string;
  momenceClientSecret: string;
  momenceRedirectUri: string;
  metaAdsClientId: string;
  metaAdsClientSecret: string;
  metaAdsRedirectUri: string;
  googleAdsClientId: string;
  googleAdsClientSecret: string;
  googleAdsRedirectUri: string;
  mappingVersion: string;
  workerId: string;
  workerConcurrency: number;
  queueSlaSeconds: number;
  serviceVersion: string;
  port: number;
  metricsPort: number;
  fivetran?: FivetranWorkerConfig;
}>;

function optionalSecret(source: Readonly<Record<string, string | undefined>>, key: string): string {
  return source[key]?.trim() ?? "";
}

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

function boundedInteger(
  source: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(source[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function loadSyncWorkerConfig(source: NodeJS.ProcessEnv = process.env): SyncWorkerConfig {
  assertProductionRuntimeBoundary(source, {
    label: "sync worker",
    controlProject: true,
    analyticalRegion: true,
    storageRegion: true,
    modelDataResidency: false,
    lightspeedProduct: true,
    databaseLogins: {
      CONTROL_PLANE_DATABASE_URL: "albert_sync_control_runtime",
      ANALYTICAL_DATABASE_URL: "albert_ingest_runtime",
    },
    distinctDatabaseVariables: ["CONTROL_PLANE_DATABASE_URL", "ANALYTICAL_DATABASE_URL"],
  });
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
  const redirectValues = ["lightspeed", "xero", "deputy", "square", "shopify", "stripe", "momence", "meta-ads", "google-ads", "lightspeed-x", "fivetran-xero", "fivetran-lightspeed"].map((provider) =>
    new URL(`/api/oauth/${provider}/callback`, publicOrigin).toString()
  );
  const port = Number(source.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT is invalid.");
  const metricsPort = boundedInteger(source, "ALBERT_METRICS_PORT", 9091, 1, 65535);
  if (metricsPort === port) throw new Error("ALBERT_METRICS_PORT must differ from PORT.");
  const workerConcurrency = boundedInteger(source, "ALBERT_WORKER_CONCURRENCY", 8, 1, 64);
  const queueSlaSeconds = boundedInteger(source, "ALBERT_QUEUE_SLA_SECONDS", 300, 30, 3600);

  const tokenEncryptionKey = required(source, "TOKEN_ENCRYPTION_KEY");
  const oauthWorkerSigningSecret = required(source, "ALBERT_OAUTH_WORKER_SIGNING_SECRET");
  if (Buffer.byteLength(oauthWorkerSigningSecret, "utf8") < 32) {
    throw new Error("ALBERT_OAUTH_WORKER_SIGNING_SECRET must contain at least 32 bytes.");
  }
  const shopifyQLSigningSecret = optionalSecret(source, "ALBERT_SHOPIFYQL_SIGNING_SECRET");
  if (shopifyQLSigningSecret && Buffer.byteLength(shopifyQLSigningSecret, "utf8") < 32) {
    throw new Error("ALBERT_SHOPIFYQL_SIGNING_SECRET must contain at least 32 bytes.");
  }
  if (shopifyQLSigningSecret === oauthWorkerSigningSecret) {
    throw new Error("ALBERT_SHOPIFYQL_SIGNING_SECRET must be distinct from the OAuth signing secret.");
  }
  const shopifyAdminSigningSecret = optionalSecret(source, "ALBERT_SHOPIFY_ADMIN_SIGNING_SECRET");
  if (shopifyAdminSigningSecret && Buffer.byteLength(shopifyAdminSigningSecret, "utf8") < 32) {
    throw new Error("ALBERT_SHOPIFY_ADMIN_SIGNING_SECRET must contain at least 32 bytes.");
  }
  const forbiddenAdminSecrets = [
    oauthWorkerSigningSecret,
    shopifyQLSigningSecret,
    optionalSecret(source, "ALBERT_SEMANTIC_SIGNING_SECRET"),
  ].filter(Boolean);
  if (shopifyAdminSigningSecret && forbiddenAdminSecrets.includes(shopifyAdminSigningSecret)) {
    throw new Error("ALBERT_SHOPIFY_ADMIN_SIGNING_SECRET must be distinct from OAuth, ShopifyQL, and semantic signing secrets.");
  }
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
  const workerId = loadReplicaWorkerId(
    source,
    "ALBERT_WORKER_ID",
    "Albert sync worker is missing ALBERT_WORKER_ID.",
  );
  const mappingVersion = source.ALBERT_MAPPING_VERSION?.trim() || "m2-v1";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(mappingVersion)) {
    throw new Error("ALBERT_MAPPING_VERSION is invalid.");
  }
  const xeroAdvancedJournals = source.XERO_ENABLE_ADVANCED_JOURNALS ?? "false";
  if (xeroAdvancedJournals !== "true" && xeroAdvancedJournals !== "false") {
    throw new Error("XERO_ENABLE_ADVANCED_JOURNALS must be true or false.");
  }
  const xeroDailyRequestLimit = Number(
    source.NODE_ENV === "production"
      ? required(source, "XERO_DAILY_REQUEST_LIMIT")
      : source.XERO_DAILY_REQUEST_LIMIT ?? "1000",
  );
  if (xeroDailyRequestLimit !== 1000 && xeroDailyRequestLimit !== 5000) {
    throw new Error("XERO_DAILY_REQUEST_LIMIT must match the Xero tier limit: 1000 or 5000.");
  }
  const suppressInitialBackfill = parseSuppressedInitialBackfillConnectors(
    source.ALBERT_OAUTH_SUPPRESS_INITIAL_BACKFILL,
  );
  const deputyClientId = optionalSecret(source, "DEPUTY_CLIENT_ID");
  const deputyClientSecret = optionalSecret(source, "DEPUTY_CLIENT_SECRET");
  if (Boolean(deputyClientId) !== Boolean(deputyClientSecret)) {
    throw new Error(
      "DEPUTY_CLIENT_ID and DEPUTY_CLIENT_SECRET must be configured together.",
    );
  }
  const squareClientId = optionalSecret(source, "SQUARE_CLIENT_ID");
  const squareClientSecret = optionalSecret(source, "SQUARE_CLIENT_SECRET");
  if (source.NODE_ENV === "production" && (!squareClientId || !squareClientSecret)) {
    throw new Error(
      "SQUARE_CLIENT_ID and SQUARE_CLIENT_SECRET are required in production.",
    );
  }
  if (Boolean(squareClientId) !== Boolean(squareClientSecret)) {
    throw new Error(
      "SQUARE_CLIENT_ID and SQUARE_CLIENT_SECRET must be configured together.",
    );
  }
  const lightspeedXClientId = optionalSecret(source, "LIGHTSPEED_X_CLIENT_ID");
  const lightspeedXClientSecret = optionalSecret(source, "LIGHTSPEED_X_CLIENT_SECRET");
  if (Boolean(lightspeedXClientId) !== Boolean(lightspeedXClientSecret)) {
    throw new Error(
      "LIGHTSPEED_X_CLIENT_ID and LIGHTSPEED_X_CLIENT_SECRET must be configured together.",
    );
  }
  if (
    lightspeedXClientId &&
    source.ALBERT_LIGHTSPEED_X_PRODUCT?.trim() !== "x-series"
  ) {
    throw new Error(
      "ALBERT_LIGHTSPEED_X_PRODUCT must explicitly confirm x-series when Lightspeed X-Series OAuth is configured.",
    );
  }
  const shopifyClientId = optionalSecret(source, "SHOPIFY_CLIENT_ID");
  const shopifyClientSecret = optionalSecret(source, "SHOPIFY_CLIENT_SECRET");
  if (Boolean(shopifyClientId) !== Boolean(shopifyClientSecret)) {
    throw new Error(
      "SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET must be configured together.",
    );
  }
  if (shopifyClientId && !shopifyQLSigningSecret) {
    throw new Error("ALBERT_SHOPIFYQL_SIGNING_SECRET is required when Shopify is configured.");
  }
  if (shopifyClientId && !shopifyAdminSigningSecret) {
    throw new Error("ALBERT_SHOPIFY_ADMIN_SIGNING_SECRET is required when Shopify is configured.");
  }
  const momenceClientId = optionalSecret(source, "MOMENCE_CLIENT_ID");
  const momenceClientSecret = optionalSecret(source, "MOMENCE_CLIENT_SECRET");
  if (Boolean(momenceClientId) !== Boolean(momenceClientSecret)) {
    throw new Error(
      "MOMENCE_CLIENT_ID and MOMENCE_CLIENT_SECRET must be configured together.",
    );
  }
  const fivetran = loadFivetranWorkerConfig(source);
  return Object.freeze({
    controlPlaneDatabaseUrl: control,
    analyticalDatabaseUrl: analytical,
    rawStorage: loadRawStorageS3Config(source, {
      machinePurpose: "sync",
      passwordEnvironmentName: "ALBERT_RAW_STORAGE_SYNC_PASSWORD",
    }),
    tokenEncryptionKey: tokenKeyring.currentKey,
    tokenEncryptionKeys: tokenKeyring.keys,
    tokenKeyReference: "env:TOKEN_ENCRYPTION_KEY",
    tokenKeyVersion,
    oauthWorkerSigningSecret,
    shopifyQLSigningSecret,
    shopifyAdminSigningSecret,
    oauthRedirectUris: new Set(redirectValues),
    oauthSuppressInitialBackfill: suppressInitialBackfill,
    lightspeedClientId: required(source, "LIGHTSPEED_CLIENT_ID"),
    lightspeedClientSecret: required(source, "LIGHTSPEED_CLIENT_SECRET"),
    lightspeedXClientId,
    lightspeedXClientSecret,
    lightspeedXRedirectUri: redirectValues[9]!,
    xeroClientId: required(source, "XERO_CLIENT_ID"),
    xeroEnableAdvancedJournals: xeroAdvancedJournals === "true",
    xeroDailyRequestLimit: xeroDailyRequestLimit as 1000 | 5000,
    deputyClientId,
    deputyClientSecret,
    deputyRedirectUri: redirectValues[2]!,
    // Optional OAuth providers are admitted only when their complete credential
    // pair is present. Missing providers stay unavailable without preventing
    // unrelated connectors from starting in the same worker fleet.
    squareClientId,
    squareClientSecret,
    squareRedirectUri: redirectValues[3]!,
    shopifyClientId,
    shopifyClientSecret,
    shopifyRedirectUri: redirectValues[4]!,
    stripeClientId: optionalSecret(source, "STRIPE_CLIENT_ID"),
    stripeSecretKey: optionalSecret(source, "STRIPE_SECRET_KEY"),
    stripeRedirectUri: redirectValues[5]!,
    momenceClientId,
    momenceClientSecret,
    momenceRedirectUri: redirectValues[6]!,
    metaAdsClientId: optionalSecret(source, "META_ADS_CLIENT_ID"),
    metaAdsClientSecret: optionalSecret(source, "META_ADS_CLIENT_SECRET"),
    metaAdsRedirectUri: redirectValues[7]!,
    googleAdsClientId: optionalSecret(source, "GOOGLE_ADS_CLIENT_ID"),
    googleAdsClientSecret: optionalSecret(source, "GOOGLE_ADS_CLIENT_SECRET"),
    googleAdsRedirectUri: redirectValues[8]!,
    mappingVersion,
    workerId,
    workerConcurrency,
    queueSlaSeconds,
    serviceVersion: source.ALBERT_SERVICE_VERSION?.trim() || "development",
    port,
    metricsPort,
    ...(fivetran ? { fivetran } : {}),
  });
}

function loadFivetranWorkerConfig(
  source: NodeJS.ProcessEnv,
): FivetranWorkerConfig | undefined {
  const apiKey = optionalSecret(source, "FIVETRAN_API_KEY");
  const apiSecret = optionalSecret(source, "FIVETRAN_API_SECRET");
  const groupId = optionalSecret(source, "FIVETRAN_GROUP_ID");
  const present = [apiKey, apiSecret, groupId].filter(Boolean).length;
  if (present === 0) return undefined;
  if (present !== 3) {
    throw new Error(
      "FIVETRAN_API_KEY, FIVETRAN_API_SECRET, and FIVETRAN_GROUP_ID must be configured together.",
    );
  }
  const destinationSchema = source.FIVETRAN_XERO_SCHEMA?.trim() || "xero";
  if (!isFivetranDestinationSchema(destinationSchema)) {
    throw new Error("FIVETRAN_XERO_SCHEMA must be a Fivetran-legal destination schema name.");
  }
  const destinationRole = optionalSecret(source, "FIVETRAN_DESTINATION_ROLE");
  if (destinationRole && !/^[a-z_][a-z0-9_]{0,62}$/.test(destinationRole)) {
    throw new Error("FIVETRAN_DESTINATION_ROLE must be a PostgreSQL role name.");
  }
  // The SDK connectors (Xero, Lightspeed R-Series) call back to this worker
  // for tokens; they need the worker's public HTTPS origin. Fly exposes the app name, so derive it there.
  const flyApp = source.FLY_APP_NAME?.trim();
  const tokenBrokerOrigin = source.FIVETRAN_TOKEN_BROKER_ORIGIN?.trim()
    || (flyApp ? `https://${flyApp}.fly.dev` : undefined);
  if (tokenBrokerOrigin && !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/u.test(tokenBrokerOrigin)) {
    throw new Error("FIVETRAN_TOKEN_BROKER_ORIGIN must be a bare https origin.");
  }
  const sdkProjectDir = source.FIVETRAN_XERO_SDK_DIR?.trim() || "connectors/xero-fivetran-sdk";
  const lightspeedSdkProjectDir = source.FIVETRAN_LIGHTSPEED_SDK_DIR?.trim() || "connectors/lightspeed-fivetran-sdk";
  const sdkPythonVersion = source.FIVETRAN_SDK_PYTHON_VERSION?.trim();
  if (sdkPythonVersion && !/^3\.\d{1,2}$/u.test(sdkPythonVersion)) {
    throw new Error("FIVETRAN_SDK_PYTHON_VERSION must look like 3.12.");
  }
  return Object.freeze({
    apiKey,
    apiSecret,
    groupId,
    destinationSchema,
    sdkProjectDir,
    lightspeedSdkProjectDir,
    ...(sdkPythonVersion ? { sdkPythonVersion } : {}),
    ...(tokenBrokerOrigin ? { tokenBrokerOrigin } : {}),
    ...(destinationRole ? { destinationRole } : {}),
  });
}
