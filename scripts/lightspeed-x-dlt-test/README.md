# Lightspeed Retail X-Series dlt validation harness

This is an isolated contract and ingestion test for Albert's production
X-Series connector. It does not participate in the central sync runtime and it
never starts ingestion automatically.

The default command uses a local HTTP fixture and a local DuckDB database. It
performs two loads so the result proves both initial extraction and incremental
merge/upsert behavior without a Lightspeed account or credential.

## Source of truth

The harness is pinned to Lightspeed's official [X-Series OpenAPI 2026-07
contract](https://x-series-api.lightspeedhq.com/openapi/api-2026-07.yaml), whose
local research artifact SHA-256 is
`123b2630178c376990dd7219f92e068e5f77ac9cd991a80e0fafa97ad8613dd7`.

Behavior is based on Lightspeed's official documentation for
[pagination](https://x-series-api.lightspeedhq.com/docs/pagination),
[rate limiting](https://x-series-api.lightspeedhq.com/docs/rate_limiting),
[authorization](https://x-series-api.lightspeedhq.com/docs/authorization), and
[dates and times](https://x-series-api.lightspeedhq.com/docs/dates_and_times).
Lightspeed's official support guidance states that there is [no persistent API
sandbox](https://x-series-support.lightspeedhq.com/hc/en-us/articles/25533876082075-How-can-I-get-a-sandbox-account-for-API-testing), so the safe default is the
fixture and the optional network path is restricted to a user-managed
trial/demo store.

## What the fixture proves

- standard `after` / `version.max` pagination, stopping only on an empty page;
- read-only `POST /inventory` with the cursor in the JSON body, ascending order,
  the documented 5,000-row maximum, and deleted inventory included;
- read-only `POST /inventory_levels` offset pagination;
- fulfillment page-number pagination;
- product-category and fulfillment-history opaque cursor handling;
- quote ID pagination while preserving int64 identifiers as text, including
  values beyond JavaScript's safe integer range;
- forward-progress and maximum-page guards for every paginator;
- one HTTP 429 followed by an RFC 1123 `Retry-After` date, while observing
  `X-RateLimit-Limit` and `X-RateLimit-Remaining`;
- JSON monetary values decoded as `Decimal`, never binary floats;
- dlt `merge` with explicit `upsert` strategy for changing sales, inventory,
  and quote records;
- stateful second-run cursors and empty-page termination; and
- complete nested source objects retained for dlt normalization.

There is deliberately no `.add_limit()`. Every endpoint has an explicit loop
and a non-advancing cursor or maximum-page failure mode.

## Run the deterministic local test

From the repository root:

```sh
uv run python scripts/lightspeed-x-dlt-test/pipeline.py mock

uv run python -m unittest discover \
  -s scripts/lightspeed-x-dlt-test \
  -p 'test_*.py' -v
```

For diagnostic extraction/normalization/load progress, use the transient
runtime settings below. They affect only that process and therefore require no
cleanup in the repository's `.dlt/config.toml`:

```sh
RUNTIME__LOG_LEVEL=INFO \
RUNTIME__HTTP_SHOW_ERROR_BODY=true \
uv run python scripts/lightspeed-x-dlt-test/pipeline.py mock \
  --progress log \
  --state-dir scripts/lightspeed-x-dlt-test/.state/diagnostic
```

The final JSON line reports the DuckDB path, local pipeline-state directory,
trace step outcomes, physical table counts, the updated sale/inventory values,
the decimal SQL type, and the largest text-safe quote ID.

Each default mock run uses a fresh timestamped directory under `.state/` so a
cursor from an earlier successful validation cannot affect a later result. An
explicit `--state-dir` is accepted only when it does not already contain this
fixture pipeline.

## Optional real demo-store check

Real execution is intentionally separate and requires an explicit confirmation:

```sh
uv run python scripts/lightspeed-x-dlt-test/pipeline.py real \
  --confirm-demo-store \
  --state-dir scripts/lightspeed-x-dlt-test/.state/demo-store
```

Do not place tokens in command arguments, environment dumps, this README, or
source files. Configure the following through dlt's normal configuration
providers in a user-controlled terminal:

```toml
# non-secret dlt config
[sources.lightspeed_x]
domain_prefix = "your-demo-retailer-prefix"
```

```toml
# secret dlt provider; edit privately, never print it
[sources.lightspeed_x]
access_token = "your-short-lived-demo-store-access-token"
```

The network mode resolves those values only through `dlt.config` and
`dlt.secrets`. It is read-only, API-version pinned, retailer-host validated,
sequential to avoid rate-limit bursts, and rejects execution unless
`--confirm-demo-store` is present. A fulfillment-history parent ID is optional
and excluded by default in real mode; the production connector owns exhaustive
parent fan-out and durable scheduling.
