/**
 * Live Albert agent quality battery against the Ashburton Cycles dogfood tenant.
 *
 * Opens real leased conversation turns, runs natural-language questions through
 * runLiveAlbertTurn against the configured semantic-query service, and
 * records answer state, format, tool chain, and timing for quality review.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import pg, {
  type Client as PgClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";
import { ulid } from "ulid";

import type { TraceEvent } from "./packages/shared/src/index.js";
import type { ProviderRunUsage } from "./packages/usage-metering/src/index.js";

try {
  process.loadEnvFile?.(".env.local");
} catch {
  /* Explicit process environment remains authoritative. */
}
// The harness passes an explicit environment object into the live runtime.
// Build it only from the process environment after Node has loaded local
// defaults, so caller overrides remain authoritative and the harness never
// parses or retains the secret file itself.
const env: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).flatMap(([key, value]) =>
    value === undefined ? [] : [[key, value]],
  ),
);

const TENANT =
  process.env.ALBERT_V2_EVALUATION_TENANT_ID?.trim() ??
  "01KZ4ZMVF5QNQ4TX35VF3WDJBM";
const CASES_PATH = process.argv[2] ?? ".albert-agent-qa-cases.json";
const ONLY =
  process.env.ALBERT_AGENT_QA_ONLY?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? null;
const RUN_ID = process.env.ALBERT_AGENT_QA_RUN_ID?.trim();
const MAX_ATTEMPTS = Math.min(
  2,
  Math.max(1, Number(process.env.ALBERT_AGENT_QA_MAX_ATTEMPTS ?? "2")),
);
const OUT_DIR = resolve(".albert-agent-qa-out", RUN_ID || ".");
mkdirSync(OUT_DIR, { recursive: true });

type ResolvedSubject = Readonly<{
  label: string;
  kind: string;
  resolvedQuestion: string;
}>;
type ContextMessage = Readonly<{
  role: "user" | "assistant";
  text: string;
  resolvedSubject?: ResolvedSubject;
}>;
type Case = Readonly<{
  id: string;
  tier: string;
  domain: string;
  ask: string;
  /** Cases with the same thread id are intentional consecutive follow-ups. */
  thread?: string;
  followUpOf?: string;
}>;
type QaResult = Readonly<{
  id: string;
  tier: string;
  domain: string;
  ok: boolean;
  answerState: string | null;
  ms: number;
  analysisLane?: unknown;
  queryCount?: number;
  tableCount?: number;
  chartCount?: number;
  claims?: readonly unknown[];
  answerText?: string | null;
  error?: string;
}>;
const ALL_CASES: readonly Case[] = JSON.parse(readFileSync(CASES_PATH, "utf8"));
const CASES = ONLY ? ALL_CASES.filter((c) => ONLY.includes(c.id)) : ALL_CASES;
if (CASES.length === 0) throw new Error("No cases selected.");

const { Client } = pg;
const { runLiveAlbertTurn } =
  await import("./services/conversation/src/live.js");
const { normalizeAgentPreferences } =
  await import("./packages/shared/src/index.js");
const { SemanticServiceClient } =
  await import("./services/conversation/src/semantic-client.js");
const { meterOpenAIUsage, toModelUsageRpcPayload } =
  await import("./packages/usage-metering/src/index.js");

const preferences = normalizeAgentPreferences({
  model: process.env.ALBERT_AGENT_QA_MODEL ?? "gpt-5.6-sol",
  reasoningEffort: process.env.ALBERT_AGENT_QA_EFFORT ?? "high",
  fastMode: /^(1|true|yes)$/iu.test(
    process.env.ALBERT_AGENT_QA_FAST_MODE ?? "false",
  ),
});
const turnTimeoutMs = Number(process.env.ALBERT_TURN_TIMEOUT_MS ?? 240_000);
const pauseMs = Number(process.env.ALBERT_AGENT_QA_PAUSE_MS ?? 2_500);
const semanticClient = new SemanticServiceClient(
  env.SEMANTIC_QUERY_SERVICE_URL!,
  env.ALBERT_SEMANTIC_SIGNING_SECRET!,
);

