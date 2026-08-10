# Albert production runbook

> **V2 authority:** ADR 0078 supersedes the web-platform and launch-evidence
> portions of this V1 runbook. The production web runtime is Vercel and the V2
> cutover is gated by the reviewed Lightspeed/Xero publication, deterministic
> qualification, the sealed 200-case Luna Max evaluation, active-publication
> receipt, and exact Vercel/Fly readiness. Sections describing ChatGPT Sites or
> a mandatory Deputy dogfood connection apply only to the V1 rollback path.

This is a desired-state provisioning and release runbook. The repository does
not prove that any Supabase project, Fly app, Sites release, GitHub environment,
attestor, or production cell currently exists or is live. Only a passing remote
environment audit, a successful immutable-authority release run, and the
candidate-bound acceptance evidence described below establish that fact for a
specific release. This runbook does not enable fixtures, seed customer data, or
bypass OAuth. Do not direct users to an environment until every acceptance gate
at the end passes.

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

Perform one vendor sandbox or test-account OAuth cycle before production
credentials are installed. Register Xero with the **Auth Code with PKCE** grant
type used by this V1 build; the worker intentionally rejects confidential-client
configuration and never accepts a Xero client secret. Xero's public-client token
exchange and refresh still require HTTP Basic syntax: Albert sends
`Authorization: Basic base64(client_id + ":")` with an empty password, alongside
the public `client_id` and PKCE/form fields. Do not mistake that header for a
confidential client secret or add `XERO_CLIENT_SECRET`. A Xero app registered
with the plain **Auth Code** grant type is the wrong app type here: it issues a
client secret, and this build has no confidential-client path for it.

To authorise a connector before its ingestion is cleared for production, list it
in `ALBERT_OAUTH_SUPPRESS_INITIAL_BACKFILL` (comma-separated connector ids:
`lightspeed-r`, `xero`, `deputy`) on the sync worker. A suppressed connector
completes consent, stores its rotating credential and creates an active
connection, but no ingestion is started: OAuth finalisation skips the initial
backfill, and a webhook- or schedule-triggered incremental that finds no cursor
retires instead of promoting itself to one. The dash reports "connected. No data
has been synced yet." Unknown connector ids fail worker startup rather than
silently leaving a pack syncing.

Consent itself still contacts the vendor — Albert lists the authorised
organisations and stores the selected account's non-secret metadata. Suppression
stops ingestion, not the OAuth handshake.

Clearing the variable makes the *next* connect sync. It does not retroactively
backfill a connection authorised while suppressed: that connection has no
cursor, and the only supported way to start it is to disconnect and reconnect
once the flag is cleared. Two further consequences while a connector is
suppressed:

- `control_plane.protected_dogfood_m7_journey_evidence` requires a matching
  `sync_job_requests` row, so a tenant onboarded under suppression cannot be
  recorded for M7 dogfood acceptance until it is reconnected.
- The stored credential is never exercised, so its refresh token is not
  rotated and `auth_health` stays `healthy` without re-verification. Xero
  refresh tokens expire after 60 days of disuse; reconnect rather than assuming
  a long-suppressed connection is still live.

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
| Sync/OAuth | `ALBERT_CONTROL_PLANE_PROJECT_REF`, `ALBERT_LIGHTSPEED_PRODUCT`, `CONTROL_PLANE_DATABASE_URL`, `ANALYTICAL_DATABASE_URL`, `SUPABASE_STORAGE_S3_ENDPOINT`, `SUPABASE_STORAGE_S3_ACCESS_KEY_ID`, `SUPABASE_STORAGE_S3_LEGACY_ANON_KEY`, `ALBERT_RAW_STORAGE_SYNC_PASSWORD`, `TOKEN_ENCRYPTION_KEY`, `TOKEN_ENCRYPTION_KEY_ID`, `ALBERT_OAUTH_WORKER_SIGNING_SECRET`, `ALBERT_PUBLIC_ORIGIN`, all three vendor client IDs, Lightspeed/Deputy client secrets, `XERO_DAILY_REQUEST_LIMIT`, `ALBERT_VENDOR_ATTESTOR_RELAY_ENABLED=true`, `ALBERT_VENDOR_ATTESTOR_PRIVATE_ORIGIN`, `ALBERT_VENDOR_ATTESTOR_TLS_SERVER_NAME`, `ALBERT_VENDOR_ATTESTOR_EXPECTED_TOOL_REF`, `ALBERT_VENDOR_ATTESTOR_EXPECTED_BUILD_DIGEST`, `ALBERT_VENDOR_ATTESTOR_TLS_CLIENT_CERT_BASE64`, `ALBERT_VENDOR_ATTESTOR_TLS_CLIENT_KEY_BASE64`, and `ALBERT_VENDOR_ATTESTOR_TLS_SERVER_CA_BASE64`; optional `TOKEN_PREVIOUS_ENCRYPTION_KEYS` during rotation and `ALBERT_VENDOR_ATTESTOR_RELAY_POLL_MS` |
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

