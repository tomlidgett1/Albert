import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DeputyConnector } from "../../connectors/deputy/index";
import { deputyManifest } from "../../connectors/deputy/manifest";
import { buildDeputyAuthorizationUrl } from "../../connectors/deputy/oauth-public";
import { deputySchemas } from "../../connectors/deputy/schemas";
import { LightspeedRConnector } from "../../connectors/lightspeed-r/index";
import { lightspeedRManifest } from "../../connectors/lightspeed-r/manifest";
import { buildLightspeedRAuthorizationUrl } from "../../connectors/lightspeed-r/oauth-public";
import { lightspeedSchemas } from "../../connectors/lightspeed-r/schemas";
import { XeroConnector } from "../../connectors/xero/index";
import {
  XERO_DEFAULT_SCOPES,
  xeroManifest,
  xeroRequestedScopes,
} from "../../connectors/xero/manifest";
import { buildXeroAuthorizationUrl } from "../../connectors/xero/oauth-public";
import { xeroSchemas } from "../../connectors/xero/schemas";
import {
  assertFixtureFieldCoverage,
  decodeCursor,
  encodeCursor,
  fetchWithRetry,
  ConnectorHttpError,
  normalizeDecimal,
  normalizeTimestamp,
  type CredentialRefreshLeaseContext,
  type ConnectorManifest,
  type OAuthCredentialSecret,
  type VersionedCredential,
  type WorkerCredentialVault,
} from "../../packages/connector-sdk/src/index";

type Fixture = Readonly<{
  fixtureVersion: number;
  provenance: string;
  responses: Readonly<Record<string, unknown>>;
}>;

function fixture(relativePath: string): Fixture {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8"),
  ) as Fixture;
}

function recordsFor(
  manifest: ConnectorManifest,
  responses: Readonly<Record<string, unknown>>,
  streamId: string,
): readonly Readonly<Record<string, unknown>>[] {
  const contract = manifest.streams.find((item) => item.id === streamId);
  assert.ok(contract, `Missing ${streamId} stream contract`);
  const response = responses[streamId];
  const candidate = manifest.id === "deputy"
    ? response
    : response && typeof response === "object"
      ? (response as Record<string, unknown>)[contract.resource]
      : undefined;
  const records = Array.isArray(candidate) ? candidate : candidate ? [candidate] : [];
  return records as readonly Readonly<Record<string, unknown>>[];
}

class MemoryVault implements WorkerCredentialVault {
  private revision = 1;
  constructor(private value: OAuthCredentialSecret) {}

  async create(secret: OAuthCredentialSecret): Promise<VersionedCredential> {
    this.value = secret;
    return this.read("credential:test");
  }

  async read(credentialRef: string): Promise<VersionedCredential> {
    return { credentialRef, revision: String(this.revision), secret: this.value };
  }

  async compareAndSwap(
    credentialRef: string,
    expectedRevision: string,
    secret: OAuthCredentialSecret,
  ): Promise<VersionedCredential> {
    assert.equal(expectedRevision, String(this.revision));
    this.value = secret;
    this.revision += 1;
    return this.read(credentialRef);
  }

  withRefreshLease<T>(
    _credentialRef: string,
    operation: (lease: CredentialRefreshLeaseContext) => Promise<T>,
    abortSignal = new AbortController().signal,
  ): Promise<T> {
    return operation({
      abortSignal,
      proof: { leaseId: "01H00000000000000000000000", fencingToken: "1" },
    });
  }

  async destroy(credentialRef: string): Promise<void> {
    void credentialRef;
    this.value = { ...this.value, accessToken: "destroyed", refreshToken: undefined };
  }
}

const context = {
  tenantId: "tenant-test",
  connectionId: "connection-test",
  credentialRef: "credential:test",
} as const;

test("all connector streams have typed, covered sanitized fixtures", () => {
  const packs = [
    {
      manifest: lightspeedRManifest,
      schemas: lightspeedSchemas,
      fixture: fixture("../../connectors/lightspeed-r/fixtures/sanitized-recording.json"),
    },
    {
      manifest: xeroManifest,
      schemas: xeroSchemas,
      fixture: fixture("../../connectors/xero/fixtures/sanitized-recording.json"),
    },
    {
      manifest: deputyManifest,
      schemas: deputySchemas,
      fixture: fixture("../../connectors/deputy/fixtures/sanitized-recording.json"),
    },
  ] as const;

  for (const pack of packs) {
    assert.equal(pack.fixture.fixtureVersion, 1);
    assert.match(pack.fixture.provenance, /Sanitized contract recording/u);
    assert.deepEqual(
      [...pack.manifest.streams.map((item) => item.id)].sort(),
      [...Object.keys(pack.schemas)].sort(),
    );
    for (const stream of pack.manifest.streams) {
      const records = recordsFor(pack.manifest, pack.fixture.responses, stream.id);
      assert.ok(records.length > 0, `${pack.manifest.id}.${stream.id} fixture is empty`);
      const schema = (pack.schemas as unknown as Readonly<Record<
        string,
        Readonly<{ safeParse(value: unknown): Readonly<{ success: boolean }> }>
      >>)[stream.id];
      assert.ok(schema, `${pack.manifest.id}.${stream.id} schema is missing`);
      for (const record of records) {
        const parsed = schema.safeParse(record);
        assert.equal(parsed.success, true, `${pack.manifest.id}.${stream.id} fixture is untyped`);
      }
      assertFixtureFieldCoverage(pack.manifest, stream.id, records);
    }
    assert.ok(pack.manifest.documentation.every((url) => url.startsWith("https://")));
    assert.deepEqual(
      [...new Set(pack.manifest.fieldCoverage.map((field) => `${field.stream}:${field.field}`))],
      pack.manifest.fieldCoverage.map((field) => `${field.stream}:${field.field}`),
      `${pack.manifest.id} has duplicate field dispositions`,
    );
  }
});

