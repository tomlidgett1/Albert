# Xero on Fivetran — Albert's Connector SDK connector

Albert's replacement for Fivetran's standard Xero connector. One consent, no
Connect Card, and every Xero endpoint Albert's own pack knows about — including
AU/UK/NZ payroll (pay runs, payslips, pay items, super, leave) and the Reports
API (P&L, balance sheet, trial balance, bank summary, executive summary, budget
summary) — landing in Fivetran's destination as Albert's own `source_xero.*`
table shapes plus `xero_report_*` line tables.

## How a tenant gets connected

1. Customer clicks **Connect** on *Xero (Fivetran)* → Albert's own Xero OAuth
   (`/api/oauth/xero/*`, `managedBy: fivetran` in the signed state). Single
   Xero consent; ingestion on the native connection is held at `manual` so
   Albert never extracts Xero itself.
2. The web callback (or the org-selection step for multi-org users) calls the
   sync worker `POST /v1/fivetran/xero/start { nativeConnectionId }`.
3. The worker packages this directory (`.py` files only), uploads it with
   `POST /v1/deploy/{group}/{schema}`, creates a `connector_sdk` connection
   (`schema = xero_<connection_ulid>`, Python 3.12) whose configuration names
   this worker as the **token broker** and carries a fresh per-connection bearer
   secret (only its SHA-256 is stored, in `fivetran_connections.account_metadata`),
   then unpauses it and requests the first sync.
4. On every sync the connector calls `POST {worker}/v1/fivetran/token` with that
   secret; the worker reads/refreshes the tenant's native Xero grant from the
   vault (lease-guarded) and returns a short-lived access token + Xero tenant id.
   Refresh tokens never leave Albert.

Disconnect deletes the Fivetran connection and disconnects the native grant
(credential destroyed, purge queued).

## Files

| File | Purpose |
|---|---|
| `connector.py` | SDK entry point: `schema()` + `update()` |
| `xero_spec.py` | **Generated** from `connectors/xero/tables.json` (scan groups, fan-outs, per-API transport profiles, columns). Regenerate: `npx tsx scripts/generate-fivetran-xero-sdk-spec.ts` |
| `xero_projection.py` | Port of `connectors/xero/spec-sync.ts` projection (column citations → fields, row identity, tombstones) |
| `xero_sync.py` | Walks: pagination, `order=` + immutable `where <scan start>`, `If-Modified-Since` watermarks in Fivetran `state`, fan-outs (payslip/employee detail, budgets, projects…), typed emit |
| `xero_reports.py` | Reports API → line tables |
| `xero_client.py` | HTTP client: token broker, 60/min pacing, 429/5xx retries, daily-limit stop |
| `tests/` | `test_projection.py` (parity with the TypeScript engine on the sanitized recording), `test_sync_e2e.py` (mock Xero end-to-end), `mock_xero_server.py` for `fivetran debug` |

## Tests

```bash
python3 -m unittest discover -s connectors/xero-fivetran-sdk/tests -v
node --import tsx --test tests/contracts/fivetran-xero-sdk.contract.test.ts
```

Real SDK runtime against the mock (writes `files/warehouse.db`, DuckDB):

```bash
python3 connectors/xero-fivetran-sdk/tests/mock_xero_server.py 8765 &
cd connectors/xero-fivetran-sdk && fivetran debug --configuration <(echo '{"xero_access_token":"t","xero_tenant_id":"x","xero_origin":"http://127.0.0.1:8765"}')
```

## Configuration keys (set by the worker)

`albert_token_url`, `albert_token_secret`, `albert_tenant_id`,
`albert_connection_id`, `xero_tenant_id`, `reports_interval_hours` (6),
optional `payroll_region` (AU|NZ|UK; else read from `Organisation.Version`),
`include_optional` ("true" walks optional fan-outs), and — debugging only —
`xero_access_token`, `xero_origin`.

## Budget

Xero allows 60 calls/min and 5,000/day per organisation. The client paces at
~57/min and honours `Retry-After`; when the daily limit is hit the sync
checkpoints and ends cleanly (Fivetran resumes next schedule). Incremental syncs
are `If-Modified-Since` for every modified-field walk; reference tables without
one (currencies, branding themes, assets…) refresh fully each run — they are
tiny. Reports cost ~25 calls every `reports_interval_hours`.
