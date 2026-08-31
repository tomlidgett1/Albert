/**
 * Live dashboard-build runner (ADR 0129): drives one real dashboard-architect
 * turn through a private Omni runtime against production Cube, then — with
 * --persist — replays the web relay faithfully (event stamping, the
 * query→table replay-reference pairing, `albert_answer_event_append`) so the
 * whole SQL chain is exercised; with --apply it additionally pins the
 * composed plan into the owner's live dashboard via the real RPCs and proves
 * every tile replays through the governed refresh adapter.
 *
 * Requires a private runtime instance (never the shared --watch one):
 *   PORT=8801 node --env-file=.env.local --import tsx services/codex-runtime/src/main.ts
 *
 * Usage:
 *   npx tsx scripts/albert-eval/run-dashboard-build.mts --run dashboard-build-live \
 *     --instruction "I need a dashboard that shows top level metrics" --persist --apply
 */
import path from "node:path";
import { mkdirSync } from "node:fs";
import pg from "pg";
import { ulid } from "ulid";
import { signCubeJwt } from "../../packages/albert-v3/src/cube/jwt.js";
import { ALBERT_CODEX_LOCAL_SIGNING_SECRET } from "../../packages/albert-codex/src/contracts.js";
import {
  OmniRuntimeServiceClient,
  type OmniServiceTurn,
  type OmniTraceEventInput,
} from "../../packages/albert-omni/src/index.js";
import {
  buildDashboardBriefMessage,
  dashboardPlanEventSchema,
  displayFromPlanTile,
  packDashboardLayouts,
  type DashboardPlanEvent,
} from "../../services/dashboard-build/src/contracts.js";
import { refreshDashboardClaim } from "../../services/dashboard/src/refresh.js";
import type { DashboardRefreshClaim } from "../../services/control-plane/src/dashboard-repository.js";
import type { TenantContext } from "../../services/control-plane/src/web-repository.js";
import {
  ACTIVE_CONNECTORS,
  ACTOR_ID,
  ROLE,
  TENANT_ID,
  appendJsonl,
  loadEnv,
  loadEvalBusinessContext,
  runDir,
} from "./lib.js";

