/**
 * Omni-harness eval runner (companion to run-codex.mts).
 *
 * Drives the agent-runtime service's /v1/omni job API with production-shaped
 * turns for Ashburton Cycles: one freshly minted control-plane lease per
 * question so per-turn Cube cold start is measured exactly as production
 * pays it.
 *
 * Requires a private runtime instance (never the shared --watch one):
 *   PORT=8799 node --env-file=.env.local --import tsx services/codex-runtime/src/main.ts
 *
 * Usage:
 *   npx tsx scripts/albert-eval/run-omni.mts --run omni-acceptance
 *   npx tsx scripts/albert-eval/run-omni.mts --run smoke --ids OM-LS-01
 *   npx tsx scripts/albert-eval/run-omni.mts --run adhoc --question "How were sales last week?"
 * Options: --concurrency N (default 3), --timeout-ms (default 780000),
 *   --limit N, --resume, --fast, --model, --effort, --service-url URL.
 *
 * Results append to evals/albert/runs/<run>/results.jsonl; raw runtime events
 * per turn go to evals/albert/runs/<run>/events/<id>.jsonl.
 */
import path from "node:path";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import pg from "pg";
import { ulid } from "ulid";
import { signCubeJwt } from "../../packages/albert-v3/src/cube/jwt.js";
import { ALBERT_CODEX_LOCAL_SIGNING_SECRET } from "../../packages/albert-codex/src/contracts.js";
import {
  OmniRuntimeServiceClient,
  type OmniServiceTurn,
  type OmniTraceEventInput,
} from "../../packages/albert-omni/src/index.js";
import { OMNI_20_QUESTIONS } from "./questions-omni-20.js";
import type { EvalQuestion } from "./questions.js";
import {
  ACTIVE_CONNECTORS,
  ACTOR_ID,
  ROLE,
  TENANT_ID,
  appendJsonl,
  computeGolden,
  createEvalCube,
  dateTokens,
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
    run: "omni-adhoc",
    concurrency: 3,
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

async function assertRuntimeReady(): Promise<void> {
  const response = await fetch(`${args.serviceUrl.replace(/\/+$/u, "")}/readyz`, {
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null) as null | {
    ready?: boolean;
    authenticationMode?: string;
  };
  if (!response.ok || payload?.ready !== true) {
    throw new Error(`The agent runtime is not ready (${response.status}).`);
  }
  console.log(`[omni-eval] runtime ready auth=${payload.authenticationMode ?? "unknown"}`);
}

await assertRuntimeReady();

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

const pool = new pg.Pool({
  connectionString: leaseDbUrl(),
  ssl: { rejectUnauthorized: false },
  max: Math.min(Math.max(args.concurrency, 3), 8),
  idleTimeoutMillis: 30_000,
});
pool.on("error", (error) => console.error("[pool]", error.message));
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
const eventsDir = path.join(dir, "events");
mkdirSync(eventsDir, { recursive: true });
const resultsFile = path.join(dir, "results.jsonl");
const priorRunRecords = args.resume ? readJsonl<EvalTurnRecord>(resultsFile) : [];
const existingRecords = new Map<string, EvalTurnRecord>();
for (const record of priorRunRecords) {
  if (!record.failed) existingRecords.set(record.id, record);
}
let engineVersion = "unknown";
try { engineVersion = execSync("git rev-parse --short HEAD").toString().trim(); } catch { /* ignore */ }
engineVersion = `omni-${engineVersion}${process.env.EVAL_ENGINE_LABEL ? `+${process.env.EVAL_ENGINE_LABEL}` : ""}`;

let selected: EvalQuestion[] = args.question
  ? [{
    id: "ADHOC",
    tier: "easy",
    scope: "lightspeed",
    surface: "sales",
    pattern: "cold",
    question: args.question,
  }]
  : OMNI_20_QUESTIONS.filter((question) => !args.ids || args.ids.has(question.id));
if (args.ids) {
  const selectedThreads = new Set(selected.flatMap((question) => question.thread ? [question.thread] : []));
  selected = OMNI_20_QUESTIONS.filter((question) => (
    args.ids!.has(question.id)
    || Boolean(question.thread && selectedThreads.has(question.thread))
  ));
}

type Unit = { key: string; turns: EvalQuestion[] };
const units: Unit[] = [];
const byThread = new Map<string, EvalQuestion[]>();
for (const question of selected) {
  if (!question.thread) {
    units.push({ key: question.id, turns: [question] });
    continue;
  }
  const turns = byThread.get(question.thread) ?? [];
  turns.push(question);
  byThread.set(question.thread, turns);
}
for (const [thread, turns] of byThread) {
  units.push({ key: thread, turns: turns.sort((left, right) => (left.turn ?? 0) - (right.turn ?? 0)) });
}
units.sort((left, right) => (right.turns.length - left.turns.length) || left.key.localeCompare(right.key));
const selectedUnits = args.limit ? units.slice(0, args.limit) : units;
selected = selectedUnits.flatMap((unit) => unit.turns);
const runnableCount = selected.filter((question) => !existingRecords.has(question.id)).length;
console.log(`[omni-eval] run=${args.run} engine=${engineVersion} model=${args.model} effort=${args.effort} fast=${args.fastMode} service=${args.serviceUrl} turns=${runnableCount}/${selected.length} units=${selectedUnits.length} concurrency=${args.concurrency}`);

type Lease = { conversationId: string; turnId: string };

async function mintLease(question: EvalQuestion, existingConversationId?: string): Promise<Lease> {
  if (existingConversationId) {
    await db(
      `update control_plane.conversation_turns
          set status = 'failed',
              result_digest = coalesce(result_digest, 'albert_eval_abandoned'),
              completed_at = now()
        where conversation_id = $1 and status = 'running'`,
      [existingConversationId],
    ).catch(() => undefined);
  }
  const turnId = ulid();
  const runtimeProfile = {
    provider: "openai",
    model: args.model,
    reasoningEffort: args.effort,
    fastMode: args.fastMode,
    runtime: "omni-agent",
    analyticalRuntime: "cube-omni-v1",
    kind: "omni_eval",
  };
  const begun = await db(
    "select conversation_id from public.begin_albert_turn($1, $2, $3, $4::jsonb, null, null)",
    [existingConversationId ?? null, turnId, question.question, JSON.stringify(runtimeProfile)],
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
    answerState === "Unavailable" || !answerState ? "albert_omni_unavailable" : "albert_omni_answered",
  ]).catch(() => undefined);
}

const cube = createEvalCube(env);

function conversationFromRecords(prior: readonly EvalTurnRecord[]): Array<{ role: "user" | "assistant"; text: string }> {
  const history: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const record of prior) {
    history.push({ role: "user", text: record.question.slice(0, 24_000) });
    if (record.answerText) history.push({ role: "assistant", text: record.answerText.slice(0, 24_000) });
  }
  return history.slice(-12);
}

