# ADR 0002: Supabase PGMQ and Cron for durable sync orchestration

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert engineering
- Supersedes: the founding specification's provisional `pg-boss` queue choice

## Context

Albert's connector plane needs priority queues, delayed retries, at-least-once delivery, visibility timeouts, dead letters, resumable backfills, scheduled polling, and an operator-visible execution ledger. The control plane already runs on Supabase Postgres. Adding a separate Redis or broker cluster for V1 would add another stateful system without removing the need for transactional connection, receipt, cursor, and audit metadata in Postgres.

The founding specification named `pg-boss` provisionally. Supabase now provides Queues on the `pgmq` extension and Cron on `pg_cron`. PGMQ supplies durable Postgres-native messages with read counts, visibility windows, delayed availability, archival, and queue metrics. Cron supplies named database schedules. Both are available as managed Supabase extensions and keep job publication in the same transaction as Albert's control-plane ledger updates.

## Decision

### Queue substrate

- Use Supabase Queues (`pgmq`) in the control-plane database.
- Maintain three worker queues: `albert_sync_high`, `albert_sync_standard`, and `albert_sync_backfill`, plus `albert_sync_deadletter`.
- Persist every publication in `control_plane.sync_job_requests` with tenant, connection, idempotency key, queue message ID, status, payload, result, and safe error metadata.
- Claim high priority before standard and backfill. A claim creates an immutable attempt row and owns a bounded visibility window. The worker extends that window during long pages.
- Archive successful messages. Retry retryable failures with bounded delay and a maximum attempt count. Archive terminal failures and publish a dead-letter envelope that retains the original job reference and safe error code.
- Do not provide an in-memory, best-effort, or silent fallback. Migration and worker startup fail closed if PGMQ or any required queue is absent.

### Delivery and idempotency

- Delivery is at least once. Correctness comes from deterministic tenant-scoped idempotency keys, immutable raw batch IDs, manifest content hashes, namespaced source keys, source-version/payload-hash upserts, and atomic cursor commits.
- OAuth finalisation inserts the connection and encrypted credential reference and calls `enqueue_sync_job` in the same database transaction. A connection is never shown as successfully authorised while its first backfill publication can be lost.
- A verified webhook reserves a tenant/connection receipt by vendor dedupe key and body hash, writes the exact signed bytes to immutable Storage, then publishes all stream jobs and marks the receipt queued in one database transaction. A retry resumes an incomplete receipt and PGMQ publication remains idempotent.
- Connector packs do not receive a database or queue client. They return pages and webhook dispositions; the trusted orchestration layer owns persistence and publication.

### Scheduling

- Use named `pg_cron` jobs rather than process-local timers.
- Run the due-work scheduler every five minutes. It enqueues Lightspeed R-Series and Deputy polling at 15-minute safety intervals and Xero polling hourly, based on the last successful per-stream cursor.
- Run seven-day reconciliation sweeps nightly at 02:17 UTC for late edits, gaps, and tombstones.
- Expire abandoned OAuth sessions and cryptographically destroy their provisional PKCE/token envelopes every ten minutes.
- Install the three named jobs through an administrator-owned, fixed-input `SECURITY DEFINER` function. The migration owner is `NOLOGIN`, while pg_cron executes as the recorded job user; the wrapper records `postgres` as the executable login without granting the migration role arbitrary Cron scheduling or command injection.
- Cron functions only publish durable jobs; the always-on Node worker performs vendor I/O and analytical writes.

### Runtime and operations

- Run an always-on Node 22 sync-worker service with separate bounded pools for the control and analytical databases, a Supabase service client restricted to the private `raw-payloads` bucket, health/readiness endpoints, database heartbeats, queue metrics, visibility renewal, and graceful signal handling.
- Bound every vendor HTTP attempt to 30 seconds and compose that deadline with the caller's abort signal. The connector SDK also races the returned promise against the signal so a non-compliant client or test double cannot retain a worker lease after the deadline; native fetch receives the same signal so its socket is closed.
- Bound a complete sync connector operation to 12 minutes, below the 15-minute queue visibility window, and an OAuth worker operation to 40 seconds, below the web tier's 45-second signed-worker timeout. Shutdown abort participates in the same signal tree. Cursor publication remains visibility-fenced after vendor I/O.
- Sleep inline only for Retry-After values of 30 seconds or less. Longer backoffs surface as `RATE_LIMITED` and use a durable PGMQ visibility deferral that does not consume the job's failure/dead-letter budget.
- Coordinate vendor capacity across all sync-worker replicas in `control_plane.vendor_rate_budgets`. An atomic, row-locked GCRA reservation is scoped to tenant, connection, and budget key; allow-listed response headers and 429 cooldowns tighten the shared gate. Xero receives a 60-per-minute/5-burst gate plus a continuous daily gate selected explicitly by `XERO_DAILY_REQUEST_LIMIT` (`1000` Starter, `5000` Core or higher). Lightspeed R-Series and Deputy use conservative one-per-second baselines with small bursts, while Lightspeed bucket/drip headers and every vendor's Retry-After can impose a stricter shared cooldown.
- Run a separate public webhook-gateway service with only the control-plane, Storage, and webhook-verification secrets it requires. Vendor OAuth client secrets and the token-encryption key are not required by this gateway.
- Restrict PGMQ and Cron schemas from browser roles. Only trusted migration/runtime identities execute orchestration functions.
- Expose queue, attempt, worker heartbeat, webhook, batch, quarantine, and readiness metadata through audited operator projections; never expose job secrets, OAuth bodies, or raw payloads.

## Consequences

### Positive

- Connection state, webhook receipts, and job publication share one transactional boundary.
- No additional broker cluster is required for V1.
- Backfills survive worker restarts and process crashes and resume from committed cursors.
- Queue lag, attempts, retries, dead letters, and schedules are queryable in the existing operator plane.

### Costs and risks

- The control-plane database now carries queue I/O; capacity and retention must be monitored separately from application tables.
- PGMQ and Cron are hard production prerequisites. A Supabase project upgrade or extension outage blocks readiness rather than degrading silently.
- Shared rate-budget persistence is also fail closed: a control-plane outage prevents new vendor requests rather than allowing every replica to independently exhaust an account's allowance. Conservative smoothing can make backfills slower than a vendor's theoretical burst maximum, but preserves foreground capacity and predictable multi-day completion.
- At-least-once execution means every downstream step must remain idempotent; queue acknowledgement alone cannot establish analytical correctness.
- `pg_cron` jobs run with their creating database role. Migration ownership, command text, and Cron schema privileges therefore require the same review as other production DDL.

## Alternatives considered

- `pg-boss`: capable, but duplicates managed queue features and would still require an Albert ledger/outbox to make connection and webhook publication atomic.
- Redis-backed queues: strong ecosystem, but add another stateful dependency and cross-system publication failure mode.
- Process-local timers and arrays: rejected because restarts lose work and there is no durable ownership, retry, or audit trail.
- Vendor webhooks only: rejected because Lightspeed R-Series has no supported webhook contract and all vendors require polling/reconciliation safety nets.

## References

- [Supabase Queues](https://supabase.com/docs/guides/queues)
- [Supabase Cron](https://supabase.com/docs/guides/cron)
- [PGMQ](https://github.com/pgmq/pgmq)
- [pg_cron](https://github.com/citusdata/pg_cron)
- [Xero API rate limits](https://developer.xero.com/documentation/best-practices/api-call-efficiencies/rate-limits)
