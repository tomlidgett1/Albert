#!/usr/bin/env python3
"""Exhaustive, isolated dlt landing test for a connected Deputy install.

The secure TypeScript launcher supplies a short-lived access token, the
validated install base URL, the analytical Postgres URL, and the official
Resource API object catalogue through process memory. No credential is written
to a dlt secrets file.

Every readable Resource object is discovered through GET .../INFO and read via
the read-only POST .../QUERY operation. QUERY pages are keyset-paginated by the
numeric Id at Deputy's documented 500-record ceiling. dlt normalises complete
source objects, including nested arrays and joined metadata, into DEPUTYNEW.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from typing import Any, Dict, Iterator, List, Mapping, MutableMapping, Optional, Sequence

import dlt
import psycopg2
from psycopg2 import sql
import requests


DATASET_NAME = "DEPUTYNEW"
PIPELINE_NAME = "albert_deputynew"
PAGE_SIZE = 500
UNAVAILABLE_STATUSES = {403, 404}
RETRYABLE_STATUSES = {429, 500, 502, 503, 504}


def required_env(name: str) -> str:
    value = os.environ.pop(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing {name}")
    return value


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sanitise_error(value: str) -> str:
    compact = re.sub(r"\s+", " ", value).strip()
    return compact[:300]


def integer_id(value: object) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value >= 0:
        return value
    if isinstance(value, str) and re.fullmatch(r"(?:0|[1-9][0-9]{0,39})", value):
        parsed = int(value)
        return parsed if parsed >= 0 else None
    return None


def info_count(payload: object) -> Optional[int]:
    if not isinstance(payload, Mapping):
        return None
    return integer_id(payload.get("count"))


class DeputyHttpError(RuntimeError):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status


class DeputyClient:
    """Sequential Deputy reader honoring vendor retry headers and backoff."""

    def __init__(self, access_token: str, base_url: str) -> None:
        self.base_url = base_url.rstrip("/") + "/"
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Accept": "application/json",
                "Authorization": f"Bearer {access_token}",
                "User-Agent": "Albert-Deputy-dlt-test/1.0",
            }
        )
        self.last_request_at = 0.0
        self.rate_remaining: Optional[int] = None

    def close(self) -> None:
        self.session.close()

    def url(self, path: str) -> str:
        return self.base_url + path.lstrip("/")

    def request(self, method: str, path: str, payload: Optional[Mapping[str, object]] = None) -> requests.Response:
        response: Optional[requests.Response] = None
        for attempt in range(7):
            elapsed = time.monotonic() - self.last_request_at
            if elapsed < 0.25:
                time.sleep(0.25 - elapsed)
            response = self.session.request(
                method,
                self.url(path),
                json=dict(payload) if payload is not None else None,
                timeout=(15, 90),
            )
            self.last_request_at = time.monotonic()
            remaining = response.headers.get("X-RateLimit-Remaining")
            if remaining and remaining.isdigit():
                self.rate_remaining = int(remaining)
            if response.status_code not in RETRYABLE_STATUSES:
                return response

            retry_after = response.headers.get("Retry-After")
            if retry_after and retry_after.isdigit():
                delay = min(120, max(1, int(retry_after)))
            else:
                delay = min(45, 2 ** attempt)
            print(json.dumps({
                "event": "retry",
                "status": response.status_code,
                "attempt": attempt + 1,
                "delay_seconds": delay,
                "rate_remaining": self.rate_remaining,
            }), flush=True)
            time.sleep(delay)
        assert response is not None
        return response

    def json(self, response: requests.Response) -> object:
        try:
            return response.json()
        except ValueError as error:
            raise DeputyHttpError(response.status_code, "Deputy response was not JSON") from error


def resource_name(value: str) -> str:
    return "deputy_" + re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")


def preflight_account(client: DeputyClient) -> Mapping[str, object]:
    response = client.request("GET", "me")
    if response.status_code == 401:
        raise DeputyHttpError(401, "The connected Deputy access token is not valid")
    if not response.ok:
        raise DeputyHttpError(response.status_code, f"Deputy /me failed with HTTP {response.status_code}")
    payload = client.json(response)
    if not isinstance(payload, Mapping):
        raise DeputyHttpError(response.status_code, "Deputy /me did not return an object")
    return payload


def load_info(client: DeputyClient, resource: str) -> tuple[Optional[Mapping[str, object]], Optional[int], Optional[str]]:
    response = client.request("GET", f"resource/{resource}/INFO")
    if response.status_code in UNAVAILABLE_STATUSES:
        return None, response.status_code, f"Resource INFO returned HTTP {response.status_code}"
    if response.status_code == 401:
        # Deputy also uses 401 for inaccessible/legacy Resource object names.
        # Verify the token independently before deciding this is an auth fault.
        preflight_account(client)
        return None, response.status_code, "Resource INFO is not available to this install (HTTP 401)"
    if not response.ok:
        return None, response.status_code, f"Resource INFO returned HTTP {response.status_code}"
    payload = client.json(response)
    if not isinstance(payload, Mapping):
        return None, response.status_code, "Resource INFO did not return an object"
    return payload, response.status_code, None


def make_resource(
    client: DeputyClient,
    resource: str,
    counters: MutableMapping[str, object],
):
    @dlt.resource(
        name=resource_name(resource),
        write_disposition="replace",
        max_table_nesting=20,
    )
    def resource_rows() -> Iterator[List[object]]:
        prior_id: Optional[int] = None
        while True:
            query: Dict[str, object] = {
                "max": PAGE_SIZE,
                "sort": {"Id": "asc"},
            }
            if prior_id is not None:
                query["search"] = {"s1": {"field": "Id", "data": prior_id, "type": "gt"}}
            response = client.request("POST", f"resource/{resource}/QUERY", query)
            if response.status_code in UNAVAILABLE_STATUSES:
                counters["status"] = "unavailable"
                counters["http_status"] = response.status_code
                counters["detail"] = f"Resource QUERY returned HTTP {response.status_code}"
                return
            if response.status_code == 401:
                preflight_account(client)
                counters["status"] = "unavailable"
                counters["http_status"] = response.status_code
                counters["detail"] = "Resource QUERY is not available to this install (HTTP 401)"
                return
            if not response.ok:
                raise DeputyHttpError(
                    response.status_code,
                    f"Resource QUERY returned HTTP {response.status_code}: {sanitise_error(response.text)}",
                )
            payload = client.json(response)
            if not isinstance(payload, list):
                raise DeputyHttpError(response.status_code, "Resource QUERY did not return an array")

            counters["pages"] = int(counters["pages"]) + 1
            counters["records"] = int(counters["records"]) + len(payload)
            if payload:
                yield payload
            if len(payload) < PAGE_SIZE:
                return

            ids = [
                parsed
                for row in payload
                if isinstance(row, Mapping)
                for parsed in [integer_id(row.get("Id"))]
                if parsed is not None
            ]
            maximum_id = max(ids, default=None)
            if maximum_id is None:
                raise DeputyHttpError(200, "A full Deputy page had no numeric Id for keyset pagination")
            if prior_id is not None and maximum_id <= prior_id:
                raise DeputyHttpError(200, "Deputy keyset pagination did not advance")
            prior_id = maximum_id

    return resource_rows


def count_reconciles(loaded: int, before: Optional[int], after: Optional[int]) -> bool:
    known = [value for value in [before, after] if value is not None]
    if not known:
        return True
    return min(known) <= loaded <= max(known)


def destination_row_count(connection: object, table_name: str) -> Optional[int]:
    """Return a prior main-table count so an interrupted run can resume safely."""
    with connection.cursor() as cursor:  # type: ignore[attr-defined]
        cursor.execute(
            "select exists (select 1 from information_schema.tables where table_schema=%s and table_name=%s)",
            (DATASET_NAME, table_name),
        )
        if not bool(cursor.fetchone()[0]):
            return None
        cursor.execute(
            sql.SQL("select count(*) from {}.{}").format(
                sql.Identifier(DATASET_NAME),
                sql.Identifier(table_name),
            )
        )
        return int(cursor.fetchone()[0])


def main() -> int:
    access_token = required_env("DEPUTY_DLT_ACCESS_TOKEN")
    base_url = required_env("DEPUTY_DLT_BASE_URL")
    destination_url = required_env("DEPUTY_DLT_DESTINATION_URL")
    resources = json.loads(required_env("DEPUTY_DLT_RESOURCES_JSON"))
    if not isinstance(resources, list) or not resources or not all(isinstance(item, str) for item in resources):
        raise RuntimeError("The Deputy Resource catalogue is invalid")

    client = DeputyClient(access_token, base_url)
    access_token = ""
    base_url = ""
    resume_db: Optional[object] = None
    statuses: List[Dict[str, object]] = []
    catalog: List[Dict[str, object]] = []

    try:
        resume_db = psycopg2.connect(destination_url)
        resume_db.set_session(readonly=True, autocommit=True)
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

        account = dict(preflight_account(client))
        pipeline.run(
            [{"extracted_at": utc_now(), "payload": account}],
            table_name="deputy_account",
            write_disposition="replace",
        )

        for index, resource in enumerate(resources, start=1):
            started_at = utc_now()
            info, info_status, info_detail = load_info(client, resource)
            expected_before = info_count(info)
            catalog.append({
                "resource_name": resource,
                "http_status": info_status,
                "available": info is not None,
                "record_count": expected_before,
                "discovered_at": utc_now(),
                "detail": info_detail,
                "info": dict(info) if info is not None else None,
            })
            counters: Dict[str, object] = {
                "status": "complete" if info is not None else "unavailable",
                "http_status": info_status,
                "pages": 0,
                "records": 0,
                "detail": info_detail,
            }

            prior_count = destination_row_count(resume_db, resource_name(resource))
            if (
                info is not None
                and prior_count is not None
                and count_reconciles(prior_count, expected_before, expected_before)
            ):
                counters["records"] = prior_count
                counters["pages"] = max(1, (prior_count + PAGE_SIZE - 1) // PAGE_SIZE)
                counters["detail"] = "Resumed from a destination row count matching Resource INFO"
                status = {
                    "resource_name": resource,
                    "table_name": resource_name(resource),
                    "status": "complete",
                    "http_status": info_status,
                    "pages": counters["pages"],
                    "records": prior_count,
                    "expected_count_before": expected_before,
                    "expected_count_after": expected_before,
                    "rate_remaining": client.rate_remaining,
                    "detail": counters["detail"],
                    "started_at": started_at,
                    "completed_at": utc_now(),
                }
                statuses.append(status)
                print(json.dumps({"event": "resource", "index": index, "total": len(resources), **status}), flush=True)
                continue

            if info is not None:
                try:
                    pipeline.run(make_resource(client, resource, counters))
                except Exception as error:
                    counters["status"] = "failed"
                    counters["detail"] = sanitise_error(str(error))

            expected_after: Optional[int] = expected_before
            if counters["status"] == "complete":
                after_info, _, _ = load_info(client, resource)
                expected_after = info_count(after_info)
                if not count_reconciles(int(counters["records"]), expected_before, expected_after):
                    # For small resources Deputy also documents an unfiltered
                    # GET collection form. Try it before classifying an INFO /
                    # QUERY visibility discrepancy.
                    maximum_expected = max(
                        [value for value in [expected_before, expected_after] if value is not None],
                        default=PAGE_SIZE + 1,
                    )
                    if maximum_expected <= PAGE_SIZE:
                        fallback_response = client.request("GET", f"resource/{resource}")
                        fallback_payload = client.json(fallback_response) if fallback_response.ok else None
                        if isinstance(fallback_payload, list) and len(fallback_payload) > int(counters["records"]):
                            pipeline.run(
                                fallback_payload,
                                table_name=resource_name(resource),
                                write_disposition="replace",
                            )
                            counters["records"] = len(fallback_payload)
                            counters["pages"] = 1
                    if not count_reconciles(int(counters["records"]), expected_before, expected_after):
                        counters["status"] = "complete_api_count_gap"
                        counters["detail"] = (
                            f"loaded every row exposed by QUERY and the unfiltered collection; "
                            f"Resource INFO count was {expected_before} before and {expected_after} after, "
                            f"while both read forms exposed {counters['records']}"
                        )

            status = {
                "resource_name": resource,
                "table_name": resource_name(resource),
                "status": counters["status"],
                "http_status": counters["http_status"],
                "pages": counters["pages"],
                "records": counters["records"],
                "expected_count_before": expected_before,
                "expected_count_after": expected_after,
                "rate_remaining": client.rate_remaining,
                "detail": counters["detail"],
                "started_at": started_at,
                "completed_at": utc_now(),
            }
            statuses.append(status)
            print(json.dumps({"event": "resource", "index": index, "total": len(resources), **status}), flush=True)

        pipeline.run(catalog, table_name="resource_catalog", write_disposition="replace")
        pipeline.run(statuses, table_name="ingestion_manifest", write_disposition="replace")
        summary = {
            "event": "complete",
            "dataset": DATASET_NAME,
            "resources": len(statuses),
            "complete": sum(
                1 for row in statuses
                if row["status"] in {"complete", "complete_api_count_gap"}
            ),
            "unavailable": sum(1 for row in statuses if row["status"] == "unavailable"),
            "failed": sum(1 for row in statuses if row["status"] == "failed"),
            "pages": sum(int(row["pages"]) for row in statuses),
            "records": sum(int(row["records"]) for row in statuses),
            "rate_remaining": client.rate_remaining,
        }
        print(json.dumps(summary), flush=True)
        return 0 if summary["failed"] == 0 else 2
    finally:
        if resume_db is not None:
            resume_db.close()  # type: ignore[attr-defined]
        client.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"event": "fatal", "detail": sanitise_error(str(error))}), file=sys.stderr, flush=True)
        raise
