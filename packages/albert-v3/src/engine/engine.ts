import { createHash } from "node:crypto";
import { Agent, Runner, user } from "@openai/agents";
import { z } from "zod";
import {
  resolveAlbertModelTransport,
  describeChatFailure,
  isXaiModel,
  sanitizeAnswerText,
  sanitizeTraceText,
  type AgentRunPreferences,
  type AnalyticalBrief,
  type AnalyticalQueryRecorder,
  type AnswerState,
  type PresentedTableDigest,
} from "../../../shared/src/index.js";
import type { ProviderRunUsage } from "../../../usage-metering/src/index.js";
import { CubeClient } from "../cube/client.js";
import { ShopifyQLClient } from "../shopifyql/client.js";
import { XeroMcpClient } from "../../../xero-mcp/src/client.js";
import { ShopifyAdminClient } from "../shopify-admin/client.js";
import { loadAgentConfig } from "../agent-config/loader.js";
import type { ConnectorDomainFreshness, EmitV3Trace, TenantSourceFinding, V3TurnContext } from "./context.js";
import {
  buildConversationInput,
  classifyIntent,
  isDefinitionOnlyQuestion,
  type ConversationMessage,
  type IntentDecision,
  type Lane,
} from "./orchestrator.js";
import {
  composeFromGatheredEvidence,
  normalizeOwnerFollowUps,
  finalAnswerSchema,
  laneModelSettings,
  runAnalyticalLane,
  runQuickLane,
  v3PromptCacheKey,
  withV3PromptCacheBoundary,
  type FinalAnswer,
  type LaneRunInput,
} from "./lanes.js";
import { runDeepLane } from "./deep-lane.js";
import { createV3CommentaryState } from "./commentary.js";
import {
  buildInitialOwnerPlan,
  publishOwnerPlan,
  settleVisiblePlan,
  settleVisiblePlanAfterFailure,
  shouldEmitInitialPlan,
} from "./initial-plan.js";
import { createComposeTableTool } from "./tools.js";
import { renderBusinessContextForClassifier, runBusinessContextRefresh, type BusinessContextForTurn, type BusinessContextSection, type SaveBusinessContext } from "../context-layer/index.js";
import { registerPriorResults, type PriorTurnResult } from "./prior-results.js";
import { runRepresentLane } from "./represent-lane.js";
import { normaliseRecipeDateRange, runRecipeLane } from "./recipe-lane.js";
import { runPlannedLane } from "./planned-lane.js";
import { runMetaLane } from "./meta-lane.js";
import { runConceptualLane } from "./conceptual-lane.js";
import { findCertifiedQuery, recipesForRoute } from "../agent-config/loader.js";
import { detectNativeCapability, renderNativeCapabilitiesForClassifier, resolveNativeCapability } from "./native-capabilities.js";
import { trackRunnerUsage } from "./usage-accounting.js";
import { createAlbertModelProvider } from "../../../agent/src/responses-provider.js";
import {
  buildTurnProvenance,
  emptyTurnProvenance,
  groundedAnswerState,
  laneRequiresQueryEvidence,
  ownerFacingAnswerText,
  retryFollowUps,
} from "./grounding.js";
import {
  looksLikeShopifyAdminQuestion,
  looksLikeShopifyQLQuestion,
  normalizeV3Connector,
  resolveV3ToolRoute,
} from "./connector-routing.js";
import { deriveConnectorFreshness } from "./freshness.js";
import { detectSocialMessage, inferSocialKind, socialReply, type SocialKind } from "./social.js";
import {
  matchVerifiedStarterPrompt,
  normalizeSpecialistAgentId,
  specialistAgentAllowedForRole,
  specialistAgentFromConfig,
  specializeAgentConfig,
  type SpecialistAgentId,
} from "../specialist-agents/registry.js";

export const ALBERT_V3_RUNTIME = "albert-v3" as const;

/** Wall-clock ceiling for the reviewer-driven top-up pass; the draft ships if it expires. */
export const REVISION_DEADLINE_MS = 60_000;
/**
 * Rows of each presented table shown to the evidence reviewer. Enough that a
 * typical top-N breakdown (limit 25) is seen whole; anything longer is
 * labelled as a sample with its true row count.
 */
export const REVIEWER_TABLE_SAMPLE_ROWS = 40;

export type AlbertV3TurnOptions = Readonly<{
  message: string;
  conversation: readonly ConversationMessage[];
  preferences: AgentRunPreferences;
  tenantId: string;
  actorId?: string;
  role?: "owner" | "manager" | "bookkeeper" | "internal_operator";
  /** Server-normalized, versioned specialist profile selected for this conversation. */
  specialistAgentId?: SpecialistAgentId;
  /** Authenticated control-plane connector keys; never accepted from a client request. */
  activeConnectors?: readonly string[];
  /** Per connector+domain sync watermarks from control-plane readiness. */
  connectorFreshness?: readonly ConnectorDomainFreshness[];
  /** Compare-only frozen goal/coverage contract; ordinary V3 turns omit it. */
  analysisBrief?: AnalyticalBrief;
  /** Durable source-topology facts for this tenant. */
  sourceFindings?: readonly TenantSourceFinding[];
  /** Persists a source finding the agent verified this turn. */
  recordSourceFinding?: (concept: string, finding: string) => Promise<void>;
  /**
   * Governed results from the last few turns of this conversation, so
   * follow-ups can re-present, re-chart or subset already-retrieved data
   * without re-running the pipeline (see prior-results.ts).
   */
  priorResults?: readonly PriorTurnResult[];
  /**
   * The tenant's business context (see context-layer/). `current` is injected
   * into every prompt; when `refresh.due`, the engine regenerates it under
   * this turn's lease (probes beside the turn's own queries) and hands the
   * result to `refresh.save` before the turn ends.
   */
  businessContext?: Readonly<{
    current?: BusinessContextForTurn;
    ownerLocked?: readonly BusinessContextSection[];
    refresh?: Readonly<{ due: boolean; save: SaveBusinessContext }>;
  }>;
  conversationId: string;
  turnId: string;
  cubeApiUrl: string;
  cubeApiSecret: string;
  shopifyQLServiceUrl?: string;
  shopifyQLSigningSecret?: string;
  shopifyAdminServiceUrl?: string;
  shopifyAdminSigningSecret?: string;
  /** Sync-worker origin + signing secret for live Xero reports via xero-mcp. */
  xeroMcpServiceUrl?: string;
  xeroMcpSigningSecret?: string;
  openaiApiKey: string;
  openaiBaseUrl?: string;
  xaiApiKey?: string;
  xaiBaseUrl?: string;
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
  openaiTracingEnabled?: boolean;
  signal?: AbortSignal;
  emit: EmitV3Trace;
  /** Host-owned durable ledger; query execution fails closed when start logging fails. */
  queryRecorder?: AnalyticalQueryRecorder;
  onProviderUsage?: (
    usage: ProviderRunUsage,
    providerResponseId: string | null,
  ) => Promise<void>;
}>;