### Independent live-vendor attestor

The M7 dogfood gate requires fresh live probes for the current Lightspeed,
Xero, and Deputy connection generations. Candidate services cannot attest
their own credentials. Deploy the separate
`vendor-connection-attestor` trust service before issuing the human onboarding
journey. It uses a dedicated `albert_vendor_attestor_runtime` database login,
has no public ingress, accepts only mTLS from the sync relay over Fly private
networking, and signs portable results with an independent Ed25519 key. The
database additionally verifies a distinct 32-byte admission HMAC.

First apply administrator upgrade 0010 and migration 0067, then create the
private Fly app. Configure the `vendor-attestor-trust` GitHub environment with
a required reviewer, self-review disabled, administrator bypass disabled, and
these values:

| Kind | Names |
| --- | --- |
| Variables | `ALBERT_VENDOR_ATTESTOR_AUTHORITY_SHA`, `ALBERT_VENDOR_ATTESTOR_TAG_SIGNER_EMAIL`, `ALBERT_VENDOR_ATTESTOR_TAG_ISSUER_APP_ID`, `ALBERT_VENDOR_ATTESTOR_KEY_ID`, `ALBERT_VENDOR_ATTESTOR_SYNC_CLIENT_SHA256`, `FLY_VENDOR_ATTESTOR_APP` |
| Secrets | `CONTROL_PLANE_ADMIN_DATABASE_URL`, `ALBERT_GITHUB_CONFIGURATION_AUDIT_TOKEN`, `ALBERT_VENDOR_ATTESTOR_DATABASE_URL`, `ALBERT_VENDOR_ATTESTOR_DB_PASSWORD`, `ALBERT_VENDOR_ATTESTOR_ED25519_PRIVATE_KEY_BASE64`, `ALBERT_VENDOR_ATTESTOR_ED25519_PUBLIC_KEY_BASE64`, `ALBERT_VENDOR_ATTESTOR_ADMISSION_HMAC_KEY_BASE64`, `ALBERT_VENDOR_ATTESTOR_TLS_KEY_BASE64`, `ALBERT_VENDOR_ATTESTOR_TLS_CERT_BASE64`, `ALBERT_VENDOR_ATTESTOR_TLS_CLIENT_CA_BASE64`, `FLY_VENDOR_ATTESTOR_API_TOKEN` |

The Ed25519 and TLS values use canonical standard base64. The key id is
`ed25519:` plus the SHA-256 digest of the Ed25519 SPKI DER. The admission key
must decode to exactly 32 bytes. `ALBERT_VENDOR_ATTESTOR_SYNC_CLIENT_SHA256`
contains one allowed client-certificate fingerprint, or two comma-separated
fingerprints during a bounded rotation. The database URL must require TLS and
use only `albert_vendor_attestor_runtime`.

Dispatch `Deploy independent vendor connection attestor` **from** the exact
reviewed `vendor-attestor-vMAJOR.MINOR.PATCH` tag and pass that same tag as
`trusted_tag`. The workflow requires a signed annotated tag whose verified
tagger email matches `ALBERT_VENDOR_ATTESTOR_TAG_SIGNER_EMAIL`, binds the event SHA and
workflow ref to that tag, requires a non-self approving environment reviewer,
and checks that `vendor-attestor-trust` admits only `vendor-attestor-v*` tags.
It then requires the tag to resolve to
`ALBERT_VENDOR_ATTESTOR_AUTHORITY_SHA`, builds and pushes an
immutable Fly registry digest, pins that digest and the
`repository@authority-sha` tool ref in the database verifier, stages only the
trust-domain runtime material, deploys the digest, and restores two private
instances. `deploy/vendor-attestor/runtime-contract.json` is the runtime
inventory source of truth.

Configure two active tag rulesets, each targeting only
`refs/tags/vendor-attestor-v*`. The creation ruleset contains only “restrict
creations” and has exactly one `always` bypass: the protected tag-issuer GitHub
App whose id is `ALBERT_VENDOR_ATTESTOR_TAG_ISSUER_APP_ID`. The independent
immutability ruleset restricts updates and deletion with no bypass actors,
including administrators. The workflow audits both rulesets, the annotated
signature, expected signer, target SHA, exact workflow ref, and environment
tag/reviewer policy before any secret-bearing step.

Install the client certificate/key, server CA, exact private `.internal`
origin, matching TLS server name, expected `repository@authority-sha` tool ref,
and expected remote image digest only on the sync app. The sync worker's
`/readyz` performs an authenticated TLS 1.3 request to the attestor's private
`/readyz` and requires those exact identities, so a bad CA, client certificate,
route, database boundary, tool ref, or build digest blocks sync readiness before
the first human challenge. Production sync rejects
`ALBERT_VENDOR_ATTESTOR_RELAY_ENABLED=false`. The attestor receives no OAuth
vault, vendor client secret, migration credential, OpenAI key, or Albert
runtime database role. See ADR 0052 and
`deploy/vendor-attestor/runtime-contract.json`.

