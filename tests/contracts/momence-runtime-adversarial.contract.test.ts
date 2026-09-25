import assert from "node:assert/strict";
import test from "node:test";

import { MomenceConnector } from "../../connectors/momence/index";
import {
  ConnectorError,
  encodeCursor,
  type ConnectorContext,
  type FetchLike,
  type OAuthCredentialSecret,
  type VersionedCredential,
  type WorkerCredentialVault,
} from "../../packages/connector-sdk/src/index";
import type { CredentialRefreshLeaseContext } from "../../packages/connector-sdk/src/oauth";

const context: ConnectorContext = {
  tenantId: "tenant-momence-adversarial",
  connectionId: "connection-momence-adversarial",
  credentialRef: "credential:momence-adversarial",
};

const range = {
  from: "2029-01-01T00:00:00.000Z",
  to: "2031-01-01T00:00:00.000Z",
};

class MemoryVault implements WorkerCredentialVault {
  private readonly secret: OAuthCredentialSecret = {
    provider: "momence",
    accessToken: "access-momence-adversarial",
    refreshToken: "refresh-momence-adversarial",
    tokenType: "Bearer",
    expiresAt: "2099-01-01T00:00:00.000Z",
    scopes: ["public-api-v2"],
    metadata: {},
  };

  async create(secret: OAuthCredentialSecret): Promise<VersionedCredential> {
    return { credentialRef: context.credentialRef, revision: "1", secret };
  }

  async read(credentialRef: string): Promise<VersionedCredential> {
    return { credentialRef, revision: "1", secret: this.secret };
  }

  async compareAndSwap(
    credentialRef: string,
    _expectedRevision: string,
    secret: OAuthCredentialSecret,
  ): Promise<VersionedCredential> {
    return { credentialRef, revision: "2", secret };
  }

  async withRefreshLease<T>(
    _credentialRef: string,
    operation: (lease: CredentialRefreshLeaseContext) => Promise<T>,
  ): Promise<T> {
    return operation({
      abortSignal: new AbortController().signal,
      proof: { leaseId: "lease-momence-adversarial", fencingToken: "1" },
    });
  }

  async destroy(): Promise<void> {}
}

function connector(fetcher: FetchLike, now: () => number): MomenceConnector {
  return new MomenceConnector({
    clientId: "client-momence-adversarial",
    clientSecret: "secret-momence-adversarial",
    redirectUri: "https://app.example.test/api/oauth/momence/callback",
    vault: new MemoryVault(),
    fetcher,
    retry: { maxAttempts: 1 },
    now,
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function page(
  pageNumber: number,
  totalCount: number,
  payload: readonly unknown[],
  pageSize: number,
): unknown {
  return {
    pagination: {
      page: pageNumber,
      pageSize,
      totalCount,
      sortBy: null,
      sortOrder: null,
    },
    payload,
  };
}

async function stream(pack: MomenceConnector, id: string) {
  const selected = (await pack.list_streams(context)).find((candidate) => candidate.id === id);
  assert.ok(selected, `stream ${id} must be declared`);
  return selected;
}

test("Momence freezes one incremental session time window across every continuation page", async () => {
  let clock = Date.parse("2030-01-01T00:00:00.000Z");
  const requests: URL[] = [];
  const fetcher: FetchLike = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url);
    assert.equal(url.pathname, "/api/v2/host/sessions");
    const requestedPage = Number(url.searchParams.get("page"));
    return json(page(requestedPage, 201, [hostSession(requestedPage + 1)], 200));
  };
  const pack = connector(fetcher, () => clock);
  const sessions = await stream(pack, "momence_sessions");
  const committed = encodeCursor({
    v: 1,
    connector: "momence",
    stream: "momence_sessions",
    mode: "incremental",
    watermark: "2029-12-01T00:00:00.000Z",
  });

  const first = await pack.incremental_sync(context, sessions, committed);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  const firstStart = requests[0]?.searchParams.get("startAfter");
  const firstEnd = requests[0]?.searchParams.get("startBefore");
  assert.ok(firstStart);
  assert.ok(firstEnd);

  clock += 24 * 60 * 60_000;
  const terminal = await pack.incremental_sync(context, sessions, first.nextCursor!);
  assert.equal(terminal.hasMore, false);
  assert.equal(
    requests[1]?.searchParams.get("startAfter"),
    firstStart,
    "a moving lower bound can skip records between page requests",
  );
  assert.equal(
    requests[1]?.searchParams.get("startBefore"),
    firstEnd,
    "a moving upper bound can change page membership during one scan",
  );
});

test("Momence cancellations remain source status and never become deletion tombstones", async () => {
  const cancelled = hostSession(17, { cancelled: true });
  const fetcher: FetchLike = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.pathname, "/api/v2/host/sessions");
    return json(page(0, 1, [cancelled], 200));
  };
  const pack = connector(fetcher, fixedClock);
  const sessions = await stream(pack, "momence_sessions");

  const result = await pack.initial_sync(context, sessions, range);
  assert.equal(result.records[0]?.normalized?.fields.isCancelled, true);
  assert.notEqual(
    result.records[0]?.normalized?.tombstone,
    true,
    "a cancelled class still exists and must remain visible to attendance and cancellation questions",
  );
  assert.deepEqual(result.records[0]?.payload, cancelled);
});

