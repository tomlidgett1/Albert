import assert from "node:assert/strict";
import test from "node:test";

import { signInternalRequest } from "../../packages/security/src/index.js";
import { FivetranClient } from "../../packages/fivetran/src/index.js";
import type { FivetranDestinationStore } from "./src/fivetran-destinations.js";
import { FivetranWorkerHttpHandler } from "./src/fivetran-http.js";
import { stripeFivetranAccessToken } from "./src/fivetran-native-credentials.js";
import type { FivetranConnectionStore } from "./src/fivetran-store.js";

const secret = "s".repeat(48);
const redirectUri = "https://albert.example/api/oauth/fivetran-xero/callback";

function handler(
  store: FivetranConnectionStore,
  client: FivetranClient,
  destinations?: FivetranDestinationStore,
) {
  return new FivetranWorkerHttpHandler({
    oauthWorkerSigningSecret: secret,
    allowedRedirectUris: new Set([redirectUri]),
    config: {
      apiKey: "key",
      apiSecret: "secret",
      groupId: "group",
      destinationSchema: "xero",
      tokenBrokerOrigin: "https://worker.example",
      sdkProjectDir: "connectors/xero-fivetran-sdk",
    },
    store,
    destinations: destinations ?? {
      async bind() {},
      async stamp() { return 0; },
    } as unknown as FivetranDestinationStore,
    client,
  });
}

test("Fivetran worker rejects unsigned calls", async () => {
  const response = await handler({} as FivetranConnectionStore, {} as FivetranClient).handle(
    new Request("https://worker.internal/v1/fivetran/xero/start", { method: "POST", body: "{}" }),
  );
  assert.equal(response.status, 401);
});

test("Fivetran start for Xero deploys Albert's SDK connector and wires the token broker", async () => {
  const calls: Array<{ url: string; method: string; body: unknown; contentType: string | null }> = [];
  const connected: Record<string, unknown>[] = [];
  const attached: Record<string, unknown>[] = [];
  const store = {
    async findByNativeConnection() { return null; },
    async createConnected(input: Record<string, unknown>) { connected.push(input); },
    async attachFivetranConnectionAny(input: Record<string, unknown>) { attached.push(input); },
    async markDisconnected() {},
    async recordSyncState() {},
  } as unknown as FivetranConnectionStore;
  const client = new FivetranClient({
    apiKey: "key",
    apiSecret: "secret",
    fetcher: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const contentType = init?.headers && !(init.headers instanceof Headers) && !Array.isArray(init.headers)
        ? (init.headers as Record<string, string>)["content-type"] ?? null
        : null;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ?? null;
      calls.push({ url, method, body, contentType });
      if (/\/v1\/connector-sdk\/packages$/u.test(url)) return Response.json({ code: "Success", data: { id: "pkg_123" } });
      return Response.json({
        code: "Success",
        data: {
          id: "sdk_xero",
          service: "connector_sdk",
          schema: (body as Record<string, Record<string, string>>)?.config?.schema ?? "xero_x",
          group_id: "group",
          paused: true,
          status: { setup_state: "connected", sync_state: "scheduled" },
        },
      });
    },
  });
  const worker = new FivetranWorkerHttpHandler({
    oauthWorkerSigningSecret: secret,
    allowedRedirectUris: new Set([redirectUri]),
    config: {
      apiKey: "key", apiSecret: "secret", groupId: "group", destinationSchema: "xero",
      tokenBrokerOrigin: "https://worker.example", sdkProjectDir: "connectors/xero-fivetran-sdk",
    },
    store,
    destinations: { async bind() {}, async stamp() { return 0; }, async inventory() { return []; } } as unknown as FivetranDestinationStore,
    xeroCredentials: {
      connectorKey: "xero",
      async read() {
        return {
          nativeConnectionId: "01J00000000000000000000077",
          externalAccountReference: "xero-tenant-guid",
          displayName: "Ashburton Cycles",
          accessToken: "xero-access-token",
          expiresAt: new Date(Date.now() + 25 * 60_000).toISOString(),
          metadata: {},
        };
      },
    } as never,
    client,
  });
  const body = JSON.stringify({
    tenantId: "01J00000000000000000000000",
    userId: "11111111-1111-4111-8111-111111111111",
    nativeConnectionId: "01J00000000000000000000077",
  });
  const path = "/v1/fivetran/xero/start";
  const signed = await signInternalRequest({ method: "POST", path, body, secret });
  const response = await worker.handle(new Request(`https://worker.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signed },
    body,
  }));
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const { result } = JSON.parse(text) as { result: Record<string, unknown> };
  assert.equal(result.fivetranConnectionId, "sdk_xero");
  const upload = calls.find((call) => /\/v1\/connector-sdk\/packages$/u.test(call.url));
  assert.ok(upload, "SDK package was uploaded before the connection was created");
  assert.ok(upload.body instanceof FormData);
  const create = calls.find((call) => call.method === "POST" && /\/v1\/connections$/u.test(call.url));
  assert.ok(create);
  const createBody = create.body as Record<string, unknown>;
  assert.equal(createBody.service, "connector_sdk");
  const config = createBody.config as Record<string, unknown>;
  assert.match(String(config.schema), /^xero_[0-9a-z]{26}$/u);
  assert.equal(config.package_id, "pkg_123");
  assert.equal(config.python_version, "3.12");
  const secrets = Object.fromEntries((config.secrets_list as Array<{ key: string; value: string }>).map((s) => [s.key, s.value]));
  assert.equal(secrets.albert_token_url, "https://worker.example");
  assert.equal(secrets.xero_tenant_id, "xero-tenant-guid");
  assert.equal(secrets.albert_tenant_id, "01J00000000000000000000000");
  assert.match(secrets.albert_token_secret, /^[A-Za-z0-9_-]{40,}$/u);
  assert.equal(secrets.albert_connection_id, connected[0]?.connectionId);
  assert.equal(connected[0]?.service, "xero");
  assert.equal(connected[0]?.displayName, "Ashburton Cycles (Fivetran)");
  assert.match(String(connected[0]?.tokenSecretHash), /^[0-9a-f]{64}$/u);
  assert.match(String(connected[0]?.sdkPackageSha256), /^[0-9a-f]{64}$/u);
  assert.equal(attached[0]?.fivetranConnectionId, "sdk_xero");
  assert.ok(calls.some((call) => /\/sync$/u.test(call.url)), "first sync was requested");
});

test("Fivetran token broker hands the SDK connector a short-lived Xero token for the right secret only", async () => {
  const { createHash } = await import("node:crypto");
  const good = "correct-horse-battery-staple-correct-horse-battery";
  const row = {
    tenantId: "01J00000000000000000000000",
    connectionId: "01J00000000000000000000001",
    fivetranConnectionId: "sdk_xero",
    destinationSchema: "xero_01j00000000000000000000001",
    service: "xero",
    displayName: "Xero (Fivetran)",
    status: "connected",
    authHealth: "healthy",
    lastSyncState: "syncing",
    nativeConnectionId: "01J00000000000000000000077",
    tokenSecretHash: createHash("sha256").update(good).digest("hex"),
  };
  const store = {
    async loadForTokenBroker() { return row; },
    async recordSyncState() {},
  } as unknown as FivetranConnectionStore;
  const worker = new FivetranWorkerHttpHandler({
    oauthWorkerSigningSecret: secret,
    allowedRedirectUris: new Set([redirectUri]),
    config: { apiKey: "key", apiSecret: "secret", groupId: "group", destinationSchema: "xero" },
    store,
    destinations: { async bind() {}, async stamp() { return 0; }, async inventory() { return []; } } as unknown as FivetranDestinationStore,
    xeroCredentials: {
      connectorKey: "xero",
      async read() {
        return {
          nativeConnectionId: "01J00000000000000000000077",
          externalAccountReference: "xero-tenant-guid",
          displayName: "Ashburton Cycles",
          accessToken: "fresh-access-token",
          expiresAt: "2026-08-17T10:00:00.000Z",
          metadata: {},
        };
      },
    } as never,
    client: new FivetranClient({ apiKey: "key", apiSecret: "secret", fetcher: async () => Response.json({}) }),
  });
  const body = JSON.stringify({ tenantId: row.tenantId, connectionId: row.connectionId });
  const ok = await worker.handle(new Request("https://worker.internal/v1/fivetran/token", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${good}` }, body,
  }));
  assert.equal(ok.status, 200);
  const { result } = await ok.json() as { result: Record<string, unknown> };
  assert.equal(result.accessToken, "fresh-access-token");
  assert.equal(result.xeroTenantId, "xero-tenant-guid");
  assert.equal(result.expiresAt, "2026-08-17T10:00:00.000Z");
  const bad = await worker.handle(new Request("https://worker.internal/v1/fivetran/token", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer wrong" }, body,
  }));
  assert.equal(bad.status, 401);
  const missing = await worker.handle(new Request("https://worker.internal/v1/fivetran/token", {
    method: "POST", headers: { "content-type": "application/json" }, body,
  }));
  assert.equal(missing.status, 401);
});