## 6. Configure release trust and protected GitHub environments

Staging and production have different trust claims. The retained
`.github/workflows/release.yml` is a fail-closed legacy dispatcher: it accepts
no inputs, checks out no code, receives no environment, and always fails. Do
not restore either staging or production deployment authority to that file and
never give a candidate-owned staging path a production credential.

| Environment | Workflow authority | Required deployment policy | Reviewer |
| --- | --- | --- | --- |
| `staging-capacity` | `.github/workflows/release-authority.yml` at the protected authority tag | Exactly one custom policy: `albert-release-authority-v*`, type `tag` | At least one; self-review disabled |
| `production` | `.github/workflows/release-authority.yml` at the protected authority tag | Exactly one custom policy: `albert-release-authority-v*`, type `tag` | At least one; self-review disabled |
| `dogfood-staging` | `.github/workflows/dogfood-acceptance.yml` at the same protected authority tag | Exactly one custom policy: `albert-release-authority-v*`, type `tag` | At least one; self-review disabled |
| `vendor-attestor-trust` | `.github/workflows/vendor-connection-attestor.yml` at its signed authority tag | Exactly one custom policy: `vendor-attestor-v*`, type `tag` | At least one; self-review disabled |

For each tag-restricted environment, disable administrator bypass, disable
“protected branches”, enable
custom deployment policies, and install only the named tag policy. Do not add
`main`, another branch, `*`, or a fallback tag: GitHub evaluates those policies
with OR semantics. Enable “prevent self-review” on all four environments; the
signed production authorization contract independently rejects a reviewer
whose GitHub id or login matches the workflow dispatcher. The vendor-attestor
workflow also performs its own mandatory environment and tag-ruleset audit
before any trust secret is made available.

Protect `main` with classic branch protection that requires every CI job
(`verify`, `browser-acceptance`, `analytical-database`, and
`control-plane-database`), strict/current-head status checks, at least one
approving review, and administrator enforcement. A ruleset may add protection,
but the audit still requires classic administrator enforcement because the
active branch-rule projection does not prove bypass safety.

### Release-authority tag namespace

Production accepts only a signed annotated tag named
`albert-release-authority-vMAJOR`, `vMAJOR.MINOR`, or
`vMAJOR.MINOR.PATCH`. The tag object must target the exact tooling commit, have
GitHub verification `verified=true` and `reason=valid`, and use the exact tagger
email stored as the repository or organisation variable
`ALBERT_RELEASE_AUTHORITY_SIGNER_EMAIL`. A lightweight tag is invalid.

Install two separate active repository tag rulesets, both scoped to the sole
include `refs/tags/albert-release-authority-v*`:

1. A creation-only ruleset containing only the `creation` restriction and
   exactly one `Integration` bypass actor in `always` mode: the owner-controlled
   release GitHub App. Store its numeric App id as the protected `production`
   variable `ALBERT_RELEASE_AUTHORITY_CREATOR_APP_ID`.
2. An immutability ruleset containing exactly `update` and `deletion`, with no
   bypass actor at all.

Do not combine them. Giving the release App a bypass on update/deletion would
make the authority mutable. The approved signer creates the signed annotated
tag object, and the release App is the only identity allowed to publish that
object into the protected namespace. A mistake is corrected by a new,
higher-versioned tag; an existing authority tag is never moved or deleted.

Set the same three non-secret pins in both `production` and
`staging-capacity`:

```text
ALBERT_RELEASE_AUTHORITY_REF=refs/tags/albert-release-authority-v1
ALBERT_RELEASE_AUTHORITY_TOOLING_SHA=<full-lowercase-40-character-tag-target>
ALBERT_RELEASE_AUTHORITY_WORKFLOW_REF=<owner>/<repo>/.github/workflows/release-authority.yml@refs/tags/albert-release-authority-v1
```

The ref, SHA, and workflow ref must all describe the same tag. Updating gate
logic requires review, a new authority tag, and an atomic update of those pins
before dispatch.

Generate an independent Ed25519 release-authorization key pair. Store the
base64url PKCS8 DER private key only as the `production` secret
`ALBERT_RELEASE_AUTHORIZATION_ED25519_PRIVATE_KEY_BASE64URL`; store the matching
base64url SPKI DER public key as the `production` variable
`ALBERT_RELEASE_AUTHORIZATION_ED25519_PUBLIC_KEY_BASE64URL`. Do not reuse the
capacity, dogfood, or vendor-attestor signer.

Store `ALBERT_GITHUB_CONFIGURATION_AUDIT_TOKEN` separately in `production` and
`vendor-attestor-trust`. It is used only to re-read environment name
inventories, branch protection, and tag rulesets after human approval. Use a
non-dispatcher audit GitHub App or user principal with repository-administrator
visibility, while the fine-grained token grants only Metadata (read) and Actions
(read). Provisioning must prove that GitHub returns the `bypass_actors` property
for every relevant ruleset; omission fails closed. The principal must not be the
tag issuer or a deploy identity, and the workflow never invokes mutation
endpoints.

