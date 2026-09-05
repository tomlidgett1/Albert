import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectorError,
  decodeCursor,
  encodeCursor,
  type ConnectorContext,
  type ConnectorStream,
  type CredentialRefreshLeaseContext,
  type FetchLike,
  type HttpRetryOptions,
  type OAuthCredentialSecret,
  type VersionedCredential,
  type WorkerCredentialVault,
} from "../../packages/connector-sdk/src/index.js";
import { SquareConnector } from "../../connectors/square/index.js";
import { buildSquareFieldIndex } from "../../connectors/square/field-index.js";
import { SQUARE_API_VERSION, SQUARE_DEFAULT_SCOPES } from "../../connectors/square/manifest.js";

const RANGE = Object.freeze({
  from: "2026-06-01T00:00:00.000Z",
  to: "2026-07-01T00:00:00.000Z",
});

const CONTEXT = Object.freeze({
  tenantId: "tenant-square-runtime",
  connectionId: "connection-square-runtime",
  credentialRef: "credential:square-runtime",
});

class MemoryVault implements WorkerCredentialVault {
  private revision = 1;

  constructor(private secret: OAuthCredentialSecret) {}

  async create(secret: OAuthCredentialSecret): Promise<VersionedCredential> {
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
  ): Promise<VersionedCredential> {
    assert.equal(expectedRevision, String(this.revision));
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
      proof: { leaseId: "01J00000000000000000000000", fencingToken: "1" },
    });
  }

  async destroy(): Promise<void> {
    this.secret = { ...this.secret, accessToken: "destroyed", refreshToken: undefined };
  }
}

function connector(
  fetcher: FetchLike,
  options: Readonly<{
    scopes?: readonly string[];
    retry?: HttpRetryOptions;
    now?: () => number;
  }> = {},
): SquareConnector {
  return new SquareConnector({
    clientId: "square-application-id",
    clientSecret: "square-application-secret",
    redirectUri: "https://albert.example/oauth/square/callback",
    vault: new MemoryVault({
      provider: "square",
      accessToken: "square-access-token",
      refreshToken: "square-refresh-token",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: options.scopes ?? SQUARE_DEFAULT_SCOPES,
      metadata: { merchantId: "merchant-1" },
    }),
    fetcher,
    retry: options.retry,
    now: options.now ?? (() => Date.parse("2026-07-01T00:00:00.000Z")),
  });
}

async function runtimeStream(pack: SquareConnector, id: string): Promise<ConnectorStream> {
  const stream = (await pack.list_streams(CONTEXT)).find((candidate) => candidate.id === id);
  assert.ok(stream, `Expected ${id} to be available to this test credential.`);
  return stream;
}

function streamHandle(id: string): ConnectorStream {
  // Extraction resolves the immutable stream contract by id; this handle
  // mirrors what the worker persists in a queued generation.
  return {
    id,
    label: id,
    domains: [],
    cursorKind: "none",
    backfillStrategy: "snapshot",
    lateEditStrategy: "full_snapshot",
    deletionStrategy: "authoritative_identity_scan",
    sourceTotalStrategy: "count_distinct_complete_scan",
    availability: "optional",
    dependencies: [],
    productDomains: [],
  };
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

function assertReadHeaders(init: RequestInit | undefined): void {
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("authorization"), "Bearer square-access-token");
  assert.equal(headers.get("square-version"), SQUARE_API_VERSION);
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(headers.has("idempotency-key"), false);
}

test("Square field index preserves distinct null and empty-container semantics", () => {
  const indexed = buildSquareFieldIndex({
    nullable: null,
    no_items: [],
    empty_metadata: {},
    nested: { no_children: [] },
  });

  assert.deepEqual(
    indexed.map(({ path, pointer, kind, rawValue }) => ({ path, pointer, kind, rawValue })),
    [
      { path: "nullable", pointer: "/nullable", kind: "null", rawValue: null },
      { path: "no_items[]", pointer: "/no_items", kind: "array", rawValue: [] },
      { path: "empty_metadata", pointer: "/empty_metadata", kind: "object", rawValue: {} },
      { path: "nested.no_children[]", pointer: "/nested/no_children", kind: "array", rawValue: [] },
    ],
  );
});

