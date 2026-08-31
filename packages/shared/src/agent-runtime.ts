/**
 * Shared, transport-safe contracts for Albert's agent runtime.
 *
 * This module deliberately contains no provider SDK imports. It is safe to use
 * from the browser for rendering and from trusted services for validation.
 */
import type { GroundedFlintSpec } from "./flint-grounded.js";

export const ALBERT_MODEL_PROVIDERS = ["openai", "xai", "anthropic"] as const;
export type AlbertModelProvider = (typeof ALBERT_MODEL_PROVIDERS)[number];

export const XAI_API_BASE_URL = "https://api.x.ai/v1";
export const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";
export const CLAUDE_HAIKU_4_5_MODEL_ID = "claude-haiku-4-5-20251001";
export const CLAUDE_SONNET_5_MODEL_ID = "claude-sonnet-5";

export const ALBERT_MODELS = [
  {
    id: "gpt-5.6-sol",
    label: "GPT 5.6 Sol",
    shortLabel: "Sol",
    description: "Most capable",
    tier: "frontier",
    provider: "openai",
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT 5.6 Terra",
    shortLabel: "Terra",
    description: "Best balance",
    tier: "balanced",
    provider: "openai",
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT 5.6 Luna",
    shortLabel: "Luna",
    description: "Most efficient",
    tier: "efficient",
    provider: "openai",
  },
  {
    id: "grok-4.6",
    label: "Grok 4.6",
    shortLabel: "Grok",
    description: "xAI frontier reasoning",
    tier: "frontier",
    provider: "xai",
  },
  {
    id: CLAUDE_SONNET_5_MODEL_ID,
    label: "Claude Sonnet 5",
    shortLabel: "Sonnet",
    description: "Anthropic deep reasoning",
    tier: "balanced",
    provider: "anthropic",
  },
  {
    id: CLAUDE_HAIKU_4_5_MODEL_ID,
    label: "Claude Haiku 4.5",
    shortLabel: "Haiku",
    description: "Anthropic fast reasoning",
    tier: "efficient",
    provider: "anthropic",
  },
] as const;

export type AlbertModelId = (typeof ALBERT_MODELS)[number]["id"];
export type AlbertModel = (typeof ALBERT_MODELS)[number];

export const ALBERT_MODEL_IDS = ALBERT_MODELS.map(({ id }) => id) as readonly AlbertModelId[];

export const REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Official Grok 4.6 reasoning.effort values. Reasoning cannot be disabled. */
export const GROK_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly ReasoningEffort[];

export type GrokReasoningEffort = (typeof GROK_REASONING_EFFORTS)[number];

/**
 * Haiku 4.5 predates Anthropic's `output_config.effort` control. Albert maps
 * its shared effort labels onto manual extended-thinking token budgets. The
 * values are application policy, not provider-native effort names.
 */
export const HAIKU_THINKING_BUDGET_TOKENS = Object.freeze({
  none: 0,
  low: 1_024,
  medium: 4_096,
  high: 8_192,
  xhigh: 16_000,
  max: 32_000,
} as const satisfies Readonly<Record<ReasoningEffort, number>>);

/** Leaves at least 8k tokens for Haiku's structured answer/tool call. */
export const HAIKU_MAX_OUTPUT_TOKENS = Object.freeze({
  none: 8_192,
  low: 9_216,
  medium: 12_288,
  high: 16_384,
  xhigh: 24_192,
  max: 40_192,
} as const satisfies Readonly<Record<ReasoningEffort, number>>);

/**
 * Sonnet 5 is a 4.6+-family Anthropic model: thinking is adaptive and effort
 * is the provider-native `output_config.effort` control. Manual
 * `budget_tokens` thinking is rejected outright on that family, so the
 * Messages adapter must branch on this rather than on the provider alone.
 */
export function anthropicUsesAdaptiveThinking(id: AlbertModelId): boolean {
  return id === CLAUDE_SONNET_5_MODEL_ID;
}

/**
 * Provider output ceilings per Anthropic model. The Messages adapter streams
 * internally, so granting the full ceiling never risks the non-streaming
 * long-request refusal.
 */
export const ANTHROPIC_MAX_OUTPUT_TOKENS = Object.freeze({
  [CLAUDE_HAIKU_4_5_MODEL_ID]: 64_000,
  [CLAUDE_SONNET_5_MODEL_ID]: 128_000,
} as const);

