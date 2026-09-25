/**
 * Codex-harness eval runner (companion to run.mts, which drives albert-v3).
 *
 * Drives the codex-runtime service job API with production-shaped turns for
 * Ashburton Cycles: one freshly minted control-plane lease per question (so
 * per-turn Cube cold start is measured exactly as production pays it). The
 * subscription300 corpus is locked to ChatGPT auth + Luna + Max + Fast.
 *
 * Requires a private codex-runtime instance (never the shared --watch one):
 *   PORT=8799 ALBERT_CODEX_MAX_CONCURRENT_TURNS=6 \
 *     node --env-file=.env.local --import tsx services/codex-runtime/src/main.ts
 *
 * Usage:
 *   npx tsx scripts/albert-eval/run-codex.mts --run codex-baseline
 *   npx tsx scripts/albert-eval/run-codex.mts --run smoke --ids CE-01,CA-01
 *   npx tsx scripts/albert-eval/run-codex.mts --run subscription-300 \
 *     --corpus subscription300 --auth chatgpt --fast --resume
 * Options: --concurrency N (default 4), --timeout-ms (default 780000),
 *   --limit N, --resume, --fast, --service-url URL (default 127.0.0.1:8799).
 *
 * Results append to evals/albert/runs/<run>/results.jsonl (EvalTurnRecord
 * rows — grade.mts and report.mts consume them unchanged); raw runtime events
 * per turn go to evals/albert/runs/<run>/events/<id>.jsonl.
 */
