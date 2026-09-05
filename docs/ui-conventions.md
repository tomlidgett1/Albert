# Albert UI conventions

Status: active
Source of truth: `app/dash/page.tsx` and `app/dash/dash.module.css`

This document records the conventions already present in `/dash`. It is a map of the existing design system, not a second design system. When code and this document differ, preserve the established `/dash` pattern and update this document in the same change.

## Principles

- Build every product surface inside the existing dash shell.
- Support `light`, `dark`, `system`, and the selectable `beige` and `green` palettes. New colours belong in the `.dash` token block and use `light-dark()` unless a brand colour has sufficient contrast in both themes.
- Keep interaction state legible without relying on colour alone.
- Use real data states and explicit copy. Animation may explain a transition, but must never imply progress that did not occur.
- Honour `prefers-reduced-motion: reduce` and Framer Motion's `useReducedMotion()` for every non-essential transition.

## Foundation

- Font: Geist with the repository-wide `--text-scale` multiplier.
- Sidebar: `260px`, collapsing to the established compact width.
- Standard control height: `36px` via `--dash-control-height`.
- Canvas, surface, text, border, focus, success, contrast, and accent colours come from the `.dash` custom properties.
- The beige palette uses a warm cream canvas, layered stone surfaces, charcoal text, and a restrained burnt-orange accent; component geometry and hierarchy remain identical to every other theme.
- Focus-visible treatment: `2px solid var(--dash-focus)` with a `2px` or `3px` offset.

## Shape and spacing

| Pattern | Radius | Notes |
| --- | ---: | --- |
| Search / bordered field | `10px` | One-pixel input border and soft focus ring |
| Navigation / menu / compact row | `8px` | Soft fill on hover/active |
| Account trigger | `10px` | Standard `36px` height |
| Anchored popover | `16px` | Tight rows and layered dash shadow |
| Primary CTA | `999px` | High-contrast `36px` pill |
| Segmented control | `999px` | `36px` track, `3px` padding, `30px` thumb |
| Modal | `28px` | `24px` on small screens |

Use the smallest native pattern that fits. Do not turn dense menus or review queues into decorative card grids.

## Motion

- Slider indicators: `260ms cubic-bezier(0.22, 1, 0.36, 1)`.
- Anchored popovers: opacity/visibility `160ms ease`; transform `380ms cubic-bezier(0.34, 1.56, 0.64, 1)` from `translateY(10px) scale(0.96)`.
- Modal backdrop: `180ms`; modal enter: `320ms cubic-bezier(0.22, 1, 0.36, 1)` from `translateY(12px) scale(0.975)`; exit: `180ms cubic-bezier(0.4, 0, 1, 1)`.
- Inline trace events: at most a `6px` rise plus opacity using the modal/slider easing. Data rows are not individually staggered.
- Reduced motion renders the final state immediately. Progress values and status text remain truthful and accessible.

## Navigation and controls

- Page-level views use measured text tabs with a `2px` sliding underline and a `24px` label gap.
- Compact choices use the measured segmented pill control.
- The chat top bar is a three-column grid: the Chat / Discover / Scheduled
  segmented pill (a `tablist`) at the top-left of the chat card, then the
  conversation title, then the header actions. The card carries `12px` top padding above the bar.
  The chat offers one harness (Omni); there is no runtime menu in the header.
- A model/runtime picker is one compact composer trigger opening a native `16px` anchored popover. Model choices are radio rows; speed and reasoning are segmented controls. Developer-only switches (the raw debugger) live in this popover, never in the header.
- Controls are keyboard reachable, expose `aria-expanded`, `aria-pressed`, `aria-current`, or radio semantics as appropriate, and return focus when a dialog/popover closes.

## Connections

