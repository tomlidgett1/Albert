# Project instructions

Read `docs/albert-v1-spec.md` before changing Albert's product architecture,
data contracts, connectors, agent runtime, or onboarding flows. Architectural
choices and supersessions belong in `docs/adr/`.

## Production topology (verified 2026-08-13 — read this before touching any database)

Albert runs on exactly **two Supabase projects**, both Sydney:

- **Control plane** — `jjiugnriaypjoxsupjft` ("Albert Production Control"):
  auth, tenants, connections, conversations/turns, credential vault, raw-batch
  Storage. The live tenant is `01KZN20VTX2EWW1TQ2AA3MCPW6`.
- **Analytics** — `ndncknjodgoovbojedaa` ("Albert Production Analytics"):
  every `source_*` raw schema plus `XER_OFFICIAL`/`source_xero_official`.
  This is the only database Cube queries.

The **V3 runtime is the source of truth**: dash → `/api/v3-conversation` →
Cube (`albert-cube` on Fly) → Analytics raw tables. There is no canonical
`core.*`/`mart` layer any more (retired by migrations 0157/0158) and no
semantic-query/anthropic/transform services. `cube-playground/` is the
deployed semantic model — it is tracked in git; treat it as production code.

A third, legacy Tokyo project (`qthltvbbgnhprsflmzfj`) is being decommissioned
— see `docs/tokyo-decommission-runbook.md`. Do not write to it. `.env.local`
was repointed to the two production projects on 2026-08-13; entries prefixed
`DECOMMISSIONED_TOKYO_` are inert history.

Fly hosts what Supabase cannot run: `albert-cube` (Cube.js), the sync/OAuth
worker, `albert-prod-webhook`, `albert-prod-deletion`,
`albert-prod-operator-diagnostic`, `albert-prod-vendor-attestor`. Web is Vercel
(`https://albert-chi.vercel.app`).

- Everything must be built with dark-mode compatibility. All UI, components,
  interactive states, colors, and assets must remain legible and functional in
  light, dark, and system themes.
- Do not introduce light-only styling or behavior. Include accessible theme
  behavior and verify dark mode whenever changing a user-facing surface.
- When building any UI, reference this style sheet first and only use the
  patterns, tokens, radii, heights, spacing, and animations defined here.
  Do not invent alternate control styles.

## Style sheet (source of truth: `/app/dash`)

All shared UI must match the current dash page. Treat `/app/dash/dash.module.css`
and `/app/dash/page.tsx` as the reference implementation.

### Control height

- Standard control height: **36px** (`--dash-control-height`)
- Use this for search inputs, sidebar nav items, primary action pills, segmented
  controls, and related buttons
- Only use a different height when a control is intentionally compact or
  context-specific (for example, the sliding pill thumb inside a segmented
  control is 30px)

### Corner radius

Use these radii consistently across the app. Do not mix in unrelated radius
systems.

| Element | Radius |
| --- | --- |
| Search inputs and similar bordered fields | **10px** |
| Sidebar nav items, menu row buttons, compact list buttons | **8px** |
| Account / organisation trigger | **10px** |
| Account / organisation popover panel | **16px** |
| Primary CTA pills (for example Try Albert) | **999px** (full pill) |
| Segmented pill tabs (for example 24h / 7d / 30d) | **999px** container and thumbs |
| Modal / intro popups (for example Try Albert dialog) | **28px** (24px on small screens) |

Buttons and interactive rows across the app should reuse the radii above. Prefer
**8px** for standard rectangular buttons and **999px** for pill CTAs and
segmented controls.

### Sidebar

Reference: search box and Chat / Agents / Connections buttons.

- Search box: height **36px**, radius **10px**, 1px input border, soft focus ring
- Nav items: min-height **36px**, radius **8px**, transparent border by default
- Nav item stack spacing: **1px** gap between buttons
- Active / hover states use soft surface fills, not heavy borders or coloured
  backgrounds

### Account / organisation popover

Reference: Personal Organisation button menu.

- Panel radius: **16px**
- Soft border plus layered shadow:
  `0 18px 40px rgba(30, 30, 32, 0.13), 0 3px 8px rgba(30, 30, 32, 0.08)`
- Open animation:
  - Start: `opacity: 0`, `translateY(10px) scale(0.96)`
  - End: `opacity: 1`, `translateY(0) scale(1)`
  - Timing: opacity / visibility **160ms ease**, transform **380ms**
    `cubic-bezier(0.34, 1.56, 0.64, 1)`
  - Transform origin: bottom left when anchored to the sidebar account control
