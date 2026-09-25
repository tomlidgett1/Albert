from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

from pipeline import (
    Page,
    PaginationError,
    iter_category_cursor_pages,
    iter_id_cursor_pages,
    iter_inventory_pages,
    iter_offset_pages,
    iter_page_number_pages,
    iter_version_pages,
    parse_retry_after,
    run_mock,
)


class FakeClient:
    def __init__(self, responses: Sequence[object]) -> None:
        self.responses = list(responses)
        self.calls = 0

    def request_json(
        self,
        _method: str,
        _path: str,
        *,
        params: Optional[Mapping[str, object]] = None,
        body: Optional[Mapping[str, object]] = None,
    ) -> object:
        del params, body
        self.calls += 1
        return self.responses.pop(0)


class RetryAfterTests(unittest.TestCase):
    def test_rfc1123_http_date(self) -> None:
        now = datetime(2026, 8, 12, 3, 0, 0, tzinfo=timezone.utc)
        self.assertEqual(parse_retry_after("Wed, 12 Aug 2026 03:00:05 GMT", now), 5)
        self.assertEqual(parse_retry_after("17", now), 17)
        self.assertIsNone(parse_retry_after("not-a-date", now))


class CursorGuardTests(unittest.TestCase):
    def test_standard_version_cursor_must_advance(self) -> None:
        client = FakeClient([{"data": [{"id": "a"}], "version": {"min": 5, "max": 5}}])
        with self.assertRaisesRegex(PaginationError, "did not advance"):
            list(iter_version_pages(client, "sales", "5"))

    def test_inventory_body_cursor_must_advance(self) -> None:
        client = FakeClient([[{"id": "a", "version": 9}]])
        with self.assertRaisesRegex(PaginationError, "did not advance"):
            list(iter_inventory_pages(client, "9"))

    def test_offset_has_hard_page_ceiling(self) -> None:
        client = FakeClient([[{"id": "a"}], [{"id": "b"}]])
        with self.assertRaisesRegex(PaginationError, "safety ceiling"):
            list(iter_offset_pages(client, max_pages=2))

    def test_page_number_has_hard_page_ceiling(self) -> None:
        client = FakeClient([{"data": [{"id": "a"}]}, {"data": [{"id": "b"}]}])
        with self.assertRaisesRegex(PaginationError, "safety ceiling"):
            list(iter_page_number_pages(client, max_pages=2))

    def test_opaque_cursor_cannot_repeat(self) -> None:
        client = FakeClient(
            [
                {"data": {"categories": [{"id": "a"}]}, "page_info": {"has_next": True, "last_seen": "same"}},
                {"data": {"categories": [{"id": "b"}]}, "page_info": {"has_next": True, "last_seen": "same"}},
            ]
        )
        with self.assertRaisesRegex(PaginationError, "empty or repeated"):
            list(iter_category_cursor_pages(client))

    def test_int64_id_cursor_is_text_safe_and_must_advance(self) -> None:
        large = "9223372036854775000"
        client = FakeClient([{"Quotes": [{"id": large}], "HasNext": True}])
        with self.assertRaisesRegex(PaginationError, "did not advance"):
            list(iter_id_cursor_pages(client, large))

    def test_empty_page_terminates_without_an_extra_request(self) -> None:
        client = FakeClient([{"data": [], "version": {"min": None, "max": None}}])
        self.assertEqual(list(iter_version_pages(client, "sales", "0")), [])
        self.assertEqual(client.calls, 1)


class EndToEndFixtureTests(unittest.TestCase):
    def test_mock_pipeline_loads_and_upserts(self) -> None:
        with tempfile.TemporaryDirectory(prefix="lightspeed-x-dlt-test-") as temporary:
            result = run_mock(Path(temporary))
            self.assertEqual(result.validation["table_counts"]["sales"], 4)
            self.assertEqual(result.validation["sale_0001"]["price_incl_tax"], "14.340000000")
            self.assertEqual(result.validation["largest_quote_id_type"], "VARCHAR")
            self.assertEqual(sum(row["status"] == 429 for row in result.request_log), 1)


if __name__ == "__main__":
    unittest.main()