test("public OAuth builders contain only public, state-bound values", () => {
  const lightspeed = new URL(buildLightspeedRAuthorizationUrl({
    clientId: "public-ls-id",
    state: "state-ls",
    redirectUri: "https://albert.example/oauth/lightspeed-r/callback",
    codeChallenge: "lightspeed-pkce-challenge",
  }));
  assert.equal(lightspeed.hostname, "cloud.lightspeedapp.com");
  assert.equal(lightspeed.searchParams.get("state"), "state-ls");
  assert.equal(lightspeed.searchParams.get("code_challenge"), "lightspeed-pkce-challenge");
  assert.equal(lightspeed.searchParams.get("code_challenge_method"), "S256");
  assert.equal(lightspeed.toString().includes("secret"), false);

  const xero = new URL(buildXeroAuthorizationUrl({
    clientId: "public-xero-id",
    state: "state-xero",
    redirectUri: "https://albert.example/oauth/xero/callback",
    codeChallenge: "challenge",
  }));
  assert.equal(xero.hostname, "login.xero.com");
  assert.equal(xero.searchParams.get("code_challenge_method"), "S256");
  assert.equal(xero.searchParams.get("state"), "state-xero");
  assert.equal(xero.searchParams.get("scope")?.includes("accounting.transactions"), false);
  assert.equal(xero.searchParams.get("scope")?.includes("accounting.journals.read"), false);
  assert.equal(XERO_DEFAULT_SCOPES.includes("accounting.journals.read" as never), false);
  assert.equal(xeroRequestedScopes(true).includes("accounting.journals.read"), true);

  const deputy = new URL(buildDeputyAuthorizationUrl({
    clientId: "public-deputy-id",
    state: "state-deputy",
    redirectUri: "https://albert.example/oauth/deputy/callback",
  }));
  assert.equal(deputy.hostname, "once.deputy.com");
  assert.equal(deputy.searchParams.get("scope"), "longlife_refresh_token");
  assert.equal(deputy.searchParams.get("state"), "state-deputy");
});

test("opaque cursors are provider and stream scoped", () => {
  const cursor = encodeCursor({
    v: 1,
    connector: "xero",
    stream: "invoices",
    mode: "incremental",
    watermark: "2026-07-31T00:00:00.000Z",
    continuation: 2,
  });
  assert.equal(
    decodeCursor(cursor, { connector: "xero", stream: "invoices" }).continuation,
    2,
  );
  assert.throws(
    () => decodeCursor(cursor, { connector: "xero", stream: "contacts" }),
    /cursor is invalid/iu,
  );
});

test("normalization preserves raw money and timestamps while emitting deterministic values", () => {
  assert.deepEqual(normalizeDecimal("1.2345e3", "aud"), {
    raw: "1.2345e3",
    exact: "1234.5",
    currency: "AUD",
  });
  assert.equal(normalizeDecimal("not-money").exact, null);
  assert.equal(
    normalizeTimestamp("/Date(1785474000000+0000)/").utc,
    "2026-07-31T05:00:00.000Z",
  );
  assert.equal(
    normalizeTimestamp(1785452400, { unixUnit: "seconds" }).utc,
    "2026-07-30T23:00:00.000Z",
  );
});

test("HTTP retry honors Retry-After rather than a fixed provider sleep", async () => {
  let calls = 0;
  const delays: number[] = [];
  const response = await fetchWithRetry(
    async () => {
      calls += 1;
      return calls === 1
        ? new Response(null, { status: 429, headers: { "retry-after": "2" } })
        : Response.json({ ok: true });
    },
    "https://vendor.example/read",
    { method: "GET" },
    { sleep: async (milliseconds) => { delays.push(milliseconds); } },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(delays, [2000]);
});

test("HTTP attempts have a hard deadline even when a fetch implementation ignores abort", async () => {
  let attemptSignal: AbortSignal | undefined;
  const startedAt = Date.now();
  await assert.rejects(
    fetchWithRetry(
      async (_input, init) => {
        attemptSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => undefined);
      },
      "https://vendor.example/hung-tls",
      { method: "GET" },
      { maxAttempts: 1, attemptTimeoutMs: 20 },
    ),
    /could not be reached/iu,
  );
  assert.ok(Date.now() - startedAt < 1_000, "hung fetch outlived its attempt deadline");
  assert.equal(attemptSignal?.aborted, true);
});