type Args = {
  run: string;
  instruction: string;
  serviceUrl: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  fastMode: boolean;
  timeoutMs: number;
  persist: boolean;
  apply: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    run: "dashboard-build-live",
    instruction: "I need a dashboard that shows top level metrics",
    serviceUrl: process.env.REPRO_SERVICE_URL ?? "http://127.0.0.1:8801",
    model: "gpt-5.6-luna",
    effort: "max",
    fastMode: false,
    timeoutMs: 780_000,
    persist: false,
    apply: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const next = () => argv[++i]!;
    if (a === "--run") args.run = next();
    else if (a === "--instruction") args.instruction = next();
    else if (a === "--service-url") args.serviceUrl = next();
    else if (a === "--model") args.model = next();
    else if (a === "--effort") args.effort = next() as Args["effort"];
    else if (a === "--fast") args.fastMode = true;
    else if (a === "--timeout-ms") args.timeoutMs = Number(next());
    else if (a === "--persist") args.persist = true;
    else if (a === "--apply") { args.apply = true; args.persist = true; }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const env = loadEnv();
if (!env.CUBEJS_API_SECRET) throw new Error("CUBEJS_API_SECRET missing");

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
  max: 2,
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

async function assertRuntimeReady(): Promise<void> {
  const response = await fetch(`${args.serviceUrl.replace(/\/+$/u, "")}/readyz`, {
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null) as null | { ready?: boolean };
  if (!response.ok || payload?.ready !== true) {
    throw new Error(`The agent runtime is not ready (${response.status}).`);
  }
}

const dir = runDir(args.run);
mkdirSync(dir, { recursive: true });
const eventsFile = path.join(dir, `events-${Date.now()}.jsonl`);

await assertRuntimeReady();
const BUSINESS_CONTEXT = loadEvalBusinessContext();
const client = new OmniRuntimeServiceClient(
  args.serviceUrl,
  env.ALBERT_CODEX_RUNTIME_SIGNING_SECRET?.trim() || ALBERT_CODEX_LOCAL_SIGNING_SECRET,
);

// ---- Lease -----------------------------------------------------------------
const turnId = ulid();
const begun = await db(
  "select conversation_id from public.begin_albert_turn($1, $2, $3, $4::jsonb, null, null)",
  [null, turnId, args.instruction, JSON.stringify({
    provider: "openai",
    model: args.model,
    reasoningEffort: args.effort,
    fastMode: args.fastMode,
    runtime: "omni-agent",
    analyticalRuntime: "cube-omni-v1",
    kind: "dashboard_build_probe",
  })],
);
const conversationId = String(begun.rows[0]?.conversation_id ?? "");
if (!conversationId) throw new Error("begin_albert_turn returned no conversation id");
await db(
  "update control_plane.conversation_turns set lease_expires_at = clock_timestamp() + interval '45 minutes' where turn_id = $1",
  [turnId],
);
await db("select public.albert_assign_conversation_title($1, $2)", [
  conversationId, `Dashboard build · ${args.run}`,
]).catch(() => undefined);
console.log(`[dash-build] lease conversation=${conversationId} turn=${turnId}`);

const cubeBearer = signCubeJwt({
  secret: env.CUBEJS_API_SECRET!,
  expiresInSeconds: 2_700,
  securityContext: {
    tenant_id: TENANT_ID,
    role: ROLE,
    specialist_agent_id: "general",
    specialist_agent_version: 1,
    conversation_id: conversationId,
    turn_id: turnId,
  },
});

const turn: OmniServiceTurn = {
  protocolVersion: 1,
  requestId: ulid(),
  tenantId: TENANT_ID,
  actorId: ACTOR_ID,
  role: ROLE,
  conversationId,
  turnId,
  message: buildDashboardBriefMessage({ instruction: args.instruction, currentTiles: [] }),
  priorConversation: [],
  activeConnectors: [...ACTIVE_CONNECTORS],
  connectorFreshness: [],
  ...(BUSINESS_CONTEXT ? { businessContext: BUSINESS_CONTEXT.rendered.slice(0, 20_000) } : {}),
  timezone: "Australia/Melbourne",
  organisationName: "Ashburton Cycles",
  ownerName: "Tom",
  cubeBearer,
  model: args.model,
  effort: args.effort,
  fastMode: args.fastMode,
  dashboardBuild: true,
};

// ---- Web-relay mirror: stamping, pairing, persistence ----------------------
let sequence = 0;
let persistedCount = 0;
let persistFailures = 0;
const queryEventIdByResultId = new Map<string, string>();
const tableEventIdByResultId = new Map<string, string>();
let plan: DashboardPlanEvent | null = null;
let answerText = "";
let answerState = "";
let queries = 0;
const t0 = Date.now();

const receiveEvent = async (event: OmniTraceEventInput) => {
  const at = ((Date.now() - t0) / 1000).toFixed(1);
  appendJsonl(eventsFile, { atMs: Date.now() - t0, ...event });
  let outbound: Record<string, unknown> = { ...event };
  if (
    event.type === "table"
    && event.dashboardReplay?.kind === "cube_v3"
    && !event.dashboardReplay.queryEventId
  ) {
    const queryEventId = queryEventIdByResultId.get(event.resultId);
    if (queryEventId) {
      outbound = { ...outbound, dashboardReplay: { ...event.dashboardReplay, queryEventId } };
    } else {
      delete outbound.dashboardReplay;
      console.log(`[dash-build] ${at}s WARN table ${event.resultId} had no pairable query event`);
    }
  }
  sequence += 1;
  const stamped = { ...outbound, id: ulid(), sequence, occurredAt: new Date().toISOString() };
  if (event.type === "query") {
    queries += 1;
    if (event.resultId) queryEventIdByResultId.set(event.resultId, stamped.id as string);
    console.log(`[dash-build] ${at}s query ${event.name ?? event.topic} rows=${event.rowCount}`);
  }
  if (event.type === "table") tableEventIdByResultId.set(event.resultId, stamped.id as string);
  if (event.type === "tasks") {
    console.log(`[dash-build] ${at}s tasks ${event.items.filter((item) => item.completed).length}/${event.items.length}`);
  }
  if (event.type === "dashboard_plan") {
    const parsed = dashboardPlanEventSchema.safeParse(stamped);
    if (parsed.success) plan = parsed.data;
    console.log(`[dash-build] ${at}s dashboard_plan "${event.dashboardTitle}" tiles=${event.tiles.length} valid=${parsed.success}`);
  }
  if (event.type === "answer") {
    answerText = event.text;
    answerState = event.state;
    console.log(`[dash-build] ${at}s answer state=${event.state}`);
  }
  if (event.type === "error") console.log(`[dash-build] ${at}s ERROR ${event.message}`);
  if (args.persist) {
    try {
      await db(
        "select public.albert_answer_event_append($1, $2, $3::jsonb)",
        [conversationId, turnId, JSON.stringify(stamped)],
      );
      persistedCount += 1;
    } catch (error) {
      persistFailures += 1;
      console.log(`[dash-build] ${at}s PERSIST FAIL ${event.type}: ${error instanceof Error ? error.message : error}`);
    }
  }
};

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error("build timeout")), args.timeoutMs);
try {
  const result = await client.runTurn(turn, receiveEvent, controller.signal, async () => undefined);
  console.log(`[dash-build] result state=${result.answerState} queries=${result.queriesExecuted} duration=${((result.durationMs ?? 0) / 1000).toFixed(1)}s`);
} finally {
  clearTimeout(timer);
  await db("select public.fail_albert_turn($1, $2, $3)", [
    conversationId, turnId, answerText ? "albert_omni_answered" : "albert_omni_unavailable",
  ]).catch((error) => console.log(`[dash-build] settle failed: ${error instanceof Error ? error.message : error}`));
}

