# ADR 0017: one-use operator diagnostic row reveals

- Status: accepted
- Date: 2026-08-03
- Supersedes: none
- Implements: Albert V1 specification sections 8, 19, and 20

## Context

The operations console normally serves projected control-plane metadata. Section
19 also requires an internal human to reveal a small analytical row sample when
metadata is insufficient to diagnose a pipeline problem. That exception must
not create analytical database access from a browser, expose arbitrary SQL to a
user or model, reuse the semantic query credential, or turn the web deployment
into a database-bearing runtime.

An `internal_operator` gate alone is insufficient. Cross-tenant customer-row
access needs a durable audit trail, a bounded target selected from observed
pipeline metadata, replay resistance, strict tenant scope, and a database
identity that cannot write.

## Decision

Albert uses a separate, always-on `operator-diagnostic` service and two dedicated
runtime logins:

- `albert_operator_diagnostic_control_runtime` is a member only of
  `albert_operator_diagnostic_control`. It can execute the three fixed reveal
  lifecycle functions and has no direct control-plane table privileges.
- `albert_operator_diagnostic_analytical_runtime` is a member only of
  `diagnostic_ro`. Every query transaction sets that role, sets the trusted
  tenant context, takes the tenant deletion advisory fence, and is read-only.

The authenticated web route accepts only a discriminated
`stage/schema/table` tuple. The control plane verifies `internal_operator`, the
stage-to-schema relationship, tenant status, and exact table presence in
`pipeline_stats`. It then appends a 60-second reveal request and operator audit
event. The web runtime sends only the generated reveal ULID to the diagnostic
service over HTTPS with `ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET`, which is
independent from OAuth and semantic transport secrets.

The service atomically consumes the grant exactly once. It discovers columns
from `information_schema`, accepts only conservative PostgreSQL identifiers,
and executes one fixed tenant-parameterised `SELECT` with these hard ceilings:

- only `source_lightspeed`, `source_xero`, `source_deputy`, `core`, or `mart`;
- only a table present in the tenant's `pipeline_stats` grant;
- at most 3 rows from the product UI and an absolute database-contract cap of 5;
- at most 32 scalar columns and 500 characters per cell;
- a 2-second statement timeout and 500-millisecond lock timeout;
- no `tenant_id`, JSON/JSONB, binary, or secret-bearing column names.

The service records a completed or failed outcome and a second immutable
operator audit event before returning any rows. If outcome persistence fails,
sampled rows are discarded and the caller receives an error. The browser sees
only the server response; it receives no database URL, HMAC secret, SQL, or
service credential. The agent runtime has no reference to this service.

The UI requires a deliberate two-step action: choose `Reveal sample`, review
the data-access notice, then choose `Reveal 3 rows`. Samples are never loaded on
page or drill-down load. The panel uses the dash tokens and motion curve and
disables non-essential motion under `prefers-reduced-motion`.

## Consequences

This adds a sixth service application, two constrained database credentials,
one independent HMAC secret, and one protected service URL. Release preflight,
secret inventory validation, exact-SHA readiness checks, runtime login
provisioning, and the production runbook include that boundary.

The service cannot run ad-hoc SQL or inspect raw object payloads. JSON columns
are intentionally omitted even when useful; an operator must diagnose them via
lineage metadata or an independently reviewed offline incident procedure. A
consumed grant is not retried after a crash; the operator explicitly creates a
new audited reveal instead.

## Rejected alternatives

- Giving Sites a `diagnostic_ro` URL was rejected because the browser-facing
  deployment must remain database-free.
- Adding diagnostic reads to semantic-query was rejected because that would
  place unrestricted read authority beside the model-facing service.
- Signing arbitrary SQL was rejected because signatures authenticate a caller;
  they do not make an unbounded query safe.
- Returning rows directly from a service-role Supabase client was rejected
  because generic service credentials are broader than the fixed grant
  lifecycle and dedicated analytical login.