export function anthropicMaxOutputTokens(id: AlbertModelId): number {
  return (ANTHROPIC_MAX_OUTPUT_TOKENS as Readonly<Record<string, number>>)[id] ?? 64_000;
}

/**
 * Default per-request output allowance for adaptive-thinking models when the
 * host configures none. Adaptive thinking spends from the same allowance as
 * the visible answer, so the default leaves generous room for both.
 */
export const ANTHROPIC_ADAPTIVE_DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

export type AgentRunPreferences = Readonly<{
  model: AlbertModelId;
  reasoningEffort: ReasoningEffort;
  /** Fast mode is an independent processing tier, not a reasoning preset. */
  fastMode: boolean;
}>;

export const DEFAULT_AGENT_PREFERENCES: AgentRunPreferences = Object.freeze({
  model: "gpt-5.6-luna",
  reasoningEffort: "max",
  fastMode: true,
});

const modelIds = new Set<string>(ALBERT_MODEL_IDS);
const reasoningEfforts = new Set<string>(REASONING_EFFORTS);
const grokReasoningEfforts = new Set<string>(GROK_REASONING_EFFORTS);
const modelsById = new Map(ALBERT_MODELS.map((model) => [model.id, model]));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAlbertModelId(value: unknown): value is AlbertModelId {
  return typeof value === "string" && modelIds.has(value);
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && reasoningEfforts.has(value);
}

export function albertModelById(id: AlbertModelId): AlbertModel {
  return modelsById.get(id) ?? ALBERT_MODELS[0];
}

export function providerForModel(id: AlbertModelId): AlbertModelProvider {
  return albertModelById(id).provider;
}

export function isXaiModel(id: AlbertModelId): boolean {
  return providerForModel(id) === "xai";
}

export function isAnthropicModel(id: AlbertModelId): boolean {
  return providerForModel(id) === "anthropic";
}

export function modelSupportsFastMode(id: AlbertModelId): boolean {
  return !isAnthropicModel(id);
}

/**
 * Maps Albert Fast onto the provider `service_tier`. GPT uses OpenAI Fast.
 * Grok uses official xAI Priority Processing (`priority`), never `fast`.
 */
export function serviceTierForPreferences(
  preferences: AgentRunPreferences,
): "default" | "fast" | "priority" {
  if (!preferences.fastMode || !modelSupportsFastMode(preferences.model)) return "default";
  return isXaiModel(preferences.model) ? "priority" : "fast";
}

export function reasoningEffortsForModel(id: AlbertModelId): readonly ReasoningEffort[] {
  return isXaiModel(id) ? GROK_REASONING_EFFORTS : REASONING_EFFORTS;
}

/**
 * Maps Albert's shared effort control onto the values the selected provider
 * accepts. Grok 4.6 has no `none` or `max`; those clamp to `low` and `xhigh`.
 */
export function clampReasoningEffort(
  model: AlbertModelId,
  effort: ReasoningEffort,
): ReasoningEffort {
  if (!isXaiModel(model)) return effort;
  if (effort === "none") return "low";
  if (effort === "max") return "xhigh";
  if (grokReasoningEfforts.has(effort)) return effort;
  return "high";
}

export type ResolvedAlbertModelTransport = Readonly<{
  provider: AlbertModelProvider;
  model: AlbertModelId;
  apiKey: string;
  baseUrl: string;
}>;

/**
 * Resolves the native endpoint for the selected model. GPT profiles stay on
 * the configured OpenAI base URL, Grok 4.6 uses xAI Responses, and Haiku uses
 * Anthropic Messages. Provider credentials are never reused across hosts.
 */
