# ADR 0089: Immutable single-node CubeCore production release

- Status: Accepted
- Date: 2026-08-12
- Owners: Albert engineering
- Extends: ADR 0053, ADR 0078, ADR 0083, ADR 0087

## Context

CubeCore is a production runtime in `deploy/runtime-contract.json`, and its
model is the governed semantic surface for Shopify and the existing connector
packs. The immutable release-authority workflow previously built and deployed
only the shared Albert services image. `cube-playground/Dockerfile` and
`deploy/fly/cube.toml` existed, but no protected release built, authorised,
deployed or proved the Cube bytes serving production. A successful services
release could therefore leave CubeCore absent or on an unrelated model.

Cube uses a separate upstream image and build context, so it cannot be folded
into `Dockerfile.services` without collapsing the reviewed runtime boundary.
The current Cube configuration also intentionally uses the in-memory cache and
queue driver. Multiple Cube Machines would create independent cache and queue
state and are not an available high-availability topology.

## Decision

The immutable production authority treats CubeCore as a second candidate
artifact for the same protected-main commit:

1. A credential-free job builds `cube-playground/Dockerfile` for Linux/amd64,
   publishes an SBOM and maximum provenance, and resolves the result to a GHCR
   `sha256` digest. The Cube upstream base is pinned by tag and digest.
2. `cube-playground` is part of the authority/candidate byte-equality surface.
   Candidate model or Dockerfile drift therefore requires a new reviewed,
   signed authority tag.
3. Production release-plan schema 3 binds both `servicesImage` and `cubeImage`.
   Authorisation-receipt schema 3 signs and verifies both digest references.
   A receipt cannot be replayed for another Cube image.
4. The production environment audit and preflight require a unique Cube Fly
   app and HTTPS origin. Deployment uses a Cube-app-scoped token and the exact
   runtime-contract secret inventory.
5. Cube deploys from the authorised digest with the candidate SHA and workflow
   deployment attempt. While `CUBEJS_CACHE_AND_QUEUE_DRIVER=memory`, the
   protected workflow enforces exactly one running Machine. Moving to a shared
   cache/queue and multiple Machines requires a separately reviewed decision.
6. Final promotion proves the one live Machine has the approved digest, SHA and
   deployment attempt, then requires Cube's bounded unauthenticated `/readyz`
   response to be exactly `{ "health": "HEALTH" }`. The same job downloads and
   re-verifies the signed release receipt before it mints one existing
   three-minute diagnostic turn in the production control cell. A probe baked
   into the exact Machine signs a two-minute, `meta`/`data`-scoped JWT with the
   Machine-resident secret, requires `/cubejs-api/v1/meta` to expose Shopify's
   aggregate-only/day/k=5 population policy and representative members, then
   executes a future-day Shopify aggregate query that must return zero rows.
   The diagnostic lease is closed with a digest bound to the signed
   authorization and Cube image. No JWT, identifier, response body or row is
   emitted.

The Cube API remains signed-public. This decision adds no database, migration,
vendor or model credentials to the web runtime and does not weaken tenant
capability enforcement in `cube-playground/cube.js`.

## Consequences

- A production release cannot omit CubeCore or silently retain an older model.
- Readiness alone cannot promote a Cube image whose model fails to compile or
  whose protected Shopify semantic query cannot execute through the real
  capability path.
- Reviewers approve content-addressed service and Cube artifacts in one plan.
- A mutable upstream Cube tag cannot alter a rebuild of the reviewed candidate.
- Cube has no multi-Machine availability until a shared cache/queue topology is
  explicitly designed, secured and capacity-tested.
- First deployment still requires the externally authorised Fly app, scoped
  deploy token, exact runtime secrets and HTTPS origin to exist; repository code
  does not create paid or credentialed infrastructure.

## Verification

- `.github/workflows/release-authority.yml`
- `cube-playground/Dockerfile`
- `cube-playground/scripts/release-smoke.mjs`
- `deploy/fly/cube.toml`
- `deploy/runtime-contract.json`
- `scripts/create-release-plan.mjs`
- `scripts/release-authorization-receipt.mjs`
- `scripts/release-preflight.mjs`
- `scripts/audit-production-environment.mjs`
- `scripts/validate-deployment.mjs`
- `scripts/run-production-cube-release-smoke.mjs`
- `tests/release-plan.test.mjs`
- `tests/release-authorization-receipt.test.mjs`
- `tests/release-preflight.test.mjs`
- `tests/contracts/cube-release-smoke.contract.test.ts`
- `tests/production-environment-audit.test.mjs`
