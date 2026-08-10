# 0072. Adaptive manager-specialist analysis

Date: 2026-08-09

## Status

Superseded for V2 by ADR 0077. Investigation Plan V2 replaces the manager and
specialist query loop with one inspectable, bounded hypothesis/evidence DAG.
The V1 runtime may retain this behavior only during the rollback window.

## Context

ADR 0069 correctly gave one primary analyst ownership of planning, evidence and
the final answer. This removed two lossy context handoffs, but it also required
one generalist prompt and tool set to serve a one-row lookup, a normal trend
analysis and a broad cross-domain business review. A real latest-sale trace
spent 43 seconds searching eight tables and loading four definitions before one
query. Conversely, broad diagnostic questions remained limited by the same
150-second, eight-result budget and had no independent analytical review.

More model turns alone do not solve this calibration problem. Unconditional
multi-agent execution would add latency and failure points to simple questions,
while handoffs would again separate interpretation from final synthesis.

## Decision

Trusted code classifies analytical task shape into three execution lanes. The
classification controls orchestration and budgets only; it never decides a
business fact or numerical answer.

- **Lookup:** one lead, a direct known-path query, at most two results, 90-second
  analytical budget and no specialist or reviewer.
- **Standard:** one revisable lead analyst, up to eight results and a 240-second
  analytical budget.
- **Deep:** one lead manager, up to four domain specialists exposed as agent
  tools, up to sixteen results, a 15-minute analytical budget, independent
  draft review and one bounded repair loop.

The lead always owns the user conversation and final answer. Specialists are
manager-invoked tools rather than handoff destinations. Each specialist has a
narrow domain instruction and a restricted analytical tool set, but executes
through the same signed, tenant-scoped, read-only semantic service. All
specialists share the run-scoped governed evidence ledger; their structured
outputs cite result identifiers and exact cell-bound claims rather than copying
or reformatting numerical evidence.

Independent specialist calls may run in parallel. The shared result ceiling,
deadline, duplicate-query rejection, breadth guard and immutable query receipts
remain trusted runtime controls. A failed specialist is contained as a partial
workstream and cannot erase evidence returned by another specialist.

For deep work, a tool-less analytical reviewer receives the question, proposed
answer, requested sections, specialist outcomes, failures and a bounded
projection of the lossless governed evidence ledger. Normal-sized results are
complete; oversized results carry row count, their leading/trailing window and
the draft's separately server-validated exact-cell claims. It checks question
coverage, comparability, material drivers, unsupported conclusions and
actionable qualification. A repair verdict may return the complete manager
history to the lead for one bounded continuation. There is no open-ended critic
loop.

Execution limits remain safety ceilings rather than targets. Lookup work must
stop as soon as one result answers the question. Deep work has a longer budget
because independent business sections, reconciliation and repair can be
legitimate, but it retains a two-minute synthesis reserve and hard turn/result
ceilings. The existing route-level optional timeout and durable lease renewal
remain in force.

## Consequences

- Simple lookups avoid schema-research ceremony and redundant answer tables.
- Standard questions retain the coherent single-analyst loop from ADR 0069.
- Broad and diagnostic questions gain parallel domain depth and an independent
  quality check without losing full governed context.
- Multi-agent overhead is paid only when trusted task-shape evidence justifies
  it.
- Evaluation must report quality, coverage, latency, tool calls, retries and
  cost separately for each lane; a multi-agent path is not accepted merely
  because it produces more text.
