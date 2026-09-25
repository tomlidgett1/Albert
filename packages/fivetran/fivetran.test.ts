import assert from "node:assert/strict";
import test from "node:test";

import { FivetranApiError, FivetranClient, summarizeSetupTests } from "./src/client.js";
import { exchangeXeroAuthorizationCode, listXeroTenants } from "./src/xero-oauth.js";
import {
  FIVETRAN_XERO_DESTINATION_SCHEMA,
  fivetranXeroConnectionSchema,
  fivetranXeroDestinationSchema,
  isFivetranDestinationSchema,
} from "./src/schema.js";

test("Fivetran Xero uses the native Fivetran destination schema name", () => {
  assert.equal(FIVETRAN_XERO_DESTINATION_SCHEMA, "xero");
  assert.equal(isFivetranDestinationSchema("xero"), true);
  assert.equal(isFivetranDestinationSchema("5XERO"), false);
  assert.equal(isFivetranDestinationSchema("5xero"), false);
  assert.equal(isFivetranDestinationSchema("_5xero"), false);
  assert.equal(fivetranXeroDestinationSchema(), "xero");
  assert.throws(() => fivetranXeroDestinationSchema("5XERO"), /fivetran_schema_invalid/u);
});

test("each Fivetran Xero connection gets a tenant-isolated destination schema", () => {
  assert.equal(
    fivetranXeroConnectionSchema("01KZN20VTX2EWW1TQ2AA3MCPW6"),
    "xero_01kzn20vtx2eww1tq2aa3mcpw6",
  );
  assert.notEqual(
    fivetranXeroConnectionSchema("01KZN20VTX2EWW1TQ2AA3MCPW6"),
    fivetranXeroConnectionSchema("01KZN20VTX2EWW1TQ2AA3MCPW7"),
  );
  assert.throws(() => fivetranXeroConnectionSchema("5XERO"), /fivetran_schema_invalid/u);
});

test("Fivetran client creates a paused Xero connection with a Connect Card", async () => {
  const calls: Array<Readonly<{ url: string; method: string; body: unknown }>> = [];
  const client = new FivetranClient({
    apiKey: "key",
    apiSecret: "secret",
    fetcher: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ url, method, body });
      return Response.json({
        code: "Success",
        data: {
          id: "ecological_groan",
          service: "xero",
          schema: "xero",
          group_id: "destination_group",
          paused: true,
          status: { setup_state: "connected", sync_state: "paused" },
        },
      });
    },
  });

  const created = await client.createXeroConnection({
    groupId: "destination_group",
    clientId: "xero-client",
    clientSecret: "xero-secret",
    redirectUri: "https://albert.example/api/oauth/fivetran-xero/callback",
  });
  assert.equal(created.id, "ecological_groan");
  assert.equal(created.schema, "xero");
  assert.deepEqual(created.setupTests, []);
  assert.equal(summarizeSetupTests([
    { title: "Verifying Organization Connection", status: "FAILED", message: "Please re-authorise" },
  ]), "Verifying Organization Connection: Please re-authorise");
  assert.equal(calls[0]?.method, "POST");
  assert.match(String(calls[0]?.url), /\/v1\/connections$/u);
  const body = calls[0]?.body as Record<string, unknown>;
  assert.equal(body.service, "xero");
  assert.equal(body.run_setup_tests, false);
  assert.equal(body.paused, true);
  assert.deepEqual(body.connect_card_config, {
    redirect_uri: "https://albert.example/api/oauth/fivetran-xero/callback",
    hide_setup_guide: true,
    all_fields: false,
  });
  assert.deepEqual(body.config, { schema: "xero", client_id: "xero-client", client_secret: "xero-secret" });
  assert.equal(body.auth, undefined);
});

test("Xero authorization-code exchange never logs the grant", async () => {
  const tokens = await exchangeXeroAuthorizationCode({
    clientId: "xero-client",
    clientSecret: "xero-secret",
    code: "auth-code",
    codeVerifier: "verifier",
    redirectUri: "https://albert.example/api/oauth/fivetran-xero/callback",
    fetcher: async (_input, init) => {
      const body = String(init?.body ?? "");
      assert.match(body, /grant_type=authorization_code/u);
      assert.match(body, /code=auth-code/u);
      return Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 1800,
        token_type: "Bearer",
      });
    },
  });
  assert.deepEqual(tokens, { accessToken: "access-token", refreshToken: "refresh-token" });
});

test("Xero tenant discovery uses the access token and never logs it", async () => {
  const tenants = await listXeroTenants({
    accessToken: "access-token",
    fetcher: async (input, init) => {
      assert.equal(String(input), "https://api.xero.com/connections");
      assert.match(String(init?.headers && "authorization" in init.headers ? init.headers.authorization : ""), /Bearer access-token/u);
      return Response.json([{ tenantId: "tenant-1", tenantName: "Demo Org" }]);
    },
  });
  assert.deepEqual(tenants, [{ tenantId: "tenant-1", tenantName: "Demo Org" }]);
});

test("Fivetran client can pause a connection without starting a second sync", async () => {
  const calls: Array<Readonly<{ url: string; method: string; body: unknown }>> = [];
  const client = new FivetranClient({
    apiKey: "key",
    apiSecret: "secret",
    fetcher: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ url, method, body });
      return Response.json({
        code: "Success",
        data: {
          id: "running_substratum",
          service: "stripe",
          schema: "stripe_demo",
          group_id: "destination_group",
          paused: true,
          status: { setup_state: "connected", sync_state: "paused" },
        },
      });
    },
  });
  const paused = await client.pause("running_substratum");
  assert.equal(paused.paused, true);
  assert.equal(calls[0]?.method, "PATCH");
  assert.match(String(calls[0]?.url), /\/v1\/connections\/running_substratum$/u);
  assert.deepEqual(calls[0]?.body, { paused: true });
});

test("Fivetran client can change schedule without pausing or starting a sync", async () => {
  const calls: Array<Readonly<{ url: string; method: string; body: unknown }>> = [];
  const client = new FivetranClient({
    apiKey: "key",
    apiSecret: "secret",
    fetcher: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ url, method, body });
      return Response.json({
        code: "Success",
        data: {
          id: "running_substratum",
          service: "stripe",
          schema: "stripe_demo",
          group_id: "destination_group",
          paused: false,
          status: { setup_state: "connected", sync_state: "syncing", is_historical_sync: true },
        },
      });
    },
  });
  const updated = await client.updateSchedule("running_substratum", {
    syncFrequencyMinutes: 1440,
    dailySyncTimeUtc: "08:00",
    scheduleType: "manual",
  });
  assert.equal(updated.paused, false);
  assert.equal(updated.status.syncState, "syncing");
  assert.deepEqual(calls[0]?.body, {
    sync_frequency: 1440,
    schedule_type: "manual",
    daily_sync_time: "08:00",
  });
});

test("Fivetran client surfaces API errors without echoing credentials", async () => {
  const client = new FivetranClient({
    apiKey: "key",
    apiSecret: "super-secret",
    fetcher: async () => Response.json({ code: "InvalidRequest", message: "schema already exists" }, { status: 409 }),
  });
  await assert.rejects(
    () => client.getConnection("missing"),
    (error: unknown) => {
      assert.ok(error instanceof FivetranApiError);
      assert.equal(error.status, 409);
      assert.match(error.message, /schema already exists/u);
      assert.doesNotMatch(error.message, /super-secret/u);
      return true;
    },
  );
});
