# ADR 0042: Staged, atomic connector-pack activation

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert engineering
- Extends: ADR 0025 (durable cross-database relay), ADR 0041 (Lightspeed supplier integrity)

## Context

A connector pack changes more than extraction code. It changes capability
evidence, governed source fields, typed projections, canonical behavior, and
sometimes compatibility repair. A rolling worker deployment means old and new
workers coexist. If both versions overwrite one unversioned capability or field
row, the query surface can expose a mixed semantic contract: some streams from
the old pack and some from the new one.

Hard-coding queries to the newest version is not an activation protocol. It can
publish a partial backfill, makes rollback ambiguous, and lets a stale worker
restore old semantics after promotion. Requiring every historical connection to
publish forever is also impossible: a disconnected connection or deleting
tenant has no lawful credential with which to produce a candidate snapshot.

## Decision

Connector packs use a migration-registered release state machine and an atomic
active pointer.

`semantic_internal.connector_pack_release` records a full, bounded SemVer,
monotonic release sequence, direct predecessor, migration provenance, and one of
`candidate`, `active`, or `retired`. A partial unique index permits exactly one
active release per connector. Release identity is immutable; the only normal
transitions are candidate to active and active to retired in the same activation
transaction.

The sequence-1 `tenant_capability` and `source_field_allowlist` primary keys are
left unchanged. Already-running workers have SQL plans whose `ON CONFLICT`
targets name those keys, so changing either key in place would make the old
fleet fail before a trigger could help. A base-table `BEFORE` router leaves
sequence 1 on those compatibility tables and diverts every sequence greater
than 1 into versioned capability and source-field shadow snapshots. Candidate
and predecessor rows therefore coexist while both old and new worker SQL keeps
a planner-valid conflict target. Runtime queries union both stores through
`active_tenant_capability` and `active_source_field_allowlist`; neither the web
nor semantic service chooses a version. The database release row is the single
visibility decision for all tenants and all streams.

A non-sensitive, trigger-maintained evidence index supports fleet-wide
activation preflight without granting a runtime role cross-tenant RLS bypass.
The index records identities, pack version, evidence kind, inclusion, and
publication time, but no customer values or source payloads. Runtime roles have
no direct access to it.

### Publication and stale-worker serialization

Every capability or allowlist insert and every update locks the exact release
row `FOR SHARE`, whether the write remains in the sequence-1 table or is routed
to a shadow snapshot. Candidate and active releases may publish. Retired or
unknown versions fail with `object_not_in_prerequisite_state`.

Activation takes the connector advisory lock and every connector release row
`FOR UPDATE`, in release order. This drains publications already in flight and
blocks new ones while readiness is recomputed. It then retires the predecessor,
activates the candidate, and appends a sequence-bound activation event in one
transaction. The event retains the tenant-free aggregate preflight, including
parity counts, audited retirement count, and external gate result. After commit,
a stale predecessor worker wakes, sees `retired`, and fails before changing
either its row or the evidence index. It cannot revive the old query contract.

Source allowlist publication is an exact snapshot per version. A candidate
copies predecessor fields as inactive tombstones before reactivating fields
governed by its own manifest. Activation can therefore distinguish an
intentionally removed or reclassified field from an unprocessed stream.

### Activation gates

Activation is fail-closed unless all of the following are true under the release
row lock:

1. The expected predecessor is still active and the candidate directly names it.
2. Every predecessor capability key has candidate evidence for the same tenant
   and connection.
3. Every active predecessor source field has a candidate field or explicit
   tombstone.
4. Every release-specific required capability and source table exists for each
   eligible predecessor connection.
5. The release-specific external compatibility hook reports ready.

Lightspeed 1.1.0 requires `inventory.purchase_orders`, `vendors`, and `orders`.
Migration 0096 extends the external hook so Vendor reconciliation and bounded
legacy Order dependency replay must also be complete. A fresh environment with
no predecessor connections satisfies the empty fleet gates, but still follows
the same explicit activation command.

The protected release performs a read-only preflight and then the atomic
activation after the candidate services pass exact-release readiness. The
operation is idempotent: a repeated release proves the existing activation
event and returns the original activation time.

### Audited retirement of connections that cannot replay

An operator may exclude one predecessor connection only when the control plane
proves that it cannot lawfully sync again. The supported command accepts tenant,
connection, connector, candidate, and predecessor identities only. It never
accepts an audit identifier, reason, or digest from the caller.

The command opens both migration cells using the exact
`albert_control_deployer` and `albert_analytical_deployer` logins. In the control
cell it:

1. locks the exact tenant and connection rows;
2. derives either an approved tenant-deletion intent or an exact disconnected,
   revoked connection-generation intent;
3. locks the matching deletion request and append-only audit row;
4. validates tenant, connection, connector, request, generation, resource,
   action, and audit metadata; and
5. produces a canonical versioned evidence document and SHA-256 digest.

