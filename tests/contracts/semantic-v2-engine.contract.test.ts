import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  applyWorkspacePatchV2,
  createInvestigationPlanV2,
  executeCompiledWorkspaceV2,
  evidenceReferenceV2Schema,
  findUngroundedClaimNumbersV2,
  groundedClaimV2Schema,
  investigationPlanV2Schema,
  queryWorkspaceV2Schema,
  resolveOperatorOutputPathV2,
  runAnalyticalOperatorV2,
  semanticClaimEvidenceDigestV2,
  semanticFilterV2Schema,
  semanticInsightKeyV2,
  unchangedInsightClaimIdsV2,
  validateClaimEvidenceV2,
  validateRecommendationOperatorEvidenceV2,
  validateWorkspaceAgainstRegistryV2,
  WorkspaceConflictError,
  WorkspaceValidationError,
  type QueryWorkspaceV2,
} from "../../packages/analytics-v2/src/index.js";
import {
  compileQueryWorkspaceV2,
  SEMANTIC_COMPILER_CONTRACT_VERSION_V2,
  SemanticCompilerV2Error,
  SOURCE_ROW_COUNT_COLUMN_V2,
} from "../../packages/compiler/src/v2.js";
import {
  semanticRegistryDocumentV2Schema,
  semanticRegistryV2Digest,
  type SemanticRegistryDocumentV2,
} from "../../packages/semantic-registry/src/v2.js";

const registry = semanticRegistryDocumentV2Schema.parse(
  JSON.parse(
    readFileSync(
      "packages/semantic-registry/registry/registry.v2.json",
      "utf8",
    ),
  ),
);
const publicationHash = semanticRegistryV2Digest(registry);
const tenantId = "01K30000000000000000000001";
const now = "2026-08-10T00:00:00.000Z";

function salesWorkspace(
  overrides: Partial<QueryWorkspaceV2["blocks"][number]> = {},
): QueryWorkspaceV2 {
  return queryWorkspaceV2Schema.parse({
    id: "01K30000000000000000000002",
    tenantId,
    publicationHash,
    overlayVersion: "overlay-v1",
    revision: 1,
    questionId: "01K30000000000000000000003",
    blocks: [
      {
        id: "sales",
        topicIds: ["business.sales_performance"],
        rootViewId: "commerce_sales_event",
        dimensionIds: [
          "commerce_sales_event.location",
          "commerce_sales_event.currency",
        ],
        measureIds: ["commerce.net_sales_ex_gst"],
        filters: [],
        time: {
          dimensionId: "commerce_sales_event.business_date",
          range: { type: "last_complete_month" },
        },
        sort: [],
        limit: 100,
        parameters: {},
        ...overrides,
      },
    ],
    status: "draft",
    createdAt: now,
    updatedAt: now,
  });
}

function compile(
  workspace: QueryWorkspaceV2,
  document: SemanticRegistryDocumentV2 = registry,
) {
  return compileQueryWorkspaceV2(
    { ...workspace, publicationHash: semanticRegistryV2Digest(document) },
    document,
    {
      tenantId,
      now,
      timezone: "Australia/Melbourne",
      connectionSet: ["01K30000000000000000000004"],
    },
  );
}

test("the generated business registry compiles deterministic tenant-bound SQL", () => {
  assert.equal(SEMANTIC_COMPILER_CONTRACT_VERSION_V2, 2);
  const sourceById = new Map(
    registry.sourceObjects.map((source) => [source.id, source]),
  );
  const sensitiveDimensions = registry.dimensions.filter((dimension) => {
    const view = registry.views.find(({ id }) => id === dimension.viewId);
    const field = view?.sourceObjectId
      ? sourceById
          .get(view.sourceObjectId)
          ?.fields.find(({ id }) => id === dimension.fieldId)
      : undefined;
    return field?.pii || field?.disposition === "sensitive_metadata";
  });
  assert.deepEqual(
    sensitiveDimensions,
    [],
    "sensitive source fields must remain inventoried but never become queryable dimensions",
  );
  const first = compile(salesWorkspace());
  const second = compile(salesWorkspace());
  assert.equal(first.normalizedPlanHash, second.normalizedPlanHash);
  assert.equal(first.queries.length, 1);
  assert.equal(first.queries[0]?.sql, second.queries[0]?.sql);
  assert.deepEqual(first.queries[0]?.parameters, second.queries[0]?.parameters);
  assert.equal(first.queries[0]?.parameters[0], tenantId);
  assert.match(first.queries[0]?.sql ?? "", /^with "tenant_scope"/u);
  assert.match(
    first.queries[0]?.sql ?? "",
    /from "mart"\."commerce_sales_event"/u,
  );
  assert.doesNotMatch(first.queries[0]?.sql ?? "", /;|--|\/\*/u);
  assert.deepEqual(first.queries[0]?.validationEvidence, {
    tenantInjected: true,
    independentlyAggregated: true,
    joinPathUnique: true,
    fanoutSafe: true,
    parameterized: true,
    snapshotMode: "none",
  });
});

