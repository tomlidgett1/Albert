import { z } from "zod";
import {
  parseSemanticQuery,
  queryFilterSchema,
  singleSemanticQuerySchema,
  compositeSemanticQuerySchema,
  sortSchema,
  timeSelectionSchema,
  type SemanticQuery,
} from "../../compiler/src/index.js";
import type {
  TraceCell,
  TraceProvenance,
  TraceTableColumn,
} from "../../shared/src/index.js";

/** Tools that cross the signed semantic-service boundary. */
export const REMOTE_SEMANTIC_AGENT_TOOL_NAMES = [
  "search_catalogue",
  "get_definition",
  "get_capabilities",
  "list_field_values",
  "run_semantic_query",
  "run_source_query",
  "run_sql",
  "run_exploratory_sql",
  "get_data_health",
  "remember",
] as const;
export type RemoteSemanticAgentToolName = (typeof REMOTE_SEMANTIC_AGENT_TOOL_NAMES)[number];

/** Local presentation/interaction tools are never sent to the query service. */
export const LOCAL_SEMANTIC_AGENT_TOOL_NAMES = [
  "ask_user",
  "publish_observation",
  "make_chart",
  "resolve_named_entity",
  "open_dimension_guide",
  "update_analysis_plan",
  "search_schema",
  "describe_tables",
] as const;

export const SEMANTIC_AGENT_TOOL_NAMES = [
  ...REMOTE_SEMANTIC_AGENT_TOOL_NAMES,
  ...LOCAL_SEMANTIC_AGENT_TOOL_NAMES,
] as const;
export type SemanticAgentToolName = (typeof SEMANTIC_AGENT_TOOL_NAMES)[number];

/**
 * Clarification choices that may become durable tenant preferences. The model
 * chooses only an opaque option id; trusted application code resolves the
 * canonical label/key/value, and the database enforces the same vocabulary.
 */
export const ALBERT_PREFERENCE_OPTION_IDS = [
  "sales.net_ex_gst",
  "sales.gross_inc_gst",
  "employee.net_sales",
  "employee.gross_margin",
  "employee.gross_profit_per_labour_hour",
  "reconciliation.daily_summary",
  "reconciliation.individual_transactions",
  "reconciliation.unknown",
  "finance.operational_gross_margin",
  "finance.accounting_gross_profit",
  "finance.accounting_net_profit",
  "calendar.financial_year",
  "calendar.calendar_year",
] as const;
export type AlbertPreferenceOptionId = (typeof ALBERT_PREFERENCE_OPTION_IDS)[number];

export type AlbertPreferenceOption = Readonly<{
  id: AlbertPreferenceOptionId;
  label: string;
  preference: string;
  value: string;
}>;

/**
 * The model may choose only a non-quantitative, server-owned continuation.
 * This prevents an interstitial narrative from smuggling an ungrounded figure
 * into otherwise validated analytical evidence.
 */
export const OBSERVATION_NEXT_STEP_IDS = [
  "compare_period",
  "break_down_by_location",
  "break_down_by_product",
  "check_margin",
  "check_labour",
  "check_finance",
  "inspect_exception",
  "visualise_result",
  "prepare_answer",
] as const;
export type ObservationNextStepId = (typeof OBSERVATION_NEXT_STEP_IDS)[number];

export const claimAssertionSchema = z.enum([
  "value",
  "highest",
  "lowest",
  "greater_than",
  "less_than",
  "equal",
]);

export const claimCellReferenceSchema = z.object({
  resultId: z.string().min(1).max(200),
  rowIndex: z.number().int().min(0).max(100_000),
  columnKey: z.string().regex(/^[a-z_][a-z0-9_.]{0,119}$/u),
}).strict();

export const evidenceClaimInputSchema = z.object({
  statement: z.string().trim().min(1).max(600),
  assertion: claimAssertionSchema,
  refs: z.array(claimCellReferenceSchema).min(1).max(12),
}).strict();
export type EvidenceClaimInput = z.infer<typeof evidenceClaimInputSchema>;

