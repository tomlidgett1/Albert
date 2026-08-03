# Project instructions

Read `docs/albert-v1-spec.md` before changing Albert's product architecture,
data contracts, connectors, agent runtime, or onboarding flows. Architectural
choices and supersessions belong in `docs/adr/`.

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

### Implementation rule

Before introducing a new button, tab, menu, search field, pill, or popup,
match the closest pattern above. If a needed pattern is missing from this
style sheet, extend this file with the chosen dash-derived values instead of
improvising a one-off style.
