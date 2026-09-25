# ADR 0120: Goal-seek answers — owner-stated targets, quantified levers, and a bridge to the number

Date: 2026-08-23
Status: Accepted
Relates to: ADR 0112 (Codex answer-quality contract), ADR 0114 (eval-driven harness improvements)

## Context

Tom's dogfood turn "can we save 1k per month somehow?" produced a technically
grounded but useless answer: a "negotiable cost pool" range ($1,925.82 to
$7,484.69 per month) with no named levers, no engagement with the $1,000
target, an orphaned stock-ageing table the prose never mentioned, and a
tighten pass that had cut the draft from 1,378 to 797 characters. A fresh
goal-seek battery (GS-01…GS-06, added to
`scripts/albert-eval/questions-codex-bikeshop.ts`) reproduced the failure on
four questions with the dash configuration (gpt-5.6-sol, high effort, fast).

The causes were structural, in the harness — not the model:

1. **The answer could not state the owner's own target.** The grounding
   validator required every numeric token to match a governed result cell.
   "$1,000" appears in no cell, so any sentence engaging the target was
   redacted (or cost a repair round-trip — GS-02/03/04 each burned one or two
   "draft figure did not match a governed result cell" repairs trying). The
   model learned to write "the monthly target" instead, which is exactly the
   vagueness the owner experienced.
2. **A per-period run-rate was underivable.** `derive_result` groupBy could
   only sum. "Subscriptions averaged $340/month" — the natural unit for a
   per-month target — was unsayable, so answers quoted annual pools instead.
3. **No goal-seek analytical brief.** "can we save…", "make an extra…",
   "under $X" matched no brief pattern, so the sufficiency reviewer had no
   target-engagement bar to hold the draft to.
4. **The tighten pass gutted dense answers.** It triggered at >900 chars and
   accepted any edit ≥35% of the original; measured on goal-seek turns it cut
   55–57% from already-tight answers, removing the named levers.
5. **Provenance pollution**: follow-up answers listed every derived metric
   from every prior turn in the conversation.
6. **Formatter list-marker collision**: when a currency cell equalled a list
   ordinal, "1." rendered as "$1.00." at the head of a recommendations list.

## Decision

All in the contract layer:

1. **Owner-stated figures are grounded** (`ownerStatedGroundingValues` in
   `services/conversation/src/grounding.ts`): numeric tokens from the owner's
   question — including "$1k", "10%", "2 grand", "a thousand" — join the
   grounded pool for final-answer validation and key-insight filtering.
   Restating the owner's own number is reporting, not invention. Prompt
   states the exception explicitly.
2. **`groupBy.aggregate: "sum" | "average"`** on `albert.derive_result`.
   Averaged columns are relabelled "(average)" and the derivation note
   discloses the aggregation. The tool description teaches the per-month
   run-rate idiom.
3. **`target_goal_v1` brief** (`services/conversation/src/analytical-brief.ts`):
   triggered when the message carries both a money/percent amount and a goal
   verb (save/cut/make/extra/under/free up/…). answerMustCover: restate the
   target with cadence (converting relative targets to dollars from the
   owner's base), quantify each named lever at the target's cadence, derive
   the combined total, verdict (achievable / with stretch / not from these
   levers), rank by controllability, separate evidence from assumptions.
4. **Prompt rules** (base instructions): the named-target yardstick contract,
   and "recommendations must be executable" (named account/product/roster
   with its observed figure; no unnamed pools). Sufficiency reviewer told to
   reject drafts that never engage a named target arithmetically.
5. **Editor bounded to sprawl**: triggers only above 2,400 chars (was 900),
   accepts only edits keeping ≥ max(900, 55%) of the original (was 35%), and
   receives the presented-table captions and insight-card labels with an
   instruction to never orphan a table/card by deleting its only prose
   reading, and never to cut named levers on advisory answers.
6. **Answer provenance filtered** to this turn's evidence plus prior results
   the answer actually presents or cites.
7. **Formatter**: ordered-list markers are exempt from figure formatting;
   dangling empty list items are dropped.

## Results (goalseek battery, sol/high/fast, private runtime)

Baseline → after: GS-01 went from an unnamed "negotiable pool" range with no
target engagement to a **derived $1,069.82/month package of three named
levers** (Tuesday roster overlap $535.96, subscriptions $340.11, advertising
$193.76) with a presented plan table and the verdict "achievable with
stretch" against the restated $1,000.00 target. GS-02/03/04 similarly now
restate their targets, size levers at the target's cadence, and close with a
verdict. Regression probes (easy scalar, requested chart, staff ranking,
wages judgment) held; the wages judgment improved, using the new monthly
average ("Deputy averaged $11,100.06 per month"). All 112 codex contract
tests pass; new contract tests cover owner-stated grounding, the average
aggregation, the goal brief triggers, the editor floor, and the list-marker
formatter fix.
