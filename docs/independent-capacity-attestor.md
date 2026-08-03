# Independent transform-capacity attestor runbook

This service is the release-security producer for ADR 0034. It is not an Albert
runtime and must not be deployed by a candidate release workflow. The source in
`services/capacity-attestor/` is the reviewed reference implementation; mirror
it into the release-security repository, review it independently, and deploy
only an immutable commit and OCI digest from that trust domain. Set
`ALBERT_CAPACITY_ATTESTOR_TOOL_REF` to that exact
`owner/repository@40-character-commit`. The same value is pinned in the Albert
production environment and inside every signed envelope.

## Trust boundaries

- The Ed25519 private key, attestor-store URL, capacity observer URLs, GitHub
  read token, Fly read token, and Prometheus read token exist only in the
  attestor deployment secret manager.
- Of the attestor trust material, the release-authority job receives only its
  HTTPS origin. No candidate checkout receives the signer or observer
  credentials. GitHub issues OIDC directly for audience
  `albert-transform-capacity-attestor`.
- The attestor policy pins repository, the immutable release-authority workflow
  ref and tooling SHA, staging cell, both capacity apps, exact floor, and corpus
  fingerprint. Request JSON cannot broaden any value.
- Authority and candidate are deliberately different identities. GitHub OIDC,
  the Actions run/job, and the workflow source bind to the protected authority
  tag and SHA. The request separately binds the full candidate commit, exact
  transform OCI digest, and release-plan digest that authority code is testing.
- The attestor verifies GitHub's JWKS signature and token lifetime, `sha`,
  `workflow_sha`, ref, run id/attempt, event, hosted runner, and
  `staging-capacity` subject. It then checks the Actions jobs API
  `check_run_id` and parses `.github/workflows/release-authority.yml` at the
  authority SHA to prove that the named attestation job is the only job allowed
  into `staging-capacity`.
- GitHub, Fly Machines, Fly Prometheus, and direct read-only database
  observations are independent inputs. Candidate output is never accepted as
  a measurement or a pass document.

## One-time bootstrap

1. Create a separate trust database and apply
   `deploy/capacity/attestor-store.sql` as its administrator.
2. Apply `deploy/capacity/attestor-control-observer.sql` to the dedicated
   Sydney capacity control database and
   `deploy/capacity/attestor-analytical-observer.sql` to its analytical
   database. These scripts create no password. Set each password from the trust
   secret manager and verify the logins have no other membership.
3. Generate an Ed25519 key in the trust HSM/KMS, or generate PKCS8 PEM offline
   if the platform cannot sign Ed25519 directly. Store only the base64-encoded
   PKCS8 private key in the attestor deployment. Export the matching SPKI public
   key to the protected Albert production environment as
   `ALBERT_CAPACITY_ED25519_PUBLIC_KEY_BASE64`.
4. Create read-only credentials:
   - a fine-grained GitHub App/token with Actions and Contents read access only
     to the Albert repository;
   - a Fly organization token that can list the two capacity apps and their
     Machines but cannot deploy or scale them; and
   - a Fly Prometheus read token for the capacity organization.
5. Configure the GitHub `staging-capacity` environment with required reviewers,
   allow only tags matching `albert-release-authority-v*`, and ensure only the
   exact `attest-transform-fleet-capacity` job in
   `.github/workflows/release-authority.yml` references it. Protect the
   authority tag namespace against candidate-controlled creation, update, and
   deletion.

## Required attestor configuration

Non-secret values:

```text
ALBERT_CAPACITY_ALLOWED_REPOSITORY=tomlidgett1/Albert
ALBERT_CAPACITY_ALLOWED_WORKFLOW_REF=tomlidgett1/Albert/.github/workflows/release-authority.yml@refs/tags/albert-release-authority-v1
ALBERT_CAPACITY_ALLOWED_AUTHORITY_REF=refs/tags/albert-release-authority-v1
ALBERT_CAPACITY_ALLOWED_AUTHORITY_SHA=<40-character-commit-at-that-tag>
ALBERT_CAPACITY_STAGING_CELL_ID=<approved-cell-id>
ALBERT_CAPACITY_TRANSFORM_APP=<dedicated-transform-capacity-app>
ALBERT_CAPACITY_AUTOSCALER_APP=<dedicated-capacity-autoscaler-app>
ALBERT_CAPACITY_REQUESTED_FLOOR=<2..40>
ALBERT_CAPACITY_CORPUS_FINGERPRINT=<approved-64-hex-fingerprint>
ALBERT_CAPACITY_ATTESTOR_TOOL_REF=<trust-owner/trust-repo@40-hex-commit>
ALBERT_CAPACITY_ATTESTOR_BUILD_DIGEST=sha256:<64-hex-image-digest>
ALBERT_CAPACITY_PROMETHEUS_ORIGIN=https://api.fly.io/prometheus/<organization>
ALBERT_CAPACITY_PROMETHEUS_RUNNING_QUERY=sum(fly_instance_up{app="{{app}}"})
ALBERT_CAPACITY_PROMETHEUS_DESIRED_QUERY=max(capacity_floor{app="{{app}}"})
```

