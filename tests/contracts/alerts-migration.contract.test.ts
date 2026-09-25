import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ALBERT_RATE_LIMIT_POLICIES } from "../../services/control-plane/src/web-repository.ts";
import { ALERT_TRIGGER_CATALOGUE, ALERT_TRIGGER_KEYS } from "../../services/alerts/src/contracts.ts";

const sql = readFileSync(new URL("../../infra/migrations/control-plane/0185_m8_alert_triggers.sql", import.meta.url), "utf8");

test("0185 creates the alert tables with lookup-backed lifecycles and a dedupe key per condition", () => {
  assert.match(sql, /^BEGIN;/u);
  assert.match(sql, /^COMMIT;\s*$/mu);
  for (const table of ["alert_triggers", "alert_trigger_state", "alert_evaluations", "alert_events", "alert_settings"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS control_plane\\.${table} \\(`, "u"), table);
    assert.match(sql, new RegExp(`ALTER TABLE control_plane\\.${table} ENABLE ROW LEVEL SECURITY;`, "u"), `${table} RLS`);
  }
  // Lifecycle vocabularies are described lookups, never literal checks.
  for (const lookup of ["alert_event_status_lookup", "alert_evaluation_status_lookup"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS control_plane\\.${lookup} \\(\\s*status text PRIMARY KEY,\\s*description text NOT NULL`, "u"), lookup);
    assert.match(sql, new RegExp(`REVOKE ALL ON TABLE control_plane\\.${lookup} FROM authenticated`, "u"), `${lookup} revoke`);
  }
  assert.match(sql, /status text NOT NULL REFERENCES control_plane\.alert_event_status_lookup\(status\)/u);
  assert.match(sql, /status text NOT NULL REFERENCES control_plane\.alert_evaluation_status_lookup\(status\)/u);
  assert.doesNotMatch(sql, /status text[^\n]*CHECK \(status IN/u, "no literal status vocabulary");
  for (const status of ["queued", "sent", "failed", "muted", "running", "finished"]) {
    assert.match(sql, new RegExp(`\\('${status}', '`, "u"), status);
  }
  // A condition fires once: the dedupe key is unique per trigger.
  assert.match(sql, /UNIQUE \(tenant_id, trigger_key, dedupe_key\)/u);
  assert.match(sql, /ON CONFLICT \(tenant_id, trigger_key, dedupe_key\) DO NOTHING/u);
  assert.match(sql, /recipients text\[\] NOT NULL DEFAULT '\{\}'::text\[\] CHECK \(cardinality\(recipients\) <= 20\)/u);
  assert.doesNotMatch(sql, /CREATE POLICY/u, "no direct table policies; every access is an RPC");
});

test("0185 exposes the RPC surface the web tier and the bridge evaluator call, owner/manager-gated where it writes", () => {
  for (const name of [
    "albert_alerts_workspace()",
    "albert_alerts_trigger_save(",
    "albert_alerts_check_request(p_evaluation_id text)",
    "albert_alerts_work()",
    "albert_alerts_evaluation_claim(",
    "albert_alerts_record_result(",
    "albert_alerts_event_finish(",
    "albert_alerts_evaluation_finish(",
  ]) {
    assert.match(sql, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name.replace(/[()]/gu, "\\$&")}`, "u"), name);
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name.split("(")[0]}\\(`, "u"), `${name} grant`);
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name.split("(")[0]}\\(`, "u"), `${name} revoke`);
  }
  // Switching a trigger and requesting a check are owner/manager actions;
  // every recipient must be an enabled enrolment.
  assert.equal((sql.match(/insufficient role for (?:managing|checking) alerts/gu) ?? []).length, 2);
  assert.match(sql, /control_plane\.tenant_imessage_enrollments AS enrollment[\s\S]*AND enrollment\.enabled/u);
  // One open evaluation at a time, claimed under a per-tenant lock.
  assert.match(sql, /a check is already in progress/u);
  assert.match(sql, /pg_advisory_xact_lock\(hashtext\('alerts:' \|\| v_tenant_id\)\)/u);
  // Abandoned evaluations are swept on every read path.
  assert.equal((sql.match(/PERFORM control_plane\.alert_evaluations_sweep\(v_tenant_id\)/gu) ?? []).length, 3);
  assert.match(sql, /SECURITY DEFINER\s+SET search_path = pg_catalog/u);
});

test("0185 registers the rate-limit actions the web route consumes", () => {
  for (const action of ["alerts.mutation", "alerts.check"] as const) {
    assert.match(sql, new RegExp(`\\('${action.replace(".", "\\.")}', \\d+, \\d+, false\\)`, "u"));
    assert.ok(action in ALBERT_RATE_LIMIT_POLICIES, `${action} is in the web policy map`);
  }
  assert.deepEqual({ ...ALBERT_RATE_LIMIT_POLICIES["alerts.mutation"] }, { limit: 60, windowSeconds: 60 });
  assert.deepEqual({ ...ALBERT_RATE_LIMIT_POLICIES["alerts.check"] }, { limit: 12, windowSeconds: 3_600 });
});

test("the trigger catalogue is ten keyed, bounded definitions", () => {
  assert.equal(ALERT_TRIGGER_KEYS.length, 10);
  assert.equal(ALERT_TRIGGER_CATALOGUE.length, 10);
  const keys = new Set(ALERT_TRIGGER_CATALOGUE.map((entry) => entry.key));
  assert.equal(keys.size, 10);
  for (const entry of ALERT_TRIGGER_CATALOGUE) {
    assert.match(entry.key, /^[a-z][a-z0-9_]{2,60}$/u);
    assert.ok(entry.title.length >= 4 && entry.title.length <= 40, entry.key);
    // The card shows a few words under the title; the rule is the long form.
    assert.ok(entry.summary.length >= 10 && entry.summary.length <= 48, entry.key);
    assert.ok(entry.summary.split(/\s+/u).length <= 7, entry.key);
    assert.ok(entry.rule.length >= 30 && entry.rule.length <= 240, entry.key);
    assert.ok(entry.needs.length >= 1, entry.key);
  }
});
