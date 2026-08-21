import { ulid } from "ulid";
import { runCodexAppServerTurn } from "../packages/albert-codex/src/app-server.js";

type PlanEntry = Readonly<{ step?: unknown; status?: unknown }>;

const cases = Object.freeze([
  Object.freeze({
    id: "multi_domain_health",
    expectedPlan: true,
    prompt: "Give Fixture Cycles a candid health check across sales, gross margin, customer retention, inventory ageing, workshop throughput, receivables, payables and labour capacity. Reconcile competing signals, state limitations and recommend one measurable experiment.",
  }),
  Object.freeze({
    id: "margin_driver_diagnosis",
    expectedPlan: true,
    prompt: "Diagnose why Fixture Cycles grew gross sales while gross margin fell. Separately test transaction volume, basket size, discounts, refunds, category mix, workshop contribution and labour capacity across equivalent periods, then rank the supported drivers.",
  }),
  Object.freeze({
    id: "stock_readiness",
    expectedPlan: true,
    prompt: "Assess Fixture Cycles' seasonal stock readiness by combining historical category demand, current stock, ageing, recent sell-through and purchasing signals. Identify overstock and shortage risks, challenge the assumptions and propose a reviewable action plan.",
  }),
  Object.freeze({
    id: "workshop_capacity",
    expectedPlan: true,
    prompt: "Determine whether workshop performance is constrained by demand or capacity. Compare intake, invoiced work, service sales, workorder mix, recorded labour, Deputy worked hours and rostered hours, then explain what the evidence can and cannot establish.",
  }),
  Object.freeze({
    id: "customer_health",
    expectedPlan: true,
    prompt: "Evaluate customer health using identification coverage, new and returning mix, repeat cohorts, concentration, lapsing, contactability and category affinity. Find the strongest retention risk and design one measurable win-back experiment without exposing customer details.",
  }),
  Object.freeze({
    id: "scalar_control",
    expectedPlan: false,
    prompt: "What were Fixture Cycles' net sales yesterday?",
  }),
]);

const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
if (!apiKey) throw new Error("OPENAI_API_KEY is unavailable for the Codex plan smoke test.");

