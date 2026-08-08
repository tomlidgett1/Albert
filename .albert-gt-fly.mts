/**
 * Ground-truth via the production dogfood semantic-query HTTP service
 * (avoids opening local analytical pools when slots are scarce).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ulid } from "ulid";

const env: Record<string, string> = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const raw = line.trim();
  if (!raw || raw.startsWith("#") || !raw.includes("=")) continue;
  const i = raw.indexOf("=");
  env[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
}
for (const [k, v] of Object.entries(env)) process.env[k] = v;

const TENANT = "01KZ4ZMVF5QNQ4TX35VF3WDJBM";
const CASES = JSON.parse(readFileSync(process.argv[2] ?? ".albert-agent-qa-groundtruth.json", "utf8"));

const pg = await import("pg");
const Client = (pg as any).default?.Client ?? (pg as any).Client;
const { SemanticServiceClient } = await import("./services/conversation/src/semantic-client.js");

const admin = new Client({ connectionString: env.CONTROL_PLANE_ADMIN_DATABASE_URL });
await admin.connect();
await admin.query("set role albert_control_migration_owner");
const owner = await admin.query(
  `select user_id from control_plane.memberships where tenant_id=$1 and role='owner' and status='active' order by created_at limit 1`,
  [TENANT],
);
const ownerId = owner.rows[0].user_id;
const conversationId = ulid();
const turnId = ulid();
await admin.query(
  `insert into control_plane.conversations(tenant_id,conversation_id,title,status,created_by,created_at,updated_at)
   values($1,$2,'Albert GT via Fly','active',$3,now(),now())`,
  [TENANT, conversationId, ownerId],
);
await admin.query(
  `insert into control_plane.conversation_turns(
     tenant_id,turn_id,conversation_id,turn_number,user_message,runtime_profile,
     status,created_by,created_at,lease_expires_at)
   values($1,$2,$3,1,'gt', $4::jsonb,'running',$5,now(),now()+interval '45 minutes')`,
  [TENANT, turnId, conversationId, JSON.stringify({ runtime: "albert-gt-fly" }), ownerId],
);

const client = new SemanticServiceClient(env.SEMANTIC_QUERY_SERVICE_URL!, env.ALBERT_SEMANTIC_SIGNING_SECRET!);
const ctx = { tenantId: TENANT, conversationId, turnId, role: "owner" as const };
const results = [];
for (const c of CASES) {
  const started = Date.now();
  try {
    const r: any = await client.execute(c.tool, c.input, ctx);
    const rows = r.data?.rows ?? r.fieldValues ?? [];
    results.push({
      id: c.id,
      ask: c.ask,
      state: r.state ?? (r.capabilities ? `answerable=${r.capabilities.answerable}` : "ok"),
      validation: r.validation?.status ?? "-",
      rowCount: rows.length,
      rows: rows.slice(0, 25),
      capabilities: r.capabilities ?? null,
      warnings: (r.validation?.warnings ?? []).slice(0, 6),
      ms: Date.now() - started,
    });
    console.error(JSON.stringify({ id: c.id, state: results.at(-1).state, rows: rows.length, ms: Date.now() - started }));
  } catch (error: any) {
    results.push({
      id: c.id,
      ask: c.ask,
      state: "ERROR",
      error: String(error?.message ?? error).slice(0, 300),
      ms: Date.now() - started,
    });
    console.error(JSON.stringify({ id: c.id, error: results.at(-1).error, ms: Date.now() - started }));
  }
  await new Promise((r) => setTimeout(r, 800));
}

await admin.query(`delete from control_plane.conversation_turns where conversation_id=$1`, [conversationId]);
await admin.query(`delete from control_plane.conversations where conversation_id=$1`, [conversationId]);
await admin.end();
writeFileSync(".albert-agent-qa-out/groundtruth-fly.json", JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.map((r) => ({
  id: r.id, state: r.state, rows: r.rowCount, error: r.error,
  sample: r.rows?.[0], caps: r.capabilities ? { answerable: r.capabilities.answerable, missing: r.capabilities.missing } : null,
})), null, 2));
