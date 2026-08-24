# ADR 0123: optional Sol planning preflight for Codex

- Status: accepted
- Date: 2026-08-24
- Extends: ADRs 0110, 0114, 0121 and 0122

## Context

The Codex analytical turn currently asks the owner-selected model to both
decompose a question and investigate it. Hard multi-part questions can benefit
from a stronger first-pass decomposition while the owner still needs control
over the model that performs the governed investigation and writes the answer.

## Decision

The main Codex composer exposes a `Sol · Max planner` switch. It defaults on
for new Codex chats and can be turned off for subsequent questions. Albert V3,
Compare, Swarm, and other runtimes do not expose or consume this control.

When enabled for a substantive analytical Codex turn:

1. A separate ephemeral Codex app-server run uses `gpt-5.6-sol` at `max`
   reasoning effort. It has no dynamic tools and may return only a bounded
   two-to-six-step checklist.
2. Trusted code validates and sanitizes that checklist as an untrusted hint;
   it is not evidence, is not persisted in the public trace, and cannot alter
   tenant scope, semantic tools, or answer validation.
3. The owner-selected Codex model then receives the checklist and runs the
   existing governed Cube investigation, grounding, repair, and presentation
   pipeline. Its selected model and effort remain authoritative for the
   analytical answer.

The preflight has a 90-second cap inside the existing 12-minute turn deadline.
If it times out, returns invalid output, or is unavailable, the selected model
continues independently. The feature bypasses deterministic recipe shortcuts
so an enabled question still reaches the selected model after the preflight;
social and trusted conversational fast paths remain unchanged.

## Consequences

- Difficult Codex questions get a stronger decomposition without changing the
  answer model selected by the owner.
- Enabled turns add a bounded Sol call and therefore may cost more and take
  longer; the UI explains the two-pass behavior and permits disabling it.
- The planner never receives Cube tools or business credentials, and all
  business figures remain subject to the existing governed evidence contract.
