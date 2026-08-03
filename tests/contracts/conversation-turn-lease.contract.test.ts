import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = read("infra/migrations/control-plane/0026_m8_durable_conversation_turn_leases.sql");
const bootstrap = read("infra/bootstrap/control_plane_role.sql");
const route = read("app/api/conversation/route.ts");

test("conversation turns have a durable deadline beyond the bounded HTTP timeout", () => {
  assert.match(route, /parsed<30_000\|\|parsed>300_000/u);
  assert.match(migration, /now\(\) \+ interval '6 minutes'/u);
  assert.match(migration, /status <> 'running' OR lease_expires_at IS NOT NULL/u);
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
