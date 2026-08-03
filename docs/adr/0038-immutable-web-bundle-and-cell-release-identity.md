# ADR 0038: Immutable web and service bundle release identity

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert security, web platform, and release engineering
- Relates to: ADR 0006, ADR 0027, ADR 0034, ADR 0035

## Context

`ALBERT_SERVICE_VERSION` is a runtime environment value. If web health reports
only that value, an operator or compromised deployment path can relabel an old
Sites artifact with a new Git SHA. Likewise, HTTP success from downstream
readiness endpoints does not prove the web is talking to services from the same
release. A new web bundle with old workers, or an old bundle with new labels,
could pass a superficial release gate.

Sites promotion and Fly service deployment are separate platform operations.
The release must prove coherence at the bytes actually serving users, not infer
it from editable environment labels or a successful build elsewhere.

## Decision

The Sites build receives the full source commit as `GITHUB_SHA` in CI or
`ALBERT_BUILD_SHA` in the protected Sites build context. `next.config.ts`
validates the 40-character SHA and injects `ALBERT_BUILD_SHA` as a compile-time
definition into every server bundle. Vinext translates this configuration into
a static Vite definition. A runtime environment update therefore cannot change
the bundle's identity.

Every Fly service image is built from the same checked-out commit with
`ALBERT_BUILD_SHA` as a Docker build argument. The service builder validates
that value and replaces the dedicated `__ALBERT_SERVICE_BUILD_SHA__` symbol
with a literal in all six runtime bundles and the protected transform-capacity
harness. The runtime image does not receive that build argument as an
environment variable; it retains the SHA as an OCI revision label and in the
compiled JavaScript only. Each process compares mutable
`ALBERT_SERVICE_VERSION` with its embedded SHA before it opens databases or a
listener. A missing, malformed, uppercase, or mismatched value fails startup.
All service readiness responses use the captured embedded value, so changing
the process environment after startup cannot relabel the running bytes.

Web readiness requires all of the following:

- the embedded build SHA is valid;
- runtime `ALBERT_SERVICE_VERSION` exactly equals the embedded SHA;
- `ALBERT_DEPLOYMENT_ID` is valid;
- Supabase Auth health succeeds; and
- sync, semantic-query, and operator-diagnostic readiness return bounded valid
  JSON, a positive ready state, the exact embedded SHA, and the exact same
  deployment id.

Malformed, oversized, unavailable, old-SHA, and mixed-deployment responses fail
closed. `/api/health` reports the embedded SHA—not the mutable runtime label—and
returns HTTP 503 on any mismatch. The protected release verifier independently
requires both the workflow SHA and `${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}` from
every public service and the promoted Sites origin.

The release workflow does not infer a Sites promotion from a build job. The
exact source revision must be promoted through the protected Sites project
while its final gate waits; only the serving bundle can satisfy the gate.

## Consequences

- An old Sites or Fly service artifact cannot become healthy by changing
  environment values.
- A partially rolled Fly fleet cannot be presented as one coherent release.
- A failed or delayed Sites promotion keeps the release workflow red.
- Local unversioned builds can run for development but cannot report production
  readiness.
- Operators must supply the same deployment attempt to Sites and all Fly
  services, in addition to the same source SHA.

## Verification

- `next.config.ts`
- `packages/config/src/health.ts`
- `packages/config/src/build-identity.ts`
- `app/api/health/route.ts`
- `scripts/verify-release-readiness.mjs`
- `scripts/build-services.mjs`
- `scripts/check-service-boundaries.mjs`
- `Dockerfile.services`
- `.github/workflows/release.yml`
- `tests/runtime-health.test.mjs`
- `tests/release-readiness.test.mjs`
- `tests/contracts/service-build-identity.contract.test.ts`
- `scripts/validate-deployment.mjs`
