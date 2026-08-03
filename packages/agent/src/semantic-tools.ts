import type {
  TraceCell,
  TraceProvenance,
  TraceTableColumn,
  TraceTimeRange,
} from "../../shared/src/index.js";

export const SEMANTIC_AGENT_TOOL_NAMES = [
  "search_catalogue",
  "get_definition",
  "get_capabilities",
  "list_field_values",
  "run_semantic_query",
  "run_source_query",
  "get_data_health",
  "ask_user",
  "remember",
  "make_chart",
] as const;

export type SemanticAgentToolName = (typeof SEMANTIC_AGENT_TOOL_NAMES)[number];

const semanticToolNames = new Set<string>(SEMANTIC_AGENT_TOOL_NAMES);

export type SemanticFilter = Readonly<{
  field: string;
  op: "eq" | "neq" | "in" | "not_in" | "gt" | "gte" | "lt" | "lte" | "contains";
  values: readonly (string | number | boolean)[];
}>;

export type SemanticQueryIr = Readonly<{
  topic: string;
  metrics: readonly string[];
  dimensions: readonly string[];
  filters: readonly SemanticFilter[];
  time: Readonly<{
    field: string;
    range:
      | Readonly<{ type: "named"; value: string }>
      | Readonly<{ type: "absolute"; start: string; end: string }>;
    compare?: string;
  }>;
  sort?: readonly Readonly<{
    metric: string;
    dir: "asc" | "desc";
  }>[];
  limit?: number;
  parameters?: Readonly<Record<string, string | number | boolean>>;
}>;

/** Acronym-preserving alias for consumers that mirror the specification. */
export type SemanticQueryIR = SemanticQueryIr;

export type GovernedResult = Readonly<{
  resultId: string;
  columns: readonly TraceTableColumn[];
  rows: readonly Readonly<Record<string, TraceCell>>[];
  provenance: TraceProvenance;
}>;

export type SourceQuerySpec = Readonly<{
  /** Exploration is constrained to exactly one connector. */
  connector: "lightspeed" | "xero" | "deputy";
  fieldIds: readonly string[];
  filters: readonly SemanticFilter[];
  timeRange: TraceTimeRange;
  limit: number;
}>;

export type AgentToolContext = Readonly<{
  /** Injected by trusted backend code; never accepted from model tool input. */
  tenantId: string;
  conversationId: string;
  turnId: string;
  role: "owner" | "manager" | "bookkeeper" | "internal_operator";
  abortSignal?: AbortSignal;
}>;

export type SemanticToolInputMap = {
  search_catalogue: Readonly<{ question: string }>;
  get_definition: Readonly<{ name: string }>;
  get_capabilities: Readonly<{ topic: string }>;
  list_field_values: Readonly<{
    field: string;
    query?: string;
    limit?: number;
  }>;
  run_semantic_query: SemanticQueryIr;
  run_source_query: SourceQuerySpec;
  get_data_health: Readonly<{ domain: string }>;
  ask_user: Readonly<{
    question: string;
    options: readonly Readonly<{ id: string; label: string; value: string }>[];
  }>;
  remember: Readonly<{
    preference: string;
    value: string | number | boolean;
    explicitlyConfirmed: true;
  }>;
  make_chart: Readonly<{
    dataRef: string;
    chartType: "bar" | "line";
    xKey: string;
    yKey: string;
    series?: readonly Readonly<{ key: string; label: string }>[];
  }>;
};

export type SemanticToolOutputMap = {
  search_catalogue: Readonly<{
    topics: readonly string[];
    metrics: readonly string[];
    fields: readonly string[];
  }>;
  get_definition: Readonly<{
    name: string;
    definition: string;
    version: number;
  }>;
  get_capabilities: Readonly<{
    topic: string;
    available: boolean;
    missing: readonly string[];
  }>;
  list_field_values: readonly Readonly<{ value: string; count?: number }>[];
  run_semantic_query: GovernedResult;
  run_source_query: GovernedResult & Readonly<{
    state: "Exploratory";
    authorityWarning?: string;
    promotionCandidateId: string;
  }>;
  get_data_health: Readonly<{
    domain: string;
    state: string;
    dataThrough?: string;
    warnings: readonly string[];
  }>;
  ask_user: Readonly<{ status: "awaiting_user" }>;
  remember: Readonly<{ overlayVersion: number }>;
  make_chart: Readonly<{
    dataRef: string;
    chartType: "bar" | "line";
    xKey: string;
    yKey: string;
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

export function isSemanticAgentToolName(value: unknown): value is SemanticAgentToolName {
  return typeof value === "string" && semanticToolNames.has(value);
}

/**
 * Runtime guard for the constitutional tool boundary. Unknown tools—including
 * any raw database or SQL executor—cannot be attached to an Albert agent.
 */
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
