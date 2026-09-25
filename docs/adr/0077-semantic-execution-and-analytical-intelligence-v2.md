# ADR 0077: Semantic Execution and Analytical Intelligence V2

- Status: accepted
- Date: 2026-08-09
- Supersedes in part: ADR 0068, ADR 0069, ADR 0072, ADR 0074, ADR 0075,
  ADR 0076, and sections 15, 16, 23 and 24 of `docs/albert-v1-spec.md`

## Context

Albert's current SQL-first analyst correctly protects the database boundary, but
it still makes the model responsible for relational implementation. That is the
wrong trust boundary for a product that promises governed answers across the
complete Lightspeed and Xero surfaces. Longer prompts, richer playbooks and more
SQL linting cannot make model-authored joins, grain choices and aggregation
semantics deterministic.

The existing repository already contains the valuable foundations: immutable
connector payloads, typed staging, canonical facts, source authority, tenant
isolation, a semantic registry, a compiler, signed read-only execution, answer
artifacts and an internal operations surface. Replacing the repository would
discard those controls without solving the analytical problem.

## Decision

Albert V2 is built in this monorepo behind a server-owned turn-level runtime
flag. The model interprets intent, selects semantic identifiers, proposes
hypotheses and explains evidence. Trusted code owns physical identifiers, join
paths, cardinality, grain, additivity, currency, time, SQL generation, query
budgets, execution and validation. No model-provided SQL or expression fragment
may reach PostgreSQL.

The runtime is split into two explicit layers:

1. **Semantic Execution V2** — an authorable semantic graph, layered Topics,
   revisioned Query Workspaces, a deterministic relational compiler, signed
   execution and immutable evidence.
2. **Analytical Intelligence V2** — inspectable investigation plans, bounded
   hypothesis/evidence DAGs, deterministic analytical operators, claim-level
   grounding, structured business context and an insight ledger.

The public terminal states are `verified`, `derived`, `exploratory`,
`clarification`, `no_data` and `unavailable`. Empty valid data is never reported
as an execution failure, and an execution failure is never reported as zero.

## Semantic authoring

Mutable drafts live in the control plane. A publication is an immutable,
content-addressed canonical JSON artifact. Activation and rollback change only
the active publication pointer. Repository YAML remains an import/export and
fixture format, not the only authoring surface.

Every Lightspeed and Xero source field has one explicit disposition. Topics are
layered as source-domain, business and composite Topics; one global all-data
Topic is prohibited. Cross-fact analysis aggregates each fact independently and
then aligns on declared shared dimensions.

Every source object and source-backed semantic view also pins the exact
connector mapping version that produced its physical projection. The compiler
must constrain every root, snapshot and joined-source scan to that mapping
version before aggregation. Rows produced by legacy and current connector
projections may coexist in staging for lineage and replay, but they must never
coexist in one semantic result. A mapping-version change is a semantic source
change: it requires a new publication, invalidates prior physical and
relationship-profile evidence, and must complete the normal qualification
cycle.

The V2 registry is permission-neutral. Role-, row-, field- and store-scoped
semantic permissions are deferred. Existing authentication, internal-operator
access and tenant isolation remain mandatory security boundaries.

## Rollout

V1 stays runnable while V2 is developed and internally shadowed. There is no
silent per-answer fallback and no progressive customer cohort. The production
route changes in one controlled switch only after complete Lightspeed/Xero
qualification; a global V1 rollback remains available for 30 days.

Deputy is not V2-certified, used in composite Topics, or included in the launch
evaluation until real Deputy data exists. Existing Deputy ingestion code is not
removed.

## Evaluation contract

The only qualifying model-backed corpus contains 200 question executions:
80 Lightspeed, 80 Xero and 40 Lightspeed-Xero. It uses the exact model
`gpt-5.6-luna`, `reasoning.effort: "max"`, standard reasoning mode and no Fast
processing tier. Each execution has an 800-second hard timeout so Max-reasoning
investigations are measured rather than prematurely aborted. V2 permits at most
64 model/tool turns inside that window; this does not expand the independent
trusted query, cost, result, or investigation budgets. The unsuffixed
`gpt-5.6` alias, Sol, Terra, Pro mode and Deputy
questions are rejected before a run begins. Forty cases are hidden holdout.
The repository commits their identifiers and allocation metadata but only sealed
prompt placeholders. The qualifying runner must bind the separately controlled
40-prompt holdout and reject any identifier or metadata drift before reserving
the one-shot budget.
Retries and paraphrase executions consume the same 200-question ceiling.
The one-shot budget cannot be reserved until the exact commit and publication
have a passed deterministic qualification receipt, including an exact live
staging table, column, type and nullability audit.

Deterministic graders own numeric and structural correctness. Human review owns
causal, diagnostic and recommendation quality; the evaluated model cannot be
its own sole grader.

The fail-closed operational sequence for migration, profiling, relationship
review, deterministic qualification, the one-time model budget, activation and
rollback is defined in `docs/semantic-v2-release-runbook.md`.

## Consequences

- The current model-authored SQL tools remain V1-only and are removed after the
  rollback window.
- The existing semantic registry and compiler gain V2 compatibility adapters
  rather than being rewritten in place.
- The admin console becomes a semantic authoring product, not only a pipeline
  observability surface.
- Some source fields will remain exploratory or unsupported. Comprehensive
  coverage means an explicit, truthful disposition, not false certification.
