/**
 * Codex-harness eval runner (companion to run.mts, which drives albert-v3).
 *
 * Drives the codex-runtime service job API with production-shaped turns for
 * Ashburton Cycles: one freshly minted control-plane lease per question (so
 * per-turn Cube cold start is measured exactly as production pays it), model
 * gpt-5.6-luna at max effort, fast mode OFF unless --fast.
 *
 * Requires a private codex-runtime instance (never the shared --watch one):
 *   PORT=8799 ALBERT_CODEX_MAX_CONCURRENT_TURNS=6 \
 *     node --env-file=.env.local --import tsx services/codex-runtime/src/main.ts
 *
 * Usage:
 *   npx tsx scripts/albert-eval/run-codex.mts --run codex-baseline
 *   npx tsx scripts/albert-eval/run-codex.mts --run smoke --ids CE-01,CA-01
 * Options: --concurrency N (default 4), --timeout-ms (default 780000),
 *   --limit N, --resume, --fast, --service-url URL (default 127.0.0.1:8799).
 *
 * Results append to evals/albert/runs/<run>/results.jsonl (EvalTurnRecord
 * rows — grade.mts and report.mts consume them unchanged); raw runtime events
 * per turn go to evals/albert/runs/<run>/events/<id>.jsonl.
 */
import path from "node:path";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import pg from "pg";
import { ulid } from "ulid";
import { signCubeJwt } from "../../packages/albert-v3/src/cube/jwt.js";
import {
  ALBERT_CODEX_LOCAL_SIGNING_SECRET,
  CodexRuntimeServiceClient,
  createCodexTraceTransportState,
  projectCodexRuntimeEvent,
} from "../../packages/albert-codex/src/index.js";
import type { CodexServiceTurn } from "../../packages/albert-codex/src/contracts.js";
import { buildSharedAnalyticalBrief } from "../../services/conversation/src/analytical-brief.js";
import { CODEX_QUESTIONS, type CodexEvalQuestion } from "./questions-codex-bikeshop.js";
import {
  ACTIVE_CONNECTORS,
  ACTOR_ID,
  ROLE,
  SOURCE_FINDINGS,
  TENANT_ID,
  appendJsonl,
  loadEnv,
  loadEvalBusinessContext,
  readJsonl,
  runDir,
  type EvalTurnRecord,
} from "./lib.js";

