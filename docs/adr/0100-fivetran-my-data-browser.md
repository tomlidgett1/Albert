# ADR 0100: Tenant-scoped Fivetran My Data browser

- Status: Accepted
- Date: 2026-08-19
- Owners: Albert product and data platform
- Extends: ADR 0017, ADR 0022, ADR 0079

## Context

Owners need a transparent, non-semantic view of the data Fivetran has landed
for their organisation: each connected destination schema, its business tables,
and the rows in a selected table. This is a data-inspection surface, not a BI
dashboard, query builder, semantic editor, or new ingestion path.

Fivetran destinations are already isolated by connection. The control plane
binds each active connection to one `destination_schema`; the analytical plane
binds the same schema to one tenant and stamps landed tables with `tenant_id`,
RLS, and read grants. The Vercel web runtime is deliberately forbidden from
holding an analytical database credential, so it cannot safely implement this
feature with a direct `pg` connection.

## Decision

`My Data` lists only Fivetran-managed connections in `connected`, `degraded`,
or `blocked` state. Native connector staging, canonical schemas, Cube semantic
views, and dlt pipelines are outside this surface.

An owner or manager starts one short-lived control-plane request for either the
catalogue or one bounded table page. Tenant identity is derived from the
authenticated user's currently selected organisation; the browser never sends
a tenant id. For row requests, the control plane accepts a schema only when it
is the exact `destination_schema` of that tenant's live Fivetran connection.

The existing isolated diagnostic Fly service consumes each request once over
its signed internal transport. Claiming the request issues a five-minute-or-
shorter `analytical:diagnostic` capability bound to the exact request, tenant,
kind, table, offset, and limit. The analytical read runs in a repeatable-read,
read-only transaction under `diagnostic_ro`, applies the capability, acquires
the tenant deletion shared lock, and independently verifies the analytical
`fivetran_destination_bindings` row before inspecting or reading a schema.

Catalogue reads return business tables only. Fivetran and Albert bookkeeping
tables are hidden. Tables that have not yet received the tenant stamp, RLS, and diagnostic
grant remain visible as unavailable and cannot be read. Row reads require an
exact safe identifier, a `tenant_id` column, RLS, and `diagnostic_ro` SELECT.
They always bind `tenant_id`, offset, and limit as parameters. Every page is
bounded to 50 rows, requests are limited to 30 per minute, and a deterministic
primary-key order is used whenever the table declares one. Offset pagination is
bounded at ten million rows to protect the four-connection diagnostic pool;
larger exports require a separately reviewed streaming path.

The surface excludes `tenant_id`, binary/structured payloads, and columns whose
names indicate credentials, tokens, authorization headers, cookies, passwords,
or private keys. Cells are rendered as escaped data and truncated to a fixed
character ceiling. A page carries at most 64 safe scalar columns; any further
safe columns are counted separately from policy-hidden columns. The UI states
both boundaries instead of implying that secret or system fields are absent
from the source.

Request and terminal audit records retain actor, tenant, schema/table,
pagination bounds, counts, outcome, and safe error code. Customer values are
never written to the control plane or application logs. Results use
`private, no-store` and are not available to models, conversations, dashboards,
or replay artefacts.

## Consequences

- Owners and managers can inspect all authorised Fivetran rows without a SQL
  surface or analytical credential in the browser/web runtime.
- The page is intentionally unavailable to bookkeepers until a field-level,
  role-specific raw-data policy is approved.
- Approximate table counts come from PostgreSQL statistics and are labelled as
  approximate; paging does not run an unbounded `count(*)`.
- A newly landed table may appear briefly as unavailable until the existing
  Fivetran maintenance path stamps its tenant and grants diagnostic read.
- Adding another Fivetran service requires no UI schema mapping: its registered
  destination appears automatically.

## Verification

- `infra/migrations/control-plane/0154_m6_fivetran_my_data_browser.sql`
- `infra/migrations/analytical/0174_m6_fivetran_my_data_schema_read.sql`
- `services/operator-diagnostic/src/contracts.ts`
- `services/operator-diagnostic/src/database.ts`
- `services/operator-diagnostic/src/http.ts`
- `services/control-plane/src/my-data-repository.ts`
- `app/dash/components/MyDataWorkspace.tsx`
- `tests/contracts/fivetran-my-data-boundary.contract.test.ts`