test("Topic defaults are mandatory and contains filters escape SQL wildcards", () => {
  const document = structuredClone(registry);
  const topic = document.topics.find(
    ({ id }) => id === "business.sales_performance",
  )!;
  topic.defaultFilters = [
    { fieldId: "commerce_sales_event.channel", op: "eq", values: ["retail"] },
  ];
  const compiled = compile(
    salesWorkspace({
      filters: [
        {
          fieldId: "commerce_sales_event.channel",
          op: "contains",
          values: ["100%_safe"],
        },
      ],
    }),
    document,
  );
  const parameters = compiled.queries[0]?.parameters ?? [];
  assert.ok(
    parameters.includes("retail"),
    "the server-owned Topic default must be bound",
  );
  assert.ok(
    parameters.includes("%100\\%\\_safe%"),
    "contains must treat %, _ and backslash as literal text",
  );
  assert.match(compiled.queries[0]?.sql ?? "", /escape '\\'/u);
  assert.throws(
    () => semanticFilterV2Schema.parse({ fieldId: "x", op: "eq", values: [] }),
    /exactly one value/iu,
  );
  assert.throws(
    () => semanticFilterV2Schema.parse({ fieldId: "x", op: "in", values: [] }),
    /at least one value/iu,
  );
  assert.throws(
    () =>
      semanticFilterV2Schema.parse({
        fieldId: "x",
        op: "is_null",
        values: [null],
      }),
    /does not accept values/iu,
  );
});

test("workspace validation rejects unexposed filters and non-time dimensions", () => {
  const unexposed = salesWorkspace({
    filters: [
      {
        fieldId: "finance_day_location.location",
        op: "eq",
        values: ["shop-1"],
      },
    ],
  });
  assert.match(
    validateWorkspaceAgainstRegistryV2(unexposed, registry).join(" "),
    /not exposed by a selected Topic/iu,
  );
  const notTime = salesWorkspace({
    time: {
      dimensionId: "commerce_sales_event.channel",
      range: { type: "last_complete_month" },
    },
  });
  assert.match(
    validateWorkspaceAgainstRegistryV2(notTime, registry).join(" "),
    /not a governed time role/iu,
  );
  const unsafeShape = salesWorkspace({
    sort: [
      {
        fieldId: "commerce_sales_event.channel",
        direction: "asc",
        nulls: "last",
      },
    ],
    parameters: { ignored: true },
    comparison: { kind: "custom" },
  });
  const shapeIssues = validateWorkspaceAgainstRegistryV2(
    unsafeShape,
    registry,
  ).join(" ");
  assert.match(shapeIssues, /sort .* is not selected/iu);
  assert.match(shapeIssues, /parameters are not executable/iu);
  assert.match(shapeIssues, /custom comparisons require a custom range/iu);
});

test("compiler rejects a registry artifact that does not match the pinned publication", () => {
  assert.throws(
    () =>
      compileQueryWorkspaceV2(
        { ...salesWorkspace(), publicationHash: "a".repeat(64) },
        registry,
        {
          tenantId,
          now,
          timezone: "Australia/Melbourne",
          connectionSet: ["01K30000000000000000000004"],
        },
      ),
    (error: unknown) =>
      error instanceof SemanticCompilerV2Error &&
      error.code === "INVALID_WORKSPACE" &&
      /publication hash does not match/iu.test(error.message),
  );
});

