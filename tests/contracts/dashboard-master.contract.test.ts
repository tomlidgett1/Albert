import { strict as assert } from "node:assert";
import test from "node:test";
import {
  DASHBOARD_MASTER_PERIOD_LABEL,
  dashboardMasterReportSchema,
  dashboardSessionStateSchema,
  type DashboardFinding,
  type DashboardObjective,
} from "../../services/dashboard-master/src/contracts.js";
import {
  buildDashboardFinding,
  captureDashboardWorkerEvent,
  dashboardWorkerPrompt,
  directDashboardPhase,
  initialDashboardObjectives,
  newDashboardSessionState,
  newDashboardWorkerEvidence,
  pendingDashboardObjectives,
} from "../../services/dashboard-master/src/session.js";

const PERIOD = DASHBOARD_MASTER_PERIOD_LABEL;

function fakeFinding(key: string, round: number, durationMs = 60_000): DashboardFinding {
  return {
    key,
    round,
    title: `Finding ${key}`,
    answerState: "Verified",
    headline: `Headline for ${key}`,
    answer: `The investigation of ${key} found revenue of $12,345 and margin of 45.6%.`,
    keyNumbers: [{ label: "Revenue", value: "$12,345" }],
    tables: [],
    charts: [],
    queries: 6,
    durationMs,
    failed: false,
  };
}

void test("a new session plans the six breadth objectives and exposes them as pending", async () => {
  const state = await directDashboardPhase(newDashboardSessionState(), async () => [], PERIOD);
  assert.equal(state.phase, "round-1");
  assert.equal(state.objectives.length, 6);
  assert.deepEqual(
    state.objectives.map((objective) => objective.round),
    [1, 1, 1, 1, 1, 1],
  );
  const pending = pendingDashboardObjectives(state);
  assert.equal(pending.length, 6);
  const prompt = dashboardWorkerPrompt(pending[0]!, PERIOD);
  assert.match(prompt, /daily deep-dive session/u);
  assert.ok(prompt.includes(PERIOD));
});

void test("the director advances rounds and lands in compose, never re-assigning executed keys", async () => {
  let state = await directDashboardPhase(newDashboardSessionState(), async () => [], PERIOD);
  // Execute all of round 1.
  for (const objective of pendingDashboardObjectives(state)) {
    state = dashboardSessionStateSchema.parse({
      ...state,
      findings: [...state.findings, fakeFinding(objective.key, 1)],
      completedKeys: [...state.completedKeys, objective.key],
      investigationMs: state.investigationMs + 60_000,
    });
  }
  assert.equal(pendingDashboardObjectives(state).length, 0);

  const drill: DashboardObjective = {
    key: "drill-margin-leak",
    title: "Drill the margin leak",
    prompt: "Quantify the discount leakage by product and week, testing volume against price effects.",
    round: 2,
  };
  const directorCalls: Array<{ round: number; findings: number }> = [];
  state = dashboardSessionStateSchema.parse(await directDashboardPhase(state, async (input) => {
    directorCalls.push({ round: input.round, findings: input.findings.length });
    return input.round === 2 ? [drill] : [];
  }, PERIOD));
  assert.equal(state.phase, "round-2");
  assert.deepEqual(directorCalls, [{ round: 2, findings: 6 }]);
  assert.equal(pendingDashboardObjectives(state).length, 1);

  // Execute the drill; the round-3 director returns nothing → compose.
  state = dashboardSessionStateSchema.parse({
    ...state,
    findings: [...state.findings, fakeFinding(drill.key, 2)],
    completedKeys: [...state.completedKeys, drill.key],
    investigationMs: state.investigationMs + 120_000,
  });
  state = dashboardSessionStateSchema.parse(await directDashboardPhase(state, async (input) => {
    directorCalls.push({ round: input.round, findings: input.findings.length });
    return [];
  }, PERIOD));
  assert.equal(state.phase, "compose");
  assert.deepEqual(directorCalls.at(-1), { round: 3, findings: 7 });
});

void test("a spent budget forces compose instead of another round", async () => {
  let state = await directDashboardPhase(newDashboardSessionState(10 * 60_000), async () => [], PERIOD);
  for (const objective of pendingDashboardObjectives(state)) {
    state = dashboardSessionStateSchema.parse({
      ...state,
      findings: [...state.findings, fakeFinding(objective.key, 1, 100_000)],
      completedKeys: [...state.completedKeys, objective.key],
      investigationMs: state.investigationMs + 100_000,
    });
  }
  const directed = await directDashboardPhase(state, async () => {
    throw new Error("the director must not be consulted once the budget is spent");
  }, PERIOD);
  assert.equal(directed.phase, "compose");
});

