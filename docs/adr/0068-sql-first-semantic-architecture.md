# 0068. SQL-first semantic architecture: linted, canaried, attested model-authored SQL

Date: 2026-08-06

## Status

Superseded for the primary question-time path by ADR 0077. This design remains
historical documentation for the bounded V1 rollback window only; model-authored
SQL is prohibited in Semantic Execution V2.

## Context

The typed semantic plan was the founding correctness mechanism: the model
emitted `{topic, metrics[], dimensions[], filters[], time}`, a deterministic
compiler produced SQL, and an answer was Verified by construction. Measured
against real questions it failed the wrong way around. The 20-case agent QA
battery scored one good answer: six cases died in `ZodError` retry loops
because the question could not be expressed in the IR at all, and the
structural insight is sharper than the scorecard — a typed plan does not
prevent wrong answers. A plan naming the wrong metric or period compiles
perfectly and returns a confident, provenance-stamped wrong number. The IR
checked well-formedness, cost expressiveness, and bound hardest on exactly
the novel questions it existed to protect.

An escape hatch already existed: `run_exploratory_sql` executed model SQL
read-only as `semantic_ro` under forced row-level security, permanently
pinned to Exploratory because the `source_exploration` audit route forbids
Verified — a structural consequence of the five invariant checks reading
compiler-produced `CompiledSemanticValidationEvidence` that no SQL path could
supply.

## Decision

The model writes SQL against Albert's declared analytical schemas as the
primary analytical path. Canonical facts and marts are the strongest governed
surface. Documented source-specific staging is also deliberately available for
progressive semantic coverage and novel questions; results from that surface
remain Exploratory unless they are separately attested. Immutable payload
storage, diagnostic access and relations outside the semantic role's declared
schema allowlist are never agent-facing.

Software owns safety and certification at three moments instead of one:

1. **Before execution** — `packages/semantic-registry/src/linter.ts` reads
   the statement (scope-aware: CTEs, derived tables, joins, aggregates,
   group keys) and rejects a short denylist of known-fatal shapes: summing a
   point-in-time level across its time axis, summing a measure a co-joined
   fact declares it multiplies (`fansOut`, direction-aware so line measures
   under a header join stay legal), and aggregating keys as quantities. It is
   open by default: relations the registry has never heard of execute, they
   just cannot certify. The linter reconstructs the same
   `CompiledSemanticValidationEvidence` the compiler produces, so the five
   semantic invariants run unchanged over agent SQL, with `one_to_many` /
   `unverified` cardinalities naming what it cannot vouch for.

2. **At execution** — a count-preservation canary re-runs each fact-bearing
   scope's verbatim join tree as `count(*)` versus `count(DISTINCT grain)`.
   Proven multiplication withholds the figures with the inflation-ratio
   fingerprint (the ratio lands near the average child count — the shape of
   a header-times-lines join); a clean canary over real rows upgrades only
   joins the registry could not classify, never declared knowledge.

3. **After execution** — every declared claim (`{metricId, column}` with a
   window and governed filters) is re-stated through the contract's own
   compiled SQL. Match earns Verified; divergence is disclosed with both
   numbers and lands Qualified; no claims means Exploratory. The 51 metric
   contracts change role: from a menu the model picks from to executable
   attestation targets.

Answer state is derived, never asserted: it is additionally capped by the
minimum **evidence tier** (0 asserted, 1 observed, 2 reconciled, 3
contracted) across every fact the statement touched, so asserted-from-docs
substrate cannot certify no matter how well a claim attests. The audited
route set widens to `sql_first`, which Verified may rest on while
`source_exploration` remains excluded.

`run_semantic_query` and the typed IR may remain as compatibility tools for
established paths, but they are not the primary analytical language and may
not constrain the questions Albert can answer. Schema and semantic context are
retrieved progressively: the agent searches the declared catalogue, loads only
the relevant grains, joins, fields and business rules, then writes the
question-specific SQL.

## Consequences

- Guaranteed metric consistency becomes attested consistency: a compiling
  plan was right by construction, a SQL answer is right by demonstration.
  The guarantee that was lost fired on roughly one question in twenty.
- Attestation roughly doubles claim-bearing query cost; re-statements are
  memoised on (contract, filters, window, watermarks) and only final claims
  attest.
- The registry gains `measures`, `fansOut`, `grainKey` and `evidenceTier`
  per fact; new generated substrate (the 90-table Lightspeed staging, Square)
  arrives at tier 0 and earns its way up.
- `mart.sales_day` and `mart.sales_day_location_category` pre-aggregate the
  most-asked shapes so fan-out is structurally impossible there and the
  linter is a backstop, not the load-bearing wall.
- SQL-first does not mean ungoverned text-to-SQL: trusted code, not the model,
  owns tenant scope, relation permissions, execution budgets, query auditing,
  scope receipts, numerical grounding and certification.
