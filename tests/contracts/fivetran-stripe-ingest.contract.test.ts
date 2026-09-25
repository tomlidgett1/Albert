import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { FIVETRAN_SERVICES, fivetranConnectionSchema } from "../../packages/fivetran/src/index.js";
import { toConnectionsWorkspace } from "../../services/control-plane/src/connections-workspace.js";

const webFlow = readFileSync("services/oauth/src/web-flow.ts", "utf8");
const workspace = readFileSync("services/control-plane/src/connections-workspace.ts", "utf8");
const connectionsUi = readFileSync("app/dash/components/ConnectionsWorkspace.tsx", "utf8");
const dashPage = readFileSync("app/dash/page.tsx", "utf8");
const worker = readFileSync("services/sync-workers/src/fivetran-http.ts", "utf8");
const workerMain = readFileSync("services/sync-workers/src/main.ts", "utf8");
const nativeCredentials = readFileSync(
  "services/sync-workers/src/fivetran-native-credentials.ts",
  "utf8",
);
const destinationMaintenance = readFileSync(
  "services/sync-workers/src/fivetran-destination-maintenance.ts",
  "utf8",
);
const stripeConnector = readFileSync("connectors/stripe/index.ts", "utf8");
const controlMigration = readFileSync("infra/migrations/control-plane/0165_m1_fivetran_stripe.sql", "utf8");
const analyticalMigration = readFileSync(
  "infra/migrations/analytical/0177_m2_stripe_source_views_over_fivetran.sql",
  "utf8",
);
const erdRefresh = readFileSync(
  "infra/migrations/analytical/0178_m2_stripe_erd_payment_link_and_intent_charge.sql",
  "utf8",
);
const routing = readFileSync("packages/albert-v3/src/engine/connector-routing.ts", "utf8");
const workerRpc = readFileSync("services/oauth/src/worker-rpc.ts", "utf8");
const oauthOnly = readFileSync("services/sync-workers/src/oauth-only-main.ts", "utf8");

