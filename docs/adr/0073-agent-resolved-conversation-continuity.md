# 0073. Agent-resolved conversation continuity and terminal answer integrity

Date: 2026-08-09

## Status

Accepted. Extends ADR 0072 without introducing phrase-specific routing or a
deterministic business-answer planner.

## Context

Albert could correctly interpret an anaphoric follow-up, execute several useful
queries and discover that an earlier answer was incomplete, then discard the
supported answer at the final safety boundary. The final-output model declared
a customer scope, but the raw-SQL path did not produce the structured filter
evidence used by the scope guard. The guard treated that metadata mismatch as a
business-data failure and replaced the answer with an unrelated request to map
the customer to a product or location dimension.

The same trace exposed two broader defects. Complexity routing considered only
the current message, so a short confirmation follow-up paid for a full standard
analysis. Conversation history persisted prose but not the model's resolved
subject. Finally, intermediate query tables were treated as owner presentation
rather than research evidence, producing needlessly large responses.

Adding names, pronouns or question templates to a routing list would only hide
known examples. The model is responsible for language interpretation; trusted
software is responsible for preserving that interpretation and attesting the
evidence actually executed.

## Decision

When a turn has prior conversation context, a bounded tool-less interpretation
agent resolves the current request into a standalone question, a subject and an
execution lane. It receives the bounded conversation transcript and the latest
persisted subject, and returns structured output. Trusted code applies the
corresponding fixed execution ceiling but does not reproduce the interpretation
with phrase lists. The lead analyst still owns all business reasoning and the
final answer.

The resolved subject is persisted on the terminal answer event and recovered by
`albert_model_context` on the next turn. It contains a concise subject label,
kind and standalone question, not hidden reasoning or an asserted business
fact. Rewinds inherit the existing answer-artifact boundary, so hidden turns do
not leak their subjects into later context.

Every executed raw-SQL query receives a server-derived scope receipt. The
semantic service tokenises the statement that actually ran and records its
relations and literal predicates, together with bounded distinct values from
the returned columns. The receipt is returned separately from model-authored
scope metadata and copied into the immutable query audit. It is evidence about
query scope, not permission to certify a metric.

A mismatch between the model's declared scope and the available receipts is
non-destructive. It qualifies the answer and becomes an input to final review;
it never replaces supported prose with a generic Unavailable response.

After server grounding, answer-state enforcement, owner-language cleanup and
provenance disclosure, a tool-less relevance reviewer checks the complete
narrative against the original question, the resolved standalone question, the
persisted subject, governed results and scope receipts. A material mismatch may
trigger one bounded answer-only repair, followed by a final review. The reviewer
cannot query data or weaken grounding. If repair is unavailable, Albert retains
the strongest already-grounded answer and exposes the qualification rather than
inventing a new refusal. If the single repaired answer still receives an
adverse terminal verdict, Albert keeps its supported findings, lowers a
Verified state to Qualified, and stops; there is no destructive or recursive
repair loop.

Query tables remain immutable evidence artifacts. They appear in the owner
response only when the lead analyst explicitly selects their result identifiers
for presentation or a chart references them. The server no longer appends a
table merely because one result happened to be tabular.

## Consequences

- Language resolution remains model-owned and generalises beyond known names or
  pronouns.
- Follow-ups retain a durable subject across processes and deployments.
- Raw-SQL scope checks are based on the executed statement and returned result,
  not solely on model-authored declarations.
- Safety checks cannot erase independently supported findings.
- A final answer cannot leave the service without a question-relevance check
  after server-owned transformations.
- Concise answers are the default; tables and charts remain available when they
  materially improve the response.
- The interpretation and terminal-review calls add bounded model cost to
  contextual and analytical turns. Lane-level evaluation must measure whether
  their correctness gain justifies that cost.
