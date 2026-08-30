import { z } from "zod";

/**
 * Dashboard Master (daily deep-dive report).
 *
 * A scheduled ~60-minute Omni investigation distils everything the connected
 * tools know into the five things the business should focus on. The report
 * document below is what the dashboard tab renders: big titles, verdicts,
 * key figures, and governed evidence tables and charts captured from the
 * investigation's own turns — never invented plot data.
 */

export const DASHBOARD_MASTER_MODEL = "gpt-5.6-luna" as const;
export const DASHBOARD_MASTER_EFFORT = "max" as const;
/** Cumulative worker-investigation budget for one session. */
export const DASHBOARD_MASTER_SESSION_BUDGET_MS = 60 * 60_000;
/** A report older than this is due for its daily refresh. */
export const DASHBOARD_MASTER_REFRESH_AFTER_MS = 24 * 60 * 60_000;
/** One tick advances the session by at most this much wall time. */
export const DASHBOARD_MASTER_TICK_BUDGET_MS = 9 * 60_000;
export const DASHBOARD_MASTER_FOCUS_COUNT = 5;

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);

const traceCellSchema = z.union([z.string().max(400), z.number(), z.null()]);

export const dashboardEvidenceTableSchema = z.object({
  resultId: ulidSchema,
  caption: z.string().min(1).max(200),
  connector: z.string().min(1).max(40).optional(),
  timeRangeLabel: z.string().max(240).optional(),
  columns: z.array(z.object({
    key: z.string().min(1).max(160),
    label: z.string().min(1).max(160),
    type: z.enum(["string", "number", "currency", "percent", "date", "datetime"]),
    currency: z.string().regex(/^[A-Z]{3}$/u).optional(),
  }).strict()).min(1).max(12),
  rows: z.array(z.record(z.string().max(160), traceCellSchema)).max(30),
  rowCount: z.number().int().min(0),
}).strict();

export type DashboardEvidenceTable = z.infer<typeof dashboardEvidenceTableSchema>;

export const dashboardEvidenceChartSchema = z.object({
  resultId: ulidSchema,
  caption: z.string().min(1).max(200),
  chartType: z.enum(["bar", "line"]),
  xKey: z.string().min(1).max(160),
  yKey: z.string().min(1).max(160),
  stacked: z.boolean().optional(),
  orientation: z.enum(["vertical", "horizontal"]).optional(),
  series: z.array(z.object({
    key: z.string().min(1).max(160),
    label: z.string().min(1).max(160),
  }).strict()).max(6).optional(),
  /** Row data the chart binds to (already governed evidence rows). */
  rows: z.array(z.record(z.string().max(160), traceCellSchema)).min(2).max(30),
  columns: dashboardEvidenceTableSchema.shape.columns,
}).strict();

export type DashboardEvidenceChart = z.infer<typeof dashboardEvidenceChartSchema>;

export const dashboardKeyFigureSchema = z.object({
  label: z.string().min(2).max(60),
  value: z.string().min(1).max(40),
  detail: z.string().max(120).optional(),
  sentiment: z.enum(["positive", "negative", "neutral"]).default("neutral"),
}).strict();

export const dashboardFocusItemSchema = z.object({
  rank: z.number().int().min(1).max(DASHBOARD_MASTER_FOCUS_COUNT),
  title: z.string().min(6).max(90),
  verdict: z.string().min(20).max(400),
  whyItMatters: z.string().min(20).max(1_600),
  keyFigures: z.array(dashboardKeyFigureSchema).min(1).max(4),
  actions: z.array(z.string().min(10).max(300)).min(2).max(4),
  tables: z.array(dashboardEvidenceTableSchema).max(2).default([]),
  charts: z.array(dashboardEvidenceChartSchema).max(2).default([]),
}).strict();

export type DashboardFocusItem = z.infer<typeof dashboardFocusItemSchema>;

export const dashboardMasterReportSchema = z.object({
  reportId: ulidSchema,
  generatedAt: z.string().min(10).max(40),
  periodLabel: z.string().min(1).max(160),
  model: z.string().min(1).max(120),
  investigationMinutes: z.number().min(0).max(240),
  workerTurns: z.number().int().min(1).max(40),
  governedQueries: z.number().int().min(0).max(2_000),
  headline: z.string().min(10).max(160),
  overview: z.string().min(40).max(2_400),
  focus: z.array(dashboardFocusItemSchema).length(DASHBOARD_MASTER_FOCUS_COUNT),
  /** Soft findings the validator could not ground; disclosed, never hidden. */
  cautions: z.array(z.string().min(6).max(300)).max(6).default([]),
}).strict();

export type DashboardMasterReport = z.infer<typeof dashboardMasterReportSchema>;

/** One investigation objective the session director assigns to a worker. */
export const dashboardObjectiveSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{2,60}$/u),
  title: z.string().min(4).max(120),
  prompt: z.string().min(40).max(6_000),
  round: z.number().int().min(1).max(4),
}).strict();

export type DashboardObjective = z.infer<typeof dashboardObjectiveSchema>;

/** A completed worker turn distilled for session state (evidence attached). */
export const dashboardFindingSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{2,60}$/u),
  round: z.number().int().min(1).max(4),
  title: z.string().min(4).max(120),
  answerState: z.string().max(40).nullable(),
  headline: z.string().max(300).nullable(),
  answer: z.string().max(9_000),
  keyNumbers: z.array(z.object({
    label: z.string().max(120),
    value: z.string().max(60),
  }).strict()).max(10).default([]),
  tables: z.array(dashboardEvidenceTableSchema).max(3).default([]),
  charts: z.array(dashboardEvidenceChartSchema).max(2).default([]),
  queries: z.number().int().min(0).max(200),
  durationMs: z.number().int().min(0),
  failed: z.boolean().default(false),
}).strict();

export type DashboardFinding = z.infer<typeof dashboardFindingSchema>;

export const dashboardSessionPhaseSchema = z.enum([
  "plan",
  "round-1",
  "round-2",
  "round-3",
  "compose",
  "completed",
]);

export type DashboardSessionPhase = z.infer<typeof dashboardSessionPhaseSchema>;

export const DASHBOARD_MASTER_PERIOD_LABEL =
  "the last 12 complete weeks, with the latest complete month in focus";

/** Durable session state advanced tick by tick until the report exists. */
export const dashboardSessionStateSchema = z.object({
  phase: dashboardSessionPhaseSchema,
  budgetMs: z.number().int().min(60_000).max(4 * 60 * 60_000),
  investigationMs: z.number().int().min(0).default(0),
  periodLabel: z.string().min(1).max(160).default(DASHBOARD_MASTER_PERIOD_LABEL),
  objectives: z.array(dashboardObjectiveSchema).max(24).default([]),
  findings: z.array(dashboardFindingSchema).max(24).default([]),
  /** Objective keys already executed (idempotent tick replays). */
  completedKeys: z.array(z.string().max(80)).max(48).default([]),
  /** Worker conversations minted for this session (hidden from history). */
  conversationIds: z.array(ulidSchema).max(48).default([]),
  notes: z.array(z.string().max(300)).max(20).default([]),
}).strict();

export type DashboardSessionState = z.infer<typeof dashboardSessionStateSchema>;
