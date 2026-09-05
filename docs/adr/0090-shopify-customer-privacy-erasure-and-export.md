# ADR 0090: Shopify customer privacy erasure and export

- Status: Accepted
- Date: 2026-08-12
- Complements: ADR 0087 (Shopify Admin GraphQL ingestion and semantics)

## Context

Shopify requires applications to implement `customers/data_request`,
`customers/redact`, and `shop/redact` and complete requested action within 30
days. Albert's authenticated ingress durably publishes customer privacy work,
but publication is not fulfilment.

Shopify staging and canonical rows are addressable by customer/order identity.
Raw JSONL is deliberately immutable and stored at connection/batch grain. A
single raw object can contain the affected customer alongside unrelated store
records, and the existing raw storage boundary supports exact connection
prefix deletion rather than object rewriting. Claiming customer-only erasure
would therefore be false.

Customer data exports contain protected customer data. They must not be
available through general semantic queries, logged, or declared delivered
merely because an asynchronous job was acknowledged.

## Decision

The existing deletion worker receives least-privilege SECURITY DEFINER
capabilities to claim the Shopify privacy queue. It alternates deletion and
privacy work, records attempts, retries with visibility leases, exposes SLA
metrics, and retains open/failed/overdue cases for operator action.

For `customers/redact`, ingress immediately fences only the exact attested
tenant, connection and generation. The privacy consumer dispatches Albert's
full connection deletion. A case can complete only after a new, same-case,
same-inbox, same-generation deletion request has a verified proof covering
credential destruction, the full raw prefix, all Shopify/generic staging,
canonical/derived analytical data, and control-plane artifacts. Previous
completed deletion requests cannot satisfy a new redaction. Customer/order
references are scrubbed after proof. The cost is deliberate over-deletion and
merchant disruption: reconnect, explicit manual Start, and backfill are
required. Albert truthfully records Shopify remote revocation as unsupported.

For `customers/data_request`, queue dispatch creates a durable per-connection
case in `awaiting_operator_export`. An authenticated internal operator requests
a one-use ten-minute export. The separately deployed operator-diagnostic
runtime consumes a signed tenant capability and executes fixed, parameterized
queries across Shopify customer, order, related typed long-tail and normalized
records, including matching typed `raw_node`, normalized source payload values,
and customer-owned metafield literals with every stored typed/JSON value form.
It returns a no-store JSON artifact and persists only its digest and
record count. A 50,000-record / 32 MiB preflight and final bound fails closed
without truncation; HMAC-only, analytically unresolvable identities remain in
operator attention. This is a secure operator workflow, not automatic customer
delivery. The case remains `awaiting_delivery` until an operator records that
the exact artifact was sent through an approved secure channel; delivery
evidence is append-only. Neither queue receipt nor artifact production alone
marks the case complete.

No runtime receives direct table access, `service_role`, Shopify secrets, or
`auth.*` access. Human functions derive identity from the existing authenticated
extension boundary; machine functions require exact runtime logins.

## Consequences

- Redaction is honest and verifiable across immutable raw storage, at the cost
  of deleting unrelated data for the same Shopify connection.
- Merchants must reconnect and explicitly restart ingestion after customer
  redaction; this limitation is surfaced in operations rather than hidden.
- Data-request artifacts are produced only on explicit operator action and are
  never written to logs or ordinary control-plane tables.
- Open and overdue obligations remain monitorable until proof or delivery;
  retries cannot turn a receipt into fabricated success.
- Customer-grain raw erasure would require a separately reviewed raw-object
  rewrite/index format and is not implied by this decision.

## Official source

- <https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance>
- <https://shopify.dev/docs/apps/launch/protected-customer-data>
