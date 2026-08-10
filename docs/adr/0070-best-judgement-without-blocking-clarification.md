# 0070. Current analytical turns use disclosed best judgement instead of clarification

Date: 2026-08-09

## Status

Accepted. Supersedes ADR 0069's decision to retain pre-agent routes for
material metric ambiguities and the clarification outcomes in ADR 0044 for
new analytical turns. Historical clarification artifacts and confirmation
receipts remain readable; unavailable-source and directory routes are unchanged.

## Context

Clarification interrupted analysis before Albert had gathered evidence and
required another owner turn before any useful result could appear. Questions
such as “performed best” and “profit” have multiple legitimate definitions,
but a capable analyst can normally select the standard operational reading
from the wording, connected source and business context. Asking the owner to
choose methodology added round-trip latency and shifted analytical judgement
back to the user.

## Decision

New analytical turns never expose `ask_user` and cannot emit the
`Clarification` answer state. The primary analyst must:

1. choose the most defensible standard operational interpretation;
2. state the chosen metric, period, population or entity assumption briefly;
3. compare two readings in one answer when both are material and cheaply
   answerable; and
4. remain honestly `Unavailable` only when the connected evidence cannot
   observe the requested concept, not merely because wording is ambiguous.

The deterministic current-turn router no longer intercepts generic profit or
employee-performance wording. A legacy intent plan with disposition
`clarification`, including a historical case id, is normalised to `answer`
before route selection. The current-turn structured output schema excludes
`Clarification`, providing a server-enforced backstop even if a model attempts
to return it.

This policy does not delete the shared historical state, persisted artifacts,
or one-use preference-confirmation records. They remain part of the backward-
compatible storage and rendering contract, but they are not reachable from a
new primary analytical run.

## Consequences

- Owners receive an evidence-backed answer in one turn instead of a blocking
  methodology question followed by a second analytical turn.
- Albert must disclose its assumptions clearly enough for the owner to judge
  the interpretation without being asked to configure it first.
- Some answers may use a different defensible reading than an owner had in
  mind; concise basis disclosure and optional non-blocking follow-ups make the
  choice visible.
- Genuine source absence, privacy restrictions and unsupported observations
  continue to fail closed as `Unavailable`.