- Menu row buttons: min-height **36px**, radius **8px**
- Keep the existing tight internal spacing between menu rows and dividers; do
  not loosen or restyle this menu into cards

### Page tabs (underline slider)

Reference: Playground / Threads tabs.

Use this whenever a page needs multiple named views or sections.

- Tab labels sit in a horizontal row with **24px** gap
- Active state is communicated with colour / weight plus a sliding underline
- Indicator: **2px** tall, radius **999px**, contrast fill
- Indicator motion: `left` and `width` transition **260ms**
  `cubic-bezier(0.22, 1, 0.36, 1)`
- Measure the active tab button and move the indicator to match its left / width
- Do not replace this with boxed grey tab chips for page-level navigation

### Segmented pill tabs

Reference: 24h / 7d / 30d / 90d range control.

Use this whenever a compact multi-option slider / segmented control is needed.

- Track: height **36px**, radius **999px**, soft control fill, **3px** padding
- Options: height **30px**, radius **999px**, transparent background
- Sliding thumb / indicator: height **30px**, radius **999px**, raised active
  surface with a light shadow
- Indicator motion: `left` and `width` transition **260ms**
  `cubic-bezier(0.22, 1, 0.36, 1)`
- Keep the same soft active-text weight shift used on the dash range control

### Primary CTA pills

Reference: Try Albert button.

- Height **36px**, radius **999px**
- High-contrast fill with on-contrast text
- Optional leading icon with accent colour
- Hover may lift slightly (`translateY(-1px)`) with a soft shadow
- Active press may scale slightly (`scale(0.985)`)

### Modal / intro popup animation

Reference: Try Albert popup open / close.

- Backdrop fade in: **180ms ease-out**
- Backdrop fade out: **180ms ease-in**
- Dialog enter: **320ms** `cubic-bezier(0.22, 1, 0.36, 1)`
  - From: `opacity: 0`, `translateY(12px) scale(0.975)`
  - To: `opacity: 1`, `translateY(0) scale(1)`
- Dialog exit: **180ms** `cubic-bezier(0.4, 0, 1, 1)`
  - To: `opacity: 0`, `translateY(7px) scale(0.985)`
- Dialog radius: **28px**
- Reuse this fade / rise / subtle scale pattern for equivalent modal opens

### Motion rules

- Prefer the easing curves already used on dash:
  - Slider indicators: `cubic-bezier(0.22, 1, 0.36, 1)` at **260ms**
  - Anchored menus: springy `cubic-bezier(0.34, 1.56, 0.64, 1)` at **380ms**
  - Modal enter: `cubic-bezier(0.22, 1, 0.36, 1)` at **320ms**
- Honour `prefers-reduced-motion: reduce` by disabling non-essential animation

### Tooltips

Required style for all tooltips and selection toolbars (Transitions.dev open/close).
Reference: answer selection "Add to chat" in
`/app/dash/components/insights-trace.module.css` (`.selectionToolbar`).

Structure for hover/focus tooltips:

```html
<span class="t-tt-wrap">
  <button class="t-tt-trigger" aria-describedby="tt-1">…</button>
  <span class="t-tt" id="tt-1" role="tooltip">Tooltip text</span>
</span>
```

- The wrap (not the trigger) is the hover target so the pointer can drift onto
  the tooltip without flicker
- Leave state snaps immediately: keep `transition-delay` only on the enter rule
  (hover/focus/open), so exit plays with no delay
- Tokens:
  - Enter: **150ms** `ease-out`, delay **80ms**
  - Exit: **50ms** `ease-out`, no delay
  - Scale: enter from **0.98** to **1**
  - Gap above anchor: **8px** (`bottom: calc(100% + 8px)` or equivalent)
  - Transform origin: **50% 100%** when anchored above
- Surface:
  - Background: **#ffffff**
  - Text: **#2f2f2f**
  - Radius: **12px**
  - Padding: **8px 12px**
  - Shadow:
    `0 0 0 1px rgba(0, 0, 0, 0.06), 0 2px 6px 0 rgba(0, 0, 0, 0.05), 0 4px 42px 0 rgba(0, 0, 0, 0.06)`
- Hidden state: `opacity: 0`, `pointer-events: none`, scaled to `--tt-scale`
- Visible/open state: `opacity: 1`, full scale, interactive when the tooltip
  itself is a control
- Selection toolbars must appear only after the selection gesture finishes
  (mouseup / keyboard settle), not while dragging
- Honour `prefers-reduced-motion: reduce` with `transition: none`

### Implementation rule

