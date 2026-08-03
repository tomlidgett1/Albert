# ADR 0016: Generation-fenced sync lifecycle and explicit coverage evidence

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert platform
- Supersedes: the unversioned stream-cursor and implicit phase-completion details in ADR 0002

## Context

PGMQ preserves an individual message, but a message is not the durable statement
of everything a connection is expected to ingest. After the maximum read count,
a failed message is archived and dead-lettered. Without a separate expectation
ledger, that can leave one stream or historical phase permanently absent while
the remaining streams continue to look healthy.

The original cursor key was tenant, connection and stream. Reauthorising a
disconnected account reused that cursor and started a new recent slice. That
could let work from the old credential epoch advance the new connection, or
skip the interval between the old modified watermark and the recent slice. It
also allowed a queued deletion to be cancelled without a durable distinction
between untouched intent and an irreversible purge.

Finally, every stream inherited the same recent, thirteen-month and full-history
phase sequence. Snapshot resources were therefore fetched three times, while
Xero's offset-only Journals endpoint restarted from offset zero. A terminal
request against 1970 was treated as complete even though the completion record
did not say whether the API scan found an oldest record, reached account start,
or encountered a vendor retention boundary. Readiness was projected from the
most recent transformed page, so a clean sibling stream could clear a worse
required-stream result.

## Decision

Every connection has a monotonically increasing `connection_generation`.
Every new queue publication is transactionally bound to the generation locked
from the connection row; supplied stale generations fail closed. Sync runs,
stream phases and cursors carry that generation. A worker proves equality with
the current connection before vendor I/O or cursor publication.

`control_plane.sync_stream_phases` is the durable expectation ledger, keyed by
tenant, connection, generation, stream and phase. It records immutable ranges,
phase order, stream strategy, required/optional status, current replay version,
queue request, coverage evidence and terminal outcome. A fixed `pg_cron`
recovery command publishes every eligible planned, missing or failed phase.
Terminal failures increment `replay_version` and receive a new sync run, batch
and generation/replay-scoped idempotency key. Queue exhaustion can therefore
never make required work disappear.

Connector manifests declare one of three backfill strategies:

- `time_windowed`: recent, then the preceding thirteen months, then the oldest
  available window.
- `snapshot`: one exhaustive current-state scan only.
- `exhaustive_offset`: one scan from the vendor's first offset only.

One-pass streams are never repeated for date phases. A stream is marked
`backfill_complete` only with explicit terminal evidence: verified oldest row,
verified empty exhaustive scan, account start, vendor-reported retention bound,
or point-in-time snapshot for a snapshot contract. The historical query floor
is not completion evidence by itself.

Xero Journals and Deputy Contacts are declared optional because vendor tier,
scope or plan can legitimately make them unavailable. `CAPABILITY_UNAVAILABLE`
for an optional phase becomes the durable terminal `unavailable` state and does
not retry forever. The semantic capability layer still keeps affected metrics
Unavailable. The same outcome on a required stream remains a failure.

Reauthorisation always advances the connection generation. A deletion request
may be cancelled only while it is unclaimed, its credential is intact, remote
revocation is still pending and its progress contains intent only. Any claimed
or destructive deletion remains irreversible. A new generation resumes a
time-windowed stream from the prior committed modified watermark only when the
prior generation has backfill completion evidence. Otherwise it performs a
new recent-first full rebuild. Verified catch-up invokes each connector's
inclusive modified-since incremental path with the prior opaque cursor; it
must not reinterpret the watermark as an event-date backfill window, because
that would miss older source objects edited after the watermark. Old-generation jobs and cursors remain audit
evidence but cannot advance current state.

Readiness uses a generation-consistent aggregate over every required stream.
It takes the worst phase and latest per-stream transform/quality outcome, the
minimum required-stream watermark, and completion only when every required
stream is complete. A successful sibling page cannot clear a failed or missing
required stream.

Worker failure evidence is a code-only database contract, not merely an
application logging convention. Sync retry, capacity deferral, reconciliation
blocking, optional-stream termination, canonical-transform retry, and identity
projection retry accept only their exact JSON keys, JSON scalar types, and
reviewed finite code vocabularies. Exception messages, vendor text, source
records, credentials, stack traces, and arbitrary metadata cannot cross these
function boundaries even when a compromised worker holds a legitimate active
lease. The original lease-fenced transition bodies remain private
`SECURITY DEFINER` implementations; runtime roles can execute only validating
wrappers, and deployment assertions prove the private implementations retain no
public or runtime grants.

## Consequences

- Backfill recovery is database-driven, observable and independent of worker
  process memory or one queue message's retry budget.
- Reconnect catches up at least once from the prior modified watermark when it
  is safe, and pays the cost of a full rebuild when coverage is uncertain.
- Snapshot APIs and Xero Journals consume materially fewer calls and no longer
  restart across artificial date phases.
- Existing completed cursors without explicit coverage evidence are
  deliberately treated as uncertain on their first reconnect and rebuilt.
- Operational failures remain diagnosable by stable codes without turning the
  durable queue and readiness ledgers into a source-text exfiltration channel.
- Lifecycle metadata grows by generation and phase. It is operational evidence
  only and remains tenant-scoped; raw and analytical records stay in their
  existing stores.

## Rejected alternatives

- **Rely on dead letters and operator vigilance:** does not guarantee expected
  work is republished and can silently strand one stream.
- **Reset the same cursor on reconnect:** cannot fence in-flight old jobs or
  distinguish safe catch-up from uncertain coverage.
- **Always resume the prior cursor:** preserves API cost at the expense of
  permanent gaps after partial deletion or incomplete historical coverage.
- **Always rebuild every reconnect:** correct but unnecessarily expensive when
  the prior generation has verified coverage and an exact modified watermark.
- **Treat every stream as three date windows:** wastes vendor budgets and is
  incorrect for snapshots and offset-only APIs.

## Verification

- control-plane migration `0058_m2_code_only_worker_failure_evidence.sql`
- `tests/sql/control-plane-code-only-worker-failure-evidence.sql`
- `tests/contracts/worker-failure-evidence-boundary.contract.test.ts`
- `tests/contracts/sync-worker-outcome.contract.test.ts`
- `tests/contracts/transform-worker-outcome.contract.test.ts`
