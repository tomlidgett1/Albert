# ADR 0027: Progressive dependency barriers and qualified readiness

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert engineering

## Context

Albert makes a recent slice useful while a connector's full-history backfill is
still running. The original lifecycle treated a completed recent transform as
sufficient evidence for the whole connector. That was unsafe for paginated
streams: a sale could transform before a later page of its product, customer,
shop, tax, employee, or payment-type master. The resulting nullable canonical
reference looked legitimate and could remain null after the master arrived.

Readiness also used canonical table names as product domains and tenant-global
connector health. An unrelated failed Xero account could therefore block a
Lightspeed sales Topic, while a partially transformed sales stream could claim
an imprecise recent range. Reconciliation was not guaranteed to start at the
transition from partial to queryable coverage.

## Decision

### Declared dependency graph

- Every connector stream declares its stream dependencies and its user-facing
  product domains separately from canonical targets. Dependencies form an
  acyclic graph and must be present in each sealed recent plan.
- Extraction and staging remain parallel. A transform job can be claimed only
  after its extraction phase is terminal and every declared dependency is
  queryable or superseded for the same connection generation.
- Snapshot master streams fetch the complete snapshot during the initial
  backfill. Pagination is a transport detail: a stream becomes queryable only
  when every page in that phase has transformed successfully.
- A real non-null source reference whose master has not resolved is retryable,
  not rewritten as null. Only an actually absent source reference may produce
  a nullable canonical foreign key.

### Exact progressive coverage

- `progressive_stream_coverage` records coverage per tenant, connection,
  generation, phase, and stream. The semantic runtime sees only the current
  connection generation.
- Recent coverage becomes `queryable` only after all pages and dependencies
  complete. Its interval is the exact intersection of the successful stream
  ranges and is labelled as qualified partial history. Full history supersedes
  the partial row.
- A product domain is ready only when every required stream assigned to that
  domain is queryable or superseded. Optional unavailable streams degrade their
  own coverage but do not block an otherwise complete required domain.
- Semantic queries evaluate the union of Topic and selected-metric
  capabilities for every effective authority contributor. Pending, degraded,
  missing, or out-of-range coverage blocks; in-range queryable coverage emits
  a bounded-history warning; superseded coverage permits the query.

### Scoped health and reconciliation

- Topic health is computed from the connection/stream contributors for its
  required capabilities and effective source authority. Failures in unrelated
  providers or non-contributing accounts cannot block the Topic; a missing
  required contributor fails closed.
- Readiness has two explicit quality tiers. Cursor integrity, OAuth scope,
  schema/enum drift, and every canonical/domain invariant block both tiers.
  Vendor-retention proof, webhook-gap recovery, and delete reconciliation are
  disclosed limitations while an exact recent range is still backfilling, so
  they produce `ready_partial` plus Qualified answers. They remain mandatory
  gates for `ready_complete`; an incomplete or failed result can never be
  promoted merely because recent coverage was queryable.
- Each canonical commit and readiness outbox entry carries both evaluated
  statuses. The control cell selects between them using its generation-fenced
  stream cursors and phase ledger; it never trusts a transform batch's local
  `backfill_complete` flag to decide the tenant's current tier. The completion
  transition also re-applies the complete-quality gate, so a later incremental
  or reconciliation batch cannot accidentally promote a qualified domain.
- Immutable page observations remain page diagnostics. Current Topic health is
  calculated from the latest connection generation's durable stream state
  (cursor chain, completion boundary, reconciliation totals, and unresolved
  quarantine/drift counters). A page-local "not observed" warning therefore
  cannot keep a Topic Qualified after full history and reconciliation become
  durably green, and a superseded generation cannot lend health to a reconnect.
- When every required recent stream reaches queryable or superseded state, the
  lifecycle atomically records and enqueues one reconciliation request for that
  connection generation. Retries are idempotent and generation fenced.

## Consequences

- Canonical facts cannot get ahead of their master data merely because workers
  run concurrently or a later page has not arrived.
- The UI can truthfully distinguish qualified recent coverage from completed
  history and disclose the exact available range.
- Domain readiness and Topic health now describe product concepts and actual
  authoritative contributors instead of physical tables or tenant-global
  failures.
- Bounded recent data can reach honest `ready_partial` without weakening the
  complete-readiness gate, and connector health can recover monotonically from
  disclosed partial limitations to Verified evidence.
- Reconciliation begins immediately at the first safe progressive-readiness
  boundary and remains one-shot under worker retries and crashes.

## Alternatives considered

- Use stream priority without a dependency graph: rejected because priorities
  do not prove that every page of every master transformed.
- Transform facts first and repair null references later: rejected because it
  publishes silently incomplete canonical data and makes repair correctness a
  second distributed workflow.
- Mark recent coverage ready after the first successful page: rejected because
  it overstates both the range and the population.
- Gate every Topic on tenant-global connector health: rejected because an
  unrelated source is not evidence about the requested authoritative data.
- Reuse canonical target names as product domains: rejected because storage
  layout is not a stable or user-facing readiness contract.
