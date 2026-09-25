/**
 * Omni-swarm quality harness: mirrors the browser fleet server-side so the
 * full chain — planner → omni workers (waves, briefs) → synthesis — can be
 * exercised and graded against the private runtime without a browser session.
 *
 * Requires the private runtime (PORT=8799, api auth) and .env.local.
 *
 * Usage:
 *   npx tsx scripts/albert-eval/run-omni-swarm.mts --run omni-swarm-1 \
 *     --question "Where am I losing money right now?"
 */
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";
import { ulid } from "ulid";
import { signCubeJwt } from "../../packages/albert-v3/src/cube/jwt.js";
import { ALBERT_CODEX_LOCAL_SIGNING_SECRET } from "../../packages/albert-codex/src/contracts.js";
import {
  OmniRuntimeServiceClient,
  type OmniServiceTurn,
  type OmniTraceEventInput,
} from "../../packages/albert-omni/src/index.js";
import { allocateSwarmPlan, prepareSwarmAgents, SWARM_CLIENT_CONCURRENCY } from "../../services/swarm/src/planner.js";
import {
  appendSwarmBrief,
  buildSwarmWaveBrief,
  splitSwarmWaves,
} from "../../services/swarm/src/worker-brief.js";
import { buildSwarmSynthesis, type SwarmSynthesisFinding } from "../../services/swarm/src/synthesis.js";
import { distillProactiveAnswer } from "../../services/proactive/src/distill.js";
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

type Args = { run: string; question: string; serviceUrl: string; timeoutMs: number };

