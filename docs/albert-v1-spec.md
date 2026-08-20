# Albert v1: founding specification for the build agent

August 2026. This document is the complete context for building Albert v1. It is written to be read in full by the build agent before any code is written, and to be kept in the repository as the source of truth (suggested: `docs/albert-v1-spec.md`, referenced from `CLAUDE.md`). Everything here has been settled through three rounds of architectural review; the builder's job is faithful implementation, not redesign. Where a genuine decision remains open, it is listed in section 23 to be raised with Tom, never guessed.

> **V2 supersession (August 2026).** ADR 0077 supersedes the question-time
> model-authored SQL design in sections 15, 16, 23 and 24. Connector ingestion,
> immutable lineage, canonical truth, source authority, tenant isolation and
> signed read-only execution remain constitutional. In V2 the model selects
> semantic objects and analytical operations; trusted code alone constructs
> executable SQL. V1 remains available only as the bounded migration rollback.
>
> **Deployment and V2 release authority.** ADR 0078 makes the Git-connected
> Vercel Next.js project the production web runtime. Vercel's immutable Git and
> deployment system identities bind the web bundle to a release; the earlier
> ChatGPT Sites path is legacy V1 history. V2 release evidence covers only real
> Lightspeed and Xero data and cannot require or claim Deputy qualification.
>
> **Owner review waiver.** ADR 0082 permits an explicit, immutable owner risk
> acceptance to replace only the second Tier 1 semantic approval or subjective
> human scoring for one exact V2 release. It never fabricates human ratings and
> cannot bypass deterministic correctness, tenant isolation, fan-out,
> grounding, evidence, runtime, latency or safety gates.
>
> **Personal live dashboard.** ADR 0083 narrowly amends section 5: Albert may
> expose one private conversation-derived pinboard per user. It is not a BI or
> query-authoring surface. Only tables with explicit trusted replay references
> can be pinned, and every refresh preserves the original governed semantic
> version/publication and immutable source lineage. Conversation remains the
> primary analytical surface. Every Cube refresh runs under its own exact,
> short-lived dashboard claim lease; it never reuses an expired chat turn.
> Every new owner-visible V3 table is a structured replayable artefact. Final
> pivots and cross-query tables use a deterministic derived-table transform over
> immutable governed source events; Markdown-only tables are not produced.
> Per-tile column labels and value formats may be customized only as bounded
> owner presentation metadata; governed values, definitions, digests, and
> replay recipes remain immutable.

**Initial build scope: three connectors (Lightspeed Retail R-Series, Xero, Deputy), the Supabase control plane, and the complete semantic operating system underneath them.** The architecture is designed for 150+ connectors and 20,000 tenants; the initial build implements the final boundaries with the simplest correct implementation behind each.

---

## Part 1: context

### 1. The business problem

Australian small businesses run three to six cloud tools: a POS, an accounting platform, a rostering system, often an ecommerce store and ad accounts. Each tool holds a slice of the truth and reports only on its own slice. The questions owners actually care about sit between the tools: which staff member working today has performed best, is my labour cost eating my margin, did Tuesday's takings reach the bank, which categories should I reorder. Answering those today requires a data team, which a five-person bike shop will never have. Existing BI is enterprise-shaped and priced; each vendor's own AI assistant can only see its own silo. Hundreds of thousands of these businesses are curious but not analytical, and nobody serves them.

### 2. The idea

Albert (Albert.com) is a tool-agnostic conversational analytics platform for small businesses. The owner connects their stack with OAuth. Within roughly thirty minutes their recent data is synced, reconciled across systems, and semantically modelled. Then they ask questions in plain language, in a chat, and get governed, provenance-carrying answers. The chatbot is the interface; the product and the moat is the semantic operating system underneath: a canonical business model every tool maps into, an identity graph resolving the same people, products and places across systems, source authority rules that turn overlapping observations into one truth, and a signed semantic query service that executes only trusted compiler output. Model-authored SQL is a V1 rollback path and is not part of Semantic Execution V2.

### 3. The wedge and the first tenant

