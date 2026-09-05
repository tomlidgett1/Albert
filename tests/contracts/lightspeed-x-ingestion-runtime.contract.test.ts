import assert from "node:assert/strict";
import test from "node:test";

import { LightspeedXConnector } from "../../connectors/lightspeed-x/index.js";
import {
  buildLightspeedXFieldIndex,
  parseLightspeedXJsonLossless,
} from "../../connectors/lightspeed-x/field-index.js";
import { LIGHTSPEED_X_DEFAULT_SCOPES } from "../../connectors/lightspeed-x/manifest.js";
import {
  advanceLightspeedXPage,
  decodeLightspeedXCursor,
  type LightspeedXPagination,
} from "../../connectors/lightspeed-x/pagination.js";
import {
  type ConnectorContext,
  type ConnectorStream,
  type CredentialRefreshLeaseContext,
  type FetchLike,
  type HttpRetryOptions,
  type OAuthCredentialSecret,
  type VendorRateBudget,
  type VersionedCredential,
  type WorkerCredentialVault,
  parseRetryAfter,
} from "../../packages/connector-sdk/src/index.js";
import {
  ProductionConnectorFactory,
  type OAuthConnectorConfig,
} from "../../services/sync-workers/src/connector-factory.js";

const RANGE = Object.freeze({
  from: "2026-07-01T00:00:00.000Z",
  to: "2026-08-01T00:00:00.000Z",
});
const CONTEXT: ConnectorContext = Object.freeze({
  tenantId: "tenant-lightspeed-x",
  connectionId: "connection-lightspeed-x",
  credentialRef: "credential:lightspeed-x",
});

class MemoryVault implements WorkerCredentialVault {
  private revision = 1;
  readonly createCalls: OAuthCredentialSecret[] = [];
  readonly compareAndSwapCalls: Array<Readonly<{
    expectedRevision: string;
    secret: OAuthCredentialSecret;
    proof: unknown;
  }>> = [];
  destroyed = false;

  constructor(private secret: OAuthCredentialSecret) {}

  async create(secret: OAuthCredentialSecret): Promise<VersionedCredential> {
    this.createCalls.push(secret);
    this.secret = secret;
    return this.read(CONTEXT.credentialRef);
  }

  async read(credentialRef: string): Promise<VersionedCredential> {
    return { credentialRef, revision: String(this.revision), secret: this.secret };
  }

  async compareAndSwap(
    credentialRef: string,
    expectedRevision: string,
    secret: OAuthCredentialSecret,
    proof?: unknown,
  ): Promise<VersionedCredential> {
    assert.equal(expectedRevision, String(this.revision));
    this.compareAndSwapCalls.push({ expectedRevision, secret, proof });
    this.secret = secret;
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
      proof: { leaseId: "01J00000000000000000000000", fencingToken: "7" },
    });
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

function validSecret(overrides: Partial<OAuthCredentialSecret> = {}): OAuthCredentialSecret {
  return {
    provider: "lightspeed-x",
    accessToken: "x-access-token",
    refreshToken: "x-refresh-token",
    tokenType: "Bearer",
    expiresAt: "2099-01-01T00:00:00.000Z",
    scopes: LIGHTSPEED_X_DEFAULT_SCOPES,
    metadata: { domainPrefix: "albert-demo" },
    ...overrides,
  };
}

function connector(
  fetcher: FetchLike,
  options: Readonly<{
    secret?: OAuthCredentialSecret;
    vault?: MemoryVault;
    retry?: HttpRetryOptions;
  }> = {},
): Readonly<{ pack: LightspeedXConnector; vault: MemoryVault }> {
  const vault = options.vault ?? new MemoryVault(options.secret ?? validSecret());
  return {
    vault,
    pack: new LightspeedXConnector({
      clientId: "x-client-id",
      clientSecret: "x-client-secret",
      redirectUri: "https://albert.example/api/oauth/lightspeed-x/callback",
      vault,
      fetcher,
      now: () => Date.parse("2026-08-12T00:00:00.000Z"),
      retry: options.retry ?? { random: () => 0, sleep: async () => undefined },
    }),
  };
}

async function runtimeStream(pack: LightspeedXConnector, id: string): Promise<ConnectorStream> {
  const stream = (await pack.list_streams(CONTEXT)).find((candidate) => candidate.id === id);
  assert.ok(stream, `Expected ${id} under the complete read-only grant.`);
  return stream;
}

