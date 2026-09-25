# ADR 0086: Lightspeed X-Series production ingestion and exhaustive semantics

- Status: Accepted for implementation; production launch remains gated
- Date: 2026-08-12
- Owners: Data platform, product analytics, security, and legal
- Amends: Albert v1 sections 2, 5, 9, 11, 17, and 19
- Related: ADR 0016, ADR 0047, ADR 0077, ADR 0084, ADR 0085

## Context

Lightspeed Retail X-Series is a different API product, OAuth registration,
resource model, and retailer host from Lightspeed R-Series. It must never be
treated as an alias for `lightspeed-r`. An X-Series merchant reasonably expects
questions spanning sales, line items, payments, products, stock, customers,
staff, shifts, outlets, registers, suppliers, taxes, consignments, price books,
promotions, gift cards, store credit, fulfillments, service orders, serial
numbers, quotes, audit history, and source-specific configuration.

The current official reference is date-versioned `2026-07` and is served from
`https://{domain_prefix}.retail.lightspeed.app/api/2026-07`. Lightspeed publishes
an official bulk OpenAPI 3.0.1 contract and an official `llms.txt` index linking
196 reference pages, each with an operation-level contract fragment. Albert
locks both sources. Deterministically merging the reference fragments produced
130 paths, 196 operations, 308 referenced schemas, 1,633 direct schema fields,
and 5,202 dereferenced field paths without a path or component collision. The
bulk document contains the same 130 paths and 196 operations plus component
schemas that are not necessarily reachable from a published operation.

The API has multiple incompatible traversal protocols. Twenty-six list
operations use the global version cursor; others use offset, page number,
resource ID, reverse `before`, an opaque next cursor, or a request-body cursor.
The inventory reads are POST requests. Version values and several resource IDs
are 64-bit values that cannot pass through JavaScript `Number` without losing
identity.

OAuth and ingestion are separate merchant actions. The user requires a
successful authorization to leave the store connected but completely inert
until an owner or manager presses **Start ingestion**.

## Decision

### Separate, pinned connector identity

The immutable connector ID is `lightspeed-x`; its staging schema is
`source_lightspeed_x`. Production configuration must retain the R-Series
`ALBERT_LIGHTSPEED_PRODUCT=r-series` safeguard and separately require the exact
`ALBERT_LIGHTSPEED_X_PRODUCT=x-series` marker whenever an X-Series client ID is
configured. OAuth, queue, staging, deletion, tracing, and semantic routing all
use the distinct connector ID.

Every API request pins `2026-07`. A committed contract lock records the official
index hash, page-manifest hash, operation inventory, schema inventory, and
pagination inventory. Upgrading the API version is an explicit connector-pack
release with regenerated coverage and contract tests; it is never a runtime
fallback. Lightspeed's documented silent fallback for an end-of-life version
is treated as contract drift and must fail visible.

### OAuth and credential rotation

The authorization-code callback must include and validate the retailer
`domain_prefix`, returned `scope`, signed state, initiating user, tenant, exact
redirect URI, and single-use OAuth session. `domain_prefix` is an identifier,
not a URL: only the constrained label is accepted and the connector constructs
the fixed `retail.lightspeed.app` host.

The token endpoint remains `/api/1.0/token` on that retailer host. Authorization
codes are single-use and expire after ten minutes. Refresh tokens rotate: a
successful refresh atomically replaces the old refresh token, and refreshes are
serialized under the existing durable lease plus credential compare-and-swap.
The browser and model runtime never receive either token.

The default grant contains documented read scopes only. Read operations that
require a write scope, particularly stock adjustments and custom adjustment
reasons requiring `inventory:write`, remain unavailable until a separately
reviewed privilege elevation exists. The connector never issues a vendor write
request. Product costs excluded by `products:read`, internal payment types
excluded by `payment_types:read`, password material, and genuinely untyped
vendor nodes are reported as named source limitations rather than fabricated.

### Generation-bound manual ingestion

