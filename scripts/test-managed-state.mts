/** Production RPC regression checks. Every fixture and temporary verifier rolls back. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { Client } from "pg";
import { ulid } from "ulid";

if (!process.argv.includes("--rollback-production")) throw new Error("Pass --rollback-production to run the transaction-only checks.");
const url = new URL(process.env.CONTROL_PLANE_MIGRATION_URL ?? process.env.CONTROL_PLANE_ADMIN_DATABASE_URL ?? "");
if (decodeURIComponent(url.username).split(".")[0] !== "albert_control_deployer") {
  const suffix = decodeURIComponent(url.username).split(".").slice(1).join(".");
  if (!process.env.ALBERT_CONTROL_DEPLOYER_DB_PASSWORD) throw new Error("A deployer connection is required.");
  url.username = `albert_control_deployer${suffix ? `.${suffix}` : ""}`;
  url.password = process.env.ALBERT_CONTROL_DEPLOYER_DB_PASSWORD;
}
const client = new Client({ connectionString: url.toString() });
const tenantId = "01KZN20VTX2EWW1TQ2AA3MCPW6";
const checks: string[] = [];
async function rejected(name: string, sql: string, args: unknown[], codes: string[]) {
  await client.query("SAVEPOINT expected_failure");
  let code: string | undefined;
  try { await client.query(sql, args); } catch (error) { code = (error as { code?: string }).code; }
  await client.query("ROLLBACK TO SAVEPOINT expected_failure");
  assert.ok(code && codes.includes(code), `${name}: expected a guarded rejection, got ${code ?? "success"}`);
  checks.push(name);
}
await client.connect();
try {
  assert.equal((await client.query("SELECT session_user")).rows[0].session_user, "albert_control_deployer");
  await client.query("BEGIN");
  await client.query("SET LOCAL ROLE albert_control_migration_owner");
  const owner = (await client.query("SELECT created_by FROM control_plane.conversations WHERE tenant_id=$1 AND conversation_id=$2", [tenantId, "01M28X81ESKPQG2ZGQ1ABZTZM6"])).rows[0]?.created_by;
  assert.ok(owner, "The existing owner fixture must exist.");
  const claims = (sub: string) => JSON.stringify({ sub, role: "authenticated", app_metadata: { active_tenant_id: tenantId } });
  await client.query("SELECT set_config('request.jwt.claims',$1,true)", [claims(owner)]);
  assert.equal((await client.query("SELECT control_plane.require_current_tenant_id() AS tenant")).rows[0].tenant, tenantId);
  const key = randomBytes(32).toString("base64url");
  await client.query("INSERT INTO control_plane.managed_agent_server_keys(key_id,key_sha256) VALUES($1,$2)", [`rollback-test-${randomUUID()}`, createHash("sha256").update(key).digest("hex")]);
  const turnId = ulid();
  const profile = { runtime: "openai-agents-api", nativeVersion: 2 };
  const begin = await client.query("SELECT * FROM public.begin_albert_turn(NULL,$1,$2,$3::jsonb)", [turnId, "Managed session rollback test", JSON.stringify(profile)]);
  const conversationId = begin.rows[0].conversation_id;
  const rpc = (name: string, placeholders: string) => `SELECT public.${name}(${placeholders}) AS value`;
  await rejected("missing server capability", rpc("albert_claim_managed_agent_session", "$1,$2,$3"), [conversationId, turnId, "invalid"], ["42501"]);
  const claim = (await client.query(rpc("albert_claim_managed_agent_session", "$1,$2,$3"), [conversationId, turnId, key])).rows[0].value;
  assert.equal(claim.revision, 0); assert.deepEqual(claim.state, {}); checks.push("owned session claim");
  await rejected("no completion before provider finishes", rpc("albert_complete_managed_agent_turn", "$1,$2,$3"), [conversationId, turnId, key], ["42501"]);
  const state = JSON.stringify({ version: 2, idleConfirmed: true, references: {}, inspectedTopics: [], clientTurnId: turnId });
  const revision = (await client.query(rpc("albert_save_managed_agent_session", "$1,$2,$3,$4::jsonb,$5"), [conversationId, turnId, 0, state, key])).rows[0].value;
  assert.equal(Number(revision), 1); checks.push("revision increment");
  await rejected("stale state writer", rpc("albert_save_managed_agent_session", "$1,$2,$3,$4::jsonb,$5"), [conversationId, turnId, 0, state, key], ["40001"]);
  await rejected("no completion without persisted answer", rpc("albert_complete_managed_agent_turn", "$1,$2,$3"), [conversationId, turnId, key], ["22023"]);
  const resultId = ulid();
  const table = { type: "table", resultId, caption: "Fixture", columns: [{ key: "total", label: "Total", type: "currency", currency: "AUD" }], rows: [{ total: 42 }] };
  const answer = { type: "answer", status: "complete", state: "Verified", text: "Rollback fixture answer.", claims: [], presentedResultIds: [resultId] };
  for (const [index, event] of [table, answer].entries()) await client.query(rpc("albert_answer_event_append", "$1,$2,$3::jsonb"), [conversationId, turnId, JSON.stringify({ ...event, id: ulid(), sequence: index + 1, occurredAt: new Date().toISOString() })]);
  await client.query(rpc("albert_complete_managed_agent_turn", "$1,$2,$3"), [conversationId, turnId, key]);
  await client.query(rpc("albert_complete_managed_agent_turn", "$1,$2,$3"), [conversationId, turnId, key]);
  const final = (await client.query("SELECT status,answer_state,result_digest FROM control_plane.conversation_turns WHERE tenant_id=$1 AND turn_id=$2", [tenantId, turnId])).rows[0];
  assert.deepEqual(final, { status: "completed", answer_state: "verified", result_digest: "albert_managed_answered" }); checks.push("idempotent successful completion");
  for (const name of ["albert_conversation_history", "albert_model_context"]) {
    const data = await client.query(rpc(name, "$1,$2"), [conversationId, name === "albert_conversation_history" ? 0 : 12]);
    assert.ok(JSON.stringify(data.rows).includes(answer.text), `${name} must retain completed managed answers`); checks.push(`${name} visibility`);
  }
  const loaded = (await client.query(rpc("albert_managed_agent_results", "$1,$2,$3"), [conversationId, [resultId], key])).rows[0].value;
  assert.equal(loaded[0].table.rows[0].total, 42); checks.push("original result restoration");
  await rejected("completed turns cannot overwrite session state", rpc("albert_save_managed_agent_session", "$1,$2,$3,$4::jsonb,$5"), [conversationId, turnId, 1, state, key], ["40001"]);
  await client.query("SELECT set_config('request.jwt.claims',$1,true)", [claims(randomUUID())]);
  await rejected("foreign actor cannot read state", rpc("albert_claim_managed_agent_session", "$1,$2,$3"), [conversationId, turnId, key], ["42501", "P0002"]);
  await rejected("foreign actor cannot read evidence", rpc("albert_managed_agent_results", "$1,$2,$3"), [conversationId, [resultId], key], ["42501", "P0002"]);
  await client.query("SELECT set_config('request.jwt.claims',$1,true)", [claims(owner)]);
  await client.query("UPDATE control_plane.conversation_turns SET hidden_at=clock_timestamp() WHERE tenant_id=$1 AND turn_id=$2", [tenantId, turnId]);
  const visible = (await client.query(rpc("albert_managed_turn_visible", "$1,$2,$3"), [conversationId, turnId, key])).rows[0].value;
  assert.equal(visible, false);
  assert.deepEqual((await client.query(rpc("albert_managed_agent_results", "$1,$2,$3"), [conversationId, [resultId], key])).rows[0].value, []);
  checks.push("rewound turns exclude session history and results");
  console.log(JSON.stringify({ passed: checks.length, checks, transaction: "rolled back" }, null, 2));
} finally { await client.query("ROLLBACK").catch(() => undefined); await client.end(); }
