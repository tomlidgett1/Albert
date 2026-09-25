# ADR 0121: subscription-backed local Codex evaluation

- Status: accepted for local evaluation only
- Date: 2026-08-24
- Owners: product and platform
- Extends: ADR 0110
- Does not modify: production Codex authentication, V3 runtime, or the sealed
  Semantic V2 release qualification in ADR 0077

## Context

Albert's isolated Codex runtime already evaluates the official Codex harness,
but ADR 0110 originally required every app-server process to authenticate with
an OpenAI API key in a fresh turn-local Codex home. That is the correct
production identity and AU-endpoint boundary, but it makes large local
development batteries incur API charges even when the operator has eligible
Codex subscription capacity.

OpenAI documents ChatGPT-managed app-server authentication as a first-class
mode: Codex owns the OAuth flow, persistence, and refresh. OpenAI also documents
Fast mode for ChatGPT-authenticated GPT-5.6 sessions. Local subscription-backed
evaluation can therefore exercise the same pinned app-server protocol without
turning a personal OAuth credential into an Albert secret or provider token.

The sealed V2 qualification remains a different contract. It uses Luna at Max
with Standard processing and must reproduce the reviewed production provider
boundary. Subscription-backed Fast runs are development evidence only.

## Decision

The Codex runtime accepts an explicit, discriminated authentication mode:

- `api` remains the default and the only mode accepted when `NODE_ENV` is
  `production`. It requires `OPENAI_API_KEY` and the approved
  `OPENAI_BASE_URL`, logs into a fresh private Codex home for each turn, and
  retains ADR 0110's production behavior.
- `chatgpt` is accepted only outside production. It uses
  `ALBERT_CODEX_CHATGPT_HOME`, then an existing `CODEX_HOME`, then the normal
  Codex home as its state location. Albert never reads, copies, serializes, or
  logs the OAuth material. The pinned Codex executable performs a non-secret
  `login status` preflight and owns token refresh.

There is no fallback between modes. The ChatGPT mode contains neither an API
key nor an API base URL, forces Codex's `chatgpt` login method, and fails before
starting a model turn if the subscription login is unavailable. The runtime
readiness response discloses only `authenticationMode`, allowing the eval
runner to reject an accidentally API-backed service before the first case.
The subscription runtime also binds to `127.0.0.1` only; configuration that
would expose a personal ChatGPT-authenticated runtime on a non-loopback listener
is rejected.

If the authenticated home contributes a global `AGENTS.md`, local evaluation
accepts it only through a reviewed path-and-SHA-256 allowlist. Any byte change
or any additional instruction source fails closed. This preserves the normal
home-owned subscription session without silently accepting mutable prompt
material.

Desktop-managed homes may also contribute the built-in `openaiDeveloperDocs`
and `node_repl` MCP entries above the ordinary user MCP table. Subscription
evaluation explicitly disables both by name in addition to clearing the MCP
table; any remaining MCP startup notification still terminates the turn.

Where the execution sandbox prohibits loopback sockets, the eval runner may use
an in-process transport. That transport calls the same
`runCodexSemanticTurn` entry point and the same isolated app-server process;
it omits only the local HTTP/HMAC hop. It is restricted to ChatGPT auth and
performs the same pinned-version and non-secret login-status preflight before
the first turn.

Subscription app-server processes keep ADR 0110's temporary empty working
directory, ephemeral threads, disabled history, no repository mount, no
runtime workspace roots, no networked tools, no shell, no browser, no MCP, and
no inherited Albert credentials. The persistent Codex home is used only for
Codex-owned authentication and refresh. Codex's separate `sqlite_home` and log
directory are redirected into the private turn-local workspace and deleted at
teardown; analytical rollout persistence remains disabled.

The subscription evaluation profile is `gpt-5.6-luna`, Max effort, and Fast
processing. Fast is asserted both in the app-server feature configuration and
on each app-server turn. Run artifacts record model, effort, speed, and auth
mode. The 300-case development corpus may include V3 regression questions, but
it does not replace or relabel the locked 200-execution V2 release corpus.

Two optional post-model phases in the production Codex runtime—the independent
sufficiency review and long-answer editor—call the OpenAI Responses API
directly. They are API-auth-only. Subscription-backed runs skip them instead
of silently charging an API account. Deterministic brief sufficiency, governed
evidence validation, candidate repair on the live Codex thread, grounding,
format validation, and evidence recovery remain active.

Subjective eval grading must also use the local ChatGPT-authenticated Codex
harness or deterministic graders. The existing Anthropic/OpenAI API grader is
not part of a subscription-only run.

## Consequences

- Large local eval batteries consume ChatGPT/Codex allowance and credits rather
  than OpenAI API spend. Fast GPT-5.6 consumption is intentionally higher than
  Standard and is visible in the operator's Codex usage limits.
- Development runs are reproducible at the harness, model, effort, speed,
  corpus, semantic data, and code-revision levels, but they are not production
  endpoint or billing-parity evidence.
- A personal subscription identity can never be deployed to Fly or accepted as
  a production service identity.
- Subscription quota exhaustion is a resumable eval condition, not permission
  to fall back to API billing.