type TurnAttempt = Readonly<{ record: EvalTurnRecord; conversationId?: string }>;

async function runTurnOnce(
  question: EvalQuestion,
  prior: readonly EvalTurnRecord[],
  existingConversationId?: string,
): Promise<TurnAttempt> {
  const startedAt = new Date();
  const tokens = dateTokens(startedAt);
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
    specialistAgentId: "general",
    model: args.model,
    reasoningEffort: args.effort,
    fastMode: args.fastMode,
    authenticationMode: "api",
  };
  const eventsFile = path.join(eventsDir, `${question.id}.jsonl`);
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("eval timeout")), args.timeoutMs);
  let lease: Lease | undefined;
  try {
    lease = await mintLease(question, existingConversationId);
    record.conversationId = lease.conversationId;
    record.turnId = lease.turnId;
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
    const turn: OmniServiceTurn = {
      protocolVersion: 1,
      requestId: ulid(),
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      role: ROLE,
      conversationId: lease.conversationId,
      turnId: lease.turnId,
      message: question.question,
      priorConversation: conversationFromRecords(prior),
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
    };
    const receiveEvent = async (event: OmniTraceEventInput) => {
      const at = Date.now() - t0;
      appendJsonl(eventsFile, { atMs: at, ...event });
      if (record.phases.classifiedMs === undefined) record.phases.classifiedMs = at;
      switch (event.type) {
        case "progress":
          record.progress.push(`${(at / 1000).toFixed(1)}s ${event.status} ${event.stage ?? ""} · ${event.label}${event.detail ? ` · ${event.detail}` : ""}`);
          break;
        case "narrative":
          record.narratives.push(event.text);
          break;
        case "tasks":
          record.plan = event.items;
          record.progress.push(`${(at / 1000).toFixed(1)}s tasks · ${event.items.filter((item) => item.completed).length}/${event.items.length}`);
          break;
        case "research":
          record.progress.push(`${(at / 1000).toFixed(1)}s research ${event.tool} · ${event.label}${event.summary ? ` · ${event.summary}` : ""}`);
          break;
        case "query":
          if (record.phases.firstQueryMs === undefined) record.phases.firstQueryMs = at;
          record.phases.lastQueryMs = at;
          record.queries.push({
            topic: event.name ? `${event.name} (${event.topic})` : event.topic,
            view: event.view,
            connector: event.connector,
            rowCount: event.rowCount,
            queryYaml: event.queryYaml,
            timeRange: event.timeRange.label,
            executionMs: event.executionMs,
          });
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
          record.charts.push({
            chartType: event.chartType,
            caption: event.caption,
            dataRef: event.dataRef,
            xKey: event.xKey,
            yKey: event.yKey,
            ...(event.orientation ? { orientation: event.orientation } : {}),
            ...(event.series?.length ? { series: event.series.map((s) => s.key) } : {}),
          });
          break;
        case "answer":
          record.phases.answerMs = at;
          record.answerState = event.state;
          record.answerText = event.text;
          record.followUps = event.followUps;
          record.presentedResultIds = event.presentedResultIds;
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
    };
    const result = await client.runTurn(
      turn,
      receiveEvent,
      controller.signal,
      async (event) => {
        appendJsonl(eventsFile, { atMs: Date.now() - t0, type: "query_audit", event });
      },
    );
    record.queriesExecuted = result.queriesExecuted;
    if (!record.answerState) record.answerState = result.answerState;
  } catch (error) {
    record.failed = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } finally {
    clearTimeout(timer);
    record.durationMs = Date.now() - t0;
    if (lease) await completeLease(lease, record.failed ? undefined : record.answerState);
  }
  if (question.golden?.length) {
    record.golden = [];
    for (const spec of question.golden) record.golden.push(await computeGolden(cube, spec, tokens));
  }
  return { record, ...(lease ? { conversationId: lease.conversationId } : {}) };
}

