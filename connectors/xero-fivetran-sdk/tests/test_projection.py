"""
Parity: the Python projection must produce exactly the rows the TypeScript
engine produced from the same sanitized recording (regenerate both inputs with
`npx tsx scripts/generate-fivetran-xero-sdk-spec.ts`).

Run: python3 -m unittest discover -s connectors/xero-fivetran-sdk/tests -v
"""
from __future__ import annotations

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from xero_projection import project_stream_rows, unwrap_envelope  # noqa: E402
from xero_spec import SPEC  # noqa: E402


def _load(name: str):
    with open(os.path.join(HERE, name), encoding="utf-8") as handle:
        return json.load(handle)


class ProjectionParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.expected = _load("expected_projection.json")
        cls.recording = _load("sanitized-recording.json")["responses"]
        cls.tables = SPEC["tables"]

    def _assert_rows(self, table_id: str, rows: list):
        expected = self.expected.get(table_id)
        self.assertIsNotNone(expected, f"{table_id} has no reference rows")
        actual = [{"sourceRecordId": row["sourceRecordId"], "fields": row["fields"], "tombstone": row["tombstone"]}
                  for row in rows]
        self.assertEqual(actual, expected, f"{table_id} projection differs from the TypeScript engine")

    def test_group_members_match_reference(self):
        checked = 0
        for group in SPEC["groups"]:
            leader = self.tables[group["leader"]]
            body = self.recording.get(leader["id"])
            if body is None:
                continue
            records = unwrap_envelope(body, leader)
            for member in group["members"]:
                table = self.tables[member["table"]]
                rows = project_stream_rows(table, leader, records, table.get("recordIdField") or "")
                self._assert_rows(table["id"], rows)
                checked += 1
        self.assertGreater(checked, 100)

    def test_fan_out_members_match_reference(self):
        checked = 0
        for fan_out in SPEC["fanOuts"]:
            table = self.tables[fan_out["id"]]
            body = self.recording.get(table["id"])
            if body is None:
                continue
            records = unwrap_envelope(body, table)
            parent = self.tables.get(fan_out["parentTable"]) if fan_out.get("parentTable") else None
            parent_body = self.recording.get(parent["id"]) if parent else None
            fan_out_parent = None
            if parent and parent_body is not None:
                parent_records = unwrap_envelope(parent_body, parent)
                if parent_records:
                    fan_out_parent = {"record": parent_records[0], "table": parent}
            for member in [{"table": table["id"]}] + list(fan_out["members"]):
                member_table = self.tables[member["table"]]
                rows = project_stream_rows(member_table, table, records, member_table.get("recordIdField") or "",
                                           fan_out_parent=fan_out_parent)
                self._assert_rows(member_table["id"], rows)
                checked += 1
        self.assertGreater(checked, 30)

    def test_every_spec_table_is_reachable(self):
        covered = set()
        for group in SPEC["groups"]:
            covered.update(member["table"] for member in group["members"])
        for fan_out in SPEC["fanOuts"]:
            covered.add(fan_out["id"])
            covered.update(member["table"] for member in fan_out["members"])
        self.assertEqual(sorted(covered), sorted(self.tables.keys()))


if __name__ == "__main__":
    unittest.main()
