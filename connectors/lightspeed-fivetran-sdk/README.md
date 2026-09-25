# Lightspeed Retail R-Series on Fivetran — Albert's Connector SDK connector

Albert's replacement for Fivetran's standard `light_speed_retail` connector
(Connect Card, ~80% of the `ls_*` contract, no tips / inventory logs / shipments
/ vendor returns / processing fees). One Lightspeed consent in Albert, no
Connect Card, and every one of the 90 `ls_*` tables of Albert's own R-Series
pack (`connectors/lightspeed-r/tables.json`) landing in Fivetran's destination
in the exact `source_lightspeed.ls_*` staging shape — so the semantic layer
re-points with a schema change only.

## How a tenant gets connected

1. Customer clicks **Connect** on *Lightspeed (Fivetran)* → Albert's own
   Lightspeed R-Series OAuth (`/api/oauth/lightspeed/*`, `managedBy: fivetran`
   in the signed state; `employee:all`, the same consent the native pack
   uses). Ingestion on the native connection is held at `manual`, so Albert
   never extracts Lightspeed itself.
2. The web callback (or the account-selection step for multi-account users)
   calls the sync worker `POST /v1/fivetran/light_speed_retail/start
   { nativeConnectionId }`.
3. The worker packages this directory (`.py` files only), uploads it with
   `POST /v1/connector-sdk/packages`, creates a `connector_sdk` connection
   (`schema = lightspeed_<connection_ulid>`, Python 3.12) whose configuration
   names this worker as the **token broker** and carries a fresh
   per-connection bearer secret (only its SHA-256 is stored, in
   `fivetran_connections.account_metadata`), then unpauses it and requests the
   first sync.
4. On every sync the connector calls `POST {worker}/v1/fivetran/token` with
   that secret; the worker reads/refreshes the tenant's native Lightspeed
   grant from the vault (lease-guarded, rotating refresh tokens committed
   compare-and-swap) and returns a short-lived access token plus the R-Series
   account id. Refresh tokens never leave Albert.

Disconnect deletes the Fivetran connection, retires + purges the
`lightspeed_<ulid>` schema, and disconnects the native grant (credential
revoked at `/auth/oauth/revoke`, purge queued).

## Files

| File | Purpose |
|---|---|
| `connector.py` | SDK entry point: `schema()` + `update()` |
| `lightspeed_spec.py` | **Generated** from `connectors/lightspeed-r/tables.json` (scan groups with the member-need relation union, extra passes, incremental strategy per group, fan-outs, and the physical staging column contract of every table). Regenerate: `npx tsx scripts/generate-fivetran-lightspeed-sdk-spec.ts` |
| `lightspeed_projection.py` | Port of `connectors/lightspeed-r/fetch-core.ts` + `spec-sync.ts` projection (envelope, `projectFrom` paths, parent-context leaves, row identity) |
| `lightspeed_sync.py` | Walks: id-sorted pages, `after` continuation, hidden-population passes, modified/id/date windows in Fivetran `state`, relation-presence guard, fan-outs, typed emit, `albert_column_contract` |
| `lightspeed_client.py` | HTTP client: token broker, leaky-bucket governor snapped to `X-LS-API-*` headers, 429/5xx retries |
| `tests/` | `test_projection.py` (parity with the TypeScript engine on the generated walk pages), `test_sync_e2e.py` (mock R-Series end-to-end), `mock_lightspeed_server.py` for `fivetran debug` |

## What one sync does

* One walk per scan group — 56 walks fill 86 tables (`CatalogVendorItem`, the supplier catalogue mirror, is skipped; `skip_resources=A,B` in the configuration skips more); `Sale.json` with
  `Customer, SaleLines.InventorySales, SalePayments.SaleAccounts,
  SalePayments.Signatures` fills sales, lines, payments, accounts, signatures
  and inventory allocations from the same pages.
* Second and later syncs narrow each walk the way the group allows:
  `timeStamp`/`updateTime >=` (watermark = the previous walk's start, minus 5
  minutes) for the 13 groups with a modified pushdown; `<id> >` last max id
  for append-only ledgers (InventoryLog, SaleVoid, RegisterWithdraw,
  InventoryCountReconcile); `startDate/endDate` for the by-day reports; a full
  re-snapshot for the reference tables (Shop, PaymentType, TaxCategory… — a
  page or two each).
* Fan-outs: `Register/{id}/calculated.json` and
  `Customer/CustomField/{id}/CustomFieldChoice.json` every sync;
  `Workorder/{id}/WorkorderImage.json` only with `include_optional=true`.
* Relations: only the ones the projection can read — the roots nested
  members project from plus relations that are themselves a staged jsonb
  column (`Customer.Contact`). Enrichment relations the worker also loads
  (`Item.Category`, `Sale.Customer`) never reach a staged column, and long
  relation lists make R-Series silently drop some. A `400 … relations that
  are not allowed: X` drops X for that account (remembered in state) and
  retries; a page whose requested relation root came back on no record is
  re-requested once with member roots only, and rejected if still absent.
* Every page checkpoints the walk cursor, so an interrupted run resumes at
  the page it stopped on. A 404/403 endpoint is recorded as `unavailable`
  (plan-gated resources), and one failing family never takes the sync down.
* Never attach a new package while a historical sync is running: Fivetran
  aborts the run to switch code (cursors survive, but the run restarts).
* `albert_column_contract(table_name, column_name)` lands once per spec
  revision so `ingestion.rebuild_fivetran_source_views` can undo Fivetran's
  identifier rewrite (`tax1_rate` → `tax_1_rate`) exactly.

Deletes: R-Series soft-deletes with `archived` (landed as its own column, as
in the native staging); `tombstone` is always false. Hard deletes are not
detected — the same as Fivetran's standard connector and the native pack's
incremental path.

## Tests

```bash
python3 -m unittest discover -s connectors/lightspeed-fivetran-sdk/tests -v
node --import tsx --test tests/contracts/fivetran-lightspeed-sdk.contract.test.ts
```

Real SDK runtime against the mock (writes `files/warehouse.db`, DuckDB):

```bash
python3 connectors/lightspeed-fivetran-sdk/tests/mock_lightspeed_server.py 8766 &
cd connectors/lightspeed-fivetran-sdk && fivetran debug --configuration <(echo '{"lightspeed_access_token":"t","lightspeed_account_id":"12345","lightspeed_origin":"http://127.0.0.1:8766"}')
```

## Configuration keys (set by the worker)

`albert_token_url`, `albert_token_secret`, `albert_tenant_id`,
`albert_connection_id`, `lightspeed_account_id`, `include_optional`
("true" also walks workorder images), `skip_resources` (comma-separated vendor resources not to walk) and — debugging only —
`lightspeed_access_token`, `lightspeed_origin`.

## Budget

R-Series is a leaky bucket (default 60 units, 1 unit/second drip, both
reported live) plus a one-second burst limiter; there is no daily quota. The
client paces from the headers, halves its burst window on a burst rejection,
and honours `Retry-After`. A live account's full Sale history is ~400 pages;
an incremental sync is a page or two per modified group.
