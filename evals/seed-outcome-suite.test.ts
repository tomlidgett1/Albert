import assert from "node:assert/strict";
import test from "node:test";

import {
  DOGFOOD_SEED_OUTCOME_SUITE_CASES,
  DOGFOOD_SEED_OUTCOME_SUITE_DIGEST,
  DOGFOOD_SEED_OUTCOME_SUITE_VERSION,
  buildDogfoodSeedObservedOutcomeEvidence,
  buildDogfoodSeedOutcomeManifestEvidence,
  validateDogfoodSeedObservedOutcomeEvidence,
  validateDogfoodSeedOutcomeManifestEvidence,
} from "./golden/seed-outcome-suite.mjs";
import { seedGoldenQuestions } from "./golden/questions.js";
import { evaluateCriticalPromptRouteQuestion } from "./runner.js";
import { promptRouteContractByCaseId } from "../services/conversation/src/prompt-routing.js";

type SeedOutcomeCase = Readonly<{
  caseId: string;
  prompt: string;
  promptDigest: string;
  expectedRoute: string;
  expectedState: string;
  requiredOutcome: Readonly<{
    kind?: string;
    evidenceSource?: string;
    fixtureValuesPermitted?: boolean;
    question?: string;
    optionIds?: readonly string[];
    reasonCode?: string;
    missingObservation?: string;
    unlock?: string;
    dataQueriesPermitted?: boolean;
  }>;
  requiredOutcomeDigest: string;
}>;

const suiteCases = DOGFOOD_SEED_OUTCOME_SUITE_CASES as readonly SeedOutcomeCase[];

test("the content-addressed outcome manifest binds all 25 seed prompts, routes and states in order", () => {
  assert.equal(DOGFOOD_SEED_OUTCOME_SUITE_VERSION, "albert-v1-seed-outcome-suite@1");
  assert.equal(
    DOGFOOD_SEED_OUTCOME_SUITE_DIGEST,
    "sha256:e067582fc9a2ecb7660400a7dad9a9ed04a9e80b93db127d857be8671ffebf3f",
  );
  assert.equal(suiteCases.length, 25);
  assert.deepEqual(
    suiteCases.map((item) => ({
      id: item.caseId,
      question: item.prompt,
      expectedRoute: item.expectedRoute,
      expectedState: item.expectedState,
    })),
    seedGoldenQuestions.map(({ id, question, expectedRoute, expectedState }) => ({
      id,
      question,
      expectedRoute,
      expectedState,
    })),
  );
  assert.equal(new Set(suiteCases.map(({ caseId }) => caseId)).size, 25);
  assert.ok(suiteCases.every(({ promptDigest, requiredOutcomeDigest }) =>
    /^sha256:[a-f0-9]{64}$/u.test(promptDigest)
      && /^sha256:[a-f0-9]{64}$/u.test(requiredOutcomeDigest)));
  for (const item of suiteCases) {
    if (item.expectedRoute === "semantic" || item.expectedRoute === "source_exploration") {
      assert.equal(item.requiredOutcome.evidenceSource, "live_candidate_tenant");
      assert.equal(item.requiredOutcome.fixtureValuesPermitted, false);
    }
  }
});

test("the four prompt-sensitive manifest outcomes exactly match production route contracts", () => {
  const criticalCases = suiteCases.filter(({ expectedRoute }) =>
    expectedRoute === "clarification" || expectedRoute === "unavailable");
  assert.equal(criticalCases.length, 4);
  for (const item of criticalCases) {
    const contract = promptRouteContractByCaseId(item.caseId);
    assert.ok(contract);
    assert.equal(contract.caseId, item.caseId);
    assert.equal(contract.route, item.expectedRoute);
    if (contract.route === "clarification") {
      assert.deepEqual(item.requiredOutcome, {
        kind: "server_owned_clarification",
        question: contract.question,
        optionIds: contract.optionIds,
        dataQueriesPermitted: false,
      });
    } else if (contract.route === "unavailable") {
      assert.deepEqual(item.requiredOutcome, {
        kind: "server_owned_unavailable",
        reasonCode: contract.reasonCode,
        missingObservation: contract.missingObservation,
        unlock: contract.unlock,
        dataQueriesPermitted: false,
      });
    } else {
      assert.fail(`Prompt-sensitive case ${item.caseId} resolved to the unexpected ${contract.route} route.`);
    }
  }
});