console.log(`[dash-build] persisted=${persistedCount} persistFailures=${persistFailures} queries=${queries}`);
if (!plan) {
  console.log("[dash-build] NO PLAN — the build turn did not compose a dashboard.");
  await pool.end();
  process.exit(1);
}
const composedPlan: DashboardPlanEvent = plan;
console.log(`[dash-build] plan "${composedPlan.dashboardTitle}" · ${composedPlan.timeframe}`);
for (const tile of composedPlan.tiles) {
  const eventId = tableEventIdByResultId.get(tile.resultId);
  console.log(`  - [${tile.kind}/${tile.width}] ${tile.title} → result ${tile.resultId} table-event ${eventId ?? "MISSING"}`);
}
console.log(`[dash-build] answer (${answerState}): ${answerText.slice(0, 400)}`);

if (!args.apply) {
  await pool.end();
  process.exit(0);
}

// ---- Apply through the real dashboard RPCs ---------------------------------
function documentOf(row: unknown): { revision: number; tiles: { tileId: string; title: string; source: { tableEventId: string } }[] } {
  const doc = (Array.isArray(row) ? row[0] : row) as {
    revision: number;
    tiles: { tileId: string; title: string; source: { tableEventId: string } }[];
  };
  return doc;
}
let doc = documentOf((await db("select public.albert_dashboard_get() as doc")).rows[0]?.doc);
console.log(`[dash-build] dashboard revision=${doc.revision} existingTiles=${doc.tiles.length}`);
for (const tile of [...doc.tiles]) {
  doc = documentOf((await db(
    "select public.albert_dashboard_tile_delete($1, $2) as doc",
    [tile.tileId, doc.revision],
  )).rows[0]?.doc);
}
const appliedTiles: { tileId: string; kind: "kpi" | "chart" | "table"; width: DashboardPlanEvent["tiles"][number]["width"] }[] = [];
for (const tile of composedPlan.tiles) {
  const tableEventId = tableEventIdByResultId.get(tile.resultId);
  if (!tableEventId) {
    console.log(`[dash-build] SKIP ${tile.title}: no persisted table event`);
    continue;
  }
  doc = documentOf((await db(
    "select public.albert_dashboard_pin($1, $2, $3, $4, $5) as doc",
    [conversationId, turnId, tableEventId, tile.resultId, doc.revision],
  )).rows[0]?.doc);
  const minted = doc.tiles.find((candidate) => candidate.source.tableEventId === tableEventId);
  if (!minted) {
    console.log(`[dash-build] SKIP ${tile.title}: pinned tile not found`);
    continue;
  }
  doc = documentOf((await db(
    "select public.albert_dashboard_tile_update($1, $2, $3, $4::jsonb, $5::jsonb) as doc",
    [minted.tileId, doc.revision, tile.title, null, JSON.stringify(displayFromPlanTile(tile))],
  )).rows[0]?.doc);
  appliedTiles.push({ tileId: minted.tileId, kind: tile.kind, width: tile.width });
  console.log(`[dash-build] pinned [${tile.kind}] ${tile.title} → tile ${minted.tileId}`);
}
doc = documentOf((await db(
  "select public.albert_dashboard_layout_update($1::jsonb, $2) as doc",
  [JSON.stringify(packDashboardLayouts(appliedTiles)), doc.revision],
)).rows[0]?.doc);
console.log(`[dash-build] applied tiles=${appliedTiles.length} revision=${doc.revision}`);

