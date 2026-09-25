# ADR 0095: Progressive semantic catalogue retrieval and routed tool exposure

- Status: Accepted
- Date: 2026-08-13
- Complements: ADR 0077 (Semantic Execution V2), ADR 0091 (ShopifyQL query
  plane), ADR 0092 (Shopify Admin read plane)

## Context

Albert's V3 runtime currently serialises the complete model-visible Cube
catalogue into every analytical prompt. The catalogue is about 70,000 input
tokens before user history, tool schemas or results. Most turns use one to
three views, so this pays repeatedly for definitions the model neither needs
nor should have to search in-context. Prompt caching can reduce the price of a
stable prefix, but it does not remove the latency, context-window pressure or
cache misses caused by a large tenant- and publication-dependent payload.

This also conflicts with the progressive-discovery architecture in sections 13
and 15 of `docs/albert-v1-spec.md`: catalogue retrieval should return a small,
governed slice for the current question while trusted code retains the complete
semantic contract for validation and execution.

Reducing context must not weaken answerability, permissions, privacy policy,
semantic validation, grounding or the connector-specific query planes. A
smaller prompt is acceptable only when view selection and final-answer quality
are non-inferior to the complete-catalogue baseline.

## Decision

### Progressive catalogue disclosure

The complete catalogue is removed from the normal base prompt. Albert supplies
three progressively richer surfaces instead:

1. A compact view index targets 3,000–5,000 model tokens and contains every
   authorised, route-relevant view's stable name, connector, short purpose and
   key metrics. It contains no exhaustive member definitions.
2. `search_semantic_catalogue(question)` searches the complete authorised
   catalogue in trusted server code and returns a bounded, ranked set of view
   summaries and matching members. Exact view and member identifiers dominate
   looser keyword, synonym and fuzzy matches; ties are deterministic. The
   model cannot provide a physical identifier, alter the search corpus or
   expand its permissions through this tool.
3. `get_view_schema(viewNames)` accepts one to three exact view names and
   returns their complete model-visible definitions losslessly, including
   member types, descriptions, AI context and query/privacy policy. Unknown or
   unauthorised names fail with typed guidance. Per-turn
   discovery calls remain bounded so repeated hydration cannot recreate an
   unbounded prompt.

The source catalogue remains complete in the trusted runtime and its existing
server-side cache. Search and schema responses are derived from the same
catalogue snapshot used by execution. Cache keys must include tenant,
publication/revision, effective permissions and connector availability; no
result may cross those boundaries. Prompt-provider caching is an optimisation,
not a correctness dependency.

Trusted code still validates every proposed view, member, filter, time grain,
aggregation, privacy rule and execution budget against the full authoritative
catalogue. Retrieval output is navigation context only. It does not become an
authorisation or validation boundary, and a search miss never permits a guessed
identifier.

### Deterministic connector routing

Before tool definitions are materialised for a model call, trusted code derives
a connector route from the current question, explicit connector terms,
resolved prior-turn views, active tenant connections and the server-owned
view-to-connector map. Deep-investigation branches are routed independently.
The model sees only the semantic and live-query planes relevant to that route.
This removes unrelated tool descriptions from both token spend and the model's
choice set.

Routing reduces exposure; it never grants access. All tools retain their
ordinary role, tenant, connector, policy and input validation.

- When evidence identifies one connector plane, only that plane and common
  presentation/grounding tools are exposed.
- When a question genuinely spans planes, the deterministic union is exposed.
- When routing is ambiguous or active-connection metadata is temporarily
  unavailable, routing fails open for quality by exposing the plausible
  already-authorised planes. It never fails open across a permission boundary.
- When a selected semantic view has no known connector mapping, execution
  fails closed with a typed configuration error. There is no implicit
  Lightspeed or other default connector.

### Prompt budget

