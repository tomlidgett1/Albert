# ADR 0007: Read-only Deputy integration and optional connection-bound webhook ingress

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert engineering
- Supersedes: the earlier automatic Deputy webhook-provisioning decision in this ADR, the Deputy webhook trust assumptions in ADR 0003, and the initial Deputy connector manifest

## Context

The V1 specification locks two requirements that must hold together: Albert never writes to a vendor API, and webhook delivery is only an accelerator because polling and reconciliation are the source of completeness. Creating or updating a Deputy `Webhook` resource during OAuth would violate the first requirement even though it changes integration metadata rather than a roster, employee, or timesheet. It would also make a valid read-only OAuth connection appear degraded when an optional acceleration path was absent.

Deputy documents Resource API reads as `POST /resource/{name}/QUERY`, while `/me` is a `GET`. It also documents manually installed webhooks, custom delivery headers, and three delivery headers: `X-Deputy-Webhook-Callback`, `X-Deputy-Generation-Time`, and, for Enterprise installations with an API-signing private key, `X-Deputy-Secret`. The Enterprise signature is HMAC-SHA256 over the exact request body. Deputy does not document the generation-time header as part of that signature, so freshness narrows the replay window but does not establish event identity.

## Decision

### Keep the connector and OAuth lifecycle strictly read-only

- OAuth completion exchanges and refreshes credentials, discovers the install through `GET /me`, persists the connection, and queues recent-first polling. It performs no webhook list, create, update, or delete request.
- Every non-OAuth Deputy business/resource call made by Albert is either `GET` or `POST` to a URL whose path ends in `/QUERY`. This is an executable contract test, not a convention.
- The connector SDK describes vendor scope-model limitations as least-privilege notes. A broad vendor scope never grants an Albert code path permission to write.
- A successfully authorized Deputy install is `connected`. Its non-secret metadata reports `operator_installation_required` for the optional webhook accelerator, with `scheduled_polling_and_reconciliation` as the completeness mode. Missing webhook installation never degrades authentication, ingestion, readiness, or governed answers.
- Scheduled incremental polling and nightly reconciliation sweeps run whether or not any webhook is installed. Contact remains polling-only because Deputy's action catalogue does not document a Contact webhook action.

### Allow only explicit owner/operator installation

- Albert never calls Deputy's Webhook resource. An owner or operator who chooses the optional accelerator must install or remove the callback in Deputy through an explicit, separate procedure under their own authority.
- Connection-bound verification material may be prepared only for that explicit privileged procedure. The material component has no vendor client and is not composed into OAuth or the sync runtime.
- A callback uses `https://<webhook-host>/v1/webhooks/deputy/<connection-ulid>/<material-ulid>`. Both identifiers are opaque routing identifiers, not authentication credentials.
- The procedure generates a cryptographically random `X-Albert-Webhook-Secret` for exactly one connection. Verification material is AES-256-GCM encrypted with associated data binding tenant, connection, and material identifiers. `DEPUTY_WEBHOOK_ENCRYPTION_KEY` is independent from OAuth-token and Xero-inbox keys.
- The encrypted material lives in `control_plane.deputy_webhook_material`. Browsers, `service_role`, the semantic runtime, and the webhook database role have no direct table access. Any one-time installation-secret reveal belongs in a separately authorized owner/operator workflow and must never be returned by OAuth.
- If an operator separately supplies the installation's Enterprise API-signing private key, ingress requires both the per-connection custom header and Deputy's official raw-body HMAC. Without that key, ingress requires the per-connection secret over TLS and fails closed.

### Resolve narrowly, verify before durability, and deduplicate signed content

- The public route contains the connection and material identifiers. A `SECURITY DEFINER` resolver returns at most that active connection's encrypted verifier; it exposes neither OAuth credential references nor other connection material.
- The gateway decrypts only the resolved envelope and verifies the exact callback header, the connection secret in constant time, and a fresh 10-digit generation time. Enterprise mode additionally verifies `X-Deputy-Secret` over the exact raw bytes before JSON parsing or durable raw-payload storage.
- Because Deputy documents only the body as HMAC-covered, replay identity is `topic + SHA-256(raw body)`. Mutable request IDs, callback headers, and generation-time headers never create a new event identity.
- A verified receipt can enqueue only the fixed Deputy incremental-sync payload allowed by `enqueue_deputy_webhook_sync`. The webhook role cannot call the generic enqueue function or inspect OAuth token references.
- A verified `*.Delete` payload must retain every source Resource `Id`. Those bounded identities are stored on the receipt and carried as tombstone-reconciliation signals in the fixed job. The sync worker lands an identity-only tombstone linked to the exact raw receipt, preserving prior typed fields long enough to retire an existing canonical row when a read-only `/QUERY` can no longer return the deleted Resource. Identity-free delete payloads fail closed.
- Disconnect destroys local verification material before credential destruction. Any later vendor retry fails resolution. Polling and reconciliation continue to recover gaps while the connection is active.

## Consequences

### Positive

- The constitutional no-vendor-write boundary has no Deputy exception.
- A normal human can connect Deputy and receive complete ingestion without vendor permissions or hidden webhook setup.
- Optional webhook absence is visible but does not masquerade as a broken connection.
- Compromise of one callback secret cannot authenticate another tenant or connection, and the webhook database identity cannot inspect OAuth credentials or publish arbitrary jobs.
- Duplicate and replay handling follows the authenticated content Deputy actually documents.
- Hard deletes cannot silently remain active merely because the Resource vanished before the accelerated read.

### Costs and risks

- Changes may appear after the scheduled polling interval when the optional accelerator is not installed. Readiness watermarks disclose that latency.
- Standard custom headers authenticate possession of a high-entropy connection secret but do not cryptographically bind the unsigned generation-time header to the body. TLS, a short freshness window, body-hash idempotency, callback matching, and reconciliation mitigate this; Enterprise HMAC is preferred where available.
- Key rotation retains a bounded current-plus-decrypt-only keyring. Existing manually installed callbacks keep their secret and callback while encrypted local material is rewrapped.
- Deputy does not document a remote OAuth revocation endpoint. Local material and token destruction remains mandatory on disconnect; any manually installed remote callback must be removed by its owner or operator.

## Alternatives considered

- Automatic create/update of Deputy Webhook resources: rejected because any vendor API write violates the locked architecture.
- Treat missing webhook installation as degraded: rejected because optional acceleration does not affect polling completeness or OAuth health.
- One deployment-wide Deputy secret: rejected because one disclosure would permit cross-tenant forgery and prevent connection-scoped rotation.
- Let the webhook gateway read OAuth envelopes: rejected because webhook verification requires no OAuth authority and the trust zones must stay separate.
- Use generation time as the dedupe key: rejected because Deputy does not document it as HMAC-covered.
- Disable Deputy webhook ingress entirely: rejected because optional, manually installed acceleration is useful when it preserves the read-only baseline and connection-bound verification.

## References

- [Deputy webhook overview](https://developer.deputy.com/docs/webhook-overview)
- [Deputy Webhook resource](https://developer.deputy.com/docs/webhook)
- [Deputy webhook action list](https://developer.deputy.com/docs/webhook-action-list)
- [Deputy custom-header representation](https://developer.deputy.com/docs/aws-sqs)
- [Deputy manual webhook setup](https://developer.deputy.com/docs/manually-adding-webhooks-to-a-deputy)
- [Deputy integration and data availability](https://developer.deputy.com/docs/integration-and-data-availability-options)
