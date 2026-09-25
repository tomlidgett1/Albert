#!/usr/bin/env python3
"""Safe dlt validation harness for Lightspeed Retail X-Series API 2026-07.

The default mode runs an entirely local two-phase fixture. Real demo-store
execution is a separate, explicit mode and resolves its bearer token through
``dlt.secrets`` and its retailer domain prefix through ``dlt.config``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Iterator, List, Mapping, MutableMapping, Optional, Sequence, Tuple

import dlt
import duckdb
import requests

from mock_api import FIXTURE_TOKEN, FixtureApiServer


API_VERSION = "2026-07"
OPENAPI_SHA256 = "123b2630178c376990dd7219f92e068e5f77ac9cd991a80e0fafa97ad8613dd7"
PIPELINE_NAME = "lightspeed_x_fixture_validation"
DATASET_NAME = "lightspeed_x_fixture"
PAGE_SIZE = 2
MAX_PAGES = 100_000
RETRYABLE_STATUSES = {429, 500, 502, 503, 504}
DOMAIN_PREFIX_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
SCRIPT_DIR = Path(__file__).resolve().parent


class PaginationError(RuntimeError):
    """Raised when a vendor cursor cannot prove forward progress."""


class XSeriesHttpError(RuntimeError):
    """Raised for a terminal X-Series HTTP response."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Page:
    rows: Sequence[Mapping[str, Any]]
    cursor: Optional[str] = None


@dataclass(frozen=True)
class MockRunResult:
    database_path: Path
    pipelines_dir: Path
    request_log: Sequence[Mapping[str, Any]]
    trace_summary: Mapping[str, Any]
    validation: Mapping[str, Any]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_retry_after(value: Optional[str], now: Optional[datetime] = None) -> Optional[int]:
    """Parse either RFC 9110 delay-seconds or an RFC 1123 HTTP-date."""

    if value is None or not value.strip():
        return None
    cleaned = value.strip()
    if cleaned.isdigit():
        return max(0, int(cleaned))
    try:
        parsed = parsedate_to_datetime(cleaned)
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    current = now or datetime.now(timezone.utc)
    return max(0, math.ceil((parsed.astimezone(timezone.utc) - current.astimezone(timezone.utc)).total_seconds()))


def _as_mapping(value: object, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise PaginationError(f"{label} response was not an object")
    return value


def _as_rows(value: object, label: str) -> Sequence[Mapping[str, Any]]:
    if not isinstance(value, list):
        raise PaginationError(f"{label} data was not an array")
    if not all(isinstance(row, Mapping) for row in value):
        raise PaginationError(f"{label} data contained a non-object row")
    return value


def _positive_int(value: object, label: str) -> int:
    if isinstance(value, bool):
        raise PaginationError(f"{label} was not an integer")
    if isinstance(value, int):
        parsed = value
    elif isinstance(value, str) and re.fullmatch(r"(?:0|[1-9][0-9]*)", value):
        parsed = int(value)
    else:
        raise PaginationError(f"{label} was not an integer")
    if parsed < 0:
        raise PaginationError(f"{label} was negative")
    return parsed


class XSeriesClient:
    """Sequential, header-aware reader with bounded retries and no secret logs."""

    def __init__(
        self,
        base_url: str,
        access_token: str,
        *,
        sleeper: Callable[[float], None] = time.sleep,
        max_attempts: int = 7,
        timeout: Tuple[float, float] = (15, 90),
    ) -> None:
        self.base_url = base_url.rstrip("/") + "/"
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Accept": "application/json",
                "Authorization": f"Bearer {access_token}",
                "User-Agent": "Albert-Lightspeed-X-dlt-validation/1.0",
            }
        )
        self.sleeper = sleeper
        self.max_attempts = max_attempts
        self.timeout = timeout
        self.rate_limit: Optional[int] = None
        self.rate_remaining: Optional[int] = None
        self.retries = 0
        self.requests = 0

    def close(self) -> None:
        self.session.close()

    def request_json(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Mapping[str, object]] = None,
        body: Optional[Mapping[str, object]] = None,
    ) -> object:
        response: Optional[requests.Response] = None
        for attempt in range(self.max_attempts):
            response = self.session.request(
                method,
                self.base_url + path.lstrip("/"),
                params=dict(params or {}),
                json=dict(body) if body is not None else None,
                timeout=self.timeout,
            )
            self.requests += 1
            self.rate_limit = _optional_header_int(response.headers.get("X-RateLimit-Limit"))
            self.rate_remaining = _optional_header_int(response.headers.get("X-RateLimit-Remaining"))
            if response.status_code not in RETRYABLE_STATUSES:
                break
            if attempt + 1 >= self.max_attempts:
                break
            retry_after = parse_retry_after(response.headers.get("Retry-After"))
            delay = float(retry_after if retry_after is not None else min(300, 2**attempt))
            self.retries += 1
            print(
                json.dumps(
                    {
                        "event": "x_series_retry",
                        "status": response.status_code,
                        "attempt": attempt + 1,
                        "delay_seconds": delay,
                        "rate_remaining": self.rate_remaining,
                    }
                ),
                flush=True,
            )
            self.sleeper(delay)
        if response is None:
            raise XSeriesHttpError(0, "request produced no response")
        if not response.ok:
            raise XSeriesHttpError(response.status_code, f"X-Series request failed with HTTP {response.status_code}")
        try:
            return json.loads(response.text, parse_float=Decimal)
        except (json.JSONDecodeError, TypeError) as error:
            raise XSeriesHttpError(response.status_code, "X-Series response was not JSON") from error


