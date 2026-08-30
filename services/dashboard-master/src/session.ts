import { ulid } from "ulid";
import type { TraceEvent } from "../../../packages/shared/src/index.js";
import type {
  OmniServiceTurn,
  OmniTraceEventInput,
} from "../../../packages/albert-omni/src/index.js";
import { distillProactiveAnswer } from "../../proactive/src/distill.js";
import {
  DASHBOARD_MASTER_EFFORT,
  DASHBOARD_MASTER_MODEL,
  DASHBOARD_MASTER_SESSION_BUDGET_MS,
  dashboardSessionStateSchema,
  type DashboardEvidenceChart,
  type DashboardEvidenceTable,
  type DashboardFinding,
  type DashboardObjective,
  type DashboardSessionState,
} from "./contracts.js";

export const DASHBOARD_WORKER_CONCURRENCY = 3;
const WORKER_TIMEOUT_MS = 720_000;
const MAX_ROUND_2_OBJECTIVES = 4;
const MAX_ROUND_3_OBJECTIVES = 3;

/**
 * What each worker turn is told about the mission, so its investigation and
 * final prose suit a daily executive dashboard rather than a chat reply.
 */
export function dashboardWorkerPrompt(objective: DashboardObjective, periodLabel: string): string {
  return `You are one investigator inside Ashburton Cycles' daily deep-dive session. The session's goal is to surface the five most important things the business should focus on; your slice is below. Investigate it thoroughly with governed queries — multiple angles, comparison anchors, quantified drivers — and finish with a tight, figure-rich write-up. Where a trend, ranking or comparison is material, attach a chart. Reporting period focus: ${periodLabel}.

YOUR OBJECTIVE — ${objective.title}:
${objective.prompt}

Finish with: the single most important finding first, the numbers behind it, and what the business should do about it. Do not pad; every sentence should carry a figure or a decision.`;
}

/** Round-1 breadth: every domain the connected tools can speak to. */
export function initialDashboardObjectives(periodLabel: string): DashboardObjective[] {
  const objectives: Array<Readonly<{ key: string; title: string; prompt: string }>> = [
    {
      key: "sales-trajectory",
      title: "Sales trajectory and demand",
      prompt: `Measure the sales trajectory: weekly takings for ${periodLabel} against the prior equal period, transactions vs basket size, best and worst weeks, and the current month-to-date run rate. Identify whether any decline is volume-led or price-led, and which categories or channels drive the change.`,
    },
    {
      key: "margin-and-products",
      title: "Margin, pricing and product economics",
      prompt: "Find where gross margin is made and lost: category-level gross profit ranking, below-cost or negative-margin products, discount and refund leakage with the products behind it, and any catalogue or costing data problems distorting margin reporting.",
    },
    {
      key: "profit-and-costs",
      title: "Accounting profit and the cost base",
      prompt: "Read the accrual P&L: latest complete month and the trailing three months versus the prior three — revenue, gross profit, operating expenses, net profit. Rank the expense accounts, identify which grew fastest, flag one-off spikes, and state how much cost absorption stands between the business and a healthy net margin.",
    },
    {
      key: "cash-and-capital",
      title: "Cash, working capital and stock",
      prompt: "Assess cash and captive capital: bank balances and their trend, cash flow versus profit, receivables and payables including drafts, and the stock position by age — how much cash sits in stock older than 180 days and which categories hold it.",
    },
    {
      key: "labour-productivity",
      title: "Labour cost and productivity",
      prompt: "Assess labour: worked hours and wage cost weekly against takings (wage share of revenue and sales per worked hour, with the trend), rostered-versus-worked gaps, and whether coverage matches the trading pattern by weekday.",
    },
    {
      key: "workshop-and-customers",
      title: "Workshop execution and customer base",
      prompt: "Assess the service side and the customer file: workshop intake, invoiced jobs, open and overdue backlog and its trend; plus customer counts, repeat behaviour, and how much historical value sits dormant. Identify the operational failure or opportunity with the most money attached.",
    },
  ];
  return objectives.map((objective) => ({ ...objective, round: 1 }));
}

