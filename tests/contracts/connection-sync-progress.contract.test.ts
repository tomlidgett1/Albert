import assert from "node:assert/strict";
import test from "node:test";
import {
  connectionCardStatus,
  connectionIngestionIsPending,
  connectionShowsSyncProgress,
  connectionSyncSummary,
  workspaceSyncIsActive,
} from "../../app/dash/components/connection-sync.ts";
import type { ConnectionAccountData, DomainReadiness } from "../../app/dash/components/ConnectionsWorkspace.tsx";

function domain(partial: Partial<DomainReadiness> & Pick<DomainReadiness, "id" | "label" | "state" | "detail">): DomainReadiness {
  return partial;
}

function connection(partial: Pick<ConnectionAccountData, "connectionId" | "auth" | "domains"> & Partial<ConnectionAccountData>): ConnectionAccountData {
  return partial;
}

test("empty domains are idle, not an in-progress sync", () => {
  assert.deepEqual(connectionSyncSummary([]), { progress: undefined, state: "not_started" });
  assert.equal(workspaceSyncIsActive([]), false);
  assert.equal(connectionShowsSyncProgress([]), false);
  assert.equal(connectionShowsSyncProgress([], "queued"), false);
  assert.equal(connectionShowsSyncProgress([], "running"), false);
  assert.equal(connectionIngestionIsPending("queued", []), true);
  assert.equal(connectionIngestionIsPending("running", []), true);
});

test("blocked domains with leftover progress do not keep a sync bar alive", () => {
  const domains = [
    domain({
      id: "sales",
      label: "Sales",
      state: "blocked",
      detail: "connection disconnected",
      progress: 80,
    }),
    domain({
      id: "inventory",
      label: "Inventory",
      state: "blocked",
      detail: "connection disconnected",
      progress: 75,
    }),
  ];

  assert.equal(connectionSyncSummary(domains).state, "blocked");
  assert.equal(workspaceSyncIsActive(domains), false);
  assert.equal(connectionShowsSyncProgress(domains, "running"), false);
  assert.equal(connectionIngestionIsPending("running", domains), false);
});

test("ready_partial still shows sync progress", () => {
  const domains = [
    domain({
      id: "accounting",
      label: "Accounting",
      state: "ready_partial",
      detail: "Recent data is queryable while deep history continues.",
      progress: 63,
    }),
  ];

  assert.equal(connectionShowsSyncProgress(domains), true);
  assert.equal(workspaceSyncIsActive(domains), true);
});

test("Tom's Lightspeed, Xero, and Deputy cards do not look like they are syncing", () => {
  const lightspeed = connection({
    connectionId: "01KZ54B1PCKM1MHSNHY4XT6DEX",
    ingestionState: "running",
    auth: {
      state: "healthy",
      label: "Connected",
      detail: "Ashburton Cycles",
      accountName: "Ashburton Cycles",
    },
    domains: [
      domain({
        id: "sales",
        label: "Sales",
        state: "blocked",
        detail: "connection disconnected",
        progress: 80,
      }),
    ],
  });
  const xero = connection({
    connectionId: "01KZA8DKH0HCKSTT1AKYTQW21W",
    ingestionState: "running",
    auth: {
      state: "error",
      label: "Connection error",
      detail: "Ashburton Cycles",
      accountName: "Ashburton Cycles",
    },
    domains: [
      domain({
        id: "accounting",
        label: "Accounting",
        state: "blocked",
        detail: "canonical transform failed",
        progress: 75,
      }),
    ],
  });
  const deputy = connection({
    connectionId: "01KZA9XZV9T7EK91TC1Y63VAHG",
    ingestionState: "queued",
    auth: {
      state: "healthy",
      label: "Connected",
      detail: "Tom Lidgett",
      accountName: "Tom Lidgett",
    },
    domains: [],
  });

  assert.equal(connectionShowsSyncProgress(lightspeed.domains, lightspeed.ingestionState), false);
  assert.equal(connectionShowsSyncProgress(xero.domains, xero.ingestionState), false);
  assert.equal(connectionShowsSyncProgress(deputy.domains, deputy.ingestionState), false);

  assert.deepEqual(connectionCardStatus(lightspeed), {
    authState: "error",
    label: "Blocked",
    detail: "Connection disconnected",
  });
  assert.deepEqual(connectionCardStatus(xero), {
    authState: "error",
    label: "Connection error",
    detail: "Canonical transform failed",
  });
  assert.deepEqual(connectionCardStatus(deputy), {
    authState: "authorizing",
    label: "Queued",
    detail: "Tom Lidgett",
  });
});
