# ADR 0126: Complete analytical query-attempt ledger

- Status: accepted
- Date: 2026-08-25
- Extends: ADRs 0001, 0079, 0110 and 0111

## Context

Successful answer traces preserve the governed query and result provenance that
reached an owner. They are not a complete diagnostic record: a malformed model
query, a semantic rejection, a Cube outage, a cancelled request, or a runtime
crash can occur before a successful `query` trace event exists. The isolated
Codex runtime also executes outside the web process, so its failed attempts need
an explicit transport rather than inference from the final answer.

Improving Albert requires one place where an operator can review every
analytical attempt together with the business question that caused it. This is
operational/customer content and therefore belongs in the Sydney control plane,
not the analytical database. It must remain inside the tenant-deletion boundary
and must not create a browser path to analytical credentials or physical SQL.

## Decision

1. The control plane owns two append-only tables:
   `analytical_query_attempts` records an attempt before execution, and
   `analytical_query_outcomes` records its one terminal result. A missing
   outcome is visible as in-progress and later interrupted; it is never silently
   treated as success.
2. Every attempt stores only governed typed query documents. Raw SQL, provider
   payloads, credentials, headers, hidden reasoning, and raw tool arguments are
   forbidden. The database snapshots the current question, conversation title,
   runtime profile, and up to six recent turns itself so a client cannot invent
   diagnostic context.
3. Albert V3 records every Cube load (including diagnostics and context probes),
   every typed Shopify query, every Shopify Admin lookup, and every live Xero
   report. The isolated Codex runtime transports Cube attempt start/outcome
   events back to the authenticated web host, which persists them through the
   same RPCs. Model-issued queries rejected before execution are recorded with
   status `rejected` as well.
4. A start record is awaited before an in-process query executes. Terminal
   writes are awaited and idempotently retried. This makes logging failure a
   fail-closed analytical condition instead of allowing unobserved queries.
   The Codex service retains the same ordered start/outcome events in its
   bounded signed-job buffer until the web host acknowledges them through its
   normal poll stream; the service still receives no Supabase credential.
5. Direct table access is denied. Authenticated writers use two narrow
   SECURITY DEFINER RPCs bound to the current actor's running conversation
   turn. The cross-tenant read RPC and viewer-status RPC require the confirmed
   Supabase Auth email `tom@lidgett.net` exactly. UI visibility is derived from
   that server status, and the read RPC independently enforces it.
6. Every Logs read appends `operator.query_logs_read` to the immutable operator
   audit ledger. Query records carry `tenant_id` and conversation foreign keys,
   so existing connection/tenant erasure removes them with other query-derived
   artefacts.
7. `/dash` exposes a Tom-only Logs row in the existing left sidebar. The page
   defaults to failures, supports all/success/in-progress filters and search,
   and uses a dense master-detail layout over the existing dash tokens in every
   theme.

## Consequences

- A successful answer trace and the diagnostic ledger serve different needs:
  the trace remains owner-safe provenance, while the ledger captures failed and
  rejected attempts without exposing it to ordinary tenant members.
- Two small control-plane writes are added per analytical attempt. Query
  execution stops if the start cannot be durably recorded; an orphaned start is
  explicit evidence of interruption rather than a missing log.
- The exact-email gate is deliberately narrower than `internal_operator`.
  Adding another viewer requires a reviewed migration/ADR change, not a UI
  edit or client-side allowlist.
- The ledger contains customer questions and therefore follows Albert's
  no-training stance and deletion lifecycle. It is evidence for internal model
  and product improvement, not permission to train a provider model.