const TRANSIENT = /overloaded|429|rate limit|fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|another turn is already running/iu;

let done = 0;
const queue = [...selectedUnits];
async function runUnit(unit: Unit): Promise<void> {
  const prior: EvalTurnRecord[] = [];
  let conversationId: string | undefined;
  for (const question of unit.turns) {
    const previous = existingRecords.get(question.id);
    if (previous) {
      prior.push(previous);
      conversationId = previous.conversationId ?? conversationId;
      done += 1;
      continue;
    }
    console.log(`[${done + 1}/${selected.length}] START ${question.id} (${question.pattern}/${question.tier}) "${question.question.slice(0, 80)}"`);
    let attempt = await runTurnOnce(question, prior, conversationId);
    if (attempt.record.failed && TRANSIENT.test(attempt.record.failed)) {
      console.log(`[omni-eval] ${question.id} transient failure (${attempt.record.failed}); retrying once in 20s`);
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      attempt = await runTurnOnce(question, prior, attempt.conversationId ?? conversationId);
    }
    const { record } = attempt;
    appendJsonl(resultsFile, record);
    prior.push(record);
    conversationId = attempt.conversationId ?? conversationId;
    done += 1;
    const latency = [
      record.phases.firstQueryMs !== undefined ? `q1=${(record.phases.firstQueryMs / 1000).toFixed(1)}s` : null,
      record.phases.answerMs !== undefined ? `ans=${(record.phases.answerMs / 1000).toFixed(1)}s` : null,
    ].filter(Boolean).join(" ");
    console.log(`[${done}/${selected.length}] DONE  ${question.id}: state=${record.answerState ?? "FAILED"} q=${record.queries.length} ${latency} total=${(record.durationMs / 1000).toFixed(0)}s${record.failed ? ` FAILED: ${record.failed.slice(0, 160)}` : ""}`);
  }
}

async function worker(): Promise<void> {
  for (;;) {
    const unit = queue.shift();
    if (!unit) return;
    try {
      await runUnit(unit);
    } catch (error) {
      console.error(`[omni-eval] unit ${unit.key} crashed:`, error);
    }
  }
}

await Promise.all(Array.from(
  { length: Math.min(args.concurrency, selectedUnits.length) },
  () => worker(),
));
console.log(`[omni-eval] finished ${done}/${selected.length} turns → ${resultsFile}`);
await pool.end();
process.exit(0);