test("composite Topics aggregate each fact independently and align only after aggregation", () => {
  const workspace = salesWorkspace({
    topicIds: ["composite.trading_profitability"],
    dimensionIds: [
      "commerce_sales_event.business_date",
      "commerce_sales_event.currency",
    ],
    measureIds: ["commerce.net_sales_ex_gst", "finance.operating_expenses"],
  });
  const compiled = compile(workspace);
  assert.equal(compiled.queries.length, 2);
  assert.equal(compiled.alignments[0]?.mode, "aggregate_then_align");
  assert.deepEqual(
    new Set(
      compiled.queries.map(({ normalizedPlan }) => normalizedPlan.factViewId),
    ),
    new Set(["commerce_sales_event", "finance_day_location"]),
  );
  assert.ok(
    compiled.queries.every(
      ({ normalizedPlan }) => normalizedPlan.joins.length === 0,
    ),
  );
  assert.ok(
    compiled.queries.every(
      ({ normalizedPlan }) =>
        normalizedPlan.dimensionIds[0] === "commerce_sales_event.business_date",
    ),
  );
});

test("multi-query workspaces require one repeatable-read execution batch", async () => {
  const workspace = salesWorkspace({
    topicIds: ["composite.trading_profitability"],
    dimensionIds: [
      "commerce_sales_event.business_date",
      "commerce_sales_event.currency",
    ],
    measureIds: ["commerce.net_sales_ex_gst", "finance.operating_expenses"],
  });
  const compiled = compile(workspace);
  let batchCalls = 0;
  const database = {
    async queryAsSemanticRole(request: Readonly<{ sql: string }>) {
      assert.match(request.sql, /^EXPLAIN \(FORMAT JSON\)/u);
      return {
        rows: [{ "QUERY PLAN": [{ Plan: { "Total Cost": 12 } }] }],
        durationMs: 1,
      };
    },
    async queryBatchAsSemanticRole(
      request: Readonly<{ statements: readonly Readonly<{ sql: string }>[] }>,
    ) {
      batchCalls += 1;
      assert.equal(request.statements.length, 2);
      return compiled.queries.map((query) => ({
        rows: [
          {
            "commerce_sales_event.business_date": "2026-07-01",
            [query.normalizedPlan.measureIds[0]!]: "100",
          },
        ],
        durationMs: 2,
      }));
    },
  };
  const context = {
    tenantId,
    workspaceId: workspace.id,
    conversationId: "01K30000000000000000000005",
    turnId: workspace.questionId,
    statementTimeoutMs: 30_000,
    maxPostgresCost: 50_000,
    sourceWatermarks: { source: now },
    cacheKey: "b".repeat(64),
  };
  const execution = await executeCompiledWorkspaceV2(
    compiled,
    database,
    context,
  );
  assert.equal(batchCalls, 1);
  assert.equal(execution.blocks[0]?.currentRows.length, 1);
  assert.equal(
    execution.blocks[0]?.currentRows[0]?.["commerce.net_sales_ex_gst"],
    "100",
  );
  assert.equal(
    execution.blocks[0]?.currentRows[0]?.["finance.operating_expenses"],
    "100",
  );
  await assert.rejects(
    () =>
      executeCompiledWorkspaceV2(
        compiled,
        { queryAsSemanticRole: database.queryAsSemanticRole },
        context,
      ),
    /shared repeatable-read snapshot/iu,
  );
});

test("zero-row aggregate sentinels become No data and never enter governed results", async () => {
  const workspace = salesWorkspace({
    dimensionIds: [],
    measureIds: ["commerce.transactions"],
  });
  const compiled = compile(workspace);
  assert.match(
    compiled.queries[0]?.sql ?? "",
    /count\(\*\)::bigint as "__albert_source_row_count"/u,
  );
  const execute = async (sourceRowCount: string) =>
    executeCompiledWorkspaceV2(
      compiled,
      {
        async queryAsSemanticRole(request) {
          if (request.sql.startsWith("EXPLAIN"))
            return {
              rows: [{ "QUERY PLAN": [{ Plan: { "Total Cost": 1 } }] }],
              durationMs: 1,
            };
          return {
            rows: [
              {
                "commerce.transactions": "0",
                [SOURCE_ROW_COUNT_COLUMN_V2]: sourceRowCount,
              },
            ],
            durationMs: 1,
          };
        },
      },
      {
        tenantId,
        workspaceId: workspace.id,
        conversationId: "01K30000000000000000000005",
        turnId: workspace.questionId,
        statementTimeoutMs: 30_000,
        maxPostgresCost: 50_000,
        sourceWatermarks: {},
        cacheKey: "c".repeat(64),
      },
    );
  const empty = await execute("0");
  assert.equal(empty.terminalState, "no_data");
  assert.deepEqual(empty.queries[0]?.rows, []);
  assert.equal(empty.queries[0]?.evidence.rowCount, 0);
  const zeroValue = await execute("3");
  assert.equal(zeroValue.terminalState, "verified");
  assert.deepEqual(zeroValue.queries[0]?.rows, [
    { "commerce.transactions": "0" },
  ]);
  assert.equal(
    SOURCE_ROW_COUNT_COLUMN_V2 in (zeroValue.queries[0]?.rows[0] ?? {}),
    false,
  );
});

