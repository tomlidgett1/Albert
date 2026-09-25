import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { lightspeedXManifest } from "../../connectors/lightspeed-x/manifest";
import { toConnectionsWorkspace } from "../../services/control-plane/src/connections-workspace";

const root = new URL("../../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

test("Lightspeed X OAuth stores authorization without publishing ingestion work", async () => {
  const [oauthStore, callback, admission] = await Promise.all([
    source("services/sync-workers/src/oauth-session-store.ts"),
    source("app/api/oauth/[provider]/callback/route.ts"),
    source("infra/migrations/control-plane/0124_m1_lightspeed_x_connector_admission.sql"),
  ]);

  assert.equal(lightspeedXManifest.ingestion.initialStart, "manual");

  const policyStart = oauthStore.indexOf("const effectiveInitialStart");
  const policyEnd = oauthStore.indexOf("configure_connection_ingestion_policy", policyStart);
  const suppressionStart = oauthStore.indexOf("const suppressInitialBackfill", policyEnd);
  const suppressionEnd = oauthStore.indexOf("if (!suppressInitialBackfill)", suppressionStart);
  const enqueue = oauthStore.indexOf("control_plane.enqueue_sync_job", suppressionEnd);
  assert.ok(policyStart > 0 && policyEnd > policyStart);
  assert.match(oauthStore.slice(policyStart, policyEnd), /input\.context\.provider === "lightspeed-x"/u);
  assert.match(oauthStore.slice(policyStart, policyEnd), /\? "manual"/u);
  assert.ok(suppressionStart > policyEnd && suppressionEnd > suppressionStart);
  assert.match(
    oauthStore.slice(suppressionStart, suppressionEnd),
    /input\.context\.provider === "lightspeed-x"/u,
  );
  assert.ok(enqueue > suppressionEnd, "the enqueue must remain inside the non-suppressed branch");
  assert.match(
    callback,
    /result\.status === "connected" && !result\.jobRequestId[\s\S]{0,160}"connected_without_sync"/u,
  );

  // Rolling deployment defence: an X-Series row can never inherit activation
  // from a previous or temporarily misclassified connector generation.
  assert.match(admission, /connection\.connector_key = 'lightspeed-x'/u);
  assert.match(admission, /SET ingestion_start_mode = 'manual'/u);
  assert.match(admission, /ingestion_activated_at = NULL/u);
  assert.match(admission, /ingestion_activated_generation = NULL/u);
});

test("Lightspeed X Start ingestion is an authenticated current-generation capability", async () => {
  const [route, activation, generationFence] = await Promise.all([
    source("app/api/connections/start-ingestion/route.ts"),
    source("infra/migrations/control-plane/0122_m1_manual_ingestion_activation.sql"),
    source("infra/migrations/control-plane/0123_m2_shopify_generation_activation.sql"),
  ]);

  const rpcAt = route.indexOf('rpc("albert_start_connection_ingestion"');
  assert.ok(rpcAt > 0);
  for (const guard of [
    "assertSameOriginMutation(request)",
    "currentTenantContext()",
    '["owner", "manager"].includes(tenant.role)',
    'consumeAlbertRateLimit("connection.start_ingestion")',
    "readBoundedJsonBody(request)",
  ]) {
    const guardAt = route.indexOf(guard);
    assert.ok(guardAt >= 0 && guardAt < rpcAt, `${guard} must run before the RPC`);
  }

  const functionStart = activation.indexOf(
    "CREATE OR REPLACE FUNCTION public.albert_start_connection_ingestion",
  );
  const functionEnd = activation.indexOf(
    "REVOKE ALL ON FUNCTION public.albert_start_connection_ingestion",
    functionStart,
  );
  assert.ok(functionStart > 0 && functionEnd > functionStart);
  const capability = activation.slice(functionStart, functionEnd);
  assert.match(capability, /extensions\.albert_auth_uid\(\)/u);
  assert.match(capability, /membership\.status = 'active'/u);
  assert.match(capability, /v_role NOT IN \('owner', 'manager'\)/u);
  assert.match(capability, /connection\.tenant_id = v_tenant_id/u);
  assert.match(capability, /FOR UPDATE/u);
  assert.match(capability, /ingestion_start_mode <> 'manual'/u);
  assert.match(capability, /ingestion_activated_generation = v_connection\.connection_generation/u);
  assert.match(capability, /'manual-start:' \|\| p_connection_id \|\| ':g'/u);
  assert.match(capability, /control_plane\.enqueue_sync_job/u);
  assert.match(activation, /REVOKE ALL[^;]+FROM PUBLIC, anon/u);
  assert.match(activation, /GRANT EXECUTE[^;]+TO authenticated/u);

  // The final publication implementation re-checks activation at enqueue and
  // claim time, so a stale generation cannot race the browser transaction.
  assert.match(
    generationFence,
    /activated_generation IS DISTINCT FROM current_generation[\s\S]{0,180}RAISE EXCEPTION/u,
  );
  assert.match(
    generationFence,
    /request\.payload ->> 'connectionGeneration' =[\s\S]{0,80}connection\.connection_generation::text/u,
  );
});

test("Lightspeed X is visibly connected but inert until Start ingestion", async () => {
  const [component, dashPage, css] = await Promise.all([
    source("app/dash/components/ConnectionsWorkspace.tsx"),
    source("app/dash/page.tsx"),
    source("app/dash/dash.module.css"),
  ]);
  const connectionId = "01J00000000000000000000000";
  const workspace = toConnectionsWorkspace({
    tenant_id: "01J00000000000000000000001",
    tenant_name: "X-Series retailer",
    connections: [{
      connection_id: connectionId,
      connector_key: "lightspeed-x",
      display_name: "X-Series retailer",
      status: "connected",
      auth_health: "healthy",
      account_metadata: { registerCount: 2 },
      manual_ingestion_start_required: true,
      ingestion_state: "awaiting_manual_start",
      readiness: [],
    }],
    dossier: null,
    identity_review_tasks: [],
    blocking_answers: {},
    oauth_sessions: [],
  }, "Australia/Melbourne");
  const provider = workspace.providers.find(({ id }) => id === "lightspeed-x");

  assert.ok(provider);
  assert.equal(provider.connections[0]?.manualIngestionStartRequired, true);
  assert.equal(provider.connections[0]?.ingestionState, "awaiting_manual_start");
  assert.equal(workspace.syncSummary.progress, 0);
  assert.match(workspace.syncSummary.detail, /Start ingestion/u);
  assert.match(
    component,
    /initialStart && providerId !== "shopify"\s*\n\s*\? "\/api\/connections\/start-ingestion"/u,
  );
  assert.match(
    component,
    /requestManualSync\(\s*connection\.connectionId,\s*true,\s*provider\.id/u,
  );
  assert.match(component, /Not imported yet/u);
  assert.match(
    dashPage,
    /connected_without_sync[\s\S]{0,220}Data will not be ingested until you choose Start ingestion\./u,
  );

  // The action reuses the dash's 36px pill CTA, theme tokens, keyboard focus,
  // busy state, and reduced-motion override rather than a connector-only style.
  assert.match(component, /aria-busy=\{connectionSyncState\.status === "requesting"\}/u);
  assert.match(css, /\.connectionsProviderActionPrimary,[\s\S]{0,260}height: var\(--dash-control-height\)/u);
  assert.match(css, /\.connectionsStartIngestionAction \{[\s\S]{0,180}background: var\(--dash-contrast\)[\s\S]{0,120}color: var\(--dash-on-contrast\)/u);
  assert.match(css, /\.connectionsProviderActionPrimary:focus-visible[\s\S]{0,260}outline: 2px solid var\(--dash-focus\)/u);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.connectionsStartIngestionAction:hover:not\(:disabled\)[\s\S]{0,180}transform: none/u);
});

test("production keeps X credentials server-only and Cube pinned in Sydney", async () => {
  const [config, factory, runtimeText, cubeToml, cubeDockerfile] = await Promise.all([
    source("services/sync-workers/src/config.ts"),
    source("services/sync-workers/src/connector-factory.ts"),
    source("deploy/runtime-contract.json"),
    source("deploy/fly/cube.toml"),
    source("cube-playground/Dockerfile"),
  ]);
  const runtime = JSON.parse(runtimeText) as {
    lockedRegions: { analytical: string };
    runtimes: {
      web: { optionalRuntimeValues: string[]; forbiddenRuntimeValues: string[] };
      cube: { exposure: string; requiredSecretNames: string[] };
      "sync-worker": { optionalSecretNames: string[] };
    };
  };

  assert.match(config, /Boolean\(lightspeedXClientId\) !== Boolean\(lightspeedXClientSecret\)/u);
  assert.match(config, /ALBERT_LIGHTSPEED_X_PRODUCT must explicitly confirm x-series/u);
  assert.match(factory, /connectors\.push\(\["lightspeed-x", factory\.create\("lightspeed-x", vault\)\]\)/u);
  assert.ok(runtime.runtimes.web.optionalRuntimeValues.includes("LIGHTSPEED_X_CLIENT_ID"));
  assert.ok(runtime.runtimes.web.forbiddenRuntimeValues.includes("LIGHTSPEED_X_CLIENT_SECRET"));
  assert.ok(runtime.runtimes["sync-worker"].optionalSecretNames.includes("LIGHTSPEED_X_CLIENT_ID"));
  assert.ok(runtime.runtimes["sync-worker"].optionalSecretNames.includes("LIGHTSPEED_X_CLIENT_SECRET"));
  assert.equal(runtime.lockedRegions.analytical, "ap-southeast-2");
  assert.equal(runtime.runtimes.cube.exposure, "signed-public");
  assert.deepEqual(runtime.runtimes.cube.requiredSecretNames, [
    "ALBERT_SEMANTIC_READ_DATABASE_URL",
    "ALBERT_SEMANTIC_CONTROL_DATABASE_URL",
    "CUBEJS_API_SECRET",
  ]);
  assert.match(cubeToml, /^primary_region = "syd"/mu);
  assert.match(cubeToml, /ALBERT_ANALYTICAL_REGION = "ap-southeast-2"/u);
  assert.match(cubeToml, /CUBEJS_DEV_MODE = "false"/u);
  assert.match(cubeToml, /min_machines_running = 1/u);
  assert.match(
    cubeDockerfile,
    /^FROM cubejs\/cube:v1\.7\.16@sha256:7a33cdc4469ccde403fae519441b06bdcd80e60032d1d793739eb860a0ea3bcc$/mu,
  );
  assert.doesNotMatch(cubeDockerfile, /:latest\b/u);
});