test("Fivetran status combines Fivetran's phase with what landed in the destination", async () => {
  const recorded: Record<string, unknown>[] = [];
  const store = {
    async loadConnection() {
      return {
        tenantId: "01J00000000000000000000000",
        connectionId: "01J00000000000000000000001",
        fivetranConnectionId: "card_xero",
        destinationSchema: "xero_01j00000000000000000000001",
        displayName: "Xero (Fivetran)",
        status: "connected",
        authHealth: "healthy",
        lastSyncState: "syncing",
      };
    },
    async recordSyncState(input: Record<string, unknown>) { recorded.push(input); },
  } as unknown as FivetranConnectionStore;
  const destinations = {
    async bind() {},
    async stamp() { return 0; },
    async inventory() {
      return [
        { table: "invoice", rows: 1200 },
        { table: "contact", rows: 300 },
        { table: "payroll_employee", rows: 0 },
      ];
    },
  } as unknown as FivetranDestinationStore;
  const client = new FivetranClient({
    apiKey: "key",
    apiSecret: "secret",
    fetcher: async (input) => {
      const url = String(input);
      if (url.endsWith("/schemas")) {
        return Response.json({
          code: "Success",
          data: {
            schemas: {
              xero_01j00000000000000000000001: {
                enabled: true,
                tables: { invoice: { enabled: true }, contact: { enabled: true }, payroll_employee: { enabled: true }, journal: { enabled: true } },
              },
            },
          },
        });
      }
      return Response.json({
        code: "Success",
        data: {
          id: "card_xero",
          service: "xero",
          schema: "xero_01j00000000000000000000001",
          group_id: "group",
          paused: false,
          succeeded_at: null,
          failed_at: null,
          status: { setup_state: "connected", sync_state: "syncing", is_historical_sync: true, warnings: [], tasks: [] },
        },
      });
    },
  });
  const body = JSON.stringify({
    tenantId: "01J00000000000000000000000",
    userId: "11111111-1111-4111-8111-111111111111",
    connectionId: "01J00000000000000000000001",
  });
  const signed = await signInternalRequest({ method: "POST", path: "/v1/fivetran/xero/status", body, secret });
  const response = await handler(store, client, destinations).handle(new Request("https://worker.internal/v1/fivetran/xero/status", {
    method: "POST",
    headers: { "content-type": "application/json", ...signed },
    body,
  }));
  assert.equal(response.status, 200);
  const { result } = await response.json() as { result: Record<string, unknown> };
  assert.equal(result.phase, "historical");
  assert.equal(result.landedTables, 2);
  assert.equal(result.enabledTables, 4);
  assert.equal(result.totalRows, 1500);
  assert.equal(result.progress, 50);
  assert.deepEqual((result.tables as Array<{ table: string }>).map((table) => table.table), ["invoice", "contact", "payroll_employee"]);
  assert.deepEqual(recorded[0], {
    tenantId: "01J00000000000000000000000",
    connectionId: "01J00000000000000000000001",
    syncState: "syncing",
    authHealth: "healthy",
    status: "connected",
  });
});