test("Momence fan-out fails closed when the parent API repeats a page identity", async () => {
  const repeatedParent = hostSession(31);
  const fetcher: FetchLike = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/api/v2/host/sessions") {
      const requestedPage = Number(url.searchParams.get("page"));
      return json(page(requestedPage, 401, [repeatedParent], 200));
    }
    assert.equal(url.pathname, "/api/v2/host/sessions/31/bookings");
    return json(page(0, 0, [], 100));
  };
  const pack = connector(fetcher, fixedClock);
  const bookings = await stream(pack, "momence_session_bookings");

  const first = await pack.initial_sync(context, bookings, range);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  const blocked = await pack.initial_sync(context, bookings, range, first.nextCursor!);
  assert.equal(blocked.hasMore, true);
  assert.equal(blocked.nextCursor, null);
  assert.equal(blocked.paginationBlock?.code, "pagination_not_advancing");
});

test("Momence fan-out fails closed when a child API repeats a page identity", async () => {
  const repeatedBooking = hostSessionBooking(44, 9);
  const fetcher: FetchLike = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/api/v2/host/sessions") {
      return json(page(0, 1, [hostSession(9)], 200));
    }
    assert.equal(url.pathname, "/api/v2/host/sessions/9/bookings");
    const requestedPage = Number(url.searchParams.get("page"));
    return json(page(requestedPage, 301, [repeatedBooking], 100));
  };
  const pack = connector(fetcher, fixedClock);
  const bookings = await stream(pack, "momence_session_bookings");

  const first = await pack.initial_sync(context, bookings, range);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  const blocked = await pack.initial_sync(context, bookings, range, first.nextCursor!);
  assert.equal(blocked.hasMore, true);
  assert.equal(blocked.nextCursor, null);
  assert.equal(blocked.paginationBlock?.code, "pagination_not_advancing");
});

test("Momence payment discovery fails closed when note pagination repeats an identity", async () => {
  const repeatedNote = hostMemberNote(71, null);
  const fetcher: FetchLike = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/api/v2/host/members") {
      const requestedPage = Number(url.searchParams.get("page"));
      return requestedPage === 0
        ? json(page(0, 1, [hostMember(12)], 100))
        : json(page(requestedPage, 1, [], 100));
    }
    assert.equal(url.pathname, "/api/v2/host/members/12/notes");
    const requestedPage = Number(url.searchParams.get("page"));
    return json(page(requestedPage, 201, [repeatedNote], 100));
  };
  const pack = connector(fetcher, fixedClock);
  const payments = await stream(pack, "momence_payment_transactions");

  const blocked = await pack.initial_sync(context, payments, range);
  assert.equal(blocked.hasMore, true);
  assert.equal(blocked.nextCursor, null);
  assert.equal(blocked.paginationBlock?.code, "pagination_not_advancing");
});

test("Momence treats a first optional child 404 as unavailable coverage, not an authoritative zero", async () => {
  const fetcher: FetchLike = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/api/v2/host/members") {
      return json(page(0, 1, [hostMember(18)], 100));
    }
    assert.equal(url.pathname, "/api/v2/host/members/18/notes");
    return json({ message: "not found" }, 404);
  };
  const pack = connector(fetcher, fixedClock);
  const notes = await stream(pack, "momence_member_notes");

  await assert.rejects(
    pack.initial_sync(context, notes, range),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "CAPABILITY_UNAVAILABLE",
  );
});

