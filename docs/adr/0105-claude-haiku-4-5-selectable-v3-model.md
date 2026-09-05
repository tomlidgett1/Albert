# 0105. Claude Haiku 4.5 as a selectable V3 model

Date: 2026-08-19

## Status

Accepted. Extends ADRs 0001 and 0094. This decision applies only to the
production V3/Cube conversation runtime. It does not revive ADR 0076's retired
isolated **New Method** runtime and does not change the Luna-only Semantic V2
release-qualification contract in ADR 0077.

## Context

Albert's owner-facing model selector supports the GPT 5.6 profiles and Grok
4.6. The owner also needs the latest generally available Claude Haiku model,
with Albert's reasoning-level control, on the same governed V3 analytical
runtime.

Anthropic's latest Haiku is Claude Haiku 4.5. Reproducible requests use the
dated model identifier `claude-haiku-4-5-20251001`, not the moving
`claude-haiku-4-5` alias. Haiku 4.5 uses the native Messages API. Anthropic's
OpenAI compatibility layer is not the production contract for strict tools or
thinking and ignores OpenAI `reasoning_effort`.

Haiku 4.5 predates Anthropic's adaptive thinking and `output_config.effort`.
It supports manual extended thinking only: `thinking.type = "enabled"` with a
`budget_tokens` value of at least 1,024 and strictly less than `max_tokens`.
It also rejects forced tool choice while manual thinking is enabled, has no
interleaved thinking, and is not eligible for Anthropic Fast mode.

First-party Haiku 4.5 cannot use Anthropic's `inference_geo`. Direct requests
are globally routed. ZDR applies only when Anthropic has approved it for the
organisation; choosing the model does not itself create ZDR or Australian
data residency.

ADR 0076's direct-API prohibition governed the former isolated Opus/Sonnet
analytics service, which was removed when V3 became authoritative. A
selectable V3 Haiku model is a different boundary: it shares Albert's current
typed semantic tools, trusted Cube execution, deterministic grounding and
public trace, while replacing only the model transport.

## Decision

- Add the pinned model `claude-haiku-4-5-20251001` to the server-owned model
  allowlist and the existing dash selector. The GPT profiles remain the
  default; Haiku is never a silent fallback.
- Use the installed official `@anthropic-ai/sdk` and native Messages API behind
  a narrow Agents SDK `Model`/`ModelProvider` adapter. Never send the OpenAI or
  xAI key to Anthropic and never route Haiku through an OpenAI-compatible
  endpoint.
- Translate Albert's reasoning levels to the following application-owned
  manual thinking budgets:

  | Albert level | Haiku `budget_tokens` | `max_tokens` |
  | --- | ---: | ---: |
  | none | disabled | 8,192 |
  | low | 1,024 | 9,216 |
  | medium | 4,096 | 12,288 |
  | high | 8,192 | 16,384 |
  | xhigh | 16,000 | 24,192 |
  | max | 32,000 | 40,192 |

  These are Albert policy labels, not Anthropic-native effort values. Every
  enabled budget leaves at least 8,192 tokens for a tool call or structured
  answer and remains below Haiku's 64k output ceiling.
- Treat Haiku's manual budgets as a different latency policy from adaptive
  OpenAI reasoning. Selecting Haiku starts at Low rather than inheriting
  Luna's Max preference. Intent classification uses no thinking; support,
  formatting, repair and review roles are capped at Low; quick roles stay Low;
  analytical roles stay Medium; and only high/deep roles may be elevated by an
  explicit High, XHigh or Max preference. The selector warns that High and Max
  can take minutes.
- Request `display: "omitted"`. Preserve Anthropic thinking or redacted-
  thinking blocks and signatures only as opaque internal continuation state.
  Never put thinking text, signatures, or raw provider responses in Albert's
  public trace or artifacts.
