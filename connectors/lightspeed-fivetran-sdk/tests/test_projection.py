"""Parity of the Python projection with the TypeScript engine (spec-sync.ts).

`walk_pages.json` holds one nested walk page per scan group and
`expected_projection.json` the rows the TypeScript engine projected from those
pages, both written by scripts/generate-fivetran-lightspeed-sdk-spec.ts. Every
member table must project the identical rows: same ids, same object type, same
updated-at, same contract fields with the same values.
"""
from __future__ import annotations

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from lightspeed_projection import parse_envelope, project_member_rows  # noqa: E402
from lightspeed_spec import SPEC  # noqa: E402


class ProjectionParityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(os.path.join(HERE, "walk_pages.json"), encoding="utf-8") as handle:
            cls.pages = json.load(handle)
        with open(os.path.join(HERE, "expected_projection.json"), encoding="utf-8") as handle:
            cls.expected = json.load(handle)

    def test_every_member_matches_the_reference_projection(self):
        checked = 0
        for group in SPEC["groups"]:
            page = self.pages.get(group["resource"])
            if page is None:
                continue
            records = parse_envelope(page, group["resource"])["records"]
            for member in group["members"]:
                expected = self.expected.get(f"{group['resource']}/{member['table']}")
                if expected is None:
                    continue
                contract_fields = {column["field"] for column in SPEC["tables"][member["table"]]["columns"]}
                rows = project_member_rows(group, member, records)
                actual = [{
                    "sourceRecordId": row["sourceRecordId"],
                    "sourceObjectType": row["sourceObjectType"],
                    "updatedAt": row["updatedAt"],
                    "fields": {key: value for key, value in row["fields"].items() if key in contract_fields},
                } for row in rows]
                self.assertEqual(actual, expected, f"{member['table']} projection drifted from the TypeScript engine")
                checked += 1
        self.assertGreater(checked, 80)

    def test_spec_covers_every_table_exactly_once(self):
        seen: dict[str, int] = {}
        for group in SPEC["groups"]:
            for member in group["members"]:
                seen[member["table"]] = seen.get(member["table"], 0) + 1
        for fan_out in SPEC["fanOuts"]:
            seen[fan_out["table"]] = seen.get(fan_out["table"], 0) + 1
        # ls_contacts is a member of three walks (Customer, CreditAccount,
        # ShipTo) by design; everything else appears once.
        for table_id in SPEC["tables"]:
            self.assertIn(table_id, seen, f"{table_id} unreachable")
        multi = {table: count for table, count in seen.items() if count > 1}
        self.assertEqual(multi, {"ls_contacts": 3})


if __name__ == "__main__":
    unittest.main()