type Args = {
  run: string;
  ids?: Set<string>;
  question?: string;
  concurrency: number;
  timeoutMs: number;
  limit?: number;
  resume: boolean;
  fastMode: boolean;
  serviceUrl: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    run: "codex-adhoc",
    concurrency: 4,
    timeoutMs: 780_000,
    resume: false,
    fastMode: false,
    serviceUrl: process.env.REPRO_SERVICE_URL ?? "http://127.0.0.1:8799",
    model: "gpt-5.6-luna",
    effort: "max",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const next = () => argv[++i]!;
    if (a === "--run") args.run = next();
    else if (a === "--ids") args.ids = new Set(next().split(",").map((s) => s.trim()).filter(Boolean));
    else if (a === "--question") args.question = next();
    else if (a === "--concurrency") args.concurrency = Number(next());
    else if (a === "--timeout-ms") args.timeoutMs = Number(next());
    else if (a === "--limit") args.limit = Number(next());
    else if (a === "--resume") args.resume = true;
    else if (a === "--fast") args.fastMode = true;
    else if (a === "--service-url") args.serviceUrl = next();
    else if (a === "--model") args.model = next();
    else if (a === "--effort") args.effort = next() as Args["effort"];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const env = loadEnv();
if (!env.CUBEJS_API_SECRET) throw new Error("CUBEJS_API_SECRET missing");

// Control-plane pooler URL for lease minting: the direct db.<ref> host is
// IPv6-only from this Mac, so rewrite to the Sydney session pooler.
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

const TOM_UID = ACTOR_ID;
const pool = new pg.Pool({ connectionString: leaseDbUrl(), ssl: { rejectUnauthorized: false }, max: 3, idleTimeoutMillis: 30_000 });
pool.on("error", (error) => console.error("[pool]", error.message));
const initialized = new WeakSet<object>();
async function db(text: string, values?: unknown[]): Promise<pg.QueryResult> {
  const client = await pool.connect();
  try {
    if (!initialized.has(client)) {
      await client.query("set role albert_control_migration_owner");
      await client.query(
        "select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, false)",
        [TOM_UID],
      );
      initialized.add(client);
    }
    return await client.query(text, values as never);
  } finally {
    client.release();
  }
}

const BUSINESS_CONTEXT = loadEvalBusinessContext();
const client = new CodexRuntimeServiceClient(
  args.serviceUrl,
  env.ALBERT_CODEX_RUNTIME_SIGNING_SECRET?.trim() || ALBERT_CODEX_LOCAL_SIGNING_SECRET,
);

const dir = runDir(args.run);
const eventsDir = path.join(dir, "events");
mkdirSync(eventsDir, { recursive: true });
const resultsFile = path.join(dir, "results.jsonl");
const existing = new Set(args.resume ? readJsonl<EvalTurnRecord>(resultsFile).map((r) => r.id) : []);
let engineVersion = "unknown";
try { engineVersion = execSync("git rev-parse --short HEAD").toString().trim(); } catch { /* ignore */ }
engineVersion = `codex-${engineVersion}${process.env.EVAL_ENGINE_LABEL ? `+${process.env.EVAL_ENGINE_LABEL}` : ""}`;

let selected: CodexEvalQuestion[] = args.question
  ? [{
    id: "ADHOC",
    tier: "easy",
    scope: "deputy",
    surface: "staff_labour",
    pattern: "cold",
    question: args.question,
  }]
  : CODEX_QUESTIONS.filter((q) => !args.ids || args.ids.has(q.id));
if (args.limit) selected = selected.slice(0, args.limit);
const runnable = selected.filter((q) => !existing.has(q.id));
console.log(`[codex-eval] run=${args.run} engine=${engineVersion} model=${args.model} fast=${args.fastMode} service=${args.serviceUrl} turns=${runnable.length}/${selected.length} concurrency=${args.concurrency}`);

type Lease = { conversationId: string; turnId: string };

async function mintLease(question: CodexEvalQuestion): Promise<Lease> {
  const turnId = ulid();
  const runtimeProfile = {
    provider: "openai",
    model: args.model,
    reasoningEffort: args.effort,
    fastMode: args.fastMode,
    kind: "codex_eval",
  };
  const begun = await db(
    "select conversation_id from public.begin_albert_turn(null, $1, $2, $3::jsonb, null, null)",
    [turnId, question.question, JSON.stringify(runtimeProfile)],
  );
  const conversationId = String(begun.rows[0]?.conversation_id ?? "");
  if (!conversationId) throw new Error("begin_albert_turn returned no conversation id");
  await db(
    "update control_plane.conversation_turns set lease_expires_at = clock_timestamp() + interval '45 minutes' where turn_id = $1",
    [turnId],
  );
  await db("select public.albert_assign_conversation_title($1, $2)", [
    conversationId, `Eval · ${args.run} · ${question.id}`,
  ]).catch(() => undefined);
  return { conversationId, turnId };
}

async function completeLease(lease: Lease, answerState: string | undefined): Promise<void> {
  await db("select public.fail_albert_turn($1, $2, $3)", [
    lease.conversationId, lease.turnId,
    answerState === "Unavailable" || !answerState ? "albert_codex_unavailable" : "albert_codex_answered",
  ]).catch(() => undefined);
}

async function runTurnOnce(question: CodexEvalQuestion): Promise<EvalTurnRecord> {
  const startedAt = new Date();
  const record: EvalTurnRecord = {
    runId: args.run,
    id: question.id,
    question: question.question,
    tier: question.tier,
    scope: question.scope,
    surface: question.surface,
    pattern: question.pattern,
    ...(question.format ? { format: question.format } : {}),
    ...(question.expect ? { expect: question.expect } : {}),
    startedAt: startedAt.toISOString(),
    durationMs: 0,
    phases: {},
    progress: [],
    narratives: [],
    queries: [],
    tables: [],
    charts: [],
    errors: [],
    engineVersion,
    businessContext: Boolean(BUSINESS_CONTEXT),
    specialistAgentId: "general",
    fastMode: args.fastMode,
  };
  const eventsFile = path.join(eventsDir, `${question.id}.jsonl`);
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("eval timeout")), args.timeoutMs);
  let lease: Lease | undefined;
  try {
    lease = await mintLease(question);
    const cubeBearer = signCubeJwt({
      secret: env.CUBEJS_API_SECRET!,
      expiresInSeconds: 2_700,
      securityContext: {
        tenant_id: TENANT_ID,
        role: ROLE,
        specialist_agent_id: "general",
        specialist_agent_version: 1,
        conversation_id: lease.conversationId,
        turn_id: lease.turnId,
      },
    });
    const analysisBrief = buildSharedAnalyticalBrief({
      message: question.question,
      activeConnectors: [...ACTIVE_CONNECTORS],
      connectorFreshness: [],
      includeGeneric: true,
    });
    const turn: CodexServiceTurn = {
      protocolVersion: 1,
      requestId: ulid(),
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      role: ROLE,
      conversationId: lease.conversationId,
      turnId: lease.turnId,
      message: question.question,
      priorConversation: [],
      priorResults: [],
      activeConnectors: [...ACTIVE_CONNECTORS],
      connectorFreshness: [],
      ...(BUSINESS_CONTEXT ? { businessContext: BUSINESS_CONTEXT.rendered.slice(0, 20_000) } : {}),
      sourceFindings: JSON.stringify(SOURCE_FINDINGS).slice(0, 12_000),
      ...(analysisBrief ? { analysisBrief } : {}),
      cubeBearer,
      model: args.model,
      effort: args.effort,
      fastMode: args.fastMode,
    };
    let transport = createCodexTraceTransportState();
    const result = await client.runTurn(turn, async (raw) => {
      const at = Date.now() - t0;
      appendJsonl(eventsFile, { atMs: at, ...raw });
      const projected = projectCodexRuntimeEvent(transport, raw);
      transport = projected.state;
      for (const event of projected.events) {
        switch (event.type) {
          case "progress":
            record.progress.push(`${(at / 1000).toFixed(1)}s ${event.status} ${event.stage} · ${event.label}${event.detail ? ` · ${event.detail}` : ""}`);
            if (event.stage === "planning" && event.status === "complete" && record.phases.classifiedMs === undefined) {
              record.phases.classifiedMs = at;
              record.phases.laneLabel = event.label;
            }
            break;
          case "narrative":
            record.narratives.push(event.text);
            break;
          case "plan":
            record.plan = event.steps;
            break;
          case "query":
            if (record.phases.firstQueryMs === undefined) record.phases.firstQueryMs = at;
            record.phases.lastQueryMs = at;
            record.queries.push({ topic: event.topic, view: event.view, connector: event.connector, rowCount: event.rowCount, queryYaml: event.queryYaml, timeRange: event.timeRange.label, executionMs: event.executionMs });
            break;
          case "table":
            record.tables.push({
              resultId: event.resultId,
              caption: event.caption,
              presentation: event.presentation ?? "evidence",
              columns: event.columns.map((c) => ({ key: c.key, label: c.label, type: c.type, ...(c.currency ? { currency: c.currency } : {}) })),
              rows: event.rows.slice(0, 50) as Array<Record<string, unknown>>,
              rowCount: event.rows.length,
              ...(event.provenance?.view?.name ? { view: event.provenance.view.name } : {}),
            });
            break;
          case "chart":
            record.charts.push({ chartType: event.chartType, caption: event.caption, dataRef: event.dataRef, xKey: event.xKey, yKey: event.yKey, ...(event.orientation ? { orientation: event.orientation } : {}), ...(event.series?.length ? { series: event.series.map((s) => s.key) } : {}) });
            break;
          case "answer":
            record.phases.answerMs = at;
            record.answerState = event.state;
            record.answerText = event.text;
            record.followUps = event.followUps;
            record.presentedResultIds = event.presentedResultIds;
            record.presentedTables = event.presentedTables;
            record.resolvedSubject = event.resolvedSubject;
            record.provenanceDefinitions = event.provenance?.definitions?.map((d) => ({ metric: d.metric, label: d.label, definition: d.definition }));
            break;
          case "clarification":
            record.phases.answerMs = at;
            record.answerState = "Clarification";
            record.clarification = event.question;
            record.clarificationOptions = event.options.map((o) => o.label);
            break;
          case "error":
            record.errors.push(event.message);
            break;
          default:
            break;
        }
      }
    }, controller.signal);
    record.queriesExecuted = result.queriesExecuted;
    if (!record.answerState) record.answerState = result.answerState;
  } catch (error) {
    record.failed = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } finally {
    clearTimeout(timer);
    record.durationMs = Date.now() - t0;
    if (lease) await completeLease(lease, record.failed ? undefined : record.answerState);
  }
  return record;
}

const TRANSIENT = /overloaded|429|fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/iu;

let done = 0;
const queue = [...runnable];
async function worker(): Promise<void> {
  for (;;) {
    const question = queue.shift();
    if (!question) return;
    console.log(`[${done + 1}/${runnable.length}] START ${question.id} (${question.tier}) "${question.question.slice(0, 80)}"`);
    let record = await runTurnOnce(question);
    if (record.failed && TRANSIENT.test(record.failed)) {
      console.log(`[codex-eval] ${question.id} transient failure (${record.failed}); retrying in 20s`);
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      record = await runTurnOnce(question);
    }
    appendJsonl(resultsFile, record);
    done += 1;
    console.log(`[${done}/${runnable.length}] DONE  ${question.id}: state=${record.answerState ?? "FAILED"} q=${record.queries.length} charts=${record.charts.length} ${(record.durationMs / 1000).toFixed(0)}s${record.failed ? ` FAILED: ${record.failed.slice(0, 160)}` : ""}`);
  }
}

await Promise.all(Array.from({ length: Math.min(args.concurrency, runnable.length) }, () => worker()));
console.log(`[codex-eval] finished ${done} turns → ${resultsFile}`);
await pool.end();
process.exit(0);