The production base request is the lane instructions, compact index, exposed
tool schemas and structured response schema. It excludes user conversation,
retrieved schemas and tool results, which are separately bounded dynamic input.
The preferred base is at most 12,000 tokens and the hard CI ceiling is 15,000
tokens for every supported routing profile, measured with the production model
tokeniser. The compact index has its own 5,000-token ceiling. A change that
crosses either ceiling cannot merge without an explicit superseding decision.

For OpenAI GPT-5.6 requests, Albert uses explicit prompt caching. A model-neutral
content-block breakpoint sits immediately after the stable lane instructions,
route-scoped tool definitions and structured-output schema. Question-matched
rules, certified-query hints, resolved intent and conversation content sit
after that breakpoint. The request uses `prompt_cache_options.mode=explicit`
with the current 30-minute TTL and a pseudonymous tenant-sharded,
lane-and-route-specific `prompt_cache_key`. The key contains no tenant ID and
is bounded so cache-routing traffic does not collapse all tenants and prompt
profiles onto one hot key. Exact-prefix matching remains the correctness
boundary. OpenAI-only cache fields are never sent to xAI.

Provider usage persistence and logs record uncached input, `cached_tokens` and
`cache_write_tokens` separately. This is required because GPT-5.6 cache writes
are more expensive than ordinary uncached input; a healthy cache must show
later discounted reads that outweigh writes. Cache-hit metrics are observed
separately from uncached token reductions so a reported saving cannot hide a
growing prompt.

## Quality and rollout

Deterministic tests gate:

- compact-index completeness, uniqueness, connector accuracy and token size;
- exact-name, synonym, ambiguous and connector-scoped retrieval, including
  stable ranking under catalogue input reordering;
- lossless schema hydration for every model-visible field and policy, with the
  one-to-three-view limit and permission failures;
- routing for single-plane, mixed, follow-up, unavailable-connection and
  unknown-mapping cases;
- parity of full-catalogue validation, privacy enforcement, grounding and
  persisted query replay; and
- the 15,000-token worst-case base-prompt ceiling using real production tool
  schemas.

Rollout is staged behind a server-owned mode switch. First, the new retriever
and router run in shadow against captured, access-safe prompts. Then paired
model-backed evaluations compare the progressive path with the complete-
catalogue path using identical model profiles, catalogue publications and data
snapshots. Promotion requires no regression in route correctness, expected-view
recall within the first three results, terminal state, numeric answer,
provenance/grounding, privacy outcome or reviewed qualitative answer across the
certified connector and question-class strata. Aggregate averages cannot mask
a failing stratum.

During the bounded rollout window, an audited server-owned kill switch can
restore the legacy complete-catalogue prompt for incident rollback. The switch
does not bypass any validator and is not a silent per-answer fallback. A
retrieval miss produces clarification or unavailable guidance rather than
automatically replaying the expensive path. The legacy renderer and switch are
removed after the observation window and a clean non-inferiority receipt.

## Consequences

- Normal turns no longer consume the roughly 70,000-token complete catalogue;
  expected base input falls by about 80% before any cache discount.
- Relevant definitions arrive in one or more explicit, auditable discovery
  steps, adding a small tool round trip when the compact index is insufficient.
- Tool exposure becomes smaller and less error-prone, while ambiguous questions
  retain answerability through a conservative authorised union.
- Catalogue caching remains valuable, but it moves to the server-side retrieval
  layer instead of paying to serialise the cached object into every model call.
- Cost, cache-hit rate, discovery-call count, retrieval recall, latency and
  quality are release metrics. Cost reduction alone cannot justify promotion.

## References

- `docs/albert-v1-spec.md`, sections 13 and 15
- ADR 0077, Semantic Execution and Analytical Intelligence V2
- ADR 0091, governed on-demand ShopifyQL query plane
- ADR 0092, governed on-demand Shopify Admin read plane
- OpenAI Prompt Caching guide,
  `https://developers.openai.com/api/docs/guides/prompt-caching`