function parseArgs(argv: string[]): Args {
  const args: Args = {
    run: "omni-swarm-adhoc",
    question: "Where am I losing money right now?",
    serviceUrl: process.env.REPRO_SERVICE_URL ?? "http://127.0.0.1:8799",
    timeoutMs: 780_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const next = () => argv[++i]!;
    if (a === "--run") args.run = next();
    else if (a === "--question") args.question = next();
    else if (a === "--service-url") args.serviceUrl = next();
    else if (a === "--timeout-ms") args.timeoutMs = Number(next());
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
mkdirSync(path.join(dir, "events"), { recursive: true });

async function mintLease(label: string): Promise<{ conversationId: string; turnId: string }> {
  const turnId = ulid();
  const begun = await db(
    "select conversation_id from public.begin_albert_turn($1, $2, $3, $4::jsonb, null, null)",
    [null, turnId, label.slice(0, 2000), JSON.stringify({
      provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "max", fastMode: false,
      runtime: "omni-agent", analyticalRuntime: "cube-omni-v1", kind: "omni_swarm_eval",
    })],
  );
  const conversationId = String(begun.rows[0]?.conversation_id ?? "");
  if (!conversationId) throw new Error("begin_albert_turn returned no conversation id");
  await db(
    "update control_plane.conversation_turns set lease_expires_at = clock_timestamp() + interval '45 minutes' where turn_id = $1",
    [turnId],
  );
  await db("select public.albert_assign_conversation_title($1, $2)", [
    conversationId, `Eval · ${args.run} · worker`,
  ]).catch(() => undefined);
  return { conversationId, turnId };
}

async function runWorker(agent: Readonly<{ key: string; title: string; role: string; prompt: string }>): Promise<SwarmSynthesisFinding> {
  const t0 = Date.now();
  const lease = await mintLease(agent.prompt);
  const cubeBearer = signCubeJwt({
    secret: env.CUBEJS_API_SECRET!,
    expiresInSeconds: 2_700,
    securityContext: {
      tenant_id: TENANT_ID, role: ROLE, specialist_agent_id: "general", specialist_agent_version: 1,
      conversation_id: lease.conversationId, turn_id: lease.turnId,
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
    message: agent.prompt,
    priorConversation: [],
    activeConnectors: [...ACTIVE_CONNECTORS],
    connectorFreshness: [],
    ...(BUSINESS_CONTEXT ? { businessContext: BUSINESS_CONTEXT.rendered.slice(0, 20_000) } : {}),
    timezone: "Australia/Melbourne",
    organisationName: "Ashburton Cycles",
    cubeBearer,
    model: "gpt-5.6-luna",
    effort: "max",
    fastMode: false,
  };
  let answer = "";
  let answerState: string | null = null;
  let queries = 0;
  const eventsFile = path.join(dir, "events", `${agent.key}.jsonl`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("worker timeout")), args.timeoutMs);
  try {
    await client.runTurn(turn, async (event: OmniTraceEventInput) => {
      appendJsonl(eventsFile, { atMs: Date.now() - t0, ...event });
      if (event.type === "query") queries += 1;
      if (event.type === "answer") { answer = event.text; answerState = event.state; }
    }, controller.signal, async () => undefined);
  } finally {
    clearTimeout(timer);
    await db("select public.fail_albert_turn($1, $2, $3)", [
      lease.conversationId, lease.turnId,
      answer ? "albert_omni_answered" : "albert_omni_unavailable",
    ]).catch(() => undefined);
  }
  const distilled = answer ? distillProactiveAnswer(answer) : null;
  const seconds = Math.round((Date.now() - t0) / 1000);
  console.log(`  [worker ${agent.key}] ${answer ? answerState : "FAILED"} q=${queries} ${seconds}s`);
  return {
    agentKey: agent.key,
    title: agent.title,
    role: agent.role,
    answerState,
    headline: distilled?.headline ?? null,
    keyNumbers: distilled?.keyNumbers ?? [],
    summaryExcerpt: answer.slice(0, 2_000),
    failed: !answer,
    failureNote: answer ? null : "worker produced no answer",
  };
}

const ready = await fetch(`${args.serviceUrl.replace(/\/+$/u, "")}/readyz`).then((r) => r.json()) as { ready?: boolean };
if (ready.ready !== true) throw new Error("runtime not ready");

console.log(`[omni-swarm] planning: "${args.question}"`);
const allocation = await allocateSwarmPlan({
  question: args.question,
  connectors: [...ACTIVE_CONNECTORS],
  businessContextExcerpt: BUSINESS_CONTEXT?.rendered,
  timezone: "Australia/Melbourne",
  apiKey,
  baseUrl,
  safetyIdentifier: createHash("sha256").update(`${TENANT_ID}:${ACTOR_ID}`).digest("hex"),
});
const agents = prepareSwarmAgents(allocation.plan, args.question);
console.log(`[omni-swarm] plan source=${allocation.source} period="${allocation.plan.periodLabel}" agents=${agents.length}: ${agents.map((a) => `${a.key}(${a.role})`).join(", ")}`);

const { firstWave, secondWave } = splitSwarmWaves(agents);
const findings: SwarmSynthesisFinding[] = [];
const queue = [...firstWave];
const workers = Array.from({ length: Math.min(SWARM_CLIENT_CONCURRENCY, firstWave.length) }, async () => {
  for (;;) {
    const agent = queue.shift();
    if (!agent) return;
    findings.push(await runWorker(agent));
  }
});
await Promise.all(workers);

if (secondWave.length > 0) {
  const brief = buildSwarmWaveBrief(findings.map((finding) => ({
    title: finding.title,
    headline: finding.headline,
    answerState: finding.answerState,
    keyNumbers: finding.keyNumbers,
    failed: finding.failed,
  })));
  for (const agent of secondWave) {
    findings.push(await runWorker({ ...agent, prompt: appendSwarmBrief(agent.prompt, brief) }));
  }
}

console.log(`[omni-swarm] synthesising over ${findings.length} findings…`);
const synthesis = await buildSwarmSynthesis({
  question: args.question,
  periodLabel: allocation.plan.periodLabel,
  period: allocation.plan.period ?? null,
  businessName: "Ashburton Cycles",
  findings,
  apiKey,
  baseUrl,
  safetyIdentifier: createHash("sha256").update(`${TENANT_ID}:${ACTOR_ID}`).digest("hex"),
});

const out = {
  question: args.question,
  plan: { periodLabel: allocation.plan.periodLabel, source: allocation.source },
  findings: findings.map(({ summaryExcerpt, ...rest }) => ({ ...rest, summaryChars: summaryExcerpt.length })),
  synthesis: synthesis.synthesis,
  synthesisSource: synthesis.source,
  unsupportedFigures: synthesis.unsupportedFigures,
};
writeFileSync(path.join(dir, "swarm-result.json"), JSON.stringify(out, null, 2));
console.log(`[omni-swarm] synthesis source=${synthesis.source} headline="${synthesis.synthesis.headline}" followUps=${synthesis.synthesis.followUps.length}`);
console.log("---- synthesis answer ----");
console.log(synthesis.synthesis.answer);
await pool.end();
process.exit(0);