test("Fivetran start for Lightspeed R-Series deploys Albert's SDK connector — no Connect Card", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const connected: Record<string, unknown>[] = [];
  const store = {
    async findByNativeConnection() { return null; },
    async createConnected(input: Record<string, unknown>) { connected.push(input); },
    async attachFivetranConnectionAny() {},
    async markDisconnected() {},
    async recordSyncState() {},
  } as unknown as FivetranConnectionStore;
  const client = new FivetranClient({
    apiKey: "key",
    apiSecret: "secret",
    fetcher: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ?? null;
      calls.push({ url, method, body });
      if (/\/v1\/connector-sdk\/packages$/u.test(url)) return Response.json({ code: "Success", data: { id: "pkg_ls" } });
      return Response.json({
        code: "Success",
        data: {
          id: "sdk_lightspeed",
          service: "connector_sdk",
          schema: (body as Record<string, Record<string, string>>)?.config?.schema ?? "lightspeed_x",
          group_id: "group",
          paused: true,
          status: { setup_state: "connected", sync_state: "scheduled" },
        },
      });
    },
  });
  const worker = new FivetranWorkerHttpHandler({
    oauthWorkerSigningSecret: secret,
    allowedRedirectUris: new Set([redirectUri]),
    config: {
      apiKey: "key", apiSecret: "secret", groupId: "group", destinationSchema: "xero",
      tokenBrokerOrigin: "https://worker.example", lightspeedSdkProjectDir: "connectors/lightspeed-fivetran-sdk",
    },
    store,
    destinations: { async bind() {}, async stamp() { return 0; }, async inventory() { return []; } } as unknown as FivetranDestinationStore,
    lightspeedCredentials: {
      connectorKey: "lightspeed-r",
      async read() {
        return {
          nativeConnectionId: "01J00000000000000000000078",
          externalAccountReference: "123456",
          displayName: "Ashburton Cycles",
          accessToken: "ls-access-token",
          expiresAt: new Date(Date.now() + 25 * 60_000).toISOString(),
          metadata: {},
        };
      },
    } as never,
    client,
  });
  const body = JSON.stringify({
    tenantId: "01J00000000000000000000000",
    userId: "11111111-1111-4111-8111-111111111111",
    nativeConnectionId: "01J00000000000000000000078",
  });
  const path = "/v1/fivetran/light_speed_retail/start";
  const signed = await signInternalRequest({ method: "POST", path, body, secret });
  const response = await worker.handle(new Request(`https://worker.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signed },
    body,
  }));
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const { result } = JSON.parse(text) as { result: Record<string, unknown> };
  assert.equal(result.fivetranConnectionId, "sdk_lightspeed");
  // No Connect Card anywhere: the connection is an SDK connection born from Albert's own grant.
  assert.ok(!calls.some((call) => JSON.stringify(call.body ?? {}).includes("connect_card")));
  const create = calls.find((call) => call.method === "POST" && /\/v1\/connections$/u.test(call.url));
  assert.ok(create);
  const createBody = create.body as Record<string, unknown>;
  assert.equal(createBody.service, "connector_sdk");
  const config = createBody.config as Record<string, unknown>;
  assert.match(String(config.schema), /^lightspeed_[0-9a-z]{26}$/u);
  assert.equal(config.package_id, "pkg_ls");
  const secrets = Object.fromEntries((config.secrets_list as Array<{ key: string; value: string }>).map((s) => [s.key, s.value]));
  assert.equal(secrets.albert_token_url, "https://worker.example");
  assert.equal(secrets.lightspeed_account_id, "123456");
  assert.equal(secrets.include_optional, "false");
  assert.equal(secrets.albert_connection_id, connected[0]?.connectionId);
  assert.equal(connected[0]?.service, "light_speed_retail");
  assert.equal(connected[0]?.displayName, "Ashburton Cycles (Fivetran)");
  assert.match(String(connected[0]?.sdkPackageSha256), /^[0-9a-f]{64}$/u);
  assert.ok(calls.some((call) => /\/sync$/u.test(call.url)), "first sync was requested");
});

test("Fivetran token broker serves the Lightspeed SDK connector its account id alongside the token", async () => {
  const { createHash } = await import("node:crypto");
  const good = "lightspeed-secret-lightspeed-secret-lightspeed-secret";
  const row = {
    tenantId: "01J00000000000000000000000",
    connectionId: "01J00000000000000000000002",
    fivetranConnectionId: "sdk_lightspeed",
    destinationSchema: "lightspeed_01j00000000000000000000002",
    service: "light_speed_retail",
    displayName: "Lightspeed Retail (Fivetran)",
    status: "connected",
    authHealth: "healthy",
    lastSyncState: "syncing",
    nativeConnectionId: "01J00000000000000000000078",
    tokenSecretHash: createHash("sha256").update(good).digest("hex"),
  };
  const worker = new FivetranWorkerHttpHandler({
    oauthWorkerSigningSecret: secret,
    allowedRedirectUris: new Set([redirectUri]),
    config: { apiKey: "key", apiSecret: "secret", groupId: "group", destinationSchema: "xero" },
    store: { async loadForTokenBroker() { return row; }, async recordSyncState() {} } as unknown as FivetranConnectionStore,
    destinations: { async bind() {}, async stamp() { return 0; }, async inventory() { return []; } } as unknown as FivetranDestinationStore,
    lightspeedCredentials: {
      connectorKey: "lightspeed-r",
      async read() {
        return {
          nativeConnectionId: "01J00000000000000000000078",
          externalAccountReference: "123456",
          displayName: "Ashburton Cycles",
          accessToken: "fresh-ls-token",
          expiresAt: "2026-08-17T10:00:00.000Z",
          metadata: {},
        };
      },
    } as never,
    client: new FivetranClient({ apiKey: "key", apiSecret: "secret", fetcher: async () => Response.json({}) }),
  });
  const body = JSON.stringify({ tenantId: row.tenantId, connectionId: row.connectionId });
  const ok = await worker.handle(new Request("https://worker.internal/v1/fivetran/token", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${good}` }, body,
  }));
  assert.equal(ok.status, 200);
  const { result } = await ok.json() as { result: Record<string, unknown> };
  assert.equal(result.accessToken, "fresh-ls-token");
  assert.equal(result.externalAccountId, "123456");
  assert.equal(result.xeroTenantId, undefined);
  // The Xero-only bridge cannot serve a Lightspeed row.
  const xeroOnly = new FivetranWorkerHttpHandler({
    oauthWorkerSigningSecret: secret,
    allowedRedirectUris: new Set([redirectUri]),
    config: { apiKey: "key", apiSecret: "secret", groupId: "group", destinationSchema: "xero" },
    store: { async loadForTokenBroker() { return row; }, async recordSyncState() {} } as unknown as FivetranConnectionStore,
    destinations: { async bind() {}, async stamp() { return 0; }, async inventory() { return []; } } as unknown as FivetranDestinationStore,
    xeroCredentials: { connectorKey: "xero", async read() { throw new Error("must not be called"); } } as never,
    client: new FivetranClient({ apiKey: "key", apiSecret: "secret", fetcher: async () => Response.json({}) }),
  });
  const notFound = await xeroOnly.handle(new Request("https://worker.internal/v1/fivetran/token", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${good}` }, body,
  }));
  assert.equal(notFound.status, 404);
});

test("Fivetran start for Deputy hands Albert's own grant to Fivetran with no Connect Card", async () => {
  const bodies: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  const connected: Record<string, unknown>[] = [];
  const store = {
    async findByNativeConnection() { return null; },
    async createConnected(input: Record<string, unknown>) { connected.push(input); },
  } as unknown as FivetranConnectionStore;
  const client = new FivetranClient({
    apiKey: "key",
    apiSecret: "secret",
    fetcher: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      bodies.push({ url, method, body });
      return Response.json({
        code: "Success",
        data: {
          id: "deputy_live",
          service: "deputy",
          schema: body.config?.schema ?? "deputy_x",
          group_id: "group",
          paused: false,
          status: { setup_state: "connected", sync_state: "scheduled" },
        },
      });
    },
  });
  const worker = new FivetranWorkerHttpHandler({
    oauthWorkerSigningSecret: secret,
    allowedRedirectUris: new Set([redirectUri]),
    config: { apiKey: "key", apiSecret: "secret", groupId: "group", destinationSchema: "xero" },
    store,
    destinations: { async bind() {}, async stamp() { return 0; }, async inventory() { return []; } } as unknown as FivetranDestinationStore,
    deputyCredentials: {
      async read() {
        return {
          nativeConnectionId: "01J00000000000000000000077",
          externalAccountReference: "acme.au.deputy.com",
          displayName: "Acme Cycles",
          accessToken: "deputy-access-token",
          expiresAt: new Date(Date.now() + 20 * 60 * 60_000).toISOString(),
          endpoint: "acme.au.deputy.com",
          subDomain: "acme.au",
        };
      },
    } as never,
    client,
  });
  const body = JSON.stringify({
    tenantId: "01J00000000000000000000000",
    userId: "11111111-1111-4111-8111-111111111111",
    nativeConnectionId: "01J00000000000000000000077",
  });
  const path = "/v1/fivetran/deputy/start";
  const signed = await signInternalRequest({ method: "POST", path, body, secret });
  const response = await worker.handle(new Request(`https://worker.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signed },
    body,
  }));
  assert.equal(response.status, 200);
  const { result } = await response.json() as { result: Record<string, unknown> };
  assert.equal(result.fivetranConnectionId, "deputy_live");
  const create = bodies.find((call) => call.method === "POST" && /\/v1\/connections$/u.test(call.url));
  assert.ok(create);
  assert.equal(create.body.service, "deputy");
  assert.equal(create.body.connect_card_config, undefined);
  assert.equal(create.body.run_setup_tests, true);
  assert.deepEqual(create.body.config, {
    schema: (create.body.config as Record<string, unknown>).schema,
    sub_domain: "acme.au",
    access_token: "deputy-access-token",
  });
  assert.match(String((create.body.config as Record<string, unknown>).schema), /^deputy_[0-9a-z]{26}$/u);
  assert.equal(connected[0]?.service, "deputy");
  assert.equal(connected[0]?.nativeConnectionId, "01J00000000000000000000077");
  assert.equal(connected[0]?.displayName, "Acme Cycles (Fivetran)");
});

