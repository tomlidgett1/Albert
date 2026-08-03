# ADR 0025: Durable cross-database semantic promotion relay

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert platform
- Relates to: ADR 0002, ADR 0004, ADR 0017, ADR 0022

## Context

Every `run_source_query` use must file a promotion candidate in the control
plane semantic inbox. The semantic query service originally inserted only
`semantic_internal.promotion_candidate_outbox` in the analytical cell and
returned its id. Nothing consumed that outbox. A user-visible result could
therefore claim the field was filed while no operator could review it.

The analytical and control databases cannot participate in one atomic
transaction. A process can stop after control-plane acceptance but before the
analytical published marker, so ordinary retries can double-increment an inbox
occurrence. Recovery also cannot enumerate analytical tenants globally: RLS
requires a signed tenant capability, and a generic cross-tenant analytical
credential would violate ADR 0022. Tenant or connection deletion can begin at
any point in the relay.

Promotion evidence must not retain a raw customer question. The question may
contain personal information or commercially sensitive language even when the
explored field itself is safe.

## Decision

Albert uses a transactional-inbox relay with candidate-id idempotency.

The analytical cell remains the source outbox. Migration 0084 adds:

- a canonical SHA-256 candidate digest over structured identifiers only;
- bounded lease owner, token, expiry, attempt, next-attempt and safe error-code
  fields;
- fixed enqueue, claim-one, claim-due, complete and fail procedures; and
- an exact-login readiness procedure.

`semantic_meta_rw` loses direct access to the outbox. Every procedure verifies
an `analytical:semantic-metadata` capability, uses its signed tenant claim, and
takes the shared deletion advisory lock. Conversation-time enqueue additionally
requires the capability's exact conversation and running-turn evidence. The
recovery path receives a capability only from a control-plane tenant scan lease.

Migration 0043 adds an idempotent delivery ledger in the control plane. The
accept procedure:

1. requires the exact `albert_semantic_control_runtime` login;
2. recomputes and compares the analytical candidate digest;
3. locks the active tenant and exact connected/degraded source connection and
   rejects an active tenant- or connection-deletion request;
4. serializes by a fingerprint of connection, connector, source table, sorted
   source fields and optional requested metric concept;
5. inserts one `(tenant_id, candidate_id)` delivery receipt; and
6. creates or increments the matching semantic inbox item only after that
   receipt is new.

An exact replay returns the original inbox item and does not increment
`occurrence_count`. Reusing a candidate id with changed content fails. A crash
after control acceptance is therefore recovered by replaying acceptance and
then marking the analytical row delivered. There is no distributed
transaction and no exactly-once network delivery claim; the durable business
effect is exactly once through idempotent acceptance.

The synchronous source-exploration path enqueues, accepts and acknowledges the
candidate before returning `promotionCandidateId`. If any boundary is not
durably complete, the tool request fails closed and does not claim filing. Its
outbox row remains recoverable.

For restart recovery, the control plane owns a narrow per-tenant scan ledger.
The exact semantic runtime claims a bounded set of active tenant ids under
expiring leases. Each claim returns a short-lived signed analytical capability
bound to that tenant, worker and scan token. The worker drains only that
tenant's RLS-visible outbox rows, with bounded batches and exponential retry
delays. It never receives a global analytical RLS bypass. Expired leases make
process loss recoverable, and replica-qualified worker ids prevent one machine
from completing another's lease.

The control inbox stores field identifiers, connector/connection ids, a
question digest and the optional governed metric concept. It stores no raw
question. Audit entries record one durable acceptance per candidate and assert
that question content was not persisted. The operator console exposes bounded
candidate and relay-health metadata, with its existing internal-operator gate
and audited drill-down. Analytical outbox state remains diagnostic-only.

Connection deletion removes analytical outbox rows and invalidates the
tenant-wide control semantic inbox as already required for derived artefacts;
the delivery ledger cascades with it. Tenant deletion removes both scan and
delivery ledgers. Analytical connection verification now includes any residual
promotion outbox row.

## Consequences

- Source exploration has a real, operator-visible promotion workflow rather
  than an orphaned analytical insert.
- A control-plane receipt can exist briefly while its analytical row is still
  leased; replay is expected and safe.
- Control-plane availability is part of source exploration's success boundary.
  Governed semantic queries are unaffected.
- Background recovery scans active tenants, even when no new source query is
  running, but can see only tenant ids and only through an exact-login lease.
- The relay intentionally retries safe structured metadata; it never retries
  or stores a raw prompt or customer result row.
- Readiness fails when either relay migration, exact role binding, or the
  analytical capability key boundary is unavailable.

## Rejected alternatives

- **Return after the analytical insert:** this repeats the original false
  filing claim and leaves recovery undefined.
- **Write the control inbox first without a delivery ledger:** a crash before
  the analytical marker double-counts the next replay.
- **Mark the analytical row before control acceptance:** a lost control write
  becomes permanently invisible to operators.
- **Use a global analytical scan role or disable RLS:** this turns one service
  credential into a cross-tenant data capability.
- **Store the sample question:** a digest is sufficient for idempotency and
  correlation; retaining the source text creates unnecessary APP 8 exposure.
- **Use an in-memory queue:** it cannot recover a process or deployment loss
  and has no deletion or idempotency proof.

## Verification

- `tests/contracts/semantic-promotion-relay.contract.test.ts`
- `services/semantic-query/promotion-relay.test.ts`
- `tests/sql/control-plane-semantic-promotion-relay.sql`
- `scripts/test-analytical-capability-boundary.ts`
- `tests/contracts/source-exploration-security.contract.test.ts`
