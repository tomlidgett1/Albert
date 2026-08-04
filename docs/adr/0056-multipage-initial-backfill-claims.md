# ADR 0056: Multi-page InitialBackfill claims

- Status: Accepted; retry identity and run finalisation refined by ADR 0062
- Date: 2026-08-04
- Owners: Albert platform
- Related: ADR 0002 (pgmq sync orchestration), ADR 0016 (generation-fenced lifecycle),
  ADR 0027 (progressive readiness)

## Context

Ashburton dogfood showed InitialBackfill spending most of its wall-clock outside
the Lightspeed API: each vendor page became a separate PGMQ claim with raw
upload, staging, commit, and re-enqueue. Insights New in Bike Dashboard walks
pages in-process against the same Lightspeed V3 API and finishes full history
far sooner under the same rate limits.

Albert still needs immutable raw storage, typed `source_*` landing, progressive
readiness (`recent` then deeper history), and generation fences. Those
requirements do not require one queue message per API page.

## Decision

`InitialBackfill` stream jobs process up to fifty vendor pages inside a single
queue claim (configurable constant `BACKFILL_PAGES_PER_CLAIM`). Within the claim
the worker:

1. Fetches a page.
2. Prefetches the next page while uploading and staging the current page when
   more pages remain in the claim budget.
3. Commits the cursor after each page so a kill resumes cleanly.
4. Mints a fresh `batchId` for every page after the first so immutable raw
   object identity stays stable.
5. Extends lease visibility as it walks.
6. Enqueues at most one continuation (or next progressive phase) when leaving
   the claim.

Progressive phases (`recent` → `thirteen_months` → `full_history`) remain the
readiness contract. They are not a reason to micro-batch every API page through
pgmq.

`IncrementalSync` and `ReconciliationSweep` stay single-page per claim so
webhook tombstones and reconciliation phase leases keep their existing
semantics.

Scheduled IncrementalSync must not starve an in-flight InitialBackfill. The
incremental scheduler skips connections that still have incomplete
`stream_cursors.backfill_complete` or open InitialBackfill job requests.

## Consequences

- Dogfood and production backfills become API-bound instead of queue-bound.
- Claim duration lengthens (still capped by the existing ~12 minute operation
  deadline and the page budget).
- Continuation idempotency and generation fences are unchanged.
- Transform and readiness still project from committed batches; multi-page
  claims only change how many batches one worker visit produces.
- Raw Storage sync grants bind to the claimed job's
  `tenant/connection/stream/date` prefix, not the payload `batchId` alone, so
  page-local batch objects remain lease-fenced while allowing ADR 0056's
  per-page batch identity (control-plane migration `0075`).
