# ADR 0057: Bounded identity candidate generation

- Status: Accepted
- Date: 2026-08-04
- Owners: Albert platform
- Related: ADR 0056 (multi-page InitialBackfill claims), ADR 0058
  (set-based transform pages), Albert v1 sections 11 and 17

## Context

The first multi-page Lightspeed dogfood backfill exposed a transform-side
failure that extraction could not reveal. Every committed page invoked tenant-
wide identity candidate generation, including fact-only pages. The matcher
materialized all active observations and self-joined them behind JSONB `OR`
predicates.

With 4,588 observations from one Lightspeed connection, a cross-source identity
candidate was impossible. PostgreSQL nevertheless evaluated the quadratic plan,
spilled roughly 4.8 GB of temporary data for one attempt, and reached the
five-minute statement timeout. The whole 100-row canonical page then rolled
back and retried after thirty seconds.

## Decision

Identity review semantics remain the conservative v1 ladder: shared external
ID, exact deterministic key, then normalized name with a source-neutral
corroborating scope. Candidate generation changes only its execution strategy:

1. Return immediately unless at least one entity type has active, linkable
   observations from two source connections.
2. Flatten own and explicitly associated deterministic evidence once, excluding
   any key with conflicting values.
3. Build external, deterministic, and composite pairs with equality joins,
   preserving strongest-method precedence without a cross-product `OR` filter.
4. Index canonical source identity lookup used to attach source-owned entities.
5. Invoke reconciliation from a transform page only when that transaction
   persisted an identity hint. Identity-decision projection still reconciles
   immediately because an accepted location association can unlock worker
   suggestions.
6. Persist PostgreSQL `57014` as bounded `database_statement_timeout` evidence
   and back off for five minutes if a future query exhausts its statement
   budget.

## Consequences

- Single-source tenants perform one bounded tenant/index scan and return zero.
- Multi-source matching scales with observations, flattened evidence, and real
  equality matches rather than all possible observation pairs.
- Identity matching remains tenant-local, source-neutral, deterministic,
  reversible, and review-only; no probabilistic matching is introduced.
- Fact-heavy backfill pages no longer pay for unrelated identity reconciliation.
- A page performs bounded set operations instead of one database round trip for
  each independent row mutation; this matters because Fly and analytical
  Postgres are separated by several milliseconds even in the same region.
- A SQL regression fixture reproduces 5,000 single-source observations under a
  500 ms statement budget.
