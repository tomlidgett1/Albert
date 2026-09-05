import assert from "node:assert/strict";
import test from "node:test";
import type { WorkerCredentialVault } from "../../packages/connector-sdk/src/index.js";
import {
  ProductionConnectorFactory,
  ProductionConnectorRegistry,
} from "./src/connector-factory.js";
import { loadSyncWorkerConfig } from "./src/config.js";

const legacyAnonKey = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.signature";

const valid: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  CONTROL_PLANE_DATABASE_URL: "postgresql://albert_sync_control_runtime.abcdefghijklmnopqrst:secret@control.example:5432/postgres?sslmode=require",
  ANALYTICAL_DATABASE_URL: "postgresql://albert_ingest_runtime:secret@analytics.example:5432/postgres?sslmode=require",
  ALBERT_CONTROL_PLANE_PROJECT_REF: "abcdefghijklmnopqrst",
  ALBERT_CONTROL_PLANE_REGION: "ap-southeast-2",
  ALBERT_ANALYTICAL_REGION: "ap-southeast-2",
  ALBERT_LIGHTSPEED_PRODUCT: "r-series",
  SUPABASE_STORAGE_S3_ENDPOINT: "https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/s3",
  SUPABASE_STORAGE_S3_REGION: "ap-southeast-2",
  SUPABASE_STORAGE_S3_ACCESS_KEY_ID: "abcdefghijklmnopqrst",
  SUPABASE_STORAGE_S3_LEGACY_ANON_KEY: legacyAnonKey,
  ALBERT_RAW_STORAGE_SYNC_PASSWORD: "sync-machine-password-material-00000001",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
  TOKEN_ENCRYPTION_KEY_ID: "v1",
  ALBERT_OAUTH_WORKER_SIGNING_SECRET: "s".repeat(48),
  ALBERT_SHOPIFYQL_SIGNING_SECRET: "q".repeat(48),
  ALBERT_SHOPIFY_ADMIN_SIGNING_SECRET: "a".repeat(48),
  ALBERT_PUBLIC_ORIGIN: "https://albert.example",
  LIGHTSPEED_CLIENT_ID: "lightspeed-client",
  LIGHTSPEED_CLIENT_SECRET: "lightspeed-secret",
  XERO_CLIENT_ID: "xero-client",
  XERO_DAILY_REQUEST_LIMIT: "1000",
  DEPUTY_CLIENT_ID: "deputy-client",
  DEPUTY_CLIENT_SECRET: "deputy-secret",
  SQUARE_CLIENT_ID: "square-client",
  SQUARE_CLIENT_SECRET: "square-secret",
  SHOPIFY_CLIENT_ID: "shopify-client",
  SHOPIFY_CLIENT_SECRET: "shopify-secret",
  STRIPE_CLIENT_ID: "ca_stripe-client",
  STRIPE_SECRET_KEY: "sk_test_stripe",
  MOMENCE_CLIENT_ID: "momence-client",
  MOMENCE_CLIENT_SECRET: "momence-secret",
  META_ADS_CLIENT_ID: "meta-client",
  META_ADS_CLIENT_SECRET: "meta-secret",
  GOOGLE_ADS_CLIENT_ID: "google-client",
  GOOGLE_ADS_CLIENT_SECRET: "google-secret",
  ALBERT_WORKER_ID: "sync-worker-01",
  ALBERT_WORKER_INSTANCE_ID: "sync-test-01",
  ALBERT_SERVICE_VERSION: "a".repeat(40),
  ALBERT_DEPLOYMENT_ID: "test-deployment-1",
  PORT: "8080",
};

test("sync worker config fails closed when the OAuth-specific HMAC secret is absent", () => {
  const source = { ...valid };
  delete (source as Partial<typeof valid>).ALBERT_OAUTH_WORKER_SIGNING_SECRET;
  assert.throws(() => loadSyncWorkerConfig(source), /ALBERT_OAUTH_WORKER_SIGNING_SECRET/);
});

