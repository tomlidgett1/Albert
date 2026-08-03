import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { toConnectionsWorkspace } from "../../services/control-plane/src/connections-workspace.js";

const connectionsComponent = readFileSync(
  resolve("app/dash/components/ConnectionsWorkspace.tsx"),
  "utf8",
);
const dashPage = readFileSync(resolve("app/dash/page.tsx"), "utf8");
const dashStyles = readFileSync(resolve("app/dash/dash.module.css"), "utf8");

const connectionIds = Object.freeze({
  lightspeed: "01J00000000000000000000010",
  xeroAustralia: "01J00000000000000000000011",
  xeroNewZealand: "01J00000000000000000000012",
  disconnectedXero: "01J00000000000000000000013",
});

function multiAccountWorkspace() {
  return toConnectionsWorkspace({
    tenant_id: "01J00000000000000000000001",
    tenant_name: "Albert Retail Group",
    connections: [
      {
        connection_id: connectionIds.lightspeed,
        connector_key: "lightspeed-r",
        display_name: "Albert Bikes Melbourne",
        status: "connected",
        auth_health: "healthy",
        readiness: [{
          domain: "sales",
          state: "ready_partial",
          progress: 0.5,
          data_ready_through: "2026-08-03T00:30:00.000Z",
        }],
      },
      {
        connection_id: connectionIds.xeroAustralia,
        connector_key: "xero",
        display_name: "Albert Retail Australia Pty Ltd",
        status: "connected",
        auth_health: "healthy",
        readiness: [{
          domain: "accounting",
          state: "ready_partial",
          progress: 0.8,
          data_ready_through: "2026-08-03T00:40:00.000Z",
        }],
      },
      {
        connection_id: connectionIds.xeroNewZealand,
        connector_key: "xero",
        display_name: "Albert Retail New Zealand Limited",
        status: "degraded",
        auth_health: "error",
        readiness: [{
          domain: "accounting",
          state: "degraded",
          progress: 0.25,
          reason_code: "reauthorisation_required",
        }],
      },
      {
        connection_id: connectionIds.disconnectedXero,
        connector_key: "xero",
        display_name: "Historical Xero organisation",
        status: "disconnected",
        auth_health: "revoked",
        last_checked_at: "2026-08-03T12:00:00.000Z",
        readiness: [{
          domain: "accounting",
          state: "blocked",
          progress: 1,
        }],
      },
    ],
    dossier: null,
    identity_review_tasks: [],
    blocking_answers: {},
    oauth_sessions: [],
  }, "Australia/Melbourne");
}

test("the workspace preserves every current Xero organisation as a connection-bound account", () => {
  const workspace = multiAccountWorkspace();
  const xero = workspace.providers.find((provider) => provider.id === "xero");
  const lightspeed = workspace.providers.find((provider) => provider.id === "lightspeed");

  assert.ok(xero);
  assert.deepEqual(
    xero.connections.map(({ connectionId }) => connectionId),
    [connectionIds.xeroAustralia, connectionIds.xeroNewZealand],
  );
  assert.deepEqual(
    xero.connections.map(({ auth }) => auth.accountName),
    ["Albert Retail Australia Pty Ltd", "Albert Retail New Zealand Limited"],
  );
  assert.equal(xero.additionalConnectionLabel, "Add another Xero organisation");
  assert.equal(lightspeed?.connections.length, 1);
  assert.equal(lightspeed?.additionalConnectionLabel, undefined);
  assert.equal(
    workspace.providers.flatMap(({ connections }) => connections)
      .some(({ connectionId }) => connectionId === connectionIds.disconnectedXero),
    false,
  );
});

test("fractional readiness is normalized once to UI percentages across every account", () => {
  const workspace = multiAccountWorkspace();
  const xero = workspace.providers.find((provider) => provider.id === "xero");
  const lightspeed = workspace.providers.find((provider) => provider.id === "lightspeed");

  assert.deepEqual(xero?.connections.map(({ domains }) => domains[0]?.progress), [80, 25]);
  assert.equal(lightspeed?.connections[0]?.domains[0]?.progress, 50);
  assert.equal(workspace.syncSummary.progress, 52);
  assert.equal(workspace.syncSummary.latestActivityAt, "2026-08-03T00:40:00.000Z");

  const domainIds = workspace.providers.flatMap(({ connections }) =>
    connections.flatMap(({ domains }) => domains.map(({ id }) => id))
  );
  assert.equal(new Set(domainIds).size, domainIds.length);
  assert.ok(domainIds.some((id) => id.includes(connectionIds.xeroAustralia)));
  assert.ok(domainIds.some((id) => id.includes(connectionIds.xeroNewZealand)));
});

test("the Connections component exposes per-account manage, readiness, disconnect, and add-another actions", () => {
  assert.match(connectionsComponent, /provider\.connections\.map\(\(connection\)/u);
  assert.match(connectionsComponent, /if \(onManage\) onManage\(connection\.connectionId\)/u);
  assert.match(
    connectionsComponent,
    /onDisconnect\?\.\(managedConnection\.connection\.connectionId\)/u,
  );
  assert.match(connectionsComponent, /Only this connection stops syncing/u);
  assert.match(connectionsComponent, /provider\.additionalConnectionLabel/u);
  assert.match(connectionsComponent, /onClick=\{\(\) => onConnect\?\.\(provider\.id\)\}/u);
  assert.match(connectionsComponent, /data-connection-id=\{connection\.connectionId\}/u);
  assert.match(dashPage, /window\.location\.assign\(`\/api\/oauth\/\$\{providerId\}\/start`\)/u);
});

test("the additional-account control follows dash sizing, focus, responsive, and reduced-motion rules", () => {
  assert.match(dashStyles, /\.connectionsProviderAddAction\s*\{[\s\S]*border-radius:\s*999px/u);
  assert.match(
    dashStyles,
    /\.connectionsProviderActionPrimary,[\s\S]*\.connectionsProviderAddAction,[\s\S]*height:\s*var\(--dash-control-height\)/u,
  );
  assert.match(dashStyles, /\.connectionsProviderAddAction:focus-visible/u);
  assert.match(
    dashStyles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.connectionsProviderAddAction,[\s\S]*transition:\s*none/u,
  );
  assert.match(dashStyles, /@media \(max-width: 520px\)[\s\S]*\.connectionsProviderRow/u);
});
