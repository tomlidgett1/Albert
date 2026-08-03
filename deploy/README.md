# Albert production runbook

This runbook creates a real Albert environment. It does not enable fixtures, seed customer data, or bypass OAuth. Do not direct users to an environment until every acceptance gate at the end passes.

## 1. Resolve the environment-owned decisions

Record these decisions in the protected deployment environment before provisioning:

1. A new Supabase project in Sydney (`ap-southeast-2`). The currently linked Tokyo development project is not a valid production target for the V1 residency contract.
2. A separate managed PostgreSQL 17 provider and Sydney region for the analytical cell. The founding specification deliberately leaves the provider to the operator; do not silently place analytics in Supabase or another region.
3. Lightspeed Retail **R-Series** registrations. X-Series fails closed because its APIs and semantics are different.
4. An OpenAI project eligible for Modified Abuse Monitoring or Zero Data Retention, using `https://au.api.openai.com/v1`. Regional storage alone is not the V1 privacy approval.
5. Xero application certification/capacity and, if enabled, Advanced Journals approval. Keep `XERO_ENABLE_ADVANCED_JOURNALS=false` until both are documented.
6. A public production origin and the final service hostnames. OAuth registrations and webhook destinations must match them exactly.

## 2. Create the data cells

### Supabase control plane

Create the Sydney project, then use its direct administrator connection for the one-time bootstrap. Enable `pgmq`, `pg_cron`, and `vector` before migration. In API settings, expose `public` only; never expose `control_plane`, `pgmq`, `cron`, `auth`, or `storage`.

Configure Auth with the final Sites origin, callback `/auth/callback`, password recovery callback, email confirmation policy, and production SMTP. Disable anonymous sign-in. Set the password policy and leaked-password protection appropriate to the plan.

The Storage migration creates the private `raw-payloads` bucket. After migration, create three independent S3 access-key pairs: sync, webhook, and deletion. Never use a Supabase service-role key for raw objects.

### Analytical Postgres

Create a private PostgreSQL 17 database in Sydney with encrypted connections, point-in-time recovery, automated backups, deletion protection, and alerts for storage, connections, replication/backup failure, and CPU. The runtime must not share the Supabase database or administrator credential.

Use direct or pooled endpoints according to the provider, but retain transaction semantics and require TLS. Semantic statements have an application timeout; configure a database-side maximum as a second boundary.

## 3. Bootstrap roles and schema

Run this from a controlled operator workstation or one-time CI job. Administrator URLs and generated passwords must exist only in that ephemeral secret context.

```bash
npm ci
npm run migrate -- --target=control-plane --bootstrap
npm run migrate -- --target=analytical --bootstrap
npm run provision:runtime-logins
```

The first two commands create NOLOGIN group roles and apply every immutable migration. The provisioner then reconciles fixed NOINHERIT LOGIN identities, removes unexpected memberships, grants exactly one group per credential, enforces connection/statement/lock timeouts, and never prints passwords.

Required one-time inputs are listed at the end of `.env.example`. Each database URL returned to a runtime must use the corresponding login:

| Deployment use | Login | Required group |
| --- | --- | --- |
| Control migrations / registry | `albert_control_deployer` | `albert_control_migration_owner` |
| Sync/OAuth control | `albert_sync_control_runtime` | `albert_sync_control` |
| Transform control | `albert_transform_control_runtime` | `albert_transform_control` |
| Semantic control | `albert_semantic_control_runtime` | `albert_semantic_control` |
| Webhook control | `albert_webhook_control_runtime` | `albert_webhook_control` |
| Deletion control | `albert_deletion_control_runtime` | `albert_deletion_control` |
| Analytical migrations | `albert_analytical_deployer` | `albert_migration_owner` |
| Sync landing | `albert_ingest_runtime` | `ingest_rw` |
| Canonical transform | `albert_transform_analytical_runtime` | `transform_rw` |
| Semantic query | `albert_semantic_read_runtime` | `semantic_ro` |
| Semantic metadata | `albert_semantic_metadata_runtime` | `semantic_meta_rw` |
| Analytical deletion | `albert_deletion_analytical_runtime` | `deletion_rw` |

Use `sslmode=verify-full` when the provider supplies a trusted CA and hostname; otherwise use the strongest provider-supported required-TLS mode. Never put an administrator URL in a runtime secret.

## 4. Register the vendor applications

Register exact HTTPS callback URLs:

