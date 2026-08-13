import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { momenceManifest } from "../../connectors/momence/manifest";
import { toConnectionsWorkspace } from "../../services/control-plane/src/connections-workspace";

const root = new URL("../../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

test("Momence authorization is inert until a current-generation Start ingestion request", async () => {
  const [oauthStore, initialPolicy, migration, route] = await Promise.all([
    source("services/sync-workers/src/oauth-session-store.ts"),
    source("infra/migrations/control-plane/0122_m1_manual_ingestion_activation.sql"),
    source("infra/migrations/control-plane/0125_m1_momence_manual_ingestion_activation.sql"),
    source("app/api/connections/start-ingestion/route.ts"),
  ]);

  assert.equal(momenceManifest.ingestion.initialStart, "manual");
  assert.match(
    oauthStore,
    /effectiveInitialStart = input\.context\.provider === "shopify"[\s\S]{0,240}input\.context\.provider === "momence"[\s\S]{0,240}\? "manual"/u,
  );
  assert.match(
    oauthStore,
    /suppressInitialBackfill = input\.context\.provider === "shopify"[\s\S]{0,240}input\.context\.provider === "momence"[\s\S]{0,320}effectiveInitialStart === "manual"/u,
  );
  assert.match(
    oauthStore,
    /if \(!suppressInitialBackfill\) \{[\s\S]*enqueue_sync_job/u,
  );
  assert.match(
    initialPolicy,
    /connector_key IN \('square','shopify','lightspeed-x','momence'\) THEN 'manual'/u,
    "Momence must be fenced in the first committed policy migration, not repaired later",
  );

  assert.match(migration, /connection\.connector_key = 'momence'/u);
  assert.match(migration, /SET ingestion_start_mode = 'manual'/u);
  assert.match(migration, /ingestion_activated_generation = NULL/u);
  assert.match(migration, /ingestion_start_mode <> 'manual'/u);

  assert.match(route, /assertSameOriginMutation\(request\)/u);
  assert.match(route, /\["owner", "manager"\]\.includes\(tenant\.role\)/u);
  assert.match(route, /consumeAlbertRateLimit\("connection\.start_ingestion"\)/u);
  assert.match(route, /rpc\("albert_start_connection_ingestion"/u);
});

test("Momence UI exposes Start ingestion first and Sync only after activation", async () => {
  const [component, callback] = await Promise.all([
    source("app/dash/components/ConnectionsWorkspace.tsx"),
    source("app/api/oauth/[provider]/callback/route.ts"),
  ]);
  const connectionId = "01J00000000000000000000000";
  const workspace = toConnectionsWorkspace({
    tenant_id: "tenant-momence",
    tenant_name: "Studio Test",
    connections: [{
      connection_id: connectionId,
      connector_key: "momence",
      display_name: "Studio Test",
      status: "connected",
      auth_health: "healthy",
      account_metadata: {},
      manual_ingestion_start_required: true,
      ingestion_state: "awaiting_manual_start",
      readiness: [],
    }],
    dossier: null,
    identity_review_tasks: [],
    blocking_answers: {},
    oauth_sessions: [],
  }, "Australia/Melbourne");

  const momence = workspace.providers.find(({ id }) => id === "momence");
  assert.ok(momence);
  assert.equal(momence.connections[0]?.manualIngestionStartRequired, true);
  assert.equal(momence.connections[0]?.ingestionState, "awaiting_manual_start");
  assert.match(workspace.syncSummary.detail, /Start ingestion/u);

  assert.match(component, /initialStart && providerId !== "shopify"[\s\S]{0,120}"\/api\/connections\/start-ingestion"/u);
  assert.match(component, /manualIngestionStartRequired[\s\S]{0,480}"Start ingestion"/u);
  assert.match(component, /Connected\. No data has been imported yet\./u);
  assert.match(component, /manualIngestionStartRequired[\s\S]{0,700}"Sync now"/u);
  assert.match(
    callback,
    /result\.status === "connected" && !result\.jobRequestId[\s\S]{0,120}"connected_without_sync"/u,
  );
});

test("production admits Momence as an optional atomic OAuth provider without exposing its secret to web", async () => {
  const [config, factory, runtimeText] = await Promise.all([
    source("services/sync-workers/src/config.ts"),
    source("services/sync-workers/src/connector-factory.ts"),
    source("deploy/runtime-contract.json"),
  ]);
  const runtime = JSON.parse(runtimeText) as {
    runtimes: {
      web: { optionalRuntimeValues: string[]; forbiddenRuntimeValues: string[] };
      "sync-worker": { optionalSecretNames: string[] };
    };
  };

  assert.match(config, /MOMENCE_CLIENT_ID and MOMENCE_CLIENT_SECRET must be configured together/u);
  assert.match(factory, /if \(provider === "momence"\)[\s\S]*new MomenceConnector/u);
  assert.match(factory, /connectors\.push\(\["momence", factory\.create\("momence", vault\)\]\)/u);
  assert.ok(runtime.runtimes.web.optionalRuntimeValues.includes("MOMENCE_CLIENT_ID"));
  assert.ok(runtime.runtimes.web.forbiddenRuntimeValues.includes("MOMENCE_CLIENT_SECRET"));
  assert.ok(runtime.runtimes["sync-worker"].optionalSecretNames.includes("MOMENCE_CLIENT_ID"));
  assert.ok(runtime.runtimes["sync-worker"].optionalSecretNames.includes("MOMENCE_CLIENT_SECRET"));
});
