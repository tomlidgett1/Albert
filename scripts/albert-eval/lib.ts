/**
 * Shared helpers for the Albert eval harness: environment, fixed tenant
 * configuration (mirrors what /api/v3-conversation injects for Ashburton
 * Cycles), date tokens, golden computation against Cube, and the
 * production-shaped conversation context for multi-turn threads.
 */
import { existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import { businessContextDocumentSchema, renderBusinessContext, type BusinessContextForTurn } from "../../packages/albert-v3/src/context-layer/index.js";
import { fileURLToPath } from "node:url";
import { CubeClient } from "../../packages/albert-v3/src/cube/client.js";
import { priorResultsFromTraceEvents, type PriorTurnResult } from "../../packages/albert-v3/src/engine/prior-results.js";
import type { GoldenSpec } from "./questions.js";

export const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "..", "..");
export const RUNS_ROOT = process.env.EVAL_RUNS_ROOT ?? path.join(repoRoot, "evals", "albert", "runs");

export function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) out[match[1]!] = match[2]!.replace(/^"|"$/g, "");
  }
  return out;
}

export function loadEnv(): Record<string, string> {
  const envLocal = readEnvFile(path.join(repoRoot, ".env.local"));
  // Library code (e.g. xeroMcpServiceUrl()) reads process.env directly, so
  // .env.local values are exported for any key the shell did not already set.
  for (const [key, value] of Object.entries(envLocal)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return { ...envLocal, ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string> };
}

// --- Fixed test configuration ------------------------------------------------

export const TENANT_ID = "01KZN20VTX2EWW1TQ2AA3MCPW6"; // Ashburton Cycles
export const ACTOR_ID = "e6a1b354-ffbc-41c0-8131-d2f018dba818"; // owner membership
export const ROLE = "owner" as const;
/** Control-plane connector keys, exactly as loadConnectorRouting returns them. */
export const ACTIVE_CONNECTORS = ["deputy", "lightspeed-r", "xero"] as const;
/**
 * The eval harness holds its own control-plane turn leases (see memory:
 * albert-v3-live-battery-lease). One lease per worker: Cube keys its query
 * orchestrator (and DB pool) on the turn, so sharing a single lease across
 * concurrent workers would serialise them through one pool — production gives
 * every turn its own.
 */
export const LEASES: ReadonlyArray<Readonly<{ conversationId: string; turnId: string }>> = (process.env.EVAL_LEASES
  ? process.env.EVAL_LEASES.split(";").map((pair) => { const [conversationId, turnId] = pair.split(":"); return { conversationId: conversationId!, turnId: turnId! }; })
  : [
      { conversationId: "01M099KAN8E7DBGE4FNFK6E4QR", turnId: "01M099KAN9ETHWQG5E28KGJNGS" },
      { conversationId: "01M099KAN9AC827TMYEFQX29GD", turnId: "01M099KAN96958DK0S6M7QEQBS" },
      { conversationId: "01M099KAN9TXPMHH8E13X8ME4F", turnId: "01M099KAN9MSGW7GRY759EX628" },
      { conversationId: "01M099KAN9BGCJ12XN1XKFR2QS", turnId: "01M099KAN9DQ874R3GG2EZQF4A" },
      { conversationId: "01M099KAN9MHMYN40PD4Y2BQYZ", turnId: "01M099KAN90FP74YZVWWWCTK03" },
      { conversationId: "01M099KAN99R016QG5WY6YJF90", turnId: "01M099KAN919YD51E1TCPRXX3P" },
      { conversationId: "01M099KAN9SC2YB11CRA7EEA3N", turnId: "01M099KAN9907TZQXAEB6ZN262" },
      { conversationId: "01M099KAN9313SSEP2QVY8VTDQ", turnId: "01M099KAN91BDZ1ZM2FWKMYDQP" },
    ]);
/** Lease used for golden computation and single-worker scripts. */
export const LEASE_CONVERSATION_ID = process.env.EVAL_LEASE_CONVERSATION_ID ?? LEASES[LEASES.length - 1]!.conversationId;
export const LEASE_TURN_ID = process.env.EVAL_LEASE_TURN_ID ?? LEASES[LEASES.length - 1]!.turnId;
export const TIMEZONE = "Australia/Melbourne";

/**
 * Snapshot of control_plane.tenant_source_findings for the tenant (2026-08-18).
 * Production loads these live; the harness pins them so runs are comparable.
 */
export const SOURCE_FINDINGS = Object.freeze([
  { concept: "worked hours", finding: "Deputy timesheets are authoritative for worked hours and wage cost. Square timecards run far higher (July 2026: Square 968h vs Deputy 360h - unclosed/auto entries) and must never be used for labour hours or labour cost.", recordedAt: "2026-08-13T14:40:48Z" },
  { concept: "total income", finding: "For whole-business income use the Xero P&L, never the sum of POS platforms: Square payments are largely the card-tender subset of Lightspeed sales, so adding Lightspeed + Square double-counts (verified July 2026: Xero P&L ~$42k ex GST vs LS $44.5k + Square $40.9k).", recordedAt: "2026-08-13T14:40:48Z" },
  { concept: "sales", finding: "Lightspeed (sales_analytics) is the canonical sales source. Raw Lightspeed rows can contain duplicate sale versions for recent syncs; the semantic layer deduplicates them, so governed view figures are correct even when raw row counts look ~2x higher.", recordedAt: "2026-08-13T14:40:48Z" },
  { concept: "product categories", finding: "Lightspeed holds the rich product category tree (Wheels and Tyres, Drivetrain, City, Cockpit). Square's catalogue is thin (Services/Uncategorised). Category and product-mix questions belong on Lightspeed views.", recordedAt: "2026-08-13T14:40:48Z" },
  { concept: "gst collected", finding: "GST collected lives in the POS sales feeds (tax on completed sales, roughly $4k+/quarter). Xero's directly-invoiced GST measure covers only the few invoiced sales (~$45/quarter) and massively understates GST collected.", recordedAt: "2026-08-13T14:40:48Z" },
  { concept: "supplier balances", finding: "Xero contact-level payable snapshots net supplier credits (e.g. a $251.15 Pon Bike credit), so they differ slightly from summing unpaid bills. Both are correct at different grains; explain rather than call the data inconsistent. Some historical bills carry junk due dates (1954, 1996).", recordedAt: "2026-08-13T14:40:48Z" },
  { concept: "xero accounting coverage", finding: "Xero accounting is populated across the available history. Evidence this turn includes the organisation record, chart-of-accounts rows, P&L lines from journals, invoices, bank activity and credit notes, plus bills and sales invoices.", recordedAt: "2026-08-17T07:51:06Z" },
  { concept: "xero payroll coverage", finding: "No Xero payroll employees or pay runs were returned across available history in this turn. Treat Xero payroll wages and super as unavailable rather than confirmed zero activity.", recordedAt: "2026-08-17T07:51:06Z" },
]);

// --- Dates -------------------------------------------------------------------

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Today's civil date in the tenant timezone, as a UTC-midnight Date for arithmetic. */
export function todayInTimezone(timezone = TIMEZONE, now = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

export function dateTokens(now = new Date()): Record<string, string> {
  const today = todayInTimezone(TIMEZONE, now);
  const dow = (today.getUTCDay() + 6) % 7; // Monday = 0
  const thisWeekStart = addDays(today, -dow);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const monthStart = new Date(Date.UTC(y, m, 1));
  const monthEnd = new Date(Date.UTC(y, m + 1, 0));
  const lastMonthStart = new Date(Date.UTC(y, m - 1, 1));
  const lastMonthEnd = new Date(Date.UTC(y, m, 0));
  const q = Math.floor(m / 3);
  const lastQuarterStart = new Date(Date.UTC(y, (q - 1) * 3, 1));
  const lastQuarterEnd = new Date(Date.UTC(y, q * 3, 0));
  const fyStartYear = m >= 6 ? y : y - 1; // Australian FY starts 1 July
  return {
    today: ymd(today),
    yesterday: ymd(addDays(today, -1)),
    tomorrow: ymd(addDays(today, 1)),
    seven_days_ago: ymd(addDays(today, -7)),
    in_14_days: ymd(addDays(today, 14)),
    this_week_start: ymd(thisWeekStart),
    this_week_end: ymd(addDays(thisWeekStart, 6)),
    last_week_start: ymd(addDays(thisWeekStart, -7)),
    last_week_end: ymd(addDays(thisWeekStart, -1)),
    next_week_start: ymd(addDays(thisWeekStart, 7)),
    next_week_end: ymd(addDays(thisWeekStart, 13)),
    this_month_start: ymd(monthStart),
    this_month_end: ymd(monthEnd),
    last_month_start: ymd(lastMonthStart),
    last_month_end: ymd(lastMonthEnd),
    this_year_start: `${y}-01-01`,
    this_year_end: `${y}-12-31`,
    last_quarter_start: ymd(lastQuarterStart),
    last_quarter_end: ymd(lastQuarterEnd),
    fy_start: `${fyStartYear}-07-01`,
    last_fy_start: `${fyStartYear - 1}-07-01`,
    last_fy_end: `${fyStartYear}-06-30`,
  };
}

export function resolveTokens<T>(value: T, tokens: Record<string, string>): T {
  if (typeof value === "string") {
    return value.replace(/\{([a-z0-9_]+)\}/g, (whole, key: string) => tokens[key] ?? whole) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolveTokens(v, tokens)) as unknown as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveTokens(v, tokens)])) as T;
  }
  return value;
}