function urlOf(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

function assertApiRequest(input: string | URL | Request, init: RequestInit | undefined): URL {
  const url = urlOf(input);
  assert.equal(url.hostname, "albert-demo.retail.lightspeed.app");
  assert.equal(new Headers(init?.headers).get("authorization"), "Bearer x-access-token");
  assert.equal(new Headers(init?.headers).get("accept"), "application/json");
  return url;
}

test("Lightspeed X-Series authorization is read-only, host-bound, and form-encoded", async () => {
  let tokenRequest: Readonly<{ url: URL; body: URLSearchParams }> | undefined;
  const { pack, vault } = connector(async (input, init) => {
    const url = urlOf(input);
    tokenRequest = { url, body: new URLSearchParams(String(init?.body)) };
    return new Response(JSON.stringify({
      access_token: "issued-access",
      token_type: "Bearer",
      expires: 1_800_000_000,
      expires_in: 86_400,
      refresh_token: "issued-refresh",
      domain_prefix: "albert-demo",
      scope: LIGHTSPEED_X_DEFAULT_SCOPES.join(" "),
    }), { headers: { "content-type": "application/json" } });
  });

  const redirect = await pack.authorize({
    redirectUri: "https://albert.example/api/oauth/lightspeed-x/callback",
    state: "opaque-state-with-entropy",
    scopes: [],
  });
  const authorizeUrl = new URL(redirect.url);
  assert.equal(authorizeUrl.origin, "https://secure.retail.lightspeed.app");
  assert.equal(authorizeUrl.pathname, "/connect");
  assert.equal(authorizeUrl.searchParams.get("state"), "opaque-state-with-entropy");
  const scopes = authorizeUrl.searchParams.get("scope")!.split(" ");
  assert.deepEqual(scopes, [...LIGHTSPEED_X_DEFAULT_SCOPES].sort());
  assert.equal(scopes.some((scope) => scope.endsWith(":write") || String(scope) === "webhooks"), false);

  const exchange = await pack.exchange_authorization_code({
    code: "single-use-code",
    domainPrefix: "ALBERT-DEMO",
    returnedScope: LIGHTSPEED_X_DEFAULT_SCOPES.join(" "),
    redirectUri: "https://albert.example/api/oauth/lightspeed-x/callback",
  });
  assert.equal(exchange.expiresAt, "2027-01-15T08:00:00.000Z");
  assert.equal(tokenRequest?.url.toString(), "https://albert-demo.retail.lightspeed.app/api/1.0/token");
  assert.equal(tokenRequest?.body.get("grant_type"), "authorization_code");
  assert.equal(tokenRequest?.body.get("code"), "single-use-code");
  assert.equal(tokenRequest?.body.get("client_secret"), "x-client-secret");
  assert.equal(tokenRequest?.url.search, "");
  assert.equal(vault.createCalls[0]?.metadata.domainPrefix, "albert-demo");
  assert.equal(vault.createCalls[0]?.refreshToken, "issued-refresh");

  await assert.rejects(
    pack.exchange_authorization_code({
      code: "code",
      domainPrefix: "evil.example.com/path",
      redirectUri: "https://albert.example/api/oauth/lightspeed-x/callback",
    }),
    /domain_prefix is invalid/u,
  );

  const { pack: overScoped } = connector(async () => new Response(JSON.stringify({
    access_token: "issued-access",
    token_type: "Bearer",
    expires: 1_800_000_000,
    refresh_token: "issued-refresh",
    domain_prefix: "albert-demo",
    scope: `${LIGHTSPEED_X_DEFAULT_SCOPES.join(" ")} inventory:write`,
  })));
  await assert.rejects(
    overScoped.exchange_authorization_code({
      code: "code",
      domainPrefix: "albert-demo",
      redirectUri: "https://albert.example/api/oauth/lightspeed-x/callback",
    }),
    /outside Albert's read-only grant: inventory:write/u,
  );
});

test("rotating refresh tokens publish once behind the refresh lease and CAS fence", async () => {
  let tokenRequests = 0;
  const vault = new MemoryVault(validSecret({ expiresAt: "2020-01-01T00:00:00.000Z" }));
  const { pack } = connector(async (input, init) => {
    const url = urlOf(input);
    assert.equal(url.toString(), "https://albert-demo.retail.lightspeed.app/api/1.0/token");
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "x-refresh-token");
    tokenRequests += 1;
    return new Response(JSON.stringify({
      access_token: "rotated-access",
      token_type: "Bearer",
      expires: 1_900_000_000,
      expires_in: 604_800,
      refresh_token: "rotated-refresh",
      domain_prefix: "albert-demo",
      scope: LIGHTSPEED_X_DEFAULT_SCOPES.join(" "),
    }));
  }, { vault });

  await Promise.all([pack.refresh_credentials(CONTEXT), pack.refresh_credentials(CONTEXT)]);
  assert.equal(tokenRequests, 1);
  assert.equal(vault.compareAndSwapCalls.length, 1);
  assert.equal(vault.compareAndSwapCalls[0]?.secret.refreshToken, "rotated-refresh");
  assert.deepEqual(vault.compareAndSwapCalls[0]?.proof, {
    leaseId: "01J00000000000000000000000",
    fencingToken: "7",
  });
});

