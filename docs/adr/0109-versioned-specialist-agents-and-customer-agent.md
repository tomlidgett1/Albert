# ADR 0109: Versioned specialist-agent profiles and the Customer Agent

- Status: Accepted (implemented 2026-08-20; production migration/release still
  follows the ordinary protected deployment gates)
- Date: 2026-08-20
- Complements: ADR 0077 (semantic execution), ADR 0095 (progressive catalogue),
  ADR 0097 (recipes), ADR 0098 (business context), ADR 0104 (initial acknowledgement)

## Context

Albert's general V3 agent can answer customer questions, but it starts every
conversation with the same broad semantic index and model-authored intent pass.
Only customer count had a certified fast recipe. Broad customer questions paid
for catalogue discovery and open planning even though the useful scope is known:
customer lifetime behaviour, period sales, products, workshop relationships and
receivables.

The first production test is Ashburton Cycles on Lightspeed R-Series. Its stored
business context reports 9,613 POS customer profiles, 8,714 with purchases and
4,150 previously classified as repeat. Audit found two release blockers:

1. the previous repeat count included every completed transaction, so one
   purchase plus one refund could be labelled repeat and a refund could move the
   first/last "purchase" date; and
2. the ordinary model-visible customer view exposed exact email, phone, street
   address, date of birth, notes and custom-field values without a role-aware
   specialist boundary.

The desired product must generalise to future Inventory, Tax and other agents
without creating per-tenant SQL, a second runtime, or autonomous prompt forks.

## Decision

### 1. A specialist is a versioned profile over V3

`specialist-agents/registry.ts` is the code-owned registry. Each definition has:

- stable id and version;
- allowed organisation roles;
- public UI copy and reviewed starter prompts;
- primary and supporting semantic views;
- preloaded workflow skills and a compact doctrine;
- verified-query priorities; and
- latency/evaluation metadata.

The selected profile biases interpretation, prompt scope, recipes and product
copy. It does not receive a database credential, new tool authority, raw SQL,
source-system write access or a separate execution loop. Every query still uses
V3's signed tenant/turn Cube capability, full catalogue validator, result
grounding, provenance and terminal-state rules. All connected governed views
remain discoverable when a customer question crosses into products, workshop,
finance or another domain.

Every turn persists `specialistAgentId`, `specialistAgentVersion` and a SHA-256
policy digest in `runtime_profile`. A control-plane insert trigger binds the
conversation to its first profile id; history and sidebar projections preserve
the receipt. A restored or edited conversation cannot silently switch agents.
Unknown request ids are rejected. The Customer Agent is available to owners and
managers (and internal operators for support); Cube independently checks the
signed role/profile context.

### 2. Focused prompt disclosure, not reduced authorization

Customer prompts preload the customer-health and customer-strategy doctrine and
keep only the profile's primary/supporting views in the stable compact semantic
prefix. `search_semantic_catalogue` still searches the complete authorized
catalogue. This reduces ambiguity and prompt size without making an unrelated
business question unavailable.

The prompt-cache partition includes pseudonymous tenant shard, profile id and
profile version. General and Customer prefixes therefore never share a cache
identity after their stable instructions diverge.

### 3. Verified starters are a deterministic head path

Each displayed starter is bound to one reviewed certified query. When the
message exactly matches that reviewed prompt, trusted code selects the recipe
without an intent-model call. Paraphrases still use the normal classifier.

Recipes may declare a trusted `answer_template` with exact first-row member
placeholders and allowlisted formats (`integer`, `number`, `percent`, `currency`,
`date`, `text`) plus zero to three static owner-voice follow-ups. Build-time
validation proves every placeholder is selected by the query. Runtime rendering
fails closed on a missing/null/incompatible cell and falls back to the existing
bounded composer. A valid template makes no composer request.

Specialist chats do not wait for ADR 0104's auxiliary acknowledgement call. The
selected-agent hero and immediate V3 progress event already acknowledge the
scope; waiting up to four seconds before starting analysis contradicts the
specialist latency contract. General conversations retain the auxiliary call.

### 4. Correct R-Series customer semantics

The R-Series customer cube aggregates the latest governed sale snapshot once per
tenant/customer in one materialized CTE:

- positive completed, non-voided sales define purchase count, first purchase,
  last purchase and repeat behaviour;
- negative completed sales define refund count/value and never create repeat;
- signed lifetime net spend retains refunds as subtraction;
- purchase value, refund value, activity count and gross profit remain explicit;
  and
- display name falls back from person name to company to `Unnamed customer`.

