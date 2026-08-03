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

After control-plane migrations, generate an independent 32-byte webhook proof key, set `WEBHOOK_ATTESTATION_KEY_ID` and `WEBHOOK_ATTESTATION_SECRET` on the webhook gateway, and install the same material with `CONTROL_PLANE_MIGRATION_URL=... npm run provision:webhook-attestation-key`. The protected release workflow performs this installation after migrations and before deployment. The parameterized provisioner never prints key material. Gateway readiness stays closed until the database key and Fly secret agree.

Configure Auth with the final Sites origin, callback `/auth/callback`, password recovery callback, email confirmation policy, and production SMTP. Disable anonymous sign-in. Set the password policy and leaked-password protection appropriate to the plan.

The Storage migration creates the private `raw-payloads` bucket and installs the
ADR 0031 policy boundary. Do **not** create generated S3 access keys: Supabase
documents that they bypass Storage RLS and grant full object authority. Albert
uses three dedicated Auth users and short-lived S3 session credentials instead.
Retain the project's legacy anon JWT for the S3 envelope because Supabase
publishable keys are not S3-session compatible. The legacy anon JWT is still
secret deployment material and never belongs in Sites or browser code.

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
npm run provision:raw-storage-machine-users
npm run provision:analytical-capability-key
npm run provision:webhook-attestation-key
```

The first two commands create NOLOGIN group roles and apply every immutable migration. The login provisioner then reconciles fixed NOINHERIT LOGIN identities, removes unexpected memberships, grants exactly one group per credential, enforces connection/statement/lock timeouts, and never prints passwords. The raw-storage provisioner uses protected Auth Admin plus direct `postgres` authority to create or rotate exactly three machine users, bind their IDs to the generation-fenced policy mapping, and prove their real S3 sessions with non-customer readiness objects. The capability provisioner connects to both databases before changing either, installs the analytical verifier first and the control-plane signer second, verifies identical SHA-256 fingerprints without printing key material, and requires both readiness checks to pass. A fresh environment is not service-ready until all six commands succeed.

The raw-storage provisioner requires
`SUPABASE_AUTH_URL`, `SUPABASE_AUTH_ADMIN_SERVICE_ROLE_KEY`,
`CONTROL_PLANE_ADMIN_DATABASE_URL`, the direct Storage S3 endpoint/region,
project reference as the S3 access key ID, the legacy anon JWT, a positive
`ALBERT_RAW_STORAGE_CREDENTIAL_GENERATION`, and three distinct 32-to-256-byte
machine passwords. Auth Admin, administrator URL, and generation are
provisioner-only. The sync Fly app receives only the sync password, webhook only
the webhook password, and deletion only the deletion password. Reusing a
generation is idempotent and does not rewrite passwords; a lower generation is
rejected.

Use one independent 32-64 byte HMAC secret for the analytical capability keyring. Set `ANALYTICAL_CAPABILITY_KEY_ID`, `ANALYTICAL_CAPABILITY_SECRET_BASE64`, `ANALYTICAL_CAPABILITY_ACTIVE_AT`, and `ANALYTICAL_CAPABILITY_RETIRE_AT` only in the protected provisioning context. Do not add them to Fly or Sites. The exact runtime logins can request capabilities only for live control-plane turns, queue attempts, transform leases, diagnostic reveals, or deletion leases; they cannot read the keyring or select an arbitrary tenant with `albert.tenant_id`.

The control bootstrap requires the exact direct `postgres` login. It applies
`infra/bootstrap-upgrades/control-plane/` after recording the base bootstrap
and before activating the NOLOGIN migration owner. Those administrator
upgrades have their own exact-prefix SHA-256 ledger; they are the only supported
way to add a fixed extension-owner capability to an existing environment.
For every routine release, use the protected administrator secret to run this
step immediately before ordinary migrations:

```bash
CONTROL_PLANE_ADMIN_DATABASE_URL='postgresql://postgres:...@.../postgres?sslmode=verify-full' \
  npm run bootstrap:upgrade:control-plane
