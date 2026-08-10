import assert from "node:assert/strict";
import test from "node:test";
import {
  ANALYSIS_EXECUTION_PROFILES,
  analysisProfileInstruction,
} from "../../services/conversation/src/analysis-orchestration.js";
import {
  analysisComplexityFromInterpretation,
  canonicalizeContextualTurnInterpretation,
  contextualTurnInterpretationSchema,
} from "../../services/conversation/src/conversation-understanding.js";
import {
  analyticalReviewInput,
  buildSqlEvidenceInstructions,
  canonicalizeAnalyticalReview,
  createAnalyticalReviewerAgent,
  createPrimaryAnalystAgent,
  createTerminalRelevanceReviewerAgent,
  createTerminalResynthesisAgent,
  domainSchemaInstructions,
  terminalRelevanceReviewInput,
} from "../../services/conversation/src/live.js";

const preferences = Object.freeze({
  model: "gpt-5.6-sol",
  reasoningEffort: "high" as const,
  fastMode: true,
});

function modelResolvedContract(
  lane: "lookup" | "standard" | "deep",
  domains: readonly ("sales" | "inventory" | "customers" | "workforce" | "finance" | "operations")[],
) {
  const question = "Resolve this analytical request without keyword routing.";
  return analysisComplexityFromInterpretation(contextualTurnInterpretationSchema.parse({
    continuity: "standalone",
    resolvedQuestion: question,
    resolvedSubject: null,
    lane,
    domains,
    requestedWorkstreams: ["Answer the resolved business question"],
    policyRouteCaseId: null,
    reason: `The request interpreter selected the ${lane} resource profile.`,
  }));
}

test("a model-resolved factual request uses the quick lookup lane", () => {
  const latestSale = modelResolvedContract("lookup", ["sales"]);
  assert.equal(latestSale.lane, "lookup");
  assert.deepEqual(latestSale.domains, ["sales"]);
  assert.equal(latestSale.profile.maxResults, 2);
  assert.equal(latestSale.profile.analyticalBudgetMs, 180_000);
  assert.equal(latestSale.profile.resilienceResultAllowance, 4);
  assert.ok(latestSale.profile.resilienceMaxTurns > latestSale.profile.maxTurns);
  assert.match(analysisProfileInstruction(latestSale), /run the smallest real business query directly/u);
  assert.match(analysisProfileInstruction(latestSale), /aggregate in one row even when there are no matching facts/iu);
  assert.match(analysisProfileInstruction(latestSale), /empty filtered result does not fully answer/iu);
});

test("a model-resolved comparison stays with one lead analyst", () => {
  const trend = modelResolvedContract("standard", ["sales"]);
  assert.equal(trend.lane, "standard");
  assert.deepEqual(trend.domains, ["sales"]);
  assert.equal(trend.profile.reviewerEnabled, false);
});

test("a model-resolved diagnostic activates deep orchestration", () => {
  const diagnostic = modelResolvedContract("deep", ["sales", "finance"]);
  assert.equal(diagnostic.lane, "deep");
  assert.equal(diagnostic.profile.reviewerEnabled, true);

  const review = modelResolvedContract("deep", ["sales", "inventory", "customers", "workforce"]);
  assert.equal(review.lane, "deep");
  assert.deepEqual(review.domains, ["sales", "inventory", "customers", "workforce"]);
  assert.equal(review.profile.maxSpecialists, 4);
});

test("deep work has a bounded long-run profile, not an unlimited loop", () => {
  const deep = ANALYSIS_EXECUTION_PROFILES.deep;
  assert.equal(deep.analyticalBudgetMs, 900_000);
  assert.ok(deep.maxTurns > ANALYSIS_EXECUTION_PROFILES.standard.maxTurns);
  assert.ok(deep.maxResults > ANALYSIS_EXECUTION_PROFILES.standard.maxResults);
  assert.equal(deep.maxResults, 12);
  assert.equal(deep.specialistMaxTurns, 10);
  assert.ok(deep.wrapUpReserveMs >= 120_000);
  assert.ok(deep.repairMaxTurns > 0);
});

