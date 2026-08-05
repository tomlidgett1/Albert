import { resolve } from "node:path";

import { Decimal4 } from "../packages/canonical-schema/src/index.js";
import {
  compileSemanticQuery,
  parseSemanticQuery,
  type CompiledSemanticQuery,
  type SemanticQuery,
} from "../packages/compiler/src/index.js";
import {
  loadRegistryFile,
  type SemanticRegistry,
} from "../packages/semantic-registry/src/index.js";
import {
  compileSourceQuery,
  DefaultSemanticToolExecutor,
  MemorySemanticResultCache,
  semanticBundleHash,
  type DatabaseRow,
  type SemanticServiceDependencies,
  type SemanticToolResponse,
} from "../services/semantic-query/src/index.js";
import {
  evaluateFixtureComparison,
  evaluateFixtureQuery,
  type FixtureResultRow,
} from "./fixture-engine.js";
import {
  FIXTURE_NOW,
  FIXTURE_TENANT_ID,
  retailFixtureRows,
} from "./fixtures/retail.js";
import {
  FIXTURE_LIGHTSPEED_CONNECTION_ID,
  sourceFixtureCatalogue,
  sourceFixtureRows,
} from "./fixtures/source.js";
import {
  seedGoldenQuestions,
  type GoldenQuestion,
  type GoldenState,
} from "./golden/questions.js";
import { evaluateSourceFixtureQuery } from "./source-fixture-engine.js";
import { criticalPromptRouteContract } from "../services/conversation/src/prompt-routing.js";

export type GoldenCaseResult = Readonly<{
  id: string;
  route: GoldenQuestion["expectedRoute"];
  expectedState: GoldenState;
  outcome: "passed" | "executable_gap";
  rows?: readonly FixtureResultRow[];
  comparisonRows?: readonly FixtureResultRow[];
  bundleHash?: string;
  reason?: string;
}>;

export type GoldenSuiteResult = Readonly<{
  registryVersion: string;
  metricCount: number;
  topicCount: number;
  questionCount: number;
  executableCount: number;
  cases: readonly GoldenCaseResult[];
  executableGaps: readonly string[];
}>;

const trustedContext = {
  tenantId: FIXTURE_TENANT_ID,
  role: "owner" as const,
  conversationId: "01J00000000000000000000021",
  turnId: "01J00000000000000000000022",
};

export async function runSeedGoldenSuite(
  registryPath = resolve("packages/semantic-registry/registry/registry.yaml"),
): Promise<GoldenSuiteResult> {
  const registry = loadRegistryFile(registryPath);
  if (registry.metrics.size !== 47 || registry.topics.size !== 7) {
    throw new Error(
      `Golden runner requires the 47-contract/7-Topic registry; observed ${registry.metrics.size}/${registry.topics.size}.`,
    );
  }

  const cases: GoldenCaseResult[] = [];
  for (const question of seedGoldenQuestions) {
    cases.push(await runQuestion(question, registry));
  }
  return {
    registryVersion: registry.version,
    metricCount: registry.metrics.size,
    topicCount: registry.topics.size,
    questionCount: seedGoldenQuestions.length,
    executableCount: cases.filter((item) => item.outcome === "passed").length,
    cases,
    executableGaps: cases
      .filter((item) => item.outcome === "executable_gap")
      .map((item) => item.id),
  };
}

async function runQuestion(
  question: GoldenQuestion,
  registry: SemanticRegistry,
): Promise<GoldenCaseResult> {
  if (question.expectedRoute === "semantic") {
    if (!question.ir) {
      return {
        id: question.id,
        route: question.expectedRoute,
        expectedState: question.expectedState,
        outcome: "executable_gap",
        reason: question.rationale ?? "The governed semantic IR is not implemented.",
      };
    }
    return runSemanticQuestion(question, registry);
  }
  if (question.expectedRoute === "source_exploration") {
    if (!question.sourceQuery) throw new Error(`${question.id} is missing source-query IR.`);
    return runSourceQuestion(question, registry);
  }
  if (question.ir || question.sourceQuery || question.expectedRows) {
    throw new Error(`${question.id} must not execute data access for ${question.expectedRoute}.`);
  }
  return evaluateCriticalPromptRouteQuestion(question);
}

