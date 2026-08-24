# ADR 0125: public reasoning summaries in Detailed mode

- Status: accepted
- Date: 2026-08-24
- Extends: ADRs 0001, 0110 and 0112

## Context

Detailed mode already shows Albert's plan, governed queries, evidence,
validation and owner-facing commentary. The owner also wants visibility into
how the selected model is approaching the analysis.

OpenAI does not expose raw reasoning tokens for GPT-5.6. The supported public
surface is an explicitly requested reasoning summary (`reasoning.summary`),
including `response.reasoning_summary_text.delta` streaming events. A reasoning
summary is model-authored explanatory output; it is not the model's private
chain-of-thought.

Official reference:

- https://developers.openai.com/api/docs/guides/reasoning#reasoning-summaries

## Decision

Codex continues to request a concise reasoning summary from app-server. Albert
consumes only `item/reasoning/summaryTextDelta` and completed reasoning-summary
items. It never consumes or forwards `item/reasoning/textDelta`, raw reasoning
content, encrypted reasoning, prompts, or provider payloads.

The runtime accumulates bounded summary parts and emits at most twelve
sanitized snapshots through the existing durable narrative event, marked with
`purpose: "reasoning_summary"`. Before publication, every snapshot:

- rejects prompt, instruction, credential, tool, schema, SQL, result-id and
  raw-reasoning language;
- rejects figures that are not already grounded in governed evidence;
- is bounded to six sentences and 1,200 visible characters; and
- contains no provider item or turn identifiers.

Detailed mode renders the latest snapshot under the explicit label “Reasoning
summary”. Earlier snapshots replace one another in the view. Compact mode does
not treat these snapshots as live commentary and does not show them. Because
the summary is stored in the normal trace, turning Detailed mode on after a
turn finishes still reveals the latest safe summary.

## Consequences

- Owners get useful transparency into the analytical approach without
  exposing private chain-of-thought or hidden instructions.
- Streaming remains bounded and durable rather than persisting every token.
- A summary sentence can disappear when it contains internal mechanics or an
  ungrounded figure; the plan and evidence trail remain the authoritative
  explanation in that case.