def _optional_header_int(value: Optional[str]) -> Optional[int]:
    return int(value) if value is not None and value.isdigit() else None


def iter_version_pages(
    client: XSeriesClient,
    path: str,
    after: str,
    *,
    page_size: int = 1000,
    max_pages: int = MAX_PAGES,
) -> Iterator[Page]:
    """Walk the documented 2.0 ``after`` / ``version.max`` protocol."""

    cursor = _positive_int(after, "initial version cursor")
    for _ in range(max_pages):
        payload = _as_mapping(
            client.request_json("GET", path, params={"after": str(cursor), "page_size": page_size}),
            path,
        )
        rows = _as_rows(payload.get("data"), f"{path}.data")
        if not rows:
            return
        version = _as_mapping(payload.get("version"), f"{path}.version")
        next_cursor = _positive_int(version.get("max"), f"{path}.version.max")
        if next_cursor <= cursor:
            raise PaginationError(f"{path} version cursor did not advance ({next_cursor} <= {cursor})")
        yield Page(rows, str(next_cursor))
        cursor = next_cursor
    raise PaginationError(f"{path} exceeded the {max_pages}-page safety ceiling")


def iter_inventory_pages(
    client: XSeriesClient,
    after: str,
    *,
    page_size: int = 5000,
    max_pages: int = MAX_PAGES,
) -> Iterator[Page]:
    """Walk the 2026-07 read-only POST /inventory body cursor."""

    cursor = _positive_int(after, "initial inventory cursor")
    for _ in range(max_pages):
        rows = _as_rows(
            client.request_json(
                "POST",
                "inventory",
                body={
                    "after": cursor,
                    "size": page_size,
                    "sort_direction": "asc",
                    "include_deleted": True,
                },
            ),
            "inventory",
        )
        if not rows:
            return
        versions = [_positive_int(row.get("version"), "inventory.version") for row in rows]
        next_cursor = max(versions)
        if next_cursor <= cursor:
            raise PaginationError(f"inventory body cursor did not advance ({next_cursor} <= {cursor})")
        yield Page(rows, str(next_cursor))
        cursor = next_cursor
    raise PaginationError(f"inventory exceeded the {max_pages}-page safety ceiling")


def iter_offset_pages(
    client: XSeriesClient,
    *,
    page_size: int = 10000,
    max_pages: int = MAX_PAGES,
) -> Iterator[Page]:
    """Walk POST /inventory_levels until an explicit empty page."""

    offset = 0
    for _ in range(max_pages):
        rows = _as_rows(
            client.request_json(
                "POST",
                "inventory_levels",
                body={"offset": offset, "size": page_size, "sort_direction": "asc", "sort_type": "product_name"},
            ),
            "inventory_levels",
        )
        if not rows:
            return
        next_offset = offset + len(rows)
        if next_offset <= offset:
            raise PaginationError("inventory_levels offset did not advance")
        yield Page(rows, str(next_offset))
        offset = next_offset
    raise PaginationError(f"inventory_levels exceeded the {max_pages}-page safety ceiling")


