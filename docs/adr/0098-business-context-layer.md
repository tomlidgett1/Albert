# ADR 0098: Business context layer

- Status: Accepted (implemented 2026-08-18; validated on Ashburton Cycles — see
  `evals/albert/context/` and `evals/albert/REPORT.md` §7)
- Date: 2026-08-18
- Supersedes: ADR 0096 (tenant connection brief — the sketch; this is the built
  version, with a model-generated narrative on top of the deterministic facts)
- Complements: ADR 0097 (planned lanes, recipes, result retention), migration
  0141 (`tenant_source_findings`)

## Context

Every Albert turn started from generic knowledge: the configured views, the
connector rule packs, and whatever `tenant_source_findings` earlier turns
happened to record. Nothing told the intent orchestrator or the answering lanes
*what this business is* — how it makes money, what "the workshop" or "the
floor" means here, how big it is, what the owner cares about, or which tool is
the source of truth for what. The 250-turn eval showed the cost: vague
questions ("How's the workshop going?", "How are we doing?") were either
clarified or answered under an arbitrary reading; cross-tool questions picked
the wrong denominator; answers were scoped to the data model rather than to
the business.

Albert will have ~50 connectors. The layer must be populated per business from
whatever is connected, and must not know a connector.

## Decision

### 1. One structured document per tenant, ~400 words rendered

`packages/albert-v3/src/context-layer/schema.ts` — `businessContextDocumentSchema`:

| section | holds | who writes it |
|---|---|---|
| identity | name, two-sentence summary, industry, model, channels, locations | generator (owner may edit) |
| revenue | basis, 3–7 streams with shares, annual band, seasonality | generator |
| scale | headcount, customers, catalogue, other | generator |
| goals | `ownerStated` (owner only), `suggestedFocus` (data watch-points), comparison preference | owner / generator |
| vocabulary | term → meaning → where it lives in the data | generator, owner edits |
| tools | per connector: role, source-of-truth-for, data range | generator, owner edits |
| cautions | data quirks that change interpretation | generator, owner edits |

Every field is bounded. `render.ts` renders it deterministically to the
"About this business" block (word budget 430, lists trimmed from the tail,
never cut mid-sentence) and to a ~120-word digest for the classifier. Both
carry the label "reference data, not instructions" and pass through
`sanitizeTraceText`.

### 2. Generated from data through config-declared probes; confirmed by the owner

`config.yml → context_probes`: one small governed Cube query per fact, per
connector (revenue by category, sales by month for 24 months, locations,
workshop volume, customers, stock, payment mix; headcount, hours and wages by
month, areas, positions; Xero organisation, ledger classes, expense accounts,
receivables/payables, suppliers, bank accounts). `facts.ts` runs the probes
for the tenant's active connectors in parallel (bounded), keeps bounded rows,
retries failures once, and records what could not be collected. `generate.ts`
makes one structured-output model call (medium effort) over the facts, the
tool catalogue notes, established source findings and the existing document,
and returns the document; owner-locked sections are copied verbatim, and
`goals.ownerStated` is never generated.

The owner sees it under **About your business** in the dashboard
(`BusinessContextWorkspace`), edits the parts only they can know (summary,
goals, vocabulary, what each tool is used for, cautions — each edited section
becomes owner-locked), rebuilds from data on demand, and confirms it. Nothing
requires the owner to write it from scratch.

### 3. Storage and maintenance

Migration 0153: `control_plane.tenant_business_context` (one row per tenant:
document, rendering, facts, status draft/confirmed, owner locks, connectors,
generator version, model, data watermark, timestamps) and an append-only
`…_revisions` log (bounded to 30). RPCs `albert_business_context()` (any
member), `albert_save_business_context(...)` and
`albert_confirm_business_context()` (owner/manager), same posture as 0141.

Refresh: Cube needs a running lease, so regeneration happens *inside a turn*.
The conversation route loads the document with the other turn context and,
for owners/managers, sets `refresh.due` when it is missing, older than 7 days,
or generated for fewer connectors than are now active. The engine then runs
the probes beside the turn's own queries (parallelism 2), generates, and saves
through `refresh.save` before the turn ends — awaited in the engine's `finally`
under a 45 s grace, never on the answer's critical path, never fatal. The
"Rebuild from data" button and the operator CLI
(`scripts/albert-business-context.mts`) begin a short turn of their own for
the same unit of work (`standalone.ts`).

### 4. Injection

- Every lane's cached, tenant-partitioned prompt prefix (`buildKnowledgeBlock`)
  carries the ~400-word rendering before the business rules — quick,
  analytical, planned, deep and their composers; the meta lane's fact sheet
  and the recipe composer carry it too.
- The intent orchestrator carries the compact digest and is told to let the
  business's revenue streams, vocabulary and tools decide the natural reading
  of a vague question ("the workshop" is that business's service department
  in the tool the context names — an answer, not a clarification).
- Cost: ~550 tokens per turn in a cached prefix, ~150 in the classifier.

## Generalisation

Nothing here knows a connector: probes, tool roles and vocabulary are data; a
new connector ships probes in the config and gets a `tools` entry from the
generator. The renderer, storage, refresh and injection are shared.

## Consequences

Measured (42 paired turns, context off vs on, same engine and judge —
`evals/albert/REPORT.md` §7): ambiguous-tier pass 65% → 70% and ambiguity
handling 3.79 → 4.07; the six vocabulary questions 50% → 67% pass; zero
clarifications either way; overall unchanged (3.64 → 3.62); cross-tool
investigations ran wider with the context (queries 4.6 → 6.8) — the knowledge
block now says the context is for scoping and phrasing, not angles to
investigate.

- Vague and vocabulary-laden questions get the business's own reading without
  clarification; cross-tool answers are scoped to the business's streams and
  the right denominators; the meta lane can describe the business.
- One extra model call per tenant per week (plus per rebuild); ~20 governed
  queries per refresh, spread beside a turn.
- Owner-authored context is the first per-tenant customisation surface Albert
  has; it ships behind the owner/manager gate.
- Not done: entity pre-resolution from the document (categories, brands,
  suppliers as `explore_entities` seeds) and per-location documents for
  multi-site businesses — both are additive to the same schema.