The `dogfood-staging` environment stores the exact producer pins
`ALBERT_DOGFOOD_ACCEPTANCE_WORKFLOW_REF` and
`ALBERT_DOGFOOD_TRUSTED_TOOLING_SHA`. It also stores the authority tag's
expected tagger email as `ALBERT_RELEASE_AUTHORITY_SIGNER_EMAIL`; the email must
match the repository/organisation value used by production authority. The
dogfood job verifies the annotated tag object, GitHub's valid signature result,
exact target, and tagger email before running collector code.

Production receives the dogfood public verifier
`ALBERT_DOGFOOD_ACCEPTANCE_ED25519_PUBLIC_KEY_BASE64URL` and one-use ledger URL
`ALBERT_DOGFOOD_CONTROL_DATABASE_URL`. It derives the expected dogfood producer
ref, tooling SHA, workflow path, and repository from its own immutable authority
event rather than accepting another mutable production pin. It receives only
the capacity attestor's public key as
`ALBERT_CAPACITY_ED25519_PUBLIC_KEY_BASE64`, together
with non-secret pins `ALBERT_CAPACITY_STAGING_CELL_ID`,
`ALBERT_CAPACITY_CORPUS_FINGERPRINT`, `ALBERT_CAPACITY_ATTESTOR_TOOL_REF`, and
`ALBERT_CAPACITY_ATTESTOR_BUILD_DIGEST`; no attestor private key or observer
credential belongs in an Albert GitHub environment.

For the immutable authority design, the dogfood pins are not an independent
trust root: `ALBERT_DOGFOOD_ACCEPTANCE_WORKFLOW_REF` is the same exact
`refs/tags/albert-release-authority-v*` ref and
`ALBERT_DOGFOOD_TRUSTED_TOOLING_SHA` is the same authority tooling SHA. Dispatch
the dogfood workflow from that tag. Its separately signed envelope still binds
the candidate deployed in staging.

The onboarding-journey issuer in `dogfood-staging` additionally requires the
canonical HTTPS variable `ALBERT_DOGFOOD_PUBLIC_ORIGIN` and the recipient's
base64url SPKI DER variable
`ALBERT_DOGFOOD_ONBOARDING_RECIPIENT_RSA_PUBLIC_KEY_BASE64URL`. Keep the
matching PKCS8 private key only on the named recipient's local machine as
`ALBERT_DOGFOOD_ONBOARDING_RECIPIENT_RSA_PRIVATE_KEY_BASE64URL`; it is never a
GitHub environment value or workflow secret.

The isolated `staging-capacity` environment requires these additional names:

| Kind | Names |
| --- | --- |
| Variables | `ALBERT_CAPACITY_ATTESTOR_URL`, `ALBERT_CAPACITY_CONTROL_PLANE_PROJECT_REF`, `ALBERT_CAPACITY_STAGING_CELL_ID`, `ALBERT_CAPACITY_CORPUS_FINGERPRINT`, `ALBERT_CAPACITY_REQUESTED_FLOOR`, `FLY_TRANSFORM_CAPACITY_APP`, `FLY_TRANSFORM_CAPACITY_AUTOSCALER_APP`, `FLY_ORGANIZATION_SLUG`, plus the three release-authority pins above |
| Secrets | `CAPACITY_CONTROL_PLANE_MIGRATION_URL`, `CAPACITY_ANALYTICAL_MIGRATION_URL`, `CAPACITY_TRANSFORM_CONTROL_PLANE_DATABASE_URL`, `CAPACITY_TRANSFORM_DATABASE_URL`, `FLY_CAPACITY_ORG_API_TOKEN`, `FLY_TRANSFORM_CAPACITY_SCALING_TOKEN`, `FLY_PROMETHEUS_READ_TOKEN` |

Keep that cell separate from production. The capacity attestor endpoint receives
OIDC and public run coordinates; its signing key, GitHub/Fly/Prometheus observer
tokens, and three observer/store database URLs remain only in the independent
trust deployment.

All ordinary release credentials remain environment-scoped: exact control and
analytical administrator/migration URLs, the independent database-login
passwords, raw-storage provisioner inputs, capability and webhook provisioner
keys, app-scoped Fly deploy/scaling tokens, the read-only Prometheus token,
OpenAI key, and the non-secret runtime targets/approvals listed in
`.env.example`. The eight Albert runtime/autoscaler apps and the separate vendor
attestor app must all have unique names. The deployment URLs use the exact
`albert_control_deployer` and
`albert_analytical_deployer` logins, require TLS, and target different
databases. `SUPABASE_MANAGEMENT_TOKEN` needs project-read plus Auth
`auth_config_read` (`auth:read`) only and must not have Auth write scope.