def iter_page_number_pages(
    client: XSeriesClient,
    *,
    page_size: int = 100,
    max_pages: int = MAX_PAGES,
) -> Iterator[Page]:
    """Walk GET /fulfillments by page number until an empty page."""

    page_number = 1
    for _ in range(max_pages):
        payload = _as_mapping(
            client.request_json(
                "GET",
                "fulfillments",
                params={"page_number": page_number, "page_size": page_size},
            ),
            "fulfillments",
        )
        rows = _as_rows(payload.get("data"), "fulfillments.data")
        if not rows:
            return
        yield Page(rows, str(page_number))
        page_number += 1
    raise PaginationError(f"fulfillments exceeded the {max_pages}-page safety ceiling")


def iter_category_cursor_pages(client: XSeriesClient, *, max_pages: int = MAX_PAGES) -> Iterator[Page]:
    """Walk product categories using its endpoint-specific opaque cursor."""

    cursor: Optional[str] = None
    for _ in range(max_pages):
        params: Dict[str, object] = {"page_size": 1000}
        if cursor is not None:
            params["after"] = cursor
        payload = _as_mapping(client.request_json("GET", "product_categories", params=params), "product_categories")
        data = _as_mapping(payload.get("data"), "product_categories.data")
        rows = _as_rows(data.get("categories"), "product_categories.data.categories")
        if not rows:
            return
        page_info = _as_mapping(payload.get("page_info", {}), "product_categories.page_info")
        has_next = page_info.get("has_next") is True
        next_cursor = page_info.get("last_seen")
        if has_next:
            if not isinstance(next_cursor, str) or not next_cursor or next_cursor == cursor:
                raise PaginationError("product_categories opaque cursor was empty or repeated")
        yield Page(rows, next_cursor if isinstance(next_cursor, str) else None)
        if not has_next:
            return
        cursor = next_cursor
    raise PaginationError(f"product_categories exceeded the {max_pages}-page safety ceiling")


def iter_id_cursor_pages(
    client: XSeriesClient,
    after: str,
    *,
    max_pages: int = MAX_PAGES,
) -> Iterator[Page]:
    """Walk quotes with string-preserved int64 IDs and ``HasNext``."""

    cursor = _positive_int(after, "initial quote ID cursor")
    for _ in range(max_pages):
        payload = _as_mapping(
            client.request_json("GET", "quotes", params={"after": str(cursor), "limit": 100}),
            "quotes",
        )
        rows = _as_rows(payload.get("Quotes"), "quotes.Quotes")
        if not rows:
            return
        ids = [_positive_int(row.get("id"), "quote.id") for row in rows]
        next_cursor = max(ids)
        if next_cursor <= cursor:
            raise PaginationError(f"quotes ID cursor did not advance ({next_cursor} <= {cursor})")
        yield Page(rows, str(next_cursor))
        cursor = next_cursor
        if payload.get("HasNext") is not True:
            return
    raise PaginationError(f"quotes exceeded the {max_pages}-page safety ceiling")


def iter_history_cursor_pages(
    client: XSeriesClient,
    fulfillment_id: str,
    *,
    max_pages: int = MAX_PAGES,
) -> Iterator[Page]:
    """Walk fulfillment history with its opaque ``next_cursor``."""

    cursor: Optional[str] = None
    for _ in range(max_pages):
        params = {"cursor": cursor} if cursor is not None else {}
        payload = _as_mapping(
            client.request_json("GET", f"fulfillments/{fulfillment_id}/history", params=params),
            "fulfillment_history",
        )
        rows = _as_rows(payload.get("data"), "fulfillment_history.data")
        if not rows:
            return
        next_cursor = payload.get("next_cursor")
        if next_cursor not in (None, ""):
            if not isinstance(next_cursor, str) or next_cursor == cursor:
                raise PaginationError("fulfillment_history opaque cursor repeated")
        yield Page(rows, next_cursor if isinstance(next_cursor, str) else None)
        if next_cursor in (None, ""):
            return
        cursor = next_cursor
    raise PaginationError(f"fulfillment_history exceeded the {max_pages}-page safety ceiling")


def _money(row: Mapping[str, Any], *path: str) -> Optional[Decimal]:
    value: object = row
    for part in path:
        if not isinstance(value, Mapping):
            return None
        value = value.get(part)
    if value is None:
        return None
    return value if isinstance(value, Decimal) else Decimal(str(value))