test("long Retry-After values are returned to durable orchestration without sleeping", async () => {
  let slept = false;
  await assert.rejects(
    fetchWithRetry(
      async () => new Response(null, { status: 429, headers: { "retry-after": "3600" } }),
      "https://vendor.example/rate-limited",
      { method: "GET" },
      {
        maxAttempts: 5,
        maxInlineRetryAfterMs: 1_000,
        sleep: async () => { slept = true; },
      },
    ),
    (error) => error instanceof ConnectorHttpError && error.retryAfterMs === 3_600_000,
  );
  assert.equal(slept, false);
});

test("Xero and Deputy webhooks fail closed and normalize supported stream signals", async () => {
  const xeroKey = "xero-webhook-key";
  const xeroPayload = new TextEncoder().encode(JSON.stringify({
    events: [{
      resourceUrl: "https://api.xero.com/api.xro/2.0/Invoices/id",
      resourceId: "00000000-0000-4000-8000-000000000004",
      eventDateUtc: "2026-07-31T01:00:00Z",
      eventType: "UPDATE",
      eventCategory: "INVOICE",
      tenantId: "xero-tenant",
      tenantType: "ORGANISATION",
    }],
    firstEventSequence: 4,
    lastEventSequence: 4,
    entropy: "fixture",
  }));
  const xeroVault = new MemoryVault({
    provider: "xero",
    accessToken: "access",
    refreshToken: "refresh",
    tokenType: "Bearer",
    expiresAt: "2099-01-01T00:00:00.000Z",
    scopes: ["accounting.journals.read"],
    metadata: { xeroTenantId: "xero-tenant" },
  });
  const xero = new XeroConnector({
    clientId: "client",
    oauthMode: "pkce",
    webhookSigningKey: xeroKey,
    vault: xeroVault,
  });
  const xeroDisposition = await xero.handle_webhook(context, {
    id: "event-xero",
    receivedAt: "2026-07-31T01:00:01Z",
    headers: {
      "x-xero-signature": createHmac("sha256", xeroKey).update(xeroPayload).digest("base64"),
    },
    body: xeroPayload,
  });
  assert.deepEqual(xeroDisposition.streams, ["invoices"]);
  await assert.rejects(
    xero.handle_webhook(context, {
      id: "bad-xero",
      receivedAt: "2026-07-31T01:00:01Z",
      headers: { "x-xero-signature": "invalid" },
      body: xeroPayload,
    }),
    /signature is invalid/iu,
  );

  const deputyKey = "deputy-enterprise-key";
  const deputyHeaderSecret = "deputy-connection-secret".repeat(2);
  const deputyCallbackUrl = "https://hooks.albert.example/v1/webhooks/deputy/01J00000000000000000000001/01J00000000000000000000002";
  const deputyPayload = new TextEncoder().encode(JSON.stringify({
    topic: "Timesheet.Update",
    data: { Id: 501 },
  }));
  const deputyVault = new MemoryVault({
    provider: "deputy",
    accessToken: "access",
    refreshToken: "refresh",
    tokenType: "Bearer",
    expiresAt: "2099-01-01T00:00:00.000Z",
    scopes: ["longlife_refresh_token"],
    metadata: { endpoint: "demo.au.deputy.com" },
  });
  const deputy = new DeputyConnector({
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "https://albert.example/oauth/deputy/callback",
    webhookVerification: {
      material: {
        version: 1,
        customHeaderSecret: deputyHeaderSecret,
        enterpriseHmacKey: deputyKey,
      },
      callbackUrl: deputyCallbackUrl,
    },
    now: () => Date.parse("2026-07-31T01:00:01Z"),
    vault: deputyVault,
  });
  const deputyDisposition = await deputy.handle_webhook(context, {
    id: "event-deputy",
    receivedAt: "2026-07-31T01:00:01Z",
    headers: {
      "x-deputy-secret": createHmac("sha256", deputyKey).update(deputyPayload).digest("hex"),
      "x-deputy-generation-time": String(Math.floor(Date.parse("2026-07-31T01:00:01Z") / 1_000)),
      "x-deputy-webhook-callback": deputyCallbackUrl,
      "x-albert-webhook-secret": deputyHeaderSecret,
    },
    body: deputyPayload,
  });
  assert.deepEqual(deputyDisposition.streams, ["timesheets"]);
});

