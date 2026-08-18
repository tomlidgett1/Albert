/**
 * Albert eval runner.
 *
 * Drives `runAlbertV3Turn` against production Cube (and the live Xero MCP
 * boundary on the sync worker) with the exact inputs the web route injects for
 * Ashburton Cycles: Luna at max reasoning, fast mode off, active connectors
 * lightspeed-r/xero/deputy, the tenant's source findings, and the
 * production-shaped conversation context for multi-turn threads.
 *
 * Usage:
 *   npx tsx scripts/albert-eval/run.mts --run baseline               # all 250 turns
 *   npx tsx scripts/albert-eval/run.mts --run smoke --ids E-LS-01,F-01a,F-01b
 *   npx tsx scripts/albert-eval/run.mts --run baseline --resume        # skip ids already recorded
 *   npx tsx scripts/albert-eval/run.mts --run x --filter pattern=chart_reformat
 *
 * Options: --concurrency N (default 4), --timeout-ms (default 780000, mirrors
 * the Vercel maxDuration ceiling), --limit N.
 *
 * Results append to evals/albert/runs/<run>/results.jsonl, one JSON row per turn.
 */
import path from "node:path";
import { execSync } from "node:child_process";
import { runAlbertV3Turn } from "../../packages/albert-v3/src/index.js";
import type { TraceEvent } from "../../packages/shared/src/index.js";
import { xeroMcpServiceUrl } from "../../packages/xero-mcp/src/client.js";
import { QUESTIONS, type EvalQuestion } from "./questions.js";
import { priorResultsFromRecords , loadEvalBusinessContext } from "./lib.js";
import {
  ACTIVE_CONNECTORS,
  ACTOR_ID,
  LEASES,
  ROLE,
  SOURCE_FINDINGS,
  TENANT_ID,
  appendJsonl,
  computeGolden,
  conversationFromPriorTurns,
  createEvalCube,
  dateTokens,
  loadEnv,
  readJsonl,
  runDir,
  type EvalTurnRecord,
} from "./lib.js";

type Args = { run: string; ids?: Set<string>; filter?: [string, string]; concurrency: number; timeoutMs: number; limit?: number; resume: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { run: "adhoc", concurrency: 4, timeoutMs: 780_000, resume: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const next = () => argv[++i]!;
    if (a === "--run") args.run = next();
    else if (a === "--ids") args.ids = new Set(next().split(",").map((s) => s.trim()).filter(Boolean));
    else if (a === "--filter") { const [k, v] = next().split("="); args.filter = [k!, v!]; }
    else if (a === "--concurrency") args.concurrency = Number(next());
    else if (a === "--timeout-ms") args.timeoutMs = Number(next());
    else if (a === "--limit") args.limit = Number(next());
    else if (a === "--resume") args.resume = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const env = loadEnv();
if (!env.CUBEJS_API_SECRET || !env.OPENAI_API_KEY) {
  console.error("Missing CUBEJS_API_SECRET or OPENAI_API_KEY");
  process.exit(1);
}
const dir = runDir(args.run);
const resultsFile = path.join(dir, "results.jsonl");
const existing = new Set(args.resume ? readJsonl<EvalTurnRecord>(resultsFile).map((r) => r.id) : []);
// EVAL_BUSINESS_CONTEXT=on|off (default on when a stored document exists for the tenant):
// injects the business context document (context-layer/) the way the production route does.
const BUSINESS_CONTEXT = loadEvalBusinessContext();
let engineVersion = "unknown";
try { engineVersion = execSync("git rev-parse --short HEAD", { cwd: path.resolve(dir, "..", "..", "..", "..") }).toString().trim(); } catch { /* not a git checkout */ }
engineVersion = `${engineVersion}${process.env.EVAL_ENGINE_LABEL ? `+${process.env.EVAL_ENGINE_LABEL}` : ""}`;

// Units: a thread is one unit (sequential turns); a cold single question is one unit.
let selected: EvalQuestion[] = QUESTIONS.filter((q) => {
  if (args.ids && !args.ids.has(q.id)) return false;
  if (args.filter && String((q as unknown as Record<string, unknown>)[args.filter[0]]) !== args.filter[1]) return false;
  return true;
});
// A selected follow-up turn needs its predecessors even if they were not selected.
if (args.ids || args.filter) {
  const threads = new Set(selected.filter((q) => q.thread).map((q) => q.thread!));
  selected = QUESTIONS.filter((q) => selected.includes(q) || (q.thread && threads.has(q.thread)));
}
type Unit = { key: string; turns: EvalQuestion[] };
const units: Unit[] = [];
const byThread = new Map<string, EvalQuestion[]>();
for (const q of selected) {
  if (q.thread) {
    if (!byThread.has(q.thread)) byThread.set(q.thread, []);
    byThread.get(q.thread)!.push(q);
  } else {
    units.push({ key: q.id, turns: [q] });
  }
}
for (const [thread, turns] of byThread) units.push({ key: thread, turns: turns.sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0)) });
// Interleave threads with singles so long threads start early.
units.sort((a, b) => (b.turns.length - a.turns.length) || a.key.localeCompare(b.key));
const limited = args.limit ? units.slice(0, args.limit) : units;
const totalTurns = limited.reduce((n, u) => n + u.turns.length, 0);
console.log(`[eval] run=${args.run} engine=${engineVersion} units=${limited.length} turns=${totalTurns} concurrency=${args.concurrency} leases=${LEASES.length}`);

