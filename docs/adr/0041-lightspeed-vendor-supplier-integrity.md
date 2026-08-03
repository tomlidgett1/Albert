# ADR 0041: Lightspeed Vendor ingestion and purchase-order supplier integrity

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert engineering
- Extends: ADR 0029 (record-scoped canonical recovery and source grains)

## Context

Lightspeed R-Series `Order` records expose `vendorID`, but the initial V1 pack
did not ingest the independently documented `Vendor` resource. The Order mapper
correctly emitted a source reference to `core.supplier`; the canonical resolver
correctly rejected that reference because no source-owned supplier existed.
Consequently, a real purchase order with a non-empty `vendorID` could not
materialise even though fixture-only mapper tests passed.

Silently treating a missing referenced supplier as null would make the pipeline
appear healthy while discarding source-provided attribution. Rewriting the
already applied generated staging migration would also violate migration
checksum immutability. Existing Lightspeed grants may not include the separate
documented `employee:vendors` scope.

## Decision

Lightspeed pack `1.1.0` adds `Vendor.json` as a required typed stream:

- The connector requests `employee:vendors`, includes archived records, loads
  the `Contact` relation, uses `timeStamp` incrementals, and retains complete
  snapshot reconciliation.
- Vendor maps to the source-owned `supplier` dimension. An archived Vendor
  becomes inactive but remains resolvable for historical purchase orders.
- Supplier identity persists a connector-namespaced Vendor ID and a normalised
  name that may create a human-review suggestion. Supplier names and account
  numbers never automatically merge with Xero contacts.
- `orders` depends on `vendors`. The scheduler cannot qualify or transform an
  Order stream before its Vendor dependency is complete for the same
  connection and generation.
- The canonical resolver remains fail-closed. A non-empty unknown `vendorID`
  is an integrity defect; `nullable` applies only when the source field itself
  is absent.
- Operational capability `inventory.purchase_orders` requires both
  `employee:vendors` and `employee:purchase_orders`. Missing legacy consent is
  reported as `required_scope_missing` instead of surfacing later as an opaque
  extraction failure.
- Additive migration `0093_m3_lightspeed_vendor_staging.sql` creates only the
  Vendor staging table, its tenant RLS policy, watermark index, and runtime
  grants. Migration `0094_m5_lightspeed_purchase_order_capability.sql` adds the
  operational capability to the database-enforced vocabulary. Migration
  `0005_m3_typed_connector_staging.sql` remains byte-for-byte immutable and its
  checksum is contract-tested.

The analytical CI path lands the reviewed Vendor and Order fixtures through
the production landing store and runs the production canonical transform.

Pack activation and legacy recovery are an atomic, fail-closed protocol:

- A pre-1.1 Order transform that exhausted its retries cannot be reclaimed
  after an OAuth generation change, and an unchanged payload does not create a
  fresh typed-staging version. Resetting the old job or replaying it under a
  newer generation would violate the worker generation fence.
- Migration `0096_m4_lightspeed_legacy_order_dependency_replay.sql` therefore
  adds a narrowly scoped compatibility projection. It considers only current,
  non-tombstoned typed Orders whose exact generic-source origin has normalized
  schema `1.0.0`, whose origin manifest is Lightspeed pack `1.0.0`, and whose
  current mapping has not already been audited.
- Compatibility projection may run only from a terminal pack-1.1 Vendor or
  Order page after both streams in the current connection generation have a
  complete, cursor-valid backfill and completed reconciliation with zero gaps,
  drift, or quarantine. Running after Vendor backfill alone is forbidden: the
  Order reconciliation must first remove records deleted since the legacy
  landing.
- The projection executes each Order command with its exact current typed batch
  and sync-run lineage. Its protected audit function accepts no worker-supplied
  success counts. It re-derives every expected OrderLine source identity from
  staging and proves the exact canonical record state, purchase-order lineage,
  and Vendor-backed supplier before appending immutable evidence.
- The terminal page's ordinary canonical work commits before compatibility
  draining begins. Recovery then processes at most 100 candidate Orders and
  500 previously unmaterialised OrderLine commands per analytical transaction.
  Each chunk uses a fresh lease-bound analytical capability and commits exact
  audit/canonical progress. A large single Order is continued from its exact
  canonical record state; a worker crash or lease hand-off resumes from the
  first unaudited line or Order. The activation gate closes only in the final
  bounded transaction after no candidate remains.