test("production factory constructs the executable X-Series pack with read-only scopes", () => {
  const factory = new ProductionConnectorFactory({
    lightspeedXClientId: "x-client-id",
    lightspeedXClientSecret: "x-client-secret",
    lightspeedXRedirectUri: "https://albert.example/api/oauth/lightspeed-x/callback",
  } as OAuthConnectorConfig);
  const vault = new MemoryVault(validSecret());

  assert.equal(factory.isConfigured("lightspeed-x"), true);
  assert.equal(factory.create("lightspeed-x", vault).id, "lightspeed-x");
  assert.deepEqual(factory.scopes("lightspeed-x"), LIGHTSPEED_X_DEFAULT_SCOPES);
});

test("account discovery exhausts version pages and publishes the unique register count", async () => {
  const requests: string[] = [];
  const { pack } = connector(async (input, init) => {
    const url = assertApiRequest(input, init);
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/2026-07/retailer") {
      return new Response(JSON.stringify({
        data: {
          id: "retailer-1",
          name: "Albert Test Store",
          domain_prefix: "albert-demo",
          currency: { code: "AUD" },
          timezone: "Australia/Melbourne",
          country: "AU",
        },
      }));
    }
    assert.equal(url.pathname, "/api/2026-07/registers");
    if (!url.searchParams.has("after")) {
      return new Response('{"data":[{"id":"register-1","version":9},{"id":"register-2","version":10}],"version":{"min":9,"max":10}}');
    }
    assert.equal(url.searchParams.get("after"), "10");
    return new Response('{"data":[],"version":{"min":null,"max":null}}');
  });

  const account = await pack.discover_account(CONTEXT);
  assert.equal(account.externalAccountId, "retailer-1");
  assert.equal(account.baseUrl, "https://albert-demo.retail.lightspeed.app/api/2026-07");
  assert.deepEqual(account.metadata, {
    retailerId: "retailer-1",
    domainPrefix: "albert-demo",
    registerCount: 2,
    currency: "AUD",
    timezone: "Australia/Melbourne",
    country: "AU",
  });
  assert.deepEqual(pack.rate_limit_options(account.metadata), {
    retailerWindowLimit: 650,
  });
  assert.deepEqual(pack.rate_limit_options({ registerCount: 0 }), {});
  assert.deepEqual(pack.rate_limit_options({ registerCount: 101 }), {});
  assert.deepEqual(pack.rate_limit_options({ registerCount: "2" }), {});
  assert.deepEqual(requests, [
    "/api/2026-07/retailer",
    "/api/2026-07/registers?deleted=true&page_size=1000",
    "/api/2026-07/registers?deleted=true&after=10&page_size=1000",
  ]);
});

test("version paging preserves int64 and decimal wire values and observes every rate response", async () => {
  const requests: URL[] = [];
  let responses = 0;
  const budget: VendorRateBudget & { before: number; observed: number } = {
    before: 0,
    observed: 0,
    async beforeRequest() { this.before += 1; },
    async observeResponse(response) {
      this.observed += 1;
      assert.equal(response.headers.get("x-ratelimit-limit"), "350");
    },
  };
  const { pack } = connector(async (input, init) => {
    const url = assertApiRequest(input, init);
    requests.push(url);
    responses += 1;
    if (responses === 1) {
      return new Response(
        '{"data":[{"id":"sale-1","version":9223372036854775806,"total":12.340000000,"updated_at":"2026-07-02T03:04:05Z"}],"version":{"min":9223372036854775806,"max":9223372036854775807}}',
        { headers: { "x-ratelimit-limit": "350", "x-ratelimit-remaining": "349" } },
      );
    }
    return new Response('{"data":[],"version":{"min":null,"max":null}}', {
      headers: { "x-ratelimit-limit": "350", "x-ratelimit-remaining": "348" },
    });
  });
  const stream = await runtimeStream(pack, "lx_sales");
  const context = { ...CONTEXT, vendorRateBudget: budget };

  const first = await pack.initial_sync(context, stream, RANGE);
  assert.equal(first.hasMore, true);
  assert.equal(decodeLightspeedXCursor(first.nextCursor?.value).position, "9223372036854775807");
  const raw = first.records[0]?.payload as Record<string, unknown>;
  assert.equal(raw.version, "9223372036854775806");
  assert.equal(raw.total, "12.340000000");
  const index = first.records[0]?.normalized?.fields.field_index as readonly Record<string, unknown>[];
  assert.equal(index.find((field) => field.path === "$.version")?.numericValue, "9223372036854775806");
  assert.equal(index.find((field) => field.path === "$.total")?.numericValue, "12.340000000");

  const terminal = await pack.initial_sync(context, stream, RANGE, first.nextCursor!);
  assert.equal(terminal.hasMore, false);
  assert.equal(terminal.nextCursor, null);
  assert.equal(terminal.coverage?.verification, "exhaustive_vendor_scan");
  assert.deepEqual(requests.map((url) => url.searchParams.get("after")), [null, "9223372036854775807"]);
  assert.equal(budget.before, 2);
  assert.equal(budget.observed, 2);
});

