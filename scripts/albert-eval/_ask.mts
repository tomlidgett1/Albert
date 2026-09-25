import { runAlbertV3Turn } from "../../packages/albert-v3/src/index.js";
import { xeroMcpServiceUrl } from "../../packages/xero-mcp/src/client.js";
import { ACTIVE_CONNECTORS, ACTOR_ID, LEASES, ROLE, SOURCE_FINDINGS, TENANT_ID, loadEnv, loadEvalBusinessContext } from "./lib.js";
const BUSINESS_CONTEXT = loadEvalBusinessContext();
const env = loadEnv();
const lease = LEASES[LEASES.length - 1]!;
const t0 = Date.now();
const result = await runAlbertV3Turn({
  message: process.argv[2] ?? "What were total sales last month?",
  conversation: [],
  preferences: { model: "gpt-5.6-luna", reasoningEffort: "max", fastMode: false },
  tenantId: TENANT_ID, actorId: ACTOR_ID, role: ROLE, activeConnectors: [...ACTIVE_CONNECTORS], connectorFreshness: [], sourceFindings: [...SOURCE_FINDINGS], ...(BUSINESS_CONTEXT ? { businessContext: { current: BUSINESS_CONTEXT } } : {}),
  conversationId: lease.conversationId, turnId: lease.turnId,
  cubeApiUrl: env.CUBE_API_URL!, cubeApiSecret: env.CUBEJS_API_SECRET!, xeroMcpServiceUrl: xeroMcpServiceUrl() || undefined, xeroMcpSigningSecret: env.ALBERT_OAUTH_WORKER_SIGNING_SECRET,
  openaiApiKey: env.OPENAI_API_KEY!, openaiBaseUrl: env.OPENAI_BASE_URL || undefined,
  emit: async (event) => { const at = ((Date.now() - t0) / 1000).toFixed(1); if (event.type === "progress") console.log(at, event.status, event.stage, event.label, event.detail ?? ""); else if (event.type === "answer") console.log(at, "ANSWER", event.state, event.text.slice(0, 300)); else console.log(at, event.type); return { ...event, id: "x", sequence: 1, occurredAt: "" } as never; },
});
console.log("done", (Date.now() - t0) / 1000, result.answerState);
process.exit(0);
