#!/usr/bin/env python3
"""Full Xero ingest for Albert's connected organisation into XER_OFFICIAL.

The launcher supplies a short-lived access token, the Xero organisation id,
the analytical Postgres URL, a spec-derived endpoint plan (including report
snapshot passes), and a bounded fan-out plan through the process environment.
No credential is written to a dlt secrets file.

Each complete Xero response envelope is kept; dlt then normalises every nested
object and array into related child tables, so invoice lines, addresses,
tracking values, payments, allocations, payslip earnings lines and similar
children are never discarded by a top-level selector.

Rate governance: ~1 request/second pacing, Retry-After honoured on 429/5xx,
and a hard reserve so the run defers (exit 75) before Xero's daily budget is
fully consumed, leaving headroom for other consumers of the connection.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterator, List, Mapping, Optional, Sequence

import dlt
import requests


DATASET_NAME = "XER_OFFICIAL"
PIPELINE_NAME = "albert_xero_official"
UNAVAILABLE_STATUSES = {401, 403, 404}
RETRYABLE_STATUSES = {429, 500, 502, 503, 504}
SAFE_PARAM_NAMES = {
    "includeArchived", "includeDeleted", "offset", "page", "pageSize", "pagesize",
    "reportYear", "status", "unitdp",
    # Report period parameters: without these the stored envelope cannot say
    # which month a report snapshot belongs to.
    "date", "fromDate", "toDate", "periods", "timeframe", "standardLayout",
}
# Stop issuing requests when this much of the daily allowance remains, so a
# rerun (and any other consumer of the connection) is never locked out.
DAY_LIMIT_RESERVE = 50
# Hard wall-clock ceiling for one HTTP round trip. requests' read timeout only
# bounds the gap between chunks, so a slow-dripping response can hang a run
# indefinitely; the watchdog aborts and retries with a fresh connection.
REQUEST_DEADLINE_SECONDS = 120


def required_env(name: str) -> str:
    value = os.environ.pop(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing {name}")
    return value


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def nested_value(value: object, path: str) -> object:
    current = value
    for segment in path.split("."):
        if not isinstance(current, Mapping):
            return None
        current = current.get(segment)
    return current


def list_count(payload: object, paths: Sequence[str]) -> int:
    counts = []
    for path in paths:
        value = nested_value(payload, path)
        counts.append(len(value) if isinstance(value, list) else 0)
    if isinstance(payload, list):
        counts.append(len(payload))
    return max(counts, default=0)


def safe_params(params: Mapping[str, str]) -> Dict[str, str]:
    return {key: value for key, value in params.items() if key in SAFE_PARAM_NAMES}


def sanitise_error(value: str) -> str:
    compact = re.sub(r"\s+", " ", value).strip()
    return compact[:240]


@dataclass
class FetchOutcome:
    status: str
    http_status: Optional[int]
    pages: int
    records: int
    day_remaining: Optional[int]
    detail: Optional[str]


class TransportFailure(RuntimeError):
    """Raised when repeated attempts never produced an HTTP response."""


class DailyBudgetExhausted(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        retry_after_seconds: Optional[int] = None,
        rate_limit_problem: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds
        self.rate_limit_problem = rate_limit_problem


class XeroClient:
    """Sequential, response-aware Xero reader with a conservative minute pace."""

    def __init__(self, access_token: str, tenant_id: str) -> None:
        self._headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {access_token}",
            "xero-tenant-id": tenant_id,
            "User-Agent": "Albert-Xero-official-ingest/1.0",
        }
        self.session = self._build_session()
        self._executor = ThreadPoolExecutor(max_workers=1)
        self.last_request_at = 0.0
        self.day_remaining: Optional[int] = None
        self.minute_remaining: Optional[int] = None
        self.retry_after_seconds: Optional[int] = None
        self.rate_limit_problem: Optional[str] = None

    def _build_session(self) -> requests.Session:
        session = requests.Session()
        session.headers.update(self._headers)
        return session

    def close(self) -> None:
        self.session.close()
        self._executor.shutdown(wait=False)

    def _issue(self, url: str, params: Mapping[str, str]) -> requests.Response:
        """One round trip under a hard wall-clock deadline.

        On deadline the pooled connection is torn down (which unblocks the
        worker thread) and the attempt reported as a timeout to the retry
        loop. A fresh executor replaces the abandoned worker.
        """
        session = self.session
        future = self._executor.submit(
            lambda: session.get(url, params=dict(params), timeout=(15, 75))
        )
        try:
            return future.result(timeout=REQUEST_DEADLINE_SECONDS)
        except FutureTimeoutError:
            session.close()
            self.session = self._build_session()
            self._executor.shutdown(wait=False)
            self._executor = ThreadPoolExecutor(max_workers=1)
            raise requests.exceptions.Timeout(
                f"request exceeded the {REQUEST_DEADLINE_SECONDS}s deadline"
            ) from None

    def get(self, url: str, params: Mapping[str, str]) -> requests.Response:
        if self.day_remaining is not None and self.day_remaining <= DAY_LIMIT_RESERVE:
            raise DailyBudgetExhausted(
                f"Stopping with {self.day_remaining} daily requests left (reserve {DAY_LIMIT_RESERVE})",
                retry_after_seconds=self.retry_after_seconds,
                rate_limit_problem="Daily (reserve)",
            )
        response: Optional[requests.Response] = None
        for attempt in range(6):
            elapsed = time.monotonic() - self.last_request_at
            if elapsed < 1.05:
                time.sleep(1.05 - elapsed)
            try:
                response = self._issue(url, params)
            except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as error:
                self.last_request_at = time.monotonic()
                delay = min(30, 2 ** attempt)
                print(json.dumps({
                    "event": "retry",
                    "status": "transport",
                    "detail": sanitise_error(str(error)),
                    "attempt": attempt + 1,
                    "delay_seconds": delay,
                    "day_remaining": self.day_remaining,
                }), flush=True)
                time.sleep(delay)
                continue
            self.last_request_at = time.monotonic()

            remaining = response.headers.get("X-DayLimit-Remaining")
            if remaining and remaining.isdigit():
                self.day_remaining = int(remaining)
            minute_remaining = response.headers.get("X-MinLimit-Remaining")
            if minute_remaining and minute_remaining.isdigit():
                self.minute_remaining = int(minute_remaining)
            retry_after = response.headers.get("Retry-After")
            self.retry_after_seconds = (
                int(retry_after)
                if retry_after and retry_after.isdigit()
                else None
            )
            self.rate_limit_problem = response.headers.get("X-Rate-Limit-Problem")

            if response.status_code not in RETRYABLE_STATUSES:
                return response

            if response.status_code == 429 and self.day_remaining is not None and self.day_remaining <= 0:
                print(json.dumps({
                    "event": "rate_limit",
                    "status": response.status_code,
                    "day_remaining": self.day_remaining,
                    "minute_remaining": self.minute_remaining,
                    "retry_after_seconds": self.retry_after_seconds,
                    "rate_limit_problem": self.rate_limit_problem,
                    "action": "stop",
                }), flush=True)
                return response

            if retry_after and retry_after.isdigit():
                delay = min(65, max(1, int(retry_after)))
            else:
                delay = min(30, 2 ** attempt)
            print(json.dumps({
                "event": "retry",
                "status": response.status_code,
                "attempt": attempt + 1,
                "delay_seconds": delay,
                "day_remaining": self.day_remaining,
            }), flush=True)
            time.sleep(delay)
        if response is None:
            raise TransportFailure("every attempt failed at the transport layer")
        return response


def response_wrapper(
    api: str,
    endpoint: str,
    page: int,
    params: Mapping[str, str],
    payload: object,
    parent_id: Optional[str] = None,
) -> Dict[str, object]:
    wrapper: Dict[str, object] = {
        "_xero_api": api,
        "_xero_endpoint": endpoint,
        "_xero_page": page,
        "_xero_params": safe_params(params),
        "_xero_extracted_at": utc_now(),
        "payload": payload,
    }
    if parent_id is not None:
        wrapper["_xero_parent_id"] = parent_id
    return wrapper


def page_fingerprint(payload: object, array_keys: Sequence[str]) -> str:
    """Stable fingerprint of a page's record arrays.

    Some endpoints (AU payroll PayItems) silently ignore the page parameter
    and return the identical body for every page, which would loop forever.
    Envelope timestamps (DateTimeUTC) change per request, so the fingerprint
    covers only the extracted record arrays.
    """
    arrays: Dict[str, object] = {}
    for path in array_keys:
        value = nested_value(payload, path)
        if isinstance(value, list):
            arrays[path] = value
    if not arrays and isinstance(payload, Mapping):
        arrays = {
            key: value for key, value in payload.items() if isinstance(value, list)
        }
    return json.dumps(arrays, sort_keys=True, default=str)


# No legitimate Xero collection walk needs more pages than this; the cap is a
# backstop against any other pagination-ignoring endpoint.
MAX_PAGES_PER_PASS = 400


def fetch_endpoint(
    client: XeroClient,
    spec: Mapping[str, Any],
    captured: List[Dict[str, object]],
) -> FetchOutcome:
    pages = 0
    records = 0
    passes = spec.get("passes") or [{}]

    for pass_params in passes:
        page = 1
        offset = 0
        previous_fingerprint: Optional[str] = None
        while True:
            params: Dict[str, str] = {str(k): str(v) for k, v in spec.get("params", {}).items()}
            params.update({str(k): str(v) for k, v in pass_params.items()})
            pagination = spec["pagination"]
            if pagination == "page":
                params[str(spec["pageParam"])] = str(page)
                page_size_param = spec.get("pageSizeParam")
                if page_size_param:
                    params[str(page_size_param)] = str(spec["pageSize"])
            elif pagination == "offset":
                params["offset"] = str(offset)

            try:
                response = client.get(str(spec["url"]), params)
            except TransportFailure as error:
                return FetchOutcome(
                    "failed", None, pages, records, client.day_remaining, sanitise_error(str(error)),
                )
            if response.status_code in UNAVAILABLE_STATUSES:
                return FetchOutcome(
                    "unavailable",
                    response.status_code,
                    pages,
                    records,
                    client.day_remaining,
                    f"endpoint returned HTTP {response.status_code}",
                )
            if not response.ok:
                return FetchOutcome(
                    "failed",
                    response.status_code,
                    pages,
                    records,
                    client.day_remaining,
                    sanitise_error(response.text),
                )

            try:
                payload = response.json()
            except ValueError:
                return FetchOutcome(
                    "failed",
                    response.status_code,
                    pages,
                    records,
                    client.day_remaining,
                    "endpoint did not return JSON",
                )

            count = list_count(payload, spec.get("arrayKeys", []))
            fingerprint = page_fingerprint(payload, spec.get("arrayKeys", []))
            if pagination == "page" and page > 1 and fingerprint == previous_fingerprint:
                # The endpoint ignored the page parameter; the walk is done.
                break
            previous_fingerprint = fingerprint

            pages += 1
            records += count
            captured.append(response_wrapper(str(spec["api"]), str(spec["endpointOp"]), page, params, payload))

            if pagination == "none":
                break
            if count == 0:
                break
            if pagination == "page":
                if page >= MAX_PAGES_PER_PASS:
                    break
                page += 1
                continue

            journals = nested_value(payload, "Journals")
            journal_numbers = [
                row.get("JournalNumber")
                for row in journals
                if isinstance(row, Mapping) and isinstance(row.get("JournalNumber"), int)
            ] if isinstance(journals, list) else []
            next_offset = max(journal_numbers, default=offset)
            if next_offset <= offset:
                break
            offset = next_offset

    return FetchOutcome("loaded", 200, pages, records, client.day_remaining, None)


def extract_parent_ids(captured_rows: Sequence[Mapping[str, object]], dotted_path: str) -> List[str]:
    """Collect ids from captured envelopes by descending a dotted path.

    Each segment may land on a list (iterated) or a mapping (descended), so
    `PayRuns.Payslips.PayslipID` walks pay runs, then each run's payslip
    stubs, then reads the id off each stub.
    """
    ids: List[str] = []
    seen: set[str] = set()

    def walk(value: object, segments: Sequence[str]) -> None:
        if isinstance(value, list):
            for item in value:
                walk(item, segments)
            return
        if not segments:
            if isinstance(value, (str, int)):
                text = str(value).strip()
                if text and text not in seen:
                    seen.add(text)
                    ids.append(text)
            return
        if isinstance(value, Mapping):
            walk(value.get(segments[0]), segments[1:])

    for row in captured_rows:
        walk(row.get("payload"), dotted_path.split("."))
    return ids


def fetch_fan_out(
    client: XeroClient,
    spec: Mapping[str, Any],
    parent_ids: Sequence[str],
    captured: List[Dict[str, object]],
) -> FetchOutcome:
    pages = 0
    records = 0
    for parent_id in parent_ids:
        url = str(spec["urlTemplate"]).replace("{id}", requests.utils.quote(parent_id, safe=""))
        page = 1
        previous_fingerprint: Optional[str] = None
        while True:
            params: Dict[str, str] = {str(k): str(v) for k, v in spec.get("params", {}).items()}
            pagination = str(spec.get("pagination", "none"))
            if pagination == "page":
                params[str(spec["pageParam"])] = str(page)
                page_size_param = spec.get("pageSizeParam")
                if page_size_param:
                    params[str(page_size_param)] = str(spec["pageSize"])

            try:
                response = client.get(url, params)
            except TransportFailure as error:
                return FetchOutcome(
                    "failed", None, pages, records, client.day_remaining, sanitise_error(str(error)),
                )
            if response.status_code in UNAVAILABLE_STATUSES:
                # A single missing parent must not sink the whole fan-out.
                break
            if not response.ok:
                return FetchOutcome(
                    "failed",
                    response.status_code,
                    pages,
                    records,
                    client.day_remaining,
                    sanitise_error(response.text),
                )
            try:
                payload = response.json()
            except ValueError:
                return FetchOutcome(
                    "failed", response.status_code, pages, records, client.day_remaining,
                    "endpoint did not return JSON",
                )

            count = list_count(payload, spec.get("arrayKeys", []))
            fingerprint = page_fingerprint(payload, spec.get("arrayKeys", []))
            if pagination == "page" and page > 1 and fingerprint == previous_fingerprint:
                break
            previous_fingerprint = fingerprint

            pages += 1
            records += count
            captured.append(response_wrapper(
                "fan_out",
                str(spec["urlTemplate"]),
                page,
                params,
                payload,
                parent_id=parent_id,
            ))

            if pagination != "page" or count == 0 or page >= MAX_PAGES_PER_PASS:
                break
            page += 1

    return FetchOutcome("loaded", 200, pages, records, client.day_remaining, None)


def make_resource(name: str, rows: Sequence[Mapping[str, object]], write_disposition: str = "replace"):
    @dlt.resource(
        name=name,
        write_disposition=write_disposition,
        max_table_nesting=20,
    )
    def endpoint_rows() -> Iterator[Mapping[str, object]]:
        yield from rows

    return endpoint_rows


def existing_parent_ids(pipeline, table_name: str, column: str = "_xero_parent_id") -> set:
    """Parent ids a previous (partial) run already landed for a fan-out."""
    try:
        with pipeline.sql_client() as client:
            with client.execute_query(
                f'select distinct "{column}" from {client.make_qualified_table_name(table_name)}'
            ) as cursor:
                return {str(row[0]) for row in cursor.fetchall() if row[0] is not None}
    except Exception:
        return set()


def db_parent_ids(pipeline, sql: str) -> List[str]:
    """Parent ids read straight from landed tables, for resume runs where the
    parent endpoint was skipped and no captured payloads exist in memory."""
    try:
        with pipeline.sql_client() as client:
            with client.execute_query(sql) as cursor:
                seen = set()
                out: List[str] = []
                for row in cursor.fetchall():
                    if row[0] is None:
                        continue
                    text = str(row[0]).strip()
                    if text and text not in seen:
                        seen.add(text)
                        out.append(text)
                return out
    except Exception:
        return []


def organisation_country(client: XeroClient) -> str:
    response = client.get("https://api.xero.com/api.xro/2.0/Organisation", {})
    if response.status_code == 429 and client.day_remaining == 0:
        raise DailyBudgetExhausted(
            "Xero daily request allowance is exhausted",
            retry_after_seconds=client.retry_after_seconds,
            rate_limit_problem=client.rate_limit_problem,
        )
    if not response.ok:
        raise RuntimeError(f"Xero Organisation preflight failed with HTTP {response.status_code}")
    payload = response.json()
    organisations = payload.get("Organisations", []) if isinstance(payload, Mapping) else []
    first = organisations[0] if isinstance(organisations, list) and organisations else {}
    country = first.get("CountryCode") if isinstance(first, Mapping) else None
    return country.upper() if isinstance(country, str) else "UNKNOWN"


def endpoint_applies(spec: Mapping[str, Any], country: str) -> bool:
    api = str(spec["api"])
    if not api.startswith("payroll_"):
        return True
    wanted = {"payroll_au": "AU", "payroll_nz": "NZ", "payroll_uk": "GB"}[api]
    return country == wanted


def manifest_row(
    *,
    api: str,
    endpoint: str,
    resource_name: str,
    availability: str,
    status: str,
    outcome: Optional[FetchOutcome],
    client: XeroClient,
    started_at: str,
    country: str,
    detail: Optional[str] = None,
) -> Dict[str, object]:
    retry_at = (
        (datetime.now(timezone.utc) + timedelta(seconds=client.retry_after_seconds)).isoformat()
        if client.retry_after_seconds is not None
        else None
    )
    return {
        "api": api,
        "endpoint": endpoint,
        "resource_name": resource_name,
        "availability": availability,
        "status": status,
        "http_status": outcome.http_status if outcome else None,
        "pages": outcome.pages if outcome else 0,
        "records": outcome.records if outcome else 0,
        "day_remaining": client.day_remaining,
        "minute_remaining": client.minute_remaining,
        "retry_after_seconds": client.retry_after_seconds,
        "retry_at": retry_at,
        "rate_limit_problem": client.rate_limit_problem,
        "detail": detail or (outcome.detail if outcome else None),
        "started_at": started_at,
        "completed_at": utc_now(),
        "organisation_country": country,
    }


def main() -> int:
    access_token = required_env("XERO_DLT_ACCESS_TOKEN")
    tenant_id = required_env("XERO_DLT_TENANT_ID")
    destination_url = required_env("XERO_DLT_DESTINATION_URL")
    endpoint_plan = json.loads(required_env("XERO_DLT_ENDPOINTS_JSON"))
    fan_out_plan = json.loads(os.environ.pop("XERO_DLT_FANOUTS_JSON", "[]"))
    # Resources already landed by a prior run today; skipped to spare the daily
    # budget. Fan-out parents must never be listed here (their captured
    # payloads supply the fan-out ids).
    skip_resources = {
        name.strip()
        for name in os.environ.pop("XERO_DLT_SKIP_RESOURCES", "").split(",")
        if name.strip()
    }
    # Resume mode: run only these resources. Untouched resources keep their
    # existing tables and manifest rows (the manifest is merged, not replaced).
    only_resources = {
        name.strip()
        for name in os.environ.pop("XERO_DLT_ONLY", "").split(",")
        if name.strip()
    }
    if not isinstance(endpoint_plan, list) or not endpoint_plan:
        raise RuntimeError("The Xero endpoint plan is empty")

    client = XeroClient(access_token, tenant_id)
    access_token = ""
    tenant_id = ""
    statuses: List[Dict[str, object]] = []
    # Captured envelopes retained only for resources that feed a fan-out.
    fan_out_parent_names = {str(spec["parentResource"]) for spec in fan_out_plan}
    captured_by_resource: Dict[str, List[Dict[str, object]]] = {}
    deferred = False

    try:
        destination = dlt.destinations.postgres(
            credentials=destination_url,
            create_indexes=False,
            naming_convention="sql_cs_v1",
        )
        destination_url = ""
        pipeline = dlt.pipeline(
            pipeline_name=PIPELINE_NAME,
            destination=destination,
            dataset_name=DATASET_NAME,
            progress="log",
        )

        try:
            country = organisation_country(client)
        except DailyBudgetExhausted as error:
            retry_at = (
                datetime.now(timezone.utc) + timedelta(seconds=error.retry_after_seconds)
                if error.retry_after_seconds is not None
                else None
            )
            pipeline.run(
                [{
                    "api": "accounting",
                    "endpoint": "GET /Organisation",
                    "resource_name": "preflight",
                    "availability": "required",
                    "status": "blocked_daily_limit",
                    "http_status": 429,
                    "pages": 0,
                    "records": 0,
                    "day_remaining": 0,
                    "minute_remaining": client.minute_remaining,
                    "retry_after_seconds": error.retry_after_seconds,
                    "retry_at": retry_at.isoformat() if retry_at is not None else None,
                    "rate_limit_problem": error.rate_limit_problem,
                    "detail": "Xero daily request allowance is exhausted; rerun after the vendor budget resets",
                    "started_at": utc_now(),
                    "completed_at": utc_now(),
                    "organisation_country": "UNKNOWN",
                }],
                table_name="ingestion_manifest",
                write_disposition="replace",
            )
            print(json.dumps({
                "event": "blocked",
                "dataset": DATASET_NAME,
                "reason": "xero_daily_limit",
                "day_remaining": 0,
                "retry_after_seconds": error.retry_after_seconds,
            }), flush=True)
            return 75

        selected = [spec for spec in endpoint_plan if endpoint_applies(spec, country)]
        total_steps = len(selected) + len(fan_out_plan)

        # ---- Phase 1: root endpoints and report snapshots -----------------
        for index, spec in enumerate(selected, start=1):
            if only_resources and str(spec["resourceName"]) not in only_resources:
                continue
            if str(spec["resourceName"]) in skip_resources:
                statuses.append(manifest_row(
                    api=str(spec["api"]), endpoint=str(spec["endpointOp"]),
                    resource_name=str(spec["resourceName"]), availability=str(spec["availability"]),
                    status="skipped_already_loaded", outcome=None, client=client,
                    started_at=utc_now(), country=country,
                    detail="Loaded by an earlier run today; skipped to spare the daily budget",
                ))
                continue
            if deferred:
                statuses.append(manifest_row(
                    api=str(spec["api"]), endpoint=str(spec["endpointOp"]),
                    resource_name=str(spec["resourceName"]), availability=str(spec["availability"]),
                    status="deferred_daily_limit", outcome=None, client=client,
                    started_at=utc_now(), country=country,
                    detail="Not requested after the daily allowance reserve was reached",
                ))
                continue
            rows: List[Dict[str, object]] = []
            started_at = utc_now()
            try:
                outcome = fetch_endpoint(client, spec, rows)
            except DailyBudgetExhausted as error:
                deferred = True
                outcome = FetchOutcome(
                    "partial_daily_limit" if rows else "deferred_daily_limit",
                    None, 0, 0, client.day_remaining, str(error),
                )
            load_error: Optional[str] = None
            daily_blocked = (
                outcome.http_status == 429
                and outcome.day_remaining is not None
                and outcome.day_remaining <= 0
            )
            if daily_blocked:
                deferred = True
            if rows and outcome.status in {"loaded", "partial_daily_limit"} or (daily_blocked and rows):
                try:
                    pipeline.run(make_resource(str(spec["resourceName"]), rows))
                    if str(spec["resourceName"]) in fan_out_parent_names:
                        captured_by_resource[str(spec["resourceName"])] = rows
                except Exception as error:
                    outcome = FetchOutcome(
                        "load_failed", outcome.http_status, outcome.pages,
                        outcome.records, outcome.day_remaining, None,
                    )
                    load_error = sanitise_error(str(error))
            reported_status = outcome.status
            if daily_blocked and outcome.status != "load_failed":
                reported_status = "partial_daily_limit" if rows else "blocked_daily_limit"

            status = manifest_row(
                api=str(spec["api"]), endpoint=str(spec["endpointOp"]),
                resource_name=str(spec["resourceName"]), availability=str(spec["availability"]),
                status=reported_status, outcome=outcome, client=client,
                started_at=started_at, country=country, detail=load_error,
            )
            statuses.append(status)
            print(json.dumps({"event": "endpoint", "index": index, "total": total_steps, **status}), flush=True)

        # ---- Phase 2: bounded fan-outs ------------------------------------
        for offset, spec in enumerate(fan_out_plan, start=1):
            index = len(selected) + offset
            resource_name = str(spec["resourceName"])
            if only_resources and resource_name not in only_resources:
                continue
            parent_resource = str(spec["parentResource"])
            parent_rows = captured_by_resource.get(parent_resource, [])
            parent_ids = extract_parent_ids(parent_rows, str(spec["idPath"]))
            if spec.get("parentIdSql"):
                # Union with landed parents so a resume run covers parents
                # captured by earlier runs, not only this run's memory.
                for pid in db_parent_ids(pipeline, str(spec["parentIdSql"])):
                    if pid not in parent_ids:
                        parent_ids.append(pid)
            resumable = bool(spec.get("resumable"))
            already_landed: set = set()
            if resumable:
                already_landed = existing_parent_ids(pipeline, resource_name)
                if already_landed:
                    parent_ids = [pid for pid in parent_ids if pid not in already_landed]
            if resumable and not parent_ids and already_landed:
                statuses.append(manifest_row(
                    api="fan_out", endpoint=str(spec["urlTemplate"]), resource_name=resource_name,
                    availability="fan_out", status="loaded", outcome=None,
                    client=client, started_at=utc_now(), country=country,
                    detail=f"All {len(already_landed)} parents already landed by earlier runs",
                ))
                continue
            if deferred:
                statuses.append(manifest_row(
                    api="fan_out", endpoint=str(spec["urlTemplate"]), resource_name=resource_name,
                    availability="fan_out", status="deferred_daily_limit", outcome=None,
                    client=client, started_at=utc_now(), country=country,
                    detail="Not requested after the daily allowance reserve was reached",
                ))
                continue
            if not parent_ids:
                statuses.append(manifest_row(
                    api="fan_out", endpoint=str(spec["urlTemplate"]), resource_name=resource_name,
                    availability="fan_out", status="empty_parent", outcome=None,
                    client=client, started_at=utc_now(), country=country,
                    detail=f"No parent ids found in {parent_resource}",
                ))
                continue
            rows = []
            started_at = utc_now()
            try:
                outcome = fetch_fan_out(client, spec, parent_ids, rows)
            except DailyBudgetExhausted as error:
                deferred = True
                outcome = FetchOutcome(
                    "partial_daily_limit" if rows else "deferred_daily_limit",
                    None, 0, 0, client.day_remaining, str(error),
                )
            load_error = None
            if rows:
                try:
                    # Resumable fan-outs append: only never-landed parents are
                    # fetched, so appending completes the table across runs
                    # instead of replacing a partial load with a smaller one.
                    pipeline.run(make_resource(
                        resource_name, rows,
                        write_disposition="append" if resumable else "replace",
                    ))
                    if resource_name in fan_out_parent_names:
                        captured_by_resource[resource_name] = rows
                except Exception as error:
                    outcome = FetchOutcome(
                        "load_failed", outcome.http_status, outcome.pages,
                        outcome.records, outcome.day_remaining, None,
                    )
                    load_error = sanitise_error(str(error))

            status = manifest_row(
                api="fan_out", endpoint=str(spec["urlTemplate"]), resource_name=resource_name,
                availability="fan_out", status=outcome.status, outcome=outcome,
                client=client, started_at=started_at, country=country,
                detail=load_error or f"parents={len(parent_ids)}",
            )
            statuses.append(status)
            print(json.dumps({"event": "endpoint", "index": index, "total": total_steps, **status}), flush=True)

        # Merge keyed on resource_name: partial/resume runs update only the
        # resources they touched, preserving the rest of the ledger.
        pipeline.run(
            statuses,
            table_name="ingestion_manifest",
            write_disposition="merge",
            primary_key="resource_name",
        )
        summary = {
            "event": "complete",
            "dataset": DATASET_NAME,
            "country": country,
            "endpoints": len(statuses),
            "loaded": sum(1 for row in statuses if row["status"] == "loaded"),
            "unavailable": sum(1 for row in statuses if row["status"] == "unavailable"),
            "failed": sum(1 for row in statuses if row["status"] in {"failed", "load_failed"}),
            "deferred": sum(1 for row in statuses if row["status"] in {"deferred_daily_limit", "partial_daily_limit"}),
            "pages": sum(int(row["pages"]) for row in statuses),
            "records": sum(int(row["records"]) for row in statuses),
            "day_remaining": client.day_remaining,
        }
        print(json.dumps(summary), flush=True)
        if summary["deferred"] > 0:
            return 75
        return 0 if summary["failed"] == 0 else 2
    finally:
        client.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"event": "fatal", "detail": sanitise_error(str(error))}), file=sys.stderr, flush=True)
        raise
