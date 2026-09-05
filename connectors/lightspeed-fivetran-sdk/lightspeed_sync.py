"""
Spec-driven Lightspeed R-Series sync for the Fivetran SDK connector.

Mirrors the walk connectors/lightspeed-r/spec-sync.ts performs, minus the parts
that only make sense inside Albert's own worker (leases, raw-object storage,
per-stream jobs):

  * one walk per scan group — `<Resource>.json`, ascending immutable id, the
    vendor's opaque `after` continuation, the member-need relation union — and
    every member table projected from the same page (the leader 1:1, nested
    members from their `projectFrom` array), so one Sale.json walk fills all
    six sale tables instead of six walks of the same data;
  * hidden populations (`archived=only`, gift-card credit accounts) as extra
    passes of the same walk;
  * incremental narrowing per group: the vendor's last-modified filter where
    the leader has one, immutable ascending id for append-only ledgers, the
    required startDate/endDate pair for the by-day reports, and a full
    re-snapshot for reference tables without any of those;
  * parent-scoped fan-outs (register calculated totals, custom-field choices,
    workorder images) as one sub-request per parent id;
  * a resumable cursor per group in Fivetran `state`, checkpointed after every
    page, so an interrupted run resumes at the page it stopped on.

Every projected row is emitted with the exact physical column names of Albert's
`source_lightspeed.ls_*` staging tables (snake_case of the vendor field), typed
per the staging contract, plus `source_record_id`, `source_updated_at`,
`tombstone` and `_albert_synced_at` — so the ls_* views port across with a
schema re-point only.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Callable

from lightspeed_client import LightspeedClient, LightspeedError, NotAvailable, TokenBrokerError, _log
from lightspeed_projection import (
    after_token,
    js_iso,
    parse_datetime,
    parse_envelope,
    project_fan_out_rows,
    project_member_rows,
    read_id,
)
from lightspeed_spec import SPEC, SPEC_SHA256

Emit = Callable[[str, dict], None]
Checkpoint = Callable[[dict], None]

MAX_PAGE_SIZE = 100
MAX_PAGES_PER_WALK = 20000
# Overlap applied to every modified-time / date window: R-Series stamps
# `timeStamp` from its own clock, and inclusive at-least-once delivery is
# cheaper than a missed late edit.
MODIFIED_OVERLAP = timedelta(minutes=5)
DATE_RANGE_OVERLAP = timedelta(days=7)
DATE_RANGE_INITIAL = timedelta(days=730)
SUB_REQUESTS_PER_CHECKPOINT = 25

# Resources deliberately not walked: CatalogVendorItem is Lightspeed's
# supplier catalogue mirror (tens of thousands of rows per vendor, no
# analytical use in Albert's Cube). `skip_resources` in the configuration
# extends this list at deploy time.
SKIPPED_RESOURCES = {"CatalogVendorItem"}

CONTROL_COLUMNS = {
    "source_record_id": "STRING",
    "source_updated_at": "UTC_DATETIME",
    "tombstone": "BOOLEAN",
    "_albert_synced_at": "UTC_DATETIME",
}
CONTRACT_TABLE = "albert_column_contract"


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

def fivetran_type(staging_type: str):
    """Staging vocabulary (text/numeric/boolean/date/timestamptz/jsonb) to Fivetran."""
    if staging_type == "numeric":
        # numeric(19,4) in Albert's staging DDL: exact, cannot lose cents.
        return {"type": "DECIMAL", "precision": 19, "scale": 4}
    return {
        "boolean": "BOOLEAN",
        "date": "NAIVE_DATE",
        "timestamptz": "UTC_DATETIME",
        "jsonb": "JSON",
    }.get(staging_type, "STRING")


def spec_schema() -> list[dict]:
    tables = []
    for table in SPEC["tables"].values():
        columns = dict(CONTROL_COLUMNS)
        for column in table["columns"]:
            if column["column"] in columns:
                continue
            columns[column["column"]] = fivetran_type(column["type"])
        tables.append({"table": table["id"], "primary_key": ["source_record_id"], "columns": columns})
    # The contract every landed table follows, so the destination can invert
    # Fivetran's identifier rewrite (tax1_rate -> tax_1_rate) without guessing.
    tables.append({
        "table": CONTRACT_TABLE,
        "primary_key": ["table_name", "column_name"],
        "columns": {"table_name": "STRING", "column_name": "STRING", "staging_type": "STRING",
                    "spec_sha256": "STRING", "_albert_synced_at": "UTC_DATETIME"},
    })
    return tables


# ---------------------------------------------------------------------------
# Value typing
# ---------------------------------------------------------------------------

def _to_decimal(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        try:
            return str(Decimal(str(value)).quantize(Decimal("0.0001")))
        except InvalidOperation:
            return None
    if isinstance(value, str):
        text = value.strip().replace(",", "")
        if not text:
            return None
        try:
            return str(Decimal(text).quantize(Decimal("0.0001")))
        except InvalidOperation:
            return None
    return None


def _to_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        text = value.strip().lower()
        if text in ("true", "1", "yes"):
            return True
        if text in ("false", "0", "no"):
            return False
    return None


def _to_date(value):
    parsed = parse_datetime(value)
    if parsed:
        return parsed.date()
    if isinstance(value, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", value.strip()):
        return date.fromisoformat(value.strip())
    return None


def typed_value(staging_type: str, value):
    if value is None:
        return None
    if staging_type == "numeric":
        return _to_decimal(value)
    if staging_type == "boolean":
        return _to_bool(value)
    if staging_type == "date":
        return _to_date(value)
    if staging_type == "timestamptz":
        return parse_datetime(value)
    if staging_type == "jsonb":
        if isinstance(value, (dict, list)):
            return value
        if isinstance(value, str):
            try:
                return json.loads(value)
            except ValueError:
                return value
        return value
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def row_to_record(table: dict, row: dict, synced_at: datetime) -> dict:
    """Map a projected row (fields keyed by vendor field name) to a typed Fivetran record."""
    record = {
        "source_record_id": row["sourceRecordId"],
        "source_updated_at": parse_datetime(row.get("updatedAt")),
        "tombstone": False,
        "_albert_synced_at": synced_at,
    }
    fields = row["fields"]
    for column in table["columns"]:
        name = column["column"]
        if name in CONTROL_COLUMNS:
            continue
        record[name] = typed_value(column["type"], fields.get(column["field"]))
    return record


# ---------------------------------------------------------------------------
# Walk parameters
# ---------------------------------------------------------------------------

def vendor_time(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")


_REFUSED = re.compile(r"relations that are not allowed:\s*([A-Za-z0-9_.,\s]+)")


def _refused_relations(message: str) -> list[str]:
    match = _REFUSED.search(message or "")
    if not match:
        return []
    return [item.strip().rstrip('"}') for item in match.group(1).split(",") if item.strip()]


def _int_id(value) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


class LightspeedSync:
    def __init__(self, configuration: dict, state: dict, emit: Emit, checkpoint: Checkpoint,
                 client: LightspeedClient | None = None, now: datetime | None = None):
        self.configuration = configuration
        self.state = state if isinstance(state, dict) else {}
        self.state.setdefault("groups", {})
        self.state.setdefault("fanouts", {})
        self.emit = emit
        self.checkpoint = checkpoint
        self.client = client or LightspeedClient(configuration)
        self.now = now or datetime.now(timezone.utc)
        self.include_optional = str(configuration.get("include_optional", "false")).lower() == "true"
        self.skipped = set(SKIPPED_RESOURCES) | {
            item.strip() for item in str(configuration.get("skip_resources", "")).split(",") if item.strip()
        }
        self.tables = SPEC["tables"]
        self.rows_emitted = 0
        self.tables_touched: set[str] = set()

    # -- contract ---------------------------------------------------------

    def emit_contract(self) -> None:
        """Land the column contract once per spec revision."""
        if self.state.get("contract_sha256") == SPEC_SHA256:
            return
        synced_at = datetime.now(timezone.utc)
        for table in self.tables.values():
            for column in list(CONTROL_COLUMNS) + [entry["column"] for entry in table["columns"]]:
                staging_type = next((entry["type"] for entry in table["columns"] if entry["column"] == column), "control")
                self.emit(CONTRACT_TABLE, {
                    "table_name": table["id"],
                    "column_name": column,
                    "staging_type": staging_type,
                    "spec_sha256": SPEC_SHA256,
                    "_albert_synced_at": synced_at,
                })
        self.state["contract_sha256"] = SPEC_SHA256
        self.checkpoint(self.state)

    # -- windows -----------------------------------------------------------

    def _window_params(self, group: dict, entry: dict) -> dict:
        kind = group["incremental"]
        if kind == "modified":
            watermark = parse_datetime(entry.get("watermark"))
            if watermark:
                return {group["modifiedParam"]: f">=,{vendor_time(watermark - MODIFIED_OVERLAP)}"}
            return {}
        if kind == "id_keyset":
            max_id = _int_id(entry.get("max_id"))
            if max_id is not None:
                return {group["idField"]: f">,{max_id}"}
            return {}
        if kind == "date_range":
            watermark = parse_datetime(entry.get("watermark"))
            start = (watermark - DATE_RANGE_OVERLAP) if watermark else (self.now - DATE_RANGE_INITIAL)
            return {"startDate": start.date().isoformat(), "endDate": self.now.date().isoformat()}
        return {}

    def _relations(self, group: dict, entry: dict) -> list:
        """The group's relation list minus any the vendor has refused for this account."""
        dropped = set(entry.get("dropped_relations") or [])
        return [relation for relation in group["relations"] if relation not in dropped]

    def _page_params(self, group: dict, cursor: dict, window: dict, relations: list | None = None) -> dict:
        params: dict = {}
        if group.get("singleton"):
            # One record, no paging/sort/relations accepted (Account.json).
            return params
        if cursor.get("after"):
            # The vendor bakes sort, filter and page size into the
            # continuation; sending them again silently restarts the walk.
            params["after"] = cursor["after"]
        else:
            params["limit"] = str(MAX_PAGE_SIZE)
            if group["incremental"] != "date_range":
                # Ascending primary id: records created mid-walk take higher
                # ids and land at the end, so a long walk can never skip one.
                params["sort"] = group["idField"]
            params.update(window)
        relations = group["relations"] if relations is None else relations
        if relations:
            params["load_relations"] = json.dumps(relations, separators=(",", ":"))
        pass_index = cursor.get("pass", -1)
        if pass_index >= 0:
            extra = group["extraParamSets"][pass_index] if pass_index < len(group["extraParamSets"]) else None
            if extra:
                params.update(extra)
        return params

    # -- group walk ----------------------------------------------------------

    def _assert_relations_present(self, group: dict, records: list, relations: list) -> None:
        """A relation-free page is a silent disaster: reject it rather than commit it."""
        if not records or not group["requiredRoots"]:
            return
        requested = {relation.split(".")[0] for relation in relations}
        missing = [root for root in group["requiredRoots"]
                   if root in requested and not any(root in record for record in records)]
        if missing:
            affected = [member["table"] for member in group["members"]
                        if member.get("projectFrom") and member["projectFrom"].split(".")[0] in missing]
            raise LightspeedError(
                f"Relations absent from every record of {group['resource']}: {', '.join(missing)}. "
                f"{', '.join(affected)} would land zero rows, so the page is rejected."
            )

    def _fetch_group_page(self, group: dict, entry: dict, cursor: dict, window: dict, relations: list) -> dict:
        """
        Fetch one page and prove its relations came back. Two vendor behaviours
        are absorbed here rather than failing the family:
          * 400 "Tried to load one or more relations that are not allowed: X" —
            X is dropped for this account (remembered in state) and the page
            is re-requested;
          * a requested relation root absent from every record — re-requested
            once with only the projection-critical roots (R-Series silently
            drops relations from long lists); if still absent, the page is
            rejected as before.
        """
        attempts = 0
        while True:
            attempts += 1
            params = self._page_params(group, cursor, window, relations)
            try:
                _, body = self.client.get_json(group["path"], params)
            except LightspeedError as error:
                refused = _refused_relations(str(error))
                if refused and relations and attempts < 6:
                    dropped = sorted(set(entry.get("dropped_relations") or []) | set(refused))
                    entry["dropped_relations"] = dropped
                    _log(f"{group['resource']}: vendor refused relations {refused}; retrying without them", "WARNING")
                    relations = [relation for relation in relations if relation not in dropped]
                    continue
                raise
            page = parse_envelope(body, group["resource"])
            try:
                self._assert_relations_present(group, page["records"], relations)
            except LightspeedError:
                member_roots = {member["projectFrom"].split(".")[0] for member in group["members"] if member.get("projectFrom")}
                roots_only = [relation for relation in relations if relation.split(".")[0] in member_roots]
                if attempts == 1 and roots_only and roots_only != relations:
                    _log(f"{group['resource']}: relations dropped silently; retrying with roots only {roots_only}", "WARNING")
                    relations = roots_only
                    continue
                raise
            return page

    def _emit_members(self, group: dict, records: list, synced_at: datetime) -> None:
        for member in group["members"]:
            table = self.tables[member["table"]]
            for row in project_member_rows(group, member, records):
                self.emit(table["id"], row_to_record(table, row, synced_at))
                self.rows_emitted += 1
            self.tables_touched.add(table["id"])

    def sync_group(self, group: dict) -> None:
        key = group["resource"]
        entry = dict(self.state["groups"].get(key) or {})
        cursor = entry.get("cursor")
        if not isinstance(cursor, dict):
            cursor = {"after": None, "pass": -1, "started_at": self.now.isoformat(),
                      "max_id": entry.get("max_id"), "pages": 0}
        window = self._window_params(group, entry)
        synced_at = datetime.now(timezone.utc)
        started_at = parse_datetime(cursor.get("started_at")) or self.now
        # Retry a group that failed last run: never let one family take the sync down.
        try:
            while True:
                relations = self._relations(group, entry)
                page = self._fetch_group_page(group, entry, cursor, window, relations)
                records = page["records"]
                self._emit_members(group, records, synced_at)
                if group["incremental"] == "id_keyset":
                    for record in records:
                        candidate = _int_id(read_id(record, group["idField"]))
                        current = _int_id(cursor.get("max_id"))
                        if candidate is not None and (current is None or candidate > current):
                            cursor["max_id"] = str(candidate)
                cursor["pages"] = int(cursor.get("pages") or 0) + 1
                next_after = after_token(page["nextUrl"])
                if page["nextUrl"] and not next_after:
                    raise LightspeedError(f"{group['resource']}: next page advertised but its continuation could not be read")
                if next_after and next_after == cursor.get("after"):
                    raise LightspeedError(f"{group['resource']}: continuation token repeated after {len(records)} records")
                if next_after and cursor["pages"] < MAX_PAGES_PER_WALK:
                    cursor["after"] = next_after
                else:
                    # Population exhausted: move to the next hidden-population pass, if any.
                    following = cursor.get("pass", -1) + 1
                    if following < len(group["extraParamSets"]):
                        cursor["after"] = None
                        cursor["pass"] = following
                    else:
                        break
                self.state["groups"][key] = {**entry, "cursor": cursor}
                self.checkpoint(self.state)
        except NotAvailable as error:
            # Plan-gated or absent resource: recorded as unavailable, never fatal.
            self.state["groups"][key] = {k: v for k, v in entry.items() if k != "cursor"}
            self.state["groups"][key].update({"unavailable": str(error)[:160], "checked_at": self.now.isoformat()})
            self.checkpoint(self.state)
            return
        except TokenBrokerError:
            raise
        except (LightspeedError, ValueError, TypeError, KeyError, AttributeError) as error:
            _log(f"group {key} failed: {type(error).__name__}: {error}", "WARNING")
            # Keep the cursor so the next run resumes the same page; keep the
            # old watermark so nothing is skipped.
            self.state["groups"][key] = {**entry, "cursor": cursor, "error": str(error)[:160],
                                         "checked_at": self.now.isoformat()}
            self.checkpoint(self.state)
            return
        completed = {"completed_at": self.now.isoformat(), "pages": cursor.get("pages", 0)}
        if entry.get("dropped_relations"):
            completed["dropped_relations"] = entry["dropped_relations"]
        if group["incremental"] in ("modified", "date_range"):
            completed["watermark"] = started_at.isoformat()
        if group["incremental"] == "id_keyset" and cursor.get("max_id") is not None:
            completed["max_id"] = cursor["max_id"]
        self.state["groups"][key] = completed
        self.checkpoint(self.state)

    # -- fan-outs ------------------------------------------------------------

    def sync_fan_out(self, fan_out: dict) -> None:
        if not fan_out.get("alwaysOn") and not self.include_optional:
            return
        key = fan_out["table"]
        table = self.tables[key]
        entry = dict(self.state["fanouts"].get(key) or {})
        cursor = entry.get("cursor") if isinstance(entry.get("cursor"), dict) else {"after": None, "sub_requests": 0}
        synced_at = datetime.now(timezone.utc)
        template = fan_out["endpointTemplate"]
        try:
            while True:
                params = {"after": cursor["after"]} if cursor.get("after") else \
                    {"limit": str(MAX_PAGE_SIZE), "sort": fan_out["parentIdField"]}
                _, parent_body = self.client.get_json(fan_out["parentPath"], params)
                parent_page = parse_envelope(parent_body, fan_out["parentResource"])
                for parent in parent_page["records"]:
                    parent_id = read_id(parent, fan_out["parentIdField"])
                    if not parent_id:
                        continue
                    from urllib.parse import quote
                    path = re.sub(r"\{[A-Za-z]+\}", quote(parent_id, safe=""), template, count=1)
                    try:
                        _, child_body = self.client.get_json(path, {})
                    except NotAvailable:
                        continue
                    children = self._fan_out_children(child_body, fan_out)
                    for row in project_fan_out_rows(fan_out, parent_id, children):
                        record = row_to_record(table, row, synced_at)
                        self.emit(table["id"], record)
                        self.rows_emitted += 1
                    self.tables_touched.add(table["id"])
                    cursor["sub_requests"] = int(cursor.get("sub_requests") or 0) + 1
                    if cursor["sub_requests"] % SUB_REQUESTS_PER_CHECKPOINT == 0:
                        self.state["fanouts"][key] = {**entry, "cursor": cursor}
                        self.checkpoint(self.state)
                next_after = after_token(parent_page["nextUrl"])
                if next_after and next_after != cursor.get("after"):
                    cursor["after"] = next_after
                    self.state["fanouts"][key] = {**entry, "cursor": cursor}
                    self.checkpoint(self.state)
                    continue
                break
        except NotAvailable as error:
            self.state["fanouts"][key] = {"unavailable": str(error)[:160], "checked_at": self.now.isoformat()}
            self.checkpoint(self.state)
            return
        except TokenBrokerError:
            raise
        except (LightspeedError, ValueError, TypeError, KeyError, AttributeError) as error:
            _log(f"fan-out {key} failed: {type(error).__name__}: {error}", "WARNING")
            self.state["fanouts"][key] = {**entry, "cursor": cursor, "error": str(error)[:160],
                                          "checked_at": self.now.isoformat()}
            self.checkpoint(self.state)
            return
        self.state["fanouts"][key] = {"completed_at": self.now.isoformat(),
                                      "sub_requests": cursor.get("sub_requests", 0)}
        self.checkpoint(self.state)

    @staticmethod
    def _fan_out_children(body, fan_out: dict) -> list:
        if not isinstance(body, dict):
            return []
        for key in (fan_out["resource"], fan_out["parentResource"]):
            if key in body:
                return parse_envelope(body, key)["records"]
        for key, value in body.items():
            if key == "@attributes":
                continue
            return parse_envelope(body, key)["records"]
        return []

    # -- orchestration -------------------------------------------------------

    def run(self) -> dict:
        summary = {"groups": 0, "fan_outs": 0, "rows": 0, "unavailable": 0, "errors": 0}
        self.emit_contract()
        for group in SPEC["groups"]:
            if group["resource"] in self.skipped:
                self.state["groups"][group["resource"]] = {"skipped": True, "checked_at": self.now.isoformat()}
                continue
            self.sync_group(group)
            summary["groups"] += 1
        for fan_out in SPEC["fanOuts"]:
            self.sync_fan_out(fan_out)
            summary["fan_outs"] += 1
        summary["unavailable"] = sum(1 for entry in list(self.state["groups"].values()) + list(self.state["fanouts"].values())
                                     if isinstance(entry, dict) and entry.get("unavailable"))
        summary["errors"] = sum(1 for entry in list(self.state["groups"].values()) + list(self.state["fanouts"].values())
                                if isinstance(entry, dict) and entry.get("error"))
        summary["rows"] = self.rows_emitted
        summary["calls"] = self.client.calls
        summary["tables"] = len(self.tables_touched)
        return summary


def spec_fingerprint() -> str:
    return hashlib.sha256(json.dumps(spec_schema(), sort_keys=True, default=str).encode("utf-8")).hexdigest()


__all__ = ["LightspeedSync", "spec_schema", "row_to_record", "typed_value", "js_iso", "spec_fingerprint"]
