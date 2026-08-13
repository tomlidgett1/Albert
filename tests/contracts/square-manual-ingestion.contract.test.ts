import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { deputyManifest } from "../../connectors/deputy/manifest";
import { lightspeedRManifest } from "../../connectors/lightspeed-r/manifest";
import { squareManifest } from "../../connectors/square/manifest";
import { stripeManifest } from "../../connectors/stripe/manifest";
import { xeroManifest } from "../../connectors/xero/manifest";
import { toConnectionsWorkspace } from "../../services/control-plane/src/connections-workspace";

const root = new URL("../../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

test("Square declares explicit first ingestion while established connectors preserve automatic start", () => {
  assert.equal(squareManifest.ingestion.initialStart, "manual");
  for (const manifest of [lightspeedRManifest, xeroManifest, deputyManifest, stripeManifest]) {
    assert.equal(manifest.ingestion.initialStart, "automatic", manifest.id);
  }
});

test("production config requires Square as an atomic credential pair and registers it for sync", async () => {
  const config = await source("services/sync-workers/src/config.ts");
  const factory = await source("services/sync-workers/src/connector-factory.ts");
  const environment = await source("packages/config/src/env.ts");
  const runtimeContract = JSON.parse(await source("deploy/runtime-contract.json")) as {
    runtimes: {
      web: { requiredRuntimeValues: string[]; forbiddenRuntimeValues: string[] };
      "sync-worker": { requiredSecretNames: string[] };
      "deletion-worker": { requiredSecretNames: string[] };
    };
  };

  assert.match(
    config,
    /Boolean\(squareClientId\) !== Boolean\(squareClientSecret\)/u,
  );
  assert.match(
    config,
    /SQUARE_CLIENT_ID and SQUARE_CLIENT_SECRET are required in production/u,
  );
  assert.match(config, /SQUARE_CLIENT_ID and SQUARE_CLIENT_SECRET must be configured together/u);
  assert.match(factory, /if \(provider === "square"\)[\s\S]*squareClientId && this\.config\.squareClientSecret/u);
  assert.match(factory, /connectors\.push\(\["square", factory\.create\("square", vault\)\]\)/u);
  assert.match(environment, /web:[\s\S]*"SQUARE_CLIENT_ID"/u);
  assert.match(environment, /worker:[\s\S]*"SQUARE_CLIENT_ID",\s*"SQUARE_CLIENT_SECRET"/u);
  assert.match(environment, /"deletion-worker":[\s\S]*"SQUARE_CLIENT_ID",\s*"SQUARE_CLIENT_SECRET"/u);
  assert.match(environment, /webForbiddenProductionValues[\s\S]*"SQUARE_CLIENT_SECRET"/u);

  assert.ok(runtimeContract.runtimes.web.requiredRuntimeValues.includes("SQUARE_CLIENT_ID"));
  assert.ok(runtimeContract.runtimes.web.forbiddenRuntimeValues.includes("SQUARE_CLIENT_SECRET"));
  for (const runtime of ["sync-worker", "deletion-worker"] as const) {
    assert.ok(runtimeContract.runtimes[runtime].requiredSecretNames.includes("SQUARE_CLIENT_ID"));
    assert.ok(runtimeContract.runtimes[runtime].requiredSecretNames.includes("SQUARE_CLIENT_SECRET"));
  }
});

test("OAuth persists the manifest policy before any optional initial enqueue", async () => {
  const oauthStore = await source("services/sync-workers/src/oauth-session-store.ts");
  const policyAt = oauthStore.indexOf("configure_connection_ingestion_policy");
  const enqueueAt = oauthStore.indexOf("control_plane.enqueue_sync_job", policyAt);

  assert.ok(policyAt > 0);
  assert.ok(enqueueAt > policyAt);
  assert.match(oauthStore, /: input\.ingestionInitialStart/u);
  assert.match(oauthStore, /effectiveInitialStart === "manual"/u);
});

test("the durable queue boundary and every automatic producer require current-generation activation", async () => {
  const activation = await source("infra/migrations/control-plane/0122_m1_manual_ingestion_activation.sql");
  const supersession = await source("infra/migrations/control-plane/0123_m2_shopify_generation_activation.sql");

  assert.match(activation, /ADD COLUMN IF NOT EXISTS ingestion_activated_generation bigint/u);
  assert.match(
    activation,
    /activated_generation IS DISTINCT FROM current_generation/u,
  );
  assert.match(
    activation,
    /request\.payload ->> 'connectionGeneration' = connection\.connection_generation::text/u,
  );
  assert.ok(
    (supersession.match(
      /connection\.ingestion_activated_generation = connection\.connection_generation/gu,
    )?.length ?? 0) >= 4,
    "incremental, recovery, reconciliation, and phase recovery must all filter inactive generations",
  );
});

test("Start ingestion uses the same current-organisation resolver as the rest of the product", async () => {
  const migration = await source(
    "infra/migrations/control-plane/0139_m1_current_org_ingestion_start.sql",
  );
  assert.match(migration, /control_plane\.current_selected_tenant_id\(\)/u);
  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION public\.albert_start_connection_ingestion_before_shopify_continuity/u,
  );
  assert.doesNotMatch(
    migration,
    /JOIN control_plane\.user_active_tenants AS active/u,
  );
});