- Preserve the current restrained vertical provider list.
- Treat authorization health and data readiness as separate states.
- Provider rows show a logo, name, purpose, authorization health, the most useful freshness signal, and a `36px` Connect/Reconnect/Manage action.
- Readiness uses the exact domain state machine from the product spec and includes a watermark or truthful backfill percentage.
- OAuth and destructive confirmation use the established modal lifecycle: focus trap, Escape, backdrop close where safe, body scroll lock, exit delay, and focus restoration.
- Review queues reuse compact rows and `36px` actions for blocking questions and reversible identity/location decisions.

## Conversational analytics

- The chat is the primary analytical surface.
- Stream an ordered execution trace, not private chain-of-thought. Allowed events are concise plan summaries, capability/data-health checks, semantic-query calls, returned tables, chart specs over those tables, named validations, and the governed answer.
- During analytical and deep turns, show sparse owner-facing commentary while work is active: one short plan, then only material evidence findings plus the next meaningful check. Do not narrate routine queries or tool activity. Keep quick lookups quiet, cap commentary per turn, and fold completed commentary into the expandable work trail once the answer arrives.
- Preserve event order exactly as emitted by the backend.
- Render final answers as restrained Markdown: a direct lead, semantic `##`
  section headings for longer reviews, short paragraphs, bullets for distinct
  findings, and numbered priority actions. Keep simple answers unsectioned.
  Historical bare report labels may be promoted only when they are standalone,
  familiar section cues; ordinary business names remain prose.
- Render governed bar and line events with Flint (Vega-Lite in the browser).
  Bars compare or rank distinct categories; grouped bars sit like-for-like
  series beside each other; stacked bars show composition; lines require an
  ordered time axis, show a dot on each reading, and print the value beside
  that dot (thinning only when the labels would collide). Year-on-year lines
  overlay on a shared month axis, never two calendar years end to end. A small
  Table control in the chart header toggles the governed rows used to draw it.
  Keep the referenced exact-value table before its chart in
  the detailed trace and available from the compact response trace.
- Reuse the existing trace rail, dashboard table, chart, drawer, and status patterns.
- A completed answer displays one of: Verified, Qualified, Exploratory, Clarification, or Unavailable.
- Numerical artefacts display source, time range, definition, freshness, result identifier, and validation outcome. “Explain this number” opens lineage and semantic metadata; it never exposes hidden reasoning or creates an agent-facing SQL surface.

## What to look at next

- The empty New Analysis page is the composer, vertically centred, with one
  panel below it: "What to look at next" (ADR 0117, ADR 0134). The panel is
  positioned below the composer stack and out of the flow, so the composer
  never moves when the panel arrives or is absent.
- The rows render only once they exist: no skeleton, no placeholder. There
  is no heading, verdict line, card or border around them: the rows are the
  whole surface. Each row is one sentence with the bare `14px` logo of the
  tool it reads at the left and an ink-only chevron; the why is the row's
  tooltip, never a second line.
- Rows come from the daily look: once a day the bridge runs Luna at max
  effort on the Omni harness over the last 24 hours. Until the first look
  lands, the chat-history playbook fills the rows. Tapping a row asks the
  sentence as a fresh analysis.

## Discover

- Discover is the chat's second surface (ADR 0130): a grid of about thirty
  question cards drawn from the connected tools and the business context. It
  replaces the conversation body inside the chat card; header actions and side
  panels are unchanged.
- The header is a heading and one short line only — no eyebrow, and no
  separate status row. That line carries the state ("Reading your connected
  tools…", "Tailoring these to <business>…" behind a pulsing dot, otherwise
  "Pick one and Albert investigates."). The connected tools are the stacked
  `24px` logos beside it, never also spelled out in prose.
- Cards use the dash chat surface, `16px` radius, and no ornament: an
  uppercase domain eyebrow, a two-line imperative title, a three-line "why",
  bare `14px` tool logos with their names and a trailing arrow that is ink
  only — no tinted glyph tile, no logo puck, no filled arrow disc. Hover
  lifts `2px` and darkens the arrow; press scales `0.985`; both are removed
  under reduced motion.
- Cards enter with a staggered `12px` rise (at most `0.5s` total) and reflow
  with layout animation when filtered. Filters are `30px` pill chips with the
  contrast fill for the active choice.
