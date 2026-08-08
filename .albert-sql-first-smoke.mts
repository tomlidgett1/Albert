/** Smoke the deployed run_sql path against the live dogfood semantic service. */
import { readFileSync } from "node:fs";
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
const pg = await import("pg");
const Client = (pg as unknown as { Client: new (o: object) => any }).Client
  ?? (pg as any).default.Client;
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
   values($1,$2,'sql-first smoke','active',$3,now(),now())`,
  [TENANT, conversationId, ownerId],
);
await admin.query(
  `insert into control_plane.conversation_turns(
     tenant_id,turn_id,conversation_id,turn_number,user_message,runtime_profile,
     status,created_by,created_at,lease_expires_at)
   values($1,$2,$3,1,'smoke', $4::jsonb,'running',$5,now(),now()+interval '20 minutes')`,
  [TENANT, turnId, conversationId, JSON.stringify({ runtime: "sql-first-smoke" }), ownerId],
);

const client = new SemanticServiceClient(env.SEMANTIC_QUERY_SERVICE_URL!, env.ALBERT_SEMANTIC_SIGNING_SECRET!);
const ctx = { tenantId: TENANT, conversationId, turnId, role: "owner" as const };

try {
  const exploratory: any = await client.execute("run_sql", {
    sql: "SELECT count(*) AS event_rows FROM mart.commerce_sales_event",
    purpose: "smoke: count canonical sales events",
    claims: [],
    filters: [],
    limit: 10,
  }, ctx);
  console.log(JSON.stringify({
    case: "claimless",
    state: exploratory.state,
    route: exploratory.queryAudit?.route,
    rows: exploratory.data?.rows,
    validation: exploratory.validation?.status,
    warnings: (exploratory.validation?.warnings ?? []).slice(0, 2),
  }));

  const claimed: any = await client.execute("run_sql", {
    sql: "SELECT SUM(f.signed_net_amount_ex_tax) AS net_sales FROM mart.commerce_sales_event f WHERE f.business_date >= '2026-07-01' AND f.business_date < '2026-08-01'",
    purpose: "smoke: July net sales with a governed claim",
    claims: [{ metricId: "commerce.net_sales_ex_gst", column: "net_sales" }],
    time: { from: "2026-07-01", to: "2026-08-01" },
    filters: [],
    limit: 10,
  }, ctx);
  console.log(JSON.stringify({
    case: "claimed",
    state: claimed.state,
    route: claimed.queryAudit?.route,
    rows: claimed.data?.rows,
    checks: (claimed.validation?.checks ?? []).filter((c: any) =>
      c.status !== "passed").map((c: any) => ({ id: c.checkId, status: c.status })),
  }));

  const blocked: any = await client.execute("run_sql", {
    sql: "SELECT SUM(i.stock_value) AS total FROM mart.inventory_health_day i",
    purpose: "smoke: snapshot summed across its axis must be refused",
    claims: [],
    filters: [],
    limit: 10,
  }, ctx).catch((error: Error) => ({ rejected: error.message.slice(0, 160) }));
  console.log(JSON.stringify({ case: "linter-block", outcome: blocked.rejected ?? blocked.state }));
} finally {
  await admin.query("delete from control_plane.conversation_turn_events where tenant_id=$1 and conversation_id=$2", [TENANT, conversationId]);
  await admin.query("delete from control_plane.conversation_turns where tenant_id=$1 and conversation_id=$2", [TENANT, conversationId]);
  await admin.query("delete from control_plane.conversations where tenant_id=$1 and conversation_id=$2", [TENANT, conversationId]);
  await admin.end();
}