test("Fivetran Stripe only accepts a Restricted or Connect secret key", () => {
  assert.equal(
    stripeFivetranAccessToken({ stripeAccessToken: "rk_live_abc123" }),
    "rk_live_abc123",
  );
  assert.equal(
    stripeFivetranAccessToken({ access_token: "sk_test_abc123" }),
    "sk_test_abc123",
  );
  assert.throws(() => stripeFivetranAccessToken({ stripeUserId: "acct_123" }), /fivetran_stripe_token_missing/u);
});

test("Fivetran start for Stripe hands the Connect grant to the native ERD connector", async () => {
  const bodies: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  const connected: Record<string, unknown>[] = [];
  const store = {
    async findByNativeConnection() { return null; },
    async createConnected(input: Record<string, unknown>) { connected.push(input); },
  } as unknown as FivetranConnectionStore;
  const client = new FivetranClient({
    apiKey: "key",
    apiSecret: "secret",
    fetcher: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      bodies.push({ url, method, body });
      if (method === "GET" && /\/schemas$/u.test(url)) {
        return Response.json({
          code: "Success",
          data: {
            schemas: {
              stripe: {
                enabled: true,
                tables: { charge: { enabled: true }, invoice: { enabled: true }, customer: { enabled: true } },
              },
            },
          },
        });
      }
      return Response.json({
        code: "Success",
        data: {
          id: "stripe_live",
          service: "stripe",
          schema: body.config?.schema ?? "stripe_x",
          group_id: "group",
          paused: false,
          status: { setup_state: "connected", sync_state: "scheduled" },
        },
      });
    },
  });
  const worker = new FivetranWorkerHttpHandler({
    oauthWorkerSigningSecret: secret,
    allowedRedirectUris: new Set([redirectUri]),
    config: { apiKey: "key", apiSecret: "secret", groupId: "group", destinationSchema: "xero" },
    store,
    destinations: { async bind() {}, async stamp() { return 0; }, async inventory() { return []; } } as unknown as FivetranDestinationStore,
    stripeCredentials: {
      async read() {
        return {
          nativeConnectionId: "01J00000000000000000000088",
          externalAccountReference: "acct_testmerchant",
          displayName: "Ashburton Cycles",
          accessToken: "rk_live_restrictedkey",
          expiresAt: new Date(Date.now() + 20 * 60 * 60_000).toISOString(),
          metadata: { stripeUserId: "acct_testmerchant" },
        };
      },
    } as never,
    client,
  });
  const body = JSON.stringify({
    tenantId: "01J00000000000000000000000",
    userId: "11111111-1111-4111-8111-111111111111",
    nativeConnectionId: "01J00000000000000000000088",
  });
  const path = "/v1/fivetran/stripe/start";
  const signed = await signInternalRequest({ method: "POST", path, body, secret });
  const response = await worker.handle(new Request(`https://worker.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signed },
    body,
  }));
  assert.equal(response.status, 200);
  const { result } = await response.json() as { result: Record<string, unknown> };
  assert.equal(result.fivetranConnectionId, "stripe_live");
  const create = bodies.find((call) => call.method === "POST" && /\/v1\/connections$/u.test(call.url));
  assert.ok(create);
  assert.equal(create.body.service, "stripe");
  assert.equal(create.body.connect_card_config, undefined);
  assert.equal(create.body.run_setup_tests, true);
  assert.equal(create.body.paused, true);
  assert.equal(create.body.sync_frequency, 1440);
  assert.equal(create.body.daily_sync_time, "08:00");
  assert.equal(create.body.schedule_type, "auto");
  assert.equal(create.body.is_historical_sync, undefined);
  assert.deepEqual(create.body.config, {
    schema: (create.body.config as Record<string, unknown>).schema,
    access_token: "rk_live_restrictedkey",
    api_key: "rk_live_restrictedkey",
    historical_sync_time_frame: "ALL_TIME",
    support_connected_accounts_sync: false,
  });
  assert.match(String((create.body.config as Record<string, unknown>).schema), /^stripe_[0-9a-z]{26}$/u);
  assert.equal(connected[0]?.service, "stripe");
  assert.equal(connected[0]?.externalAccountReference, "acct_testmerchant");
  assert.ok(bodies.some((call) => call.method === "PATCH" && /\/schemas$/u.test(call.url)
    && call.body.schema_change_handling === "ALLOW_ALL"
    && call.body.enable_new_by_default === true));
  assert.ok(bodies.some((call) => call.method === "POST" && /\/schemas\/reload$/u.test(call.url)));
  const enableIdx = bodies.findIndex((call) => call.method === "PATCH" && /\/schemas$/u.test(call.url));
  const unpauseIdx = bodies.findIndex((call) => call.method === "PATCH" && /\/v1\/connections\/stripe_live$/u.test(call.url)
    && call.body.paused === false);
  const syncIdx = bodies.findIndex((call) => call.method === "POST" && /\/sync$/u.test(call.url));
  assert.ok(enableIdx >= 0 && unpauseIdx > enableIdx);
  assert.equal(syncIdx, -1);
});

test("Fivetran Stripe start does not force-sync an already running historical job", async () => {
  const bodies: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  const client = new FivetranClient({
    apiKey: "key",
    apiSecret: "secret",
    fetcher: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      bodies.push({ url, method, body });
      if (method === "GET" && /\/schemas$/u.test(url)) {
        return Response.json({
          code: "Success",
          data: {
            schemas: {
              stripe: {
                enabled: true,
                tables: { charge: { enabled: true }, customer: { enabled: true } },
              },
            },
          },
        });
      }
      return Response.json({
        code: "Success",
        data: {
          id: "running_substratum",
          service: "stripe",
          schema: "stripe_01j00000000000000000000099",
          group_id: "group",
          paused: false,
          status: { setup_state: "connected", sync_state: "syncing" },
        },
      });
    },
  });
  const worker = new FivetranWorkerHttpHandler({
    oauthWorkerSigningSecret: secret,
    allowedRedirectUris: new Set([redirectUri]),
    config: { apiKey: "key", apiSecret: "secret", groupId: "group", destinationSchema: "xero" },
    store: {
      async findByNativeConnection() {
        return {
          tenantId: "01J00000000000000000000000",
          connectionId: "01J00000000000000000000099",
          fivetranConnectionId: "running_substratum",
          lastSyncState: "syncing",
        };
      },
      async recordSyncState() {},
    } as unknown as FivetranConnectionStore,
    destinations: { async bind() {}, async stamp() { return 0; }, async inventory() { return []; } } as unknown as FivetranDestinationStore,
    stripeCredentials: {
      async read() {
        return {
          nativeConnectionId: "01J00000000000000000000088",
          externalAccountReference: "acct_testmerchant",
          displayName: "Ashburton Cycles",
          accessToken: "rk_live_restrictedkey",
          expiresAt: new Date(Date.now() + 20 * 60 * 60_000).toISOString(),
          metadata: { stripeUserId: "acct_testmerchant" },
        };
      },
    } as never,
    client,
  });
  const body = JSON.stringify({
    tenantId: "01J00000000000000000000000",
    userId: "11111111-1111-4111-8111-111111111111",
    nativeConnectionId: "01J00000000000000000000088",
  });
  const path = "/v1/fivetran/stripe/start";
  const signed = await signInternalRequest({ method: "POST", path, body, secret });
  const response = await worker.handle(new Request(`https://worker.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signed },
    body,
  }));
  assert.equal(response.status, 200);
  assert.equal(bodies.filter((call) => call.method === "POST" && /\/sync$/u.test(call.url)).length, 0);
});

