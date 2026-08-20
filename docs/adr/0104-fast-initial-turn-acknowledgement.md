# ADR 0104: Fast initial turn acknowledgement

- Status: Accepted (implemented 2026-08-19)
- Date: 2026-08-19
- Complements: ADR 0001 (OpenAI runtime), ADR 0094 (selectable Grok), ADR 0103 (truthful plan lifecycle)

## Context

Albert's V3 stream previously showed only a generic planning animation until
intent classification or analytical planning produced its first trace event.
Even when the eventual answer was strong, the owner received no immediate,
request-specific confirmation that Albert had understood the work.

The acknowledgement cannot be part of the governed answer. At that point no
query evidence exists, the terminal answer state is unknown, and the owner's
selected analytical model must retain control of the substantive turn. A free
model-authored sentence would also create a pre-evidence path for invented
figures or conclusions.

## Decision

Every substantive V3 turn starts one bounded auxiliary OpenAI Responses call
after the durable turn is created and alongside the independent context reads.
The call is pinned to:

- `gpt-5.6-luna`;
- `reasoning.effort: "high"`;
- `service_tier: "fast"`;
- `store: false`, low text verbosity, no tools, no retries, and a four-second
  client timeout;
- a stable privacy-preserving safety identifier derived from the tenant and
  actor ids;
- the configured OpenAI base URL, including the production AU endpoint.

The model returns structured data only: an allowlisted action (`lookup`,
`compare`, `investigate`, `explain`, or `present`) and a short noun phrase. The
phrase is length-, character-, pronoun-, number-, and unsafe-vocabulary-checked.
Trusted code renders the owner-facing sentence from a fixed template. It can
say what Albert will do but cannot state a result, amount, date, percentage,
source claim, or completed action.

The rendered sentence is the turn's first ordinary `narrative` trace event,
tagged with `purpose: "acknowledgement"`. It therefore uses the existing
sanitisation, contiguous ordering, immutable event persistence, SSE transport,
restore, and audit contracts. The dashboard separates it from evidence-backed
commentary and renders it in a dedicated slot immediately above the Planning
indicator, before a plan exists.

Deterministically detected greetings, thanks, acknowledgements, and farewells
skip the auxiliary call. A timeout, provider failure, malformed structured
output, unsafe focus, or disconnected client drops the acknowledgement and
releases the normal V3 turn unchanged. The call never selects a lane, creates
evidence, influences validation, changes the selected answer model, or changes
terminal-state eligibility.

## Usage and observability

The auxiliary response id, effective service tier, token counts, duration,
tenant, conversation, and turn are recorded in structured service logs without
logging the question or acknowledgement text. The existing one-row-per-turn
usage ledger remains the receipt for the selected analytical runtime; it cannot
represent a second model and service tier without changing its historical
contract. Provider billing remains the financial reconciliation authority.

## Consequences

- The owner normally sees a specific acknowledgement while the slower V3 work
  is still beginning.
- The substantive answer keeps its selected provider, reasoning effort, Fast
  preference, evidence boundary, and model-usage receipt.
- The additional request adds a small fixed latency/cost workload, bounded by
  Luna, structured output, no retries, and the short timeout.
- OpenAI receives the initial question for this auxiliary purpose even when a
  non-OpenAI model is selected for the analytical answer, matching the existing
  OpenAI conversation-title auxiliary path; `store: false` and the configured
  regional endpoint remain mandatory.
