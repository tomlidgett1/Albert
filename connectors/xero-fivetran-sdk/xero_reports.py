"""
Xero Reports → tables. The Reports API returns a rendered grid (header row of
period columns, sections, rows with cells that carry the account id as an
attribute). Every report is flattened to one line per (row × period column):

  xero_report_profit_and_loss_lines   ACCRUAL + CASH (paymentsOnly) basis, monthly, trailing 24 months
  xero_report_balance_sheet_lines     month-end snapshots, trailing 24 months
  xero_report_trial_balance_lines     last 3 month-ends + financial-year end
  xero_report_bank_summary_lines      per bank account, monthly, trailing 12 months
  xero_report_executive_summary_lines current + previous month
  xero_report_budget_summary_lines    12 monthly periods from today

Report grids are recomputed by Xero on every call, so lines are re-upserted on
each run (keys are stable per report/period/section/row/account/ordinal). Runs
are throttled by `reports_interval_hours` (default 6) — the whole set costs
~25 API calls, which is trivial against the daily budget at that cadence.
"""
from __future__ import annotations

import calendar
import hashlib
import re
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Callable

from xero_client import NotAvailable, XeroClient
from xero_projection import parse_datetime

Emit = Callable[[str, dict], None]

REPORT_TABLES = {
    "xero_report_profit_and_loss_lines": {
        "basis": "STRING", "period_start": "NAIVE_DATE", "period_end": "NAIVE_DATE", "column_label": "STRING",
        "section": "STRING", "row_title": "STRING", "row_type": "STRING", "account_id": "STRING",
        "amount": {"type": "DECIMAL", "precision": 30, "scale": 8}, "ordinal": "INT",
    },
    "xero_report_balance_sheet_lines": {
        "as_at": "NAIVE_DATE", "column_label": "STRING", "section": "STRING", "row_title": "STRING",
        "row_type": "STRING", "account_id": "STRING",
        "amount": {"type": "DECIMAL", "precision": 30, "scale": 8}, "ordinal": "INT",
    },
    "xero_report_trial_balance_lines": {
        "as_at": "NAIVE_DATE", "section": "STRING", "row_title": "STRING", "row_type": "STRING", "account_id": "STRING",
        "debit": {"type": "DECIMAL", "precision": 30, "scale": 8}, "credit": {"type": "DECIMAL", "precision": 30, "scale": 8},
        "ytd_debit": {"type": "DECIMAL", "precision": 30, "scale": 8}, "ytd_credit": {"type": "DECIMAL", "precision": 30, "scale": 8},
        "ordinal": "INT",
    },
    "xero_report_bank_summary_lines": {
        "period_start": "NAIVE_DATE", "period_end": "NAIVE_DATE", "section": "STRING", "row_title": "STRING",
        "row_type": "STRING", "account_id": "STRING",
        "opening_balance": {"type": "DECIMAL", "precision": 30, "scale": 8},
        "cash_received": {"type": "DECIMAL", "precision": 30, "scale": 8},
        "cash_spent": {"type": "DECIMAL", "precision": 30, "scale": 8},
        "closing_balance": {"type": "DECIMAL", "precision": 30, "scale": 8}, "ordinal": "INT",
    },
    "xero_report_executive_summary_lines": {
        "period_end": "NAIVE_DATE", "column_label": "STRING", "section": "STRING", "row_title": "STRING",
        "row_type": "STRING", "value_text": "STRING",
        "amount": {"type": "DECIMAL", "precision": 30, "scale": 8}, "ordinal": "INT",
    },
    "xero_report_budget_summary_lines": {
        "period_end": "NAIVE_DATE", "column_label": "STRING", "section": "STRING", "row_title": "STRING",
        "row_type": "STRING", "account_id": "STRING",
        "amount": {"type": "DECIMAL", "precision": 30, "scale": 8}, "ordinal": "INT",
    },
}
COMMON_COLUMNS = {
    "source_record_id": "STRING",
    "report_id": "STRING",
    "report_name": "STRING",
    "report_updated_at": "UTC_DATETIME",
    "_albert_synced_at": "UTC_DATETIME",
}


