# ADR 0029: Record-scoped canonical recovery and effective-dated source grains

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert engineering
- Extends: ADR 0026 (replay-healed quarantine and executable domain invariants)

## Context

Typed staging proves that a vendor payload matches the reviewed source-field
contract. It does not prove that every record contains the business fields
needed for a canonical fact. Real accounts can contain an otherwise valid Xero
invoice with no issue date, a Lightspeed sale whose shop reference is null, or
a negative sale line with no original-line reference. The canonical mapper
previously flattened the whole batch in one expression. One such record threw
before any peer record could commit, so retries could poison a stream forever.

Two source grains also needed explicit ownership:

- Deputy's Employee resource is a mutable person/worker record, while an
  employment episode is one continuous effective interval. Keying both by the
  Employee ID overwrote termination history when that person was rehired.
- Lightspeed exposes purchase-order lines both embedded on `Order` and through
  `OrderLine`. Only the parent Order carries its supplier reference, shop,
  lifecycle dates, status, and currency. The referenced supplier is a separate
  `Vendor` resource. Letting both line projections replace the same fact made
  the final row depend on stream arrival order; omitting Vendor ingestion made
  a valid non-empty `vendorID` fail canonical reference resolution.

## Decision

### Canonical record isolation and recovery

The typed source row is the atomic mapper boundary. Lineage is checked before
the boundary and remains a batch-fatal invariant. Each mapper invocation then
produces either a non-empty command set or a sanitised canonical rejection.
Rejected rows are written through a narrow transform-only function into the
existing analytical quarantine ledger, bound to the exact tenant, connection,
sync run, immutable raw batch, stream, source identity, payload hash, and
mapping version. Valid peer rows continue through the canonical transaction.

A transform commit records both staged and mapper-quarantined row counts. The
`canonical_mapping_total` quality check passes with no open canonical
rejections, warns when a partial batch remains recoverable, and blocks when
every staged row in the batch is rejected. A readiness watermark is derived
only from accepted rows.

Landing may heal typed/schema quarantine, but it cannot heal a
`canonical.*` rejection. A later raw replay resolves that rejection only after
all canonical commands for the corrected source row have succeeded in the same
analytical transaction. A rollback therefore leaves both the rejection and
the previous truth intact. History is retained as a resolved row with the
recovery sync run; no operator deletes evidence and no runtime receives broad
write access to the ingestion schema.

### Deputy episode identity

Deputy still maps one stable `person` and `worker` from Employee ID. It maps an
`employment_episode` from Employee ID plus the source-reported effective start
date. The canonical interval trigger closes an earlier open episode when a
later episode starts and bounds an out-of-order earlier episode at the next
known start. A tenant/worker/start unique index enforces the declared grain.

Roster, timesheet, and leave facts resolve the source-owned worker's episode on
their business date. They do not point at a mutable "current episode" key and
do not materialise identity-merge decisions into facts.

### Lightspeed purchase-order authority

`Order.json` with the requested `OrderLines` relation is the sole
materialising source for `purchase_order_line`. The standalone `OrderLine`
stream remains a typed identity and reconciliation stream. Active rows emit
metadata only, so they cannot replace complete facts with null header fields;
verified tombstones emit a narrow update-only cancellation against the same
native line identity. The final complete fact is therefore identical whether
the active standalone row arrives before or after its parent order.

`Vendor.json` is a required typed stream under the documented
`employee:vendors` grant. It maps each source Vendor to `core.supplier` and
records only connector-namespaced external identity plus a reviewable
normalised-name hint. `orders` declares `vendors` as a dependency, so a
purchase order can resolve its non-empty `vendorID` to the exact source-owned
supplier before line facts materialise. The resolver remains fail-closed: a
dangling vendor reference is quarantined as an integrity defect and is never
silently rewritten to null.

## Consequences

- One malformed business record no longer stalls valid peers or causes an
  unbounded retry loop, while every omission remains visible and qualified.
- Mapper fixes are deployable through immutable raw replay and produce an
  auditable recovery transition.
- A terminated and rehired worker has two non-overlapping episodes against one
  stable worker/person, so historical workforce facts retain their correct
  interval.
- Purchase-order facts retain supplier, location, dates, status, and currency
  deterministically across stream scheduling and retries.
- Supplier attribution is backed by an independently ingested Vendor row;
  archived Vendors remain historically resolvable but become inactive.
- Systemic failures outside the mapper boundary (tenant lineage, authority,
  capabilities, database contracts, and transaction execution) still abort
  the batch and remain retry/fail-closed concerns.

## Alternatives considered

- Retry the whole batch forever: rejected because one permanently malformed
  source row prevents unrelated valid records from becoming queryable.
- Skip mapper errors without durable evidence: rejected because readiness and
  governed answers would silently overstate coverage.
- Resolve canonical failures during typed landing: rejected because typed
  validity does not prove that canonical commands committed.
- Key an employment episode by Employee ID: rejected because rehire mutates
  history instead of creating the required effective-dated grain.
- Merge partial `OrderLine` fields into the fact: rejected because conflicting
  endpoint timestamps and absent header fields make arrival order observable.
- Treat an unresolved nullable supplier reference as null: rejected because
  `nullable` permits an absent source value, not the silent loss of a supplied
  `vendorID`.