test("Fivetran Stripe uses the native connector and official ERD, not the Stripe Admin API", () => {
  assert.equal(FIVETRAN_SERVICES.stripe.service, "stripe");
  assert.equal(FIVETRAN_SERVICES.stripe.connectorKey, "fivetran-stripe");
  assert.equal(FIVETRAN_SERVICES.stripe.schemaPrefix, "stripe");
  assert.equal(FIVETRAN_SERVICES.stripe.authorization, "api");
  assert.equal(
    fivetranConnectionSchema("stripe", "01KZN20VTX2EWW1TQ2AA3MCPW6"),
    "stripe_01kzn20vtx2eww1tq2aa3mcpw6",
  );
  assert.match(worker, /historical_sync_time_frame: "ALL_TIME"/u);
  assert.match(worker, /access_token: credential.accessToken/u);
  assert.match(worker, /api_key: credential.accessToken/u);
  assert.match(worker, /paused: true/u);
  assert.match(worker, /enableAllSchemasWhenReady\(created\.id, \{ attempts: 8/u);
  assert.match(worker, /isStripeLiveFivetranSecret\(credential\.accessToken\)/u);
  assert.match(worker, /unwindDestination/u);
  assert.doesNotMatch(worker, /isHistoricalSync: true/u);
  assert.match(worker, /enableAllSchemasWhenReady\(created\.id/u);
  assert.match(worker, /enableAllSchemasWhenReady\(row\.fivetranConnectionId/u);
  assert.match(
    readFileSync("packages/fivetran/src/client.ts", "utf8"),
    /schema_change_handling: "ALLOW_ALL"/u,
  );
  assert.match(worker, /support_connected_accounts_sync: false/u);
  assert.match(worker, /definition\.service === "stripe"/u);
  assert.match(
    readFileSync("services/sync-workers/src/oauth-http.ts", "utf8"),
    /oauth_provider_not_configured:\$\{selectedProvider\}/u,
  );
  assert.doesNotMatch(worker, /api\.stripe\.com/u);
  assert.match(analyticalMigration, /'st_charge'/u);
  assert.match(analyticalMigration, /stripe_contract_views/u);
  assert.match(analyticalMigration, /subscription_history/u);
  assert.match(analyticalMigration, /ingestion\.stripe_erd_tables/u);
  assert.match(analyticalMigration, /GRANT EXECUTE ON FUNCTION ingestion\.rebuild_stripe_official_views\(\) TO ingest_rw/u);
  assert.doesNotMatch(analyticalMigration, /stripe\.com\/v1/u);
  assert.match(erdRefresh, /payment_link_custom_field/u);
  assert.match(erdRefresh, /invoice_account_tax_id/u);
  assert.match(erdRefresh, /latest_charge_id/u);
  assert.match(workerRpc, /FIVETRAN_START_TIMEOUT_MS = 180_000/u);
  assert.match(worker, /maintainConnectedDestinations/u);
  assert.match(worker, /row\.service === "stripe" \|\| row\.service === "deputy"/u);
  assert.match(worker, /inventory\.length === 0/u);
  assert.match(destinationMaintenance, /Stripe has no broker/u);
  assert.match(workerMain, /FivetranDestinationMaintenance/u);
  assert.match(workerMain, /stripeConfigured: connectorFactory.isConfigured\("stripe"\)/u);
  assert.match(workerMain, /stripeCredentials: new StripeFivetranCredentialBridge/u);
  assert.doesNotMatch(workerMain, /stripeCredentials: connectorFactory.isConfigured\("stripe"\)/u);
  const stripeBridge = nativeCredentials.slice(
    nativeCredentials.indexOf("export class StripeFivetranCredentialBridge"),
  );
  assert.doesNotMatch(stripeBridge, /refresh_credentials/u);
  assert.match(
    readFileSync("services/sync-workers/src/credential-vault.ts", "utf8"),
    /tokenType !== "Bearer" && candidate\.tokenType !== "StripeAccount"/u,
  );
  assert.match(workerMain, /destinationMaintenance: fivetranDestinationMaintenance\?\.health\(\)/u);
  assert.match(oauthOnly, /stripeClientId,/u);
  assert.doesNotMatch(oauthOnly, /stripeClientId: required\("STRIPE_CLIENT_ID"\)/u);
  assert.match(oauthOnly, /fivetran-stripe/u);
});

test("Stripe Connect OAuth is handed to Fivetran with the granted secret key", () => {
  assert.match(webFlow, /"fivetran-stripe": "stripe"/u);
  assert.match(webFlow, /"fivetran-stripe": "stripe"/u);
  assert.match(stripeConnector, /stripeAccessToken: fivetranSecret/u);
  assert.match(stripeConnector, /isStripeFivetranSecret\(fivetranSecret\)/u);
  assert.match(stripeConnector, /isStripeLiveFivetranSecret\(fivetranSecret\)/u);
  assert.match(worker, /stripeCredentials/u);
  assert.match(controlMigration, /WHEN 'stripe' THEN 'fivetran-stripe'/u);
  assert.match(controlMigration, /WHEN 'stripe' THEN 'payments'/u);
  assert.match(routing, /normalized === "fivetran-stripe"/u);
});

test("the connections page offers Stripe \(Fivetran\) and hides native Stripe", () => {
  assert.match(connectionsUi, /id: "fivetran-stripe" as const/u);
  assert.match(connectionsUi, /name: "Stripe \(Fivetran\)"/u);
  assert.match(dashPage, /"fivetran-stripe": "Stripe \(Fivetran\)"/u);
  assert.match(workspace, /id: "fivetran-stripe"/u);

  const view = toConnectionsWorkspace({
    tenant_id: "01J00000000000000000000001",
    tenant_name: "Albert Retail Group",
    connections: [{
      connection_id: "01J00000000000000000000040",
      connector_key: "fivetran-stripe",
      display_name: "Stripe (Fivetran)",
      status: "connected",
      auth_health: "healthy",
      manual_ingestion_start_required: false,
      ingestion_state: "active",
      readiness: [{
        domain: "payments",
        state: "syncing",
      }],
    }],
    dossier: null,
    identity_review_tasks: [],
    blocking_answers: {},
    oauth_sessions: [],
  }, "Australia/Melbourne");
  const stripe = view.providers.find((provider) => provider.id === "fivetran-stripe");
  assert.ok(stripe);
  assert.equal(stripe.name, "Stripe (Fivetran)");
  assert.equal(stripe.connections[0]?.connectionId, "01J00000000000000000000040");
  assert.equal(view.providers.some((provider) => provider.id === "stripe"), false);
});
