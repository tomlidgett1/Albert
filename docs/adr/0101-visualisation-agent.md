# 0101. A visualisation agent: shape-first chart selection

Date: 2026-08-19

## Status

Accepted. Refines ADR 0071 (grounded chart responses) and section 4 of ADR
0097 (the data-shape-driven chart layer). ADR 0071's series and point limits
are superseded by the figures below.

## Context

On 2026-08-18 the deep lane answered "go deep into our workshop and explain how
we can get more out of each workorder" with two charts, both wrong:

- a **line** of nine named services over **three months** — the pivot ran on
  the 50-row client slice of a 483-row result (`table.rows`, not `allRows`),
  the compare-date-range column was ignored so both periods were squashed onto
  one axis, and nine lines is a tangle whatever the data;
- a **line** whose legend was `default`, `non_inventory`, `(blank)`,
  `assembly` — raw Lightspeed item-type codes, with a null bucket, as the
  owner-facing series labels.

Neither chart supported a claim in the answer. They were drawn by a **branch
investigator** mid-search, before any answer existed, because `make_chart` was
exposed to every deep-lane branch and the final synthesiser had no chart tool
at all. The chart type was the model's guess; the runtime only annotated a
categorical line with a note and otherwise plotted what it was told.

Omni's workbook separates the two concerns: the query fixes the result shape,
and the visualisation layer maps that shape onto x / y / colour facets with a
"best guess" chart the analyst can override (docs.omni.co, *Visualize data in
Omni*: "Omni will take a best guess at the right chart for each new query").
Their published guidance is the standard one — lines for continuous time with
3–4 series at most, sorted horizontal bars for rankings, stacked bars (never
pies) for composition, tables when exact values matter, a KPI card for a single
number.

## Decision

Presentation is a separate job with its own agent, deterministic best guess,
and runtime validation.

### 1. Result-shape profiling (`engine/result-shape.ts`)

`profileResult(table)` classifies every column of a governed result as
`time` (date/datetime, `.month`-style bucket, ISO-shaped values), `period`
(`compareDateRange` labels), `dimension` or `measure`, with distinct count,
blank count, sample values, unit group (currency code / percent / number) and a
`codeLike` flag for snake_case enums and ids in `*_type` / `*_id` columns. The
profile classifies the grain (`scalar`, `single-row`, `time-series`,
`time-by-category`, `category`, `category-by-category`, `records`) and
`recommendVisual` returns the best-guess form with the series mapping filled
in:

| Shape | Best guess |
|---|---|
| one row | `kpi` / prose — no chart |
| time, no dimension | `line`, extra same-unit measures as further lines |
| time + period column | `line`, series = period, x aligned to month-of-year (overlay, not end-to-end) |
| time × dimension ≤ 4 values | `line`, one series per value |
| time × dimension > 4 values | `stacked_bar` per period (top 7 + Other) |
| one dimension | `bar`, horizontal, sorted by value, top 12 |
| one dimension + period column | `bar` grouped by period (this vs last) |
| two dimensions | `stacked_bar`, higher-cardinality dimension on x |
| ≥ 3 informative text columns, or no measure | `table` |

Profit / revenue outrank counts and percentages as the headline measure.
`renderResultShape` is the compact prompt form.

### 2. The visualiser agent (`engine/visualise-lane.ts`)

`runVisualiser({ lane, answer })` runs **after** the answer is composed. Its
prompt is the owner's question, the finished answer, and the shape profiles of
every evidence result (chart-data derivations excluded). Its only tool is
`make_chart`. It attaches at most two charts, each with a caption naming the
claim it supports, or none. It never queries and never writes the answer, and
its output type is plain text (a one-line summary) so structured-output-first
models (Grok) still call the tool.

In the deep lane the branch investigators are created with `chartable: false`;
the visualiser runs against the synthesiser's answer. The planned composer keeps
`make_chart` (single-shot lanes) but now receives the shape profiles and best
guesses in its prompt.

### 3. Chart-layer rules (`engine/chart-layer.ts`)

`make_chart` gains `stacked_bar` and a `where` filter, and the runtime now
enforces, before any chart event is emitted:

- transforms read **every held row** (`allRows`), never the client slice;
- a line needs an ordered time axis and chronological sort — otherwise it is
  drawn as bars with the reason returned; a line carries at most **4** series
  (top 3 + Other), a stack at most **8** (top 7 + Other); `auto` over more than
  four series on a time axis resolves to `stacked_bar`;
- a category bar defaults to `y_desc` (ranked) and horizontal orientation, and
  trims to the top 15 with a note when the caller set no limit;
- a compare-date-range result must be filtered to one period (`where`) or use
  the period column as the series or the x axis — squashing both periods onto
  one axis is refused with the period labels and shape profile returned;
- series labels are derived from source values only, but humanised: blanks are
  "(not set)" and sort last into Other, snake_case codes are title-cased, date
  ranges become "Aug 2025 – Jul 2026";
- rows with a blank x are dropped with a note; a measure cannot be an axis or a
  series; mixed units cannot share an axis; identical bars and sub-threshold
  point counts are still refused (3 for a line, 2 for a bar).

The public `chart` event keeps `chartType: "bar" | "line"` on the wire and adds
`stacked?: boolean` plus a trusted `flint` spec (semantic types, encodings,
display names). The dash compiles that spec with Flint and draws Vega-Lite in
the browser. Historical events without `flint` are reconstructed from
`xKey` / `yKey` / `series` and the governed table. The model never writes
Vega-Lite and never invents plot rows. Pie, maps and the rest of Flint's
catalogue stay out of production until a later reviewed extension.

## Consequences

- The chart decision has a deterministic baseline that the eval harness can
  assert per result shape (`tests/contracts/v3-visualiser.contract.test.ts`
  reproduces the 2026-08-18 failures and the corrected outcomes).
- Deep-lane charts are chosen against the answer, once, by a cheap agent
  (medium effort, ≤ 6 turns) instead of opportunistically by each branch.
- Long-format results with two periods and many categories now produce a
  period-versus-period grouped bar or a top-7 stack, never a nine-line spaghetti.
- KPI cards, small multiples and pie/donut are deliberately not rendered; the
  runtime's answer to those shapes is prose, a table, or a stacked bar.
- Follow-ups: run the visualiser in the analytical lane too (today only the
  planned composer receives shape hints), and expose the best guess to the
  re-present lane so "chart this" can accept it without naming a type.

## Verification

- `tests/contracts/v3-visualiser.contract.test.ts`
- `tests/contracts/v3-flint-charts.contract.test.ts`
- `tests/contracts/v3-empty-result-persistence.contract.test.ts` (chart gate and perceptual floor)