test("sync worker requires a dedicated ShopifyQL HMAC boundary", () => {
  const missing = { ...valid };
  delete missing.ALBERT_SHOPIFYQL_SIGNING_SECRET;
  assert.throws(() => loadSyncWorkerConfig(missing), /ALBERT_SHOPIFYQL_SIGNING_SECRET/u);
  assert.throws(
    () => loadSyncWorkerConfig({
      ...valid,
      ALBERT_SHOPIFYQL_SIGNING_SECRET: valid.ALBERT_OAUTH_WORKER_SIGNING_SECRET,
    }),
    /must be distinct/u,
  );
});

test("sync worker requires an independently keyed Shopify Admin read boundary", () => {
  const missing = { ...valid };
  delete missing.ALBERT_SHOPIFY_ADMIN_SIGNING_SECRET;
  assert.throws(() => loadSyncWorkerConfig(missing), /ALBERT_SHOPIFY_ADMIN_SIGNING_SECRET/u);
  for (const reused of [
    valid.ALBERT_OAUTH_WORKER_SIGNING_SECRET,
    valid.ALBERT_SHOPIFYQL_SIGNING_SECRET,
  ]) {
    assert.throws(
      () => loadSyncWorkerConfig({ ...valid, ALBERT_SHOPIFY_ADMIN_SIGNING_SECRET: reused }),
      /must be distinct/u,
    );
  }
  assert.throws(
    () => loadSyncWorkerConfig({
      ...valid,
      ALBERT_SEMANTIC_SIGNING_SECRET: "m".repeat(48),
      ALBERT_SHOPIFY_ADMIN_SIGNING_SECRET: "m".repeat(48),
    }),
    /must be distinct/u,
  );
});

test("sync worker neither requires nor loads the Xero webhook signing key", () => {
  const config = loadSyncWorkerConfig({
    ...valid,
    XERO_WEBHOOK_SIGNING_KEY: "must-remain-gateway-only",
  });
  assert.equal(Object.hasOwn(config, "xeroWebhookSigningKey"), false);
});

test("Deputy OAuth is optional as one atomic provider while Lightspeed and Xero remain required", () => {
  const withoutDeputy = { ...valid };
  delete withoutDeputy.DEPUTY_CLIENT_ID;
  delete withoutDeputy.DEPUTY_CLIENT_SECRET;
  const config = loadSyncWorkerConfig(withoutDeputy);
  assert.equal(config.deputyClientId, "");
  assert.equal(config.deputyClientSecret, "");
  assert.throws(
    () => loadSyncWorkerConfig({ ...withoutDeputy, DEPUTY_CLIENT_ID: "partial" }),
    /must be configured together/u,
  );
  assert.throws(
    () => loadSyncWorkerConfig({ ...withoutDeputy, LIGHTSPEED_CLIENT_ID: "" }),
    /LIGHTSPEED_CLIENT_ID/u,
  );
  assert.throws(
    () => loadSyncWorkerConfig({ ...withoutDeputy, XERO_CLIENT_ID: "" }),
    /XERO_CLIENT_ID/u,
  );

  const factory = new ProductionConnectorFactory(config);
  const vault = {} as WorkerCredentialVault;
  assert.equal(factory.isConfigured("deputy"), false);
  assert.throws(
    () => factory.create("deputy", vault),
    /oauth_provider_not_configured:deputy/u,
  );
  const registry = new ProductionConnectorRegistry(factory, vault);
  assert.equal(registry.get("lightspeed-r").id, "lightspeed-r");
  assert.equal(registry.get("xero").id, "xero");
  assert.throws(
    () => registry.get("deputy"),
    /connector_not_configured:deputy/u,
  );
});

test("Stripe Connect is optional as one atomic provider while Lightspeed and Xero remain required", () => {
  const withoutStripe = { ...valid };
  delete withoutStripe.STRIPE_CLIENT_ID;
  delete withoutStripe.STRIPE_SECRET_KEY;
  const config = loadSyncWorkerConfig(withoutStripe);
  assert.equal(config.stripeClientId, "");
  assert.equal(config.stripeSecretKey, "");
  assert.throws(
    () => loadSyncWorkerConfig({ ...withoutStripe, STRIPE_CLIENT_ID: "ca_partial" }),
    /must be configured together/u,
  );

  const factory = new ProductionConnectorFactory(config);
  const vault = {} as WorkerCredentialVault;
  assert.equal(factory.isConfigured("stripe"), false);
  assert.throws(
    () => factory.create("stripe", vault),
    /oauth_provider_not_configured:stripe/u,
  );
  const configuredFactory = new ProductionConnectorFactory(loadSyncWorkerConfig(valid));
  assert.equal(configuredFactory.isConfigured("stripe"), true);
  assert.equal(
    new ProductionConnectorRegistry(configuredFactory, vault).get("stripe").id,
    "stripe",
  );
});