export function evaluateCriticalPromptRouteQuestion(
  question: GoldenQuestion,
): GoldenCaseResult {
  const contract = criticalPromptRouteContract(question.question);
  if (!contract) {
    throw new Error(`${question.id} prompt did not activate a trusted critical route contract.`);
  }
  if (contract.caseId !== question.id) {
    throw new Error(`${question.id} prompt activated substituted route contract ${contract.caseId}.`);
  }
  if (contract.route !== question.expectedRoute) {
    throw new Error(`${question.id} expected ${question.expectedRoute} but prompt routing produced ${contract.route}.`);
  }
  if (question.expectedState !== contract.route) {
    throw new Error(`${question.id} expected state ${question.expectedState} does not match route ${contract.route}.`);
  }
  return {
    id: question.id,
    route: question.expectedRoute,
    expectedState: question.expectedState,
    outcome: "passed",
    reason: contract.route === "clarification"
      ? `Prompt route requires ${contract.question} (${contract.optionIds.join(", ")}).`
      : `Prompt route requires Unavailable (${contract.reasonCode}).`,
  };
}

async function runSemanticQuestion(
  question: GoldenQuestion,
  registry: SemanticRegistry,
): Promise<GoldenCaseResult> {
  const ir = parseSemanticQuery(question.ir);
  const context = compilerContext(registry);
  const firstCompiled = compileSemanticQuery(ir, registry, context);
  const secondCompiled = compileSemanticQuery(ir, registry, context);
  assertEqual(firstCompiled, secondCompiled, `${question.id} compiler output is non-deterministic`);
  if (firstCompiled.parameters[0] !== FIXTURE_TENANT_ID) {
    throw new Error(`${question.id} did not bind trusted tenant scope as parameter one.`);
  }
  if (firstCompiled.sql.includes(FIXTURE_TENANT_ID)) {
    throw new Error(`${question.id} embedded trusted tenant scope in SQL text.`);
  }

  const rows = evaluateFixtureQuery(ir, registry, retailFixtureRows);
  assertExpectedRows(question.id, rows, question.expectedRows);
  const serviceRows = serviceRowsForCompiled(firstCompiled, ir, rows, registry);
  const response = await executeSemanticService(ir, serviceRows, question.expectedState, registry);
  if (response.state !== question.expectedState) {
    throw new Error(
      `${question.id} expected ${question.expectedState} but semantic service returned ${response.state}.`,
    );
  }
  assertExpectedRows(question.id, response.data?.rows as readonly FixtureResultRow[], question.expectedRows);

  const bundleSources = fixtureBundleSources(firstCompiled, registry);
  const expectedHash = semanticBundleHash({
    registryVersion: registry.version,
    overlayVersion: "fixture-overlay-v1",
    identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
    packVersions: bundleSources.packVersions,
    sourceWatermarks: bundleSources.sourceWatermarks,
    // The bundle identifies what the service actually compiled. Trusted keys
    // the agent cannot send are injected server-side, so hashing the raw seed
    // would pin a query no model can express.
    ir: parseSemanticQuery(asToolInput(question.ir)),
  });
  if (response.provenance.bundleHash !== expectedHash) {
    throw new Error(`${question.id} semantic bundle hash is not reproducible.`);
  }

  let comparisonRows: readonly FixtureResultRow[] | undefined;
  if (question.expectedComparisonRows) {
    if (question.comparisonIr) {
      const comparisonIr = parseSemanticQuery(question.comparisonIr);
      const comparisonCompiled = compileSemanticQuery(comparisonIr, registry, context);
      assertEqual(
        comparisonCompiled,
        compileSemanticQuery(comparisonIr, registry, context),
        `${question.id} comparison compiler output is non-deterministic`,
      );
      comparisonRows = evaluateFixtureQuery(comparisonIr, registry, retailFixtureRows);
    } else {
      comparisonRows = evaluateFixtureComparison(ir, registry, retailFixtureRows).prior;
    }
    assertExpectedRows(question.id, comparisonRows, question.expectedComparisonRows);
  }

  return {
    id: question.id,
    route: question.expectedRoute,
    expectedState: question.expectedState,
    outcome: "passed",
    rows,
    comparisonRows,
    bundleHash: response.provenance.bundleHash,
  };
}