const preferenceOptionById: Readonly<Record<AlbertPreferenceOptionId, AlbertPreferenceOption>> = Object.freeze({
  "sales.net_ex_gst": Object.freeze({ id: "sales.net_ex_gst", label: "Net sales (ex GST)", preference: "sales.default_metric", value: "commerce.net_sales_ex_gst" }),
  "sales.gross_inc_gst": Object.freeze({ id: "sales.gross_inc_gst", label: "Gross takings (inc GST)", preference: "sales.default_metric", value: "commerce.gross_takings_inc_gst" }),
  "employee.net_sales": Object.freeze({ id: "employee.net_sales", label: "Net sales", preference: "employee.performance_default", value: "commerce.net_sales_ex_gst" }),
  "employee.gross_margin": Object.freeze({ id: "employee.gross_margin", label: "Gross profit", preference: "employee.performance_default", value: "commerce.gross_margin" }),
  "employee.gross_profit_per_labour_hour": Object.freeze({ id: "employee.gross_profit_per_labour_hour", label: "Gross profit per worked hour", preference: "employee.performance_default", value: "composites.gross_profit_per_labour_hour" }),
  "reconciliation.daily_summary": Object.freeze({ id: "reconciliation.daily_summary", label: "Daily summary journals", preference: "reconciliation.pos_posting_topology", value: "daily_summary_journals" }),
  "reconciliation.individual_transactions": Object.freeze({ id: "reconciliation.individual_transactions", label: "Individual transactions", preference: "reconciliation.pos_posting_topology", value: "individual_transactions" }),
  "reconciliation.unknown": Object.freeze({ id: "reconciliation.unknown", label: "I’m not sure", preference: "reconciliation.pos_posting_topology", value: "unknown" }),
  "finance.operational_gross_margin": Object.freeze({ id: "finance.operational_gross_margin", label: "Operational gross margin", preference: "finance.profit_default", value: "commerce.gross_margin" }),
  "finance.accounting_gross_profit": Object.freeze({ id: "finance.accounting_gross_profit", label: "Accounting gross profit", preference: "finance.profit_default", value: "finance.gross_profit_accounting" }),
  "finance.accounting_net_profit": Object.freeze({ id: "finance.accounting_net_profit", label: "Accounting net profit", preference: "finance.profit_default", value: "finance.net_profit" }),
  // "This year" is materially ambiguous for an Australian business: the
  // financial year opens 1 July, the calendar year 1 January. Answering on an
  // unconfirmed default silently reports a different period than the one asked
  // about, so the basis is a confirmed tenant preference.
  "calendar.financial_year": Object.freeze({ id: "calendar.financial_year", label: "Financial year (from 1 July)", preference: "calendar.year_basis", value: "financial_year" }),
  "calendar.calendar_year": Object.freeze({ id: "calendar.calendar_year", label: "Calendar year (from 1 January)", preference: "calendar.year_basis", value: "calendar_year" }),
});

export function resolveAlbertPreferenceOption(id: AlbertPreferenceOptionId): AlbertPreferenceOption {
  return preferenceOptionById[id];
}

export function isAllowlistedRememberedPreference(preference: string, value: unknown): value is string {
  return typeof value === "string" && ALBERT_PREFERENCE_OPTION_IDS.some((id) => {
    const option = preferenceOptionById[id];
    return option.preference === preference && option.value === value;
  });
}

const sourceFilterSchema = z.object({
  field: z.string().min(1),
  op: z.enum(["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "is_null", "is_not_null"]),
  values: z.array(z.union([z.string(), z.number(), z.boolean()])).max(100).default([]),
}).strict();

/**
 * Trusted evidence about the scope of the statement that actually executed.
 * The model never supplies this object. SQL predicates are tokenised by the
 * semantic service and result values are copied from the returned rows; the
 * receipt therefore records scope evidence without pretending to certify a
 * metric or infer a business fact.
 */
export const queryScopeReceiptSchema = z.object({
  kind: z.literal("sql"),
  relations: z.array(z.object({
    schema: z.string().trim().min(1).max(80).optional(),
    relation: z.string().trim().min(1).max(120),
  }).strict()).max(32),
  predicates: z.array(z.object({
    expression: z.string().trim().min(1).max(240),
    operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "like", "not_like", "ilike", "not_ilike", "in", "not_in", "is_null", "is_not_null"]),
    values: z.array(z.string().max(240)).max(20),
  }).strict()).max(40),
  resultValues: z.array(z.object({
    column: z.string().trim().min(1).max(120),
    values: z.array(z.string().max(240)).min(1).max(20),
  }).strict()).max(32),
}).strict();
export type QueryScopeReceipt = z.infer<typeof queryScopeReceiptSchema>;
const sourceAggregateSchema = z.object({
  op: z.enum(["count", "count_distinct", "sum", "avg", "min", "max"]),
  field: z.string().min(1).optional(),
  as: z.string().regex(/^[a-z_][a-z0-9_]*$/),
}).strict();

