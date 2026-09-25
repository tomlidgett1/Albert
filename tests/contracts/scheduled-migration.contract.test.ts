import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ALBERT_RATE_LIMIT_POLICIES } from "../../services/control-plane/src/web-repository.ts";

const sql = readFileSync(new URL("../../infra/migrations/control-plane/0183_m8_scheduled_tasks.sql", import.meta.url), "utf8");

test("0183 creates the schedule tables with the bounded shapes the shared contracts expect", () => {
  assert.match(sql, /^BEGIN;/mu);
  assert.match(sql, /^COMMIT;\s*$/mu);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS control_plane\.scheduled_tasks \(/u);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS control_plane\.scheduled_task_runs \(/u);
  assert.match(sql, /days <@ ARRAY\['mon','tue','wed','thu','fri','sat','sun'\]::text\[\]/u);
  assert.match(sql, /phone_e164 text NOT NULL CHECK \(phone_e164 ~ '\^\\\+\[1-9\]\[0-9\]\{5,14\}\$'\)/u);
  assert.match(sql, /status text NOT NULL CHECK \(status IN \('queued', 'running', 'sent', 'failed', 'missed'\)\)/u);
  assert.match(sql, /trigger text NOT NULL CHECK \(trigger IN \('schedule', 'manual'\)\)/u);
  assert.match(sql, /ON DELETE CASCADE/u);
  assert.match(sql, /ALTER TABLE control_plane\.scheduled_tasks ENABLE ROW LEVEL SECURITY;/u);
  assert.match(sql, /ALTER TABLE control_plane\.scheduled_task_runs ENABLE ROW LEVEL SECURITY;/u);
  assert.doesNotMatch(sql, /CREATE POLICY/u, "no direct table policies; every access is an RPC");
});

test("0183 exposes the RPC surface the web tier and the bridge scheduler call, owner/manager-gated where it writes", () => {
  for (const name of [
    "albert_scheduled_workspace()",
    "albert_scheduled_task_save(",
    "albert_scheduled_task_delete(p_task_id text)",
    "albert_scheduled_run_request(",
    "albert_scheduled_work()",
    "albert_scheduled_run_claim(",
    "albert_scheduled_run_finish(",
  ]) {
    assert.match(sql, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name.replace(/[()]/gu, "\\$&")}`, "u"), name);
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name.split("(")[0]}\\(`, "u"), `${name} grant`);
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name.split("(")[0]}\\(`, "u"), `${name} revoke`);
  }
  // Writes require owner/manager; the destination must be an enabled enrolment.
  // save, delete and run-request; claim/finish run under the bridge's owner session.
  assert.equal((sql.match(/insufficient role for (?:managing|running) schedules/gu) ?? []).length, 3);
  assert.match(sql, /control_plane\.tenant_imessage_enrollments AS enrollment[\s\S]*AND enrollment\.enabled/u);
  assert.match(sql, /already has 20 schedules/u);
  // Claims are optimistic on the slot the caller read, and advance next_run_at immediately.
  assert.match(sql, /v_task\.next_run_at <> p_expected_next_run_at/u);
  assert.match(sql, /next_run_at = p_next_run_at,\s*last_run_at = clock_timestamp\(\)/u);
  // Abandoned runs are swept on every read path.
  assert.equal((sql.match(/PERFORM control_plane\.scheduled_runs_sweep\(v_tenant_id\)/gu) ?? []).length, 3);
  assert.match(sql, /SECURITY DEFINER\s+SET search_path = pg_catalog/u);
});

test("0183 registers the rate-limit actions the web route consumes", () => {
  for (const action of ["scheduled.create", "scheduled.mutation", "scheduled.run"] as const) {
    assert.match(sql, new RegExp(`\\('${action.replace(".", "\\.")}', \\d+, \\d+, false\\)`, "u"));
    assert.ok(action in ALBERT_RATE_LIMIT_POLICIES, `${action} is in the web policy map`);
  }
  assert.deepEqual({ ...ALBERT_RATE_LIMIT_POLICIES["scheduled.create"] }, { limit: 20, windowSeconds: 3_600 });
  assert.deepEqual({ ...ALBERT_RATE_LIMIT_POLICIES["scheduled.mutation"] }, { limit: 60, windowSeconds: 60 });
  assert.deepEqual({ ...ALBERT_RATE_LIMIT_POLICIES["scheduled.run"] }, { limit: 12, windowSeconds: 3_600 });
});