test("deep interpretations must identify a specialist-capable domain", () => {
  const parsed = contextualTurnInterpretationSchema.safeParse({
    continuity: "standalone",
    resolvedQuestion: "Assess the business deeply.",
    resolvedSubject: null,
    lane: "deep",
    domains: [],
    requestedWorkstreams: ["Assess the business"],
    policyRouteCaseId: null,
    reason: "Deep analysis requested.",
  });
  assert.equal(parsed.success, false);
});

test("equivalent interpreter rewrites are canonicalised instead of discarding the lane decision", () => {
  const parsed = contextualTurnInterpretationSchema.parse({
    continuity: "standalone",
    resolvedQuestion: "What were completed net sales excluding GST for yesterday?",
    resolvedSubject: {
      label: "Yesterday's completed net sales",
      kind: "sales metric",
      resolvedQuestion: "How much net sales excluding GST did we complete yesterday?",
    },
    lane: "lookup",
    domains: ["sales"],
    requestedWorkstreams: ["Return yesterday's completed net sales excluding GST"],
    policyRouteCaseId: null,
    reason: "This is one bounded factual lookup.",
  });

  const canonical = canonicalizeContextualTurnInterpretation(parsed);
  assert.equal(canonical.lane, "lookup");
  assert.equal(canonical.resolvedSubject?.resolvedQuestion, canonical.resolvedQuestion);
  assert.equal(canonical.resolvedSubject?.label, "Yesterday's completed net sales");
});

test("only deep managers receive bounded domain specialists", () => {
  const standardContract = modelResolvedContract("standard", ["sales"]);
  const standardAgent = createPrimaryAnalystAgent(preferences, undefined, undefined, standardContract);
  assert.equal(standardAgent.tools.some(({ name }) => name.startsWith("research_")), false);
  assert.equal(standardAgent.modelSettings.parallelToolCalls, false);

  const deepContract = modelResolvedContract("deep", ["sales", "inventory", "customers", "workforce"]);
  const deepAgent = createPrimaryAnalystAgent(preferences, undefined, undefined, deepContract);
  assert.deepEqual(
    deepAgent.tools.filter(({ name }) => name.startsWith("research_")).map(({ name }) => name),
    ["research_sales", "research_inventory", "research_customers", "research_workforce"],
  );
  assert.equal(deepAgent.modelSettings.parallelToolCalls, true);
});

test("deep reviews expose exactly the model-selected specialist domains", () => {
  const agent = createPrimaryAnalystAgent(
    preferences,
    undefined,
    undefined,
    modelResolvedContract("deep", ["finance", "operations"]),
  );
  assert.deepEqual(
    agent.tools.filter(({ name }) => name.startsWith("research_")).map(({ name }) => name),
    ["research_finance", "research_operations"],
  );
});

test("model-selected domains receive the correct cross-source analytical surface", () => {
  const salesPrompt = buildSqlEvidenceInstructions(undefined, modelResolvedContract("standard", ["sales"]));
  assert.doesNotMatch(salesPrompt, /source_deputy\.timesheets/u);
  assert.doesNotMatch(salesPrompt, /source_xero\.xero_invoices/u);

  const workforcePrompt = buildSqlEvidenceInstructions(
    undefined,
    modelResolvedContract("deep", ["sales", "workforce"]),
  );
  assert.match(workforcePrompt, /mart\.workforce_sales_aligned/u);
  assert.match(workforcePrompt, /source_deputy\.timesheets/u);
  assert.match(workforcePrompt, /planned rosters and actual worked time/iu);
  assert.match(workforcePrompt, /employee\(text\)/iu);
  assert.match(workforcePrompt, /Never join IDs across those systems/u);
  assert.match(workforcePrompt, /Do not query information_schema, pg_catalog/u);
  assert.match(workforcePrompt, /Lightspeed employee_id is a numeric POS identifier/u);
  assert.match(domainSchemaInstructions(["sales", "workforce"]), /mart\.workforce_sales_aligned/u);
  assert.match(domainSchemaInstructions(["sales", "workforce"]), /source_deputy\.timesheets/u);

  const financePrompt = buildSqlEvidenceInstructions(
    undefined,
    modelResolvedContract("deep", ["sales", "finance"]),
  );
  assert.match(financePrompt, /mart\.reconciliation_aligned/u);
  assert.match(financePrompt, /source_xero\.xero_invoices/u);
});

