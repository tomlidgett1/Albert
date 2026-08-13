#!/usr/bin/env python3
"""Isolated dlt landing test for Albert's connected Xero organisation.

The launcher supplies a short-lived access token, the Xero organisation id,
the analytical Postgres URL, and a spec-derived endpoint plan through the
process environment. No credential is written to a dlt secrets file.

Unlike the small dltHub example, this keeps each complete Xero response
envelope. dlt then normalises every nested object and array into related child
tables, so invoice lines, addresses, tracking values, payments, and similar
children are not discarded by a top-level selector.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterator, List, Mapping, Optional, Sequence

import dlt
import requests


DATASET_NAME = "XERO_TEST"
PIPELINE_NAME = "albert_xero_test"
UNAVAILABLE_STATUSES = {401, 403, 404}
RETRYABLE_STATUSES = {429, 500, 502, 503, 504}
SAFE_PARAM_NAMES = {"includeArchived", "includeDeleted", "offset", "page", "pageSize", "pagesize", "reportYear", "status", "unitdp"}


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
    return max(counts, default=0)


def safe_params(params: Mapping[str, str]) -> Dict[str, str]:
    return {key: value for key, value in params.items() if key in SAFE_PARAM_NAMES}


def sanitise_error(value: str) -> str:
    # Xero error bodies should not contain the bearer token, but keep the test
    # manifest deliberately small and free of arbitrary source text/PII.
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
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Accept": "application/json",
                "Authorization": f"Bearer {access_token}",
                "xero-tenant-id": tenant_id,
                "User-Agent": "Albert-Xero-dlt-test/1.0",
            }
        )
        self.last_request_at = 0.0
        self.day_remaining: Optional[int] = None
        self.minute_remaining: Optional[int] = None
        self.retry_after_seconds: Optional[int] = None
        self.rate_limit_problem: Optional[str] = None

    def close(self) -> None:
        self.session.close()

    def get(self, url: str, params: Mapping[str, str]) -> requests.Response:
        for attempt in range(6):
            elapsed = time.monotonic() - self.last_request_at
            if elapsed < 1.05:
                time.sleep(1.05 - elapsed)
            response = self.session.get(url, params=dict(params), timeout=(15, 75))
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
        return response


def response_wrapper(spec: Mapping[str, Any], page: int, params: Mapping[str, str], payload: object) -> Dict[str, object]:
    return {
        "_xero_api": spec["api"],
        "_xero_endpoint": spec["endpointOp"],
        "_xero_page": page,
        "_xero_params": safe_params(params),
        "_xero_extracted_at": utc_now(),
        "payload": payload,
    }


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

            response = client.get(str(spec["url"]), params)
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

            pages += 1
            count = list_count(payload, spec.get("arrayKeys", []))
            records += count
            captured.append(response_wrapper(spec, page, params, payload))

            if pagination == "none":
                break
            if count == 0:
                break
            if pagination == "page":
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


def make_resource(name: str, rows: Sequence[Mapping[str, object]]):
    @dlt.resource(
        name=name,
        write_disposition="replace",
        max_table_nesting=20,
    )
    def endpoint_rows() -> Iterator[Mapping[str, object]]:
        yield from rows

    return endpoint_rows


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


def main() -> int:
    access_token = required_env("XERO_DLT_ACCESS_TOKEN")
    tenant_id = required_env("XERO_DLT_TENANT_ID")
    destination_url = required_env("XERO_DLT_DESTINATION_URL")
    endpoint_plan = json.loads(required_env("XERO_DLT_ENDPOINTS_JSON"))
    if not isinstance(endpoint_plan, list) or not endpoint_plan:
        raise RuntimeError("The Xero endpoint plan is empty")

    client = XeroClient(access_token, tenant_id)
    # Drop local references as soon as the requests session owns the headers.
    access_token = ""
    tenant_id = ""
    statuses: List[Dict[str, object]] = []

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
            blocked_status = {
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
            }
            pipeline.run(
                [blocked_status],
                table_name="ingestion_manifest",
                write_disposition="replace",
            )
            print(json.dumps({
                "event": "blocked",
                "dataset": DATASET_NAME,
                "reason": "xero_daily_limit",
                "day_remaining": 0,
                "retry_after_seconds": error.retry_after_seconds,
                "retry_at": retry_at.isoformat() if retry_at is not None else None,
                "rate_limit_problem": error.rate_limit_problem,
            }), flush=True)
            return 75

        selected = [spec for spec in endpoint_plan if endpoint_applies(spec, country)]
        for index, spec in enumerate(selected, start=1):
            rows: List[Dict[str, object]] = []
            started_at = utc_now()
            outcome = fetch_endpoint(client, spec, rows)
            load_error: Optional[str] = None
            daily_blocked = (
                outcome.http_status == 429
                and outcome.day_remaining is not None
                and outcome.day_remaining <= 0
            )
            if (outcome.status == "loaded" or daily_blocked) and rows:
                try:
                    pipeline.run(make_resource(str(spec["resourceName"]), rows))
                except Exception as error:  # dlt exposes several destination-specific failures
                    outcome = FetchOutcome(
                        "load_failed",
                        outcome.http_status,
                        outcome.pages,
                        outcome.records,
                        outcome.day_remaining,
                        None,
                    )
                    load_error = sanitise_error(str(error))
            reported_status = outcome.status
            if daily_blocked and outcome.status != "load_failed":
                reported_status = "partial_daily_limit" if rows else "blocked_daily_limit"

            status = {
                "api": spec["api"],
                "endpoint": spec["endpointOp"],
                "resource_name": spec["resourceName"],
                "availability": spec["availability"],
                "status": reported_status,
                "http_status": outcome.http_status,
                "pages": outcome.pages,
                "records": outcome.records,
                "day_remaining": outcome.day_remaining,
                "minute_remaining": client.minute_remaining,
                "retry_after_seconds": client.retry_after_seconds,
                "retry_at": (
                    datetime.now(timezone.utc) + timedelta(seconds=client.retry_after_seconds)
                ).isoformat() if client.retry_after_seconds is not None else None,
                "rate_limit_problem": client.rate_limit_problem,
                "detail": load_error or outcome.detail,
                "started_at": started_at,
                "completed_at": utc_now(),
                "organisation_country": country,
            }
            statuses.append(status)
            print(json.dumps({"event": "endpoint", "index": index, "total": len(selected), **status}), flush=True)
            if daily_blocked:
                for deferred in selected[index:]:
                    statuses.append({
                        "api": deferred["api"],
                        "endpoint": deferred["endpointOp"],
                        "resource_name": deferred["resourceName"],
                        "availability": deferred["availability"],
                        "status": "deferred_daily_limit",
                        "http_status": None,
                        "pages": 0,
                        "records": 0,
                        "day_remaining": 0,
                        "minute_remaining": client.minute_remaining,
                        "retry_after_seconds": client.retry_after_seconds,
                        "retry_at": (
                            datetime.now(timezone.utc) + timedelta(seconds=client.retry_after_seconds)
                        ).isoformat() if client.retry_after_seconds is not None else None,
                        "rate_limit_problem": client.rate_limit_problem,
                        "detail": "Not requested after Xero reported the daily limit was exhausted",
                        "started_at": utc_now(),
                        "completed_at": utc_now(),
                        "organisation_country": country,
                    })
                break

        pipeline.run(
            statuses,
            table_name="ingestion_manifest",
            write_disposition="replace",
        )
        summary = {
            "event": "complete",
            "dataset": DATASET_NAME,
            "country": country,
            "endpoints": len(statuses),
            "loaded": sum(1 for row in statuses if row["status"] == "loaded"),
            "unavailable": sum(1 for row in statuses if row["status"] == "unavailable"),
            "failed": sum(1 for row in statuses if row["status"] in {"failed", "load_failed"}),
            "deferred": sum(1 for row in statuses if row["status"] == "deferred_daily_limit"),
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
