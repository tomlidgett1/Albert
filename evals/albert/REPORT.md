# Albert — full-scale evaluation and improvement loop (2026-08-18)

Model under test: **GPT 5.6 Luna at Max reasoning, fast mode off**, on the v3
engine, against the test business **Ashburton Cycles** with **Xero, Lightspeed
(R-Series) and Deputy** connected. 250 scored turns, run twice — once against
the engine as it stood at commit `570a0e5` (baseline) and once against the
engine after the changes described in §4 (improved) — on the same question set,
same leases, same tenant data, same judge.

Companion artefacts:

- `scripts/albert-eval/` — the repeatable harness (`questions.ts` matrix,
  `run.mts` runner, `grade.mts` judge, `report.mts` single-run and
  `--compare` reports, `_ask.mts` ad-hoc single turn). Re-run: see §7.
- `evals/albert/runs/baseline/report.md`, `evals/albert/runs/improved/report.md`
  — full per-run reports (latency by class, quality by group, every turn).
- `evals/albert/compare-baseline-vs-improved.md` — the machine-generated
  before/after tables (§5 below quotes from it).
- `docs/adr/0097-planned-lanes-recipes-and-result-retention.md` — the
  architecture decision record for the changes.

---

## 1. Method

### 1.1 Question matrix (250 turns)

Built to the brief's axes; every turn is one row in
`scripts/albert-eval/questions.ts` with tier, scope, surface, interaction
pattern, expected format and, for 62 turns, a golden spec.

| axis | distribution |
|---|---|
| difficulty tier | easy 48 · medium 104 · hard 46 · extremely hard 26 · ambiguous 14 · meta 12 |
| tool scope | Lightspeed 112 · Xero 49 · Deputy 49 · multi/cross-tool 28 · meta 12 |
| surface | sales 68 · staff/labour 49 · cash/AR/AP/GST 32 · products 31 · cross-cutting 28 · P&L 13 · meta 13 · workshop 9 · suppliers/inventory 7 |
| interaction pattern | cold 202 · chart re-format 20 · drill-down 16 · follow-up 12 |
| expected format | prose 100 · any 74 · table 41 · chart-or-table 15 · line 14 · bar 6 |
| threads | 30 multi-turn threads (12 follow-up pairs, 10 chart-reformat triples, 8 drill-down triples) |
| goldens | 62 turns carry a golden value / top entity / row count / entity list computed **live from Cube** at grading time (date tokens resolved to the run day) |

Threads run their turns sequentially with production-shaped conversation
context (prior answers, presented-table digests, governed queries, and — for
the improved engine — prior result sets), exactly as `app/api/v3-conversation`
supplies them.

### 1.2 Runner

`run.mts` calls `runAlbertV3Turn` the way the production route does (tenant
`01KZN20VTX2EWW1TQ2AA3MCPW6`, owner role, `activeConnectors =
[deputy, lightspeed-r, xero]`, the tenant's pinned source findings, live Cube on
`albert-cube.fly.dev`, the Xero MCP proxy through the sync worker), one
turn lease per worker, records every trace event: phase timings
(classified / first query / last query / answer), each governed query with
Cube execution time, tables, charts, usage. Timeout 780 s per turn (the route's
own `maxDuration` is 800 s). Baseline ran from a frozen snapshot of the tree so
engine edits made during the run could not leak into it; the improved run ran
from a second snapshot.

### 1.3 Rubric and judge