Do not rely on this prose as a static inventory. The credentials-safe audit
derives the `production` and `staging-capacity` inventories directly from the
authority workflow, the `dogfood-staging` acceptance inventory from the
dogfood collector, and the `vendor-attestor-trust` inventory from its deployment
workflow. The onboarding-journey issuer has the additional names listed above.
`.env.example` includes blank operator placeholders; never put a real value in
the repository.

### Production Supabase Auth contract

Configure the production control-plane project's hosted Auth service before the
first production release. `ALBERT_PUBLIC_ORIGIN` must be a canonical HTTPS
origin with no trailing slash. For an origin such as `https://albert.example`,
the live Management API `GET /v1/projects/{ref}/config/auth` response must meet
this exact contract:

- `site_url=https://albert.example`;
- `uri_allow_list=https://albert.example/auth/callback?next=/dash,https://albert.example/auth/callback?next=%2Freset-password%3Fmode%3Dupdate`
  as an exact two-item set with no empty value, whitespace, wildcard, duplicate,
  or additional URL; provider-returned item order is not significant;
- `disable_signup=false`, `external_email_enabled=true`, and
  `external_anonymous_users_enabled=false`;
- `mailer_autoconfirm=false` and
  `mailer_allow_unverified_email_sign_ins=false`;
- non-empty, valid `smtp_admin_email`, `smtp_port`, `smtp_user`, and
  `smtp_sender_name` metadata plus a canonical `smtp_host` hostname with no
  scheme, credentials, path, or embedded port, from a production custom SMTP
  provider;
- `password_min_length=12` and
  `password_required_characters=abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789`;
- `password_hibp_enabled=true`; and
- `refresh_token_rotation_enabled=true`.