export type AlbertV3TurnResult = Readonly<{
  answerState: AnswerState;
  answerText: string;
  resultDigest: string;
  queriesExecuted: number;
}>;

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function hasMarkdownTable(text: string): boolean {
  const lines = text.split("\n");
  return lines.some((line, index) => {
    const next = lines[index + 1] ?? "";
    return line.includes("|")
      && /^\s*\|?\s*:?-{3,}/u.test(next)
      && next.includes("|");
  });
}

function stripMarkdownTables(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const divider = lines[index + 1] ?? "";
    if (line.includes("|") && divider.includes("|") && /^\s*\|?\s*:?-{3,}/u.test(divider)) {
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|")) index += 1;
      index -= 1;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

export function looksLikeLiveShopifyQuestion(value: string): boolean {
  return /\bshopify\b/iu.test(value)
    || looksLikeShopifyQLQuestion(value)
    || looksLikeShopifyAdminQuestion(value);
}

async function repairMarkdownAnswerTable(input: Readonly<{
  runner: Runner;
  preferences: AgentRunPreferences;
  context: V3TurnContext;
  draft: FinalAnswer;
}>): Promise<FinalAnswer> {
  const sources = [...input.context.tableResults.values()]
    .filter((table) => table.presentation === "evidence")
    .slice(0, 12)
    .map((table) => ({
      resultId: table.resultId,
      caption: table.caption,
      columns: table.columns,
      rows: table.rows,
    }));
  if (sources.length === 0) {
    return { ...input.draft, answer: stripMarkdownTables(input.draft.answer) || "The requested table is unavailable." };
  }
  const repairAgent = new Agent<V3TurnContext, typeof finalAnswerSchema>({
    name: "Albert v3 structured table repair",
    instructions: `A draft answer incorrectly contains one or more Markdown pipe tables.
Recreate every such table by calling compose_table with exact source-cell references from
the governed results supplied below. Preserve its orientation, labels, order and unavailable
states. Use labelSource for any date-based pivot heading. Then return the same answer as
clean Markdown with no Markdown table and no new figures. Preserve the draft's headings,
short paragraphs, bullets and numbered-list hierarchy, as well as its state, follow-ups
and disclosed assumptions. Do not run new queries.`,
    model: input.preferences.model,
    modelSettings: laneModelSettings(input.preferences, "medium", {
      maxEffort: "medium",
      promptCacheKey: v3PromptCacheKey({
        partition: input.context.promptCachePartition,
        profile: "structured-table-repair",
        route: input.context.toolRoute,
      }),
    }),
    tools: [createComposeTableTool()],
    outputType: finalAnswerSchema,
  });
  try {
    const run = await input.runner.run(repairAgent, withV3PromptCacheBoundary(
      input.preferences.model,
      [user(JSON.stringify({
        draft: input.draft,
        governedSourceResults: sources,
      }))],
    ), {
      context: input.context,
      maxTurns: 6,
      signal: input.context.signal,
    });
    const repaired = run.finalOutput;
    if (repaired) {
      return {
        ...repaired,
        answer: stripMarkdownTables(repaired.answer) || stripMarkdownTables(input.draft.answer),
      };
    }
  } catch {
    // The invariant is fail-closed: never render an unstructured table. The
    // governed source results remain visible and pinnable if repair fails.
  }
  return { ...input.draft, answer: stripMarkdownTables(input.draft.answer) || "The governed results are shown above." };
}

const evidenceReviewSchema = z.object({
  verdict: z.enum(["ship", "investigate"]),
  /** Concrete missing checks phrased as data questions; empty when shipping. */
  missing: z.array(z.string().min(8).max(200)).max(3),
});

function captionKey(caption: string): string {
  return caption
    .toLocaleLowerCase("en-AU")
    .replace(/\b(?:corrected|final|verified|updated|revised)\b/gu, " ")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

/**
 * The answer tables the owner sees: the last three composed tables, except
 * that a table re-composed under the same caption (the model correcting a
 * calculation) replaces its earlier versions rather than stacking beside them.
 */
export function presentedAnswerTableIds(
  tables: readonly Readonly<{ resultId: string; caption: string; presentation: "evidence" | "answer" }>[],
): string[] {
  const latestByCaption = new Map<string, string>();
  for (const table of tables) {
    if (table.presentation !== "answer") continue;
    const key = captionKey(table.caption);
    // Re-insert so Map order reflects the latest composition.
    latestByCaption.delete(key);
    latestByCaption.set(key, table.resultId);
  }
  return [...latestByCaption.values()].slice(-3);
}

const PRESENTED_TABLE_DIGEST_MAX_TABLES = 3;
const PRESENTED_TABLE_DIGEST_MAX_ROWS = 60;
const PRESENTED_TABLE_DIGEST_MAX_COLUMNS = 8;
const PRESENTED_TABLE_DIGEST_MAX_CELL = 80;
/** Hard ceiling on the serialised digest so persisted answer events stay small. */
const PRESENTED_TABLE_DIGEST_MAX_BYTES = 12_000;

/**
 * What the owner actually saw, in a form the next turn can read. Without this
 * the model context of a follow-up carried only the prose and the query
 * definitions, so after a P&L the owner asking "what subscriptions do we
 * have?" could not be anchored to the Subscriptions line sitting on screen and
 * was treated as a fresh question. Bounded on every axis; a large table keeps
 * its first rows and its true row count.
 */
export function buildPresentedTableDigest(
  tables: readonly Readonly<{
    resultId: string;
    caption: string;
    columns: readonly Readonly<{ key: string; label: string }>[];
    rows: readonly Readonly<Record<string, string | number | null>>[];
  }>[],
  presentedResultIds: readonly string[],
): readonly PresentedTableDigest[] {
  const byId = new Map(tables.map((table) => [table.resultId, table] as const));
  const digests: PresentedTableDigest[] = [];
  let bytes = 0;
  for (const resultId of presentedResultIds.slice(-PRESENTED_TABLE_DIGEST_MAX_TABLES)) {
    const table = byId.get(resultId);
    if (!table) continue;
    const columns = table.columns.slice(0, PRESENTED_TABLE_DIGEST_MAX_COLUMNS);
    const clip = (value: string | number | null): string | number | null =>
      typeof value === "string" ? sanitizeTraceText(value, PRESENTED_TABLE_DIGEST_MAX_CELL) : value;
    const rows = table.rows
      .slice(0, PRESENTED_TABLE_DIGEST_MAX_ROWS)
      .map((row) => columns.map((column) => clip(row[column.key] ?? null)));
    const digest: PresentedTableDigest = Object.freeze({
      caption: sanitizeTraceText(table.caption, 160),
      columns: columns.map((column) => sanitizeTraceText(column.label, 60)),
      rowCount: table.rows.length,
      rows,
    });
    // Rows are trimmed, never dropped wholesale, when the budget is tight: the
    // caption, columns and row count alone still tell the next turn what was
    // shown.
    let candidate = digest;
    let size = JSON.stringify(candidate).length;
    while (bytes + size > PRESENTED_TABLE_DIGEST_MAX_BYTES && candidate.rows.length > 0) {
      candidate = Object.freeze({ ...candidate, rows: candidate.rows.slice(0, Math.floor(candidate.rows.length / 2)) });
      size = JSON.stringify(candidate).length;
    }
    if (bytes + size > PRESENTED_TABLE_DIGEST_MAX_BYTES) break;
    bytes += size;
    digests.push(candidate);
  }
  return Object.freeze(digests);
}

/**
 * Whether the evidence-sufficiency review runs for this turn.
 *
 * Quick turns that came back clean skip it: the lane exists for one-query
 * facts and lists ("what's the roster this week"), and the reviewer's three
 * failure modes (unexplained zero, uncovered facet, claim past a watermark)
 * are already excluded when the lane itself reports Verified, saw rows, and
 * never crossed a sync watermark. The review — a second medium-effort model
 * call — stays on for every analytical turn and for any quick turn that is
 * exploratory, empty, escalated, or freshness-qualified.
 */
export function shouldReviewEvidence(input: Readonly<{
  lane: Lane;
  /** The lane that actually produced the answer (quick may have escalated). */
  escalated: boolean;
  state: FinalAnswer["state"];
  queriesExecuted: number;
  rowsSeen: number;
  freshnessQualified: boolean;
}>): boolean {
  if (input.lane !== "quick" && input.lane !== "analytical") return false;
  if (input.state === "Escalate" || input.state === "Unavailable") return false;
  if (input.queriesExecuted === 0) return false;
  if (
    input.lane === "quick"
    && !input.escalated
    && input.state === "Verified"
    && input.rowsSeen > 0
    && !input.freshnessQualified
  ) {
    return false;
  }
  return true;
}

/**
 * The generate→review gate: before an answer ships, a cheap reviewer asks
 * whether the gathered evidence would genuinely satisfy the owner's goal. A
 * literally-true but unexplanatory answer (an unexplained zero, an uncovered
 * facet, a claim reaching past a sync watermark) fails review and re-enters
 * the analytical lane once with a refilled budget. Best effort: any reviewer
 * failure ships the original answer.
 */
async function reviewEvidenceSufficiency(input: Readonly<{
  runner: Runner;
  preferences: AgentRunPreferences;
  context: V3TurnContext;
  intent: Readonly<{
    resolvedQuestion: string;
    ownerGoal: string | null;
    answerMustCover: readonly string[];
  }>;
  draft: FinalAnswer;
}>): Promise<z.infer<typeof evidenceReviewSchema> | undefined> {
  const evidence = [
    ...input.context.executedQueries.map((query) => ({
      topic: query.topic,
      view: query.view,
      rowCount: query.rowCount,
      timeRange: query.timeRangeLabel,
    })),
    // Results carried over from earlier turns are evidence too.
    ...[...input.context.tableResults.values()]
      .filter((table) => table.reusedFromPriorTurn)
      .map((table) => ({ topic: `${table.caption} (from an earlier answer in this conversation)`, view: table.provenance.view?.name ?? "earlier result", rowCount: table.rowCount, timeRange: table.provenance.timeRange.label })),
  ];
  // Figures the owner will see often live in composed tables rather than the
  // prose, so the reviewer must read those tables too or it will report the
  // draft's own numbers as missing. The sample is capped, but the reviewer is
  // always told the table's true row count: turn 01M095F8M1… silently showed
  // 12 of a 25-row table next to a query reporting 25 rows, and the reviewer
  // (correctly, from what it saw) demanded "the 13 rows not shown" — a 60s
  // revision that re-ran the same query and then timed out.
  const allTables = [...input.context.tableResults.values()];
  const presented = new Set(presentedAnswerTableIds(allTables));
  const answerTables = allTables
    .filter((table) => presented.has(table.resultId))
    .map((table) => {
      const sample = table.rows.slice(0, REVIEWER_TABLE_SAMPLE_ROWS);
      return {
        caption: table.caption,
        columns: table.columns.map((column) => column.label),
        totalRows: table.rows.length,
        rowsShown: sample.length,
        ...(sample.length < table.rows.length
          ? { note: `Sample only: the owner sees all ${table.rows.length} rows.` }
          : {}),
        rows: sample.map((row) => table.columnKeys.map((key) => row[key] ?? null)),
      };
    });
  const critic = new Agent<unknown, typeof evidenceReviewSchema>({
    name: "Albert v3 evidence reviewer",
    instructions: `You review whether the evidence gathered this turn genuinely answers the
owner's question before the answer ships. You never write the answer; you only
judge sufficiency.

The draft consists of the prose AND the tables composed for it (draftTables); a
figure shown in a draft table counts as reported. Never name a check whose
answer already appears in the draft prose or tables. draftTables.rows is a
sample: totalRows is what the owner sees, and every row of the source result
is available to the composed table. A table with fewer rows than a query
returned, or a sample shorter than totalRows, is never missing evidence.

Fail the review (verdict=investigate) when:
- A zero, empty or missing figure is reported without evidence explaining it
  (where the data actually falls, what the planned/counterpart figures show, or
  a data-freshness limit). An unexplained zero is not an answer.
- The question or the useful-answer points have a facet no query addressed. A
  question about actuals usually needs the matching plan or schedule for the
  same period when actuals come back empty; a question about a period needs
  anything already outstanding from earlier periods when money is involved.
- A claim depends on a window that reaches past the connector's synced-through
  watermark without saying so. Judge this ONLY from the connectorFreshness
  watermarks supplied below, and only the watermark whose connector AND domain
  match the view the claim came from (a Xero invoices watermark says nothing
  about Lightspeed sales): when that watermark is later than the window, or no
  matching watermark is supplied, freshness is not a reason to investigate. A period
  that includes today, or a "month to date" that the draft already labels as
  such, is never a reason. Never ask for a check of whether the data is
  "synced through today".
Otherwise return verdict=ship. When investigating, name at most 3 concrete
missing checks phrased as plain data questions (no tool or schema jargon).
Never fail a review for style, formatting or depth beyond the question. Never
ask whether a chart or table "was included": presentation is not evidence.
Never fail a review for a curiosity that does not change the answer: a small
row with zero revenue, an odd single transaction, rounding, an unremarkable
minor category, or "why" questions about a detail the owner did not ask
about. The test is whether the owner's question is answered and its headline
figures are supported — not whether every row has been explained.`,
    model: input.preferences.model,
    modelSettings: laneModelSettings(input.preferences, "medium", {
      maxEffort: "medium",
      promptCacheKey: v3PromptCacheKey({
        partition: input.context.promptCachePartition,
        profile: "evidence-reviewer",
        route: input.context.toolRoute,
      }),
    }),
    outputType: evidenceReviewSchema,
  });
  try {
    const run = await input.runner.run(critic, withV3PromptCacheBoundary(
      input.preferences.model,
      [user(JSON.stringify({
        resolvedQuestion: input.intent.resolvedQuestion,
        ownerGoal: input.intent.ownerGoal,
        answerMustCover: input.intent.answerMustCover,
        evidence,
        connectorFreshness: input.context.connectorFreshness,
        draftAnswer: input.draft.answer,
        draftTables: answerTables,
        draftState: input.draft.state,
      }))],
    ), {
      maxTurns: 2,
      signal: input.context.signal,
    });
    return run.finalOutput;
  } catch {
    return undefined;
  }
}

/** How long the turn's end waits for an in-flight business context refresh. */
const BUSINESS_CONTEXT_REFRESH_GRACE_MS = 45_000;

/**
 * Runs one Albert v3 turn: intent orchestration, lane execution over the Cube
 * semantic layer, and a terminal answer/clarification event. All trace output
 * flows through `options.emit`; the caller owns transport and persistence.
 */
export async function runAlbertV3Turn(options: AlbertV3TurnOptions): Promise<AlbertV3TurnResult> {
  let contextRefresh: Promise<void> | undefined;
  let activeTurnContext: V3TurnContext | undefined;
  const specialistAgentId = normalizeSpecialistAgentId(options.specialistAgentId);
  const config = specializeAgentConfig(loadAgentConfig(), specialistAgentId);
  const specialistAgent = specialistAgentFromConfig(config);
  if (
    specialistAgent.id !== "general"
    && !specialistAgentAllowedForRole(specialistAgent.id, options.role)
  ) {
    throw new Error("This specialist agent is not available for the current organisation role.");
  }
  const emit = options.emit;

  await emit({
    type: "progress",
    status: "running",
    stage: "planning",
    label: "Reading the question",
    detail: `${specialistAgent.ui.title} · Cube semantic layer`,
    progress: 0.05,
  });

  const cube = new CubeClient({
    apiUrl: options.cubeApiUrl,
    apiSecret: options.cubeApiSecret,
    securityContext: {
      tenant_id: options.tenantId,
      conversation_id: options.conversationId,
      turn_id: options.turnId,
      ...(options.role ? { role: options.role } : {}),
      specialist_agent_id: specialistAgent.id,
      specialist_agent_version: specialistAgent.version,
    },
    ...(options.queryRecorder ? { queryRecorder: options.queryRecorder } : {}),
  });
  // Live Shopify reports contain Level-2 protected customer data. Until a
  // field-level entitlement policy exists, no signed client is installed for
  // bookkeepers/internal operators. The worker independently rechecks the
  // active owner/manager membership on every catalogue/query invocation.
  const shopifyQL = (options.role === "owner" || options.role === "manager")
      && options.actorId && options.shopifyQLServiceUrl && options.shopifyQLSigningSecret
    ? new ShopifyQLClient(
        options.shopifyQLServiceUrl,
        options.shopifyQLSigningSecret,
        {
          tenantId: options.tenantId,
          actorId: options.actorId,
          role: options.role,
          conversationId: options.conversationId,
          turnId: options.turnId,
        },
      )
    : undefined;
  // Live Xero statements (P&L) ride the tenant's native Xero grant through the
  // worker's xero-mcp boundary — the same grant that feeds Fivetran, so no
  // extra consent. Owner/manager only, and only when Xero is connected.
  const xeroMcp = (options.role === "owner" || options.role === "manager")
      && options.actorId && options.xeroMcpServiceUrl && options.xeroMcpSigningSecret
      && (options.activeConnectors ?? []).some((key) => key === "xero" || key === "fivetran-xero")
    ? new XeroMcpClient(
        options.xeroMcpServiceUrl,
        options.xeroMcpSigningSecret,
        {
          tenantId: options.tenantId,
          actorId: options.actorId,
          role: options.role,
          conversationId: options.conversationId,
          turnId: options.turnId,
        },
      )
    : undefined;
  const shopifyAdmin = (options.role === "owner" || options.role === "manager")
      && options.actorId && options.shopifyAdminServiceUrl && options.shopifyAdminSigningSecret
    ? new ShopifyAdminClient(
        options.shopifyAdminServiceUrl,
        options.shopifyAdminSigningSecret,
        {
          tenantId: options.tenantId,
          actorId: options.actorId,
          role: options.role,
          conversationId: options.conversationId,
          turnId: options.turnId,
        },
      )
    : undefined;

  const provider = createAlbertModelProvider(resolveAlbertModelTransport({
    model: options.preferences.model,
    openaiApiKey: options.openaiApiKey,
    openaiBaseUrl: options.openaiBaseUrl,
    xaiApiKey: options.xaiApiKey,
    xaiBaseUrl: options.xaiBaseUrl,
    anthropicApiKey: options.anthropicApiKey,
    anthropicBaseUrl: options.anthropicBaseUrl,
  }));
  const accounting = trackRunnerUsage(new Runner({
    modelProvider: provider,
    tracingDisabled: !options.openaiTracingEnabled,
    traceIncludeSensitiveData: false,
    workflowName: "albert-v3-engine",
    groupId: options.conversationId,
  }));
  const runner = accounting.runner;
  const promptCachePartition = digest(
    `${options.tenantId}:${specialistAgent.id}:${specialistAgent.version}`,
  ).slice(0, 12);

  try {
  // A Xero statement request (P&L / balance sheet / trial balance) has a fully
  // specified answer: Xero's own report for the period. It bypasses the intent
  // planner entirely — the planner's plan card and answerMustCover are how a
  // statement request kept getting rebuilt from ledger views — and runs the
  // dedicated statement lane below. The planner is only consulted if that lane
  // hands back (Escalate), i.e. the owner asked for more than a statement.
  // Native connector capabilities (registry-driven): a deterministic detector
  // owns explicit requests before classification; the classifier can also
  // route indirect wording to a capability afterwards.
  const definitionOnly = isDefinitionOnlyQuestion(options.message);
  const nativeMatch = definitionOnly
    ? undefined
    : detectNativeCapability(options.message, { xeroMcp }, options.activeConnectors);
  const statementKind = nativeMatch?.kind;
  // A greeting, thanks or sign-off has no question in it. Reply and stop:
  // no catalogue fetch, no classifier, no planned query to "acknowledge the
  // owner's thanks" with a currency count.
  const answerSocially = async (kind: SocialKind): Promise<AlbertV3TurnResult> => {
    const reply = socialReply(kind, options.message);
    const text = sanitizeAnswerText(
      specialistAgent.id === "customers" && kind === "greeting"
        ? "Hi — I’m ready to dig into customer value, repeat behaviour, retention, workshop relationships, and receivables."
        : reply.text,
    );
    const socialFollowUps = specialistAgent.id === "general"
      ? reply.followUps
      : specialistAgent.starterPrompts.slice(0, 3).map(({ prompt }) => prompt);
    await emit({
      type: "progress",
      status: "complete",
      stage: "planning",
      label: "Just a reply",
      detail: "No data needed for this one.",
      progress: 0.12,
    });
    await emit({
      type: "answer",
      status: "complete",
      state: "Verified",
      text,
      provenance: emptyTurnProvenance(config.timezone),
      followUps: [...socialFollowUps],
      presentedResultIds: [],
      claims: [],
    });
    return {
      answerState: "Verified",
      answerText: text,
      resultDigest: digest(text),
      queriesExecuted: 0,
    };
  };
  const socialKind = statementKind ? null : detectSocialMessage(options.message, options.conversation);
  if (socialKind) return answerSocially(socialKind);
  const verifiedStarter = matchVerifiedStarterPrompt(specialistAgent.id, options.message);
  const verifiedStarterRecipe = verifiedStarter
    ? findCertifiedQuery(verifiedStarter.certifiedQueryName, config)
    : undefined;
  const deterministicStarterIntent: IntentDecision | undefined = verifiedStarterRecipe?.recipe
    ? {
        lane: "quick",
        resolvedQuestion: options.message.trim().slice(0, 600),
        ownerGoal: null,
        answerShape: verifiedStarterRecipe.recipe.presentation === "fact"
          ? "fact"
          : verifiedStarterRecipe.recipe.presentation === "list"
            || verifiedStarterRecipe.recipe.presentation === "table"
            ? "list"
            : verifiedStarterRecipe.recipe.presentation === "line"
              ? "trend"
              : "breakdown",
        answerMustCover: [],
        assumptions: [],
        clarificationQuestion: null,
        clarificationOptions: [],
        recipe: verifiedStarterRecipe.name,
        recipeDateRange: null,
        recipeEntity: null,
        nativeCapability: null,
      }
    : undefined;
  const classify = () => classifyIntent({
    runner,
    preferences: options.preferences,
    config,
    cachePartition: promptCachePartition,
    conversation: options.conversation,
    message: options.message,
    sourceFindings: options.sourceFindings ?? [],
    activeConnectors: options.activeConnectors,
    nativeCapabilities: renderNativeCapabilitiesForClassifier(options.activeConnectors),
    businessContext: options.businessContext?.current ? renderBusinessContextForClassifier(options.businessContext.current.document) : "",
    signal: options.signal,
  });
  // The catalogue fetch, the intent classification and the freshness probes
  // are independent; they run concurrently.
  const activeTraceConnectors = [...new Set((options.activeConnectors ?? [])
    .map((key) => normalizeV3Connector(key))
    .filter((key): key is NonNullable<typeof key> => Boolean(key)))];
  const [catalogueResult, classifiedIntent, connectorFreshness] = await Promise.all([
    cube.fetchCatalogue(options.signal).then(
      (catalogue) => ({ ok: true as const, catalogue }),
      (error: unknown) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : "Cubecore is down. The Cube API could not be reached.",
      }),
    ),
    statementKind
      ? Promise.resolve(undefined)
      : deterministicStarterIntent
        ? Promise.resolve(deterministicStarterIntent)
        : classify(),
    definitionOnly ? Promise.resolve(options.connectorFreshness ?? []) : deriveConnectorFreshness({
      cube,
      tenantId: options.tenantId,
      probes: config.freshnessProbes,
      activeConnectors: activeTraceConnectors,
      known: options.connectorFreshness ?? [],
      signal: options.signal,
    }).catch(() => options.connectorFreshness ?? []),
  ]);
  let intent: IntentDecision = classifiedIntent ?? {
    lane: "quick",
    resolvedQuestion: options.message.trim().slice(0, 600),
    ownerGoal: null,
    answerShape: "list",
    answerMustCover: [],
    assumptions: [],
    clarificationQuestion: null,
    clarificationOptions: [],
    recipe: null,
    recipeDateRange: null,
    recipeEntity: null,
    nativeCapability: null,
  };

  if (options.analysisBrief) {
    const required = [...new Set([
      ...options.analysisBrief.answerMustCover,
      ...intent.answerMustCover,
    ])].slice(0, 4);
    intent = {
      ...intent,
      ownerGoal: options.analysisBrief.ownerGoal,
      answerMustCover: required,
      lane: options.analysisBrief.requiredViews.length > 1 && intent.lane === "quick"
        ? "analytical"
        : intent.lane,
      assumptions: [
        ...intent.assumptions,
        ...(options.analysisBrief.commonPeriodEnd
          ? [`Use a common comparison period ending ${options.analysisBrief.commonPeriodEnd}.`]
          : []),
      ],
    };
  }

  if (intent.lane === "social") return answerSocially(inferSocialKind(options.message));

  if (intent.lane === "off_topic") {
    const text = sanitizeAnswerText(
      "I can only answer questions about the business data connected to Albert: "
      + "sales, products and customers, accounting (invoices, bills, profit, GST, bank activity), "
      + "payroll and staffing. Ask me anything in that territory.",
    );
    await emit({
      type: "answer",
      status: "complete",
      state: "Unavailable",
      text,
      provenance: emptyTurnProvenance(config.timezone),
      followUps: [
        "How did sales go this month compared to last month?",
        "Which categories make the most gross profit?",
        "Who are my top customers this year?",
      ],
      presentedResultIds: [],
      claims: [],
    });
    return {
      answerState: "Unavailable",
      answerText: text,
      resultDigest: digest(text),
      queriesExecuted: 0,
    };
  }

  if (intent.lane === "clarification") {
    const question = sanitizeTraceText(
      intent.clarificationQuestion ?? "Could you clarify what you would like me to analyse?",
      240,
    );
    await emit({
      type: "clarification",
      status: "complete",
      question,
      options: intent.clarificationOptions.slice(0, 4).map((label, index) => ({
        id: `option_${index + 1}`,
        label: sanitizeTraceText(label, 80),
      })),
    });
    return {
      answerState: "Clarification",
      answerText: question,
      resultDigest: digest(question),
      queriesExecuted: 0,
    };
  }

  const toolRoute = resolveV3ToolRoute({
    question: options.message,
    resolvedQuestion: intent.resolvedQuestion,
    lane: intent.lane,
    conversation: options.conversation,
    config,
    activeConnectors: options.activeConnectors,
    cubeAvailable: catalogueResult.ok,
    shopifyQLAvailable: Boolean(shopifyQL),
    shopifyAdminAvailable: Boolean(shopifyAdmin),
  });

  if (!catalogueResult.ok && !(toolRoute.shopifyQL || toolRoute.shopifyAdmin)) {
    const text = sanitizeAnswerText(
      describeChatFailure(new Error(catalogueResult.error), { runtime: "v3" }),
    );
    await emit({
      type: "answer",
      status: "warning",
      state: "Unavailable",
      text,
      provenance: emptyTurnProvenance(config.timezone),
      followUps: retryFollowUps(options.message),
      presentedResultIds: [],
      claims: [],
    });
    return {
      answerState: "Unavailable",
      answerText: text,
      resultDigest: digest(text),
      queriesExecuted: 0,
    };
  }

  let lane = intent.lane;
  const catalogue = catalogueResult.ok
    ? catalogueResult.catalogue
    : { views: [], fetchedAt: new Date().toISOString() };
  const budget = config.lanes[
    lane === "quick" || lane === "explain" || lane === "represent" || lane === "meta" || lane === "conceptual" ? "quick" : lane === "deep" ? "deep" : "analytical"
  ];
  const context: V3TurnContext = {
    cube,
    ...(shopifyQL ? { shopifyQL } : {}),
    ...(shopifyAdmin ? { shopifyAdmin } : {}),
    ...(xeroMcp ? { xeroMcp } : {}),
    config,
    promptCachePartition,
    toolRoute,
    emit,
    ...(options.queryRecorder ? { queryRecorder: options.queryRecorder } : {}),
    signal: options.signal,
    budget: { maxQueries: budget.maxQueries, executed: 0 },
    connectorFreshness,
    ...(options.businessContext?.current ? { businessContext: options.businessContext.current } : {}),
    sourceFindings: options.sourceFindings ?? [],
    ...(options.recordSourceFinding ? { recordSourceFinding: options.recordSourceFinding } : {}),
    commentary: createV3CommentaryState(lane === "analytical" || lane === "deep"),
    definitionEvidence: [],
    executedQueries: [],
    tableResults: new Map(),
    priorResults: new Map(),
    chartedResultIds: new Set(),
  };
  activeTurnContext = context;
  registerPriorResults(context, options.priorResults ?? []);
  const classifiedNative = !nativeMatch
    ? resolveNativeCapability(intent.nativeCapability, { xeroMcp }, options.activeConnectors)
    : undefined;

  // Business context refresh under this turn's lease: the probes run beside
  // the turn's own queries (bounded parallelism) and the document is saved
  // before the lease closes. Never on the critical path — awaited, bounded, in
  // the finally block — and never fatal.
  if (!definitionOnly && lane !== "conceptual" && options.businessContext?.refresh?.due && !contextRefresh) {
    const refresh = options.businessContext.refresh;
    contextRefresh = runBusinessContextRefresh({
      cube,
      config,
      connectorKeys: options.activeConnectors ?? [],
      freshness: connectorFreshness,
      preferences: options.preferences,
      runner,
      cachePartition: promptCachePartition,
      existing: options.businessContext.current
        ? { document: options.businessContext.current.document, ownerLocked: options.businessContext.ownerLocked ?? [] }
        : undefined,
      sourceFindings: options.sourceFindings ?? [],
      signal: options.signal,
    })
      .then((result) => refresh.save(result))
      .catch((error: unknown) => {
        console.warn("[albert-v3] business context refresh skipped", error instanceof Error ? error.message : String(error));
      });
  }

  if (!statementKind && !classifiedNative && shouldEmitInitialPlan(lane)) {
    await publishOwnerPlan(context, buildInitialOwnerPlan(intent));
  }

  await emit({
    type: "progress",
    status: "complete",
    stage: "planning",
    label: statementKind
      ? nativeMatch?.capability.label ?? "Live Xero statement"
      : lane === "quick"
      ? "Quick lookup"
      : lane === "explain"
        ? "Explaining the previous answer"
        : lane === "represent"
          ? "Re-presenting the previous answer"
        : lane === "meta"
          ? "Checking what data is connected"
        : lane === "conceptual"
          ? "Explaining the concept"
        : lane === "deep"
          ? "Deep investigation"
          : "Analytical investigation",
    detail: sanitizeTraceText(intent.resolvedQuestion, 300),
    progress: 0.12,
  });

  let laneInput: LaneRunInput = {
    runner,
    preferences: options.preferences,
    config,
    catalogue,
    context,
    conversation: buildConversationInput(options.conversation, options.message),
    intent,
  };

  let finalAnswer: FinalAnswer | undefined;
  let quickEscalated = false;
  let statementAnswered = false;
  let plannedAnswered = false;
  // Intent-based delegation: the classifier recognised a native capability the
  // detector did not (indirect wording). Runs before the general lanes; on
  // Escalate the general path continues with the classified intent.
  if (classifiedNative && (lane === "quick" || lane === "analytical")) {
    await emit({ type: "progress", status: "running", stage: "query", label: classifiedNative.capability.label, detail: classifiedNative.kind.replace(/_/gu, " "), progress: 0.2 });
    const answer = await classifiedNative.capability.run(laneInput, classifiedNative.kind);
    // Unavailable means the native tool itself failed (token, rate limit,
    // outage): the semantic layer's synced view of the same data is the
    // fallback, not a dead end for the owner.
    if (answer && answer.state !== "Escalate" && answer.state !== "Unavailable") {
      finalAnswer = answer;
      statementAnswered = true;
    } else if (answer?.state === "Unavailable") {
      await emit({ type: "progress", status: "warning", stage: "query", label: `${classifiedNative.capability.label} is unavailable right now`, detail: "Answering from the synced data instead.", progress: 0.2 });
    }
  }
  if (!statementAnswered && classifiedNative && !context.visiblePlan && shouldEmitInitialPlan(lane)) {
    await publishOwnerPlan(context, buildInitialOwnerPlan(intent));
  }
  if (statementAnswered) {
    // answered by the classifier-routed native capability
  } else if (nativeMatch && statementKind) {
    finalAnswer = await nativeMatch.capability.run(laneInput, statementKind);
    if (finalAnswer && finalAnswer.state !== "Escalate" && finalAnswer.state !== "Unavailable") {
      statementAnswered = true;
    } else {
      const nativeDown = finalAnswer?.state === "Unavailable";
      // The owner asked for more than the statement gives. Now consult the
      // planner and continue on the general path; the statement (if fetched)
      // is already registered as evidence for the analytical lane to build on.
      finalAnswer = undefined;
      const reclassified = await classify();
      const fallbackLane: Lane = reclassified.lane === "off_topic" || reclassified.lane === "clarification" || reclassified.lane === "social"
        ? "quick"
        : reclassified.lane;
      intent = { ...reclassified, lane: fallbackLane };
      lane = fallbackLane;
      laneInput = { ...laneInput, intent };
      if (shouldEmitInitialPlan(lane)) {
        await publishOwnerPlan(context, buildInitialOwnerPlan(intent));
      }
      await emit({
        type: "progress",
        status: nativeDown ? "warning" : "running",
        stage: "query",
        label: nativeDown ? `${nativeMatch.capability.label} is unavailable right now` : "Looking beyond the statement",
        detail: nativeDown ? "Answering from the synced data instead." : "The request needs more than Xero's report on its own.",
        progress: 0.2,
      });
      if (nativeDown) {
        context.sourceFindings = [...context.sourceFindings, {
          concept: "native report unavailable",
          finding: `${nativeMatch.capability.label} could not be fetched this turn (the connector's live report failed). Answer from the synced governed views instead and say the figures come from the synced copy rather than the live report; do not retry the live report. The owner asked for the STATEMENT, so present the complete statement, not just headline totals: for a P&L, compose_table every account line (xero_profit_and_loss_account_analytics statement_amount by section and account_name for the period) together with the headline totals (xero_profit_and_loss_analytics), in Xero's section order (Income, Cost of Sales, Gross Profit, Operating Expenses, Net Profit); for a balance sheet, the line_* members of xero_balance_sheet_analytics grouped by section with the position totals.`,
          recordedAt: new Date().toISOString(),
        }];
      }
    }
  }
  // Fast path: a certified recipe answers the recognised question directly.
  // Anything short of a clean answer falls through to the regular lanes with
  // the recipe's evidence (if any) already registered.
  let recipeAnswered = false;
  const recipeName = !statementAnswered && !statementKind && lane === "quick" ? intent.recipe : null;
  const recipe = recipeName ? findCertifiedQuery(recipeName, config) : undefined;
  const recipeDateRange = normaliseRecipeDateRange(intent.recipeDateRange);
  // A period the classifier named but the recipe grammar cannot express ("since
  // we opened", "the last two financial years") must not silently become the
  // recipe's default period: the general path handles it.
  const recipePeriodUsable = !intent.recipeDateRange || Boolean(recipeDateRange);
  if (recipe?.recipe && recipePeriodUsable && recipesForRoute(config, toolRoute.activeCubeConnectors).includes(recipe)) {
    const answer = await runRecipeLane(
      laneInput,
      recipe,
      recipeDateRange,
      intent.recipeEntity,
    );
    if (answer && answer.state !== "Escalate") {
      finalAnswer = answer;
      recipeAnswered = true;
    }
  }
  if (statementAnswered || recipeAnswered) {
    // handled above
  } else if (lane === "conceptual") {
    finalAnswer = await runConceptualLane(laneInput);
  } else if (lane === "meta") {
    finalAnswer = await runMetaLane(laneInput, options.activeConnectors);
    if (!finalAnswer || finalAnswer.state === "Escalate") {
      finalAnswer = undefined;
      lane = "quick";
      intent = { ...intent, lane: "quick" };
      laneInput = { ...laneInput, intent };
      finalAnswer = await runQuickLane(laneInput);
    }
  } else if (lane === "represent") {
    // Presentation change over already-retrieved data: no query tools, tiny
    // prompt. Hands back when the change needs data that was not retrieved.
    finalAnswer = await runRepresentLane(laneInput);
    if (!finalAnswer || finalAnswer.state === "Escalate") {
      finalAnswer = undefined;
      lane = "quick";
      intent = { ...intent, lane: "quick" };
      laneInput = { ...laneInput, intent };
      await emit({
        type: "progress",
        status: "running",
        stage: "query",
        label: "Fetching what the new view needs",
        detail: "The change needs data beyond what was already on screen.",
        progress: 0.2,
      });
      finalAnswer = await runQuickLane(laneInput);
      if (!finalAnswer || finalAnswer.state === "Escalate") {
        quickEscalated = true;
        context.budget.maxQueries = Math.max(context.budget.maxQueries, context.budget.executed + config.lanes.analytical.maxQueries);
        finalAnswer = await runAnalyticalLane(laneInput);
      }
    }
  } else if (lane === "quick" || lane === "explain") {
    // Research step first: plan the queries from retrieved schemas, run them in
    // parallel, compose. The agentic quick lane is the fallback when the plan
    // cannot be executed or the composer finds the evidence insufficient.
    if (lane === "quick" && !isXaiModel(options.preferences.model)) {
      const planned = await runPlannedLane(laneInput, { mode: "quick" });
      if (planned && planned.state !== "Escalate") { finalAnswer = planned; plannedAnswered = true; }
    }
    if (!finalAnswer) finalAnswer = await runQuickLane(laneInput);
    // A quick question that turned out to need more work falls through to the
    // analytical lane rather than returning a half answer. That covers three
    // shapes: no terminal answer at all, an answer produced without any query,
    // and an explicit state=Escalate (the quick lane found evidence it could
    // not reconcile within its budget). Grok already retried the investigation
    // pass when it skipped tools, so do not pay for a third xAI round on the
    // same empty evidence.
    const grokAlreadyRetriedInvestigation = isXaiModel(options.preferences.model) && lane !== "explain";
    const ranNoQueries = lane === "quick"
      && context.executedQueries.length === 0
      && ![...context.tableResults.values()].some((table) => table.reusedFromPriorTurn)
      && !grokAlreadyRetriedInvestigation;
    const askedToEscalate = lane === "quick" && finalAnswer?.state === "Escalate";
    // The planned lane's fail-fast Unavailable (every planned query timed out
    // at the source) is terminal: the agentic lane would only wait out the
    // same timeouts again.
    const sourceDown = plannedAnswered && finalAnswer?.state === "Unavailable";
    if (!sourceDown && (!finalAnswer || ranNoQueries || askedToEscalate)) {
      quickEscalated = true;
      // A surprise refills the budget: escalation must never stop one query
      // short of the answer because the first pass spent its allowance.
      context.budget.maxQueries = Math.max(
        context.budget.maxQueries,
        context.budget.executed + config.lanes.analytical.maxQueries,
      );
      // The quick lane runs without an opening plan card. Now that the turn
      // has become an investigation, put the tick-off plan on screen so the
      // analytical lane has a list to work through.
      if (!context.visiblePlan) {
        await publishOwnerPlan(context, buildInitialOwnerPlan(intent));
      }
      await emit({
        type: "progress",
        status: "running",
        stage: "query",
        label: askedToEscalate ? "Digging deeper" : "Looking up the figures",
        detail: askedToEscalate
          ? "The first pass found evidence it could not reconcile."
          : "The first pass did not run a data query.",
        progress: 0.2,
      });
      finalAnswer = await runAnalyticalLane(laneInput);
    }
  } else if (lane === "deep") {
    finalAnswer = await runDeepLane(laneInput);
    if (!finalAnswer) finalAnswer = await runAnalyticalLane(laneInput);
  } else {
    // Planned research step, then the agentic analytical lane as fallback with
    // the evidence already gathered and a refilled budget.
    if (!isXaiModel(options.preferences.model)) {
      context.commentary.enabled = true;
      const planned = await runPlannedLane(laneInput, { mode: "analytical" });
      if (planned && planned.state !== "Escalate") { finalAnswer = planned; plannedAnswered = true; }
    }
    if (!finalAnswer) {
      context.budget.maxQueries = Math.max(context.budget.maxQueries, context.budget.executed + config.lanes.analytical.maxQueries);
      finalAnswer = await runAnalyticalLane(laneInput);
    }
  }

  if (!finalAnswer && context.executedQueries.length > 0) {
    // Every lane pass ran out of turns or budget with evidence in hand:
    // compose from what was gathered rather than failing the turn.
    finalAnswer = await composeFromGatheredEvidence(laneInput);
  }
  if (!finalAnswer) {
    throw new Error("The Albert v3 engine did not produce a terminal answer.");
  }

  // Generate → review → revise: a cheap sufficiency review gates the answer.
  // One revision pass at most; explain rests on prior turns and deep already
  // synthesises across branches, so only the data lanes are gated — and a
  // clean quick lookup skips the gate (see shouldReviewEvidence).
  const reusedRows = [...context.tableResults.values()].filter((table) => table.reusedFromPriorTurn).reduce((n, table) => n + table.rowCount, 0);
  if (!statementAnswered && !recipeAnswered && shouldReviewEvidence({
    // A planned answer is reviewed by the same clean-lookup rule as quick:
    // Verified with rows and no freshness caveat ships without the gate.
    lane: plannedAnswered ? "quick" : lane,
    escalated: quickEscalated,
    state: finalAnswer.state,
    queriesExecuted: context.executedQueries.length,
    rowsSeen: context.executedQueries.reduce((total, query) => total + query.rowCount, 0) + reusedRows,
    freshnessQualified: Boolean(context.freshnessQualified),
  })) {
    const review = await reviewEvidenceSufficiency({
      runner,
      preferences: options.preferences,
      context,
      intent: {
        resolvedQuestion: intent.resolvedQuestion,
        ownerGoal: intent.ownerGoal,
        answerMustCover: intent.answerMustCover,
      },
      draft: finalAnswer,
    });
    if (review?.verdict === "investigate" && review.missing.length > 0) {
      // Targeted top-up, not a fresh investigation: the reviewer named the
      // gaps, so the revision runs only those checks and updates the draft.
      // The 75-question battery showed full re-investigation here doubled
      // latency and caused timeouts.
      context.budget.maxQueries = Math.max(
        context.budget.maxQueries,
        context.budget.executed + Math.min(4, config.lanes.analytical.maxQueries),
      );
      await emit({
        type: "progress",
        status: "running",
        stage: "query",
        label: "Reviewed the evidence — digging further",
        detail: sanitizeTraceText(review.missing.join(" · "), 300),
        progress: 0.7,
      });
      // The revision is a bounded top-up, never a second investigation: it
      // runs under its own deadline, and any failure (timeout, provider
      // error, max turns) ships the finished draft rather than the turn.
      // Turn 01M092D9DQ… died this way: a good draft existed at ~60s and a
      // wandering revision took the whole turn past the request timeout.
      const revisionSignal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(REVISION_DEADLINE_MS)])
        : AbortSignal.timeout(REVISION_DEADLINE_MS);
      let revised: FinalAnswer | undefined;
      try {
        // A planned answer is topped up by a second planned pass first: the
        // reviewer's gaps become the question, the first pass's evidence is
        // already registered for the composer. Only if that cannot close the
        // gaps does the agentic lane take over.
        if (plannedAnswered) {
          const topUp = await runPlannedLane({
            ...laneInput,
            signal: revisionSignal,
            intent: {
              ...laneInput.intent,
              resolvedQuestion: `${intent.resolvedQuestion}\n\nAn internal reviewer judged the first pass insufficient on: ${review.missing.join("; ")}. Plan ONLY the queries that close these gaps (the first pass's results are already available); compose the full corrected answer from all results.`,
            },
          }, { mode: "analytical" });
          if (topUp && topUp.state !== "Escalate") revised = topUp;
        }
        if (!revised) revised = await runAnalyticalLane({
          ...laneInput,
          signal: revisionSignal,
          conversation: [
            ...laneInput.conversation,
            user(
              "An internal reviewer judged the draft below insufficient on specific points. "
              + `Run ONLY the queries needed to close these gaps (do not repeat work already done): ${review.missing.join("; ")}. `
              + `Then return the corrected full answer, keeping everything from the draft that remains true.\n\nDraft:\n${finalAnswer.answer}`,
            ),
          ],
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        await emit({
          type: "progress",
          status: "warning",
          stage: "query",
          label: "Kept the first answer",
          detail: "The extra checks did not finish in time.",
          progress: 0.85,
        });
      }
      if (revised && revised.state !== "Escalate") finalAnswer = revised;
    }
  }

  if (hasMarkdownTable(finalAnswer.answer)) {
    finalAnswer = await repairMarkdownAnswerTable({
      runner,
      preferences: options.preferences,
      context,
      draft: finalAnswer,
    });
  }

  const rowsSeen = context.executedQueries.reduce((total, query) => total + query.rowCount, 0);
  // Escalate is an engine-internal handoff, not a terminal state. If a lane
  // with no deeper pass left still returns it, ship the evidence gathered as
  // exploratory rather than a dead end.
  const reusedResults = [...context.tableResults.values()].filter((table) => table.reusedFromPriorTurn).length;
  const state = groundedAnswerState({
    lane,
    requested: finalAnswer.state === "Escalate" ? "Exploratory" : finalAnswer.state,
    queriesExecuted: context.executedQueries.length,
    rowsSeen: rowsSeen + reusedRows,
    freshnessQualified: context.freshnessQualified,
    reusedResults,
    definitionEvidenceCount: context.definitionEvidence?.length ?? 0,
    emptyResultIsAnswer: context.emptyResultIsAnswer,
  });
  const text = sanitizeAnswerText(ownerFacingAnswerText({
    lane,
    draft: finalAnswer.answer,
    queriesExecuted: context.executedQueries.length,
    reusedResults,
  }), 8_000);

  const tableResults = [...context.tableResults.values()];
  const answerTableResultIds = presentedAnswerTableIds(tableResults);
  // Without a composed table, the owner sees the last evidence tables — but a
  // one-row result behind a single-figure answer is the figure restated as a
  // table, so single-row evidence is never presented on its own.
  const presentedResultIds = answerTableResultIds.length > 0
    ? answerTableResultIds
    : tableResults.filter((table) => table.presentation === "evidence" && table.rowCount > 1)
      .map((table) => table.resultId)
      .slice(-3);
  const followUps = laneRequiresQueryEvidence(lane) && context.executedQueries.length === 0
    ? retryFollowUps(options.message)
    : normalizeOwnerFollowUps(finalAnswer.followUps)
      .map((followUp) => sanitizeTraceText(followUp, 160))
      .filter(Boolean);
  await settleVisiblePlan(context, state);
  await emit({
    type: "answer",
    status: "complete",
    state,
    text,
    provenance: buildTurnProvenance(context),
    followUps,
    resolvedSubject: {
      label: sanitizeTraceText(intent.resolvedQuestion, 160),
      kind: lane,
      resolvedQuestion: sanitizeTraceText(intent.resolvedQuestion, 2_000),
    },
    presentedResultIds,
    presentedTables: buildPresentedTableDigest(tableResults, presentedResultIds),
    claims: [],
  });

  return {
    answerState: state,
    answerText: text,
    resultDigest: digest(text),
    queriesExecuted: context.executedQueries.length,
  };
  } catch (error) {
    if (activeTurnContext?.visiblePlan) {
      try {
        await settleVisiblePlanAfterFailure(
          activeTurnContext,
          options.signal?.aborted ? "cancelled" : "blocked",
        );
      } catch {
        // The original turn failure remains authoritative; terminalising the
        // cosmetic checklist is best-effort and must never mask it.
      }
    }
    throw error;
  } finally {
    // Give an in-flight business context refresh a bounded chance to land
    // while the lease is still alive; a slow one is simply retried next turn.
    if (contextRefresh && !options.signal?.aborted) {
      await Promise.race([contextRefresh, new Promise<void>((resolve) => setTimeout(resolve, BUSINESS_CONTEXT_REFRESH_GRACE_MS))]);
    }
    const usage = accounting.snapshot();
    if (usage.requests > 0 && options.onProviderUsage) {
      await options.onProviderUsage(usage, accounting.lastResponseId());
    }
  }
}