- `https://<origin>/api/oauth/lightspeed/callback`
- `https://<origin>/api/oauth/xero/callback`
- `https://<origin>/api/oauth/deputy/callback`

Register webhook destinations:

- Xero: `https://<webhook-host>/v1/webhooks/xero`
- Deputy: per-connection endpoints created by Albert after OAuth; do not reuse one tenant's secret for another tenant.

Request only the connector scopes declared in each pack manifest. Some Lightspeed R-Series APIs do not offer read-only scope variants; document that residual vendor capability and keep Albert source operations read-only. Complete Xero's connection-limit/certification process before onboarding more than the approved account count.

Perform one vendor sandbox or test-account OAuth cycle before production credentials are installed. Confirm the registered Xero grant type matches `XERO_OAUTH_MODE`; never combine an unregistered PKCE client with a confidential-client secret.

## 5. Create service applications

Create five Fly applications in the same organization. The release workflow passes the app name, so manifests intentionally do not hardcode one.

```bash
fly apps create <semantic-app> --org <org>
fly apps create <sync-app> --org <org>
fly apps create <transform-app> --org <org>
fly apps create <webhook-app> --org <org>
fly apps create <deletion-app> --org <org>
```

Do not allocate a public IP to transform or deletion. The release rejects either private worker if an IP exists. Semantic, sync, and webhook use HTTPS ingress; only health plus signed application routes are served.

Create an app-scoped deploy token for each app and store it in the protected GitHub environment as:

- `FLY_SEMANTIC_API_TOKEN`
- `FLY_SYNC_API_TOKEN`
- `FLY_TRANSFORM_API_TOKEN`
- `FLY_WEBHOOK_API_TOKEN`
- `FLY_DELETION_API_TOKEN`

Set the matching environment variables `FLY_SEMANTIC_APP`, `FLY_SYNC_APP`, `FLY_TRANSFORM_APP`, `FLY_WEBHOOK_APP`, and `FLY_DELETION_APP`.

### Service secret matrix

Set secrets with `fly secrets set --app <app> ...` or the equivalent platform API. Reused names below receive different role-specific URLs or distinct S3 keys in each app.

| App | Required secrets |
| --- | --- |
| Semantic | `CONTROL_PLANE_DATABASE_URL`, `ANALYTICAL_DATABASE_URL`, `ALBERT_SEMANTIC_METADATA_DATABASE_URL`, `ALBERT_SEMANTIC_SIGNING_SECRET`, `OPENAI_API_KEY`, `OPENAI_BASE_URL` |
| Sync/OAuth | `CONTROL_PLANE_DATABASE_URL`, `ANALYTICAL_DATABASE_URL`, sync S3 quartet, `TOKEN_ENCRYPTION_KEY`, `TOKEN_ENCRYPTION_KEY_ID`, `ALBERT_OAUTH_WORKER_SIGNING_SECRET`, `ALBERT_PUBLIC_ORIGIN`, all three vendor client IDs, Lightspeed/Deputy client secrets, Xero webhook key and `XERO_DAILY_REQUEST_LIMIT`, `DEPUTY_WEBHOOK_ENCRYPTION_KEY`, `DEPUTY_WEBHOOK_ENCRYPTION_KEY_ID`, `WEBHOOK_GATEWAY_PUBLIC_URL`, `ALBERT_WORKER_ID` |
| Transform | `TRANSFORM_CONTROL_PLANE_DATABASE_URL`, `TRANSFORM_DATABASE_URL`, `ALBERT_TRANSFORM_WORKER_ID` |
| Webhook | webhook-control `CONTROL_PLANE_DATABASE_URL`, webhook S3 quartet, `XERO_WEBHOOK_SIGNING_KEY`, `WEBHOOK_INBOX_ENCRYPTION_KEY`, `WEBHOOK_INBOX_ENCRYPTION_KEY_ID`, optional `WEBHOOK_INBOX_PREVIOUS_ENCRYPTION_KEYS`, `DEPUTY_WEBHOOK_ENCRYPTION_KEY`, `DEPUTY_WEBHOOK_ENCRYPTION_KEY_ID`, optional `DEPUTY_WEBHOOK_PREVIOUS_ENCRYPTION_KEYS`, optional `DEPUTY_WEBHOOK_MAX_SKEW_SECONDS` |
| Deletion | deletion-control `CONTROL_PLANE_DATABASE_URL`, `DELETION_ANALYTICAL_DATABASE_URL`, deletion S3 quartet, `TOKEN_ENCRYPTION_KEY`, `TOKEN_ENCRYPTION_KEY_ID`, Lightspeed ID/secret and Xero client ID, `DELETION_PROOF_HMAC_KEY`, `ALBERT_DELETION_WORKER_ID` |