def _enrich(row: Mapping[str, Any], endpoint: str, cursor: Optional[str]) -> Dict[str, Any]:
    enriched = dict(row)
    enriched["x_api_version"] = API_VERSION
    enriched["x_endpoint"] = endpoint
    enriched["x_cursor"] = cursor
    enriched["x_extracted_at"] = utc_now()
    return enriched


def _state_after(state: MutableMapping[str, Any]) -> str:
    value = state.get("after", "0")
    return str(value)


def _upsert_disposition() -> Mapping[str, str]:
    return {"disposition": "merge", "strategy": "upsert"}


def sales_resource(client: XSeriesClient):
    @dlt.resource(
        name="sales",
        primary_key="id",
        write_disposition=_upsert_disposition(),
        columns={
            "totals__loyalty": {"data_type": "decimal", "precision": 38, "scale": 9},
            "totals__price": {"data_type": "decimal", "precision": 38, "scale": 9},
            "totals__price_incl_tax": {"data_type": "decimal", "precision": 38, "scale": 9},
            "totals__surcharge": {"data_type": "decimal", "precision": 38, "scale": 9},
            "totals__tax": {"data_type": "decimal", "precision": 38, "scale": 9},
            "x_cursor_version": {"data_type": "bigint"},
            "x_money_price_incl_tax": {"data_type": "decimal", "precision": 38, "scale": 9},
        },
        max_table_nesting=20,
    )
    def sales() -> Iterator[Sequence[Mapping[str, Any]]]:
        state = dlt.current.resource_state()
        for page in iter_version_pages(client, "sales", _state_after(state), page_size=1000):
            rows = []
            for row in page.rows:
                enriched = _enrich(row, "GET /sales", page.cursor)
                enriched["x_cursor_version"] = _positive_int(page.cursor, "sales cursor")
                enriched["x_money_price_incl_tax"] = _money(row, "totals", "price_incl_tax")
                rows.append(enriched)
            state["after"] = page.cursor
            yield rows

    return sales


def inventory_resource(client: XSeriesClient):
    @dlt.resource(
        name="inventory",
        primary_key="id",
        write_disposition=_upsert_disposition(),
        columns={
            "average_cost": {"data_type": "decimal", "precision": 38, "scale": 9},
            "current_inventory_level": {"data_type": "decimal", "precision": 38, "scale": 9},
            "deleted_at": {"data_type": "timestamp"},
            "quantity_to_procure": {"data_type": "decimal", "precision": 38, "scale": 9},
            "reorder_amount": {"data_type": "decimal", "precision": 38, "scale": 9},
            "reorder_point": {"data_type": "decimal", "precision": 38, "scale": 9},
            "reorder_target": {"data_type": "decimal", "precision": 38, "scale": 9},
            "x_money_average_cost": {"data_type": "decimal", "precision": 38, "scale": 9},
        },
    )
    def inventory() -> Iterator[Sequence[Mapping[str, Any]]]:
        state = dlt.current.resource_state()
        for page in iter_inventory_pages(client, _state_after(state)):
            rows = []
            for row in page.rows:
                enriched = _enrich(row, "POST /inventory", page.cursor)
                enriched["x_money_average_cost"] = _money(row, "average_cost")
                rows.append(enriched)
            state["after"] = page.cursor
            yield rows

    return inventory


def inventory_levels_resource(client: XSeriesClient):
    @dlt.resource(
        name="inventory_levels",
        primary_key=["location_id", "product_id"],
        write_disposition="replace",
        columns={
            "average_cost": {"data_type": "decimal", "precision": 38, "scale": 9},
            "current_inventory_level": {"data_type": "decimal", "precision": 38, "scale": 9},
            "quantity_to_procure": {"data_type": "decimal", "precision": 38, "scale": 9},
            "reorder_amount": {"data_type": "decimal", "precision": 38, "scale": 9},
            "reorder_target": {"data_type": "decimal", "precision": 38, "scale": 9},
            "reorder_threshold": {"data_type": "decimal", "precision": 38, "scale": 9},
            "total_cost": {"data_type": "decimal", "precision": 38, "scale": 9},
            "x_money_average_cost": {"data_type": "decimal", "precision": 38, "scale": 9},
            "x_money_total_cost": {"data_type": "decimal", "precision": 38, "scale": 9},
        },
    )
    def inventory_levels() -> Iterator[Sequence[Mapping[str, Any]]]:
        for page in iter_offset_pages(client):
            rows = []
            for row in page.rows:
                enriched = _enrich(row, "POST /inventory_levels", page.cursor)
                enriched["x_money_average_cost"] = _money(row, "average_cost")
                enriched["x_money_total_cost"] = _money(row, "total_cost")
                rows.append(enriched)
            yield rows

    return inventory_levels


