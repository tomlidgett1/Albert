import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CONNECTOR_IDS } from "../../packages/connector-sdk/src/index.js";
import { toConnectionsWorkspace } from "../../services/control-plane/src/connections-workspace.js";
import {
  FIVETRAN_XERO_DESTINATION_SCHEMA,
  fivetranXeroConnectionSchema,
  isFivetranDestinationSchema,
} from "../../packages/fivetran/src/index.js";

const workspace = readFileSync("services/control-plane/src/connections-workspace.ts", "utf8");
const connectionsUi = readFileSync("app/dash/components/ConnectionsWorkspace.tsx", "utf8");
const dashPage = readFileSync("app/dash/page.tsx", "utf8");
const callback = readFileSync("app/api/oauth/[provider]/callback/route.ts", "utf8");
const repository = readFileSync("services/control-plane/src/web-repository.ts", "utf8");
const routing = readFileSync("tests/contracts/v3-query-context-routing.contract.test.ts", "utf8");
const knownConnector = readFileSync(
  "infra/migrations/control-plane/0124_m1_lightspeed_x_connector_admission.sql",
  "utf8",
);
const fivetranMigration = readFileSync(
  "infra/migrations/control-plane/0145_m1_fivetran_xero_connections.sql",
  "utf8",
);
const tenantSchemaMigration = readFileSync(
  "infra/migrations/control-plane/0146_m1_fivetran_xero_tenant_schemas.sql",
  "utf8",
);
const tenantBindingMigration = readFileSync(
  "infra/migrations/analytical/0166_m1_fivetran_xero_tenant_bindings.sql",
  "utf8",
);
const tenantBindingOwnerWrite = readFileSync(
  "infra/migrations/analytical/0167_m1_fivetran_destination_owner_write.sql",
  "utf8",
);
const hidePendingMigration = readFileSync(
  "infra/migrations/control-plane/0147_m1_fivetran_hide_pending_workspace.sql",
  "utf8",
);

test("Fivetran Xero writes Fivetran's native tables into a tenant-isolated schema", () => {
  assert.equal(FIVETRAN_XERO_DESTINATION_SCHEMA, "xero");
  assert.equal(isFivetranDestinationSchema("xero"), true);
  assert.equal(isFivetranDestinationSchema("5XERO"), false);
  assert.equal(isFivetranDestinationSchema("5xero"), false);
  assert.equal(
    fivetranXeroConnectionSchema("01KZN20VTX2EWW1TQ2AA3MCPW6"),
    "xero_01kzn20vtx2eww1tq2aa3mcpw6",
  );
  assert.match(fivetranMigration, /destination_schema text NOT NULL\s+CHECK \(destination_schema ~ '\^\[a-z\]\[a-z0-9_\]\{0,127\}\$'\)/u);
  assert.doesNotMatch(fivetranMigration, /5XERO|source_xero/u);
  assert.match(tenantSchemaMigration, /UNIQUE \(destination_schema\)/u);
  assert.match(tenantBindingMigration, /ingestion\.fivetran_destination_bindings/u);
  assert.match(tenantBindingMigration, /ADD COLUMN tenant_id text/u);
  assert.match(tenantBindingMigration, /CREATE POLICY tenant_scope/u);
  assert.match(tenantBindingOwnerWrite, /NO FORCE ROW LEVEL SECURITY/u);
  assert.match(hidePendingMigration, /AND connection\.status IN \('connected', 'degraded', 'blocked'\)/u);
  assert.match(workspace, /Full Xero ingest through Fivetran, into a tenant-isolated native schema/u);
});

test("Fivetran Xero stays outside Albert connector packs and V3 routing", () => {
  assert.equal((CONNECTOR_IDS as readonly string[]).includes("fivetran-xero"), false);
  assert.match(
    knownConnector,
    /'lightspeed-r', 'lightspeed-x', 'xero', 'deputy', 'square',\s*'shopify', 'stripe', 'momence', 'meta-ads', 'google-ads'/u,
  );
  assert.doesNotMatch(knownConnector, /fivetran-xero/u);
  assert.match(fivetranMigration, /outside is_known_connector/u);
  assert.match(repository, /albert_fivetran_workspace_connections/u);
  assert.match(repository, /loadConnectorRouting/u);
  assert.doesNotMatch(
    repository.slice(repository.indexOf("export async function loadConnectorRouting")),
    /albert_fivetran_workspace_connections/u,
  );
  assert.match(routing, /assert\.deepEqual\(calls, \["albert_connections_workspace", "albert_connector_freshness"\]\)/u);
});

test("the connections page starts Fivetran Xero through a Connect Card and returns to Albert", () => {
  assert.match(connectionsUi, /id: "fivetran-xero" as const/u);
  assert.match(connectionsUi, /name: "Xero \(Fivetran\)"/u);
  assert.match(dashPage, /"fivetran-xero": "Xero \(Fivetran\)"/u);
  assert.match(dashPage, /"fivetran-xero"/u);
  assert.match(callback, /isFivetranWebProvider\(provider\)/u);
  assert.match(callback, /finishFivetranOAuthFlow/u);
  const webFlow = readFileSync("services/oauth/src/web-flow.ts", "utf8");
  assert.match(webFlow, /"fivetran-xero": "xero"/u);
  assert.match(webFlow, /"fivetran-lightspeed": "light_speed_retail"/u);
  assert.match(webFlow, /"fivetran-deputy": "deputy"/u);
  assert.match(webFlow, /cookieName\(input\.provider\)/u);
  assert.match(webFlow, /connectCardUri/u);
  assert.match(webFlow, /https:\/\/fivetran\.com\//u);
  assert.match(webFlow, /\/api\/oauth\/\$\{browserProvider\(input\.provider\)\}\/callback/u);
  assert.match(repository, /status !== "pending"/u);

  const workspaceView = toConnectionsWorkspace({
    tenant_id: "01J00000000000000000000001",
    tenant_name: "Albert Retail Group",
    connections: [{
      connection_id: "01J00000000000000000000030",
      connector_key: "fivetran-xero",
      display_name: "Xero (Fivetran)",
      status: "connected",
      auth_health: "healthy",
      manual_ingestion_start_required: false,
      ingestion_state: "active",
      readiness: [{
        domain: "accounting",
        state: "syncing",
      }],
    }],
    dossier: null,
    identity_review_tasks: [],
    blocking_answers: {},
    oauth_sessions: [],
  }, "Australia/Melbourne");
  const fivetran = workspaceView.providers.find((provider) => provider.id === "fivetran-xero");
  assert.ok(fivetran);
  assert.equal(fivetran.name, "Xero (Fivetran)");
  assert.equal(fivetran.connections[0]?.connectionId, "01J00000000000000000000030");
  assert.equal(fivetran.connections[0]?.manualIngestionStartRequired, false);
});