function fixtureBundleSources(
  compiled: CompiledSemanticQuery,
  registry: SemanticRegistry,
): Readonly<{
  packVersions: Readonly<Record<string, string>>;
  sourceWatermarks: Readonly<Record<string, string>>;
}> {
  const authorities = new Set(compiled.validationEvidence.metrics.map((metric) => metric.authority));
  for (const dependencyId of compiled.validationEvidence.metrics.flatMap((metric) => metric.dependencyMetricIds)) {
    const authority = registry.metrics.get(dependencyId)?.authority;
    if (authority) authorities.add(authority);
  }
  const connectionIds = [...new Set([...authorities].flatMap((authority) => {
    const connectionId = fixtureAuthorityByConcept[authority as keyof typeof fixtureAuthorityByConcept];
    return connectionId ? [connectionId] : [];
  }))];
  const details = fixtureSourceDetails.filter((source) => connectionIds.includes(source.connectionId));
  return {
    packVersions: Object.fromEntries(details.map((source) => [
      source.connectorId,
      fixturePackVersions[source.connectorId as keyof typeof fixturePackVersions],
    ])),
    sourceWatermarks: Object.fromEntries(connectionIds.map((connectionId) => [
      connectionId,
      fixtureWatermarks[connectionId as keyof typeof fixtureWatermarks],
    ])),
  };
}

async function runSourceQuestion(
  question: GoldenQuestion,
  registry: SemanticRegistry,
): Promise<GoldenCaseResult> {
  const firstCompiled = compileSourceQuery(
    question.sourceQuery,
    FIXTURE_TENANT_ID,
    "owner",
    sourceFixtureCatalogue,
  );
  const secondCompiled = compileSourceQuery(
    question.sourceQuery,
    FIXTURE_TENANT_ID,
    "owner",
    sourceFixtureCatalogue,
  );
  assertEqual(firstCompiled, secondCompiled, `${question.id} source plan is non-deterministic`);
  if (firstCompiled.parameters[0] !== FIXTURE_TENANT_ID) {
    throw new Error(`${question.id} source query lost trusted tenant scope.`);
  }

  const rows = evaluateSourceFixtureQuery(question.sourceQuery, sourceFixtureRows);
  assertExpectedRows(question.id, rows, question.expectedRows);
  const service = createService(registry, rows, "passed");
  const response = await service.execute(
    "run_source_query",
    question.sourceQuery,
    trustedContext,
  );
  if (response.state !== "exploratory") {
    throw new Error(`${question.id} expected exploratory source state, got ${response.state}.`);
  }
  assertExpectedRows(question.id, response.data?.rows as readonly FixtureResultRow[], question.expectedRows);
  return {
    id: question.id,
    route: question.expectedRoute,
    expectedState: question.expectedState,
    outcome: "passed",
    rows,
    bundleHash: response.provenance.bundleHash,
  };
}

/** Drop the trusted-only keys the agent-facing tool schema does not accept. */
function asToolInput(ir: unknown): unknown {
  if (!ir || typeof ir !== "object" || Array.isArray(ir)) return ir;
  const { parameters: _trusted, queries, ...rest } = ir as Record<string, unknown>;
  void _trusted;
  return {
    ...rest,
    ...(Array.isArray(queries) ? { queries: queries.map((subquery) => asToolInput(subquery)) } : {}),
  };
}

async function executeSemanticService(
  ir: unknown,
  rows: readonly DatabaseRow[],
  expectedState: GoldenState,
  registry: SemanticRegistry,
): Promise<SemanticToolResponse> {
  const health = expectedState === "qualified" ? "warning" : "passed";
  const service = createService(registry, rows, health);
  // The agent-facing tool schema deliberately omits `parameters`: OpenAI strict
  // function tools reject an extra required key, so trusted code injects it.
  // Send what the model would actually send, or the seed never reaches the
  // compiler and the suite fails on schema shape instead of behaviour.
  const toolInput = asToolInput(ir);
  const first = await service.execute("run_semantic_query", toolInput, trustedContext);
  const second = await service.execute("run_semantic_query", toolInput, trustedContext);
  if (first.performance.cacheHit || !second.performance.cacheHit) {
    throw new Error("Semantic fixture service did not exercise deterministic bundle caching.");
  }
  if (first.provenance.bundleHash !== second.provenance.bundleHash) {
    throw new Error("Semantic fixture service produced unstable bundle hashes.");
  }
  return first;
}

