# 0145 — GPT-6 on OpenAI's global host

Date: 2026-09-23. Status: implemented and deployed the same day. Amends
ADR 0001's rule that every OpenAI call uses the Australian endpoint.

## Why

OpenAI released GPT-6 Sol and GPT-6 Luna on 2026-09-22 (US time), after
GPT-6 Astra. The owner asked for every GPT-5.6 model to move to GPT-6, in
Albert and in Yellow Jersey's Analytics tab (ADR 0144), which runs Albert's
Omni harness.

GPT-6 is not served from OpenAI's Australian data-residency endpoint. With the
production key, the same minimal request (verified 2026-09-23) returns:

| Host | gpt-5.6-luna | gpt-6-luna |
| --- | --- | --- |
| `au.api.openai.com` | reaches the model | `401 incorrect_hostname`: "make your request to api.openai.com" |
| `api.openai.com` | reaches the model | reaches the model |

OpenAI's model pages list EU data residency (Standard processing only) and no
Australian option. ADR 0001 already records that the AU endpoint gives
regional *storage* of eligible API state, not regional *processing*; Albert
sends `store: false`, so what changes on the global host is where OpenAI's
retained request data lives, not where the model runs.

## Decision

**GPT-6 runs on OpenAI's global host under an explicit cross-border approval,
the same bar Claude clears.** Claude already processes Albert's production
data outside Australia, gated by `ALBERT_ANTHROPIC_APP8_APPROVED` (APP 8) and
`ALBERT_ANTHROPIC_ZDR_APPROVED`. GPT-6 gets its own flag,
`ALBERT_OPENAI_GLOBAL_APP8_APPROVED`, set on the web (Vercel) and the runtime
(Fly). OpenAI's data controls (`ALBERT_MODEL_DATA_CONTROL_APPROVED`) are
project-wide, so they already cover the global host.

- `packages/shared/src/agent-runtime.ts`: GPT-6 Astra, Sol and Luna join the
  registry. `openAiModelRequiresGlobalHost()` names them.
  `resolveAlbertModelTransport()` sends them to `OPENAI_GLOBAL_API_BASE_URL`
  only when the caller passes `openaiGlobalApproved`; without it they are
  refused outright, never rerouted to the regional host. GPT-5.6 keeps the
  configured (AU) `OPENAI_BASE_URL`, so the ADR 0001 boundary checks
  (`production-boundary.ts`, `env.ts`, `release-preflight.mjs`) are
  unchanged.
- `services/codex-runtime/src/config.ts`: `globalApproved` on the Omni and
  OAI Codex OpenAI credentials: always in development, only with the flag in
  production. `http.ts` refuses an unapproved GPT-6 job with 503 before a job
  exists, and points the OAI Codex driver at the global host for GPT-6.
- `app/api/omni-conversation/harness-route.ts`: the same production gate as
  Claude's, before any turn starts.
- Effort: GPT-6 Astra rejects `none` (`low`, `medium`, `high`, `xhigh`,
  `max` only); Sol and Luna accept all six. `clampReasoningEffort` maps
  Astra's `none` to `low`. `fast` and `priority` service tiers are accepted by
  all three, as is Albert's `reasoning.context` / `reasoning.mode` shape.
- Pickers: Omni and OAI Codex offer GPT-6 Luna, Sol and Astra (plus Claude on
  Omni); the OAI Codex default is GPT-6 Luna. The picker discloses that GPT-6
  data is not held in Australia, as it already does for Claude.
- GPT-5.6 is **retired, not removed**: still admitted on the regional host so
  stored preferences, the comparison views and the hidden legacy runtimes
  (Codex CLI, v3, swarm, Xero MCP) keep working, and past turns keep their
  labels. Reopening an older Omni analysis moves its follow-ups up a
  generation, tier for tier (`currentGptModel`): 5.6 Sol → 6 Astra, 5.6 Terra
  → 6 Sol, 5.6 Luna → 6 Luna.
- `packages/usage-metering`: `OPENAI_GPT_6_RATE_CARD` (Astra $10 / $1 cached /
  $50; Sol $2 / $0.20 / $10; Luna $0.10 / $0.01 / $0.50 per 1M tokens; cache
  writes 1.25x input; Fast 2x; over 272K input tokens 2x input and 1.5x
  output) with no regional uplift.

The control-plane usage ledger and the four metering/finalization functions
still admit only GPT-5.6, Grok and Claude. That is deliberate for now: those
guards belong to the legacy runtimes' metering, which cannot reach GPT-6
(their pickers do not list it and their transport carries no approval), while
Omni logs usage without writing the ledger. A runtime that starts metering
GPT-6 must add it there first, as 0156 did for Haiku.

## Consequences

- An Omni or OAI Codex turn on GPT-6 sends the question, the governed tool
  results and the answer draft to OpenAI's global service. The picker says so.
- To return to Australian-only OpenAI processing, unset
  `ALBERT_OPENAI_GLOBAL_APP8_APPROVED` on Vercel and Fly: GPT-6 turns then
  fail closed with "GPT 6 models are not approved for production data on this
  Albert environment", and GPT-5.6 remains available to clients that ask for
  it.
- If OpenAI later serves GPT-6 from `au.api.openai.com`,
  `openAiModelRequiresGlobalHost()` is the one switch to flip.
