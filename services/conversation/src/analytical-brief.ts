import { createHash } from "node:crypto";
import type { AnalyticalBrief } from "../../../packages/shared/src/index.js";

type Freshness = Readonly<{
  connector: string;
  dataThrough: string | null;
}>;

const EMPLOYEE_PERFORMANCE = /\b(?:(?:which|what)\s+(?:employee|staff member|worker).*(?:best|top|strongest)|(?:best|top|strongest)\s+(?:employee|staff member|worker)|(?:employee|staff|worker)\s+performance|performed\s+the\s+best)\b/iu;
const TESTABLE_OPPORTUNITY = /\b(?:(?:one|single|best|strongest|high[- ]confidence)\s+)?(?:opportunit(?:y|ies)|initiative|experiment|test)\b/iu;
const DECISION_MODEL = /\b(?:can\s+(?:i|we|the\s+business)\s+(?:afford|support|sustain|justify)|should\s+(?:i|we)\s+(?:hire|buy|open|close|drop|add|extend|invest)|(?:is|was|be)\s+(?:it|this|that|[a-z\s]{1,30})\s+worth\s+(?:it|the))\b/iu;
// A goal-seek ask names a numeric yardstick: an amount the owner wants to
// save, make, free up, or stay under. Both halves must be present — an amount
// AND a goal verb — so plain lookups with numbers ("top 10 products") and
// verbs without amounts ("how do I save money?") stay on their own briefs.
const TARGET_AMOUNT = /(?:\$\s?\d[\d,]*(?:\.\d+)?\s*(?:k|m)?\b|\b\d[\d,]*(?:\.\d+)?\s*(?:k|m|grand|dollars?|bucks?|percent|per\s?cent)\b|\d(?:\.\d+)?\s*%|\b(?:a|one)\s+(?:thousand|grand)\b|\b(?:five|ten)\s+hundred\b)/iu;
const TARGET_GOAL_VERB = /\b(?:save|savings?|cut(?:ting)?|trim|reduce|reduc(?:e|ing|tion)|shave|free\s+up|find|unlock|claw\s+back|recover|make|earn|add|extra|additional|increase|grow|boost|lift|bring\s+in|generate|get\s+(?:it|that|[a-z\s]{0,24})\s*(?:under|below|down\s+to)|keep\s+[a-z\s]{0,24}\s*(?:under|below)|under|below|target(?:ing)?)\b/iu;
const FRAMEWORK_QUESTION = /\b(?:how\s+(?:should|do|would)\s+(?:i|we)\s+(?:best\s+)?(?:think\s+about|approach|price|structure|evaluate|reason\s+about)|what(?:'s|\s+is)\s+a\s+(?:sensible|good|healthy)\s+(?:way|target|benchmark)|what\s+(?:kpis?|metrics)\s+should|frameworks?\s+appl)/iu;

function connectorFamily(value: string): "lightspeed" | "deputy" | string {
  const normalized = value.toLowerCase().replaceAll("_", "-");
  if (["lightspeed", "lightspeed-r", "lightspeed-r-series", "lightspeed-retail"].includes(normalized)) return "lightspeed";
  if (normalized === "deputy") return "deputy";
  return normalized;
}

function dateOnly(value: string | null | undefined): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})/u.exec(value ?? "");
  return match?.[1] ?? null;
}

function stableDigest(value: Omit<AnalyticalBrief, "digest">): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