def fulfillments_resource(client: XSeriesClient):
    @dlt.resource(name="fulfillments", primary_key="id", write_disposition="replace", max_table_nesting=20)
    def fulfillments() -> Iterator[Sequence[Mapping[str, Any]]]:
        for page in iter_page_number_pages(client):
            yield [_enrich(row, "GET /fulfillments", page.cursor) for row in page.rows]

    return fulfillments


def categories_resource(client: XSeriesClient):
    @dlt.resource(name="product_categories", primary_key="id", write_disposition="replace", max_table_nesting=20)
    def product_categories() -> Iterator[Sequence[Mapping[str, Any]]]:
        for page in iter_category_cursor_pages(client):
            yield [_enrich(row, "GET /product_categories", page.cursor) for row in page.rows]

    return product_categories


def quotes_resource(client: XSeriesClient):
    @dlt.resource(
        name="quotes",
        primary_key="id",
        write_disposition=_upsert_disposition(),
        columns={
            "deleted_at": {"data_type": "timestamp"},
            "grand_total": {"data_type": "decimal", "precision": 38, "scale": 9},
            "id": {"data_type": "text"},
            "loyalty": {"data_type": "decimal", "precision": 38, "scale": 9},
            "total_price": {"data_type": "decimal", "precision": 38, "scale": 9},
            "total_tax": {"data_type": "decimal", "precision": 38, "scale": 9},
            "x_money_grand_total": {"data_type": "decimal", "precision": 38, "scale": 9},
        },
        max_table_nesting=20,
    )
    def quotes() -> Iterator[Sequence[Mapping[str, Any]]]:
        state = dlt.current.resource_state()
        for page in iter_id_cursor_pages(client, _state_after(state)):
            rows = []
            for row in page.rows:
                enriched = _enrich(row, "GET /quotes", page.cursor)
                enriched["x_money_grand_total"] = _money(row, "grand_total")
                rows.append(enriched)
            state["after"] = page.cursor
            yield rows

    return quotes


def fulfillment_history_resource(client: XSeriesClient, fulfillment_id: str):
    @dlt.resource(name="fulfillment_history", write_disposition="replace")
    def fulfillment_history() -> Iterator[Sequence[Mapping[str, Any]]]:
        for page in iter_history_cursor_pages(client, fulfillment_id):
            rows = []
            for row in page.rows:
                enriched = _enrich(row, f"GET /fulfillments/{fulfillment_id}/history", page.cursor)
                enriched["fulfillment_id"] = fulfillment_id
                enriched["x_event_key"] = hashlib.sha256(
                    json.dumps(enriched, sort_keys=True, default=str).encode("utf-8")
                ).hexdigest()
                rows.append(enriched)
            yield rows

    return fulfillment_history


@dlt.source(name="lightspeed_x")
def lightspeed_x_source(
    access_token: str = dlt.secrets.value,
    domain_prefix: str = dlt.config.value,
    api_version: str = API_VERSION,
    base_url: Optional[str] = None,
    history_fulfillment_id: Optional[str] = None,
):
    """Return read-only X-Series resources.

    Real mode auto-resolves ``sources.lightspeed_x.access_token`` from
    ``dlt.secrets`` and ``sources.lightspeed_x.domain_prefix`` from
    ``dlt.config``. Mock mode passes both values explicitly.
    """

    if api_version != API_VERSION:
        raise ValueError(f"this validation contract is pinned to API {API_VERSION}")
    if base_url is None:
        if not DOMAIN_PREFIX_RE.fullmatch(domain_prefix):
            raise ValueError("invalid Lightspeed retailer domain prefix")
        base_url = f"https://{domain_prefix}.retail.lightspeed.app/api/{api_version}/"
    client = XSeriesClient(base_url, access_token)
    resources = [
        sales_resource(client),
        inventory_resource(client),
        inventory_levels_resource(client),
        fulfillments_resource(client),
        categories_resource(client),
        quotes_resource(client),
    ]
    if history_fulfillment_id:
        resources.append(fulfillment_history_resource(client, history_fulfillment_id))
    return resources