- Copy on a card is never a governed number. The card's accessible name is
  `Ask: <prompt>`; asking starts a fresh Omni analysis and returns to Chat.
- Empty state (no connected tools) is a single centred call to action to open
  Connections, not an empty grid.

## Scheduled

- Scheduled is the chat's third surface (ADR 0131): the reports Albert texts
  over iMessage on a timer. It replaces the conversation body inside the chat
  card like Discover; header actions and side panels are unchanged.
- The composer is one `16px` card: a plain textarea for the owner's
  description ("send me a message every morning at 9am with…") and a
  `36px` contrast pill that creates the schedule. Creation is one step; the
  reading's assumptions are stated in a `role="status"` line, never hidden.
- A schedule card is a `16px` dash chat surface: title, a one-line cadence
  ("Weekdays at 9:00 am · Australia/Melbourne · to Tom · +61 …"), the
  standing question as an editable field, then Time (native `time` input),
  Days (seven `30px` pill toggles with `aria-pressed`), Time zone and Send
  to (native labelled selects over the tenant's enrolled numbers). On/off is
  a `role="switch"`; removal is the two-step "×" → "Remove?" control.
- The footer states the truth of the schedule without colour alone: "Next
  Wed 2 Sep, 9:00 am" or "Paused", then the last run as Sent / Failed /
  Missed with its time and any error, and a "View analysis" link to the
  run's conversation. "Run now" queues a manual run and reads "Sending…"
  with `aria-busy` until the bridge reports the outcome; the tab polls
  while a run is open.
- Copy on a card is never a governed number; the texted answer is.

## Alerts

- Alerts is the chat's fourth surface (ADR 0132): the ten heads-up
  triggers, who each one texts, and what each reads right now. It replaces
  the conversation body inside the chat card like Discover and Scheduled;
  header actions and side panels are unchanged.
- The header is the heading "Alerts" and one line only: the truth of the
  last check ("Checked 4 min ago", "Checking…" behind a pulsing dot, "Last
  check failed …") followed by how far each tool's data reaches ("·
  Lightspeed to Wed 2 Sep"), with a quiet `30px` Check now pill at the
  right. No eyebrow, no lede.
- A trigger card is a `16px` dash chat surface in a three-column grid (two
  below `1040px`, one below `760px`) holding exactly four things: the
  title, a few words beneath it, the recipient chips and a footer line of
  the bare `14px` logos of the tools it reads followed by a faint "Last
  fired …" or "Hasn't fired yet". On/off is a
  `role="switch"` top-right; an off card keeps legible text, recedes its
  chips and reads "Off". Readings and numbers never appear on a card; what
  fired lives in Recent.
- Recipients are `26px` pill chips, one per enrolled number, with
  `aria-pressed` and a check mark when the number receives the trigger. A
  selected chip is a light tint of the success green with a filled check
  and the switch's on state is the same green; neither uses the contrast
  fill, so a card with every number chosen stays quiet.
  The chips never invent a number: enrolment on the iMessage page is the
  only way in, and a tab with no enrolled numbers says so in one line.
- Recent is a hairline-separated list: the bold headline, its sentence, then
  trigger · relative time, with Failed or Not texted only when delivery
  did not happen. Copy on a card is never a governed number; the texts are.

## Specialist agents

- Specialists are profiles inside the existing chat, never separate products or
  a second conversation design. The sidebar uses one standard `36px` Agents
  navigation row; its `16px` anchored popover uses the existing spring motion,
  `8px` menu rows, outside-click close, Escape close/focus restore and arrow-key
  navigation.
- Selecting a specialist starts a clean conversation. New Analysis leaves the
  specialist and returns to general Albert; saved conversations restore their
  immutable specialist profile from the server runtime receipt.
- The chat header shows a compact `<specialist> · <organisation>` context before
  the ordinary conversation title. It truncates before reducing action targets.
- A specialist empty state may show at most four reviewed starter questions in
  a two-column desktop / one-column mobile grid. Each starter must name a real
  certified recipe and be answerable under current permissions. The “Verified”
  label means a reviewed semantic/query path, never that an answer has been
  precomputed.
- Starter rows use the standard `8px` compact-button radius, dash surfaces and
  focus ring. They are not decorative cards. Hover lift is removed under
  reduced motion.
- Role-gated agents are absent, not disabled teasers. The server and semantic
  layer independently recheck the role; the browser state is never the
  authorization boundary.

## Runtime comparison

- Compare is one shared question above two equal-width, independently
  scrolling trace panes. Never merge event streams, evidence IDs, answer states
  or provenance between panes.
- Desktop uses a two-column split with the same `16px` analytical surface
  radius. At the compact breakpoint both complete panes stack vertically;
  neither stream is discarded or replaced by a summary.
- Both lanes use the same renderer, width, model label and timing vocabulary.
  Show first-evidence and terminal-answer time, never acknowledgement time or a
  winner inferred from one run.
- The shared composer uses the dash input surface and pill treatment. While a
  run is active it becomes Stop both; each pane also has its own compact stop
  control so one result can continue independently.
- Always disclose that Compare launches and saves two governed conversations,
  uses runtime-specific prompts/tools, and reads live rather than from a frozen
  benchmark snapshot.

## Dashboards

Sigma Computing's official documentation is the source of truth for every
dashboard surface (ADR 0134). Mirror its vocabulary and interaction model;
do not invent dashboard UX.

- The Dashboards tab is the list: a heading, one line, one "New dashboard"
  button, and quiet rows (title, element count, last edited) with a More
  menu holding "Rename" and "Delete" (with a confirmation). A row opens the
  dashboard full-page with a back link; "New dashboard" opens a blank
  document in dashboard mode, where the chat builds it in natural language.
- A dashboard is a conversation-derived pinboard of governed elements, never
  a query builder. Every newly produced owner-visible table is a structured
  replayable artefact and uses one compact `+` action in its top-right corner
  with the standard tooltip timing and surface. A successful pin becomes a
  checkmarked “Added” state; do not render new Markdown-only tables without
  this action.
- Desktop uses 12 columns, tablet uses 8, and mobile uses one column. Grid rows
  are `28px`, gaps are `10px`, and a new tile is `4×7` with a `3×5` minimum and
  `12×16` maximum. Tiles do not overlap and vertical gaps compact. Resize
  from any edge or corner with cursor-only affordances.
- Persist desktop/tablet layouts only after a move or resize stops. Disable
  touch dragging on mobile; retain table scrolling and provide move up/down
  controls. The drag handle also supports keyboard move and resize commands and
  announces the resulting position through `aria-live`.
- An element (tile) carries a drag handle, an inline title, a status dot whose
  tooltip holds the freshness detail, and Sigma's element toolbar in its
  top-right corner on hover, focus or selection: "Filters" (with a count),
  "Properties", the Albert wand ("Edit … with Albert"), and "More" (Refresh
  data, Open source analysis, Delete element). Nothing else lives in the
  header. Clicking an element selects it (a quiet ring); Escape or the
  canvas clears the selection.
- "Properties" is Sigma's element editor in a portalled popover with two
  tabs. Properties: Show as; chart type, orientation and stacking; the KPI
  value; then the governed query's shape — "Truncate date", "Date range",
  the Columns list (move up/down, hide/show, delete from the query), "Add
  column", "Rows". Format: column, name, format, decimals; the KPI
  "Comparison" and "Better when"; the note. Rows are label + one native
  control; a composed pivot's Properties says it is composed by Albert and
  points at the wand.
- Three edit lanes, never one. Presentation changes (display, format, name,
  hide, column order) apply instantly and optimistically. Query-shape
  changes are one deterministic server requery each: the element keeps its
  data, shows a 2 px progress bar under its header (static under reduced
  motion) and is `aria-busy` until the new result lands; a failure is one
  line inside the element with "Dismiss". Anything else goes through the
  wand. Edits to one element run in order.
- Every table column header shows a caret on hover that opens the column
  menu: "Sort ascending", "Sort descending", "Clear sort", "Filter…",
  "Rename", "Format…", "Hide column", "Delete column". A sorted column shows
  a small ▲/▼. A right-clicked value offers "Keep only" / "Exclude".
- Filters are cards typed by the column's data: List (include or exclude
  values on screen, plus typed values), Text match, Number (a condition and
  a value), Date range (between, before, after). A card reads back in words
  ("Product is Gravel bike hire") and removes with one click.
- Sort and filters are element query overrides: the rows on screen change
  at once and the element's governed query re-runs with them (the status dot
  shows "Updating" until the snapshot lands). They never edit the governed
  recipe; composed pivots do not offer them.
