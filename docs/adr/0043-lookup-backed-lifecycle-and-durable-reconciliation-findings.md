# ADR 0043: Lookup-backed lifecycle states and durable reconciliation findings

- Status: Accepted
- Date: 2026-08-04
- Owners: Albert data platform and release engineering
- Relates to: ADR 0006, ADR 0011, ADR 0021, ADR 0026, ADR 0035

## Context

Albert's V1 contract requires lifecycle values to be represented by lookup
tables rather than PostgreSQL enums or isolated literal checks. This keeps a
state vocabulary inspectable, allows reviewed data migrations to extend it,
and prevents application code and database constraints from drifting apart.
Several later migrations introduced otherwise valid lifecycle columns with
`CHECK (status IN (...))` but without lookup foreign keys.

The same contract requires reconciliation variances above their governed
tolerance to become durable findings. The executable quality suite recorded
the aggregate `pos_ledger_tolerance` and `pos_bank_tolerance` results, but did
not materialise an exception in `quality.finding`. A warning could therefore
be observed through current health while leaving no durable finding for later
operator review.

## Decision

Every lifecycle `status` column is backed by a semantically named lookup table
and foreign key. A compatible existing lookup is reused only when it represents
the same lifecycle; otherwise a dedicated lookup is introduced. The obsolete
literal-only checks are removed after current values have been validated by the
new foreign key. PostgreSQL enums remain prohibited for these values.

`quality.record_check` invokes a migration-owned reconciliation materialiser in
the same transaction as its aggregate check result. The materialiser evaluates
each governed day/location row in `mart.reconciliation_aligned` and
`mart.settlement_reconciliation_aligned` against a lookup-backed policy: $1.00
for POS-to-ledger and $0.05 for POS-to-bank settlement.

A finding identifier is deterministic over tenant, check, and the mart's stable
day/location entity id. The run id is deliberately excluded, so retrying a run
or observing the same variance on the next nightly run updates one finding
rather than manufacturing duplicates. Evidence contains the business date,
internal location reference, currency where applicable, signed and absolute
variance, tolerance, and the bounded aggregate inputs needed to explain the
exception; it never copies source payloads.

Findings have a lookup-backed `open` / `resolved` lifecycle. Each materialisation
reopens or refreshes every current above-tolerance entity, then resolves open
entities no longer present in the current governed result. The first-observed
run remains immutable while last-observed and resolution run ids make the
lifecycle auditable. The transform runtime has no direct finding mutation
privileges; it can only invoke the tenant-checked mart materialiser. Reviewed
deletion procedures retain owner authority to erase findings when a tenant or
connection is purged.

The repository carries a contract test that rejects new literal-only lifecycle
status columns, alongside SQL proofs for the lookup foreign keys and durable
reconciliation-finding behavior.

## Consequences

- Status vocabularies are discoverable and extend only through reviewed data
  migrations.
- Above-tolerance POS/ledger and POS/bank rows produce the daily, explainable
  findings promised by the reconciliation Topic rather than one aggregate
  warning.
- Repeated runs refresh one stable finding, disappeared variances resolve, and
  later recurrences reopen the same identity.
- A normal transform credential cannot invent or directly rewrite a finding.
- Tenant erasure remains complete because deletion runs through separately
  authorized owner functions.
- Adding a lifecycle state now requires updating its lookup before rows may use
  the value; this deliberate friction prevents silent state drift.

## Alternatives considered

- **Keep literal `CHECK` constraints:** rejected because each table would own a
  private vocabulary and violate the V1 lookup contract.
- **Use PostgreSQL enums:** rejected because removing or changing lifecycle
  values becomes a schema operation rather than a reversible reviewed data
  migration.
- **Treat `quality.check_result` as the finding:** rejected because it is a
  refreshable run aggregate, not a user-facing day/location exception.
- **Create a new finding for every run:** rejected because retry and nightly run
  volume would manufacture duplicate incidents for one continuing variance.
- **Keep findings permanently open:** rejected because a corrected posting or
  settlement must be visibly resolved by later governed evidence.

## Verification

- `infra/migrations/control-plane/0061_m0_lookup_backed_lifecycle_statuses.sql`
- `infra/migrations/analytical/0100_m4_durable_reconciliation_findings.sql`
- `infra/migrations/analytical/0101_m0_lookup_backed_reconciliation_status.sql`
- `tests/sql/analytical-durable-reconciliation-findings.sql`
- `tests/contracts/durable-reconciliation-findings.contract.test.ts`
- `tests/sql/control-plane-lookup-backed-statuses.sql`
- `tests/sql/analytical-lookup-backed-statuses.sql`
- `tests/contracts/lookup-backed-statuses.contract.test.ts`
