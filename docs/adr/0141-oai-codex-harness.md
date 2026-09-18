# 0141 — OAI Codex: Omni's tools on OpenAI's managed Codex harness

Date: 2026-09-18. Status: implemented; deployed to the agent runtime (Fly)
and the web tier (Vercel) on the same day.

The owner asked for a net-new harness built on the Agents API OpenAI
released in public beta on 2026-09-10, selectable from the chat, with a
split view that runs it against Omni on the same prompt. This ADR records
what was built and the decisions that shape it.

## What the Agents API is

`POST /v1/agents/sessions` (header `OpenAI-Beta: agents=v1`) creates a
managed session: OpenAI runs the agent loop that powers Codex — context
compaction, retries, tool orchestration, optional sandboxes and subagents —
and the application only exchanges events with it. A session streams
`agent.session.*` events; the application answers `function_call` items with
`agent.session.input.tool_result` events, continues a conversation with
`agent.session.input.message`, and stops with `agent.session.input.cancel`.
A conversation-only session (`environment: { type: "none" }`) must be
created with its first input and streams that turn immediately; later turns
subscribe to `GET …/events` before posting input. Function-call arguments
arrive as JSON objects, assistant messages carry a `phase` (`commentary` or
`final_answer`), and turn usage is attached shortly after the terminal event.

## Design

**One turn, two loops.** `runOmniSemanticTurn` already owned the governed
tools, the evidence registry, the answer contract (`ComposeAnswer`), the
checkpoint and the trace. The change introduces a *driver* seam
(`packages/albert-omni/src/driver.ts`): the in-process `@openai/agents`
Runner became the default driver, and the OAI Codex harness
(`packages/albert-oai-codex/`) supplies a driver backed by the Agents API.
Both receive identical instructions, the identical tool set (as SDK function
tools whose JSON schemas and `invoke` are reused directly) and the identical
nudges, so a side-by-side comparison measures the harness, not the tools.

**Turn shape.** The driver creates a session with the analyst instructions
appended to the harness's own base instructions, the ten governed function
tools, `environment: none`, `multi_agent` off, the selected reasoning effort
and service tier, and metadata naming the tenant, conversation and turn. The
prior conversation is folded into the first input (the API accepts user
messages only). Function calls are executed concurrently through the SDK
tool's `invoke` (argument validation and error replies included) and
answered with idempotent `tool_result` events, retrying the documented
"unknown pending tool call" registration gap. Commentary messages are
narrated live; the answer is everything said after the last successful tool
result, exactly as Omni computes it. Nudges (tool markup, missing
`ComposeAnswer`, missing dashboard plan) are follow-up turns on the same
session. Cancelling Albert's turn posts a cancel to the managed turn.

**Transport.** A small fetch-based client with its own SSE reader talks to
the beta surface; the pinned `openai` package the other harnesses use is
untouched. The base URL follows `OPENAI_BASE_URL` (the AU host accepts the
beta) unless `ALBERT_OAI_CODEX_BASE_URL` pins it.

**Failure and recovery.** Turn failures carry the API's stable category
(`server_overloaded`, `rate_limit_exceeded`, `context_length_exceeded`, …);
the transient ones join Omni's retry ladder, the rest map to the existing
public failure codes. The checkpoint records the session identity; a runtime
restart re-attaches to a waiting or running session, reads the answer of a
session that finished while Albert was away, or starts afresh.

**Data handling.** The managed harness stores every session item on OpenAI's
side and offers no zero-data-retention mode, unlike Omni's `store: false`
Responses calls. The driver therefore deletes each session after the turn
(`ALBERT_OAI_CODEX_RETAIN_SESSIONS=true` keeps them for debugging). Whether
the AU host keeps beta session data in-region is not documented by OpenAI
and should be confirmed before the harness serves customer tenants beyond
the owner's own.

**Models.** The managed harness runs OpenAI models only: GPT-5.6 Luna, Terra
and Sol. `gpt-6-astra` (the model in OpenAI's examples) is available to the
organisation but is not in Albert's model registry yet.

## Surfaces

- Runtime service: `OmniServiceTurn.harness` (`"omni"` | `"oai-codex"`,
  optional so older callers are unaffected; the runtime deploys first).
  `/v1/omni/readyz` attests `harnesses`. Job logs carry `harness`.
- Web: `app/api/oai-codex-conversation/route.ts` shares
  `handleOmniHarnessConversation` with the Omni route; the conversation is
  runtime-locked as `oai-codex-agent` / `cube-oai-codex-v1` and the stream
  answers `X-Albert-Runtime: oai_codex`.
- Dash: a harness selector (Omni · OAI Codex · Compare) in the chat header;
  the OAI Codex chat reuses the Omni trail, composer and model controls
  (OpenAI models only). Compare opens Omni against OAI Codex by default,
  either pane can be switched to Albert or Codex while idle, and the
  original engine comparison stays reachable at `?runtime=compare`.
- Eval: `scripts/albert-eval/run-omni.mts --harness oai-codex`.

## Integration note

Production was found to run `codex/newagent-agents-api` (ADR 0139's
`/newagent` page, ADR 0140's native mode) while the main checkout was fifteen
commits behind it. The mainline was rebased onto that branch before this
harness deployed, so the `/newagent` page, the recommendations work and the
later Omni fixes all remain in production. The managed harness of ADR 0139
now plugs into the same driver seam as OAI Codex; its behaviour is unchanged.

## Observations from the first live turns

Two defects surfaced only against the live API and are fixed in this ADR's
follow-up commits: turn usage is attached a few seconds after the terminal
event (fetched at session idle, with one retry, never invented), and a client
request timeout must cover only the connection phase of the event stream — a
stream bounded by the full timeout cut every managed turn longer than a
minute.


A trivial managed turn (one tool call) took about 18 seconds end to end,
with roughly 6 seconds before the turn was created and about 4 seconds
between the final message and the idle event; the harness prepends about 6k
tokens of its own base instructions to every session. These are properties
of the managed harness, not of Albert, and are exactly what the split view
is for.