function createService(
  registry: SemanticRegistry,
  rows: readonly DatabaseRow[],
  health: "passed" | "warning",
): DefaultSemanticToolExecutor {
  const dependencies: SemanticServiceDependencies = {
    registry,
    contextProvider: {
      async load() {
        return {
          timezone: "Australia/Melbourne",
          tradingDayCutoff: "00:00",
          fiscalYearStartMonth: 7,
          fiscalYearStartDay: 1,
          weekStartsOn: 1,
          tenantParameters: fixtureTenantParameters,
          capabilities: allCapabilities(registry),
          overlayVersion: "fixture-overlay-v1",
          identityGraphVersion: 0,
          identityGraphHash: "d41d8cd98f00b204e9800998ecf8427e",
          defaults: {},
          dossier: {},
          packVersions: fixturePackVersions,
          sourceWatermarks: fixtureWatermarks,
          sourceDetails: fixtureSourceDetails,
          authorityByConcept: fixtureAuthorityByConcept,
        };
      },
    },
    database: {
      async queryAsSemanticRole(request) {
        if (request.tenantId !== FIXTURE_TENANT_ID || request.parameters[0] !== FIXTURE_TENANT_ID) {
          throw new Error("Fixture semantic database received untrusted tenant scope.");
        }
        return { rows, durationMs: 1 };
      },
    },
    cache: new MemorySemanticResultCache(() => Date.parse(FIXTURE_NOW)),
    sourceCatalogue: {
      async listFields(_context, connectionId, sourceTable) {
        return sourceFixtureCatalogue.filter(
          (field) => field.connectionId === connectionId && field.sourceTable === sourceTable,
        );
      },
    },
    dataHealth: {
      async getForTopic() {
        return {
          status: health,
          checks: [{ checkId: "golden_fixture_match", status: health }],
        };
      },
    },
    audit: {
      async append() {},
      async promoteSourceField() { return "fixture-promotion"; },
    },
    publicationEvidence: {
      async inspect() {
        return {
          registryVersion: registry.version,
          registryHash: "f".repeat(64),
          activePublicationMatches: true,
        };
      },
    },
    clock: () => new Date(FIXTURE_NOW),
  };
  return new DefaultSemanticToolExecutor(dependencies);
}

function compilerContext(registry: SemanticRegistry) {
  return {
    tenantId: FIXTURE_TENANT_ID,
    role: "owner" as const,
    capabilities: allCapabilities(registry),
    now: FIXTURE_NOW,
    timezone: "Australia/Melbourne",
    tradingDayCutoff: "00:00",
    fiscalYearStartMonth: 7,
    fiscalYearStartDay: 1,
    weekStartsOn: 1,
    tenantParameters: fixtureTenantParameters,
    maxRows: 1000,
    maxEstimatedCost: 100,
  };
}

function allCapabilities(registry: SemanticRegistry): ReadonlySet<string> {
  return new Set(
    [
      ...[...registry.metrics.values()].flatMap((metric) => metric.requiredCapabilities),
      ...[...registry.topics.values()].flatMap((topic) => topic.requiredCapabilities),
    ].filter((capability) => capability !== "workforce.time_entries.overtime"),
  );
}

function assertExpectedRows(
  id: string,
  actual: readonly Readonly<Record<string, unknown>>[] | undefined,
  expected: readonly Readonly<Record<string, string>>[] | undefined,
): void {
  if (!expected) return;
  const projected = actual?.map((row, index) => Object.fromEntries(
    Object.keys(expected[index] ?? {}).map((key) => [key, row[key]]),
  ));
  assertEqual(projected, expected, `${id} numeric fixture result changed`);
}

