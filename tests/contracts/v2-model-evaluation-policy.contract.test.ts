import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  applyV2EvaluationGold,
  assertNoConflictingV2EvaluationEnvironment,
  assertV2EvaluationCorpus,
  assertV2PublicEvaluationBlueprint,
  bindV2SealedHoldout,
  sealedV2HoldoutPrompt,
  V2_EVALUATION_RUNTIME,
  v2EvaluationEnvironment,
} from "../../scripts/v2-evaluation-policy.js";
import { gradeV2ModelEvaluation } from "../../scripts/v2-evaluation-grading.js";
import { v2OwnerReviewWaiverDigest } from "../../scripts/v2-owner-review-waiver.js";

const corpus: unknown = JSON.parse(
  readFileSync("evals/v2-evaluation-corpus.json", "utf8"),
);

test("release blueprint locks all 200 allocations without committing holdout prompts", () => {
  assert.doesNotThrow(() => assertV2PublicEvaluationBlueprint(corpus));
  const cases = corpus as Array<{
    id: string;
    ask: string;
    visibility: string;
  }>;
  const hidden = cases.filter(({ visibility }) => visibility === "hidden");
  assert.equal(hidden.length, 40);
  assert.ok(hidden.every(({ id, ask }) => ask === sealedV2HoldoutPrompt(id)));
  const allocated = corpus as Array<{
    source: string;
    expectedTerminalState: string;
    grading: { oracleBlock: unknown | null };
  }>;
  assert.equal(
    allocated.filter(({ grading }) => grading.oracleBlock !== null).length,
    64,
  );
  assert.equal(
    allocated.filter(
      ({ source, expectedTerminalState }) =>
        source === "lightspeed_xero" && expectedTerminalState === "verified",
    ).length,
    0,
    "composite questions cannot be Verified before both source authorities are certified",
  );
});

test("sealed holdout binding requires exact reviewed metadata and non-public prompts", () => {
  assertV2PublicEvaluationBlueprint(corpus);
  const holdout = corpus
    .filter(({ visibility }) => visibility === "hidden")
    .map((evaluationCase) => ({
      ...evaluationCase,
      ask: `External sealed fixture ${evaluationCase.id}`,
    }));
  const combined = bindV2SealedHoldout(corpus, holdout);
  assert.equal(combined.length, 200);
  assert.throws(
    () => bindV2SealedHoldout(corpus, holdout.slice(1)),
    /exactly 40/iu,
  );
  assert.throws(
    () =>
      bindV2SealedHoldout(corpus, [
        { ...holdout[0]!, source: "lightspeed" },
        ...holdout.slice(1),
      ]),
    /metadata/iu,
  );
});

test("release evaluation is pinned to Luna Max in standard non-Fast non-Pro mode", () => {
  assert.deepEqual(V2_EVALUATION_RUNTIME, {
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    processingMode: "standard",
    fastMode: false,
    proMode: false,
    maximumAttempts: 1,
    turnTimeoutMs: 800_000,
    analyticalRuntime: "v2",
  });
  assert.deepEqual(v2EvaluationEnvironment(), {
    ALBERT_AGENT_QA_MODEL: "gpt-5.6-luna",
    ALBERT_AGENT_QA_EFFORT: "max",
    ALBERT_AGENT_QA_FAST_MODE: "false",
    ALBERT_AGENT_QA_PRO_MODE: "false",
    ALBERT_AGENT_QA_MAX_ATTEMPTS: "1",
    ALBERT_TURN_TIMEOUT_MS: "800000",
    ALBERT_ANALYTICAL_RUNTIME: "v2",
  });
  assert.throws(
    () =>
      assertNoConflictingV2EvaluationEnvironment({
        ALBERT_AGENT_QA_MODEL: "gpt-5.6-sol",
      }),
    /conflicts/iu,
  );
  assert.throws(
    () =>
      assertNoConflictingV2EvaluationEnvironment({
        ALBERT_AGENT_QA_FAST_MODE: "true",
      }),
    /conflicts/iu,
  );
  assert.throws(
    () =>
      assertNoConflictingV2EvaluationEnvironment({
        ALBERT_AGENT_QA_ONLY: "v2_001",
      }),
    /partial/iu,
  );
});

