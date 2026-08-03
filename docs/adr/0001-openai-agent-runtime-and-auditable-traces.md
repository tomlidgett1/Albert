# ADR 0001: OpenAI agent runtime and auditable analytical traces

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert engineering
- Supersedes: the founding specification's provisional Claude provider choice

## Context

Albert needs an agent runtime that can plan against governed tools, stream useful progress, carry multi-turn state, and preserve a complete trace. The founding specification deliberately puts every analytical number behind a typed semantic plan and deterministic compiler. It also names the model provider as replaceable. The product direction now explicitly requires the current OpenAI model family, user-selectable model/speed/reasoning settings, and a sequential natural-language analytics experience.

OpenAI's current guidance recommends the Responses API for reasoning, tool-calling, and multi-turn workflows; the TypeScript Agents SDK supplies the agent loop, tool execution, handoffs, streaming, state, and traces. The current model family is GPT-5.6: Sol for frontier capability, Terra for balanced cost/latency, and Luna for high-volume work. Fast mode is a request service tier, and reasoning effort is an explicit model setting.

The UI must be transparent without exposing private chain-of-thought. Free-form internal reasoning is neither a stable product contract nor the audit record required by Albert. The correct user-visible contract is an ordered stream of deliberate, structured execution artefacts.

## Decision

### Runtime

- Use `@openai/agents` in TypeScript over the OpenAI Responses transport.
- Pin an explicit model per run. Do not depend on an SDK default.
- Keep the model provider behind an Albert-owned runtime interface so regional inference and future provider changes do not affect the semantic layer.
- Use one primary analytical agent initially. Add specialists only when an evaluation shows a clear quality or latency benefit.
- Continue a conversation with one consistent state strategy. Persist Albert's auditable turn artefacts independently of provider-managed continuation state.

### Model catalogue and user controls

Expose a server-owned catalogue and persist the resolved selection on every turn:

| Product label | Model | Intended role |
| --- | --- | --- |
| Best | `gpt-5.6-sol` | Complex planning, synthesis, and difficult reconciliations |
| Balanced | `gpt-5.6-terra` | General analytical conversations with lower cost/latency |
| Fast | `gpt-5.6-luna` | Classification, catalogue lookup, and high-volume simple requests |

- Default new analytical conversations to `gpt-5.6-sol` until workload evals support a different router.
- Allow `none`, `low`, `medium`, `high`, `xhigh`, and `max` reasoning effort when supported by the selected model. Default to `medium`; reserve `max` for explicit quality-first work.
- Expose Fast mode separately as `service_tier: "fast"`. It does not silently change the chosen model or reasoning effort.
- Changes made during a run apply to the next turn. Store the requested and resolved model, effort, service tier, and runtime version with the answer artefact.
- Pro mode, persisted reasoning, and beta multi-agent execution remain evaluation-gated features rather than default UI switches.

### Semantic safety boundary

- The agent can emit only validated semantic IR or a controlled single-source exploration specification.
- The agent never receives a SQL tool and never supplies tenant scope.
- Trusted backend code injects tenant identity, validates capabilities/budgets/permissions, compiles SQL deterministically, and executes only as `semantic_ro`.
- Tables and charts are rendered only from semantic-query result artefacts. The model may choose presentation, but it never invents or recalculates values.

### User-visible execution trace

The conversation service emits an append-only ordered event stream:

- `progress`: concise phase/status update.
- `narrative`: evidence-based explanation of what the workflow is doing next.
- `query`: the semantic topic, metrics, dimensions, period, and lens; never raw SQL.
- `table`: returned columns/rows plus result and provenance identifiers.
- `chart`: a constrained chart specification referencing a returned table.
- `validation`: a named quality check and outcome.
- `clarification`: one material choice with options.
- `answer`: final narrative, answer state, provenance, and follow-ups.
- `error`: a safe, recoverable failure or exact unavailable-data gap.

This trace may say “Resolved sales to Net sales excluding GST,” “Queried Sales performance,” or “Validated refund handling and freshness.” It must not expose hidden reasoning tokens, speculative scratch work, prompts, compiled SQL, or raw tool payloads.

Provider/SDK traces are operator observability only. The product trace is sanitized, provider-neutral, reconnectable, and safe to show to the tenant.

### Observability and privacy

- Use OpenAI trace identifiers for operational debugging while retaining Albert's own provider-neutral artefact log.
- Send a stable privacy-preserving safety identifier for end-user runs.
- Minimise personal data in prompts, prefer aggregate tool results, treat source text as untrusted data, and use source data for neither model nor platform training.
- The AU-region inference endpoint remains an explicit deployment decision. No production traffic is enabled until it is resolved.

## Consequences

### Positive

- The UI can show a natural sequential analysis without conflating transparency with hidden chain-of-thought.
- Every number remains reproducible from a result artefact and semantic bundle hash.
- Model, speed, and reasoning changes are explicit, measurable, and auditable.
- The agent runtime can evolve without relaxing the semantic or tenant-isolation boundary.

### Costs and risks

- Model combinations multiply the eval matrix; representative golden questions must run across supported profiles.
- Fast and high-effort options can materially change latency and cost, so the UI must show the resolved profile and metering.
- Provider traces are not a substitute for Albert's audit log and may have different retention/residency characteristics.
- A missing regional endpoint decision blocks production model traffic but not the local typed runtime, fixture trace, or UI.

## Alternatives considered

- Direct Responses API without the Agents SDK: smaller dependency surface, but more custom agent-loop, streaming, handoff, and trace code.
- Show raw model reasoning: rejected because it is not a safe or stable product API and does not satisfy the deterministic audit requirement.
- One fixed frontier model at maximum reasoning: rejected because it prevents users from managing latency/cost and is not supported by workload evidence.
- Model-generated SQL: rejected by the founding specification's constitutional boundary.

## References

- [OpenAI Agents SDK quickstart](https://developers.openai.com/api/docs/guides/agents/quickstart)
- [OpenAI Agents SDK models and providers](https://developers.openai.com/api/docs/guides/agents/models)
- [OpenAI Agents SDK running and streaming](https://developers.openai.com/api/docs/guides/agents/running-agents)
- [GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI Fast mode](https://developers.openai.com/api/docs/guides/fast-mode)
- [OpenAI reasoning models](https://developers.openai.com/api/docs/guides/reasoning)
