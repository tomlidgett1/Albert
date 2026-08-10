import {
  V2_EVALUATION_RUNTIME,
  type V2EvaluationCase,
} from "./v2-evaluation-policy.js";
import {
  assertV2OwnerReviewWaiver,
  type V2OwnerReviewWaiver,
} from "./v2-owner-review-waiver.js";

type EvaluationResult = Readonly<{
  id: string;
  ok: boolean;
  attempt: number;
  answerState: string;
  analysisLane?: string;
  claims?: readonly Readonly<Record<string, unknown>>[];
  tables?: readonly Readonly<{
    rowCount?: number;
    rows?: readonly Readonly<Record<string, unknown>>[];
  }>[];
  toolChain?: readonly string[];
  ms: number;
  answerArtifactId?: string;
  answerArtifactDigest?: string;
  publicationHash?: string;
  executionIds?: readonly string[];
  investigationId?: string | null;
  semanticValidation?: Readonly<{
    executionCount?: number;
    snapshotCount?: number;
    tenantIsolationPassed?: boolean;
    fanoutSafetyPassed?: boolean;
    evidenceComplete?: boolean;
    explainCostPassed?: boolean;
  }>;
  evaluationRuntime?: Readonly<{
    model?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    proMode?: boolean;
    processingMode?: string;
    commitSha?: string | null;
    corpusHash?: string | null;
    visibleCorpusHash?: string | null;
    holdoutCorpusHash?: string | null;
    goldManifestHash?: string | null;
    datasetWatermarkHash?: string | null;
  }>;
  metering?: Readonly<{ estimatedCostUsdMicros?: number }>;
}>;

export type HumanEvaluationReview = Readonly<{
  caseId: string;
  acceptable: boolean;
  reviewer: string;
  reviewerType: "human";
  independentOfEvaluationModel: true;
  notes?: string;
}>;

type ReleaseBinding = Readonly<{
  runId?: string;
  publicationHash: string;
  commit: string;
  corpusHash?: string;
  visibleCorpusHash?: string;
  holdoutCorpusHash?: string;
  goldManifestHash?: string;
  datasetWatermarkHash?: string;
  deterministicReceiptHash?: string;
}>;

function normalizedState(value: string): string {
  return value.toLowerCase().replaceAll(" ", "_");
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
}

function canonicalDecimal(value: unknown): string | null {
  if (
    (typeof value !== "number" || !Number.isFinite(value)) &&
    typeof value !== "string"
  )
    return null;
  const raw = String(value).trim();
  const match = /^([-+]?)(\d+)(?:\.(\d+))?$/u.exec(raw);
  if (!match) return null;
  const integer = match[2]!.replace(/^0+(?=\d)/u, "");
  const fraction = (match[3] ?? "").replace(/0+$/u, "");
  const magnitude = `${integer}${fraction ? `.${fraction}` : ""}`;
  return magnitude === "0" ? "0" : `${match[1] === "-" ? "-" : ""}${magnitude}`;
}

function scalarEquals(left: unknown, right: unknown): boolean {
  if (left === null || right === null) return left === right;
  const leftDecimal = canonicalDecimal(left);
  const rightDecimal = canonicalDecimal(right);
  return leftDecimal !== null && rightDecimal !== null
    ? leftDecimal === rightDecimal
    : left === right;
}

function numericGoldMatches(
  evaluationCase: V2EvaluationCase,
  result: EvaluationResult,
): boolean {
  const gold = evaluationCase.grading.deterministicGold;
  if (!gold || gold.kind !== "numeric_cells") return false;
  return gold.cells.every((cell) => {
    const table = result.tables?.[cell.tableIndex];
    if (!table?.rows) return false;
    const rowMatch = cell.rowMatch ?? {};
    const matchingRows = table.rows.filter((row) =>
      Object.entries(rowMatch).every(
        ([key, value]) =>
          Object.prototype.hasOwnProperty.call(row, key) &&
          scalarEquals(row[key], value),
      ),
    );
    if (
      matchingRows.length !== 1 ||
      !Object.prototype.hasOwnProperty.call(matchingRows[0]!, cell.columnKey)
    )
      return false;
    return (
      canonicalDecimal(matchingRows[0]![cell.columnKey]) ===
      canonicalDecimal(cell.expected)
    );
  });
}

