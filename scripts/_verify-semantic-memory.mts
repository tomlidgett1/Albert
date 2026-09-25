/**
 * One-off live verification for ADR 0115 semantic memory (delete after use).
 * Mirrors the codex-conversation route's glue: loads the tenant's stored
 * rules, matches them against the question, injects them into the turn, runs
 * it on the private codex runtime, and prints what the runtime did.
 */
import pg from "pg";
import { ulid } from "ulid";
import { readFileSync } from "node:fs";
import {
  ALBERT_CODEX_LOCAL_SIGNING_SECRET,
  CodexRuntimeServiceClient,
  matchSemanticRules,
  type CodexServiceTurn,
} from "../packages/albert-codex/src/index.js";
import { buildSharedAnalyticalBrief } from "../services/conversation/src/index.js";
import { signCubeJwt } from "../packages/albert-v3/src/cube/jwt.js";

const TENANT_ID = "01KZN20VTX2EWW1TQ2AA3MCPW6";
const ACTOR_ID = "e6a1b354-ffbc-41c0-8131-d2f018dba818";
const QUESTION = process.argv[2] ?? "Give me a list of general service data by month for the last 6 months";

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/u.exec(line.trim());
    if (match) env[match[1]!] = match[2]!.replace(/^"|"$/gu, "");
  }
  return env;
}
const env = loadEnv();

function leaseDbUrl(): string {
  const url = new URL(env.CONTROL_PLANE_DATABASE_URL!);
  const ref = url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/u)?.[1];
  if (ref) {
    url.username = `${decodeURIComponent(url.username)}.${ref}`;
    url.hostname = "aws-0-ap-southeast-2.pooler.supabase.com";
  }
  return url.toString();
}

const pool = new pg.Pool({ connectionString: leaseDbUrl(), ssl: { rejectUnauthorized: false }, max: 1 });
async function db(text: string, values?: unknown[]): Promise<pg.QueryResult> {
  const client = await pool.connect();
  try {
    await client.query("set role albert_control_migration_owner");
    await client.query(
      "select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, false)",
      [ACTOR_ID],
    );
    return await client.query(text, values as never);
  } finally {
    client.release();
  }
}

const rules = (await db(
  "select rule_id, term, meaning, counter_meaning, binding, status, use_count from control_plane.tenant_semantic_memory where tenant_id = $1",
  [TENANT_ID],
)).rows.map((row) => ({
  ruleId: String(row.rule_id),
  term: String(row.term),
  meaning: String(row.meaning),
  counterMeaning: row.counter_meaning ? String(row.counter_meaning) : undefined,
  binding: row.binding ?? undefined,
  status: String(row.status),
  useCount: Number(row.use_count),
}));
const matched = matchSemanticRules(QUESTION, rules);
console.log(`[verify] stored rules=${rules.length} matched=${matched.length}`);
for (const rule of matched) console.log(`  matched: "${rule.term}" (${rule.status})`);

const turnId = ulid();
const begun = await db(
  "select conversation_id from public.begin_albert_turn(null, $1, $2, $3::jsonb, null, null)",
  [turnId, QUESTION, JSON.stringify({ provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "max", fastMode: false, kind: "codex_eval" })],
);
const conversationId = String(begun.rows[0]?.conversation_id ?? "");
if (!conversationId) throw new Error("no conversation id");
await db("update control_plane.conversation_turns set lease_expires_at = clock_timestamp() + interval '30 minutes' where turn_id = $1", [turnId]);
await db("select public.albert_assign_conversation_title($1, $2)", [conversationId, "Eval · semantic-memory verify"]).catch(() => undefined);

const cubeBearer = signCubeJwt({
  secret: env.CUBEJS_API_SECRET!,
  expiresInSeconds: 2_700,
  securityContext: {
    tenant_id: TENANT_ID,
    role: "owner",
    specialist_agent_id: "general",
    specialist_agent_version: 1,
    conversation_id: conversationId,
    turn_id: turnId,
  },
});
const analysisBrief = buildSharedAnalyticalBrief({
  message: QUESTION,
  activeConnectors: ["lightspeed-r", "xero", "deputy"],
  connectorFreshness: [],
  includeGeneric: true,
});
const turn: CodexServiceTurn = {
  protocolVersion: 1,
  requestId: ulid(),
  tenantId: TENANT_ID,
  actorId: ACTOR_ID,
  role: "owner",
  conversationId,
  turnId,
  message: QUESTION,
  priorConversation: [],
  priorResults: [],
  activeConnectors: ["lightspeed-r", "xero", "deputy"],
  connectorFreshness: [],
  semanticMemory: matched.map((rule) => ({
    term: rule.term,
    meaning: rule.meaning,
    ...(rule.counterMeaning ? { counterMeaning: rule.counterMeaning } : {}),
    ...(rule.binding ? { binding: rule.binding as { view: string } } : {}),
    status: rule.status as "proposed" | "confirmed",
  })),
  ...(analysisBrief ? { analysisBrief } : {}),
  cubeBearer,
  model: "gpt-5.6-luna",
  effort: "max",
  fastMode: false,
};
const client = new CodexRuntimeServiceClient("http://127.0.0.1:8799", env.ALBERT_CODEX_RUNTIME_SIGNING_SECRET?.trim() || ALBERT_CODEX_LOCAL_SIGNING_SECRET);
const t0 = Date.now();
let lastEventAt = Date.now();
let maxGapMs = 0;
let eventCount = 0;
const result = await client.runTurn(turn, (event) => {
  const now = Date.now();
  maxGapMs = Math.max(maxGapMs, now - lastEventAt);
  lastEventAt = now;
  eventCount += 1;
  if (event.type === "narrative") {
    console.log(`[${((now - t0) / 1000).toFixed(1)}s] narrative · ${(event as { text?: string }).text}`);
  }
  const at = ((now - t0) / 1000).toFixed(1);
  if (event.type === "query") console.log(`[${at}s] query · ${(event as { view?: string }).view} · ${(event as { topic?: string }).topic ?? ""}`);
  if (event.type === "progress") console.log(`[${at}s] progress · ${(event as { label?: string }).label}`);
  if (event.type === "table") {
    const table = event as unknown as { caption?: string; presentation?: string; rows?: unknown[]; columns?: { label: string }[] };
    console.log(`[${at}s] table · ${table.presentation} · ${table.caption} · ${table.rows?.length} row(s) × [${table.columns?.map((c) => c.label).join(" | ")}]`);
  }
  if (event.type === "answer") {
    const answer = event as unknown as { text?: string; state?: string; presentedResultIds?: string[]; provenance?: { timeRange?: { label?: string } }; keyInsights?: readonly { value: string; label: string; detail?: string; sentiment?: string }[] };
    console.log(`\n=== ANSWER (${answer.state}) · presented=${answer.presentedResultIds?.length} · window=${answer.provenance?.timeRange?.label} ===`);
    for (const card of answer.keyInsights ?? []) {
      console.log(`  [card:${card.sentiment}] ${card.value} — ${card.label}${card.detail ? ` (${card.detail})` : ""}`);
    }
    console.log(`\n${answer.text}\n`);
  }
});
console.log("[verify] result:", JSON.stringify({ answerState: result.answerState, queriesExecuted: result.queriesExecuted, memoryProposals: result.memoryProposals ?? [] }));
console.log(`[verify] events=${eventCount} maxSilenceGap=${(maxGapMs / 1000).toFixed(1)}s`);
await db("select public.fail_albert_turn($1, $2, $3)", [conversationId, turnId, "albert_codex_answered"]).catch(() => undefined);
await pool.end();
