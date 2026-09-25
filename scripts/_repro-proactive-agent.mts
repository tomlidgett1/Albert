/**
 * Live verification for the Proactive roster (ADR 0113): runs one roster
 * agent's prompt as a real Terra-max codex turn against Ashburton Cycles
 * through a local codex-runtime, then distils the answer exactly as
 * /api/proactive/finding would. Requires a freshly minted turn lease:
 *   PROACTIVE_CONVERSATION_ID / PROACTIVE_TURN_ID
 * Usage: node --import tsx scripts/_repro-proactive-agent.mts [agent-key]
 */
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
  CodexRuntimeServiceClient,
  createCodexTraceTransportState,
  projectCodexRuntimeEvent,
} from "../packages/albert-codex/src/index.js";
import { createTraceEmitter } from "../services/conversation/src/trace-emitter.js";
import type { CodexServiceTurn } from "../packages/albert-codex/src/contracts.js";
import { buildSharedAnalyticalBrief } from "../services/conversation/src/analytical-brief.js";
import { proactiveAgentByKey, PROACTIVE_MODEL } from "../services/proactive/src/roster.js";
import { distillProactiveAnswer } from "../services/proactive/src/distill.js";

const env = loadEnv();
const agentKey = process.argv[2] ?? "revenue-momentum";
const agent = proactiveAgentByKey(agentKey);
if (!agent) throw new Error(`unknown roster agent: ${agentKey}`);
const conversationId = process.env.PROACTIVE_CONVERSATION_ID;
const turnId = process.env.PROACTIVE_TURN_ID;
if (!conversationId || !turnId) throw new Error("set PROACTIVE_CONVERSATION_ID and PROACTIVE_TURN_ID to a live lease");

const client = new CodexRuntimeServiceClient(
  process.env.REPRO_SERVICE_URL ?? "http://127.0.0.1:8797",
  env.ALBERT_CODEX_RUNTIME_SIGNING_SECRET?.trim() || ALBERT_CODEX_LOCAL_SIGNING_SECRET,
);
const businessContext = loadEvalBusinessContext();
const cubeBearer = signCubeJwt({
  secret: env.CUBEJS_API_SECRET!,
  expiresInSeconds: 1800,
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

const startedAt = Date.now();
console.log(`[proactive:${agent.key}] requestId=${turn.requestId} model=${turn.model} effort=${turn.effort}`);
let transport = createCodexTraceTransportState();
const routeEmit = createTraceEmitter({ persist: async () => {}, deliver: () => {} });
let answerText = "";
let answerState = "";
let followUps: string[] = [];
const result = await client.runTurn(turn, async (event) => {
  const projected = projectCodexRuntimeEvent(transport, event);
  transport = projected.state;
  for (const accepted of projected.events) await routeEmit(accepted);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const record = event as unknown as Record<string, unknown>;
  if (record.type === "answer") {
    answerText = String(record.text ?? "");
    answerState = String(record.state ?? "");
    followUps = Array.isArray(record.followUps) ? record.followUps.map(String) : [];
    console.log(`[${elapsed}s] ANSWER state=${answerState}`);
  } else if (record.type === "progress") {
    console.log(`[${elapsed}s] progress ${record.label}`);
  } else if (record.type === "query") {
    console.log(`[${elapsed}s] query ${record.topic} rows=${record.rowCount}`);
  } else if (record.type === "error") {
    console.log(`[${elapsed}s] ERROR ${record.message}`);
  }
});
console.log(`COMPLETE state=${result.answerState} queries=${result.queriesExecuted} durationMs=${result.durationMs}`);
console.log("\n===== ANSWER =====\n");
console.log(answerText);
console.log("\n===== DISTILLED =====\n");
const distilled = distillProactiveAnswer(answerText);
console.log(JSON.stringify({ headline: distilled.headline, keyNumbers: distilled.keyNumbers, followUps, answerState }, null, 2));
