import type { ConnectorManifest } from "../../packages/connector-sdk/src/index.js";
import { squareStreamFieldCoverage } from "./field-census.js";
import {
  SQUARE_READ_STREAMS,
  squareDeletionContract,
  squareSourceTotalContract,
} from "./streams.js";

/**
 * Every documented Square read permission. Square grants permissions to the
 * whole application, so a narrower request would only have to be widened later
 * behind a second seller consent. No write permission is listed: the pack
 * contains no Square write method, so a write grant could only ever exceed what
 * the code can use.
 *
 * `DEVICE_CREDENTIAL_MANAGEMENT` is deliberately absent — it is a management
 * capability, not a read scope.
 */
export const SQUARE_DEFAULT_SCOPES = [
  "MERCHANT_PROFILE_READ",
  "ORDERS_READ",
  "PAYMENTS_READ",
  "PAYMENT_METHODS_READ",
  "PAYOUTS_READ",
  "ITEMS_READ",
  "INVENTORY_READ",
  "CUSTOMERS_READ",
  "EMPLOYEES_READ",
  "TIMECARDS_READ",
  "TIMECARDS_SETTINGS_READ",
  "BANK_ACCOUNTS_READ",
  "CASH_DRAWER_READ",
  "DISPUTES_READ",
  "GIFTCARDS_READ",
  "INVOICES_READ",
  "LOYALTY_READ",
  "SUBSCRIPTIONS_READ",
  "VENDOR_READ",
  "DEVICES_READ",
  "APPOINTMENTS_READ",
  "APPOINTMENTS_ALL_READ",
  "APPOINTMENTS_BUSINESS_SETTINGS_READ",
  "ONLINE_STORE_SITE_READ",
  "ONLINE_STORE_SNIPPETS_READ",
] as const;

export const SQUARE_ALLOWED_SCOPES = SQUARE_DEFAULT_SCOPES;

function streamContract(stream: (typeof SQUARE_READ_STREAMS)[number]): ConnectorManifest["streams"][number] {
  const deletionStrategy = squareDeletionContract(stream);
  const lateEditStrategy = deletionStrategy === "immutable_append_only"
    ? "append_only" as const
    : stream.modifiedPath && stream.backfill.mode === "time_windowed"
      ? "modified_field" as const
      : "full_snapshot" as const;
  return Object.freeze({
    id: stream.id,
    resource: stream.resource,
    endpoint: `${stream.method} ${stream.endpoint}`,
    recordIdField: typeof stream.recordIdPath === "string" ? stream.recordIdPath : stream.recordIdPath.join("+"),
    ...(stream.modifiedPath ? { modifiedField: stream.modifiedPath } : {}),
    pagination: stream.pagination.kind === "cursor" ? "vendor_cursor" : "none",
    backfillStrategy: stream.backfill.mode === "time_windowed" ? "time_windowed" : "snapshot",
    lateEditStrategy,
    deletionStrategy,
    sourceTotalStrategy: squareSourceTotalContract(stream),
    availability: stream.availability.sellerOAuth === "undocumented" || stream.priority >= 4
      ? "optional" as const
      : "required" as const,
    dependencies: stream.dependencies,
    productDomains: stream.productDomains,
    canonicalTargets: stream.canonicalTargets,
    // Metadata-only surfaces still need a source-authority owner so governed
    // source fields cannot leak across competing systems. Their closest
    // reviewed Square concept is used only for source evidence, never to
    // manufacture a canonical fact.
    authorityConcept: stream.authorityConcept ?? "operational_sales",
    ...(stream.id === "square_inventory_counts" ? { reprocessIdenticalPayloadOnNewBatch: true } : {}),
  });
}

const SQUARE_STREAM_CONTRACTS = Object.freeze(SQUARE_READ_STREAMS.map(streamContract));

