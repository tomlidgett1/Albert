"""
Albert's Xero connector for the Fivetran Connector SDK.

One connection per Albert tenant, deployed by Albert's sync worker with a
configuration of:

  albert_token_url       Albert sync-worker origin (the token broker)
  albert_token_secret    per-connection bearer secret (Fivetran stores it encrypted)
  albert_tenant_id       Albert tenant ULID
  albert_connection_id   Albert Fivetran connection ULID
  xero_tenant_id         Xero organisation (tenant) id the grant covers
  payroll_region         optional AU|NZ|UK override (else read from Organisation.Version)
  include_optional       "true" to also walk optional fan-outs (CIS, contact groups, …)
  reports_interval_hours how often to refresh the Reports tables (default 6)
  xero_daily_reserve     daily Xero calls the sync must never spend, kept for
                         Albert's live report calls (default 200)
  xero_reports_headroom  extra calls kept back while a Reports refresh is due
                         so the statements always land (default 60)
  xero_access_token      DEBUG ONLY: static token instead of the broker

Tables are Albert's `source_xero.*` staging shapes (generated from
connectors/xero/tables.json) plus the flattened Reports tables, all keyed by a
stable `source_record_id`.
"""
from __future__ import annotations

import json
import traceback
from datetime import datetime, timedelta, timezone

from fivetran_connector_sdk import Connector, Logging as log, Operations as op

from xero_client import XeroClient
from xero_projection import parse_datetime
from xero_reports import XeroReports, report_schema
from xero_sync import XeroSync, spec_schema


def schema(configuration: dict):
    return spec_schema() + report_schema()


def _emit(table: str, record: dict) -> None:
    op.upsert(table=table, data=record)


def _checkpoint(state: dict) -> None:
    op.checkpoint(state=state)


def _organisation(client: XeroClient) -> dict:
    try:
        _, body = client.get_json("/api.xro/2.0/Organisation")
    except Exception as error:  # noqa: BLE001 - reports degrade without org metadata
        log.warning(f"Organisation lookup failed: {error}")
        return {}
    orgs = (body or {}).get("Organisations") or []
    return orgs[0] if orgs and isinstance(orgs[0], dict) else {}


def update(configuration: dict, state: dict):
    state = state or {}
    try:
        _update(configuration, state)
    except Exception as error:  # noqa: BLE001 - re-raised after recording
        # Fivetran surfaces only "Python Code Throwing Error"; keep the real
        # traceback in state so it is readable via the connection-state API.
        state["last_error"] = {
            "at": datetime.now(timezone.utc).isoformat(),
            "type": type(error).__name__,
            "message": str(error)[:500],
            "traceback": traceback.format_exc()[-2500:],
        }
        try:
            op.checkpoint(state=state)
        except Exception:  # noqa: BLE001
            pass
        raise


def _update(configuration: dict, state: dict):
    # Daily-allowance discipline. Xero gives this (uncertified) app 1,000 calls
    # a day per organisation and the SAME allowance serves Albert's live Xero
    # report calls (balance sheet, bank balances, aged receivables). The sync
    # therefore never spends the last `xero_daily_reserve` calls, and keeps a
    # further `xero_reports_headroom` untouched while the Reports API refresh
    # is still due, because Xero's own statements (P&L, balance sheet, bank
    # summary) are worth more to the owner than one more hourly document walk.
    live_reserve = int(configuration.get("xero_daily_reserve") or 200)
    reports_headroom = int(configuration.get("xero_reports_headroom") or 60)

    interval_hours = float(configuration.get("reports_interval_hours") or 6)
    reports_state = state.setdefault("reports", {})
    last_reports = parse_datetime(reports_state.get("last_run")) if reports_state.get("last_run") else None
    reports_due = last_reports is None or datetime.now(timezone.utc) - last_reports >= timedelta(hours=interval_hours)

    client = XeroClient(configuration, daily_reserve=live_reserve + (reports_headroom if reports_due else 0))
    log.info("Albert Xero sync starting")

    sync = XeroSync(configuration, state, _emit, _checkpoint, client=client)
    summary = sync.run()
    log.info(f"Spec sync: {json.dumps(summary)}")
    # Keep the last outcome in state so it is inspectable through Fivetran's
    # connection-state API without dashboard access.
    state["last_run"] = {
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "groups": summary.get("groups"),
        "fan_outs": summary.get("fan_outs"),
        "chains": summary.get("chains"),
        "rows": summary.get("rows"),
        "calls": summary.get("calls"),
        "skipped_in_cooldown": summary.get("skipped_in_cooldown"),
        "day_remaining": summary.get("day_remaining"),
        "stopped_early": summary.get("stopped_early"),
    }

    # Reports run whenever they are due and the hard daily limit is not hit;
    # a walk that stopped early only because it reached the reserve still
    # leaves the reports headroom, so the statements refresh.
    hard_limit = bool(summary.get("stopped_early")) and not client.reserve_exhausted()
    hard_limit = hard_limit or client.day_remaining == 0
    if reports_due and not hard_limit:
        client.daily_reserve = live_reserve
        organisation = _organisation(client)
        reports = XeroReports(client, _emit, organisation)
        try:
            report_summary = reports.run()
            reports_state["last_run"] = datetime.now(timezone.utc).isoformat()
            reports_state["last_summary"] = {
                "at": reports_state["last_run"],
                "rows": report_summary.get("rows"),
                "calls": report_summary.get("calls"),
                "completed": report_summary.get("completed"),
                "failed": report_summary.get("failed"),
            }
            log.info(f"Reports: {json.dumps(report_summary)}")
        except Exception as error:  # noqa: BLE001 - reports must not fail the whole sync
            reports_state["last_error"] = {"at": datetime.now(timezone.utc).isoformat(), "message": str(error)[:300]}
            log.warning(f"Reports run failed and will retry next sync: {error}")
    op.checkpoint(state=state)
    log.info(f"Albert Xero sync finished: {client.calls} Xero calls, day_remaining={client.day_remaining}")


connector = Connector(update=update, schema=schema)

if __name__ == "__main__":
    connector.debug()
