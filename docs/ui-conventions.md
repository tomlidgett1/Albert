# Albert UI conventions

Status: active
Source of truth: `app/dash/page.tsx` and `app/dash/dash.module.css`

This document records the conventions already present in `/dash`. It is a map of the existing design system, not a second design system. When code and this document differ, preserve the established `/dash` pattern and update this document in the same change.

## Principles

- Build every product surface inside the existing dash shell.
- Support `light`, `dark`, and `system` themes. New colours belong in the `.dash` token block and use `light-dark()` unless a brand colour has sufficient contrast in both themes.
- Keep interaction state legible without relying on colour alone.
- Use real data states and explicit copy. Animation may explain a transition, but must never imply progress that did not occur.
- Honour `prefers-reduced-motion: reduce` and Framer Motion's `useReducedMotion()` for every non-essential transition.

## Foundation

- Font: Geist with the repository-wide `--text-scale` multiplier.
- Sidebar: `260px`, collapsing to the established compact width.
- Standard control height: `36px` via `--dash-control-height`.
- Canvas, surface, text, border, focus, success, contrast, and accent colours come from the `.dash` custom properties.
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
- Preserve event order exactly as emitted by the backend.
- Reuse the existing trace rail, dashboard table, chart, drawer, and status patterns.
- A completed answer displays one of: Verified, Qualified, Exploratory, Clarification, or Unavailable.
- Numerical artefacts display source, time range, definition, freshness, result identifier, and validation outcome. “Explain this number” opens lineage and semantic metadata; it never exposes hidden reasoning or creates an agent-facing SQL surface.

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
