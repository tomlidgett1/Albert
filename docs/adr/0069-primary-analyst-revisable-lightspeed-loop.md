# 0069. One revisable primary analyst with progressive Lightspeed semantics

Date: 2026-08-09

## Status

Superseded for V2 by ADR 0077. Its revisable-loop principles survive in the
bounded Investigation Plan, but its model-authored SQL and V1 tool loop remain
available only during the rollback window. The signed semantic service,
read-only execution role, tenant isolation, numeric grounding, provenance, and
answer-state enforcement
remain mandatory.

## Context

Albert divided an analytical turn between a low-effort intent planner, a SQL
evidence agent, and a low-effort answer agent. That separation discarded the
analyst's working context twice. The plan was fixed before evidence arrived,
the query agent could not revise the trusted plan, and the answer agent saw a
lossy copy capped at the first 25 rows. A larger turn ceiling did not repair
the underlying handoffs.

The Bike Dashboard's Insights New runtime demonstrated the useful opposite:
one capable agent owns planning, discovery, querying, interpretation, and the
answer; it can change direction after every result; and its complete source
catalogue remains discoverable. Albert must retain its stronger correctness
controls while adopting that analytical loop. This phase is deliberately
Lightspeed-first.

## Decision

One primary analyst owns the complete normal turn:

1. It records an initial working plan before any schema or data tool runs.
2. It searches a compact catalogue containing every generated `ls_*` table,
   then loads exact table grain, keys, joins, field meanings, and traps on
   demand from generated per-table dictionaries.
3. It executes model-authored SQL only through the existing signed semantic
   service and inspects each governed result in the same model context.
4. It records a revised plan whenever evidence, ambiguity, or a failed route
   changes the next useful step, and returns the maximum supported partial
   answer if one branch cannot be completed.
5. It writes the final structured answer itself. There is no separate LLM
   intent planner and no normal lossy answer-composer handoff.

For a broad request that explicitly names at least three analytical sections,
trusted runtime code enforces breadth before depth: once one section has a
usable result, another query for that section is deferred until every named
section has one result. This prevents a review from spending its whole evidence
window debugging one area while silently omitting customers, staff, inventory,
or operations.

The primary run has an eight-result ceiling. Its tools disappear dynamically
when the ceiling is reached or the synthesis reserve begins, forcing the next
turn to be answer-only. If the provider or SDK ends the primary run without a
readable structured answer, the same configured model receives an answer-only
continuation. The continuation prefers the original full run history. If the
SDK did not expose history, Albert supplies a lossless packet containing the
original question and every result's purpose, columns, rows, provenance, and
validation state. It may repair structured output for up to three turns and
has no tools. This is interruption recovery, not a separate planning or
interpretation stage.

The pre-agent router is reduced to deterministic, fail-closed product policy:
known unavailable concepts, material metric ambiguities, and server-owned
directory routes. It does not prescribe the analytical plan.

The Lightspeed catalogue and per-table dictionaries are generated from the
reconciled schema sources, so all available tables remain reachable without
injecting every column into every prompt. Exact documentation is returned by
local `search_schema` and `describe_tables` tools; it is semantic context, not
query authorisation.

Connector playbooks contain reusable Lightspeed meaning only: grains, joins,
metric definitions, platform conventions, and known failure modes. Merchant
facts are never injected from a reference tenant. Timezone, categories,
employees, table population, coverage dates, payment setup, statuses, counts,
and availability conclusions must be measured from the current connection.
Empty, sparse/partial, and observed-zero populations are distinct outcomes.

The model-facing staging query tool accepts only `purpose`, `sql`, and `limit`;
trusted code injects the claimless exploratory contract. Cause-specific error
guidance distinguishes timeouts, grouping errors, oversized sorts, missing
columns, and ambiguous columns. A failed branch gets one simplified retry, and
multi-part work then moves to the next independent section.

The quality-first default remains Sol with maximum reasoning and Fast mode.
The main run has a 32-turn ceiling, an eight-result ceiling, a 150-second
analytical deadline, and a 45-second wrap-up reserve. A narrow low-effort
summariser may still compress a result over 100 rows, but it neither plans nor
answers. The 30-case evaluation for this decision deliberately used Luna with
maximum reasoning and Fast mode, as a separate test profile rather than a
change to the product default.

## Consequences

- Planning is explicit and auditable but no longer treated as trusted proof.
- Evidence can change the route without a context handoff, and the final
  answer retains access to every result returned in the turn.
- Multi-section reviews cover their explicitly requested breadth before using
  remaining capacity for deeper follow-up.
- Every Lightspeed table is discoverable while prompt size stays bounded.
- Normal analytical turns use one primary model run instead of planner,
  evidence, and answer runs; interrupted complex turns may use the answer-only
  continuation described above.
- Tenant-specific examples can no longer leak a reference merchant's timezone,
  categories, staff, coverage, or operational setup into another answer.
- Safety remains enforced below and after the model, not delegated to its
  plan. Output can still be reduced, redacted, or blocked by Albert's existing
  grounding and provenance gates.
- Xero and Deputy receive the same progressive catalogue treatment only after
  the Lightspeed phase is evaluated.