test("Square read traversal keeps a fixed time fence across vendor cursors and explicit location fan-out", async () => {
  const paymentRequests: Array<Readonly<{
    url: URL;
    method: string;
    headers: Headers;
  }>> = [];
  let paymentPage = 0;
  const pack = connector(async (input, init) => {
    const url = requestUrl(input);
    assertReadHeaders(init);
    if (url.pathname === "/v2/locations") {
      assert.equal(init?.method, "GET");
      return Response.json({ locations: [{ id: "location-a" }, { id: "location-b" }] });
    }
    assert.equal(url.pathname, "/v2/payments");
    assert.equal(init?.method, "GET");
    assert.equal(init?.body, undefined);
    paymentRequests.push({ url, method: init.method, headers: new Headers(init.headers) });
    paymentPage += 1;
    if (paymentPage === 1) {
      return Response.json({
        payments: [{ id: "payment-a-1", location_id: "location-a", updated_at: "2026-06-05T00:00:00Z" }],
        cursor: "vendor-cursor-a",
      });
    }
    if (paymentPage === 2) {
      return Response.json({
        payments: [{ id: "payment-a-2", location_id: "location-a", updated_at: "2026-06-06T00:00:00Z" }],
      });
    }
    return Response.json({
      payments: [{ id: "payment-b-1", location_id: "location-b", updated_at: "2026-06-07T00:00:00Z" }],
    });
  });
  const stream = await runtimeStream(pack, "square_payments");

  const first = await pack.initial_sync(CONTEXT, stream, RANGE);
  assert.equal(first.hasMore, true);
  assert.equal(first.coverage, undefined);
  const firstCursor = decodeCursor(first.nextCursor!, { connector: "square", stream: stream.id });
  assert.equal(firstCursor.rangeFrom, RANGE.from);
  assert.equal(firstCursor.rangeTo, RANGE.to);
  assert.deepEqual(JSON.parse(String(firstCursor.continuation)), {
    workIndex: 0,
    vendorCursor: "vendor-cursor-a",
    traversalStartedAt: RANGE.to,
  });

  // A caller cannot widen or move an in-flight page walk. The cursor's source
  // fence is authoritative until every location and every vendor page drains.
  const second = await pack.initial_sync(
    CONTEXT,
    stream,
    { from: "2000-01-01T00:00:00.000Z", to: "2090-01-01T00:00:00.000Z" },
    first.nextCursor!,
  );
  assert.equal(second.hasMore, true);
  const secondCursor = decodeCursor(second.nextCursor!, { connector: "square", stream: stream.id });
  assert.equal(secondCursor.rangeFrom, RANGE.from);
  assert.equal(secondCursor.rangeTo, RANGE.to);
  assert.deepEqual(JSON.parse(String(secondCursor.continuation)), {
    workIndex: 1,
    traversalStartedAt: RANGE.to,
  });

  const third = await pack.initial_sync(CONTEXT, stream, RANGE, second.nextCursor!);
  assert.equal(third.hasMore, false);
  assert.deepEqual(third.coverage, {
    boundaryKind: "window_exhausted",
    lowerBound: RANGE.from,
    verification: "exhaustive_vendor_scan",
  });

  assert.equal(paymentRequests.length, 3);
  assert.deepEqual(
    paymentRequests.map(({ url }) => url.searchParams.get("location_id")),
    ["location-a", "location-a", "location-b"],
  );
  assert.deepEqual(
    paymentRequests.map(({ url }) => url.searchParams.get("cursor")),
    [null, "vendor-cursor-a", null],
  );
  for (const { url, method, headers } of paymentRequests) {
    assert.equal(method, "GET");
    assert.equal(headers.get("square-version"), SQUARE_API_VERSION);
    assert.equal(url.searchParams.get("begin_time"), RANGE.from);
    assert.equal(url.searchParams.get("end_time"), RANGE.to);
    assert.equal(url.searchParams.get("sort_field"), "UPDATED_AT");
    assert.equal(url.searchParams.get("sort_order"), "ASC");
    assert.equal(url.searchParams.get("limit"), "100");
  }
});