test("Fivetran Stripe start syncs once after unpausing a manual schedule", async () => {
  const bodies: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  let paused = true;
  const client = new FivetranClient({
    apiKey: "key",
    apiSecret: "secret",
    fetcher: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      bodies.push({ url, method, body });
      if (method === "PATCH" && body.paused === false) paused = false;
      if (method === "GET" && /\/schemas$/u.test(url)) {
        return Response.json({
          code: "Success",
          data: { schemas: { stripe: { enabled: true, tables: { charge: { enabled: true } } } } },
        });
      }
      return Response.json({
        code: "Success",
        data: {
          id: "running_substratum",
          service: "stripe",
          schema: "stripe_01j00000000000000000000099",
          group_id: "group",
          paused,
          schedule_type: "manual",
          status: { setup_state: "connected", sync_state: paused ? "paused" : "scheduled" },
        },
      });
    },
  });
  const worker = new FivetranWorkerHttpHandler({
    oauthWorkerSigningSecret: secret,
    allowedRedirectUris: new Set([redirectUri]),
    config: { apiKey: "key", apiSecret: "secret", groupId: "group", destinationSchema: "xero" },
    store: {
      async findByNativeConnection() {
        return {
          tenantId: "01J00000000000000000000000",
          connectionId: "01J00000000000000000000099",
          fivetranConnectionId: "running_substratum",
          lastSyncState: "paused",
        };
      },
      async recordSyncState() {},
    } as unknown as FivetranConnectionStore,
    destinations: { async bind() {}, async stamp() { return 0; }, async inventory() { return []; } } as unknown as FivetranDestinationStore,
    stripeCredentials: {
      async read() {
        return {
          nativeConnectionId: "01J00000000000000000000088",
          externalAccountReference: "acct_testmerchant",
          displayName: "Ashburton Cycles",
          accessToken: "rk_live_restrictedkey",
          expiresAt: new Date(Date.now() + 20 * 60 * 60_000).toISOString(),
          metadata: { stripeUserId: "acct_testmerchant" },
        };
      },
    } as never,
    client,
  });
  const body = JSON.stringify({
    tenantId: "01J00000000000000000000000",
    userId: "11111111-1111-4111-8111-111111111111",
    nativeConnectionId: "01J00000000000000000000088",
  });
  const path = "/v1/fivetran/stripe/start";
  const signed = await signInternalRequest({ method: "POST", path, body, secret });
  const response = await worker.handle(new Request(`https://worker.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signed },
    body,
  }));
  assert.equal(response.status, 200);
  assert.equal(bodies.filter((call) => call.method === "PATCH" && call.body.paused === false).length, 1);
  assert.equal(bodies.filter((call) => call.method === "POST" && /\/sync$/u.test(call.url)).length, 1);
});

test("Fivetran Stripe start unwinds the destination bind when create fails", async () => {
  const retired: string[] = [];
  const purged: string[] = [];
  const worker = new FivetranWorkerHttpHandler({
    oauthWorkerSigningSecret: secret,
    allowedRedirectUris: new Set([redirectUri]),
    config: { apiKey: "key", apiSecret: "secret", groupId: "group", destinationSchema: "xero" },
    store: { async findByNativeConnection() { return null; } } as unknown as FivetranConnectionStore,
    destinations: {
      async bind() {},
      async stamp() { return 0; },
      async inventory() { return []; },
      async retire(input: { destinationSchema: string }) { retired.push(input.destinationSchema); },
      async purge(input: { destinationSchema: string }) { purged.push(input.destinationSchema); },
    } as unknown as FivetranDestinationStore,
    stripeCredentials: {
      async read() {
        return {
          nativeConnectionId: "01J00000000000000000000088",
          externalAccountReference: "acct_testmerchant",
          displayName: "Ashburton Cycles",
          accessToken: "rk_live_restrictedkey",
          expiresAt: new Date(Date.now() + 20 * 60 * 60_000).toISOString(),
          metadata: { stripeUserId: "acct_testmerchant" },
        };
      },
    } as never,
    client: new FivetranClient({
      apiKey: "key",
      apiSecret: "secret",
      fetcher: async () => Response.json({ code: "InvalidInput", message: "bad stripe key" }, { status: 400 }),
    }),
  });
  const body = JSON.stringify({
    tenantId: "01J00000000000000000000000",
    userId: "11111111-1111-4111-8111-111111111111",
    nativeConnectionId: "01J00000000000000000000088",
  });
  const path = "/v1/fivetran/stripe/start";
  const signed = await signInternalRequest({ method: "POST", path, body, secret });
  const response = await worker.handle(new Request(`https://worker.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signed },
    body,
  }));
  assert.equal(response.status, 409);
  assert.equal(retired.length, 1);
  assert.equal(purged.length, 1);
  assert.match(retired[0] ?? "", /^stripe_[0-9a-z]{26}$/u);
});

