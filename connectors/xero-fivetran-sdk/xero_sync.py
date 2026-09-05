"""
Spec-driven Xero sync for the Fivetran SDK connector.

Mirrors the walk connectors/xero/index.ts performs, minus the parts that only
make sense inside Albert's own worker (leases, budgets, raw-object storage):

  * one endpoint walk per scan group, projecting the leader plus every nested
    member from the same page; page/offset pagination with the fixed
    `order=` + immutable `where <scan start>` bound so mutable pages cannot skip
    rows; If-Modified-Since from the group's watermark on incremental runs;
  * fan-outs (one sub-request per parent id — payslip detail, employee detail,
    budget lines, project tasks…) driven by a fresh walk of the parent group
    filtered to parents modified since the fan-out's watermark;
  * parent-detail chains for fan-outs whose child ids only exist on the
    parent's detail endpoint (Payroll AU payslips: GET /PayRuns/{PayRunID}
    carries the Payslips array GET /PayRuns omits): per new or updated parent,
    the detail is fetched, the parent row and the stub rows it carries are
    landed, and the per-child detail is chained from the stub ids;
  * per-group / per-fan-out watermarks in Fivetran `state`, checkpointed as
    each finishes, so a run cut short by Xero's daily limit resumes exactly
    where it stopped.

Every projected row is emitted with Albert's staging column names
(the spec column names), a stable `source_record_id`, `source_updated_at`, and
`tombstone`, typed per the spec — the same shape the `source_xero.*` staging
tables carry, so the xo_* views port across unchanged.
"""
from __future__ import annotations

import json
import re
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Callable

from urllib.parse import quote

from xero_client import DailyLimitReached, NotAvailable, TokenBrokerError, XeroClient, XeroError, _log
from xero_projection import (
    _leader_id_field,
    _read_identifier,
    normalize_xero_value,
    parse_datetime,
    project_stream_rows,
    unwrap_envelope,
)
from xero_spec import SPEC

Emit = Callable[[str, dict], None]
Checkpoint = Callable[[dict], None]

PAYROLL_API_FOR_VERSION = {"AU": "payroll_au", "NZ": "payroll_nz", "UK": "payroll_uk"}
ALWAYS_ON_APIS = {"accounting", "assets", "files", "projects", "identity"}
SUB_REQUESTS_PER_CHECKPOINT = 25
# Endpoint circuit breaker. An endpoint Xero refuses (401/403/404: scope
# tier, region, retired) is re-probed once a day, not every sync; an endpoint
# that errors (5xx, parse) backs off 6h, doubling per consecutive failure up
# to a day. Before this every hourly sync re-hit all of them — the twelve
# Payroll AU endpoints alone burned ~70 of the 1,000 daily calls per hour and
# starved the Reports API and Albert's live balance-sheet calls.
UNAVAILABLE_RECHECK_HOURS = 24
ERROR_BACKOFF_HOURS = 6
ERROR_BACKOFF_MAX_HOURS = 24
# Parent-detail chains: fan-outs whose child ids the parent's LIST response
# never carries. Payroll AU's GET /PayRuns omits the Payslips array; only
# GET /PayRuns/{PayRunID} returns it (verified 2026-09-01: 485 posted pay
# runs landed, zero payslips, every sub-request keyed on the PayRunID and
# 404ing). For such a fan-out the walk fetches each new or updated parent's
# detail, re-lands the parent row with what the list omitted, lands one
# walk-table row per stub in the detail's `stubs` array (the PayslipSummary
# shape xo_payslip_summaries reads), then chains the fan-out's own detail
# request per stub id for the walk table's full row and its line tables.
PARENT_DETAIL_CHAINS = {
    "xero_payroll_au_payslips": {
        "detailPath": "/payroll.xro/1.0/PayRuns/{PayRunID}",
        "stubs": "Payslips",
        "stubIdField": "PayslipID",
        # PayslipSummary stamps its last change as LastEdited where the
        # Payslip object (and the walk table's modified column) use UpdatedDateUTC.
        "stubModifiedField": "LastEdited",
    },
}
# Bump when a chain's landing rules change: every parent is re-walked once.
CHAIN_VERSION = 1
# Consecutive 401/403/404 answers, before any success in a pass, after which
# the chain stops asking: for parent detail the whole chain backs off like an
# unavailable group; for stub detail the pass keeps landing the summaries the
# parent detail carries and stops spending the daily allowance on lines the
# grant cannot read.
CHAIN_UNAVAILABLE_PROBES = 3
CONTROL_COLUMNS = {
    "source_record_id": "STRING",
    "source_updated_at": "UTC_DATETIME",
    "tombstone": "BOOLEAN",
    "_albert_synced_at": "UTC_DATETIME",
}


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