const SQUARE_FIELD_COVERAGE = Object.freeze(SQUARE_READ_STREAMS.flatMap((stream) => {
  const common = [
    {
      stream: stream.id,
      field: "payload_json",
      disposition: "governed_extension" as const,
      stagingType: "jsonb" as const,
      target: `source_square.${stream.id}.payload_json`,
      pii: stream.productDomains.includes("customers") || stream.productDomains.includes("workforce")
        ? "free_text_untrusted" as const
        : "none" as const,
    },
    {
      stream: stream.id,
      field: "field_index",
      disposition: "governed_extension" as const,
      stagingType: "jsonb" as const,
      target: `source_square.${stream.id}.field_index`,
      pii: "free_text_untrusted" as const,
    },
    {
      stream: stream.id,
      field: "parent_context",
      disposition: "governed_extension" as const,
      stagingType: "jsonb" as const,
      target: `source_square.${stream.id}.parent_context`,
      pii: "none" as const,
    },
  ];
  // The transitive SDK closure can reach the same wire path through several
  // unions/references. It is useful to retain that provenance in the census,
  // but the governed source catalogue must publish one addressable contract
  // per stream/path. Prefer a scalar description when a union exposes both a
  // container edge and its scalar leaf at the same path.
  const documentedPaths = new Map<string, ReturnType<typeof squareStreamFieldCoverage>["paths"][number]>();
  for (const row of squareStreamFieldCoverage(stream.id).paths) {
    if (!row.path) continue;
    const current = documentedPaths.get(row.path);
    if (!current || (row.kind === "scalar" && current.kind !== "scalar")) {
      documentedPaths.set(row.path, row);
    }
  }
  const paths = [...documentedPaths.values()]
    .map((row) => ({
      stream: stream.id,
      field: row.path,
      disposition: "governed_extension" as const,
      stagingType: row.kind === "scalar" ? "text" as const : "jsonb" as const,
      storageField: "field_index",
      storageType: "jsonb" as const,
      queryPath: row.path,
      queryable: true,
      target: `source_square.sq_source_fields:${stream.id}:${row.path}`,
      pii: stream.productDomains.includes("customers") || stream.productDomains.includes("workforce")
        ? "free_text_untrusted" as const
        : "none" as const,
    }));
  return [...common, ...paths];
}));

/**
 * Square pins behaviour to a dated API version rather than a URL path segment.
 * Every request sends it explicitly so a vendor default rollover cannot change
 * response shapes underneath the pack.
 */
export const SQUARE_API_VERSION = "2026-07-15";

/**
 * Pinned, read-only production pack. The generated SDK census covers every
 * direct and transitive field while the runtime field index preserves additive
 * properties immediately, without allowing undocumented values to fabricate
 * canonical facts.
 */