function registryWithCrossFactRelationships(
  cardinalities: readonly ("many_to_one" | "one_to_many")[],
): SemanticRegistryDocumentV2 {
  const document = structuredClone(registry);
  const topic = document.topics.find(
    ({ id }) => id === "business.sales_performance",
  )!;
  topic.viewIds.push("finance_day_location");
  topic.dimensionIds.push("finance_day_location.location");
  cardinalities.forEach((cardinality, index) => {
    const id = `test.cross_fact_${index + 1}`;
    document.relationships.push({
      id,
      fromViewId: "commerce_sales_event",
      toViewId: "finance_day_location",
      fromFieldId: "location_id",
      toFieldId: "location_id",
      cardinality,
      optional: true,
      supportedDirections: ["from_to"],
      temporalBehavior: "not_applicable",
      semanticState: "exploratory",
      evidence: ["synthetic adversarial fixture"],
    });
    topic.relationshipIds.push(id);
  });
  return document;
}

test("the compiler rejects fan-out and ambiguous join paths instead of guessing", () => {
  const workspace = salesWorkspace({
    dimensionIds: [
      "finance_day_location.location",
      "commerce_sales_event.currency",
    ],
  });
  assert.throws(
    () =>
      compile(workspace, registryWithCrossFactRelationships(["one_to_many"])),
    (error: unknown) =>
      error instanceof SemanticCompilerV2Error &&
      error.code === "UNSAFE_FANOUT",
  );
  assert.throws(
    () =>
      compile(
        workspace,
        registryWithCrossFactRelationships(["many_to_one", "many_to_one"]),
      ),
    (error: unknown) =>
      error instanceof SemanticCompilerV2Error &&
      error.code === "AMBIGUOUS_JOIN_PATH",
  );
});

test("workspace revisions are optimistic, immutable after execution, and preserve follow-up lineage", () => {
  const workspace = salesWorkspace();
  const patched = applyWorkspacePatchV2(
    workspace,
    {
      expectedRevision: 1,
      operations: [{ op: "set_limit", blockId: "sales", limit: 25 }],
    },
    "2026-08-10T00:00:01.000Z",
  );
  assert.equal(patched.revision, 2);
  assert.equal(patched.blocks[0]?.limit, 25);
  assert.throws(
    () =>
      applyWorkspacePatchV2(patched, {
        expectedRevision: 1,
        operations: [{ op: "set_limit", blockId: "sales", limit: 10 }],
      }),
    WorkspaceConflictError,
  );
  assert.throws(
    () =>
      applyWorkspacePatchV2(
        { ...patched, status: "executed" },
        {
          expectedRevision: 2,
          operations: [{ op: "set_limit", blockId: "sales", limit: 10 }],
        },
      ),
    WorkspaceValidationError,
  );
});

