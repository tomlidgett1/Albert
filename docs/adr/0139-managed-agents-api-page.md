# ADR 0139: Separate managed Agents API page

- Date: 2026-09-11
- Status: implementation accepted; live-data activation requires owner approval
- Extends: ADRs 0001, 0110 and 0135

## Decision

`/newagent` is a separate authenticated page using the existing view2 layout,
theme tokens, controls, trace renderer and conversation store. It always sends
analysis to `/api/newagent-conversation`. URL runtime overrides, new-chat actions
and dashboard requests cannot switch this page to Omni. Only OpenAI Luna,
Terra and Sol are offered; the initial profile is Luna, High, standard speed.

The new endpoint uses the public beta OpenAI Agents API, released September 2026,
through the official OpenAI JavaScript SDK 7.15.0 and `beta.agents.sessions`.
OpenAI owns orchestration, context compaction and recovery. The Omni Runner is
never instantiated for this path. The existing analytical implementation exposes
an orchestration interface so both harnesses share the same validated function
tools, Cube queries, result semantics, derived-table rules and answer composition.
The existing Omni endpoint and defaults retain their previous behavior.

Albert supplies application function tools with `environment: none`. The model
receives neither Cube credentials nor database credentials, and has no shell,
unrestricted HTTP client or write-back tool. Server-authenticated tenant/role/turn
claims authorize every Cube request. Query records and ordered, sanitized trace
events remain in the control plane. Provider reasoning is never forwarded to the
browser. Only an accepted, evidence-bound composition can become the answer.

Each Albert turn owns one temporary provider session. Repair prompts continue
within that session. Later user turns rebuild bounded conversation context from
Albert's authenticated store, including prior governed results. Stream recovery
reconnects to the same provider session and checks saved turn outcomes and items;
idle is not success. Tool results are cached by turn/call ID, and recovery checks
current required actions before resubmission. Stop/disconnect cancels work.
Every exit attempts cancellation where needed and session deletion, with failures
logged explicitly. A Vercel process loss can still prevent final cleanup; the beta
must not be represented as offering zero retention.

The endpoint executes on Vercel alongside the web application, using the existing
Sydney control plane and Fly Cube service. No new database or Fly service is
needed, and no migrations are introduced.

## Data controls

[OpenAI's Agents API documentation](https://developers.openai.com/api/docs/guides/agents-api/overview)
states that this beta supports US residency only and is not eligible for Zero Data
Retention. This is materially different from ADR 0001's AU endpoint posture.
The new endpoint fails closed unless `ALBERT_AGENTS_API_DATA_CONTROL_APPROVED=true`.
The owner was asked to approve this exception specifically for the new page;
until approval is recorded, all live model tests use synthetic fixtures only.
The existing `OPENAI_BASE_URL` and all other product runtimes are unaffected.

## Verification

- Provider tests exercise real session creation, application tool calls,
  in-session follow-ups and cleanup using synthetic values.
- Deterministic transport tests cover stale actions, disconnected streams,
  root-turn failure, reasoning exclusion and cancellation before deletion.
- Analytical tests use the real managed API with an independently checked,
  synthetic Cube fixture and require every cited value to resolve to a result cell.
- Browser tests use the production Next.js build, the view2 layout, light/dark/
  system themes, a narrow canvas, follow-ups, new-chat reset and the auth boundary.
- Existing Omni regressions and deployment checks protect the shared tools.

References: [quickstart](https://developers.openai.com/api/docs/guides/agents-api/quickstart),
[function tools](https://developers.openai.com/api/docs/guides/agents-api/tools/functions),
[events and recovery](https://developers.openai.com/api/docs/guides/agents-api/sessions/events).