export function buildSharedAnalyticalBrief(input: Readonly<{
  message: string;
  activeConnectors?: readonly string[];
  connectorFreshness?: readonly Freshness[];
  includeGeneric?: boolean;
}>): AnalyticalBrief | undefined {
  const employeePerformance = EMPLOYEE_PERFORMANCE.test(input.message);
  const testableOpportunity = TESTABLE_OPPORTUNITY.test(input.message);
  const targetGoal = !employeePerformance && !testableOpportunity
    && TARGET_AMOUNT.test(input.message) && TARGET_GOAL_VERB.test(input.message);
  const decisionModel = !employeePerformance && !testableOpportunity && !targetGoal && DECISION_MODEL.test(input.message);
  const frameworkQuestion = !employeePerformance && !testableOpportunity && !targetGoal && !decisionModel && FRAMEWORK_QUESTION.test(input.message);
  if (!employeePerformance && !testableOpportunity && !targetGoal && !decisionModel && !frameworkQuestion && !input.includeGeneric) return undefined;
  const active = new Set((input.activeConnectors ?? []).map(connectorFamily));
  const hasDeputy = active.has("deputy");
  const latestByConnector = new Map<string, string>();
  for (const entry of input.connectorFreshness ?? []) {
    const connector = connectorFamily(entry.connector);
    const date = dateOnly(entry.dataThrough);
    if (!["lightspeed", "deputy"].includes(connector) || !date) continue;
    if (!latestByConnector.has(connector) || date > latestByConnector.get(connector)!) {
      latestByConnector.set(connector, date);
    }
  }
  const relevantDates = [...latestByConnector.values()].sort();
  const brief = employeePerformance ? Object.freeze({
    id: "employee_performance_v1",
    version: 1,
    ownerGoal: "Identify the strongest current-period employee without mistaking longer hours for better performance.",
    answerMustCover: Object.freeze([
      "Rank employee-attributed POS contribution using takings, transactions and gross profit.",
      ...(hasDeputy ? ["Compare authoritative Deputy worked hours so total contribution is not confused with productivity."] : []),
      "Use a common like-for-like period for every productivity comparison.",
      "Explain POS attribution, source-identity and non-sales-duty limitations.",
    ]),
    requiredViews: Object.freeze([
      Object.freeze({ view: "sales_analytics", reason: "employee-attributed POS contribution" }),
      ...(hasDeputy ? [Object.freeze({ view: "workforce_analytics", reason: "authoritative worked hours and wage context" })] : []),
    ]),
    requiredCalculations: Object.freeze(hasDeputy
      ? ["takings_per_worked_hour", "gross_profit_per_worked_hour"]
      : []),
    commonPeriodEnd: relevantDates.length >= 2 ? relevantDates[0]! : null,
  } satisfies Omit<AnalyticalBrief, "digest">) : testableOpportunity ? Object.freeze({
    id: "testable_opportunity_v2",
    version: 2,
    ownerGoal: "Investigate the business broadly, compare distinct candidate opportunities, and turn the best-supported one into a bounded measurable experiment.",
    answerMustCover: Object.freeze([
      "Evaluate at least three genuinely different opportunity candidates across the available commercial, customer, product, inventory, workshop, workforce and cash lenses before selecting one.",
      "Explain why the selected opportunity is stronger than the alternatives on materiality, controllability, addressable population or lever, and measurement readiness.",
      "Specify the target, intervention, primary outcome, baseline, commercial guardrail and stop-or-expand decision rule.",
      "Separate retrieved evidence from hypothesis, consent assumptions and causal claims.",
    ]),
    requiredViews: Object.freeze([
      ...(active.has("lightspeed") ? [
        Object.freeze({ view: "sales_analytics", reason: "commercial baseline and trend materiality" }),
        Object.freeze({ view: "customer_analytics", reason: "customer population, value, recency and safe reachability context" }),
        Object.freeze({ view: "product_sales_analytics", reason: "product, category and workshop-line revenue and gross-profit opportunities" }),
        Object.freeze({ view: "inventory_analytics", reason: "stock availability, ageing and working-capital opportunity or constraint" }),
        Object.freeze({ view: "workshop_analytics", reason: "workshop demand, throughput and service-operation opportunity" }),
      ] : []),
      ...(active.has("deputy") ? [
        Object.freeze({ view: "workforce_analytics", reason: "worked-hours capacity and labour-cost context" }),
      ] : []),
      ...(active.has("xero") ? [
        Object.freeze({ view: "xero_finance_analytics", reason: "cash, receivables and payables constraints on the proposed experiment" }),
      ] : []),
    ]),
    requiredCalculations: Object.freeze([]),
    commonPeriodEnd: null,
  } satisfies Omit<AnalyticalBrief, "digest">) : targetGoal ? Object.freeze({
    id: "target_goal_v1",
    version: 1,
    ownerGoal: "Turn the owner's named numeric target into a concrete, quantified path: which specific levers, at what observed size, combine to reach it.",
    answerMustCover: Object.freeze([
      "Restate the owner's target as a number with its cadence (per week, per month, one-off) and use it as the yardstick throughout; convert a relative target to dollars from the owner's actual base, stating the base and period.",
      "Quantify each candidate lever at the target's cadence from governed evidence, naming the specific account, product, category, supplier, subscription or roster pattern — never an unnamed pool. Label recurring amounts versus one-offs.",
      "State whether the named levers together reach, approach or fall short of the target using a trusted derived total (never prose arithmetic), and give a direct verdict: achievable, achievable with stretch, or not from these levers.",
      "Rank the levers by size and controllability, and make each one actionable: what to change, in owner language.",
      "Separate observed evidence from proposed actions; state the one or two assumptions the verdict is most sensitive to.",
    ]),
    requiredViews: Object.freeze([]),
    requiredCalculations: Object.freeze([]),
    commonPeriodEnd: null,
  } satisfies Omit<AnalyticalBrief, "digest">) : decisionModel ? Object.freeze({
    id: "decision_model_v1",
    version: 1,
    ownerGoal: "Turn a yes/no business decision into a quantified model the owner can pressure-test, grounded in their own numbers.",
    answerMustCover: Object.freeze([
      "Quantify the cost side of the decision from governed data or a clearly attributed general estimate (for example a loaded wage from current wage rates).",
      "Quantify the offsetting gain required to break even, and compare it with the current observed baseline so the gap is explicit.",
      "State current headroom or constraint evidence (capacity, demand, cash) that bears on the decision.",
      "Separate observed evidence from assumptions, and state the one or two assumptions the verdict is most sensitive to.",
    ]),
    requiredViews: Object.freeze([]),
    requiredCalculations: Object.freeze([]),
    commonPeriodEnd: null,
  } satisfies Omit<AnalyticalBrief, "digest">) : frameworkQuestion ? Object.freeze({
    id: "framework_question_v1",
    version: 1,
    ownerGoal: "Give the owner a usable way to think about the question, then locate their own business inside that frame with governed numbers.",
    answerMustCover: Object.freeze([
      "Name the applicable framework or decision rule in plain language, in a sentence or two — not a lecture.",
      "State a general benchmark or target range where one is widely accepted, explicitly attributed as general industry guidance rather than the owner's data.",
      "Compute the owner's current position on that framework from governed evidence, or state exactly which input is missing and the nearest supported proxy.",
      "Close with the gap or implication: where the owner sits against the benchmark and what that suggests, without over-claiming causality.",
    ]),
    requiredViews: Object.freeze([]),
    requiredCalculations: Object.freeze([]),
    commonPeriodEnd: null,
  } satisfies Omit<AnalyticalBrief, "digest">) : Object.freeze({
    id: "general_analysis_v1",
    version: 1,
    ownerGoal: "Answer the owner's practical question at the depth it was asked, with governed evidence sufficient for a useful decision.",
    answerMustCover: Object.freeze([
      "Answer every explicit sub-question in the owner's message, or state exactly why one is unavailable, before adding any context.",
      "Answer the practical question directly rather than a narrower convenient proxy; a broad or open-ended question needs the material findings from the domains material to the ask — not from every reachable surface, and not a single highlight.",
      "Prefer insight over recital: comparisons, changes, concentrations and anomalies grounded in the evidence, including unexpected empty or implausible fields worth the owner's attention.",
      "Keep periods, definitions and populations consistent across comparisons.",
      "State material source, freshness, coverage and causality limitations once, briefly.",
    ]),
    requiredViews: Object.freeze([]),
    requiredCalculations: Object.freeze([]),
    commonPeriodEnd: null,
  } satisfies Omit<AnalyticalBrief, "digest">);
  return Object.freeze({ ...brief, digest: stableDigest(brief) });
}