/** Canonical source-exploration input consumed by both the agent and service. */
export const sourceQuerySpecSchema = z.object({
  connectionId: z.string().min(1),
  sourceTable: z.string().min(1),
  fields: z.array(z.string().min(1)).max(20).default([]),
  aggregates: z.array(sourceAggregateSchema).max(10).default([]),
  groupBy: z.array(z.string().min(1)).max(8).default([]),
  filters: z.array(sourceFilterSchema).max(20).default([]),
  limit: z.number().int().min(1).max(500).default(100),
  requestedMetricConcept: z.string().regex(/^[a-z][a-z0-9_.]{0,159}$/).optional(),
}).strict();
export type SourceQuerySpec = z.infer<typeof sourceQuerySpecSchema>;

/**
 * Agent-facing subquery shape for OpenAI strict function tools.
 * Free-form `z.record` parameter maps are rejected by the Responses API
 * ("Extra required key 'parameters'"), so trusted code injects `{}` instead.
 */
const toolFacingSubquerySchema = z.object({
  topic: z.string().min(1),
  metrics: z.array(z.string().min(1)).min(1).max(20),
  dimensions: z.array(z.string().min(1)).max(8).optional(),
  filters: z.array(queryFilterSchema).max(20).optional(),
  time: timeSelectionSchema,
}).strict();

/** Flattened tool input; converted to the compiler IR before execution. */
export const semanticQueryToolInputSchema = z.object({
  kind: z.enum(["single", "composite"]).default("single"),
  topic: z.string().min(1),
  metrics: z.array(z.string().min(1)).min(1).max(20),
  dimensions: z.array(z.string().min(1)).max(8).optional(),
  filters: z.array(queryFilterSchema).max(20).optional(),
  time: timeSelectionSchema.optional(),
  queries: z.array(toolFacingSubquerySchema).min(2).max(4).optional(),
  alignOn: z.array(z.string().min(1)).min(1).max(4).optional(),
  sort: z.array(sortSchema).max(5).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
}).strict();
export type SemanticQueryToolInput = z.infer<typeof semanticQueryToolInputSchema>;

/** Compiler IR accepted by the signed semantic service. */
export const semanticQueryIrSchema = z.union([
  singleSemanticQuerySchema,
  compositeSemanticQuerySchema,
]);
export type SemanticQueryIr = SemanticQuery;
/** Acronym-preserving alias for consumers that mirror the specification. */
export type SemanticQueryIR = SemanticQueryIr;

/** Converts OpenAI tool arguments into the compiler-owned semantic IR. */
export function toolInputToSemanticQueryIr(input: SemanticQueryToolInput): SemanticQueryIr {
  const kind = input.kind ?? "single";
  if (kind === "composite") {
    return parseSemanticQuery({
      kind: "composite",
      topic: input.topic,
      metrics: input.metrics,
      queries: (input.queries ?? []).map((query) => ({
        ...query,
        dimensions: query.dimensions ?? [],
        filters: query.filters ?? [],
        parameters: {},
      })),
      alignOn: input.alignOn ?? [],
      sort: input.sort ?? [],
      limit: input.limit ?? 100,
      parameters: {},
    });
  }
  return parseSemanticQuery({
    kind: "single",
    topic: input.topic,
    metrics: input.metrics,
    dimensions: input.dimensions ?? [],
    filters: input.filters ?? [],
    time: input.time,
    sort: input.sort ?? [],
    limit: input.limit ?? 100,
    parameters: {},
  });
}

