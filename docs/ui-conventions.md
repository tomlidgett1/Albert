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
- A model/runtime picker is one compact composer trigger opening a native `16px` anchored popover. Model choices are radio rows; speed and reasoning are segmented controls.
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
- Render governed bar and line events with Nivo's responsive SVG components.
  Bars compare or rank distinct categories; lines require an ordered time or
  numeric axis. Keep the referenced exact-value table before its chart in the
  detailed trace and available from the compact response trace.
- Reuse the existing trace rail, dashboard table, chart, drawer, and status patterns.
- A completed answer displays one of: Verified, Qualified, Exploratory, Clarification, or Unavailable.
- Numerical artefacts display source, time range, definition, freshness, result identifier, and validation outcome. “Explain this number” opens lineage and semantic metadata; it never exposes hidden reasoning or creates an agent-facing SQL surface.

## Personal dashboard

- Dashboard is a dense conversation-derived pinboard, never a query builder.
- Every newly produced owner-visible table is a structured replayable artefact
  and uses one compact `+` action in its top-right corner with the standard
  tooltip timing and surface. This includes final pivots composed across
  multiple governed results. A successful pin becomes a checkmarked “Added”
  state; do not render new Markdown-only tables without this action.
- Desktop uses 12 columns, tablet uses 8, and mobile uses one column. Grid rows
  are `28px`, gaps are `10px`, and a new tile is `4×7` with a `3×5` minimum and
  `12×16` maximum. Tiles do not overlap and vertical gaps compact.
- Persist desktop/tablet layouts only after a move or resize stops. Disable
  touch dragging on mobile; retain table scrolling and provide move up/down
  controls. The drag handle also supports keyboard move and resize commands and
  announces the resulting position through `aria-live`.
- A tile uses the dash surface, border, `10px` field radius, `8px` action radius,
  standard focus treatment, and existing tooltip pattern. It contains a title,
  freshness/status, governed table, source-analysis link, refresh/retry, and
  remove action without decorative card chrome.
- Double-clicking a column header (or pressing Enter/F2 while it is focused)
  opens an anchored compact editor for its display label, allowlisted format,
  and zero to six decimal places. Save on Done or focus exit; Escape cancels.
  The editor changes presentation metadata only and must not imply that source
  fields or governed values were edited.
- Render the saved snapshot immediately. Stale, refreshing, error, current
  empty, and current data states must be distinguishable without colour alone.
- Dashboard motion uses the existing slider easing and is removed under
  `prefers-reduced-motion: reduce`.

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
