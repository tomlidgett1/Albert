# Omni and Sigma AI analytics agents: architecture notes for Albert

Date: 2026-08-09

This note records what the vendors publicly document, not an inferred
reverse-engineering of their private runtimes.

## Omni

Omni describes its AI as grounded in the organisation's semantic model. The
model supplies governed metrics, relationships, permissions, topic/view/field
descriptions, synonyms, values, examples and explicit `ai_context`. Natural
language can produce queries, visualisations, summaries and dashboards.

Important implementation patterns:

- **The LLM owns contextual judgement.** Omni states that its LLM decides how
  to weight model-, topic-, view- and field-level context and resolve apparent
  contradictions. It also documents the resulting non-determinism rather than
  representing context as guaranteed executable policy.
- **Context is progressive and curated.** Omni prioritises metadata, prunes
  lower-value properties when a topic is large, limits the fields supplied to
  the agent and supports narrower searches outside topics. It recommends a
  smaller, well-described field set over an indiscriminate schema dump.
- **Semantic queries still become SQL.** Analyses use modeled fields and
  relationships, then execute against the warehouse. Users can inspect the
  selected field, its definition or calculation and its description.
- **Validation is a product control.** Model settings can enable automatic
  analysis validation before results are returned and can independently tune
  model capability/thinking for analysis, building and summarisation.
- **Scope and permissions are explicit.** Agent chats can be scoped to a
  connection, model or topic; every AI surface observes the existing user
  permissions.
- **Reusable processes are separate from open analysis.** Skills standardise
  recurring reports and checks without reducing all natural-language requests
  to those routines.

## Sigma Computing

Sigma Assistant answers natural-language questions against live accessible
data, returns charts/tables that can be opened in a workbook and supports
iterative follow-up conversations.

Important implementation patterns:

- **Source selection is semantic, not phrase routing.** When a user does not
  pin a source, Sigma describes selection based on access, relevance from
  metadata, known validity/endorsement and usage frequency. Configured sources
  are indexed for semantic search.
- **Models are preferred but raw tables remain possible.** Admins can configure
  data models, semantic views or platform tables. Sigma recommends data models
  because relationships and metrics let Assistant perform more accurate
  aggregate and multi-table analysis.
- **Business instructions live with the model.** AI context can define aliases,
  time fields, metric rules, relationship usage, freshness, units and
  forbidden analysis. Column/table/model descriptions and certification badges
  improve retrieval and consistency.
- **The model selects tools; deterministic actions remain tools.** Custom Sigma
  agents receive chosen data context, instructions and tools such as workbook
  actions, warehouse agents, search services or MCP. The agent uses tool names
  and instructions to decide when to invoke them; the invoked action itself can
  be a fixed sequence and can require approval.
- **Governance follows the query.** Row-, column- and source-level access still
  applies to Assistant and warehouse agents execute with configured roles.

## Implications for Albert

Albert should not copy either product literally. Its differentiator is a
stronger source-authority, identity, evidence-tier and claim-attestation model.
The useful shared direction is:

1. Let the model interpret requests, select analytical context, plan, choose
   tools, write SQL and revise after evidence.
2. Keep permissions, tenant isolation, SQL safety, grain checks, numerical
   grounding and certification deterministic.
3. Retrieve compact domain/schema context progressively instead of carrying a
   large connector manual on every turn.
4. Prefer governed canonical metrics and relationships when they answer the
   question, while preserving declared staging SQL for the long tail.
5. Make query fields, definitions, sources, scope and validation inspectable.
6. Evaluate routing, source selection, completion, correctness, latency and
   repeatability; improve the model context and eval corpus rather than adding
   prompt regex for each failure.

## Primary sources

- [Omni AI overview](https://docs.omni.co/ai)
- [Omni Agent](https://docs.omni.co/ai/chat)
- [Omni AI model optimisation](https://docs.omni.co/modeling/develop/ai-optimization)
- [Omni AI settings](https://docs.omni.co/modeling/models/parameters/ai-settings)
- [Omni SQL generation](https://docs.omni.co/analyze-explore/sql/generation)
- [Sigma Assistant natural-language analysis](https://help.sigmacomputing.com/docs/ask-natural-language-queries-with-assistant)
- [Sigma Assistant source configuration and selection](https://help.sigmacomputing.com/docs/configure-ai-features-for-your-organization)
- [Sigma data-model AI context](https://help.sigmacomputing.com/docs/manage-ai-context-for-data-models)
- [Sigma data-model best practices](https://help.sigmacomputing.com/lang-hc/docs/data-modeling-best-practices)
- [Sigma custom agents](https://help.sigmacomputing.com/docs/build-agents)
