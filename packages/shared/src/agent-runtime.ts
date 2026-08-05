/**
 * Shared, transport-safe contracts for Albert's agent runtime.
 *
 * This module deliberately contains no provider SDK imports. It is safe to use
 * from the browser for rendering and from trusted services for validation.
 */

export const ALBERT_MODELS = [
  {
    id: "gpt-5.6-sol",
    label: "Sol",
    description: "Most capable",
    tier: "frontier",
  },
  {
    id: "gpt-5.6-terra",
    label: "Terra",
    description: "Best balance",
    tier: "balanced",
  },
  {
    id: "gpt-5.6-luna",
    label: "Luna",
    description: "Most efficient",
    tier: "efficient",
  },
] as const;

export type AlbertModelId = (typeof ALBERT_MODELS)[number]["id"];

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

export type AgentRunPreferences = Readonly<{
  model: AlbertModelId;
  reasoningEffort: ReasoningEffort;
  /** Fast mode is an independent processing tier, not a reasoning preset. */
  fastMode: boolean;
}>;

export const DEFAULT_AGENT_PREFERENCES: AgentRunPreferences = Object.freeze({
  model: "gpt-5.6-sol",
  reasoningEffort: "medium",
  fastMode: false,
});

const modelIds = new Set<string>(ALBERT_MODEL_IDS);
const reasoningEfforts = new Set<string>(REASONING_EFFORTS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAlbertModelId(value: unknown): value is AlbertModelId {
  return typeof value === "string" && modelIds.has(value);
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && reasoningEfforts.has(value);
}

/**
 * Normalizes untrusted UI input against the server-owned allowlist.
 * Unknown fields and values never flow into a provider request.
 */
export function normalizeAgentPreferences(input: unknown): AgentRunPreferences {
  const candidate = isRecord(input) ? input : {};

  return Object.freeze({
    model: isAlbertModelId(candidate.model)
      ? candidate.model
      : DEFAULT_AGENT_PREFERENCES.model,
    reasoningEffort: isReasoningEffort(candidate.reasoningEffort)
      ? candidate.reasoningEffort
      : DEFAULT_AGENT_PREFERENCES.reasoningEffort,
    fastMode:
      typeof candidate.fastMode === "boolean"
        ? candidate.fastMode
        : DEFAULT_AGENT_PREFERENCES.fastMode,
  });
}

export const ANSWER_STATES = [
  "Verified",
  "Qualified",
  "Exploratory",
  "Clarification",
  "Unavailable",
] as const;

export type AnswerState = (typeof ANSWER_STATES)[number];

export type TraceStatus = "pending" | "running" | "complete" | "warning" | "error";

export type TraceCell = string | number | null;

export type TraceTimeRange = Readonly<{
  label: string;
  start: string;
  end: string;
  timezone: string;
}>;

export type TraceProvenance = Readonly<{
  sources: readonly Readonly<{
    connector: "lightspeed" | "xero" | "deputy";
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
}

export type TraceTableColumn = Readonly<{
  key: string;
  label: string;
  type: "string" | "number" | "currency" | "percent" | "date" | "datetime";
  /** ISO-4217 code proven by query validation; omitted when the currency is unknown. */
  currency?: string;
}>;

export interface TraceTableEvent extends TraceEventBase {
  type: "table";
  caption: string;
  columns: readonly TraceTableColumn[];
  rows: readonly Readonly<Record<string, TraceCell>>[];
  resultId: string;
  provenance: TraceProvenance;
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

export interface TraceAnswerEvent extends TraceEventBase {
  type: "answer";
  state: AnswerState;
  text: string;
  provenance: TraceProvenance;
  followUps: readonly string[];
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

/** Removes control characters and bounds user-visible trace copy. */
export function sanitizeTraceText(value: string, maxLength = 500): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
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
