// Live governed-query battery against the real Lightspeed bike-shop tenant.
//
// The analytical capability issuer only mints a token while a conversation turn
// holds an active lease (control_plane.issue_semantic_analytical_capability),
// so this mirrors what the app and the protected dogfood harness both do:
// open a real turn, run the governed path, then remove the probe conversation.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const env: Record<string, string> = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const raw = line.trim();
  if (!raw || raw.startsWith("#") || !raw.includes("=")) continue;
  const i = raw.indexOf("=");
  env[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
}
for (const [k, v] of Object.entries(env)) process.env[k] = v;
process.env.CONTROL_PLANE_DATABASE_URL = env.ALBERT_SEMANTIC_CONTROL_DATABASE_URL;
process.env.ANALYTICAL_DATABASE_URL = env.ALBERT_SEMANTIC_READ_DATABASE_URL;

const TENANT = "01KZ4ZMVF5QNQ4TX35VF3WDJBM";

const pg = await import("pg");
const Pool = (pg as any).default?.Pool ?? (pg as any).Pool;
const Client = (pg as any).default?.Client ?? (pg as any).Client;
const { createPostgresSemanticComposition } = await import("./services/semantic-query/src/composition.js");
const { OpenAIEmbeddingProvider } = await import("./services/semantic-query/src/embeddings.js");
const { ulid } = await import("ulid");

const conversationId = ulid();
const turnId = ulid();

// --- open a real leased turn -------------------------------------------------
const admin = new Client({ connectionString: env.CONTROL_PLANE_ADMIN_DATABASE_URL });
await admin.connect();
await admin.query("set role albert_control_migration_owner");
const owner = await admin.query(
  `select membership.user_id from control_plane.memberships membership
    where membership.tenant_id=$1 and membership.role='owner' and membership.status='active'
    order by membership.created_at limit 1`, [TENANT]);
const ownerId = owner.rows[0]?.user_id;
if (!ownerId) throw new Error("no active owner for tenant");

await admin.query(
  `insert into control_plane.conversations(tenant_id,conversation_id,title,status,created_by,created_at,updated_at)
   values($1,$2,'Albert QA probe','active',$3,now(),now())`, [TENANT, conversationId, ownerId]);
await admin.query(
  `insert into control_plane.conversation_turns(
     tenant_id,turn_id,conversation_id,turn_number,user_message,runtime_profile,
     status,created_by,created_at,lease_expires_at)
   values($1,$2,$3,1,'Albert QA probe',
     jsonb_build_object('runtime','albert-qa-probe'),'running',$4,now(),now()+interval '45 minutes')`,
  [TENANT, turnId, conversationId, ownerId]);

const composition: any = await createPostgresSemanticComposition({
  registryPath: resolve("packages/semantic-registry/registry/registry.yaml"),
  controlPlanePool: new Pool({ connectionString: process.env.CONTROL_PLANE_DATABASE_URL!, max: 3, application_name: "albert-qa-control" }),
  analyticalReadPool: new Pool({ connectionString: process.env.ANALYTICAL_DATABASE_URL!, max: 4, application_name: "albert-qa-read" }),
  semanticMetadataPool: new Pool({ connectionString: env.ALBERT_SEMANTIC_METADATA_DATABASE_URL!, max: 3, application_name: "albert-qa-meta" }),
  embeddingProvider: new OpenAIEmbeddingProvider({ apiKey: env.OPENAI_API_KEY!, baseURL: env.OPENAI_BASE_URL!, timeoutMs: 20_000 }),
  cacheTtlSeconds: 1,
  statementTimeoutMs: 25_000,
  promotionRelayWorkerId: "albert-qa-probe",
  promotionRelayPollIntervalMs: 60_000,
  promotionRelayTenantBatchSize: 1,
  promotionRelayCandidateBatchSize: 1,
  promotionRelayLeaseSeconds: 90,
});
const executor = composition.executor ?? composition;
const context = { tenantId: TENANT, conversationId, turnId, role: "owner" as const };

type Case = Readonly<{ id: string; tier: "easy" | "medium" | "hard"; ask: string; tool: string; input: unknown }>;
const CASES: readonly Case[] = JSON.parse(readFileSync(process.argv[2] ?? ".albert-qa-cases.json", "utf8"));

const results: any[] = [];
for (const c of CASES) {
  const started = Date.now();
  try {
    const r: any = await executor.execute(c.tool, c.input, context);
    const rows = r.data?.rows ?? r.fieldValues ?? [];
    results.push({
      id: c.id, tier: c.tier, ask: c.ask,
      state: r.state ?? (r.capabilities ? `answerable=${r.capabilities.answerable}` : r.dataHealth ? `health=${r.dataHealth.status}` : "ok"),
      validation: r.validation?.status ?? "-",
      rowCount: rows.length,
      sample: rows[0] ? JSON.stringify(rows[0]).slice(0, 190) : "",
      ...(process.env.ALBERT_QA_FULL ? { rows } : {}),
      warnings: (r.validation?.warnings ?? []).slice(0, 6),
      checks: (r.validation?.checks ?? []).filter((c: any) => c.status && c.status !== "passed").slice(0, 6),
      ms: Date.now() - started,
    });
  } catch (error: any) {
    results.push({
      id: c.id, tier: c.tier, ask: c.ask, state: "ERROR",
      validation: "-", rowCount: 0, sample: "",
      error: `${error?.code ?? error?.name ?? "error"}: ${String(error?.message ?? error).slice(0, 220)}`,
      ms: Date.now() - started,
    });
  }
}

// --- clean up the probe conversation ----------------------------------------
await admin.query("delete from control_plane.conversation_turn_events where tenant_id=$1 and turn_id=$2", [TENANT, turnId]);
await admin.query("update control_plane.conversation_turns set status='failed',completed_at=now(),result_digest='albert_qa_probe' where tenant_id=$1 and turn_id=$2", [TENANT, turnId]);
await admin.query("delete from control_plane.conversation_turns where tenant_id=$1 and turn_id=$2", [TENANT, turnId]);
await admin.query("delete from control_plane.conversations where tenant_id=$1 and conversation_id=$2", [TENANT, conversationId]);
await admin.end();

console.log(JSON.stringify(results, null, 1));
process.exit(0);
