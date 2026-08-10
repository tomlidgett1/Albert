import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { compileQueryWorkspaceV2 } from "../packages/compiler/src/v2.js";
import {
  createSemanticPublicationV2,
  semanticRegistryDocumentV2Schema,
} from "../packages/semantic-registry/src/v2.js";
import {
  assertV2EvaluationCorpus,
  assertV2PublicEvaluationBlueprint,
  sealedV2HoldoutPrompt,
  V2_REQUIRED_OPERATOR_COVERAGE,
  V2_REQUIRED_RISK_COVERAGE,
  V2_REQUIRED_TOPIC_COVERAGE,
  type V2EvaluationCase,
} from "./v2-evaluation-policy.js";

type Source = V2EvaluationCase["source"];
type Difficulty = V2EvaluationCase["difficulty"];
type QuestionClass = V2EvaluationCase["questionClass"];
type Terminal = V2EvaluationCase["expectedTerminalState"];
type OperatorId = (typeof V2_REQUIRED_OPERATOR_COVERAGE)[number];

type RegistryTopic = Readonly<{
  id: string;
  layer: "source_domain" | "business" | "composite";
  label: string;
  description: string;
  viewIds: readonly string[];
  dimensionIds: readonly string[];
  measureIds: readonly string[];
  sampleQuestions: readonly string[];
}>;

type RegistryMeasure = Readonly<{
  id: string;
  viewId: string;
  label: string;
  description: string;
  semanticState: string;
  currencyFieldId?: string;
}>;

type MutableEvaluationCase = {
  -readonly [Key in keyof V2EvaluationCase]: V2EvaluationCase[Key];
};

function labels<T extends string>(
  counts: Readonly<Record<T, number>>,
  seed: number,
): T[] {
  const values = Object.entries(counts).flatMap(([label, count]) =>
    Array.from({ length: Number(count) }, () => label as T),
  );
  let state = seed >>> 0;
  for (let index = values.length - 1; index > 0; index -= 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    [values[index], values[target]] = [values[target]!, values[index]!];
  }
  return values;
}

const registry = semanticRegistryDocumentV2Schema.parse(
  JSON.parse(
    readFileSync(
      resolve("packages/semantic-registry/registry/registry.v2.json"),
      "utf8",
    ),
  ),
);
const publicationHash = createSemanticPublicationV2(registry).publicationHash;
const topicById = new Map(registry.topics.map((topic) => [topic.id, topic]));
const dimensionById = new Map(
  registry.dimensions.map((dimension) => [dimension.id, dimension]),
);
const measureById = new Map(
  registry.measures.map((measure) => [measure.id, measure]),
);
for (const topicId of V2_REQUIRED_TOPIC_COVERAGE)
  if (!topicById.has(topicId))
    throw new Error(
      `Required evaluation Topic ${topicId} is absent from Registry V2.`,
    );

const sources = labels<Source>(
  { lightspeed: 80, xero: 80, lightspeed_xero: 40 },
  7,
);
const difficulties = labels<Difficulty>(
  { easy: 30, medium: 60, hard: 70, adversarial: 40 },
  17,
);
const classes = labels<QuestionClass>(
  {
    lookup: 35,
    comparison: 40,
    diagnosis: 50,
    recommendation: 45,
    open_exploration: 30,
  },
  29,
);

// This cross-allocation preserves the locked aggregate terminal-state totals
// while giving comparison and diagnosis enough Derived cases to exercise the
// full deterministic operator catalogue. Recommendations remain Derived at
// best and therefore never receive an expected Verified state.
const terminalAllocations: Readonly<
  Record<QuestionClass, Readonly<Record<Terminal, number>>>
> = {
  lookup: {
    verified: 26,
    derived: 0,
    exploratory: 3,
    clarification: 2,
    no_data: 2,
    unavailable: 2,
  },
  comparison: {
    verified: 24,
    derived: 8,
    exploratory: 2,
    clarification: 2,
    no_data: 2,
    unavailable: 2,
  },
  diagnosis: {
    verified: 32,
    derived: 12,
    exploratory: 2,
    clarification: 1,
    no_data: 1,
    unavailable: 2,
  },
  recommendation: {
    verified: 0,
    derived: 10,
    exploratory: 10,
    clarification: 8,
    no_data: 8,
    unavailable: 9,
  },
  open_exploration: {
    verified: 23,
    derived: 0,
    exploratory: 3,
    clarification: 2,
    no_data: 2,
    unavailable: 0,
  },
};
const terminalQueues = Object.fromEntries(
  Object.entries(terminalAllocations).map(
    ([questionClass, counts], index) => [
      questionClass,
      labels(counts, 43 + index * 17),
    ],
  ),
) as Record<QuestionClass, Terminal[]>;

const terminalAssignments = classes.map((questionClass) => {
  const terminal = terminalQueues[questionClass].shift();
  if (!terminal)
    throw new Error(
      `Terminal allocation for ${questionClass} was exhausted.`,
    );
  return terminal;
});