The control locks remain held while the analytical migration owner locks the
release rows and appends the retirement. The command then re-reads and re-hashes
the locked control evidence before committing analytical state. Mere expired,
broken, or revoked credentials on a live connection are insufficient; the user
must durably disconnect it or approve tenant deletion.

There is no distributed transaction between the two PostgreSQL cells. The
control transaction is read-only, while the analytical insert is idempotent for
the exact audit and digest. A failure before analytical commit leaves no
retirement. An ambiguous failure after analytical commit is retried with the
same locked, immutable evidence; conflicting evidence fails closed.

Retirement is not a permanent bypass for a reconnect. Candidate evidence is
timestamped at publication. Release-row locking drains concurrent publication
before retirement, and any later candidate write makes the connection eligible
again, requiring the complete candidate snapshot.

### Deletion and retention

Connection-retirement rows are append-only during normal operation, but their
immutability trigger permits deletes only inside the established
`deletion_internal.mutation_authorized()` fence. Migration 0095 inserts a private
layer beneath the signed one-use connection purge to delete exact retirement
rows and both shadow-snapshot row types. Deletes from the compatibility and
shadow snapshot tables transactionally remove their evidence-index rows through
triggers. Tenant purge discovers every tenant-scoped table through the existing
catalog-driven erasure path. Residual attestation counts those relations, so a
deletion cannot verify while retirement, snapshot, or index evidence remains.

Migration 0096 removes its replay gate before the older reconciliation wrapper
deletes stream-health rows. The stream-health trigger treats only a
migration-owner-authorized `DELETE` as erasure and removes/keeps the gate absent;
it therefore cannot recreate replay state from sibling rows part-way through a
multi-row purge. Runtime roles have no direct delete privilege on that table.

Activation events and release definitions contain no tenant identifier and are
retained as global deployment evidence.

## Rollout

For Lightspeed 1.1.0:

1. Apply migrations 0095 and 0096. Pack 1.0.0 remains active; 1.1.0 is only a
   candidate, so migration alone changes no query-visible connector semantics.
2. Roll out 1.1.0 workers. Old workers continue publishing 1.0.0 while new
   workers build independent 1.1.0 snapshots.
3. Backfill and reconcile Vendor and Order streams and finish the bounded legacy
   Order replay. Re-consent connections that lack the Vendor scope.
4. For a connection that has durably disconnected or belongs to an approved
   deleting tenant, run `npm run connector-pack:retire-connection --` with only
   its identities and pack versions. Do not manufacture retirement evidence.
5. Let the protected release run the activation preflight. An incomplete fleet
   stops promotion while 1.0.0 remains visible. Retry the release after replay
   or verified retirement completes.
6. Activate atomically. Monitor retired-pack publication failures; they identify
   stale workers that must be drained or replaced, not retried indefinitely.

For every future pack, an additive migration must:

- register a new full SemVer and next release sequence with its direct
  predecessor, leaving it `candidate`;
- register new required capabilities and source tables;
- extend the external gate for any data repair, replay, or reconciliation that
  cannot be represented by row parity;
- preserve predecessor rows and publish candidate tombstones for removals;
- add the explicit candidate/predecessor activation command to the protected
  release; and
- add SQL contracts for mixed-version invisibility, incomplete preflight,
  activation atomicity, stale writers, retry idempotency, and deletion.

No migration edits an applied release record or reactivates a retired pack. A
rollback is a forward release with a new sequence and reviewed compatibility
contract.

## Consequences

- Users see one coherent connector semantic contract, even during rolling
  worker deployment.
- Candidate backfill, new-scope failures, and compatibility repair can take
  time without exposing partial analytics.
- Activation is an explicit, audited production action rather than a code
  version comparison.
- Stale-worker safety is enforced by PostgreSQL locks and triggers, independent
  of orchestrator timing.
- Inactive connections cannot block a fleet forever, while caller-supplied or
  forged retirement evidence cannot bypass readiness.
- Versioned shadow snapshots and the global metadata index consume additional
  storage until ordinary retention and deletion paths remove tenant evidence.

## Alternatives considered

- **Overwrite one capability/allowlist row during deployment:** rejected because
  stream completion order creates mixed contracts and stale workers can win.
- **Filter queries to a hard-coded newest version:** rejected because visibility
  would precede fleet readiness and require coordinated application rollback.
- **Stop the worker fleet for activation:** rejected because it creates avoidable
  downtime and still does not prove compatibility replay.
- **Trust an operator-supplied disconnected flag or digest:** rejected because it
  is forgeable and cannot prove the exact control-plane connection generation.
- **Treat any revoked credential as retired:** rejected because credentials can
  be repaired or re-authorised without a durable deletion fence.
- **Use a distributed transaction coordinator across cells:** rejected for V1;
  locked immutable control evidence plus one idempotent analytical write has a
  smaller operational and failure surface.
