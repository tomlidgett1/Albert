/**
 * Live Albert agent quality battery against the Ashburton Cycles dogfood tenant.
 *
 * Opens real leased conversation turns, runs natural-language questions through
 * runLiveAlbertTurn against the production dogfood semantic-query service, and
 * records answer state, format, tool chain, and timing for quality review.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ulid } from "ulid";

const env: Record<string, string> = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const raw = line.trim();
  if (!raw || raw.startsWith("#") || !raw.includes("=")) continue;
  const i = raw.indexOf("=");
  env[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
}
for (const [k, v] of Object.entries(env)) process.env[k] = v;

const TENANT = "01KZ4ZMVF5QNQ4TX35VF3WDJBM";
const CASES_PATH = process.argv[2] ?? ".albert-agent-qa-cases.json";
const ONLY = process.env.ALBERT_AGENT_QA_ONLY?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const OUT_DIR = resolve(".albert-agent-qa-out");
mkdirSync(OUT_DIR, { recursive: true });

type Case = Readonly<{ id: string; tier: string; domain: string; ask: string }>;
const ALL_CASES: readonly Case[] = JSON.parse(readFileSync(CASES_PATH, "utf8"));
const CASES = ONLY ? ALL_CASES.filter((c) => ONLY.includes(c.id)) : ALL_CASES;
if (CASES.length === 0) throw new Error("No cases selected.");

const pg = await import("pg");
const Client = (pg as any).default?.Client ?? (pg as any).Client;
const { runLiveAlbertTurn } = await import("./services/conversation/src/live.js");
const { normalizeAgentPreferences } = await import("./packages/shared/src/index.js");

const preferences = normalizeAgentPreferences({
  model: process.env.ALBERT_AGENT_QA_MODEL ?? "gpt-5.6-sol",
  reasoningEffort: process.env.ALBERT_AGENT_QA_EFFORT ?? "high",
  fastMode: false,
});

const admin = new Client({ connectionString: env.CONTROL_PLANE_ADMIN_DATABASE_URL });
await admin.connect();
await admin.query("set role albert_control_migration_owner");

const owner = await admin.query(
  `select membership.user_id from control_plane.memberships membership
    where membership.tenant_id=$1 and membership.role='owner' and membership.status='active'
    order by membership.created_at limit 1`,
  [TENANT],
);
const ownerId = owner.rows[0]?.user_id as string | undefined;
if (!ownerId) throw new Error("no active owner for Ashburton tenant");

const conversationId = ulid();
await admin.query(
  `insert into control_plane.conversations(tenant_id,conversation_id,title,status,created_by,created_at,updated_at)
   values($1,$2,'Albert agent QA battery','active',$3,now(),now())`,
  [TENANT, conversationId, ownerId],
);

console.error(JSON.stringify({
  event: "battery_start",
  tenant: TENANT,
  conversationId,
  cases: CASES.map((c) => c.id),
  preferences,
  semantic: env.SEMANTIC_QUERY_SERVICE_URL,
}, null, 2));

const results: any[] = [];

async function openTurn(turnId: string, message: string) {
  await admin.query(
    `insert into control_plane.conversation_turns(
       tenant_id,turn_id,conversation_id,turn_number,user_message,runtime_profile,
       status,created_by,created_at,lease_expires_at)
     values($1,$2,$3,
       (select coalesce(max(turn_number),0)+1 from control_plane.conversation_turns where tenant_id=$1 and conversation_id=$3),
       $4, $5::jsonb,
       'running',$6,now(),now()+interval '45 minutes')`,
    [
      TENANT,
      turnId,
      conversationId,
      message,
      JSON.stringify({
        runtime: "albert-agent-qa",
        model: preferences.model,
        reasoningEffort: preferences.reasoningEffort,
      }),
      ownerId,
    ],
  );
}

async function closeTurn(turnId: string, digest: string) {
  await admin.query(
    `update control_plane.conversation_turns
       set status='completed', completed_at=now(), result_digest=$3
     where tenant_id=$1 and turn_id=$2`,
    [TENANT, turnId, digest.slice(0, 120)],
  ).catch(async () => {
    await admin.query(
      `update control_plane.conversation_turns
         set status='failed', completed_at=now(), result_digest='albert_agent_qa_failed'
       where tenant_id=$1 and turn_id=$2`,
      [TENANT, turnId],
    );
  });
}

const turnTimeoutMs = Number(process.env.ALBERT_TURN_TIMEOUT_MS ?? 240_000);
const pauseMs = Number(process.env.ALBERT_AGENT_QA_PAUSE_MS ?? 2_500);

for (const c of CASES) {
  let attempt = 0;
  let finished = false;
  while (!finished && attempt < 2) {
    attempt += 1;
    const turnId = ulid();
    const started = Date.now();
    const events: any[] = [];
    const toolish: string[] = [];
    let answer: any = null;
    let clarification: any = null;

    console.error(JSON.stringify({ event: "case_start", id: c.id, tier: c.tier, attempt, ask: c.ask }));
    await openTurn(turnId, c.ask);

    try {
      const live = await runLiveAlbertTurn({
        message: c.ask,
        preferences,
        tenantId: TENANT,
        role: "owner",
        conversationId,
        turnId,
        modelContext: [{ role: "user", text: c.ask }],
        openaiApiKey: env.OPENAI_API_KEY!,
        openaiBaseUrl: env.OPENAI_BASE_URL!,
        semanticServiceUrl: env.SEMANTIC_QUERY_SERVICE_URL!,
        semanticSigningSecret: env.ALBERT_SEMANTIC_SIGNING_SECRET!,
        safetyIdentifier: `albert-agent-qa-${c.id}`,
        openaiTracingEnabled: false,
        abortSignal: AbortSignal.timeout(turnTimeoutMs),
        emit: async (event) => {
          events.push(event);
          if (event.type === "query") toolish.push(`query:${(event as any).topic ?? "?"}`);
          if (event.type === "table") toolish.push(`table:rows=${(event as any).rows?.length ?? 0}`);
          if (event.type === "clarification") {
            clarification = event;
            toolish.push("clarification");
          }
          if (event.type === "answer") answer = event;
          if (event.type === "progress" && (event as any).stage) {
            toolish.push(`progress:${(event as any).stage}`);
          }
          if (event.type === "validation") {
            toolish.push(`validation:${(event as any).name}:${(event as any).outcome}`);
          }
        },
      });

      const tables = events.filter((e) => e.type === "table").map((e) => ({
        resultId: e.resultId,
        columns: (e.columns ?? []).map((col: any) => col.key ?? col.label ?? col),
        rowCount: e.rows?.length ?? 0,
        sample: (e.rows ?? []).slice(0, 3),
      }));
      const narratives = events.filter((e) => e.type === "narrative").map((e) => e.text);
      const queries = events.filter((e) => e.type === "query");
      const validations = events.filter((e) => e.type === "validation");

      const record = {
        id: c.id,
        tier: c.tier,
        domain: c.domain,
        ask: c.ask,
        ok: true,
        attempt,
        answerState: live.answerState ?? answer?.state ?? null,
        answerText: answer?.text ?? null,
        claims: answer?.claims ?? [],
        followUps: answer?.followUps ?? [],
        clarification: clarification
          ? { prompt: clarification.prompt ?? clarification.text, options: clarification.options }
          : null,
        queryCount: queries.length,
        tableCount: tables.length,
        tables,
        narratives: narratives.slice(0, 8),
        validations: validations.map((v) => ({
          name: v.name,
          outcome: v.outcome,
          detail: v.detail,
        })),
        toolChain: toolish,
        usage: live.usage,
        ms: Date.now() - started,
        eventTypes: events.map((e) => e.type),
      };
      // Retry once if the only issue was a soft timeout/unavailable with no table evidence.
      const softTimeout = record.answerState === "Unavailable"
        && record.tableCount === 0
        && /timed out|timeout|unavailable/i.test(String(record.answerText ?? ""));
      if (softTimeout && attempt < 2) {
        console.error(JSON.stringify({ event: "case_retry", id: c.id, reason: "soft_timeout" }));
        await closeTurn(turnId, "retry");
        await new Promise((r) => setTimeout(r, 5_000));
        continue;
      }
      results.push(record);
      writeFileSync(resolve(OUT_DIR, `${c.id}.json`), JSON.stringify(record, null, 2));
      await closeTurn(turnId, live.resultDigest ?? "ok");
      console.error(JSON.stringify({
        event: "case_done",
        id: c.id,
        state: record.answerState,
        ms: record.ms,
        queries: record.queryCount,
        tables: record.tableCount,
        answerPreview: String(record.answerText ?? "").slice(0, 180),
      }));
      finished = true;
    } catch (error: any) {
      const msg = `${error?.code ?? error?.name ?? "error"}: ${String(error?.message ?? error).slice(0, 500)}`;
      const retryable = /aborted|timeout|ECONNRESET|503|429/i.test(msg);
      if (retryable && attempt < 2) {
        console.error(JSON.stringify({ event: "case_retry", id: c.id, reason: msg.slice(0, 120) }));
        await admin.query(
          `update control_plane.conversation_turns
             set status='failed', completed_at=now(), result_digest='albert_agent_qa_retry'
           where tenant_id=$1 and turn_id=$2`,
          [TENANT, turnId],
        ).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 5_000));
        continue;
      }
      const record = {
        id: c.id,
        tier: c.tier,
        domain: c.domain,
        ask: c.ask,
        ok: false,
        attempt,
        answerState: "ERROR",
        answerText: null,
        error: msg,
        events: events.slice(0, 40),
        toolChain: toolish,
        ms: Date.now() - started,
      };
      results.push(record);
      writeFileSync(resolve(OUT_DIR, `${c.id}.json`), JSON.stringify(record, null, 2));
      await admin.query(
        `update control_plane.conversation_turns
           set status='failed', completed_at=now(), result_digest='albert_agent_qa_error'
         where tenant_id=$1 and turn_id=$2`,
        [TENANT, turnId],
      ).catch(() => undefined);
      console.error(JSON.stringify({ event: "case_error", id: c.id, error: record.error, ms: record.ms }));
      finished = true;
    }
  }
  await new Promise((r) => setTimeout(r, pauseMs));
}

await admin.query(
  `delete from control_plane.conversation_turn_events where tenant_id=$1 and conversation_id=$2`,
  [TENANT, conversationId],
).catch(() => undefined);
await admin.query(
  `delete from control_plane.conversation_turns where tenant_id=$1 and conversation_id=$2`,
  [TENANT, conversationId],
);
await admin.query(
  `delete from control_plane.conversations where tenant_id=$1 and conversation_id=$2`,
  [TENANT, conversationId],
);
await admin.end();

const summaryPath = resolve(OUT_DIR, `summary-${Date.now()}.json`);
writeFileSync(summaryPath, JSON.stringify(results, null, 2));
console.log(JSON.stringify({
  summaryPath,
  conversationId,
  preferences,
  results: results.map((r) => ({
    id: r.id,
    tier: r.tier,
    domain: r.domain,
    ok: r.ok,
    state: r.answerState,
    ms: r.ms,
    queries: r.queryCount ?? 0,
    tables: r.tableCount ?? 0,
    claims: (r.claims ?? []).length,
    answerPreview: String(r.answerText ?? r.error ?? "").slice(0, 220),
  })),
}, null, 2));
process.exit(0);
