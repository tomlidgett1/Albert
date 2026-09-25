import assert from "node:assert/strict";
import test from "node:test";

import { signInternalRequest, verifyInternalRequest } from "../../packages/security/src/index.js";
import { FivetranClient } from "../../packages/fivetran/src/index.js";
import type { TransactionalPostgres } from "./src/database.js";
import type { FivetranDestinationStore } from "./src/fivetran-destinations.js";
import { FivetranWorkerHttpHandler } from "./src/fivetran-http.js";
import type { FivetranConnectionRow, FivetranConnectionStore } from "./src/fivetran-store.js";
import {
  PartnerGrantBridge,
  parsePartnerTokenBrokers,
  partnerProviderForService,
  type PartnerGrantCredential,
} from "./src/partner-grants.js";

const signingSecret = "s".repeat(48);
const brokerSecret = "b".repeat(48);
const tenantId = "01J00000000000000000000000";
const userId = "11111111-1111-4111-8111-111111111111";
const clientId = "yellow-jersey-3acef09d8b2846e8a0c345ce59c61972";
const brokerUrl = "https://yj.example/api/partner/albert/token";

function bindingDb(row: Record<string, unknown> | null): TransactionalPostgres {
  return {
    async query(sql: string, values?: readonly unknown[]) {
      assert.match(sql, /from control_plane\.partner_clients/u);
      assert.match(sql, /status = 'active'/u);
      assert.match(sql, /token_broker/u);
      assert.deepEqual(values, [tenantId]);
      return { rows: row ? [row] : [] };
    },
    async transaction() {
      throw new Error("not used");
    },
  } as unknown as TransactionalPostgres;
}

const binding = { client_id: clientId, partner: "yellow-jersey", partner_account_ref: "3acef09d-8b28-46e8-a0c3-45ce59c61972" };

function bridge(fetcher: typeof fetch, row: Record<string, unknown> | null = binding) {
  return new PartnerGrantBridge({
    db: bindingDb(row),
    brokers: parsePartnerTokenBrokers(JSON.stringify([{ partner: "yellow-jersey", url: brokerUrl, secret: brokerSecret }])),
    fetcher,
  });
}

test("partner token brokers parse strictly", () => {
  assert.equal(parsePartnerTokenBrokers(undefined).size, 0);
  assert.equal(parsePartnerTokenBrokers("  ").size, 0);
  const brokers = parsePartnerTokenBrokers(JSON.stringify([{ partner: "yellow-jersey", url: brokerUrl, secret: brokerSecret }]));
  assert.equal(brokers.get("yellow-jersey")?.url, brokerUrl);
  for (const bad of [
    "{}",
    "not json",
    JSON.stringify([{ partner: "Yellow Jersey", url: brokerUrl, secret: brokerSecret }]),
    JSON.stringify([{ partner: "yellow-jersey", url: "http://yj.example/token", secret: brokerSecret }]),
    JSON.stringify([{ partner: "yellow-jersey", url: "https://user:pw@yj.example/token", secret: brokerSecret }]),
    JSON.stringify([{ partner: "yellow-jersey", url: `${brokerUrl}?x=1`, secret: brokerSecret }]),
    JSON.stringify([{ partner: "yellow-jersey", url: brokerUrl, secret: "short" }]),
    JSON.stringify([
      { partner: "yellow-jersey", url: brokerUrl, secret: brokerSecret },
      { partner: "yellow-jersey", url: brokerUrl, secret: brokerSecret },
    ]),
  ]) {
    assert.throws(() => parsePartnerTokenBrokers(bad), /ALBERT_PARTNER_TOKEN_BROKERS/u, bad);
  }
});

test("only rotating-grant vendors map to partner providers", () => {
  assert.equal(partnerProviderForService("light_speed_retail"), "lightspeed");
  assert.equal(partnerProviderForService("xero"), "xero");
  assert.equal(partnerProviderForService("deputy"), "deputy");
  assert.equal(partnerProviderForService("stripe"), undefined);
  assert.equal(partnerProviderForService("toString"), undefined);
});

