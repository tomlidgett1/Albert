# ADR 0153: Partner semantic query API

Date: 2026-09-24. Status: implemented; deploy recorded below.

## Why

Yellow Jersey's Analytics area has a Sigma-style dashboard editor. Until now
it read Yellow Jersey's own Postgres mirror through Yellow Jersey's own
semantic layer, so its numbers could disagree with Albert's (for example, it
treated Lightspeed's `calcSubtotal` as after discounts, overstating ex-GST
revenue and gross profit). The owner asked for the dashboard to read
Albert's semantic layer instead: the same governed views and measures Omni
answers from.

Albert had no way to run a structured query without an Omni turn. Cube only
answers a token that carries a running turn or a claimed dashboard-tile
refresh, and both of those exist for Albert's own surfaces.

## Decision

**1. A semantic query lease (control-plane migration 0196).** A new private
table, `control_plane.semantic_query_leases`, and two functions:

- `public.albert_semantic_query_lease_claim(expected_tenant_id, purpose)`,
  for authenticated members. It requires owner or manager, fails closed when
  the session's selected tenant is not the one the partner expects, and
  **reuses the member's live lease while it has at least 75 seconds left**.
  A lease lives three minutes; a tenant holds at most six unexpired leases.
  Reuse matters because Cube builds one orchestrator and connection pool per
  execution claim: a dashboard page issues a dozen queries at once and they
  should share one.
- `control_plane.issue_semantic_query_analytical_capability(tenant, lease,
  scope)`, a copy of the tile issuer (0121) keyed by lease, executable only by
  `albert_semantic_control`. The capability expires with the lease.

The table uses FORCE RLS with the migration-owner policy (the 0118 pattern)
and grants nothing to client roles. No analytical migration is needed: the
capability reuses the `semantic_read` audience and scope.

**2. Cube accepts exactly one execution claim.** `cube.js` gains
`semantic_query_lease_id`. `executionKind` returns turn, dashboard or
semantic query only when exactly one claim is present, and both
`prepareConnection` and `queryRewrite` use it, so a token with two claims (or
none) has no execution. A lease token's API scopes are `meta` and `data`
only. The orchestrator id includes the lease.

**3. Two partner routes** (bearer sessions from `partner-session` only,
owner or manager, `expectedTenantId` required, `semantic.query` rate limit of
240 calls a minute per member, `Cache-Control: private, no-store`):

- `GET /api/semantic/meta?expectedTenantId=…` returns the governed views with
  each member's title, type, description, guidance, display format and
  measure aggregation. Members hidden from model-facing surfaces and each
  view's `tenant_id` are left out. Formats and aggregations come from Cube's
  raw meta inside this route; the shared catalogue parser is unchanged, so
  Omni's catalogue digest is unaffected.
- `POST /api/semantic/query` takes `{expectedTenantId, queries}` with up to 12
  Cube JSON queries (strict schema: known keys only, bounded members,
  filters, values, limit 1 to 2,000, offset up to 100,000, `ungrouped` and
  `total` allowed). Each query is checked with `validateCubeQuery` against
  the live catalogue on its own, so a bad one fails alone. Row listings
  (`ungrouped`) are refused on aggregate-only views. The batch runs under one
  lease, four at a time, through `CubeClient.loadQuery`, which applies
  `enforceCubeResultPrivacy`. Results come back in order as
  `{ok, view, rows, annotation, total?, executionMs}` or `{ok: false, code,
  error}`.

**4. `total`.** `CubeClient` now returns Cube's `total` when a query asks for
it, so a partner table can say how many rows match.

## Not chosen

- **Cube's SQL API (`/v1/cubesql`).** It is switched off on albert-cube, and
  turning it on would bypass every TypeScript guard (one view, aggregate-only
  policies, group sizes, limits) and allow arbitrary row-level SQL.
- **Synthetic turns.** They work without a migration but put conversation
  rows in the owner's list and allow one running turn per conversation.

## Consequences

- Partner dashboards and Omni answer from the same governed definitions.
- Data freshness is Albert's: while Fivetran's plan is paused (since 19
  Sep), partner dashboards stop there too.
- Lease rows older than a day are deleted by the next claim for that tenant.
- The query ledger (`analytical_query_attempts`) needs a turn, so partner
  queries are logged by lease id in the web logs instead.
