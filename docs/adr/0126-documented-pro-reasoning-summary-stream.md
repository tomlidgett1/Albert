# ADR 0126: documented Pro reasoning-summary stream

- Status: accepted
- Date: 2026-08-25
- Depends on: ADR 0001, ADR 0110, ADR 0124

## Context

The owner wants a live account of what a long Codex analysis is doing. OpenAI's
Responses API exposes public reasoning summaries through
`response.reasoning_summary_text.delta` and `.done`. It separately exposes raw
reasoning-text event types, but private chain-of-thought is not an Albert
product contract and cannot become the audit record required by ADR 0001.

Codex app-server notifications are sufficient for standard runs, but the Pro
adapter already owns the exact Responses byte stream and is the authoritative
place to observe Pro summary events. Relying only on an app-server translation
made the Pro summary UI appear empty when that translation was absent or used
the documented structured completion shape instead of a string.

## Decision

1. Codex requests `reasoning.summary = "detailed"` for owner-visible public
   summaries. Luna remains the selected analytical model and effort remains an
   independent setting.
2. The loopback Pro adapter continues to forward provider bytes unchanged, and
   additionally parses only the documented reasoning-summary delta/done SSE
   events. It never parses, persists, or forwards raw reasoning-text events.
3. Pro runs prefer this direct Responses summary stream. Standard runs retain
   Codex app-server summary notifications. Completed app-server reasoning items
   accept both legacy strings and documented `{ type: "summary_text", text }`
   parts.
4. Every public summary still passes Albert's grounding and internal-mechanics
   gate before becoming a `reasoning_summary` trace event. Albert's separate
   evidence commentary remains the audited “what I found / what I will check
   next” channel.
5. Pro acceptance remains independently verified by a successful provider
   response carrying `reasoning.mode = "pro"`; a summary event is not proof of
   Pro mode by itself.

## Consequences

- The Reasoning panel can update during a Pro response without exposing private
  chain-of-thought.
- Provider summary wording is informative UI, not deterministic evidence.
  Figures still require governed result cells and claim validation.
- Tests prove summary events are extracted while raw reasoning text remains only
  in the untouched provider stream consumed by Codex itself.
