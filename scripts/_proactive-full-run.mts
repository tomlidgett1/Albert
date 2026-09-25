/**
 * Full Proactive test run (ADR 0113) against Ashburton Cycles, driven
 * headlessly: mirrors exactly what the browser fleet does — one real codex
 * conversation per roster agent through a local codex-runtime, every projected
 * trace event persisted, findings distilled and recorded — using the
 * control-plane RPCs under emulated authenticated claims (SET ROLE
 * albert_control_migration_owner, which owns the functions).
 *
 * Env: PROACTIVE_DB_URL (control-plane pooler URL), REPRO_SERVICE_URL
 * (codex-runtime, default 127.0.0.1:8797), PROACTIVE_CONCURRENCY (default 5).
 * Usage: node --import tsx scripts/_proactive-full-run.mts
 */
import pg from "pg";
import { ulid } from "ulid";
import {
  loadEnv,
  loadEvalBusinessContext,
  ACTIVE_CONNECTORS,
  ACTOR_ID,
  ROLE,
  SOURCE_FINDINGS,
  TENANT_ID,
} from "./albert-eval/lib.js";
import { signCubeJwt } from "../packages/albert-v3/src/cube/jwt.js";
import {
  ALBERT_CODEX_LOCAL_SIGNING_SECRET,
  ALBERT_CODEX_ANALYTICAL_RUNTIME,
  ALBERT_CODEX_ANALYSIS_TIMEOUT_MS,
  ALBERT_CODEX_PINNED_CLI_VERSION,
  ALBERT_CODEX_PROTOCOL_VERSION,
  ALBERT_CODEX_RUNTIME,
  CodexRuntimeServiceClient,
  createCodexTraceTransportState,
  projectCodexRuntimeEvent,
} from "../packages/albert-codex/src/index.js";
import { createTraceEmitter } from "../services/conversation/src/trace-emitter.js";
import type { CodexServiceTurn } from "../packages/albert-codex/src/contracts.js";
import { buildSharedAnalyticalBrief } from "../services/conversation/src/analytical-brief.js";
import {
  PROACTIVE_AGENT_ROSTER,
  PROACTIVE_MODEL,
  type ProactiveAgentDefinition,
} from "../services/proactive/src/roster.js";
import { distillProactiveAnswer } from "../services/proactive/src/distill.js";

const env = loadEnv();
const dbUrl = process.env.PROACTIVE_DB_URL;
if (!dbUrl) throw new Error("set PROACTIVE_DB_URL to the control-plane pooler URL");
const TOM_UID = "e6a1b354-ffbc-41c0-8131-d2f018dba818";
const CONCURRENCY = Number(process.env.PROACTIVE_CONCURRENCY ?? "5");
const serviceUrl = process.env.REPRO_SERVICE_URL ?? "http://127.0.0.1:8797";

const pool = new pg.Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
  max: 4,
  idleTimeoutMillis: 30_000,
});
pool.on("error", (error) => console.error("[pool]", error.message));
pool.on("connect", (client) => {
  client.on("error", (error) => console.error("[pg-client]", error.message));
});
async function initConnection(client: pg.PoolClient): Promise<void> {
  await client.query("set role albert_control_migration_owner");
  await client.query(
    "select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, false)",
    [TOM_UID],
  );
}
const initialized = new WeakSet<object>();
async function db<T = pg.QueryResult>(text: string, values?: unknown[]): Promise<pg.QueryResult> {
  const client = await pool.connect();
  try {
    if (!initialized.has(client)) {
      await initConnection(client);
      initialized.add(client);
    }
    return await client.query(text, values as never);
  } finally {
    client.release();
  }
}

const businessContext = loadEvalBusinessContext();
const client = new CodexRuntimeServiceClient(
  serviceUrl,
  env.ALBERT_CODEX_RUNTIME_SIGNING_SECRET?.trim() || ALBERT_CODEX_LOCAL_SIGNING_SECRET,
);

const runId = ulid();
console.log(`[run ${runId}] starting full proactive run: ${PROACTIVE_AGENT_ROSTER.length} agents, concurrency ${CONCURRENCY}, runtime ${serviceUrl}`);
await db("select public.albert_proactive_begin_run($1, $2, $3, $4::jsonb)", [
  runId,
  PROACTIVE_MODEL,
  "max",
  JSON.stringify(PROACTIVE_AGENT_ROSTER.map((agent) => ({
    key: agent.key,
    title: agent.title,
    tagline: agent.tagline,
  }))),
]);

const runtimeProfile = {
  provider: "openai",
  runtime: ALBERT_CODEX_RUNTIME,
  analyticalRuntime: ALBERT_CODEX_ANALYTICAL_RUNTIME,
  model: PROACTIVE_MODEL,
  reasoningEffort: "max",
  fastMode: true,
  codexCliVersion: ALBERT_CODEX_PINNED_CLI_VERSION,
  codexProtocolVersion: ALBERT_CODEX_PROTOCOL_VERSION,
  analysisTimeoutMs: ALBERT_CODEX_ANALYSIS_TIMEOUT_MS,
  kind: "proactive_research",
};

type AgentSummary = { key: string; ok: boolean; state?: string; headline?: string; error?: string; durationS: number };
const summaries: AgentSummary[] = [];