The two redirect values are derived from the final signup and password-recovery
flows in the app. Vendor OAuth callbacks under `/api/oauth/*` are unrelated and
must not be added to the Supabase Auth allowlist. The read-only gate deliberately
does not inspect, project, or log the SMTP password or any provider secret. Use
the Supabase dashboard or a separately approved write-scoped provisioning
process to configure Auth; release and audit jobs perform no mutation. Supabase's
[Management API reference](https://supabase.com/docs/reference/api/gets-projects-auth-config)
defines `GET /v1/projects/{ref}/config/auth` and its `auth_config_read`
permission. The [password security guide](https://supabase.com/docs/guides/auth/password-security)
and [custom SMTP guide](https://supabase.com/docs/guides/auth/auth-smtp) provide
the underlying production recommendations.

### Credentials-safe authority audit

Before the first release and after changing any protected environment, run the
fail-closed authority audit. Authenticate `gh`, `flyctl`, and `supabase` through
their normal credential stores. Do not pass tokens on the command line. Inject
the read-only `SUPABASE_MANAGEMENT_TOKEN` from the approved secret store and
export the numeric `ALBERT_RELEASE_AUTHORITY_CREATOR_APP_ID` and
`ALBERT_VENDOR_ATTESTOR_TAG_ISSUER_APP_ID`, plus `ALBERT_PUBLIC_ORIGIN`,
`FLY_ORGANIZATION_SLUG`, and the nine non-secret
app name variables `FLY_SEMANTIC_APP`, `FLY_SYNC_APP`, `FLY_TRANSFORM_APP`,
`FLY_WEBHOOK_APP`, `FLY_DELETION_APP`, `FLY_OPERATOR_DIAGNOSTIC_APP`,
`FLY_SYNC_AUTOSCALER_APP`, `FLY_TRANSFORM_AUTOSCALER_APP`, and
`FLY_VENDOR_ATTESTOR_APP`.

Export a names-only Vercel inventory from the production Vercel project through
the Vercel API. The file is deliberately not an env file and
must use one record per line; assignments and values are rejected:

```text
project:prj_l5faWCnDWxw7QB7nBWgr9zaKFxuL
team:team_wx7OlK7ikXNuFcOSaewRxonA
runtime:NEXT_PUBLIC_SUPABASE_URL
runtime:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
# Continue with every installed runtime name; never include a value.
```

Then run:

```sh
npm run --silent audit:production-environment -- \
  --repo tomlidgett1/Albert \
  --supabase-project-ref <sydney-control-plane-ref> \
  --vercel-inventory-names <absolute-path-to-names-only-inventory>
```

The command derives required GitHub secret and variable names directly from the
immutable-authority, protected dogfood, and vendor-attestor workflows. It
verifies the `production`, `staging-capacity`, `dogfood-staging`, and
`vendor-attestor-trust` environments, disabled administrator bypass, required
non-self reviewers, exact
deployment policies, every CI check, strict status checks, an approving review,
and administrator enforcement on `main`, authenticated access to every named
healthy Fly app, and the selected Supabase project's live
`ap-southeast-2`/`ACTIVE_HEALTHY` metadata plus the exact live production Auth
contract above. The Auth inspection uses the official read-only Management API;
an unavailable, malformed, or weaker response fails the audit. Configure the
environment authority as follows:

- `production` and `staging-capacity`: custom deployment branches/tags with the
  sole policy `albert-release-authority-v*` of type `tag`;
- `dogfood-staging`: custom deployment branches/tags with the sole policy
  `albert-release-authority-v*` of type `tag`; and
- `vendor-attestor-trust`: custom deployment branches/tags with the sole policy
  `vendor-attestor-v*` of type `tag`; and
- `main`: classic branch protection with required checks, a current-head review
  gate, and administrator enforcement. Ruleset-only metadata fails closed
  because GitHub's active branch-rule projection does not prove bypass safety.

It also requires both split ruleset pairs described above for the release and
vendor-attestor namespaces: one creation-only rule per namespace with its sole
expected always-on GitHub App bypass, and a separate update/deletion rule with
no bypass. The audit projects ruleset, environment, secret, and variable
metadata only; it never reads their values.

Additional wildcard or fallback policies fail the audit because GitHub combines
deployment policies with OR semantics. A Fly app must report `deployed` or
`running`; accessible but suspended, stopped, or statusless apps fail. The audit
also matches the Sites inventory against the web runtime contract and rejects
database, migration, token-vault, and other forbidden trust-zone names.

Machine-readable JSON is written to stdout, the human summary to stderr, and
any missing or unavailable proof produces exit status 1. GitHub inventory calls
project only names and creation/update timestamps before the audit process sees
their output. Command failures are intentionally sanitized; neither provider
responses nor credential values are echoed.

## 7. Release the service cell

### Staging release

This repository currently contains no active general staging-deployment
workflow. `.github/workflows/release.yml` is deliberately retired and fails
every dispatch. Before dogfood collection, deploy the exact candidate into the
isolated staging cell through the separately reviewed staging-only process
owned by that cell, then record its full SHA and unique deployment id in
`dogfood-staging`. Do not reuse a production credential or describe that
external staging deployment as a production-authority run. The protected
dogfood workflow only collects and signs evidence from an already deployed
candidate; it does not deploy the candidate itself.

### Production prerequisites and dispatch

Before production dispatch, require all of the following:

- `candidate_sha` is the exact current `main` head and has successful
  `verify`, `browser-acceptance`, `analytical-database`, and
  `control-plane-database` check runs;
- one successful, unexpired dogfood acceptance artifact exists for that exact
  candidate, and the operator has recorded its numeric workflow run ID and
  numeric artifact ID; GitHub must also report the exact
  `sha256:<64-lowercase-hex>` artifact digest—not an artifact name, “latest”
  lookup, or copied JSON;
- the signed annotated release-authority tag and both protected environment
  pin sets are exact and the candidate's privileged release surface is
  byte-identical to the authority surface;
- the independent capacity attestor is healthy and its policy pins the same
  authority ref/SHA/workflow, staging cell, apps, corpus, and trust build; and
- `ghcr.io/<owner>/albert-services` is public. Fly receives no GHCR pull
  credential. If the package is private, the credential-free build job fails
  before any protected environment is entered.

Dispatch the production workflow from the authority tag itself:

```sh
gh workflow run .github/workflows/release-authority.yml \
  --ref albert-release-authority-v1 \
  -f candidate_sha=<full-main-head-sha> \
  -f dogfood_run_id=<exact-numeric-run-id> \
  -f dogfood_artifact_id=<exact-numeric-artifact-id>
```

Do not dispatch from `main` or the candidate branch. The protected production
entry point is `Immutable production release authority`; the retired legacy
release dispatcher cannot release anything.

### Production authority flow

The production workflow performs these phases in order:

1. Without environment credentials, it verifies the event ref, event SHA,
   workflow ref, trusted checkout, signed annotated tag object, GitHub signature
   status, and expected signer email. It separately proves the candidate is the
   current protected-main head with every required check green.
2. Still without protected credentials, it checks out the candidate, runs the
   complete `npm run check`, builds the services image with the candidate SHA
   compiled and labelled into it, pushes an immutable GHCR digest, logs out of
   GHCR, and proves that digest is anonymously pullable.
3. Authority code verifies the exact tag-owned dogfood workflow path and
   tooling SHA, dispatch event, successful first attempt, run ID, artifact ID,
   GitHub-reported artifact digest, candidate-specific artifact name, and
   unexpired state. It then creates a deterministic release plan binding
   authority ref/SHA/workflow, candidate SHA, services image digest, dogfood
   run/artifact IDs and digest, plus the release run/attempt and dispatcher
   identity. Plan creation is valid only on release run attempt 1.
4. Plan creation hashes the privileged release surface in both checkouts. Any
   difference in CI, service Dockerfile, connectors, contracts, deployment
   manifests, capacity tooling, evals, migrations, packages, scripts, lockfile,
   package manifest, or TypeScript configuration stops the run and requires a
   newly reviewed authority tag.
5. The tag-owned capacity job deploys only the plan's services-image digest to
   the isolated 20,000-tenant Sydney capacity cell. The independent attestor
   binds GitHub OIDC and Actions job identity to the authority tag and separately
   binds the candidate SHA, image digest, and plan digest. It signs only after
   the queue drains, the autoscaler floor remains stable, and database/pool
   limits pass. Cleanup quiesces both capacity apps on success or failure.
6. The `production` reviewer checks the exact authority tag/SHA, candidate SHA,
   image digest, plan digest, and dogfood run/artifact IDs and digest shown in
   the release summary. GitHub must identify the approver as a human user who is
   different from the workflow dispatcher. Approval is authorization for that
   tuple only.
7. Authority-only code verifies live Supabase/Auth, residency and data-control
   policy, app targets, migration identities, approved product decisions, and
   the capacity envelope; it then atomically consumes the exact one-use dogfood
   acceptance. Candidate checkout and candidate scripts are absent from this
   protected authorization job.
8. The authorizer seals an Ed25519 receipt binding authority ref/SHA/workflow,
   candidate SHA, services image, plan digest, workflow run/attempt and
   dispatcher, distinct human reviewer, production-approval record digest,
   GitHub authority-audit digest, and the exact capacity and dogfood envelope
   digests. The receipt has a six-hour lifetime and a fresh nonce. Downstream
   jobs download the same-run artifact, verify its recorded SHA-256 and
   signature with the protected public key, and reject another run, attempt,
   actor, reviewer, candidate, image, plan, approval, audit, or expired receipt.
9. Only after that receipt exists may authority-reviewed code apply bootstrap
   additions and checksum-locked migrations, reconcile exact runtime identities,
   rotate raw-storage principals, install capability/webhook keys, publish the
   semantic registry, or deploy the candidate image digest. Protected jobs
   check out only the authority SHA; the release plan has already proved their
   privileged surface is identical to the candidate.
10. The workflow deploys every service from the approved digest, never from a
    mutable tag. It preserves any larger running fleet, applies the attested
    transform Machine floor, deploys pinned autoscalers, verifies private-worker
    exposure and exact image/SHA identity, waits for public readiness, then
    activates the complete connector pack.
11. The final gate waits for Sites `/api/health` to expose the same candidate
    SHA and release run/attempt, with matching service readiness. The authority
    workflow does not deploy Sites. After dispatch and before this final
    activation can pass, explicitly select/push the exact candidate Sites
    source version, save the candidate-bound runtime values, and deploy it.

A failed tag check, public-pull proof, plan comparison, evidence check,
preflight, receipt verification, migration, publication, deployment, or health
check stops promotion. Dogfood evidence is one-use and both the plan and receipt
are first-attempt/run-bound; GitHub “re-run jobs” is not a valid production
retry. Do not retry by selecting a newer artifact, copying an envelope, or
manually deploying around a failed job. Start a new workflow run and create the
fresh candidate-bound evidence or authority tag required by the failed
boundary.

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
`ALBERT_ALLOW_FIXTURE_RUNTIME=false`, the explicitly reviewed
`ALBERT_BLOCKING_QUESTIONS_APPROVED_DIGEST`, the full release SHA in
`ALBERT_SERVICE_VERSION`, and a unique `ALBERT_DEPLOYMENT_ID`. Vendor client
secrets, database URLs, raw-storage session material, token keys, migration credentials, and deletion
keys must be absent.

### Blocking-question wording approval

The candidate onboarding contract is content-addressed. Review
`contracts/blocking-questions.v1.json` as one unit: UI copy, option labels,
connector prerequisites, and every overlay mutation. After explicit approval,
print the verified candidate digest locally:

```bash
node --input-type=module -e \
  "import('./contracts/blocking-questions.mjs').then(m => console.log(m.ALBERT_BLOCKING_QUESTIONS_CONTRACT_DIGEST))"
```

Set that exact value as the protected GitHub environment variable and the Sites
server runtime value named `ALBERT_BLOCKING_QUESTIONS_APPROVED_DIGEST`. It is not
a secret. Leave it unset before approval; `.env.example` deliberately contains
no default. Production package inspection and release preflight reject a missing
or stale digest, and the production inventory audit requires the name in both
the protected release environment and Sites. See ADR 0051.

The operator console never receives a database URL. Its explicit row reveal
uses the independent `ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET`; the same
secret is installed only in Sites and the operator-diagnostic app. Create the
two diagnostic runtime logins with `npm run provision:runtime-logins`, then
verify the app's `/readyz` at the exact release SHA before enabling reveals.
Every reveal must create requested and completed/failed entries in the
append-only operator audit log. See ADR 0017.

The authority workflow does not build, save, or deploy the Sites project. After
the production workflow is dispatched and before its final activation gate,
select or push the exact **candidate SHA** in the Sites project from
`.openai/hosting.json`, save the candidate-bound environment, and explicitly
deploy that version. Set `ALBERT_BUILD_SHA` to the candidate input, not to the
authority workflow's `GITHUB_SHA`: in production,
`GITHUB_SHA` is deliberately the trusted tooling commit and may differ from the
candidate. `next.config.ts` compiles the candidate value into the bundle. Set
the runtime `ALBERT_SERVICE_VERSION` to the same candidate SHA and
`ALBERT_DEPLOYMENT_ID` to the authority workflow's
`${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}`. `/api/health` must return ready, the
embedded candidate `releaseSha`, and that exact deployment id; it also parses
bounded JSON from sync, semantic, and diagnostic readiness and requires each to
report the same pair. Changing Sites environment values cannot relabel an old
bundle. Only then can the authority workflow finish green.

The same identity rule applies to Fly. The credential-free authority job builds
the candidate checkout with
`ALBERT_BUILD_SHA=${ALBERT_RELEASE_CANDIDATE_SHA}`, records that SHA as the OCI
revision label, pushes the image, and passes only its immutable digest into
protected deployment. `ALBERT_BUILD_SHA` is intentionally absent from the
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

Complete this ceremony against the isolated dogfood staging deployment for the
exact candidate before production dispatch. Use a clean browser profile and a
dedicated production-test organisation. Record timestamps, connection IDs, and
candidate SHA without recording tokens or customer payloads. The trusted
dogfood workflow must turn the completed journey into the exact signed,
unexpired run/artifact pair supplied to production authority; a checklist,
screenshot, browser test, or “latest” artifact is not a substitute. After
production deployment, repeat only the non-destructive login/readiness smoke
needed to confirm the final cell; do not manufacture replacement acceptance
evidence in production.

Dispatch the collector from the same immutable authority tag used for
production, not from `main` or a separate dogfood tag:

```sh
gh workflow run .github/workflows/dogfood-acceptance.yml \
  --ref albert-release-authority-v1 \
  -f candidate_sha=<full-staging-candidate-sha> \
  -f onboarding_journey_id=<completed-journey-ulid>
```

The resulting successful first-attempt run and unexpired artifact provide the
numeric IDs and GitHub artifact digest used by the production release plan.

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

Production is open to users only when all ten have produced accepted dogfood
evidence for the exact candidate and the immutable-authority workflow has
deployed and smoke-tested that same candidate.

## 10. Operations

### Monitoring

Alert on failed readiness, Machine restart loops, missing worker heartbeats, queue age/depth, lease retries, dead-letter growth, quarantine rate, vendor 401/403/429 classes, webhook signature/replay rejection rate, semantic timeouts, quality invariant failures, OpenAI errors, claimed diagnostic reveals without outcomes, diagnostic signature failures, deletion deadlines, backup failures, and database/storage saturation. Logs are structured and must retain correlation IDs, never secrets, sampled rows, or raw exception payloads.

Sync and transform Machines expose Prometheus metrics only on the private
metrics port configured in their Fly manifests. Page immediately when
`albert_sync_queue_sla_breached` or `albert_transform_queue_sla_breached` is
non-zero for two scrapes, or when the relevant oldest-age gauge remains above
300 or 120 seconds. Fly's pinned metrics autoscalers maintain a two-Machine
sync floor and the independently attested transform floor (between 2 and 40),
then scale to at most 40 Machines from queue depth, queue age, and (for
transform) the number of tenants due for an hourly snapshot. A release restores
a missing applicable floor but never scales down a larger running fleet.

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
or producer implementation authority. Immutable release-authority code sends
GitHub OIDC and public protocol-v2 coordinates. OIDC and the Actions API bind
the protected authority tag, tooling SHA, workflow, and attempt; the request
separately binds the candidate SHA, exact services-image digest, and release-plan
digest. The attestor then independently observes GitHub, Fly Machines, Fly
Prometheus, the isolated control database, and the isolated analytical database.
The signed contract requires exactly 20,000 fingerprinted tenants, the exact
candidate image, complete queue drain, a continuous autoscaler floor, and bounded
database and pool pressure. The protected release applies that measured floor
without ever scaling down a larger production fleet.

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

Database migrations are forward-only. Do not manually redeploy a prior image or
Sites revision around the production authority boundary. If the schema remains
backward-compatible, create and merge a reviewed revert commit, make it the
current protected-main head, produce fresh candidate-bound dogfood/capacity
evidence, mint a new authority tag when the privileged surface differs, and run
the immutable production workflow again. Otherwise create and review a forward
repair migration and release it through the same path. Never edit a migration
already present in `albert_migrations.applied_migration`; the runner rejects its
changed checksum. Semantic publications are immutable; publish a reviewed
replacement rather than mutating documents in place.

### Incident containment

For a suspected process compromise, revoke that app's deploy token, runtime database password, raw-storage machine sessions/password, and process-owned HMAC/vendor keys; stop its Machines if continued execution risks data. Rotate the affected raw-storage purpose at a new credential generation and explicitly revoke its Auth sessions. Other process credentials are independent and should be rotated based on evidence, not assumed shared. Preserve correlation IDs and audit rows while excluding customer payloads from incident channels.