// The qualification tenant has live Xero source data but its certified
// canonical finance marts are not yet populated. A cross-source question can
// therefore be Derived, Exploratory, Clarification, No data or Unavailable,
// but cannot honestly be expected Verified. Move every provisional composite
// Verified allocation to a non-composite, non-recommendation case while
// preserving all locked marginal totals and enough non-verified cases to
// cover every source-domain Topic.
const sourceTopicReserve: Readonly<Record<"lightspeed" | "xero", number>> = {
  lightspeed: V2_REQUIRED_TOPIC_COVERAGE.filter((id) =>
    id.startsWith("source.lightspeed."),
  ).length,
  xero: V2_REQUIRED_TOPIC_COVERAGE.filter((id) =>
    id.startsWith("source.xero."),
  ).length,
};
const nonVerifiedNonDerived = (source: "lightspeed" | "xero") =>
  terminalAssignments.filter(
    (terminal, index) =>
      sources[index] === source &&
      terminal !== "verified" &&
      terminal !== "derived",
  ).length;
for (const [compositeIndex, terminal] of terminalAssignments.entries()) {
  if (sources[compositeIndex] !== "lightspeed_xero" || terminal !== "verified")
    continue;
  const replacementIndex = terminalAssignments.findIndex(
    (candidate, index) => {
      const source = sources[index];
      return (
        source !== "lightspeed_xero" &&
        classes[index] !== "recommendation" &&
        candidate !== "verified" &&
        candidate !== "derived" &&
        nonVerifiedNonDerived(source) > sourceTopicReserve[source]
      );
    },
  );
  if (replacementIndex < 0)
    throw new Error(
      "The evaluation allocation cannot remove false composite Verified expectations while preserving source-Topic coverage.",
    );
  terminalAssignments[compositeIndex] = terminalAssignments[replacementIndex]!;
  terminalAssignments[replacementIndex] = "verified";
}

const topicPools: Readonly<Record<Source, readonly string[]>> = {
  lightspeed: [
    ...V2_REQUIRED_TOPIC_COVERAGE.filter((id) =>
      id.startsWith("source.lightspeed."),
    ),
    "business.sales_performance",
    "business.product_category_performance",
    "business.gross_margin_discounting",
    "business.inventory_health",
    "business.purchasing_suppliers",
    "business.customers_retention",
    "business.store_employee_performance",
    "business.gst_tax",
  ],
  xero: [
    ...V2_REQUIRED_TOPIC_COVERAGE.filter((id) =>
      id.startsWith("source.xero."),
    ),
    "business.purchasing_suppliers",
    "business.customers_retention",
    "business.cash_banking",
    "business.receivables",
    "business.payables_expenses",
    "business.financial_performance",
    "business.gst_tax",
  ],
  lightspeed_xero: V2_REQUIRED_TOPIC_COVERAGE.filter((id) =>
    id.startsWith("composite."),
  ),
};

const knownPopulatedXeroViews = new Set([
  "source.xero.xero_accounts",
  "source.xero.xero_bank_transactions",
  "source.xero.xero_bank_transfers",
  "source.xero.xero_batch_payments",
  "source.xero.xero_contacts",
  "source.xero.xero_credit_notes",
  "source.xero.xero_invoice_line_items",
  "source.xero.xero_invoices",
  "source.xero.xero_manual_journal_lines",
  "source.xero.xero_manual_journals",
  "source.xero.xero_overpayments",
  "source.xero.xero_payments",
  "source.xero.xero_payroll_au_employees",
  "source.xero.xero_payroll_au_pay_runs",
  "source.xero.xero_payroll_au_timesheets",
]);
const verifiedTopicPools: Readonly<
  Record<Exclude<Source, "lightspeed_xero">, readonly string[]>
> = {
  lightspeed: [
    "business.sales_performance",
    "business.product_category_performance",
    "business.gross_margin_discounting",
    "business.inventory_health",
    "business.customers_retention",
    "business.store_employee_performance",
  ],
  xero: V2_REQUIRED_TOPIC_COVERAGE.filter((topicId) => {
    const topic = topicById.get(topicId);
    return (
      topic?.layer === "source_domain" &&
      topic.viewIds.some((viewId) => knownPopulatedXeroViews.has(viewId))
    );
  }),
};
if (
  verifiedTopicPools.lightspeed.length === 0 ||
  verifiedTopicPools.xero.length === 0
)
  throw new Error("Verified evaluation Topic pools must not be empty.");

const forcedCoverageTopicByIndex = new Map<number, string>();
for (const source of ["lightspeed", "xero"] as const) {
  const requiredTopics = V2_REQUIRED_TOPIC_COVERAGE.filter((topicId) =>
    topicId.startsWith(`source.${source}.`),
  );
  const eligible = terminalAssignments
    .map((terminal, index) => ({ terminal, index }))
    .filter(
      ({ terminal, index }) =>
        sources[index] === source &&
        terminal !== "verified" &&
        terminal !== "derived",
    );
  if (eligible.length < requiredTopics.length)
    throw new Error(
      `The ${source} allocation does not retain enough non-certified cases for complete source-Topic coverage.`,
    );
  requiredTopics.forEach((topicId, index) =>
    forcedCoverageTopicByIndex.set(eligible[index]!.index, topicId),
  );
}

// Xero's verified pool intentionally exercises signed source structure. Reserve
// separate non-operator cases for every normal accounting business Topic so
// source completeness cannot crowd customer-facing coverage out of the corpus.
for (const topicId of topicPools.xero.filter((id) => id.startsWith("business."))) {
  const topic = topicById.get(topicId)!;
  const candidate = terminalAssignments
    .map((terminal, index) => ({ terminal, index }))
    .find(
      ({ terminal, index }) =>
        sources[index] === "xero" &&
        terminal !== "derived" &&
        !forcedCoverageTopicByIndex.has(index) &&
        (terminal !== "verified" ||
          topic.measureIds.some((measureId) => {
            const measure = measureById.get(measureId);
            return (
              measure?.semanticState === "verified" &&
              knownPopulatedXeroViews.has(measure.viewId) &&
              measure.id.endsWith(".row_count")
            );
          })),
    );
  if (!candidate)
    throw new Error(`No compatible Xero case can cover business Topic ${topicId}.`);
  forcedCoverageTopicByIndex.set(candidate.index, topicId);
}