def report_schema() -> list[dict]:
    return [
        {"table": name, "primary_key": ["source_record_id"], "columns": {**COMMON_COLUMNS, **columns}}
        for name, columns in REPORT_TABLES.items()
    ]


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def month_end(moment: date) -> date:
    return date(moment.year, moment.month, calendar.monthrange(moment.year, moment.month)[1])


def month_start(moment: date) -> date:
    return date(moment.year, moment.month, 1)


def shift_months(moment: date, months: int) -> date:
    year = moment.year + (moment.month - 1 + months) // 12
    month = (moment.month - 1 + months) % 12 + 1
    return date(year, month, min(moment.day, calendar.monthrange(year, month)[1]))


_LABEL_FORMATS = ("%d %b %y", "%d %b %Y", "%d %B %y", "%d %B %Y", "%Y-%m-%d", "%b %y", "%b %Y", "%B %y", "%B %Y")


def parse_column_date(label: str | None) -> date | None:
    if not label:
        return None
    text = label.strip()
    for fmt in _LABEL_FORMATS:
        try:
            parsed = datetime.strptime(text, fmt).date()
            if fmt in ("%b %y", "%b %Y", "%B %y", "%B %Y"):
                return month_end(parsed)
            return parsed
        except ValueError:
            continue
    parsed = parse_datetime(text)
    return parsed.date() if parsed else None


def to_decimal(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(Decimal(str(value)).quantize(Decimal("0.00000001")))
    text = str(value).strip().replace(",", "")
    if not text:
        return None
    negative = text.startswith("(") and text.endswith(")")
    text = text.strip("()").replace("%", "")
    try:
        number = Decimal(text)
    except InvalidOperation:
        return None
    if negative:
        number = -number
    return str(number.quantize(Decimal("0.00000001")))


def cell_value(cell: dict):
    return cell.get("Value") if isinstance(cell, dict) else None


def cell_account_id(cell: dict) -> str | None:
    if not isinstance(cell, dict):
        return None
    for attribute in cell.get("Attributes") or []:
        if isinstance(attribute, dict) and str(attribute.get("Id", "")).lower() == "account":
            value = attribute.get("Value")
            return str(value) if value else None
    return None


def line_key(*parts) -> str:
    joined = "\x1f".join("" if part is None else str(part) for part in parts)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:40]


def report_updated(report: dict) -> datetime | None:
    return parse_datetime(report.get("UpdatedDateUTC"))


def walk_rows(rows: list, section: str | None = None):
    """Yield (section_title, row) for every leaf row in a report grid."""
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        row_type = row.get("RowType")
        if row_type == "Section":
            yield from walk_rows(row.get("Rows") or [], row.get("Title") or section or "")
        elif row_type in ("Row", "SummaryRow"):
            yield section or "", row


def header_cells(report: dict) -> list:
    for row in report.get("Rows") or []:
        if isinstance(row, dict) and row.get("RowType") == "Header":
            return row.get("Cells") or []
    return []


# ---------------------------------------------------------------------------
# extraction
# ---------------------------------------------------------------------------

