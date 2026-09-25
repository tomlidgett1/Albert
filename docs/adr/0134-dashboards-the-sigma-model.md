# 0134 — Dashboards, plural, on Sigma's element model

Date: 2026-09-03. Status: accepted.

## The ask

The dashboard-building experience was poor. The owner wants to see every
dashboard they have built, start a new one and build it in natural language
only, watch elements render in real time, click an element and tell Albert
what to change about it, and change an element's filters, sorting and data
the way Sigma Computing does. Sigma's official documentation
(help.sigmacomputing.com) is the source of truth for anything dashboard.

## What Sigma does (from the docs)

- Home lists documents ("Create New" → "Workbook"; "Recents", "Documents");
  a document's menu carries "Rename" and "Delete" (with a confirmation).
- An element shows a toolbar in its top-right corner on hover or selection:
  "Filters", "Maximize element", "More" ("Duplicate", "Delete element",
  "Export", "Explain this chart", "Sort" → "Custom sort…").
- Every table column header has a caret menu: "Sort ascending",
  "Sort descending", "Filter", "Rename", "Format" and friends; a right-clicked
  value offers "Keep only" / "Exclude".
- Element filters are cards typed by the column's data: "List" (include or
  exclude values), "Text match", "Number range", "Date range". Filters and
  sorts apply in every workbook mode.
- AI inside a workbook is the formula assistant's wand and "Explain this
  chart"; Sigma Assistant is the natural-language entry.

## Decisions

### Many dashboards per member (migration 0186)

`personal_dashboards` loses its one-per-member unique key. Every dashboard
RPC gains a trailing `p_dashboard_id text DEFAULT NULL`; an unnamed call
resolves the member's most recently touched dashboard and creates one on
first use, so every pre-0186 caller — including the deployed web tier —
keeps working unchanged. New RPCs: `albert_dashboard_list`, `_create`,
`_delete`, `_link_conversation` (the dashboard remembers the conversation
that last built it). Refresh completion resolves the dashboard from the
tile's own lease. The old overloads are dropped so PostgREST never sees two
candidates.

Web: `GET /api/dashboard/list`; `GET /api/dashboard?dashboardId=`; `POST`
creates; `DELETE` removes; every mutation body accepts `dashboardId`.

### The Dashboards tab is the list

Heading, one line, one "New dashboard" button, quiet rows (title, element
count, last edited) with a More menu for Rename and Delete. A row opens the
dashboard full-page with a back link. "New dashboard" creates a blank
document and opens dashboard mode on it: the chat builds it, the right card
waits with "Describe what you want to watch". A build turn's brief carries
`Target dashboard: <id>` as a trailing line the chat strips, so reopening
the conversation re-enters the same dashboard.

### The element model

Tiles are Sigma elements. Click selects (quiet ring); the toolbar appears
top-right on hover or selection: Filters (with a count), the Albert wand,
More (Show as, Sort by for charts and KPIs, Refresh, Open source analysis,
Delete element). Table headers carry a caret menu: Sort ascending, Sort
descending, Clear sort, Filter…, Rename, Format…. A right-clicked value
offers Keep only / Exclude. Menus render through a portal
(`DashPopover`) because grid items are transformed and tiles clip overflow.

### Sort and filters are element query overrides

A tile carries `query_overrides` jsonb (`order` ≤3, `filters` ≤8 typed by
Cube operator, `limit`), keyed by the tile's own snapshot column keys and
validated in SQL (`dashboard_query_overrides_valid`) and zod. They never
touch the governed replay recipe or its digests: the refresh adapter checks
the digests first, resolves column keys to query members, applies the
overrides to the validated base query (sort replaces order, filters append
with AND, limit only narrows), re-validates against the live catalogue, and
runs. An unknown column fails the refresh with `query_overrides_invalid`
rather than showing the wrong rows. Overrides need a governed query behind
the element (`cube_v3`); composed pivots and legacy semantic replays refuse
them. The client applies the same overrides to the rows on screen at once
and forces the element's refresh, so a sort or filter feels instant and the
full result set follows.

### Edit one element with Albert

The wand opens one field: "What should change about “Revenue by week”?".
The sentence runs as a dashboard-mode turn scoped to the tile:
`POST /api/dashboard/build` with `tileId` composes an element-edit brief
("Edit one element of my dashboard." + the element's governed query YAML,
columns, display and width, plus the rules: rebuild only this element, keep
its window, compose exactly ONE tile). The runtime's dashboard instructions
gain an "Editing One Element" section and the compose schema's floor drops
to one tile. `POST /api/dashboard/build/apply` with `replaceTileId` deletes
the old tile, pins the replacement and puts it in the exact slot the old
tile held on both breakpoints (a kind change takes its default height).
While it runs, the panel keeps the whole dashboard on screen and reworks the
one tile in place: skeleton, then the draft as its query lands, then the
applied tile. From the standalone view the wand enters dashboard mode on
that dashboard first, so the working streams into the chat.

