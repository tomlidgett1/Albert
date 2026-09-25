import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = read("infra/migrations/control-plane/0026_m8_durable_conversation_turn_leases.sql");
const bootstrap = read("infra/bootstrap/control_plane_role.sql");
const route = read("app/api/v3-conversation/route.ts");
const config = read("packages/config/src/env.ts");
const renewal = read("infra/migrations/control-plane/0084_m8_renewable_conversation_turn_leases.sql");

test("a running turn holds a durable lease it must keep renewing", () => {
  // The lease recovers turns whose runner died. An analytical turn has no fixed
  // duration, so the runner proves it is alive by renewing rather than by
  // finishing inside a wall clock; a dead runner stops renewing and is reaped.
  assert.match(migration, /now\(\) \+ interval '6 minutes'/u);
  assert.match(migration, /status <> 'running' OR lease_expires_at IS NOT NULL/u);
  assert.match(renewal, /renew_albert_turn_lease/u);
  assert.match(renewal, /turn\.status = 'running'/u);
  assert.match(renewal, /turn\.lease_expires_at > clock_timestamp\(\)/u);
  assert.match(route, /renewConversationTurnLease/u);
  assert.match(route, /clearInterval\(leaseRenewal\)/u);
  // Renewal must land well inside the lease, or one slow call lapses it.
  const interval = /LEASE_RENEWAL_INTERVAL_MS\s*=\s*(\d[\d_]*)/u.exec(route);
  assert.ok(interval, "the route must define its lease renewal interval");
  assert.ok(Number(interval[1]!.replaceAll("_", "")) < 6 * 60 * 1_000);
});

test("a configured turn deadline stays optional and never shortens the lease", () => {
  assert.match(config, /ALBERT_TURN_TIMEOUT_MS/u);
  assert.match(config, /timeout < 30_000 \|\| timeout > 300_000/u);
});

test("begin reaps an expired runner under the conversation lock", () => {
  assert.match(migration, /pg_advisory_xact_lock[\s\S]*reap_expired_conversation_turns[\s\S]*begin_albert_turn_core_v1/u);
  assert.match(migration, /result_digest = 'turn_lease_expired'/u);
  assert.match(migration, /conversation\.turn_lease_expired/u);
});

test("a fixed administrator-owned cron job recovers turns after process death", () => {
  assert.match(bootstrap, /albert-conversation-turn-reaper[\s\S]*\* \* \* \* \*[\s\S]*reap_expired_conversation_turns/u);
  assert.match(migration, /albert_install_conversation_reaper_cron_job/u);
  assert.match(migration, /REVOKE ALL ON FUNCTION control_plane\.reap_expired_conversation_turns/u);
});

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}