void test("worker evidence capture keeps governed tables, binds charts to them, and bounds rows", () => {
  const evidence = newDashboardWorkerEvidence();
  const columns = [
    { key: "week", label: "Week", type: "date" as const },
    { key: "takings", label: "Takings", type: "currency" as const, currency: "AUD" },
  ];
  const rows = Array.from({ length: 40 }, (_, index) => ({
    week: `2026-W${index + 1}`,
    takings: 1_000 + index,
  }));
  captureDashboardWorkerEvent(evidence, { type: "query", status: "complete", name: "weekly takings" } as never);
  captureDashboardWorkerEvent(evidence, {
    type: "table",
    status: "complete",
    resultId: "01JX000000000000000000TAB1",
    caption: "Weekly takings",
    columns,
    rows,
    provenance: { sources: [{ connector: "lightspeed-r" }], timeRange: { label: "Last 12 weeks" } },
  } as never);
  captureDashboardWorkerEvent(evidence, {
    type: "chart",
    status: "complete",
    chartType: "line",
    dataRef: "01JX000000000000000000TAB1",
    caption: "Takings trend",
    xKey: "week",
    yKey: "takings",
  } as never);
  captureDashboardWorkerEvent(evidence, {
    type: "chart",
    status: "complete",
    chartType: "bar",
    dataRef: "01JX00000000000000000MISS0",
    caption: "Chart with no table must be dropped",
    xKey: "week",
    yKey: "takings",
  } as never);
  captureDashboardWorkerEvent(evidence, { type: "answer", text: "Takings averaged $1,020 a week.", state: "Verified" } as never);

  assert.equal(evidence.queries, 1);
  assert.equal(evidence.tables.length, 1);
  assert.equal(evidence.tables[0]!.rows.length, 30);
  assert.equal(evidence.tables[0]!.rowCount, 40);
  assert.equal(evidence.tables[0]!.connector, "lightspeed-r");
  assert.equal(evidence.tables[0]!.timeRangeLabel, "Last 12 weeks");
  assert.equal(evidence.charts.length, 1);
  assert.equal(evidence.charts[0]!.resultId, "01JX000000000000000000TAB1");
  assert.equal(evidence.charts[0]!.rows.length, 30);

  const finding = buildDashboardFinding({
    objective: { key: "sales-trajectory", round: 1, title: "Sales trajectory and demand" },
    evidence,
    durationMs: 90_500,
    failed: false,
  });
  assert.equal(finding.failed, false);
  assert.equal(finding.answerState, "Verified");
  assert.equal(finding.tables.length, 1);
  assert.equal(finding.charts.length, 1);
  assert.ok(finding.headline);
});

void test("a worker with no answer becomes a failed finding that still fits the schema", () => {
  const finding = buildDashboardFinding({
    objective: { key: "cash-and-capital", round: 1, title: "Cash, working capital and stock" },
    evidence: { tables: [], charts: [], queries: 3, answer: "", answerState: null },
    durationMs: 30_000,
    failed: true,
  });
  assert.equal(finding.failed, true);
  assert.equal(finding.headline, null);
  const state = dashboardSessionStateSchema.parse({
    ...newDashboardSessionState(),
    phase: "round-1",
    objectives: initialDashboardObjectives(PERIOD),
    findings: [finding],
    completedKeys: [finding.key],
  });
  assert.equal(state.findings.length, 1);
});

void test("the report schema holds exactly five ranked focus items with evidence bounds", () => {
  const table = {
    resultId: "01JX000000000000000000TAB2",
    caption: "Margin by category",
    columns: [
      { key: "category", label: "Category", type: "string" as const },
      { key: "margin", label: "Margin", type: "percent" as const },
    ],
    rows: [{ category: "Bikes", margin: 32.1 }, { category: "Service", margin: 92.5 }],
    rowCount: 2,
  };
  const focusItem = (rank: number) => ({
    rank,
    title: `Focus area number ${rank}`,
    verdict: "The margin on bikes is materially below the floor benchmark for the category.",
    whyItMatters: "Bikes carry most of the revenue but the thinnest margin, so small pricing moves swing profit.",
    keyFigures: [{ label: "Bike margin", value: "32.1%", sentiment: "negative" as const }],
    actions: ["Review pricing on the top ten bikes this week.", "Set a discount approval threshold."],
    tables: [table],
    charts: [],
  });
  const report = dashboardMasterReportSchema.parse({
    reportId: "01JX0000000000000000000RPT",
    generatedAt: new Date("2026-08-30T05:00:00Z").toISOString(),
    periodLabel: PERIOD,
    model: "gpt-5.6-luna",
    investigationMinutes: 58.3,
    workerTurns: 11,
    governedQueries: 214,
    headline: "Margins, not sales volume, are the biggest lever this month.",
    overview: "Sales are steady but discounting and labour data gaps are eroding profit; the five areas below carry the most money.",
    focus: [1, 2, 3, 4, 5].map(focusItem),
    cautions: [],
  });
  assert.equal(report.focus.length, 5);
  assert.throws(() => dashboardMasterReportSchema.parse({ ...report, focus: report.focus.slice(0, 4) }));
});