async function runCase(testCase: typeof cases[number]) {
  const timeline: string[] = [];
  const planSnapshots: Array<readonly PlanEntry[]> = [];
  let queryCalls = 0;
  let toolCalls = 0;
  const startedAt = Date.now();
  const result = await runCodexAppServerTurn({
    apiKey,
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    model: "gpt-5.6-luna",
    effort: "max",
    fastMode: true,
    input: JSON.stringify({
      notice: "This is a synthetic plan-behaviour evaluation. All entities and values are fictional.",
      currentQuestion: testCase.prompt,
    }),
    baseInstructions: `You are a read-only business analyst evaluating Fixture Cycles with synthetic data.
For every genuinely multi-step investigation, create a two-to-six-step plan with the built-in plan tool before the first analytical query and update that same plan as work progresses. Simple one-query lookups do not need a plan.
Use only the Albert tools. Stop when the supplied synthetic evidence is sufficient. Return the required structured final answer.`,
    developerInstructions: "Investigate efficiently, distinguish evidence from inference, and do not repeat an equivalent successful query.",
    onNotification(method, params) {
      if (method !== "turn/plan/updated" || typeof params !== "object" || params === null) return;
      const plan = Array.isArray((params as { plan?: unknown }).plan)
        ? (params as { plan: PlanEntry[] }).plan
        : [];
      timeline.push("plan");
      planSnapshots.push(plan.map((entry) => ({ step: entry.step, status: entry.status })));
    },
    async onToolCall(call) {
      toolCalls += 1;
      timeline.push(call.tool === "run_semantic_query" ? "query" : `tool:${call.tool}`);
      if (call.tool === "search_semantic_catalogue") {
        return {
          success: true,
          text: JSON.stringify({
            ok: true,
            matches: [
              { name: "sales_analytics", purpose: "Sales, margin, discounts and refunds" },
              { name: "customer_analytics", purpose: "Aggregate customer health" },
              { name: "inventory_analytics", purpose: "Stock and ageing" },
              { name: "workshop_analytics", purpose: "Workshop demand and throughput" },
              { name: "xero_profit_and_loss", purpose: "Accounting performance" },
              { name: "deputy_timesheet_analytics", purpose: "Worked and rostered hours" },
            ],
          }),
        };
      }
      if (call.tool === "get_view_schema") {
        return {
          success: true,
          text: JSON.stringify({
            ok: true,
            views: [{
              name: "fixture_analytics",
              members: [
                { name: "fixture_analytics.metric", kind: "dimension", type: "string" },
                { name: "fixture_analytics.current_value", kind: "measure", type: "number" },
                { name: "fixture_analytics.prior_value", kind: "measure", type: "number" },
              ],
            }],
          }),
        };
      }
      if (call.tool === "run_semantic_query") {
        queryCalls += 1;
        if (queryCalls > 4) {
          return {
            success: false,
            text: JSON.stringify({
              ok: false,
              error: "synthetic_evidence_complete",
              guidance: "Four distinct synthetic evidence checks are already available. Reuse them, settle the plan and answer.",
            }),
          };
        }
        return {
          success: true,
          text: JSON.stringify({
            ok: true,
            resultId: ulid(),
            view: "fixture_analytics",
            columns: [
              { key: "metric", label: "Metric", type: "string" },
              { key: "current_value", label: "Current value", type: "number" },
              { key: "prior_value", label: "Prior value", type: "number" },
            ],
            rows: [
              { metric: `Synthetic check ${queryCalls}`, current_value: 100 + queryCalls, prior_value: 96 + queryCalls },
            ],
            rowCount: 1,
            hostGeneratedClaims: [],
            guidance: queryCalls >= 4
              ? "The synthetic evidence set is complete. Update the plan and answer."
              : "Use this result, then gather only a distinct missing check.",
          }),
        };
      }
      if (call.tool === "report_evidence_update") {
        return { success: true, text: JSON.stringify({ ok: true }) };
      }
      if (call.tool === "make_chart") {
        return { success: false, text: JSON.stringify({ ok: false, error: "not_needed_for_plan_test" }) };
      }
      return { success: false, text: JSON.stringify({ ok: false, error: "unknown_tool" }) };
    },
  });

  const firstPlan = timeline.indexOf("plan");
  const firstQuery = timeline.indexOf("query");
  const finalPlan = planSnapshots.at(-1) ?? [];
  return Object.freeze({
    id: testCase.id,
    expectedPlan: testCase.expectedPlan,
    planEventCount: planSnapshots.length,
    stepCount: planSnapshots[0]?.length ?? 0,
    firstPlanBeforeFirstQuery: firstPlan >= 0 && (firstQuery < 0 || firstPlan < firstQuery),
    sawStatusProgression: new Set(planSnapshots.map((plan) => plan.map((step) => step.status).join("|"))).size > 1,
    finalNativePlanCompleted: finalPlan.length > 0 && finalPlan.every((step) => step.status === "completed"),
    queryCalls,
    toolCalls,
    durationMs: Date.now() - startedAt,
    completed: Boolean(result.turnId),
  });
}

const results: Awaited<ReturnType<typeof runCase>>[] = [];
let nextCase = 0;
await Promise.all(Array.from({ length: 2 }, async () => {
  while (nextCase < cases.length) {
    const testCase = cases[nextCase++]!;
    try {
      results.push(await runCase(testCase));
    } catch (error) {
      results.push({
        id: testCase.id,
        expectedPlan: testCase.expectedPlan,
        planEventCount: 0,
        stepCount: 0,
        firstPlanBeforeFirstQuery: false,
        sawStatusProgression: false,
        finalNativePlanCompleted: false,
        queryCalls: 0,
        toolCalls: 0,
        durationMs: 0,
        completed: false,
        error: error instanceof Error ? error.message.slice(0, 240) : "Unknown failure",
      } as Awaited<ReturnType<typeof runCase>> & { error: string });
    }
  }
}));
results.sort((left, right) => cases.findIndex((entry) => entry.id === left.id) - cases.findIndex((entry) => entry.id === right.id));
const failures = results.filter((result) => result.expectedPlan
  ? !result.completed
    || result.planEventCount < 1
    || result.stepCount < 2
    || result.stepCount > 6
    || !result.firstPlanBeforeFirstQuery
    || !result.sawStatusProgression
  : !result.completed || result.planEventCount !== 0);
process.stdout.write(`${JSON.stringify({
  model: "gpt-5.6-luna",
  effort: "max",
  fastMode: true,
  syntheticOnly: true,
  passed: failures.length === 0,
  failedCaseIds: failures.map((result) => result.id),
  results,
}, null, 2)}\n`);
if (failures.length > 0) process.exitCode = 1;
