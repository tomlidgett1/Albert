import {
  queryBlockV2Schema,
  type QueryBlockV2,
} from "../packages/analytics-v2/src/workspace.js";

export const V2_EVALUATION_TOTAL = 200 as const;

export const V2_REQUIRED_OPERATOR_COVERAGE = Object.freeze([
  "period_contribution",
  "dimension_contribution",
  "gross_margin_bridge",
  "price_volume_mix",
  "pareto_concentration",
  "trend_anomaly",
  "discount_leakage",
  "return_rate",
  "customer_retention",
  "stockout_opportunity",
  "supplier_performance",
  "pos_xero_reconciliation",
  "sales_bank_reconciliation",
  "profitability_bridge",
  "opportunity_sizing",
  "constraint_controllability",
] as const);

export const V2_REQUIRED_TOPIC_COVERAGE = Object.freeze([
  "source.lightspeed.catalogue",
  "source.lightspeed.customers",
  "source.lightspeed.inventory",
  "source.lightspeed.org",
  "source.lightspeed.purchasing",
  "source.lightspeed.registers",
  "source.lightspeed.sales",
  "source.lightspeed.taxreports",
  "source.lightspeed.workshop",
  "source.xero.assets",
  "source.xero.banking",
  "source.xero.contacts_dir",
  "source.xero.files",
  "source.xero.invoicing",
  "source.xero.ledger_config",
  "source.xero.org_meta",
  "source.xero.payments_credits",
  "source.xero.payroll_au_people",
  "source.xero.payroll_au_runs",
  "source.xero.payroll_nz_people",
  "source.xero.payroll_nz_runs",
  "source.xero.payroll_uk_people",
  "source.xero.payroll_uk_runs",
  "source.xero.projects",
  "source.xero.purchasing_items",
  "business.sales_performance",
  "business.product_category_performance",
  "business.gross_margin_discounting",
  "business.inventory_health",
  "business.purchasing_suppliers",
  "business.customers_retention",
  "business.store_employee_performance",
  "business.cash_banking",
  "business.receivables",
  "business.payables_expenses",
  "business.financial_performance",
  "business.gst_tax",
  "composite.trading_profitability",
  "composite.pos_accounting_revenue",
  "composite.sales_bank",
  "composite.inventory_cogs",
  "composite.customer_accounting",
  "composite.cash_conversion",
] as const);

export const V2_REQUIRED_RISK_COVERAGE = Object.freeze([
  "line_payment_fanout",
  "snapshot_semi_additivity",
  "refund_void_reversal",
  "gift_card_store_credit",
  "gst_basis",
  "cost_basis",
  "recognition_date",
  "cash_accrual_basis",
  "journal_balance",
  "payment_allocation",
  "cross_source_double_counting",
  "bank_settlement_timing",
  "multi_currency",
  "fiscal_calendar_dst_partial_period",
  "null_zero_sparse_duplicate_orphan_late_data",
  "ambiguous_unsupported_join",
  "causal_overreach",
  "recommendation_controllability",
] as const);

export const V2_EVALUATION_POLICY = Object.freeze({
  source: Object.freeze({ lightspeed: 80, xero: 80, lightspeed_xero: 40 }),
  difficulty: Object.freeze({
    easy: 30,
    medium: 60,
    hard: 70,
    adversarial: 40,
  }),
  questionClass: Object.freeze({
    lookup: 35,
    comparison: 40,
    diagnosis: 50,
    recommendation: 45,
    open_exploration: 30,
  }),
  expectedTerminalState: Object.freeze({
    verified: 105,
    derived: 30,
    exploratory: 20,
    clarification: 15,
    no_data: 15,
    unavailable: 15,
  }),
  visibility: Object.freeze({ visible: 160, hidden: 40 }),
} as const);

export const V2_EVALUATION_RUNTIME = Object.freeze({
  model: "gpt-5.6-luna",
  reasoningEffort: "max",
  processingMode: "standard",
  fastMode: false,
  proMode: false,
  maximumAttempts: 1,
  analyticalRuntime: "v2",
} as const);

export type V2EvaluationGoldScalar = string | number | null;

export type V2EvaluationDeterministicGold =
  | Readonly<{ kind: "empty_result"; rowCount: 0 }>
  | Readonly<{
      kind: "numeric_cells";
      cells: readonly Readonly<{
        tableIndex: number;
        columnKey: string;
        rowMatch?: Readonly<Record<string, V2EvaluationGoldScalar>>;
        expected: string | number;
      }>[];
    }>;