function claimIsStructurallyGrounded(
  result: EvaluationResult,
  claim: Readonly<Record<string, unknown>>,
): boolean {
  if (
    !result.ok ||
    !result.answerArtifactId ||
    !Array.isArray(claim.evidenceRefs) ||
    claim.evidenceRefs.length === 0
  )
    return false;
  return claim.evidenceRefs.every((rawReference) => {
    if (
      !rawReference ||
      typeof rawReference !== "object" ||
      Array.isArray(rawReference)
    )
      return false;
    const reference = rawReference as Record<string, unknown>;
    return (
      typeof reference.executionId === "string" &&
      typeof reference.resultId === "string" &&
      typeof reference.publicationHash === "string" &&
      reference.publicationHash === result.publicationHash &&
      ((Number.isInteger(reference.rowIndex) &&
        typeof reference.columnKey === "string") ||
        typeof reference.operatorArtifactId === "string")
    );
  });
}

function hasUnsupportedAnalyticalClaim(result: EvaluationResult): boolean {
  return (result.claims ?? []).some((claim) => {
    const references = Array.isArray(claim.evidenceRefs)
      ? claim.evidenceRefs.filter(
          (value): value is Record<string, unknown> =>
            Boolean(value) &&
            typeof value === "object" &&
            !Array.isArray(value),
        )
      : [];
    const hasOperator = references.some(
      ({ operatorArtifactId }) =>
        typeof operatorArtifactId === "string" && operatorArtifactId.length > 0,
    );
    if (claim.type === "causal")
      return (
        !hasOperator ||
        !Array.isArray(claim.competingHypothesisRefs) ||
        claim.competingHypothesisRefs.length < 2
      );
    if (claim.type === "recommendation")
      return (
        !hasOperator ||
        !["high", "medium", "low"].includes(String(claim.controllability)) ||
        typeof claim.opportunityValue !== "string" ||
        !Array.isArray(claim.limitations) ||
        claim.limitations.length === 0
      );
    return false;
  });
}