test("Fivetran Stripe start rejects a test-mode Connect key", async () => {
  const worker = new FivetranWorkerHttpHandler({
    oauthWorkerSigningSecret: secret,
    allowedRedirectUris: new Set([redirectUri]),
    config: { apiKey: "key", apiSecret: "secret", groupId: "group", destinationSchema: "xero" },
    store: { async findByNativeConnection() { return null; } } as unknown as FivetranConnectionStore,
    destinations: { async bind() {}, async stamp() { return 0; }, async inventory() { return []; } } as unknown as FivetranDestinationStore,
    stripeCredentials: {
      async read() {
        return {
          nativeConnectionId: "01J00000000000000000000088",
          externalAccountReference: "acct_testmerchant",
          displayName: "Ashburton Cycles",
          accessToken: "sk_test_notforfivetran",
          expiresAt: new Date(Date.now() + 20 * 60 * 60_000).toISOString(),
          metadata: { stripeUserId: "acct_testmerchant" },
        };
      },
    } as never,
    client: new FivetranClient({
      apiKey: "key",
      apiSecret: "secret",
      fetcher: async () => Response.json({ code: "Success", data: { id: "unused" } }),
    }),
  });
  const body = JSON.stringify({
    tenantId: "01J00000000000000000000000",
    userId: "11111111-1111-4111-8111-111111111111",
    nativeConnectionId: "01J00000000000000000000088",
  });
  const path = "/v1/fivetran/stripe/start";
  const signed = await signInternalRequest({ method: "POST", path, body, secret });
  const response = await worker.handle(new Request(`https://worker.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signed },
    body,
  }));
  assert.equal(response.status, 409);
  const payload = await response.json() as { error: string };
  assert.equal(payload.error, "fivetran_stripe_live_key_required");
});

test("Fivetran Stripe enable-all retries when the catalogue is only partly selected", async () => {
  let schemaReads = 0;
  const bodies: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  const client = new FivetranClient({
    apiKey: "key",
    apiSecret: "secret",
    fetcher: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      bodies.push({ url, method, body });
      if (method === "GET" && /\/schemas$/u.test(url)) {
        schemaReads += 1;
        const tables = schemaReads === 1
          ? { charge: { enabled: true }, invoice: { enabled: false }, customer: { enabled: false } }
          : { charge: { enabled: true }, invoice: { enabled: true }, customer: { enabled: true } };
        return Response.json({
          code: "Success",
          data: { schemas: { stripe: { enabled: true, tables } } },
        });
      }
      return Response.json({
        code: "Success",
        data: {
          id: "stripe_live",
          service: "stripe",
          schema: body.config?.schema ?? "stripe_x",
          group_id: "group",
          paused: true,
          status: { setup_state: "connected", sync_state: "scheduled" },
        },
      });
    },
  });
  const worker = new FivetranWorkerHttpHandler({
    oauthWorkerSigningSecret: secret,
    allowedRedirectUris: new Set([redirectUri]),
    config: { apiKey: "key", apiSecret: "secret", groupId: "group", destinationSchema: "xero" },
    store: {
      async findByNativeConnection() { return null; },
      async createConnected() {},
    } as unknown as FivetranConnectionStore,
    destinations: { async bind() {}, async stamp() { return 0; }, async inventory() { return []; } } as unknown as FivetranDestinationStore,
    stripeCredentials: {
      async read() {
        return {
          nativeConnectionId: "01J00000000000000000000088",
          externalAccountReference: "acct_testmerchant",
          displayName: "Ashburton Cycles",
          accessToken: "rk_live_restrictedkey",
          expiresAt: new Date(Date.now() + 20 * 60 * 60_000).toISOString(),
          metadata: { stripeUserId: "acct_testmerchant" },
        };
      },
    } as never,
    client,
  });
  const body = JSON.stringify({
    tenantId: "01J00000000000000000000000",
    userId: "11111111-1111-4111-8111-111111111111",
    nativeConnectionId: "01J00000000000000000000088",
  });
  const path = "/v1/fivetran/stripe/start";
  const signed = await signInternalRequest({ method: "POST", path, body, secret });
  const response = await worker.handle(new Request(`https://worker.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signed },
    body,
  }));
  assert.equal(response.status, 200);
  assert.equal(schemaReads, 2);
  assert.ok(bodies.filter((call) => call.method === "PATCH" && /\/schemas$/u.test(call.url)).length >= 2);
});

