/**
 * Dashboard Master session runner: executes the full daily deep-dive
 * (plan → three investigation rounds → compose) against a running agent
 * runtime, producing the report document the Dashboard Master tab renders.
 *
 * Requires the private runtime (PORT=8799) or --service-url for prod, and
 * .env.local for leases, Cube signing, and OpenAI.
 *
 * Usage:
 *   npx tsx scripts/albert-eval/run-dashboard-master.mts --run dm-session-1
 *   ... --budget-minutes 60 --service-url https://albert-codex-runtime.fly.dev
 */
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";
import { ulid } from "ulid";
import { signCubeJwt } from "../../packages/albert-v3/src/cube/jwt.js";
import { ALBERT_CODEX_LOCAL_SIGNING_SECRET } from "../../packages/albert-codex/src/contracts.js";
import { OmniRuntimeServiceClient } from "../../packages/albert-omni/src/index.js";
import {
  DASHBOARD_MASTER_EFFORT,
  DASHBOARD_MASTER_MODEL,
  DASHBOARD_MASTER_PERIOD_LABEL,
  DASHBOARD_MASTER_TICK_BUDGET_MS,
  dashboardMasterReportSchema,
  type DashboardSessionState,
} from "../../services/dashboard-master/src/contracts.js";
import {
  advanceDashboardSession,
  newDashboardSessionState,
  type DashboardSessionDeps,
  type DashboardTurnGrant,
} from "../../services/dashboard-master/src/session.js";
import {
  composeDashboardReport,
  createDashboardDirector,
} from "../../services/dashboard-master/src/compose.js";
import {
  ACTIVE_CONNECTORS,
  ACTOR_ID,
  ROLE,
  TENANT_ID,
  loadEnv,
  loadEvalBusinessContext,
  runDir,
} from "./lib.js";

