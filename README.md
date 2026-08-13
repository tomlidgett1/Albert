# Albert

Albert is a production-oriented natural-language analytics platform for Lightspeed Retail R-Series, Xero, and Deputy. A signed-in organisation connects its own systems, Albert ingests and reconciles the source data, and the OpenAI Agents SDK streams an ordered analytical trace: progress, governed tables, charts, validation, provenance, and the final evidence-bound answer.

Production does not contain a demo-data fallback. If Auth, a connector, a queue, the semantic service, or OpenAI is unavailable, the application reports a recoverable unavailable state instead of presenting fixture results as real data.

## Architecture

```mermaid
flowchart LR
  B["Browser"] --> W["Sites web application"]
  W --> S["Supabase Auth and control plane"]
  W -->|"HMAC + TLS"| O["Sync and OAuth worker"]
  W -->|"HMAC + TLS"| Q["Semantic query service"]
  V["Xero and optional, manually installed Deputy webhooks"] --> H["Webhook gateway"]
  H --> S
  O --> S
  O --> R["Supabase raw Storage"]
  O --> A["Analytical Postgres"]
  T["Transform worker"] --> S
  T --> A
  Q --> S
  Q --> A
  D["Deletion worker"] --> S
  D --> R
  D --> A
  W -->|"store: false"| AI["OpenAI AU data-residency API"]
```

The trust boundaries, release ordering, and rationale are recorded in [ADR 0006](docs/adr/0006-sydney-cell-topology-and-protected-release.md); the RLS-scoped raw-storage authority is [ADR 0031](docs/adr/0031-rls-scoped-raw-storage-machine-sessions.md). The complete product contract is [the V1 specification](docs/albert-v1-spec.md).

## Implemented production surfaces

- Supabase email/password authentication, callback, recovery, membership-scoped tenant bootstrap, and row-level security.
- Real OAuth start/callback/account-selection/disconnect flows with worker-only vendor secrets and envelope-encrypted refresh tokens.
- Lightspeed R-Series, Xero, and Deputy connector packs with cursoring, pagination, retries, rate budgets, optional webhook verification, immutable raw landing, typed staging, quarantine, and canonical mapping. Deputy ingestion is complete through polling and reconciliation; Albert never creates or updates Deputy Webhook resources.
- Durable pgmq sync orchestration, isolated transform and deletion workers, leases, heartbeats, idempotency, reconciliation, quality checks, and cross-store purge proofs.
- RLS-scoped Supabase S3 machine sessions with separate sync, webhook, and deletion Auth principals; generated full-access S3 keys and service-role credentials are rejected from runtimes.
- A reviewed semantic registry, source-field catalogue, tenant allowlists, role/PII gates, hybrid retrieval, compiled parameterized SQL, provenance, validation, and bounded query execution.
- OpenAI Agents SDK conversations using current Albert-supported model profiles, user-selectable reasoning effort and Fast mode, local conversation state, `store: false`, and ordered auditable SSE events.
- Light, dark, and system themes based on the `/app/dash` design system, including reduced-motion behavior and recoverable connection states.
- Hardened service images, Sydney Fly manifests, bounded multi-lane workers,
  queue/maintenance-pressure autoscaling, compacted pipeline telemetry, a
  protected release workflow, immutable migration ledger, environment
  validation, and readiness checks.

## Local verification

Node.js 22.23.1 or later is required. Copy `.env.example` into an ignored
`.env.local` and point every backend URL at the deployed Fly and Supabase
origins. `npm run dev` only starts the local web UI. Do not start Docker,
Cubecore, the Cube playground, or local semantic/Anthropic/sync workers.

```bash
npm ci
npm run registry:check
npm run test:deployment
npm run check
npm run dev
```

The default production conversation runtime is live. Fixture traces require both `ALBERT_CONVERSATION_RUNTIME=fixture` and `ALBERT_ALLOW_FIXTURE_RUNTIME=true`, and are rejected when `NODE_ENV=production`.

Database integration checks are reproducible in CI. For a new local database, an administrator first creates the group roles and then the migration runner applies each immutable stream:

```bash
npm run migrate -- --target=control-plane --bootstrap
npm run migrate -- --target=analytical --bootstrap
```

Do not use `--bootstrap` for ordinary releases.

## Production deployment

Follow [the production runbook](deploy/README.md). It covers the Sydney Supabase and analytical cells, vendor registrations, process-specific secrets, first bootstrap, Fly applications, Sites deployment, semantic publication, monitoring, rollback, key rotation, and the human acceptance test.

Routine releases are manually promoted through a protected GitHub `staging` or
`production` environment using
[`.github/workflows/release.yml`](.github/workflows/release.yml). The workflow
runs the full check, migrates both cells, publishes the exact semantic snapshot,
validates and deploys all six Albert services plus the two isolated worker
autoscalers, enforces private-worker networking, and waits for readiness. The
Sites web release follows only after that cell is healthy.

## Repository map

- `app/` — authenticated web application, API routes, and Dash UI
- `connectors/` — Lightspeed R-Series, Xero, and Deputy packs
- `packages/` — canonical schema, compiler, queue, storage, security, semantic registry, and usage metering
- `services/` — conversation, control-plane, sync/OAuth, transform, webhook, semantic-query, and deletion runtimes
- `infra/` — database role bootstrap and immutable migrations
- `deploy/` — Fly manifests and production operations
- `evals/` and `tests/` — grounding, security, connector, SQL isolation, runtime, deployment, and UI contracts
- `docs/adr/` — architecture decision records

## Security invariants

- Browser code receives only the Supabase URL and publishable key.
- Vendor client secrets, refresh tokens, token-encryption keys, analytical credentials, and raw-storage machine sessions never enter the browser or model context.
- The Supabase `service_role` key is not a service deployment credential.
- Raw ingestion has create/read authority only; deletion has list/delete authority only. Storage RLS, protected Auth-principal mappings, and split service bundles enforce that boundary.
- The model receives bounded user/final narrative context and governed tool results, never refresh tokens, raw payloads, arbitrary SQL, hidden reasoning, or unrestricted control-plane rows.
- Every analytical result carries tenant scope, semantic version, source lineage, time range, validation, and an answer state. Unsupported figures are withheld before delivery.
- Every user or connection deletion is fenced against new writes, remotely revoked where supported, purged across all stores, verified, and completed with a content-addressed proof.

Report a suspected security issue privately to the repository owner; do not include credentials or customer data in a public issue.