const periods = [
  "the last complete trading week",
  "the last complete calendar month",
  "the last complete fiscal quarter",
  "fiscal year to date through the last complete day",
  "the same complete period last year",
  "the four complete weeks ending before today",
  "the complete month spanning the daylight-saving transition",
  "the current fiscal year compared only through the same elapsed day last year",
  "the last 13 complete trading weeks",
  "the prior two complete fiscal periods",
] as const;

const dimensions: Readonly<Record<Source, readonly string[]>> = {
  lightspeed: [
    "store",
    "category",
    "product and matrix",
    "customer cohort",
    "employee",
    "register",
    "tender type",
    "supplier",
    "workshop status",
    "weekday",
    "trading hour",
    "return reason",
  ],
  xero: [
    "account",
    "contact",
    "invoice or bill status",
    "tracking category",
    "bank account",
    "tax type",
    "project",
    "asset class",
    "supplier",
    "due-date bucket",
    "currency",
    "document type",
  ],
  lightspeed_xero: [
    "recognition period",
    "store and accounting account",
    "settlement window",
    "customer mapping status",
    "category and COGS account",
    "working-capital component",
    "source authority",
    "matched versus unmatched coverage",
  ],
};

function certifiedMeasureFor(
  topic: RegistryTopic,
  source: Source,
  ordinal: number,
): RegistryMeasure {
  const candidates = topic.measureIds
    .flatMap((id) => measureById.get(id) ?? [])
    .filter(
      (measure) =>
        measure.semanticState === "verified" &&
        (source !== "xero" ||
          (knownPopulatedXeroViews.has(measure.viewId) &&
            measure.id.endsWith(".row_count"))),
    );
  if (candidates.length === 0)
    throw new Error(
      `Verified case has no certified, populated measure in Topic ${topic.id}.`,
    );
  return candidates[ordinal % candidates.length]!;
}

function governedDimensionLabel(
  topic: RegistryTopic,
  measure: RegistryMeasure | null,
  terminal: Terminal,
  fallback: string,
  ordinal: number,
): string {
  const candidates = topic.dimensionIds
    .flatMap((id) => dimensionById.get(id) ?? [])
    .filter(
      (dimension) =>
        !measure ||
        (dimension.viewId === measure.viewId &&
          (terminal !== "verified" || dimension.semanticState === "verified")),
    );
  return candidates.length
    ? candidates[ordinal % candidates.length]!.label
    : fallback;
}

const riskCompatibility: Readonly<
  Record<(typeof V2_REQUIRED_RISK_COVERAGE)[number], readonly Source[]>
> = {
  line_payment_fanout: ["lightspeed", "lightspeed_xero"],
  snapshot_semi_additivity: ["lightspeed", "lightspeed_xero"],
  refund_void_reversal: ["lightspeed", "lightspeed_xero"],
  gift_card_store_credit: ["lightspeed", "lightspeed_xero"],
  gst_basis: ["lightspeed", "xero", "lightspeed_xero"],
  cost_basis: ["lightspeed", "lightspeed_xero"],
  recognition_date: ["lightspeed", "xero", "lightspeed_xero"],
  cash_accrual_basis: ["xero", "lightspeed_xero"],
  journal_balance: ["xero", "lightspeed_xero"],
  payment_allocation: ["xero", "lightspeed_xero"],
  cross_source_double_counting: ["lightspeed_xero"],
  bank_settlement_timing: ["xero", "lightspeed_xero"],
  multi_currency: ["xero", "lightspeed_xero"],
  fiscal_calendar_dst_partial_period: [
    "lightspeed",
    "xero",
    "lightspeed_xero",
  ],
  null_zero_sparse_duplicate_orphan_late_data: [
    "lightspeed",
    "xero",
    "lightspeed_xero",
  ],
  ambiguous_unsupported_join: [
    "lightspeed",
    "xero",
    "lightspeed_xero",
  ],
  causal_overreach: ["lightspeed", "xero", "lightspeed_xero"],
  recommendation_controllability: [
    "lightspeed",
    "xero",
    "lightspeed_xero",
  ],
};

const oracleFrom = "2026-07-07T00:00:00.000Z";
const oracleTo = "2026-08-08T00:00:00.000Z";
const noDataOracleFrom = "1900-01-01T00:00:00.000Z";
const noDataOracleTo = "1900-02-01T00:00:00.000Z";