test("429 responses consume durable budget and honour vendor Retry-After", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const observed: number[] = [];
  const budget: VendorRateBudget = {
    async beforeRequest() { attempts += 1; },
    async observeResponse(response) { observed.push(response.status); },
  };
  const { pack } = connector(async (input, init) => {
    const url = assertApiRequest(input, init);
    assert.equal(url.pathname, "/api/2026-07/retailer");
    if (attempts === 1) {
      return new Response("rate limited", {
        status: 429,
        headers: {
          "retry-after": "2",
          "x-ratelimit-limit": "350",
          "x-ratelimit-remaining": "0",
        },
      });
    }
    return new Response('{"data":{"id":"retailer-1"}}');
  }, {
    retry: { maxAttempts: 2, sleep: async (milliseconds) => { sleeps.push(milliseconds); } },
  });
  const context = { ...CONTEXT, vendorRateBudget: budget };
  const page = await pack.initial_sync(context, await runtimeStream(pack, "lx_retailer"), RANGE);

  assert.equal(page.hasMore, false);
  assert.equal(attempts, 2);
  assert.deepEqual(observed, [429, 200]);
  assert.deepEqual(sleeps, [2_000]);
  assert.equal(
    parseRetryAfter("Wed, 12 Aug 2026 00:00:05 GMT", Date.parse("2026-08-12T00:00:00Z")),
    5_000,
  );
});

test("lossless JSON indexing retains exponent notation and rejects malformed numbers", () => {
  const parsed = parseLightspeedXJsonLossless(
    '{"positive":1e3,"negative":-2.50E-4,"integer":9223372036854775807}',
  ) as Record<string, unknown>;
  assert.deepEqual(parsed, {
    positive: "1e3",
    negative: "-2.50E-4",
    integer: "9223372036854775807",
  });
  const index = buildLightspeedXFieldIndex(parsed);
  assert.equal(index.find((field) => field.path === "$.positive")?.numericValue, "1e3");
  assert.equal(index.find((field) => field.path === "$.negative")?.numericValue, "-2.50E-4");
  assert.equal(index.find((field) => field.path === "$.integer")?.numericValue, "9223372036854775807");

  for (const malformed of [
    '{"value":01}',
    '{"value":1.}',
    '{"value":1e}',
    '{"value":1e+}',
    '{"value":+1}',
    '{"value":--1}',
  ]) {
    assert.throws(() => parseLightspeedXJsonLossless(malformed), SyntaxError, malformed);
  }
});

test("read-only POST inventory uses a body cursor and derives version from its bare-array response", async () => {
  let observedBody: Record<string, unknown> | undefined;
  const { pack } = connector(async (input, init) => {
    const url = assertApiRequest(input, init);
    assert.equal(url.pathname, "/api/2026-07/inventory");
    assert.equal(init?.method, "POST");
    observedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response('[{"id":"inventory-1","product_id":"product-1","outlet_id":"outlet-1","version":9223372036854775807,"current_inventory_level":3.5000}]');
  });
  const page = await pack.initial_sync(CONTEXT, await runtimeStream(pack, "lx_inventory"), RANGE);
  assert.equal(page.hasMore, true);
  assert.equal(decodeLightspeedXCursor(page.nextCursor?.value).position, "9223372036854775807");
  assert.deepEqual(observedBody, {
    include_deleted: true,
    sort_direction: "asc",
    size: "5000",
  });
  assert.equal(page.records[0]?.normalized?.fields.payload_json instanceof Object, true);
});

