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
import {
  LIGHTSPEED_R_DOCUMENTATION_BUILD,
  LIGHTSPEED_R_DOCUMENTED_FIELDS,
} from "../../connectors/lightspeed-r/documented-fields";
import { buildLightspeedRAuthorizationUrl } from "../../connectors/lightspeed-r/oauth-public";
import { lightspeedSchemas } from "../../connectors/lightspeed-r/schemas";
import { buildGoogleAdsAuthorizationUrl } from "../../connectors/google-ads/oauth-public";
import { GOOGLE_ADS_DEFAULT_SCOPES } from "../../connectors/google-ads/manifest";
import { buildMetaAdsAuthorizationUrl } from "../../connectors/meta-ads/oauth-public";
import { META_ADS_DEFAULT_SCOPES } from "../../connectors/meta-ads/manifest";
import { buildMomenceAuthorizationUrl } from "../../connectors/momence/oauth-public";
import { verifyShopifyCallbackHmac } from "../../connectors/shopify/index";
import { SHOPIFY_DEFAULT_SCOPES, normalizeShopifyShopDomain } from "../../connectors/shopify/manifest";
import { buildShopifyAuthorizationUrl } from "../../connectors/shopify/oauth-public";
import { buildStripeAuthorizationUrl } from "../../connectors/stripe/oauth-public";
import { STRIPE_DEFAULT_SCOPES } from "../../connectors/stripe/manifest";
import { connectorManifests } from "../../connectors/registry";
import { SquareConnector } from "../../connectors/square/index";
import { SQUARE_DEFAULT_SCOPES, squareManifest } from "../../connectors/square/manifest";
import { buildSquareAuthorizationUrl } from "../../connectors/square/oauth-public";
import { XeroConnector } from "../../connectors/xero/index";
import {
  XERO_DEFAULT_SCOPES,
  xeroManifest,
  xeroRequestedScopes,
} from "../../connectors/xero/manifest";
import {
  XERO_ACCOUNTING_OPENAPI_REVISION,
  XERO_DOCUMENTED_FIELDS,
} from "../../connectors/xero/documented-fields";
import { buildXeroAuthorizationUrl } from "../../connectors/xero/oauth-public";
import { xeroSchemas } from "../../connectors/xero/schemas";
import {
  assertFixtureFieldCoverage,
  assertConnectorManifestReconciliationPolicy,
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

test("the Xero field catalogue is pinned to an immutable official OpenAPI revision", () => {
  assert.match(XERO_ACCOUNTING_OPENAPI_REVISION, /^[a-f0-9]{40}$/u);
  assert.match(xeroManifest.apiVersion, new RegExp(XERO_ACCOUNTING_OPENAPI_REVISION));
  assert.ok(xeroManifest.documentation.some((url) => url.includes(XERO_ACCOUNTING_OPENAPI_REVISION)));
  for (const [stream, fields] of Object.entries(XERO_DOCUMENTED_FIELDS)) {
    const dispositions = xeroManifest.fieldCoverage.filter((entry) => entry.stream === stream);
    const byField = new Map(dispositions.map((entry) => [entry.field, entry]));
    assert.equal(byField.size, dispositions.length, `${stream} contains duplicate field dispositions`);
    for (const field of fields) {
      const disposition = byField.get(field);
      assert.ok(disposition, `${stream}.${field} is missing its OpenAPI field disposition`);
      if (disposition.disposition === "unsupported") {
        assert.match(disposition.reason ?? "", /pinned Xero Accounting OpenAPI/iu);
      }
    }
  }
});

test("Xero payments are settlement evidence and never fabricate POS tender facts", () => {
  const payments = xeroManifest.streams.find((stream) => stream.id === "xero_payments");
  assert.ok(payments);
  assert.deepEqual([...payments.canonicalTargets], ["event_link","metadata"]);
  assert.equal(payments.canonicalTargets.includes("commerce_payment"), false);
  const paymentFields = xeroManifest.fieldCoverage.filter((field) => field.stream === "xero_payments");
  assert.ok(paymentFields.filter((field) => field.disposition === "canonical").every((field) =>
    field.target === "event_link" || field.target?.startsWith("event_link")
  ));
  assert.equal(paymentFields.some((field) => field.target?.startsWith("commerce_payment")), false);
});

test("lookup-only PaymentType coverage names only emitted metadata evidence", () => {
  // The spec-generated ls_payment_types stream has no mapper of its own: it
  // emits only the lookup metadata observation. Its generated coverage may
  // therefore claim exactly one canonical disposition — the record id that
  // becomes the recorded source id — never a target no mapper emits.
  const fields = lightspeedRManifest.fieldCoverage.filter((field) => field.stream === "ls_payment_types");
  const canonical = fields.filter((field) => field.disposition === "canonical");
  assert.deepEqual(canonical.map((field) => [field.field, field.target]), [
    ["paymentTypeID", "metadata.source_record_id"],
  ]);
  assert.ok(fields.filter((field) => field.field !== "paymentTypeID").every((field) =>
    field.disposition !== "canonical"
  ));
});

test("every declared stream carries an executable reconciliation policy", () => {
  const manifests = [lightspeedRManifest, xeroManifest, deputyManifest] as const;
  // The spec-driven packs derive their stream sets from their table specs;
  // the count is pinned there (tables.json + streams contract tests), and this
  // suite asserts policy validity for every stream that exists.
  assert.ok(manifests.reduce((count, manifest) => count + manifest.streams.length, 0) >= 31);
  for (const manifest of manifests) {
    assert.doesNotThrow(() => assertConnectorManifestReconciliationPolicy(manifest));
    for (const stream of manifest.streams) {
      assert.ok(stream.lateEditStrategy);
      assert.ok(stream.deletionStrategy);
      assert.ok(stream.sourceTotalStrategy);
      if (stream.deletionStrategy === "immutable_append_only") {
        assert.equal(stream.lateEditStrategy, "append_only");
      }
    }
  }

  const incomplete = {
    ...xeroManifest,
    streams: [{ ...xeroManifest.streams[0], deletionStrategy: undefined }],
  } as unknown as ConnectorManifest;
  assert.throws(
    () => assertConnectorManifestReconciliationPolicy(incomplete),
    /missing a valid deletionStrategy/iu,
  );
  for(const canonicalTargets of [[],["legal_entity","legal_entity"],["finance"]]){
    const invalidTargets={
      ...xeroManifest,
      streams:[{...xeroManifest.streams[0],canonicalTargets}],
    } as unknown as ConnectorManifest;
    assert.throws(
      ()=>assertConnectorManifestReconciliationPolicy(invalidTargets),
      /unique, known canonical targets/iu,
    );
  }
});

test("reconciliation uses modification authority and unfiltered identity scans", async () => {
  const xeroFixture = fixture("../../connectors/xero/fixtures/sanitized-recording.json");
  const paymentResponse = structuredClone(
    xeroFixture.responses.payments as Record<string, unknown>,
  );
  const payment = (paymentResponse.Payments as Array<Record<string, unknown>>)[0];
  assert.ok(payment);
  payment.Date = "2020-01-01T00:00:00Z";
  payment.DateString = "2020-01-01T00:00:00Z";
  payment.UpdatedDateUTC = "/Date(1785474000000+0000)/";
  payment.UpdatedDateUTCString = "2026-07-31T01:00:00Z";

  const xeroRequests: Array<{ url: URL; headers: Headers }> = [];
  const xero = new XeroConnector({
    clientId: "client",
    oauthMode: "pkce",
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
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/connections") {
        return Response.json([{
          id: "connection-1",
          tenantId: "xero-tenant",
          tenantType: "ORGANISATION",
          tenantName: "Demo Xero",
        }]);
      }
      xeroRequests.push({ url, headers: new Headers(init?.headers) });
      return Response.json(paymentResponse);
    },
  });
  const paymentStream = (await xero.list_streams(context)).find((stream) =>
    stream.id === "xero_payments"
  );
  assert.ok(paymentStream);
  const latePage = await xero.reconciliation_sync(context, paymentStream, {
    phase: "late_edits",
    range: { from: "2026-07-30T00:00:00Z", to: "2026-08-01T00:00:00Z" },
  });
  assert.equal(latePage.records.length, 1);
  assert.equal(
    latePage.records[0]?.normalized?.timestamps?.event_date?.raw,
    "2020-01-01T00:00:00Z",
  );
  assert.equal(
    xeroRequests[0]?.headers.get("if-modified-since"),
    new Date("2026-07-30T00:00:00Z").toUTCString(),
  );
  assert.equal(
    xeroRequests[0]?.url.searchParams.get("where"),
    "UpdatedDateUTC<DateTime(2026,8,1,0,0,0)",
  );
  assert.equal(
    xeroRequests[0]?.url.searchParams.get("order"),
    "UpdatedDateUTC ASC,PaymentID ASC",
  );

  xeroRequests.length = 0;
  await xero.reconciliation_sync(context, paymentStream, {
    phase: "identity_snapshot",
    range: { from: "2026-07-30T00:00:00Z", to: "2026-08-01T00:00:00Z" },
  });
  assert.equal(xeroRequests[0]?.headers.has("if-modified-since"), false);
  assert.equal(xeroRequests[0]?.url.searchParams.has("where"), false);

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
    fetcher: async (_input, init) => {
      deputyQuery = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json([]);
    },
  });
  const rosterStream = (await deputy.list_streams(context)).find((stream) =>
    stream.id === "rosters"
  );
  assert.ok(rosterStream);
  await deputy.reconciliation_sync(context, rosterStream, {
    phase: "late_edits",
    range: { from: "2026-07-30T00:00:00Z", to: "2026-08-01T00:00:00Z" },
  });
  const lateSearch = deputyQuery?.search as Record<string, Record<string, unknown>>;
  assert.equal(lateSearch.s1?.field, "Modified");
  assert.equal(lateSearch.s2?.field, "Modified");
  assert.equal(Object.values(lateSearch).some((filter) => filter.field === "Date"), false);

  await deputy.reconciliation_sync(context, rosterStream, {
    phase: "identity_snapshot",
    range: { from: "2026-07-30T00:00:00Z", to: "2026-08-01T00:00:00Z" },
  });
  assert.equal(deputyQuery?.search, undefined);
  assert.deepEqual(deputyQuery?.sort, { Id: "asc" });
});

