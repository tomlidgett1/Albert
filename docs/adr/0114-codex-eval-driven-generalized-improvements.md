# ADR 0114: Eval-driven generalized Codex harness improvements

Date: 2026-08-21
Status: Accepted
Relates to: ADR 0112 (Codex answer-quality contract), ADR 0113 (Proactive panel)

## Context

A 50-question owner-realistic eval battery (`scripts/albert-eval/questions-codex-bikeshop.ts`,
runner `scripts/albert-eval/run-codex.mts`) was run against the Codex harness on
gpt-5.6-luna at max effort with fast mode off, against the Ashburton Cycles dogfood
tenant (lightspeed-r + xero + deputy). Tiers: easy, medium, hard, xhard, ambiguous,
meta, theory. Grading: `grade.mts` LLM judge (Sol) + deterministic
`format-metrics.mts`. Baseline run `codex-luna-max-baseline`:

- Pass 20/50 (easy 10/10, correctness 5.0; hard 2/8; ambiguous 1/6; theory 1/5).
- Latency p50 207s / p90 442s; compose time (answer − last query) p50 132s;
  31/50 turns entered the draft-repair loop (42 round-trips).
- Dominant judge tags: padded 43, over_investigated 27, missed_facet 17,
  format_broken 12, unsupported_number 8, wrong_period 5, stale_data_claim 5.

Root causes were traced in the harness, not the model:

1. **No current date in the prompt.** The model inferred "now" from whichever
   result it saw first (monthly P&L ends last month), producing wrong
   "last N weeks/months" windows and false "data ends in July" claims.
2. **Markdown pipe tables** appeared in 5 answers (the mermaid ban never
   mentioned tables), duplicating governed presented tables.
3. **Cube's duplicate time-dimension column** (`dim` + `dim.granularity`,
   identical values) leaked into owner-visible tables.
4. **No re-aggregation capability**: proving a "busiest weekday" ordering took
   seven per-weekday scalar queries because `derive_result` could not group
   rows the turn already had.
5. **Two-series stories split into two charts**: the model never aligned two
   results and charted them once (the `alignWith` + `extraYKeys` path existed
   but was unguided), and an exact duplicate chart shipped twice because the
   dedupe signature keyed on `resultId`, not plotted content.
6. **Machine captions**: the model sometimes passed the view name as the
   owner-visible topic/caption.
7. **Grounding vs theory questions**: legitimate industry rule-of-thumb ranges
   were unstateable (any non-cell number is redacted), so benchmark questions
   lost their most useful sentence.
8. **Effort miscalibration**: narrow questions over-investigated (26 queries
   for "How are we doing?"), while explicitly asked sub-facets were still
   missed; followUps were empty on 41/50 turns (no guidance existed).

## Decision

All changes are generalized (no connector-, industry- or view-specific logic):

- **Prompt (semantic-runtime `renderTrustedInstructions`)**: current date in
  the tenant timezone plus a recency rule (anchor relative periods to today,
  include partial periods, never claim a data cutoff without a latest-date
  check); explicit sub-question coverage rule; investigation-effort
  calibration; scalar answers present no tables; followUps guidance;
  markdown-pipe-table ban; combined-chart guidance (align two results, chart
  once with extraYKeys/series; compareDateRange for two periods);
  owner-visible caption rule; derive-before-compose emphasis; externally
  attributed rule-of-thumb sentences.
- **Validator**: sentences explicitly attributed as general industry guidance
  (e.g. "as a general industry rule of thumb") are exempt from cell-grounding;
  everything else still grounds to cells. A markdown pipe table in a draft
  triggers a bounded repair (like the mermaid repair).
- **Tables**: `columnKeys` drops a bare column whose dotted granular sibling is
  present (Cube time-dimension duplicate). Machine-ish topics are rewritten
  into readable captions from the query's measures/dimensions and time range.
- **derive_result `groupBy`**: trusted re-aggregation of rows already returned
  — group by an existing column, optionally bucketing ISO dates by
  weekday/month/quarter/year; numeric columns are summed, percent columns are
  dropped with a disclosure (re-derive via ratio). Grouped cells are citable
  governed evidence.
- **Chart dedupe**: the duplicate signature now hashes plotted values instead
  of the source resultId, so re-derived clones of the same chart are rejected.

