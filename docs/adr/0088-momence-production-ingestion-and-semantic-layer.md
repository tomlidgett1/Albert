# ADR 0088: Momence production ingestion and semantic layer

- Status: Accepted
- Date: 2026-08-12
- Owners: Data platform and product analytics

## Context

Momence Public API v2 is the source system for a yoga, fitness or wellness
studio's members, sessions, bookings, appointments, memberships and sales. The
official OpenAPI document currently has 60 paths, 74 operations and 200
reachable schemas. The previous Albert pack authorised an account but declared
no stream, staged no data and could not answer a Momence question.

The source contract has material constraints:

- its only documented server is `https://api.momence.com`; no sandbox or test
  account is published;
- host reads are implicitly scoped by the authorising staff user, but
  `AuthProfileDto` exposes no selected host identifier;
- page pagination starts at zero and exposes `totalCount`, with no general
  updated-since cursor;
- there is no global bought-membership list or payment-transaction list;
- host sales and webhooks are experimental/support-enabled;
- report creation and retrieval are daily-rate-limited, report creation needs a
  `hostId` that the API does not otherwise disclose, and report `details` is
  untyped;
- API money fields use multiple types and incompletely documented units.

Albert's product contract also requires OAuth authorization and first data
movement to be separate user actions. A connection must never start Momence
ingestion solely because OAuth succeeded.

## Decision

### Official source and exhaustive contract

Albert pins the exact first-party OpenAPI bytes, counts and digests. A
deterministic generator records all operations and every request/response leaf
in operation context. Every field is assigned one of four explicit outcomes:

1. ingested and queryable through the governed field index;
2. protocol metadata retained as sync evidence;
3. request-only and therefore not an observable store attribute; or
4. outside the safe store read boundary, with the API limitation recorded.

No schema, operation or field may disappear silently when the official
contract changes. Unknown live response fields retain their exact raw payload
but quarantine the typed projection until reviewed.

### Read-only store graph

The connector uses only documented GET operations. It never invokes checkout,
member mutation, tag mutation, booking/check-in, freeze, waiver, saved-payment
method or logout operations.

The required graph covers the authorising profile, host members, membership
plans, appointments, sessions, session details, session bookings, member
session/appointment histories, active bought memberships, and tags. Member
fan-out is required where Momence has no store-wide list. Member-host locations,
public plans/sessions, notes, experimental sales and payment-transaction detail
are optional and become fail-visible unavailable coverage when Momence or the
staff role does not expose them.

Every entity persists:

- the exact immutable vendor payload;
- stable source and parent identity;
- a compact curated projection for common analysis; and
- a long-form typed scalar index containing stable path, exact JSON pointer,
  array ordinal and typed value.

The long-form source explorer is the semantic completeness backstop. A user can
ask about any documented returned field without requiring a new physical SQL
column. PII classification and existing tenant/role controls still apply;
“answerable” does not mean unrestricted bulk disclosure.

### Pagination, reconciliation and rate control

Page completion follows `(page + 1) * pageSize >= totalCount`. Full pages must
advance their identity digest, and empty non-terminal pages block rather than
loop. Parent fan-out cursors carry parent page, parent index and child page so a
worker restart resumes without replaying the population.

Momence publishes no general modification cursor. Time-filterable operational
streams use fixed bounded windows for routine pulls and progressive backfill for
historical reach. Two-pass reconciliation proves stability within each window,
but absence from a window cannot prove deletion from the store. The same rule
applies to payment details discoverable only through current member-note links.
Those populations use `no_absence_deletes`; cancellations remain source states,
not tombstones. Webhooks may accelerate this only after Momence publishes or
enables a contract sufficient for secure installation; they never replace
polling completeness.

The production transition from the earlier authoritative policy is a guarded
data repair, not a metadata-only policy flip. It restores any inferred
tombstone's complete landing and typed lineage from committed immutable
staging, repairs Teacher/Location canonical state and deterministic source
links by counterfactually replaying valid transformed observations through the
same timestamp/version/hash/mapping admission rule as the runtime, invalidates
old snapshots, and fails closed when exact history or durable transform order
is unavailable. This deliberately ignores a later-timestamp identical replay,
which never claimed canonical state in normal operation. Control-plane and
analytical triggers fence queued pre-deployment workers from reapplying the
superseded tombstone after the cutover. The upgrade path is executed in CI on
PostgreSQL as the non-`BYPASSRLS` migration owner, including the case where a
later live pull has an older vendor timestamp than the synthetic tombstone.

