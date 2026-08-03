# ADR 0026: Replay-healed quarantine and executable domain invariants

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert engineering

## Context

Quarantine is a resumable correction lane, not a permanent poison flag. A row
that failed an older source schema or mapper can become valid after a reviewed
mapping release and raw replay. Albert stores its analytical quarantine and a
sanitised control-plane index in separate databases, so healing must survive a
crash between those commits. A broad control-plane `UPDATE` grant would make the
sync runtime able to hide unrelated failures.

The V1 quality names also need executable meanings. `line_maths` previously
checked arithmetic inside each line but not line totals against the order
header or refund reversal evidence. `observation_coverage` accepted 99% of
orders with any relationship and ignored order lines, payments, and refunds.
`stock_continuity` only counted negative snapshots. Those measurements could
show green while canonical numbers or lineage were incomplete.

## Decision

### Quarantine recovery

- Landing classifies the entire page before writes. If any copy of a source
  identity remains invalid, no prior quarantine for that identity can resolve.
- Once a source row and its typed staging projection commit successfully, all
  open analytical quarantine findings for the same tenant, connection, stream,
  object type, and source record are marked `resolved` in that transaction.
  The replay sync run and fixed `validated_replay` reason are retained.
- The landing result returns a deduplicated set of healed identities. An
  idempotent replay of an already committed batch re-reads its healed identities
  so a crash after the analytical commit cannot strand the control mirror.
- Control-plane healing is exposed only through
  `resolve_quarantine_items`. It validates the exact active queue attempt,
  worker identity, connection generation, deletion fence, job stream, bounded
  exact-shape identity list, and one-use sync write permit. The runtime receives
  no table-wide update privilege.
- The next connector stream-health snapshot recomputes open current-generation
  quarantine counts. A successful corrected replay can therefore restore
  health; history remains queryable as resolved evidence.

### Executable invariant definitions

- `line_maths` measures line component arithmetic, order-header versus line
  totals, refund component arithmetic, and exact `reversal_of` evidence to the
  original order line. Component tolerance is 0.0001 and header tolerance is
  0.01 in the row currency.
- `observation_coverage` is 100% or failed. Orders and lines require an explicit
  `authoritative` observation bridge plus matching immutable canonical record
  state. Payments and refunds require matching canonical record state and the
  effective-dated `operational_sales` authority used when the fact was written.
- `stock_continuity` measures negative balances, missing dates between observed
  daily snapshots, and movement-versus-balance reconciliation between
  consecutive snapshots. Movement reconciliation runs only when the current
  inventory-log stream has complete, cursor-valid, quarantine-free evidence.
  Gaps or reconciliation mismatches fail; a negative balance warns.

## Consequences

- Corrected raw replay is operationally recoverable without deleting audit
  history or asking an operator to mutate both databases by hand.
- A stale worker, wrong stream, deleted tenant, or fabricated source identity
  cannot clear control-plane quarantine.
- Quality status now reflects exact commerce lineage and cross-row arithmetic,
  rather than row-local or percentage proxies.
- Inventory movement checks deliberately remain unavailable until the connector
  proves a complete stream; the result details expose how many pairs were
  actually reconciled.
- Mapper fixes still require governed replay. Albert never silently reclassifies
  an old invalid payload merely because code was deployed.

## Alternatives considered

- Delete quarantine rows after replay: rejected because it destroys evidence.
- Resolve through a broad sync-runtime table grant: rejected because one worker
  could hide another stream or tenant's failure.
- Keep 99% coverage and warning-only arithmetic: rejected because the named V1
  invariants are release gates, not sampling metrics.
- Infer continuity from non-negative stock alone: rejected because missing
  daily observations and unexplained balance changes are independent failures.
