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
  const cases = [
    { name: "merch-aligned", sql: "SELECT c.name AS category, SUM(a.net_sales_ex_gst) AS net_sales, SUM(a.gross_margin) AS gross_margin FROM mart.merchandising_aligned a JOIN core.product_category c ON c.id = a.product_category_id WHERE a.business_date >= '2026-05-09' AND a.business_date < '2026-08-07' GROUP BY c.name ORDER BY net_sales DESC",
      claims: [{ metricId: "commerce.net_sales_ex_gst", column: "net_sales" }, { metricId: "commerce.gross_margin", column: "gross_margin" }], time: { from: "2026-05-09", to: "2026-08-07" } },
    { name: "join-noclaim", sql: "SELECT c.name, SUM(f.signed_net_amount_ex_tax) AS net_sales FROM mart.commerce_sales_event f JOIN core.product_category c ON c.id = f.product_category_id GROUP BY c.name", claims: [], time: undefined },
    { name: "dim-grant", sql: "SELECT count(*) AS n FROM core.product_category", claims: [], time: undefined },
    { name: "dim-worker", sql: "SELECT count(*) AS n FROM core.worker", claims: [], time: undefined },
    { name: "e1-shape", sql: "SELECT SUM(f.signed_net_amount_ex_tax) AS net_sales FROM mart.commerce_sales_event f WHERE f.business_date >= '2026-07-08' AND f.business_date < '2026-08-07'",
      claims: [{ metricId: "commerce.net_sales_ex_gst", column: "net_sales" }], time: { from: "2026-07-08", to: "2026-08-07" } },
    { name: "m2-shape", sql: "SELECT w.display_name, SUM(a.net_sales_ex_gst) AS net_sales FROM mart.workforce_sales_aligned a JOIN core.worker w ON w.id = a.worker_id WHERE a.business_date >= '2026-07-08' AND a.business_date < '2026-08-07' GROUP BY w.display_name ORDER BY net_sales DESC",
      claims: [{ metricId: "commerce.net_sales_ex_gst", column: "net_sales" }], time: { from: "2026-07-08", to: "2026-08-07" } },
    { name: "m1-shape", sql: "SELECT c.name, SUM(f.signed_net_amount_ex_tax) AS net_sales, SUM(f.signed_net_amount_ex_tax) - SUM(f.signed_total_cost) AS gross_margin FROM mart.commerce_sales_event f JOIN core.product_category c ON c.id = f.product_category_id WHERE f.business_date >= '2026-05-09' AND f.business_date < '2026-08-07' GROUP BY c.name ORDER BY net_sales DESC",
      claims: [{ metricId: "commerce.net_sales_ex_gst", column: "net_sales" }], time: { from: "2026-05-09", to: "2026-08-07" } },
  ];
  for (const c of cases) {
    try {
      const t0 = Date.now(); const r: any = await client.execute("run_sql", { sql: c.sql, purpose: "probe " + c.name, claims: c.claims, time: c.time, filters: [], limit: 50 }, ctx);
      console.log(JSON.stringify({ name: c.name, ms: Date.now()-t0, state: r.state, rows: (r.data?.rows ?? []).length, checks: (r.validation?.checks ?? []).filter((x: any) => x.status !== "passed").map((x: any) => x.checkId + "=" + x.status) }));
    } catch (error: any) {
      console.log(JSON.stringify({ name: c.name, ERROR: String(error?.message ?? error).slice(0, 400) }));
    }
  }
} finally {

  await admin.query("delete from control_plane.conversation_turn_events where tenant_id=$1 and conversation_id=$2", [TENANT, conversationId]);
  await admin.query("delete from control_plane.conversation_turns where tenant_id=$1 and conversation_id=$2", [TENANT, conversationId]);
  await admin.query("delete from control_plane.conversations where tenant_id=$1 and conversation_id=$2", [TENANT, conversationId]);
  await admin.end();
}