const cube = createEvalCube(env);
const xeroServiceUrl = xeroMcpServiceUrl() || undefined;
const xeroSecret = env.ALBERT_OAUTH_WORKER_SIGNING_SECRET || undefined;
if (!xeroServiceUrl || !xeroSecret) console.warn("[eval] Xero MCP boundary not configured; live Xero statements will be unavailable");

async function runTurn(question: EvalQuestion, prior: EvalTurnRecord[], lease: Readonly<{ conversationId: string; turnId: string }>): Promise<EvalTurnRecord> {
  const startedAt = new Date();
  const tokens = dateTokens(startedAt);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("eval timeout")), args.timeoutMs);
  const record: EvalTurnRecord = {
    runId: args.run,
    id: question.id,
    ...(question.thread ? { thread: question.thread, turn: question.turn } : {}),
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
  };
  const t0 = Date.now();
  let sequence = 0;
  const conversation = conversationFromPriorTurns(prior, question.question);
  const priorResults = priorResultsFromRecords(prior);
  const started = Date.now();
  try {
    const result = await runAlbertV3Turn({
      message: question.question,
      conversation: conversation as never,
      preferences: { model: "gpt-5.6-luna", reasoningEffort: "max", fastMode: false },
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      role: ROLE,
      activeConnectors: [...ACTIVE_CONNECTORS],
      // Production currently has no readiness/cursor watermarks for the Fivetran-backed connections.
      connectorFreshness: [],
      sourceFindings: [...SOURCE_FINDINGS],
      priorResults,
      ...(BUSINESS_CONTEXT ? { businessContext: { current: BUSINESS_CONTEXT } } : {}),
      conversationId: lease.conversationId,
      turnId: lease.turnId,
      cubeApiUrl: env.CUBE_API_URL!,
      cubeApiSecret: env.CUBEJS_API_SECRET!,
      xeroMcpServiceUrl: xeroServiceUrl,
      xeroMcpSigningSecret: xeroSecret,
      openaiApiKey: env.OPENAI_API_KEY!,
      openaiBaseUrl: env.OPENAI_BASE_URL || undefined,
      signal: controller.signal,
      onProviderUsage: async (usage) => { record.usage = usage; },
      emit: async (event) => {
        sequence += 1;
        const at = Date.now() - t0;
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
        return { ...event, id: `ev_${question.id}_${sequence}`, sequence, occurredAt: new Date().toISOString() } as TraceEvent;
      },
    });
    record.queriesExecuted = result.queriesExecuted;
    record.answerState = result.answerState;
    if (result.answerState !== "Clarification") record.answerText = result.answerText;
  } catch (error) {
    record.failed = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }
  record.durationMs = Date.now() - started;
  if (question.golden?.length) {
    record.golden = [];
    for (const spec of question.golden) record.golden.push(await computeGolden(cube, spec, tokens));
  }
  return record;
}

let done = 0;
async function runUnit(unit: Unit, lease: Readonly<{ conversationId: string; turnId: string }>): Promise<void> {
  const prior: EvalTurnRecord[] = [];
  for (const question of unit.turns) {
    if (existing.has(question.id)) {
      // Resume: reuse the recorded turn as context for the rest of the thread.
      const previous = readJsonl<EvalTurnRecord>(resultsFile).find((r) => r.id === question.id);
      if (previous) prior.push(previous);
      done += 1;
      continue;
    }
    console.log(`[${done + 1}/${totalTurns}] START ${question.id} (${question.pattern}) "${question.question}"`);
    const record = await runTurn(question, prior, lease);
    appendJsonl(resultsFile, record);
    prior.push(record);
    done += 1;
    console.log(`[${done}/${totalTurns}] DONE  ${question.id}: state=${record.answerState ?? "FAILED"} q=${record.queries.length} charts=${record.charts.length} ${(record.durationMs / 1000).toFixed(0)}s${record.failed ? ` FAILED: ${record.failed}` : ""}`);
  }
}

let cursor = 0;
async function worker(index: number): Promise<void> {
  const lease = LEASES[index % LEASES.length]!;
  while (cursor < limited.length) {
    const unit = limited[cursor]!;
    cursor += 1;
    try {
      await runUnit(unit, lease);
    } catch (error) {
      console.error(`[eval] unit ${unit.key} crashed:`, error);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(args.concurrency, limited.length) }, (_, index) => worker(index)));
console.log(`[eval] finished ${done} turns → ${resultsFile}`);
process.exit(0);
