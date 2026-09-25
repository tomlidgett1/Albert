# ADR 0112: Codex answer-quality contract

- Status: accepted
- Date: 2026-08-21
- Owners: product and platform
- Amends: ADR 0110 (isolated Codex analytics runtime)
- Does not modify: the security invariants of ADR 0110 — trusted code still
  performs every calculation, every figure still binds to governed cells, and
  the process isolation boundary is unchanged.

## Context

ADR 0110 built a validation system that guarantees Codex answers are *true*,
but nothing required them to be *useful*. A representative deep prompt ("go
extremely deep on employees") ran 29 governed queries in ~110 seconds and then
spent ~170 seconds shredding a rich draft down to one sentence, because:

1. The prompt banned all derived arithmetic ("never calculate a figure outside
   returned cells"), so ratios, shares and per-unit rates — the substance of
   analytical insight — were unsayable.
2. One un-bindable claim after repairs replaced the *entire* answer with
   boilerplate, so the cheapest passing answer was the emptiest one.
3. The base instructions were ~95% compliance and ~5% craft; the only quality
   bullet sat 25th of ~30.
4. The sufficiency reviewer was told "do not demand cosmetic additions" and had
   no concept of depth; the analytical brief (and with it the review itself)
   existed for only two regex-matched question shapes.
5. Repair turns ran at the turn's full effort (usually Max), adding ~45s per
   round-trip for citation rebinding that needs no frontier reasoning.

Every corrective loop pushed answers toward exhaustive-or-empty; none pushed
toward insightful. These changes are general: nothing keys on a question topic.

## Decision

### 1. `albert.derive_result` — trusted general-purpose derivation

A sixth namespaced tool. The model names inputs; trusted Albert code computes:

- per-row `ratio`, `difference`, `sum`, `percent_of`, `share_of_total_pct`
  over numeric columns of one governed result;
- optional exact-unique-label alignment of two results (generalizing the
  employee-productivity derivation: duplicates dropped, alignment disclosed as
  a source-label join, never an identity graph);
- re-projection (`orderBy` + `limit`) of an existing result, removing the
  re-query-to-re-sort waste.

Derived cells are governed evidence: they are emitted as trace tables, carry
merged provenance with `calculations` formulae, support host-generated ranked
claims (ordered-before-limit), and are citable exactly like query cells.
Bounded at 8 derivations per turn with digest dedup; values rounded to 4 dp;
division by zero yields null. The prose rule becomes "never do arithmetic in
prose — derive it", which *strengthens* the no-invented-figures invariant while
unlocking derived insight.

### 2. Graceful degradation instead of answer destruction

`validateCodexFinalAnswer` now salvages: an unsupported figure invalidates its
own sentence (via the shared `redactUngroundedProse`), an unprovable claim is
dropped while proven claims survive, and a salvaged Verified draft downgrades
to Qualified with a warning-status validation event disclosing what was
removed. Still failing closed, unchanged: fabricated result references,
evidence-free conclusions, comparative wording with **zero** proven claims,
and answers with nothing grounded left. Grounding repair is bounded: after two
failed repair round-trips the salvaged answer is published rather than burning
the remaining deadline.

### 3. Craft-first composition contract

The base instructions now open with an answer-quality contract: lead with the
most decision-relevant finding; match depth to the ask (scalar → sentences,
broad → structured brief covering every material domain investigated); prefer
derived comparisons over table recital; treat anomalies (empty surfaces,
all-one-status fields, zero costs) as first-class findings; choose
presentedResultIds by story value; limitations once, no padding. All ADR 0110
security bullets are retained verbatim or strengthened.

### 4. Generalized brief + depth-aware sufficiency review

Every analytical turn now carries at least the `general_analysis_v1` brief
(ownerGoal + depth-matching must-covers), so the independent sufficiency
review applies to all substantive turns, not two regex shapes. The reviewer
also receives the owner's question and may return `investigate` when the
draft's depth falls materially below the question's breadth, when gathered
evidence domains are silently ignored, or when a visible anomaly goes
unmentioned — while remaining forbidden from inflating narrow questions. The
review is skipped for single-result turns where it cannot earn its latency.

### 5. Repair turns at reduced effort, both repair loops bounded

Validator-driven repair turns run at `high` when the turn is `max`/`xhigh`
(transient stream resumes keep full effort). Repair feedback now offers up to
8 host-generated claim objects. Evidence updates per turn: 4 → 6. Review
repairs are capped at two round-trips — a grounded draft then ships as-is —
so the reviewer improves coverage but never owns the deadline.

### 5a. Answer length budget: 4,000 → 8,000 characters

The first live deep-dive under this contract produced a rich brief that the
4,000-character schema cap truncated mid-sentence, which the reviewer then
(correctly) rejected — a repair loop the cap made unwinnable. The budget is
now 8,000 characters, the quality contract states it explicitly ("a complete
tight brief beats a truncated exhaustive one"), and the reviewer is
instructed that a visibly cut-off draft yields exactly one missing item:
finish within budget by tightening, never add on top.

### 6. Acknowledgement hardening

The trusted acknowledgement renderer strips a model-authored leading verb so
the template verb cannot double ("I'll investigate examine scope…"), and the
Nano instructions pin `focus` to a business-subject noun phrase.

## Consequences

- The employees deep-dive class of failure (rich investigation, one-sentence
  answer) is structurally removed: derived comparisons are speakable, partial
  grounding failures cost sentences instead of answers, and the review pushes
  the answer back up to the question's breadth.
- The truth guarantee is preserved in a slightly weaker but explicit form:
  every published figure still binds to a governed (query or trusted-derived)
  cell; comparative wording requires at least one proven typed claim rather
  than all claims proving; removals are disclosed in the validation trace.
- Latency improves on the failure path (bounded repairs at reduced effort) and
  worsens marginally on multi-result turns (one low-effort review call).
- The `albert-eval` judged harness should be pointed at the codex lane to
  measure answer quality against the V3 baseline; the smoke suites still
  verify only plumbing.