test("independent reviewer has no data tools and receives the full review contract", () => {
  const reviewer = createAnalyticalReviewerAgent(preferences);
  assert.deepEqual(reviewer.tools, []);
  assert.match(String(reviewer.instructions), /Do not demand extra analysis merely because more analysis is possible/u);

  const packet = JSON.parse(analyticalReviewInput(
    "Review sales, inventory and customers",
    {
      state: "Qualified",
      text: "Supported partial answer.",
      claims: [],
      followUps: [],
      scope: null,
    },
    ["sales", "inventory", "customers"],
    new Map(),
    new Map(),
    [],
    ["Inventory lookup was unavailable"],
  )) as Readonly<Record<string, unknown>>;
  assert.deepEqual(packet.requestedWorkstreams, ["sales", "inventory", "customers"]);
  assert.deepEqual(packet.unresolvedFailures, ["Inventory lookup was unavailable"]);
  assert.deepEqual(packet.evidence, []);
});

test("review execution derives its verdict from material issues instead of brittle duplicate fields", () => {
  const repair = canonicalizeAnalyticalReview({
    verdict: "pass",
    summary: "The answer needs one bounded correction.",
    requiresMoreEvidence: false,
    issues: [{
      code: "unsupported_conclusion",
      detail: "The conclusion is stronger than the evidence.",
      repairInstruction: "Qualify the conclusion using the supplied result.",
    }],
  });
  assert.equal(repair.verdict, "repair");

  const pass = canonicalizeAnalyticalReview({
    verdict: "repair",
    summary: "No material defects remain.",
    requiresMoreEvidence: false,
    issues: [],
  });
  assert.equal(pass.verdict, "pass");
});

test("terminal relevance and resynthesis are tool-less and review the post-transformation answer", () => {
  const reviewer = createTerminalRelevanceReviewerAgent(preferences);
  const resynthesis = createTerminalResynthesisAgent(preferences);
  assert.deepEqual(reviewer.tools, []);
  assert.deepEqual(resynthesis.tools, []);
  assert.match(String(reviewer.instructions), /after every server-side transformation/iu);
  assert.match(String(reviewer.instructions), /completed lookup found no match[\s\S]*direct negative conclusion/iu);
  assert.match(String(reviewer.instructions), /latest business-event date is activity/iu);
  assert.match(String(reviewer.instructions), /currency[\s\S]*two decimal places/iu);
  assert.match(String(resynthesis.instructions), /Never replace a supported answer with a generic refusal/iu);

  const packet = JSON.parse(terminalRelevanceReviewInput({
    currentUserMessage: "They are the only transactions?",
    resolvedQuestion: "Are these the only transactions for Tom Lidgett?",
    resolvedSubject: {
      label: "Tom Lidgett transactions",
      kind: "customer transactions",
      resolvedQuestion: "Are these the only transactions for Tom Lidgett?",
    },
    candidate: {
      state: "Qualified",
      text: "Tom Lidgett has more records than the one previously shown.",
      scope: null,
      presentedResultIds: [],
    },
    results: new Map(),
    purposes: new Map(),
  })) as Readonly<Record<string, unknown>>;
  assert.equal(packet.currentUserMessage, "They are the only transactions?");
  assert.equal(packet.resolvedQuestion, "Are these the only transactions for Tom Lidgett?");
  assert.deepEqual(packet.evidence, []);
});