def _make_pipeline(state_dir: Path, progress: Optional[str]):
    state_dir.mkdir(parents=True, exist_ok=True)
    pipelines_dir = state_dir / "pipelines"
    pipelines_dir.mkdir(parents=True, exist_ok=True)
    # Keep the DuckDB catalog name distinct from DATASET_NAME. DuckDB treats
    # an identical catalog and schema name as ambiguous in generated SQL.
    database_path = state_dir / "fixture_landing.duckdb"
    pipeline = dlt.pipeline(
        pipeline_name=PIPELINE_NAME,
        destination=dlt.destinations.duckdb(credentials=str(database_path)),
        dataset_name=DATASET_NAME,
        pipelines_dir=str(pipelines_dir),
        progress=progress,
    )
    return pipeline, database_path, pipelines_dir


def _trace_summary(pipeline: Any) -> Mapping[str, Any]:
    trace = pipeline.last_trace
    if trace is None:
        return {"available": False}
    steps = []
    for step in trace.steps:
        steps.append(
            {
                "step": step.step,
                "started_at": step.started_at.isoformat() if step.started_at else None,
                "finished_at": step.finished_at.isoformat() if step.finished_at else None,
                "has_exception": step.step_exception is not None,
            }
        )
    return {"available": True, "steps": steps}


def validate_database(database_path: Path) -> Mapping[str, Any]:
    with duckdb.connect(str(database_path), read_only=True) as connection:
        table_counts = {
            table: connection.execute(f'SELECT count(*) FROM "{DATASET_NAME}"."{table}"').fetchone()[0]
            for table in [
                "sales",
                "inventory",
                "inventory_levels",
                "fulfillments",
                "product_categories",
                "quotes",
                "fulfillment_history",
            ]
        }
        sale_one = connection.execute(
            f'SELECT x_money_price_incl_tax, x_cursor_version FROM "{DATASET_NAME}".sales WHERE id = ?',
            ["sale-0001"],
        ).fetchone()
        inventory_one = connection.execute(
            f'SELECT current_inventory_level, version FROM "{DATASET_NAME}".inventory WHERE id = ?',
            ["inventory-0001"],
        ).fetchone()
        largest_quote = connection.execute(
            f'SELECT max(id), typeof(max(id)) FROM "{DATASET_NAME}".quotes'
        ).fetchone()
        money_type = connection.execute(
            """
            SELECT data_type
            FROM information_schema.columns
            WHERE table_schema = ? AND table_name = 'sales' AND column_name = 'x_money_price_incl_tax'
            """,
            [DATASET_NAME],
        ).fetchone()
        variant_columns = connection.execute(
            """
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = ? AND column_name LIKE '%\\_\\_v\\_%' ESCAPE '\\'
            ORDER BY table_name, column_name
            """,
            [DATASET_NAME],
        ).fetchall()
        if table_counts != {
            "sales": 4,
            "inventory": 3,
            "inventory_levels": 3,
            "fulfillments": 3,
            "product_categories": 3,
            "quotes": 3,
            "fulfillment_history": 3,
        }:
            raise AssertionError(f"unexpected fixture row counts: {table_counts}")
        if sale_one != (Decimal("14.340000000"), 14):
            raise AssertionError(f"sales upsert/decimal validation failed: {sale_one}")
        if inventory_one != (Decimal("9.000000000"), 23):
            raise AssertionError(f"inventory upsert validation failed: {inventory_one}")
        if largest_quote != ("9223372036854775002", "VARCHAR"):
            raise AssertionError(f"int64 identifier validation failed: {largest_quote}")
        if money_type is None or not str(money_type[0]).startswith("DECIMAL"):
            raise AssertionError(f"money column was not Decimal: {money_type}")
        if variant_columns:
            raise AssertionError(f"unexpected dlt variant columns: {variant_columns}")
        return {
            "table_counts": table_counts,
            "sale_0001": {"price_incl_tax": str(sale_one[0]), "cursor_version": sale_one[1]},
            "inventory_0001": {"level": str(inventory_one[0]), "version": inventory_one[1]},
            "largest_quote_id": largest_quote[0],
            "largest_quote_id_type": largest_quote[1],
            "money_type": money_type[0],
            "variant_columns": variant_columns,
        }