test("the Lightspeed R-Series field catalogue is pinned to a reviewed official documentation build", () => {
  assert.equal(LIGHTSPEED_R_DOCUMENTATION_BUILD, "2026-07-27T19:51:56Z");
  assert.match(lightspeedRManifest.apiVersion, /documentation build 2026-07-27T19:51:56Z/u);
  for (const [stream, fields] of Object.entries(LIGHTSPEED_R_DOCUMENTED_FIELDS)) {
    const dispositions = lightspeedRManifest.fieldCoverage.filter((entry) => entry.stream === stream);
    const byField = new Map(dispositions.map((entry) => [entry.field, entry]));
    assert.equal(byField.size, dispositions.length, `${stream} contains duplicate field dispositions`);
    for (const field of fields) {
      const disposition = byField.get(field);
      assert.ok(disposition, `${stream}.${field} is missing its documentation field disposition`);
      if (disposition.disposition === "unsupported") {
        assert.match(disposition.reason ?? "", /pinned Lightspeed R-Series V3 documentation build/iu);
      }
    }
  }
});

test("public OAuth builders contain only public, state-bound values", () => {
  const lightspeed = new URL(buildLightspeedRAuthorizationUrl({
    clientId: "public-ls-id",
    state: "state-ls",
    redirectUri: "https://albert.example/oauth/lightspeed-r/callback",
    codeChallenge: "challenge-ls",
  }));
  assert.equal(lightspeed.hostname, "cloud.lightspeedapp.com");
  assert.equal(lightspeed.searchParams.get("response_type"), "code");
  assert.equal(lightspeed.searchParams.get("state"), "state-ls");
  assert.equal(lightspeed.searchParams.get("code_challenge"), "challenge-ls");
  assert.equal(lightspeed.searchParams.get("code_challenge_method"), "S256");
  assert.equal(lightspeed.searchParams.get("redirect_uri"), "https://albert.example/oauth/lightspeed-r/callback");
  assert.deepEqual(lightspeed.searchParams.get("scope")?.split(" "), [
    "employee:register_read",
    "employee:inventory_read",
    "employee:customers_read",
    "employee:product_cost",
    "employee:admin_employees",
    "employee:admin_shops",
    "employee:categories",
    "employee:vendors",
    "employee:purchase_orders",
    "employee:admin_purchases",
  ]);
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

test("Lightspeed R-Series exchanges codes as multipart form with PKCE and redirect_uri", async () => {
  let exchangeBody: FormData | undefined;
  let exchangeContentType: string | null = null;
  const connector = new LightspeedRConnector({
    clientId: "lightspeed-client",
    clientSecret: "lightspeed-secret",
    vault: new MemoryVault({
      provider: "lightspeed-r",
      accessToken: "unused",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: [],
      metadata: {},
    }),
    fetcher: async (_input, init) => {
      exchangeBody = init?.body as FormData;
      exchangeContentType = new Headers(init?.headers).get("content-type");
      return Response.json({
        access_token: "access",
        refresh_token: "refresh",
        token_type: "Bearer",
        expires_in: 1_800,
      });
    },
  });

  await connector.exchange_authorization_code({
    code: "short-lived-code",
    redirectUri: "https://albert.example/api/oauth/lightspeed/callback",
    codeVerifier: "v".repeat(64),
  });

  assert.equal(exchangeContentType, null);
  assert.ok(exchangeBody instanceof FormData);
  assert.equal(exchangeBody.get("client_id"), "lightspeed-client");
  assert.equal(exchangeBody.get("client_secret"), "lightspeed-secret");
  assert.equal(exchangeBody.get("grant_type"), "authorization_code");
  assert.equal(exchangeBody.get("code"), "short-lived-code");
  assert.equal(exchangeBody.get("redirect_uri"), "https://albert.example/api/oauth/lightspeed/callback");
  assert.equal(exchangeBody.get("code_verifier"), "v".repeat(64));
});

test("opaque cursors are provider and stream scoped", () => {
  // The Lightspeed spec walk stores its continuation as opaque JSON state
  // ({after, pass}). The shape may evolve; the invariant is scoping: a cursor
  // replayed against another connector or another stream must be rejected as
  // CURSOR_INVALID, never reinterpreted.
  const continuation = JSON.stringify({ after: "vendor-after-token", pass: -1 });
  const cursor = encodeCursor({
    v: 1,
    connector: "lightspeed-r",
    stream: "ls_sales",
    mode: "incremental",
    watermark: "2026-07-31T00:00:00.000Z",
    continuation,
  });
  assert.equal(
    decodeCursor(cursor, { connector: "lightspeed-r", stream: "ls_sales" }).continuation,
    continuation,
  );
  assert.throws(
    () => decodeCursor(cursor, { connector: "lightspeed-r", stream: "ls_sale_lines" }),
    /cursor is invalid/iu,
  );
  assert.throws(
    () => decodeCursor(cursor, { connector: "xero", stream: "ls_sales" }),
    /cursor is invalid/iu,
  );
});

test("a watermarkless cursor omits sourceUpdatedAt instead of carrying undefined", () => {
  // The cursor is written verbatim as the raw batch manifest's cursorEnd, whose
  // JSON validation rejects a present key holding `undefined`. Lookup streams
  // such as categories never observe a source modification timestamp, so this
  // is their normal cursor shape, not an edge case.
  const cursor = encodeCursor({
    v: 1,
    connector: "lightspeed-r",
    stream: "ls_categories",
    mode: "reconciliation",
  });
  assert.deepEqual(Object.keys(cursor), ["value"]);
  assert.equal("sourceUpdatedAt" in cursor, false);
  assert.equal(
    decodeCursor(cursor, { connector: "lightspeed-r", stream: "ls_categories" }).watermark,
    undefined,
  );
  assert.equal(
    encodeCursor({
      v: 1,
      connector: "lightspeed-r",
      stream: "ls_sales",
      mode: "reconciliation",
      watermark: "2026-07-31T00:00:00.000Z",
    }).sourceUpdatedAt,
    "2026-07-31T00:00:00.000Z",
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
  assert.deepEqual(xeroDisposition.streams, ["xero_invoices"]);
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
    .find((item) => item.id === "finance.journals");
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
  assert.equal(
    (await lightspeed.describe_capabilities(context)).find((item) =>
      item.id === "inventory.purchase_orders")?.support,
    "unavailable",
  );

  const lightspeedWithPurchaseOrders = new LightspeedRConnector({
    clientId: "client",
    clientSecret: "secret",
    vault: new MemoryVault({
      provider: "lightspeed-r",
      accessToken: "access",
      refreshToken: "refresh",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["employee:vendors", "employee:purchase_orders"],
      metadata: {},
    }),
  });
  const purchaseOrders = (await lightspeedWithPurchaseOrders.describe_capabilities(context))
    .find((item) => item.id === "inventory.purchase_orders");
  assert.equal(purchaseOrders?.support, "full");
  assert.deepEqual(purchaseOrders?.requiredScopes, ["employee:vendors", "employee:purchase_orders"]);

  const lightspeedWithAll = new LightspeedRConnector({
    clientId: "client",
    clientSecret: "secret",
    vault: new MemoryVault({
      provider: "lightspeed-r",
      accessToken: "access",
      refreshToken: "refresh",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["employee:all"],
      metadata: {},
    }),
  });
  const allScopeCapabilities = await lightspeedWithAll.describe_capabilities(context);
  assert.equal(
    allScopeCapabilities.find((item) => item.id === "inventory.purchase_orders")?.support,
    "full",
  );
  assert.equal(
    allScopeCapabilities.find((item) => item.id === "commerce.orders.customer")?.support,
    "full",
  );
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
      // The spec walk varies its pagination, sort, window and relation
      // parameters; the sanitized recording represents one vendor page and is
      // served whatever parameters the walk sends.
      if (url.pathname.endsWith("/Sale.json")) {
        return Response.json(lightspeedFixture.responses.ls_sales, {
          headers: {
            "x-ls-api-bucket-level": "2/90",
            "x-ls-api-drip-rate": "1",
          },
        });
      }
      if (url.pathname.endsWith("/Vendor.json")) {
        return Response.json(lightspeedFixture.responses.ls_vendors);
      }
      return new Response(null, { status: 404 });
    },
  });
  const saleStream = (await lightspeed.list_streams(context)).find((stream) => stream.id === "ls_sales");
  assert.ok(saleStream);
  const salePage = await lightspeed.initial_sync(
    context,
    saleStream,
    { from: "2026-07-01T00:00:00Z", to: "2026-08-01T00:00:00Z" },
  );
  assert.equal(salePage.records.length, 1);
  // Typed projection: approved coverage fields ride normalized.fields verbatim;
  // exact money coercion is owned by typed staging downstream.
  assert.equal(salePage.records[0]?.sourceRecordId, "601");
  assert.equal(salePage.records[0]?.normalized?.fields.total, "1499.0000");
  assert.equal(salePage.records[0]?.validationIssues, undefined);
  const saleUrl = lightspeedRequests.find((url) => url.pathname.endsWith("/Sale.json"));
  // The walk pages by ascending immutable id and pushes the modified-time
  // window down to the vendor, and it requests the scan group's collapsed
  // relation union so every sale-derived stream's page is byte-identical and
  // can be served from the leader's page cache without extra HTTP.
  assert.equal(saleUrl?.searchParams.get("sort"), "saleID");
  assert.match(saleUrl?.searchParams.get("updateTime") ?? "", /^><,/u);
  const saleRelations = JSON.parse(saleUrl?.searchParams.get("load_relations") ?? "[]") as string[];
  assert.ok(saleRelations.includes("SaleLines.InventorySales"));
  assert.ok(saleRelations.includes("SalePayments.SaleAccounts"));

  const vendorStream = (await lightspeed.list_streams(context)).find((stream) => stream.id === "ls_vendors");
  assert.ok(vendorStream);
  const vendorPage = await lightspeed.initial_sync(
    context,
    vendorStream,
    { from: "2026-07-01T00:00:00Z", to: "2026-08-01T00:00:00Z" },
  );
  assert.equal(vendorPage.records.length, 1);
  assert.equal(vendorPage.records[0]?.sourceRecordId, "802");
  assert.equal(vendorPage.records[0]?.normalized?.fields.name, "Example Cycle Supply");
  assert.equal(vendorPage.records[0]?.validationIssues, undefined);
  const vendorUrl = lightspeedRequests.find((url) => url.pathname.endsWith("/Vendor.json"));
  assert.equal(vendorUrl?.searchParams.get("load_relations"), '["Contact"]');
  assert.equal(vendorUrl?.searchParams.get("sort"), "vendorID");
  assert.match(vendorUrl?.searchParams.get("timeStamp") ?? "", /^><,/u);
  // Hidden populations are separate passes rather than a widened first pass:
  // the default walk omits `archived`, and exhausting it hands back a cursor
  // whose next pass asks the vendor for the archived-only population.
  assert.equal(vendorUrl?.searchParams.has("archived"), false);
  assert.equal(vendorPage.hasMore, true);
  const archivedVendorPage = await lightspeed.initial_sync(
    context,
    vendorStream,
    { from: "2026-07-01T00:00:00Z", to: "2026-08-01T00:00:00Z" },
    vendorPage.nextCursor!,
  );
  const archivedVendorUrl = lightspeedRequests
    .filter((url) => url.pathname.endsWith("/Vendor.json"))
    .at(-1);
  assert.equal(archivedVendorUrl?.searchParams.get("archived"), "only");
  assert.equal(archivedVendorPage.hasMore, false);
  // The scan graph replaces the old lookup-table ordering: a derived stream
  // depends on the leader whose walk produces its payload.
  assert.deepEqual(
    lightspeedRManifest.streams.find((stream) => stream.id === "ls_sale_lines")?.dependencies,
    ["ls_sales"],
  );
  assert.deepEqual(
    lightspeedRManifest.streams.find((stream) => stream.id === "ls_purchase_order_lines")?.dependencies,
    ["ls_purchase_orders"],
  );

  const xeroFixture = fixture("../../connectors/xero/fixtures/sanitized-recording.json");
  const xeroRequests: URL[] = [];
  const xero = new XeroConnector({
    clientId: "client",
    oauthMode: "pkce",
    webhookSigningKey: "key",
    now: () => Date.parse("2026-08-03T00:00:00.000Z"),
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
  const invoiceStream = (await xero.list_streams(context)).find((stream) => stream.id === "xero_invoices");
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

  const paymentStream = (await xero.list_streams(context)).find((stream) => stream.id === "xero_payments");
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
  const inventoryResponse = recording.responses.ls_inventory_logs as Record<string, unknown>;
  const inventory = (inventoryResponse.InventoryLog as readonly Record<string, unknown>[])[0];
  assert.ok(inventory);
  const afterToken = "b2Zmc2V0PTEwMA";
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
            "@attributes": {
              next: `https://api.lightspeedapp.com/API/V3/Account/101/InventoryLog.json?after=${afterToken}`,
            },
            InventoryLog: [{ ...inventory, newAdditiveVendorField: "raw-only" }],
          })
        : Response.json({ "@attributes": { next: "" }, InventoryLog: [] });
    },
  });
  const stream = (await connector.list_streams(context)).find((item) => item.id === "ls_inventory_logs");
  assert.ok(stream);
  const initial = await connector.initial_sync(
    context,
    stream,
    { from: "2026-07-01T00:00:00Z", to: "2026-08-01T00:00:00Z" },
  );
  // The walk is ordered by ascending immutable id, so a record created
  // mid-walk lands at the end and can never be skipped. createTime is not a
  // sortable modified-time pushdown, so no time filter is sent: completeness
  // comes from walking the id order to exhaustion, not from a vendor filter.
  assert.equal(requests.at(-1)?.searchParams.get("sort"), "inventoryLogID");
  assert.equal(requests.at(-1)?.searchParams.has("createTime"), false);
  // The cursor carries the vendor's opaque continuation for the open walk;
  // the old numeric id checkpoint no longer exists.
  const continuation = decodeCursor(initial.nextCursor!, {
    connector: "lightspeed-r",
    stream: "ls_inventory_logs",
  }).continuation;
  assert.deepEqual(JSON.parse(String(continuation)), { after: afterToken, pass: -1 });
  assert.equal(initial.hasMore, true);
  assert.equal(initial.records[0]?.normalized?.fields.newAdditiveVendorField, undefined);
  assert.equal(initial.records[0]?.normalized?.fields.qohChange, "1.0000");
  assert.equal(initial.records[0]?.validationIssues?.[0]?.code, "schema_drift");

  await connector.incremental_sync(context, stream, initial.nextCursor!);
  // The vendor bakes sort, filter and page size into the continuation token;
  // re-sending them alongside it would silently restart the walk.
  assert.equal(requests.at(-1)?.searchParams.get("after"), afterToken);
  assert.equal(requests.at(-1)?.searchParams.has("sort"), false);
  assert.equal(requests.at(-1)?.searchParams.has("limit"), false);
  assert.equal(
    (await connector.describe_capabilities(context)).find((item) =>
      item.id === "inventory.movements")?.support,
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
        assert.equal((init?.body as URLSearchParams).get("client_id"), "client");
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

test("Xero connection discovery recovers an early-revoked access token through the durable refresh path", async () => {
  const vault = new MemoryVault({
    provider: "xero",
    accessToken: "revoked-before-expiry",
    refreshToken: "rotating-refresh-v1",
    tokenType: "Bearer",
    expiresAt: "2099-01-01T00:00:00.000Z",
    scopes: ["offline_access", "accounting.settings.read"],
    metadata: {},
  });
  const discoveryAuthorizations: string[] = [];
  let refreshCalls = 0;
  const xero = new XeroConnector({
    clientId: "client",
    oauthMode: "pkce",
    vault,
    fetcher: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === "identity.xero.com") {
        refreshCalls += 1;
        return Response.json({
          access_token: "fresh-access",
          refresh_token: "rotating-refresh-v2",
          expires_in: 1800,
          token_type: "Bearer",
          scope: "offline_access accounting.settings.read",
        });
      }
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      discoveryAuthorizations.push(authorization);
      if (authorization === "Bearer revoked-before-expiry") {
        return new Response("expired", { status: 401 });
      }
      return Response.json([{
        id: "connection-1",
        tenantId: "tenant-1",
        tenantType: "ORGANISATION",
        tenantName: "Demo Organisation",
      }]);
    },
  });

  const accounts = await xero.discover_accounts(context);
  assert.equal(accounts.length, 1);
  assert.equal(refreshCalls, 1);
  assert.deepEqual(discoveryAuthorizations, [
    "Bearer revoked-before-expiry",
    "Bearer fresh-access",
  ]);
  assert.equal((await vault.read(context.credentialRef)).secret.refreshToken, "rotating-refresh-v2");
});