test("a concurrent Deputy start converges on the winner instead of duplicating", async () => {
  const deleted: string[] = [];
  const store = {
    async findByNativeConnection(input: Record<string, unknown>) {
      void input;
      return findResult;
    },
    async createConnected() { throw new Error("fivetran_native_already_connected"); },
  } as unknown as FivetranConnectionStore;
  const findResult: Record<string, unknown> | null = null;
  const client = new FivetranClient({
    apiKey: "key",
    apiSecret: "secret",
    fetcher: async (input, init) => {
      const url = String(input);
      if (init?.method === "DELETE") {
        deleted.push(url);
        return Response.json({ code: "Success" });
      }
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      return Response.json({
        code: "Success",
        data: {
          id: "deputy_loser",
          service: "deputy",
          schema: body.config?.schema ?? "deputy_x",
          group_id: "group",
          paused: false,
          status: { setup_state: "connected", sync_state: "scheduled" },
        },
      });
    },
  });
  const worker = new FivetranWorkerHttpHandler({
    oauthWorkerSigningSecret: secret,
    allowedRedirectUris: new Set([redirectUri]),
    config: { apiKey: "key", apiSecret: "secret", groupId: "group", destinationSchema: "xero" },
    store,
    destinations: { async bind() {}, async stamp() { return 0; }, async inventory() { return []; }, async retire() {}, async purge() {}, async rebuildSourceViews() { return 0; } } as unknown as FivetranDestinationStore,
    deputyCredentials: {
      async read() {
        return {
          nativeConnectionId: "01J00000000000000000000077",
          externalAccountReference: "acme.au.deputy.com",
          displayName: "Acme",
          accessToken: "token",
          expiresAt: new Date(Date.now() + 20 * 60 * 60_000).toISOString(),
          endpoint: "acme.au.deputy.com",
          subDomain: "acme.au",
        };
      },
    } as never,
    client,
  });
  // First lookup (dedupe) misses; after the unique violation the winner exists.
  let calls = 0;
  (store as unknown as { findByNativeConnection: () => Promise<unknown> }).findByNativeConnection = async () => {
    calls += 1;
    if (calls === 1) return null;
    return {
      tenantId: "01J00000000000000000000000",
      connectionId: "01J000000000000000000000AA",
      fivetranConnectionId: "deputy_winner",
      destinationSchema: "deputy_01j000000000000000000000aa",
      service: "deputy",
      displayName: "Acme (Fivetran)",
      status: "connected",
      authHealth: "healthy",
      lastSyncState: "syncing",
      nativeConnectionId: "01J00000000000000000000077",
    };
  };
  const body = JSON.stringify({
    tenantId: "01J00000000000000000000000",
    userId: "11111111-1111-4111-8111-111111111111",
    nativeConnectionId: "01J00000000000000000000077",
  });
  const path = "/v1/fivetran/deputy/start";
  const signed = await signInternalRequest({ method: "POST", path, body, secret });
  const response2 = await worker.handle(new Request(`https://worker.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signed },
    body,
  }));
  const text = await response2.text();
  assert.equal(response2.status, 200, text);
  const { result } = JSON.parse(text) as { result: Record<string, unknown> };
  assert.equal(result.fivetranConnectionId, "deputy_winner");
  assert.equal(deleted.length, 1, "the losing Fivetran connection was deleted");
  assert.match(deleted[0] ?? "", /deputy_loser/u);
});

test("disconnect deletes the Fivetran connection and erases the destination schema", async () => {
  const deleted: string[] = [];
  const retired: string[] = [];
  const purged: string[] = [];
  const store = {
    async loadConnection() {
      return {
        tenantId: "01J00000000000000000000000",
        connectionId: "01J00000000000000000000001",
        fivetranConnectionId: "live_conn",
        destinationSchema: "xero_01j00000000000000000000001",
        service: "xero",
        displayName: "Xero (Fivetran)",
        status: "connected",
        authHealth: "healthy",
        lastSyncState: "succeeded",
        nativeConnectionId: "01J00000000000000000000077",
      };
    },
    async markDisconnected() {},
  } as unknown as FivetranConnectionStore;
  const client = new FivetranClient({
    apiKey: "key",
    apiSecret: "secret",
    fetcher: async (input, init) => {
      if (init?.method === "DELETE") deleted.push(String(input));
      return Response.json({ code: "Success" });
    },
  });
  const worker = new FivetranWorkerHttpHandler({
    oauthWorkerSigningSecret: secret,
    allowedRedirectUris: new Set([redirectUri]),
    config: { apiKey: "key", apiSecret: "secret", groupId: "group", destinationSchema: "xero" },
    store,
    destinations: {
      async bind() {}, async stamp() { return 0; }, async inventory() { return []; },
      async retire(input: { destinationSchema: string }) { retired.push(input.destinationSchema); },
      async purge(input: { destinationSchema: string }) { purged.push(input.destinationSchema); },
      async rebuildSourceViews() { return 0; },
    } as unknown as FivetranDestinationStore,
    client,
  });
  const body = JSON.stringify({
    tenantId: "01J00000000000000000000000",
    userId: "11111111-1111-4111-8111-111111111111",
    connectionId: "01J00000000000000000000001",
  });
  const path = "/v1/fivetran/connection/disconnect";
  const signed = await signInternalRequest({ method: "POST", path, body, secret });
  const response = await worker.handle(new Request(`https://worker.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signed },
    body,
  }));
  assert.equal(response.status, 200);
  assert.match(deleted[0] ?? "", /live_conn/u);
  assert.deepEqual(retired, ["xero_01j00000000000000000000001"]);
  assert.deepEqual(purged, ["xero_01j00000000000000000000001"], "the schema is erased on disconnect");
});