function oracleBlockFor(input: Readonly<{
  caseId: string;
  topic: RegistryTopic;
  preferredMeasure: RegistryMeasure | null;
  questionClass: QuestionClass;
  noData: boolean;
}>): NonNullable<V2EvaluationCase["grading"]["oracleBlock"]> {
  const comparisonKinds = ["prior_period", "prior_month", "prior_year"] as const;
  const caseOrdinal = Number(input.caseId.slice(3));
  const views = new Map(registry.views.map((view) => [view.id, view]));
  const measures = [
    ...(input.preferredMeasure ? [input.preferredMeasure] : []),
    ...input.topic.measureIds.flatMap((id) => measureById.get(id) ?? []),
  ].filter(
    (measure, index, all) =>
      all.findIndex(({ id }) => id === measure.id) === index &&
      !["unsupported", "deprecated"].includes(measure.semanticState) &&
      (input.noData || measure.semanticState === "verified"),
  );
  for (const measure of measures) {
    const view = views.get(measure.viewId);
    if (!view || !input.topic.viewIds.includes(view.id)) continue;
    const timeDimensions = input.topic.dimensionIds
      .flatMap((id) => dimensionById.get(id) ?? [])
      .filter(
        (dimension) =>
          dimension.viewId === measure.viewId && dimension.timeRole !== "none",
      );
    const timeSelections =
      view.temporalAvailability === "current_only"
        ? input.noData
          ? []
          : [{ range: { type: "current_snapshot" as const } }]
        : timeDimensions.map((dimension) => ({
            dimensionId: dimension.id,
            range: {
              type: "absolute" as const,
              from: input.noData ? noDataOracleFrom : oracleFrom,
              to: input.noData ? noDataOracleTo : oracleTo,
            },
          }));
    for (const time of timeSelections) {
      const currencyDimension = measure.currencyFieldId
        ? input.topic.dimensionIds
            .flatMap((id) => dimensionById.get(id) ?? [])
            .find(
              (dimension) =>
                dimension.viewId === measure.viewId &&
                dimension.fieldId === measure.currencyFieldId,
            )
        : undefined;
      if (measure.currencyFieldId && !currencyDimension) continue;
      const block = {
        id: `${input.caseId}_oracle`,
        topicIds: [input.topic.id],
        rootViewId: measure.viewId,
        dimensionIds: currencyDimension ? [currencyDimension.id] : [],
        measureIds: [measure.id],
        filters: [],
        time,
        ...(input.questionClass === "comparison" && !input.noData
          ? {
              comparison: {
                kind: comparisonKinds[caseOrdinal % comparisonKinds.length]!,
              },
            }
          : {}),
        sort: [],
        limit: 100,
        parameters: {},
      };
      try {
        compileQueryWorkspaceV2(
          {
            id: `${input.caseId}_workspace`,
            tenantId: "01KZ4ZMVF5QNQ4TX35VF3WDJBM",
            publicationHash,
            overlayVersion: "evaluation-oracle-v1",
            revision: 1,
            questionId: input.caseId,
            blocks: [block],
            status: "draft",
            createdAt: "2026-08-10T00:00:00.000Z",
            updatedAt: "2026-08-10T00:00:00.000Z",
          },
          registry,
          {
            tenantId: "01KZ4ZMVF5QNQ4TX35VF3WDJBM",
            now: "2026-08-10T00:00:00.000Z",
            timezone: "Australia/Melbourne",
            tradingDayCutoff: "04:00",
            fiscalYearStartMonth: 7,
            fiscalYearStartDay: 1,
            weekStartsOn: 1,
            maxEstimatedCost: 250,
            maxRows: 1_000,
            connectionSet: ["evaluation-oracle"],
          },
        );
        return block;
      } catch {
        // Try the next governed measure/time role combination.
      }
    }
  }
  throw new Error(
    `No deterministic oracle block compiles for ${input.caseId} in Topic ${input.topic.id}.`,
  );
}

function topicFocus(
  topic: RegistryTopic,
  questionClass: QuestionClass,
  period: string,
  dimension: string,
  measure: RegistryMeasure | null,
): string {
  const example = measure
    ? `Report ${measure.label}: ${measure.description}`
    : (topic.sampleQuestions[0] ?? topic.description);
  if (questionClass === "lookup")
    return `For ${period}, answer this ${topic.label} question and report the result by ${dimension}: ${example}`;
  if (questionClass === "comparison")
    return `For ${topic.label}, compare ${period} with the prior equivalent complete period by ${dimension}. Focus on this business question: ${example}`;
  if (questionClass === "diagnosis")
    return `Diagnose the material drivers in ${topic.label} for ${period} by ${dimension}. Test competing explanations related to: ${topic.description}`;
  if (questionClass === "recommendation")
    return `Using ${topic.label} evidence for ${period}, identify and size the highest-value controllable action by ${dimension}. Respect this scope: ${topic.description}`;
  return `Explore ${topic.label} for ${period} across ${dimension}, identify the most material governed signals, and state what remains inconclusive. Scope: ${topic.description}`;
}

const unavailableRequests: Readonly<Record<Source, readonly string[]>> = {
  lightspeed: [
    "Prove that a competitor's price change caused the observed result using only Lightspeed.",
    "Calculate exact market share without any governed competitor or market-size data.",
    "Identify employee intent or motivation from transaction records alone.",
  ],
  xero: [
    "Convert every historical amount using exact transaction-date market FX when no governed FX series exists.",
    "Prove that an external advertising campaign caused the accounting result using Xero alone.",
    "Forecast the statutory tax assessment without a governed tax-liability model.",
  ],
  lightspeed_xero: [
    "Prove that an external advertising campaign caused the profitability change using only Lightspeed and Xero.",
    "Reconcile individual events when no governed cross-source event identity exists.",
    "Claim exact economic profit when owner labour and other off-ledger costs are unavailable.",
  ],
};