export function resolveAlbertModelTransport(input: Readonly<{
  model: AlbertModelId;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  xaiApiKey?: string;
  xaiBaseUrl?: string;
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
}>): ResolvedAlbertModelTransport {
  if (isAnthropicModel(input.model)) {
    const apiKey = input.anthropicApiKey?.trim() ?? "";
    if (!apiKey) {
      throw new Error(`${albertModelById(input.model).label} is not configured on this Albert environment.`);
    }
    const baseUrl = (input.anthropicBaseUrl?.trim() || ANTHROPIC_API_BASE_URL).replace(/\/+$/u, "");
    return Object.freeze({
      provider: "anthropic",
      model: input.model,
      apiKey,
      baseUrl,
    });
  }

  if (isXaiModel(input.model)) {
    const apiKey = input.xaiApiKey?.trim() ?? "";
    if (!apiKey) {
      throw new Error("Grok 4.6 is not configured on this Albert environment.");
    }
    const baseUrl = (input.xaiBaseUrl?.trim() || XAI_API_BASE_URL).replace(/\/+$/u, "");
    return Object.freeze({
      provider: "xai",
      model: input.model,
      apiKey,
      baseUrl,
    });
  }

  const apiKey = input.openaiApiKey?.trim() ?? "";
  if (!apiKey) {
    throw new Error("The OpenAI conversation runtime is not fully configured.");
  }
  const baseUrl = (input.openaiBaseUrl?.trim() || "https://api.openai.com/v1").replace(/\/+$/u, "");
  return Object.freeze({
    provider: "openai",
    model: input.model,
    apiKey,
    baseUrl,
  });
}

/**
 * Normalizes untrusted UI input against the server-owned allowlist.
 * Unknown fields and values never flow into a provider request.
 */
export function normalizeAgentPreferences(input: unknown): AgentRunPreferences {
  const candidate = isRecord(input) ? input : {};
  const model = isAlbertModelId(candidate.model)
    ? candidate.model
    : DEFAULT_AGENT_PREFERENCES.model;
  const requestedEffort = isReasoningEffort(candidate.reasoningEffort)
    ? candidate.reasoningEffort
    : DEFAULT_AGENT_PREFERENCES.reasoningEffort;

  return Object.freeze({
    model,
    reasoningEffort: clampReasoningEffort(model, requestedEffort),
    fastMode:
      modelSupportsFastMode(model)
      && (typeof candidate.fastMode === "boolean"
        ? candidate.fastMode
        : DEFAULT_AGENT_PREFERENCES.fastMode),
  });
}

export const ANSWER_STATES = [
  "Verified",
  "Derived",
  "Qualified",
  "Exploratory",
  "Clarification",
  "No data",
  "Unavailable",
] as const;

export type AnswerState = (typeof ANSWER_STATES)[number];

/** The exact public terminal contract for Semantic Execution V2. */
export const SEMANTIC_V2_ANSWER_STATES = [
  "Verified",
  "Derived",
  "Exploratory",
  "Clarification",
  "No data",
  "Unavailable",
] as const satisfies readonly AnswerState[];
export type SemanticV2AnswerState = (typeof SEMANTIC_V2_ANSWER_STATES)[number];

export type TraceStatus = "pending" | "running" | "complete" | "warning" | "error";

export type TraceCell = string | number | null;

export type TraceTimeRange = Readonly<{
  label: string;
  start: string;
  end: string;
  timezone: string;
}>;

/** The tools Albert can source data from, as shown in provenance and traces. */
export type TraceConnector =
  | "lightspeed" | "lightspeed-x" | "xero" | "deputy" | "square" | "shopify" | "stripe"
  | "momence" | "meta-ads" | "google-ads";

/** One governed member behind a result, with its model-owned meaning. */
export type TraceProvenanceDefinition = Readonly<{
  metric: string;
  label: string;
  definition: string;
  /** Semantic view the member belongs to (Cube results). */
  view?: string;
  kind?: "measure" | "dimension" | "segment" | "time";
}>;

/** A filter the query applied, in the model's member vocabulary plus a plain rendering. */
export type TraceProvenanceFilter = Readonly<{
  member: string;
  label: string;
  operator: string;
  values: readonly string[];
  /** Owner-readable rendering, e.g. "Store is Fitzroy" or "Completed at in the last 30 days". */
  text: string;
}>;

export type TraceProvenance = Readonly<{
  sources: readonly Readonly<{
    connector: TraceConnector;
    label: string;
    dataThrough: string;
  }>[];
  timeRange: TraceTimeRange;
  definitions: readonly TraceProvenanceDefinition[];
  semanticBundleHash: string;
  identityGraph: Readonly<{ version: number; hash: string }>;
  coverage?: readonly Readonly<{
    label: string;
    value: number;
    unit: "percent" | "records";
  }>[];
  /** The governed view (Cube "topic") the result was read from. */
  view?: Readonly<{ name: string; label: string; description: string }>;
  /** Filters and time windows the query applied, so a result's scope is inspectable. */
  filters?: readonly TraceProvenanceFilter[];
  /** For composed tables: how each calculated column was derived, in words. */
  calculations?: readonly Readonly<{ column: string; formula: string }>[];
}>;