def fivetran_type(spec_type: str):
    if spec_type in ("numeric", "real"):
        return {"type": "DECIMAL", "precision": 30, "scale": 8}
    return {
        "text": "STRING",
        "integer": "INT",
        "bigint": "LONG",
        "boolean": "BOOLEAN",
        "date": "NAIVE_DATE",
        "timestamptz": "UTC_DATETIME",
        "timestamp": "UTC_DATETIME",
        "jsonb": "JSON",
        "json": "JSON",
    }.get(spec_type, "STRING")


# Postgres truncates identifiers to 63 bytes; Albert's own staging DDL lives
# with the same limit, so the one over-long spec column (NZ payroll) lands
# under the identical truncated name here rather than tripping Fivetran's
# "Column Length Exceeded" warning.
MAX_IDENTIFIER = 63


def destination_column(name: str) -> str:
    return name[:MAX_IDENTIFIER]


def spec_schema() -> list[dict]:
    tables = []
    for table in SPEC["tables"].values():
        columns = dict(CONTROL_COLUMNS)
        for column in table["columns"]:
            name = destination_column(column["name"])
            if name in columns:
                continue
            columns[name] = fivetran_type(column["type"])
        tables.append({"table": table["id"], "primary_key": ["source_record_id"], "columns": columns})
    return tables


# ---------------------------------------------------------------------------
# Value typing
# ---------------------------------------------------------------------------