test("parent fan-out checkpoints the parent page and exposes synthetic lineage only in staging", async () => {
  const paths: string[] = [];
  const { pack } = connector(async (input, init) => {
    const url = assertApiRequest(input, init);
    paths.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/2026-07/customers") {
      return new Response('{"data":[{"id":"customer/1","version":5}],"version":{"min":5,"max":5}}');
    }
    assert.equal(url.pathname, "/api/2026-07/customers/customer%2F1/addresses");
    return new Response('{"data":[{"id":9007199254740993,"city":"Melbourne"}]}');
  });
  const stream = await runtimeStream(pack, "lx_customer_addresses");

  const page = await pack.initial_sync(CONTEXT, stream, RANGE);
  assert.equal(page.hasMore, true, "the parent version scan still needs its explicit empty page");
  const record = page.records[0]!;
  assert.equal((record.payload as Record<string, unknown>)._albert, undefined);
  const projected = record.normalized?.fields.payload_json as Record<string, unknown>;
  assert.deepEqual(projected._albert, { parent: { customer_id: "customer/1" } });
  assert.equal(record.sourceRecordId, "9007199254740993");
  assert.deepEqual(paths, [
    "/api/2026-07/customers?deleted=true&page_size=1000",
    "/api/2026-07/customers/customer%2F1/addresses",
  ]);
  assert.equal(decodeLightspeedXCursor(page.nextCursor?.value).parentAfter, "5");
});

test("partitioned custom-field definitions advance deterministically without auto-mutation", async () => {
  const entities: string[] = [];
  const { pack } = connector(async (input, init) => {
    const url = assertApiRequest(input, init);
    assert.equal(init?.method, "GET");
    entities.push(url.searchParams.get("entity") ?? "");
    return new Response('{"data":[]}');
  });
  const stream = await runtimeStream(pack, "lx_custom_fields");
  const first = await pack.initial_sync(CONTEXT, stream, RANGE);
  assert.equal(first.hasMore, true);
  assert.equal(decodeLightspeedXCursor(first.nextCursor?.value).partitionIndex, 1);
  const second = await pack.initial_sync(CONTEXT, stream, RANGE, first.nextCursor!);
  assert.deepEqual(entities, ["sale", "line_item"]);
  assert.equal(decodeLightspeedXCursor(second.nextCursor?.value).partitionIndex, 2);
});

test("all paginator families advance or fail visibly", () => {
  const version: LightspeedXPagination = {
    kind: "version", location: "query", requestField: "after", responseField: "version.max",
    emptyPageTerminates: true,
  };
  assert.deepEqual(advanceLightspeedXPage(version, undefined, [], [{ version: "12" }]), {
    hasMore: true, nextPosition: "12",
  });
  assert.equal(advanceLightspeedXPage(version, "12", {}, [{ version: "12" }]).block?.code, "pagination_not_advancing");

  const offset: LightspeedXPagination = { kind: "offset", location: "body", requestField: "offset" };
  assert.equal(advanceLightspeedXPage(offset, "10", {}, [{}, {}, {}]).nextPosition, "13");
  const page: LightspeedXPagination = { kind: "page", location: "query", requestField: "page" };
  assert.equal(advanceLightspeedXPage(page, "7", {}, [{}]).nextPosition, "8");
  const opaque: LightspeedXPagination = { kind: "opaque", location: "query", responseField: "next" };
  assert.equal(advanceLightspeedXPage(opaque, "a", { next: "b" }, [{}]).nextPosition, "b");
  assert.equal(advanceLightspeedXPage(opaque, "z", { next: "a" }, [{}]).nextPosition, "a");
  assert.equal(advanceLightspeedXPage(opaque, "same", { next: "same" }, [{}]).block?.code, "pagination_not_advancing");
  assert.equal(advanceLightspeedXPage(opaque, "a", {}, [{}]).hasMore, false);
  const after: LightspeedXPagination = {
    kind: "after_id", location: "query", lastRecordField: "id", hasNextField: "has_next",
  };
  assert.equal(advanceLightspeedXPage(after, "10", { has_next: true }, [{ id: "11" }]).nextPosition, "11");
  assert.equal(advanceLightspeedXPage(after, "z", { has_next: true }, [{ id: "a" }]).nextPosition, "a");
  const before: LightspeedXPagination = { kind: "before_id", location: "query", lastRecordField: "id" };
  assert.equal(advanceLightspeedXPage(before, "10", {}, [{ id: "9" }]).nextPosition, "9");
  assert.equal(advanceLightspeedXPage(before, "9", {}, [{ id: "9" }]).block?.code, "pagination_not_advancing");
});

test("disconnect destroys the local encrypted grant because remote revocation is undocumented", async () => {
  const { pack, vault } = connector(async () => {
    throw new Error("no network request expected");
  });
  await pack.revoke_credentials(CONTEXT);
  assert.equal(vault.destroyed, true);
});
