# ADR 0007: Deputy webhook provisioning and connection-bound ingress

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert engineering
- Supersedes: the Deputy webhook trust assumptions in ADR 0003 and the initial Deputy connector manifest

## Context

Deputy incremental ingestion cannot depend on a manually configured, deployment-wide shared secret. One shared verifier would let a leaked callback from one customer authenticate traffic for every other Deputy connection, and a webhook edge that can inspect OAuth credential references would unnecessarily join the webhook and OAuth trust zones. Neither is compatible with Albert's tenant isolation or worker-owned credential boundary.

Deputy exposes Webhook resources through its REST API and documents an exact custom-header representation for webhook delivery. Deputy also documents three delivery headers: `X-Deputy-Webhook-Callback`, `X-Deputy-Generation-Time`, and, for Enterprise installations with an API signing private key, `X-Deputy-Secret`. The Enterprise signature is HMAC-SHA256 over the raw request body. Deputy does not document the generation-time header as part of that signature. Therefore timestamp freshness can narrow the replay window, but it cannot by itself establish event identity or make an old body new.

Normal OAuth completion must leave a connection usable even if the Deputy installation cannot create Webhook resources. Permission or vendor-plan/approval failures must be explicit, recoverable states; they must not be represented as a healthy webhook setup and must not destroy a successfully issued OAuth credential.

## Decision

### Provision on normal OAuth completion

- After Deputy account selection and durable OAuth finalisation, the sync worker reconciles one Deputy Webhook resource for every documented Albert-consumed Insert, Update, and Delete topic, plus `Company.Update`. Deputy's current action catalogue does not list Contact, so that stream remains polling- and reconciliation-driven rather than making setup depend on an undocumented trigger.
- The callback is `https://<webhook-host>/v1/webhooks/deputy/<connection-ulid>/<material-ulid>`. Both identifiers are opaque routing identifiers. They are not authentication credentials.
- Albert writes only Deputy Webhook integration metadata. This is the narrowly reviewed exception to the connector pack's read-only business-data rule; no employee, roster, timesheet, leave, contact, company, or operational-unit record is written.
- Existing Webhook resources at the exact callback and topic are reconciled idempotently. A retry reuses the same encrypted verifier and callback instead of creating a new trust identity.
- A short database-backed provisioning lease prevents two OAuth/reconnect requests from racing duplicate vendor writes. Each attempt is fenced by its monotonic attempt number, so a stale failure cannot overwrite a newer successful setup state.
- Webhook provisioning failures mark the connection `degraded`, store a sanitized setup status and reason code, and return a retryable or action-required result from OAuth completion. Initial backfill remains queued because polling is the recovery mechanism and the OAuth connection itself is valid. Reconnecting retries setup.

### Bind verification material to one connection

- Before vendor registration, the sync worker generates a cryptographically random custom-header secret for exactly one Deputy connection.
- The custom header is registered in Deputy's documented newline-delimited `Name: value` form as `X-Albert-Webhook-Secret: <random-secret>`.
- Verification material is AES-256-GCM encrypted with associated data containing tenant, connection, and material identifiers. It uses `DEPUTY_WEBHOOK_ENCRYPTION_KEY`, which must be independent from the OAuth `TOKEN_ENCRYPTION_KEY` and Xero webhook-inbox key.
- The encrypted material lives in `control_plane.deputy_webhook_material`, not in OAuth token envelopes or browser-visible metadata. The browser, `service_role`, semantic runtime, and webhook database role have no direct table access.
- If an operator supplies the installation's Enterprise API-signing private key for that connection, the material records `custom_header_and_enterprise_hmac`; ingress then requires both the connection secret and Deputy's official raw-body HMAC. Without an Enterprise key, ingress requires the unique custom header over TLS and fails closed on every other connection.

### Resolve narrowly, verify before durability, and deduplicate signed content