- Use the TypeScript SDK's streaming Messages helper for every provider call
  and await `finalMessage()` before returning to the Agents runner. This keeps
  XHigh and Max calls above the SDK's long-request threshold alive without
  changing Albert's owner-facing stream: provider deltas and thinking remain
  private, while the same complete signed Message feeds tool continuation,
  usage metering and deterministic validation.
- Convert an Agents SDK `required`/named tool choice to Anthropic `auto` when
  thinking is enabled, because the provider rejects forced tool choice in that
  mode. This does not relax Albert's trust boundary: host code still refuses
  ungrounded output, required-evidence lanes retry or fail closed, and the
  model never receives SQL or a database credential.
- Use Anthropic's strict tool schemas and native structured output. Transform
  JSON Schema through the official SDK helper before transmission, then retain
  the Agents SDK/Zod validation after generation.
- Keep Anthropic's combined compiled-schema limits explicit: at most 20 strict
  tools, 24 optional parameters and 16 union-typed parameters across the JSON
  output and every strict tool in one request, plus undocumented internal
  grammar-size limits. Structured-output requests reserve the provider grammar
  entirely for the final result and send tools non-strict; text-only requests
  retain at most four low-complexity strict tools. Every tool keeps its original
  host-side Zod validation, so malformed input is rejected before execution
  rather than widening Albert's trusted boundary.
- Simplify nullable unions only in the provider-facing output grammar: nullable
  fields may be omitted by Claude, then trusted adapter code restores required
  nulls before the unchanged Agents SDK/Zod validation. This keeps the V3 query
  planner below Anthropic's hidden grammar ceiling without changing Albert's
  persisted or in-process output contract.
- Disable and hide Fast mode for Haiku. Send `service_tier: "standard_only"`;
  do not translate Albert Fast to Anthropic Priority Tier.
- Fail closed on missing credentials, provider refusal, truncation, context
  exhaustion, malformed output, or an unsupported content block.
- Development may use `ANTHROPIC_API_KEY` directly. Production exposes Haiku
  only when `ALBERT_ANTHROPIC_APP8_APPROVED=true` and
  `ALBERT_ANTHROPIC_ZDR_APPROVED=true`. The choice must be disclosed as global
  processing; it does not inherit the AU OpenAI residency claim. A future AU
  Bedrock transport is a separate reviewed change.
- Meter the published first-party Haiku rates: US$1/MTok input, US$0.10/MTok
  cache read, US$1.25/MTok five-minute cache write, and US$5/MTok output.
  Thinking is included in billed output even when its display is omitted.

## Consequences

- Owners can run the same governed V3 analysis with Haiku and choose a visible
  reasoning level without creating a second analytics architecture.
- The adapter must maintain lossless opaque thinking signatures across a tool
  loop. Contract tests cover native request shape, strict structured output,
  tool continuation, truncation, usage and UI request binding.
- A thinking-enabled Haiku lane cannot cryptographically force the next model
  action to be a tool call. Deterministic evidence/grounding remains the
  authoritative enforcement point, so the safe failure is Unavailable rather
  than an ungrounded answer.
- Large V3 structured-output inventories use host-validated tools so one
  request stays within Anthropic's grammar compilation limits. The model sees
  the same tools and schemas; only provider-side constrained sampling is
  disabled, and invalid arguments still fail before tool execution.
- Changing reasoning level changes the thinking budget and invalidates prompt
  cache boundaries. The selected level should remain stable inside a cached
  conversation when practical.
- A Max owner preference is not a blanket instruction to spend 32k thinking
  tokens on routing or formatting. It is reserved for deep analytical work so
  simple questions retain interactive latency.
- Global routing and output-priced thinking make APP 8 disclosure, ZDR
  approval and per-turn usage metering operational requirements.
- Provider streaming is a transport-liveness mechanism only. Albert continues
  streaming its own audited narrative/table/validation events rather than raw
  Claude tokens or reasoning deltas.

## References

- [Claude models overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode)
- [API retention and ZDR](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)
- [Data residency](https://platform.claude.com/docs/en/manage-claude/data-residency)
- [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)