function nonDerivedQuestion(input: Readonly<{
  source: Source;
  difficulty: Difficulty;
  questionClass: QuestionClass;
  terminal: Terminal;
  topic: RegistryTopic;
  measure: RegistryMeasure | null;
  period: string;
  dimension: string;
  ordinal: number;
}>): string {
  const focus = topicFocus(
    input.topic,
    input.questionClass,
    input.period,
    input.dimension,
    input.measure,
  );
  if (input.terminal === "clarification") {
    const ambiguity =
      input.source === "lightspeed"
        ? "The request deliberately does not specify revenue versus tenders versus tickets, GST basis, or recognition date."
        : input.source === "xero"
          ? "The request deliberately does not specify cash versus accrual basis, financial definition, or document status."
          : "The request deliberately does not specify source authority, recognition date, GST basis, matching window, or tolerance.";
    return `${focus} ${ambiguity} Ask exactly one material clarification instead of guessing.`;
  }
  if (input.terminal === "no_data")
    return `${focus} Restrict the valid governed query to 1 January 1900 through 31 January 1900 and return No data—not Unavailable—when it is empty.`;
  if (input.terminal === "unavailable") {
    const requests = unavailableRequests[input.source];
    return `${input.topic.label}, ${input.period}, ${input.dimension}: ${requests[input.ordinal % requests.length]} Return the exact unavailable capability and unlock; do not invent a proxy.`;
  }
  if (input.terminal === "exploratory")
    return `${focus} Use the documented but uncertified source semantics needed for this case, label every affected claim Exploratory, and disclose the exact limitation.`;
  const stress =
    input.difficulty === "adversarial"
      ? "Defend against fan-out, duplicate keys, nulls, zero denominators, refunds or reversals, unsafe snapshot aggregation, and timing mismatch."
      : input.difficulty === "hard"
        ? "Resolve fiscal calendar, recognition date, GST basis, sign, currency, partial-period and source-authority semantics explicitly."
        : input.difficulty === "medium"
          ? "Use the governed time role, grain, status filters and comparison scope explicitly."
          : "Use certified measures and cell-ground every number.";
  return `${focus} ${stress} Keep causal interpretation separate from measured association.`;
}

type OperatorSpec = Readonly<{
  id: OperatorId;
  sources: readonly Source[];
  classes: readonly QuestionClass[];
}>;

const operatorSpecs: readonly OperatorSpec[] = [
  {
    id: "pos_xero_reconciliation",
    sources: ["lightspeed_xero"],
    classes: ["comparison", "diagnosis"],
  },
  {
    id: "sales_bank_reconciliation",
    sources: ["lightspeed_xero"],
    classes: ["comparison", "diagnosis"],
  },
  {
    id: "price_volume_mix",
    sources: ["lightspeed", "lightspeed_xero"],
    classes: ["comparison", "diagnosis"],
  },
  {
    id: "discount_leakage",
    sources: ["lightspeed", "lightspeed_xero"],
    classes: ["comparison", "diagnosis"],
  },
  {
    id: "return_rate",
    sources: ["lightspeed", "lightspeed_xero"],
    classes: ["comparison", "diagnosis"],
  },
  {
    id: "customer_retention",
    sources: ["lightspeed", "lightspeed_xero"],
    classes: ["diagnosis"],
  },
  {
    id: "stockout_opportunity",
    sources: ["lightspeed", "lightspeed_xero"],
    classes: ["diagnosis"],
  },
  {
    id: "profitability_bridge",
    sources: ["xero", "lightspeed_xero"],
    classes: ["comparison", "diagnosis"],
  },
  {
    id: "supplier_performance",
    sources: ["lightspeed", "xero", "lightspeed_xero"],
    classes: ["comparison", "diagnosis"],
  },
  {
    id: "gross_margin_bridge",
    sources: ["lightspeed", "xero", "lightspeed_xero"],
    classes: ["comparison", "diagnosis"],
  },
  {
    id: "period_contribution",
    sources: ["lightspeed", "xero", "lightspeed_xero"],
    classes: ["comparison", "diagnosis"],
  },
  {
    id: "dimension_contribution",
    sources: ["lightspeed", "xero", "lightspeed_xero"],
    classes: ["diagnosis"],
  },
  {
    id: "pareto_concentration",
    sources: ["lightspeed", "xero", "lightspeed_xero"],
    classes: ["diagnosis"],
  },
  {
    id: "trend_anomaly",
    sources: ["lightspeed", "xero", "lightspeed_xero"],
    classes: ["comparison", "diagnosis"],
  },
  {
    id: "opportunity_sizing",
    sources: ["lightspeed", "xero", "lightspeed_xero"],
    classes: ["recommendation"],
  },
  {
    id: "constraint_controllability",
    sources: ["lightspeed", "xero", "lightspeed_xero"],
    classes: ["recommendation"],
  },
];

function operatorTopic(operatorId: OperatorId, source: Source): string {
  if (operatorId === "pos_xero_reconciliation")
    return "composite.pos_accounting_revenue";
  if (operatorId === "sales_bank_reconciliation")
    return "composite.sales_bank";
  if (operatorId === "price_volume_mix")
    return "business.product_category_performance";
  if (operatorId === "discount_leakage" || operatorId === "return_rate")
    return "business.gross_margin_discounting";
  if (operatorId === "customer_retention")
    return "business.customers_retention";
  if (operatorId === "stockout_opportunity")
    return "business.inventory_health";
  if (operatorId === "supplier_performance")
    return "business.purchasing_suppliers";
  if (operatorId === "profitability_bridge")
    return source === "lightspeed_xero"
      ? "composite.trading_profitability"
      : "business.financial_performance";
  if (
    operatorId === "opportunity_sizing" ||
    operatorId === "constraint_controllability"
  )
    return source === "lightspeed_xero"
      ? "composite.cash_conversion"
      : source === "xero"
        ? "business.financial_performance"
        : "business.sales_performance";
  return source === "lightspeed_xero"
    ? "composite.trading_profitability"
    : source === "xero"
      ? "business.financial_performance"
      : "business.sales_performance";
}