async function runAgent(agent: ProactiveAgentDefinition): Promise<void> {
  const startedAt = Date.now();
  const turnId = ulid();
  const label = `[${agent.key}]`;
  let conversationId = "";
  try {
    const begun = await db(
      "select conversation_id from public.begin_albert_turn(null, $1, $2, $3::jsonb, null, null)",
      [turnId, agent.prompt, JSON.stringify(runtimeProfile)],
    );
    conversationId = String(begun.rows[0]?.conversation_id ?? "");
    if (!conversationId) throw new Error("begin_albert_turn returned no conversation id");
    await db(
      "update control_plane.conversation_turns set lease_expires_at = clock_timestamp() + interval '45 minutes' where turn_id = $1",
      [turnId],
    );
    await db("select public.albert_assign_conversation_title($1, $2)", [
      conversationId,
      `Proactive · ${agent.title}`,
    ]).catch(() => undefined);
    await db("select public.albert_proactive_agent_started($1, $2, $3, $4)", [
      runId, agent.key, conversationId, turnId,
    ]);
    console.log(`${label} turn ${turnId} conversation ${conversationId}`);

    const cubeBearer = signCubeJwt({
      secret: env.CUBEJS_API_SECRET!,
      expiresInSeconds: 2700,
      securityContext: {
        tenant_id: TENANT_ID,
        role: ROLE,
        specialist_agent_id: "general",
        specialist_agent_version: 1,
        conversation_id: conversationId,
        turn_id: turnId,
      },
    });
    const analysisBrief = buildSharedAnalyticalBrief({
      message: agent.prompt,
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
      conversationId,
      turnId,
      message: agent.prompt,
      priorConversation: [],
      priorResults: [],
      activeConnectors: [...ACTIVE_CONNECTORS],
      connectorFreshness: [],
      ...(businessContext ? { businessContext: businessContext.rendered.slice(0, 20_000) } : {}),
      sourceFindings: JSON.stringify(SOURCE_FINDINGS).slice(0, 12_000),
      ...(analysisBrief ? { analysisBrief } : {}),
      cubeBearer,
      model: PROACTIVE_MODEL,
      effort: "max",
      fastMode: true,
    };

    let answerText = "";
    let answerState = "";
    let followUps: string[] = [];
    let persisted = 0;
    let persistFailures = 0;
    // Mirror the route: project runtime events onto the durable trace and
    // persist each accepted event exactly as appendConversationEvent does.
    let transport = createCodexTraceTransportState();
    const emit = createTraceEmitter({
      persist: async (event) => {
        try {
          await db("select public.albert_answer_event_append($1, $2, $3::jsonb)", [
            conversationId, turnId, JSON.stringify(event),
          ]);
          persisted += 1;
        } catch (error) {
          persistFailures += 1;
          if (persistFailures <= 3) {
            console.error(`${label} persist failed: ${error instanceof Error ? error.message : error}`);
          }
        }
      },
      deliver: (event) => {
        const record = event as unknown as Record<string, unknown>;
        if (record.type === "answer") {
          answerText = String(record.text ?? "");
          answerState = String(record.state ?? "");
          followUps = Array.isArray(record.followUps) ? record.followUps.map(String) : [];
        }
      },
    });
    const result = await client.runTurn(turn, async (event) => {
      const projected = projectCodexRuntimeEvent(transport, event);
      transport = projected.state;
      for (const accepted of projected.events) await emit(accepted);
      const record = event as unknown as Record<string, unknown>;
      if (record.type === "query" || record.type === "answer" || record.type === "error") {
        console.log(`${label} ${((Date.now() - startedAt) / 1000).toFixed(0)}s ${record.type}${record.type === "query" ? ` rows=${record.rowCount}` : ""}`);
      }
    });
    await emit.drain?.();
    if (!answerText) throw new Error(`turn finished without an answer (state=${result.answerState})`);

    const distilled = distillProactiveAnswer(answerText);
    await db(
      "select public.albert_proactive_agent_completed($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)",
      [
        runId, agent.key, answerState || result.answerState,
        distilled.headline, answerText.slice(0, 8_000),
        JSON.stringify(distilled.keyNumbers),
        JSON.stringify(followUps.slice(0, 6).map((q) => q.slice(0, 200))),
      ],
    );
    await db("select public.fail_albert_turn($1, $2, $3)", [
      conversationId, turnId,
      result.answerState === "Unavailable" ? "albert_codex_unavailable" : "albert_codex_answered",
    ]).catch(() => undefined);
    const durationS = (Date.now() - startedAt) / 1000;
    summaries.push({ key: agent.key, ok: true, state: answerState, headline: distilled.headline, durationS });
    console.log(`${label} DONE in ${durationS.toFixed(0)}s state=${answerState} events=${persisted} — ${distilled.headline}`);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 280) : String(error);
    const durationS = (Date.now() - startedAt) / 1000;
    summaries.push({ key: agent.key, ok: false, error: message, durationS });
    console.error(`${label} FAILED in ${durationS.toFixed(0)}s: ${message}`);
    await db("select public.albert_proactive_agent_failed($1, $2, $3)", [runId, agent.key, message.slice(0, 300)])
      .catch(() => undefined);
    if (conversationId) {
      await db("select public.fail_albert_turn($1, $2, 'codex_runtime_failure')", [conversationId, turnId])
        .catch(() => undefined);
    }
  }
}

const queue = [...PROACTIVE_AGENT_ROSTER];
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
  for (;;) {
    const agent = queue.shift();
    if (!agent) return;
    await runAgent(agent);
  }
}));

console.log("\n===== RUN SUMMARY =====");
for (const s of summaries) {
  console.log(`${s.ok ? "OK " : "ERR"} ${s.key.padEnd(22)} ${s.durationS.toFixed(0).padStart(4)}s ${s.ok ? `${s.state} — ${s.headline}` : s.error}`);
}
const panel = await db("select public.albert_proactive_panel() as panel");
const run = panel.rows[0]?.panel?.run;
console.log(`\npanel run status=${run?.status} completed=${run?.findings?.filter((f: { status: string }) => f.status === "completed").length}/${run?.findings?.length}`);
await pool.end();
