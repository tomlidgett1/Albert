# ADR 0097: Planned research step, certified recipes, prior-result retention, and registry-driven native delegation

- Status: Accepted (implemented 2026-08-18; measured with the 250-turn eval harness in `scripts/albert-eval/`)
- Date: 2026-08-18
- Supersedes parts of: ADR 0072 (adaptive manager/specialist analysis — the agentic
  quick/analytical loops remain as fallbacks, no longer the primary path)
- Complements: ADR 0095 (progressive catalogue retrieval), ADR 0071 (grounded nivo charts)

## Context

The 250-turn evaluation of the Albert v3 engine (Luna at max reasoning,
Ashburton Cycles with Lightspeed, Xero and Deputy connected) showed the current
performance was set by the *shape of the pipeline*, not by the model:

1. Every turn ran an intent classification, then an agentic lane that discovered
   the schema and the answer in the same loop: catalogue search (one reasoning
   round-trip), schema load (another), one query, look, another query… Each
   round-trip carried a ~10 KB prompt at xhigh effort; queries ran serially. A
   one-figure question cost 20–40 s; a comparison 60–130 s; a diagnosis minutes.
2. Follow-ups re-ran the pipeline because the engine started every turn with an
   empty result registry — the previous answer's rows survived only as a 12 KB
   prose digest. "Make it a bar chart" cost a fresh Cube query and 20–45 s.
3. Charts were a thin pass-through (one x, one y, model-chosen type) and were
   hidden entirely when the classifier guessed a fact/list shape, so explicit
   chart requests came back without a chart and staff × month data plotted as
   one tangled line.
4. Answers were padded with source-attribution and exclusion notes ("Lightspeed
   only, so payment platforms are not double-counted", "voided sales excluded",
   "the source did not provide a currency code") because the prompt talked at
   length about sources; a one-figure question got two paragraphs.
5. Xero's own reports were used only when the owner said "P&L / balance sheet /
   trial balance"; "net profit last FY" or "biggest expense accounts" were
   rebuilt from ledger views. The delegation was a Xero-specific regex and lane.
6. Meta questions ("what's connected", "how fresh") were answered by probing
   queries, slowly and sometimes naming configured-but-unconnected tools.
7. Fivetran-backed connections had no ingestion watermark, so the model could
   not tell an unsynced day from an empty one.

Albert will have ~50 connectors. Every fix below is a mechanism that is
populated per connector but does not know about connectors.

## Decision

### 1. A planned research step for the data lanes (`engine/planned-lane.ts`)