export interface TraceEventBase {
  id: string;
  sequence: number;
  type: string;
  status?: TraceStatus;
  occurredAt: string;
}

/**
 * Identifies the governed work a progress step represents so the browser can
 * merge a step with the result event it produced instead of listing both.
 */
export type TraceProgressStage =
  | "planning"
  | "research"
  | "catalogue"
  | "definition"
  | "capabilities"
  | "field_values"
  | "data_health"
  | "query"
  | "source_query"
  | "directory";

export interface TraceProgressEvent extends TraceEventBase {
  type: "progress";
  label: string;
  /**
   * The concrete substance behind the label — the governed metrics, dimensions,
   * field, domain, or period actually being worked on. Never model prose.
   */
  detail?: string;
  stage?: TraceProgressStage;
  /** A bounded, user-facing completion estimate from 0 to 1. */
  progress?: number;
  /**
   * What a research step actually found, one line each (matched views and
   * their meaning, matched stored values with their weight, member
   * definitions read). Bounded; rendered as the step's expandable body so
   * the owner sees the outcome, not just that a lookup happened. An empty
   * list on a completed step means "nothing matched" and is worth showing.
   */
  findings?: readonly string[];
}

export interface TraceNarrativeEvent extends TraceEventBase {
  type: "narrative";
  /** Separates acknowledgements and safe model summaries from evidence-backed commentary. */
  purpose?: "acknowledgement" | "reasoning_summary";
  text: string;
}

export type TracePlanStepStatus =
  | "pending"
  | "active"
  | "done"
  | "blocked"
  | "incomplete";

export type TracePlanStepKind = "evidence" | "synthesis";

export type TracePlanStep = Readonly<{
  /** Stable within one turn so evidence can be attached without label matching. */
  id: string;
  label: string;
  status: TracePlanStepStatus;
  /** Evidence steps need governed result references before they may be done. */
  kind: TracePlanStepKind;
  /** Successful governed result sets that support this exact step. */
  evidenceResultIds: readonly string[];
  /** Owner-safe explanation for blocked or incomplete terminal states. */
  statusDetail?: string;
}>;

/**
 * The agent's visible working plan: short owner-readable steps ticked off as
 * the investigation progresses. Each plan event carries the full current
 * list; the UI renders only the latest one.
 */
export interface TracePlanEvent extends TraceEventBase {
  type: "plan";
  steps: readonly TracePlanStep[];
}

export interface TraceQueryEvent extends TraceEventBase {
  type: "query";
  topic: string;
  metrics: readonly string[];
  dimensions: readonly string[];
  timeRange: TraceTimeRange;
  lens: string;
  /**
   * Albert v3 Cube transparency (additive; other runtimes omit these).
   * `queryYaml` is the governed Cube JSON query rendered as YAML. It is a
   * semantic representation, never raw SQL or prompts.
   */
  view?: string;
  cubesUsed?: readonly string[];
  queryYaml?: string;
  rowCount?: number;
  executionMs?: number;
  /** Which tool the queried view draws its data from (drives the UI logo). */
  connector?: TraceConnector;
  /** Owner-readable query title authored by the agent ("Revenue by week"). */
  name?: string;
  /**
   * The result id of the evidence table this query produced. Remote runtimes
   * cannot know web-stamped event ids, so the web relay uses this to pair a
   * table's `dashboardReplay.queryEventId` with its query event.
   */
  resultId?: string;
}

export type TraceTableColumn = Readonly<{
  key: string;
  label: string;
  type: "string" | "number" | "currency" | "percent" | "date" | "datetime";
  /** ISO-4217 code proven by query validation; omitted when the currency is unknown. */
  currency?: string;
}>;

/**
 * The value format of one row in a metric-per-row (pivoted) table. A pivoted
 * column stacks different measures — currency rows above percent rows — so a
 * single column type cannot format its cells; each row keeps the unit of the
 * measure it was pivoted from.
 */
export type TraceRowFormat = Readonly<{
  type: "number" | "currency" | "percent";
  /** ISO-4217 code proven by query validation; omitted when the currency is unknown. */
  currency?: string;
}>;

