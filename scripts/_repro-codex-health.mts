/**
 * Direct reproduction of the failing Codex analytical turn:
 * "Give me a candid health check across sales, customers, inventory and cash"
 * Runs runCodexSemanticTurn exactly as services/codex-runtime does, against the
 * live Cube, using the eval harness lease for Ashburton Cycles.
 */
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
import { runCodexSemanticTurn } from "../packages/albert-codex/src/semantic-runtime.js";
import type { CodexServiceTurn } from "../packages/albert-codex/src/contracts.js";
import { buildSharedAnalyticalBrief } from "../services/conversation/src/analytical-brief.js";

const env = loadEnv();
const message = process.argv[2] ?? "Give me a candid health check across sales, customers, inventory and cash";

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
  includeGeneric: false,
});

const businessContext = loadEvalBusinessContext();

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
  fastMode: true,
};

console.log(`[repro] starting turn requestId=${turn.requestId} brief=${analysisBrief?.id ?? "none"} businessContext=${Boolean(businessContext)}`);
const startedAt = Date.now();

function summarise(event: Record<string, unknown>): string {
  const type = String(event.type);
  if (type === "table") {
    const rows = Array.isArray(event.rows) ? event.rows.length : 0;
    return `table resultId=${event.resultId} rows=${rows} caption=${event.caption}`;
  }
  if (type === "query") return `query topic=${event.topic} rowCount=${event.rowCount} ms=${event.executionMs}`;
  if (type === "plan") {
    const steps = Array.isArray(event.steps) ? event.steps as Array<Record<string, unknown>> : [];
    return `plan ${steps.map((s) => `${s.status}:${s.label}`).join(" | ")}`;
  }
  if (type === "progress") return `progress ${event.stage}/${event.status} ${event.label} — ${event.detail ?? ""}`;
  if (type === "narrative") return `narrative ${event.text}`;
  if (type === "validation") return `validation ${event.name} → ${event.outcome}: ${event.detail}`;
  if (type === "answer") return `ANSWER state=${event.state}\n${String(event.text).slice(0, 2000)}`;
  return `${type} ${JSON.stringify(event).slice(0, 300)}`;
}

try {
  const result = await runCodexSemanticTurn({
    turn,
    cubeApiUrl: env.CUBE_API_URL!,
    authentication: {
      mode: "api",
      apiKey: env.OPENAI_API_KEY!,
      baseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    },
    emit: (event) => {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`[${elapsed}s] ${summarise(event as unknown as Record<string, unknown>)}`);
    },
  });
  console.log(`[repro] COMPLETE state=${result.answerState} queries=${result.queriesExecuted} durationMs=${result.durationMs}`);
} catch (error) {
  console.error(`[repro] FAILED after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  console.error(error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : error);
  process.exitCode = 1;
}
