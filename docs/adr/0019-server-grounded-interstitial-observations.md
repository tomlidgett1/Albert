# ADR 0019: Server-grounded interstitial observations

- Status: Accepted
- Date: 2026-08-03

## Context

Albert must feel like a natural-language analytics platform: a governed table can
be followed by a concise observation, then another query, table, chart, or final
answer. Emitting model-authored prose directly between results would create a
second quantitative answer channel outside the final-answer grounding checks.
It could also expose private chain of thought if “reasoning” prose were treated
as an unrestricted stream.

## Decision

Add `publish_observation` as a local Agents SDK tool. It never crosses the
semantic-service boundary and may run only against governed results retained in
the current turn.

The tool accepts one typed evidence claim whose references identify an exact
`resultId`, zero-based `rowIndex`, and `columnKey`. The existing claim validator
checks the metric value, same-row dimension labels, comparison semantics,
ordering proof, and result-registry identity. Trusted application code then
discards the model's wording and renders a canonical sentence from the
validated cells.

An optional continuation is selected only by an opaque allowlisted id such as
`break_down_by_location` or `visualise_result`. Trusted code owns the rendered
copy, and that copy contains no figures. Duplicate observations are rejected and
each turn is capped at six observations.

After a non-empty governed table is emitted, the runtime records its result as
pending. A later semantic query, source query, or chart is rejected until a
validated observation references that immediately preceding result. Final-answer
finalization remains available after a single result, so the guard guarantees
ordering between analytical artifacts without forcing redundant prose before a
concise answer.

The visible narrative is therefore an audited execution trace, not private
model reasoning. Raw tool arguments, prompts, provider payloads, compiled SQL,
and chain of thought remain unavailable to the client.

## Consequences

- Users see the intended table-to-observation-to-next-analysis rhythm without
  weakening numerical grounding.
- Unsupported figures are blocked before a narrative trace event is persisted
  or delivered.
- Adding a new continuation requires a reviewed contract and server-owned copy;
  models cannot introduce arbitrary next-step prose.
- Prompt compliance is not the ordering boundary: a server-side gate prevents a
  second analytical artifact from skipping the pending observation.
- The application may evolve presentation and animation independently of the
  analytical trust boundary because trace events retain the existing sanitized
  narrative shape.

## Verification

Contract tests exercise a real streamed Agents SDK loop with two governed
queries and assert the ordered `table → observation → query → table` trace. They
also prove that an unsupported figure and a free-form continuation are rejected.
