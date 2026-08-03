# ADR 0030: Fleet concurrency, queue-pressure scaling, and bounded pipeline history

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert platform
- Relates to: ADR 0006, ADR 0016, ADR 0022, ADR 0025

## Context

Albert V1 uses durable PostgreSQL queues and horizontally replicated Node
workers. A Machine previously claimed one sync or transform job at a time,
while the release reset every Fly app to exactly two Machines. Hourly pipeline
maintenance claimed at most 100 tenants once and processed those leases
sequentially. At the 20,000-tenant design point, an untouched tenant could wait
roughly 100 hours for an hourly snapshot, and claims near the end of a batch
could expire before execution.

Pipeline snapshots were also append-only at both database boundaries. The
legacy aggregate projection outbox had no consumer, and delivered projections
were retained indefinitely. This makes observability itself an unbounded data
plane.

Queue workers need an autoscaling signal that reflects durable work, not HTTP
traffic. The snapshot sweep is not a queue, so queue depth alone cannot reveal
its backlog. Scaling credentials must not be installed in an Albert runtime.

## Decision

### Bounded execution lanes

Sync and transform Machines run a configurable number of independent claim
lanes, defaulting to eight and hard-bounded to 1–64. Each claim retains its
existing message/lease token, deadline extension, retry transition, generation
fence, vendor budget, and deletion fence. SIGTERM stops new claims and waits
for in-flight lane promises to settle within Fly's drain window.

Database pools are sized from the lane count plus a small allowance for health,
heartbeats, OAuth, and maintenance. Concurrency is process-local; Fly's
immutable Machine id remains part of the lease owner, so replicas cannot renew
or complete one another's work.

### Drain-to-empty hourly maintenance

The snapshot loop repeatedly claims lane-sized tenant batches until no tenant
is due or the per-run safety ceiling is reached. A batch is processed in
parallel and the next batch is not leased early. Failed tenants retain their
lease until expiry, successful tenants complete independently, and one failure
does not discard successful work. The default safety ceiling is 20,000 claims
per Machine invocation; multiple Machines safely divide candidates through
`SKIP LOCKED` and active-lease exclusion.

The control plane publishes exact due-tenant and active-lease counts. This
includes the maintenance backlog in capacity decisions rather than assuming
that transform queue depth represents it. Durable claim/completion timestamps
also produce a 24-hour sample count and p95 tenant latency, so release capacity
uses measured work rather than a synthetic benchmark.

### Metrics-based fleet scaling

Sync and transform publish aggregate Prometheus gauges on a separate private
metrics port: lane capacity, active jobs, durable queue depth, oldest visible
age, SLO breach, and transform-maintenance due tenants. They expose no tenant,
connection, source-row, query, or credential label.

Pinned Fly metrics-autoscaler apps consume those gauges. They retain two
Machines and create no more than 40 for each worker fleet. Sync pressure uses
depth plus age against a 300-second SLO. Transform pressure uses depth, age
against a 120-second SLO, and due maintenance tenants. Autoscaler deploy and
Prometheus-read tokens are held only by the autoscaler apps and protected
release environment. Albert service releases restore capacity only when fewer
than two Machines exist; they never scale a live fleet down to two.

At the 20,000-tenant design point, 40 Machines × 8 lanes provide 320 concurrent
maintenance slots. An hour-long sweep therefore tolerates an average 57.6
seconds per tenant (`3,600 × 320 / 20,000`). The two-Machine floor tolerates
2.88 seconds. Production opening requires measured p95 snapshot/projection
latency to fit the selected floor or a reviewed higher floor.

### Bounded operational history

After a successful cross-database projection, tenant-scoped retention runs
inside the same signed transform capability and control-plane scope:

- hourly pipeline buckets for 48 hours;
- daily buckets through 35 days;
- monthly buckets through 400 days;
- no pipeline snapshots older than 400 days;
- delivered readiness and table-stat projections for 24 hours;
- delivered identity-review and semantic-promotion projections for 30 days;
- unpublished rows indefinitely until delivered, repaired, or tenant-deleted;
  and
- immediate removal of the superseded, unconsumed aggregate pipeline outbox.

Retention functions verify the exact runtime login and signed/current tenant
scope. They cannot prune another tenant and do not grant a runtime unrestricted
table deletion. Dormant disconnected tenants do not create new telemetry;
forward migrations compact any historical V1 data and tenant deletion remains
the definitive erasure path.

## Consequences

- A single Machine can use I/O wait productively without weakening lease or
  vendor-budget semantics, and the fleet can react to durable backlog.
- Maintenance leases are claimed near execution time and the 20,000-tenant
  sweep is no longer capped at 100 tenants per hour.
- Scaling remains bounded. A vendor outage can increase backlog but cannot
  create unlimited Machines or bypass provider rate limits.
- Operational metadata has an explicit cost envelope while retaining useful
  incident resolution and long-term trend points.
- Actual vendor latency, database p95, rate tiers, and live dogfood results are
  deployment evidence, not values that a repository can honestly fabricate.

## Alternatives considered

- **One lane per Machine:** rejected because long vendor I/O leaves CPU and
  database capacity idle and requires excessive replica counts.
- **Claim thousands of snapshot leases up front:** rejected because bounded
  ten-minute capabilities would expire while waiting in process memory.
- **Scale from HTTP concurrency:** rejected because worker load lives in
  durable queues and maintenance ledgers, not inbound requests.
- **Give workers Fly scaling tokens:** rejected because a compromised connector
  runtime must not control infrastructure or read organization metrics.
- **Keep every telemetry snapshot:** rejected because observability is not a
  lawful reason for an unbounded per-tenant append-only store.

## Verification

- `tests/contracts/worker-fleet-scale.contract.test.ts`
- `tests/contracts/canonical-transform-worker.contract.test.ts`
- `tests/release-preflight.test.mjs`
- `scripts/validate-deployment.mjs`
- control-plane migration `0048`
- analytical migration `0089`