test("Xero contact extraction always includes archived source records", async () => {
  const requestedUrls: URL[] = [];
  const xero = new XeroConnector({
    clientId: "client",
    oauthMode: "pkce",
    vault: new MemoryVault({
      provider: "xero",
      accessToken: "access",
      refreshToken: "refresh",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["accounting.contacts.read"],
      metadata: { xeroTenantId: "tenant-1" },
    }),
    fetcher: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestedUrls.push(url);
      if (url.pathname === "/connections") {
        return Response.json([{
          id: "connection-1",
          tenantId: "tenant-1",
          tenantType: "ORGANISATION",
          tenantName: "Demo Organisation",
        }]);
      }
      return Response.json({ Contacts: [{
        ContactID: "contact-1",
        Name: "Demo Customer",
        ContactStatus: "ARCHIVED",
        Website: "https://customer.example",
        ValidationErrors: [],
      }] });
    },
  });
  const stream = (await xero.list_streams(context)).find(({ id }) => id === "xero_contacts");
  assert.ok(stream);

  const page = await xero.initial_sync(
    context,
    stream,
    { from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" },
  );

  const contactRequest = requestedUrls.find(({ pathname }) => pathname.endsWith("/Contacts"));
  assert.equal(contactRequest?.searchParams.get("includeArchived"), "true");
  assert.equal(page.records[0]?.validationIssues, undefined);
  assert.equal(page.records[0]?.normalized?.tombstone, true);
  assert.equal(page.records[0]?.normalized?.fields.Website, undefined);
  assert.equal((page.records[0]?.payload as Record<string, unknown>).Website, "https://customer.example");
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
      assert.equal(new Headers(init?.headers).get("content-type"), null);
      const body = init?.body as FormData;
      assert.ok(body instanceof FormData);
      assert.equal(body.get("client_id"), "lightspeed-client");
      assert.equal(body.get("client_secret"), "lightspeed-secret");
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
  const xeroWheres: string[] = [];
  const xeroOrders: string[] = [];
  const xeroPages: number[] = [];
  let xeroPageCalls = 0;
  const xero = new XeroConnector({
    clientId: "client",
    oauthMode: "pkce",
    webhookSigningKey: "key",
    now: () => Date.parse("2026-08-03T00:00:00.000Z"),
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
      xeroWheres.push(url.searchParams.get("where") ?? "");
      xeroOrders.push(url.searchParams.get("order") ?? "");
      xeroPages.push(Number(url.searchParams.get("page")));
      assert.equal(url.searchParams.get("pageSize"), "1000");
      xeroPageCalls += 1;
      return xeroPageCalls === 1 || xeroPageCalls === 3
        ? Response.json(xeroFixture.responses.invoices)
        : Response.json({ Invoices: [] });
    },
  });
  const invoiceStream = (await xero.list_streams(context)).find((stream) => stream.id === "xero_invoices");
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
  const verificationRestart = await xero.incremental_sync(
    context,invoiceStream,firstXeroPage.nextCursor!,
  );
  const restartCursor=decodeCursor(verificationRestart.nextCursor!,{
    connector:"xero",stream:"xero_invoices",
  });
  assert.equal(verificationRestart.hasMore,true);
  assert.equal(restartCursor.continuation,undefined);
  assert.match(restartCursor.verificationDigest ?? "",/^[0-9a-f]{64}$/u);
  const verificationPage = await xero.incremental_sync(
    context,invoiceStream,verificationRestart.nextCursor!,
  );
  const finalXeroPage = await xero.incremental_sync(
    context,invoiceStream,verificationPage.nextCursor!,
  );
  const finalXeroCursor = decodeCursor(finalXeroPage.nextCursor!, {
    connector: "xero",
    stream: "invoices",
  });
  assert.equal(finalXeroPage.hasMore, false);
  assert.equal(finalXeroCursor.watermark,"2026-08-03T00:00:00.000Z");
  assert.deepEqual(xeroPages,[1,2,1,2]);
  assert.equal(new Set(xeroFilters).size,1);
  assert.deepEqual(new Set(xeroWheres),new Set([
    "UpdatedDateUTC<DateTime(2026,8,3,0,0,0)",
  ]));
  assert.deepEqual(new Set(xeroOrders),new Set([
    "UpdatedDateUTC ASC,InvoiceID ASC",
  ]));

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

test("Xero page scans require two identical bounded passes before advancing", async () => {
  const fixtureData=fixture("../../connectors/xero/fixtures/sanitized-recording.json");
  const base=structuredClone(
    (fixtureData.responses.invoices as {Invoices:Array<Record<string,unknown>>}).Invoices[0]!,
  );
  const invoice=(id:string,updated:string) => ({
    ...structuredClone(base),InvoiceID:id,
    UpdatedDateUTC:`/Date(${Date.parse(updated)}+0000)/`,
    UpdatedDateUTCString:updated,
  });
  const firstPass=[
    invoice("10000000-0000-4000-8000-000000000001","2026-07-02T00:00:00.000Z"),
    invoice("10000000-0000-4000-8000-000000000002","2026-07-03T00:00:00.000Z"),
  ];
  const changedPass=[
    firstPass[0]!,
    invoice("10000000-0000-4000-8000-000000000003","2026-07-04T00:00:00.000Z"),
  ];
  let dataCall=0;
  const calls=[firstPass,[],changedPass,[],changedPass,[]] as const;
  const xero=new XeroConnector({
    clientId:"client",oauthMode:"pkce",
    now:()=>Date.parse("2026-08-03T00:00:00.000Z"),
    vault:new MemoryVault({
      provider:"xero",accessToken:"access",refreshToken:"refresh",
      tokenType:"Bearer",expiresAt:"2099-01-01T00:00:00.000Z",
      scopes:["accounting.invoices.read"],metadata:{xeroTenantId:"xero-tenant"},
    }),
    fetcher:async(input)=>{
      const url=new URL(input instanceof Request?input.url:input.toString());
      if(url.pathname==="/connections")return Response.json([{
        id:"connection-1",tenantId:"xero-tenant",tenantType:"ORGANISATION",tenantName:"Demo Xero",
      }]);
      assert.equal(url.searchParams.get("order"),"UpdatedDateUTC ASC,InvoiceID ASC");
      assert.equal(url.searchParams.get("where"),"UpdatedDateUTC<DateTime(2026,8,3,0,0,0)");
      const response=calls[dataCall++];
      assert.ok(response,"unexpected extra Xero verification pass");
      return Response.json({Invoices:response});
    },
  });
  const stream=(await xero.list_streams(context)).find((candidate)=>candidate.id==="xero_invoices");
  assert.ok(stream);
  let cursor=encodeCursor({
    v:1,connector:"xero",stream:"xero_invoices",mode:"incremental",
    watermark:"2026-07-01T00:00:00.000Z",
  });
  let page:Awaited<ReturnType<typeof xero.incremental_sync>>;
  do{
    page=await xero.incremental_sync(context,stream,cursor);
    assert.ok(page.nextCursor);
    cursor=page.nextCursor;
  }while(page.hasMore);

  assert.equal(dataCall,6,"a changed verification pass must be scanned again");
  assert.equal(
    decodeCursor(cursor,{connector:"xero",stream:"xero_invoices"}).watermark,
    "2026-08-03T00:00:00.000Z",
  );
});

test("malformed vendor pagination identities quarantine without creating a looping cursor", async () => {
  const xero = new XeroConnector({
    clientId: "client",
    oauthMode: "pkce",
    vault: new MemoryVault({
      provider: "xero",
      accessToken: "access",
      refreshToken: "refresh",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["accounting.journals.read"],
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
        : Response.json({
            Journals: [{
              JournalID: "00000000-0000-4000-8000-000000000099",
              JournalLines: [],
            }],
          });
    },
  });
  const journalStream = (await xero.list_streams(context)).find(({ id }) => id === "xero_journals");
  assert.ok(journalStream);
  const journalPage = await xero.initial_sync(
    context,
    journalStream,
    { from: "1970-01-01T00:00:00.000Z", to: "2026-08-03T00:00:00.000Z" },
  );
  assert.equal(journalPage.hasMore, true);
  assert.equal(journalPage.nextCursor, null);
  assert.equal(journalPage.paginationBlock?.code, "pagination_identity_invalid");
  assert.equal(journalPage.records[0]?.validationIssues?.[0]?.code, "schema_invalid");

  const deputyQueries: Array<Record<string, unknown>> = [];
  let deputyCall = 0;
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
      deputyCall += 1;
      return Response.json(deputyCall === 1
        ? [
            ...Array.from({ length: 499 }, (_, index) => ({
              Id: index + 1,
              CompanyName: `Company ${index + 1}`,
              Active: true,
            })),
            { CompanyName: "Missing source identity", Active: true },
          ]
        : Array.from({ length: 500 }, () => ({
            CompanyName: "Still missing source identity",
            Active: true,
          })));
    },
  });
  const companyStream = (await deputy.list_streams(context)).find(({ id }) => id === "companies");
  assert.ok(companyStream);
  const firstDeputyPage = await deputy.incremental_sync(
    context,
    companyStream,
    encodeCursor({
      v: 1,
      connector: "deputy",
      stream: "companies",
      mode: "incremental",
      watermark: "2026-07-01T00:00:00.000Z",
    }),
  );
  assert.equal(firstDeputyPage.hasMore, true);
  assert.equal(
    decodeCursor(firstDeputyPage.nextCursor!, { connector: "deputy", stream: "companies" }).continuation,
    499,
  );
  assert.match(firstDeputyPage.records.at(-1)?.sourceRecordId ?? "", /^invalid:/u);

  const blockedDeputyPage = await deputy.incremental_sync(
    context,
    companyStream,
    firstDeputyPage.nextCursor!,
  );
  assert.equal(blockedDeputyPage.hasMore, true);
  assert.equal(blockedDeputyPage.nextCursor, null);
  assert.equal(blockedDeputyPage.paginationBlock?.code, "pagination_identity_invalid");
  assert.deepEqual(
    (deputyQueries[1]?.search as Record<string, Record<string, unknown>>).s3,
    { field: "Id", data: 499, type: "gt" },
  );
});

