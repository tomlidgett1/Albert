import { createHash } from "node:crypto";

export const DOGFOOD_SEED_OUTCOME_SUITE_VERSION = "albert-v1-seed-outcome-suite@1";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function deeplyFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deeplyFreeze(child);
  }
  return value;
}

const semanticOutcome = Object.freeze({
  kind: "governed_semantic_result",
  evidenceSource: "live_candidate_tenant",
  fixtureValuesPermitted: false,
});

const caseDefinitions = [
  ["sales-month-vs-last", "Net sales this month versus last, like for like on the partial month.", "semantic", "verified", semanticOutcome],
  ["sales-category", "Which categories are performing well this month?", "semantic", "verified", semanticOutcome],
  ["sales-products-margin", "Top ten products by gross margin this quarter.", "semantic", "qualified", semanticOutcome],
  ["sales-aov-trend", "Average order value trend over six months.", "semantic", "verified", semanticOutcome],
  ["sales-discount-location", "Discount rate by location last month.", "semantic", "verified", semanticOutcome],
  ["sales-refund-rate", "Refund rate this quarter versus last.", "semantic", "verified", semanticOutcome],
  ["inventory-overstocked", "Which categories are overstocked by stock cover?", "semantic", "verified", semanticOutcome],
  ["inventory-sell-through", "Sell-through over the last 30 days.", "semantic", "verified", semanticOutcome],
  ["inventory-out", "What is out of stock right now?", "semantic", "verified", semanticOutcome],
  ["inventory-dead", "Show dead stock with no sales in 90 days.", "semantic", "qualified", semanticOutcome],
  ["customers-new-returning", "New versus returning customers this month.", "semantic", "qualified", semanticOutcome],
  ["customers-lapsed", "Customers lapsed in the last six months.", "semantic", "qualified", semanticOutcome],
  ["customers-repeat", "Repeat purchase rate this year.", "semantic", "qualified", semanticOutcome],
  ["workforce-best", "Which employees working today performed best over six months?", "clarification", "clarification", {
    kind: "server_owned_clarification",
    question: "What should ‘performed best’ mean for this answer?",
    optionIds: [
      "employee.net_sales",
      "employee.gross_margin",
      "employee.gross_profit_per_labour_hour",
    ],
    dataQueriesPermitted: false,
  }],
  ["workforce-roster-vs-worked", "Rostered versus worked hours last week by location.", "semantic", "verified", semanticOutcome],
  ["workforce-labour-percent", "Labour cost as a percentage of sales by week this quarter.", "semantic", "qualified", semanticOutcome],
  ["workforce-overtime", "Overtime hours last fortnight.", "unavailable", "unavailable", {
    kind: "server_owned_unavailable",
    reasonCode: "overtime_duration_not_observed",
    missingObservation: "governed Deputy overtime duration",
    unlock: "connected source field providing governed overtime duration",
    dataQueriesPermitted: false,
  }],
  ["workforce-sales-hour", "Sales per worked hour by location.", "semantic", "verified", semanticOutcome],
  ["finance-gst", "GST collected this quarter.", "semantic", "verified", semanticOutcome],
  ["finance-receivables", "Receivables outstanding right now.", "semantic", "verified", semanticOutcome],
  ["finance-profit", "What was profit last month?", "clarification", "clarification", {
    kind: "server_owned_clarification",
    question: "Which profit lens should Albert use for this answer?",
    optionIds: [
      "finance.operational_gross_margin",
      "finance.accounting_gross_profit",
      "finance.accounting_net_profit",
    ],
    dataQueriesPermitted: false,
  }],
  ["finance-cash-pos", "Cash receipts versus POS takings yesterday.", "semantic", "qualified", semanticOutcome],
  ["reconcile-bank", "Did Tuesday's takings reach the bank?", "semantic", "qualified", semanticOutcome],
  ["honesty-footfall", "Why did foot traffic decline?", "unavailable", "unavailable", {
    kind: "server_owned_unavailable",
    reasonCode: "foot_traffic_not_observed",
    missingObservation: "connected foot-traffic source or governed visit metric",
    unlock: "connected foot-traffic source and published governed visit metric",
    dataQueriesPermitted: false,
  }],
  ["exploration-staff-discount", "How many sales used the discount reason staff purchase?", "source_exploration", "exploratory", {
    kind: "governed_source_exploration",
    evidenceSource: "live_candidate_tenant",
    fixtureValuesPermitted: false,
    promotionCandidateRequired: true,
  }],
];

