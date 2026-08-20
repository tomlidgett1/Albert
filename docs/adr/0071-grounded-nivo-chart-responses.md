# 0071. Grounded Nivo chart responses

Date: 2026-08-09

## Status

Accepted. Refines ADR 0001's constrained chart event and the conversational
analytics conventions in `docs/ui-conventions.md`. Series/point limits, chart
type resolution and who decides the chart are superseded by ADR 0101 (the
visualisation agent). The renderer is now Flint (Vega-Lite in the browser),
not Nivo; the grounding contract here still stands.

## Context

Albert's public trace already allowed a chart event that referenced a governed
table, but the browser drew a one-series SVG itself and the primary analyst had
only the instruction to chart “trends, rankings”. That was insufficient for a
general response contract: a visually plausible line can imply continuity in
unordered categories, repeated x-values can collapse distinct groups, mixed
units can share a misleading axis, and hand-built chart behaviour diverges as
new result shapes arrive.

The response surface now needs four presentation forms: text, exact tables,
bar charts and line charts. Charts must remain downstream views of governed
results; they cannot become a second analytical or numerical source.

## Decision

The primary analyst owns the presentation decision after inspecting the actual
result:

- normally use text/table for a scalar, one-row result, raw records or a result
  too dense to read; a one-bar chart remains available when explicitly asked;
- use a bar chart for comparisons and rankings across distinct categories;
- use a line chart only for a genuinely ordered time or numeric sequence; and
- use at most four series, only when they have the same unit and currency.

The local `make_chart` tool remains the only chart-producing path. It accepts a
governed `dataRef`, chart type, x column, primary y column and optional series.
It never accepts inline data. Before emitting a public chart event, trusted code
validates the requested presentation against the referenced result:

1. every field is a real result column and every series is numeric;
2. the primary y column is the first series and series keys are unique;
3. all series have compatible units and currency metadata;
4. the x-axis values are non-null and unique at the plotted grain;
5. a line x-axis is comparable by type or grounded value shape and the returned
   rows are strictly ascending; and
6. a line contains at least two points, a bar at least one category, and the
   result contains no more than 40 bar or 120 line points.

Invalid chart requests fail locally with corrective guidance and never enter
the public or immutable trace. Series labels and captions are derived from
trusted result metadata rather than accepted as numerical evidence from the
model.

Trusted code compiles the validated request into a closed Flint spec
(Line / Bar / Grouped Bar / Stacked Bar) with semantic types taken from the
governed columns. The public chart event still references `dataRef` and never
carries invented rows. The dash assembles that spec in the browser with
`vega-embed` and `ast: true` (Vinext's worker cannot load Vega).

The governed table remains the exact-value and provenance source (shown before
the chart in the detailed trace and available from the compact trace). Flint
formats measures from semantic types (Price, Percentage, Quantity). Bar
orientation and canvas height adapt to the actual categories without changing
the trace contract.

Flint receives Albert dash tokens for canvas, ink and the four chart colours.
Charts support light, dark, beige, green and system themes, a text alternative
pointing to the exact table, and CSP-safe drawing.

## Consequences

- The agent can choose among text, tables, bar charts and line charts without
  creating an ungoverned data path.
- The same immutable table digest continues to bind every plotted value; chart
  events remain small presentation specifications.
- Categorical line charts, duplicate x-values, incompatible units and
  unreadably dense SVG charts fail before rendering.
- Adding another chart family requires a reviewed extension to this contract;
  only bar and line are supported by this decision.

## Verification

- `packages/agent/src/chart-policy.ts`
- `services/conversation/src/live.ts`
- `app/dash/components/AnalyticalTrace.tsx`
- `tests/contracts/chart-response.contract.test.ts`