export function gradeV2ModelEvaluation(
  corpus: readonly V2EvaluationCase[],
  results: readonly EvaluationResult[],
  humanReviews: readonly HumanEvaluationReview[] = [],
  releaseBinding?: ReleaseBinding,
  ownerReviewWaiver?: V2OwnerReviewWaiver,
): Readonly<Record<string, unknown>> {
  if (corpus.length !== 200 || results.length !== 200)
    throw new Error(
      `V2 release grading requires exactly 200 corpus cases and results; received ${corpus.length}/${results.length}.`,
    );
  const resultById = new Map(results.map((result) => [result.id, result]));
  if (resultById.size !== 200 || corpus.some(({ id }) => !resultById.has(id)))
    throw new Error(
      "Evaluation results do not exactly cover the locked corpus.",
    );
  const paired = corpus.map((evaluationCase) => ({
    evaluationCase,
    result: resultById.get(evaluationCase.id)!,
  }));
  const completed = paired.filter(
    ({ result }) => result.ok && Boolean(result.answerArtifactId),
  );
  const interpretations = paired.filter(
    ({ evaluationCase, result }) =>
      normalizedState(result.answerState) ===
      evaluationCase.expectedTerminalState,
  );
  const falseVerified = paired.filter(
    ({ evaluationCase, result }) =>
      normalizedState(result.answerState) === "verified" &&
      evaluationCase.expectedTerminalState !== "verified",
  );
  const incorrectUnavailable = paired.filter(
    ({ evaluationCase, result }) =>
      normalizedState(result.answerState) === "unavailable" &&
      evaluationCase.expectedTerminalState !== "unavailable",
  );
  const unexpectedClarifications = paired.filter(
    ({ evaluationCase, result }) =>
      evaluationCase.expectedTerminalState !== "clarification" &&
      normalizedState(result.answerState) === "clarification",
  );
  const clarificationDenominator = paired.filter(
    ({ evaluationCase }) =>
      evaluationCase.expectedTerminalState !== "clarification",
  ).length;
  const firstPass = paired.filter(
    ({ result }) => result.attempt === 1 && result.ok,
  );
  const followUps = paired.filter(
    ({ evaluationCase }) => evaluationCase.followUpOf,
  );
  const coherentFollowUps = followUps.filter(
    ({ result }) =>
      result.ok &&
      (result.toolChain ?? []).some((item) =>
        /continue workspace v2/iu.test(item),
      ),
  );
  const positiveExpected = paired.filter(({ evaluationCase }) =>
    ["verified", "derived", "exploratory", "no_data"].includes(
      evaluationCase.expectedTerminalState,
    ),
  );
  const answerable = positiveExpected.filter(({ result }) =>
    ["verified", "derived", "exploratory", "no_data"].includes(
      normalizedState(result.answerState),
    ),
  );
  const claimCases = paired.filter(
    ({ evaluationCase }) => evaluationCase.grading.requiresClaims,
  );
  const claimUnits: Array<{
    evaluationCase: V2EvaluationCase;
    result: EvaluationResult;
    claim: Readonly<Record<string, unknown>> | null;
  }> = [];
  for (const { evaluationCase, result } of claimCases) {
    if ((result.claims?.length ?? 0) === 0) {
      claimUnits.push({ evaluationCase, result, claim: null });
    } else {
      for (const claim of result.claims!)
        claimUnits.push({ evaluationCase, result, claim });
    }
  }
  const supportedClaims = claimUnits.filter(
    ({ result, claim }) =>
      claim !== null && claimIsStructurallyGrounded(result, claim),
  );
  const operatorCases = paired.filter(
    ({ evaluationCase }) => evaluationCase.expectedOperator !== null,
  );
  const correctOperators = operatorCases.filter(({ evaluationCase, result }) =>
    (result.toolChain ?? []).some((item) =>
      item.includes(
        `run analytical operator v2: ${evaluationCase.expectedOperator}`,
      ),
    ),
  );
  const runtimeCorrect = paired.filter(
    ({ result }) =>
      result.evaluationRuntime?.model === "gpt-5.6-luna" &&
      result.evaluationRuntime.reasoningEffort === "max" &&
      result.evaluationRuntime.fastMode === false &&
      result.evaluationRuntime.proMode === false &&
      result.evaluationRuntime.processingMode === "standard" &&
      (!releaseBinding ||
        (result.evaluationRuntime.commitSha === releaseBinding.commit &&
          result.evaluationRuntime.corpusHash === releaseBinding.corpusHash &&
          result.evaluationRuntime.visibleCorpusHash ===
            releaseBinding.visibleCorpusHash &&
          result.evaluationRuntime.holdoutCorpusHash ===
            releaseBinding.holdoutCorpusHash &&
          result.evaluationRuntime.goldManifestHash ===
            releaseBinding.goldManifestHash &&
          result.evaluationRuntime.datasetWatermarkHash ===
            releaseBinding.datasetWatermarkHash)),
  );
  const publicationBound = paired.filter(
    ({ result }) =>
      Boolean(result.publicationHash) &&
      (!releaseBinding ||
        result.publicationHash === releaseBinding.publicationHash),
  );
  const deputyUse = paired.filter(({ result }) =>
    /\bdeputy\b/iu.test(
      JSON.stringify({ toolChain: result.toolChain, claims: result.claims }),
    ),
  );
  const numericGold = paired.filter(
    ({ evaluationCase }) =>
      evaluationCase.grading.deterministicGold?.kind === "numeric_cells",
  );
  const correctNumericGold = numericGold.filter(({ evaluationCase, result }) =>
    numericGoldMatches(evaluationCase, result),
  );
  const emptyGold = paired.filter(
    ({ evaluationCase }) =>
      evaluationCase.grading.deterministicGold?.kind === "empty_result",
  );
  const correctEmptyGold = emptyGold.filter(
    ({ result }) =>
      normalizedState(result.answerState) === "no_data" &&
      (result.tables ?? []).every(({ rowCount = 0 }) => rowCount === 0),
  );
  const deterministicGold = [...numericGold, ...emptyGold];
  const deterministicCorrect = [...correctNumericGold, ...correctEmptyGold];
  const safetyFailures = paired.filter(
    ({ result }) => !result.ok || !result.answerArtifactId,
  );
  const validationReceiptFailures = paired.filter(({ result }) => {
    const validation = result.semanticValidation;
    return (
      !validation ||
      validation.executionCount !== (result.executionIds?.length ?? 0) ||
      validation.snapshotCount !== validation.executionCount
    );
  });
  const tenantIsolationFailures = paired.filter(
    ({ result }) => result.semanticValidation?.tenantIsolationPassed !== true,
  );
  const fanoutFailures = paired.filter(
    ({ result }) => result.semanticValidation?.fanoutSafetyPassed !== true,
  );
  const evidenceFailures = paired.filter(
    ({ result }) =>
      result.semanticValidation?.evidenceComplete !== true ||
      result.semanticValidation?.explainCostPassed !== true,
  );
  const unsupportedAnalyticalClaims = paired.filter(({ result }) =>
    hasUnsupportedAnalyticalClaim(result),
  );
  const reviewById = new Map(
    humanReviews.map((review) => [review.caseId, review]),
  );
  const validIndependentReview = (
    review: HumanEvaluationReview | undefined,
  ): review is HumanEvaluationReview =>
    Boolean(
      review &&
      review.reviewer.trim() &&
      review.reviewerType === "human" &&
      review.independentOfEvaluationModel === true,
    );
  const humanCases = paired.filter(
    ({ evaluationCase }) =>
      evaluationCase.questionClass === "diagnosis" ||
      evaluationCase.questionClass === "recommendation",
  );
  const reviewedHumanCases = humanCases.filter(({ evaluationCase }) =>
    validIndependentReview(reviewById.get(evaluationCase.id)),
  );
  const acceptableHumanCases = reviewedHumanCases.filter(
    ({ evaluationCase }) => reviewById.get(evaluationCase.id)?.acceptable,
  );
  let ownerReviewWaiverValid = false;
  if (ownerReviewWaiver && releaseBinding?.runId) {
    assertV2OwnerReviewWaiver(ownerReviewWaiver, {
      scope: "evaluation_subjective_human_review",
      publicationHash: releaseBinding.publicationHash,
      commit: releaseBinding.commit,
      runId: releaseBinding.runId,
    });
    ownerReviewWaiverValid = true;
  }
  const completeIndependentHumanReview =
    reviewedHumanCases.length === humanCases.length &&
    ratio(acceptableHumanCases.length, reviewedHumanCases.length) >= 0.9;
  const latency = Object.fromEntries(
    [
      "lookup",
      "comparison",
      "diagnosis",
      "recommendation",
      "open_exploration",
    ].map((questionClass) => [
      questionClass,
      percentile(
        paired
          .filter(
            ({ evaluationCase }) =>
              evaluationCase.questionClass === questionClass,
          )
          .map(({ result }) => result.ms),
        0.95,
      ),
    ]),
  );
  const metrics = {
    exactNumericalAccuracy:
      numericGold.length === 0
        ? 0
        : ratio(correctNumericGold.length, numericGold.length),
    deterministicGoldAccuracy:
      deterministicGold.length === 0
        ? 0
        : ratio(deterministicCorrect.length, deterministicGold.length),
    numericGoldCaseCount: numericGold.length,
    deterministicGoldCaseCount: deterministicGold.length,
    correctInterpretationRate: ratio(interpretations.length, paired.length),
    claimSupportAccuracy: ratio(supportedClaims.length, claimUnits.length),
    userWeightedAnswerability: ratio(
      answerable.length,
      positiveExpected.length,
    ),
    falseVerifiedCount: falseVerified.length,
    incorrectUnavailableRate: ratio(incorrectUnavailable.length, paired.length),
    clarificationRateExcludingExpected: ratio(
      unexpectedClarifications.length,
      clarificationDenominator,
    ),
    firstPassCompletionRate: ratio(firstPass.length, paired.length),
    followUpCoherence: ratio(coherentFollowUps.length, followUps.length),
    humanQuality:
      reviewedHumanCases.length === 0
        ? null
        : ratio(acceptableHumanCases.length, reviewedHumanCases.length),
    humanReviewCoverage: ratio(reviewedHumanCases.length, humanCases.length),
    finalizedArtifactRate: ratio(completed.length, paired.length),
    executionValidationReceiptRate: ratio(
      paired.length - validationReceiptFailures.length,
      paired.length,
    ),
    exactOperatorSelectionRate: ratio(
      correctOperators.length,
      operatorCases.length,
    ),
    exactRuntimeConfigurationRate: ratio(runtimeCorrect.length, paired.length),
    publicationBindingRate: ratio(publicationBound.length, paired.length),
    prohibitedDeputyUseCount: deputyUse.length,
    latencyP95Ms: latency,
    maximumLatencyMs: Math.max(...paired.map(({ result }) => result.ms)),
    estimatedCostUsdMicros: paired.reduce(
      (total, { result }) =>
        total + Number(result.metering?.estimatedCostUsdMicros ?? 0),
      0,
    ),
  };
  const gates = {
    exactNumericalAccuracy: metrics.exactNumericalAccuracy === 1,
    deterministicGoldAccuracy: metrics.deterministicGoldAccuracy === 1,
    allArtifactsFinalized: metrics.finalizedArtifactRate === 1,
    completeExecutionValidationReceipts:
      metrics.executionValidationReceiptRate === 1,
    zeroCrossTenantLeakage: tenantIsolationFailures.length === 0,
    zeroFalseVerified: metrics.falseVerifiedCount === 0,
    zeroUndetectedFanout: fanoutFailures.length === 0,
    completeEvidenceAndCostValidation: evidenceFailures.length === 0,
    zeroUnsupportedCausalOrRecommendationClaims:
      unsupportedAnalyticalClaims.length === 0,
    exactOperatorSelection: metrics.exactOperatorSelectionRate === 1,
    exactRuntimeConfiguration: metrics.exactRuntimeConfigurationRate === 1,
    exactPublicationBinding: metrics.publicationBindingRate === 1,
    noDeputyUse: metrics.prohibitedDeputyUseCount === 0,
    correctInterpretation: metrics.correctInterpretationRate >= 0.97,
    claimSupport: metrics.claimSupportAccuracy >= 0.98,
    answerability: metrics.userWeightedAnswerability >= 0.95,
    incorrectUnavailable: metrics.incorrectUnavailableRate < 0.02,
    clarification: metrics.clarificationRateExcludingExpected <= 0.1,
    firstPass: metrics.firstPassCompletionRate >= 0.9,
    followUps: metrics.followUpCoherence >= 0.95,
    subjectiveReviewRequirementSatisfied:
      completeIndependentHumanReview || ownerReviewWaiverValid,
    lookupLatency: Number(latency.lookup) <= 10_000,
    comparisonLatency: Number(latency.comparison) <= 30_000,
    analyticalLatency:
      Number(latency.diagnosis) <= 90_000 &&
      Number(latency.recommendation) <= 90_000,
    hardTimeout:
      metrics.maximumLatencyMs <= V2_EVALUATION_RUNTIME.turnTimeoutMs,
  };
  const failedGates = Object.entries(gates)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return Object.freeze({
    schemaVersion: 2,
    status:
      failedGates.length === 0
        ? "passed"
        : humanReviews.length === 0 &&
            !ownerReviewWaiverValid &&
            failedGates.every((gate) =>
              ["subjectiveReviewRequirementSatisfied"].includes(gate),
            )
          ? "awaiting_human_review"
          : "failed",
    caseCount: paired.length,
    metrics,
    gates,
    failedGates,
    failures: {
      interpretation: paired
        .filter((item) => !interpretations.includes(item))
        .map(({ evaluationCase }) => evaluationCase.id),
      falseVerified: falseVerified.map(
        ({ evaluationCase }) => evaluationCase.id,
      ),
      incorrectUnavailable: incorrectUnavailable.map(
        ({ evaluationCase }) => evaluationCase.id,
      ),
      unsupportedOrUnfinalized: safetyFailures.map(
        ({ evaluationCase }) => evaluationCase.id,
      ),
      numericalGold: numericGold
        .filter((item) => !correctNumericGold.includes(item))
        .map(({ evaluationCase }) => evaluationCase.id),
      deterministicGold: deterministicGold
        .filter((item) => !deterministicCorrect.includes(item))
        .map(({ evaluationCase }) => evaluationCase.id),
      validationReceipts: validationReceiptFailures.map(
        ({ evaluationCase }) => evaluationCase.id,
      ),
      tenantIsolation: tenantIsolationFailures.map(
        ({ evaluationCase }) => evaluationCase.id,
      ),
      fanoutSafety: fanoutFailures.map(
        ({ evaluationCase }) => evaluationCase.id,
      ),
      evidenceAndCostValidation: evidenceFailures.map(
        ({ evaluationCase }) => evaluationCase.id,
      ),
      unsupportedAnalyticalClaims: unsupportedAnalyticalClaims.map(
        ({ evaluationCase }) => evaluationCase.id,
      ),
      incoherentFollowUps: followUps
        .filter((item) => !coherentFollowUps.includes(item))
        .map(({ evaluationCase }) => evaluationCase.id),
      incorrectOperator: operatorCases
        .filter((item) => !correctOperators.includes(item))
        .map(({ evaluationCase }) => evaluationCase.id),
      runtimeConfiguration: paired
        .filter((item) => !runtimeCorrect.includes(item))
        .map(({ evaluationCase }) => evaluationCase.id),
      publicationBinding: paired
        .filter((item) => !publicationBound.includes(item))
        .map(({ evaluationCase }) => evaluationCase.id),
      prohibitedDeputyUse: deputyUse.map(
        ({ evaluationCase }) => evaluationCase.id,
      ),
    },
    subjectiveReview: ownerReviewWaiverValid
      ? {
          status: "owner_waived",
          waiverDigest: ownerReviewWaiver!.waiverDigest,
          authorizedBy: ownerReviewWaiver!.authorizedBy,
          independentlyReviewedCases: reviewedHumanCases.length,
          independentlyReviewableCases: humanCases.length,
        }
      : completeIndependentHumanReview
        ? {
            status: "independently_human_reviewed",
            independentlyReviewedCases: reviewedHumanCases.length,
            independentlyReviewableCases: humanCases.length,
          }
        : {
            status: "awaiting_human_review",
            independentlyReviewedCases: reviewedHumanCases.length,
            independentlyReviewableCases: humanCases.length,
          },
    releaseBinding: releaseBinding
      ? Object.freeze({ ...releaseBinding })
      : null,
  });
}