type Args = { run: string; serviceUrl: string; budgetMinutes: number; persist: boolean; resume: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = {
    run: "dashboard-master-adhoc",
    serviceUrl: process.env.REPRO_SERVICE_URL ?? "http://127.0.0.1:8799",
    budgetMinutes: 60,
    persist: false,
    resume: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const next = () => argv[++i]!;
    if (a === "--run") args.run = next();
    else if (a === "--service-url") args.serviceUrl = next();
    else if (a === "--budget-minutes") args.budgetMinutes = Number(next());
    else if (a === "--persist") args.persist = true;
    else if (a === "--resume") args.resume = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const env = loadEnv();
if (!env.CUBEJS_API_SECRET) throw new Error("CUBEJS_API_SECRET missing");
const apiKey = process.env.OPENAI_API_KEY?.trim() || env.OPENAI_API_KEY?.trim();
if (!apiKey) throw new Error("OPENAI_API_KEY missing");
const baseUrl = process.env.OPENAI_BASE_URL?.trim() || env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";

function leaseDbUrl(): string {
  if (process.env.CODEX_EVAL_DB_URL) return process.env.CODEX_EVAL_DB_URL;
  const raw = env.CONTROL_PLANE_DATABASE_URL;
  if (!raw) throw new Error("CONTROL_PLANE_DATABASE_URL missing");
  const url = new URL(raw);
  const ref = url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/)?.[1];
  if (ref) {
    url.username = `${decodeURIComponent(url.username)}.${ref}`;
    url.hostname = "aws-0-ap-southeast-2.pooler.supabase.com";
  }
  return url.toString();
}

const pool = new pg.Pool({
  connectionString: leaseDbUrl(),
  ssl: { rejectUnauthorized: false },
  max: 4,
  idleTimeoutMillis: 30_000,
});
const initialized = new WeakSet<object>();
async function db(text: string, values?: unknown[]): Promise<pg.QueryResult> {
  const client = await pool.connect();
  try {
    if (!initialized.has(client)) {
      await client.query("set role albert_control_migration_owner");
      await client.query(
        "select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, false)",
        [ACTOR_ID],
      );
      initialized.add(client);
    }
    return await client.query(text, values as never);
  } finally {
    client.release();
  }
}

const BUSINESS_CONTEXT = loadEvalBusinessContext();
const client = new OmniRuntimeServiceClient(
  args.serviceUrl,
  env.ALBERT_CODEX_RUNTIME_SIGNING_SECRET?.trim() || ALBERT_CODEX_LOCAL_SIGNING_SECRET,
);
const dir = runDir(args.run);
mkdirSync(dir, { recursive: true });

const deps: DashboardSessionDeps = {
  mintTurn: async (label: string): Promise<DashboardTurnGrant> => {
    const turnId = ulid();
    const begun = await db(
      "select conversation_id from public.begin_albert_turn($1, $2, $3, $4::jsonb, null, null)",
      [null, turnId, label.slice(0, 2000), JSON.stringify({
        provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "max", fastMode: false,
        runtime: "omni-agent", analyticalRuntime: "cube-omni-v1", kind: "dashboard_master",
      })],
    );
    const conversationId = String(begun.rows[0]?.conversation_id ?? "");
    if (!conversationId) throw new Error("begin_albert_turn returned no conversation id");
    await db(
      "update control_plane.conversation_turns set lease_expires_at = clock_timestamp() + interval '45 minutes' where turn_id = $1",
      [turnId],
    );
    await db("select public.albert_assign_conversation_title($1, $2)", [
      conversationId, label.slice(0, 120),
    ]).catch(() => undefined);
    const cubeBearer = signCubeJwt({
      secret: env.CUBEJS_API_SECRET!,
      expiresInSeconds: 2_700,
      securityContext: {
        tenant_id: TENANT_ID, role: ROLE, specialist_agent_id: "general", specialist_agent_version: 1,
        conversation_id: conversationId, turn_id: turnId,
      },
    });
    return { conversationId, turnId, cubeBearer, tenantId: TENANT_ID, actorId: ACTOR_ID, role: ROLE };
  },
  settleTurn: async (grant, answered) => {
    await db("select public.fail_albert_turn($1, $2, $3)", [
      grant.conversationId, grant.turnId,
      answered ? "albert_omni_answered" : "albert_omni_unavailable",
    ]).catch(() => undefined);
  },
  runOmniTurn: async (turn, onEvent, signal) => (
    client.runTurn(turn, async (event) => onEvent(event), signal, async () => undefined)
  ),
  timezone: "Australia/Melbourne",
  organisationName: "Ashburton Cycles",
  activeConnectors: [...ACTIVE_CONNECTORS],
  ...(BUSINESS_CONTEXT ? { businessContext: BUSINESS_CONTEXT.rendered } : {}),
  log: (line) => console.log(`  ${line}`),
};

const transport = {
  apiKey,
  baseUrl,
  safetyIdentifier: createHash("sha256").update(`${TENANT_ID}:${ACTOR_ID}`).digest("hex"),
};
const director = createDashboardDirector(transport);
const periodLabel = DASHBOARD_MASTER_PERIOD_LABEL;

const ready = await fetch(`${args.serviceUrl.replace(/\/+$/u, "")}/readyz`).then((r) => r.json()) as { ready?: boolean };
if (ready.ready !== true) throw new Error("agent runtime not ready");

const statePath = path.join(dir, "session-state.json");
let state: DashboardSessionState = args.resume && existsSync(statePath)
  ? { ...JSON.parse(readFileSync(statePath, "utf8")) as DashboardSessionState, budgetMs: args.budgetMinutes * 60_000 }
  : newDashboardSessionState(args.budgetMinutes * 60_000);
const sessionStarted = Date.now();
console.log(`[dashboard-master] session ${args.resume ? `resume phase=${state.phase} findings=${state.findings.length}` : "start"} budget=${args.budgetMinutes}m service=${args.serviceUrl}`);
for (let tick = 1; state.phase !== "compose" && state.phase !== "completed"; tick += 1) {
  console.log(`[dashboard-master] tick ${tick}: phase=${state.phase} findings=${state.findings.length} spent=${Math.round(state.investigationMs / 60_000)}m`);
  const result = await advanceDashboardSession({
    state,
    periodLabel,
    deps,
    director,
    tickBudgetMs: DASHBOARD_MASTER_TICK_BUDGET_MS,
  });
  state = result.state;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  if (!result.advanced) break;
  if (tick > 24) throw new Error("session did not converge within 24 ticks");
}

console.log(`[dashboard-master] composing over ${state.findings.length} findings (${Math.round(state.investigationMs / 60_000)}m investigated)…`);
const report = await composeDashboardReport({
  state,
  periodLabel,
  businessName: "Ashburton Cycles",
  transport,
});
dashboardMasterReportSchema.parse(report);
writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2));

if (args.persist) {
  await db("select public.albert_dashboard_master_begin($1, $2, $3, $4::jsonb)", [
    report.reportId, DASHBOARD_MASTER_MODEL, DASHBOARD_MASTER_EFFORT, JSON.stringify(state),
  ]);
  await db("select public.albert_dashboard_master_complete($1, $2::jsonb)", [
    report.reportId, JSON.stringify(report),
  ]);
  console.log(`[dashboard-master] report ${report.reportId} persisted to the control plane`);
}

console.log(`[dashboard-master] DONE in ${Math.round((Date.now() - sessionStarted) / 60_000)}m wall · ${report.investigationMinutes}m investigated · ${report.workerTurns} turns · ${report.governedQueries} queries`);
console.log(`headline: ${report.headline}`);
for (const item of report.focus) {
  console.log(`  ${item.rank}. ${item.title} — ${item.keyFigures.map((figure) => `${figure.label} ${figure.value}`).join("; ")} [tables=${item.tables.length} charts=${item.charts.length}]`);
}
if (report.cautions.length > 0) console.log(`cautions: ${report.cautions.join(" | ")}`);
console.log(`report → ${path.join(dir, "report.json")}`);
await pool.end();
process.exit(0);