test("Start ingestion is an authenticated, rate-limited, idempotent current-generation capability", async () => {
  const migration = await source("infra/migrations/control-plane/0122_m1_manual_ingestion_activation.sql");
  const route = await source("app/api/connections/start-ingestion/route.ts");

  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.albert_start_connection_ingestion/u);
  assert.match(migration, /FOR UPDATE/u);
  assert.match(migration, /'manual-start:' \|\| p_connection_id \|\| ':g'/u);
  assert.match(migration, /ingestion_activated_generation = v_connection\.connection_generation/u);
  assert.match(migration, /REVOKE ALL[^;]+FROM PUBLIC, anon/u);
  assert.match(migration, /GRANT EXECUTE[^;]+TO authenticated/u);

  const rpcAt = route.indexOf("albert_start_connection_ingestion");
  assert.ok(rpcAt > 0);
  for (const guard of [
    "assertSameOriginMutation(request)",
    'consumeAlbertRateLimit("connection.start_ingestion")',
    "readBoundedJsonBody(request)",
    '["owner", "manager"].includes(tenant.role)',
  ]) {
    const guardAt = route.indexOf(guard);
    assert.ok(guardAt > -1 && guardAt < rpcAt, `${guard} must run before the RPC`);
  }
});

test("the workspace exposes Square as connected but inert until the manual action", async () => {
  const workspace = toConnectionsWorkspace({
    tenant_id: "01J00000000000000000000001",
    tenant_name: "Corner Cafe",
    connections: [{
      connection_id: "01J00000000000000000000002",
      connector_key: "square",
      display_name: "Corner Cafe",
      status: "connected",
      auth_health: "healthy",
      manual_ingestion_start_required: true,
      ingestion_state: "awaiting_manual_start",
      readiness: [],
    }],
    dossier: null,
    identity_review_tasks: [],
    blocking_answers: {},
    oauth_sessions: [],
  }, "Australia/Melbourne");
  const square = workspace.providers.find(({ id }) => id === "square");

  assert.equal(square?.connections[0]?.ingestionState, "awaiting_manual_start");
  assert.equal(square?.connections[0]?.manualIngestionStartRequired, true);
  assert.equal(workspace.syncSummary.progress, 0);
  assert.match(workspace.syncSummary.detail, /Start ingestion/u);

  const component = await source("app/dash/components/ConnectionsWorkspace.tsx");
  assert.match(
    component,
    /initialStart && providerId !== "shopify"\s*\n\s*\? "\/api\/connections\/start-ingestion"\s*\n\s*: "\/api\/connections\/sync"/u,
  );
  assert.match(
    component,
    /requestManualSync\(\s*connection\.connectionId,\s*true,\s*provider\.id/u,
  );
  assert.match(component, /Connected\. No data has been imported yet\./u);
});
