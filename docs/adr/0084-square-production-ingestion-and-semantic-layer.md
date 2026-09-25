# ADR 0084: Square production ingestion and exhaustive semantic coverage

- Status: accepted
- Date: 2026-08-12
- Owners: Data platform and product analytics
- Supersedes for Square only: the automatic post-OAuth start described in
  `docs/albert-v1-spec.md` sections 2 and 17

## Context

Square is a broad operational system, not only a payment processor. A seller
can reasonably ask Albert about orders and item modifiers, payments and fees,
refunds, catalogue history, inventory states, customers, loyalty and gift
cards, cash drawers, payouts, staff timecards, bookings, invoices,
subscriptions, disputes, devices and online channels.

The prior Square pack deliberately stopped at OAuth. It declared no stream and
therefore made no false data-coverage claim, but a successful connection could
not answer a Square question. The product requirement now is production-grade
ingestion with an explicit user start and a semantic escape hatch for every
readable source field.

Square versions API behaviour through the `Square-Version` header. The current
reference and official Node SDK release used for this decision correspond to
`2026-07-15`. Square documents additions of optional response fields and enum
values as compatible changes. Cursor values are traversal tokens, generally
short-lived, rather than durable incremental state. Money amounts are signed
integers in a currency's minor unit. Webhooks are at-least-once, can arrive out
of order, and are accelerators rather than completeness evidence.

## Decision

### Versioned read contract

The connector pins `Square-Version: 2026-07-15` on every source and OAuth
request. A committed spec lock and field census are generated from the
version-matched official SDK and checked against the live official endpoint,
object and enum references. CI fails when a pinned-SDK field or selected read
surface lacks a disposition. Upgrades are explicit connector-pack releases.

The selected seller-readable APIs are declared as data, including HTTP method,
endpoint, response root, pagination placement, stable time strategy, required
scope, availability, authority and dependencies. Required retail/cafe streams
fail the run when unavailable. Product- or region-gated streams are optional
and publish durable unavailability instead of retrying forever.

### Raw, staged and semantic shape

The exact response object is retained in immutable raw storage before mapping.
Each source entity stages:

1. reviewed native fields used for canonical and curated Square analysis;
2. `payload_json`, preserving its complete source-native object; and
3. `field_index`, a typed list of every scalar occurrence with its stable
   array-insensitive field path, exact RFC 6901 pointer, ordinal, native value
   type and typed scalar value (including distinct markers for an explicitly
   empty array and explicitly empty object).

The versioned field census maps every documented path to either a canonical
target, a governed extension through that typed field index, or a named
unobservable reason. An additive field returned before the next SDK review is
immediately represented in `field_index` and is reported as detected schema
drift; it is not silently dropped. Dynamic maps and custom-attribute keys are
represented as native key/value paths. The immutable payload remains the
replay authority.

Common, source-neutral concepts map into the existing canonical model:
merchant/location, products and variations, customers, team members, orders
and lines, payments, inventory observations, timecards and planned shifts.
Square-specific concepts stay in governed Square views until a genuinely
cross-source canonical grain exists. In particular, payouts are not bank
transactions, payment refunds are not fabricated line-item returns, gift-card
issuance is not revenue, and timecards are not planned shifts.

CubeCore exposes curated retail/cafe views at declared grains plus a searchable
Square native-field view. Common questions use certified measures; unusual
questions resolve an exact field path at its source grain. Array-valued
children never join implicitly across sibling grains. PII and financial
identifiers remain governed and are not surfaced in ordinary answers by
default.

### Money, time and identity

Square `Money.amount` is preserved as an exact integer base-unit string. Curated
conversion uses only the explicit intersection of the pinned Square Currency
enum and the official current ISO 4217 list entries with numeric minor units.
An unknown, historical-without-current-minor-unit, metal, accounting, test,
crypto or future code yields a null curated money value while its raw amount
and code remain queryable; no fallback exponent is guessed. Values of different
currencies never aggregate. Decimal-string quantities and rates do not pass
through IEEE floating point. Curated location-grain CubeCore dates
derive from the joined Square Location IANA timezone, including daylight-saving
transitions, and exclude rows when a valid location timezone is unavailable
rather than silently using UTC. The canonical mapper currently receives a
validated tenant timezone rather than a per-row source location timezone;
multi-timezone merchants therefore carry an explicit canonical limitation
until location timezone is added to canonical mapping context. Historical
order-line names and prices remain the sale snapshot and are not overwritten
with the current catalogue record.

Durable identities are seller merchant ID plus source object type and source
record ID. Nested records use the Square UID/ID when present and otherwise a
parent identity plus path/ordinal. Hashes are evidence, never the first choice
for a mutable source identity.