export const semanticToolInputSchemas = Object.freeze({
  search_catalogue: z.object({ question: z.string().trim().min(1).max(2_000) }).strict(),
  get_definition: z.object({ name: z.string().trim().min(1).max(200) }).strict(),
  get_capabilities: z.object({ topic: z.string().trim().min(1).max(200) }).strict(),
  list_field_values: z.object({
    field: z.string().trim().min(1).max(300),
    query: z.string().trim().max(200).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }).strict(),
  run_semantic_query: semanticQueryToolInputSchema,
  run_source_query: sourceQuerySpecSchema,
  /**
   * The primary analytical instrument: model-authored SQL over the canonical
   * model. Safety does not rest on this schema — the statement runs READ ONLY
   * as semantic_ro under row level security, so it can neither write nor see
   * another tenant (see services/semantic-query/src/exploratory-sql.ts).
   * Correctness rests on what surrounds execution: the registry linter
   * rejects known-fatal shapes before the statement runs, a runtime canary
   * proves the join tree preserved fact grain, and each declared claim is
   * attested against the governed metric contract it names. A claim that
   * matches earns Verified; a divergent claim is Qualified with both numbers;
   * no claims means the figures are Exploratory.
   */
  run_sql: z.object({
    sql: z.string().trim().min(1).max(8_000),
    purpose: z.string().trim().min(1).max(300),
    /**
     * Claims tie output columns to governed concepts, and are what makes a
     * SQL answer certifiable. The window and filters scope the attestation
     * re-statement, so they must describe the same population the SQL reads.
     */
    claims: z.array(z.object({
      metricId: z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/),
      column: z.string().regex(/^[a-z_][a-z0-9_]*$/),
    }).strict()).max(8).default([]),
    time: z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).strict().optional(),
    filters: z.array(queryFilterSchema).max(10).default([]),
    limit: z.number().int().min(1).max(500).default(200),
  }).strict(),
  /**
   * Deprecated alias of run_sql without claims: read-only SQL whose result is
   * always Exploratory. Retired once every caller declares claims.
   */
  run_exploratory_sql: z.object({
    sql: z.string().trim().min(1).max(8_000),
    purpose: z.string().trim().min(1).max(300),
    limit: z.number().int().min(1).max(500).default(100),
  }).strict(),
  get_data_health: z.object({ domain: z.string().trim().min(1).max(100) }).strict(),
  remember: z.object({
    preference: z.enum(["sales.default_metric", "employee.performance_default", "reconciliation.pos_posting_topology", "finance.profit_default", "calendar.year_basis"]),
    value: z.string().trim().min(1).max(300),
    explicitlyConfirmed: z.literal(true),
  }).strict(),
  /**
   * Two kinds of clarification. `options` chooses between server-owned
   * preference lenses. `field`/`values` disambiguates the user's own words
   * against the tenant's real catalogue values ("does 'the workshop' mean
   * Services or Workshop?"), which the model may not invent: trusted code
   * checks every value against a governed list_field_values result from this
   * turn before it is ever shown.
   */
  ask_user: z.object({
    question: z.string().trim().min(1).max(300),
    options: z.array(z.object({
      id: z.enum(ALBERT_PREFERENCE_OPTION_IDS),
    }).strict()).max(3).default([]),
    field: z.string().trim().max(120).optional(),
    values: z.array(z.string().trim().min(1).max(200)).max(4).default([]),
  }).strict(),
  publish_observation: z.object({
    claim: evidenceClaimInputSchema,
    nextStep: z.enum(OBSERVATION_NEXT_STEP_IDS).optional(),
  }).strict(),
  make_chart: z.object({
    dataRef: z.string().min(1).describe("Result id of a governed table returned in this turn."),
    chartType: z.enum(["bar", "line"]).describe(
      "Use line only for an ordered time/numeric sequence; use bar for categorical comparison or ranking.",
    ),
    xKey: z.string().min(1).describe("Dimension or ordered time column used on the x axis."),
    yKey: z.string().min(1).describe("Primary numeric measure column."),
    series: z.array(z.object({
      key: z.string().min(1).max(120),
      label: z.string().trim().min(1).max(120),
    }).strict()).min(1).max(4).optional().describe(
      "All plotted measures, with yKey first. Include only measures with the same unit and currency.",
    ),
  }).strict(),
  /**
   * Resolve a dumbed-down product/service name against the store's Lightspeed
   * catalogue, ranked by recent sales. Local tool: runs staging SQL via run_sql.
   */
  resolve_named_entity: z.object({
    phrase: z.string().trim().min(1).max(120),
    purpose: z.string().trim().min(1).max(300).default("Match the product or service the owner named"),
  }).strict(),
  /**
   * Open the deep playbook + column dictionary for one Lightspeed dimension
   * (sales, workshop, inventory, customers, purchasing, employees). Local
   * tool: returns generated text, runs no SQL.
   */
  open_dimension_guide: z.object({
    dimension: z.string().trim().min(1).max(40),
  }).strict(),
  /**
   * Audited working plan owned by the primary analyst. It is deliberately a
   * local tool: the plan may change as evidence arrives and is never trusted as
   * a query authorization or correctness proof.
   */
  update_analysis_plan: z.object({
    summary: z.string().trim().min(1).max(180),
    steps: z.array(z.string().trim().min(1).max(180)).min(1).max(8),
    reason: z.enum(["initial", "evidence", "recovery"]),
  }).strict(),
  /** Keyword discovery over the complete generated Lightspeed SQL catalogue. */
  search_schema: z.object({
    query: z.string().trim().min(1).max(300),
    limit: z.number().int().min(1).max(20).default(10),
  }).strict(),
  /** Retrieve the complete grounded dictionary for selected Lightspeed tables. */
  describe_tables: z.object({
    tables: z.array(z.string().trim().regex(/^ls_[a-z0-9_]+$/u)).min(1).max(8),
  }).strict(),
} satisfies Record<SemanticAgentToolName, z.ZodType>);