test("destination maintenance walks Stripe rows and rebuilds official views", async () => {
  const rebuilt: string[] = [];
  const stamped: string[] = [];
  const enabled: string[] = [];
  const store = {
    async listConnectedByService(input: { service: string }) {
      if (input.service !== "stripe") return [];
      return [{
        tenantId: "01J00000000000000000000000",
        connectionId: "01J00000000000000000000099",
        fivetranConnectionId: "stripe_live",
        destinationSchema: "stripe_01j00000000000000000000099",
        service: "stripe",
        displayName: "Stripe (Fivetran)",
        status: "connected",
        authHealth: "healthy",
        lastSyncState: "syncing",
      }];
    },
    async readMaintenance() { return { unionTables: 0 }; },
    async recordMaintenance() {},
  } as unknown as FivetranConnectionStore;
  const worker = new FivetranWorkerHttpHandler({
    oauthWorkerSigningSecret: secret,
    allowedRedirectUris: new Set([redirectUri]),
    config: { apiKey: "key", apiSecret: "secret", groupId: "group", destinationSchema: "xero" },
    store,
    destinations: {
      async bind() {},
      async inventory() { return [{ table: "charge", rows: 12 }]; },
      async stamp(input: { destinationSchema: string }) {
        stamped.push(input.destinationSchema);
        return 1;
      },
      async rebuildSourceViews(prefix: string) {
        rebuilt.push(prefix);
        return 1;
      },
    } as unknown as FivetranDestinationStore,
    client: {
      async enableAllSchemas() { enabled.push("stripe_live"); },
      async getSchemaSummary() {
        return { loaded: true, enabledTables: 3, totalTables: 3 };
      },
      async getConnection() {
        return {
          paused: false,
          status: { syncState: "succeeded", isHistoricalSync: false },
        };
      },
    } as unknown as FivetranClient,
  });
  const maintained = await worker.maintainConnectedDestinations();
  assert.equal(maintained, 1);
  assert.deepEqual(enabled, []);
  assert.deepEqual(stamped, ["stripe_01j00000000000000000000099"]);
  assert.deepEqual(rebuilt, ["stripe"]);
});

test("destination maintenance skips enable-all on SDK connectors", async () => {
  const enabled: string[] = [];
  const stamped: string[] = [];
  const store = {
    async listConnectedByService(input: { service: string }) {
      if (input.service !== "xero") return [];
      return [{
        tenantId: "01J00000000000000000000000",
        connectionId: "01J00000000000000000000001",
        fivetranConnectionId: "xero_sdk",
        destinationSchema: "xero_01j00000000000000000000001",
        service: "xero",
        displayName: "Xero (Fivetran)",
        status: "connected",
        authHealth: "healthy",
        lastSyncState: "succeeded",
      }];
    },
    async readMaintenance() { return { unionTables: 0 }; },
    async recordMaintenance() {},
  } as unknown as FivetranConnectionStore;
  const worker = new FivetranWorkerHttpHandler({
    oauthWorkerSigningSecret: secret,
    allowedRedirectUris: new Set([redirectUri]),
    config: { apiKey: "key", apiSecret: "secret", groupId: "group", destinationSchema: "xero" },
    store,
    destinations: {
      async bind() {},
      async inventory() { return [{ table: "xero_account", rows: 4 }]; },
      async stamp(input: { destinationSchema: string }) {
        stamped.push(input.destinationSchema);
        return 1;
      },
      async rebuildSourceViews() { return 1; },
    } as unknown as FivetranDestinationStore,
    client: {
      async enableAllSchemas() { enabled.push("xero_sdk"); },
      async getSchemaSummary() {
        return { loaded: false, enabledTables: 0, totalTables: 0 };
      },
    } as unknown as FivetranClient,
  });
  const maintained = await worker.maintainConnectedDestinations();
  assert.equal(maintained, 1);
  assert.deepEqual(enabled, []);
  assert.deepEqual(stamped, ["xero_01j00000000000000000000001"]);
});