npm run migrate
```

The administrator command never reads or changes the one-time base-bootstrap
checksum. Never put `CONTROL_PLANE_ADMIN_DATABASE_URL` in a runtime app, and do
not run the ordinary migration stream before the administrator-upgrade gate.

An environment created before ADR 0017 must rerun the reviewed control-plane
role bootstrap once before migration 0030, then rerun the login provisioner to
create both diagnostic logins. Routine release migrations intentionally cannot
create runtime roles.

Required one-time inputs are listed at the end of `.env.example`. Each database URL returned to a runtime must use the corresponding login:

| Deployment use | Login | Required group |
| --- | --- | --- |
| Control migrations / registry | `albert_control_deployer` | `albert_control_migration_owner` |
| Sync/OAuth control | `albert_sync_control_runtime` | `albert_sync_control` |
| Transform control | `albert_transform_control_runtime` | `albert_transform_control` |
| Semantic control | `albert_semantic_control_runtime` | `albert_semantic_control` |
| Operator diagnostic control | `albert_operator_diagnostic_control_runtime` | `albert_operator_diagnostic_control` |
| Webhook control | `albert_webhook_control_runtime` | `albert_webhook_control` |
| Deletion control | `albert_deletion_control_runtime` | `albert_deletion_control` |
| Analytical migrations | `albert_analytical_deployer` | `albert_migration_owner` |
| Sync landing | `albert_ingest_runtime` | `ingest_rw` |
| Canonical transform | `albert_transform_analytical_runtime` | `transform_rw` |
| Semantic query | `albert_semantic_read_runtime` | `semantic_ro` |
| Operator row diagnostics | `albert_operator_diagnostic_analytical_runtime` | `diagnostic_ro` |
| Semantic metadata | `albert_semantic_metadata_runtime` | `semantic_meta_rw` |
| Analytical deletion | `albert_deletion_analytical_runtime` | `deletion_rw` |

Use `sslmode=verify-full` when the provider supplies a trusted CA and hostname; otherwise use the strongest provider-supported required-TLS mode. Never put an administrator URL in a runtime secret.

### Capability key rotation

Create a new random secret and a never-reused key id. Keep the current key active while the replacement is installed. Set the replacement activation and retirement timestamps, then also set `ANALYTICAL_CAPABILITY_PREVIOUS_KEY_ID` and `ANALYTICAL_CAPABILITY_PREVIOUS_RETIRE_AT`; the previous retirement must be at least ten minutes in the future and at least five minutes after replacement activation. Run the dual-cell command without `--target`:

```bash
openssl rand -base64 32
npm run provision:analytical-capability-key
```

The command installs/verifies the replacement analytical verifier first, then the control signer. It shortens the old control signing window before shortening analytical verification to the identical timestamp, so a partial failure can leave verification available longer but can never leave the signer ahead of the verifier. Retry the same idempotent command after any interruption. Expired key material is pruned on a later successful provisioning run, after the maximum five-minute token lifetime and an additional ten-minute safety margin. Never change the secret behind an existing key id; the database rejects key-id reuse.

## 4. Register the vendor applications

Register exact HTTPS callback URLs:

- `https://<origin>/api/oauth/lightspeed/callback`
- `https://<origin>/api/oauth/xero/callback`
- `https://<origin>/api/oauth/deputy/callback`

Register webhook destinations:

- Xero: `https://<webhook-host>/v1/webhooks/xero`
- Deputy: optional per-connection endpoints are installed explicitly by an owner/operator in Deputy after preparing connection-bound verification material. OAuth never creates or updates them, and one connection's secret is never reused for another.

Request only the connector scopes declared in each pack manifest. Lightspeed
pack 1.1.0 requires both `employee:vendors` and `employee:purchase_orders` for
attributable purchase-order ingestion. A pre-1.1 connection without the Vendor
grant must report `inventory.purchase_orders` unavailable and be re-consented
by an owner before Vendor backfill and Order replay; never bypass the capability
failure. Some Lightspeed R-Series APIs do not offer read-only scope variants;
document that residual vendor capability and keep Albert source operations
read-only. Complete Xero's connection-limit/certification process before
onboarding more than the approved account count.

Perform one vendor sandbox or test-account OAuth cycle before production credentials are installed. Register Xero with the **Auth Code with PKCE** grant type used by this V1 build; the worker intentionally rejects confidential-client configuration and never accepts a Xero client secret.

## 5. Create service applications

Create six Albert runtime applications and two metrics-autoscaler applications
in the same Fly organization. The release workflow passes app names, so the
manifests intentionally do not hardcode one.

```bash
fly apps create <semantic-app> --org <org>
fly apps create <sync-app> --org <org>
fly apps create <transform-app> --org <org>
fly apps create <webhook-app> --org <org>
fly apps create <deletion-app> --org <org>
fly apps create <operator-diagnostic-app> --org <org>
fly apps create <sync-autoscaler-app> --org <org>
fly apps create <transform-autoscaler-app> --org <org>
```

Do not allocate a public IP to transform or deletion. The release rejects either private worker if an IP exists. Semantic, sync, and webhook use HTTPS ingress; only health plus signed application routes are served.

Create an app-scoped deploy token for each app and store it in the protected GitHub environment as:

- `FLY_SEMANTIC_API_TOKEN`
- `FLY_SYNC_API_TOKEN`
- `FLY_TRANSFORM_API_TOKEN`
- `FLY_WEBHOOK_API_TOKEN`
- `FLY_DELETION_API_TOKEN`
- `FLY_OPERATOR_DIAGNOSTIC_API_TOKEN`
- `FLY_SYNC_AUTOSCALER_API_TOKEN`
- `FLY_TRANSFORM_AUTOSCALER_API_TOKEN`

Set the matching environment variables `FLY_SEMANTIC_APP`, `FLY_SYNC_APP`,
`FLY_TRANSFORM_APP`, `FLY_WEBHOOK_APP`, `FLY_DELETION_APP`,
`FLY_OPERATOR_DIAGNOSTIC_APP`, `FLY_SYNC_AUTOSCALER_APP`,
`FLY_TRANSFORM_AUTOSCALER_APP`, and `FLY_ORGANIZATION_SLUG`.

Create a deploy token scoped to each target worker app for the corresponding
autoscaler and store them as `FLY_SYNC_SCALING_TOKEN` and
`FLY_TRANSFORM_SCALING_TOKEN`. Create one organization read-only token as
`FLY_PROMETHEUS_READ_TOKEN`. The protected release installs these only into
the autoscaler apps; they are never present in an Albert runtime.

### Service secret matrix