test("Square credentials are required in production, atomic in development, and available to sync dispatch", () => {
  const vault = {} as WorkerCredentialVault;
  const configured = loadSyncWorkerConfig(valid);
  const configuredFactory = new ProductionConnectorFactory(configured);
  assert.equal(configuredFactory.isConfigured("square"), true);
  assert.equal(
    new ProductionConnectorRegistry(configuredFactory, vault).get("square").id,
    "square",
  );

  const withoutSquare = { ...valid };
  delete withoutSquare.SQUARE_CLIENT_ID;
  delete withoutSquare.SQUARE_CLIENT_SECRET;
  assert.throws(
    () => loadSyncWorkerConfig(withoutSquare),
    /SQUARE_CLIENT_ID and SQUARE_CLIENT_SECRET are required in production/u,
  );

  const developmentWithoutSquare = { ...withoutSquare, NODE_ENV: "development" as const };
  const optionalFactory = new ProductionConnectorFactory(
    loadSyncWorkerConfig(developmentWithoutSquare),
  );
  assert.equal(optionalFactory.isConfigured("square"), false);
  assert.throws(
    () => optionalFactory.create("square", vault),
    /oauth_provider_not_configured:square/u,
  );
  assert.throws(
    () => new ProductionConnectorRegistry(optionalFactory, vault).get("square"),
    /connector_not_configured:square/u,
  );
  assert.throws(
    () => loadSyncWorkerConfig({
      ...developmentWithoutSquare,
      SQUARE_CLIENT_ID: "partial",
    }),
    /SQUARE_CLIENT_ID and SQUARE_CLIENT_SECRET must be configured together/u,
  );
});

test("Lightspeed X credentials are atomic, product-gated, and available to production sync dispatch", () => {
  const vault = {} as WorkerCredentialVault;
  const withLightspeedX = {
    ...valid,
    ALBERT_LIGHTSPEED_X_PRODUCT: "x-series",
    LIGHTSPEED_X_CLIENT_ID: "lightspeed-x-client",
    LIGHTSPEED_X_CLIENT_SECRET: "lightspeed-x-secret",
  };
  const configured = loadSyncWorkerConfig(withLightspeedX);
  const configuredFactory = new ProductionConnectorFactory(configured);
  assert.equal(configuredFactory.isConfigured("lightspeed-x"), true);
  assert.equal(
    new ProductionConnectorRegistry(configuredFactory, vault).get("lightspeed-x").id,
    "lightspeed-x",
  );

  assert.throws(
    () => loadSyncWorkerConfig({
      ...valid,
      ALBERT_LIGHTSPEED_X_PRODUCT: "x-series",
      LIGHTSPEED_X_CLIENT_ID: "partial",
    }),
    /LIGHTSPEED_X_CLIENT_ID and LIGHTSPEED_X_CLIENT_SECRET must be configured together/u,
  );
  assert.throws(
    () => loadSyncWorkerConfig({
      ...withLightspeedX,
      ALBERT_LIGHTSPEED_X_PRODUCT: "r-series",
    }),
    /ALBERT_LIGHTSPEED_X_PRODUCT must explicitly confirm x-series/u,
  );
});

