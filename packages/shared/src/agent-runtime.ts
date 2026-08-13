/**
 * Shared, transport-safe contracts for Albert's agent runtime.
 *
 * This module deliberately contains no provider SDK imports. It is safe to use
 * from the browser for rendering and from trusted services for validation.
 */

export const ALBERT_MODEL_PROVIDERS = ["openai", "xai"] as const;
export type AlbertModelProvider = (typeof ALBERT_MODEL_PROVIDERS)[number];

export const XAI_API_BASE_URL = "https://api.x.ai/v1";

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

export type AgentRunPreferences = Readonly<{
  model: AlbertModelId;
  reasoningEffort: ReasoningEffort;
  /** Fast mode is an independent processing tier, not a reasoning preset. */
  fastMode: boolean;
}>;

export const DEFAULT_AGENT_PREFERENCES: AgentRunPreferences = Object.freeze({
  model: "gpt-5.6-luna",
  reasoningEffort: "max",
  fastMode: false,
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

export function modelSupportsFastMode(id: AlbertModelId): boolean {
  return isAlbertModelId(id);
}

/**
 * Maps Albert Fast onto the provider `service_tier`. GPT uses OpenAI Fast.
 * Grok uses official xAI Priority Processing (`priority`), never `fast`.
 */
export function serviceTierForPreferences(
  preferences: AgentRunPreferences,
): "default" | "fast" | "priority" {
  if (!preferences.fastMode) return "default";
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
 * Resolves the Responses API endpoint for the selected model. GPT profiles
 * stay on the configured OpenAI base URL. Grok 4.6 uses the official xAI
 * endpoint and never reuses the OpenAI key or AU OpenAI host.
 */
export function resolveAlbertModelTransport(input: Readonly<{
  model: AlbertModelId;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  xaiApiKey?: string;
  xaiBaseUrl?: string;
}>): ResolvedAlbertModelTransport {
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

export type TraceProvenance = Readonly<{
  sources: readonly Readonly<{
    connector: TraceConnector;
    label: string;
    dataThrough: string;
  }>[];
  timeRange: TraceTimeRange;
  definitions: readonly Readonly<{
    metric: string;
    label: string;
    definition: string;
  }>[];
  semanticBundleHash: string;
  identityGraph: Readonly<{ version: number; hash: string }>;
  coverage?: readonly Readonly<{
    label: string;
    value: number;
    unit: "percent" | "records";
  }>[];
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
}

export interface TraceNarrativeEvent extends TraceEventBase {
  type: "narrative";
  text: string;
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
}

export type TraceTableColumn = Readonly<{
  key: string;
  label: string;
  type: "string" | "number" | "currency" | "percent" | "date" | "datetime";
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
      operator: "add" | "subtract" | "multiply" | "divide";
      left: TraceDerivedNumericOperand;
      right: TraceDerivedNumericOperand;
    }>;

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
  resultId: string;
  provenance: TraceProvenance;
  /** Answer tables render beside prose; evidence tables remain in the query trail. */
  presentation?: "evidence" | "answer";
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

export interface TraceAnswerEvent extends TraceEventBase {
  type: "answer";
  state: AnswerState;
  text: string;
  provenance: TraceProvenance;
  followUps: readonly string[];
  /** Persisted continuity state for a later anaphoric or elliptical follow-up. */
  resolvedSubject?: ResolvedConversationSubject;
  /** Results the lead explicitly selected for owner-visible tabular detail. */
  presentedResultIds?: readonly string[];
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

export interface TraceErrorEvent extends TraceEventBase {
  type: "error";
  message: string;
  recoverable: boolean;
}

/**
 * Public execution events. There are intentionally no raw prompt, reasoning,
 * tool-argument, provider-payload, or SQL fields in this union.
 */
export type TraceEvent =
  | TraceProgressEvent
  | TraceNarrativeEvent
  | TraceQueryEvent
  | TraceTableEvent
  | TraceChartEvent
  | TraceValidationEvent
  | TraceAnswerEvent
  | TraceClarificationEvent
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

    ids.add(event.id);
    assertNoForbiddenTraceKeys(event, `trace[${index}]`);
  });

  return events;
}
