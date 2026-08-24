/**
 * Drives the local codex-runtime service (job API on 127.0.0.1:8792) exactly
 * as app/api/codex-conversation/route.ts does, with the failing prompt.
 * Usage: node --import tsx scripts/_repro-codex-service.mts [runs]
 */
import { appendFileSync } from "node:fs";
import { ulid } from "ulid";
import {
  loadEnv,
  loadEvalBusinessContext,
  ACTIVE_CONNECTORS,
  ACTOR_ID,
  LEASE_CONVERSATION_ID,
  LEASE_TURN_ID,
  ROLE,
  SOURCE_FINDINGS,
  TENANT_ID,
} from "./albert-eval/lib.js";
import { signCubeJwt } from "../packages/albert-v3/src/cube/jwt.js";
import {
  ALBERT_CODEX_LOCAL_SIGNING_SECRET,
  CodexRuntimeServiceClient,
  createCodexTraceTransportState,
  projectCodexRuntimeEvent,
} from "../packages/albert-codex/src/index.js";
import { createTraceEmitter } from "../services/conversation/src/trace-emitter.js";
import type { CodexServiceTurn } from "../packages/albert-codex/src/contracts.js";
import { buildSharedAnalyticalBrief } from "../services/conversation/src/analytical-brief.js";

const env = loadEnv();
const runs = Number(process.argv[2] ?? "1");
const message = process.env.REPRO_MESSAGE
  ?? "Give me a candid health check across sales, customers, inventory and cash";
const businessContext = loadEvalBusinessContext();
const client = new CodexRuntimeServiceClient(
  process.env.REPRO_SERVICE_URL ?? "http://127.0.0.1:8792",
  env.ALBERT_CODEX_RUNTIME_SIGNING_SECRET?.trim() || ALBERT_CODEX_LOCAL_SIGNING_SECRET,
);

function summarise(event: Record<string, unknown>): string {
  const type = String(event.type);
  if (type === "table") return `table resultId=${event.resultId} caption=${event.caption}`;
  if (type === "query") return `query topic=${event.topic} rowCount=${event.rowCount}`;
  if (type === "plan") {
    const steps = Array.isArray(event.steps) ? event.steps as Array<Record<string, unknown>> : [];
    return `plan ${steps.map((s) => `${s.status}`).join(",")}`;
  }
  if (type === "progress") return `progress ${event.stage}/${event.status} ${event.label} — ${String(event.detail ?? "").slice(0, 120)}`;
  if (type === "narrative") return `narrative ${String(event.text).slice(0, 160)}`;
  if (type === "validation") return `validation ${event.name} → ${event.outcome}`;
  if (type === "answer") return `ANSWER state=${event.state}\n${String(event.text)}`;
  if (type === "error") return `ERROR message=${event.message}`;
  if (type === "chart") {
    const flint = event.flint as { chart_spec?: { chartType?: string } } | undefined;
    return `CHART ${flint?.chart_spec?.chartType} caption=${event.caption} yKey=${event.yKey} dataRef=${event.dataRef}`;
  }
  return type;
}

for (let run = 1; run <= runs; run += 1) {
  const cubeBearer = signCubeJwt({
    secret: env.CUBEJS_API_SECRET!,
    expiresInSeconds: 1800,
    securityContext: {
      tenant_id: TENANT_ID,
      role: ROLE,
      specialist_agent_id: "general",
      specialist_agent_version: 1,
      conversation_id: LEASE_CONVERSATION_ID,
      turn_id: LEASE_TURN_ID,
    },
  });
  const analysisBrief = buildSharedAnalyticalBrief({
    message,
    activeConnectors: [...ACTIVE_CONNECTORS],
    connectorFreshness: [],
    // Mirrors the production route: every analytical turn carries a brief.
    includeGeneric: true,
  });
  const turn: CodexServiceTurn = {
    protocolVersion: 1,
    requestId: ulid(),
    tenantId: TENANT_ID,
    actorId: ACTOR_ID,
    role: ROLE,
    conversationId: LEASE_CONVERSATION_ID,
    turnId: LEASE_TURN_ID,
    message,
    priorConversation: [],
    priorResults: [],
    activeConnectors: [...ACTIVE_CONNECTORS],
    connectorFreshness: [],
    ...(businessContext ? { businessContext: businessContext.rendered.slice(0, 20_000) } : {}),
    sourceFindings: JSON.stringify(SOURCE_FINDINGS).slice(0, 12_000),
    ...(analysisBrief ? { analysisBrief } : {}),
    cubeBearer,
    model: "gpt-5.6-luna",
    effort: "max",
    fastMode: process.env.REPRO_FAST_MODE !== "false",
  };
  const startedAt = Date.now();
  console.log(`\n[run ${run}/${runs}] requestId=${turn.requestId} message=${message.slice(0, 60)}`);
  try {
    const rawEventsFile = process.env.RAW_EVENTS_FILE;
    // Mirror the production route exactly: every runtime event is projected
    // onto the durable trace and validated by the strict ordered-trace
    // contract, so a violation here fails the run just as the route would.
    let transport = createCodexTraceTransportState();
    const routeEmit = createTraceEmitter({ persist: async () => {}, deliver: () => {} });
    const result = await client.runTurn(turn, async (event) => {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (rawEventsFile) appendFileSync(rawEventsFile, `${JSON.stringify(event)}\n`);
      const projected = projectCodexRuntimeEvent(transport, event);
      transport = projected.state;
      for (const accepted of projected.events) await routeEmit(accepted);
      console.log(`[run ${run} ${elapsed}s] ${summarise(event as unknown as Record<string, unknown>)}`);
    });
    console.log(`[run ${run}] COMPLETE state=${result.answerState} queries=${result.queriesExecuted} durationMs=${result.durationMs}`);
  } catch (error) {
    console.error(`[run ${run}] FAILED after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    console.error(error instanceof Error ? `${error.name} code=${(error as { code?: string }).code}: ${error.message}` : error);
  }
}