export const DOGFOOD_SEED_OUTCOME_SUITE_CASES = deeplyFreeze(caseDefinitions.map(([
  caseId,
  prompt,
  expectedRoute,
  expectedState,
  requiredOutcome,
]) => ({
  caseId,
  prompt,
  promptDigest: digest(prompt),
  expectedRoute,
  expectedState,
  requiredOutcome,
  requiredOutcomeDigest: digest(requiredOutcome),
})));

const calculatedSuiteDigest = digest({
  suiteVersion: DOGFOOD_SEED_OUTCOME_SUITE_VERSION,
  cases: DOGFOOD_SEED_OUTCOME_SUITE_CASES,
});

// This is intentionally content-addressed. Any prompt, order, route, state or
// required-outcome change must update both the suite version and this pin.
export const DOGFOOD_SEED_OUTCOME_SUITE_DIGEST = "sha256:e067582fc9a2ecb7660400a7dad9a9ed04a9e80b93db127d857be8671ffebf3f";

if (calculatedSuiteDigest !== DOGFOOD_SEED_OUTCOME_SUITE_DIGEST) {
  throw new Error(`Seed outcome suite digest drifted: expected ${DOGFOOD_SEED_OUTCOME_SUITE_DIGEST}, calculated ${calculatedSuiteDigest}.`);
}

function assertPlainObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value;
}

function assertExactKeys(value, expectedKeys, path) {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (canonicalJson(actualKeys) !== canonicalJson(sortedExpectedKeys)) {
    throw new Error(`${path} must contain exactly: ${sortedExpectedKeys.join(", ")}.`);
  }
}

function manifestCase(entry) {
  return Object.freeze({
    caseId: entry.caseId,
    promptDigest: entry.promptDigest,
    expectedRoute: entry.expectedRoute,
    expectedState: entry.expectedState,
    requiredOutcomeDigest: entry.requiredOutcomeDigest,
  });
}

/** Immutable expected requirements only; this is not evidence of a live run. */
export function buildDogfoodSeedOutcomeManifestEvidence() {
  return deeplyFreeze({
    suiteVersion: DOGFOOD_SEED_OUTCOME_SUITE_VERSION,
    suiteDigest: DOGFOOD_SEED_OUTCOME_SUITE_DIGEST,
    cases: DOGFOOD_SEED_OUTCOME_SUITE_CASES.map(manifestCase),
  });
}

export function validateDogfoodSeedOutcomeManifestEvidence(candidate) {
  const value = assertPlainObject(candidate, "seed outcome manifest evidence");
  assertExactKeys(value, ["suiteVersion", "suiteDigest", "cases"], "seed outcome manifest evidence");
  if (value.suiteVersion !== DOGFOOD_SEED_OUTCOME_SUITE_VERSION) {
    throw new Error("Seed outcome suite version does not match the code-owned manifest.");
  }
  if (value.suiteDigest !== DOGFOOD_SEED_OUTCOME_SUITE_DIGEST) {
    throw new Error("Seed outcome suite digest does not match the code-owned manifest.");
  }
  if (!Array.isArray(value.cases) || value.cases.length !== DOGFOOD_SEED_OUTCOME_SUITE_CASES.length) {
    throw new Error(`Seed outcome manifest evidence must contain exactly ${DOGFOOD_SEED_OUTCOME_SUITE_CASES.length} cases.`);
  }
  value.cases.forEach((candidateCase, index) => {
    const observed = assertPlainObject(candidateCase, `seed outcome manifest evidence cases[${index}]`);
    assertExactKeys(
      observed,
      ["caseId", "promptDigest", "expectedRoute", "expectedState", "requiredOutcomeDigest"],
      `seed outcome manifest evidence cases[${index}]`,
    );
    const expected = manifestCase(DOGFOOD_SEED_OUTCOME_SUITE_CASES[index]);
    for (const key of Object.keys(expected)) {
      if (observed[key] !== expected[key]) {
        throw new Error(`Seed outcome manifest evidence case ${index} has a substituted ${key}.`);
      }
    }
  });
  return deeplyFreeze(structuredClone(value));
}

