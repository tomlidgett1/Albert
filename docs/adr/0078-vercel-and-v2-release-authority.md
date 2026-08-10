# ADR 0078: Vercel web deployment and V2 release authority

- Status: accepted
- Date: 2026-08-10
- Supersedes in part: the ChatGPT Sites deployment assumptions in the current
  founding specification, deployment contract, and V1 protected-dogfood
  release path
- Extends: ADR 0077

## Context

ADR 0077 makes the fully reviewed Lightspeed/Xero semantic publication, exact
deterministic qualification, and capped Luna Max evaluation the release evidence
for Analytical Architecture V2. The inherited V1 release path instead treats a
ChatGPT Sites deployment and a three-provider Lightspeed/Xero/Deputy onboarding
journey as mandatory production evidence. Those conditions cannot represent the
approved V2 scope: the web application is deployed on Vercel, and Deputy has no
real qualification data and is explicitly excluded from V2 certification.

Manually maintained web release variables are also insufficient. A mutable
environment value could relabel an older web bundle after deployment. Vercel
already exposes immutable commit, deployment, project, branch, and environment
identity at build and runtime; the application and release collector should use
those platform values directly.

## Decision

The Albert web application is a Git-connected Next.js project on Vercel. Its
production branch is protected `main`, its repository manifest is
`vercel.json`, and its non-secret project binding is recorded in
`deploy/vercel-project.json`. A production web release is valid only when the
Vercel API proves one `READY` production deployment for the exact candidate
commit, from `main`, in the pinned project/team, owning the declared production
origin, with the reviewed Next.js build settings.

At build time the web bundle embeds `VERCEL_GIT_COMMIT_SHA`. At runtime it uses
`VERCEL_GIT_COMMIT_SHA`, `VERCEL_DEPLOYMENT_ID`, and `VERCEL_PROJECT_ID` as the
authoritative release identity. When `VERCEL=1`, mutable `ALBERT_SERVICE_VERSION`,
`ALBERT_RELEASE_SHA`, and `ALBERT_DEPLOYMENT_ID` values cannot override those
system values. Missing or malformed Vercel identity fails readiness closed.

The V2 cutover authority requires all of the following for the same commit and
publication:

1. Protected-main CI and browser/database checks pass.
2. The immutable Lightspeed/Xero semantic publication satisfies its risk-tiered
   independent review requirements and has no unresolved relationship.
3. Deterministic qualification passes against the exact live schema and dataset
   watermark.
4. Exactly 200 model-backed cases pass the ADR 0077 Luna Max contract, including
   independent human grading where required.
5. The activation qualification is durably recorded in the control plane.
6. The semantic service reports V2 readiness with the exact publication.
7. Vercel provenance proves the exact production web deployment.
8. An authorised internal operator activates the qualified publication and the
   server-owned analytical route changes from V1 to V2 without per-answer
   fallback.

The V1 protected-dogfood workflow remains historical regression coverage for
the three-connector onboarding product. Its ChatGPT Sites envelope and Deputy
connection are not V2 launch evidence and cannot substitute for any gate above.
Existing Deputy connector, webhook, deletion, and V1 tests remain intact.

The control plane, analytical database, and raw storage remain locked to Sydney.
This ADR does not authorise a regional migration, paid infrastructure creation,
credential changes, protection bypass, self-approval, or fabricated semantic
review. Those require their existing external authorities.

Web and service readiness require the same exact commit SHA. Deployment IDs are
validated but remain platform-local: a Vercel `dpl_*` identity must not be
compared for equality with a Fly release or Machine identity. The release
receipt binds those distinct deployments to the common commit.

## Consequences

- `deploy/runtime-contract.json` identifies Vercel as the only production web
  platform. `.openai/hosting.json` is inert legacy metadata and is not consulted
  by V2 deployment or environment audits.
- Production environment audits inspect a names-only Vercel environment
  inventory plus the pinned project/team metadata. They never print values.
- Vercel provenance is collected directly from its authenticated read-only API
  boundary and contains no token material.
- Deputy can neither block nor contribute to V2 semantic qualification, the
  200-case evaluation, or the V2 cutover decision until a future reviewed ADR
  admits real Deputy data.
- The global V1 rollback remains available for 30 stable days after cutover.
