# Momence connector

Production, read-only Momence Public API v2 ingestion for yoga, fitness and
wellness studios. The exact official OpenAPI bytes retrieved on **2026-08-12**
are pinned in `spec-lock.ts`; the generated operation/field census must be
regenerated and reviewed whenever that hash changes.

Official sources:

- [Developer Hub](https://api.docs.momence.com/)
- [OpenAPI schema](https://static.momence.com/schema/api-v2-schema.yaml)
- [Authentication](https://api.docs.momence.com/docs/getting-started)
- [Authorization](https://api.docs.momence.com/docs/authorization)
- [Terminology](https://api.docs.momence.com/docs/terminology)

## Lifecycle

OAuth authorization never starts ingestion. The manifest's manual initial-start
policy stores the grant and leaves the connection in `awaiting_manual_start`.
An owner or manager presses **Start ingestion** to activate the current
connection generation and enqueue the first backfill. A reauthorization is a
new generation and requires a new explicit start.

Only the authorization-code and refresh-token grants are implemented. The
documented password grant is forbidden. Refresh-token rotation is persisted
under the shared lease/compare-and-swap protocol, using Momence's documented
absolute expiry fields.

## Data graph

The connector reads profile, members, membership plans, appointments, sessions,
session details/bookings, member histories, active bought memberships, notes,
tags and member-host public locations/catalogues. Experimental sales and
payment-transaction detail are optional and fail visibly when Momence support
has not enabled them.

Every source entity lands as an exact immutable payload and a typed field index.
The curated CubeCore views cover common studio questions; the exhaustive source
explorer covers every documented returned scalar, including nested arrays and
custom fields. Request-only/write-operation fields are catalogued as
unobservable rather than being misrepresented as store data.

Momence publishes no global bought-membership or payment-transaction list, so
these endpoints fan out from members and transaction ids referenced by member
notes respectively. `HostSaleDto` does not expose the transaction id. It also
publishes no general updated-since cursor, so routine time windows are backed by
progressive historical backfill and two-pass window verification. Absence from
a time window or from the currently note-discoverable transaction population is
never interpreted as deletion; cancellation remains an explicit source state.

## Rate and environment constraints

Momence publishes no general API request limit. Albert conservatively permits
one active request per connection in each worker process and uses a shared,
burst-one reservation of two request starts per second across worker replicas.
It honours `Retry-After` and uses bounded full-jitter retries. Report APIs are
not part of automatic ingestion; their documented limits are 100 report
creations and 1,000 report retrievals per day.

Fan-out keeps a bounded, credential-versioned cache of parent/member/note pages
for the current traversal. This avoids requesting the same 100- or 200-record
parent page once per child while preserving a fingerprint fence across durable
cursor resumes.

Every extracted entity is checked against one of 17 generated response
contracts derived from the pinned OpenAPI. Required/type/enum failures and
undocumented keys retain exact raw JSON and hash evidence but do not enter typed
staging until the contract drift is reviewed.

No official sandbox, test server or developer test account is documented. CI
therefore uses schema-derived mocks. A live smoke test is permitted only through
the normal OAuth flow against an explicitly authorised disposable host; secrets
remain in the platform secret stores and are never pasted into chat or fixtures.

| Variable | Where |
| --- | --- |
| `MOMENCE_CLIENT_ID` | Vercel web + sync worker |
| `MOMENCE_CLIENT_SECRET` | Sync worker only |