test("expected and observed evidence validators accept only the complete ordered suite", () => {
  const manifest = buildDogfoodSeedOutcomeManifestEvidence();
  assert.deepEqual(validateDogfoodSeedOutcomeManifestEvidence(manifest), manifest);

  const observed = buildDogfoodSeedObservedOutcomeEvidence(suiteCases.map((item) => ({
    observedRoute: item.expectedRoute,
    observedState: item.expectedState,
    observedOutcomeDigest: item.requiredOutcomeDigest,
    passed: true,
  })));
  assert.deepEqual(validateDogfoodSeedObservedOutcomeEvidence(observed), observed);
  assert.equal(Object.isFrozen(observed), true);
  assert.equal(Object.isFrozen(observed.cases), true);
});

test("a missing seed case fails both immutable-manifest and observed-outcome evidence", () => {
  const incompleteManifest = structuredClone(buildDogfoodSeedOutcomeManifestEvidence());
  incompleteManifest.cases.pop();
  assert.throws(
    () => validateDogfoodSeedOutcomeManifestEvidence(incompleteManifest),
    /exactly 25 cases/u,
  );

  const incompleteOutcomes = suiteCases.slice(0, -1).map((item) => ({
    observedRoute: item.expectedRoute,
    observedState: item.expectedState,
    observedOutcomeDigest: item.requiredOutcomeDigest,
    passed: true,
  }));
  assert.throws(
    () => buildDogfoodSeedObservedOutcomeEvidence(incompleteOutcomes),
    /must contain exactly 25 cases/u,
  );

  const additionalOutcome = [...incompleteOutcomes, incompleteOutcomes[0], incompleteOutcomes[1]];
  assert.throws(
    () => buildDogfoodSeedObservedOutcomeEvidence(additionalOutcome),
    /must contain exactly 25 cases/u,
  );
});

test("substituted prompts, order, outcomes and pass flags fail the protected evidence contract", () => {
  const substitutedPrompt = structuredClone(buildDogfoodSeedOutcomeManifestEvidence());
  substitutedPrompt.cases[0].promptDigest = substitutedPrompt.cases[1].promptDigest;
  assert.throws(
    () => validateDogfoodSeedOutcomeManifestEvidence(substitutedPrompt),
    /substituted promptDigest/u,
  );

  const reordered = structuredClone(buildDogfoodSeedOutcomeManifestEvidence());
  [reordered.cases[0], reordered.cases[1]] = [reordered.cases[1], reordered.cases[0]];
  assert.throws(
    () => validateDogfoodSeedOutcomeManifestEvidence(reordered),
    /substituted caseId/u,
  );

  const validObserved = buildDogfoodSeedObservedOutcomeEvidence(suiteCases.map((item) => ({
    observedRoute: item.expectedRoute,
    observedState: item.expectedState,
    observedOutcomeDigest: item.requiredOutcomeDigest,
    passed: true,
  })));
  const substitutedOutcome = structuredClone(validObserved);
  substitutedOutcome.cases[0].observedState = "qualified";
  assert.throws(
    () => validateDogfoodSeedObservedOutcomeEvidence(substitutedOutcome),
    /did not satisfy its required outcome/u,
  );

  const falsePass = structuredClone(validObserved);
  falsePass.cases[0].passed = false;
  assert.throws(
    () => validateDogfoodSeedObservedOutcomeEvidence(falsePass),
    /did not satisfy its required outcome/u,
  );
});

test("the deterministic runner binds critical routes by case id, not prompt regex", () => {
  const workforce = seedGoldenQuestions.find(({ id }) => id === "workforce-best");
  const finance = seedGoldenQuestions.find(({ id }) => id === "finance-profit");
  assert.ok(workforce && finance);
  // Intent+Plan selects caseId; the eval harness trusts the golden case id.
  // A swapped prompt with the workforce-best id still resolves that contract.
  const result = evaluateCriticalPromptRouteQuestion({
    ...workforce,
    question: finance.question,
  });
  assert.equal(result.outcome, "passed");
  assert.equal(result.route, "clarification");
  assert.throws(
    () => evaluateCriticalPromptRouteQuestion({
      ...workforce,
      id: "not-a-critical-case",
    }),
    /not a trusted critical route case id/u,
  );
});