The S3 quartet is `SUPABASE_STORAGE_S3_ENDPOINT`, `SUPABASE_STORAGE_S3_REGION`, `SUPABASE_STORAGE_S3_ACCESS_KEY_ID`, and `SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY`.

Set `XERO_DAILY_REQUEST_LIMIT` to `1000` for Starter apps and `5000` for Core
or higher. The sync worker fails closed for any other value so its durable
per-organisation request budget cannot silently exceed the registered tier.

Generate `TOKEN_ENCRYPTION_KEY`, `DEPUTY_WEBHOOK_ENCRYPTION_KEY`, and
`WEBHOOK_INBOX_ENCRYPTION_KEY` independently as exactly 32 random bytes encoded
as canonical, unpadded base64url. For example, generate each value separately
with `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`. Give each key a
stable version identifier. The sync and webhook deployments receive the same
Deputy webhook key, but it must never equal the OAuth token key or Xero inbox
key; the Xero inbox key must also differ from `XERO_WEBHOOK_SIGNING_KEY`. Albert
then generates and encrypts a different vendor-header secret for each Deputy
connection during OAuth. All HMAC/state/proof secrets must contain at least 32
random bytes. Generate independently; never reuse one secret across OAuth,
semantic, user hashing, webhook, deletion proof, or database authentication.

The Xero ingress verifies the signature over the exact request bytes and commits
the encrypted inbox before returning `2xx`; it intentionally performs no tenant
lookup, S3 write, or queue fan-out inside Xero's five-second deadline. Readiness
fails if the leased processor is not running, either database pool is unavailable,
raw storage is unavailable, or any unprocessed inbox row references a key ID not
loaded by the process. For a key rotation, deploy the new primary key and key ID
with the old key in `WEBHOOK_INBOX_PREVIOUS_ENCRYPTION_KEYS` (a JSON object of
`key-id: base64url-key`), wait until readiness and inbox health show no active row
using the old key, then remove the old entry. Never remove a decrypt-only key
while an active inbox row still names it.

Deputy webhook-key rotation uses the same bounded overlap pattern. Deploy the
new key and ID to sync and webhook with the old value in
`DEPUTY_WEBHOOK_PREVIOUS_ENCRYPTION_KEYS`. Sync workers automatically drain
fenced, `SKIP LOCKED` rewrap batches at startup; a concurrent reconnect also
rewraps its own verifier. Neither path changes the vendor header secret or
callback identity. Gateway readiness reports unavailable while an active
material names a key outside the loaded current-plus-previous set. Query the
operator fleet until no non-retired material names the old ID, then remove the
decrypt-only entry and smoke-test one signed callback.

## 6. Configure protected GitHub environments

Create `staging` and `production` environments with required reviewers for production. Add:

Secrets:

- `CONTROL_PLANE_MIGRATION_URL`
- `ANALYTICAL_MIGRATION_URL`
- `OPENAI_API_KEY`
- the five app-scoped Fly tokens above

Variables:

- the five Fly app names above
- `OPENAI_BASE_URL=https://au.api.openai.com/v1`
- `SEMANTIC_QUERY_SERVICE_URL`
- `SYNC_WORKER_INTERNAL_URL`
- `WEBHOOK_GATEWAY_PUBLIC_URL`

The deployment URLs use deployer logins, not database administrators. Protect `main`, require CI, code review, and the production environment approval before running `Release production cells`.

## 7. Release the service cell

Run the `Release production cells` workflow for staging, then production. It performs these gates in order:

1. Full source, contract, evaluation, service image, deployment-manifest, and web build verification.
2. Checksum-locked migrations for both databases.
3. Atomic semantic catalogue and embedding publication.
4. Strict platform validation and rolling deploy of all services.
5. Two Machines per service, private-worker IP verification, platform checks, and public readiness smoke tests.

A failed migration, publication, health check, or private-IP assertion stops promotion. Do not bypass a failed job with a manual deploy.

## 8. Configure and deploy Sites