test("Momence known API boundaries remain partial after an endpoint succeeds", async () => {
  const fetcher: FetchLike = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/api/v2/host/sales") return json(page(0, 0, [], 100));
    if (url.pathname === "/api/v2/host/members") return json(page(0, 0, [], 100));
    throw new Error(`unexpected Momence request: ${url.pathname}`);
  };
  const pack = connector(fetcher, fixedClock);
  const sales = await stream(pack, "momence_sales");
  const payments = await stream(pack, "momence_payment_transactions");

  await pack.initial_sync(context, sales, range);
  await pack.initial_sync(context, payments, range);
  const capabilities = new Map(
    (await pack.describe_capabilities(context)).map((capability) => [capability.id, capability]),
  );
  for (const id of [
    "commerce.orders",
    "commerce.order_lines",
    "commerce.orders.customer",
    "commerce.order_lines.discounts",
    "commerce.payments",
    "commerce.refunds",
  ] as const) {
    assert.equal(
      capabilities.get(id)?.support,
      "partial",
      `${id} has a documented population or field boundary that endpoint success cannot remove`,
    );
  }
});

test("Momence snapshot coverage is anchored to extraction time, not an entity business timestamp", async () => {
  const member = hostMember(25, { lastSeen: "2022-02-03T04:05:06.000Z" });
  const fetcher: FetchLike = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.pathname, "/api/v2/host/members");
    return json(page(0, 1, [member], 100));
  };
  const pack = connector(fetcher, fixedClock);
  const members = await stream(pack, "momence_members");

  const result = await pack.initial_sync(context, members, range);
  assert.equal(result.records[0]?.sourceUpdatedAt, "2022-02-03T04:05:06.000Z");
  assert.equal(result.coverage?.boundaryKind, "snapshot_at");
  assert.equal(
    result.coverage?.lowerBound,
    "2030-01-01T00:00:00.000Z",
    "source last-seen/sale/session timestamps do not describe when a snapshot was observed",
  );
});

test("Momence serializes active API requests per connection", async () => {
  let active = 0;
  let maximumActive = 0;
  const fetcher: FetchLike = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.pathname, "/api/v2/auth/profile");
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return json({
      userId: 41,
      memberId: null,
      email: "owner@example.test",
      firstName: "Studio",
      lastName: "Owner",
    });
  };
  const pack = connector(fetcher, fixedClock);

  const health = await Promise.all([
    pack.check_connection(context),
    pack.check_connection(context),
  ]);

  assert.deepEqual(health, ["healthy", "healthy"]);
  assert.equal(maximumActive, 1, "one connection must never issue overlapping Momence requests in a worker");
});

test("Momence reuses one parent page across fan-out children to conserve the vendor budget", async () => {
  let parentRequests = 0;
  let childRequests = 0;
  const fetcher: FetchLike = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/api/v2/host/sessions") {
      parentRequests += 1;
      return json(page(0, 2, [hostSession(61), hostSession(62)], 200));
    }
    childRequests += 1;
    assert.match(url.pathname, /^\/api\/v2\/host\/sessions\/(?:61|62)\/bookings$/u);
    return json(page(0, 0, [], 100));
  };
  const pack = connector(fetcher, fixedClock);
  const bookings = await stream(pack, "momence_session_bookings");

  const first = await pack.initial_sync(context, bookings, range);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  const terminal = await pack.initial_sync(context, bookings, range, first.nextCursor!);

  assert.equal(terminal.hasMore, false);
  assert.equal(parentRequests, 1, "one parent page should be reserved once, not once per child");
  assert.equal(childRequests, 2);
});