All 17 extracted entity shapes are validated against generated, dereferenced
response contracts from the pinned OpenAPI. Missing required fields, wrong
types/enums and undocumented keys retain exact raw evidence but are quarantined
before typed staging. Fan-out also keeps a small credential-versioned cache of
the current parent/member/note pages so each parent page is reserved once per
in-process traversal instead of once per child; durable fingerprints still
fail closed if a page changes after a worker restart.

Because no general limit is documented, production permits one active request
per connection in each worker process and uses a burst-one durable shared
reservation of two request starts per second per connection across replicas.
HTTP 408/425/429/5xx responses use bounded full-jitter retries, a per-attempt
deadline and `Retry-After`; long cooldowns return to durable orchestration.
Reports are not generated automatically, so their 100/day creation budget is
not consumed by store ingestion.

### OAuth identity and manual activation

OAuth uses authorization code plus refresh-token rotation under the existing
credential lease/CAS protocol. Absolute `accessTokenExpiresAt` and
`refreshTokenExpiresAt` values from `AuthTokenDto` are authoritative; Albert
does not invent an `expires_in` field. `/api/v2/auth/profile` replaces the
non-existent `/auth/me` assumption.

The manifest declares `ingestion.initialStart = manual`. OAuth persists the
encrypted grant and account identity but enqueues no sync job. An owner or
manager must press **Start ingestion**. The dedicated same-origin, rate-limited
activation boundary atomically activates the current connection generation and
enqueues one recent coordinator. Reauthorization requires explicit activation
for the new generation. Later **Sync now** remains a distinct action.

The public API exposes only the stable authorising `userId`, not selected
`hostId`; the source account reference is therefore `user:<userId>`. This is an
explicit API limitation, never a guessed studio identity.

### Canonical and CubeCore modelling

Existing canonical identities are reused only where semantics match:

- member -> person and customer account;
- teacher -> worker identity (not an employment episode or shift);
- explicit member-host location -> location;
- membership plan -> product/product variant.

Sessions, bookings, attendance/check-ins, appointments, entitlement/credit
state and Momence sales remain governed native grains. The current canonical
model has no service-session, service-booking, attendance or membership-
entitlement facts, and a HostSale does not expose the location/currency evidence
required by core commerce facts. Coercing those records would create false
cross-source comparability. A future canonical service-operations extension
requires a separate ADR.

Several sessions or appointments in one API page may embed the same teacher or
location. Canonical dimension projection therefore reduces repeated native
identities with the same source-time/version/hash/mapping admission semantics
as sequential canonical state claims. Every mapped command remains auditable,
while only the deterministic final admissible value is materialized for each
canonical identity; a repeated teacher or studio must never make an otherwise
valid batch untransformable.

CubeCore exposes curated member, schedule, attendance, appointment, membership,
sales/payment and instructor questions plus the exhaustive source explorer. AI
context distinguishes booked from attended, booking cancellation from session
cancellation, plan from active entitlement, credit balance from inventory,
sale value from captured cash, and refund date from service date. Currency is
never aggregated without currency context, and native grains are not raw-joined
before independent aggregation.

## Consequences

- Momence becomes a production ingestion connector rather than an OAuth-only
  placeholder.
- Every official API field has a checked disposition, and every safe
  store-readable leaf is queryable.
- Source limitations produce honest unavailable/partial answers instead of
  synthetic zeros.
- Initial ingestion is an explicit, auditable user decision.
- The connector makes more requests than a flat list integration because the
  official API requires fan-out; conservative budgets trade latency for vendor
  safety.
- Live vendor acceptance cannot run without an explicitly authorised Momence
  host because no official sandbox exists. Schema-derived mocks are the
  default CI contract, and credentials remain exclusively in the existing
  secret/configuration path.

## Sources

- [Momence Developer Hub](https://api.docs.momence.com/)
- [Official OpenAPI schema](https://static.momence.com/schema/api-v2-schema.yaml)
- [Authentication](https://api.docs.momence.com/docs/getting-started)
- [Authorization](https://api.docs.momence.com/docs/authorization)
- [Terminology](https://api.docs.momence.com/docs/terminology)
- [Webhook basics](https://api.docs.momence.com/reference/outoging-webhooks)
- [Webhook events](https://api.docs.momence.com/reference/webhooks-reference)