Set secrets with `fly secrets set --app <app> ...` or the equivalent platform API. Reused names below receive different role-specific URLs. The three storage apps share only the project session coordinates and receive distinct purpose passwords.

`deploy/runtime-contract.json` is the machine-readable source of truth for the
runtime boundary. The release gate reads the secret *names* from each Fly app,
requires the declared set, and rejects undeclared or deployment-owner material
before any migration runs. Secret values are never returned to CI.

| App | Required secrets |
| --- | --- |
| Semantic | `ALBERT_CONTROL_PLANE_PROJECT_REF`, `CONTROL_PLANE_DATABASE_URL`, `ANALYTICAL_DATABASE_URL`, `ALBERT_SEMANTIC_METADATA_DATABASE_URL`, `ALBERT_SEMANTIC_SIGNING_SECRET`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ALBERT_MODEL_DATA_CONTROL_APPROVED` |
| Sync/OAuth | `ALBERT_CONTROL_PLANE_PROJECT_REF`, `ALBERT_LIGHTSPEED_PRODUCT`, `CONTROL_PLANE_DATABASE_URL`, `ANALYTICAL_DATABASE_URL`, `SUPABASE_STORAGE_S3_ENDPOINT`, `SUPABASE_STORAGE_S3_ACCESS_KEY_ID`, `SUPABASE_STORAGE_S3_LEGACY_ANON_KEY`, `ALBERT_RAW_STORAGE_SYNC_PASSWORD`, `TOKEN_ENCRYPTION_KEY`, `TOKEN_ENCRYPTION_KEY_ID`, `ALBERT_OAUTH_WORKER_SIGNING_SECRET`, `ALBERT_PUBLIC_ORIGIN`, all three vendor client IDs, Lightspeed/Deputy client secrets, `XERO_DAILY_REQUEST_LIMIT`; optional `TOKEN_PREVIOUS_ENCRYPTION_KEYS` during rotation |
| Transform | `ALBERT_CONTROL_PLANE_PROJECT_REF`, `TRANSFORM_CONTROL_PLANE_DATABASE_URL`, `TRANSFORM_DATABASE_URL` |
| Webhook | `ALBERT_CONTROL_PLANE_PROJECT_REF`, webhook-control `CONTROL_PLANE_DATABASE_URL`, `SUPABASE_STORAGE_S3_ENDPOINT`, `SUPABASE_STORAGE_S3_ACCESS_KEY_ID`, `SUPABASE_STORAGE_S3_LEGACY_ANON_KEY`, `ALBERT_RAW_STORAGE_WEBHOOK_PASSWORD`, `XERO_WEBHOOK_SIGNING_KEY`, `WEBHOOK_ATTESTATION_KEY_ID`, `WEBHOOK_ATTESTATION_SECRET`, `WEBHOOK_INBOX_ENCRYPTION_KEY`, `WEBHOOK_INBOX_ENCRYPTION_KEY_ID`, `DEPUTY_WEBHOOK_ENCRYPTION_KEY`, `DEPUTY_WEBHOOK_ENCRYPTION_KEY_ID` |
| Deletion | `ALBERT_CONTROL_PLANE_PROJECT_REF`, deletion-control `CONTROL_PLANE_DATABASE_URL`, `DELETION_ANALYTICAL_DATABASE_URL`, `SUPABASE_STORAGE_S3_ENDPOINT`, `SUPABASE_STORAGE_S3_ACCESS_KEY_ID`, `SUPABASE_STORAGE_S3_LEGACY_ANON_KEY`, `ALBERT_RAW_STORAGE_DELETION_PASSWORD`, `TOKEN_ENCRYPTION_KEY`, `TOKEN_ENCRYPTION_KEY_ID`, Lightspeed ID/secret and Xero client ID, `DELETION_PROOF_HMAC_KEY`; optional `TOKEN_PREVIOUS_ENCRYPTION_KEYS` during rotation |
| Operator diagnostic | `ALBERT_CONTROL_PLANE_PROJECT_REF`, `OPERATOR_DIAGNOSTIC_CONTROL_PLANE_DATABASE_URL`, `OPERATOR_DIAGNOSTIC_ANALYTICAL_DATABASE_URL`, `ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET` |

The Fly manifests lock `SUPABASE_STORAGE_S3_REGION=ap-southeast-2`. The endpoint
must be `https://<project-ref>.storage.supabase.co/storage/v1/s3`, the access key
ID must equal the selected project ref, and the S3 secret-access-key field is
supplied internally from `SUPABASE_STORAGE_S3_LEGACY_ANON_KEY`. The provider
signs in the exact machine user and supplies its short-lived access JWT as the
AWS `sessionToken`. Generated `SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY` material,
Auth Admin credentials, another purpose's password, and any undeclared name are
release errors. See ADR 0031 and `deploy/runtime-contract.json`.

The six Albert runtime manifests are explicit; those whose processes claim leases set
stable, non-secret worker-role prefixes. At runtime Albert appends Fly's
immutable `FLY_MACHINE_ID` before claiming
or renewing any lease. A non-Fly deployment must supply a unique
`ALBERT_WORKER_INSTANCE_ID` to every replica. This prevents horizontally scaled
workers from sharing a lease owner or releasing one another's work.