The two Prometheus expressions are protected trust configuration, not request
fields. Validate their labels against the capacity organization before the
first promotion; an absent, duplicate, sparse, NaN, or sub-floor series fails
closed.

Secrets:

```text
ALBERT_CAPACITY_ED25519_PRIVATE_KEY_BASE64
ALBERT_CAPACITY_ATTESTOR_STORE_DATABASE_URL
ALBERT_CAPACITY_CONTROL_OBSERVER_DATABASE_URL
ALBERT_CAPACITY_ANALYTICAL_OBSERVER_DATABASE_URL
ALBERT_CAPACITY_GITHUB_READ_TOKEN
ALBERT_CAPACITY_FLY_READ_TOKEN
ALBERT_CAPACITY_PROMETHEUS_READ_TOKEN
```

All PostgreSQL URLs must require TLS and use the exact observer/store logins.
No candidate runtime or GitHub environment secret may contain these values.

## Build and deploy from the trust repository

At the independently reviewed commit:

```sh
npm ci --ignore-scripts
npm run build:capacity-attestor
node --check .albert-build/capacity-attestor/main.js
node --import tsx --test services/capacity-attestor/capacity-attestor.test.ts
```

Build `Dockerfile.capacity-attestor`, record the registry-reported OCI digest,
set that exact digest in `ALBERT_CAPACITY_ATTESTOR_BUILD_DIGEST`, and deploy with
`deploy/capacity/capacity-attestor.reference.toml`. The reference manifest keeps
two Sydney instances running for health availability, while the application
and durable lease store permit only one observation for a workflow attempt.
Do not use a mutable image tag as promotion evidence.

## Protected promotion flow

1. The immutable authority workflow accepts a separate full candidate SHA and
   content-addressed release plan. Albert CI passes ordinary verification,
   quiesces the dedicated capacity apps, applies candidate migrations to that
   isolated cell, verifies the approved 20,000-tenant corpus, and deploys the
   release plan's exact transform image digest behind a future barrier.
2. Authority-owned request code obtains GitHub OIDC and posts only public
   coordinates to
   `POST /v1/transform-capacity-attestations`. The service immediately returns
   HTTP 202 and a deterministic opaque attestation id while observation runs;
   the client repeats the same authenticated POST at the reviewed 15-second
   interval with refreshed OIDC until it receives the completed envelope. Each
   HTTP exchange is bounded to 20 seconds, so neither Fly nor an intermediary
   must keep a silent 50-minute connection alive.
3. The protocol-v2 request contains authority SHA/ref/workflow/run identity and
   candidate SHA/transform-image/release-plan identity. The attestor reserves
   the workflow attempt durably and stores the digest of the complete request;
   any retry that changes either identity is a conflict. Legacy protocol-v1
   rows remain readable for retention but can never satisfy a v2 request.
4. The attestor validates the OIDC/check-run/workflow authority boundary and
   independently observes the full candidate run. It signs only if all schema
   gates pass: exact candidate Machines and image,
   20,000 distinct tenants, fixed corpus, queue drain, bounded leases,
   connection/pool/lock/deadlock limits, Prometheus floor, and five-minute
   autoscaler stability.
5. The schema-v2 envelope carries separate `authority` and `candidate` objects.
   Authority-owned production preflight verifies the executing authority SHA,
   ref, workflow and attempt plus the approved candidate SHA, immutable services
   image digest, and release-plan digest before the first production mutation.
   Cleanup then stops both capacity-only apps regardless of outcome.

An HTTP 202 means the durable observation remains pending; 401 means identity
failure; 403 means policy drift; 409 means a conflicting run identity; and 503
means measurement or a trusted dependency failed. None has a bypass.

## Rotation and recovery

- Rotate GitHub/Fly/database read credentials independently and confirm
  `/readyz` before removing the old version.
- Rotate Ed25519 with a bounded dual-public-key release window: deploy the new
  signer, add its public key to a reviewed verifier release, run one staging
  promotion, then remove the old key. Never distribute either private key to
  Albert CI.
- A crashed observation remains leased for 55 minutes. A later authorized OIDC
  poll for the exact same authority and candidate identity may take over only
  after expiry; completed evidence is idempotently returned and a measured
  failure is terminal for that workflow attempt. A different authority SHA/ref,
  candidate SHA/image/plan, or request digest for the same run/attempt is
  permanently rejected.
- Preserve signed envelopes and store rows for the release evidence retention
  period. They contain operational aggregates only, never customer rows or
  credentials.

The repository tests prove protocol and fail-closed behavior. A real protected
Sydney run with the maintained 20,000-tenant corpus is still mandatory
operational evidence before opening production; no local test can substitute
for it.