test("Momence fails closed if a fan-out parent page changes across a worker resume", async () => {
  const firstPack = connector(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/api/v2/host/sessions") {
      return json(page(0, 2, [hostSession(71), hostSession(72)], 200));
    }
    return json(page(0, 0, [], 100));
  }, fixedClock);
  const bookings = await stream(firstPack, "momence_session_bookings");
  const first = await firstPack.initial_sync(context, bookings, range);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);

  let childRequested = false;
  const resumedPack = connector(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/api/v2/host/sessions") {
      return json(page(0, 2, [hostSession(71), hostSession(799)], 200));
    }
    childRequested = true;
    return json(page(0, 0, [], 100));
  }, fixedClock);
  const resumedBookings = await stream(resumedPack, "momence_session_bookings");
  const blocked = await resumedPack.initial_sync(context, resumedBookings, range, first.nextCursor!);

  assert.equal(blocked.hasMore, true);
  assert.equal(blocked.nextCursor, null);
  assert.equal(blocked.paginationBlock?.code, "pagination_identity_invalid");
  assert.equal(childRequested, false, "a changed parent page must block before using its shifted child index");
});

test("Momence rejects an identity-repeat even when the repeated page claims to be terminal", async () => {
  const repeated = hostMember(81);
  const pack = connector(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const requestedPage = Number(url.searchParams.get("page"));
    return json(page(requestedPage, 101, [repeated], 100));
  }, fixedClock);
  const members = await stream(pack, "momence_members");
  const first = await pack.initial_sync(context, members, range);
  assert.ok(first.nextCursor);

  const blocked = await pack.initial_sync(context, members, range, first.nextCursor!);
  assert.equal(blocked.hasMore, true);
  assert.equal(blocked.nextCursor, null);
  assert.equal(blocked.paginationBlock?.code, "pagination_not_advancing");
});

function fixedClock(): number {
  return Date.parse("2030-01-01T00:00:00.000Z");
}

function hostMember(
  id: number,
  options: Readonly<{ lastSeen?: string }> = {},
): Readonly<Record<string, unknown>> {
  return {
    id,
    firstName: "Ava",
    lastName: `Member ${id}`,
    email: `member-${id}@example.test`,
    phoneNumber: null,
    pictureUrl: null,
    firstSeen: "2021-01-01T00:00:00.000Z",
    lastSeen: options.lastSeen ?? "2029-12-01T00:00:00.000Z",
    visits: {
      appointments: 0,
      appointmentsVisits: 0,
      bookings: 0,
      bookingsVisits: 0,
      openAreaVisits: 0,
      total: 0,
      totalVisits: 0,
    },
    customerFields: [],
    customerTags: [],
  };
}

function hostSession(
  id: number,
  options: Readonly<{ cancelled?: boolean }> = {},
): Readonly<Record<string, unknown>> {
  return {
    id,
    name: `Yoga session ${id}`,
    type: "fitness",
    description: null,
    startsAt: "2030-01-10T09:00:00.000Z",
    endsAt: "2030-01-10T10:00:00.000Z",
    durationInMinutes: 60,
    capacity: 20,
    bookingCount: 1,
    teacher: null,
    isRecurring: false,
    isCancelled: options.cancelled ?? false,
    isInPerson: true,
    isDraft: false,
    inPersonLocation: null,
    onlineStreamUrl: null,
    onlineStreamPassword: null,
    bannerImageUrl: null,
    hostPhotoUrl: null,
    tags: [],
  };
}

function hostSessionBooking(id: number, memberId: number): Readonly<Record<string, unknown>> {
  return {
    id,
    member: {
      id: memberId,
      firstName: "Ava",
      lastName: "Yogi",
      email: `member-${memberId}@example.test`,
      phoneNumber: null,
      pictureUrl: null,
    },
    roomSpotId: null,
    checkedIn: false,
    ticketsBought: 1,
    createdAt: "2029-12-01T00:00:00.000Z",
    isRecurring: false,
    recurringBookingId: null,
    cancelledAt: null,
  };
}

function hostMemberNote(
  id: number,
  paymentTransactionId: number | null,
): Readonly<Record<string, unknown>> {
  return {
    id,
    createdAt: "2029-12-01T00:00:00.000Z",
    modifiedAt: "2029-12-01T00:00:00.000Z",
    type: "regular",
    note: "Member note",
    imageLink: null,
    customerNoteTemplateId: null,
    sessionBookingId: null,
    appointmentReservationId: null,
    productOrderId: null,
    boughtMembershipId: null,
    paymentTransactionId,
    lockedAt: null,
    lockedByUserId: null,
  };
}
