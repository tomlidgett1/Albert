# ADR 0102: Idempotent per-turn orchestrator creation in Cube

- Status: Accepted (deployed to `albert-cube` 2026-08-19)
- Date: 2026-08-19
- Owners: Albert data platform
- Extends: ADR 0089 (immutable single-node Cube release), ADR 0097 (planned lanes)

## Context

Every Albert v3 turn gets its own Cube orchestrator
(`contextToOrchestratorId` in `cube-playground/cube.js` keys on the turn id) so
that pooled Postgres connections only ever carry that turn's analytical
capability. The first data request of a turn therefore always creates a fresh
orchestrator.

On 2026-08-19 follow-up questions of the shape "how does this compare with the
same period last year" stopped answering: the trace showed a single
`compareDateRange` query, ten "Continue wait" polls, then
`Cube did not finish the query within 90 seconds` and an *Unavailable* answer.
The generated SQL executed in 126 ms on the analytics database; the same
query on a warmed turn returned in ~1 s; two plain queries fired concurrently
on a fresh turn returned in ~5 s. Only "first query of the turn is a
compareDateRange (multi) query" hung, and it hung deterministically.

Cube's trace log (captured on a throwaway machine with `CUBEJS_LOG_LEVEL=trace`)
showed the mechanism:

1. The API gateway resolves a `compareDateRange` load into N sub-queries and
   calls `getAdapterApi(context)` for each of them inside one `Promise.all` —
   i.e. in the same tick.
2. `CubejsServerCore.getOrchestratorApi` (Cube 1.7.16) is check-then-set across
   `await`s. For a *new* orchestrator id both calls miss the storage lookup and
   each builds a complete OrchestratorApi (query orchestrator, cache, queue,
   driver pool). The second overwrites the first in `orchestratorStorage`.
3. With `CUBEJS_CACHE_AND_QUEUE_DRIVER=memory` both queue instances share one
   state object (keyed by the queue prefix) but keep independent queue-id
   counters, so both sub-queries were processed under `processingId 2`. The
   instance that lost the processing-lock race saw its own id in the lock,
   released it on "Skip processing", and when the real execution finished
   Cube logged `Orphaned execution result — Result for query was not set due
   to processing lock wasn't acquired` and dropped the rows.
4. The query stayed in `active` until the stalled-query sweep (~2 minutes);
   every poll answered "Continue wait"; the engine's 90 s cap fired.

Separate HTTP requests do not hit the race because Cube reaches
`getOrchestratorApi` and stores the instance within one macrotask; only the
same-tick fan-out inside a single request (compareDateRange, `total`) does.
The failure surfaced now because follow-up turns re-use cached data-range
probes and so their first Cube query is the compare itself, on a cold
orchestrator.

## Decision

`cube-playground/cube.js` installs an idempotency guard on
`CubejsServerCore.prototype.getOrchestratorApi` before `cubejs server`
instantiates the core (the config file is required first): concurrent callers
for the same orchestrator id await one in-flight creation promise; the storage
lookup stays the fast path for warmed turns. The guard refuses to start Cube if
the internals it relies on (`orchestratorStorage`, `contextToOrchestratorId`)
have moved, so a Cube upgrade cannot silently reintroduce the race. The image
pin (`cubejs/cube:v1.7.16@sha256…`) and the release smoke remain the upgrade
gate.

The engine additionally refuses a query that lists a bucketed time dimension
again under `dimensions` (`validateCubeQuery`): Cube then GROUP BYs the raw
timestamp too and a "monthly, limit 12" query returns twelve arbitrary sales.
This shape was emitted by the same failing turn; it was not the cause of the
hang, but it would have produced a wrong answer had the query returned.

`deploy/fly/cube.toml` now ships `CUBEJS_DB_QUERY_TIMEOUT = "2m"` (statement
timeout on every pooled connection) so one runaway statement cannot hold a
queue slot for Cube's default ten minutes.

## Consequences

- A fresh turn whose first query is a compareDateRange query returns in the
  normal cold-start time (~5 s; ~20 s once per tenant after a Cube restart
  while the schema compiles) with zero Continue-wait polls. Verified against
  production Cube with a freshly minted turn lease.
- The engine's 90 s Continue-wait cap is unchanged. It is a safety bound, not
  a query budget: legitimate queries finish in seconds, the database now stops
  statements at two minutes, and Cube's stalled-query sweep is ~two minutes, so
  90 s is the point at which waiting longer cannot change the outcome. What
  was wrong was Cube answering "Continue wait" for a query it had already
  finished and discarded.
- Contract test `tests/contracts/v3-cube-query-validation.contract.test.ts`
  pins both the validator rule and the presence/order of the guard in
  `cube.js`.
- Follow-ups (not in this change): per-turn orchestrators are never released,
  so each turn leaves an OrchestratorApi, queue and driver pool (with its
  eviction timer) alive until the machine restarts; the Cube machine still
  runs in `nrt` although the config says `syd`; and the second half of the
  upstream bug (per-instance queue-id counters over shared local queue state)
  is worth reporting to cube-js/cube alongside the creation race.

## Reproduction (for future regressions)

Mint a conversation + `running` turn in `control_plane.conversation_turns`
(project `jjiugnriaypjoxsupjft`), sign a Cube JWT for it, and make the *first*
`/cubejs-api/v1/load` a `compareDateRange` query with `queryType=multi`. Before
the guard it polled "Continue wait" until the caller gave up; after it, the
first call returns rows. `fly logs -a albert-cube` (capped at 100 lines) shows
the poll requests but no error; the trace level log shows
`Skip processing` / `Orphaned execution result` for the two sub-queries.