Retrieval and planning are separated from execution, the way an analyst (or
Omni's planning step) works: the lexical catalogue search picks candidate views
(with a rule that a cross-tool question gets a view from each tool it touches),
their **full schemas plus certified example queries** go in front of **one
planning call** that writes the complete, minimal set of governed queries with
exact member names; the engine validates and executes them **in parallel**
(bounded), repairs rejected steps in one bounded retry, and one composer turns
the evidence into the answer (chart/table included). Three model calls instead
of ten; wall-clock = the slowest query, not the sum. The agentic quick and
analytical lanes remain as fallbacks (rejected plan, insufficient evidence →
`state=Escalate` → agentic lane continues with the evidence and a refilled
budget). Deep lane unchanged.

Dependent steps are declared, not guessed: a step whose filter or window is a
value only an earlier step produces ("the biggest day", "the top customer")
carries a `bind` (source step, source result column, first/all, target filter or
time dimension). Independent steps run in parallel; bound steps run after their
source with the value substituted. When the sufficiency reviewer finds gaps in a
planned answer, the top-up is a second planned pass over the reviewer's gaps
(the first pass's results are already registered) before the agentic lane is
used.

Generalises because it reads the same catalogue and executes through the same
governed path as every other lane; a new connector adds views and example
queries, not lane code.

### 2. Certified recipes = the fast path for the head of the distribution (`engine/recipe-lane.ts`)

A certified query flagged `recipe: true` (with `presentation`, an optional
`date_parameter`, `answer_hint` and `matches`) is a complete answer plan for a
recognised question shape. The intent orchestrator lists the recipes usable on
the tenant's connectors and, when the question *is* one of them (one period, no
comparison, no missing filter, no join), returns `recipe`, `recipeDateRange`
(the owner's period) and `recipeEntity`. The engine executes the recipe query
directly and one bounded composer (compose_table / make_chart) writes the
answer. No catalogue search, no schema load, no loop, no evidence review. A
rejected query, an empty result, or an off-shape request hands back to the
regular lanes with the evidence registered — the fast path can only save time.

27 recipes were written for the three test connectors (sales for a period,
sales by month/week/day, top products, sales by category, refunds, GST,
payment mix, staff sales, customer count, stock position, workshop jobs; roster
for a period, hours by staff, hours/wages totals, wage cost by month, leave,
staff count; payables/receivables outstanding, unpaid bills, top suppliers,
bills by month, bank money in/out). They live next to the views they read; the
mechanism (config → orchestrator field → direct execution → composer) is
connector-agnostic.

### 3. Prior-result retention and a re-present lane (`engine/prior-results.ts`, `engine/represent-lane.ts`)

The last two answered turns' governed result sets (rows + query) are loaded
from the persisted trace (`loadPriorTurnResults` in the conversation service,
`priorResults` on `runAlbertV3Turn`) and registered on the turn context as
addressable results. `make_chart` and `compose_table` resolve a resultId from
this turn *or* a prior turn; a prior result used for the first time is
re-emitted as an evidence table of the current turn under the same id, so the
client renders against rows it has seen. The model sees a bounded block of the
prior results (resultId, column keys, rows) in the request context.

A new `represent` lane (routed by the orchestrator for "make it a bar chart",
"top 5 only", "flip it", "sort it", "last 7 days") runs a small agent with only
the presentation tools over prior results — no query tools, no knowledge
block. If the change needs data that was not retrieved it escalates to the
quick lane, which still has the prior results.

### 4. A data-shape-driven chart layer (`engine/chart-layer.ts`)

`make_chart` gained a deterministic transform vocabulary that generalises to any
result table: `seriesKey` (long → wide pivot, up to 8 series + Other),
`extraYKeys`, `sort` (x / y_desc / y_asc), `limit` + `take` (first/last N),
`orientation`, and `chartType: auto` resolved from the x axis (time → line,
categories → bar). Transforms produce a derived evidence table so the client
plots exactly what the model verified. The tool is exposed whenever the answer
shape allows a chart *or* the owner asked for one *or* prior results exist; the
perceptual floor is 3 points for a line, 2 for bars. `TraceChartEvent` carries
`series` (already supported by the renderer) and a new `orientation`.
Superseded in part by ADR 0101: series caps are now 4 for lines / 8 for stacks,
`stacked_bar` and `where` were added, and in the deep lane the chart decision
moved from the investigators to a dedicated visualiser agent.

### 4b. Deterministic re-aggregation and cheap presentation (`engine/aggregate-layer.ts`, `present_result`)

Two tools close gaps the eval exposed in every lane:

- `aggregate_result` groups a governed result by a column value or a date part
  of a date/datetime column (weekday, hour of day, month, day of month, week,
  date) and sums/averages/counts numeric columns, producing a derived evidence
  table. A bucket the view lacks ("sales by day of the week", "busiest hour")
  becomes one governed query at the finest useful grain plus one deterministic
  transform — instead of one filtered query per weekday (which Cube's date
  filters cannot even express). Query results keep every row in memory
  (`allRows`, bounded) for this; the client-facing slice is unchanged.
- `present_result` shows the rows of one governed result as the owner-facing
  table (pick/relabel columns, sort, top N). It builds the same cell-referenced
  derivation `compose_table` produces — provenance and dashboard replay are
  identical — but costs the model a dozen tokens instead of one per cell; a
  30-row bill list went from ~10,000 output tokens (60–90 s) to ~100.
  `compose_table` remains for combined or calculated tables.

Both work on any result of any view; neither knows a connector.

### 5. Answer contract: length calibrated to the question

The intent classifier keeps short vague questions ("How are we doing?", "Sales?")
off the deep lane: the most natural reading is answered briefly on the quick lane
(a recipe when one fits) with the assumption recorded; deep is reserved for an
explicit request for a review, diagnosis or strategy.

The contract now says plainly: a one-figure question gets one or two sentences
(figure, period, at most one comparison); never explain inclusions/exclusions,
sources, deduplication, currency codes or "not double-counted"; established
source facts tell the model which numbers to use and are never repeated to the
owner.

### 6. Registry-driven native delegation (`engine/native-capabilities.ts`)

"Delegate to the connector's own tool when it beats the semantic layer" is now
a registry: each capability declares connector keys, kinds with routing
descriptions, a deterministic detector, an availability check and a runner.
The engine consults the registry before classification (detector) and the
orchestrator can route indirect wording afterwards (`nativeCapability:
"id:kind"`). Xero statements are the first entry, with detection broadened to
profit / income / expense-account / expense-ratio / balance / bank-balance
questions, and the statement lane can now answer questions *about* the
statement (rank lines, ratios, period comparisons) with compose_table. Adding
connector #47's MCP report is one registry entry.

### 7. Meta lane and data-derived freshness (`engine/meta-lane.ts`, `engine/freshness.ts`)

Questions about the data itself are answered from a fact sheet the engine
already owns (connected tools and their data areas from the config, not-connected
tools, native capabilities, watermarks, source findings) with one composition
call. Watermarks are derived from the data when the control plane has none:
`freshness_probes` in the agent config name each connector's primary time
dimension; the engine probes latest (and earliest) dates in parallel with
classification, cached per tenant for ten minutes, bounded to 5 s on the
critical path.

## Consequences

Measured on the 250-turn eval (`evals/albert/REPORT.md`; baseline `570a0e5`
vs this tree, same questions, leases, tenant and judge): pass rate 50% → 63%,
mean overall 3.06 → 3.44, latency p50 112 s → 39 s (chart re-formats 49 → 11 s,
follow-ups 183 → 23 s, meta 62 → 7 s, cold single-tool 106 → 38 s), model
requests per turn median 10 → 4, over-investigation tags 66 → 32, re-ran
pipeline for a re-format 15 → 3, no chart when needed 16 → 3, methodology
dump 12 → 1. On the 134 turns untouched by Cube timeouts / the Xero MCP outage
in either run: pass 68% → 75%, p50 55 s → 20 s, p95 338 s → 143 s.

- Latency: the head of the distribution answers in ~6–15 s (recipe or
  statement lane), presentation follow-ups in ~10 s, planned single-tool
  questions in ~15–60 s, planned cross-tool questions in ~60–130 s; the agentic
  loop remains for what planning cannot finish. Cube's own execution time (2 s
  median, a 30–90 s tail and 90 s timeouts under database load) is now the
  dominant remaining cost — see "Remaining failure modes" in the eval report.
- Quality: fewer, better-scoped queries; charts appear when asked and are
  typed by data shape; multi-series charts render; answers are shorter and
  free of audit-trail prose; statement questions come from Xero itself.
- The classifier prompt grows by the recipe list (~3–4 KB) and the native
  capability block; both are scoped to the tenant's connectors.
- New contract tests: `tests/contracts/v3-fast-paths.contract.test.ts` (chart
  layer, prior results, recipes, native registry, routing surface, step
  bindings, aggregate layer).
- Not done (recommended next): Cube pre-aggregations for the hot views and
  weekday/hour derived dimensions (semantic-layer changes that need a Cube
  release), a per-tenant connection brief (ADR 0096), and result retention
  beyond two turns.