- The global activation evidence contains only opaque tenant and connection
  identifiers, generation, readiness, counts, and timestamps. Runtime roles
  cannot write it directly. A new generation, health regression, or legacy
  Order landing clears readiness. Health mutations take the candidate release
  row's share fence before waiting on replay serialization, so activation
  cannot pass a gate whose regression is already in flight.
- Signed connection erasure removes the replay gate before reconciliation
  state. Its health trigger recognizes only an authorized row deletion as
  erasure and cannot recreate the gate while sibling stream rows are being
  purged; ordinary inserts and updates still follow the full activation fence.
- Migration `0095_m5_atomic_connector_pack_activation.sql` owns the general
  atomic pack-release protocol. Migration 0096 extends its external gate so
  Lightspeed 1.1 cannot become active, and 1.0 cannot retire, until every
  still-connected predecessor connection has completed this reconciled repair.
  Release-row locks make activation atomic with in-flight legacy landings and
  repair transactions.

The CI proof establishes the actual production failure and recovery sequence:
the legacy Order fails before Vendor materialisation; Vendor materialisation
alone does not replay it; forged audit evidence is rejected while the
purchase-order line is absent; and the terminal reconciled pack-1.1 transform
creates the exact Vendor-to-`core.supplier`-to-`core.purchase_order_line`
reference, immutable audit, and ready activation gate.

## Rollout

1. Apply analytical migrations 0093, 0094, 0095, and 0096 before deploying
   pack-1.1 workers.
2. Register 1.1.0 as a candidate release; do not directly replace the active
   pack or retire 1.0.0.
3. Mark pre-1.1 Lightspeed connections missing `employee:vendors` unavailable
   for `inventory.purchase_orders` and ask an owner to re-consent.
4. Run current-generation Vendor and Order backfills and reconciliation to
   completion. The terminal page performs the bounded legacy Order projection
   and closes that connection's activation gate only when every candidate has
   database-verified materialisation evidence.
5. Activate 1.1.0 through the protected atomic release procedure after all
   required predecessor connections report a ready external gate.
6. Complete live R-Series dogfood acceptance with at least one purchase order
   carrying a real Vendor before production promotion.

## Consequences

- Purchase-order supplier attribution is source-backed and queryable rather
  than fixture-implied.
- Old OAuth consent cannot falsely advertise complete purchase-order support.
- New source staging is deployable without invalidating an applied migration.
- The staging generator allocates only the next unused migration number, opens
  its output with create-only semantics, and refuses streams whose table already
  exists. Migration 0093's checksum is frozen; later Vendor fields require a
  separately reviewed additive migration and contract-test extension.
- A deleted or permission-inaccessible Vendor remains a visible quality fault;
  the platform never fabricates or silently drops its supplier reference.
- A stale Order deleted at source cannot be resurrected by the compatibility
  path because replay eligibility begins only after current-generation Order
  reconciliation and excludes typed tombstones.
- The one-time compatibility logic is intentionally pack- and schema-specific;
  it is not a general facility for bypassing terminal jobs or replaying old
  mappings.
- Legacy volume does not enlarge a terminal page into one unbounded database
  transaction. Replay progress is durable independently of the canonical job's
  final control-plane completion, while the closed activation gate prevents
  partially repaired data from promoting pack 1.1.

## Alternatives considered

- Materialise an ad-hoc supplier from `Order.vendorID`: rejected because it
  invents a dimension without the Vendor's name, status, or reconciliation
  lifecycle.
- Resolve an unknown nullable source reference to null: rejected because it
  converts referential corruption into silent analytical data loss.
- Load the embedded `Order.Vendor` relation only: rejected because Lightspeed
  documents Vendor as an independently sortable resource and Orders do not
  guarantee a complete embedded Vendor relation.
- Regenerate migration 0005: rejected because applied migration bytes and
  checksums are immutable.
- Reset terminal pack-1.0 jobs after reconnect: rejected because old-generation
  jobs are intentionally fenced and cannot safely execute under new OAuth
  credentials.
- Replay immediately after Vendor backfill: rejected because a legacy Order
  deleted at source could be materialised before the current Order
  reconciliation writes its tombstone.
- Trust worker-reported applied-command counts: rejected because activation
  evidence must be derived from exact canonical rows and lineage inside the
  database trust boundary.

## References

- [Lightspeed R-Series Vendor endpoint](https://developers.lightspeedhq.com/retail/endpoints/Vendor/)
- [Lightspeed R-Series OAuth scopes](https://developers.lightspeedhq.com/retail/authentication/scopes/)