def _to_decimal(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        try:
            return str(Decimal(str(value)).quantize(Decimal("0.00000001")))
        except InvalidOperation:
            return None
    if isinstance(value, str):
        text = value.strip().replace(",", "")
        if not text:
            return None
        try:
            return str(Decimal(text).quantize(Decimal("0.00000001")))
        except InvalidOperation:
            return None
    return None


def _to_int(value):
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(Decimal(value.strip()))
        except (InvalidOperation, ValueError):
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


def _to_datetime(value):
    return parse_datetime(value)


def typed_value(spec_type: str, value):
    if value is None:
        return None
    if spec_type in ("numeric", "real"):
        return _to_decimal(value)
    if spec_type in ("integer", "bigint"):
        return _to_int(value)
    if spec_type == "boolean":
        return _to_bool(value)
    if spec_type == "date":
        return _to_date(value)
    if spec_type in ("timestamptz", "timestamp"):
        return _to_datetime(value)
    if spec_type in ("jsonb", "json"):
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
    """Map a projected row (fields keyed by staged field name) to a typed Fivetran record."""
    from xero_projection import source_field

    record = {
        "source_record_id": row["sourceRecordId"],
        "source_updated_at": _to_datetime(row.get("updatedAt")),
        "tombstone": bool(row.get("tombstone")),
        "_albert_synced_at": synced_at,
    }
    fields = row["fields"]
    for column in table["columns"]:
        name = destination_column(column["name"])
        if name in CONTROL_COLUMNS:
            continue
        value = fields.get(source_field(column))
        record[name] = typed_value(column["type"], value)
    return record


# ---------------------------------------------------------------------------
# Walks
# ---------------------------------------------------------------------------

def xero_datetime(moment: datetime) -> str:
    moment = moment.astimezone(timezone.utc)
    return f"DateTime({moment.year},{moment.month},{moment.day},{moment.hour},{moment.minute},{moment.second})"


def _backoff_entry(entry: dict, kind: str, message: str, now: datetime) -> dict:
    """State entry for a failed walk: keeps the watermark, records why, and
    sets retry_after so the walk is skipped until the cooldown has passed."""
    from datetime import timedelta
    failures = int(entry.get("failures") or 0) + 1
    if kind == "unavailable":
        hours = UNAVAILABLE_RECHECK_HOURS
    else:
        hours = min(ERROR_BACKOFF_MAX_HOURS, ERROR_BACKOFF_HOURS * (2 ** (failures - 1)))
    # A parent-detail chain's in-pass progress (`landed`) and its completion
    # marker survive a cooldown, so the pass resumes instead of re-spending.
    kept = {k: v for k, v in entry.items() if k in ("watermark", "chain", "landed")}
    return {
        **kept,
        kind: message[:160],
        "checked_at": now.isoformat(),
        "failures": failures,
        "retry_after": (now + timedelta(hours=hours)).isoformat(),
    }


def _in_cooldown(entry: dict, now: datetime) -> bool:
    retry_after = parse_datetime(entry.get("retry_after")) if entry.get("retry_after") else None
    return bool(retry_after and retry_after > now)


def _parent_stamp(record: dict, modified_field: str | None) -> str:
    """What must differ for a parent already landed in a chain pass to be
    fetched again: its modified stamp and its status (Xero re-stamps a pay run
    whose payslips changed; posting changes the status)."""
    modified = normalize_xero_value(record.get(modified_field)) if modified_field else None
    status = record.get("PayRunStatus") or record.get("Status")
    return f"{modified or ''}|{status or ''}"


def http_date(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT")


class XeroSync:
    def __init__(self, configuration: dict, state: dict, emit: Emit, checkpoint: Checkpoint,
                 client: XeroClient | None = None, now: datetime | None = None):
        self.configuration = configuration
        self.state = state if isinstance(state, dict) else {}
        self.state.setdefault("groups", {})
        self.state.setdefault("fanouts", {})
        self.emit = emit
        self.checkpoint = checkpoint
        self.client = client or XeroClient(configuration)
        self.now = now or datetime.now(timezone.utc)
        self.include_optional = str(configuration.get("include_optional", "false")).lower() == "true"
        self.tables = SPEC["tables"]
        self.profiles = SPEC["profiles"]
        self.rows_emitted = 0
        self.skipped = 0
        self.tables_touched: set[str] = set()
        self._clauseless_groups: set[str] = set()
        self._parent_cache: dict[str, list] = {}
        self.chain_stats: dict[str, dict] = {}

    # -- org / region ------------------------------------------------------

    def enabled_apis(self) -> set[str]:
        apis = set(ALWAYS_ON_APIS)
        forced = str(self.configuration.get("payroll_region", "")).strip().upper()
        version = forced
        if not version:
            try:
                _, body = self.client.get_json("/api.xro/2.0/Organisation")
                orgs = (body or {}).get("Organisations") or []
                version = str((orgs[0] if orgs else {}).get("Version", "")).upper()
            except NotAvailable:
                version = ""
        api = PAYROLL_API_FOR_VERSION.get(version)
        if api:
            apis.add(api)
        return apis

    # -- group walk --------------------------------------------------------

    def _walk_pages(self, group: dict, since: datetime | None, scan_start: datetime, on_page):
        """Walk every page of a group's endpoint; call on_page(records) per page."""
        leader = self.tables[group["leader"]]
        profile = self.profiles[group["api"]]
        passes = group.get("extraPasses") or [{}]
        strip_clauses = group["key"] in self._clauseless_groups
        headers = {}
        if since and profile["supportsIfModifiedSince"] and group["modifiedField"] and group["pagination"] != "offset":
            headers["if-modified-since"] = http_date(since)
        for extra in passes:
            page = 1
            offset = 0
            while True:
                params = dict(group.get("baseParams") or {})
                params.update(extra)
                if group["pagination"] == "page" and profile["pageParam"]:
                    params[profile["pageParam"]] = str(page)
                    if profile["pageSizeParam"]:
                        params[profile["pageSizeParam"]] = str(profile["pageSize"])
                    if profile["supportsOrder"] and group["modifiedField"] and leader.get("recordIdField"):
                        params["order"] = f"{group['modifiedField']} ASC,{leader['recordIdField']} ASC"
                elif group["pagination"] == "offset":
                    params["offset"] = str(offset)
                if (group["pagination"] != "offset" and profile["supportsWhere"] and group["whereFilterable"]
                        and group["modifiedField"]):
                    params["where"] = f"{group['modifiedField']}<{xero_datetime(scan_start)}"
                if strip_clauses:
                    params.pop("order", None)
                    params.pop("where", None)
                try:
                    status, body = self.client.get_json(
                        group["path"], params, headers, tenant_scoped=group["api"] != "identity",
                    )
                except XeroError as error:
                    # Some endpoints (Quotes) reject an order/where clause other
                    # walks accept, with ErrorNumber 16 QueryParseException.
                    # Retry the page without the clauses rather than losing the
                    # family; ordering only tightens page stability, it is not
                    # required for correctness because the scan re-walks fully
                    # until a watermark exists.
                    if "QueryParseException" not in str(error) or (
                        "order" not in params and "where" not in params
                    ):
                        raise
                    params.pop("order", None)
                    params.pop("where", None)
                    strip_clauses = True
                    self._clauseless_groups.add(group["key"])
                    _log(f"{group['path']}: retrying without order/where after QueryParseException", "WARNING")
                    status, body = self.client.get_json(
                        group["path"], params, headers, tenant_scoped=group["api"] != "identity",
                    )
                if status == 304 or body is None:
                    return
                records = unwrap_envelope(body, leader)
                if records:
                    on_page(records)
                if group["pagination"] == "page":
                    # Page sizes are fixed per API (pageSize when the API takes
                    # one, else Xero's 100); a short page is the last one.
                    page_size = profile["pageSize"] if profile["pageSizeParam"] else 100
                    if len(records) < max(1, page_size):
                        break
                    page += 1
                    if page > 5000:
                        break
                elif group["pagination"] == "offset":
                    if not records:
                        break
                    last = records[-1]
                    number = last.get("JournalNumber") if isinstance(last, dict) else None
                    if not isinstance(number, int):
                        break
                    offset = number
                    if len(records) < 100:
                        break
                else:
                    break

    def sync_group(self, group: dict) -> None:
        key = group["key"]
        leader = self.tables[group["leader"]]
        entry = self.state["groups"].get(key) or {}
        if _in_cooldown(entry, self.now):
            self.skipped += 1
            return
        since = parse_datetime(entry.get("watermark")) if entry.get("watermark") else None
        scan_start = self.now
        synced_at = datetime.now(timezone.utc)
        members = [(self.tables[member["table"]]) for member in group["members"]]

        def on_page(records: list):
            for table in members:
                rows = project_stream_rows(table, leader, records, table.get("recordIdField") or "")
                for row in rows:
                    self.emit(table["id"], row_to_record(table, row, synced_at))
                    self.rows_emitted += 1
                self.tables_touched.add(table["id"])

        try:
            self._walk_pages(group, since, scan_start, on_page)
        except NotAvailable as error:
            # Scope tier / region / retired endpoint: not reachable for this org.
            self.state["groups"][key] = _backoff_entry(entry, "unavailable", str(error), scan_start)
            self.checkpoint(self.state)
            return
        except (DailyLimitReached, TokenBrokerError):
            raise
        except (XeroError, ValueError, TypeError, KeyError, AttributeError) as error:
            # One family failing must not take the whole sync down; keep the old
            # watermark and back off before retrying it.
            _log(f"group {key} failed: {type(error).__name__}: {error}", "WARNING")
            self.state["groups"][key] = _backoff_entry(entry, "error", str(error), scan_start)
            self.checkpoint(self.state)
            return
        self.state["groups"][key] = {"watermark": scan_start.isoformat()}
        self.checkpoint(self.state)

    # -- fan-outs ----------------------------------------------------------

    def _fan_out_requests(self, fan_out: dict, parent_records: list, parent_table: dict) -> list[dict]:
        path = fan_out["path"]
        param = fan_out["fanOutParam"]
        uses_path_param = f"{{{param}}}" in path
        requests = []
        seen = set()
        for parent in parent_records:
            if not isinstance(parent, dict):
                continue
            ids: list[str] = []
            own = _read_identifier(parent, param)
            if own:
                ids.append(own)
            elif param == (parent_table.get("recordIdField") or ""):
                via = _read_identifier(parent, parent_table.get("recordIdField") or "")
                if via:
                    ids.append(via)
            else:
                for value in parent.values():
                    if not isinstance(value, list):
                        continue
                    for stub in value:
                        if isinstance(stub, dict):
                            stub_id = _read_identifier(stub, param)
                            if stub_id:
                                ids.append(stub_id)
                if not ids:
                    fallback = _read_identifier(parent, parent_table.get("recordIdField") or "")
                    if fallback:
                        ids.append(fallback)
            for identifier in ids:
                if identifier in seen:
                    continue
                seen.add(identifier)
                if uses_path_param:
                    from urllib.parse import quote
                    requests.append({"path": path.replace(f"{{{param}}}", quote(identifier, safe="")),
                                     "params": {}, "parentId": identifier, "parent": parent})
                else:
                    requests.append({"path": path, "params": {param: identifier}, "parentId": identifier, "parent": parent})
        return requests

    def _group_for_table(self, table_id: str) -> dict | None:
        for group in SPEC["groups"]:
            if any(member["table"] == table_id for member in group["members"]):
                return group
        return None

    def sync_fan_out(self, fan_out: dict) -> None:
        if fan_out.get("templatedParents"):
            return  # attachments / history: per-document, on demand only
        if fan_out["availability"] == "optional" and not self.include_optional:
            return
        parent_id = fan_out.get("parentTable")
        parent_table = self.tables.get(parent_id) if parent_id else None
        if not parent_table:
            return
        parent_group = self._group_for_table(parent_id)
        parent_fan_out = None
        if parent_group is None:
            # Parent is itself a fan-out walk (working weeks under working patterns): skip
            # second-level fan-outs unless optional inclusion is on.
            parent_fan_out = next((f for f in SPEC["fanOuts"] if f["id"] == parent_id), None)
            if parent_fan_out is None or not self.include_optional:
                return
            return

        entry = self.state["fanouts"].get(fan_out["id"]) or {}
        if _in_cooldown(entry, self.now):
            self.skipped += 1
            return
        chain = PARENT_DETAIL_CHAINS.get(fan_out["id"])
        if chain:
            self._sync_parent_detail_chain(fan_out, chain, parent_table, parent_group, entry)
            return
        since = parse_datetime(entry.get("watermark")) if entry.get("watermark") else None
        scan_start = self.now
        synced_at = datetime.now(timezone.utc)
        walk_table = self.tables[fan_out["id"]]
        member_tables = [walk_table] + [self.tables[member["table"]] for member in fan_out["members"]]
        issued = {"count": 0}

        def on_page(parent_records: list):
            for request in self._fan_out_requests(fan_out, parent_records, parent_table):
                try:
                    status, body = self.client.get_json(request["path"], request["params"])
                except NotAvailable:
                    continue
                if status == 304 or body is None:
                    continue
                sub_records = unwrap_envelope(body, walk_table)
                for table in member_tables:
                    rows = project_stream_rows(
                        table, walk_table, sub_records, table.get("recordIdField") or "",
                        fan_out_parent={"record": request["parent"], "table": parent_table},
                    )
                    for row in rows:
                        self.emit(table["id"], row_to_record(table, row, synced_at))
                        self.rows_emitted += 1
                    self.tables_touched.add(table["id"])
                issued["count"] += 1
                if issued["count"] % SUB_REQUESTS_PER_CHECKPOINT == 0:
                    self.checkpoint(self.state)

        if not self._walk_fan_out(fan_out, entry, parent_group, since, scan_start, on_page):
            return
        self.state["fanouts"][fan_out["id"]] = {"watermark": scan_start.isoformat()}
        self.checkpoint(self.state)

    def _walk_fan_out(self, fan_out: dict, entry: dict, parent_group: dict, since: datetime | None,
                      scan_start: datetime, on_page) -> bool:
        """Walk a fan-out's parent group under the shared failure discipline.
        True when the walk completed; False when it was recorded as unavailable
        or erroring (cooldown written and checkpointed)."""
        try:
            self._walk_pages(parent_group, since, scan_start, on_page)
        except NotAvailable as error:
            self.state["fanouts"][fan_out["id"]] = _backoff_entry(entry, "unavailable", str(error), scan_start)
            self.checkpoint(self.state)
            return False
        except (DailyLimitReached, TokenBrokerError):
            raise
        except (XeroError, ValueError, TypeError, KeyError, AttributeError) as error:
            _log(f"fan-out {fan_out['id']} failed: {type(error).__name__}: {error}", "WARNING")
            self.state["fanouts"][fan_out["id"]] = _backoff_entry(entry, "error", str(error), scan_start)
            self.checkpoint(self.state)
            return False
        return True

    def _sync_parent_detail_chain(self, fan_out: dict, chain: dict, parent_table: dict, parent_group: dict,
                                  entry: dict) -> None:
        """Fan-out whose child ids only exist on the parent's detail endpoint
        (PARENT_DETAIL_CHAINS). Incremental like every fan-out: the parent walk
        is If-Modified-Since from the chain's watermark, so a POSTED pay run
        whose payslips have landed costs nothing until Xero reports it modified.
        Parents landed in the pass are remembered in state (`landed`) and the
        watermark only moves once the pass lands every parent the walk returned,
        so a pass the daily reserve cuts short resumes where it stopped."""
        fan_out_id = fan_out["id"]
        scan_start = self.now
        synced_at = datetime.now(timezone.utc)
        walk_table = self.tables[fan_out_id]
        member_tables = [self.tables[member["table"]] for member in fan_out["members"]]
        parent_id_field = parent_table.get("recordIdField") or ""
        parent_modified = parent_group.get("modifiedField")
        stubs_key = chain["stubs"]
        stub_id_field = chain["stubIdField"]
        stub_modified = chain.get("stubModifiedField")
        walk_modified = walk_table["source"].get("modifiedField") or ""
        # A watermark written before this chain existed belongs to a walk that
        # "completed" without landing a payslip; ignoring it makes the first
        # pass after the fix backfill every parent exactly once.
        chain_complete = entry.get("chain") == CHAIN_VERSION
        since = parse_datetime(entry["watermark"]) if chain_complete and entry.get("watermark") else None
        landed = entry.get("landed") if isinstance(entry.get("landed"), dict) else {}
        entry = dict(entry)
        entry["landed"] = landed
        self.state["fanouts"][fan_out_id] = entry  # in-pass progress must reach every checkpoint
        stats = self.chain_stats.setdefault(fan_out_id, {
            "parents": 0, "already_landed": 0, "parent_calls": 0, "stub_calls": 0, "rows": 0,
            "stubs_unavailable": False,
        })
        probes = {"parent_ok": 0, "parent_denied": 0, "stub_ok": 0, "stub_denied": 0}
        issued = {"count": 0}

        def emit_rows(table: dict, rows: list) -> None:
            for row in rows:
                self.emit(table["id"], row_to_record(table, row, synced_at))
                self.rows_emitted += 1
                stats["rows"] += 1
            self.tables_touched.add(table["id"])

        def tick() -> None:
            issued["count"] += 1
            if issued["count"] % SUB_REQUESTS_PER_CHECKPOINT == 0:
                self.checkpoint(self.state)

        def fetch_parent_detail(parent_id: str):
            path = chain["detailPath"].replace(f"{{{parent_id_field}}}", quote(parent_id, safe=""))
            stats["parent_calls"] += 1
            try:
                status, body = self.client.get_json(path)
            except NotAvailable:
                probes["parent_denied"] += 1
                if probes["parent_ok"] == 0 and probes["parent_denied"] >= CHAIN_UNAVAILABLE_PROBES:
                    raise  # the detail endpoint itself is out of reach: back off like a group
                return None
            probes["parent_ok"] += 1
            if status == 304 or body is None:
                return None
            records = [record for record in unwrap_envelope(body, parent_table) if isinstance(record, dict)]
            return next((record for record in records if _read_identifier(record, parent_id_field) == parent_id),
                        records[0] if records else None)

        def fetch_stub_detail(stub_id: str):
            if stats["stubs_unavailable"]:
                return None
            path = fan_out["path"].replace(f"{{{fan_out['fanOutParam']}}}", quote(stub_id, safe=""))
            stats["stub_calls"] += 1
            try:
                status, body = self.client.get_json(path)
            except NotAvailable as error:
                probes["stub_denied"] += 1
                if probes["stub_ok"] == 0 and probes["stub_denied"] >= CHAIN_UNAVAILABLE_PROBES:
                    # The summaries are landed already; the lines are not
                    # readable with this grant, so stop paying to find out.
                    stats["stubs_unavailable"] = True
                    _log(f"chain {fan_out_id}: {fan_out['path']} unavailable ({error}); landing summaries only",
                         "WARNING")
                return None
            probes["stub_ok"] += 1
            if status == 304 or body is None:
                return None
            return unwrap_envelope(body, walk_table)

        def on_page(parent_records: list):
            for parent in parent_records:
                if not isinstance(parent, dict):
                    continue
                parent_id = _read_identifier(parent, parent_id_field)
                if not parent_id:
                    continue
                stats["parents"] += 1
                stamp = _parent_stamp(parent, parent_modified)
                if landed.get(parent_id) == stamp:
                    stats["already_landed"] += 1
                    continue
                detail = fetch_parent_detail(parent_id)
                if detail is None:
                    # Not readable right now. Never remembered as landed: the
                    # next walk re-probes it, so a scope granted later still
                    # backfills every run.
                    tick()
                    continue
                # The parent row again, now with what the list omitted (PayRun.Payslips).
                emit_rows(parent_table, project_stream_rows(parent_table, parent_table, [detail], parent_id_field))
                pending = []
                seen = set()
                for stub in detail.get(stubs_key) or []:
                    if not isinstance(stub, dict):
                        continue
                    stub_id = _read_identifier(stub, stub_id_field)
                    if not stub_id or stub_id in seen:
                        continue
                    seen.add(stub_id)
                    element = dict(stub)
                    if stub_modified and walk_modified and walk_modified not in element and stub_modified in element:
                        element[walk_modified] = element[stub_modified]
                    # The parent as this stub sees it, so `PayRun.Payslips.X`
                    # citations resolve against the stub itself.
                    fan_out_parent = {"record": {**detail, stubs_key: element}, "table": parent_table}
                    emit_rows(walk_table, project_stream_rows(
                        walk_table, walk_table, [element], walk_table.get("recordIdField") or "",
                        fan_out_parent=fan_out_parent,
                    ))
                    pending.append((stub_id, fan_out_parent))
                for stub_id, fan_out_parent in pending:
                    sub_records = fetch_stub_detail(stub_id)
                    if sub_records:
                        for table in [walk_table] + member_tables:
                            emit_rows(table, project_stream_rows(
                                table, walk_table, sub_records, table.get("recordIdField") or "",
                                fan_out_parent=fan_out_parent,
                            ))
                    tick()
                landed[parent_id] = stamp
                tick()

        if not self._walk_fan_out(fan_out, entry, parent_group, since, scan_start, on_page):
            return
        self.state["fanouts"][fan_out_id] = {"watermark": scan_start.isoformat(), "chain": CHAIN_VERSION}
        self.checkpoint(self.state)
        _log(f"chain {fan_out_id}: {json.dumps(stats)}")

    # -- orchestration -----------------------------------------------------

    def run(self) -> dict:
        summary = {"groups": 0, "fan_outs": 0, "rows": 0, "stopped_early": None}
        try:
            apis = self.enabled_apis()
            for group in SPEC["groups"]:
                if group["api"] not in apis:
                    continue
                if group["availability"] == "optional" and not self.include_optional and group["api"] == "accounting" \
                        and group["endpointOp"].startswith("GET /Reports/TenNinetyNine"):
                    continue
                self.sync_group(group)
                summary["groups"] += 1
            deferred = []
            for fan_out in SPEC["fanOuts"]:
                if fan_out["api"] not in apis:
                    continue
                if fan_out["id"] in PARENT_DETAIL_CHAINS:
                    # The costliest walks (one detail per parent plus one per
                    # stub) go last, so every other table lands first when the
                    # daily reserve cuts a sync short.
                    deferred.append(fan_out)
                    continue
                self.sync_fan_out(fan_out)
                summary["fan_outs"] += 1
            for fan_out in deferred:
                self.sync_fan_out(fan_out)
                summary["fan_outs"] += 1
        except DailyLimitReached as error:
            summary["stopped_early"] = str(error)
            self.checkpoint(self.state)
        summary["rows"] = self.rows_emitted
        summary["chains"] = self.chain_stats
        summary["calls"] = self.client.calls
        summary["skipped_in_cooldown"] = self.skipped
        summary["day_remaining"] = self.client.day_remaining
        return summary