test("Xero treats 304 Not Modified as a successful empty incremental page", async () => {
  const watermark = "2026-07-01T00:00:00.000Z";
  const xero = new XeroConnector({
    clientId: "client",
    oauthMode: "pkce",
    webhookSigningKey: "key",
    now: () => Date.parse("2026-08-03T00:00:00.000Z"),
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
  const stream = (await xero.list_streams(context)).find((candidate) => candidate.id === "xero_invoices");
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
  assert.equal(
    decodeCursor(page.nextCursor!,{connector:"xero",stream:"xero_invoices"}).watermark,
    "2026-08-03T00:00:00.000Z",
  );
});

test("Square authorizes read-only over the confidential code flow and stays authorization-only", async () => {
  const square = new URL(buildSquareAuthorizationUrl({
    clientId: "public-square-id",
    state: "state-square",
    redirectUri: "https://albert.example/api/oauth/square/callback",
  }));
  assert.equal(square.hostname, "connect.squareup.com");
  assert.equal(square.pathname, "/oauth2/authorize");
  assert.equal(square.searchParams.get("client_id"), "public-square-id");
  assert.equal(square.searchParams.get("state"), "state-square");
  assert.equal(
    square.searchParams.get("redirect_uri"),
    "https://albert.example/api/oauth/square/callback",
  );
  // `session=false` stops Square silently reusing whichever seller session the
  // browser already holds, which would connect the wrong merchant.
  assert.equal(square.searchParams.get("session"), "false");
  // Confidential code flow: PKCE parameters must never appear on the redirect.
  assert.equal(square.searchParams.has("code_challenge"), false);
  assert.equal(square.searchParams.has("code_challenge_method"), false);
  assert.equal(square.toString().includes("secret"), false);

  // Square scopes are space separated, and every one of them is a read grant.
  const scopeParameter = square.searchParams.get("scope") ?? "";
  const requested = scopeParameter.split(" ");
  assert.equal(requested.length > 0, true);
  assert.deepEqual([...requested], [...SQUARE_DEFAULT_SCOPES]);
  for (const scope of requested) {
    assert.equal(/_READ$/u.test(scope), true, `${scope} is not a read permission`);
  }
  // A management capability is not a read grant and must never be requested.
  assert.equal(scopeParameter.includes("DEVICE_CREDENTIAL_MANAGEMENT"), false);

  // A write permission must be refused rather than silently forwarded.
  assert.throws(() => buildSquareAuthorizationUrl({
    clientId: "public-square-id",
    state: "state-square",
    redirectUri: "https://albert.example/api/oauth/square/callback",
    scopes: ["ORDERS_WRITE"],
  }), /Invalid Square authorization parameters/u);

  // Authorization-only: no stream, no capability, and no claimed authority.
  assert.deepEqual([...squareManifest.streams], []);
  assert.deepEqual(squareManifest.capabilities, {});
  assert.deepEqual([...squareManifest.sourceAuthority.defaults], []);

  const connector = new SquareConnector({
    clientId: "square-client",
    clientSecret: "square-secret",
    redirectUri: "https://albert.example/api/oauth/square/callback",
    vault: new MemoryVault({
      provider: "square",
      accessToken: "unused",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: [...SQUARE_DEFAULT_SCOPES],
      metadata: { merchantId: "MERCHANT" },
    }),
  });
  const context = { tenantId: "t", connectionId: "c", credentialRef: "ref" };
  assert.deepEqual(await connector.list_streams(context), []);
  assert.deepEqual(await connector.describe_capabilities(context), []);
  // A sync routed to Square is a defect, so it must fail closed rather than
  // return an empty page that would read as "synced, nothing found".
  await assert.rejects(
    () => connector.initial_sync(
      context,
      { id: "orders" } as never,
      { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" },
    ),
    /declares no stream/u,
  );
  const webhook = await connector.handle_webhook(context, { body: "{}" } as never);
  assert.equal(webhook.accepted, false);
});

test("authorization-only packs declare no stream, capability or source authority", () => {
  const authorizationOnly = ["square", "shopify", "stripe", "momence", "meta-ads", "google-ads"];
  for (const id of authorizationOnly) {
    const manifest = connectorManifests.find((candidate) => candidate.id === id);
    assert.ok(manifest, `${id} is not registered`);
    assert.deepEqual([...manifest.streams], [], `${id} declares a stream`);
    assert.deepEqual(manifest.capabilities, {}, `${id} declares a capability`);
    assert.deepEqual([...manifest.sourceAuthority.defaults], [], `${id} claims source authority`);
    assert.deepEqual([...manifest.fieldCoverage], [], `${id} declares field coverage`);
  }
});

test("Shopify binds authorization to a validated shop and verifies the callback HMAC", () => {
  assert.equal(normalizeShopifyShopDomain("My-Store"), "my-store.myshopify.com");
  assert.equal(normalizeShopifyShopDomain("https://My-Store.myshopify.com/"), "my-store.myshopify.com");
  // A custom domain does not host the OAuth endpoint, and an attacker-chosen
  // host is exactly what this rejects.
  for (const bad of ["evil.com", "shop.example.com", "my-store.myshopify.com.evil.com", ""]) {
    assert.throws(() => normalizeShopifyShopDomain(bad), /myshopify\.com/u, `accepted ${bad}`);
  }

  const url = new URL(buildShopifyAuthorizationUrl({
    clientId: "shopify-id",
    state: "state-shopify",
    redirectUri: "https://albert.example/api/oauth/shopify/callback",
    shopDomain: "my-store",
  }));
  assert.equal(url.hostname, "my-store.myshopify.com");
  assert.equal(url.pathname, "/admin/oauth/authorize");
  // Shopify separates scopes with commas, and every one must be read-only.
  const scopes = (url.searchParams.get("scope") ?? "").split(",");
  assert.deepEqual(scopes, [...SHOPIFY_DEFAULT_SCOPES]);
  for (const scope of scopes) assert.equal(scope.startsWith("read_"), true, `${scope} is not read-only`);
  assert.equal(url.toString().includes("secret"), false);

  const secret = "shopify-app-secret";
  const signed = new URLSearchParams({ code: "abc", shop: "my-store.myshopify.com", state: "state-shopify" });
  const digest = createHmac("sha256", secret)
    .update([...signed.entries()].map(([k, v]) => `${k}=${v}`).sort().join("&"), "utf8")
    .digest("hex");
  signed.set("hmac", digest);
  assert.equal(verifyShopifyCallbackHmac(signed, secret), true);
  // Any tampering, and any wrong secret, must fail closed.
  const tampered = new URLSearchParams(signed);
  tampered.set("shop", "attacker.myshopify.com");
  assert.equal(verifyShopifyCallbackHmac(tampered, secret), false);
  assert.equal(verifyShopifyCallbackHmac(signed, "wrong-secret"), false);
  assert.equal(verifyShopifyCallbackHmac(new URLSearchParams({ code: "abc" }), secret), false);
});

test("Stripe, Momence, Meta Ads and Google Ads build correct authorization redirects", () => {
  const stripe = new URL(buildStripeAuthorizationUrl({
    clientId: "ca_stripe", state: "s", redirectUri: "https://albert.example/api/oauth/stripe/callback",
  }));
  assert.equal(stripe.hostname, "connect.stripe.com");
  assert.equal(stripe.searchParams.get("response_type"), "code");
  // Stripe's scope parameter is single valued.
  assert.equal(stripe.searchParams.get("scope"), STRIPE_DEFAULT_SCOPES[0]);
  assert.throws(() => buildStripeAuthorizationUrl({
    clientId: "ca_stripe", state: "s", redirectUri: "https://albert.example/api/oauth/stripe/callback",
    scopes: ["read_only", "read_write"],
  }), /Invalid Stripe authorization parameters/u);

  const momence = new URL(buildMomenceAuthorizationUrl({
    clientId: "m", state: "s", redirectUri: "https://albert.example/api/oauth/momence/callback",
  }));
  assert.equal(momence.hostname, "api.momence.com");
  assert.equal(momence.searchParams.get("scope"), "public-api-v2");
  assert.equal(momence.searchParams.get("prompt"), "login");

  const meta = new URL(buildMetaAdsAuthorizationUrl({
    clientId: "m", state: "s", redirectUri: "https://albert.example/api/oauth/meta-ads/callback",
  }));
  assert.equal(meta.hostname, "www.facebook.com");
  // Meta separates permissions with commas, and ads_management is never asked for.
  const metaScopeParameter = meta.searchParams.get("scope") ?? "";
  assert.deepEqual([...metaScopeParameter.split(",")], [...META_ADS_DEFAULT_SCOPES]);
  assert.equal(metaScopeParameter.includes("ads_management"), false);

  const google = new URL(buildGoogleAdsAuthorizationUrl({
    clientId: "g", state: "s", redirectUri: "https://albert.example/api/oauth/google-ads/callback",
  }));
  assert.equal(google.hostname, "accounts.google.com");
  assert.deepEqual((google.searchParams.get("scope") ?? "").split(" "), [...GOOGLE_ADS_DEFAULT_SCOPES]);
  // Both are required or Google silently omits the refresh token, leaving a
  // connection that cannot be renewed unattended.
  assert.equal(google.searchParams.get("access_type"), "offline");
  assert.equal(google.searchParams.get("prompt"), "consent");
});