The manifest declares `ingestion.initialStart = manual`. OAuth may exchange and
store credentials, discover the retailer, and create or reauthorize its
connection, but it cannot enqueue an initial, incremental, reconciliation, or
webhook-driven extraction.

The connection's `ingestion_activated_generation` must equal its current
`connection_generation` before the central queue publication boundary accepts
any sync job. An owner or manager invokes the same-origin, tenant-scoped,
rate-limited Start ingestion action. Activation and publication of the
progressive initial coordinator occur in one locked, idempotent database
transaction. Reauthorization advances the generation and requires a fresh
manual activation. UI wording never claims that data has imported merely
because OAuth succeeded.

### Exhaustive raw and staged representation

Every selected read operation is endpoint-configured; there is no generic
pagination guess. Standard version lists commit `response.version.max` as an
opaque decimal string and stop only when `data` is empty. Offset and page
operations advance only from observed page cardinality. Opaque cursors remain
opaque. A non-advancing cursor blocks the page with evidence rather than
looping. Child fan-outs carry connector-owned `_albert.parent.*` context while
preserving the complete official entity unchanged.

Each source entity lands three representations:

1. the byte-faithful vendor payload in immutable raw storage;
2. a bounded typed projection for reviewed canonical and curated analysis; and
3. a typed long-form field index for every scalar occurrence, including nested
   arrays and free-form maps.

The field index preserves stable path, exact ordinal path, field name, native
value type, and typed text, decimal, boolean, timestamp, date, or JSON value.
Decimal money and quantity strings never pass through binary floating point.
All 64-bit IDs and cursors remain strings. The explicitly opaque contract nodes
remain raw JSON; child properties are not invented.

### CubeCore and canonical semantics

Common cross-source concepts map to the existing canonical model where their
grain and economic meaning agree: retailer/legal entity, outlet/location,
register, customer, worker, supplier, product and variant, category, tax,
stock location and balance, sale/order, line item, payment, refund/reversal,
inventory movement, and purchase-order/consignment line.

X-Series-specific concepts remain governed extensions until a defensible
cross-source grain exists. Gift-card loading is not revenue; store-credit issue
is not a cash payment; a consignment receipt is not a sale; a fulfillment is
not an order line; current catalogue price must not overwrite the historical
sale-line price. Returns, voids, discounts, taxes, surcharges, loyalty, and
payment amounts retain their documented signs and grains.

CubeCore exposes private source cubes, curated certified cubes, canonical
joins, and an exhaustive X-Series source-field explorer. Normal questions use
certified measures at declared grains. Unusual questions resolve a documented
field path against the source-field explorer and retain its parent stream and
record identity, so sibling array grains can never be cross-joined implicitly.
UTC timestamps are retained as evidence; trading-date derivation uses the
associated outlet IANA timezone.

### Rate limits, retries, and completeness

All source calls pass through the durable per-tenant, per-connection request
budget shared by every worker replica. The baseline five-minute allowance is
`300 * register_count + 50`; until a verified register count is available the
connector uses the conservative one-register allowance. It records
`X-RateLimit-Limit` and `X-RateLimit-Remaining`, preserves headroom for token
refresh and health checks, honors RFC 1123 `Retry-After`, and defers on the
first 429. Token-endpoint limits are observed separately.

Requests have hard deadlines and bounded retries with jitter. Independent
streams may progress concurrently only within the shared allowance; child
fan-outs are bounded. Polling and scheduled reconciliation own completeness.
Webhooks may accelerate work after a separately verified install but are not a
ledger and are never installed as a side effect of OAuth or manual start.

### Retention, privacy, and launch gates

Lightspeed's developer terms are a production launch constraint. Retrieved API
data must be deleted within 60 days unless the merchant expressly authorizes a
longer period, and all related data must be deleted on API termination. Albert
must retain auditable merchant consent, apply the matching raw/staged/semantic
retention policy, and exercise the existing disconnect and tenant-deletion
proof path. X-Series publishes no documented remote OAuth revocation endpoint,
so deletion destroys the encrypted local credential and records remote
revocation as vendor-unsupported.

