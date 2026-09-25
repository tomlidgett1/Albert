export const ANALYSIS_LANES = ["lookup", "standard", "deep"] as const;
export type AnalysisLane = (typeof ANALYSIS_LANES)[number];

export const BUSINESS_ANALYSIS_DOMAINS = [
  "sales",
  "inventory",
  "customers",
  "workforce",
  "finance",
  "operations",
] as const;
export type BusinessAnalysisDomain = (typeof BUSINESS_ANALYSIS_DOMAINS)[number];

export type AnalysisExecutionProfile = Readonly<{
  lane: AnalysisLane;
  label: string;
  analyticalBudgetMs: number;
  wrapUpReserveMs: number;
  maxTurns: number;
  maxResults: number;
  /** One bounded continuation when every successful lookup result is empty. */
  resilienceMaxTurns: number;
  /** Extra evidence capacity exposed only inside that continuation. */
  resilienceResultAllowance: number;
  specialistMaxTurns: number;
  maxSpecialists: number;
  reviewerEnabled: boolean;
  repairMaxTurns: number;
}>;

export const ANALYSIS_EXECUTION_PROFILES: Readonly<Record<AnalysisLane, AnalysisExecutionProfile>> = Object.freeze({
  lookup: Object.freeze({
    lane: "lookup",
    label: "Quick lookup",
    analyticalBudgetMs: 180_000,
    wrapUpReserveMs: 30_000,
    maxTurns: 12,
    maxResults: 2,
    resilienceMaxTurns: 14,
    resilienceResultAllowance: 4,
    specialistMaxTurns: 0,
    maxSpecialists: 0,
    reviewerEnabled: false,
    repairMaxTurns: 0,
  }),
  standard: Object.freeze({
    lane: "standard",
    label: "Business analysis",
    analyticalBudgetMs: 240_000,
    wrapUpReserveMs: 50_000,
    maxTurns: 32,
    maxResults: 8,
    resilienceMaxTurns: 12,
    resilienceResultAllowance: 4,
    specialistMaxTurns: 0,
    maxSpecialists: 0,
    reviewerEnabled: false,
    repairMaxTurns: 0,
  }),
  deep: Object.freeze({
    lane: "deep",
    label: "Deep business review",
    analyticalBudgetMs: 900_000,
    wrapUpReserveMs: 120_000,
    maxTurns: 48,
    maxResults: 12,
    resilienceMaxTurns: 12,
    resilienceResultAllowance: 4,
    specialistMaxTurns: 10,
    maxSpecialists: 4,
    reviewerEnabled: true,
    repairMaxTurns: 10,
  }),
});

export type AnalysisComplexityContract = Readonly<{
  lane: AnalysisLane;
  profile: AnalysisExecutionProfile;
  domains: readonly BusinessAnalysisDomain[];
  reasons: readonly string[];
}>;

export const DEFAULT_ANALYSIS_COMPLEXITY: AnalysisComplexityContract = Object.freeze({
  lane: "standard",
  profile: ANALYSIS_EXECUTION_PROFILES.standard,
  domains: Object.freeze([]),
  reasons: Object.freeze(["safe-fallback-after-interpretation-failure"]),
});

export function analysisProfileInstruction(contract: AnalysisComplexityContract): string {
  if (contract.lane === "lookup") {
    return `\n\nEXECUTION PROFILE — QUICK LOOKUP
- This is a narrow factual lookup, not a research report.
- Record a one-step plan, then use the known playbook and run the smallest real business query directly.
- Do not search the schema, load table definitions, or open a dimension guide unless the first real query proves the known route is invalid.
- Return one concise answer with the useful qualifier (definition, scope or freshness). Do not repeat a one-row result as a markdown table unless the owner asked for a table.
- For a count or sum, make the first query return the requested boundary and aggregate in one row even when there are no matching facts; do not select a pre-aggregated daily row that vanishes on a zero-activity date.
- Stop after the first result that fully answers the question. An empty filtered result does not fully answer an identity or record lookup: revise the route and establish whether representation, field choice, relationship or source coverage explains it before concluding no match.`;
  }
  if (contract.lane === "deep") {
    return `\n\nEXECUTION PROFILE — DEEP BUSINESS REVIEW
- You are the lead analyst and retain final-answer ownership. Delegate independent domain work to the available specialist-agent tools after recording the initial plan.
- Run independent specialists in parallel when their evidence does not depend on another workstream. Use their governed result references through the shared evidence ledger; never ask them for free-standing invented figures.
- Integrate the evidence across workstreams, test material alternative explanations, and distinguish measured facts, interpretation, risks and recommendations.
- A separate reviewer will evaluate the draft and may return one bounded repair request. Preserve useful partial findings when any specialist fails.`;
  }
  return `\n\nEXECUTION PROFILE — STANDARD BUSINESS ANALYSIS
- Keep one lead analyst in control. Gather the smallest set of results that establishes the answer, relevant comparison and material drivers.
- Do not delegate to specialists. Stop once the evidence supports a decision-useful conclusion.`;
}