test("model-backed runner requires an explicit 200-case budget confirmation", () => {
  const runner = readFileSync("scripts/run-v2-model-evaluation.mts", "utf8");
  const harness = readFileSync(".albert-agent-qa.mts", "utf8");
  assert.match(runner, /--execute/u);
  assert.match(runner, /--confirm-budget=200/u);
  assert.match(runner, /assertV2PublicEvaluationBlueprint/u);
  assert.match(runner, /bindV2SealedHoldout/u);
  assert.match(runner, /assertNoConflictingV2EvaluationEnvironment/u);
  assert.match(runner, /ALBERT_SEMANTIC_V2_PUBLICATION_HASH/u);
  assert.match(runner, /readiness\.analyticalRuntime !== "v2"/u);
  assert.match(runner, /readiness\.v2PublicationHash !== publicationHash/u);
  assert.match(runner, /openSync\(lockPath, "wx"\)/u);
  assert.match(runner, /Automatic reruns are prohibited/u);
  assert.ok(
    runner.indexOf("assertSemanticV2OpenAISchemaCompatibility();") <
      runner.indexOf('openSync(lockPath, "wx")'),
    "strict tool/output schema compatibility must pass before the one-time budget is reserved",
  );
  assert.match(runner, /grade-v2-model-evaluation\.mts/u);
  assert.match(runner, /ALBERT_V2_EVALUATION_HOLDOUT_PATH/u);
  assert.match(runner, /ALBERT_V2_EVALUATION_GOLD_PATH/u);
  assert.match(runner, /ALBERT_V2_DETERMINISTIC_RECEIPT_PATH/u);
  assert.match(runner, /physical-staging-contract/u);
  assert.match(
    runner,
    /deterministicReceipt\.analyticalProjectRef !== analyticalProjectRef/u,
  );
  assert.match(runner, /\/models\/\$\{V2_EVALUATION_RUNTIME\.model\}/u);
  assert.match(runner, /modelIdentity\.id !== V2_EVALUATION_RUNTIME\.model/u);
  assert.match(runner, /ALBERT_V2_DETERMINISTIC_RECEIPT_HASH/u);
  assert.match(runner, /combinedCorpusPath/u);
  assert.match(runner, /datasetWatermarkHash/u);
  assert.match(harness, /live\.providerRuntime\?\.verified/u);
  assert.match(harness, /providerRuntime\.model !== "gpt-5\.6-luna"/u);
  assert.match(harness, /providerRuntime\.reasoningEffort !== "max"/u);
  assert.match(harness, /providerRuntime\.reasoningMode !== "standard"/u);
  assert.match(harness, /providerRuntime\.serviceTier !== "default"/u);
  assert.match(harness, /ALBERT_TURN_TIMEOUT_MS \?\? 800_000/u);
  assert.match(harness, /createTraceEmitter/u);
  assert.match(harness, /insert into control_plane\.conversation_turn_events/u);
  assert.ok(
    harness.indexOf("await traceEmitter.drain()") <
      harness.indexOf("finalizeSemanticV2AnswerArtifact"),
    "the complete ordered trace must be durable before immutable answer finalization",
  );
  assert.match(harness, /tracePersistence\.failed !== 0/u);
});