/**
 * An immutable, server-resolvable reference for a governed table result.
 *
 * This deliberately contains no SQL or executable browser-authored recipe.
 * Dashboard pinning submits the event identifiers and trusted server code
 * resolves the full replay recipe from the immutable conversation trace.
 */
export type DashboardReplayRef =
  | Readonly<{
      kind: "cube_v3";
      queryEventId: string;
      queryDigest: string;
      semanticVersionDigest: string;
    }>
  | Readonly<{
      kind: "semantic_v2";
      executionId: string;
      resultId: string;
      publicationHash: string;
    }>
  | Readonly<{
      kind: "derived_v1";
      /** Direct governed table events consumed by the deterministic transform. */
      sourceTableEventIds: readonly string[];
      transformDigest: string;
    }>;

export type TraceDerivedIndexedSourceCell = Readonly<{
  kind: "source";
  sourceResultId: string;
  rowIndex: number;
  columnKey: string;
}>;

export type TraceDerivedMatchedSourceCell = Readonly<{
  kind: "matched_source";
  sourceResultId: string;
  columnKey: string;
  matchColumnKey: string;
  matchValue: TraceDerivedIndexedSourceCell;
}>;

export type TraceDerivedSourceCell =
  | TraceDerivedIndexedSourceCell
  | TraceDerivedMatchedSourceCell;

export type TraceDerivedLiteralCell = Readonly<{
  kind: "literal";
  value: TraceCell;
}>;

export type TraceDerivedNumericOperand = TraceDerivedSourceCell | Readonly<{
  kind: "number";
  value: number;
}>;

export type TraceDerivedCellExpression =
  | TraceDerivedSourceCell
  | TraceDerivedLiteralCell
  | Readonly<{
      kind: "calculation";
      /**
       * Binary arithmetic over two operands. `percent_change` is
       * (left − right) / right × 100 and `percent_of` is left / right × 100,
       * both on the 0–100 scale Cube percent measures use; either is null
       * when right is zero.
       */
      operator: TraceDerivedCalculationOperator;
      left: TraceDerivedNumericOperand;
      right: TraceDerivedNumericOperand;
    }>;

export const TRACE_DERIVED_CALCULATION_OPERATORS = Object.freeze([
  "add", "subtract", "multiply", "divide", "percent_change", "percent_of",
] as const);
export type TraceDerivedCalculationOperator = (typeof TRACE_DERIVED_CALCULATION_OPERATORS)[number];

/**
 * A bounded, deterministic presentation transform over immutable governed
 * source tables. It is emitted only by trusted runtime code after every source
 * reference has been validated; dashboard refreshes replay the sources and
 * apply this exact transform without invoking a model.
 */
export type TraceTableDerivationV1 = Readonly<{
  version: "derived_table_v1";
  sources: readonly Readonly<{
    tableEventId: string;
    resultId: string;
  }>[];
  columns: readonly Readonly<TraceTableColumn & {
    /** Dynamic pivot heading, for example a rolling week's date. */
    labelSource?: TraceDerivedSourceCell;
  }>[];
  rows: readonly Readonly<{
    cells: readonly Readonly<{
      columnKey: string;
      expression: TraceDerivedCellExpression;
    }>[];
  }>[];
}>;

export interface TraceTableEvent extends TraceEventBase {
  type: "table";
  caption: string;
  columns: readonly TraceTableColumn[];
  rows: readonly Readonly<Record<string, TraceCell>>[];
  /**
   * Aligned with `rows`; present only when rows are measures with mixed units
   * (a pivoted comparison). Renderers format each numeric cell by its row's
   * format instead of the column type. A null entry keeps the column type.
   */
  rowFormats?: readonly (TraceRowFormat | null)[];
  resultId: string;
  provenance: TraceProvenance;
  /** Answer tables render beside prose; evidence tables remain in the query trail. */
  presentation?: "evidence" | "answer";
  /**
   * Rendering hint. "financial_statement" marks a statement-shaped table
   * (section, line, one currency column per period — a P&L, balance sheet or
   * trial balance) so the dashboard renders it as an accountant's statement
   * (section groups, indented lines, ruled totals) instead of a data grid.
   */
  layout?: "financial_statement";
  /** Present only when trusted server code can safely replay this table. */
  dashboardReplay?: DashboardReplayRef;
  /** Present with `derived_v1`; the digest is carried by `dashboardReplay`. */
  dashboardDerivation?: TraceTableDerivationV1;
}

