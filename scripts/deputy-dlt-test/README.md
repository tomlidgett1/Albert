# Deputy dlt isolation test

This experiment expands the [dltHub Deputy scaffold](https://dlthub.com/context/source/deputy)
for Albert's existing encrypted Deputy OAuth connection and analytical
Supabase database.

It creates the exact, case-sensitive PostgreSQL schema `"DEPUTYNEW"` and:

- reads the install-bound OAuth token from Albert's encrypted worker vault,
  validates the regional install host, and checks the account with `GET /me`;
- discovers all 58 Resource objects listed in Deputy's official Resource API
  overview with read-only `GET .../INFO` requests;
- reads every accessible object with the documented read-only
  `POST .../QUERY` operation;
- keyset-paginates complete scans at Deputy's 500-record response limit;
- asks `INFO` for the source count before and after each scan, checks Deputy's
  documented unfiltered collection endpoint for small discrepancies, and
  records any remaining source visibility gap explicitly;
- lets dlt normalise full objects and nested arrays into related Postgres
  tables; and
- records inaccessible plan/role-gated objects in `ingestion_manifest`;
- distinguishes resource-level HTTP 401 responses from an invalid OAuth token
  by independently checking `/me`; and
- resumes an interrupted run only when a physical destination count matches
  the current `INFO` count.

This is a diagnostic raw landing zone. It is separate from Albert's immutable
payload store, governed `source_deputy` staging, canonical workforce facts, and
semantic query path.

## Run

The Xero test's local dlt virtual environment can be reused because both tests
pin the same runtime dependencies:

```sh
.xero-dlt-venv/bin/pip install -r scripts/deputy-dlt-test/requirements.txt
npx tsx scripts/deputy-dlt-test/run.mts --plan
npx tsx scripts/deputy-dlt-test/run.mts --ingest
```

Set `DEPUTY_DLT_PYTHON` to use another compatible Python interpreter. The
launcher never writes the access token, refresh token, install hostname, or
database URL to a dlt secrets file.

If the encrypted access token is expired, refresh it through Albert's deployed
sync worker before running this isolated loader. The launcher intentionally
does not require or copy the Deputy OAuth client secret into the local process.