export type V2EvaluationGoldManifest = Readonly<{
  schemaVersion: 1;
  publicationHash: string;
  datasetWatermarkHash: string;
  cases: Readonly<Record<string, V2EvaluationDeterministicGold>>;
}>;

export type V2EvaluationCase = Readonly<{
  id: string;
  tier: string;
  domain: string;
  ask: string;
  source: keyof typeof V2_EVALUATION_POLICY.source;
  difficulty: keyof typeof V2_EVALUATION_POLICY.difficulty;
  questionClass: keyof typeof V2_EVALUATION_POLICY.questionClass;
  expectedTerminalState: keyof typeof V2_EVALUATION_POLICY.expectedTerminalState;
  visibility: keyof typeof V2_EVALUATION_POLICY.visibility;
  thread?: string;
  followUpOf?: string;
  expectedOperator: string | null;
  grading: Readonly<{
    requiresClaims: boolean;
    requiresOperator: boolean;
    oracleBlock: QueryBlockV2 | null;
    deterministicGold: V2EvaluationDeterministicGold | null;
    prohibitedConnectors: readonly ["deputy"];
  }>;
  tags: readonly string[];
}>;

export function sealedV2HoldoutPrompt(caseId: string): string {
  return `[SEALED V2 HOLDOUT PROMPT ${caseId}]`;
}

function evaluationCaseBlueprint(evaluationCase: V2EvaluationCase): unknown {
  return {
    id: evaluationCase.id,
    tier: evaluationCase.tier,
    domain: evaluationCase.domain,
    source: evaluationCase.source,
    difficulty: evaluationCase.difficulty,
    questionClass: evaluationCase.questionClass,
    expectedTerminalState: evaluationCase.expectedTerminalState,
    visibility: evaluationCase.visibility,
    thread: evaluationCase.thread ?? null,
    followUpOf: evaluationCase.followUpOf ?? null,
    expectedOperator: evaluationCase.expectedOperator,
    grading: {
      requiresClaims: evaluationCase.grading.requiresClaims,
      requiresOperator: evaluationCase.grading.requiresOperator,
      oracleBlock: evaluationCase.grading.oracleBlock,
      prohibitedConnectors: evaluationCase.grading.prohibitedConnectors,
    },
    tags: evaluationCase.tags,
  };
}