test("the partner bridge signs its request and maps each provider's answer", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const answers: Record<string, Record<string, unknown>> = {
    lightspeed: { externalAccountId: "168990", displayName: "Wattle Test Cycles" },
    xero: { externalAccountId: "A1B2C3D4-0000-4000-8000-00000000abcd" },
    deputy: { externalAccountId: "wattle.au.deputy.com", endpoint: "wattle.au.deputy.com" },
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = String(init?.body);
    const headers = init?.headers as Record<string, string>;
    const verified = await verifyInternalRequest({
      method: "POST",
      path: url.pathname,
      body,
      secret: brokerSecret,
      timestamp: headers["x-albert-timestamp"] ?? null,
      signature: headers["x-albert-signature"] ?? null,
    });
    assert.equal(verified, true, "request carries a valid HMAC for the partner's path");
    assert.equal(init?.redirect, "error");
    const parsed = JSON.parse(body) as Record<string, unknown>;
    seen.push(parsed);
    return Response.json({
      accessToken: `token-for-${String(parsed.provider)}-0123456789`,
      expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      ...answers[String(parsed.provider)],
    });
  };
  const partner = bridge(fetcher);
  const lightspeed = await partner.read({ tenantId, service: "light_speed_retail" });
  assert.equal(lightspeed.externalAccountReference, "168990");
  assert.equal(lightspeed.displayName, "Wattle Test Cycles");
  assert.equal(lightspeed.partnerClientId, clientId);
  const xero = await partner.read({ tenantId, service: "xero", minValiditySeconds: 600 });
  assert.equal(xero.externalAccountReference, "a1b2c3d4-0000-4000-8000-00000000abcd");
  const deputy = await partner.read({ tenantId, service: "deputy", minValiditySeconds: 8 * 3600 });
  assert.equal(deputy.subDomain, "wattle.au");
  assert.equal(deputy.endpoint, "wattle.au.deputy.com");
  assert.deepEqual(seen.map((body) => body.provider), ["lightspeed", "xero", "deputy"]);
  assert.deepEqual(seen.map((body) => body.minValiditySeconds), [300, 600, 28_800]);
  for (const body of seen) {
    assert.equal(body.tenantId, tenantId);
    assert.equal(body.clientId, clientId);
    assert.equal(body.accountRef, binding.partner_account_ref);
    assert.equal("refreshToken" in body, false);
  }
});

test("the partner bridge maps refusals to honest worker errors", async () => {
  const cases: Array<[number, RegExp]> = [
    [401, /^Error: fivetran_partner_broker_invalid/u],
    [403, /^Error: fivetran_partner_broker_invalid/u],
    [404, /^Error: fivetran_partner_grant_expired:not_connected/u],
    [409, /^Error: fivetran_partner_grant_expired:not_connected/u],
    [502, /^Error: fivetran_partner_broker_unavailable/u],
  ];
  for (const [status, expected] of cases) {
    const partner = bridge(async () => Response.json({ error: "not_connected" }, { status }));
    await assert.rejects(partner.read({ tenantId, service: "xero" }), expected, String(status));
  }
  await assert.rejects(
    bridge(async () => { throw new TypeError("fetch failed"); }).read({ tenantId, service: "xero" }),
    /^Error: fivetran_partner_broker_unavailable/u,
  );
  await assert.rejects(
    bridge(async () => Response.json({ accessToken: "x".repeat(20), expiresAt: new Date(Date.now() - 1000).toISOString(), externalAccountId: "168990" }))
      .read({ tenantId, service: "light_speed_retail" }),
    /^Error: fivetran_partner_grant_expired/u,
  );
  await assert.rejects(
    bridge(async () => Response.json({ accessToken: "x".repeat(20), expiresAt: new Date(Date.now() + 60_000).toISOString(), externalAccountId: "../../etc" }))
      .read({ tenantId, service: "light_speed_retail" }),
    /^Error: fivetran_partner_broker_invalid/u,
  );
  await assert.rejects(
    bridge(async () => Response.json({ accessToken: "x".repeat(20), expiresAt: new Date(Date.now() + 60_000).toISOString(), endpoint: "evil.example.com" }))
      .read({ tenantId, service: "deputy" }),
    /^Error: fivetran_partner_broker_invalid/u,
  );
  await assert.rejects(bridge(async () => Response.json({})).read({ tenantId, service: "stripe" }), /^Error: fivetran_service_unsupported/u);
  await assert.rejects(
    bridge(async () => Response.json({}), null).read({ tenantId, service: "xero" }),
    /^Error: fivetran_partner_binding_not_found/u,
  );
});

