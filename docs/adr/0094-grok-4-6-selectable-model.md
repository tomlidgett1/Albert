# 0094. Grok 4.6 as a selectable Albert model

Date: 2026-08-13

## Status

Accepted. Extends ADR 0001's model catalogue. Does not replace the OpenAI
runtime, AU OpenAI residency pin, or the public trace contract.

## Context

Albert's owner-facing selector currently exposes GPT 5.6 Sol, Terra and Luna
with user-selectable reasoning effort. The product now also needs official
Grok 4.6, including its reasoning levels, without dropping those GPT profiles.

xAI documents Grok 4.6 as model `grok-4.6` on the Responses API at
`https://api.x.ai/v1`. Reasoning is controlled with `reasoning.effort` of
`low`, `medium`, `high` (default) or `xhigh`. Reasoning cannot be disabled.
`store: false` opts out of xAI's 30-day server-side storage. Albert Fast mode
on Grok maps to official xAI Priority Processing (`service_tier: "priority"`,
2x token rates). It is not OpenAI's `service_tier: "fast"`.

xAI does not offer an Australian inference geography. GPT turns stay on the
approved AU OpenAI endpoint.

## Decision

- Add `grok-4.6` to the server-owned Albert model allowlist and the dash
  selector. Existing GPT profiles remain selectable and default.
- Route only Grok-selected turns to xAI with `XAI_API_KEY` and
  `https://api.x.ai/v1`. Never send the OpenAI key to xAI or the xAI key to
  OpenAI.
- Clamp Grok effort: `none` → `low`, `max` → `xhigh`. Fast on Grok sends
  `service_tier: "priority"`; Fast on GPT still sends `fast`.
- Send `store: false`. Never put private reasoning, encrypted thinking, or
  raw provider payloads in the public trace.
- `XAI_API_KEY` is optional at boot. Selecting Grok without it fails closed.
- Owner-selected Grok turns are US-processed. GPT production traffic remains
  AU-pinned.

## Consequences

Grok can be used from the same selector as GPT 5.6. APP 8 disclosure for
xAI US processing is an operational requirement for customer use of Grok.
Encrypted reasoning may travel on the xAI wire for tool-loop continuity and
must never be rendered.

## References

- https://docs.x.ai/developers/grok-4-6
- https://docs.x.ai/developers/model-capabilities/text/reasoning
- https://docs.x.ai/developers/advanced-api-usage/priority-processing
