# ADR 0124: Codex GPT-5.6 Pro reasoning mode

- Status: accepted
- Date: 2026-08-24
- Extends: ADRs 0110, 0121, 0122 and 0123
- Supersedes: ADR 0001's Pro-mode UI evaluation gate for the isolated Codex runtime only

## Context

OpenAI's GPT-5.6 documentation defines Pro as a Responses API execution mode,
not a model slug and not a reasoning-effort level. A request keeps its selected
GPT-5.6 model and independently sets `reasoning.mode: "pro"` alongside any
supported `reasoning.effort`. Pro performs more model work and can improve
reliability on difficult tasks, with higher latency and token usage.

The pinned Codex app-server protocol does not yet expose `reasoning.mode` in
`turn/start`. Its generated protocol schema exposes model, effort, summary and
service tier only. Sending an invented app-server field would therefore be an
unverifiable no-op.

Official references:

- https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode
- https://developers.openai.com/api/docs/guides/latest-model

## Decision

The main Codex run-settings popover exposes an independent `Pro reasoning`
switch. It defaults off and is not exposed by Albert V3, Compare, Swarm, or
other runtimes. The selected GPT-5.6 model, effort, and Fast processing choice
remain unchanged.

When Pro is enabled, the API-authenticated Codex runtime starts a loopback-only
HTTP adapter for the lifetime of each ephemeral app-server run. Codex continues
to own its thread, tool loop, repairs and structured output. The adapter changes
only outgoing `/responses` JSON by merging `mode: "pro"` into the existing
`reasoning` object, preserving effort and all other request fields, then streams
the provider response back unchanged. It forwards to the configured OpenAI base
URL, so production continues to use the approved AU endpoint.

The adapter binds to `127.0.0.1`, accepts bounded request bodies, never logs
headers, bodies or credentials, and is closed with the app-server session.
Pro mode is unavailable for local ChatGPT-subscription authentication because
OpenAI documents it as a Responses API request feature; those runs fail with a
specific public error rather than silently running standard mode.

The setting applies to both the optional Sol planning preflight and the
owner-selected Codex investigation when both switches are enabled.

## Consequences

- Albert sends the exact documented GPT-5.6 Pro parameter without inventing a
  `gpt-5.6-pro` model id or overloading reasoning effort.
- Pro can be combined independently with Luna, Terra or Sol, any supported
  effort, and the existing Fast processing selection.
- Enabled turns may be materially slower and use more billed output/reasoning
  tokens; the UI discloses this and keeps the mode opt-in.
- The adapter can be removed once the pinned Codex app-server protocol exposes
  a first-class reasoning-mode field and that field is contract-tested.