test("Square wire int64 values remain exact in immutable raw data and the typed field index", async () => {
  const pack = connector(async (input, init) => {
    const url = requestUrl(input);
    assertReadHeaders(init);
    if (url.pathname === "/v2/locations") {
      return Response.json({ locations: [{ id: "location-a" }] });
    }
    assert.equal(url.pathname, "/v2/payments");
    return new Response(
      '{"payments":[{"id":"payment-int64","location_id":"location-a","version":9007199254740993,"amount_money":{"amount":9223372036854775807,"currency":"AUD"},"future_extension":{"risk.signal":"green","flags":[true,false]},"updated_at":"2026-06-20T01:02:03Z"}]}',
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const stream = await runtimeStream(pack, "square_payments");

  const page = await pack.initial_sync(CONTEXT, stream, RANGE);
  const record = page.records[0];
  assert.ok(record);
  assert.equal(record.sourceObjectType, "Payment");
  assert.equal(record.sourceRecordId, "payment-int64");
  assert.equal(record.sourceUpdatedAt, "2026-06-20T01:02:03.000Z");
  assert.match(record.payloadHash, /^[a-f0-9]{64}$/u);

  const payload = record.payload as Record<string, unknown>;
  assert.equal(payload.version, "9007199254740993");
  assert.equal((payload.amount_money as Record<string, unknown>).amount, "9223372036854775807");
  assert.deepEqual(record.normalized?.fields.payload_json, record.payload);
  assert.equal(record.normalized?.schemaVersion, pack.manifest.packVersion);
  const fieldIndex = record.normalized?.fields.field_index as readonly Record<string, unknown>[];
  assert.equal(
    fieldIndex.find((field) => field.path === "version")?.numericValue,
    "9007199254740993",
  );
  assert.equal(
    fieldIndex.find((field) => field.path === "amount_money.amount")?.numericValue,
    "9223372036854775807",
  );
  assert.deepEqual(
    fieldIndex
      .filter((field) => field.path === "future_extension.flags[]")
      .map((field) => [field.ordinal, field.pointer, field.booleanValue]),
    [[0, "/future_extension/flags/0", true], [1, "/future_extension/flags/1", false]],
  );
  assert.equal(
    fieldIndex.find((field) => field.pointer === "/future_extension/risk.signal")?.textValue,
    "green",
  );
});

test("Square expires vendor cursors in memory and restarts their immutable fixed window", async () => {
  let clock = Date.parse("2026-07-01T00:00:00.000Z");
  const paymentRequests: URL[] = [];
  const pack = connector(async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/v2/locations") {
      return Response.json({ locations: [{ id: "location-a" }] });
    }
    assert.equal(url.pathname, "/v2/payments");
    paymentRequests.push(url);
    return paymentRequests.length === 1
      ? Response.json({
          payments: [{ id: "payment-before-expiry", updated_at: "2026-06-10T00:00:00Z" }],
          cursor: "short-lived-square-cursor",
        })
      : Response.json({
          payments: [{ id: "payment-replayed-after-expiry", updated_at: "2026-06-10T00:00:00Z" }],
        });
  }, { now: () => clock });
  const stream = await runtimeStream(pack, "square_payments");

  const first = await pack.initial_sync(CONTEXT, stream, RANGE);
  assert.equal(first.hasMore, true);
  clock += 5 * 60_000;
  const second = await pack.initial_sync(
    CONTEXT,
    stream,
    { from: "2000-01-01T00:00:00.000Z", to: "2090-01-01T00:00:00.000Z" },
    first.nextCursor!,
  );

  assert.equal(second.hasMore, false);
  assert.deepEqual(paymentRequests.map((url) => url.searchParams.get("cursor")), [null, null]);
  assert.deepEqual(
    paymentRequests.map((url) => [url.searchParams.get("begin_time"), url.searchParams.get("end_time")]),
    [[RANGE.from, RANGE.to], [RANGE.from, RANGE.to]],
  );
  const committed = decodeCursor(second.nextCursor!, { connector: "square", stream: stream.id });
  assert.equal(committed.watermark, RANGE.to);
  assert.equal(committed.continuation, undefined);
});

test("Square incrementals reopen the documented late-edit overlap from the durable watermark", async () => {
  const paymentRequests: URL[] = [];
  const pack = connector(async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/v2/locations") {
      return Response.json({ locations: [{ id: "location-a" }] });
    }
    paymentRequests.push(url);
    return Response.json({ payments: [] });
  });
  const stream = await runtimeStream(pack, "square_payments");
  const durable = encodeCursor({
    v: 1,
    connector: "square",
    stream: stream.id,
    mode: "incremental",
    watermark: "2026-06-20T00:00:00.000Z",
  });

  const page = await pack.incremental_sync(CONTEXT, stream, durable);
  assert.equal(paymentRequests.length, 1);
  assert.equal(paymentRequests[0]?.searchParams.get("begin_time"), "2026-06-19T00:00:00.000Z");
  assert.equal(paymentRequests[0]?.searchParams.get("end_time"), RANGE.to);
  assert.equal(
    decodeCursor(page.nextCursor!, { connector: "square", stream: stream.id }).watermark,
    RANGE.to,
  );
});