let adminBroken = false;
let admin: PgClient;

async function connectAdmin() {
  const client = new Client({
    connectionString: env.CONTROL_PLANE_ADMIN_DATABASE_URL,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  client.on("error", (error: Error) => {
    if (admin === client) adminBroken = true;
    console.error(
      JSON.stringify({
        event: "control_plane_connection_error",
        error: error.message.slice(0, 300),
      }),
    );
  });
  await client.connect();
  await client.query("set role albert_control_migration_owner");
  return client;
}

async function adminQuery<Row extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: readonly unknown[],
): Promise<QueryResult<Row>> {
  if (adminBroken) {
    await admin?.end().catch(() => undefined);
    admin = await connectAdmin();
    adminBroken = false;
  }
  try {
    return await admin.query(text, values);
  } catch (error: unknown) {
    const errorRecord =
      error && typeof error === "object"
        ? (error as Readonly<Record<string, unknown>>)
        : undefined;
    if (
      !/connection|closed|ECONNRESET|ETIMEDOUT|timeout/iu.test(
        String(
          errorRecord?.code ?? (error instanceof Error ? error.message : error),
        ),
      )
    ) {
      throw error;
    }
    await admin?.end().catch(() => undefined);
    admin = await connectAdmin();
    adminBroken = false;
    console.error(JSON.stringify({ event: "control_plane_reconnected" }));
    return admin.query(text, values);
  }
}

admin = await connectAdmin();

const owner = await adminQuery(
  `select membership.user_id from control_plane.memberships membership
    where membership.tenant_id=$1 and membership.role='owner' and membership.status='active'
    order by membership.created_at limit 1`,
  [TENANT],
);
const ownerId = owner.rows[0]?.user_id as string | undefined;
if (!ownerId) throw new Error("no active owner for Ashburton tenant");

const conversationIds = new Map<string, string>();
const modelContexts = new Map<string, ContextMessage[]>();

async function conversationFor(c: Case): Promise<
  Readonly<{
    thread: string;
    conversationId: string;
    priorContext: readonly ContextMessage[];
  }>
> {
  const thread = c.thread?.trim() || c.id;
  let conversationId = conversationIds.get(thread);
  if (!conversationId) {
    conversationId = ulid();
    conversationIds.set(thread, conversationId);
    modelContexts.set(thread, []);
    await adminQuery(
      `insert into control_plane.conversations(tenant_id,conversation_id,title,status,created_by,created_at,updated_at)
       values($1,$2,$3,'active',$4,now(),now())`,
      [TENANT, conversationId, `Albert QA ${thread}`.slice(0, 120), ownerId],
    );
  }
  return {
    thread,
    conversationId,
    priorContext: Object.freeze([...(modelContexts.get(thread) ?? [])]),
  };
}

console.error(
  JSON.stringify(
    {
      event: "battery_start",
      tenant: TENANT,
      runId: RUN_ID ?? null,
      cases: CASES.map((c) => c.id),
      threads: [...new Set(CASES.map((c) => c.thread?.trim() || c.id))].length,
      preferences,
      turnTimeoutMs,
      semantic: env.SEMANTIC_QUERY_SERVICE_URL,
    },
    null,
    2,
  ),
);

const results: QaResult[] = [];

async function openTurn(
  conversationId: string,
  turnId: string,
  message: string,
) {
  await adminQuery(
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
  await adminQuery(
    `update control_plane.conversation_turns
       set status='completed', completed_at=now(), result_digest=$3
     where tenant_id=$1 and turn_id=$2`,
    [TENANT, turnId, digest.slice(0, 120)],
  ).catch(async () => {
    await adminQuery(
      `update control_plane.conversation_turns
         set status='failed', completed_at=now(), result_digest='albert_agent_qa_failed'
       where tenant_id=$1 and turn_id=$2`,
      [TENANT, turnId],
    );
  });
}

for (const c of CASES) {
  const conversation = await conversationFor(c);
  let attempt = 0;
  let finished = false;
  while (!finished && attempt < MAX_ATTEMPTS) {
    attempt += 1;
    const turnId = ulid();
    const started = Date.now();
    const events: TraceEvent[] = [];
    const toolish: string[] = [];
    let answer: Extract<TraceEvent, { type: "answer" }> | null = null;
    let clarification: Extract<TraceEvent, { type: "clarification" }> | null =
      null;
    const currentModelContext: ContextMessage[] = [
      ...conversation.priorContext,
      { role: "user", text: c.ask },
    ];

    console.error(
      JSON.stringify({
        event: "case_start",
        id: c.id,
        tier: c.tier,
        thread: conversation.thread,
        contextMessages: conversation.priorContext.length,
        attempt,
        ask: c.ask,
      }),
    );
    await openTurn(conversation.conversationId, turnId, c.ask);

    try {
      const live = await runLiveAlbertTurn({
        message: c.ask,
        preferences,
        tenantId: TENANT,
        role: "owner",
        conversationId: conversation.conversationId,
        turnId,
        modelContext: currentModelContext,
        openaiApiKey: env.OPENAI_API_KEY!,
        openaiBaseUrl: env.OPENAI_BASE_URL!,
        semanticServiceUrl: env.SEMANTIC_QUERY_SERVICE_URL!,
        semanticSigningSecret: env.ALBERT_SEMANTIC_SIGNING_SECRET!,
        safetyIdentifier: `albert-agent-qa-${c.id}`,
        openaiTracingEnabled: false,
        abortSignal: AbortSignal.timeout(turnTimeoutMs),
        emit: async (event) => {
          events.push(event);
          if (event.type === "query")
            toolish.push(`query:${event.topic ?? "?"}`);
          if (event.type === "table")
            toolish.push(`table:rows=${event.rows?.length ?? 0}`);
          if (event.type === "clarification") {
            clarification = event;
            toolish.push("clarification");
          }
          if (event.type === "answer") answer = event;
          if (event.type === "progress" && event.stage) {
            toolish.push(`progress:${event.stage}:${event.detail ?? ""}`);
          }
          if (event.type === "validation") {
            toolish.push(`validation:${event.name}:${event.outcome}`);
          }
        },
      });
      if (
        !live.providerRuntime?.verified ||
        live.providerRuntime.model !== "gpt-5.6-luna" ||
        live.providerRuntime.reasoningEffort !== "max" ||
        live.providerRuntime.reasoningMode !== "standard" ||
        live.providerRuntime.serviceTier !== "default"
      )
        throw new Error(
          "The provider did not attest Luna Max in standard non-Fast mode.",
        );

      const tables = events
        .filter((e) => e.type === "table")
        .map((e) => ({
          resultId: e.resultId,
          columns: (e.columns ?? []).map((col) => col.key ?? col.label),
          rowCount: e.rows?.length ?? 0,
          rows: e.rows ?? [],
        }));
      const narratives = events
        .filter((e) => e.type === "narrative")
        .map((e) => e.text);
      const queries = events.filter((e) => e.type === "query");
      const validations = events.filter((e) => e.type === "validation");
      const charts = events
        .filter((e) => e.type === "chart")
        .map((e) => ({
          chartType: e.chartType,
          dataRef: e.dataRef,
          xKey: e.xKey,
          yKey: e.yKey,
          series: e.series,
        }));
      if (!live.semanticV2)
        throw new Error(
          "The locked V2 evaluation turn did not return Semantic V2 lineage.",
        );
      const executionIds = [...live.semanticV2.executionIds];
      const snapshotRows =
        executionIds.length === 0
          ? []
          : ((
              await adminQuery(
                `select execution_id,validation
           from control_plane.query_execution_snapshots_v2
          where tenant_id=$1 and execution_id=any($2::text[])
          order by array_position($2::text[],execution_id)`,
                [TENANT, executionIds],
              )
            ).rows as readonly Readonly<{
              execution_id: string;
              validation: Record<string, unknown>;
            }>[]);
      const semanticValidation = {
        executionCount: executionIds.length,
        snapshotCount: snapshotRows.length,
        tenantIsolationPassed:
          snapshotRows.length === executionIds.length &&
          snapshotRows.every(
            ({ execution_id, validation }, index) =>
              execution_id === executionIds[index] &&
              validation.tenantIsolationPassed === true,
          ),
        fanoutSafetyPassed:
          snapshotRows.length === executionIds.length &&
          snapshotRows.every(
            ({ validation }) => validation.fanoutSafetyPassed === true,
          ),
        evidenceComplete:
          snapshotRows.length === executionIds.length &&
          snapshotRows.every(
            ({ validation }) => validation.evidenceComplete === true,
          ),
        explainCostPassed:
          snapshotRows.length === executionIds.length &&
          snapshotRows.every(
            ({ validation }) => validation.explainCostPassed === true,
          ),
      };

      const record = {
        id: c.id,
        tier: c.tier,
        domain: c.domain,
        ask: c.ask,
        thread: conversation.thread,
        followUpOf: c.followUpOf ?? null,
        contextMessages: conversation.priorContext.length,
        ok: true,
        attempt,
        analysisLane: live.analysisLane,
        answerState: live.answerState ?? answer?.state ?? null,
        answerText: answer?.text ?? null,
        resolvedSubject: answer?.resolvedSubject ?? null,
        claims: live.semanticV2?.claims ?? answer?.claims ?? [],
        publicationHash: live.semanticV2?.publicationHash ?? null,
        executionIds,
        investigationId: live.semanticV2.investigationId ?? null,
        semanticValidation,
        evaluationRuntime: {
          model: preferences.model,
          reasoningEffort: preferences.reasoningEffort,
          fastMode: preferences.fastMode,
          proMode: false,
          processingMode: "standard",
          providerRuntime: live.providerRuntime,
          commitSha: process.env.ALBERT_AGENT_QA_COMMIT_SHA ?? null,
          corpusHash: process.env.ALBERT_V2_EVALUATION_CORPUS_HASH ?? null,
          visibleCorpusHash:
            process.env.ALBERT_V2_EVALUATION_VISIBLE_CORPUS_HASH ?? null,
          holdoutCorpusHash:
            process.env.ALBERT_V2_EVALUATION_HOLDOUT_CORPUS_HASH ?? null,
          goldManifestHash:
            process.env.ALBERT_V2_EVALUATION_GOLD_MANIFEST_HASH ?? null,
          datasetWatermarkHash:
            process.env.ALBERT_V2_EVALUATION_DATASET_WATERMARK_HASH ?? null,
        },
        followUps: answer?.followUps ?? [],
        clarification: clarification
          ? {
              prompt: clarification.question,
              options: clarification.options,
            }
          : null,
        queryCount: queries.length,
        tableCount: tables.length,
        chartCount: charts.length,
        charts,
        queries: queries.map((query) => ({
          topic: query.topic,
          lens: query.lens,
          metrics: query.metrics,
          dimensions: query.dimensions,
          timeRange: query.timeRange,
        })),
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
      const softTimeout =
        record.answerState === "Unavailable" &&
        record.tableCount === 0 &&
        /timed out|timeout|unavailable/i.test(String(record.answerText ?? ""));
      if (softTimeout && attempt < MAX_ATTEMPTS) {
        console.error(
          JSON.stringify({
            event: "case_retry",
            id: c.id,
            reason: "soft_timeout",
          }),
        );
        await closeTurn(turnId, "retry");
        await new Promise((r) => setTimeout(r, 5_000));
        continue;
      }
      const metering = meterOpenAIUsage({
        model: preferences.model,
        fastMode: preferences.fastMode,
        usage: live.usage as ProviderRunUsage,
      });
      const finalization =
        await semanticClient.finalizeSemanticV2AnswerArtifact({
          tenantId: TENANT,
          actorUserId: ownerId,
          conversationId: conversation.conversationId,
          turnId,
          providerResponseId: live.lastResponseId,
          providerUsage: live.usage,
          answerState: String(live.answerState)
            .toLowerCase()
            .replace(" ", "_") as
            | "verified"
            | "derived"
            | "exploratory"
            | "clarification"
            | "no_data"
            | "unavailable",
          turnResultDigest: live.resultDigest,
          metering: toModelUsageRpcPayload(metering),
          executionIds: [...live.semanticV2.executionIds],
          publicationHash: live.semanticV2.publicationHash,
          investigationId: live.semanticV2.investigationId,
          claims: [...live.semanticV2.claims],
        });
      Object.assign(record, {
        metering,
        answerArtifactId: finalization.answerArtifactId,
        answerArtifactDigest: finalization.artifactDigest,
      });
      results.push(record);
      writeFileSync(
        resolve(OUT_DIR, `${c.id}.json`),
        JSON.stringify(record, null, 2),
      );
      const assistantText = String(
        answer?.text ?? clarification?.prompt ?? clarification?.text ?? "",
      ).trim();
      if (assistantText) {
        modelContexts.set(
          conversation.thread,
          [
            ...currentModelContext,
            {
              role: "assistant",
              text: assistantText,
              ...(answer?.resolvedSubject
                ? { resolvedSubject: answer.resolvedSubject }
                : {}),
            },
          ].slice(-12),
        );
      }
      console.error(
        JSON.stringify({
          event: "case_done",
          id: c.id,
          state: record.answerState,
          ms: record.ms,
          queries: record.queryCount,
          tables: record.tableCount,
          charts: record.chartCount,
          answerPreview: String(record.answerText ?? "").slice(0, 180),
        }),
      );
      finished = true;
    } catch (error: unknown) {
      const errorRecord =
        error && typeof error === "object"
          ? (error as Readonly<Record<string, unknown>>)
          : undefined;
      const msg = `${errorRecord?.code ?? (error instanceof Error ? error.name : "error")}: ${String(error instanceof Error ? error.message : error).slice(0, 500)}`;
      const retryable = /aborted|timeout|ECONNRESET|503|429/i.test(msg);
      if (retryable && attempt < MAX_ATTEMPTS) {
        console.error(
          JSON.stringify({
            event: "case_retry",
            id: c.id,
            reason: msg.slice(0, 120),
          }),
        );
        await adminQuery(
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
        thread: conversation.thread,
        contextMessages: conversation.priorContext.length,
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
      writeFileSync(
        resolve(OUT_DIR, `${c.id}.json`),
        JSON.stringify(record, null, 2),
      );
      await adminQuery(
        `update control_plane.conversation_turns
           set status='failed', completed_at=now(), result_digest='albert_agent_qa_error'
         where tenant_id=$1 and turn_id=$2`,
        [TENANT, turnId],
      ).catch(() => undefined);
      console.error(
        JSON.stringify({
          event: "case_error",
          id: c.id,
          error: record.error,
          ms: record.ms,
        }),
      );
      finished = true;
    }
  }
  await new Promise((r) => setTimeout(r, pauseMs));
}

for (const conversationId of process.env.ALBERT_ANALYTICAL_RUNTIME === "v2"
  ? []
  : conversationIds.values()) {
  await adminQuery(
    `delete from control_plane.conversation_turn_events where tenant_id=$1 and conversation_id=$2`,
    [TENANT, conversationId],
  ).catch(() => undefined);
  await adminQuery(
    `delete from control_plane.conversation_turns where tenant_id=$1 and conversation_id=$2`,
    [TENANT, conversationId],
  );
  await adminQuery(
    `delete from control_plane.conversations where tenant_id=$1 and conversation_id=$2`,
    [TENANT, conversationId],
  );
}
await admin.end().catch(() => undefined);

const summaryPath = resolve(OUT_DIR, "summary.json");
writeFileSync(summaryPath, JSON.stringify(results, null, 2));
console.log(
  JSON.stringify(
    {
      summaryPath,
      conversationIds: [...conversationIds.values()],
      preferences,
      results: results.map((r) => ({
        id: r.id,
        tier: r.tier,
        domain: r.domain,
        ok: r.ok,
        state: r.answerState,
        lane: r.analysisLane,
        ms: r.ms,
        queries: r.queryCount ?? 0,
        tables: r.tableCount ?? 0,
        charts: r.chartCount ?? 0,
        claims: (r.claims ?? []).length,
        answerPreview: String(r.answerText ?? r.error ?? "").slice(0, 220),
      })),
    },
    null,
    2,
  ),
);
process.exit(0);