test("release grading enforces all machine gates and waits for independent human review", () => {
  assertV2EvaluationCorpus(corpus);
  const publicationHash = "a".repeat(64);
  const goldCases = Object.fromEntries(
    corpus
      .filter(
        ({ expectedTerminalState, grading }) =>
          grading.oracleBlock !== null || expectedTerminalState === "no_data",
      )
      .map(({ id, expectedTerminalState }) => [
        id,
        expectedTerminalState === "no_data"
          ? { kind: "empty_result", rowCount: 0 }
          : {
              kind: "numeric_cells",
              cells: [{ tableIndex: 0, columnKey: "value", expected: "1" }],
            },
      ]),
  );
  const cases = applyV2EvaluationGold(
    corpus,
    {
      schemaVersion: 1,
      publicationHash,
      datasetWatermarkHash: "d".repeat(64),
      cases: goldCases,
    },
    publicationHash,
  ).cases;
  const results = cases.map((evaluationCase) => ({
    id: evaluationCase.id,
    ok: true,
    attempt: 1,
    answerState: evaluationCase.expectedTerminalState,
    claims: evaluationCase.grading.requiresClaims
      ? [
          {
            id: "claim",
            type: "numeric",
            evidenceRefs: [
              {
                executionId: "execution",
                resultId: "result",
                publicationHash,
                rowIndex: 0,
                columnKey: "value",
              },
            ],
          },
        ]
      : [],
    tables:
      evaluationCase.expectedTerminalState === "no_data"
        ? [{ rowCount: 0, rows: [] }]
        : [{ rowCount: 1, rows: [{ value: 1 }] }],
    toolChain: [
      ...(evaluationCase.followUpOf
        ? ["progress:definition:continue workspace v2"]
        : []),
      ...(evaluationCase.expectedOperator
        ? [
            `progress:query:run analytical operator v2: ${evaluationCase.expectedOperator}`,
          ]
        : []),
    ],
    ms:
      evaluationCase.questionClass === "lookup"
        ? 1_000
        : evaluationCase.questionClass === "comparison"
          ? 2_000
          : 3_000,
    answerArtifactId: `artifact-${evaluationCase.id}`,
    answerArtifactDigest: "a".repeat(64),
    publicationHash,
    executionIds: ["execution"],
    investigationId: "investigation",
    semanticValidation: {
      executionCount: 1,
      snapshotCount: 1,
      tenantIsolationPassed: true,
      fanoutSafetyPassed: true,
      evidenceComplete: true,
      explainCostPassed: true,
    },
    evaluationRuntime: {
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      fastMode: false,
      proMode: false,
      processingMode: "standard",
      commitSha: "c".repeat(40),
    },
    metering: { estimatedCostUsdMicros: 1 },
  }));
  const awaiting = gradeV2ModelEvaluation(cases, results);
  assert.equal(awaiting.status, "awaiting_human_review");
  const waiverBody = {
    schemaVersion: 1 as const,
    kind: "albert.semantic-v2-owner-review-waiver" as const,
    status: "authorized" as const,
    scope: "evaluation_subjective_human_review" as const,
    publicationHash,
    commit: "c".repeat(40),
    runId: "evaluation-run",
    reason:
      "The product owner explicitly accepted the lack of independent subjective scoring for this exact run.",
    authorizedBy: "93000000-0000-4000-8000-000000000009",
    createdAt: "2026-08-10T00:00:00.000Z",
  };
  const ownerWaived = gradeV2ModelEvaluation(
    cases,
    results,
    [],
    {
      publicationHash,
      commit: "c".repeat(40),
      runId: "evaluation-run",
    },
    {
      ...waiverBody,
      waiverDigest: v2OwnerReviewWaiverDigest(waiverBody),
    },
  );
  assert.equal(ownerWaived.status, "passed");
  assert.equal(
    (ownerWaived.metrics as Record<string, unknown>).humanQuality,
    null,
  );
  assert.deepEqual(ownerWaived.subjectiveReview, {
    status: "owner_waived",
    waiverDigest: v2OwnerReviewWaiverDigest(waiverBody),
    authorizedBy: waiverBody.authorizedBy,
    independentlyReviewedCases: 0,
    independentlyReviewableCases: 95,
  });
  assert.throws(
    () =>
      gradeV2ModelEvaluation(
        cases,
        results,
        [],
        {
          publicationHash,
          commit: "c".repeat(40),
          runId: "evaluation-run",
        },
        {
          ...waiverBody,
          waiverDigest: "f".repeat(64),
        },
      ),
    /invalid or does not match/iu,
  );
  const humanReviews = cases
    .filter(
      ({ questionClass }) =>
        questionClass === "diagnosis" || questionClass === "recommendation",
    )
    .map(({ id }) => ({
      caseId: id,
      acceptable: true,
      reviewer: "independent-reviewer",
      reviewerType: "human" as const,
      independentOfEvaluationModel: true as const,
    }));
  const passed = gradeV2ModelEvaluation(cases, results, humanReviews);
  assert.equal(passed.status, "passed");
  assert.equal(
    (passed.metrics as Record<string, unknown>).exactNumericalAccuracy,
    1,
  );
  const broken = results.map((result, index) =>
    index === 0
      ? { ...result, ok: false, answerArtifactId: undefined }
      : result,
  );
  assert.equal(
    gradeV2ModelEvaluation(cases, broken, humanReviews).status,
    "failed",
  );
});

test("dataset-bound gold fails closed when an answerable lookup is missing", () => {
  assertV2EvaluationCorpus(corpus);
  assert.throws(
    () =>
      applyV2EvaluationGold(
        corpus,
        {
          schemaVersion: 1,
          publicationHash: "a".repeat(64),
          datasetWatermarkHash: "d".repeat(64),
          cases: {},
        },
        "a".repeat(64),
      ),
    /deterministic gold is required/iu,
  );
});