- The Albert wand opens one field ("What should change about “…”?") and
  runs a scoped element edit through the chat: the element reworks in place
  (skeleton → draft → applied) while the working streams in the chat card.
- Menus and editors anchored to an element render through the shared
  portalled popover (`DashPopover`), never inside the tile.
- Double-clicking a column header (or pressing Enter/F2 while it is focused)
  renames it inline; "Format…" opens the compact editor for the allowlisted
  format and zero to six decimal places. Presentation metadata only — never
  imply that source fields or governed values were edited.
- Render the saved snapshot immediately. Stale, refreshing, error, current
  empty, and current data states must be distinguishable without colour alone.
- Dashboard motion uses the existing slider easing and is removed under
  `prefers-reduced-motion: reduce`.

## My Data browser

- My Data is a dense Fivetran catalogue and row-inspection workspace, not a
  semantic-layer editor, query builder, or conversation-derived pinboard.
- Use a master-detail layout: a compact schema/table rail and one full-width
  native data table with sticky headers and contained horizontal scrolling.
- Catalogue search uses the standard `36px` / `10px` field; schema and table
  rows use the standard `8px` navigation treatment and `aria-current`.
- Show source, schema, approximate row count, column count, availability, and
  last catalogue check truthfully. Label planner row estimates with `≈`.