function operatorQuestion(
  operatorId: OperatorId,
  source: Source,
  questionClass: QuestionClass,
  period: string,
  dimension: string,
): string {
  const prefix =
    questionClass === "comparison"
      ? "Compare the complete periods and"
      : questionClass === "diagnosis"
        ? "Test competing explanations and"
        : "Produce a ranked recommendation and";
  const byOperator: Readonly<Record<OperatorId, string>> = {
    period_contribution: `calculate a period-over-period contribution bridge by ${dimension}`,
    dimension_contribution: `decompose the total change into exhaustive ${dimension} contributions`,
    gross_margin_bridge:
      "bridge gross-profit change into governed revenue and cost effects with margin rates",
    price_volume_mix:
      "decompose revenue change into price, volume, and disclosed interaction effects at stable product grain",
    pareto_concentration: `calculate Pareto concentration and the governed share attributable to the leading ${dimension} members`,
    trend_anomaly:
      "evaluate at least 12 complete periods for deterministic trend anomalies without claiming causality",
    discount_leakage:
      "separate observed discounts from the governed approved-discount baseline and quantify leakage limitations",
    return_rate:
      "calculate value and unit return rates with their separate governed denominators",
    customer_retention:
      "calculate acquisition-cohort retention using stable governed customer identity",
    stockout_opportunity:
      "estimate stockout opportunity from unavailable days, observed demand, margin, and explicit availability assumptions",
    supplier_performance:
      "calculate supplier fill rate and lead-time variance from complete order and receipt evidence",
    pos_xero_reconciliation:
      "reconcile independently aggregated Lightspeed revenue to Xero revenue with explicit tolerance and unmatched coverage",
    sales_bank_reconciliation:
      "reconcile sales to bank settlements after explicit timing and fee adjustments",
    profitability_bridge:
      "bridge revenue, COGS, and operating expenses into operating profit without double-counting source authority",
    opportunity_sizing:
      "size gross, confidence-adjusted, and net opportunity after implementation cost",
    constraint_controllability:
      "separate actionable value from constrained or low-controllability opportunities using governed business context",
  };
  const sourceScope =
    source === "lightspeed_xero"
      ? "using independently aggregated Lightspeed and Xero evidence"
      : `using governed ${source === "lightspeed" ? "Lightspeed" : "Xero"} evidence`;
  return `${prefix} ${byOperator[operatorId]} for ${period}, ${sourceScope}. Segment the evidence by ${dimension}. Persist the ${operatorId} operator evidence, disclose undefined or incomplete components, and ground every figure.`;
}

const sourceOrdinals: Record<Source, number> = {
  lightspeed: 0,
  xero: 0,
  lightspeed_xero: 0,
};

const cases: MutableEvaluationCase[] = Array.from(
  { length: 200 },
  (_, index) => {
    const source = sources[index]!;
    const ordinal = sourceOrdinals[source]++;
    const difficulty = difficulties[index]!;
    const questionClass = classes[index]!;
    const expectedTerminalState = terminalAssignments[index]!;
    const topicId =
      forcedCoverageTopicByIndex.get(index) ??
      (expectedTerminalState === "verified" && source !== "lightspeed_xero"
        ? verifiedTopicPools[source][
            ordinal % verifiedTopicPools[source].length
          ]
        : topicPools[source][ordinal % topicPools[source].length])!;
    const topic = topicById.get(topicId)!;
    const period = periods[(index + ordinal) % periods.length]!;
    const genericDimension =
      dimensions[source][(index * 3 + ordinal) % dimensions[source].length]!;
    const measure =
      expectedTerminalState === "verified"
        ? certifiedMeasureFor(topic, source, ordinal)
        : null;
    const dimension = governedDimensionLabel(
      topic,
      measure,
      expectedTerminalState,
      genericDimension,
      index + ordinal,
    );
    const risks = V2_REQUIRED_RISK_COVERAGE.filter((risk) =>
      riskCompatibility[risk].includes(source),
    );
    const risk = risks[ordinal % risks.length]!;
    const secondaryRisk = risks[(ordinal * 5 + 3) % risks.length]!;
    return {
      id: `v2_${String(index + 1).padStart(3, "0")}`,
      tier: difficulty,
      domain: source,
      ask:
        expectedTerminalState === "derived"
          ? `Pending deterministic operator assignment for ${topic.label}.`
          : nonDerivedQuestion({
              source,
              difficulty,
              questionClass,
              terminal: expectedTerminalState,
              topic,
              measure,
              period,
              dimension,
              ordinal,
            }),
      source,
      difficulty,
      questionClass,
      expectedTerminalState,
      visibility: index < 160 ? "visible" : "hidden",
      expectedOperator: null,
      grading: {
        requiresClaims: ["verified", "derived", "exploratory"].includes(
          expectedTerminalState,
        ),
        requiresOperator: false,
        oracleBlock: null,
        deterministicGold:
          expectedTerminalState === "no_data"
            ? { kind: "empty_result", rowCount: 0 }
            : null,
        prohibitedConnectors: ["deputy"],
      },
      tags: [
        source,
        difficulty,
        questionClass,
        expectedTerminalState,
        `topic:${topicId}`,
        `dimension:${dimension.replaceAll(" ", "_")}`,
        `risk:${risk}`,
        `risk:${secondaryRisk}`,
      ],
    };
  },
);