export const squareManifest: ConnectorManifest = {
  id: "square",
  displayName: "Square",
  packVersion: "1.0.0",
  apiVersion: `Square-Version ${SQUARE_API_VERSION}`,
  releasedAt: "2026-08-06",
  documentation: [
    "https://developer.squareup.com/docs/oauth-api/overview",
    "https://developer.squareup.com/docs/oauth-api/create-urls-for-square-authorization",
    "https://developer.squareup.com/docs/oauth-api/square-permissions",
    "https://developer.squareup.com/reference/square/o-auth-api/obtain-token",
    "https://developer.squareup.com/reference/square/o-auth-api/revoke-token",
    "https://developer.squareup.com/reference/square/merchants-api/retrieve-merchant",
    "https://developer.squareup.com/reference/square/locations-api/list-locations",
  ],
  ingestion: { initialStart: "manual" },
  oauth: {
    scopes: SQUARE_DEFAULT_SCOPES,
    leastPrivilegeNotes: [
      "Square scopes an OAuth grant to the application, not to an individual endpoint, so a seller re-consents whenever the requested permission set grows. Albert therefore requests the complete documented read set once and contains no Square write method.",
      "Albert uses Square's confidential code flow rather than PKCE. Square's PKCE refresh tokens are single-use and expire after 90 days, which cannot survive an unattended worker, and RevokeToken authenticates with the application secret in every flow.",
    ],
    refreshTokenRotation: false,
    remoteRevocation: "supported",
  },
  streams: SQUARE_STREAM_CONTRACTS,
  sourceAuthority: {
    defaults: [
      { concepts: ["operational_sales", "product_master", "customer_master", "cash_settlement"], scope: { kind: "connection_account" } },
      { concepts: ["stock"], scope: { kind: "canonical_dimension", table: "stock_location", scopeType: "location" } },
      { concepts: ["planned_shifts", "worked_hours"], scope: { kind: "canonical_dimension", table: "location", scopeType: "location" } },
    ],
  },
  rateLimit: {
    algorithm: "vendor_response_directed_backoff",
    concurrency: 2,
    responseHeaders: ["Retry-After"],
    reservations: [
      { key: "square.requests", burstCapacity: 2, interval: { kind: "fixed", milliseconds: 100 } },
    ],
  },
  capabilities: {
    "commerce.orders": { support: "full", streams: ["square_orders"], reason: "Orders Search is the authoritative Square seller order stream." },
    "commerce.order_lines": { support: "full", streams: ["square_orders"], reason: "Square returns line items at native order-line grain." },
    "commerce.order_lines.discounts": { support: "full", streams: ["square_orders"], coverageFields: ["line_items[].total_discount_money.amount"], reason: "Square returns line and order discount allocations." },
    "commerce.order_lines.worker_attribution": { support: "unavailable", streams: ["square_orders"], reason: "The current Square Order response has no authoritative team-member field at line-item grain. Payment-level employee/team-member IDs must not be projected onto individual order lines." },
    "commerce.payments": { support: "full", streams: ["square_payments"], reason: "Payments are extracted for every explicit seller location." },
    "commerce.refunds": { support: "partial", streams: ["square_refunds"], coverageFields: ["amount_money.amount", "order_id", "payment_id"], reason: "PaymentRefund has a total amount but no trustworthy tax allocation." },
    "inventory.balances": { support: "full", streams: ["square_inventory_counts"], reason: "Current calculated counts are extracted as point-in-time snapshots." },
    "inventory.movements": { support: "partial", streams: ["square_inventory_changes", "square_transfer_orders"], reason: "Adjustments, counts and transfer orders are separate Square surfaces." },
    "inventory.stocktakes": { support: "full", streams: ["square_inventory_changes"], reason: "Physical count changes retain their native identities and timestamps." },
    "workforce.shifts": { support: "full", streams: ["square_scheduled_shifts"], reason: "Scheduled shifts are extracted from the current Labor API." },
    "workforce.time_entries": { support: "full", streams: ["square_timecards"], reason: "Timecards are the current replacement for retired Shift resources." },
    "workforce.time_entries.cost": { support: "partial", streams: ["square_timecards", "square_team_member_wages"], reason: "Cost depends on wage applicability and complete timecard segments." },
    "workforce.time_entries.overtime": { support: "unavailable", streams: ["square_timecards"], reason: "Square Timecard responses do not expose an authoritative overtime-minute allocation." },
    "finance.invoices": { support: "partial", streams: ["square_invoices"], reason: "Square invoices are operational sales documents, not a statutory ledger." },
    "finance.payments": { support: "full", streams: ["square_payments", "square_payouts", "square_payout_entries"], reason: "Tender, fee and settlement surfaces are modeled at separate grains." },
    "source.webhooks": { support: "unavailable", streams: SQUARE_READ_STREAMS.filter((stream) => stream.deletion.webhook).map((stream) => stream.id), reason: "Square notifications require application-owned notification-URL signature verification in the isolated webhook gateway. Until that route is provisioned, Square webhooks fail closed and polling plus reconciliation provide completeness." },
  },
  identityRules: [
    "A Square connection is identified by its merchant_id, which Square returns from the token exchange and which survives access-token rotation.",
    "Location IDs are explicit on every location-sensitive traversal; Albert never relies on Square's main-location default.",
    "Every source scalar is addressable by stable census path and exact RFC 6901 occurrence pointer while the immutable JSON remains the authority.",
  ],
  topology: [
    "OAuth establishes a connected-but-not-started generation. Only the user's manual start action can enqueue the first Square backfill.",
    "Initial extraction drains short-lived Square cursors inside a restartable traversal; durable progress uses a timestamp boundary or complete snapshot evidence.",
    "Core sales, catalogue, inventory, customer, labour and settlement streams land first; optional seller surfaces follow in dependency order.",
  ],
  fieldCoverage: SQUARE_FIELD_COVERAGE,
  qualityAssertions: [
    "The pinned Square SDK census is reproducible and every returned scalar is retained in immutable raw JSON plus the typed field index.",
    "Money remains integer base units in source storage and is converted using an explicit ISO-4217 exponent only at canonical/semantic projection.",
    "A time-windowed stream advances only after its cursor traversal is exhausted; full scans publish completed-traversal evidence.",
    "Square access tokens last 30 days; the credential vault refreshes ahead of expiry rather than relying on a request failing first.",
  ],
  limitations: [
    "Some Square products are beta or early access, depend on seller entitlements, or have no documented seller OAuth scope. They are optional and become explicitly Unavailable rather than blocking core retail ingestion.",
    "Square does not expose item-level cost of goods on Orders; cost and margin remain partial unless another authoritative inventory/accounting source supplies cost.",
    "A bounded time-window reconciliation is never treated as proof that older identities were deleted. Time-windowed streams and child fan-outs over time-windowed parents retain historical identities unless Square returns an explicit soft-delete marker; newer versions of the same identity can still replace older source state. Their distinct source total describes only the bounded scan and is never compared with all landed history.",
    "Square revocation without revoke_only_access_token terminates every token the application holds for that merchant, so disconnect revokes the single access token and then destroys Albert's local credential.",
  ],
  unknownFieldPolicy: "quarantine_schema_drift",
};