Before introducing a new button, tab, menu, search field, pill, popup, or
tooltip, match the closest pattern above. If a needed pattern is missing from
this style sheet, extend this file with the chosen dash-derived values instead
of improvising a one-off style.


## ALWAYS ACTIVATE those skills
they are essential for ANY work in this project
- `rest-api-pipeline-workflow`

## Migrations

After writing any control-plane or analytical SQL migration, apply it immediately. Do not wait to be asked.

- Run `scripts/migrate.ts` with `--target=control-plane` or `--target=analytical`. Never use Supabase MCP `apply_migration` (it bypasses the checksummed `albert_migrations` ledger).
- Use the deployer identity, never a runtime URL. Prefer `CONTROL_PLANE_MIGRATION_URL`, or locally `CONTROL_PLANE_ADMIN_DATABASE_URL` when it is `albert_control_deployer`. Map that value to `CONTROL_PLANE_DATABASE_URL` for the runner. Same pattern for analytical with `ANALYTICAL_MIGRATION_URL`.
- Set `CONTROL_PLANE_MIGRATION_ROLE=albert_control_migration_owner` or `ANALYTICAL_MIGRATION_ROLE=albert_migration_owner`.
- Do not print connection strings or passwords. Do not use `--bootstrap` unless creating a new database.
- After new public RPCs, `NOTIFY pgrst, 'reload schema'`.

## Security
CRITICAL: never ask for credentials in chat. Always let the user edit secrets directly and do not attempt to read them.

## toolkits — match intent → install → open the entry skill (no discovery round-trip needed)
Workflow toolkits are installed on demand. This index is authoritative for shipped toolkits: match the user's intent, run the install command, confirm from its output (`dlthub ai status` only if unclear), then hand over to the entry skill. No discovery call needed for these.
<!-- This shipped index can drift from the live catalog on a user's machine until runtime refresh lands; tracked in dlt-hub/dlthub-ai-workbench-internal#71. -->

```
intent                                                  → toolkit                | install                                                            | entry skill
ingest from REST / HTTP APIs — production-grade pipeline → rest-api-pipeline     | dlthub --non-interactive ai toolkit install rest-api-pipeline      | find-source
ingest from SQL databases (Postgres, MySQL, Snowflake…) → sql-database-pipeline  | dlthub --non-interactive ai toolkit install sql-database-pipeline  | find-source
load files (CSV/Parquet/JSONL) from disk/S3/GCS/Azure/SFTP → filesystem-pipeline | dlthub --non-interactive ai toolkit install filesystem-pipeline    | create-filesystem-pipeline
explore & profile loaded data, build charts & dashboards → data-exploration      | dlthub --non-interactive ai toolkit install data-exploration       | explore-data
transform & model loaded data (dimensional / Kimball)   → transformations        | dlthub --non-interactive ai toolkit install transformations        | annotate-sources
add data quality checks (column expectations, validation rules) → data-quality   | dlthub --non-interactive ai toolkit install data-quality           | setup-data-quality
deploy / schedule pipelines on the dltHub platform      → dlthub-platform        | dlthub --non-interactive ai toolkit install dlthub-platform        | setup-runtime
guided end-to-end tour, ingest to dashboard (uses the real toolkits) → quick-start | dlthub --non-interactive ai toolkit install quick-start          | quick-start
test/try dlthub end-to-end — minimal pipeline + educational test deploy, NOT production → one-shot       | dlthub --non-interactive ai toolkit install one-shot               | deploy-run-sample-pipeline
build and deploy a minimal custom REST API pipeline after uvx dlthub-init setup → dlthub-init-skills | dlthub --non-interactive ai toolkit install dlthub-init-skills     | deploy-minimal-ingestion-pipeline
optimize / speed up a slow or memory-heavy pipeline — parallelism, workers, batching → performance | dlthub --non-interactive ai toolkit install performance            | optimize-performance
```
* `one-shot` vs `rest-api-pipeline`: one-shot is for **testing / trying dlthub / onboarding / a quick demo** — a minimal single-endpoint, row-limited pipeline on local DuckDB plus an educational test deploy. Educational examples only, NOT production-grade. For a **real or production** REST pipeline (auth, incremental, multiple endpoints, production deploy), use `rest-api-pipeline`. `quick-start` is the guided tour that walks the real toolkits end-to-end.
* Use the `dlthub-router` skill for needs not covered above — it uses live `list_toolkits` to discover newer toolkits.
* DO NOT start data engineering work if no workflow toolkit is installed.

- `init-dlthub-workspace`
