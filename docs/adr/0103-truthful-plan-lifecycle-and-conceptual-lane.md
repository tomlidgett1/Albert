# ADR 0103: Evidence-bound plans and governed conceptual answers

- Status: Accepted (implemented 2026-08-19)
- Date: 2026-08-19
- Supersedes: ADR 0097 only where visible plan progress was inferred from query count
- Complements: ADR 0095 (progressive catalogue retrieval), ADR 0098 (business context)

## Context

Albert's visible investigation plan previously advanced one step for every
successful query and marked every remaining step done immediately before the
answer event. Query count does not establish relevance: an unrelated lookup, a
partial investigation, or an answer ending after a source failure could produce
an all-green checklist. The trace did not retain which governed result supported
which plan obligation.

Albert also routed abstract questions such as "How does gross margin work?"
through data lanes. That incurred freshness probes and sometimes a business-data
query even though the published semantic definition was the complete answer.
Conversely, "What is my gross margin?" must remain a tenant-scoped data query.

## Decision

### 1. Stable, evidence-bound plan steps

Every plan step has a stable turn-local id, a kind (`evidence` or `synthesis`),
one of five states (`pending`, `active`, `done`, `blocked`, `incomplete`), exact
governed result ids, and an owner-safe terminal reason when blocked or
incomplete.

An evidence step may become `done` only when every cited result id resolves to a
successful table result already emitted in this trace. A zero-row governed
result is valid evidence for a no-data conclusion. A failed, rejected, missing,
or merely unrelated query is not evidence.

The model-facing `update_plan` tool must retain ids and order and cite result ids
for newly completed steps. Trusted code rejects missing references, identity
changes, terminal-state regressions, and more than one active step. The model
cannot complete the synthesis step.

The planned lane declares `coversPlanStepIds` for every query. Trusted code
applies all parallel query outcomes together; a step completes only when every
query mapped to it succeeded. A repair may correct a query but cannot redirect
its plan coverage. Deep branches declare the same coverage and bind their
reviewed branch results only after all branches settle. Branch-local query
events never mutate the shared plan.

Every planned query and deep branch must map to at least one existing evidence
step whenever a visible plan exists; missing, empty, synthesis-step, or foreign
coverage rejects the planned pass before it executes. Reused prior-turn results
are declared separately, re-emitted into the current trace, and bound by their
exact result ids.

The one-shot query planner preserves the owner's selected reasoning effort. A
60-second planner-only deadline hands the turn to the existing adaptive
investigation rather than holding the stream open indefinitely.

#### 1.1 Research before execution

The planned lane exposes a first-class `research` progress stage before answer
queries execute. It searches the tenant-scoped semantic catalogue, hydrates the
relevant definitions, and validates model-proposed string filters against real
stored dimension values. Equality is tried first; colloquial or misspelt values
fall back to the same bounded typo-tolerant contains variants used by entity
exploration. Successful matches replace the proposed filter with exact stored
values. Research is capped at four distinct value lookups with a ten-second
deadline per lookup. Missing, excessive, or unavailable validation rejects the
fast planned pass and hands the turn to the adaptive lane; it never guesses.

Research lookups are scope validation, not answer evidence. They emit no result
table or numerical claim. The completed research event records the semantic
areas and value validations it performed, followed by one short owner-facing
commentary.

#### 1.2 Commentary on plan completion

Every evidence-bound plan completion carries a concise commentary in the main
activity stream. Trusted planned/deep execution derives the exact supporting
result count and emits a short narrative after publishing the completed step.
Completion commentary is not copied into the plan card; completed rows remain
compact, while the card reserves detail text for blocked and incomplete
reasons. Deep branches retain their more specific branch findings and suppress
duplicate generic commentary.

For agentic `update_plan`, a newly completed evidence step is rejected unless
the same call includes a short concrete evidence summary (or plainly states
that no matching/material result was found). Trusted code emits that summary as
narrative commentary in the main activity stream. A step cannot turn green
first and add commentary later.

At finalisation, trusted code preserves evidence-backed completion. It marks the
first unmet evidence dependency `blocked` for an Unavailable answer and every
other unmet obligation `incomplete`. For other terminal answers, unmet evidence
steps remain `incomplete`. Synthesis becomes done only when a real final answer
exists and prior plan obligations already carry valid result evidence. An answer
event is invalid while any visible step remains pending or active.
If a turn throws or is cancelled before an answer, the engine best-effort emits
a terminal plan snapshot first: the blocked dependency is named plainly and the
remaining work stays incomplete.
If an aborted transport cannot deliver that final server snapshot, the client
renders any remaining active/pending steps as incomplete once streaming stops.

### 2. Optional follow-up prompts

Final structured output accepts zero to three follow-up prompts. An empty list
is correct for an engaged conversation or a self-contained answer. Existing UI
surfaces already omit the chip row when the list is empty.

### 3. First-class conceptual lane

`conceptual` is a no-query lane for the abstract meaning, formula, inclusion
rules, or difference between governed business concepts. Deterministic routing
guards distinguish definitions from actual-value requests:

- "How does gross margin work?" and "What is gross margin?" are conceptual.
- "What is my gross margin?" is a quick data lookup.
- "Why is our margin down?" is an analytical investigation.
- A question about a definition used in a previous answer remains `explain`.

Before live connector delegation, the host detects high-confidence definition
questions. Such turns skip native reports, data-derived freshness probes, and
business-context refresh. They still fetch Cube metadata because the published
semantic catalogue is their evidence.

The conceptual lane retrieves a bounded, strictly connector-scoped set of
model-visible member descriptions. Trusted code selects and renders the exact
published definitions directly; no model call or paraphrase can add claims that
the definitions do not contain. Those exact members are recorded in provenance,
which permits Verified with zero data queries. No matching definition is terminal
Unavailable and never falls through to a data query.

## Trace and UI contract

Plan snapshots are additive JSON trace events; no database migration is needed.
The shared trace validator enforces stable step identity, monotonic evidence,
evidence-before-completion, no terminal regression, and no open plan at answer
time. The dashboard renders completed, active, blocked, and incomplete steps
distinctly in light and dark themes, including the terminal reason.

Conceptual answers carry semantic definitions and a definition-specific bundle
hash in ordinary answer provenance. They carry no business result rows, time
window, or fabricated query provenance.

## Consequences

- The checklist is now an auditable statement of completed analytical work,
  rather than a progress animation derived from query count.
- Partial and unavailable answers remain useful without falsely presenting
  every requested facet as complete.
- Planned and deep parallelism is preserved; plan mutation happens centrally
  after results settle.
- Definition questions are faster and cannot accidentally read tenant data.
- Definition answers make no provider call and cannot outrun their cited text.
- Planner and deep-branch output schemas gain explicit plan-coverage fields.
- Historical trace JSON remains readable, while new plan snapshots use the
  stronger step contract.