export function newDashboardSessionState(
  budgetMs = DASHBOARD_MASTER_SESSION_BUDGET_MS,
): DashboardSessionState {
  return dashboardSessionStateSchema.parse({
    phase: "plan",
    budgetMs,
    investigationMs: 0,
    objectives: [],
    findings: [],
    completedKeys: [],
    notes: [],
  });
}

// ---------------------------------------------------------------------------
// Evidence capture from a worker's trace events
// ---------------------------------------------------------------------------

export type DashboardWorkerEvidence = {
  tables: DashboardEvidenceTable[];
  charts: DashboardEvidenceChart[];
  tablesById: Map<string, DashboardEvidenceTable>;
  queries: number;
  answer: string;
  answerState: string | null;
};

export function newDashboardWorkerEvidence(): DashboardWorkerEvidence {
  return { tables: [], charts: [], tablesById: new Map(), queries: 0, answer: "", answerState: null };
}

function boundedRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  columns: readonly Readonly<{ key: string }>[],
): Array<Record<string, string | number | null>> {
  return rows.slice(0, 30).map((row) => Object.fromEntries(
    columns.slice(0, 12).map((column) => {
      const value = row[column.key];
      if (typeof value === "number" && Number.isFinite(value)) return [column.key, value];
      if (typeof value === "string") return [column.key, value.slice(0, 400)];
      return [column.key, null];
    }),
  ));
}

export function captureDashboardWorkerEvent(evidence: DashboardWorkerEvidence, event: OmniTraceEventInput): void {
  if (event.type === "query") {
    evidence.queries += 1;
    return;
  }
  if (event.type === "table" && event.status === "complete") {
    const columns = event.columns.slice(0, 12).map((column) => ({
      key: column.key,
      label: column.label,
      type: column.type,
      ...(column.currency ? { currency: column.currency } : {}),
    }));
    const table: DashboardEvidenceTable = {
      resultId: event.resultId,
      caption: event.caption.slice(0, 200),
      ...(event.provenance?.sources?.[0]?.connector ? { connector: event.provenance.sources[0].connector } : {}),
      ...(event.provenance?.timeRange?.label ? { timeRangeLabel: event.provenance.timeRange.label.slice(0, 240) } : {}),
      columns,
      rows: boundedRows(event.rows, columns),
      rowCount: event.rows.length,
    };
    evidence.tablesById.set(event.resultId, table);
    evidence.tables.push(table);
    return;
  }
  if (event.type === "chart" && event.status === "complete") {
    const source = evidence.tablesById.get(event.dataRef);
    if (!source || source.rows.length < 2) return;
    evidence.charts.push({
      resultId: event.dataRef,
      caption: event.caption.slice(0, 200),
      chartType: event.chartType,
      xKey: event.xKey,
      yKey: event.yKey,
      ...(event.stacked !== undefined ? { stacked: event.stacked } : {}),
      ...(event.orientation ? { orientation: event.orientation } : {}),
      ...(event.series?.length ? {
        series: event.series.slice(0, 6).map((entry) => ({ key: entry.key, label: entry.label })),
      } : {}),
      rows: source.rows,
      columns: source.columns,
    });
    return;
  }
  if (event.type === "answer") {
    evidence.answer = event.text;
    evidence.answerState = event.state;
  }
}

// ---------------------------------------------------------------------------
// Worker execution (transport injected by the caller)
// ---------------------------------------------------------------------------

export type DashboardTurnGrant = Readonly<{
  conversationId: string;
  turnId: string;
  cubeBearer: string;
  tenantId: string;
  actorId: string;
  role: OmniServiceTurn["role"];
}>;

export type DashboardSessionDeps = Readonly<{
  /** Begin a governed turn and return its identity plus a scoped Cube bearer. */
  mintTurn: (label: string) => Promise<DashboardTurnGrant>;
  /** Settle the governed turn after the worker finishes. */
  settleTurn: (grant: DashboardTurnGrant, answered: boolean) => Promise<void>;
  /** Execute one omni turn against the agent runtime. */
  runOmniTurn: (
    turn: OmniServiceTurn,
    onEvent: (event: OmniTraceEventInput) => void,
    signal: AbortSignal,
  ) => Promise<unknown>;
  timezone: string;
  organisationName: string;
  activeConnectors: readonly string[];
  businessContext?: string;
  log?: (line: string) => void;
}>;

