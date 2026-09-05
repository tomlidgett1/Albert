# Shopify customer privacy operations runbook

This runbook covers Shopify Admin API `2026-07` mandatory
`customers/data_request` and `customers/redact` webhooks. Shopify requires the
requested action within 30 days. A webhook `2xx`, a queue acknowledgement, or
an export digest is not fulfilment evidence.

## Monitor and triage

The production deletion worker claims `albert_shopify_privacy` and publishes
privacy counters at `GET /v1/metrics` and in its heartbeat metadata:
`openCases`, `overdueCases`, `attentionRequired`, `oldestCompleteBy`, and
`visibleQueueMessages`. Alert whenever:

- `attentionRequired > 0`;
- `overdueCases > 0`;
- `oldestCompleteBy` is less than seven days away; or
- queue messages are visible while the worker heartbeat is stale.

Internal operators can list cases with authenticated
`GET /api/admin/shopify-privacy`. Do not paste case payloads, customer/order
identifiers, artifacts, secrets, or exception text into tickets or logs. Use
the case ID and safe error code only.

## Customer redaction

Albert cannot truthfully remove one customer's records from immutable mixed
record raw JSONL objects. The fail-safe implementation therefore fences the
exact attested tenant/connection/generation and uses full connection deletion.
This removes the local credential envelope, the complete raw object prefix,
all `source_shopify` and generic ingestion rows for the connection, canonical
and derived data, caches, indexes, and connection-scoped control state. The
case completes only after the standard deletion proof verifies every store.

This is not transparent operation. Notify the merchant that all Albert data
for that Shopify connection is being erased. After proof completion, they must
reconnect Shopify, explicitly select **Start ingestion**, and rebuild. Never
describe local credential destruction as remote Shopify token revocation.

If the target generation changed, deletion failed, or the deadline is near,
the case is `attention_required`. Do not link an old deletion proof. Resolve
the current generation/connection binding, restore the failed deletion job,
and confirm that the privacy case references a proof requested no earlier than
the webhook and bound to the same case, inbox and connection generation.

## Customer data request

1. List open cases and choose a case in `awaiting_operator_export`.
2. From Albert's authenticated internal-operator session, call
   `POST /api/admin/shopify-privacy/{caseId}/export` with same-origin headers.
   The response is a no-store JSON attachment. Store it only in the approved
   secure delivery system. Do not attach it to ordinary support tickets.
3. Verify the downloaded artifact ID and the
   `X-Albert-Artifact-SHA256` response header against the operator case. Export
   production alone leaves the case in `awaiting_delivery`.
4. Deliver the exact artifact directly to the verified shop owner or through
   the approved secure portal. Verify the recipient out of band according to
   the privacy operations policy.
5. Record delivery with
   `POST /api/admin/shopify-privacy/{caseId}/delivery` and JSON:

   ```json
   {
     "exportId": "01...",
     "deliveryChannel": "approved_secure_portal",
     "deliveredAt": "2026-08-12T04:00:00.000Z"
   }
   ```

Only this final operation creates append-only delivery evidence and marks the
case complete. If artifact generation fails, the one-use grant is failed and
the case returns to `awaiting_operator_export`; request a new export. If the
case is overdue, escalate immediately and preserve the case/evidence records.

The JSON includes queried typed `raw_node` values, matching normalized source
payloads, long-tail field values, and customer-owned metafield literals
(including every stored typed and JSON form) in addition to curated
customer/order columns. It is therefore protected customer data in full, not a harmless
summary. Generation fails closed at 50,000 records or an estimated/actual 32
MiB artifact; it never truncates. An HMAC-only webhook with no Shopify customer
or order identifier is `attention_required` and cannot produce a misleading
empty export. Escalate those cases for a separately verified identity-resolution
procedure; do not record delivery until a real artifact exists.

## Recovery and verification

- Queue claims and redaction dispatch are idempotent. Retry only through the
  worker; do not mutate PGMQ or privacy tables directly.
- A redaction case may reference only a deletion proof created for the same
  privacy case/inbox/generation after webhook receipt.
- A data-request case may complete only when an export outcome has a SHA-256
  digest and row count and matching append-only delivery evidence exists.
- Keep exports out of logs and tracing. Operational evidence contains only
  ULIDs, status/error codes, counts, timestamps and cryptographic digests.

Official source: <https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance>