export interface TraceChartEvent extends TraceEventBase {
  type: "chart";
  caption: string;
  chartType: "bar" | "line";
  /** References a governed table result; chart events never carry invented data. */
  dataRef: string;
  xKey: string;
  yKey: string;
  series?: readonly Readonly<{
    key: string;
    label: string;
  }>[];
  /** Bar orientation requested by the turn; the renderer decides when absent. */
  orientation?: "vertical" | "horizontal";
  /** Bars only: stack the series (composition) instead of grouping them (comparison). */
  stacked?: boolean;
  /**
   * Trusted Flint compile target for the browser renderer. Never carries plot
   * rows; the client binds `dataRef`. Absent on historical chart events.
   */
  flint?: GroundedFlintSpec;
}

export interface TraceValidationEvent extends TraceEventBase {
  type: "validation";
  name: string;
  outcome: "passed" | "qualified" | "failed";
  detail: string;
}

/**
 * The model-resolved subject carried between completed turns. This is a
 * compact interpretation artifact, not a business fact or hidden reasoning.
 */
export type ResolvedConversationSubject = Readonly<{
  label: string;
  kind: string;
  resolvedQuestion: string;
}>;

/** Compact, size-bounded rendering of one owner-visible table for later turns. */
export type PresentedTableDigest = Readonly<{
  caption: string;
  /** Column labels in display order (bounded). */
  columns: readonly string[];
  /** Total rows the owner saw; `rows` may be a prefix sample. */
  rowCount: number;
  /** Cell values in `columns` order; strings, numbers or null. */
  rows: readonly (readonly (string | number | null)[])[];
}>;

/**
 * One headline stat card shown with the answer ("Key insights"): a governed
 * figure or two-word state, its owner-language label, and optional context.
 * Model-authored, host-validated — every numeric token grounds against
 * result cells before the card is emitted.
 */
export type AnswerKeyInsight = Readonly<{
  value: string;
  label: string;
  detail?: string;
  sentiment?: "positive" | "negative" | "neutral";
}>;

export interface TraceAnswerEvent extends TraceEventBase {
  type: "answer";
  state: AnswerState;
  text: string;
  provenance: TraceProvenance;
  followUps: readonly string[];
  /** Headline stat cards, present only when the analysis warrants them. */
  keyInsights?: readonly AnswerKeyInsight[];
  /** Persisted continuity state for a later anaphoric or elliptical follow-up. */
  resolvedSubject?: ResolvedConversationSubject;
  /** Results the lead explicitly selected for owner-visible tabular detail. */
  presentedResultIds?: readonly string[];
  /**
   * A bounded digest of the tables the owner saw with this answer (caption,
   * column labels, the first rows). Persisted so a later turn can resolve
   * "what subscriptions do we have?" to the Subscriptions line of the P&L it
   * just showed, instead of treating every follow-up as a fresh question.
   */
  presentedTables?: readonly PresentedTableDigest[];
  /** Server-validated cell associations retained in the immutable artefact. */
  claims?: readonly Readonly<{
    statement: string;
    assertion: "value" | "highest" | "lowest" | "greater_than" | "less_than" | "equal";
    refs: readonly Readonly<{ resultId: string; rowIndex: number; columnKey: string }>[];
  }>[];
}

export interface TraceClarificationEvent extends TraceEventBase {
  type: "clarification";
  question: string;
  options: readonly Readonly<{
    id: string;
    label: string;
  }>[];
}

/**
 * The Omni runtime's visible task checklist ("Tasks (1 of 4)"). Unlike the
 * strict evidence-backed `plan` contract, tasks are the agent's own working
 * list: each event carries the full current list and the latest one wins.
 * Completion is a claim by the runtime, clamped monotonic by the emitter.
 */
export interface TraceTasksEvent extends TraceEventBase {
  type: "tasks";
  items: readonly Readonly<{
    /** Stable within one turn. */
    id: string;
    label: string;
    completed: boolean;
  }>[];
}

/**
 * One completed research step card in the Omni runtime's trail: a semantic
 * model search, a field-value lookup, or a small trusted lookup. `document`
 * carries only governed semantic-model renderings (member names, types and
 * definitions as YAML) — the same class of content as `queryYaml` — never
 * raw provider output, SQL, or prompts.
 */
