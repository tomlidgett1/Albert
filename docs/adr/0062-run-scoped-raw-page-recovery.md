# ADR 0062: Run-scoped raw page recovery

- Status: Accepted
- Date: 2026-08-05
- Owners: Albert platform
- Related: ADR 0002 (pgmq sync orchestration), ADR 0016
  (generation-fenced lifecycle), ADR 0056 (multi-page InitialBackfill claims),
  Albert v1 sections 3, 7, and 17

## Context

Multi-page backfill retries can mint a fresh page `batchId` after a crash. The
original manifest constraint deduplicated equal content across the whole
connection, so the first implementation reused an old batch whenever content
hash and cursor boundaries matched.

That scope is too broad. Snapshot streams legitimately return byte-identical
content in later scheduled sync runs. Reusing the old batch also reuses its
sync run, landing, and connector-quality identity. The new run then attempts
to attach different evidence to the old batch and fails closed as a conflicting
replay. It also means the new observation has no immutable lineage of its own.

The multi-page implementation kept a sync run open whenever its last page had
a continuation. At the fifty-page claim boundary the request was successfully
acknowledged and a new continuation run took over, leaving the prior run
permanently `running`. It also recorded page success before publishing the
successor, creating a crash window in which a successful replay could skip the
missing continuation.

## Decision

1. Raw content deduplication is scoped to
   `(tenant, sync_run, connection, stream, content_hash, cursor_start,
   cursor_end)`. A retry in the same run may reuse its exact page; a distinct
   run always receives a distinct raw object, manifest, landing, transform,
   and quality lineage.
2. Every committed page stores its continuation in `sync_runs.cursor_end`. A
   retried InitialBackfill claim resumes from that durable cursor. If progress
   exists, its first resumed page mints a fresh batch ID; the run-scoped fence
   still recovers a crash of that page idempotently.
3. A page commit keeps the current sync run open. On claim exit the worker
   publishes the continuation or next phase first, then marks the current run
   succeeded, then acknowledges the queue request.
4. Migration `0078` repairs historical non-terminal run rows whose owning
   queue requests are already terminal, without changing accumulated counts or
   cursors.

## Consequences

- Unchanged scheduled snapshots remain independently auditable and can drive
  required per-batch transforms such as inventory snapshots.
- A killed claim resumes at the last committed page rather than replaying the
  entire fifty-page chunk.
- A terminal queue request cannot leave its run falsely active, and a run
  cannot become terminal before its durable successor is published.
- Raw storage remains append-only. Deduplication is an idempotency fence for
  one run, not an attempt to erase repeated source observations.

