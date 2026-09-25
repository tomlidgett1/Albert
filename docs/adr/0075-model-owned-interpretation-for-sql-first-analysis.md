# 0075. Model-owned interpretation for SQL-first analysis

Date: 2026-08-09

## Status

Superseded in part by ADR 0077. Model-owned intent interpretation survives, but
model-authored SQL and the SQL-first execution loop do not. V2 interpretation
selects registered semantic objects, typed workspace operations, hypotheses
and deterministic operators.

## Context

Albert's SQL-first analyst had two conflicting control systems. The capable
model owned the revisable analytical plan, schema discovery, SQL and final
answer, but trusted application code still inferred complexity, business
domains and requested report sections from regular-expression lists. Separate
phrase rules also selected a small number of Unavailable and directory routes.

Those rules were not safety controls. They were a second, weaker language
model. A synonym, elliptical follow-up or unfamiliar business formulation
could be assigned the wrong budget, omit a requested workstream or trigger an
unrelated policy. Adding another phrase repaired only the observed example and
made the hidden taxonomy larger.

Current analytics products support a cleaner boundary. Omni documents an
agent grounded in model/topic/view/field semantic context, lets the LLM decide
how to apply that context, progressively prunes or searches metadata, and can
enable automatic analysis validation. Sigma Assistant selects accessible data
sources through semantic relevance, metadata, endorsement and usage; its data
models contribute relationships, metrics and explicit AI context. Sigma's
custom agents similarly use model-selected tools, while deterministic action
steps and permissions remain below the agent. Neither public architecture
removes governance in order to gain model autonomy.

Albert should use the same responsibility split while retaining its stronger
SQL execution and evidence controls: the model interprets meaning and chooses
the analytical route; trusted software constrains and verifies what can
execute.

## Decision

Every analytical turn, including a standalone first turn, begins with one
bounded tool-less request interpreter using the configured model. It receives
the current request, bounded transcript and latest persisted resolved subject,
and returns schema-validated structured output:

- continuity and a standalone resolved question;
- an optional open-vocabulary resolved subject;
- one execution lane: lookup, standard or deep;
- relevant specialist-capable business domains;
- open-vocabulary requested workstreams that define what the final answer must
  cover;
- an optional identifier for a server-owned capability policy; and
- a concise resource-selection reason.

No regular expression, keyword list, word count or prompt-template matcher may
interpret user language for analytical complexity, domains, requested report
coverage, directory routing or unavailable-data routing. If interpretation
fails validation or the provider is unavailable, the safe fallback is the
standard single-lead profile with no special policy route. Failure never grants
extra data access.

The interpreter may select only policy identifiers declared by trusted code.
The identifier is not itself authority: the server resolves it to the fixed
tool contract, permissions and terminal-state rules. This preserves fail-closed
capability policy without asking application code to understand natural
language. A terminal policy route is valid only when it resolves the complete
request; a broader question with independent answerable workstreams stays with
the lead so an unavailable branch cannot erase supported findings.

The lead analyst receives the resolved question, subject and requested
workstreams. It owns the working plan and decides which schema, SQL statements,
specialists and evidence satisfy each obligation. The runtime no longer
rejects a query because a regular expression mapped its purpose or table names
to an already-covered section. For deep work, model-selected domains determine
which bounded specialist tools are exposed; the independent reviewer checks
the draft against the model-resolved workstreams and governed evidence.

Deterministic controls remain mandatory wherever the task is mechanical,
security-sensitive or independently verifiable:

- fixed lane budgets, deadlines, result ceilings and specialist limits;
- tenant scope, role and declared-relation permissions;
- SQL parsing, linter rules, grain-preservation canaries and duplicate
  statement detection;
- immutable query audits and server-derived scope receipts;
- numerical grounding, claim attestation and answer-state derivation;
- tool schemas, PII restrictions and terminal relevance review.

Regular expressions remain permitted for syntactic jobs such as identifier
validation, safe text normalisation, SQL/source parsing and grounded-number
detection. They must not decide what a human request means or which analysis it
deserves.

SQL-first remains the constitutional query architecture. Model autonomy does
not mean database autonomy: the agent writes question-specific read-only SQL
against progressively retrieved, declared semantic context, and only the
signed semantic service may execute it.

## Consequences

- Novel phrasing and contextual follow-ups receive the same analytical
  judgement as familiar wording instead of falling outside a phrase list.
- The model, not table-name heuristics, owns report completeness and
  breadth-versus-depth decisions.
- Server logic becomes smaller and more durable: it enforces resource and
  evidence contracts rather than approximating language understanding.
- Every production turn pays for a small structured interpretation call. This
  cost must be measured against routing accuracy, latency and avoided failed
  analyses.
- Model-selected lanes and workstreams are observable and evaluable. The live
  QA suite must include paraphrases, elliptical follow-ups and adversarially
  similar requests to measure routing consistency.
- A model can still make a poor interpretation. Structured output, conservative
  fallback, final relevance review and bounded profiles contain the failure;
  evals, not new phrase rules, are the correction mechanism.

## References

- [Omni: AI in Omni](https://docs.omni.co/ai)
- [Omni: Optimize models for Omni AI](https://docs.omni.co/modeling/develop/ai-optimization)
- [Omni: AI settings](https://docs.omni.co/modeling/models/parameters/ai-settings)
- [Sigma: Configure AI features and Assistant data sources](https://help.sigmacomputing.com/docs/configure-ai-features-for-your-organization)
- [Sigma: Data-model AI context](https://help.sigmacomputing.com/docs/manage-ai-context-for-data-models)
- [Sigma: Build agents](https://help.sigmacomputing.com/docs/build-agents)
