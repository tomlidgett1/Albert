import { createHash } from "node:crypto";
import type { AnalyticalBrief } from "../../../packages/shared/src/index.js";

type Freshness = Readonly<{
  connector: string;
  dataThrough: string | null;
}>;

const EMPLOYEE_PERFORMANCE = /\b(?:(?:which|what)\s+(?:employee|staff member|worker).*(?:best|top|strongest)|(?:best|top|strongest)\s+(?:employee|staff member|worker)|(?:employee|staff|worker)\s+performance|performed\s+the\s+best)\b/iu;
const TESTABLE_OPPORTUNITY = /\b(?:(?:one|single|best|strongest|high[- ]confidence)\s+)?(?:opportunit(?:y|ies)|initiative|experiment|test)\b/iu;

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
  if (!employeePerformance && !testableOpportunity && !input.includeGeneric) return undefined;
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
  } satisfies Omit<AnalyticalBrief, "digest">) : Object.freeze({
    id: "comparison_general_v1",
    version: 1,
    ownerGoal: "Answer the shared business question with sufficient governed evidence for a useful decision.",
    answerMustCover: Object.freeze([
      "Answer the practical question directly rather than a narrower convenient proxy.",
      "Keep periods, definitions and populations consistent across comparisons.",
      "State material source, freshness, coverage and causality limitations.",
    ]),
    requiredViews: Object.freeze([]),
    requiredCalculations: Object.freeze([]),
    commonPeriodEnd: null,
  } satisfies Omit<AnalyticalBrief, "digest">);
  return Object.freeze({ ...brief, digest: stableDigest(brief) });
}