function countsBy(
  cases: readonly V2EvaluationCase[],
  field:
    | "source"
    | "difficulty"
    | "questionClass"
    | "expectedTerminalState"
    | "visibility",
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const evaluationCase of cases)
    counts[evaluationCase[field]] = (counts[evaluationCase[field]] ?? 0) + 1;
  return counts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isGoldScalar(value: unknown): value is V2EvaluationGoldScalar {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function assertDeterministicGold(
  value: unknown,
  label: string,
): asserts value is V2EvaluationDeterministicGold {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  if (value.kind === "empty_result") {
    if (value.rowCount !== 0)
      throw new Error(`${label} must require exactly zero rows.`);
    return;
  }
  if (
    value.kind !== "numeric_cells" ||
    !Array.isArray(value.cells) ||
    value.cells.length === 0
  ) {
    throw new Error(
      `${label} must be empty_result or contain at least one numeric cell expectation.`,
    );
  }
  for (const [index, rawCell] of value.cells.entries()) {
    if (
      !isRecord(rawCell) ||
      !Number.isInteger(rawCell.tableIndex) ||
      Number(rawCell.tableIndex) < 0 ||
      typeof rawCell.columnKey !== "string" ||
      rawCell.columnKey.length === 0 ||
      !(
        (typeof rawCell.expected === "number" &&
          Number.isFinite(rawCell.expected)) ||
        (typeof rawCell.expected === "string" &&
          /^[-+]?\d+(?:\.\d+)?$/u.test(rawCell.expected))
      )
    ) {
      throw new Error(
        `${label}.cells[${index}] is not a valid exact numeric expectation.`,
      );
    }
    if (
      rawCell.rowMatch !== undefined &&
      (!isRecord(rawCell.rowMatch) ||
        Object.values(rawCell.rowMatch).some((entry) => !isGoldScalar(entry)))
    ) {
      throw new Error(
        `${label}.cells[${index}].rowMatch must contain only scalar values.`,
      );
    }
  }
}

export function assertV2EvaluationCorpus(
  rawCases: unknown,
): asserts rawCases is readonly V2EvaluationCase[] {
  if (!Array.isArray(rawCases))
    throw new Error("The V2 evaluation corpus must be an array.");
  const cases = rawCases as V2EvaluationCase[];
  if (cases.length !== V2_EVALUATION_TOTAL)
    throw new Error(
      `Evaluation corpus must contain exactly ${V2_EVALUATION_TOTAL} cases; received ${cases.length}.`,
    );
  if (new Set(cases.map(({ id }) => id)).size !== cases.length)
    throw new Error("Every V2 evaluation case must have a unique ID.");
  if (
    cases.some(
      ({ source, domain, ask, tags, grading }) =>
        !source || !domain || !ask || !Array.isArray(tags) || !grading,
    )
  )
    throw new Error(
      "Every V2 evaluation case must include its required fields, grading contract, and tags.",
    );
  if (
    cases.some(({ source, domain, ask, tags }) =>
      /\bdeputy\b/iu.test(JSON.stringify({ source, domain, ask, tags })),
    )
  )
    throw new Error("Deputy cases are prohibited from V2 evaluation.");
  if (
    cases.some(
      ({ questionClass, expectedTerminalState }) =>
        questionClass === "recommendation" &&
        expectedTerminalState === "verified",
    )
  )
    throw new Error(
      "Recommendations cannot be expected Verified because opportunity sizing is deterministically derived.",
    );
  if (
    cases.some(
      ({ expectedTerminalState, expectedOperator, grading }) =>
        grading.requiresOperator !== (expectedOperator !== null) ||
        (expectedTerminalState === "derived" && !expectedOperator),
    )
  )
    throw new Error(
      "Derived evaluation cases require an explicit deterministic operator contract.",
    );
  if (new Set(cases.map(({ ask }) => ask.trim())).size !== cases.length)
    throw new Error("Every V2 evaluation question must be unique.");
  const expectedOperators = new Set(
    cases.flatMap(({ expectedOperator }) =>
      expectedOperator ? [expectedOperator] : [],
    ),
  );
  const missingOperators = V2_REQUIRED_OPERATOR_COVERAGE.filter(
    (operatorId) => !expectedOperators.has(operatorId),
  );
  if (missingOperators.length)
    throw new Error(
      `The V2 corpus does not cover these analytical operators: ${missingOperators.join(", ")}.`,
    );
  const tagSet = new Set(cases.flatMap(({ tags }) => tags));
  const missingTopics = V2_REQUIRED_TOPIC_COVERAGE.filter(
    (topicId) => !tagSet.has(`topic:${topicId}`),
  );
  if (missingTopics.length)
    throw new Error(
      `The V2 corpus does not cover these semantic Topics: ${missingTopics.join(", ")}.`,
    );
  const missingRisks = V2_REQUIRED_RISK_COVERAGE.filter(
    (risk) => !tagSet.has(`risk:${risk}`),
  );
  if (missingRisks.length)
    throw new Error(
      `The V2 corpus does not cover these analytical risks: ${missingRisks.join(", ")}.`,
    );
  if (
    cases.some(
      ({ expectedOperator, tags }) =>
        expectedOperator && !tags.includes(`operator:${expectedOperator}`),
    )
  )
    throw new Error(
      "Every expected analytical operator must be represented in the case tags.",
    );
  for (const evaluationCase of cases) {
    if (evaluationCase.grading.oracleBlock !== null)
      queryBlockV2Schema.parse(evaluationCase.grading.oracleBlock);
    if (evaluationCase.grading.deterministicGold !== null)
      assertDeterministicGold(
        evaluationCase.grading.deterministicGold,
        `Evaluation case ${evaluationCase.id} deterministicGold`,
      );
  }
  const followUps = cases.filter(({ followUpOf }) => followUpOf);
  if (followUps.length !== 20)
    throw new Error(
      `Evaluation corpus must contain exactly 20 follow-up questions; received ${followUps.length}.`,
    );
  const byId = new Map(
    cases.map((evaluationCase) => [evaluationCase.id, evaluationCase]),
  );
  if (
    followUps.some((evaluationCase) => {
      const parent = byId.get(evaluationCase.followUpOf!);
      return (
        !parent ||
        !evaluationCase.thread ||
        evaluationCase.thread !== parent.thread ||
        evaluationCase.source !== parent.source
      );
    })
  )
    throw new Error(
      "Follow-up questions must name an earlier same-source case in the same thread.",
    );

  for (const [field, expected] of Object.entries(V2_EVALUATION_POLICY)) {
    const actual = countsBy(cases, field as Parameters<typeof countsBy>[1]);
    if (
      JSON.stringify(actual, Object.keys(actual).sort()) !==
      JSON.stringify(expected, Object.keys(expected).sort())
    ) {
      throw new Error(
        `The ${field} allocation is invalid. Expected ${JSON.stringify(expected)}; received ${JSON.stringify(actual)}.`,
      );
    }
  }
}

/**
 * The repository carries the full allocation blueprint, but never the 40
 * holdout prompts. This preserves deterministic distribution review without
 * leaking the questions used for release qualification.
 */
export function assertV2PublicEvaluationBlueprint(
  rawCases: unknown,
): asserts rawCases is readonly V2EvaluationCase[] {
  assertV2EvaluationCorpus(rawCases);
  const cases = rawCases as readonly V2EvaluationCase[];
  const hidden = cases.filter(({ visibility }) => visibility === "hidden");
  if (
    hidden.some(
      (evaluationCase) =>
        evaluationCase.ask !== sealedV2HoldoutPrompt(evaluationCase.id),
    )
  )
    throw new Error(
      "The committed evaluation blueprint must not contain a hidden holdout prompt.",
    );
  if (
    cases
      .filter(({ visibility }) => visibility === "visible")
      .some(({ ask }) => /^\[SEALED V2 HOLDOUT PROMPT /u.test(ask))
  )
    throw new Error("A visible evaluation case cannot use a sealed placeholder.");
}

export function bindV2SealedHoldout(
  publicBlueprintRaw: unknown,
  holdoutRaw: unknown,
): readonly V2EvaluationCase[] {
  assertV2PublicEvaluationBlueprint(publicBlueprintRaw);
  if (!Array.isArray(holdoutRaw) || holdoutRaw.length !== 40)
    throw new Error("The sealed holdout must contain exactly 40 hidden cases.");
  const publicBlueprint = publicBlueprintRaw as readonly V2EvaluationCase[];
  const expected = publicBlueprint.filter(
    ({ visibility }) => visibility === "hidden",
  );
  const holdout = holdoutRaw as readonly V2EvaluationCase[];
  const byId = new Map(holdout.map((evaluationCase) => [evaluationCase.id, evaluationCase]));
  for (const blueprintCase of expected) {
    const evaluationCase = byId.get(blueprintCase.id);
    if (!evaluationCase)
      throw new Error(`The sealed holdout is missing ${blueprintCase.id}.`);
    if (
      evaluationCase.visibility !== "hidden" ||
      evaluationCase.ask === sealedV2HoldoutPrompt(evaluationCase.id) ||
      /^\[SEALED V2 HOLDOUT PROMPT /u.test(evaluationCase.ask)
    )
      throw new Error(
        `The sealed holdout prompt for ${evaluationCase.id} is missing or still redacted.`,
      );
    if (
      JSON.stringify(evaluationCaseBlueprint(evaluationCase)) !==
      JSON.stringify(evaluationCaseBlueprint(blueprintCase))
    )
      throw new Error(
        `The sealed holdout metadata for ${evaluationCase.id} does not match the reviewed allocation blueprint.`,
      );
  }
  if (byId.size !== expected.length)
    throw new Error("The sealed holdout contains duplicate or unexpected case IDs.");
  const combined = [
    ...publicBlueprint.filter(({ visibility }) => visibility === "visible"),
    ...holdout,
  ];
  assertV2EvaluationCorpus(combined);
  return Object.freeze(combined);
}

/**
 * Applies dataset-bound gold results without committing dogfood values or the
 * hidden holdout to the repository. Every answerable lookup/comparison is
 * required to have exact gold: empty results for expected No data cases and
 * governed numeric cells for all other answerable cases.
 */
export function applyV2EvaluationGold(
  corpus: readonly V2EvaluationCase[],
  rawManifest: unknown,
  expectedPublicationHash: string,
): Readonly<{
  cases: readonly V2EvaluationCase[];
  datasetWatermarkHash: string;
}> {
  if (
    !isRecord(rawManifest) ||
    rawManifest.schemaVersion !== 1 ||
    rawManifest.publicationHash !== expectedPublicationHash ||
    typeof rawManifest.datasetWatermarkHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(rawManifest.datasetWatermarkHash) ||
    !isRecord(rawManifest.cases)
  ) {
    throw new Error(
      "The deterministic-gold manifest must be schema v1 and bind the exact publication and dataset watermark.",
    );
  }
  const manifestCases = rawManifest.cases as Record<string, unknown>;
  const byId = new Map(
    corpus.map((evaluationCase) => [evaluationCase.id, evaluationCase]),
  );
  for (const [caseId, gold] of Object.entries(manifestCases)) {
    if (!byId.has(caseId))
      throw new Error(
        `Deterministic gold references unknown evaluation case ${caseId}.`,
      );
    assertDeterministicGold(gold, `Deterministic gold for ${caseId}`);
  }
  const goldById = manifestCases as Record<
    string,
    V2EvaluationDeterministicGold
  >;
  const required = corpus.filter(
    ({ expectedTerminalState, grading }) =>
      grading.oracleBlock !== null || expectedTerminalState === "no_data",
  );
  for (const evaluationCase of required) {
    const gold = goldById[evaluationCase.id];
    if (!gold)
      throw new Error(
        `Deterministic gold is required for answerable ${evaluationCase.questionClass} case ${evaluationCase.id}.`,
      );
    if (
      evaluationCase.expectedTerminalState === "no_data" &&
      gold.kind !== "empty_result"
    ) {
      throw new Error(
        `No-data case ${evaluationCase.id} requires empty-result gold.`,
      );
    }
    if (
      evaluationCase.expectedTerminalState !== "no_data" &&
      gold.kind !== "numeric_cells"
    ) {
      throw new Error(
        `Answerable case ${evaluationCase.id} requires numeric-cell gold.`,
      );
    }
  }
  const cases = Object.freeze(
    corpus.map((evaluationCase) =>
      Object.freeze({
        ...evaluationCase,
        grading: Object.freeze({
          ...evaluationCase.grading,
          deterministicGold:
            goldById[evaluationCase.id] ??
            evaluationCase.grading.deterministicGold,
        }),
      }),
    ),
  );
  assertV2EvaluationCorpus(cases);
  return Object.freeze({
    cases,
    datasetWatermarkHash: rawManifest.datasetWatermarkHash as string,
  });
}

export function assertNoConflictingV2EvaluationEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  const expected: Readonly<Record<string, string>> = {
    ALBERT_AGENT_QA_MODEL: V2_EVALUATION_RUNTIME.model,
    ALBERT_AGENT_QA_EFFORT: V2_EVALUATION_RUNTIME.reasoningEffort,
    ALBERT_AGENT_QA_FAST_MODE: "false",
    ALBERT_AGENT_QA_PRO_MODE: "false",
    ALBERT_AGENT_QA_MAX_ATTEMPTS: String(V2_EVALUATION_RUNTIME.maximumAttempts),
    ALBERT_ANALYTICAL_RUNTIME: V2_EVALUATION_RUNTIME.analyticalRuntime,
  };
  for (const [name, value] of Object.entries(expected)) {
    const supplied = environment[name]?.trim();
    if (supplied && supplied !== value)
      throw new Error(
        `${name} conflicts with the locked V2 evaluation value ${value}.`,
      );
  }
  if (environment.ALBERT_AGENT_QA_ONLY?.trim())
    throw new Error(
      "Partial selection is prohibited for the capped release evaluation.",
    );
}

export function v2EvaluationEnvironment(): Readonly<Record<string, string>> {
  return Object.freeze({
    ALBERT_AGENT_QA_MODEL: V2_EVALUATION_RUNTIME.model,
    ALBERT_AGENT_QA_EFFORT: V2_EVALUATION_RUNTIME.reasoningEffort,
    ALBERT_AGENT_QA_FAST_MODE: String(V2_EVALUATION_RUNTIME.fastMode),
    ALBERT_AGENT_QA_PRO_MODE: String(V2_EVALUATION_RUNTIME.proMode),
    ALBERT_AGENT_QA_MAX_ATTEMPTS: String(V2_EVALUATION_RUNTIME.maximumAttempts),
    ALBERT_ANALYTICAL_RUNTIME: V2_EVALUATION_RUNTIME.analyticalRuntime,
  });
}