// --- Cube / goldens ----------------------------------------------------------

export function createEvalCube(env: Record<string, string>): CubeClient {
  if (!env.CUBE_API_URL || !env.CUBEJS_API_SECRET) throw new Error("CUBE_API_URL / CUBEJS_API_SECRET missing");
  return new CubeClient({
    apiUrl: env.CUBE_API_URL,
    apiSecret: env.CUBEJS_API_SECRET,
    securityContext: { tenant_id: TENANT_ID, conversation_id: LEASE_CONVERSATION_ID, turn_id: LEASE_TURN_ID },
  });
}

export type GoldenResult = Readonly<{
  label: string;
  mode: GoldenSpec["mode"];
  member: string;
  tolerancePct: number;
  note?: string;
  /** Numeric value (mode=value), entity name (top_entity), row count (row_count) or entity names (entity_list). */
  value: number | string | string[] | null;
  rows: readonly Record<string, unknown>[];
  error?: string;
}>;

export async function computeGolden(cube: CubeClient, spec: GoldenSpec, tokens: Record<string, string>): Promise<GoldenResult> {
  const query = resolveTokens(spec.query, tokens) as Record<string, unknown>;
  const base = { label: spec.label, mode: spec.mode, member: spec.member, tolerancePct: spec.tolerancePct ?? 0.5, ...(spec.note ? { note: spec.note } : {}) };
  try {
    let { result } = await cube.loadQuery(query as never, {});
    for (let attempt = 0; attempt < 2 && !result.ok && /timed out|did not finish|53300|too many connections/iu.test(result.error); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      ({ result } = await cube.loadQuery(query as never, {}));
    }
    if (!result.ok) return { ...base, value: null, rows: [], error: result.error };
    const rows = result.rows.slice(0, 25);
    if (spec.mode === "value") {
      const raw = rows[0]?.[spec.member];
      const value = raw === null || raw === undefined ? null : Number(raw);
      return { ...base, value: value !== null && Number.isFinite(value) ? value : null, rows };
    }
    if (spec.mode === "top_entity") {
      const raw = rows[0]?.[spec.member];
      return { ...base, value: raw === null || raw === undefined ? null : String(raw), rows };
    }
    if (spec.mode === "entity_list") {
      return { ...base, value: rows.map((r) => r[spec.member]).filter((v) => v !== null && v !== undefined).map(String), rows };
    }
    return { ...base, value: result.rows.length, rows };
  } catch (error) {
    return { ...base, value: null, rows: [], error: error instanceof Error ? error.message : String(error) };
  }
}