test("Square order traversal chunks every explicit seller location without using the main-location default", async () => {
  const locations = Array.from({ length: 12 }, (_, index) => ({ id: `location-${index + 1}` }));
  const orderBodies: Record<string, unknown>[] = [];
  const pack = connector(async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/v2/locations") return Response.json({ locations });
    assert.equal(url.pathname, "/v2/orders/search");
    orderBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ orders: [] });
  });
  const stream = await runtimeStream(pack, "square_orders");

  const first = await pack.initial_sync(CONTEXT, stream, RANGE);
  assert.equal(first.hasMore, true);
  const second = await pack.initial_sync(CONTEXT, stream, RANGE, first.nextCursor!);
  assert.equal(second.hasMore, false);
  assert.deepEqual(orderBodies.map((body) => body.location_ids), [
    locations.slice(0, 10).map((location) => location.id),
    locations.slice(10).map((location) => location.id),
  ]);
});

test("Square seven-day reconciliation windows and their child fan-outs never claim deletion authority", async () => {
  const lookback = {
    from: "2026-06-24T00:00:00.000Z",
    to: "2026-07-01T00:00:00.000Z",
  };
  const orderBodies: Record<string, unknown>[] = [];
  const childPaths: string[] = [];
  const pack = connector(async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/v2/locations") {
      return Response.json({ locations: [{ id: "location-a" }] });
    }
    if (url.pathname === "/v2/orders/search") {
      orderBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        orders: [{ id: "order-in-lookback", updated_at: "2026-06-28T00:00:00Z" }],
      });
    }
    childPaths.push(url.pathname);
    assert.equal(url.pathname, "/v2/orders/order-in-lookback/custom-attributes");
    return Response.json({
      custom_attributes: [{ key: "table_note", value: "window-scoped", updated_at: "2026-06-28T00:00:00Z" }],
    });
  });

  const orders = await runtimeStream(pack, "square_orders");
  assert.equal(orders.deletionStrategy, "no_absence_deletes");
  assert.equal(orders.lateEditStrategy, "modified_field");
  assert.equal(orders.sourceTotalStrategy, "count_distinct_bounded_scan");
  await pack.reconciliation_sync(CONTEXT, orders, {
    phase: "identity_snapshot",
    range: lookback,
  });

  const attributes = await runtimeStream(pack, "square_order_custom_attributes");
  assert.equal(attributes.deletionStrategy, "no_absence_deletes");
  assert.equal(attributes.lateEditStrategy, "full_snapshot");
  assert.equal(attributes.sourceTotalStrategy, "count_distinct_bounded_scan");
  await pack.reconciliation_sync(CONTEXT, attributes, {
    phase: "verify_snapshot",
    range: lookback,
  });

  assert.equal(orderBodies.length, 2);
  for (const body of orderBodies) {
    const query = body.query as Record<string, unknown>;
    const filter = query.filter as Record<string, unknown>;
    const dateTime = filter.date_time_filter as Record<string, unknown>;
    const updatedAt = dateTime.updated_at as Record<string, unknown>;
    assert.equal(updatedAt.start_at, lookback.from);
    assert.equal(updatedAt.end_at, lookback.to);
  }
  assert.deepEqual(childPaths, ["/v2/orders/order-in-lookback/custom-attributes"]);
});

test("Square location-sensitive reads and unsigned webhooks fail closed", async () => {
  let paymentCalls = 0;
  const pack = connector(async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/v2/locations") return Response.json({ locations: [] });
    paymentCalls += 1;
    return Response.json({ payments: [] });
  });
  const stream = await runtimeStream(pack, "square_payments");

  await assert.rejects(
    pack.initial_sync(CONTEXT, stream, RANGE),
    (error: unknown) => error instanceof ConnectorError &&
      error.code === "REMOTE_RESPONSE_INVALID" &&
      /implicit main-location read/u.test(error.message),
  );
  assert.equal(paymentCalls, 0);

  const webhook = await pack.handle_webhook(CONTEXT, {
    id: "spoofed-event",
    receivedAt: RANGE.to,
    headers: { "x-square-hmacsha256-signature": "not-verified" },
    body: new TextEncoder().encode('{"type":"payment.updated","merchant_id":"merchant-1"}'),
  });
  assert.deepEqual(webhook, {
    accepted: false,
    streams: [],
    reason: "square_webhook_verification_not_configured",
  });
});