### Derived results that refresh

The first production build after this ADR composed a single "Daily workshop
summary" tile — a `DeriveResult` inner join of two governed queries — and
apply refused it: derived results carried no replay reference. With the
compose floor at one tile the old three-tile minimum no longer forced the
source queries in. Two changes close this:

- `DeriveResult` inner joins and computes now seal a `derived_table_v1`
  derivation like a pivot's: left cells as indexed source references, right
  cells as `matched_source` lookups on the join key, computed columns as
  calculations, folded through a derived source to its governed leaves. The
  seal is granted only when every leaf fits the 50-row refresh snapshot and
  the transform materialises over those rows exactly (the sealed rows
  replace the tool's own, so trace and tile agree to the digit). Aggregates,
  anti-joins, left joins with unmatched rows, case-insensitive matches the
  exact replay matcher cannot reproduce, and oversized sources stay
  unreplayable, and the tool's notes say why.
- `ComposeDashboard` refuses a tile over an unreplayable result and names the
  replayable ones, so the plan self-repairs; the dashboard instructions state
  the rule; the apply route's error explains what to ask for instead.

### Realtime rendering

Unchanged and verified: during a whole build every governed result streams
in as a draft tile on the workspace grid geometry before the plan lands.

## Alternatives rejected

- **Client-supplied query edits.** The browser never sends a query; overrides
  are column-keyed presentation-level intent the server resolves and
  re-validates. The recipe stays digest-locked.
- **Whole-dashboard rebuild for an element edit.** Slow, expensive, and it
  redesigns what the owner did not ask to change. A scoped brief plus an
  in-place replace keeps the dashboard's shape.
- **Menus inside the tile.** Grid items are transformed and tiles clip
  overflow; menus were cut off on small tiles. A portal fixes both.
- **A "Dashboards" chat surface.** Dashboards are documents, not a chat
  mode; they belong beside Dashboard Master in the sidebar.

## Consequences

- Deploy order: apply 0186 first (old callers keep working), then the web,
  then the Fly runtime for the one-tile compose floor and the element-edit
  instructions. Until the runtime deploys, an element edit still works but
  an older runtime may pad the plan; apply uses only the first tile and
  reports the rest as skipped.
- "+ Add to dashboard" from a chat still lands on the member's most recent
  dashboard; a picker is a follow-up.
- Contract tests: `tests/contracts/dashboards-many.contract.test.ts` pins
  the migration, the override semantics and the routes; the build and
  personal-dashboard suites pin the brief formats and the element UI.
- Browser acceptance: "Dashboards lists every dashboard…", "Element sort and
  filters are query overrides…", "The Albert wand reworks one element in
  place", and the updated dashboard-mode test.

### Amendment (2026-09-03, evening): columns that never shift, and the cost of a call

The first production dashboard exposed two defects underneath the editor:

- **Column identity was minted three ways.** The Omni runtime traced
  columns as `validated.members` (which also lists filter and order members,
  so an ordered time dimension pinned twice) spelled with underscores; the
  pin copied that verbatim; the refresh rebuilt columns from Cube's row keys
  (dot spelling, Cube's order, plus the `.day` bucket key). Every Omni tile
  re-ordered on its first refresh, presentation keyed by exact key stopped
  applying, and every sealed derivation (pivots included) failed with
  `derived_transform_failed` because the refreshed sources spelled keys
  differently. Now one helper, `cubeResultColumns` in
  `packages/albert-v3/src/cube/presentation.ts`, mints columns in query
  order, deduplicated, underscore-keyed, for the runtime trace and the
  refresh alike; `alignColumnsToPrevious` keeps a refreshed tile's keys,
  labels and order exactly as the owner last saw them (a doubled column
  collapses, new members append); `canonicalColumnKey` makes every spelling
  of a member equal and the derived-table materializer resolves columns
  tolerantly; `validateCubeQuery` returns deduplicated members. Proven on
  the owner's own tiles through the real adapter.
- **Every dashboard call paid two transpacific round trips.** Only the omni
  route ran in Sydney; every other route ran in iad1 and re-authenticated on
  every repository call. Now `vercel.json` pins all functions to `syd1`,
  `requireUser`/`currentTenantContext` are memoised per request with React's
  `cache()`, the refresh adapter caches the Cube catalogue for five minutes,
  the refresh route answers immediately when nothing is eligible and runs
  eight tiles at a time.

### Amendment (2026-09-04): editing an element from first principles

The first cut edited every element through the Albert wand: a model turn
composed a new element, and the apply route replaced the tile with ten
sequential RPCs. It was slow (40–60 s), and a replaced tile is a new tile,
so columns, presentation and position had to be reconstructed. "Column
shifted positions, it takes too long" was the result. Sigma's editor has no
single path for every change; it has three, and so does ours now
(migration `0187`).

**Three edit lanes.**

1. *Display* — instant. Show as, chart type, orientation, stacking, the KPI
   value and comparison ("% difference from", "Difference from", "% of",
   "Absolute", higher or lower is better), column format, decimals, name,
   hide, and the authored column order. One `PATCH /api/dashboard/tiles/:id`
   (`albert_dashboard_tile_update` gained `p_column_order`, which rewrites the
   snapshot's column array — the contract a refresh aligns to). The client
   applies the change optimistically; the document that comes back replaces
   only the tile it changed.
2. *Requery* — deterministic, seconds. Truncate date, the date range or a
   comparison, a column or calculation added or removed, the row limit. The
   browser sends one of eight structured edits
   (`services/dashboard/src/query-edits.ts`), never a query. `POST
   /api/dashboard/tiles/:id/query` claims the tile's refresh lease (the Cube
   capability needs one), patches the recipe's CubeQuery, keeps it on the
   recipe's view, validates it against the live catalogue, applies the
   element's own sort/filters/limit for the run, runs it once, and stores
   the re-minted digest-locked recipe with its snapshot in one transaction
   (`albert_dashboard_tile_requery`). `recipe_version` guards two edits of
   the same element; the write is checked against the dashboard's revision
   *at write time*, so a title or layout change during the run cannot fail
   it. `alignColumnsForRequery` keeps the owner's column order and carries
   presentation, display keys and overrides across a re-spelled time column
   (a week column becoming a month column). If anything fails after the
   claim, `albert_dashboard_refresh_release` hands the lease back without an
   outcome: the element keeps its data and shows the edit's own message.
   The field list behind "Add column" (`GET …/fields`) reads the governed
   view from the shared catalogue cache with a tenant-only Cube token;
   `/v1/meta` needs no lease.
3. *Wand* — for everything else. The lean edit mode from the morning
   (one topic, one query, one tile, low effort, fast mode) measured 9.7 s
   end to end against production, and the apply is now one RPC
   (`albert_dashboard_element_replace`: delete, pin, title + display, the old
   slot on both breakpoints, the conversation link — atomically, with every
   step's own checks).

**The editor is Sigma's.** The element toolbar is Filters · Properties ·
the Albert wand · More. Properties (a portalled popover, two tabs) holds
Show as and the chart/KPI settings, then the governed query's shape:
Truncate date, Date range, the Columns list (move, hide, delete from the
query), Add column, Rows. Format holds column format, decimals, name, the
KPI comparison and the note. The More menu is Refresh data, Open source
analysis, Delete element. The column caret menu gained Hide column and
Delete column. A composed pivot's Properties says so and points at the
wand.

**Stale-while-revalidate.** An element with a requery in flight keeps its
rows or chart, shows a 2 px progress bar under its header (static under
`prefers-reduced-motion`) and is `aria-busy`. Edits to one element run in
order, each starting from the recipe the previous one produced; tile
mutations run in order too, each carrying the revision the previous one
returned. A failed edit shows one line inside the element with Dismiss; the
element's data is untouched.

**Consequences.** `dashboard_tiles` gained `recipe_version`,
`recipe_origin` ('trace' | 'edited') and `recipe_edited_at`; the document
carries `recipeVersion`/`recipeOrigin`. The refresh adapter is unchanged:
it still re-verifies the digests of whatever recipe is on the tile, so an
edited recipe refreshes exactly like a traced one. Rate policy
`dashboard.requery` (240/hour). The catalogue cache moved to
`services/dashboard/src/catalogue-cache.ts` so refresh, requery and the
field list share it.

**Sealed joins over rolling windows (same day).** Tom's composed "Daily
summary stats" failed every refresh with `derived_transform_failed`: an
inner join sealed when every day matched had, a day later, a day in one
source the other lacked. The materializer now leaves that cell blank
instead of failing the element (the join was verified when it was sealed;
drift is data, not corruption), and the refresh adapter records the
materializer's message in `adapter_metadata.detail` so the next such
failure explains itself.