// --- Conversation context (production shape) ---------------------------------

export type EvalTurnRecord = {
  runId: string;
  id: string;
  thread?: string;
  turn?: number;
  question: string;
  tier: string;
  scope: string;
  surface: string;
  pattern: string;
  format?: string;
  expect?: string;
  startedAt: string;
  durationMs: number;
  phases: { classifiedMs?: number; firstQueryMs?: number; lastQueryMs?: number; answerMs?: number; laneLabel?: string };
  answerState?: string;
  answerText?: string;
  followUps?: readonly string[];
  clarification?: string;
  clarificationOptions?: readonly string[];
  plan?: unknown;
  progress: string[];
  narratives: string[];
  queries: Array<{ topic: string; view?: string; connector?: string; rowCount?: number; queryYaml?: string; timeRange?: string; executionMs?: number }>;
  tables: Array<{ resultId: string; caption: string; presentation: string; columns: Array<{ key: string; label: string; type: string; currency?: string }>; rows: Array<Record<string, unknown>>; rowCount: number; view?: string }>;
  charts: Array<{ chartType: string; caption: string; dataRef: string; xKey: string; yKey: string; orientation?: string; series?: string[] }>;
  errors: string[];
  failed?: string;
  queriesExecuted?: number;
  presentedResultIds?: readonly string[];
  presentedTables?: unknown;
  resolvedSubject?: unknown;
  provenanceDefinitions?: Array<{ metric: string; label: string; definition: string }>;
  golden?: GoldenResult[];
  usage?: unknown;
  engineVersion?: string;
  /** Whether the business context document was injected for this turn. */
  businessContext?: boolean;
};