`grade.mts` scores each turn 1–5 on **correctness** (verified against the
goldens and against Albert's own evidence tables), **directness**, **calibrated
detail** (over-answering is a failure), **format fitness** (chart type by data
shape, tables where tabular, prose for a single figure), **ambiguity handling**
(only where the question admits several readings), an **overall** score,
pass/fail (overall ≥ 4 ∧ correctness ≥ 4 ∧ no critical failure) and a set of
failure tags from a fixed vocabulary. Deterministic checks run first (golden
numbers/entities present in owner-visible text, chart present on a re-format
turn, markdown pipe tables, failed/timed-out turns) and override the judge
where they are conclusive.

The judge only sees what the owner sees — the answer text, charts, and the
tables the answer event actually presents (latest composition per caption, max
three, plus chart data), with evidence tables passed separately for
number-checking. An earlier grader draft showed every emitted table and
over-penalised both runs for "duplicate tables" the client never renders; those
grades were discarded and both runs were graded with the corrected judge.

Judge model: **GPT 5.6 Sol** (OpenAI Responses API, strict JSON schema, medium
reasoning). The harness defaults to Claude Opus 5; the Anthropic key on this
machine ran out of credit part-way through the baseline, so both runs were
graded with Sol for consistency (spot-checks on the same turns matched Opus's
verdicts and tags). Sol is used only as the judge; the model under test is
Luna throughout.

### 1.4 Latency classes

cold single-tool · cold multi-tool · follow-up · drill-down · chart re-format,
plus breakdowns by tier and scope. Each turn also records the sum of Cube
execution time so model/engine time can be separated from semantic-layer time
(the analytics database sits at its 60-connection ceiling and Cube's tail
latency — 30–90 s and outright 90 s timeouts under load — is the dominant
external noise in every number below).

---

## 2. Baseline results (engine at `570a0e5`, 250 turns)

Full tables: `evals/albert/runs/baseline/report.md`.

| | |
|---|---|
| Pass rate | **50%** (125/250) |
| Mean scores (1–5) | overall 3.06 · correctness 3.51 · directness 3.95 · calibrated detail 2.69 · format fitness 3.24 |
| Golden hits (35 easy/single-figure turns with a numeric golden) | 83% |
| Latency, all turns | p50 **112 s** · p95 **780 s** (the harness ceiling) · mean 210 s · 19 turns failed outright (14 eval timeouts at 780 s, 5 aborted) |
| Answer states | Verified 110 · Exploratory 91 · Unavailable 25 · failed 19 · No data 5 |
| Model requests per turn | median 10, mean 11.2 · queries per cold turn median 2, p95 11 |

Latency by class (p50 / p95, seconds): cold single-tool 106 / 780 · cold
multi-tool 237 / 753 · follow-up 183 / 780 · drill-down 101 / 780 · chart
re-format 49 / 249 · meta 62 / 632. By tier: easy 40 / 780 · medium 95 / 657 ·
hard 180 / 780 · extremely hard 227 / 609 · ambiguous 292 / 753.

Quality by class (pass rate): chart re-format 75% · follow-up 75% · drill-down
50% · cold 46%. By tier: easy 67% · medium 61% · hard 33% · extremely hard 35% ·
ambiguous 29% · meta 8%. By scope: Deputy 76% · Xero 49% · Lightspeed 47% ·
multi 32%. By surface: staff/labour 76% · cash/AR/AP 59% · sales 53% · products
42% · cross-cutting 32% · P&L 15% · meta 15%.

Two infrastructure events shaped the baseline numbers and are called out
wherever they matter below: **74 turns saw at least one Cube query time out
at 90 s** (the analytics database at its 60-connection ceiling, with Fivetran
syncs and other sessions' batteries running), and **the Xero MCP proxy stopped
returning reports from ~03:17 UTC** (Xero API daily allowance / token — every
`list-profit-and-loss` / `list-report-balance-sheet` call errored), which
affected 21 baseline turns including 9 of the 13 P&L turns.

## 3. Ranked failure modes (baseline) and root causes

Ranked by how many of the 250 turns carried the tag (a turn can carry several);
root causes were established by reading the traces of the tagged turns.

| # | failure mode | turns | root cause | fix (§4) |
|--:|---|--:|---|---|
| 1 | **padded** — methodology paragraphs, source/exclusion disclaimers ("Lightspeed only, so payment platforms are not double-counted", "voided sales excluded", "no currency code"), unrequested extra breakdowns, restated table rows | 153 (61%; 25 of 48 easy one-figure questions) | The answer contract talked at length about sources and exclusions and the model dutifully repeated them; the reviewer never penalised length; the analytical lane's "headline → movements → detail" template applied even to one-figure questions | 4.6 |
| 2 | **over-investigated** — 5–26 queries for a one- or two-query question | 66 (26%) | One agentic loop discovers schema and answer together: catalogue → schema → query → look → query…, each step an xhigh round-trip over a 10 KB prompt; the sufficiency reviewer re-entered the *whole* analytical lane on any doubt; ambiguous one-liners ("How are we doing?", "Sales?") were routed to analytical/deep (7 analytical, 2 deep of 14; median 307 s) | 4.1, 4.2, 4.6, 4.8 |
| 3 | **missed facet** — the asked drill-down/derived view never delivered (Saturdays by hour, refunded items, weekday totals) | 50 (20%) | (a) buckets the semantic layer lacks (weekday, hour of day) → the model ran one filtered query per weekday, hit Cube's single-range date filter, gave up; (b) dependent two-step questions guessed the second step; (c) escalation lost the thread | 4.5, 4.1 |
| 4 | **unavailable / error** (47) + **timeout** (27) | 47 + 27 (19% + 11%) | 74 turns hit 90 s Cube timeouts and the loop waited them out serially (13 queries × 90 s); 14 turns exceeded 780 s; the Xero MCP outage returned "Unavailable" with no fallback on 21 turns; the represent request "flip it" was declared unsupported | 4.1 (fail-fast, parallel), 4.7 (ledger fallback), 4.4, plus infrastructure (§6) |
| 5 | **format broken / table missing / no chart when needed / chart when not needed** | 24 / 13 / 16 / 8 | `make_chart` hidden whenever the classifier guessed a fact/list shape; single-series charts only (staff × month became one tangled line); tables composed cell-by-cell so long tables were skipped or duplicated; the "flip"/orientation vocabulary did not exist | 4.4, 4.5 |
| 6 | **re-ran pipeline for a re-format** — every one of the 20 chart re-format turns ran ≥1 new query (median 49 s; 3 with no chart at all) | 15 tagged / 20 affected | The engine started every turn with an empty result registry — the prior answer's rows survived only as a prose digest — so "make it a bar chart" meant a fresh Cube query and often a fresh investigation | 4.3 |
| 7 | **wrong / unsupported number, wrong entity, false zero, wrong period** | 17 / 18 / 15 / 8 / 8 | Numbers computed in the model's head across several partial results (weekday sums from daily rows, "11 of 12 weeks"); silent narrowing (stocked products only, approved bills only); an empty window read as "none" instead of "not yet synced"; "September" resolved backwards | 4.5 (deterministic aggregation), 4.4/4.5 (derived tables carry provenance), 4.8 (watermarks), 4.6 (forward-looking dates) |
| 8 | **meta questions** — 12 turns, 8% pass, 4.1 queries and 89 s median; unconnected tools named, vague freshness | 12 | Answered by probing queries instead of the engine's own registry; Fivetran-backed connections had no watermark so the model could not tell "unsynced" from "empty" | 4.8 |
| 9 | **P&L / statement questions** — 15% pass | 13 | Native Xero reports used only on the literal words "P&L / balance sheet"; when the MCP call failed the lane returned Unavailable instead of falling back to the synced ledger | 4.7 |
| 10 | **ambiguity handling** — 29% pass, 2.4/5 | 14 | Vague prompts triggered wide investigations with no stated assumption instead of a brief answer under a stated reading (or a crisp clarification) | 4.6 |

Latency root causes, in order of contribution to the p50: (1) serial agentic
loop with 10–12 model requests per turn (median 10 requests; non-Cube time p50
89 s on cold single-tool turns vs Cube p50 7 s); (2) the reviewer's full
re-investigation; (3) Cube tail latency and 90 s timeouts under database load
(p95 Cube time 119 s single-tool, 307 s multi-tool, 918 s on drill-downs);
(4) presentation cost — writing tables cell by cell (8–10 k output tokens,
60–90 s per table).

---

## 4. Improvements implemented

Every change below is a mechanism, populated per connector by configuration
(views, example queries, recipes, probes, registry entries) but containing no
connector logic. The test for each was "does this still work when tool #47 is
connected?" — the answer is given per item. All are in
`packages/albert-v3/src/engine/` unless noted; contract tests in
`tests/contracts/v3-fast-paths.contract.test.ts` (8 tests) plus updated
routing/scope tests.

### 4.1 Planned research step before the agentic loop (`planned-lane.ts`)

*Failure modes addressed: over-investigation, serial query chains, latency on
cold single- and multi-tool questions.*

Retrieval and planning are separated from execution, the way an analyst (or
Omni's planning step) works: the lexical catalogue search picks candidate
views (a cross-tool question is guaranteed a view from each tool it touches),
their **full schemas plus certified example queries** go in front of **one
planning call** that writes the complete, minimal set of governed queries with
exact member names; the engine validates and executes them **in parallel**
(bounded to 3, because the semantic layer's per-turn pool is small), repairs
rejected steps in one bounded retry, and one composer writes the answer with
chart/table. Three model calls instead of ten; wall-clock ≈ the slowest query
instead of the sum. Dependent steps are declared, not guessed: a step whose
filter or window is a value only an earlier step produces ("the biggest day",
"the top customer") carries a `bind` and runs after its source with the value
substituted (X-05 "who worked on our biggest sales day": 144 s → 39 s). Steps
that all time out at the source fail fast as *Unavailable* instead of handing
the same timeouts to the agentic lane. When the sufficiency reviewer finds gaps
in a planned answer, the top-up is a second planned pass over the gaps before
the agentic lane is used. The agentic quick/analytical lanes remain as
fallbacks with the evidence already registered.

*Generalises:* reads the same catalogue and executes through the same governed
path as every lane; a new connector adds views and example queries, not lane
code.

### 4.2 Certified recipes as the tool-agnostic fast path (`recipe-lane.ts`, `cube-playground/agents/certified_queries/recipe-*.md`)

*Failure modes addressed: 20–40 s for one-figure questions; padded answers.*

A certified query flagged `recipe: true` (with `presentation`,
`date_parameter`, `answer_hint`, `matches`) is a complete answer plan for a
recognised question shape. The intent orchestrator sees the recipes usable on
the tenant's connectors and, when the question *is* one of them (one period, no
comparison, no missing filter, no join), returns `recipe` + `recipeDateRange` +
`recipeEntity`; the engine executes the recipe query directly and one bounded
composer answers. No catalogue search, no schema load, no loop, no review. Any
rejection, empty result or off-shape request hands back to the regular lanes —
the fast path can only save time. 27 recipes were written for the three test
connectors (sales for a period / by month / week / day, top products, sales by
category, refunds, GST, payment mix, staff sales, customer count, stock
position, workshop jobs, roster, hours by staff, hours/wages totals, wage cost
by month, leave, staff count, payables/receivables, unpaid bills, top
suppliers, bills by month, bank money in/out). Measured: "sales yesterday"
20 s → 8 s; "sales last month" 25 s → 6 s; "unpaid bills" 369 s (agentic,
under DB timeouts) → 30 s.

*Generalises:* the mechanism (config → orchestrator field → direct execution →
composer) knows nothing about connectors; a new connector ships recipes next
to its views. The classifier prompt grows by the tenant-scoped recipe list
(~3–4 KB).

### 4.3 Prior-result retention + a re-present lane (`prior-results.ts`, `represent-lane.ts`, `services/conversation/src/artifact-store.ts`, `app/api/v3-conversation/route.ts`)

*Failure modes addressed: re-running the pipeline for "make it a bar chart",
reformat not applied, 20–45 s follow-ups.*

The last two answered turns' governed result sets (rows + query) are loaded
from the persisted trace and registered on the turn context as addressable
results; `make_chart`, `compose_table`, `present_result` and
`aggregate_result` resolve a resultId from this turn *or* a prior turn, and a
prior result used for the first time is re-emitted as an evidence table of the
current turn under the same id (the client renders against rows it has seen).
A new `represent` lane (routed for "make it a bar chart", "top 5 only", "flip
it", "sort it", "last 7 days", "show only the last 6 months") runs a small
agent with only the presentation tools over prior results — no query tools —
and escalates to quick (which still has the prior results) when the change
needs data that was not retrieved. Prior results count as evidence for
grounding, so a re-presentation ships *Verified* rather than *Unavailable*.
Measured: chart re-formats 20–45 s → 9–11 s with zero queries.

*Generalises:* results are results regardless of the view or connector that
produced them.

### 4.4 Data-shape-driven chart layer (`chart-layer.ts`)

*Failure modes addressed: no chart when needed, wrong chart type, single-series
tangles, charts hidden by the answer-shape gate.*

`make_chart` gained a deterministic transform vocabulary that works on any
result table: `seriesKey` (long → wide pivot, up to 8 series + Other),
`extraYKeys`, `sort` (x / y_desc / y_asc), `limit` + `take` (first/last N),
`orientation`, and `chartType: auto` resolved from the x axis (time → line,
categories → bar). Transforms produce a derived evidence table so the client
plots exactly what the model verified. The tool is exposed whenever the answer
shape allows a chart *or* the owner asked for one *or* prior results exist;
the perceptual floor is 3 points for a line, 2 for bars. Renderer honours
`series` and the new `orientation`.

### 4.5 Deterministic re-aggregation and cheap presentation (`aggregate-layer.ts`, `present_result` in `tools.ts`)

*Failure modes addressed: weekday / hour-of-day questions (7 filtered queries,
315 s, or "cannot isolate Saturdays"); 60–90 s spent writing a 30-row table
cell by cell.*

`aggregate_result` groups a governed result by a column value or a date part
of a date/datetime column (weekday, hour, month, day of month, week, date),
optionally after keeping only matching rows (Saturdays; 09:00–11:00), and
sums/averages/counts numeric columns into a derived evidence table that can be
charted and presented. A bucket the view lacks becomes one governed query at
the finest useful grain plus one deterministic transform. Query results keep
every row in memory (bounded) for this; the client-facing slice is unchanged.
Measured: "sales by day of week (3 months)" 315 s / 11 queries → 43–53 s / 1
query; "Saturdays by hour" 239–371 s and *Unavailable* → 98 s with a bar
chart; "what sells best on Saturday mornings" (product × hour) now answerable.

`present_result` shows the rows of one governed result as the owner-facing
table (pick/relabel columns, sort, top N) and builds the same cell-referenced
derivation `compose_table` would have — identical provenance and dashboard
replay — for a dozen output tokens instead of one per cell (a 30-row bill list:
~10,000 output tokens → ~100). `compose_table` remains for combined or
calculated tables.

*Generalises:* both operate on result tables of any view; neither knows a
connector. The right long-term fix for weekday/hour is also semantic-layer
side (derived time dimensions on every timestamp — see §6), but the engine
mechanism means no connector has to model them first.

### 4.6 Answer contract: length calibrated to the question (`lanes.ts`)

*Failure modes addressed: padded, methodology dump, hallucinated source
disclaimers.*

The contract now says plainly: a one-figure question gets one or two sentences
(figure, period, at most one comparison); never explain inclusions/exclusions,
sources, deduplication, currency codes or "not double-counted"; established
source facts tell the model which numbers to use and are never repeated to the
owner. Vague short questions ("How are we doing?", "Sales?") are answered on
the quick lane with the most natural reading recorded as an assumption, never
on the deep lane ("How are we doing?" 349 s / 11 queries → 13 s / 1 query).
Forward-looking month names resolve forward ("bills due in September" on 18
August is next month, not last year's).

### 4.7 Registry-driven native delegation (`native-capabilities.ts`, `statement-lane.ts`)

*Failure modes addressed: P&L / balance-sheet questions rebuilt from ledger
views; Xero MCP used only on the words "P&L".*

"Delegate to the connector's own tool when it beats the semantic layer" is now
a registry: each capability declares connector keys, kinds with routing
descriptions, a deterministic detector, an availability check and a runner.
The engine consults the registry before classification and the orchestrator
can route indirect wording afterwards (`nativeCapability: "id:kind"`). Xero
statements are the first entry, detection broadened to profit / income /
expense-account / expense-ratio / balance / bank-balance questions, and the
statement lane can answer questions *about* the statement (rank lines, ratios,
period comparisons) with the presentation tools. Measured: "net profit last
FY" 8 s; "biggest expense accounts" 28 s from Xero itself.

*Generalises:* adding connector #47's native report is one registry entry.

### 4.8 Meta lane and data-derived freshness (`meta-lane.ts`, `freshness.ts`, `config.yml → freshness_probes`)

*Failure modes addressed: meta questions answered by probing queries (155 s),
unconnected tools named, no watermark for Fivetran-backed connectors, reviewer
applying one connector's watermark to another's data.*

Questions about the data itself are answered from a fact sheet the engine
already owns (connected tools and their data areas from the config,
not-connected tools, native capabilities, watermarks, source findings) with one
composition call (4–8 s). Watermarks are derived from the data when the control
plane has none: `freshness_probes` name each connector's primary time
dimension; the engine probes latest/earliest dates in parallel with
classification, cached per tenant, bounded to 5 s on the critical path. The
sufficiency reviewer is told a watermark applies only to its own connector and
domain, and not to fail a review over curiosities that do not change the
answer.


## 5. Post-improvement results and before/after comparison

Same 250 turns, same leases, same tenant, same judge; the improved engine ran
from a second frozen snapshot immediately after the baseline finished
(04:47–06:18 UTC). Full tables: `evals/albert/runs/improved/report.md` and
`evals/albert/compare-baseline-vs-improved.md`.

### 5.1 Headline

| | baseline | improved |
|---|---|---|
| Pass rate | 50% | **63%** |
| Mean overall / correctness / directness / calibrated detail / format | 3.06 / 3.51 / 3.95 / 2.69 / 3.24 | **3.44 / 3.86 / 4.36 / 3.21 / 3.50** |
| Golden verdicts (62 golden turns) | match 34 · partial 4 · mismatch 9 · golden unavailable (Cube) 31 | match 42 · partial 4 · mismatch 8 · unavailable 20 |
| Latency p50 / p95 / mean | 112 s / 780 s / 210 s | **39 s / 708 s / 119 s** |
| Turns failed outright (780 s / aborted) | 19 | 9 |
| Answer states | Verified 110 · Exploratory 91 · Unavailable 25 · failed 19 · No data 5 | Verified 153 · Exploratory 67 · Unavailable 17 · failed 9 · Qualified 3 · No data 1 |
| Model requests per turn (median) | 10 | **4** |
| Governed queries per turn (mean) | 3.5 | 1.9 |
| Lanes used | quick 141 · analytical 99 · deep 5 · statement 4 · explain 1 | quick 134 (86 via recipes) · analytical 74 · represent 16 · statement 14 · meta 9 · deep 3 |

**Like-for-like view.** Both runs were hit by infrastructure: Cube 90 s
timeouts (74 baseline turns, 52 improved) and the Xero MCP outage (21 / 17
turns). On the 134 turns untouched by either event in either run: pass 68% →
**75%**, overall 3.59 → 3.77, p50 55 s → **20 s**, p95 338 s → **143 s**.

### 5.2 Latency by class (p50 / p95, seconds)

| class | baseline | improved | notes |
|---|---|---|---|
| cold single-tool (162) | 106 / 780 | **38 / 676** | recipe turns 6–15 s; planned turns 15–60 s; the p95 is Cube timeouts on hard Lightspeed product questions |
| cold multi-tool (28) | 237 / 753 | **129 / 780** | planned cross-tool 50–130 s; the tail is deep/analytical turns waiting out timeouts |
| follow-up (12) | 183 / 780 | **23 / 780** | one query or none (prior results); F-11b timed out on Cube in both runs |
| drill-down (16) | 101 / 780 | **61 / 780** | |
| chart re-format (20) | 49 / 249 | **11 / 93** | 0.4 queries per turn (was 2.5); 14 of 20 answered by the represent lane with zero queries |
| meta (12) | 62 / 632 | **7 / 625** | fact sheet, no queries; T-09 ("how many products in the catalogue") is a data question routed to quick and lost to Cube timeouts |
| by tier — easy | 40 / 780 | **15 / 464** | |
| medium | 95 / 657 | **24 / 161** | |
| hard | 180 / 780 | 148 / 780 | dominated by Cube timeouts (14 hard Lightspeed turns saw ≥1) |
| extremely hard | 227 / 609 | 154 / 780 | |
| ambiguous | 292 / 753 | **15 / 780** | brief answer under a stated reading |
| by scope — Deputy | 63 / 248 | **22 / 143** | |
| Lightspeed | 122 / 780 | **38 / 780** | |
| Xero | 103 / 281 | **39 / 327** | statement lane 6–15 s when the MCP answered; ledger fallback 40–130 s during the outage |
| multi | 237 / 753 | 129 / 780 | |

Where the time goes now (cold single-tool p50): Cube execution 3 s, model +
engine 25 s (was 7 s + 89 s); model requests 6.3 per turn (was 10.9). Chart
re-formats: 11 s model time, no Cube. Cross-tool: Cube 14 s, model 111 s (was
15 s + 211 s).

### 5.3 Quality by class (pass rate; mean overall)

| class | baseline | improved |
|---|---|---|
| cold | 46% (2.98) | **62% (3.41)** |
| follow-up | 75% (3.50) | 75% (3.67) |
| drill-down | 50% (3.25) | 44% (3.19) |
| chart re-format | 75% (3.45) | 75% (3.80) |
| easy / medium / hard / xhard | 67% / 61% / 33% / 35% | **79% / 76%** / 39% / 38% |
| ambiguous / meta | 29% / 8% | **57% / 33%** |
| Deputy / Lightspeed / Xero / multi | 76% / 47% / 49% / 32% | 80% / **65% / 63%** / 36% |
| calibrated detail (mean) | 2.69 | 3.21 |
| format fitness (mean) | 3.24 | 3.50 |

Failure tags before → after (turns): padded 153 → 132 · over-investigated
66 → **32** · unavailable/error 47 → **27** · timeout 27 → 20 · no chart when
needed 16 → **3** · re-ran pipeline for a re-format 15 → **3** · table missing
13 → **5** · methodology dump 12 → **1** · hallucinated source 3 → **0** ·
false zero 8 → 4 · missed facet 50 → 50 · format broken 24 → 24 · wrong number
17 → 14 · wrong entity 15 → 14 · assumption not stated 6 → 11 · too thin 1 → 6.

### 5.4 What moved and what did not

Biggest per-turn wins (overall 1–2 → 4–5): A-01 "How are we doing?" 479 s /
9 queries → 12 s / 1; C-10b re-format 94 s / 8 queries → 10 s / 0; D-05b
"Saturdays by hour" 322 s / 13 queries → 61 s / 2 with a bar chart; D-05c
"what sells best on Saturday mornings" 609 s / 26 queries / *No data* → 275 s
/ 2 / a supported ranking (one prose slip on the leading *physical* item); F-08b follow-up 780 s timeout → 94 s; E-LS-08 top
categories 780 s → 15 s; M-XR-01 top suppliers 294 s / 9 → 14 s / 1; M-DP-08
"most Saturdays" 386 s / 9 → 32 s / 1; T-07 meta 19 s wrong → 6 s right;
E-XR-13 / M-XR-02 / M-XR-10 statement questions Unavailable → answered.

Regressions (overall dropped ≥ 2) and their causes:

- **X-15, D-01b, H-LS-05, X-17, X-20** — Cube timeouts on the improved run's
  queries (the baseline happened to get through); D-01b and X-20 hit the 780 s
  ceiling. Infrastructure, not engine.
- **M-DP-05 "most leave"** — the leave recipe counts leave requests; the golden
  counts approved leave hours (Angus). Recipe definition to align.
- **T-08 "last Xero transaction"** — the meta lane answered "not available"
  when the Xero freshness probe had not returned within its 5 s budget instead
  of escalating to a query. Fixed after the run: the meta lane now escalates
  when the fact sheet lacks the asked date (§4.8).
- **F-04b "which of those bills are overdue"** — the recipe listed the two
  overdue approved bills ($294.84) without reconciling to the prior turn's
  contact-level payables ($23 k, itself suspect — §6.4).
- **X-16, C-04a, C-07b, H-DP-05** — composer slips: a per-staff comparison
  plotted as one series; a two-year comparison charted as one year per chart
  (the compareDateRange result was not pivoted); "margin after wages" answered
  as gross margin; a roster-coverage total that did not add up to its own
  rows. See §6.5–6.6.
- **E-LS-19 "sales today"** — 3 transactions vs golden 1: the recipe counts
  transactions including refunds/voids while the golden counts completed
  sales; recipe measure to align.

What did not move: **missed facet** (50 → 50) — the drill-down and hard tiers
still lose the asked grain (refunded *items*, shifts *listed*, margin *after
wages*); **format broken** (24 → 24) — now mostly duplicated charts/tables from
the composer rather than markdown tables or missing charts; **padded** stays
the most common tag (132) but has changed character: the judge now flags a
one-row table beside a one-figure answer (the engine presented the evidence
table when no answer table existed — fixed after the run: single-row evidence
is no longer presented on its own) and light extra context, not methodology
paragraphs (methodology dump 12 → 1, hallucinated source 3 → 0).

Three fixes were made after the measured run in response to it and are in
the working tree but not in the improved numbers: the meta-lane escalation
(T-08), single-row evidence tables not presented on their own (the residual
"padded" on one-figure answers), and the planned lane's fail-fast Unavailable
being terminal instead of handing to the agentic lane (F-11b spent 780 s
re-timing-out); plus a planner rule to query several named entities in one
query, and word-number periods ("last two years") for recipes with a fall-through
to the general path when the named period is not expressible.

---

## 6. Remaining failure modes and recommended next steps

Observed on the improved run (details in §5 and `runs/improved/report.md`),
in priority order.

1. **Semantic-layer tail latency and 90 s timeouts (infrastructure, the largest
   remaining cost).** The analytics database runs at its 60-connection ceiling
   with Fivetran syncs, other batteries and Cube sharing it; queries that take
   1–3 s in isolation take 30–90 s under load and time out outright. The engine
   now fails fast and in parallel, but a turn whose only query times out is
   still an *Unavailable* answer. Next: (a) Cube pre-aggregations for the hot
   views (`sales_analytics`, `product_sales_analytics`, `workforce_analytics`,
   `xero_finance_analytics`) at day grain with the common dimensions —
   removes most of the scan cost; (b) a larger database tier / dedicated
   read replica for Cube (see memory: `max_connections=60`, saturated);
   (c) a per-turn query-time budget that switches to a cached / coarser
   result before the 90 s wall.
2. **Derived time dimensions in the views (semantic layer).** `aggregate_result`
   answers weekday / hour-of-day questions engine-side, but at the transaction
   grain a "products by weekday × hour" question needs thousands of rows.
   Adding `*_weekday`, `*_hour_of_day` (and `*_week_of_year`) dimensions to
   every view's primary timestamp is a modelling convention that generalises to
   all connectors and lets Cube group and *filter* on them. Needs a Cube
   release.
3. **Native report outages have no cache.** When the Xero MCP proxy failed
   (Xero API allowance / token, from ~03:17 UTC), statement questions fell back
   to the synced ledger view, whose P&L lines differ from Xero's report (no
   cost-of-sales split, no payroll journals) — the answer is available but not
   the owner's P&L. Next: cache the last successful statement per tenant/kind/
   period (statements are immutable once the period closes) and serve it with
   an "as at" label; surface `X-DayLimit-Remaining` in the connection brief.
4. **Xero payables at contact level disagree with the bill list** (contact
   snapshot $22.5 k outstanding vs approved unpaid bills ~$1.9 k). This is an
   ingestion/data-quality issue in `source_xero` (stale contact balances), not
   an engine one; it produces confident wrong "top creditor" answers on both
   runs. Next: reconcile contact balances against invoices in the census, or
   drop the contact-level payables member from the recipe/view.
5. **Composer presentation slips**: occasional duplicated charts (the composer
   charts an aggregated result twice), a per-staff comparison plotted with one
   series instead of `seriesKey`, a "sort it" re-format delivered as a table.
   Cheap fixes: dedupe identical chart signatures across derived tables (the
   signature already dedupes same-table charts), require `seriesKey` when the
   plan nominated one, and prefer make_chart for re-formats of a chart.
6. **Drill-downs that need a facet the plan missed** ("what was refunded?" →
   refunded items). The planner covers the asked question; drill-down turns
   sometimes need the *entity* grain (items, shifts) rather than the aggregate.
   Next: an "answer must cover" hint from the classifier for drill-downs
   ("list the underlying items/documents"), and a recipe per view for "list the
   underlying records for period P".
7. **Workshop status semantics** (every job reads as open) still trips
   drill-downs; the source finding exists but the composer does not always
   surface it. Next: a per-view data-quality note in the schema the planner
   sees (`aiContext`), so caveats ride with the view rather than with the
   tenant finding.
8. **Vague questions get an assumption but rarely a clarification.** The eval
   accepted either; owners may prefer a one-line clarification for "Show me the
   numbers". Next: A/B the clarification chip in the product.
9. **Not measured here:** connectors other than the three test tools. Every
   mechanism is populated per connector; the recipe and freshness-probe sets
   for Square, Shopify, Lightspeed X, Stripe, Momence, Meta/Google Ads are
   still to be written (a config task per connector, no engine change).

## 7. Housekeeping and how to re-run

```bash
# run (from the working tree or a snapshot; EVAL_RUNS_ROOT points a snapshot at the repo's runs dir)
EVAL_ENGINE_LABEL=<label> npx tsx scripts/albert-eval/run.mts --run <name> --concurrency 6 [--ids A-01,C-02b] [--resume]
# grade (Anthropic Opus by default; EVAL_JUDGE_PROVIDER=openai uses gpt-5.6-sol) — --resume re-judges errored rows
EVAL_JUDGE_PROVIDER=openai npx tsx scripts/albert-eval/grade.mts --run <name> --concurrency 4 --resume
# reports
npx tsx scripts/albert-eval/report.mts --run <name>
npx tsx scripts/albert-eval/report.mts --compare baseline <name>
```

- Runs, grades and reports: `evals/albert/runs/{baseline,improved}/`,
  `evals/albert/compare-baseline-vs-improved.md`. Dev runs `dev1..dev9` are
  the smoke batteries used while iterating.
- Eval leases (`scripts/albert-eval/lib.ts` `LEASES`) are still open turn
  leases in the control plane; complete them when the harness is next idle.
- Nothing has been committed; the working tree carries the engine changes,
  the harness, ADR 0097 and this report.
