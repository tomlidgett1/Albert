# ADR 0021: Durable two-snapshot reconciliation and required-stream health

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert platform
- Refines: ADR 0002 (Supabase/PGMQ sync orchestration)
- Composes with: ADR 0011 (canonical capability observations)
- Extends: ADR 0016 (generation-fenced sync lifecycle and coverage evidence)

## Context

Incremental cursors and webhooks are latency mechanisms, not completeness
proof. A provider can expose an older business object that was edited today,
omit a hard-deleted object from every later page, or deliver no delete event at
all. Comparing only record totals also fails when one source identity replaces
another between scans. A malformed page, duplicate identity, partial scan, or
quarantined row must never be interpreted as evidence that a missing local
object was deleted.

The seven connector quality checks were previously published from individual
pages. A clean sibling page could therefore replace a worse observation, old
connection generations could continue to affect current health, and an
expected but entirely missing required stream had no row from which to fail
closed. Deletion also needed to remove the new reconciliation evidence without
weakening the reviewed M8 closure.

## Decision

Every connector stream declares three explicit policies in its manifest:

- a late-edit strategy: `modified_field`, `full_snapshot`, or `append_only`;
- a deletion strategy: `soft_delete`, `verified_delete_feed`,
  `authoritative_identity_scan`, or `immutable_append_only`; and
- a source-total strategy: `provider_reported` or
  `count_distinct_complete_scan`.

The SDK and semantic registry reject a stream with a missing, inconsistent, or
unknown policy. Immutable streams must also be append-only. Xero modified-date
reconciliation uses `If-Modified-Since` even for business-date resources;
Deputy uses `Modified`; Lightspeed follows each endpoint's declared modified or
snapshot contract. Provider writes remain prohibited.

Each tenant/connection/generation/stream sweep is a durable four-phase state
machine:

1. `late_edits`
2. `identity_snapshot`
3. `verify_snapshot`
4. `apply_tombstones`

Every transition is bound to the active PGMQ request, message, worker, read
count, connection generation, sweep, stream and phase. Completed or blocked
transitions retain that exact lease identity and evidence. Exact replay is
idempotent; changed evidence, a different lease, a stale generation, or a
never-begun transition fails closed. The page landing and control-plane phase
transition commit together from the worker's perspective, so a crash cannot
advance one without durable replay evidence for the other.

All thirty-one V1 streams participate in complete identity scans according to
their policies. A page retains its complete identity evidence and exact replay
contract. A snapshot fails if any page is incomplete, malformed, duplicated,
quarantined, inconsistent with its source total, or replayed with changed
evidence. Verification is a second independently completed scan that starts
after the first completes. Equal totals are insufficient: the two identity
sets must also be identical.

An object may be tombstoned from absence only when both complete scans omit its
identity, both scans have identical membership, the local version predates the
first scan, no newer local source version won the race, and the stream declares
`authoritative_identity_scan`. Tombstones are bounded synthetic raw records
that name both snapshot batches. They pass through the ordinary immutable raw,
typed, source and canonical paths; an application cannot be marked durable
until the exact tombstone batch is the current source version. Soft-delete and
verified-delete-feed records likewise use the normal source path. Albert never
writes deletion state back to a vendor.

`quality.connector_stream_state` registers every expected stream before pages
arrive. Health rolls up only the current generation and the worst required
stream across cursor-chain completeness, observed scope, retention/backfill
evidence, reconciliation freshness, delete handling, open schema drift, and
open enum/quarantine state. Open quarantine is joined through generation-bound
batch evidence rather than counted for the lifetime of a connection. A clean
empty terminal scan is valid evidence; an unobserved required stream remains
blocked. Page-local warnings cannot overwrite this durable roll-up.

Connection erasure deletes stream state, snapshot pages, identity evidence and
tombstone applications before delegating to the reviewed analytical M8 purge,
and verification includes every new relation. The non-login analytical
migration owner alone receives database `TEMPORARY` capability because the M8
SECURITY DEFINER purge uses transaction-scoped work tables; runtime roles do
not receive it.

## Consequences

- Late edits are recovered by source modification time rather than event date.
- Hard deletion is intentionally delayed until two stable scans exist.
- Reconciliation stores more operational evidence, but it is bounded per page,
  generation-scoped, tenant-isolated and included in erasure.
- A provider with unstable membership, duplicate identities, missing totals,
  or quarantined records blocks reconciliation instead of producing a false
  deletion.
- Current health represents all expected required streams, including streams
  that have never returned a row.

## Rejected alternatives

- **Trust webhook delivery:** webhooks are hints and do not prove absence or
  recover every late edit.
- **One identity scan:** a transient provider omission could delete valid data.
- **Compare totals only:** changed membership can preserve the same total.
- **Delete source rows directly:** loses immutable lineage and bypasses typed
  and canonical tombstone handling.
- **Carry lifetime error counters:** resolved or obsolete-generation quarantine
  would permanently poison current health.
- **Let page checks be last-writer-wins:** a clean sibling stream could hide a
  missing or blocked required stream.