## Consequences

- Contract tests extended: `codex-derive-result` (groupBy semantics, bucket
  errors, attribution exemption) and `codex-chart-runtime` (content-based
  duplicate rejection).
- The improvement run is compared against `codex-luna-max-baseline` with the
  same battery; see `evals/albert/runs/` and the eval report artifact.
- The attribution exemption is deliberately narrow: the exempting phrase makes
  the non-tenant provenance visible in the answer itself; tenant figures
  cannot borrow it without announcing themselves as not the owner's data.

## Addendum: iterations 2–4 (same day)

Fair-judge note: the grader originally showed the judge only 6 rows per
evidence table, so figures grounded in row 7+ of weekly/monthly series were
scored as invented. `grade.mts` now shows 30 evidence rows (40 for answer
tables); all runs below are scored under the widened window.

Scores (pass/50, same 50-question battery, Luna max, fast off):
baseline 19 → improved 29 → improved2 27 → v4 28. Plateau diagnosis: the
remaining failure mass is padded / missed_facet / over_investigated, plus a
cluster of concrete defects found by forensics on every failing turn.

Further generalized changes:
- **Answer-surface tables** (found via a live bug report): the product renders
  only `presentation:"answer"` tables beside the reply, and Codex emitted
  everything as evidence — presented tables are now re-emitted for the answer
  surface (final and evidence-recovery paths). Presented duplicates (same
  view+query digest) are dropped.
- **derive_result**: duplicate column labels auto-renamed from the unique
  expression name (a live turn shipped twelve columns all labelled "Quarter");
  `select` re-projects to named columns so a presentable table is not a
  25-column scratchpad.