const MAX_GOVERNED_QUERIES_PER_ANSWER = 8;

/** Mirrors services/conversation/src/artifact-store.ts governedQueriesFromAnswerEvent. */
export function governedQueriesFromDefinitions(
  definitions: ReadonlyArray<{ metric: string; label: string; definition: string }> | undefined,
): Array<{ view: string; topic: string; queryYaml: string }> {
  const governed: Array<{ view: string; topic: string; queryYaml: string }> = [];
  for (const row of definitions ?? []) {
    if (governed.length >= MAX_GOVERNED_QUERIES_PER_ANSWER) break;
    if (typeof row.metric !== "string" || typeof row.definition !== "string" || row.definition.length === 0 || row.definition.length > 4_000) continue;
    const view = row.metric.startsWith("cube.yaml:")
      ? row.metric.slice("cube.yaml:".length)
      : row.metric.startsWith("shopifyql.ir:")
        ? `shopifyql:${row.metric.slice("shopifyql.ir:".length)}`
        : row.metric.startsWith("shopify-admin.ir:")
          ? `shopify-admin:${row.metric.slice("shopify-admin.ir:".length)}`
          : undefined;
    if (!view) continue;
    governed.push({ view, topic: typeof row.label === "string" ? row.label.slice(0, 160) : "Governed query", queryYaml: row.definition });
  }
  return governed;
}