export interface TraceResearchEvent extends TraceEventBase {
  type: "research";
  tool: "search_model" | "value_lookup" | "docs" | "current_time";
  /** Card headline, e.g. "Look up refund fields in the Sales topic". */
  label: string;
  /** Right-aligned outcome, e.g. "98 fields found matching \"refund\"". */
  summary?: string;
  /** The search term or match pattern the step used. */
  query?: string;
  /** Governed markdown body (field definitions grouped by view, as YAML). */
  document?: string;
  /** Stored values a lookup matched, in match order. */
  values?: readonly string[];
  /** Owner-readable field label a value lookup ran against. */
  field?: string;
}

export interface TraceErrorEvent extends TraceEventBase {
  type: "error";
  message: string;
  recoverable: boolean;
}

/** Grid width steps a dashboard plan may request; the host maps them to columns. */
export const DASHBOARD_PLAN_WIDTHS = Object.freeze([
  "quarter", "third", "half", "twoThirds", "full",
] as const);
export type DashboardPlanWidth = (typeof DASHBOARD_PLAN_WIDTHS)[number];

/**
 * One tile of a composed dashboard plan. Every `resultId` must reference a
 * governed table the same turn executed successfully — the compose tool
 * enforces this before the event is emitted, and the apply route re-resolves
 * ids against the persisted trace, so a plan can never cite unexecuted data.
 */
export type TraceDashboardPlanTile = Readonly<{
  resultId: string;
  kind: "kpi" | "chart" | "table";
  title: string;
  /** Optional sub-caption, e.g. "vs previous 30 days". */
  note?: string;
  width: DashboardPlanWidth;
  /** KPI tiles: the column holding the headline value. */
  valueKey?: string;
  /** Chart tiles: grounded-flint configuration over the result's columns. */
  chartType?: "bar" | "line";
  xKey?: string;
  yKey?: string;
  series?: readonly Readonly<{ key: string; label: string }>[];
  stacked?: boolean;
  orientation?: "vertical" | "horizontal";
}>;

/**
 * The dashboard-architect turn's composed plan: which executed governed
 * results become tiles, with presentation and layout intent. Emitted at most
 * once per accepted composition (a later plan supersedes an earlier one).
 */
export interface TraceDashboardPlanEvent extends TraceEventBase {
  type: "dashboard_plan";
  dashboardTitle: string;
  /** The coherent window statement, e.g. "Last 30 days vs the previous 30". */
  timeframe: string;
  tiles: readonly TraceDashboardPlanTile[];
}

/**
 * Public execution events. There are intentionally no raw prompt, reasoning,
 * tool-argument, provider-payload, or SQL fields in this union.
 */
export type TraceEvent =
  | TraceProgressEvent
  | TraceNarrativeEvent
  | TracePlanEvent
  | TraceQueryEvent
  | TraceTableEvent
  | TraceChartEvent
  | TraceValidationEvent
  | TraceAnswerEvent
  | TraceClarificationEvent
  | TraceTasksEvent
  | TraceResearchEvent
  | TraceDashboardPlanEvent
  | TraceErrorEvent;

const forbiddenTraceKeys = new Set([
  "chainofthought",
  "compiledsql",
  "prompt",
  "rawproviderpayload",
  "rawreasoning",
  "rawtooloutput",
  "reasoning",
  "sql",
  "toolarguments",
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function assertNoForbiddenTraceKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenTraceKeys(item, `${path}[${index}]`));
    return;
  }

  if (!isRecord(value)) return;

  Object.entries(value).forEach(([key, child]) => {
    if (forbiddenTraceKeys.has(normalizedKey(key))) {
      throw new Error(`Unsafe trace field at ${path}.${key}`);
    }
    assertNoForbiddenTraceKeys(child, `${path}.${key}`);
  });
}