async function runDashboardWorker(
  objective: DashboardObjective,
  periodLabel: string,
  deps: DashboardSessionDeps,
): Promise<DashboardFinding> {
  const startedAt = Date.now();
  const grant = await deps.mintTurn(`Dashboard Master · ${objective.title}`);
  const evidence = newDashboardWorkerEvidence();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("dashboard worker timeout")), WORKER_TIMEOUT_MS);
  let failed = false;
  try {
    const turn: OmniServiceTurn = {
      protocolVersion: 1,
      requestId: ulid(),
      tenantId: grant.tenantId,
      actorId: grant.actorId,
      role: grant.role,
      conversationId: grant.conversationId,
      turnId: grant.turnId,
      message: dashboardWorkerPrompt(objective, periodLabel),
      priorConversation: [],
      activeConnectors: [...deps.activeConnectors],
      connectorFreshness: [],
      ...(deps.businessContext ? { businessContext: deps.businessContext.slice(0, 20_000) } : {}),
      timezone: deps.timezone,
      organisationName: deps.organisationName,
      cubeBearer: grant.cubeBearer,
      model: DASHBOARD_MASTER_MODEL,
      effort: DASHBOARD_MASTER_EFFORT,
      fastMode: false,
    };
    await deps.runOmniTurn(turn, (event) => captureDashboardWorkerEvent(evidence, event), abort.signal);
  } catch (error) {
    failed = true;
    deps.log?.(`worker ${objective.key} failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`);
  } finally {
    clearTimeout(timer);
    await deps.settleTurn(grant, Boolean(evidence.answer)).catch(() => undefined);
  }
  const durationMs = Date.now() - startedAt;
  deps.log?.(`worker ${objective.key}: ${evidence.answer ? evidence.answerState : "FAILED"} q=${evidence.queries} tables=${evidence.tables.length} charts=${evidence.charts.length} ${Math.round(durationMs / 1000)}s`);
  return buildDashboardFinding({ objective, evidence, durationMs, failed });
}

/** Distils captured worker evidence into the durable session finding. */
export function buildDashboardFinding(input: Readonly<{
  objective: Pick<DashboardObjective, "key" | "round" | "title">;
  evidence: Readonly<Pick<DashboardWorkerEvidence, "tables" | "charts" | "queries" | "answer" | "answerState">>;
  durationMs: number;
  failed: boolean;
}>): DashboardFinding {
  const { objective, evidence } = input;
  const distilled = evidence.answer ? distillProactiveAnswer(evidence.answer) : null;
  return {
    key: objective.key,
    round: objective.round,
    title: objective.title,
    answerState: evidence.answerState ? evidence.answerState.slice(0, 40) : null,
    headline: distilled?.headline?.slice(0, 300) ?? null,
    answer: evidence.answer.slice(0, 9_000),
    keyNumbers: (distilled?.keyNumbers ?? []).slice(0, 10)
      .map((entry) => ({ label: entry.label.slice(0, 120), value: entry.value.slice(0, 60) })),
    tables: evidence.tables.slice(-3),
    charts: evidence.charts.slice(-2),
    queries: Math.min(evidence.queries, 200),
    durationMs: Math.max(0, Math.round(input.durationMs)),
    failed: input.failed || !evidence.answer,
  };
}

// ---------------------------------------------------------------------------
// Tick advancement
// ---------------------------------------------------------------------------

export type DashboardDirector = (input: Readonly<{
  round: 2 | 3;
  maxObjectives: number;
  findings: readonly DashboardFinding[];
  periodLabel: string;
}>) => Promise<readonly DashboardObjective[]>;

export type DashboardTickResult = Readonly<{
  state: DashboardSessionState;
  /** True when this tick did work; false means the phase needs the composer. */
  advanced: boolean;
}>;

/** Objectives of the state's current round not yet executed. */
export function pendingDashboardObjectives(state: DashboardSessionState): readonly DashboardObjective[] {
  const round = state.phase === "round-1" ? 1 : state.phase === "round-2" ? 2 : state.phase === "round-3" ? 3 : null;
  if (round === null) return [];
  return state.objectives.filter((objective) => (
    objective.round === round && !state.completedKeys.includes(objective.key)
  ));
}

