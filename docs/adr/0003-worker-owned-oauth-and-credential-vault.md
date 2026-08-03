# ADR 0003: Worker-owned OAuth exchange and credential vault

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert engineering

## Context

Albert must let an authenticated owner connect Lightspeed Retail R-Series, Xero, and Deputy while preserving a stronger boundary than a conventional web callback. The founding specification requires refresh tokens to be envelope-encrypted, readable by workers only, and unreachable by the browser, application UI, analytical model, and semantic query service. Xero can return multiple organisations, refresh tokens may rotate, and all three connectors need resumable initial sync immediately after account selection.

Putting client secrets and token exchange in the Sites web process would make that process a credential reader. Storing a PKCE verifier or OAuth state plaintext in a browser-accessible table would also weaken replay protection. A shared service-role key without a narrower application boundary would turn an accidental web import into broad control-plane access.

## Decision

### Split the public start from the private exchange

- The authenticated web route creates a high-entropy nonce and one-use PKCE verifier for every provider. Lightspeed R-Series and Xero receive an S256 challenge; Deputy's documented flow does not accept PKCE parameters, but keeping the same sealed session-secret shape avoids a weaker provider-specific storage path.
- Browser-safe connector modules build only the vendor authorisation URL. Xero and Lightspeed R-Series receive an S256 challenge bound to the encrypted session verifier. Lightspeed also receives the exact registered redirect URI, and its confidential-client token exchange binds the same redirect URI plus `client_id`, `client_secret`, `grant_type`, code, and verifier. Deputy accepts only its documented non-PKCE code flow. These modules cannot import a client secret or credential vault.
- The web route sends OAuth session metadata and a one-use encrypted session secret to an internal worker endpoint over an HMAC-authenticated request. Its plaintext is sent to a vendor only for the Lightspeed and Xero exchanges. Only a SHA-256 state nonce and an opaque secret reference are stored in `control_plane.oauth_sessions`.
- The signed state token contains tenant, initiating user, provider, redirect URI, expiry, nonce, and OAuth session ID. A short-lived HttpOnly, Secure, SameSite=Lax cookie binds the callback to the initiating browser. Neither contains an access or refresh token.
- The callback validates the authenticated user, tenant, signed state, cookie nonce, expiry, provider, and stored single-use session before the worker exchanges the code.

### Worker-only credential lifecycle

- Connector worker classes own authorisation-code exchange, connection checks, account discovery and selection, refresh, and revocation where the vendor supports it.
- `WorkerCredentialVault` is the only token persistence interface. It exposes create, read, refresh under a durable lease, fenced compare-and-swap rotation, and destroy. It is never exported to a web or model composition root.
- OAuth token material is encrypted with AES-256-GCM using unique nonces and tenant/connection associated data. The database stores ciphertext, authentication metadata, a wrapped/key reference, and version; never plaintext tokens or unwrapped data keys.
- Refresh-token rotation first acquires a durable lease keyed by tenant plus connection (or by the single-use OAuth session before connection finalisation). The lease has a monotonically increasing fencing token, a 45-second crash expiry, a 15-second renewal heartbeat, and a five-minute hard operation deadline. Release is explicit and exact-match; an abandoned lease becomes acquirable after expiry.
- A replica rereads the encrypted credential only after it acquires the lease. If the revision changed while it waited, it consumes the winner's new token and does not call the vendor refresh endpoint again. This is required for rotating refresh tokens such as Xero's.
- The lease proof is checked with `FOR UPDATE` in the same database transaction as compare-and-swap. A delayed worker whose lease expired or was replaced therefore cannot publish even if its vendor HTTP response arrives late. Revision compare-and-swap remains the second line of defence.
- Deletion-worker lease operations are exposed only through active-deletion-claim wrappers. The deletion runtime cannot lease an arbitrary credential by presenting an opaque reference.
- The Sites web service needs public connector IDs and HMAC/state secrets only. Vendor client secrets, token encryption keys, Supabase service credentials, and analytical database credentials exist only in the worker deployment.

### Online token-KEK rotation

- `TOKEN_ENCRYPTION_KEY` is the sole write/current 256-bit AES-KW key and `TOKEN_ENCRYPTION_KEY_ID` is its persisted key ID. Both are canonical and immutable as a pair for a release. `TOKEN_PREVIOUS_ENCRYPTION_KEYS` is an optional JSON object keyed by key ID containing at most four distinct, canonical 256-bit overlap keys. Reused key material, duplicate/current IDs, malformed JSON, padding, and oversized keyrings fail configuration before either worker starts.
- The sync/OAuth and deletion runtimes load the same current-plus-overlap keyring. Overlap keys are unwrap-only. This preserves deletion-time token refresh/revocation while a rolling deployment and online rewrap are in progress; Sites, webhook, semantic, transform, and diagnostic runtimes cannot receive this keyring.
- Sync readiness enumerates both active durable credentials and active OAuth-session envelopes. It fails closed if an active envelope names an unknown logical reference/key ID or if a representative wrapped DEK cannot be unwrapped by the configured material. Key IDs and aggregate counts may appear in worker operational metadata; key values, unwrapped DEKs, and credential material never do.
- Every sync replica runs the same convergent background rewrapper. `FOR UPDATE ... SKIP LOCKED` divides bounded batches between replicas. Each row update compares the prior key locator and wrapped-DEK bytes, then changes only `wrapped_data_key`, `key_reference`, and `key_version`; the token reference's denormalized key version is updated in the same transaction. Credential ciphertext, nonce, authentication tag, AAD digest, credential revision, and OAuth plaintext are never read or rewritten by rotation.
- Each successful row emits an append-only tenant audit event with source/target key IDs, credential version, envelope scope, and explicit evidence that only the wrapped DEK changed. Worker heartbeat metadata records current key ID, loaded overlap count, active-envelope count, pending rewrap count, last rewrap time, and a sanitized failure code.
- Active-envelope partial indexes bound readiness and rotation scans. Historical retired/consumed envelopes are outside the active read contract and are not a reason to retain a KEK.

