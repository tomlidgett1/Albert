# ADR 0115 — Semantic memory: deterministic learned vocabulary rules

Date: 2026-08-22 · Status: accepted · Migration: 0161

## Context

Albert misread "general service data" as the **Services category** when the
owner meant the **item "Service - General Service"**. The owner corrected it in
chat and the correction evaporated with the conversation. Albert needs to learn
from interactions — but the learning must be generalised (any tenant, any
industry, any connector), deterministic, auditable, and owner-controlled.

The business context layer (ADR 0098) already carries owner prose, including a
free-text vocabulary section. Prose is right for narrative context and wrong
for bindings: a binding must be matched deterministically, applied per-rule,
individually retirable, and validated against the catalogue. Ruled out:
per-tenant fine-tuning (models churn; cost; generalisation risk), raw
transcript injection (noisy, unbounded), embedding retrieval (imprecise,
unauditable at this scale — tenants hold dozens of rules, not thousands).

## Decision

A per-tenant **semantic memory** of structured rules:

```
term: "general service"
meaning: the item "Service - General Service" in Lightspeed product sales
counterMeaning: the whole Services category
binding: { view, dimension, value }        — optional, catalogue-validated
status: proposed | confirmed | retired      · source: albert | owner
```

**Store** — `control_plane.tenant_semantic_memory` (0161), unique per
(tenant, kind, normalised term), 200-rule cap. Membership-scoped SECURITY
DEFINER RPCs: list / save (upsert; a confirmed rule is never silently
downgraded by an automatic capture) / status / delete (owner-manager) /
record-use. Repository: `services/control-plane/src/semantic-memory-repository.ts`.

**Capture** — a new `albert.remember_term` runtime tool. The prompt directs
Codex to call it when the owner corrects an interpretation (trigger
`correction` → stored **proposed**) or explicitly asks Albert to remember
(trigger `owner_request` → stored **confirmed**). The handler validates the
binding view against the tenant's governed catalogue, dedupes per turn, caps at
4, and emits an owner-visible "Albert learned a term" progress step. Proposals
travel back on `CodexSemanticTurnResult.memoryProposals`; the conversation
route persists them after the turn. Vocabulary and preferences only — the tool
description and prompt forbid storing figures, one-off facts, or instructions.

**Recall** — the route loads the tenant's rules each turn and matches the
message with `matchSemanticRules` (normalised token-sequence match with light
plural stemming; confirmed first, longer terms first; max 12). Matches ride
`CodexServiceTurn.semanticMemory` into the turn input as data; a trusted
instruction tells the runtime to interpret matched terms per the rule and say
so in the answer. Matching bumps per-rule usage counters. Rules bind
vocabulary, never facts: every figure still comes from governed result cells,
so a wrong rule can misdirect a query but can never fabricate a number.

**Ambiguity rule (no memory needed)** — when a phrase matches members at two
levels (category vs item) and no rule decides it, the runtime must state the
interpretation it chose and offer the alternative as a follow-up. This turns
silent misreads into one-tap corrections — which are exactly what feeds capture.

**Settings surface** — "Albert's memory" in the dash account menu
(`SemanticMemoryWorkspace`, `/api/semantic-memory`): every rule with meaning,
binding, provenance (learned vs added by hand), usage, and status; confirm /
retire / restore / delete; add a rule manually (stored confirmed).

## Verification (2026-08-22, live against production data)

- Injection: seeded the "general service" rule for the dogfood tenant; the
  runtime answered the original failing question with **one** item-level query
  (`product_sales_analytics`, "Monthly sales performance for the Service -
  General Service item") instead of the category misread.
- Capture: "Remember this: bench fees means…" produced an `owner_request`
  proposal; an unknown binding view and an in-turn duplicate were refused.
- All five RPCs smoke-tested against the production control plane; contract
  tests in `tests/contracts/codex-semantic-memory.contract.test.ts`.

## Consequences

- The codex path is wired end-to-end. The V3 runtime does not yet inject
  `semanticMemory`; the turn field and matcher are runtime-agnostic, so wiring
  V3 is a follow-up, not a redesign.
- Correction capture depends on the model calling the tool; a deterministic
  post-turn extractor over correction-shaped turns is a possible follow-up if
  capture recall proves low.
- Bindings reference catalogue member names; a renamed member leaves a stale
  binding. The meaning text still guides interpretation; injection-time view
  validation and the Settings surface are the pressure valves.