Cross-merchant benchmarking is prohibited. Any use of transaction data that
identifies individual items or services requires Lightspeed legal review and,
where the terms require it, prior written approval. Production enablement is
blocked until that approval and the merchant-facing privacy, support,
liability, incident-notification, and retention terms are recorded. This gate
does not justify weakening or omitting the technical implementation.

### Verification without credentials in source control

CI and local tests use deterministic HTTP fixtures generated from the pinned
contract to exercise every pagination family, refresh-token rotation, retry
behavior, tombstones, raw fidelity, field indexing, typed normalization, and
manual-start queue fence. A live test uses a user-managed official Developer
Portal demo store when available. Demo stores are time-limited; no credential
is requested in chat, printed, read by the model, or committed. Absence of a
live demo credential is reported as unexecuted live attestation, never as a
successful live ingestion test.

## Consequences

- X-Series authorization cannot be confused with R-Series and cannot move
  merchant data until a generation-bound user action.
- Curated measures answer common retail questions while all documented nested
  fields remain discoverable and queryable at their native grain.
- The source pack is larger than a hand-authored connector, but regeneration is
  deterministic and API upgrades are reviewable.
- Some documented analytics remain unavailable under least privilege or are
  omitted by Lightspeed itself; answers must state those limitations.
- Conservative request budgeting can initially under-use a multi-register
  retailer's allowance, but cannot exceed the official baseline while account
  topology is being established.
- Production deployment remains fail-closed until legal approval, merchant
  retention consent, runtime secrets, migrations, deletion verification, and a
  live demo-store attestation are complete.

## Rejected alternatives

- **Reuse the R-Series connector ID or staging schema.** The contracts and
  retailer identities are incompatible and could silently corrupt semantics.
- **Start ingestion in the OAuth callback.** Authorization is not consent to
  import data and violates the explicit product requirement.
- **Use one generic `after` paginator.** Several current endpoints use different
  traversal state and would skip, duplicate, or loop.
- **Convert cursors, IDs, money, or quantities to JavaScript numbers.** This
  loses identity or decimal precision.
- **Expose only curated wide tables.** Thousands of documented nested fields
  would become unanswerable and additive API fields would disappear silently.
- **Treat raw JSON alone as a semantic layer.** Data would be retained but not
  typed, searchable, governed, or safe to aggregate.
- **Request write scopes for analytical convenience.** Least privilege takes
  precedence; write-scoped reads require an explicit separate decision.
- **Claim live validation from fixtures.** Fixtures prove code paths, not the
  current behavior of a real retailer account.

## Official source of truth

- <https://x-series-api.lightspeedhq.com/llms.txt>
- <https://x-series-api.lightspeedhq.com/openapi/api-2026-07.yaml>
- <https://x-series-api.lightspeedhq.com/docs/quick_start>
- <https://x-series-api.lightspeedhq.com/docs/authorization>
- <https://x-series-api.lightspeedhq.com/docs/scopes>
- <https://x-series-api.lightspeedhq.com/docs/pagination>
- <https://x-series-api.lightspeedhq.com/docs/rate_limiting>
- <https://x-series-api.lightspeedhq.com/docs/dates_and_times>
- <https://x-series-api.lightspeedhq.com/docs/versioning-strategy>
- <https://x-series-api.lightspeedhq.com/docs/2026-07-release-notes>
- <https://developers.lightspeedhq.com/terms>

The pinned inventory records:

- official bulk OpenAPI SHA-256:
  `123b2630178c376990dd7219f92e068e5f77ac9cd991a80e0fafa97ad8613dd7`;

- official index SHA-256:
  `b2b10867c8ad96aefb1d10edbfc07d8e8ad2c54825f1a88233b19babb6b694e4`;
- sorted official page-manifest SHA-256:
  `39a254a4c51bd8c9dbc015868fb84886e499e36ab197bcb72dfe75bba9754fdf`;
- canonical merged OpenAPI SHA-256:
  `51170855ec69622e0fb1556cfd1af1144e8ab720455c75b88b01d8d465899865`.