test("Momence credentials are atomic and configured Momence is available to production sync dispatch", () => {
  const vault = {} as WorkerCredentialVault;
  const configured = loadSyncWorkerConfig(valid);
  const configuredFactory = new ProductionConnectorFactory(configured);
  assert.equal(configuredFactory.isConfigured("momence"), true);
  assert.equal(
    new ProductionConnectorRegistry(configuredFactory, vault).get("momence").id,
    "momence",
  );

  const withoutMomence = { ...valid };
  delete withoutMomence.MOMENCE_CLIENT_ID;
  delete withoutMomence.MOMENCE_CLIENT_SECRET;
  const optionalFactory = new ProductionConnectorFactory(loadSyncWorkerConfig(withoutMomence));
  assert.equal(optionalFactory.isConfigured("momence"), false);
  assert.throws(
    () => optionalFactory.create("momence", vault),
    /oauth_provider_not_configured:momence/u,
  );
  assert.throws(
    () => new ProductionConnectorRegistry(optionalFactory, vault).get("momence"),
    /connector_not_configured:momence/u,
  );
  assert.throws(
    () => loadSyncWorkerConfig({ ...withoutMomence, MOMENCE_CLIENT_ID: "partial" }),
    /MOMENCE_CLIENT_ID and MOMENCE_CLIENT_SECRET must be configured together/u,
  );
});

test("initial-backfill suppression is opt-in, per connector, and fails closed on typos", () => {
  assert.deepEqual([...loadSyncWorkerConfig(valid).oauthSuppressInitialBackfill], []);
  assert.deepEqual(
    [...loadSyncWorkerConfig({
      ...valid,
      ALBERT_OAUTH_SUPPRESS_INITIAL_BACKFILL: " xero , deputy ",
    }).oauthSuppressInitialBackfill],
    ["xero", "deputy"],
  );
  // A typo must not be read as "nothing suppressed" and quietly start a sync.
  assert.throws(
    () => loadSyncWorkerConfig({ ...valid, ALBERT_OAUTH_SUPPRESS_INITIAL_BACKFILL: "xerro" }),
    /ALBERT_OAUTH_SUPPRESS_INITIAL_BACKFILL lists unknown connectors: xerro/u,
  );
  assert.throws(
    () => loadSyncWorkerConfig({ ...valid, ALBERT_OAUTH_SUPPRESS_INITIAL_BACKFILL: "xero,lightspeed" }),
    /unknown connectors: lightspeed/u,
  );
});

test("sync worker config accepts only exact HTTPS OAuth callbacks in production", () => {
  const config = loadSyncWorkerConfig(valid);
  assert.ok(config.oauthRedirectUris.has("https://albert.example/api/oauth/xero/callback"));
  assert.ok(config.oauthRedirectUris.has("https://albert.example/api/oauth/fivetran-xero/callback"));
  assert.equal(config.fivetran, undefined);
  assert.equal(config.xeroDailyRequestLimit, 1000);
  assert.equal(config.workerConcurrency, 8);
  assert.equal(config.queueSlaSeconds, 300);
  assert.equal(config.metricsPort, 9091);
  assert.throws(
    () => loadSyncWorkerConfig({ ...valid, ALBERT_PUBLIC_ORIGIN: "http://localhost" }),
    /ALBERT_PUBLIC_ORIGIN/,
  );
  assert.equal(loadSyncWorkerConfig({ ...valid, XERO_DAILY_REQUEST_LIMIT: "5000" }).xeroDailyRequestLimit, 5000);
  assert.throws(
    () => loadSyncWorkerConfig({ ...valid, XERO_DAILY_REQUEST_LIMIT: "2500" }),
    /XERO_DAILY_REQUEST_LIMIT/,
  );
  const isolated = loadSyncWorkerConfig({
    ...valid,
    DEPUTY_WEBHOOK_ENCRYPTION_KEY: "must-remain-outside-sync-runtime",
    DEPUTY_WEBHOOK_ENCRYPTION_KEY_ID: "must-remain-outside-sync-runtime",
    WEBHOOK_GATEWAY_PUBLIC_URL: "https://webhooks.albert.example",
    DEPUTY_WEBHOOK_PREVIOUS_ENCRYPTION_KEYS: JSON.stringify({
      "deputy-webhook-v0": "must-remain-outside-sync-runtime",
    }),
  });
  assert.equal(Object.hasOwn(isolated, "deputyWebhookEncryptionKey"), false);
  assert.equal(Object.hasOwn(isolated, "deputyWebhookEncryptionKeys"), false);
  assert.equal(Object.hasOwn(isolated, "webhookGatewayPublicUrl"), false);
  assert.throws(
    () => loadSyncWorkerConfig({ ...valid, ALBERT_WORKER_CONCURRENCY: "0" }),
    /ALBERT_WORKER_CONCURRENCY/,
  );
  assert.throws(
    () => loadSyncWorkerConfig({ ...valid, ALBERT_METRICS_PORT: valid.PORT }),
    /must differ from PORT/,
  );
});

