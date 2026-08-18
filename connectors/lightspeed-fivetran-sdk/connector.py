"""
Albert's Lightspeed Retail R-Series connector for the Fivetran Connector SDK.

One connection per Albert tenant, deployed by Albert's sync worker with a
configuration of:

  albert_token_url         Albert sync-worker origin (the token broker)
  albert_token_secret      per-connection bearer secret (Fivetran stores it encrypted)
  albert_tenant_id         Albert tenant ULID
  albert_connection_id     Albert Fivetran connection ULID
  lightspeed_account_id    R-Series account id the grant covers (the broker also returns it)
  include_optional         "true" to also walk the opt-in fan-outs (workorder images)
  lightspeed_access_token  DEBUG ONLY: static token instead of the broker
  lightspeed_origin        DEBUG ONLY: API origin (mock server)

Tables are Albert's `source_lightspeed.ls_*` staging shapes (generated from
connectors/lightspeed-r/tables.json), all keyed by a stable `source_record_id`.
"""
from __future__ import annotations

import json
import traceback
from datetime import datetime, timezone

from fivetran_connector_sdk import Connector, Logging as log, Operations as op

from lightspeed_client import LightspeedClient
from lightspeed_sync import LightspeedSync, spec_schema


def schema(configuration: dict):
    return spec_schema()


def _emit(table: str, record: dict) -> None:
    op.upsert(table=table, data=record)


def _checkpoint(state: dict) -> None:
    op.checkpoint(state=state)


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
    client = LightspeedClient(configuration)
    log.info("Albert Lightspeed R-Series sync starting")
    account = client.discover_account()
    if account:
        state["account"] = {"accountID": str(account.get("accountID", "")), "name": str(account.get("name", ""))[:120]}

    sync = LightspeedSync(configuration, state, _emit, _checkpoint, client=client)
    summary = sync.run()
    log.info(f"Spec sync: {json.dumps(summary)}")
    state["last_run"] = {
        "finished_at": datetime.now(timezone.utc).isoformat(),
        **{key: summary.get(key) for key in ("groups", "fan_outs", "rows", "calls", "unavailable", "errors", "tables")},
    }
    state.pop("last_error", None)
    op.checkpoint(state=state)
    log.info(f"Albert Lightspeed R-Series sync finished: {sync.client.calls} API calls")


connector = Connector(update=update, schema=schema)

if __name__ == "__main__":
    connector.debug()
