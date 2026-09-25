# Xero dlt isolation test

This experiment adapts the [dltHub Xero finance scaffold](https://dlthub.com/context/source/xero-finance)
to Albert's existing encrypted Xero connection and analytical Supabase database.

It differs from the small public example in four correctness-critical ways:

- sends the required `xero-tenant-id` header;
- derives all non-parent endpoints from Albert's pinned Xero OpenAPI scan plan;
- explicitly handles Xero page/offset pagination and records unavailable scopes;
- lands complete response envelopes so dlt normalises nested source data instead
  of retaining only top-level contacts or invoices.

The destination is the exact, case-sensitive PostgreSQL schema `"XERO_TEST"`.
This is an isolated diagnostic landing zone, not Albert's canonical or governed
`source_xero` path. Parent-id fan-outs such as document history and attachments
are intentionally excluded from this bounded run because history alone exceeds
the connected account's daily API allowance by weeks.

## Run

```sh
python3 -m venv .xero-dlt-venv
.xero-dlt-venv/bin/pip install -r scripts/xero-dlt-test/requirements.txt
npx tsx scripts/xero-dlt-test/run.mts --plan
npx tsx scripts/xero-dlt-test/run.mts --ingest
```

The launcher decrypts and, when necessary, refreshes the connected credential
in memory. It never writes the access token, refresh token, organisation id, or
database URL to a dlt secrets file.

If Xero reports that the organisation's daily allowance is exhausted, the
loader writes a `blocked_daily_limit` manifest row with Xero's safe retry
metadata and exits with status `75`. If the limit is reached after one or more
complete pages have been fetched, those pages are loaded before the remaining
endpoints are marked `deferred_daily_limit`; rerunning after the reset replaces
each resource with its complete endpoint result.