function assignOperator(
  evaluationCase: MutableEvaluationCase,
  operatorId: OperatorId,
): void {
  const index = Number(evaluationCase.id.slice(3)) - 1;
  const period = periods[
    (index + sourceOrdinalsForCase(evaluationCase)) % periods.length
  ]!;
  const dimensionPool = dimensions[evaluationCase.source];
  const dimension = dimensionPool[index % dimensionPool.length]!;
  const topicId = operatorTopic(operatorId, evaluationCase.source);
  evaluationCase.expectedOperator = operatorId;
  evaluationCase.ask = operatorQuestion(
    operatorId,
    evaluationCase.source,
    evaluationCase.questionClass,
    period,
    dimension,
  );
  evaluationCase.grading = {
    ...evaluationCase.grading,
    requiresOperator: true,
  };
  evaluationCase.tags = [
    ...evaluationCase.tags.filter(
      (tag) => !tag.startsWith("topic:") && !tag.startsWith("operator:"),
    ),
    `topic:${topicId}`,
    `operator:${operatorId}`,
  ];
}

function sourceOrdinalsForCase(evaluationCase: MutableEvaluationCase): number {
  let ordinal = -1;
  for (const candidate of cases) {
    if (candidate.source === evaluationCase.source) ordinal += 1;
    if (candidate === evaluationCase) return ordinal;
  }
  throw new Error(`Case ${evaluationCase.id} is not in the corpus.`);
}

const unassignedDerived = () =>
  cases.filter(
    ({ expectedTerminalState, expectedOperator }) =>
      expectedTerminalState === "derived" && expectedOperator === null,
  );

// Some generated Verified cases originally landed on certified facts that are
// empty in the qualified Sydney snapshot. Keep numerical gold cases bound to a
// populated certified fact; the empty domains remain covered by explicit No
// data, Exploratory, and Unavailable cases.
const numericOracleOverrides = new Map<
  string,
  Readonly<{ topicId: string; measureId: string }>
>([
  [
    "v2_006",
    {
      topicId: "business.sales_performance",
      measureId: "commerce.transactions",
    },
  ],
  [
    "v2_020",
    {
      topicId: "business.sales_performance",
      measureId: "commerce.transactions",
    },
  ],
  [
    "v2_024",
    {
      topicId: "business.sales_performance",
      measureId: "commerce.transactions",
    },
  ],
  [
    "v2_075",
    {
      topicId: "business.sales_performance",
      measureId: "commerce.transactions",
    },
  ],
  [
    "v2_126",
    {
      topicId: "business.sales_performance",
      measureId: "commerce.transactions",
    },
  ],
  [
    "v2_127",
    {
      topicId: "business.sales_performance",
      measureId: "commerce.transactions",
    },
  ],
  [
    "v2_141",
    {
      topicId: "business.sales_performance",
      measureId: "commerce.transactions",
    },
  ],
  [
    "v2_178",
    {
      topicId: "business.sales_performance",
      measureId: "commerce.transactions",
    },
  ],
]);

// Assign every operator to a visible compatible case first. The committed 160
// regression cases therefore retain full operator coverage even when the 40
// placeholder holdout cases are replaced by the sealed external holdout.
for (const spec of operatorSpecs) {
  const candidate = unassignedDerived().find(
    (evaluationCase) =>
      evaluationCase.visibility === "visible" &&
      spec.sources.includes(evaluationCase.source) &&
      spec.classes.includes(evaluationCase.questionClass),
  );
  if (!candidate)
    throw new Error(
      `No visible derived case can cover operator ${spec.id}; adjust the deterministic allocation seeds.`,
    );
  assignOperator(candidate, spec.id);
}

let fallbackIndex = 0;
for (const evaluationCase of unassignedDerived()) {
  const compatible = operatorSpecs.filter(
    ({ sources: allowedSources, classes: allowedClasses }) =>
      allowedSources.includes(evaluationCase.source) &&
      allowedClasses.includes(evaluationCase.questionClass),
  );
  if (!compatible.length)
    throw new Error(
      `Derived case ${evaluationCase.id} has no compatible deterministic operator.`,
    );
  assignOperator(
    evaluationCase,
    compatible[fallbackIndex++ % compatible.length]!.id,
  );
}

