# ADR 0032: Run-scoped transform diagnostics and a fail-closed fleet-capacity gate

- Status: Superseded by ADR 0034
- Date: 2026-08-03
- Owners: Albert platform
- Relates to: ADR 0006, ADR 0022, ADR 0030

## Context

ADR 0030 sets an hourly snapshot objective for 20,000 tenants, eight transform
lanes per Machine, and a 40-Machine ceiling. A first implementation timed one
eight-lane process, linearly extrapolated its p95 to as many as 40 Machines,
and allowed manually copied JSON to satisfy production preflight. That was not
production capacity evidence.

A single process cannot observe shared control-plane and analytical-database
saturation, connection-pool contention, locks, or autoscaler behaviour at 320
lanes. A tenant count alone does not attest representative source and
projection volume. A manually copied artefact does not prove which candidate,
database, or executable produced it. The calculated floor was also not applied
to the deployed transform app. Treating those unknowns as a pass would create
false confidence.

The underlying per-tenant path is still useful to measure. It includes the
signed maintenance capability, analytical pipeline-stat snapshot,
cross-database projection, dossier refresh, retention, and durable lease
completion. The design therefore separated an honest engineering diagnostic
from the distributed release attestation subsequently accepted in ADR 0034.

## Decision

Albert ships an operator-only transform-capacity diagnostic in the service
image. It invokes the production `CanonicalTransformPipeline` with the two
least-privilege transform runtime identities. Managed staging mode independently
enforces the production boundary even when `NODE_ENV` is unset:

- Sydney control and analytical regions;
- selected Supabase control project;
- non-local TLS database URLs;
- exact `albert_transform_control_runtime` and
  `albert_transform_analytical_runtime` logins;
- distinct control and analytical database targets;
- exact candidate SHA and SHA-bound approval; and
- eight worker lanes with an eight-claim batch.

Every run has an explicit run id and a unique worker id. The database computes
count and p95 only from durable completions attributed to that worker after the
recorded start time. Ambient maintenance history cannot contaminate the
measurement. The diagnostic does not read private lease rows directly, accept
tenant ids, use a migration login, expose HTTP, or run in production.

The schema-v2 output fixes the 20,000-tenant, 3,600-second, 70%-utilization,
two-Machine floor, and 40-Machine ceiling constants. It labels the arithmetic
as a projection and always records:

- `measurementScope: "single_process_diagnostic"`;
- `workerProcesses: 1`;
- `releaseEligible: false`; and
- the four unresolved blockers: fleet saturation, representative workload,
  staging orchestration, and trusted distributed attestation.

`diagnosticPassed` means only that the run-scoped sample met its requested
count, the durable count matched the pipeline return value, and the
single-process projection stayed inside the reviewed arithmetic ceiling. It
does not mean that the fleet can meet the objective.

Under this ADR, production release preflight failed closed regardless of a
supplied JSON value. No environment variable could convert the diagnostic into
capacity evidence. ADR 0034 later implemented an independent protected
workflow that:

1. deploys the exact candidate to a dedicated Sydney staging cell;
2. quiesces normal snapshot workers and restores them after the run;
3. seeds and attests workload strata representative of expected source rows,
   canonical projections, and tenant sizes;
4. runs the proposed number of candidate processes concurrently and measures
   shared database, pool, lock, and autoscaler behaviour;
5. supply-chain-attests the result to the candidate SHA and protected run; and
6. applies the proven transform Machine floor before serving traffic.

ADR 0034 is that superseding decision and executable release contract. It does
not reuse schema-v2 diagnostic output as if it were fleet evidence.

Maintenance lease history is operational telemetry, not an event archive.
Completed rows receive `completed_at` and `(worker_id, completed_at)` indexes
and are retained for 48 hours; stale incomplete rows are retained for at most
24 hours after expiry. The normal snapshot path invokes the bounded retention
routine after each sweep.

## Consequences

- Engineers can compare exact candidate snapshot-path latency without mixing
  other workers' 24-hour completions into the sample.
- Staging diagnostics fail before work when privileged/wrong-region/local
  database URLs, configuration drift, or weak approval are supplied.
- A manually fabricated or edited JSON document cannot unlock production.
- The release cannot deploy an unproven calculated floor because production is
  blocked until distributed evidence and floor application are implemented
  together.
- At the time of this ADR, operators had to quiesce and seed the dedicated
  staging cell manually. ADR 0034 replaces that release blocker with enforced
  orchestration and an approved corpus fingerprint.
- Maintenance completion queries remain bounded and indexed at the design
  cadence rather than growing by roughly 175 million rows per year.

## Alternatives considered

- **Linearly extrapolate one process:** rejected because it cannot measure
  shared-resource saturation or autoscaler behaviour.
- **Paste a staging JSON artefact into a protected variable:** rejected because
  editable JSON is not provenance or attestation.
- **Trust `NODE_ENV=production` in an operator shell:** rejected because the
  capacity environment, not ambient Node mode, defines the managed boundary.
- **Require an empty 24-hour completion window:** rejected because deployed
  workers run a snapshot immediately and hourly, making that procedure
  self-defeating. Exact run attribution is the correct diagnostic boundary.
- **Generate load in production:** rejected because customer workloads must not
  become capacity experiments.
- **Drop the diagnostic entirely:** rejected because run-scoped latency remains
  valuable engineering evidence when represented honestly.

## Verification

- `tests/contracts/transform-capacity-harness.contract.test.ts`
- `tests/release-preflight.test.mjs`
- `scripts/transform-capacity-harness.ts`
- `scripts/release-preflight.mjs`
- `infra/migrations/control-plane/0051_m2_transform_maintenance_capacity_retention.sql`
- `deploy/README.md`