Set `XERO_DAILY_REQUEST_LIMIT` to `1000` for Starter apps and `5000` for Core
or higher. The sync worker fails closed for any other value so its durable
per-organisation request budget cannot silently exceed the registered tier.
`XERO_WEBHOOK_SIGNING_KEY` is ingress-only material: provide it to the webhook
gateway and never to the sync/OAuth worker.

Generate `TOKEN_ENCRYPTION_KEY`, `DEPUTY_WEBHOOK_ENCRYPTION_KEY`, and
`WEBHOOK_INBOX_ENCRYPTION_KEY` independently as exactly 32 random bytes encoded
as canonical, unpadded base64url. For example, generate each value separately
with `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`. Give each key a
stable version identifier. The webhook gateway and separately authorized
Deputy installation procedure receive the Deputy webhook key; the sync/OAuth
runtime does not. It must never equal the OAuth token key or Xero inbox key,
and the Xero inbox key must also differ from `XERO_WEBHOOK_SIGNING_KEY`. The
explicit installation procedure generates and encrypts a different vendor
header secret for each Deputy connection without calling a Deputy API. All
HMAC/state/proof secrets must contain at least 32 random bytes. Generate
independently; never reuse one secret across OAuth, semantic, user hashing,
webhook, deletion proof, or database authentication.

`TOKEN_PREVIOUS_ENCRYPTION_KEYS` is a canonical JSON object of
`key-id: base64url-key`, with no more than four entries. It is an overlap
keyring, despite the historical `PREVIOUS` name: it may temporarily carry the
next key as decrypt-only before that key is promoted. The current ID cannot be
present in the object, and no two IDs may reuse key material. Configure the
same token keyring on sync/OAuth and deletion; never configure it on Sites or
another service.

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
new key and ID to the webhook gateway with the old value in
`DEPUTY_WEBHOOK_PREVIOUS_ENCRYPTION_KEYS`, then run the privileged local
material-rewrap procedure. This changes neither the manually installed vendor
header secret nor callback identity and performs no Deputy API call. Gateway
readiness reports unavailable while active material names a key outside the
loaded current-plus-previous set. Remove the decrypt-only entry only after no
non-retired material names the old ID, then smoke-test one signed callback.

## 6. Configure protected GitHub environments

Create `staging` and `production` environments with required reviewers for production. Add:

Secrets:

- `CONTROL_PLANE_ADMIN_DATABASE_URL` (direct protected `postgres` login; required only by the pre-migration administrator-upgrade gate)
- `ANALYTICAL_ADMIN_DATABASE_URL` (direct protected analytical administrator login; required only by runtime-login and capability provisioning)
- `CONTROL_PLANE_MIGRATION_URL`
- `ANALYTICAL_MIGRATION_URL`
- `SUPABASE_MANAGEMENT_TOKEN` with project-read access only
- `OPENAI_API_KEY`
- `SUPABASE_AUTH_ADMIN_SERVICE_ROLE_KEY` (legacy service-role JWT; protected provisioner only, never a runtime secret)
- `SUPABASE_STORAGE_S3_LEGACY_ANON_KEY` (legacy anon JWT required by the S3 session protocol; never Sites/browser configuration)
- `ALBERT_RAW_STORAGE_SYNC_PASSWORD`, `ALBERT_RAW_STORAGE_WEBHOOK_PASSWORD`, and `ALBERT_RAW_STORAGE_DELETION_PASSWORD` (independent machine secrets)
- `ANALYTICAL_CAPABILITY_SECRET_BASE64`
- `WEBHOOK_ATTESTATION_SECRET`
- all database-login passwords named in `.env.example` (`ALBERT_CONTROL_DEPLOYER_DB_PASSWORD` through `ALBERT_DELETION_DB_PASSWORD`, including both operator-diagnostic passwords)
- the six app-scoped Fly tokens above

Variables:

- the six Fly app names above
- `ALBERT_CONTROL_PLANE_PROJECT_REF` for the newly created Sydney project
- `ALBERT_CONTROL_PLANE_REGION=ap-southeast-2`
- `ALBERT_ANALYTICAL_REGION=ap-southeast-2`
- `SUPABASE_STORAGE_S3_REGION=ap-southeast-2`
- `SUPABASE_STORAGE_S3_ENDPOINT=https://<project-ref>.storage.supabase.co/storage/v1/s3`
- `ALBERT_RAW_STORAGE_CREDENTIAL_GENERATION` as a positive, monotonically increasing integer
- `ALBERT_MODEL_DATA_RESIDENCY_REGION=au` (regional storage; Australia is not currently an OpenAI regional-processing location)
- `ALBERT_MODEL_DATA_CONTROL_APPROVED=true` only after MAM/ZDR approval is recorded
- `ALBERT_LIGHTSPEED_PRODUCT=r-series` only after the R-versus-X decision is confirmed
- `ANALYTICAL_CAPABILITY_KEY_ID`, `ANALYTICAL_CAPABILITY_ACTIVE_AT`, and `ANALYTICAL_CAPABILITY_RETIRE_AT`; add the previous-key variables only during a reviewed rotation
- `WEBHOOK_ATTESTATION_KEY_ID`
- `NEXT_PUBLIC_SUPABASE_URL`, `ALBERT_PUBLIC_ORIGIN`, `OPENAI_BASE_URL`,
  `SEMANTIC_QUERY_SERVICE_URL`, `OPERATOR_DIAGNOSTIC_SERVICE_URL`, `SYNC_WORKER_INTERNAL_URL`, and
  `WEBHOOK_GATEWAY_PUBLIC_URL`