import path from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import pg from "pg";
import { ulid } from "ulid";
import { signCubeJwt } from "../../packages/albert-v3/src/cube/jwt.js";
import {
  ALBERT_CODEX_LOCAL_SIGNING_SECRET,
  CodexRuntimeServiceClient,
  assertCodexChatGPTLogin,
  assertPinnedCodexVersion,
  codexChildEnvironment,
  createCodexTraceTransportState,
  projectCodexRuntimeEvent,
  resolveCodexBinary,
  runCodexSemanticTurn,
} from "../../packages/albert-codex/src/index.js";
import type { CodexServiceTurn } from "../../packages/albert-codex/src/contracts.js";
import { buildSharedAnalyticalBrief } from "../../services/conversation/src/analytical-brief.js";
import {
  prepareSuperAgentPasses,
  superAgentPlan,
} from "../../services/swarm/src/super-agent.js";
import { CODEX_300_QUESTIONS } from "./questions-codex-300.js";
import { CODEX_QUESTIONS } from "./questions-codex-bikeshop.js";
import { CODEX_HARD100_QUESTIONS } from "./questions-codex-hard100.js";
import type { EvalQuestion } from "./questions.js";
import { subscriptionAuthentication } from "./subscription-auth.js";
import {
  ACTIVE_CONNECTORS,
  ACTOR_ID,
  ROLE,
  SOURCE_FINDINGS,
  TENANT_ID,
  appendJsonl,
  codexPriorResultsFromRecords,
  computeGolden,
  conversationFromPriorTurns,
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
  superAgentQuestion?: string;
  startSuperPass?: number;
  concurrency: number;
  timeoutMs: number;
  limit?: number;
  resume: boolean;
  fastMode: boolean;
  serviceUrl: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  corpus: "codex56" | "subscription300" | "hard100";
  authMode: "api" | "chatgpt";
  transport: "service" | "in-process";
  workerStaggerMs: number;
  solPlanner: boolean;
  proMode: boolean;
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
    corpus: "codex56",
    authMode: "api",
    transport: "service",
    workerStaggerMs: 0,
    solPlanner: false,
    proMode: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const next = () => argv[++i]!;
    if (a === "--run") args.run = next();
    else if (a === "--ids") args.ids = new Set(next().split(",").map((s) => s.trim()).filter(Boolean));
    else if (a === "--question") args.question = next();
    else if (a === "--super-agent-question") args.superAgentQuestion = next();
    else if (a === "--start-super-pass") args.startSuperPass = Number(next());
    else if (a === "--concurrency") args.concurrency = Number(next());
    else if (a === "--timeout-ms") args.timeoutMs = Number(next());
    else if (a === "--limit") args.limit = Number(next());
    else if (a === "--resume") args.resume = true;
    else if (a === "--fast") args.fastMode = true;
    else if (a === "--service-url") args.serviceUrl = next();
    else if (a === "--model") args.model = next();
    else if (a === "--effort") args.effort = next() as Args["effort"];
    else if (a === "--corpus") args.corpus = next() as Args["corpus"];
    else if (a === "--auth") args.authMode = next() as Args["authMode"];
    else if (a === "--transport") args.transport = next() as Args["transport"];
    else if (a === "--worker-stagger-ms") args.workerStaggerMs = Number(next());
    else if (a === "--sol-planner") args.solPlanner = true;
    else if (a === "--pro") args.proMode = true;
  }
  if (args.corpus !== "codex56" && args.corpus !== "subscription300" && args.corpus !== "hard100") {
    throw new Error("--corpus must be codex56, subscription300 or hard100");
  }
  if (args.authMode !== "api" && args.authMode !== "chatgpt") {
    throw new Error("--auth must be api or chatgpt");
  }
  if (args.transport !== "service" && args.transport !== "in-process") {
    throw new Error("--transport must be service or in-process");
  }
  if (!Number.isFinite(args.workerStaggerMs) || args.workerStaggerMs < 0 || args.workerStaggerMs > 30_000) {
    throw new Error("--worker-stagger-ms must be between 0 and 30000");
  }
  if (args.question && args.superAgentQuestion) {
    throw new Error("--question and --super-agent-question are mutually exclusive");
  }
  if (args.superAgentQuestion) args.solPlanner = true;
  if (args.proMode && args.authMode !== "api") {
    throw new Error("--pro requires --auth api");
  }
  if (args.startSuperPass !== undefined && (
    !Number.isInteger(args.startSuperPass)
    || args.startSuperPass < 1
    || args.startSuperPass > 5
    || !args.superAgentQuestion
  )) {
    throw new Error("--start-super-pass requires --super-agent-question and a pass from 1 to 5");
  }
  if (args.corpus === "subscription300" && (
    args.authMode !== "chatgpt"
    || args.model !== "gpt-5.6-luna"
    || args.effort !== "max"
    || !args.fastMode
  )) {
    throw new Error("subscription300 requires --auth chatgpt --model gpt-5.6-luna --effort max --fast");
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const env = loadEnv();
if (!env.CUBEJS_API_SECRET) throw new Error("CUBEJS_API_SECRET missing");
const subscriptionCodexHome = process.env.ALBERT_CODEX_CHATGPT_HOME?.trim()
  || process.env.CODEX_HOME?.trim()
  || path.join(homedir(), ".codex");
let resolvedInProcessBinary: string | undefined;

async function assertRuntimeAuthentication(): Promise<void> {
  if (args.transport === "in-process") {
    if (args.authMode !== "chatgpt") {
      throw new Error("In-process eval transport is restricted to ChatGPT subscription auth.");
    }
    if (!path.isAbsolute(subscriptionCodexHome)) {
      throw new Error("ChatGPT-authenticated Codex home must be absolute.");
    }
    const environment = codexChildEnvironment({ codexHome: subscriptionCodexHome });
    resolvedInProcessBinary = await resolveCodexBinary(
      process.env.ALBERT_CODEX_BINARY_PATH?.trim() || undefined,
    );
    const runtime = await assertPinnedCodexVersion(resolvedInProcessBinary, environment);
    await assertCodexChatGPTLogin({
      binaryPath: resolvedInProcessBinary,
      codexHome: subscriptionCodexHome,
      environment,
      cwd: process.cwd(),
    });
    console.log(`[codex-eval] runtime=${runtime} auth=chatgpt transport=in-process`);
    return;
  }
  const response = await fetch(`${args.serviceUrl.replace(/\/+$/u, "")}/readyz`, {
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null) as null | {
    ready?: boolean;
    authenticationMode?: string;
    runtime?: string;
  };
  if (!response.ok || payload?.ready !== true) {
    throw new Error(`Codex runtime is not ready (${response.status}).`);
  }
  if (payload.authenticationMode !== args.authMode) {
    throw new Error(
      `Codex runtime auth mismatch: requested ${args.authMode}, runtime reports ${payload.authenticationMode ?? "unknown"}.`,
    );
  }
  if (args.authMode === "chatgpt" && payload.authenticationMode !== "chatgpt") {
    throw new Error("Subscription evaluation refused an API-authenticated Codex runtime.");
  }
  console.log(`[codex-eval] runtime=${payload.runtime ?? "unknown"} auth=${payload.authenticationMode}`);
}

await assertRuntimeAuthentication();

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
const client = args.transport === "service"
  ? new CodexRuntimeServiceClient(
      args.serviceUrl,
      env.ALBERT_CODEX_RUNTIME_SIGNING_SECRET?.trim() || ALBERT_CODEX_LOCAL_SIGNING_SECRET,
    )
  : null;

const dir = runDir(args.run);
const eventsDir = path.join(dir, "events");
mkdirSync(eventsDir, { recursive: true });
const resultsFile = path.join(dir, "results.jsonl");
const priorRunRecords = args.resume || args.startSuperPass !== undefined
  ? readJsonl<EvalTurnRecord>(resultsFile)
  : [];
const existingRecords = new Map<string, EvalTurnRecord>();
// Resume retries failed/aborted turns. Only a completed record can satisfy a
// corpus id or provide trusted context to the rest of its thread.
for (const record of priorRunRecords) {
  if (!record.failed) existingRecords.set(record.id, record);
}
const existing = new Set(existingRecords.keys());
let engineVersion = "unknown";
try { engineVersion = execSync("git rev-parse --short HEAD").toString().trim(); } catch { /* ignore */ }
engineVersion = `codex-${engineVersion}${process.env.EVAL_ENGINE_LABEL ? `+${process.env.EVAL_ENGINE_LABEL}` : ""}`;

const corpus: readonly EvalQuestion[] = args.corpus === "subscription300"
  ? CODEX_300_QUESTIONS
  : args.corpus === "hard100"
    ? CODEX_HARD100_QUESTIONS
    : CODEX_QUESTIONS;
const allSuperAgentQuestions: EvalQuestion[] | null = args.superAgentQuestion
  ? prepareSuperAgentPasses(
      superAgentPlan({ timezone: "Australia/Melbourne" }),
      args.superAgentQuestion,
    ).map((pass, index) => ({
      id: `SUPER-${String(index + 1).padStart(2, "0")}`,
      tier: "xhard" as const,
      scope: "multi" as const,
      surface: "cross" as const,
      pattern: index === 0 ? "cold" as const : "followup" as const,
      question: pass.prompt,
      thread: "SUPER-AGENT",
      turn: index + 1,
      expect: pass.tagline,
      format: "any" as const,
    }))
  : null;
const superAgentQuestions = allSuperAgentQuestions?.filter((question) => (
  (question.turn ?? 1) >= (args.startSuperPass ?? 1)
)) ?? null;
let selected: EvalQuestion[] = superAgentQuestions ?? (args.question
  ? [{
    id: "ADHOC",
    tier: "easy",
    scope: "deputy",
    surface: "staff_labour",
    pattern: "cold",
    question: args.question,
  }]
  : corpus.filter((question) => !args.ids || args.ids.has(question.id)));
if (args.ids) {
  const selectedThreads = new Set(selected.flatMap((question) => question.thread ? [question.thread] : []));
  selected = corpus.filter((question) => (
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
const runnableCount = selected.filter((question) => !existing.has(question.id)).length;
console.log(`[codex-eval] run=${args.run} corpus=${args.corpus} engine=${engineVersion} model=${args.model} effort=${args.effort} fast=${args.fastMode} solPlanner=${args.solPlanner} pro=${args.proMode} auth=${args.authMode} transport=${args.transport} service=${args.serviceUrl} turns=${runnableCount}/${selected.length} units=${selectedUnits.length} concurrency=${args.concurrency}`);

type Lease = { conversationId: string; turnId: string };

async function mintLease(question: EvalQuestion, existingConversationId?: string): Promise<Lease> {
  if (existingConversationId) {
    // A killed runner strands its in-flight turn as 'running' for the whole
    // 45-minute eval lease, and begin_albert_turn refuses the thread's next
    // turn while one is live. The runner is the only writer for its own eval
    // conversations, so any running row here is an orphan — settle it.
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
    solPlanner: args.solPlanner,
    reasoningMode: args.proMode ? "pro" : "standard",
    kind: "codex_eval",
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
    answerState === "Unavailable" || !answerState ? "albert_codex_unavailable" : "albert_codex_answered",
  ]).catch(() => undefined);
}

const cube = createEvalCube(env);

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
    authenticationMode: args.authMode,
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
    const analysisBrief = buildSharedAnalyticalBrief({
      message: question.question,
      activeConnectors: [...ACTIVE_CONNECTORS],
      connectorFreshness: [],
      includeGeneric: true,
    });
    const history = conversationFromPriorTurns(prior, question.question).slice(0, -1).map((message) => ({
      role: message.role as "user" | "assistant",
      text: String(message.text ?? "").slice(0, 8_000),
    }));
    const turn: CodexServiceTurn = {
      protocolVersion: 1,
      requestId: ulid(),
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      role: ROLE,
      conversationId: lease.conversationId,
      turnId: lease.turnId,
      message: question.question,
      priorConversation: history.slice(-12),
      priorResults: codexPriorResultsFromRecords(prior),
      activeConnectors: [...ACTIVE_CONNECTORS],
      connectorFreshness: [],
      ...(BUSINESS_CONTEXT ? { businessContext: BUSINESS_CONTEXT.rendered.slice(0, 20_000) } : {}),
      sourceFindings: JSON.stringify(SOURCE_FINDINGS).slice(0, 12_000),
      ...(analysisBrief ? { analysisBrief } : {}),
      cubeBearer,
      model: args.model,
      effort: args.effort,
      fastMode: args.fastMode,
      ...(args.solPlanner ? { solPlanner: true } : {}),
      ...(args.proMode ? { reasoningMode: "pro" as const } : {}),
    };
    let transport = createCodexTraceTransportState();
    const receiveEvent = async (raw: Parameters<typeof projectCodexRuntimeEvent>[1]) => {
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
    };
    const result = args.transport === "service"
      ? await client!.runTurn(
          turn,
          receiveEvent,
          controller.signal,
          async (event) => {
            appendJsonl(eventsFile, {
              atMs: Date.now() - t0,
              type: "query_audit",
              event,
            });
          },
        )
      : await runCodexSemanticTurn({
          turn,
          cubeApiUrl: env.CUBE_API_URL!,
          authentication: subscriptionAuthentication(subscriptionCodexHome),
          codexBinaryPath: resolvedInProcessBinary,
          signal: controller.signal,
          emit: receiveEvent,
        });
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

const TRANSIENT = /overloaded|429|rate limit|usage limit|fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|another turn is already running/iu;

let done = 0;
const queue = [...selectedUnits];
async function runUnit(unit: Unit): Promise<void> {
  const prior: EvalTurnRecord[] = args.startSuperPass !== undefined
    ? priorRunRecords
      .filter((record) => record.thread === "SUPER-AGENT" && (record.turn ?? 0) < args.startSuperPass!)
      .sort((left, right) => (left.turn ?? 0) - (right.turn ?? 0))
    : [];
  let conversationId: string | undefined = prior.at(-1)?.conversationId;
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
      console.log(`[codex-eval] ${question.id} transient/subscription-limit failure (${attempt.record.failed}); retrying once in 20s`);
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      attempt = await runTurnOnce(question, prior, attempt.conversationId ?? conversationId);
    }
    const { record } = attempt;
    appendJsonl(resultsFile, record);
    prior.push(record);
    conversationId = attempt.conversationId ?? conversationId;
    done += 1;
    console.log(`[${done}/${selected.length}] DONE  ${question.id}: state=${record.answerState ?? "FAILED"} q=${record.queries.length} charts=${record.charts.length} ${(record.durationMs / 1000).toFixed(0)}s${record.failed ? ` FAILED: ${record.failed.slice(0, 160)}` : ""}`);
  }
}

async function worker(index: number): Promise<void> {
  if (index > 0 && args.workerStaggerMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, index * args.workerStaggerMs));
  }
  for (;;) {
    const unit = queue.shift();
    if (!unit) return;
    try {
      await runUnit(unit);
    } catch (error) {
      console.error(`[codex-eval] unit ${unit.key} crashed:`, error);
    }
  }
}

await Promise.all(Array.from(
  { length: Math.min(args.concurrency, selectedUnits.length) },
  (_, index) => worker(index),
));
console.log(`[codex-eval] finished ${done}/${selected.length} turns → ${resultsFile}`);
await pool.end();
process.exit(0);