/* ------------------------------------------------------------------ */
/* The worker's partner-brokered start, token and relay paths           */
/* ------------------------------------------------------------------ */

type FakeGrants = {
  reads: Array<Record<string, unknown>>;
  bridge: PartnerGrantBridge;
};

function fakeGrants(credential: Partial<PartnerGrantCredential> = {}, bound = true): FakeGrants {
  const reads: Array<Record<string, unknown>> = [];
  return {
    reads,
    bridge: {
      async binding() {
        return bound ? { clientId, partner: "yellow-jersey", accountRef: binding.partner_account_ref } : null;
      },
      async read(input: Record<string, unknown>) {
        reads.push(input);
        return {
          partner: "yellow-jersey",
          partnerClientId: clientId,
          externalAccountReference: "168990",
          displayName: "Wattle Test Cycles",
          accessToken: "partner-access-token",
          expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
          metadata: {},
          ...credential,
        };
      },
    } as unknown as PartnerGrantBridge,
  };
}

function fivetranClient(calls: Array<{ url: string; method: string; body: unknown }>, service: string) {
  return new FivetranClient({
    apiKey: "key",
    apiSecret: "secret",
    fetcher: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ?? null;
      calls.push({ url, method, body });
      if (/\/v1\/connector-sdk\/packages$/u.test(url)) return Response.json({ code: "Success", data: { id: "pkg_123" } });
      return Response.json({
        code: "Success",
        data: {
          id: `${service}_live`,
          service: service === "deputy" ? "deputy" : "connector_sdk",
          schema: (body as Record<string, Record<string, string>>)?.config?.schema ?? `${service}_x`,
          group_id: "group",
          paused: false,
          status: { setup_state: "connected", sync_state: "scheduled" },
        },
      });
    },
  });
}

function worker(store: FivetranConnectionStore, client: FivetranClient, grants?: PartnerGrantBridge) {
  return new FivetranWorkerHttpHandler({
    oauthWorkerSigningSecret: signingSecret,
    allowedRedirectUris: new Set(),
    config: {
      apiKey: "key", apiSecret: "secret", groupId: "group", destinationSchema: "xero",
      tokenBrokerOrigin: "https://worker.example",
      sdkProjectDir: "connectors/xero-fivetran-sdk",
      lightspeedSdkProjectDir: "connectors/lightspeed-fivetran-sdk",
    },
    store,
    destinations: { async bind() {}, async stamp() { return 0; }, async inventory() { return []; }, async retire() {}, async purge() {} } as unknown as FivetranDestinationStore,
    // No Albert OAuth app: a partner-brokered grant must not need one.
    ...(grants ? { partnerGrants: grants } : {}),
    client,
  });
}