- `ALBERT_SNAPSHOT_P95_MS`; staging may use a reviewed diagnostic baseline,
  but this value is not production capacity attestation

The deployment URLs use the exact `albert_control_deployer` and
`albert_analytical_deployer` logins, require TLS, and target different
databases. The Supabase management token lets the preflight verify the selected
project's actual region and health; a text label is not accepted as residency
proof. Record the analytical provider and Sydney-region evidence in the
environment review because that provider remains an explicit V1 decision.
Protect `main`, require CI, code review, and the production environment approval
before running `Release production cells`.

## 7. Release the service cell

Run the `Release production cells` workflow for staging, then production. It performs these gates in order:

1. Full source, contract, evaluation, service image, deployment-manifest, and web build verification.
2. Exact-SHA release preflight: actual Supabase project region/health, explicit
   R-Series and AU data-control decisions, clean HTTPS origins, distinct
   least-privilege migration logins, and unique app targets.
3. Stage only the exact RLS-session coordinates and purpose password in each
   storage app, then validate every Fly secret inventory before DDL.
4. Reviewed administrator bootstrap upgrades, immediately before ordinary migrations.
5. Checksum-locked migrations for both databases, after the preflight only.
6. Exact runtime-login reconciliation; generation-fenced Auth machine-user
   provisioning plus real S3 sentinel proof; verifier-first dual-cell analytical
   capability installation; and webhook attestation installation. No service
   deploy starts before all four succeed.
7. Atomic semantic catalogue and embedding publication.
8. Strict platform validation and rolling deploy of all services, including the independently signed operator diagnostic boundary.
9. Two Machines per service, private-worker IP verification, platform checks,
   and exact-SHA public readiness smoke tests.
10. Connector-pack parity and compatibility-replay preflight, followed by one
    atomic database activation. An incomplete candidate stops promotion while
    the predecessor remains query-visible; a fresh empty environment runs the
    same gate and activation rather than receiving an implicit shortcut.
11. A protected Sites promotion gate that waits for `/api/health` to report the
   compile-time workflow SHA, the exact deployment attempt, and matching
   readiness identities from every web dependency. The release workflow cannot
   finish green while an old, relabelled, mixed, or unhealthy revision serves.

A failed migration, publication, health check, or private-IP assertion stops promotion. Do not bypass a failed job with a manual deploy.

### Connector-pack activation and inactive connections

Migration 0095 stages Lightspeed 1.1.0 beside active 1.0.0. Candidate workers
must publish every predecessor capability and governed field, the required
Vendor/Order evidence, and the migration-0096 compatibility replay gate before
the release can switch query visibility. The protected workflow executes both
commands after the new worker revision is healthy:

```bash
ANALYTICAL_MIGRATION_URL='postgresql://albert_analytical_deployer:...@.../analytics?sslmode=verify-full' \
  npm run connector-pack:activate -- \
  --connector=lightspeed-r --candidate=1.1.0 --expected-active=1.0.0 --check
ANALYTICAL_MIGRATION_URL='postgresql://albert_analytical_deployer:...@.../analytics?sslmode=verify-full' \
  npm run connector-pack:activate -- \
  --connector=lightspeed-r --candidate=1.1.0 --expected-active=1.0.0
```

The first rollout may stop at this gate while existing accounts backfill. That
is safe: pack 1.0.0 remains active and the newly deployed workers continue
building isolated 1.1.0 evidence. Re-run the protected release after every
eligible connection is complete. Repeating activation after success is
idempotent and returns the original activation event.

If a predecessor connection was durably disconnected, or its tenant has an
approved deletion in progress, retire that exact connection from candidate
parity with the dual-cell verifier:

```bash
CONTROL_PLANE_MIGRATION_URL='postgresql://albert_control_deployer:...@.../postgres?sslmode=verify-full' \
ANALYTICAL_MIGRATION_URL='postgresql://albert_analytical_deployer:...@.../analytics?sslmode=verify-full' \
  npm run connector-pack:retire-connection -- \
  --tenant=01... --connection=01... --connector=lightspeed-r \
  --candidate=1.1.0 --expected-active=1.0.0
```

Do not supply a reason, audit id, or digest. The command locks and verifies the
exact control-plane lifecycle and append-only audit, derives and rechecks its
own SHA-256 evidence while the control rows remain locked, and only then commits
the analytical exception. An expired or broken live credential is not eligible;
repair, re-consent, or durably disconnect it. See ADR 0042.

## 8. Configure and deploy Sites

