import { readFileSync } from "node:fs";
const env: Record<string, string> = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const raw = line.trim();
  if (!raw || raw.startsWith("#") || !raw.includes("=")) continue;
  const i = raw.indexOf("=");
  env[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
}
for (const [k, v] of Object.entries(env)) process.env[k] = v;
const { SemanticServiceClient } = await import("./services/conversation/src/semantic-client.js");
const pg = await import("pg");
const Client = (pg as any).default?.Client ?? (pg as any).Client;
const c = new Client({ connectionString: env.CONTROL_PLANE_ADMIN_DATABASE_URL });
await c.connect();
await c.query("SET ROLE albert_control_migration_owner");
const conv = (await c.query("SELECT conversation_id, turn_id FROM control_plane.conversation_turns WHERE tenant_id='01KZ4ZMVF5QNQ4TX35VF3WDJBM' ORDER BY created_at DESC LIMIT 1")).rows[0];
await c.end();
const client = new SemanticServiceClient(env.SEMANTIC_QUERY_SERVICE_URL!, env.ALBERT_SEMANTIC_SIGNING_SECRET!);
const ctx = { tenantId: "01KZ4ZMVF5QNQ4TX35VF3WDJBM", conversationId: conv.conversation_id, turnId: conv.turn_id, role: "owner" as const };
const r: any = await client.execute("get_capabilities", { topic: "sales_performance" }, ctx);
console.log(JSON.stringify({ answerable: r.capabilities?.answerable, missing: r.capabilities?.missing, available: (r.capabilities?.available ?? []).length }));