async function signedStart(handler: FivetranWorkerHttpHandler, service: string, body: Record<string, unknown>) {
  const payload = JSON.stringify(body);
  const path = `/v1/fivetran/${service}/start`;
  const signed = await signInternalRequest({ method: "POST", path, body: payload, secret: signingSecret });
  return handler.handle(new Request(`https://worker.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signed },
    body: payload,
  }));
}

test("a partner-brokered Lightspeed start deploys the SDK connector over the partner's grant", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const connected: Record<string, unknown>[] = [];
  const grants = fakeGrants();
  const store = {
    async findByPartnerGrant(input: Record<string, unknown>) {
      assert.deepEqual(input, { tenantId, service: "light_speed_retail" });
      return null;
    },
    async findByNativeConnection() { throw new Error("native lookup must not run for a partner grant"); },
    async createConnected(input: Record<string, unknown>) { connected.push(input); },
    async attachFivetranConnectionAny() {},
    async markDisconnected() {},
    async recordSyncState() {},
  } as unknown as FivetranConnectionStore;
  const response = await signedStart(worker(store, fivetranClient(calls, "light_speed_retail"), grants.bridge), "light_speed_retail", {
    tenantId, userId, grantSource: "partner",
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.deepEqual(grants.reads, [{ tenantId, service: "light_speed_retail", minValiditySeconds: 300 }]);
  assert.equal(connected[0]?.partnerClientId, clientId);
  assert.equal(connected[0]?.partner, "yellow-jersey");
  assert.equal(connected[0]?.nativeConnectionId, undefined);
  assert.equal(connected[0]?.externalAccountReference, "168990");
  const create = calls.find((call) => call.method === "POST" && /\/v1\/connections$/u.test(call.url));
  const config = (create?.body as Record<string, Record<string, unknown>>).config!;
  const secrets = Object.fromEntries((config.secrets_list as Array<{ key: string; value: string }>).map((s) => [s.key, s.value]));
  // The connector still asks Albert's worker; the worker asks the partner.
  assert.equal(secrets.albert_token_url, "https://worker.example");
  assert.equal(secrets.lightspeed_account_id, "168990");
  assert.equal(Object.values(secrets).includes("partner-access-token"), false, "no vendor token is written into Fivetran config");
});

test("a repeat partner registration answers with the live connection and touches nothing", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const states: Record<string, unknown>[] = [];
  const existing: FivetranConnectionRow = {
    tenantId,
    connectionId: "01J00000000000000000000099",
    fivetranConnectionId: "light_speed_retail_live",
    destinationSchema: "lightspeed_01j00000000000000000000099",
    service: "light_speed_retail",
    displayName: "Wattle Test Cycles (Fivetran)",
    status: "connected",
    authHealth: "healthy",
    lastSyncState: "syncing",
    nativeConnectionId: null,
    partnerClientId: clientId,
  };
  const store = {
    async findByPartnerGrant() { return existing; },
    async recordSyncState(input: Record<string, unknown>) { states.push(input); },
  } as unknown as FivetranConnectionStore;
  const response = await signedStart(worker(store, fivetranClient(calls, "light_speed_retail"), fakeGrants().bridge), "light_speed_retail", {
    tenantId, userId, grantSource: "partner",
  });
  assert.equal(response.status, 200);
  const { result } = await response.json() as { result: Record<string, unknown> };
  assert.equal(result.connectionId, existing.connectionId);
  assert.deepEqual(calls, [], "no package upload, no config rewrite, no forced sync");
  assert.equal(states[0]?.authHealth, "healthy");
});

test("a partner-brokered Deputy start pushes the partner's token to Fivetran", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const connected: Record<string, unknown>[] = [];
  const grants = fakeGrants({
    externalAccountReference: "wattle.au.deputy.com",
    endpoint: "wattle.au.deputy.com",
    subDomain: "wattle.au",
    accessToken: "deputy-partner-token",
  });
  const store = {
    async findByPartnerGrant() { return null; },
    async createConnected(input: Record<string, unknown>) { connected.push(input); },
  } as unknown as FivetranConnectionStore;
  const response = await signedStart(worker(store, fivetranClient(calls, "deputy"), grants.bridge), "deputy", {
    tenantId, userId, grantSource: "partner",
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(grants.reads[0]?.minValiditySeconds, 8 * 60 * 60);
  const create = calls.find((call) => call.method === "POST" && /\/v1\/connections$/u.test(call.url));
  const config = (create?.body as Record<string, Record<string, unknown>>).config!;
  assert.equal(config.sub_domain, "wattle.au");
  assert.equal(config.access_token, "deputy-partner-token");
  assert.equal(connected[0]?.partnerClientId, clientId);
});

test("partner starts refuse services without a rotating grant and mixed grant sources", async () => {
  const store = {} as FivetranConnectionStore;
  const handler = worker(store, fivetranClient([], "stripe"), fakeGrants().bridge);
  const stripe = await signedStart(handler, "stripe", { tenantId, userId, grantSource: "partner" });
  assert.equal(stripe.status, 503);
  assert.equal(((await stripe.json()) as { error: string }).error, "fivetran_service_unsupported");
  const mixed = await signedStart(handler, "xero", {
    tenantId, userId, grantSource: "partner", nativeConnectionId: "01J00000000000000000000077",
  });
  assert.equal(mixed.status, 409);
  const unbound = await signedStart(worker({
    async findByPartnerGrant() { return null; },
  } as unknown as FivetranConnectionStore, fivetranClient([], "xero"), {
    async binding() { return null; },
    async read() { throw new Error("fivetran_partner_binding_not_found"); },
  } as unknown as PartnerGrantBridge), "xero", { tenantId, userId, grantSource: "partner" });
  assert.equal(unbound.status, 404);
  const unconfigured = await signedStart(worker({} as FivetranConnectionStore, fivetranClient([], "xero")), "xero", {
    tenantId, userId, grantSource: "partner",
  });
  assert.equal(unconfigured.status, 503);
});

function tokenRequest(tokenSecret: string, connectionId: string) {
  return new Request("https://worker.example/v1/fivetran/token", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tokenSecret}` },
    body: JSON.stringify({ tenantId, connectionId }),
  });
}