Set the Sites server environment from the `web` entry in
`deploy/runtime-contract.json`. Browser-visible values are limited to
`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Server
values include the OpenAI key, five web trust-zone secrets, the public origin,
service URLs (including `OPERATOR_DIAGNOSTIC_SERVICE_URL`), public connector client IDs, the verified project/region and
model approvals, `ALBERT_CONVERSATION_RUNTIME=live`,
`ALBERT_ALLOW_FIXTURE_RUNTIME=false`, the full release SHA in
`ALBERT_SERVICE_VERSION`, and a unique `ALBERT_DEPLOYMENT_ID`. Vendor client
secrets, database URLs, raw-storage session material, token keys, migration credentials, and deletion
keys must be absent.

The operator console never receives a database URL. Its explicit row reveal
uses the independent `ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET`; the same
secret is installed only in Sites and the operator-diagnostic app. Create the
two diagnostic runtime logins with `npm run provision:runtime-logins`, then
verify the app's `/readyz` at the exact release SHA before enabling reveals.
Every reveal must create requested and completed/failed entries in the
append-only operator audit log. See ADR 0017.

Build and deploy the exact workflow SHA through the Sites project in
`.openai/hosting.json` after the service smoke jobs pass, while the workflow's
final protected web gate is waiting. Set `ALBERT_BUILD_SHA` to that full source
SHA in the protected build context (GitHub Actions supplies `GITHUB_SHA`
automatically). `next.config.ts` compiles this value into the bundle. Set the
runtime `ALBERT_SERVICE_VERSION` to the same SHA and `ALBERT_DEPLOYMENT_ID` to
`${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}`. Its `/api/health` must return ready,
the embedded `releaseSha`, and that exact deployment id; it also parses bounded
JSON from sync, semantic, and diagnostic readiness and requires each to report
the same pair. Changing Sites environment values cannot relabel an old bundle.
Only then can the release workflow finish green and acceptance begin.

The same identity rule applies to Fly. The protected workflow passes
`ALBERT_BUILD_SHA=${GITHUB_SHA}` as a Docker build argument, compiles that
literal into every service and capacity-harness bundle, and records it as the
OCI revision label. `ALBERT_BUILD_SHA` is intentionally absent from the
runtime environment. Each service compares its embedded identity with
`ALBERT_SERVICE_VERSION` before opening a listener and reports only the
embedded value from `/readyz`; changing Machine environment values cannot make
an older image pass release readiness.

Confirm the generated origin exactly matches Supabase redirects and all three
vendor callbacks; update registrations before accepting users if the origin
changes. A service release and a different Sites source revision are not one
production release.

Supabase project secrets do not automatically become Sites or Fly secrets. Configure each runtime explicitly according to the matrix.

## 9. Human acceptance gate

Use a clean browser profile and a dedicated production-test organisation. Record timestamps, connection IDs, and release SHA without recording tokens or customer payloads.

1. Sign up, confirm email, log out/in, request password recovery, set a new password, and verify the session survives a refresh.
2. Create the organisation and verify a second user cannot access it without membership.
3. Connect Lightspeed R-Series. Confirm wrong-series detection fails closed,
   the intended account is selected, the Vendor stream completes before its
   dependent Order stream, and a real purchase order joins to the named
   canonical supplier. Confirm initial backfill appears, cursors advance, and
   readiness becomes partial then complete.
4. Connect Xero. Exercise multi-organisation selection, confirm the chosen tenant only, deliver a signed webhook, and verify a durable incremental sync without duplicate facts.
5. Connect Deputy. Confirm OAuth and complete recent-first ingestion succeed through polling without any Webhook-resource API call. Verify the UI reports optional owner/operator installation without degrading the connection. If the optional callback is manually installed, confirm a signed event advances only the bound connection and replay/cross-tenant attempts are rejected.
6. Ask a governed cross-domain question. Change the model, reasoning effort, and Fast mode. Verify the UI streams ordered natural-language progress, table(s), chart(s), validation, provenance, and a final state; no hidden chain-of-thought or raw SQL appears.
7. Ask an unsupported or ambiguous question. Verify Albert asks one material clarification or returns Unavailable instead of inventing a number.
8. Force a recoverable vendor/semantic error and retry. Verify the prior partial trace is auditable and no duplicate batch, cursor, or usage row is created.
9. Verify light, dark, system theme, keyboard navigation, narrow viewport, and reduced-motion behavior on login, Connections, Chat, and Admin.
10. Disconnect each provider. Verify the durable intent and future-sync fence commit immediately, then verify credential destruction meets the enforced 15-minute deadline, remote revocation is attempted where supported, and the purge job completes with evidence. Exercise a full tenant deletion in the staging cell and validate the signed proof after control, raw, analytical, semantic, result, and cache counts reach zero.

Production is open to users only when all ten pass against the exact release SHA.

## 10. Operations

### Monitoring

Alert on failed readiness, Machine restart loops, missing worker heartbeats, queue age/depth, lease retries, dead-letter growth, quarantine rate, vendor 401/403/429 classes, webhook signature/replay rejection rate, semantic timeouts, quality invariant failures, OpenAI errors, claimed diagnostic reveals without outcomes, diagnostic signature failures, deletion deadlines, backup failures, and database/storage saturation. Logs are structured and must retain correlation IDs, never secrets, sampled rows, or raw exception payloads.

Sync and transform Machines expose Prometheus metrics only on the private
metrics port configured in their Fly manifests. Page immediately when
`albert_sync_queue_sla_breached` or `albert_transform_queue_sla_breached` is
non-zero for two scrapes, or when the relevant oldest-age gauge remains above
300 or 120 seconds. Fly's pinned metrics autoscalers maintain a two-Machine
floor and scale to at most 40 Machines from queue depth, queue age, and (for
transform) the number of tenants due for an hourly snapshot. A release only
restores a missing two-Machine floor; it never destroys capacity created by
the autoscaler.

Each Machine runs eight bounded lanes and claims one lane-sized snapshot batch
at a time. The arithmetic ceiling remains 40 Machines, but a single process
cannot prove that 40 processes will scale linearly against the shared control
and analytical databases. The repository harness is therefore a run-scoped
diagnostic only. It exercises the real signed snapshot, cross-database
projection, dossier, retention, and lease-completion path, but always emits
`measurementScope: "single_process_diagnostic"` and
`releaseEligible: false` with the unresolved limitations.

### Repeatable transform-capacity diagnostic

Use a dedicated Sydney staging cell containing only non-customer test tenants.
Before running, quiesce ordinary staging snapshot workers and seed at least 500
due tenants. This manual prerequisite makes the diagnostic repeatable enough
for engineering comparison, but it is one reason it is not release evidence.
Use only `albert_transform_control_runtime` and
`albert_transform_analytical_runtime` URLs. The harness independently enforces
the production TLS, Sydney-region, selected-control-project, exact-login,
separate-database, eight-lane, and eight-claim-batch boundaries even when the
operator shell's `NODE_ENV` is unset.

Supply the transform service's production-boundary variables, a unique run id,
and approval bound to the exact candidate SHA:

```sh
export ALBERT_CAPACITY_ENVIRONMENT=staging
export ALBERT_CAPACITY_MODE=load
export ALBERT_CAPACITY_MIN_SAMPLES=500
export ALBERT_CAPACITY_MAX_CLAIMS=20000
export ALBERT_CAPACITY_RUN_ID="${GITHUB_RUN_ID:-operator}-${GITHUB_RUN_ATTEMPT:-1}"
export ALBERT_WORKER_INSTANCE_ID="capacity-${ALBERT_CAPACITY_RUN_ID}"
export ALBERT_CAPACITY_RUN_APPROVED="load-staging:${ALBERT_SERVICE_VERSION}"
npm run capacity:transform > "$RUNNER_TEMP/albert-transform-capacity.json"
```

The diagnostic reads its p95 only from completions attributed to that exact
worker/run and start time; ambient 24-hour rows cannot contaminate it. An
interrupted run is discarded. Completed maintenance evidence is indexed and
retained for 48 hours, preventing unbounded ledger growth.

### Protected production capacity attestation

Production preflight fails closed unless the same release workflow obtains a
fresh Ed25519 envelope from the independently deployed reference attestor in
`services/capacity-attestor/`. Candidate CI has no signer, observer credential,
or producer implementation authority. It sends GitHub OIDC and public run
coordinates; the attestor binds the exact protected check-run and workflow,
then independently observes GitHub, Fly Machines, Fly Prometheus, the isolated
control database, and the isolated analytical database. The signed contract
requires exactly 20,000 fingerprinted tenants, the exact candidate image,
complete queue drain, a continuous autoscaler floor, and bounded database and
pool pressure. The protected release applies that measured floor without ever
scaling down a larger production fleet.

Bootstrap, immutable trust-repository deployment, secret inventory, observer
grants, rotation, failure handling, and the first live run are documented in
`docs/independent-capacity-attestor.md`. `ALBERT_TRANSFORM_CAPACITY_EVIDENCE`
and pasted JSON remain invalid inputs; only the same-workflow signed envelope
is accepted.

Pipeline telemetry is compacted per tenant after every successful projection:
hourly buckets for 48 hours, daily buckets through 35 days, monthly buckets
through 400 days, and nothing older. Delivered high-volume projection outboxes
are retained for 24 hours; identity and semantic-promotion delivery evidence is
retained for 30 days. Unpublished rows are never removed. The obsolete,
unconsumed aggregate pipeline outbox is drained on the same fenced path.

### Reconciliation operations

Nightly `ReconciliationSweep` work is successful only when every required
current-generation stream reaches `complete` through `late_edits`,
`identity_snapshot`, `verify_snapshot`, and `apply_tombstones`. Monitor
`control_plane.reconciliation_stream_sweeps` for `blocked`, a phase unchanged
for longer than the provider-specific scan window, or a generation lower than
the live connection. Inspect `phase_evidence` and `phase_transition_leases` by
correlation identifiers; never copy raw source payloads into an incident.

In the analytical cell, inspect `quality.connector_stream_state` for required
streams with no observed page, an invalid cursor chain, missing retention
evidence, reconciliation older than 26 hours, unequal source/local totals, or
open drift/quarantine. Confirm a suspected hard deletion has two `complete`
snapshots, zero membership delta, distinct scan windows, and an application row
naming both final snapshot batches. Never manufacture an application row or
delete a source row manually.

For a retryable provider outage, allow the queue lease to expire and replay the
same phase job. Exact evidence replay is idempotent. For a malformed,
quarantined, duplicate, incomplete, or membership-changing scan, fix or resolve
the source/normalization issue and start a new sweep ID; do not force the
blocked sweep forward. A reconnect creates a new connection generation and
automatically fences the old sweep. Escalate repeated source-total mismatch or
unstable membership as a provider-data incident.

### Backups and recovery

Enable Supabase and analytical point-in-time recovery. Raw objects are immutable inputs, but backup policy must still meet the contractual retention/deletion model. Test restoring both databases into an isolated staging cell, repointing no production callback, rebuilding semantic publication, and reconciling raw manifests. A restore test is incomplete until tenant isolation and deletion tombstones are verified.

### Rotation

- Rotate HMAC/state/user/proof secrets independently, supporting a bounded dual-read window where the protocol requires it.
- Rotate raw-storage machine sessions with the generation-fenced procedure below; generated S3 keys are never valid Albert credentials.
- Rotate database passwords by rerunning the login provisioner, update the one owning deployment, wait for pool turnover/readiness, then continue.
- Rotate the token KEK only with the staged procedure below; never change `TOKEN_ENCRYPTION_KEY_ID` ad hoc.
- Rotate the Deputy webhook KEK with `DEPUTY_WEBHOOK_PREVIOUS_ENCRYPTION_KEYS`, a privileged local material rewrap, readiness, and a real callback smoke test before removing the old key. The rotation must perform no Deputy API write.
- Vendor secrets and signing keys follow each vendor's overlap/verification procedure and require a real callback/webhook smoke test.

#### Raw Storage machine-session rotation

1. Generate three new, mutually distinct random passwords of at least 32 bytes.
   Never reuse a runtime, database, vendor, or HMAC secret.
2. Increment `ALBERT_RAW_STORAGE_CREDENTIAL_GENERATION` in the protected GitHub
   environment and replace the three matching GitHub secrets. Do not edit only a
   Fly password: the Auth user and runtime would then disagree.
3. Run the protected release. It stages each password only in its owning app,
   applies the reviewed authority migration, rotates the Auth users and mapping,
   then exercises sync create/read, webhook create/read, and deletion enumeration
   against the fixed non-customer sentinels before any service deploy.
4. Require all storage-enabled Machines to report ready and complete one real
   sync/webhook ingestion plus a staging deletion proof. If provisioning fails,
   retry the same generation after correcting the cause; never decrement it.
5. Remove superseded secret versions from the operator secret manager only after
   every old Machine and rollback image has been retired. Auth refresh sessions
   for the old password are bounded by Auth session revocation/expiry; if
   compromise is suspected, explicitly sign the machine user out before rollout.

#### Token KEK rotation procedure

The sync/OAuth and deletion processes can both write credential envelopes, so
rotation is a two-runtime rolling protocol. Let `token-v1` be current and
`token-v2` be the new independently generated key.

1. Add `token-v2` to `TOKEN_PREVIOUS_ENCRYPTION_KEYS` on both the deletion and sync/OAuth Fly apps while leaving `TOKEN_ENCRYPTION_KEY=token-v1-key` and `TOKEN_ENCRYPTION_KEY_ID=token-v1`. Wait for every Machine in both apps to report ready. This makes both readers understand either key before any writer changes.
2. Promote the deletion app to `TOKEN_ENCRYPTION_KEY=token-v2-key` and `TOKEN_ENCRYPTION_KEY_ID=token-v2`, with `{"token-v1":"token-v1-key"}` as its overlap object. The sync/OAuth app still has `token-v2` loaded decrypt-only, so credentials refreshed during deletion remain readable. Wait for deletion readiness.
3. Promote sync/OAuth to the same `token-v2` current pair with `token-v1` in its overlap object. Readiness first proves every active durable credential and OAuth-session wrapped DEK is resolvable. Each sync replica then claims bounded rows with `FOR UPDATE SKIP LOCKED` and rewraps only the random DEK; it never decrypts or rewrites OAuth ciphertext.
4. Watch `control_plane.worker_heartbeats.health_metadata->'tokenKek'` for every current sync replica. Require the expected `currentKeyVersion`, a null `lastErrorCode`, and `pendingRewrapCount = 0`. Independently query active `oauth_secret_envelopes` and active `oauth_session_secret_envelopes`; both must name only `token-v2`. Confirm the append-only `oauth.credential_kek_rewrapped` and `oauth.session_kek_rewrapped` audit events for the change window. Readiness alone is not proof that rewrap is complete because a loaded old key is intentionally ready during overlap.
5. Remove `token-v1` from the sync/OAuth overlap object, verify readiness and one real credential refresh/OAuth callback, then remove it from deletion and verify readiness plus a revocation smoke test. Never remove either copy while an active envelope, an old Machine, or a rollback image can still require it.

If a promotion must be rolled back before step 5, make `token-v1` current again
while retaining `token-v2` in the overlap object on both runtimes. Once old key
material has been removed, rollback to an image/configuration that cannot read
`token-v2` is forbidden. Configuration rejects padded/non-canonical keys,
duplicate IDs or material, malformed JSON, and more than four overlap keys.

### Rollback

Database migrations are forward-only. If the schema is backward-compatible, redeploy the prior service image and Sites release. Otherwise create and review a forward repair migration. Never edit a migration already present in `albert_migrations.applied_migration`; the runner will reject its changed checksum. Semantic publications are immutable; publish a reviewed replacement rather than mutating documents in place.

### Incident containment

For a suspected process compromise, revoke that app's deploy token, runtime database password, raw-storage machine sessions/password, and process-owned HMAC/vendor keys; stop its Machines if continued execution risks data. Rotate the affected raw-storage purpose at a new credential generation and explicitly revoke its Auth sessions. Other process credentials are independent and should be rotated based on evidence, not assumed shared. Preserve correlation IDs and audit rows while excluding customer payloads from incident channels.
