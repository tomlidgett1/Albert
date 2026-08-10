# 0071. Grounded Nivo chart responses

Date: 2026-08-09

## Status

Accepted. Refines ADR 0001's constrained chart event and the conversational
analytics conventions in `docs/ui-conventions.md`.

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

The dash renders valid specs with Nivo's SVG `ResponsiveBar` and
`ResponsiveLine`. The governed table remains the exact-value and provenance
source (shown before the chart in the detailed trace and available from the
compact trace); conversion of exact decimals to binary numbers is only for
plotting. Tooltips read the original table cells so their display uses Albert's
exact currency/percent formatting. Bar orientation, canvas dimensions and
label density adapt to the number and length of the actual categories without
changing the trace contract.

Nivo receives only dash theme tokens. Charts support light, dark, green and
system themes, keyboard-focusable SVG semantics, a text alternative pointing
to the exact table, and disabled motion under `prefers-reduced-motion`.

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