Vertical one is Australian independent retail. The first tenant is a Melbourne bike retailer (the founder's own shop) running exactly the initial three connectors: Lightspeed Retail R-Series, Xero and Deputy. Everything in the initial build must work end to end on that real, messy, live data.

### 4. Product promises, stated honestly

- "Ready within the hour" means the most valuable recent, reconciled domains are queryable, with per-domain readiness visible; deep history backfills in the background because vendor APIs impose rate and history limits.
- "Ask anything" means Albert always returns a governed answer, one precise clarification, or an exact statement of what data is missing and what would unlock it. Albert never manufactures a number. No figure in any answer is ever generated by a language model; every figure comes from a logged result returned by SQL that the semantic service validated, tenant-scoped and executed read-only.

### 5. What Albert is not

Not enterprise BI. Not unconstrained text-to-SQL over an ungoverned warehouse. Not a write-back automation tool: Albert never writes to a source system, in any version. Not a dashboard product; conversation is the primary surface, with provenance and calculation detail one tap away.

---

## Part 2: the experience being built

1. Owner signs up, connects Lightspeed, Xero and Deputy via OAuth.
2. Sync begins immediately, recent data first. A readiness panel shows each domain independently: `Sales: ready through 10:42 am. Workforce: ready through 10:38 am. Accounting: backfilling, 63%.`
3. Albert drafts a business dossier from the data (locations, trading hours, seasonality, GST registration, cash or accrual basis from Xero settings) and asks only the blocking questions (section 16). Uncertain cross-system matches ("Is Jess C in Deputy the same person as Jessica Chen in Lightspeed?") appear as tap-to-confirm cards.
4. The owner asks questions in chat. In V2 every answer carries one of six states: **Verified** (certified semantic metrics, validation passed), **Derived** (deterministic analytical computation over governed evidence), **Exploratory** (documented but uncertified source semantics), **Clarification** (one material ambiguity prevents safe interpretation), **No data** (the valid represented query returned no rows), or **Unavailable** (an honest gap statement naming what is missing).
5. Every numerical answer shows its sources, time range, definitions used and data freshness, with "explain this number" walking the full lineage.

---

## Part 3: locked architectural principles

These are constitutional. Any implementation choice that contradicts them is wrong, whatever its local convenience.

1. **Cross-system integration happens through canonical domains, never pairwise connectors.** A connector maps once into Albert's canonical model. No connector ever contains another connector's logic.
2. **Raw source observations are preserved immutably, separate from business truth.** Every API payload is kept, replayable, forever (while the tenant is active). Mapping fixes rebuild from storage, never from the API.
3. **Identity, event linkage and source authority are first-class.** Tools are never joined on display names. Overlapping observations of one economic event are linked, not unioned, and authority is concept-scoped and effective-dated, never a single global source of truth.
4. **Canonical facts contain business truth only.** One row per real economic event. Provenance and observation multiplicity live in bridge tables, not flags on fact rows.
5. **Cross-fact analysis aggregates each fact independently, then aligns on shared dimensions.** Facts at different grains are never joined directly.
6. **Semantic execution is the constitutional V2 question-time architecture.** The LLM owns intent interpretation, semantic-object and operator selection, inspectable hypotheses, and evidence-backed explanation. It never authors executable SQL, joins, physical identifiers, or expression fragments. Trusted code owns tenant scope, join paths, cardinality, grain, additivity, time, currency, deterministic relational planning, parameterized SQL lowering, budgets, read-only execution, validation, evidence lineage and terminal-state eligibility. The signed semantic query service executes compiler-produced plans only; no answer becomes Verified because the model says so. The earlier SQL-first design remains bounded to the V1 rollback window described by ADR 0077.
7. **Tenant nuance lives in structured, versioned overlays** (parameters, synonyms, defaults) with selective human confirmation. Never per-tenant SQL, joins, security rules or forks.
8. **Every fact has exactly one declared grain**, explicit additivity rules, and the compiler never infers either.

**The correctness test.** Physical schemas may evolve through normal migrations. Five invariants must survive every migration, and CI tests them: tenant isolation, immutable lineage, source-neutral canonical meaning, versioned semantic contracts, and backward-compatible query behaviour.

---

## Part 4: system design

### 6. Topology

```
                  ┌─ control plane: Supabase project (Sydney) ─────────────┐
                  │ Auth | tenants | memberships/roles | connections |     │
                  │ oauth token refs | sync runs + cursors | readiness |   │
                  │ dossiers | tenant overlays | semantic publications |   │
                  │ catalogue embeddings (pgvector) | conversations |      │
                  │ answer artefacts | identity review tasks | semantic    │
                  │ inbox | audit log | placement registry (cell 01)       │
                  └────────────────────────────────────────────────────────┘
Vercel web app ─► conversation service ─► agent runtime ─► semantic query service ─► analytical Postgres (cell 01)
                                                                              schemas: source_lightspeed |
                                                                              source_xero | source_deputy |
                                                                              core | mart | quality
sync workers (always-on Node service) ─► connector packs ─► Supabase Storage bucket raw-payloads (immutable, compressed)
                                    └► ingestion manifests + source_* staging (analytical Postgres)
webhook gateway ─► job queue (pg-boss, control plane) ─► sync workers
```

- **Modular monolith plus background workers**, TypeScript throughout, one repository. The web/API app and the workers share modules and deploy as separate processes. The web app is the existing /dash application: every surface in this specification (chat, onboarding, readiness, identity review, and the admin console) is built inside it, from its established component library and design principles. Never introduce a second design system.
- **Web deployment:** the Next.js web/API surface deploys through the pinned
  Vercel project from protected `main`. Vercel system commit/deployment identity
  is authoritative; a mutable environment value cannot relabel a deployment.
  Fly remains the runtime for the separately built service processes.
- **Control plane:** the existing Supabase project (Sydney). Supabase Auth for users. No substantial source or analytical data lives here.
- **Analytical database:** a separate Postgres database from the control plane (a second Supabase project in Sydney is acceptable; any managed Postgres is; the requirement is workload separation plus the role model in section 8). Ingestion and analytical queries must never contend with login and chat.
- **Raw payloads:** a Supabase Storage bucket (`raw-payloads`), S3-compatible, encrypted, immutable, accessed by workers via service credentials only. Keying: `tenant/{tenant_id}/connection/{connection_id}/stream/{stream}/date/{yyyy-mm-dd}/batch-{ulid}.jsonl.gz`.
- **Jobs and scheduling: Supabase-native, no workflow engine.** A Postgres-backed job queue (pg-boss or pgmq) on the control-plane database, pg_cron for schedules, and an always-on Node sync worker service. Durability lives in the data model this spec already mandates: per-stream cursors, the sync ledger and idempotent upserts, so a killed or redeployed worker restarts and resumes from its cursors. Vendor rate budgets are enforced by re-enqueueing with a delay when a budget window is exhausted. Two hard constraints: Supabase Edge Functions are never the worker runtime (their execution time caps are wrong for multi-hour backfills, and self-chaining them is a hand-rolled state machine), and all orchestration sits behind a SyncOrchestrator interface exposing the three job types in section 17, so a workflow engine (Temporal) can swap in later at its named trigger: roughly connector five, or the first cross-stream backfill dependency that hurts.
- **Models:** OpenAI through the official Agents SDK and Responses API behind a provider abstraction, owner-selected Grok 4.6 through the official xAI Responses API (`https://api.x.ai/v1`, model `grok-4.6`), and owner-selected Claude Haiku 4.5 through Anthropic's native Messages API (pinned model `claude-haiku-4-5-20251001`). The server-owned allowlist exposes `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `grok-4.6`, and the pinned Haiku profile. GPT uses native reasoning effort; Grok exposes `low` / `medium` / `high` / `xhigh`; Haiku's six Albert levels map to reviewed manual `thinking.budget_tokens` values because Haiku does not support Anthropic effort. Fast is independent for GPT (`service_tier: "fast"`) and Grok (`service_tier: "priority"`) and unavailable for Haiku. Production GPT traffic uses the approved AU data-residency endpoint and `store: false`; Grok uses `store: false`; direct Haiku is globally routed and requires explicit APP 8 plus organisation-level ZDR approval. No provider's private reasoning appears in Albert's public trace. The sequential user-visible narrative is reconstructed only from audited tool, table, chart, validation, and provenance events (APP 8). See ADRs 0001, 0094 and 0105.
- **Protected capacity promotion:** a candidate cannot attest its own throughput. Production promotion is gated by the independently deployed, immutable-tooling, GitHub-OIDC-bound transform fleet attestor in ADR 0034 and `docs/independent-capacity-attestor.md`; it observes the exact 20,000-tenant Sydney capacity run across Fly, Prometheus, and both databases and supplies the measured Machine floor before any production mutation.

### 7. Storage conventions

- IDs are ULIDs. Every canonical primary key is (tenant_id, id). tenant_id appears on every analytical row, including mapping and quality tables.
- Money is numeric(19,4) with a sibling currency char(3). Exact decimals only, never floats. Monetary components are stored, never recomputed at query time: quantity, unit_price, gross_amount (pre-discount), discount_amount, net_amount_inc_tax, tax_amount, net_amount_ex_tax, unit_cost, total_cost.
- Timestamps are UTC timestamptz. Time roles are preserved separately where they exist: ordered_at, completed_at, fulfilled_at, refunded_at, posted_at, source_updated_at, ingested_at. business_date (date) derives from the tenant's timezone and trading-day cutoff.
- Statuses are text with check constraints against lookup tables, not Postgres enums.
- **Composite indexes lead with tenant_id. No table partitioning in the initial build**; partitioning is a later, measured, per-table decision. The scale seam is the placement registry.
- Every batch written to raw storage gets a manifest row in Postgres: connector version, API version, extraction time, cursor range, content hash, record count, schema fingerprint, payload object keys. Every staged and canonical row carries sync_run_id; staging rows carry their payload batch reference.

### 8. Database roles (analytical)

| Role | Access | Used by |
|---|---|---|
| ingest_rw | ingestion manifests + source_* schemas, read-write | connector workers |
| transform_rw | core, mart, quality, read-write; source_* read | transformation jobs |
| semantic_ro | core and mart read-only, plus read on allowlisted source_* fields | semantic query service |
| diagnostic_ro | read-only everything | internal humans only, never the agent |
| migration owner | DDL only, no runtime access | migrations pipeline |

A compromised connector parser must not be able to touch a canonical fact. RLS exists on tenant-owned control-plane tables and as defence in depth on analytical schemas; tenant scope is always injected by trusted backend code, never supplied by the model. Browsers and models have no path to the analytical database.

### 9. Canonical model

Sixteen dimensions: calendar_day (global; fiscal behaviour via tenant calendar config), location, register, channel (in_store, online, phone), legal_entity, person, customer_account, worker, employment_episode (effective-dated; a rehire is a new episode against the same person), supplier, product, product_variant, product_category (with an effective-dated `product_category_assignment` bridge; the compiler resolves "as currently classified" by default and "as sold" on request), gl_account, tax_code, stock_location. Marketing dimensions (campaign, ad_group) are reserved namespaces, not built.

Thirteen facts, one declared grain each:

| Fact | Grain (one row per...) | Notes |
|---|---|---|
| commerce_order | canonical commercial order | header totals anchor the line_maths invariant |
| commerce_order_line | sellable line on one canonical order | truth only; see section 10 |
| commerce_payment | tender or payment event | |
| commerce_refund_line | refund allocation linked to its original line | subtracts by metric contract |
| inventory_movement | stock quantity-changing event | |
| inventory_balance_snapshot | variant x stock_location x snapshot date | semi-additive: the compiler refuses to sum it across dates; additivity is declared `last_value_over_time` |
| purchase_order_line | supplier PO line | R-Series Orders feed this |
| finance_journal_line | debit or credit journal line | debits equal credits invariant |
| finance_invoice_line | sales invoice or bill line | |
| finance_bank_transaction | bank feed line | |
| workforce_shift | planned work interval | |
| workforce_time_entry | actual worked interval | carries cost where Deputy provides it |
| workforce_leave | leave interval | |

Every fact declaration (in code, as executable configuration) states grain, primary key, cardinality of every relationship, additivity, applicable time roles, and refund, void and reversal behaviour.

### 10. Truth-only facts and the observation bridges

Canonical facts contain one row per real business event and nothing else: no authoritative flags, no duplicate rows, no filter every consumer must remember. Provenance and multiplicity live in bridges:

```
core.order_source_observation (
  tenant_id, order_id,
  connection_id, source_object_type, source_record_id,
  relationship,        -- authoritative | downstream_copy | accounting_posting | settlement
  match_method, confidence_band, valid_from, valid_to
)
core.order_line_source_observation (
  tenant_id, order_line_id,
  connection_id, source_record_id, source_line_ref,
  relationship, allocation numeric null,   -- partial refunds, bundle splits, fee-only lines
  match_method, confidence_band
)
core.event_link (
  tenant_id, link_type,   -- duplicate_of | accounting_posting_of | reversal_of | part_of_batch
  from_ref (connection_id, object_type, source_record_id),
  to_ref   (connection_id, object_type, source_record_id),
  evidence jsonb, rule_version, created_at
)
```

`event_link` is the pre-canonical, source-to-source evidence table the builder populates while deciding; the bridges are the durable product relating source records to canonical rows, many-to-many by construction. Facts keep `primary_connection_id` and `primary_source_record_id` as convenience lineage for the common single-source case. Live cases in the initial build: a Xero daily takings journal observed against many orders (`accounting_posting`), refunds reversing original lines (`reversal_of`), and bank settlements against a day's tenders (`settlement`). The mirrored-order case (Shopify into a POS) arrives with connector four; the structure is ready for it.

### 11. Identity

One generic structure:

```
core.entity_source_link (
  tenant_id, link_id,
  entity_type,          -- worker | location | product_variant | customer_account | supplier
  canonical_entity_id,
  connection_id, source_object_type, source_record_id,
  match_method,         -- external_id | deterministic_key | composite_suggestion | user_confirmed
  match_status,         -- proposed | accepted | rejected | superseded
  confidence_band, valid_from, valid_to, confirmed_by, superseded_by
)
```

The v1 ladder, strongest first: explicit shared or external IDs; exact scoped deterministic keys (work email, employee number, barcode, SKU, ABN); deterministic composite suggestions (normalised name plus a corroborating signal such as shared location); user confirmation in the review UI. **No probabilistic matching in v1**; below the ladder, records stay unlinked and answers disclose coverage. Be conservative even with email and phone: families share numbers, businesses share inboxes, staff get rehired (hence employment_episode). All merges are reversible via superseding rows. Identity is tenant-local, always.

Concrete initial matches: Deputy Employee to R-Series Employee (work email, else name plus shop, else review card); R-Series Customer to Xero Contact (email, else review); Deputy locations and operational units to R-Series Shops (name and address, confirmed at onboarding); products are single-source until connector four.

### 12. Source authority

```
core.source_authority (tenant_id, concept, scope_type, scope_id,
                       authoritative_connection_id, effective_from, effective_to)
```

Shipped defaults for this stack: operational_sales, stock, product_master, customer_master → Lightspeed; statutory_finance, cash_settlement → Xero; planned_shifts, worked_hours → Deputy. Authority is concept-scoped; there is deliberately no "primary system" setting. The canonical builder reads it to pick authoritative observations; the semantic layer reads it to attach warnings when an Exploratory query touches a non-authoritative source for a concept. Onboarding asks about authority only where two connected tools claim the same concept, which with these three connectors is rare by design.

### 13. Semantic layer

**Registry as code.** Metric contracts, Topic definitions, entity and join declarations, and capability requirements live as versioned YAML in `packages/semantic-registry`, validated in CI (schema, join legality, grain compatibility, test coverage) and published as a versioned snapshot to control-plane tables at deploy. Documentation and metric counts are generated from the registry at publish time; hand-maintained counts are banned.

**Five-layer resolution at query time:** canonical core → connector pack → retail industry pack → tenant-approved overlay → current conversation choice. The session layer holds temporary choices without touching stored config. Nothing is ever forked per tenant.

**Metric contract format** (every metric is one of these):

```yaml
id: commerce.net_sales_ex_gst
version: 1
label: Net sales
synonyms: [revenue, sales, takings, turnover]
description: >
  Sum of completed order line net amounts excluding GST, voids and
  internal transactions. Refunds subtract on the day they occur.
ai_context: >
  Default lens for "how are my sales going". "Takings" may mean GST
  inclusive; offer commerce.gross_takings_inc_gst. Do not confuse with
  finance.accrued_revenue, which recognises income on invoice date.
base_fact: commerce_order_line
grain: one_order_line
expression: sum(net_amount_ex_tax)
default_time: completed_at
filters: { order_status: [completed], voided: false }
refund_handling: subtract
aggregation: sum
unit: currency
authority: operational_sales
allowed_dimensions: [business_date, location, register, channel, product.category, customer, worker]
required_capabilities: [commerce.order_lines]
tenant_parameters: []
tests:
  - reconciles_within: { metric: finance.accrued_revenue, tolerance: 0.05 }
```

**V1 registry: 51 contracts** (amended by ADRs 0013 and 0033; the generated domains are commerce 14, customers 7, inventory 7, workforce 6, finance 9, composites 8). The settlement contracts distinguish captured tender from order value and make POS-to-bank variance deterministic; the flagship productivity contract keeps gross-profit-per-worked-hour arithmetic inside the governed aggregate-then-align compiler:

- Commerce: gross_takings_inc_gst, tender_amount, net_sales_ex_gst, units_sold, transactions, avg_order_value, items_per_transaction, discount_amount, discount_rate, refund_amount, refund_rate, gross_margin, gross_margin_pct, sell_price_realisation.
- Customers: active_customers (windowed tenant parameter), purchasing_customers (period-scoped), new_customers, returning_customer_rate, repeat_purchase_rate, avg_customer_value, lapsed_customers (windowed).
- Inventory: stock_on_hand_units, stock_on_hand_value, stock_cover_days, sell_through_rate, inventory_turns, days_out_of_stock, stocktake_variance.
- Workforce: rostered_hours, worked_hours, labour_cost, overtime_hours, average_hourly_cost, roster_adherence.
- Finance: accrued_revenue, cash_receipts, operating_expenses, gross_profit_accounting, net_profit, gst_collected, gst_paid, receivables_outstanding, payables_outstanding.
- Composites: labour_cost_pct_of_sales, sales_per_labour_hour, gross_profit_per_labour_hour, pos_to_ledger_variance, pos_to_bank_variance, gmroi, stock_to_sales_ratio, sell_through_on_hand_pct.

There is no context-free metric named revenue. "Sales" is a tenant-overlay pointer at one explicit lens.

**Topics (8):** sales_performance, customers_retention, inventory_health, workforce_labour, profitability_cash, plus three composites: merchandising (order lines and stock balances aggregated independently, aligned on the product grain), workforce_sales (order lines and time entries aggregated independently, aligned on worker, day, location) and reconciliation (orders, payments, journals and bank transactions aligned on day and location; variances surface as findings). Each Topic declares its base fact or aggregated fact set, approved dimensions and joins, metrics, default filters, required capabilities, freshness requirements, role security, and ai_context with sample questions. Topics and metric contracts are the strongest semantic context, not a restrictive query language. The agent progressively discovers the declared schema, table grains, relationships, field definitions, evidence tiers and connector playbooks needed for the current question.

**Catalogue:** every Topic, metric, field and synonym is embedded (pgvector, control plane) with keyword indexes; retrieval returns a small governed slice per question.

**Tenant overlay** (structured, versioned, audited): timezone, trading-day cutoff, fiscal calendar, tax display default, default metric lenses, churn and active-customer windows, authority selections, location and channel mappings, vocabulary and synonyms, targets. Disallowed: SQL, security rules, joins, tenant filters, core metric changes.

### 14. Semantic Execution V2 query service

The model proposes only registered semantic identifiers and typed workspace mutations. A server-owned, revisioned Query Workspace pins the tenant, semantic publication, overlay, blocks, Topics, measures, dimensions, filters, time semantics, comparisons, sort and limits. No model-provided string becomes an executable identifier, join condition, expression or SQL fragment.

Trusted code validates the workspace, resolves a unique allowed join path, proves grain and fan-out safety, aggregates facts independently, aligns only on declared conformed dimensions, applies bounded calculation contracts, and produces a normalized relational plan. The compiler lowers that plan through Kysely's PostgreSQL dialect with bound parameters. The signed query service runs only compiler output inside a read-only transaction after static allowlist and `EXPLAIN (FORMAT JSON)` cost checks, statement timeout and row limits.

Every execution persists the pinned workspace revision, publication and overlay, normalized plan and compiler hashes, source watermarks, validation evidence and immutable result evidence. Cross-fact analysis always aggregates each fact independently before alignment. Documented but uncertified fields can support Exploratory results; unsupported or ambiguous semantics fail with typed reasons rather than falling back to model-authored SQL.

### 15. The answering model: semantic execution and six terminal states

```
question
  ├─ certified semantic result           → Verified
  ├─ deterministic governed computation  → Derived
  ├─ documented uncertified semantics    → Exploratory
  ├─ one material ambiguity              → Clarification
  ├─ valid represented query is empty    → No data
  └─ cannot be represented safely        → Unavailable
```

Cross-source analysis must use declared composite Topics, source-authority and event-link rules, or independently aggregate each authoritative source before explicit alignment. The model may not improvise identity joins. Unrestricted read-only SQL remains solely `diagnostic_ro` for internal humans and is not an agent tool.

### 16. Agent runtime

**Tools:** semantic context retrieval; create, patch, validate, preview, execute, inspect and fork Query Workspaces; create and update bounded Investigation Plans; run deterministic analytical operators; inspect evidence; and record governed insight dispositions. Atomic workspace mutations remain available for repair, while batch patches are the normal path. No V2 tool accepts SQL or physical identifiers.

**Loop:** classify the question as lookup, comparison, diagnosis, recommendation or open exploration → resolve one material ambiguity when required → create an inspectable hypothesis/evidence DAG with class-specific round, query, duration and cost budgets → execute independent semantic evidence nodes in parallel → adapt only within the bounded plan → run deterministic operators for analysis and opportunity sizing → construct claim-level evidence references → stop as sufficient, inconclusive, no data or unavailable → answer with one of the six terminal states. Persist inspectable analytical state, workspace revisions, immutable evidence, claims, business-context versions and insight identity; never use hidden chain of thought as the audit record.

**Validator (independent of the planner):** semantic-object existence, Topic eligibility, join-path uniqueness, cardinality, grain compatibility, additivity, snapshots, currency, time and source authority; result and claim evidence; competing-hypothesis support for causal language; and quantified opportunity, limitation and controllability evidence for recommendations. Validation derives terminal-state eligibility and the model cannot upgrade it.

### 16.1 Approved Anthropic New Method runtime

> **V2 scope note.** This separately approved runtime is not Semantic Execution
> V2-certified and cannot be used for V2 release qualification or silently
> receive a V2-routed turn. Its SQL-capable contract remains isolated from the
> V2 trust boundary and is governed by its own activation decision.
>
> **V3 topology note (August 2026).** The isolated New Method service was
> retired when V3 became the production source of truth. ADR 0105's selectable
> Haiku model does not revive this SQL-capable runtime; it uses V3's existing
> typed semantic tools and deterministic grounding.

Albert supports a second, method-locked analytics runtime selected only by the
chat action **New Method**. It is a net-new TypeScript system in
`packages/anthropic-analytics`, `services/anthropic-analytics` and
`evals/anthropic-analytics`. It uses the self-hosted Claude Agent SDK with
Claude Opus 5 as primary and Claude Sonnet 5 as an explicitly disclosed
infrastructure fallback. It may not import or adapt the OpenAI agent, planner,
prompts, playbooks or conversation execution loop.

The constitutional boundary is shared, not the agent implementation. The web
route derives actor, tenant and role; the Anthropic service receives signed
turn context; and Claude can reach data only through four typed, in-process MCP
tools for semantic context, the allowlisted 90-table Lightspeed schema,
read-only SQL execution through the signed semantic service, and bounded
analysis checkpoints. It receives no database, Supabase, connector or payload
credential and no filesystem, shell, web, task, subagent, skill, plugin or
auto-memory authority.

Anthropic turns are limited to 20 agent turns, US$3 and 180 seconds, use
adaptive thinking at maximum effort, and return structured output. Every
number must bind to an exact returned result cell. Host code validates cells,
derives the confidence ceiling and converts all provider, validation, timeout,
budget, cancellation and malformed-output failures into one terminal
Unavailable result. Composite, multiple-result and staging analyses receive a
restricted tool-less Opus evidence review; deterministic grounding remains
authoritative. “Always returns a result” means exactly one Verified, Qualified,
Exploratory, Clarification or Unavailable terminal disposition, never a guess.

Agent SDK sessions are opaque, tenant-scoped Postgres mirrors with independent
retention. They are not the public audit record. Ordered trace events and final
artifacts persist synchronously through the existing immutable contracts, with
a provider-discriminated v2 finalization request; OpenAI v1 finalization stays
backward-compatible. Conversation runtime is immutable from the first turn, so
restore, follow-up, retry and cancellation cannot cross methods.

Production activation is separately gated. Direct Anthropic API inference is
for local development only. Production must prove exact Opus 5 and Sonnet 5
profiles on an approved regional Bedrock path in `ap-southeast-2`, approved
APP 8/privacy and ZDR controls, load testing and provider preflight. Missing
regional support fails closed; Australian data is never silently routed to a
global or US endpoint. ADR 0076 records the complete trust and supersession
decision.

**Dossier and blocking questions.** After first sync, draft the dossier (industry, locations, trading hours from the sales histogram, seasonality, GST registration and cash or accrual basis from Xero organisation settings, channels), every inferred statement carrying provenance, confidence and confirmation state. Blocking questions for this stack, asked once at onboarding: does "sales" normally mean including or excluding GST; when does your trading day end; are these Deputy and Lightspeed staff the same people (batch of match cards); are these Deputy areas the same places as these Lightspeed shops; what should "best employee" mean by default; does your POS post daily summary journals into Xero, or line by line. Everything else arrives later as quick in-conversation choices and becomes a default only on explicit confirmation.

**Worked trace (the flagship question).** "Which of my employees working today performed best over the last six months?" → interpret "today" via tenant timezone and cutoff → Query A (workforce_labour): workers with shifts today from Deputy → resolve "performed best" from overlay default or one chip (net sales, gross profit, or gross profit per worked hour), offering to remember → Query B (workforce_sales composite): six-month net sales by worker from Lightspeed lines, R-Series attributes sales to employees via employeeID so coverage should be high, disclose it regardless → Query C: six-month worked hours by worker → align on canonical worker, rank the rostered set → validate identity coverage, attribution coverage, refunds, freshness → answer with definitions and provenance. Never join order lines to timesheet rows.

### 17. Sync design

**Job types, shared by all packs:** `InitialBackfill` (priority order: organisation and shops, employees, products and categories, recent sales and refunds, today's roster and recent timesheets, current inventory, current accounting period, recent customers; then 13 months; then the full available history in slices, back to the start of each account for every stream, marking backfill_complete per stream in the sync ledger; multi-day where vendor rate caps require, for example Xero's daily budget, tracked and visible throughout), `IncrementalSync` (webhook-signalled or scheduled; per-stream cursors; at-least-once with deterministic dedupe on the namespaced source key, upserting only when source version or payload hash changes), `ReconciliationSweep` (nightly: lookback windows for late edits, deletion reconciliation as tombstones, source-total comparisons). All idempotent and resumable; malformed records quarantine to a dead-letter store with the batch reference rather than halting the stream; every run writes the sync ledger.

**Readiness** is a named state machine per tenant x connection x domain: not_started, syncing, transforming, validating, ready_partial, ready_complete, degraded, blocked; surfaced in the UI and injected into agent context.

### 18. Quality gates

Named checks, wired to answers, failing to Qualified or Blocked with the reason attached. Connector: cursor_completeness, scope_available, retention_limit_recorded, webhook_gap_recovered, delete_handling, schema_drift, enum_drift. Canonical: pk_unique, orphan_rate, status_mapping_total, tz_validity, tax_consistency, field_coverage_vs_manifest. Bridges: observation_coverage (every canonical commerce fact has at least one authoritative observation), no_orphan_observations. Domain invariants: line_maths (lines reconcile to order headers), tender_reconciles, stock_continuity, journal_balances, shift_timesheet_coverage, pos_ledger_tolerance. Semantic: no_fanout, grain_compatible_ratios, snapshot_not_summed, authority_respected, golden_fixture_match. Reconciliation variances above tolerance become findings in the reconciliation Topic ("Tuesday's takings are $412 short of the bank deposit"), never silent errors.

### 19. Admin operations console

Internal, operator-facing, cross-tenant, and deliberately built early: during M2 to M5 this console is the primary debugging instrument, and in production it is how a one-person team operates a fleet. It is built inside the existing /dash application, as an operator-gated area (for example /dash/admin) behind an internal_operator role (allowlisted accounts only), using the same components, tokens, layout and design principles as the rest of /dash. It must feel like a native part of the product, not a bolted-on tool.

Two views:

- **Fleet view.** Every tenant x connection as a grid: connector, auth health and token expiry, readiness state per domain, last successful sync per stream, backfill progress, webhook health (last event received, gap recovery status), quarantine counts, failing quality checks, and vendor budget counters (for example Xero API calls used today against the 5,000 daily cap). Degraded and blocked states sort to the top; the healthy fleet is boring by design.
- **Tenant pipeline view.** One tenant's pipeline drawn left to right: connection → streams (cursor positions, last delta) → raw (batch count, most recent batch, bytes, manifest link) → staging tables (row counts, freshness, quarantined rows) → canonical facts, dimensions and bridges (row counts, freshness, invariant status, identity link coverage, observation coverage) → marts → per-domain readiness. Every node clicks through to detail: sync ledger entries, job status and attempt history, quality check results, and the batch manifest trail that is the lineage.

Data sources are strictly existing operational metadata: the sync ledger, batch manifests, stream cursors, the readiness state machine, quality results, and the identity review and semantic inbox queues, plus one addition: a `pipeline_stats` snapshot job (run post-sync and hourly) records per-tenant, per-table row counts and maximum event and ingest timestamps, so the console never runs count(*) against live tables on page load. The console introduces no new write path into the data plane.

Boundaries, consistent with everything above: the browser never touches the analytical database; the console's server-side reads use pipeline_stats and control-plane tables, with drill-downs running as diagnostic_ro; row-level data samples sit behind an explicit reveal action; and because this surface is cross-tenant by nature, every console access and every drill-down is audit-logged. Metadata and counts by default, never customer rows.

### 20. Security and privacy

Least-privilege read-only OAuth scopes; refresh tokens under envelope encryption in the control plane, readable by workers only, never by the app or the model; Albert never writes to a source system. All source text (product names, notes, customer fields) is untrusted data everywhere: rendered as data in prompts and answers, never interpreted as instructions; tool inputs and outputs schema-validated. Tenant scope enforced at every tool boundary by trusted code. Fixed analytical roles receive only short-lived, signed, audience-bound tenant capabilities tied to durable control-plane work; a database credential cannot select a tenant by setting a session variable, and destructive capabilities are one-use and lease-bound. The public webhook database identity cannot self-assert signature verification: independently keyed, one-use HMAC attestations bind the exact verified disposition, while direct receipt and enqueue authority is revoked. In-tenant roles (owner, manager, bookkeeper) implemented as semantic-layer permissions on Topics and metrics; the exploration catalogue respects them and the packs' PII classifications. APP 11 controls; APP 8 handling (AU-region inference preferred, personal identifiers minimised in prompts, aggregates by default); immutable audit on OAuth, data access, semantic changes and queries; disconnection triggers cascading deletion across raw objects, staging, canonical, bridges, links, embeddings and caches within 30 days; cross-tenant isolation tests in CI permanently. Xero contractually prohibits using API data to train AI models; Albert's platform-wide no-training stance is mandatory, not optional.

---

## Part 5: the three connector packs

### 21. The pack contract

Every connector implements one interface: authorize, check_connection, discover_account, list_streams, initial_sync(stream, range), incremental_sync(stream, cursor), handle_webhook(event), refresh_credentials, describe_capabilities. Every pack ships: manifest, OAuth configuration, stream definitions with pagination and cursor rules, rate-limit policy, raw schema, typed source schema, canonical mappings, identity rules, known integration topology, capability manifest, field coverage manifest (every accessible field dispositioned: mapped to canonical, governed source-specific extension, or intentionally unsupported with a reason), PII classification, quality assertions, recorded fixtures, and known limitations. **A pack does not merge without fixtures and passing golden evals.** Exact endpoint and field names below are planning-grade; pin them against current vendor documentation during pack authoring, and record the pinned API version in the manifest.

### 21.1 Lightspeed Retail R-Series

**Verification first:** R-Series and X-Series are entirely different products with entirely different APIs (X-Series is the former Vend). Milestone 3 begins by confirming the shop's account is genuinely R-Series; if it is X-Series, this pack section is replaced, and nothing else in this specification changes.

- Auth: OAuth2 with refresh tokens; account-scoped base URL (`.../API/V3/Account/{accountID}/`).
- Streams: Sale (with SaleLines, SalePayments via load relations), Item, Category (R-Series has a real category tree), Customer, Employee, Shop (location), ItemShop (stock levels by shop), Vendor (supplier identity), Order and OrderLine (supplier purchase orders), PaymentType, TaxCategory.
- Incremental: timestamp filters on modified time per stream; cursor is the high-water mark.
- Rate limiting: leaky bucket with bucket-level and drip-rate response headers; the pack's rate policy honours headers, never fixed sleeps.
- Notable semantics: Sale carries completed and voided flags and an employee reference, so **worker attribution is a full capability** on this stack; returns appear as negative-quantity lines or refund-flagged sales and map to commerce_refund_line with a reversal_of event link; archived items and customers are soft deletes; GST components per line.
- Canonical targets: commerce_order, commerce_order_line, commerce_payment, commerce_refund_line, inventory_balance_snapshot (from ItemShop), inventory_movement (where exposed), purchase_order_line, supplier (Vendor), product, product_variant, product_category, customer_account, worker (Employee), location (Shop), register.
- Capability manifest starter: commerce.order_lines full; commerce.order_lines.worker_attribution full; commerce.order_lines.unit_cost measure from data; inventory.current_stock full; inventory.historical_movements verify against API.

### 21.2 Xero

- Auth: OAuth2 with PKCE; a connection can span multiple Xero organisations (tenants); store the Xero tenant id per connection.
- Streams: Organisation (settings: base currency, GST basis, financial year), Accounts, Contacts, Invoices (AR and AP via type), CreditNotes, Payments, BankTransactions, ManualJournals, Journals (the posted ledger; offset-cursor pagination), TaxRates, TrackingCategories.
- Incremental: If-Modified-Since headers plus paging on most streams; Journals by offset.
- Webhooks: contacts and invoices only; treat as accelerators, poll regardless.
- Rate limits: around 60 calls per minute and 5,000 per day per organisation; app certification unlocks Rapid Sync (rate lift for roughly the first 30 minutes of a new connection) and removes the uncertified 25-connection cap; API usage is now priced, so replay-from-storage rather than re-pull is an economic rule, not just hygiene. Certification is not needed for the dogfood tenant but goes on the roadmap the moment design partners exist.
- Notable semantics: cash versus accrual basis read from Organisation into the dossier; POS daily-summary journals are the live accounting_posting bridge case; bank feeds ground the settlement and reconciliation Topics.
- Canonical targets: gl_account, finance_journal_line, finance_invoice_line, finance_bank_transaction, tax_code, legal_entity, supplier and customer_account (from Contacts, identity-linked to POS customers), commerce_payment allocations where applicable.

### 21.3 Deputy

- Auth: OAuth2; install-specific base URL (`https://{install}.deputy.com/api/v1/`).
- Streams: Employee, Roster (planned shifts), Timesheet (actual worked time, with cost fields where payroll data permits), Leave, OperationalUnit and Company (areas and locations), Contact.
- Incremental: resource query endpoints filtered on modified time; cursor is the high-water mark.
- Webhooks: available for key events; treat as accelerators, poll and sweep regardless.
- Notable semantics: rosters versus timesheets are separate streams and map to separate facts (workforce_shift versus workforce_time_entry), which is exactly what powers rostered-versus-worked analysis; OperationalUnit and Company map to location, confirmed against Lightspeed Shops at onboarding; overnight shifts span business dates, resolved by the trading-day cutoff.
- Canonical targets: worker, employment_episode, workforce_shift, workforce_time_entry, workforce_leave, location.

---

## Part 6: build milestones

Build strictly in this order; each milestone has acceptance criteria that gate the next. Do not build ahead of the gates.

| M | Scope | Acceptance criteria |
|---|---|---|
| M0 | Repo scaffold: monorepo layout (section 22), TypeScript strict, CI, migration pipeline with the migration-owner role, env and secrets handling, job queue and sync worker service wiring | CI green on an empty walking skeleton; migrations run via the pipeline only |
| M1 | Control plane: Supabase schema (tenants, memberships, roles, connections, token refs, sync runs, cursors, readiness, dossiers, overlays, publications, conversations, artefacts, review tasks, inbox, audit, placement registry), Supabase Auth, RLS on tenant-owned tables | Cross-tenant isolation tests pass; a tenant, membership and connection can be created end to end |
| M2 | Ingestion framework: pack SDK interface, raw batch writer to the Storage bucket with manifests, the three sync job types, webhook gateway and queue, quarantine, sync ledger, admin console skeleton (fleet grid over connections, sync runs and batch manifests) | A stub connector syncs fixture data through raw to staging idempotently; a killed backfill resumes from its cursor; both are visible live in the admin console |
| M3 | The three packs to staging: R-Series (after the R versus X verification), Xero, Deputy; recorded fixtures; contract tests | All streams land typed in source_* schemas from fixtures and from the live dogfood accounts; connector quality checks green; full-history backfill runs to completion for the dogfood tenant across every stream of all three connectors (backfill_complete marked per stream), reconciled against source totals where obtainable |
| M4 | Canonical build: dimensions, facts, bridges, event_link, entity_source_link, source_authority defaults, transformation jobs as transform_rw, canonical and bridge quality checks, marts (sales_day_location, labour_day_location), pipeline_stats snapshots and the console tenant pipeline view with invariant status | Domain invariants green on dogfood data and visible in the console, including line_maths, journal_balances, observation_coverage; the Xero daily-posting bridge case works; identity suggestions generated for Deputy and Lightspeed staff |
| M5 | Semantic registry and deterministic query service: governed contracts, layered Topics, schema catalogue, Query Workspace V2, relational-plan compiler, grain and fan-out validation, claim attestation, evidence artifacts, caching and capability gating. **Test this layer independently of any chat** with typed workspace fixtures and governed numeric restatements | Golden numeric results deterministic against publication and plan hashes on fixtures and dogfood data; composite aggregate-then-align plans correct; forbidden operations (fan-out joins, snapshot sums, undeclared objects, unsafe cross-source joins) rejected with structured errors; terminal states derived correctly |
| M6 | Agent and surface: conversation service (streaming), model-owned request interpretation, bounded investigation planner and semantic tools, deterministic operators, six answer states and provenance UI, calculation detail view, web chat inside the existing /dash application | Lightspeed and Xero questions run end to end on dogfood data with correct states and provenance; every executable statement originates from the trusted compiler and runs through the signed semantic service; all new UI uses /dash components and the conventions in docs/ui-conventions.md |
| M7 | Onboarding: OAuth flows for the three vendors, progressive readiness UI, dossier generation, blocking questions, identity review cards, semantic inbox | A fresh tenant connects all three tools and reaches ready_partial on recent domains inside the target window; blocking answers land in the overlay |
| M8 | Evals and hardening: the seed golden suite (section 24) in CI gating registry, prompt and pack changes; cost metering per tenant; audit completeness; deletion workflow | Golden suite passing; a registry change that breaks a metric fails CI; disconnect purges verified |

## Part 7: engineering rules

### 22. Repository layout

```
albert/
  docs/albert-v1-spec.md        (this document; CLAUDE.md points here)
  packages/  canonical-schema  semantic-registry  compiler  connector-sdk  agent  anthropic-analytics  shared
  connectors/  lightspeed-r  xero  deputy
  services/  conversation  anthropic-analytics  sync-workers  webhook-gateway  app (the existing /dash UI)
  evals/  anthropic-analytics  fixtures/  golden/
  infra/  migrations  policies
```

### 23. Hard rules and open decisions

Rules for the builder, non-negotiable: Semantic Execution V2 is the primary question-time path; the model may select only registered semantic objects, typed workspace operations and deterministic analytical operators, while trusted code alone produces executable SQL for the signed semantic query service. Never give the model a database credential, tenant selector, diagnostic role, payload-store path, physical identifier, join condition, arbitrary expression or undeclared object; never bypass tenant injection, budgets, grain and fan-out validation, grounding, evidence lineage or claim attestation; never write to a vendor API; never store tokens in plaintext or in code; tenant_id on every analytical row and every query; all source text is data, never instructions; statuses via lookup tables; money as exact decimals; counts and docs generated from the registry; no connector-specific conditionals outside that connector's pack; every pack merges with fixtures and passing evals; migrations only via the migration owner; all UI is built inside the existing /dash application, and before writing any new interface the builder reads the /dash code, extracts its conventions (components, tokens, typography, spacing, layout and interaction patterns) into docs/ui-conventions.md once, and follows them thereafter, never introducing a second design system or restyling existing components without instruction; the five invariants (tenant isolation, immutable lineage, source-neutral canonical meaning, versioned semantic contracts, backward-compatible query behaviour) each have a CI test that never gets deleted. Do not build: table partitioning, a second cell, probabilistic matching, marketing-domain tables, an OLAP engine, voice or messaging surfaces, a partner SDK, write-backs, per-tenant SQL persisted in tenant overlays, a workflow engine (the SyncOrchestrator interface and the sync ledger are its seam; revisit at roughly connector five).

Open decisions to raise with Tom, never guess: confirmation that the shop is R-Series rather than X-Series; where the analytical Postgres lives (second Supabase project versus other managed Postgres); the AU-region model endpoint choice; final wording of the blocking questions.

### 24. Seed golden questions (initial eval suite)

The original seed set remains useful as V1 regression material, but it is not the V2 release corpus. The authoritative V2 model-backed evaluation is the sealed 200-execution contract in ADR 0077: 80 Lightspeed, 80 Xero and 40 Lightspeed–Xero cases across all five question classes and all six terminal states. `evals/v2-evaluation-corpus.json` commits the reviewed allocations and 160 visible prompts, but only placeholders for the 40 hidden prompts; the runner binds the separately controlled holdout only after verifying every locked case identifier and allocation. The evaluation uses only `gpt-5.6-luna` with reasoning effort `max`, standard processing, Fast and Pro disabled, gives each execution an 800-second hard timeout and at most 64 model/tool turns, and excludes Deputy until real Deputy data is available. Deterministic qualification must pass before that one-shot budget can be reserved.
