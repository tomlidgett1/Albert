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
    client = XeroClient(configuration)
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
        "rows": summary.get("rows"),
        "calls": summary.get("calls"),
        "stopped_early": summary.get("stopped_early"),
    }

    interval_hours = float(configuration.get("reports_interval_hours") or 6)
    reports_state = state.setdefault("reports", {})
    last_run = parse_datetime(reports_state.get("last_run")) if reports_state.get("last_run") else None
    due = last_run is None or datetime.now(timezone.utc) - last_run >= timedelta(hours=interval_hours)
    if due and not summary.get("stopped_early"):
        organisation = _organisation(client)
        reports = XeroReports(client, _emit, organisation)
        try:
            report_summary = reports.run()
            reports_state["last_run"] = datetime.now(timezone.utc).isoformat()
            log.info(f"Reports: {json.dumps(report_summary)}")
        except Exception as error:  # noqa: BLE001 - reports must not fail the whole sync
            log.warning(f"Reports run failed and will retry next sync: {error}")
    op.checkpoint(state=state)
    log.info(f"Albert Xero sync finished: {sync.client.calls} Xero calls")


connector = Connector(update=update, schema=schema)

if __name__ == "__main__":
    connector.debug()