The sales view publishes identified-versus-anonymous transaction and takings
complements plus coverage percentages. Customer conclusions must state their
attribution boundary. "Profiles" are not claimed to be deduplicated humans.
Fixed 180-day lapsed recipes describe recency only; they are not churn
predictions. Bicycle, workshop and consumables cadences remain separate
hypotheses until evidence supports a relative model.

### 5. Privacy and action boundary

Ordinary replayable customer-bearing views no longer publish customer ids,
email, phone, street address, date of birth, free-text notes or custom-field
values. They retain aggregate contactability flags and broad geography. Names
and company labels may appear only for an explicit owner/manager list/ranking
request. Contactability is not legal marketing consent.

The Customer Agent may propose a read-only experiment or initiative, but cannot
send a campaign, update a source system, enrich a named customer on the web, or
infer sensitive traits. Source/customer text remains untrusted data. Live web
research is not on the default analytical path: it would add latency and create
privacy/provenance ambiguity. Reviewed strategy doctrine may use public primary
sources; any future live strategy tool must require citations and must never
receive customer values.

### 6. "Self-learning" is governed context, not self-modifying semantics

The first version improves through Albert's existing bounded stores:

- current conversation and retained governed results;
- owner-confirmed business context and vocabulary; and
- durable source-topology findings with supersession.

It does not write period figures into source findings, silently change metric
definitions, retain inferred sensitive traits, or promote its own query examples.
New synonyms, recipes and strategy rules must follow propose → evaluate → review
→ version → publish. A later typed agent-context proposal queue may add evidence
references, confidence, expiry, reviewer and supersession, but is not simulated
with unstructured memory in this release.

### 7. Acceleration follows measured topology

No Cube pre-aggregation is added in this release. Production currently has no
Cube Store/refresh worker, uses live-turn capabilities, and creates a per-turn
orchestrator. Anonymous scheduled refresh would violate that boundary. The
immediate acceleration is therefore:

- one-pass lifetime SQL instead of repeated sub-query dimensions;
- focused prompt disclosure and preloaded skills;
- deterministic reviewed starter routing;
- deterministic single-row answer rendering; and
- parallel bounded plans for novel questions.

Cube Store, customer-month/cohort rollups and a dedicated short-lived refresh
capability require a separate measured ADR, deletion/privacy integration and a
background refresh worker. Rollup-only mode is not acceptable because novel
customer questions must retain the governed source fallback.

## Evaluation and release gates

The customer corpus is separate from the formal ADR 0077 qualification. It runs
`gpt-5.6-luna`, reasoning `max`, with Fast enabled as an explicit profile and
records full traces. It covers:

- purchase-versus-refund and lifetime-versus-period semantics;
- counts, repeat rate, top/lapsed/value/geography/contactability and attribution;
- customer/product/workshop and Xero-receivables boundaries;
- duplicate profiles, anonymous sales, empty results and stale data;
- named-customer and PII/adversarial requests; and
- off-domain access and multi-turn restore.

Release requires zero tenant/role/privacy/write-back failures, zero unexplained
figures, deterministic reconciliation invariants, correct recipe selection, and
no regression in the general profile. Latency is reported by path (verified,
ad-hoc, deep) with p50/p95, Cube execution, model requests, tokens and retries;
targets are evidence to validate, never claims inferred from a single warm run.

## Consequences

- A reviewed Customer starter can reach Cube without intent classification and
  can answer a one-row result without any model request.
- Novel questions still retain Albert's general analytical reach and safety
  boundary, with customer evidence and methodology first in context.
- Customer repeat/recency figures change intentionally because refunds no longer
  masquerade as purchases; old snapshots are historical evidence, not goldens.
- High-risk contact/free-text fields disappear from ordinary chat even if a
  prompt asks for them.
- Existing general conversations restore as profile `general`; specialist
  conversations are durable and immutable by profile id.

## Primary references

- Google Looker specialized agents and golden queries:
  https://docs.cloud.google.com/looker/docs/conversational-analytics-overview
- Microsoft semantic-model scope and verified answers:
  https://learn.microsoft.com/en-us/fabric/data-science/semantic-model-best-practices
- Snowflake reviewed verified-query suggestions:
  https://docs.snowflake.com/en/user-guide/views-semantic/verified-query-suggestions
- OpenAI latency and prompt caching:
  https://developers.openai.com/api/docs/guides/latency-optimization and
  https://developers.openai.com/api/docs/guides/prompt-caching
- Cube caching/pre-aggregations:
  https://docs.cube.dev/docs/pre-aggregations/index
- OAIC APP 3 and direct marketing guidance:
  https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines/chapter-3-app-3-collection-of-solicited-personal-information
  and https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines/chapter-7-app-7-direct-marketing
