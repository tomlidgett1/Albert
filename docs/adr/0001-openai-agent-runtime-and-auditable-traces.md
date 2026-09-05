# ADR 0001: OpenAI agent runtime and auditable analytical traces

- Status: Accepted for runtime and trace design; semantic safety boundary and the rejection of model-authored SQL are superseded by ADR 0068
- Date: 2026-08-03
- Owners: Albert engineering
- Supersedes: the founding specification's provisional Claude provider choice

> **Supersession note (2026-08-09):** ADR 0068 established linted,
> canaried and attested model-authored SQL as Albert's primary analytical path.
> The typed-IR-only statements below record the original decision but are no
> longer current architecture. ADR 0075 further replaces deterministic
> natural-language routing with model-owned structured interpretation.

## Context

Albert needs an agent runtime that can plan against governed tools, stream useful progress, carry multi-turn state, and preserve a complete trace. The founding specification deliberately puts every analytical number behind a typed semantic plan and deterministic compiler. It also names the model provider as replaceable. The product direction now explicitly requires the current OpenAI model family, user-selectable model/speed/reasoning settings, and a sequential natural-language analytics experience.

OpenAI's current guidance recommends the Responses API for reasoning, tool-calling, and multi-turn workflows; the TypeScript Agents SDK supplies the agent loop, tool execution, handoffs, streaming, state, and traces. The current model family is GPT-5.6: Sol for frontier capability, Terra for balanced cost/latency, and Luna for high-volume work. Fast mode is a request service tier, and reasoning effort is an explicit model setting.

The UI must be transparent without exposing private chain-of-thought. Free-form internal reasoning is neither a stable product contract nor the audit record required by Albert. The correct user-visible contract is an ordered stream of deliberate, structured execution artefacts.

## Decision

### Runtime

- Use `@openai/agents` in TypeScript over the OpenAI Responses transport.
- Pin an explicit model per run. Do not depend on an SDK default.
- Keep the model provider behind an Albert-owned runtime interface so regional inference and future provider changes do not affect the semantic layer.
- Use one primary analytical agent plus a narrow result-summarisation sub-agent for governed tables over 100 rows. The sub-agent receives the complete table in its own context, has no tools, cannot calculate new figures, and returns a grounded summary while the full table remains the tenant-visible artefact.
- Continue conversations from a bounded, tenant-scoped context rebuilt from Albert's own completed narrative artefacts. Send Responses requests with `store: false` and `reasoning.context: "current_turn"`; provider response IDs are audit correlation only, never the source of conversational continuity.

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
- Control-plane reads run as the constrained `albert_semantic_control` role. It can read the active registry and tenant overlay, and append explicitly confirmed overlay/audit changes; it has no privilege on OAuth token references or encrypted credential envelopes.
- Tables and charts are rendered only from semantic-query result artefacts. The model may choose presentation, but it never invents or recalculates values.
- A large-result summary is checked against every governed row before it enters the visible trace. Any numeric token absent from a governed cell (other than the server-derived row count) is withheld. The nested run's request and token usage is combined into the turn's immutable usage ledger.

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

- Keep Albert's provider-neutral artefact log enabled for every turn. OpenAI SDK tracing excludes sensitive data and is disabled by default; an MAM-approved project may opt in explicitly with `ALBERT_OPENAI_TRACING_ENABLED=true`.
- Send a stable privacy-preserving safety identifier for end-user runs.
- Minimise personal data in prompts, prefer aggregate tool results, treat source text as untrusted data, and use source data for neither model nor platform training.
- Use `https://au.api.openai.com/v1` for production API traffic so eligible API state is stored in Australia. As of this ADR date, OpenAI documents **regional storage but not regional processing** for Australia and requires Modified Abuse Monitoring or Zero Data Retention eligibility. Production readiness therefore requires the OpenAI project to be approved for MAM or ZDR, trace payload collection to exclude sensitive data, and prompts to contain the minimum aggregate data needed for the answer.
- Keep `OPENAI_BASE_URL` explicit and fail-fast. Albert does not silently fall back from the AU endpoint to the global endpoint.

## Consequences

### Positive

- The UI can show a natural sequential analysis without conflating transparency with hidden chain-of-thought.
- Large tables do not consume the primary planner's context unboundedly, while their complete result and summarized interpretation remain auditable.
- Every number remains reproducible from a result artefact and semantic bundle hash.
- Model, speed, and reasoning changes are explicit, measurable, and auditable.
- The agent runtime can evolve without relaxing the semantic or tenant-isolation boundary.

### Costs and risks

- Model combinations multiply the eval matrix; representative golden questions must run across supported profiles.
- Fast and high-effort options can materially change latency and cost, so the UI must show the resolved profile and metering.
- Provider traces are not a substitute for Albert's audit log and may have different retention/residency characteristics.
- Rebuilding bounded narrative context consumes more input tokens than provider-managed continuation, but avoids coupling product continuity to provider retention and supports stricter ZDR operation.
- Australian storage does not mean Australian processing. APP 8 assessment, customer disclosure, and contractual safeguards remain operational requirements, and the deployment smoke test must confirm the configured OpenAI project can use the AU domain.

## Alternatives considered

- Direct Responses API without the Agents SDK: smaller dependency surface, but more custom agent-loop, streaming, handoff, and trace code.
- Show raw model reasoning: rejected because it is not a safe or stable product API and does not satisfy the deterministic audit requirement.
- One fixed frontier model at maximum reasoning: rejected because it prevents users from managing latency/cost and is not supported by workload evidence.
- Model-generated SQL: rejected by the founding specification's constitutional boundary.

## References

- [OpenAI Agents SDK quickstart](https://developers.openai.com/api/docs/guides/agents/quickstart)
- [OpenAI Agents SDK models and providers](https://developers.openai.com/api/docs/guides/agents/models)
- [OpenAI Agents SDK running and streaming](https://developers.openai.com/api/docs/guides/agents/running-agents)
- [Upgrade to GPT-5.6 Sol](https://developers.openai.com/api/docs/guides/upgrading-to-gpt-5p6-sol)
- [GPT-5.6 prompting guidance](https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6)
- [OpenAI Fast mode](https://developers.openai.com/api/docs/guides/fast-mode)
- [OpenAI reasoning models](https://developers.openai.com/api/docs/guides/reasoning)
- [OpenAI data controls and regional support](https://developers.openai.com/api/docs/guides/your-data#support-by-region)