- **Sufficiency reviewer**: now enumerates the owner's explicit sub-questions
  (missed_facet was the #2 tag) and returns an `excess` list — content beyond
  the ask is a defect with a trim-repair channel, not just missing coverage.
- **Briefs**: generic brief demands every explicit sub-question answered and
  scopes breadth to "domains material to the ask"; new `framework_question_v1`
  brief (framework + attributed benchmark + own position + implication) for
  "how should I think about X" questions.
- **Query budget**: soft advisory at 10 governed queries, hard stop at 20
  (eval turns reached 26–40 queries with no score benefit — pure latency and
  padding).
- **Failure-derived prompt rules**: zero-activity entities must be checked on
  per-entity/screening asks (three fails shared this root cause);
  sourceFindings override raw query impressions; seasonality requires full
  available history; a comparison ask implies the delta and % change.

## Addendum 2 — final results (2026-08-22)

Batch 5 (run v6): a bounded, fail-open **editorial tightness pass**
(`answer-editor.ts`) after validation — cuts methodology narration and
unrequested domains, figures byte-identical, edited draft re-validated for
grounding and adopted only if still fully grounded (adopted on 25/50 turns);
plus a `decision_model_v1` brief (cost side, break-even gain vs baseline,
headroom, sensitive assumptions) for "can we afford / is it worth it" asks.

Grader fix: `grade.mts` dated turns by the **UTC** day of `startedAt`; the
runtime resolves "yesterday"/"this week" in the tenant timezone, so a run
straddling UTC midnight was judged against the wrong day (v6 ran 14:09Z+ =
after tenant midnight; 6 spurious wrong_period tags). `today` is now computed
in the tenant timezone (`EVAL_TENANT_TIMEZONE`, default Australia/Melbourne).
Only v6 was affected; earlier runs re-verified clean.

Final trajectory (pass/50, fair judge): baseline **19** → improved **29** →
improved2 27 → v4 28 → v5 29 → v6 **31** (62%). v6 means: overall 3.76,
correctness 4.08, detail 3.42 (baseline 2.62), format 3.78. Deterministic
wins held: pipe tables 0, wrong-period/stale ~0, charts 3/3 delivered,
answer tables 29/50 turns, follow-ups 47/50, queries capped at 20 (was 40),
answer length p50 792 chars (baseline ~1500+), latency p50 226s.

Stopping decision: program stopped at v6. Tier decomposition — easy 10/10,
hard 6/8, medium 7/10, meta 3/5, but xhard 1/6, ambiguous 2/6, theory 2/5.
Of the 19 remaining fails, 14 are analytical-judgment misses (correctness<4:
the model quantified the wrong facet, skipped a requested derived figure, or
anchored a verdict without a baseline) and 5 are craft-only. These are
model-reasoning and judge-strictness limits, not harness-contract defects;
the contract layer (grounding, tables, charts, periods, budget) no longer
produces failures. Reaching 45/50 would require either a stronger analytical
planner (e.g. decomposition-checklist enforcement per sub-question with
answer-time verification) or accepting judge-defined "ideal analysis" as the
spec — both are new programs, not iterations of this one.

## Addendum 3 — certified scalar recipe preflight (2026-08-23)

A traced one-row question ("what was our latest sale?") took 22.4 seconds:
1.7 seconds in Cube and 20.7 seconds in Codex discovery, drafting and repair.
The semantic query was not the dominant latency.

Codex therefore runs a generalized, fail-open recipe preflight before starting
the app-server loop. It is configuration-driven rather than phrase-specific:

- only one connected certified recipe may match;
- the recipe must be a scalar `fact` with a reviewed deterministic template;
- trusted code must resolve every required period from the bounded recipe date
  grammar;
- grouped, comparative, referential, ambiguous, untemplated, empty or rejected
  cases fall through unchanged to the full Codex runtime; and
- execution still uses the exact turn bearer, Cube validation/privacy policy,
  provenance construction and cell-grounding validator.

The recipe template may interpolate exact result members and the trusted
`{{period}}` parameter. This allows common scalar questions such as "show me
sales this week" to execute one governed Cube query and return a host-rendered
answer without catalogue search, full view hydration, model drafting or repair.
Adding another fast path means publishing another certified templated recipe;
no connector, view or utterance conditional is added to the runtime.

## Addendum 4 — shape-aware immediate acknowledgement (2026-08-23)

The pre-evidence acknowledgement previously collapsed direct questions into
stock copy such as "I’ll check … and bring back the relevant detail." Trusted
rendering now distinguishes lookup, comparison, trend, breakdown, ranking,
reconciliation, investigation, explanation and presentation. Each shape names
the analytical move in one concise sentence; generic promise suffixes are
forbidden by contract tests. The model still supplies only a bounded action and
noun phrase, so no result, figure or untrusted prose can enter this event.

## Addendum 5 — owner-surface recipe coverage and cheaper model path (2026-08-23)

Sales-period lookups were already on the zero-model path. The same fail-open
preflight now covers the other head-of-distribution owner surfaces for
Lightspeed, Xero and Deputy by publishing templated scalar recipes (hours and
wages, roster cost, staff count, stock on hand, GST, refunds, AR, AP, cash in
and out, cash at bank, net/gross profit, workshop open jobs, unapproved
timesheet count, open shift count). Currency dimensions were dropped from the
Xero P&L facts so they stay one-row aggregates.

Matching is still configuration-driven:

- certified scoring uses the recipe name, user request, and listed `matches`,
  with distinctive-token gating so a listed phrasing cannot win on period words
  alone;
- a coordinated ask fail-opens only when two clauses independently match
  different recipes, so "hours and wages" stays one recipe;
- when two scalar recipes both score, the top one must win by a margin or the
  path fail-opens.

Questions that still need the model receive the top certified queries as
trusted first Cube JSON, skip catalogue search when the view index already
names the view, and take a soft query advisory at 6 (hard stop remains 20).

## Addendum 6 — certified list recipe preflight (2026-08-23)

Scalar facts ("sales this week", "hours and wages last week") were already on
the zero-model path. Owner roster asks such as "schedule tomorrow?" are lists,
so they still started the full Codex loop and took 25s or more.

The same fail-open preflight now accepts a connected, templated `list` recipe
when the ask is unambiguous:

- `who` / `which` / `list` wording selects only list recipes, so a count or
  cost fact cannot answer "who is on tomorrow";
- other wording still prefers the recipe that covers more of the question's
  distinctive tokens, so "what will the roster cost" stays a scalar;
- the host renders a row-count sentence from `{{recipe.rows|integer}}`,
  presents the governed table, and uses `empty_answer` when there are no rows;
- breakdown, comparative, referential, and multi-recipe asks still fail-open.

No connector, view, or utterance conditional is added to the runtime.
Adding another list fast path means publishing another templated list recipe.
