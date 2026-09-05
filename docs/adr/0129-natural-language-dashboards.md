# 0129 — Natural-language dashboards on the Omni harness

Date: 2026-08-30. Status: accepted.

## The ask

A "Build dashboard" button on the main UI: the owner types "I need a dashboard
that shows top level metrics" and Albert designs, executes and assembles a
live dashboard. The builder must run on the Omni harness (ADR-era
`packages/albert-omni`, the strongest and fastest analytical runtime we have).

## What a great dashboard is, from first principles

A chat answer serves a one-off question. A dashboard exists because some
questions are *standing* — the owner will ask them again tomorrow. Everything
else follows from that:

1. **Tiles are queries, not answers.** A standing question must re-execute.
   The artifact we persist is a governed query plus presentation, never a
   baked number. (This is exactly what the pinned-tile store already encodes:
   a `cube_v3` replay recipe with digest checks.)
2. **Glanceable means comparative.** "Revenue $48,213" is not information;
   "$48,213, up 12% on the previous 30 days" is. Every KPI needs a
   like-for-like comparison, and the delta must be computed by deterministic
   code over two governed cells — never by the model.
3. **Hierarchy: level → direction → composition → detail.** The scan order of
   every good dashboard: a KPI row (state), a hero trend (direction),
   breakdowns (composition), a table (actionable detail). The builder's
   layout grammar encodes this instead of leaving it to chance.
4. **One coherent timeframe.** Mixed windows destroy glanceability. The
   dashboard states its window once; tiles that deviate must say so.
5. **Trust is structural.** Every figure traces to a governed query that
   actually ran, with provenance, freshness watermarks and semantic-version
   digests. A tile that cannot replay is not a tile.
6. **Opinionated beats configurable.** The agent is the designer. A
   constrained grid, three tile kinds and fixed width steps produce
   consistently professional output; a free canvas produces slop.
7. **Iterable through the same channel.** The first build is a draft; the
   owner refines it by talking ("add wages", "make the trend weekly"). The
   spec-in → spec-out loop makes refinement the same operation as building.

## Decision

Compose the builder out of two systems that already exist, and close the gaps
between them:

- **The personal live dashboard** (migrations 0117–0121): per-tenant tile
  grid, `albert_dashboard_pin` resolving replay recipes from the immutable
  conversation trace, claim/complete refresh with digest verification, 5-min
  auto-refresh while open. This was previously reachable only by hand-pinning
  v3 tables; the tab was hidden.
- **The Omni harness**: the analyst agent with governed query tools, task
  lists and research events, streamed as SSE through
  `/api/omni-conversation`.

The build is **one Omni turn in dashboard-architect mode**
(`dashboardBuild: true` on `OmniServiceTurn`):

1. `POST /api/dashboard/build` composes an architect brief server-side (the
   owner's instruction + current dashboard summary for refinement) and
   consumes the `dashboard.build` rate limit.
2. The browser runs the turn through `/api/omni-conversation` exactly like
   any Omni conversation — live tasks, research and query cards ARE the build
   progress UI. The turn is a real conversation, so every tile's "open source
   analysis" affordance lands on the build trace.
3. In dashboard mode the agent keeps its full query discipline but swaps
   answer-formatting instructions for a dashboard design system, loses the
   chat chart tool, and gains one tool: **ComposeDashboard**. Its executor
   validates every tile against evidence *the agent actually executed this
   turn* (result ids, column keys, non-empty rows) and bounces failures back
   for self-repair. On success it emits a `dashboard_plan` trace event.
4. `POST /api/dashboard/build/apply` reads the **persisted** trace (never a
   client payload), resolves each planned tile's `resultId` to its table
   event, then drives the existing RPCs: clear (replace mode), pin, set
   title/display, apply a deterministically packed layout. Grounding is
   inherited from `albert_dashboard_pin`, which refuses tables without a
   valid replay reference.

### Gap closures this required

- **Omni tables are now pinnable.** `runQueryCore` stamps `dashboardReplay`
  (`cube_v3` with `cubeQueryDigest`/`cubeSemanticVersionDigest` — identical
  canonicalisation to v3, verified compatible because `filteredCatalogue`
  never alters a view's member list) and stamps `resultId` on query events.
  The remote runtime cannot know web-stamped event ids, so the omni web route
  pairs query→table by `resultId` and fills `queryEventId` before emitting;
  unpaired replay refs are stripped, never persisted broken.
- **Omni traces now persist at all.** The `albert_answer_event_append` type
  whitelist (0140) predates Omni: the first `tasks` event was rejected, and
  the contiguous-sequence gate then rejected every later event — in
  production, no Omni turn had ever persisted a `tasks`, `research`, `query`,
  `table` or (substantive) `answer` event, which also fed follow-up turns the
  "nothing was answered" note. Migration 0179 widens the whitelist
  (`tasks`, `research`, `dashboard_plan`).
- **Tiles learn presentation.** `display` jsonb on `dashboard_tiles`
  (`{"mode":"table"}` default, `kpi` with a value column, `chart` with a
  grounded-flint config). Rendering reuses `compileGroundedFlint` +
  `FlintChartView` for charts and `formatDashboardCell` for KPIs, so
  dashboards look exactly like Albert's answer visuals. KPI deltas are
  computed in the renderer from the two rows of a `compareDateRange` query —
  the sanctioned two-cell arithmetic class. Column keys are matched
  tolerantly (`sales_gross` ≡ `sales.gross`) because Omni publishes
  underscore keys while refresh snapshots use raw member keys.

### Layout grammar

12-column grid (existing). The plan speaks in width words — quarter, third,
half, twoThirds, full — and the apply route packs rows greedily in plan
order: KPIs at 3×5, charts at 6×9, tables at 6×7 by default. Tablet maps the
same words onto 8 columns. No agent-authored x/y; determinism keeps generated
layouts clean and diffable.

## Alternatives rejected

- **A parallel dashboard store** (spec JSONB per dashboard, own hydrator):
  duplicates replay, refresh, revision and purge machinery that already
  exists and is battle-tested; loses hand-pinning interop.
- **Plan as fenced JSON in the answer text**: no schema enforcement, no
  self-repair loop, fragile parsing. A strict tool gets SDK-level validation
  and lets the executor reject unexecuted result ids.
- **Server-orchestrated multi-worker session** (Dashboard Master shape): a
  build is one architect's coherent design pass, not a breadth investigation;
  a single turn is faster, cheaper, and keeps one provenance trail.
- **Client-supplied plan on apply**: the browser could then pin arbitrary
  content. Apply trusts only the persisted, sanitised trace.

## Consequences

- Hand-pinned tables gain the same display modes (a pinned table can become a
  chart tile) via the widened `albert_dashboard_tile_update`.
- Omni chat tables become pin-eligible everywhere, closing the "+ to
  dashboard" gap for the flagship runtime.
- The Dashboard tab is un-hidden and becomes the feature's home; the build
  composer lives there, with the empty state as the builder hero.
- Deploy order: Fly runtime (schema + tool) before Vercel web (sends
  `dashboardBuild`), matching the connector-scope precedent. The runtime
  ignores unknown-field-free old requests, so old web + new runtime is safe.
- Migration 0179 (control-plane): event whitelist, `display` column,
  document/tile_update updates, `dashboard.build` rate policy.