### Account selection and sync

- If discovery returns exactly one account, the worker selects it, creates the connection, records capabilities, consumes the OAuth session, and enqueues `InitialBackfill` atomically.
- If discovery returns multiple accounts, the worker stores a sanitized choice list and marks the session `selecting_account`. The initiating user chooses through the Connections UI; no credential or selection token appears in the URL.
- Selection is single-use, tenant/user scoped, and expiry checked. The worker then follows the same atomic connection-and-enqueue path.
- Lightspeed discovery must prove the account is R-Series using the V3 account endpoint. An X-Series account fails closed with an exact capability/configuration error.

### Disconnect and deletion

- Disconnect is an explicit owner/manager action with a confirmation dialog.
- Albert first commits an audited deletion request, closes new sync/webhook acquisition paths, and publishes the deletion job in the same database transaction. The deletion worker then invokes Lightspeed's refresh-token revocation endpoint or deletes the selected Xero connection by its connection ID. Deputy documents user-managed consent removal but no remote revocation endpoint. Regardless of remote success, the worker destroys the local credential and completes the durable purge. No web request destroys credential material before a recoverable deletion intent exists.
- Raw objects, source staging, canonical facts/bridges/links, embeddings, results, and caches are purged through scoped idempotent deletion steps within the 30-day policy. A failed step is retried and remains operator-visible.

### Internal transport

Internal HTTP requests are signed over method, path, timestamp, and SHA-256 body digest, with a short clock-skew window. The method/path binding prevents a valid request from being replayed against another internal endpoint. Production services also require private networking or an authenticated ingress; HMAC is not a substitute for TLS or network policy.
The OAuth worker and semantic query service use independent signing secrets, so compromise of an analytical read service cannot authorize credential operations.

## Consequences

### Positive

- A compromise of the browser bundle or normal application route cannot read refresh tokens.
- Rotating refresh tokens remain correct under worker concurrency.
- Worker replicas can scale horizontally without duplicate refresh exchanges; crash recovery is bounded by the short lease expiry rather than process lifetime.
- Xero multi-organisation selection is recoverable and auditable without leaking credentials into redirect URLs.
- Connector packs retain a common credential lifecycle while vendor-specific OAuth and revocation behaviour remains inside each pack. Lightspeed revocation uses its documented `revoke_refresh_token` grant at `/auth/oauth/access_token`.
- Provider-facing request shapes stay pinned to each vendor's documented contract; only Lightspeed and Xero receive their documented PKCE fields.

### Costs and risks

- OAuth completion depends on the internal worker being available; the UI must show a recoverable failed/expired state rather than pretending a connection succeeded.
- Token-KEK rotation needs a staged two-runtime overlap and proof that the active pending-rewrap count reached zero before old material is removed. A key-ID change without that sequence deliberately makes readiness fail.
- Refresh now depends on the control-plane lease ledger. A transient database failure aborts the in-flight vendor exchange and retries durably; it never falls back to an unsafe process-local refresh.
- Lightspeed and Xero remote disconnects can still fail during vendor outages; local credential destruction remains mandatory, the failure is audited, and the UI must direct the owner to the vendor's connected-app settings when manual revocation is required. Deputy always uses this local-destruction/manual-revocation path.
- Service-role and envelope-key bootstrap secrets still need a deployment secret manager; they must never be committed or placed in public Supabase settings.

## Alternatives considered

- Exchange tokens in the web callback: rejected because the application process would receive refresh tokens.
- Store tokens directly in browser-visible Supabase tables under RLS: rejected because RLS is not a worker-only cryptographic boundary.
- Auto-select the first Xero organisation: rejected because it can connect the wrong legal entity and is not reversible without user surprise.
- Use a vendor aggregation platform: rejected for V1 because it would move core connector semantics and provenance outside Albert’s pack contract.

## References

- [Lightspeed Retail R-Series OAuth](https://developers.lightspeedhq.com/retail/authentication/authentication-overview/)
- [Lightspeed refresh-token rotation and revocation](https://developers.lightspeedhq.com/retail/authentication/refresh-token/)
- [Lightspeed R-Series authentication collection](https://www.postman.com/lightspeedhq/r-series-api/documentation/j3gxxum/r-series-authentication)
- [Xero OAuth 2.0](https://developer.xero.com/documentation/guides/oauth2/overview/)
- [Xero granular scopes](https://developer.xero.com/documentation/guides/oauth2/scopes/)
- [Deputy OAuth](https://developer.deputy.com/docs/using-oauth-20)