/**
 * Merge actual case results with the immutable requirements. This function
 * validates rather than infers `passed`; callers must supply observed output
 * produced by the candidate-tenant acceptance run.
 */
export function buildDogfoodSeedObservedOutcomeEvidence(observedCases) {
  if (!Array.isArray(observedCases)) throw new Error("Observed seed outcomes must be an array.");
  if (observedCases.length !== DOGFOOD_SEED_OUTCOME_SUITE_CASES.length) {
    throw new Error(`Observed seed outcomes must contain exactly ${DOGFOOD_SEED_OUTCOME_SUITE_CASES.length} cases.`);
  }
  return validateDogfoodSeedObservedOutcomeEvidence({
    ...buildDogfoodSeedOutcomeManifestEvidence(),
    cases: DOGFOOD_SEED_OUTCOME_SUITE_CASES.map((expected, index) => ({
      ...manifestCase(expected),
      ...assertPlainObject(observedCases[index], `observed seed outcomes[${index}]`),
    })),
  });
}

export function validateDogfoodSeedObservedOutcomeEvidence(candidate) {
  const value = assertPlainObject(candidate, "observed seed outcome evidence");
  assertExactKeys(value, ["suiteVersion", "suiteDigest", "cases"], "observed seed outcome evidence");
  if (value.suiteVersion !== DOGFOOD_SEED_OUTCOME_SUITE_VERSION
    || value.suiteDigest !== DOGFOOD_SEED_OUTCOME_SUITE_DIGEST) {
    throw new Error("Observed seed outcome evidence is not bound to the code-owned suite.");
  }
  if (!Array.isArray(value.cases) || value.cases.length !== DOGFOOD_SEED_OUTCOME_SUITE_CASES.length) {
    throw new Error(`Observed seed outcome evidence must contain exactly ${DOGFOOD_SEED_OUTCOME_SUITE_CASES.length} cases.`);
  }
  value.cases.forEach((candidateCase, index) => {
    const observed = assertPlainObject(candidateCase, `observed seed outcome evidence cases[${index}]`);
    assertExactKeys(
      observed,
      [
        "caseId",
        "promptDigest",
        "expectedRoute",
        "expectedState",
        "requiredOutcomeDigest",
        "observedRoute",
        "observedState",
        "observedOutcomeDigest",
        "passed",
      ],
      `observed seed outcome evidence cases[${index}]`,
    );
    const expected = DOGFOOD_SEED_OUTCOME_SUITE_CASES[index];
    const expectedManifest = manifestCase(expected);
    for (const key of Object.keys(expectedManifest)) {
      if (observed[key] !== expectedManifest[key]) {
        throw new Error(`Observed seed outcome evidence case ${index} has a substituted ${key}.`);
      }
    }
    if (observed.observedRoute !== expected.expectedRoute
      || observed.observedState !== expected.expectedState
      || observed.observedOutcomeDigest !== expected.requiredOutcomeDigest
      || observed.passed !== true) {
      throw new Error(`Observed seed outcome evidence case ${expected.caseId} did not satisfy its required outcome.`);
    }
  });
  return deeplyFreeze(structuredClone(value));
}