test("investigations require a real acyclic evidence DAG and resolved sufficiency", () => {
  assert.throws(
    () =>
      createInvestigationPlanV2({
        id: "diagnosis",
        objective: "Explain the decline",
        questionClass: "diagnosis",
        definitionsToResolve: [],
        hypotheses: [],
        evidenceNodes: [
          {
            id: "e1",
            question: "What changed?",
            status: "pending",
            resultRefs: [],
          },
        ],
        dependencies: [],
        stopConditions: ["objective_satisfied"],
        status: "draft",
      }),
    /at least two competing hypotheses/iu,
  );

  const base = {
    id: "cycle",
    objective: "Compare periods",
    questionClass: "comparison" as const,
    definitionsToResolve: [],
    hypotheses: [],
    evidenceNodes: [
      {
        id: "e1",
        question: "First",
        status: "pending" as const,
        resultRefs: [],
      },
      {
        id: "e2",
        question: "Second",
        status: "pending" as const,
        resultRefs: [],
      },
    ],
    dependencies: [
      { fromEvidenceNodeId: "e1", toEvidenceNodeId: "e2" },
      { fromEvidenceNodeId: "e2", toEvidenceNodeId: "e1" },
    ],
    queryBudget: { maxRounds: 1, maxQueries: 2, maxDurationMs: 20_000 },
    stopConditions: ["objective_satisfied" as const],
    status: "draft" as const,
    roundsUsed: 0,
    queriesUsed: 0,
  };
  assert.throws(() => investigationPlanV2Schema.parse(base), /acyclic DAG/iu);
  assert.throws(
    () =>
      investigationPlanV2Schema.parse({
        ...base,
        dependencies: [],
        status: "sufficient",
      }),
    /every evidence node to be terminal/iu,
  );
  assert.throws(
    () =>
      investigationPlanV2Schema.parse({
        ...base,
        dependencies: [],
        status: "sufficient",
        evidenceNodes: base.evidenceNodes.map((node) => ({
          ...node,
          status: "failed" as const,
        })),
      }),
    /at least one successfully grounded evidence node/iu,
  );
  assert.throws(
    () =>
      createInvestigationPlanV2({
        id: "unsupported-hypothesis",
        objective: "Diagnose the margin decline",
        questionClass: "diagnosis",
        definitionsToResolve: [],
        hypotheses: [
          {
            id: "price",
            proposition: "Price declined.",
            evidenceNodeIds: ["price-evidence"],
            status: "supported",
          },
          {
            id: "mix",
            proposition: "Mix deteriorated.",
            evidenceNodeIds: ["mix-evidence"],
            status: "untested",
          },
        ],
        evidenceNodes: [
          {
            id: "price-evidence",
            question: "Measure the price effect.",
            status: "pending",
            resultRefs: [],
          },
          {
            id: "mix-evidence",
            question: "Measure the mix effect.",
            status: "pending",
            resultRefs: [],
          },
        ],
        dependencies: [],
        stopConditions: ["objective_satisfied"],
        status: "draft",
      }),
    /without successful referenced evidence/iu,
  );
  assert.throws(
    () =>
      investigationPlanV2Schema.parse({
        ...base,
        dependencies: [],
        evidenceNodes: [
          {
            ...base.evidenceNodes[0],
            status: "succeeded",
            resultRefs: [],
          },
          base.evidenceNodes[1],
        ],
      }),
    /requires persisted result or operator evidence/iu,
  );
});

test("deterministic operators preserve undefined zero-denominator results", () => {
  const contribution = runAnalyticalOperatorV2(
    {
      operatorId: "period_contribution",
      current: [{ key: "a", label: "A", value: "10" }],
      comparison: [{ key: "a", label: "A", value: "10" }],
    },
    ["execution:result"],
  );
  const contributions = contribution.output.contributions as readonly Readonly<
    Record<string, unknown>
  >[];
  assert.equal(contributions[0]?.shareOfChange, null);
  assert.match(
    contribution.limitations.join(" "),
    /undefined because total change is zero/iu,
  );

  const returns = runAnalyticalOperatorV2(
    {
      operatorId: "return_rate",
      grossSales: "0",
      returnValue: "0",
      soldUnits: "0",
      returnedUnits: "0",
    },
    ["execution:returns"],
  );
  assert.equal(returns.output.valueReturnRate, null);
  assert.equal(returns.output.unitReturnRate, null);
  assert.match(returns.limitations.join(" "), /undefined/iu);

  const bridge = runAnalyticalOperatorV2(
    {
      operatorId: "gross_margin_bridge",
      currentRevenue: "100",
      comparisonRevenue: "80",
      currentCost: "60",
      comparisonCost: "50",
    },
    ["execution:margin"],
  );
  assert.deepEqual(
    {
      current: bridge.output.currentGrossProfit,
      comparison: bridge.output.comparisonGrossProfit,
      change: bridge.output.totalChange,
    },
    { current: "40", comparison: "30", change: "10" },
  );
});

test("claim figures must be grounded by that claim's exact cited evidence", () => {
  assert.deepEqual(
    findUngroundedClaimNumbersV2("Net sales were $123.46.", [123.456]),
    [],
  );
  assert.deepEqual(
    findUngroundedClaimNumbersV2("Margin was 25%.", [{ marginRate: 0.25 }]),
    [],
  );
  assert.deepEqual(
    findUngroundedClaimNumbersV2("Net sales were $999.", [123.456]),
    ["$999"],
  );
  assert.deepEqual(
    findUngroundedClaimNumbersV2("1. Net sales were $123.46.", [123.456]),
    [],
  );
  assert.deepEqual(
    validateClaimEvidenceV2(
      {
        id: "operator-claim",
        text: "Sales increased.",
        type: "comparative",
        evidenceRefs: [
          {
            executionId: "execution",
            resultId: "result",
            operatorArtifactId: "operator",
            operatorOutputPath: ["totalChange"],
            publicationHash: "a".repeat(64),
          },
        ],
        semanticState: "verified",
        limitations: [],
        competingHypothesisRefs: [],
      },
      [
        {
          executionId: "execution",
          resultId: "result",
          state: "verified",
          rowCount: 1,
          validationPassed: true,
          publicationHash: "a".repeat(64),
          limitations: [],
        },
      ],
    ),
    ["Claim operator-claim is operator-derived and cannot be Verified."],
  );
});