### Restart-safe extraction and reconciliation

Durable cursors contain stable time windows, location/fan-out position and
source high-water marks. Vendor cursor tokens may be used only to continue the
same traversal. If one expires, the bounded stable window restarts and lands
idempotently. Every page repeats its original filters exactly and rejects a
non-advancing cursor. Orders overlap by at least 72 hours to include offline POS
arrivals; APIs without a reliable updated filter receive complete snapshot or
bounded-window reconciliation.

A bounded reconciliation window is never absence evidence for all staged
history. Time-windowed streams, and child fan-outs whose parent IDs came from a
time window, cannot emit inferred tombstones. They retain identities unless
Square returns an explicit soft-delete field. Only a complete current-list
traversal can use authoritative identity-scan retirement.

The connector contract therefore distinguishes mutable reconciliation without
absence authority (`no_absence_deletes`) from genuinely immutable event streams
(`immutable_append_only`). The former still permits modified-field and full
snapshot late-edit replacement. Its `count_distinct_bounded_scan` total is the
population observed inside the declared window, not an all-history source
total. Durable reconciliation records that evidence but never compares it with
the entire landed population; both database planes reject the unsafe pairing
of `authoritative_identity_scan` with a bounded total.

`429` responses use bounded exponential backoff with full jitter and honour
`Retry-After`; requests have hard deadlines and pass through the durable
per-connection rate budget. Bulk HTTP 200 responses are inspected for
item-level errors. Square webhooks are unavailable until the isolated gateway
can verify the exact configured notification URL plus raw request bytes with
the application-owned signature key. The connector therefore fails webhook
handling closed; polling and scheduled reconciliation own completeness.

### Manual first ingestion

Square declares `ingestion.initialStart = manual`. OAuth stores and refreshes
the seller grant, discovers the merchant and creates the connection, but does
not enqueue extraction. The connection persists an `awaiting_manual_start`
state enforced at the central queue boundary, so incremental schedulers,
reconciliation, webhooks, process restarts and configuration changes cannot
start data movement accidentally.

An owner or manager starts ingestion through a same-origin, tenant-scoped,
rate-limited action. The activation and progressive recent-first coordinator
enqueue are one idempotent transaction under a connection lock. The UI shows a
high-contrast 36px pill action, “Start ingestion”, and explicitly says that no
data has been imported. After activation the existing “Sync now” path remains
available. Reauthorisation does not reset a previously activated connection.

## Consequences

- A connected Square store remains inert until its user acts, including under
  background schedulers.
- Common Square questions use stable canonical or curated measures; every
  unusual documented leaf remains discoverable and queryable at native grain.
- Complete raw retention and a typed field index make additive Square changes
  replayable without pretending unreviewed fields are certified measures.
- The connector incurs extra storage and catalogue-search cost. CubeCore uses
  progressive field discovery rather than injecting the entire Square field
  catalogue into every model prompt.
- Optional Square products can be absent without blocking core sales coverage,
  but their absence is visible in readiness and answer caveats.
- Production release requires Square schema RLS/grants, deletion coverage,
  runtime credential contracts, OAuth/manual-start tests, transport fixtures,
  canonical invariants and semantic question evaluations.

## Rejected alternatives

- **Automatically start after OAuth.** This violates the explicit product
  requirement and cannot be repaired by UI wording.
- **Suppress only the OAuth enqueue with an environment variable.** Later
  schedulers could still start ingestion, and a deployment change would alter
  tenant behaviour.
- **One opaque JSON column.** Raw data would exist but uncommon fields would
  not be discoverable, typed or safely answerable.
- **A physical SQL column for every transitive SDK field.** Thousands of nested
  array/map paths would produce unstable tables and unsafe mixed grains.
- **Use webhooks as the ledger.** Delivery ordering and retention do not prove
  completeness.
- **Treat payments, order totals and payouts as interchangeable revenue.** This
  double-counts economic events and destroys settlement reconciliation.

## Source of truth

- <https://developer.squareup.com/reference/square>
- <https://developer.squareup.com/docs/oauth-api/square-permissions>
- <https://developer.squareup.com/docs/build-basics/versioning-overview>
- <https://developer.squareup.com/docs/build-basics/common-api-patterns/pagination>
- <https://developer.squareup.com/docs/build-basics/common-data-types/working-with-monetary-amounts>
- <https://developer.squareup.com/docs/build-basics/general-considerations/handling-errors>
- <https://developer.squareup.com/docs/webhooks/overview>
- <https://developer.squareup.com/docs/events-api/overview>
