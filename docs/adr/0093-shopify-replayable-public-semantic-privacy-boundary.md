# ADR 0093: Shopify replayable public semantic privacy boundary

- Status: Accepted
- Date: 2026-08-12
- Complements: ADR 0087 (Shopify ingestion and CubeCore), ADR 0090
  (Shopify erasure/export), ADR 0092 (governed Admin reads)

## Context

Shopify classifies customers, orders, transactions, refunds, fulfilments and
customer/order metafields as protected customer data. This includes all facts
about a single customer, not only direct contact fields. A curated Cube view
that removes email and phone but still returns an order number, customer ID,
tag, tracking value, exact event time or per-customer lifetime fact remains a
protected-data disclosure. Arbitrary merchant text is also unsafe to persist in
model context or replayable answer artefacts because it can contain personal,
confidential or instruction-like content.

Cube's V3 query shape permits a time-typed member in ordinary `dimensions` as
well as in `timeDimensions`. Prompt guidance alone therefore cannot enforce
time bucketing. Requiring an aggregate measure alone is also insufficient: a
high-cardinality breakdown or narrow date range can produce a one-order cell.

This decision applies to replayable public semantic outputs. It does not change
the private raw Cube projections required for source completeness, Shopify
privacy export/erasure, or definition-level schema answerability.

## Decision

Protected Shopify fact views publish a generic metadata-driven query policy:

- `privacy_policy: aggregate_only` requires at least one measure and rejects
  row-only extraction;
- `minimum_time_granularity: day` rejects a time member in ordinary dimensions,
  exact time filters, missing granularity and hour-or-finer buckets;
- measure filters are rejected to reduce value-probing and binary-search
  inference;
- `privacy_minimum_group_size: 5` and `privacy_population_measure` require the
  protected-subject population measure in every query; and
- after Cube returns, Albert rejects the complete result if any row has a
  missing, invalid or sub-five population. This happens before the result can
  enter model context, the per-turn cache, a query/table trace, or Dashboard
  replay. The whole result fails rather than silently presenting an incomplete
  total after removing unsafe rows.

For order and order-line views the population is distinct customer when one is
present, otherwise distinct order. For payment, refund, fulfilment and return
views it is distinct linked order. For the customer population view it is the
customer count. These population measures remain private on the raw cubes and
are exposed only through the curated views for enforcement.

The protected public allowlists omit customer/order/payment/refund/fulfilment/
return identifiers and names, confirmation and legacy IDs, tags, tracking,
transaction-level amounts, line-level amounts/quantities, customer timestamps,
per-customer order counts and lifetime values. Customer analytics exposes only
population aggregates. Time in protected fact results is day-or-coarser.

All replayable Shopify views omit arbitrary merchant-authored product, variant,
SKU, barcode, vendor, category and location labels; descriptions, HTML, tags,
SEO text, URLs/domains, discount titles/codes and shop identifiers are likewise
unavailable. The exhaustive field view publishes official definition and
availability metadata only—never observed values or source-object identifiers.
Metafield views publish aggregate owner/type/access/presence classifications,
not merchant names, namespaces, keys, validation payloads, value fingerprints,
timestamps or literals.

Albert does not rely on the conversation actor's role to make replayable Cube
results safe. Where a current non-protected value is allowed and materially
needed, an owner or manager can use ADR 0092's typed, non-replayable Admin read
plane. That plane continues to deny protected customer members and
unclassified metafield literals. Individual protected records remain
Unavailable outside the separately reviewed privacy export workflow in ADR
0090.

Every source-returned string is untrusted evidence, never an instruction. It
cannot change tool choice, access policy, privacy handling, scope or runtime
instructions.

## Residual boundary

The k=5 rule is deterministic cell suppression, not formal anonymisation. This
release has no noise, cross-query privacy budget or query-history ledger.
Repeated admissible queries can therefore support differencing inferences about
small changes even though no returned cell contains fewer than five protected
subjects. Albert must not claim that these aggregates are anonymous. A future
release requiring a formal anonymity guarantee needs a separately reviewed
privacy mechanism, such as a bounded query ledger and differential privacy.

## Consequences

- Protected customer/order rows and exact timestamps cannot enter ordinary
  conversation evidence or persisted Dashboard artefacts through Cube V3.
- Sparse breakdowns fail closed with guidance to broaden the date range or use
  fewer dimensions.
- Product/SKU/location rankings cannot be persisted from the public Cube
  surface. This is an explicit release boundary, not a synthetic zero or an
  invitation to bypass policy with exhaustive fields.
- Private raw cubes retain complete API field answerability for governed
  ingestion, deletion and operator workflows.
- Certified Shopify queries include the policy population measure and use
  day-or-coarser time buckets.

## Official source

- <https://shopify.dev/docs/apps/launch/protected-customer-data>
- <https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance>
