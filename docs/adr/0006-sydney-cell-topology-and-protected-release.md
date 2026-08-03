# ADR 0006: Sydney cell topology and protected release

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert engineering

## Context

Albert combines a browser application, authentication, OAuth control state, durable ingestion, governed analytical data, an agent runtime, and destructive deletion. Treating these as one deployment would put vendor refresh tokens, raw payloads, analytical write credentials, and model-facing reads in the same failure domain. A UI-only deployment would also create false confidence: a healthy page says nothing about queues, connector workers, semantic publication, or deletion.

The founding specification requires Australian residency, Supabase as the authentication and control plane, a separate analytical Postgres host, durable workers, real vendor callbacks, and a release process that can prove the deployed system matches the reviewed registry and migrations.

## Decision

### Regional cells

- The production Supabase project is created in Sydney (`ap-southeast-2`) and owns Auth, the `public` API schema, the private `control_plane` schema, pgmq queues, cron scheduling, pgvector catalogue documents, and the `raw-payloads` Storage bucket.
- The analytical database is a separate PostgreSQL 17 service in Sydney. Its provider is an explicit operator decision because the founding specification does not authorize silently choosing a vendor. It is never the Supabase control database.
- The web application is deployed through Sites. Its server routes receive browser sessions, begin OAuth, stream conversations, and call signed services. They never receive vendor client secrets, token-encryption keys, analytical credentials, Supabase service-role credentials, or raw-storage credentials.
- The six always-on service deployments run in Fly's `syd` region using one hardened image and separate commands, credentials, applications, and app-scoped deploy tokens.

### Network exposure

- `webhook-gateway` is public because vendors must deliver signed webhooks to it. It verifies the exact raw body before durable receipt and conditional raw-object creation.
- `sync-worker` and `semantic-query` have HTTPS ingress because the Sites server cannot join Fly's private 6PN. Every mutation or analytical tool route is HMAC-authenticated with an independent secret, timestamp, method, path, and body digest. Their liveness/readiness routes disclose no secrets.
- `transform-worker` and `deletion-worker` have no Fly public service and no public IP. Fly top-level checks reach their internal readiness ports.
- A deployment fails if a private worker has any public IP.

### Process and credential boundaries

- The sync deployment alone owns vendor client secrets, encrypted credential access, the sync queue, the `ingest_rw` analytical identity, and the ADR 0031 sync-purpose Storage session.
- The transform deployment receives only a constrained transform-control login and `transform_rw`; it cannot read OAuth tokens, raw-object credentials, sync queues, or deletion credentials.
- The semantic deployment receives `albert_semantic_control`, `semantic_ro`, and a separate `semantic_meta_rw` login. It cannot read OAuth credentials or write canonical facts.
- The webhook deployment receives only its webhook-control login, vendor webhook verification material, queue wrappers, and the ADR 0031 webhook-purpose Storage session.
- The deletion deployment receives fenced deletion-control functions, `deletion_rw`, remote-revocation material, and the ADR 0031 deletion-purpose Storage session. It cannot use a generic backend role.
- Generated Supabase S3 keys are forbidden because they bypass Storage RLS. Three mapped Auth machine sessions enforce sync insert/select, webhook insert/select, and deletion select/delete. Raw writes use `If-None-Match: *`; a retry accepts an existing object only after byte and SHA-256 verification.
- `deploy/runtime-contract.json` is the reviewed, machine-readable credential
  boundary for Sites and all six service processes. Fly secret inventories are
  exact: a missing, prohibited, or undeclared name stops the release before DDL.
- Every service validates its production database URL against its dedicated
  login, required TLS, selected control-plane project ref, locked region, and
  release identity before opening a pool. Supplying an administrator URL under
  a runtime variable name therefore fails closed.

### Release ordering

Production releases use the protected `release.yml` workflow and cannot overlap for the same environment:

1. Run the complete registry, deployment, lint, type, contract, evaluation, service-build, and web-build checks.
2. Bind the full Git SHA to the protected environment, verify the selected
   Supabase project's actual `ap-southeast-2` region and healthy state through
   its Management API, require the explicit R-Series and AU model-data-control
   approvals, validate clean distinct origins and unique app targets, and
   compare each Fly app's secret names to the runtime contract.
3. Apply both migration streams with deployment-only logins, advisory locking, immutable checksums, and one transaction per migration. Both `SET ROLE` and the actual session login are checked.
4. Generate embeddings and publish the content-addressed semantic registry atomically through the same constrained control deployer identity.
5. Validate each Fly manifest against its target app and deploy all six services with the Git SHA and workflow run as deployment identity.
6. Maintain two Machines for each service, verify private IP policy, inspect separate liveness and readiness checks, and smoke-test all public readiness endpoints.
7. Deploy the exact same SHA through the Sites project only after the service
   cell is healthy. Compile that SHA into the web bundle, require runtime and
   bundle identities to match, require every web dependency to return the same
   SHA and deployment attempt, then run the human OAuth and governed-query
   acceptance script.

Every release and dogfood job that invokes Fly uses both an immutable setup
action commit and the same explicit `flyctl` version. Deployment validation
counts every setup step and fails if a step is unpinned, omitted, or drifts from
the reviewed toolchain.

The first environment bootstrap is deliberately separate because it requires managed-database administrator authority to create NOLOGIN group roles and enable extensions. Routine releases do not receive that authority.

### Availability and rollback

- Public and worker services maintain two Machines. Queue leases, idempotency keys, compare-and-swap credential rotation, conditional raw writes, and content-addressed publications make concurrent processing and restarts safe.
- Database migrations are forward-only. A rollback redeploys the prior application image only when its schema compatibility is proven; otherwise a reviewed forward repair migration is required.
- Semantic publications are immutable snapshots. A prior reviewed registry may be republished as a new release decision without modifying historical documents.
- Health checks do not expose credentials, and failures stop promotion before the web application points users at an unhealthy cell.
- A mutable Sites environment cannot relabel an old bundle: web health reports
  its compiled source SHA and rejects mixed service deployment ids.

## Consequences

### Positive

- A compromise of one process does not automatically reveal every secret or database capability.
- Background destructive workers are not accidentally exposed by their health endpoints.
- Every release ties code, schema, semantic definitions, service health, and deployment identity together.
- A protected variable claiming “Sydney” cannot mask a Tokyo Supabase project;
  the release reads the selected project's region from Supabase before any
  migration or service deployment.
- A real browser login can reach real vendor OAuth and real governed analytics once environment-owned credentials and vendor registrations are installed.

### Costs and risks

- Six service applications, two database cells, and distinct credentials require disciplined secret rotation and monitoring.
- Sites-to-Fly calls cross public TLS ingress and therefore depend on HMAC key rotation and strict request verification.
- Initial production creation cannot be automated without the operator's Supabase, analytical-provider, Fly, OpenAI, and vendor account authority.
- Two Machines per service cost more than a single-instance prototype; the availability and rolling-release guarantees justify that baseline.

## Alternatives considered

- Put every runtime in Sites: rejected because the web process would inherit worker credentials and long-running queue responsibilities.
- Use Supabase as both control and analytical database: rejected because it collapses workload and trust boundaries required by the specification.
- Expose worker health ports as public services: rejected because platform health monitoring supports private top-level checks.
- Use one organization-wide Fly token: rejected because app-scoped deployment tokens limit release-system blast radius.
- Run migrations automatically inside every service deployment: rejected because concurrent services could race schema and semantic publication.

## References

- [Fly top-level health checks](https://fly.io/docs/reference/health-checks/)
- [Fly private networking](https://fly.io/docs/networking/private-networking/)
- [Fly continuous deployment](https://fly.io/docs/launch/continuous-deployment-with-github-actions/)
- [Supabase database migrations](https://supabase.com/docs/guides/deployment/database-migrations)
- [Supabase Management API](https://supabase.com/docs/reference/api/getting-started)
- [Supabase S3 authentication](https://supabase.com/docs/guides/storage/s3/authentication)