def _assert_mock_request_contract(requests_log: Sequence[Mapping[str, Any]]) -> None:
    statuses = [row["status"] for row in requests_log]
    if statuses.count(429) != 1:
        raise AssertionError(f"fixture expected exactly one 429, got {statuses.count(429)}")
    sales_after = [str(row["query"].get("after", "0")) for row in requests_log if row["path"].endswith("/sales")]
    if sales_after != ["0", "0", "11", "12", "12", "14"]:
        raise AssertionError(f"standard cursor request sequence differed: {sales_after}")
    offsets = [str(row["body"].get("offset", 0)) for row in requests_log if row["path"].endswith("/inventory_levels")]
    if offsets != ["0", "2", "3", "0", "2", "3"]:
        raise AssertionError(f"offset request sequence differed: {offsets}")
    page_numbers = [str(row["query"].get("page_number")) for row in requests_log if row["path"].endswith("/fulfillments")]
    if page_numbers != ["1", "2", "3", "1", "2", "3"]:
        raise AssertionError(f"page-number request sequence differed: {page_numbers}")


def run_mock(state_dir: Path, progress: Optional[str] = None) -> MockRunResult:
    if (state_dir / "fixture_landing.duckdb").exists() or (state_dir / "pipelines" / PIPELINE_NAME).exists():
        raise RuntimeError(
            f"mock state directory already contains a completed run: {state_dir}; choose a fresh --state-dir"
        )
    pipeline, database_path, pipelines_dir = _make_pipeline(state_dir, progress)
    with FixtureApiServer() as fixture:
        initial_source = lightspeed_x_source(
            access_token=FIXTURE_TOKEN,
            domain_prefix="fixture",
            base_url=fixture.base_url,
            history_fulfillment_id="fulfill-1",
        )
        first_info = pipeline.run(initial_source)
        print(json.dumps({"event": "fixture_initial_loaded", "load_ids": list(first_info.loads_ids)}), flush=True)

        fixture.set_phase("delta")
        delta_source = lightspeed_x_source(
            access_token=FIXTURE_TOKEN,
            domain_prefix="fixture",
            base_url=fixture.base_url,
            history_fulfillment_id="fulfill-1",
        )
        second_info = pipeline.run(delta_source)
        print(json.dumps({"event": "fixture_delta_loaded", "load_ids": list(second_info.loads_ids)}), flush=True)
        request_log = fixture.requests

    _assert_mock_request_contract(request_log)
    validation = validate_database(database_path)
    trace = _trace_summary(pipeline)
    return MockRunResult(database_path, pipelines_dir, request_log, trace, validation)


def run_real_demo(state_dir: Path, progress: Optional[str], confirmed: bool) -> Mapping[str, Any]:
    if not confirmed:
        raise RuntimeError("real mode requires --confirm-demo-store; use only a user-managed trial/demo retailer")
    pipeline, database_path, pipelines_dir = _make_pipeline(state_dir, progress)
    # dlt resolves access_token from dlt.secrets and domain_prefix from dlt.config.
    info = pipeline.run(lightspeed_x_source())
    return {
        "database_path": str(database_path),
        "pipelines_dir": str(pipelines_dir),
        "load_ids": list(info.loads_ids),
        "trace": _trace_summary(pipeline),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", nargs="?", choices=["mock", "real"], default="mock")
    default_run = f"run-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{os.getpid()}"
    parser.add_argument("--state-dir", type=Path, default=SCRIPT_DIR / ".state" / default_run)
    parser.add_argument("--progress", choices=["log"], default=None)
    parser.add_argument("--confirm-demo-store", action="store_true")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.mode == "real":
            result = run_real_demo(args.state_dir.resolve(), args.progress, args.confirm_demo_store)
        else:
            mock = run_mock(args.state_dir.resolve(), args.progress)
            result = {
                "database_path": str(mock.database_path),
                "pipelines_dir": str(mock.pipelines_dir),
                "requests": len(mock.request_log),
                "trace": mock.trace_summary,
                "validation": mock.validation,
            }
        print(json.dumps({"event": "complete", "mode": args.mode, **result}, default=str), flush=True)
        return 0
    except Exception as error:
        print(json.dumps({"event": "failed", "mode": args.mode, "error_type": type(error).__name__, "detail": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