Set the Sites server environment from the `web` requirements in `packages/config/src/env.ts`. Browser-visible values are limited to `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Server values include the OpenAI key, four web trust-zone secrets, the public origin, service URLs, and public connector client IDs. Vendor client secrets, database URLs, S3 keys, token keys, and deletion keys must be absent.

Deploy Sites only after the service-cell workflow is green. Confirm the generated origin exactly matches Supabase redirects and all three vendor callbacks; update registrations before accepting users if the origin changes.

Supabase project secrets do not automatically become Sites or Fly secrets. Configure each runtime explicitly according to the matrix.

## 9. Human acceptance gate

Use a clean browser profile and a dedicated production-test organisation. Record timestamps, connection IDs, and release SHA without recording tokens or customer payloads.

1. Sign up, confirm email, log out/in, request password recovery, set a new password, and verify the session survives a refresh.
2. Create the organisation and verify a second user cannot access it without membership.
3. Connect Lightspeed R-Series. Confirm wrong-series detection fails closed, the intended account is selected, the initial backfill appears, cursors advance, and readiness becomes partial then complete.
4. Connect Xero. Exercise multi-organisation selection, confirm the chosen tenant only, deliver a signed webhook, and verify a durable incremental sync without duplicate facts.
5. Connect Deputy. Confirm Albert provisions per-connection webhooks, a signed event advances the correct connection only, and replay/cross-tenant attempts are rejected.
6. Ask a governed cross-domain question. Change the model, reasoning effort, and Fast mode. Verify the UI streams ordered natural-language progress, table(s), chart(s), validation, provenance, and a final state; no hidden chain-of-thought or raw SQL appears.
7. Ask an unsupported or ambiguous question. Verify Albert asks one material clarification or returns Unavailable instead of inventing a number.
8. Force a recoverable vendor/semantic error and retry. Verify the prior partial trace is auditable and no duplicate batch, cursor, or usage row is created.
9. Verify light, dark, system theme, keyboard navigation, narrow viewport, and reduced-motion behavior on login, Connections, Chat, and Admin.
10. Disconnect each provider. Verify local credential destruction immediately, remote revocation where supported, future sync fencing, and a durable purge job. Exercise a full tenant deletion in the staging cell and validate the signed proof after control, raw, analytical, semantic, result, and cache counts reach zero.

Production is open to users only when all ten pass against the exact release SHA.

## 10. Operations

### Monitoring

Alert on failed readiness, Machine restart loops, missing worker heartbeats, queue age/depth, lease retries, dead-letter growth, quarantine rate, vendor 401/403/429 classes, webhook signature/replay rejection rate, semantic timeouts, quality invariant failures, OpenAI errors, deletion deadlines, backup failures, and database/storage saturation. Logs are structured and must retain correlation IDs, never secrets or raw exception payloads.

### Backups and recovery

Enable Supabase and analytical point-in-time recovery. Raw objects are immutable inputs, but backup policy must still meet the contractual retention/deletion model. Test restoring both databases into an isolated staging cell, repointing no production callback, rebuilding semantic publication, and reconciling raw manifests. A restore test is incomplete until tenant isolation and deletion tombstones are verified.

### Rotation

- Rotate HMAC/state/user/proof secrets independently, supporting a bounded dual-read window where the protocol requires it.
- Rotate S3 keys one deployment at a time and revoke the old key after readiness and a conditional-write test.
- Rotate database passwords by rerunning the login provisioner, update the one owning deployment, wait for pool turnover/readiness, then continue.
- Rotate the token KEK using a versioned dual-read/rewrap operation before removing the old key. Never change `TOKEN_ENCRYPTION_KEY_ID` without completing the rewrap.
- Rotate the Deputy webhook KEK with `DEPUTY_WEBHOOK_PREVIOUS_ENCRYPTION_KEYS`, automatic fenced batch rewrap, readiness, and a real callback smoke test before removing the old key.
- Vendor secrets and signing keys follow each vendor's overlap/verification procedure and require a real callback/webhook smoke test.

### Rollback

Database migrations are forward-only. If the schema is backward-compatible, redeploy the prior service image and Sites release. Otherwise create and review a forward repair migration. Never edit a migration already present in `albert_migrations.applied_migration`; the runner will reject its changed checksum. Semantic publications are immutable; publish a reviewed replacement rather than mutating documents in place.

### Incident containment

For a suspected process compromise, revoke that app's deploy token, runtime database password, S3 key, and process-owned HMAC/vendor keys; stop its Machines if continued execution risks data. Other process credentials are independent and should be rotated based on evidence, not assumed shared. Preserve correlation IDs and audit rows while excluding customer payloads from incident channels.