/** Builds the ConversationMessage[] the production route would load for the next turn of a thread. */
export function conversationFromPriorTurns(prior: readonly EvalTurnRecord[], currentMessage: string) {
  const messages: Array<Record<string, unknown>> = [];
  for (const turn of prior) {
    messages.push({ role: "user", text: turn.question });
    if (turn.answerText && turn.answerState !== "Clarification") {
      const governed = governedQueriesFromDefinitions(turn.provenanceDefinitions);
      messages.push({
        role: "assistant",
        text: turn.answerText,
        ...(governed.length ? { governedQueries: governed } : {}),
        ...(turn.resolvedSubject ? { resolvedSubject: turn.resolvedSubject } : {}),
        ...(Array.isArray(turn.presentedTables) && turn.presentedTables.length ? { presentedTables: turn.presentedTables } : {}),
      });
    } else if (turn.clarification) {
      messages.push({ role: "assistant", text: turn.clarification });
    } else {
      messages.push({ role: "assistant", text: "That earlier turn did not produce an answer (it failed before finishing)." });
    }
  }
  messages.push({ role: "user", text: currentMessage });
  return messages;
}

// --- Run storage -------------------------------------------------------------

export function runDir(runId: string): string {
  const dir = path.join(RUNS_ROOT, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

export function appendJsonl(file: string, value: unknown): void {
  appendFileSync(file, `${JSON.stringify(value)}\n`);
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

/** Latency class used throughout the reports. */
export function latencyClass(record: Pick<EvalTurnRecord, "pattern" | "scope" | "tier">): string {
  if (record.pattern === "followup") return "followup";
  if (record.pattern === "chart_reformat") return "chart_reformat";
  if (record.pattern === "drilldown") return "drilldown";
  if (record.tier === "meta") return "meta";
  if (record.scope === "multi") return "cold_multi_tool";
  return "cold_single_tool";
}

/**
 * The prior-turn results the production route passes to the engine, rebuilt
 * from the harness records of the earlier turns in the same thread (mirrors
 * priorResultsFromTraceEvents over persisted table/query events).
 */
export function priorResultsFromRecords(prior: readonly EvalTurnRecord[]): PriorTurnResult[] {
  const recent = prior.slice(-2);
  const turns = recent.map((record, index) => ({
    turnsAgo: recent.length - index,
    events: [
      ...record.queries.map((q) => ({ type: "query", view: q.view, queryYaml: q.queryYaml })),
      ...record.tables.map((t) => ({
        type: "table",
        resultId: t.resultId,
        caption: t.caption,
        presentation: t.presentation,
        columns: t.columns,
        rows: t.rows,
        provenance: {
          sources: [{ connector: record.queries.find((q) => q.view)?.connector ?? "lightspeed", label: t.caption, dataThrough: "unknown" }],
          timeRange: { label: record.queries[0]?.timeRange ?? "As previously retrieved", start: "unknown", end: "unknown", timezone: TIMEZONE },
          definitions: [],
          semanticBundleHash: "albert-eval-prior",
          identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
          view: t.view ? { name: t.view, label: t.view, description: "" } : undefined,
        },
      })),
    ],
  }));
  return priorResultsFromTraceEvents(turns);
}


/**
 * The tenant's business context document as the eval injects it: read from
 * evals/albert/context/<tenant>.json (written by scripts/albert-business-context.mts).
 * EVAL_BUSINESS_CONTEXT=off disables injection; =on requires the file.
 */
export function loadEvalBusinessContext(): BusinessContextForTurn | undefined {
  const mode = (process.env.EVAL_BUSINESS_CONTEXT ?? "auto").toLowerCase();
  if (mode === "off") return undefined;
  const file = path.join(repoRoot, "evals", "albert", "context", `${TENANT_ID.toLowerCase()}.json`);
  if (!existsSync(file)) {
    if (mode === "on") throw new Error(`EVAL_BUSINESS_CONTEXT=on but ${file} does not exist; run scripts/albert-business-context.mts --generate`);
    return undefined;
  }
  const record = JSON.parse(readFileSync(file, "utf8")) as { document: unknown; generatedAt?: string; connectors?: string[] };
  const document = businessContextDocumentSchema.parse(record.document);
  return {
    document,
    rendered: renderBusinessContext(document),
    status: "confirmed",
    generatedAt: record.generatedAt ?? null,
    connectors: record.connectors ?? [...ACTIVE_CONNECTORS],
  };
}