/**
 * Advance a session whose current round has fully executed: consult the
 * director for the next round's objectives, or move to compose when the
 * budget is spent or nothing worth investigating remains. Pure apart from
 * the director call — shared by the tick runner and the web direct route.
 */
export async function directDashboardPhase(
  state: DashboardSessionState,
  director: DashboardDirector,
  periodLabel: string,
): Promise<DashboardSessionState> {
  const budgetLeft = state.budgetMs - state.investigationMs;
  if (state.phase === "plan") {
    const objectives = initialDashboardObjectives(periodLabel);
    return {
      ...state,
      phase: "round-1",
      objectives,
      notes: [...state.notes, `Planned ${objectives.length} breadth objectives.`],
    };
  }
  if (state.phase === "round-1" || state.phase === "round-2") {
    if (pendingDashboardObjectives(state).length > 0) return state;
    if (budgetLeft < 5 * 60_000) {
      return { ...state, phase: "compose", notes: [...state.notes, `Budget spent after ${state.phase}; composing.`] };
    }
    const round = state.phase === "round-1" ? 2 as const : 3 as const;
    const next = await director({
      round,
      maxObjectives: round === 2 ? MAX_ROUND_2_OBJECTIVES : MAX_ROUND_3_OBJECTIVES,
      findings: state.findings,
      periodLabel,
    });
    if (next.length === 0) {
      return { ...state, phase: "compose", notes: [...state.notes, `Nothing further to assign after ${state.phase}.`] };
    }
    return {
      ...state,
      phase: round === 2 ? "round-2" : "round-3",
      objectives: [...state.objectives, ...next],
      notes: [...state.notes, `Director assigned ${next.length} ${round === 2 ? "drill" : "challenge"} objectives.`],
    };
  }
  if (state.phase === "round-3" && pendingDashboardObjectives(state).length === 0) {
    return { ...state, phase: "compose" };
  }
  return state;
}

/**
 * Runs as much of the current phase as fits inside the tick budget. State is
 * durable and objective execution is idempotent by key, so a crashed or
 * expired tick simply resumes where it stopped.
 */
export async function advanceDashboardSession(
  input: Readonly<{
    state: DashboardSessionState;
    periodLabel: string;
    deps: DashboardSessionDeps;
    director: DashboardDirector;
    tickBudgetMs: number;
  }>,
): Promise<DashboardTickResult> {
  const tickStarted = Date.now();
  let state = dashboardSessionStateSchema.parse(input.state);
  const timeLeft = () => input.tickBudgetMs - (Date.now() - tickStarted);
  const budgetLeft = () => state.budgetMs - state.investigationMs;

  if (state.phase === "plan") {
    state = await directDashboardPhase(state, input.director, input.periodLabel);
  }

  while (state.phase === "round-1" || state.phase === "round-2" || state.phase === "round-3") {
    const pending = pendingDashboardObjectives(state);
    if (pending.length > 0) {
      const queue = [...pending];
      let exhausted = false;
      const workers = Array.from({ length: Math.min(DASHBOARD_WORKER_CONCURRENCY, queue.length) }, async () => {
        for (;;) {
          if (timeLeft() < 60_000 || budgetLeft() < 30_000) { exhausted = true; return; }
          const objective = queue.shift();
          if (!objective) return;
          const finding = await runDashboardWorker(objective, input.periodLabel, input.deps);
          state = {
            ...state,
            findings: [...state.findings, finding],
            completedKeys: [...state.completedKeys, objective.key],
            investigationMs: state.investigationMs + finding.durationMs,
          };
        }
      });
      await Promise.all(workers);
      if (exhausted || pendingDashboardObjectives(state).length > 0) return { state, advanced: true };
    }
    const directed = await directDashboardPhase(state, input.director, input.periodLabel);
    if (directed.phase === state.phase) return { state: directed, advanced: true };
    state = directed;
    if (state.phase === "compose" || timeLeft() < 60_000) return { state, advanced: true };
  }

  // "compose" and "completed" are handled by the caller (the composer needs
  // the report repository, not worker transport).
  return { state, advanced: false };
}