- The public route contains both connection and material identifiers. A `SECURITY DEFINER` resolver returns at most that active connection's encrypted verifier; it never exposes an OAuth credential reference or any other connection's material.
- The gateway decrypts only the resolved envelope and checks the exact callback header, constant-time connection secret, and a fresh 10-digit `X-Deputy-Generation-Time`. Enterprise mode additionally verifies `X-Deputy-Secret` over the exact raw bytes before JSON parsing or durable raw-payload storage.
- Because Deputy documents only the raw body as HMAC-covered, the dedupe identity is `topic + SHA-256(raw body)`. It deliberately excludes request IDs, callback headers, and generation-time headers. Re-sending the same signed body with mutable headers cannot bypass receipt idempotency.
- A verified receipt can enqueue only the fixed Deputy incremental-sync payload allowed by `enqueue_deputy_webhook_sync`. The webhook role cannot call the generic sync enqueue function or inspect OAuth token references.
- Disconnect destroys the local verification envelope before the OAuth token envelope. Any later vendor retry then fails resolution and cannot be persisted or routed. Scheduled reconciliation continues to recover webhook gaps while a connection is active.

## Consequences

### Positive

- Compromise of one callback secret does not authenticate a second tenant or connection.
- A compromised webhook database identity cannot enumerate encrypted verifier rows, inspect OAuth token references, or submit arbitrary queue payloads.
- Provisioning is automatic, idempotent, auditable, and part of the real OAuth lifecycle rather than an operator-only instruction.
- Duplicate and replay handling is based on the authenticated body identity Deputy actually documents.
- Customers with Enterprise signing keys can layer the official Deputy HMAC over Albert's connection-specific routing secret.

### Costs and risks

- Standard Deputy webhook custom headers authenticate possession of a high-entropy per-connection secret but do not cryptographically bind the mutable generation-time header to the body. TLS, a short freshness window, body-hash idempotency, callback matching, and polling reconciliation mitigate this limitation; Enterprise HMAC is preferred where available.
- Deputy installations may deny Webhook resource creation. Those connections remain polling-capable but visibly degraded until an owner resolves permission or vendor approval and retries.
- Webhook-key rotation uses a bounded current-plus-decrypt-only keyring. Sync workers automatically drain fenced, `SKIP LOCKED` rewrap batches at startup, while reconnect also fences and rewraps its verifier. Neither path changes the vendor secret or callback; readiness prevents removal of an ID still named by active material.
- Deputy does not document a remote OAuth revocation endpoint. Local material and token destruction remains mandatory on disconnect, while obsolete remote Webhook resources may continue to receive a non-success response until removed by Deputy or an administrator.

## Alternatives considered

- One deployment-wide Deputy secret: rejected because it permits cross-tenant forgery after one disclosure and prevents connection-scoped rotation.
- Let the webhook gateway read OAuth token envelopes and discover the account dynamically: rejected because webhook verification does not require OAuth authority and would collapse trust boundaries.
- Use the generation-time header as the dedupe key: rejected because Deputy does not document that header as HMAC-covered and mutable headers must not create new event identities.
- Fail the entire OAuth callback when Webhook creation is denied: rejected because the credential and polling backfill remain useful; a truthful recoverable degraded state is safer than discarding valid consent.
- Require manual Webhook setup for every user: rejected because the V1 product must work after a normal human OAuth connection without hidden operator steps.

## References

- [Deputy webhook overview](https://developer.deputy.com/docs/webhook-overview)
- [Deputy Webhook resource](https://developer.deputy.com/docs/webhook)
- [Deputy Add a Webhook URL API](https://developer.deputy.com/reference/addawebhookurl)
- [Deputy webhook action list](https://developer.deputy.com/docs/webhook-action-list)
- [Deputy custom-header representation (SQS guide)](https://developer.deputy.com/docs/aws-sqs)
- [Deputy manual webhook setup](https://developer.deputy.com/docs/manually-adding-webhooks-to-a-deputy)
- [Deputy integration and data availability](https://developer.deputy.com/docs/integration-and-data-availability-options)
