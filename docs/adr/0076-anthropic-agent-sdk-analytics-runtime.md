# 0076. Isolated Anthropic Agent SDK analytics runtime

Date: 2026-08-09

## Status

Accepted as a separately gated non-V2 runtime. ADR 0077 supersedes its
question-time SQL architecture for Semantic Execution V2; it cannot participate
in V2 certification, evaluation or silent fallback. Its own production
activation remains blocked on APP 8 and privacy review, ZDR approval, AU
regional load testing, and an exact provider preflight.

Historically, this decision extended ADR 0068's then-constitutional SQL-first boundary and
supersedes the single-provider assumption in ADR 0001. It does not replace the
existing OpenAI runtime. For conversations created with the New Method, it
supersedes the OpenAI-specific runtime and planning choices in ADRs 0001,
0069, 0072, 0073, 0074 and 0075 while retaining their deterministic security,
lineage and evidence obligations.

## Context

Albert needs a genuinely independent natural-language analytics implementation
to test a second agent architecture without turning one runtime into a thin
provider adapter for the other. The shared truth cannot be an agent prompt or
planner. It must be the platform boundary: authenticated tenant context,
declared analytical schemas, signed read-only SQL execution, immutable public
trace events and independently finalized answer artifacts.

Anthropic's self-hosted Claude Agent SDK provides the current TypeScript agent
loop, custom in-process MCP tools, structured outputs, bounded turns and cost,
session resume, and an external `SessionStore`. The store is explicitly a
best-effort mirror of the SDK's local transcript, so it cannot be the source of
truth for Albert's public audit or final result. Agent SDK sessions also write
locally before mirroring; a unique ephemeral `CLAUDE_CONFIG_DIR` is therefore
required.

Claude Opus 5 is the requested primary model and Anthropic documents it for
complex agentic and enterprise work. Claude Sonnet 5 is an infrastructure
fallback. Both support adaptive thinking. A fallback must be visible in usage
evidence and validation events; it must never be presented as if Opus produced
the run.

First-party Claude inference does not provide an Australian inference
geography. Bedrock distinguishes global and regional endpoints, but exact
model availability and routing must be proven for the production account.
Albert must not turn missing regional support into an implicit cross-region
fallback.

## Decision

Create three net-new roots:

- `packages/anthropic-analytics` owns Anthropic-only prompts, result schemas,
  the 90-table Lightspeed catalogue, custom MCP tools, grounding, review and
  Agent SDK execution;
- `services/anthropic-analytics` owns signed transport, provider isolation,
  deadlines, AU provider gates and the tenant-scoped Postgres `SessionStore`;
  and
- `evals/anthropic-analytics` owns deterministic and adversarial analytics
  evaluation.

No file in the new package or service may import `@openai/agents`, Albert's
OpenAI conversation runtime, its planner, its prompts or its generated agent
playbooks. The runtime may share only the public trace and finalization
contracts, internal request signing, authenticated conversation identity, and
the signed semantic-query service.

The chat header exposes a 36px primary pill labelled **New Method**. It starts
a blank Anthropic conversation. A conversation's runtime is immutable from its
first turn: restore, follow-up, retry and cancellation route to the same
runtime. Anthropic conversations display `Claude Opus 5` and do not expose
OpenAI run controls. Existing New Analysis behavior remains OpenAI.

The primary run is `claude-opus-5`, adaptive thinking, maximum effort, at most
20 agent turns, at most US$3 across the turn, and a 180-second wall deadline.
`claude-sonnet-5` is the explicit infrastructure fallback. The SDK loads no
filesystem settings, skills, plugins or built-in tools. Shell, filesystem,
web, task and agent tools are disallowed. Auto-memory is disabled, child
process environment variables are allowlisted, and local session data is
removed when the turn ends.

Claude receives exactly four in-process MCP tools:

1. `semantic_context` retrieves governed definitions, capabilities, values and
   data health through the signed semantic service.
2. `lightspeed_schema` searches or describes only the 90 relations declared in
   `connectors/lightspeed-r/tables.json`.
3. `sql_execute` submits a bounded read-only statement to the semantic service;
   trusted code captures tenant, role, conversation and turn identity.
4. `analysis_checkpoint` records proposed facts, grain and uncertainty without
   granting data authority.

The semantic service remains authoritative for relation and field allowlists,
tenant injection, role/PII policy, time and row bounds, mapping versions,
tombstones, completed/voided sale semantics, refunds, GST, fan-out protection,
query audits and result state. Instruction-shaped source text is removed from
the model-facing result projection outside Claude. The exact governed cell is
retained only in the host evidence ledger for deterministic grounding.

The agent must execute SQL before a numerical claim and cite every number with
an exact result, row and column. Host code rejects missing cells, mismatched
values and prose numbers absent from grounded claims. It derives the maximum
confidence from all cited results, so source exploration cannot become
Verified by model recommendation. Composite, multi-result and staging analyses
receive a second restricted Opus review containing only the candidate and a
bounded evidence summary. The reviewer has no tools. Deterministic grounding
remains authoritative over review output.

Every accepted turn has exactly one public terminal disposition: Verified,
Qualified, Exploratory, Clarification or Unavailable. “100% result” means this
terminal guarantee, not fabricated analytical certainty. Provider errors,
rate limits, timeouts, cancellation, budget exhaustion, malformed output,
failed review and exhausted SQL repair become Unavailable. Streams use ordered
sequence IDs, keepalives and abort propagation. Turn and session persistence
are idempotent. Public trace persistence and immutable finalization are
synchronous; opaque Agent SDK session mirroring remains monitored but
best-effort.

The web route accepts only a message, optional conversation ID, and optional
confirmed clarification. It derives actor, tenant and role server-side. The
provider-neutral v2 finalization endpoint adds a discriminated Anthropic
metering payload; the OpenAI v1 endpoint and contract remain unchanged.

Production supports no direct Anthropic API mode. It requires an approved
Bedrock profile in `ap-southeast-2`, data-residency value `au`, approved data
controls, and exact Opus-primary/Sonnet-fallback model profiles. Startup and
readiness fail closed if any condition is missing. There is no global or US
fallback. The credential disclosed in the implementation request is
compromised by disclosure, is never used, and must be revoked; live smoke
tests use only a newly rotated secret supplied by the secret manager.

## Consequences

- Anthropic experimentation cannot accidentally inherit OpenAI planner
  behavior, prompts, tools or provider credentials.
- Both runtimes remain comparable at the public trace and evidence boundary
  while their reasoning implementations stay independent.
- The runtime cannot answer around a semantic-service rejection. Honest
  Unavailable outcomes increase under outages or unsupported questions by
  design.
- Session transcripts add tenant-scoped Postgres storage and retention work.
  Mirror failures are observable but do not erase public trace or result
  artifacts.
- Composite answers incur reviewer latency and cost. The reviewer receives
  only remaining turn budget, so the whole run stays within the configured
  ceiling.
- Public release requires the deterministic/adversarial thresholds, browser
  coverage, privacy and ZDR approvals, regional provider proof and load tests.

## References

- [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [TypeScript Agent SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)
- [Session storage](https://code.claude.com/docs/en/agent-sdk/session-storage)
- [Structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs)
- [Claude model overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- [API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)
- [Data residency](https://platform.claude.com/docs/en/manage-claude/data-residency)