/** Control characters that must never reach a rendered surface. */
const controlCharacterPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Removes control characters and bounds user-visible trace copy. */
export function sanitizeTraceText(value: string, maxLength = 500): string {
  return value
    .replace(controlCharacterPattern, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/**
 * Bounds answer prose exactly as {@link sanitizeTraceText} bounds trace copy —
 * same control-character strip, same length cap — but keeps the line breaks.
 * An answer is markdown the reader sees rendered, and its block structure lives
 * entirely in the newlines: collapsing them turns a table into a row of loose
 * pipes and a list into one run-on sentence. Trace labels stay single-line;
 * only the narrative the business owner reads comes through here.
 */
export function sanitizeAnswerText(value: string, maxLength = 4_000): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(controlCharacterPattern, "")
    // Horizontal runs only. Leading indentation collapses with them so a list
    // or table row the model nudged inward still reads as one at the margin.
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

/**
 * Validates the transport invariant used by persistence and SSE streaming.
 * Sequences are contiguous so reconnecting clients can detect missing events.
 */
export function assertOrderedSanitizedTrace(
  events: readonly TraceEvent[],
): readonly TraceEvent[] {
  const ids = new Set<string>();
  const successfulResultIds = new Set<string>();
  let previousPlan: readonly TracePlanStep[] | undefined;

  events.forEach((event, index) => {
    const expectedSequence = index + 1;
    if (event.sequence !== expectedSequence) {
      throw new Error(
        `Trace sequence ${event.sequence} is out of order; expected ${expectedSequence}.`,
      );
    }
    if (!event.id || ids.has(event.id)) {
      throw new Error(`Trace event id must be unique: ${event.id || "<empty>"}.`);
    }
    if (Number.isNaN(Date.parse(event.occurredAt))) {
      throw new Error(`Trace event ${event.id} has an invalid occurredAt timestamp.`);
    }
    if ("progress" in event && event.progress !== undefined) {
      if (event.progress < 0 || event.progress > 1) {
        throw new Error(`Trace event ${event.id} has progress outside 0..1.`);
      }
    }
    if (event.type === "table" && event.status === "complete") {
      successfulResultIds.add(event.resultId);
    }
    if (event.type === "plan") {
      const stepIds = event.steps.map(({ id }) => id);
      if (stepIds.some((id) => !/^[a-z][a-z0-9_-]{2,47}$/u.test(id)) || new Set(stepIds).size !== stepIds.length) {
        throw new Error(`Trace plan ${event.id} has missing, invalid or duplicate step ids.`);
      }
      if (event.steps.filter(({ status }) => status === "active").length > 1) {
        throw new Error(`Trace plan ${event.id} has more than one active step.`);
      }
      for (const step of event.steps) {
        if (new Set(step.evidenceResultIds).size !== step.evidenceResultIds.length) {
          throw new Error(`Trace plan step ${step.id} has duplicate evidence references.`);
        }
        const unknown = step.evidenceResultIds.filter((resultId) => !successfulResultIds.has(resultId));
        if (unknown.length > 0) {
          throw new Error(`Trace plan step ${step.id} cites result evidence that was not emitted successfully first.`);
        }
        if (step.status === "done" && step.evidenceResultIds.length === 0) {
          throw new Error(`Trace plan step ${step.id} is done without result evidence.`);
        }
        if ((step.status === "blocked" || step.status === "incomplete") && !step.statusDetail?.trim()) {
          throw new Error(`Trace plan step ${step.id} is ${step.status} without an owner-safe reason.`);
        }
      }
      if (previousPlan) {
        if (previousPlan.length !== event.steps.length) {
          throw new Error(`Trace plan ${event.id} changed its step count.`);
        }
        event.steps.forEach((step, stepIndex) => {
          const previous = previousPlan![stepIndex]!;
          if (step.id !== previous.id || step.kind !== previous.kind) {
            throw new Error(`Trace plan ${event.id} changed stable step identity or order.`);
          }
          if (["done", "blocked", "incomplete"].includes(previous.status) && step.status !== previous.status) {
            throw new Error(`Trace plan step ${step.id} regressed from ${previous.status}.`);
          }
          if (previous.evidenceResultIds.some((resultId) => !step.evidenceResultIds.includes(resultId))) {
            throw new Error(`Trace plan step ${step.id} removed earlier evidence.`);
          }
        });
      }
      previousPlan = event.steps;
    }
    if (event.type === "answer" && previousPlan?.some(({ status }) => status === "pending" || status === "active")) {
      throw new Error(`Trace answer ${event.id} was emitted before the visible plan reached truthful terminal states.`);
    }

    ids.add(event.id);
    assertNoForbiddenTraceKeys(event, `trace[${index}]`);
  });

  return events;
}