class XeroReports:
    def __init__(self, client: XeroClient, emit: Emit, organisation: dict | None, today: date | None = None):
        self.client = client
        self.emit = emit
        self.organisation = organisation or {}
        self.today = today or datetime.now(timezone.utc).date()
        self.synced_at = datetime.now(timezone.utc)
        self.rows = 0
        self.calls = 0

    def _fetch(self, name: str, params: dict) -> dict | None:
        try:
            _, body = self.client.get_json(f"/api.xro/2.0/Reports/{name}", params)
        except NotAvailable:
            return None
        self.calls += 1
        reports = (body or {}).get("Reports") or []
        return reports[0] if reports and isinstance(reports[0], dict) else None

    def _emit(self, table: str, report: dict, key_parts: list, record: dict) -> None:
        record = {
            "source_record_id": line_key(table, *key_parts),
            "report_id": report.get("ReportID"),
            "report_name": report.get("ReportName"),
            "report_updated_at": report_updated(report),
            "_albert_synced_at": self.synced_at,
            **record,
        }
        self.emit(table, record)
        self.rows += 1

    # -- period-grid reports (P&L, balance sheet, budget summary, exec summary)

    def _emit_period_grid(self, table: str, report: dict, basis: str | None, date_field: str,
                          start_field: str | None = None, with_text: bool = False, key_extra=()):
        headers = header_cells(report)
        labels = [cell_value(cell) for cell in headers][1:]
        seen: dict = {}
        for section, row in walk_rows(report.get("Rows") or []):
            cells = row.get("Cells") or []
            if not cells:
                continue
            title = cell_value(cells[0]) or ""
            account_id = cell_account_id(cells[0])
            ordinal = seen.get((section, title, account_id), 0)
            seen[(section, title, account_id)] = ordinal + 1
            for index, cell in enumerate(cells[1:]):
                label = labels[index] if index < len(labels) else None
                if index >= len(labels) and label is None:
                    continue
                period_end = parse_column_date(label)
                if not period_end and label:
                    continue
                value = cell_value(cell)
                if account_id is None:
                    account_id = cell_account_id(cell)
                record = {
                    date_field: period_end,
                    "column_label": label,
                    "section": section,
                    "row_title": title,
                    "row_type": row.get("RowType"),
                    "ordinal": ordinal,
                }
                if start_field:
                    record[start_field] = month_start(period_end) if period_end else None
                if basis is not None:
                    record["basis"] = basis
                if table != "xero_report_executive_summary_lines":
                    record["account_id"] = account_id
                    record["amount"] = to_decimal(value)
                else:
                    record["value_text"] = None if value is None else str(value)
                    record["amount"] = to_decimal(value)
                key = [basis, period_end.isoformat() if period_end else label, section, title, account_id, ordinal, *key_extra]
                self._emit(table, report, key, record)

    def profit_and_loss(self) -> None:
        current_end = month_end(self.today)
        for basis, extra in (("ACCRUAL", {}), ("CASH", {"paymentsOnly": "true"})):
            for offset in (0, 12):
                to_date = month_end(shift_months(current_end, -offset))
                report = self._fetch("ProfitAndLoss", {
                    "toDate": to_date.isoformat(),
                    "periods": "11",
                    "timeframe": "MONTH",
                    "standardLayout": "true",
                    **extra,
                })
                if report:
                    self._emit_period_grid("xero_report_profit_and_loss_lines", report, basis,
                                           "period_end", start_field="period_start")

    def balance_sheet(self) -> None:
        current_end = month_end(self.today)
        for offset in (0, 12):
            as_at = month_end(shift_months(current_end, -offset))
            report = self._fetch("BalanceSheet", {
                "date": as_at.isoformat(), "periods": "11", "timeframe": "MONTH", "standardLayout": "true",
            })
            if report:
                self._emit_period_grid("xero_report_balance_sheet_lines", report, None, "as_at")

    def budget_summary(self) -> None:
        report = self._fetch("BudgetSummary", {"date": self.today.isoformat(), "periods": "12", "timeframe": "1"})
        if report:
            self._emit_period_grid("xero_report_budget_summary_lines", report, None, "period_end")

    def executive_summary(self) -> None:
        for offset in (0, 1):
            as_at = month_end(shift_months(month_end(self.today), -offset))
            report = self._fetch("ExecutiveSummary", {"date": as_at.isoformat()})
            if report:
                self._emit_period_grid("xero_report_executive_summary_lines", report, None, "period_end",
                                       with_text=True, key_extra=(as_at.isoformat(),))

    # -- fixed-column reports (trial balance, bank summary)

    def _emit_fixed_columns(self, table: str, report: dict, column_names: list[str], key_parts: list, record_base: dict):
        headers = [str(cell_value(cell) or "").strip().lower() for cell in header_cells(report)]
        seen: dict = {}
        for section, row in walk_rows(report.get("Rows") or []):
            cells = row.get("Cells") or []
            if not cells:
                continue
            title = cell_value(cells[0]) or ""
            account_id = cell_account_id(cells[0])
            ordinal = seen.get((section, title, account_id), 0)
            seen[(section, title, account_id)] = ordinal + 1
            record = {**record_base, "section": section, "row_title": title, "row_type": row.get("RowType"),
                      "account_id": account_id, "ordinal": ordinal}
            for name in column_names:
                record[name] = None
            for index, cell in enumerate(cells[1:], start=1):
                header = headers[index] if index < len(headers) else ""
                target = _match_column(header, column_names)
                if target:
                    record[target] = to_decimal(cell_value(cell))
                if account_id is None:
                    account_id = cell_account_id(cell)
                    record["account_id"] = account_id
            self._emit(table, report, [*key_parts, section, title, account_id, ordinal], record)

    def trial_balance(self) -> None:
        dates = []
        current_end = month_end(self.today)
        for offset in (0, 1, 2):
            dates.append(month_end(shift_months(current_end, -offset)))
        fy_end = self._financial_year_end()
        if fy_end and fy_end not in dates:
            dates.append(fy_end)
        for as_at in dates:
            report = self._fetch("TrialBalance", {"date": as_at.isoformat()})
            if report:
                self._emit_fixed_columns("xero_report_trial_balance_lines", report,
                                         ["debit", "credit", "ytd_debit", "ytd_credit"],
                                         [as_at.isoformat()], {"as_at": as_at})

    def bank_summary(self) -> None:
        current_end = month_end(self.today)
        for offset in range(0, 12):
            period_end = month_end(shift_months(current_end, -offset))
            period_start = month_start(period_end)
            report = self._fetch("BankSummary", {"fromDate": period_start.isoformat(), "toDate": period_end.isoformat()})
            if report:
                self._emit_fixed_columns("xero_report_bank_summary_lines", report,
                                         ["opening_balance", "cash_received", "cash_spent", "closing_balance"],
                                         [period_start.isoformat(), period_end.isoformat()],
                                         {"period_start": period_start, "period_end": period_end})

    def _financial_year_end(self) -> date | None:
        try:
            day = int(self.organisation.get("FinancialYearEndDay") or 0)
            month = int(self.organisation.get("FinancialYearEndMonth") or 0)
        except (TypeError, ValueError):
            return None
        if not day or not month:
            return None
        candidate = date(self.today.year, month, min(day, calendar.monthrange(self.today.year, month)[1]))
        if candidate > self.today:
            candidate = date(self.today.year - 1, month, min(day, calendar.monthrange(self.today.year - 1, month)[1]))
        return candidate

    def run(self) -> dict:
        for step in (self.profit_and_loss, self.balance_sheet, self.trial_balance, self.bank_summary,
                     self.executive_summary, self.budget_summary):
            step()
        return {"rows": self.rows, "calls": self.calls}


def _match_column(header: str, names: list[str]) -> str | None:
    normalized = re.sub(r"[^a-z]+", "_", header).strip("_")
    for name in names:
        if normalized == name:
            return name
    aliases = {
        "debit": ("debit",), "credit": ("credit",),
        "ytd_debit": ("ytd_debit", "year_to_date_debit"), "ytd_credit": ("ytd_credit", "year_to_date_credit"),
        "opening_balance": ("opening_balance",), "cash_received": ("cash_received",),
        "cash_spent": ("cash_spent",), "closing_balance": ("closing_balance",),
    }
    for name in names:
        if normalized in aliases.get(name, ()):
            return name
    return None