test("the token broker relays the partner's token to a partner-brokered connector", async () => {
  const { createHash } = await import("node:crypto");
  const tokenSecret = "connector-secret-0123456789";
  const connectionId = "01J00000000000000000000099";
  const row = {
    tenantId,
    connectionId,
    fivetranConnectionId: "sdk_ls",
    destinationSchema: "lightspeed_x",
    service: "light_speed_retail",
    displayName: "Wattle",
    status: "connected",
    authHealth: "healthy",
    lastSyncState: "syncing",
    nativeConnectionId: null,
    partnerClientId: clientId,
    tokenSecretHash: createHash("sha256").update(tokenSecret).digest("hex"),
  };
  const states: Record<string, unknown>[] = [];
  const store = {
    async loadForTokenBroker() { return row; },
    async recordSyncState(input: Record<string, unknown>) { states.push(input); },
    async readMaintenance() { return { unionTables: 0 }; },
  } as unknown as FivetranConnectionStore;
  const grants = fakeGrants();
  const handler = worker(store, fivetranClient([], "light_speed_retail"), grants.bridge);
  const response = await handler.handle(tokenRequest(tokenSecret, connectionId));
  assert.equal(response.status, 200);
  const { result } = await response.json() as { result: Record<string, unknown> };
  assert.equal(result.accessToken, "partner-access-token");
  assert.equal(result.externalAccountId, "168990");
  assert.equal(grants.reads[0]?.minValiditySeconds, 300);

  assert.equal((await handler.handle(tokenRequest("wrong-secret-0123456789", connectionId))).status, 401);

  // The tenant's binding moved to another client: this row gets nothing more.
  const moved = worker(store, fivetranClient([], "light_speed_retail"), fakeGrants({ partnerClientId: "yellow-jersey-other" }).bridge);
  const refused = await moved.handle(tokenRequest(tokenSecret, connectionId));
  assert.equal(refused.status, 404);
  assert.equal(states.some((state) => state.authHealth === "expired"), true, "a lost binding is recorded on the row");
});

test("the Deputy relay pushes partner tokens that outlive the next cycle", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const rows = [{
    tenantId,
    connectionId: "01J00000000000000000000098",
    fivetranConnectionId: "deputy_live",
    destinationSchema: "deputy_x",
    service: "deputy",
    displayName: "Wattle",
    status: "connected",
    authHealth: "healthy",
    lastSyncState: "succeeded",
    nativeConnectionId: null,
    partnerClientId: clientId,
  }];
  const store = {
    async listConnectedByService(input: Record<string, unknown>) {
      assert.deepEqual(input, { service: "deputy" });
      return rows;
    },
    async recordSyncState() {},
  } as unknown as FivetranConnectionStore;
  const grants = fakeGrants({ subDomain: "wattle.au", endpoint: "wattle.au.deputy.com", accessToken: "fresh-deputy-token" });
  const pushed = await worker(store, fivetranClient(calls, "deputy"), grants.bridge).refreshDeputyTokens();
  assert.equal(pushed, 1);
  assert.equal(grants.reads[0]?.minValiditySeconds, 8 * 60 * 60);
  const patch = calls.find((call) => call.method === "PATCH");
  const config = (patch?.body as Record<string, Record<string, unknown>>).config!;
  assert.deepEqual({ sub_domain: config.sub_domain, access_token: config.access_token }, {
    sub_domain: "wattle.au",
    access_token: "fresh-deputy-token",
  });
});