test("operator claims resolve one exact output path and recommendations require positive sizing", () => {
  assert.throws(
    () =>
      evidenceReferenceV2Schema.parse({
        executionId: "execution",
        resultId: "result",
        operatorArtifactId: "operator",
        publicationHash: "a".repeat(64),
      }),
    /operatorOutputPath/iu,
  );
  assert.deepEqual(
    resolveOperatorOutputPathV2(
      { opportunities: [{ netOpportunity: "125.5" }] },
      ["opportunities", 0, "netOpportunity"],
    ),
    { found: true, value: "125.5" },
  );
  assert.deepEqual(
    resolveOperatorOutputPathV2(
      { opportunities: [{ netOpportunity: "125.5" }] },
      ["opportunities", 1, "netOpportunity"],
    ),
    { found: false },
  );
  assert.throws(
    () =>
      groundedClaimV2Schema.parse({
        id: "recommendation",
        text: "Do not pursue this action.",
        type: "recommendation",
        evidenceRefs: [
          {
            executionId: "execution",
            resultId: "result",
            operatorArtifactId: "operator",
            operatorOutputPath: ["netOpportunity"],
            publicationHash: "a".repeat(64),
          },
        ],
        semanticState: "derived",
        limitations: ["Fixture limitation."],
        controllability: "high",
        competingHypothesisRefs: [],
        opportunityValue: "0",
      }),
    /must be positive/iu,
  );
  const recommendation = groundedClaimV2Schema.parse({
    id: "recommendation",
    text: "Pursue the $125.50 opportunity.",
    type: "recommendation",
    evidenceRefs: [
      {
        executionId: "execution",
        resultId: "sizing",
        operatorArtifactId: "sizing-operator",
        operatorOutputPath: ["opportunities", 0, "netOpportunity"],
        publicationHash: "a".repeat(64),
      },
      {
        executionId: "execution",
        resultId: "constraints",
        operatorArtifactId: "constraint-operator",
        operatorOutputPath: ["opportunities", 0, "controllability"],
        publicationHash: "a".repeat(64),
      },
    ],
    semanticState: "derived",
    limitations: ["Attainable improvement remains an assumption."],
    controllability: "high",
    competingHypothesisRefs: [],
    opportunityValue: "125.5",
  });
  assert.deepEqual(
    validateRecommendationOperatorEvidenceV2(recommendation, [
      {
        operatorId: "opportunity_sizing",
        path: ["opportunities", 0, "netOpportunity"],
        value: "125.5",
      },
      {
        operatorId: "constraint_controllability",
        path: ["opportunities", 0, "controllability"],
        value: "high",
      },
    ]),
    [],
  );
  assert.deepEqual(
    validateRecommendationOperatorEvidenceV2(recommendation, [
      {
        operatorId: "opportunity_sizing",
        path: ["opportunities", 0, "baseline"],
        value: "125.5",
      },
      {
        operatorId: "constraint_controllability",
        path: ["opportunities", 0, "actionableValue"],
        value: "high",
      },
    ]).length,
    2,
  );
  const governedEvidence = [
    {
      kind: "operator",
      resultId: "sizing",
      artifactHash: "b".repeat(64),
      operatorOutputPath: ["opportunities", 0, "netOpportunity"],
      value: "125.5",
    },
  ];
  const prior = [
    {
      insightKey: semanticInsightKeyV2(recommendation),
      evidenceDigest: semanticClaimEvidenceDigestV2(governedEvidence),
    },
  ];
  assert.deepEqual(
    [
      ...unchangedInsightClaimIdsV2(
        "open_exploration",
        [{ claim: recommendation, governedEvidence }],
        prior,
      ),
    ],
    ["recommendation"],
  );
  assert.deepEqual(
    [
      ...unchangedInsightClaimIdsV2(
        "lookup",
        [{ claim: recommendation, governedEvidence }],
        prior,
      ),
    ],
    [],
  );
});