for (const evaluationCase of cases) {
  const needsNumericOracle =
    evaluationCase.expectedTerminalState === "verified" &&
    (evaluationCase.questionClass === "lookup" ||
      evaluationCase.questionClass === "comparison");
  const needsEmptyOracle = evaluationCase.expectedTerminalState === "no_data";
  if (!needsNumericOracle && !needsEmptyOracle) continue;
  const override = numericOracleOverrides.get(evaluationCase.id);
  if (override)
    evaluationCase.tags = [
      ...evaluationCase.tags.filter((tag) => !tag.startsWith("topic:")),
      `topic:${override.topicId}`,
    ];
  const topicId = override?.topicId ?? evaluationCase.tags
    .find((tag) => tag.startsWith("topic:"))
    ?.slice("topic:".length);
  const topic = topicId ? topicById.get(topicId) : undefined;
  if (!topic)
    throw new Error(`Evaluation case ${evaluationCase.id} has no Topic.`);
  const preferredMeasure = needsNumericOracle
    ? override
      ? (measureById.get(override.measureId) ?? null)
      : certifiedMeasureFor(
          topic,
          evaluationCase.source,
          Number(evaluationCase.id.slice(3)),
        )
    : null;
  if (override && !preferredMeasure)
    throw new Error(
      `Evaluation case ${evaluationCase.id} references unknown measure ${override.measureId}.`,
    );
  const oracleBlock = oracleBlockFor({
    caseId: evaluationCase.id,
    topic,
    preferredMeasure,
    questionClass: evaluationCase.questionClass,
    noData: needsEmptyOracle,
  });
  evaluationCase.grading = {
    ...evaluationCase.grading,
    oracleBlock,
  };
  const measure = measureById.get(oracleBlock.measureIds[0]!)!;
  const grouping = oracleBlock.dimensionIds
    .map((id) => dimensionById.get(id)?.label)
    .filter(Boolean)
    .join(" and ");
  const risk = evaluationCase.tags
    .find((tag) => tag.startsWith("risk:"))!
    .slice("risk:".length)
    .replaceAll("_", " ");
  if (needsEmptyOracle) {
    evaluationCase.ask = `Run the valid governed ${topic.label} query for ${measure.label} from 1 January 1900 through 31 January 1900${grouping ? ` by ${grouping}` : ""}. Return No data if the executed result is empty; do not call it Unavailable. Preserve ${risk} safeguards.`;
  } else {
    const comparisonKind = oracleBlock.comparison?.kind;
    const comparison = comparisonKind
      ? ` Compare it with ${
          comparisonKind === "prior_month"
            ? "the same dated span one month earlier"
            : comparisonKind === "prior_year"
              ? "the same dated span one year earlier"
              : "the immediately preceding equal-length period"
        }.`
      : "";
    evaluationCase.ask = `From 7 July 2026 through 7 August 2026, report ${measure.label} for ${topic.label}${grouping ? ` by ${grouping}` : ""}.${comparison} Use only the certified definition, preserve ${risk} safeguards, and cell-ground every number.`;
  }
}

for (const [questionClass, queue] of Object.entries(terminalQueues))
  if (queue.length)
    throw new Error(
      `Terminal allocation for ${questionClass} has ${queue.length} unused cases.`,
    );

const followUpPairs: Readonly<Record<Source, number>> = {
  lightspeed: 8,
  xero: 8,
  lightspeed_xero: 4,
};
for (const [source, pairCount] of Object.entries(followUpPairs) as [
  Source,
  number,
][]) {
  const candidates = cases
    .filter((evaluationCase) => evaluationCase.source === source)
    .slice(0, pairCount * 2);
  for (let pair = 0; pair < pairCount; pair += 1) {
    const first = candidates[pair * 2]!;
    const followUp = candidates[pair * 2 + 1]!;
    const thread = `v2_follow_up_${source}_${String(pair + 1).padStart(2, "0")}`;
    first.thread = thread;
    followUp.thread = thread;
    followUp.followUpOf = first.id;
    followUp.ask = `Building on the preceding governed result, ${followUp.ask.charAt(0).toLowerCase()}${followUp.ask.slice(1)}`;
  }
}

const duplicateQuestions = Object.entries(
  Object.groupBy(cases, ({ ask }) => ask),
).filter(([, grouped]) => (grouped?.length ?? 0) > 1);
if (duplicateQuestions.length)
  throw new Error(
    `Generated duplicate evaluation questions: ${duplicateQuestions
      .map(([, grouped]) => grouped!.map(({ id }) => id).join("/"))
      .join(", ")}. First duplicate: ${duplicateQuestions[0]![0]}`,
  );

assertV2EvaluationCorpus(cases);
const holdoutOutput = process.argv
  .find((value) => value.startsWith("--sealed-holdout-output="))
  ?.slice("--sealed-holdout-output=".length)
  .trim();
if (holdoutOutput) {
  if (!process.argv.includes("--write-sealed-holdout"))
    throw new Error(
      "Writing the sealed holdout requires --write-sealed-holdout.",
    );
  const absoluteHoldoutOutput = resolve(holdoutOutput);
  const repositoryRelative = relative(resolve("."), absoluteHoldoutOutput);
  if (!repositoryRelative.startsWith("..") || repositoryRelative === "")
    throw new Error("The sealed holdout must be written outside the repository.");
  writeFileSync(
    absoluteHoldoutOutput,
    `${JSON.stringify(
      cases.filter(({ visibility }) => visibility === "hidden"),
      null,
      2,
    )}\n`,
    { flag: "wx", mode: 0o600 },
  );
}
const publicBlueprint = cases.map((evaluationCase) =>
  evaluationCase.visibility === "hidden"
    ? { ...evaluationCase, ask: sealedV2HoldoutPrompt(evaluationCase.id) }
    : evaluationCase,
);
assertV2PublicEvaluationBlueprint(publicBlueprint);
writeFileSync(
  resolve("evals/v2-evaluation-corpus.json"),
  `${JSON.stringify(publicBlueprint, null, 2)}\n`,
);
process.stdout.write(
  "Generated the reviewed 200-case V2 allocation blueprint with 160 visible prompts and 40 sealed holdout placeholders.\n",
);