function serviceRowsForCompiled(
  compiled: CompiledSemanticQuery,
  ir: SemanticQuery,
  currentRows: readonly FixtureResultRow[],
  registry: SemanticRegistry,
): readonly Readonly<Record<string, unknown>>[] {
  if (ir.kind !== "single" || ir.time.compare === "none") return currentRows;
  const comparison = evaluateFixtureComparison(ir, registry, retailFixtureRows);
  const priorByKey = new Map(
    comparison.prior.map((row) => [dimensionKey(row, ir.dimensions), row]),
  );
  return comparison.current.map((current) => {
    const prior = priorByKey.get(dimensionKey(current, ir.dimensions)) ?? {};
    const output: Record<string, unknown> = Object.fromEntries(
      ir.dimensions.map((dimension) => [dimension, current[dimension] ?? prior[dimension] ?? ""]),
    );
    for (const metricId of compiled.metricIds) {
      const alias = metricId.slice(metricId.indexOf(".") + 1);
      const currentValue = Decimal4.from(current[alias] ?? "0");
      const priorValue = Decimal4.from(prior[alias] ?? "0");
      const change = currentValue.subtract(priorValue);
      output[alias] = currentValue.toString();
      output[`${alias}__comparison`] = priorValue.toString();
      output[`${alias}__change`] = change.toString();
      output[`${alias}__change_pct`] = priorValue.equals("0")
        ? null
        : change.multiply("100").divide(priorValue).toString();
    }
    return output;
  });
}

function dimensionKey(
  row: Readonly<Record<string, unknown>>,
  dimensions: readonly string[],
): string {
  return JSON.stringify(dimensions.map((dimension) => row[dimension] ?? null));
}

function assertEqual(left: unknown, right: unknown, message: string): void {
  const leftValue = stableStringify(left);
  const rightValue = stableStringify(right);
  if (leftValue !== rightValue) {
    throw new Error(`${message}.\nExpected: ${rightValue}\nActual:   ${leftValue}`);
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const fixturePackVersions = {
  "lightspeed-r": "1.1.0",
  xero: "1.0.0",
  deputy: "1.0.0",
} as const;

const FIXTURE_XERO_CONNECTION_ID = "01J00000000000000000000012";
const FIXTURE_DEPUTY_CONNECTION_ID = "01J00000000000000000000013";

const fixtureWatermarks = {
  [FIXTURE_LIGHTSPEED_CONNECTION_ID]: "2026-03-15T11:00:00.000Z",
  [FIXTURE_XERO_CONNECTION_ID]: "2026-03-15T10:30:00.000Z",
  [FIXTURE_DEPUTY_CONNECTION_ID]: "2026-03-15T11:30:00.000Z",
} as const;

const fixtureSourceDetails = [
  { connectorId: "lightspeed-r", connectionId: FIXTURE_LIGHTSPEED_CONNECTION_ID, label: "Lightspeed", dataThrough: fixtureWatermarks[FIXTURE_LIGHTSPEED_CONNECTION_ID] },
  { connectorId: "xero", connectionId: FIXTURE_XERO_CONNECTION_ID, label: "Xero", dataThrough: fixtureWatermarks[FIXTURE_XERO_CONNECTION_ID] },
  { connectorId: "deputy", connectionId: FIXTURE_DEPUTY_CONNECTION_ID, label: "Deputy", dataThrough: fixtureWatermarks[FIXTURE_DEPUTY_CONNECTION_ID] },
] as const;

const fixtureAuthorityByConcept = {
  operational_sales: FIXTURE_LIGHTSPEED_CONNECTION_ID,
  product_master: FIXTURE_LIGHTSPEED_CONNECTION_ID,
  customer_master: FIXTURE_LIGHTSPEED_CONNECTION_ID,
  stock: FIXTURE_LIGHTSPEED_CONNECTION_ID,
  statutory_finance: FIXTURE_XERO_CONNECTION_ID,
  cash_settlement: FIXTURE_XERO_CONNECTION_ID,
  planned_shifts: FIXTURE_DEPUTY_CONNECTION_ID,
  worked_hours: FIXTURE_DEPUTY_CONNECTION_ID,
} as const;

const fixtureTenantParameters = {
  active_customer_days: 90,
  lapsed_customer_days: 180,
  stock_velocity_days: 30,
} as const;
