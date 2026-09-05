# ADR 0122: brief-aware Codex budgets and parallel eval environments

- Status: accepted
- Date: 2026-08-24
- Owners: product and platform
- Extends: ADRs 0110, 0112, 0114 and 0121

## Context

A live subscription-backed Luna / Max / Fast specimen for the generic question
“what are the three biggest problems?” reached 19 governed queries, spent nearly
eight minutes, remained on one active plan step, and required multiple grounding
repairs. The earlier uniform ceiling of 20 prevented an infinite investigation
but did not preserve a useful latency/quality frontier. More evidence increased
the citation surface without making the requested three-problem decision more
complete.

The 300-turn development corpus also needs higher throughput. Independent shell
processes would race over corpus selection and append the same output files.
One runner already owns an atomic unit queue and can safely operate several
isolated app-server environments.

## Decision

Every Codex turn retains ADR 0110's 12-minute analytical deadline and gains a
brief-aware successful-query ceiling:

- testable opportunity: 16;
- target goal: 14;
- decision model: 12;
- general analysis: 10; and
- employee performance, framework, or unclassified analysis: 8.

The soft advisory begins four queries before the ceiling and states the exact
remaining count. It directs Codex to finish the current evidence obligation,
avoid opening an optional surface, and derive remaining arithmetic from cells
already returned. At the ceiling the host rejects further semantic queries and
requires plan settlement and composition. Catalogue/schema discovery and
trusted derivations remain available because they do not create another source
observation; existing per-tool security and derivation limits remain unchanged.

One evidence plan step may bind at most three governed results. A later query is
rejected with `plan_step_saturated` until Codex marks that step done and advances
the next pending evidence step (or synthesis). This distributes a bounded
budget across the question's actual obligations instead of allowing one
interesting lane to consume every query.

The subscription corpus runs through four workers inside one process. Each
worker receives its own:

- temporary cwd and SQLite/log state;
- ephemeral app-server process and thread;
- control-plane turn lease and Cube bearer; and
- event/result artifact path.

Workers share only the reviewed ChatGPT authentication identity, immutable
question corpus, and one in-process queue. Starts are staggered by 2.5 seconds
to avoid simultaneous auth/config initialization. A single process remains the
only writer coordinating question ownership, so no case can be claimed twice.
Subscription rate-limit failures remain resumable and never fall back to API
billing.

## Consequences

- Broad generic answers must prioritize the best-supported findings instead of
  auditing every reachable domain.
- Named briefs with more reviewed obligations retain proportionally more query
  headroom.
- Four environments improve corpus wall-clock throughput but do not change one
  turn's measured latency; the brief-aware ceiling addresses per-turn latency.
- A future ceiling change requires paired latency, quality, grounding-repair,
  and missed-facet evidence rather than intuition alone.

## 300-turn quality follow-up

The completed subscription corpus scored 67% pass. Zero-model recipe turns
passed only 47% versus 71% for model-backed turns. Accordingly, deterministic
recipes are now limited to literal facts: causal/evaluative language,
comparisons and shares, ranking superlatives, named entities, sensitive/action
requests, absolute dates, and financial-year asks fail open to Codex. This
preserves the measured 2-second path where its semantics are exact without
trading correctness for speed.

Host sufficiency also makes deliverables explicit. A list/ranking/breakdown
cannot finalize without a presented governed table, and an explicit chart ask
cannot finalize without a newly emitted governed chart unless the terminal
state is Clarification, No data, or Unavailable. Narrow answers receive a
600-character guidance target and must leave row recital to the table.

Natural chart follow-ups (for example, “sort the months”, “make it a line”, or
“switch it back to bars”) now carry forward chart intent. Pure type, ordering,
subset, and axis edits cannot reopen the analytical pipeline; bucket, measure,
or added-period changes may use at most one new query. The targeted nine-turn
chart set improved from 4/9 to 9/9 passes, reduced p50 from 142s to 117s and
p95 from 199s to 161s, and reduced governed queries from seven to four.

Presentation-only repairs are host-owned: claim-referenced rankings/lists get
their governed table without another model round, while chart-only asks drop
duplicative answer tables. Cross-source mismatches receive the governed scope
limitation when the draft reports only differing totals. Broad business-area
health asks use adjacent complete periods and cover the area's material volume,
revenue/cost, and labour/product facets.

The iterated 17-turn failure set improved from 4/17 to 17/17 subscription-judge
passes (mean correctness 3.18 to 5.00). This is targeted verification, not a
replacement full-corpus score. Its aggregate latency rose because unsafe
2–4-second recipe answers now route to Max model reasoning; do not describe
that as a global latency improvement. The completed 300-turn baseline remains
67% pass, p50 119s and p95 495s until a fresh full-corpus run is completed.