- Fetch only one bounded page at a time. Previous/next actions are `36px`
  rectangular controls; page-size choices use a native labelled select.
- Distinguish no Fivetran connection, not-yet-stamped table, empty table,
  loading, access denial, and retryable service failure without colour alone.
- State that tenant, system, credential-bearing, binary, and structured fields
  are hidden. Never imply that values are absent from the source when policy
  merely prevents their display.
- At the mobile breakpoint, stack the catalogue above the data pane and keep
  wide columns scrollable inside their labelled table viewport.

## Responsive behaviour

- Keep provider rows and analytical artefacts readable down to narrow mobile widths.
- Tables scroll horizontally inside their own bordered container.
- Popovers stay inside the viewport; modals become bottom-aligned/full-width only at the existing small-screen breakpoint.
- Collapse secondary labels before shrinking touch targets.

## Verification checklist

- Light, dark, and system themes remain legible.
- Keyboard traversal and visible focus work for every new control.
- `prefers-reduced-motion` does not hide or falsify state.
- Known progress uses `aria-valuenow`; indeterminate progress is labelled as such.
- Modal and popover focus is restored on close.
- No model-authored number is rendered as governed data.


## Financial statements (P&L, balance sheet, trial balance)

A governed table event with `layout: "financial_statement"` (or the
statement shape: `section`, `line`, then one currency column per period) is
rendered by `FinancialStatementView`, not the data grid: section headings,
indented account lines, ruled `Total ...` subtotals, double-ruled grand
totals (Gross Profit, Net Profit, Total Assets/Liabilities, Net Assets),
right-aligned figures with bracketed negatives and no currency-code prefix.
The engine sets the flag on every live Xero statement table
(`packages/albert-v3/src/engine/tools.ts`); a fallback statement composed
from governed views gets the same treatment when it uses `section`/`line`
column keys.