test("connector capability manifests never silently promote gated sources", async () => {
  const xeroWithoutJournals = new XeroConnector({
    clientId: "client",
    oauthMode: "pkce",
    webhookSigningKey: "key",
    vault: new MemoryVault({
      provider: "xero",
      accessToken: "access",
      refreshToken: "refresh",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["accounting.settings.read"],
      metadata: { xeroTenantId: "tenant" },
    }),
  });
  const ledger = (await xeroWithoutJournals.describe_capabilities(context))
    .find((item) => item.id === "finance.general_ledger");
  assert.equal(ledger?.support, "unavailable");

  const lightspeed = new LightspeedRConnector({
    clientId: "client",
    clientSecret: "secret",
    vault: new MemoryVault({
      provider: "lightspeed-r",
      accessToken: "access",
      refreshToken: "refresh",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["employee:register_read"],
      metadata: {},
    }),
  });
  assert.equal((await lightspeed.handle_webhook(context, {
    id: "unused",
    receivedAt: "2026-07-31T00:00:00Z",
    headers: {},
    body: new Uint8Array(),
  })).accepted, false);
});

test("connector workers execute typed, read-only extraction pages against vendor-shaped recordings", async () => {
  const lightspeedFixture = fixture("../../connectors/lightspeed-r/fixtures/sanitized-recording.json");
  const lightspeedRequests: URL[] = [];
  const lightspeed = new LightspeedRConnector({
    clientId: "client",
    clientSecret: "secret",
    vault: new MemoryVault({
      provider: "lightspeed-r",
      accessToken: "access",
      refreshToken: "refresh",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["employee:register_read"],
      metadata: { lightspeedAccountId: "101" },
    }),
    fetcher: async (input, init) => {
      assert.equal(init?.method, "GET");
      const url = new URL(input instanceof Request ? input.url : input.toString());
      lightspeedRequests.push(url);
      if (url.pathname === "/API/V3/Account.json") {
        return Response.json({ Account: { accountID: "101", name: "Demo" } });
      }
      if (url.pathname.endsWith("/Sale.json")) {
        return Response.json(lightspeedFixture.responses.sales, {
          headers: {
            "x-ls-api-bucket-level": "2/90",
            "x-ls-api-drip-rate": "1",
          },
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  const saleStream = (await lightspeed.list_streams(context)).find((stream) => stream.id === "sales");
  assert.ok(saleStream);
  const salePage = await lightspeed.initial_sync(
    context,
    saleStream,
    { from: "2026-07-01T00:00:00Z", to: "2026-08-01T00:00:00Z" },
  );
  assert.equal(salePage.records.length, 1);
  assert.equal(salePage.records[0]?.normalized?.money?.total?.exact, "1499.0000");
  assert.equal(salePage.records[0]?.validationIssues, undefined);
  const saleUrl = lightspeedRequests.find((url) => url.pathname.endsWith("/Sale.json"));
  assert.equal(saleUrl?.searchParams.get("load_relations"), '["SaleLines","SalePayments"]');
  assert.match(saleUrl?.searchParams.get("timeStamp") ?? "", /^><,/u);

  const xeroFixture = fixture("../../connectors/xero/fixtures/sanitized-recording.json");
  const xeroRequests: URL[] = [];
  const xero = new XeroConnector({
    clientId: "client",
    oauthMode: "pkce",
    webhookSigningKey: "key",
    vault: new MemoryVault({
      provider: "xero",
      accessToken: "access",
      refreshToken: "refresh",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["accounting.transactions.read"],
      metadata: { xeroTenantId: "xero-tenant" },
    }),
    fetcher: async (input, init) => {
      assert.equal(init?.method, "GET");
      const url = new URL(input instanceof Request ? input.url : input.toString());
      xeroRequests.push(url);
      if (url.pathname === "/connections") {
        return Response.json([{
          id: "xero-connection",
          tenantId: "xero-tenant",
          tenantType: "ORGANISATION",
          tenantName: "Demo Xero",
        }]);
      }
      if (url.pathname.endsWith("/Invoices")) {
        assert.equal(new Headers(init?.headers).get("xero-tenant-id"), "xero-tenant");
        return Response.json(xeroFixture.responses.invoices);
      }
      if (url.pathname.endsWith("/Payments")) {
        assert.equal(new Headers(init?.headers).get("xero-tenant-id"), "xero-tenant");
        return Response.json(xeroFixture.responses.payments);
      }
      return new Response(null, { status: 404 });
    },
  });
  const invoiceStream = (await xero.list_streams(context)).find((stream) => stream.id === "invoices");
  assert.ok(invoiceStream);
  const invoicePage = await xero.initial_sync(
    context,
    invoiceStream,
    { from: "2026-07-01T00:00:00Z", to: "2026-08-01T00:00:00Z" },
  );
  assert.equal(invoicePage.records[0]?.normalized?.money?.Total?.exact, "1499.0000");
  assert.equal(invoicePage.records[0]?.validationIssues, undefined);
  const invoiceUrl = xeroRequests.find((url) => url.pathname.endsWith("/Invoices"));
  assert.equal(invoiceUrl?.searchParams.get("page"), "1");
  assert.match(invoiceUrl?.searchParams.get("where") ?? "", /^Date>=DateTime/u);

  const paymentStream = (await xero.list_streams(context)).find((stream) => stream.id === "payments");
  assert.ok(paymentStream);
  const paymentPage = await xero.initial_sync(
    context,
    paymentStream,
    { from: "2026-07-01T00:00:00Z", to: "2026-08-01T00:00:00Z" },
  );
  const paymentRecord = paymentPage.records[0];
  assert.ok(paymentRecord);
  assert.equal(paymentRecord.validationIssues, undefined);
  assert.equal(paymentRecord.normalized?.money?.BankAmount?.exact, "1499.0000");
  assert.deepEqual(paymentRecord.normalized?.fields.Prepayment, null);
  assert.equal(
    (paymentRecord.normalized?.fields.BatchPayment as Record<string, unknown>).BatchPaymentID,
    "00000000-0000-4000-8000-000000000016",
  );

  const deputyFixture = fixture("../../connectors/deputy/fixtures/sanitized-recording.json");
  let deputyQuery: Record<string, unknown> | undefined;
  const deputy = new DeputyConnector({
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "https://albert.example/oauth/deputy/callback",
    vault: new MemoryVault({
      provider: "deputy",
      accessToken: "access",
      refreshToken: "refresh",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["longlife_refresh_token"],
      metadata: { endpoint: "demo.au.deputy.com" },
    }),
    fetcher: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      assert.equal(init?.method, "POST");
      assert.equal(url.pathname, "/api/v1/resource/Timesheet/QUERY");
      deputyQuery = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json(deputyFixture.responses.timesheets);
    },
  });
  const timesheetStream = (await deputy.list_streams(context)).find((stream) => stream.id === "timesheets");
  assert.ok(timesheetStream);
  const timesheetPage = await deputy.initial_sync(
    context,
    timesheetStream,
    { from: "2026-07-01T00:00:00Z", to: "2026-08-01T00:00:00Z" },
  );
  assert.equal(timesheetPage.records[0]?.normalized?.money?.Cost?.exact, "240.0000");
  assert.equal(timesheetPage.records[0]?.validationIssues, undefined);
  assert.equal((deputyQuery?.search as Record<string, Record<string, unknown>>).s1?.field, "StartTime");
});

test("documented Deputy leave aliases and opaque metadata do not quarantine legitimate records", async () => {
  const recording = fixture("../../connectors/deputy/fixtures/sanitized-recording.json");
  const recordedLeave = recordsFor(deputyManifest, recording.responses, "leave")[0];
  assert.ok(recordedLeave);
  const {
    ExternalID: externalId,
    TimeZone: timeZone,
    ...leaveFields
  } = recordedLeave;
  const connector = new DeputyConnector({
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "https://albert.example/oauth/deputy/callback",
    vault: new MemoryVault({
      provider: "deputy",
      accessToken: "access",
      refreshToken: "refresh",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["longlife_refresh_token"],
      metadata: { endpoint: "demo.au.deputy.com" },
    }),
    fetcher: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      assert.equal(init?.method, "POST");
      assert.equal(url.pathname, "/api/v1/resource/Leave/QUERY");
      return Response.json([{
        ...leaveFields,
        ExternalId: externalId,
        Timezone: timeZone,
      }]);
    },
  });
  const stream = (await connector.list_streams(context)).find((item) => item.id === "leave");
  assert.ok(stream);
  const page = await connector.initial_sync(
    context,
    stream,
    { from: "2026-08-01T00:00:00Z", to: "2026-09-01T00:00:00Z" },
  );
  const record = page.records[0];
  assert.ok(record);
  assert.equal(record.validationIssues, undefined);
  assert.equal(record.normalized?.fields.ExternalID, externalId);
  assert.equal(record.normalized?.fields.TimeZone, timeZone);
  assert.equal(record.normalized?.fields.ExternalId, undefined);
  assert.equal(record.normalized?.fields.Timezone, undefined);
  assert.equal(record.normalized?.fields._DPMetaData, undefined);
  assert.equal(record.normalized?.timestamps?.Start?.utc, "2026-08-09T14:00:00.000Z");
  assert.equal(record.normalized?.timestamps?.End?.utc, "2026-08-10T13:59:59.000Z");
});

test("Deputy location extraction requests its documented AddressObject identity evidence", async () => {
  const recording = fixture("../../connectors/deputy/fixtures/sanitized-recording.json");
  let query: Record<string, unknown> | undefined;
  const connector = new DeputyConnector({
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "https://albert.example/oauth/deputy/callback",
    vault: new MemoryVault({
      provider: "deputy",
      accessToken: "access",
      refreshToken: "refresh",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["longlife_refresh_token"],
      metadata: { endpoint: "demo.au.deputy.com" },
    }),
    fetcher: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      assert.equal(url.pathname, "/api/v1/resource/Company/QUERY");
      query = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json(recording.responses.companies);
    },
  });
  const stream = (await connector.list_streams(context)).find((candidate) => candidate.id === "companies");
  assert.ok(stream);
  const page = await connector.initial_sync(
    context,
    stream,
    { from: "2026-07-01T00:00:00Z", to: "2026-08-01T00:00:00Z" },
  );
  assert.deepEqual(query?.join, ["AddressObject"]);
  assert.equal(page.records[0]?.validationIssues, undefined);
  assert.equal(
    (page.records[0]?.normalized?.fields.AddressObject as Record<string, unknown>).Street1,
    "1 Example Lane",
  );
});

test("Lightspeed InventoryLog advances by sortable ID and keeps additive drift out of staging", async () => {
  const recording = fixture("../../connectors/lightspeed-r/fixtures/sanitized-recording.json");
  const inventoryResponse = recording.responses.inventory_logs as Record<string, unknown>;
  const inventory = (inventoryResponse.InventoryLog as readonly Record<string, unknown>[])[0];
  assert.ok(inventory);
  const requests: URL[] = [];
  let inventoryCalls = 0;
  const connector = new LightspeedRConnector({
    clientId: "client",
    clientSecret: "secret",
    vault: new MemoryVault({
      provider: "lightspeed-r",
      accessToken: "access",
      refreshToken: "refresh",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["employee:inventory_read", "employee:product_cost"],
      metadata: { lightspeedAccountId: "101" },
    }),
    fetcher: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push(url);
      if (url.pathname === "/API/V3/Account.json") {
        return Response.json({ Account: { accountID: "101", name: "Demo" } });
      }
      inventoryCalls += 1;
      return inventoryCalls === 1
        ? Response.json({
            "@attributes": { next: "" },
            InventoryLog: [{ ...inventory, newAdditiveVendorField: "raw-only" }],
          })
        : Response.json({ "@attributes": { next: "" }, InventoryLog: [] });
    },
  });
  const stream = (await connector.list_streams(context)).find((item) => item.id === "inventory_logs");
  assert.ok(stream);
  const initial = await connector.initial_sync(
    context,
    stream,
    { from: "2026-07-01T00:00:00Z", to: "2026-08-01T00:00:00Z" },
  );
  assert.equal(requests.at(-1)?.searchParams.get("sort"), "inventoryLogID");
  assert.match(requests.at(-1)?.searchParams.get("createTime") ?? "", /^><,/u);
  assert.equal(
    decodeCursor(initial.nextCursor!, { connector: "lightspeed-r", stream: "inventory_logs" }).continuation,
    1101,
  );
  assert.equal(initial.records[0]?.normalized?.fields.newAdditiveVendorField, undefined);
  assert.equal(initial.records[0]?.normalized?.fields.qohChange, "1.0000");
  assert.equal(initial.records[0]?.validationIssues?.[0]?.code, "schema_drift");

  await connector.incremental_sync(context, stream, initial.nextCursor!);
  assert.equal(requests.at(-1)?.searchParams.get("inventoryLogID"), ">,1101");
  assert.equal(
    (await connector.describe_capabilities(context)).find((item) =>
      item.id === "inventory.historical_movements")?.support,
    "partial",
  );
});

test("rotating refresh tokens are persisted with compare-and-swap before use", async () => {
  const vault = new MemoryVault({
    provider: "xero",
    accessToken: "expired-access",
    refreshToken: "old-refresh",
    tokenType: "Bearer",
    expiresAt: "2020-01-01T00:00:00.000Z",
    scopes: ["accounting.settings.read"],
    metadata: {},
  });
  let connectionsAuthorization = "";
  const xero = new XeroConnector({
    clientId: "client",
    oauthMode: "pkce",
    webhookSigningKey: "key",
    vault,
    now: () => Date.parse("2026-08-03T00:00:00Z"),
    fetcher: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === "identity.xero.com") {
        assert.equal(String(init?.body).includes("old-refresh"), true);
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          `Basic ${Buffer.from("client:", "utf8").toString("base64")}`,
        );
        return Response.json({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 1800,
          token_type: "Bearer",
          scope: "accounting.settings.read",
        });
      }
      connectionsAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json([]);
    },
  });
  await xero.discover_accounts(context);
  assert.equal(connectionsAuthorization, "Bearer new-access");
  assert.equal((await vault.read(context.credentialRef)).secret.refreshToken, "new-refresh");
  assert.equal((await vault.read(context.credentialRef)).revision, "2");
});