test("sync worker config namespaces leases to the running Fly machine", () => {
  const config = loadSyncWorkerConfig({ ...valid, FLY_MACHINE_ID: "90801abcdef123" });
  assert.equal(config.workerId, "sync-worker-01:90801abcdef123");
});

test("sync worker loads a bounded, canonical token KEK overlap keyring", () => {
  const previous = Buffer.alloc(32, 6).toString("base64url");
  const config = loadSyncWorkerConfig({
    ...valid,
    TOKEN_PREVIOUS_ENCRYPTION_KEYS: JSON.stringify({ v0: previous }),
  });
  assert.deepEqual([...config.tokenEncryptionKeys.keys()], ["v1", "v0"]);
  assert.equal(config.tokenEncryptionKeys.get("v0"), previous);

  assert.throws(
    () => loadSyncWorkerConfig({
      ...valid,
      TOKEN_ENCRYPTION_KEY: `${valid.TOKEN_ENCRYPTION_KEY}=`,
    }),
    /unpadded base64url/,
  );
  assert.throws(
    () => loadSyncWorkerConfig({
      ...valid,
      TOKEN_PREVIOUS_ENCRYPTION_KEYS: JSON.stringify({
        v0: valid.TOKEN_ENCRYPTION_KEY,
      }),
    }),
    /reuse key material/,
  );
  assert.throws(
    () => loadSyncWorkerConfig({
      ...valid,
      TOKEN_PREVIOUS_ENCRYPTION_KEYS: JSON.stringify(Object.fromEntries(
        [1, 2, 3, 4, 5].map((value) => [
          `v${value + 1}`,
          Buffer.alloc(32, value + 20).toString("base64url"),
        ]),
      )),
    }),
    /too many keys/,
  );
});

test("Fivetran Xero config is optional, complete, and uses a Fivetran-legal schema", () => {
  assert.equal(loadSyncWorkerConfig(valid).fivetran, undefined);
  assert.throws(
    () => loadSyncWorkerConfig({ ...valid, FIVETRAN_API_KEY: "key" }),
    /FIVETRAN_API_KEY, FIVETRAN_API_SECRET, and FIVETRAN_GROUP_ID must be configured together/u,
  );
  assert.throws(
    () => loadSyncWorkerConfig({
      ...valid,
      FIVETRAN_API_KEY: "key",
      FIVETRAN_API_SECRET: "secret",
      FIVETRAN_GROUP_ID: "group",
      FIVETRAN_XERO_SCHEMA: "5XERO",
    }),
    /FIVETRAN_XERO_SCHEMA must be a Fivetran-legal destination schema name/u,
  );
  const configured = loadSyncWorkerConfig({
    ...valid,
    FIVETRAN_API_KEY: "key",
    FIVETRAN_API_SECRET: "secret",
    FIVETRAN_GROUP_ID: "group",
  });
  assert.equal(configured.fivetran?.destinationSchema, "xero");
  assert.equal(configured.fivetran?.groupId, "group");
  assert.equal(configured.fivetran?.sdkProjectDir, "connectors/xero-fivetran-sdk");
  assert.equal(configured.fivetran?.tokenBrokerOrigin, undefined);
  const onFly = loadSyncWorkerConfig({
    ...valid,
    FIVETRAN_API_KEY: "key",
    FIVETRAN_API_SECRET: "secret",
    FIVETRAN_GROUP_ID: "group",
    FLY_APP_NAME: "albert-sync-worker-dogfood",
  });
  assert.equal(onFly.fivetran?.tokenBrokerOrigin, "https://albert-sync-worker-dogfood.fly.dev");
});