// ---- Prove replay: claim + refresh every tile through the real adapter -----
const tenant: TenantContext = {
  tenant_id: TENANT_ID,
  tenant_name: "Ashburton Cycles",
  tenant_slug: "ashburton-cycles",
  role: ROLE,
  timezone: "Australia/Melbourne",
} as TenantContext;
const claims = (await db(
  "select public.albert_dashboard_refresh_claim(null, true) as claims",
)).rows[0]?.claims as DashboardRefreshClaim[];
console.log(`[dash-build] refresh claims=${claims?.length ?? 0}`);
for (const claim of claims ?? []) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const refreshed = await refreshDashboardClaim(claim, tenant, [], "AUD");
  await db(
    `select public.albert_dashboard_refresh_complete(
       $1, $2::timestamptz, $3, $4, $5::timestamptz, $6, $7::jsonb, $8, $9, $10::jsonb, $11, $12, $13, $14::jsonb) as doc`,
    [
      claim.tileId, claim.claimedAt, claim.leaseId, refreshed.outcome, startedAt,
      Date.now() - started, refreshed.snapshot ? JSON.stringify(refreshed.snapshot) : null,
      refreshed.resultDigest, refreshed.rowCount, JSON.stringify(refreshed.sourceWatermarks),
      claim.replayKind, refreshed.dedupeStatus, refreshed.errorCode, JSON.stringify(refreshed.metadata),
    ],
  );
  console.log(`[dash-build] refresh tile=${claim.tileId} outcome=${refreshed.outcome} rows=${refreshed.rowCount ?? "-"} error=${refreshed.errorCode ?? "-"}`);
}
const finalDoc = (await db("select public.albert_dashboard_get() as doc")).rows[0]?.doc as {
  tiles: { title: string; display: { mode: string }; refreshState: string; snapshot: { rows: unknown[]; empty: boolean } | null }[];
};
console.log("[dash-build] final dashboard:");
for (const tile of finalDoc.tiles) {
  console.log(`  - ${tile.title} [${tile.display.mode}] state=${tile.refreshState} rows=${tile.snapshot?.rows.length ?? 0} empty=${tile.snapshot?.empty ?? "?"}`);
}
await pool.end();