const wireTimeRangeSchema = z.object({
  label: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  timezone: z.string().min(1),
}).strict();
const sourceDetailSchema = z.object({
  connectorId: z.string().min(1),
  connectionId: z.string().min(1),
  label: z.string().min(1),
  dataThrough: z.string().min(1),
}).strict();
const definitionDetailSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  definition: z.string().min(1),
}).strict();
const governedResultWindowSchema = z.object({
  requestedLimit: z.number().int().min(1).max(1000),
  orderedBeforeLimit: z.literal(true),
  // Ranking / aged-inventory statements often ORDER BY several expressions.
  // Cap high enough for real shop SQL; the proof still records the prefix used.
  orderBy: z.array(z.object({
    columnKey: z.string().min(1),
    direction: z.enum(["asc", "desc"]),
  }).strict()).max(12),
}).strict();

/**
 * One signed wire response for every remote semantic tool. Tool-specific
 * payloads are optional, while provenance, validation, and performance are
 * mandatory and therefore cannot be lost between service and UI adapters.
 */
export const semanticToolResponseSchema = z.object({
  state: z.enum(["verified", "qualified", "exploratory", "clarification", "unavailable"]),
  resultId: z.string().min(1).optional(),
  data: z.object({
    columns: z.array(z.string().min(1)),
    rows: z.array(z.record(z.string(), z.unknown())),
    /**
     * Row-parallel, tenant-scoped canonical values that may be copied into a
     * later governed filter. They are deliberately separate from display
     * rows so tables keep human labels while the agent never guesses an
     * entity id from a label.
     */
    filterRefs: z.array(z.record(z.string().min(1), z.string().min(1))).optional(),
    /** Compiler-owned ordering proof; absent for exploratory source queries. */
    resultWindow: governedResultWindowSchema.optional(),
  }).strict().optional(),
  definition: z.unknown().optional(),
  capabilities: z.object({
    topic: z.string().min(1),
    answerable: z.boolean(),
    required: z.array(z.string()),
    available: z.array(z.string()),
    missing: z.array(z.string()),
    details: z.array(z.object({
      id: z.string().min(1),
      requiredForTopic: z.boolean(),
      available: z.boolean(),
      support: z.enum(["full", "partial", "unavailable", "unknown"]),
      observations: z.array(z.object({
        connectorId: z.string().min(1),
        connectionId: z.string().min(1).optional(),
        support: z.enum(["full", "partial", "unavailable", "unknown"]),
        reasonCode: z.string().min(1).optional(),
        reason: z.string().min(1).optional(),
        coverage: z.record(z.string(), z.unknown()),
      }).strict()),
    }).strict()).default([]),
  }).strict().optional(),
  catalogue: z.object({
    topics: z.array(z.object({ id: z.string(), label: z.string(), description: z.string(), answerable: z.boolean() }).strict()),
    metrics: z.array(z.object({ id: z.string(), label: z.string(), description: z.string(), unit: z.string() }).strict()),
    dimensions: z.array(z.object({ id: z.string(), label: z.string(), topics: z.array(z.string()) }).strict()),
    fields: z.array(z.object({ id: z.string(), connectorId: z.string(), connectionId: z.string(), sourceTable: z.string(), field: z.string(), definition: z.string(), fieldType: z.string() }).strict()),
    tenantContext: z.object({
      defaults: z.record(z.string(), z.union([z.string().max(160), z.number(), z.boolean()])),
      dossier: z.record(z.string(), z.union([
        z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(200)).max(50),
      ])),
    }).strict(),
  }).strict().optional(),
  fieldValues: z.array(z.object({ value: z.string(), count: z.number().int().nonnegative().optional() }).strict()).optional(),
  dataHealth: z.object({
    domain: z.string(),
    status: z.enum(["passed", "warning", "failed", "blocked"]),
    dataThrough: z.string().optional(),
    checks: z.array(z.record(z.string(), z.unknown())),
    warnings: z.array(z.string()),
  }).strict().optional(),
  rememberedPreference: z.object({ preference: z.string(), overlayVersion: z.number().int().positive() }).strict().optional(),
  promotionCandidateId: z.string().min(1).optional(),
  /** Server-derived scope evidence for the statement that actually ran. */
  scopeReceipt: queryScopeReceiptSchema.optional(),
  /**
   * Server-side evidence receipt for an executed analytical query. The live
   * conversation runtime records this receipt in the immutable answer
   * artefact, but deliberately omits it from the tool result shown to the
   * model and from the public trace.
   */
  queryAudit: z.object({
    queryAuditId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    route: z.enum(["semantic", "source_exploration", "sql_first"]),
    bundleHash: z.string().regex(/^[a-f0-9]{64}$/),
    registryVersion: z.string().min(1).max(160),
    resultDigest: z.string().regex(/^[a-f0-9]{64}$/),
    compilerOutputHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
  provenance: z.object({
    bundleHash: z.string().min(1),
    registryVersion: z.string().min(1),
    identityGraph: z.object({
      version: z.number().int().nonnegative(),
      hash: z.string().regex(/^[a-f0-9]{32}$/),
    }).strict(),
    sources: z.array(z.string()),
    sourceWatermarks: z.record(z.string(), z.string()),
    sourceDetails: z.array(sourceDetailSchema).default([]),
    definitionsApplied: z.array(z.string()),
    definitionDetails: z.array(definitionDetailSchema).default([]),
    timeRange: wireTimeRangeSchema.optional(),
    authorityWarning: z.string().optional(),
  }).strict(),
  validation: z.object({
    status: z.enum(["passed", "warning", "failed", "blocked"]),
    checks: z.array(z.record(z.string(), z.unknown())),
    warnings: z.array(z.string()),
  }).strict(),
  performance: z.object({ cacheHit: z.boolean(), durationMs: z.number().nonnegative(), rowCount: z.number().int().nonnegative() }).strict(),
}).strict();
export type SemanticToolResponse = z.infer<typeof semanticToolResponseSchema>;

export type GovernedResult = Readonly<{
  resultId: string;
  columns: readonly TraceTableColumn[];
  rows: readonly Readonly<Record<string, TraceCell>>[];
  /** Server-derived query-scope evidence; never authored by the model. */
  scopeReceipt?: QueryScopeReceipt;
  /** Exact canonical filter values, indexed in parallel with rows. */
  filterRefs?: readonly Readonly<Record<string, string>>[];
  /**
   * Compiler-owned proof that an outer ORDER BY was applied before LIMIT.
   * Ranking claims must fail closed when this proof is absent or mismatched.
   */
  resultWindow?: Readonly<{
    requestedLimit: number;
    orderedBeforeLimit: true;
    orderBy: readonly Readonly<{
      columnKey: string;
      direction: "asc" | "desc";
    }>[];
  }>;
  provenance: TraceProvenance;
  validations: readonly Readonly<{
    name: string;
    outcome: "passed" | "qualified" | "failed";
    detail: string;
  }>[];
}>;

export type AgentToolContext = Readonly<{
  /** Injected by trusted backend code; never accepted from model tool input. */
  tenantId: string;
  conversationId: string;
  turnId: string;
  role: "owner" | "manager" | "bookkeeper" | "internal_operator";
  /** Signed server-side confirmation context; never accepted from model input. */
  confirmedPreference?: string;
  confirmedValue?: string;
  abortSignal?: AbortSignal;
}>;

export type SemanticToolInputMap = {
  [Name in SemanticAgentToolName]: z.infer<(typeof semanticToolInputSchemas)[Name]>;
};

export type SemanticToolOutputMap = {
  search_catalogue: NonNullable<SemanticToolResponse["catalogue"]>;
  get_definition: Readonly<{ definition: unknown }>;
  get_capabilities: NonNullable<SemanticToolResponse["capabilities"]>;
  list_field_values: NonNullable<SemanticToolResponse["fieldValues"]>;
  run_semantic_query: GovernedResult;
  run_source_query: GovernedResult & Readonly<{
    state: "Exploratory";
    authorityWarning?: string;
    promotionCandidateId: string;
  }>;
  run_sql: GovernedResult & Readonly<{
    /** Derived from attestation outcome and the evidence tier touched. */
    state: "Verified" | "Qualified" | "Exploratory" | "Unavailable";
  }>;
  run_exploratory_sql: GovernedResult & Readonly<{
    state: "Exploratory";
    /** Always set: an exploratory figure is never a certified metric. */
    ungovernedWarning: string;
  }>;
  get_data_health: NonNullable<SemanticToolResponse["dataHealth"]>;
  ask_user: Readonly<{ status: "awaiting_user" }>;
  publish_observation: Readonly<{
    status: "published";
    text: string;
  }>;
  remember: NonNullable<SemanticToolResponse["rememberedPreference"]>;
  make_chart: Readonly<{
    dataRef: string;
    chartType: "bar" | "line";
    xKey: string;
    yKey: string;
    series?: readonly Readonly<{ key: string; label: string }>[];
  }>;
  resolve_named_entity: Readonly<{
    phrase: string;
    assumption: Readonly<{
      itemId: string;
      itemName: string;
      unitsThisMonth: number;
      unitsAllTime: number;
    }> | null;
    confidence: "high" | "medium" | "low" | "none";
    reason: string;
    candidates: readonly Readonly<{
      itemId: string;
      itemName: string;
      unitsThisMonth: number;
      unitsAllTime: number;
    }>[];
    nextStep: string;
  }>;
  open_dimension_guide: Readonly<
    | { status: "ok"; dimension: string; guide: string }
    | { status: "unknown_dimension"; guidance: string }
  >;
  update_analysis_plan: Readonly<{
    status: "updated";
    revision: number;
    reason: "initial" | "evidence" | "recovery";
  }>;
  search_schema: Readonly<{
    matches: readonly Readonly<{ table: string; score: number; summary: string }>[];
    guidance: string;
  }>;
  describe_tables: Readonly<{
    tables: Readonly<Record<string, string>>;
    unknown: readonly string[];
    guidance?: string;
  }>;
};

export type SemanticAgentTool<Name extends SemanticAgentToolName = SemanticAgentToolName> =
  Readonly<{
    name: Name;
    description: string;
    execute: (
      input: SemanticToolInputMap[Name],
      context: AgentToolContext,
    ) => Promise<SemanticToolOutputMap[Name]>;
  }>;

const semanticToolNames = new Set<string>(SEMANTIC_AGENT_TOOL_NAMES);

export function isSemanticAgentToolName(value: unknown): value is SemanticAgentToolName {
  return typeof value === "string" && semanticToolNames.has(value);
}

/** Runtime guard rejecting raw database, SQL, or any unapproved tool. */
export function assertSemanticOnlyToolNames(
  names: readonly string[],
): asserts names is readonly SemanticAgentToolName[] {
  const unknown = names.filter((name) => !isSemanticAgentToolName(name));
  if (unknown.length > 0) {
    throw new Error(`Agent tool boundary rejected: ${unknown.join(", ")}.`);
  }
}

export function assertSemanticOnlyToolset(
  tools: readonly SemanticAgentTool[],
): readonly SemanticAgentTool[] {
  const names = tools.map(({ name }) => name);
  assertSemanticOnlyToolNames(names);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate semantic tools: ${[...new Set(duplicates)].join(", ")}.`);
  }
  return Object.freeze([...tools]);
}