test("Xero discovery ignores non-organisation connections with null tenant names", async () => {
  const xero = new XeroConnector({
    clientId: "client",
    oauthMode: "pkce",
    vault: new MemoryVault({
      provider: "xero",
      accessToken: "access",
      refreshToken: "refresh",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["accounting.settings.read"],
      metadata: {},
    }),
    fetcher: async () => Response.json([
      {
        id: "practice-connection",
        tenantId: "practice-tenant",
        tenantType: "PRACTICEMANAGER",
        tenantName: null,
      },
      {
        id: "organisation-connection",
        tenantId: "organisation-tenant",
        tenantType: "ORGANISATION",
        tenantName: "Demo Organisation",
      },
    ]),
  });

  assert.deepEqual(await xero.discover_accounts(context), [{
    externalAccountId: "organisation-tenant",
    displayName: "Demo Organisation",
    baseUrl: "https://api.xero.com/api.xro/2.0/",
    metadata: {
      xeroConnectionId: "organisation-connection",
      tenantType: "ORGANISATION",
      updatedAt: null,
    },
  }]);
});

test("Lightspeed and Xero disconnect remotely before cryptographically destroying local access", async () => {
  const lightspeedVault = new MemoryVault({
    provider: "lightspeed-r",
    accessToken: "lightspeed-access",
    refreshToken: "lightspeed-refresh",
    tokenType: "Bearer",
    expiresAt: "2099-01-01T00:00:00.000Z",
    scopes: ["employee:register_read"],
    metadata: {},
  });
  let lightspeedRevoked = false;
  const lightspeed = new LightspeedRConnector({
    clientId: "lightspeed-client",
    clientSecret: "lightspeed-secret",
    vault: lightspeedVault,
    fetcher: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      assert.equal(url.toString(), "https://cloud.lightspeedapp.com/auth/oauth/revoke");
      assert.equal(init?.method, "POST");
      const body = init?.body as URLSearchParams;
      assert.equal(body.get("refresh_token"), "lightspeed-refresh");
      lightspeedRevoked = true;
      return new Response(null, { status: 204 });
    },
  });
  await lightspeed.revoke_credentials(context);
  assert.equal(lightspeedRevoked, true);
  assert.equal((await lightspeedVault.read(context.credentialRef)).secret.accessToken, "destroyed");

  const xeroVault = new MemoryVault({
    provider: "xero",
    accessToken: "xero-access",
    refreshToken: "xero-refresh",
    tokenType: "Bearer",
    expiresAt: "2099-01-01T00:00:00.000Z",
    scopes: ["accounting.invoices.read"],
    metadata: { xeroTenantId: "tenant-1", xeroConnectionId: "connection-1" },
  });
  let xeroDisconnected = false;
  const xero = new XeroConnector({
    clientId: "xero-client",
    oauthMode: "pkce",
    webhookSigningKey: "xero-hook",
    vault: xeroVault,
    fetcher: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      assert.equal(url.toString(), "https://api.xero.com/connections/connection-1");
      assert.equal(init?.method, "DELETE");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer xero-access");
      xeroDisconnected = true;
      return new Response(null, { status: 204 });
    },
  });
  await xero.revoke_credentials(context);
  assert.equal(xeroDisconnected, true);
  assert.equal((await xeroVault.read(context.credentialRef)).secret.accessToken, "destroyed");
});