test("Square source identity and schema projection preserve catalog tombstones", async () => {
  let catalogBody: Record<string, unknown> | undefined;
  const pack = connector(async (input, init) => {
    const url = requestUrl(input);
    assert.equal(url.pathname, "/v2/catalog/search");
    assert.equal(init?.method, "POST");
    assertReadHeaders(init);
    catalogBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      objects: [{
        type: "ITEM",
        id: "catalog-item-deleted",
        is_deleted: true,
        version: 123,
        updated_at: "2026-06-10T00:00:00Z",
        item_data: { name: "Retired flat white" },
      }],
    });
  });
  const stream = await runtimeStream(pack, "square_catalog_objects");

  const page = await pack.initial_sync(
    CONTEXT,
    stream,
    { from: "1970-01-01T00:00:00.000Z", to: RANGE.to },
  );
  const record = page.records[0];
  assert.ok(record);
  assert.equal(record.sourceObjectType, "CatalogObject");
  assert.equal(record.sourceRecordId, "catalog-item-deleted");
  assert.equal(record.normalized?.schemaVersion, pack.manifest.packVersion);
  assert.equal(record.normalized?.tombstone, true);
  assert.deepEqual(record.normalized?.fields.payload_json, record.payload);
  assert.equal(catalogBody?.include_deleted_objects, true);
  assert.equal(catalogBody?.include_related_objects, false);
  assert.equal(catalogBody?.begin_time, "1970-01-01T00:00:00.000Z");
  // SearchCatalogObjects exposes no upper-bound parameter. The connector fixes
  // begin_time, accepts post-fence duplicates, and advances only after drain.
  assert.equal(catalogBody?.latest_time, undefined);
  assert.equal(catalogBody?.cursor, undefined);
  assert.deepEqual(page.coverage, {
    boundaryKind: "verified_oldest",
    lowerBound: "1970-01-01T00:00:00.000Z",
    verification: "exhaustive_vendor_scan",
  });
});

test("Square snapshot streams publish terminal point-in-time coverage", async () => {
  const pack = connector(async (input, init) => {
    const url = requestUrl(input);
    assert.equal(url.pathname, "/v2/locations");
    assert.equal(init?.method, "GET");
    assertReadHeaders(init);
    return Response.json({ locations: [{ id: "location-a", name: "CBD Cafe", status: "ACTIVE" }] });
  });
  const stream = await runtimeStream(pack, "square_locations");

  const page = await pack.initial_sync(CONTEXT, stream, RANGE);
  assert.equal(page.hasMore, false);
  assert.equal(page.records[0]?.sourceRecordId, "location-a");
  assert.deepEqual(page.coverage, {
    boundaryKind: "snapshot_at",
    lowerBound: RANGE.to,
    verification: "exhaustive_vendor_scan",
  });
});

test("Square missing scopes and unpublished seller-OAuth surfaces fail closed before network access", async () => {
  let fetchCalls = 0;
  const pack = connector(async () => {
    fetchCalls += 1;
    throw new Error("A fail-closed stream must not reach Square.");
  }, { scopes: ["MERCHANT_PROFILE_READ"] });

  const listed = await pack.list_streams(CONTEXT);
  assert.equal(listed.some((stream) => stream.id === "square_payments"), false);
  assert.equal(listed.some((stream) => stream.id === "square_channels"), false);

  await assert.rejects(
    pack.initial_sync(CONTEXT, streamHandle("square_payments"), RANGE),
    (error: unknown) => error instanceof ConnectorError && error.code === "CAPABILITY_UNAVAILABLE",
  );
  await assert.rejects(
    pack.initial_sync(CONTEXT, streamHandle("square_channels"), RANGE),
    (error: unknown) => error instanceof ConnectorError && error.code === "CAPABILITY_UNAVAILABLE",
  );
  assert.equal(fetchCalls, 0);
});

test("Square 429 retries reserve and observe the shared vendor budget for location discovery and data pages", async () => {
  let paymentAttempts = 0;
  const observedStatuses: number[] = [];
  let reservations = 0;
  const pack = connector(async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/v2/locations") {
      return Response.json({ locations: [{ id: "location-a" }] });
    }
    assert.equal(url.pathname, "/v2/payments");
    paymentAttempts += 1;
    return paymentAttempts === 1
      ? new Response(null, { status: 429, headers: { "retry-after": "0" } })
      : Response.json({ payments: [{ id: "payment-after-retry", updated_at: "2026-06-22T00:00:00Z" }] });
  }, {
    retry: {
      maxAttempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 1,
      maxInlineRetryAfterMs: 1_000,
      random: () => 0,
      sleep: async () => undefined,
    },
  });
  const stream = await runtimeStream(pack, "square_payments");
  const context: ConnectorContext = {
    ...CONTEXT,
    vendorRateBudget: {
      beforeRequest: async () => { reservations += 1; },
      observeResponse: async (response) => { observedStatuses.push(response.status); },
    },
  };

  const page = await pack.initial_sync(context, stream, RANGE);
  assert.equal(page.records[0]?.sourceRecordId, "payment-after-retry");
  assert.equal(paymentAttempts, 2);
  assert.equal(reservations, 3);
  assert.deepEqual(observedStatuses, [200, 429, 200]);
});