test("Xero destroys local credentials when refresh fails during disconnect", async () => {
  const vault = new MemoryVault({
    provider: "xero",
    accessToken: "expired-access",
    refreshToken: "invalid-refresh",
    tokenType: "Bearer",
    expiresAt: "2020-01-01T00:00:00.000Z",
    scopes: ["accounting.settings.read"],
    metadata: { xeroTenantId: "tenant-1", xeroConnectionId: "connection-1" },
  });
  const xero = new XeroConnector({
    clientId: "xero-client",
    oauthMode: "pkce",
    vault,
    fetcher: async () => new Response("invalid_grant", { status: 400 }),
  });

  await assert.rejects(xero.revoke_credentials(context));
  assert.equal((await vault.read(context.credentialRef)).secret.accessToken, "destroyed");
  assert.equal((await vault.read(context.credentialRef)).secret.refreshToken, undefined);
});

test("Xero and Deputy hold incremental watermarks fixed until pagination completes", async () => {
  const originalWatermark = "2026-07-01T00:00:00.000Z";
  const xeroFixture = fixture("../../connectors/xero/fixtures/sanitized-recording.json");
  const xeroFilters: string[] = [];
  const xeroPages: number[] = [];
  let xeroPageCalls = 0;
  const xero = new XeroConnector({
    clientId: "client",
    oauthMode: "pkce",
    webhookSigningKey: "key",
    vault: new MemoryVault({
      provider: "xero",
      accessToken: "access",
      refreshToken: "refresh",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["accounting.invoices.read"],
      metadata: { xeroTenantId: "xero-tenant" },
    }),
    fetcher: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/connections") {
        return Response.json([{
          id: "connection-1",
          tenantId: "xero-tenant",
          tenantType: "ORGANISATION",
          tenantName: "Demo Xero",
        }]);
      }
      xeroFilters.push(new Headers(init?.headers).get("if-modified-since") ?? "");
      xeroPages.push(Number(url.searchParams.get("page")));
      assert.equal(url.searchParams.get("pageSize"), "1000");
      xeroPageCalls += 1;
      return xeroPageCalls === 1
        ? Response.json(xeroFixture.responses.invoices)
        : Response.json({ Invoices: [] });
    },
  });
  const invoiceStream = (await xero.list_streams(context)).find((stream) => stream.id === "invoices");
  assert.ok(invoiceStream);
  const firstXeroPage = await xero.incremental_sync(
    context,
    invoiceStream,
    encodeCursor({
      v: 1,
      connector: "xero",
      stream: "invoices",
      mode: "incremental",
      watermark: originalWatermark,
    }),
  );
  const midXeroCursor = decodeCursor(firstXeroPage.nextCursor!, {
    connector: "xero",
    stream: "invoices",
  });
  assert.equal(firstXeroPage.hasMore, true);
  assert.equal(midXeroCursor.watermark, originalWatermark);
  assert.ok(midXeroCursor.observedWatermark && midXeroCursor.observedWatermark > originalWatermark);
  const finalXeroPage = await xero.incremental_sync(context, invoiceStream, firstXeroPage.nextCursor!);
  const finalXeroCursor = decodeCursor(finalXeroPage.nextCursor!, {
    connector: "xero",
    stream: "invoices",
  });
  assert.equal(finalXeroPage.hasMore, false);
  assert.equal(finalXeroCursor.watermark, midXeroCursor.observedWatermark);
  assert.deepEqual(xeroPages, [1, 2]);
  assert.equal(xeroFilters[0], xeroFilters[1]);

  const deputyQueries: Array<Record<string, unknown>> = [];
  let deputyCalls = 0;
  const deputy = new DeputyConnector({
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "https://albert.example/oauth/deputy/callback",
    now: () => Date.parse("2026-08-03T00:00:00.000Z"),
    vault: new MemoryVault({
      provider: "deputy",
      accessToken: "access",
      refreshToken: "refresh",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["longlife_refresh_token"],
      metadata: { endpoint: "demo.au.deputy.com" },
    }),
    fetcher: async (_input, init) => {
      deputyQueries.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      deputyCalls += 1;
      return Response.json(deputyCalls === 1
        ? Array.from({ length: 500 }, (_, index) => ({
            Id: index + 1,
            CompanyName: `Company ${index + 1}`,
            Active: true,
            Modified: "2026-07-31T01:00:00+10:00",
          }))
        : []);
    },
  });
  const companyStream = (await deputy.list_streams(context)).find((stream) => stream.id === "companies");
  assert.ok(companyStream);
  const firstDeputyPage = await deputy.incremental_sync(
    context,
    companyStream,
    encodeCursor({
      v: 1,
      connector: "deputy",
      stream: "companies",
      mode: "incremental",
      watermark: originalWatermark,
    }),
  );
  const midDeputyCursor = decodeCursor(firstDeputyPage.nextCursor!, {
    connector: "deputy",
    stream: "companies",
  });
  assert.equal(firstDeputyPage.hasMore, true);
  assert.equal(midDeputyCursor.watermark, originalWatermark);
  assert.ok(midDeputyCursor.observedWatermark && midDeputyCursor.observedWatermark > originalWatermark);
  const finalDeputyPage = await deputy.incremental_sync(
    context,
    companyStream,
    firstDeputyPage.nextCursor!,
  );
  const finalDeputyCursor = decodeCursor(finalDeputyPage.nextCursor!, {
    connector: "deputy",
    stream: "companies",
  });
  assert.equal(finalDeputyPage.hasMore, false);
  assert.equal(finalDeputyCursor.watermark, "2026-08-03T00:00:00.000Z");
  assert.equal(deputyQueries[0]?.start, undefined);
  assert.equal(deputyQueries[1]?.start, undefined);
  assert.deepEqual(deputyQueries[0]?.sort, { Id: "asc" });
  assert.deepEqual(deputyQueries[1]?.sort, { Id: "asc" });
  const firstDeputyFilter = deputyQueries[0]?.search as Record<string, Record<string, unknown>>;
  const secondDeputyFilter = deputyQueries[1]?.search as Record<string, Record<string, unknown>>;
  assert.equal(firstDeputyFilter.s1?.data, originalWatermark);
  assert.equal(secondDeputyFilter.s1?.data, originalWatermark);
  assert.equal(firstDeputyFilter.s2?.data, "2026-08-03T00:00:00.000Z");
  assert.equal(secondDeputyFilter.s2?.data, "2026-08-03T00:00:00.000Z");
  assert.deepEqual(secondDeputyFilter.s3, { field: "Id", data: 500, type: "gt" });
});

test("Xero treats 304 Not Modified as a successful empty incremental page", async () => {
  const watermark = "2026-07-01T00:00:00.000Z";
  const xero = new XeroConnector({
    clientId: "client",
    oauthMode: "pkce",
    webhookSigningKey: "key",
    vault: new MemoryVault({
      provider: "xero",
      accessToken: "access",
      refreshToken: "refresh",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["accounting.invoices.read"],
      metadata: { xeroTenantId: "xero-tenant" },
    }),
    fetcher: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === "/connections"
        ? Response.json([{
            id: "connection-1",
            tenantId: "xero-tenant",
            tenantType: "ORGANISATION",
            tenantName: "Demo Xero",
          }])
        : new Response(null, { status: 304 });
    },
  });
  const stream = (await xero.list_streams(context)).find((candidate) => candidate.id === "invoices");
  assert.ok(stream);
  const page = await xero.incremental_sync(context, stream, encodeCursor({
    v: 1,
    connector: "xero",
    stream: "invoices",
    mode: "incremental",
    watermark,
  }));
  assert.deepEqual(page.records, []);
  assert.equal(page.hasMore, false);
  assert.equal(decodeCursor(page.nextCursor!, { connector: "xero", stream: "invoices" }).watermark, watermark);
});
