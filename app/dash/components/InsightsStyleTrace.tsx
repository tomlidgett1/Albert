"use client";

import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type {
  AnswerKeyInsight,
  AnswerState,
  TraceChartEvent,
  TraceEvent,
  TracePlanEvent,
  TraceProgressStage,
  TraceProvenance,
  TraceTableEvent,
} from "@/packages/shared/src";
import { CONNECTOR_LOGOS, CONNECTOR_NAMES, type TraceConnectorId } from "./connectors";
import { GovernedResultGrid } from "./GovernedResultGrid";
import {
  parseSafeAnswerLineage,
  type SafeAnswerLineage,
  type TurnLineageReference,
} from "./answer-lineage";
import { responseVisibleResultIds } from "../lib/answer-presentation";
import { latestReasoningSummary } from "../lib/reasoning-summary";
import {
  renderAssistantMarkdown,
  splitAssistantMarkdownLead,
} from "../lib/render-assistant-markdown";
import styles from "./insights-trace.module.css";

const ResultChart = lazy(() => import("./AnalyticalTrace").then((module) => ({
  default: module.ResultChart,
})));

type TrailSource = TraceProvenance["sources"][number];

/** Small logo + name chip identifying the tool a query drew its data from. */
function ToolChip({ connector }: { connector: TrailSource["connector"] }) {
  return (
    <span className={styles.toolChip} title={`Data from ${CONNECTOR_NAMES[connector]}`}>
      <Image
        src={CONNECTOR_LOGOS[connector]}
        alt=""
        width={12}
        height={12}
        unoptimized
      />
      <span>{CONNECTOR_NAMES[connector]}</span>
    </span>
  );
}

type InsightsStyleTraceProps = {
  events: readonly TraceEvent[];
  streaming?: boolean;
  detailedMode?: boolean;
  runtime?: "fixture" | "openai" | "anthropic" | "cubecore" | "v3" | "xero_mcp" | "codex" | "omni" | "compare";
  lineageReference?: TurnLineageReference;
  onFollowUp?: (prompt: string) => void;
  onAddToChat?: (text: string) => void;
  onAddToDashboard?: (table: TraceTableEvent) => Promise<void>;
  onClarification?: (label: string, optionId: string) => void;
};

type AuditReceiptState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; lineage: SafeAnswerLineage }>
  | Readonly<{ kind: "error"; message: string }>;

type TrailStepStatus = "running" | "done" | "error" | "incomplete";

type TrailStep = Readonly<{
  id: string;
  kind: "sql" | "tool";
  /** Governed work this step represents; lets a result event settle its own step. */
  stage?: TraceProgressStage;
  title: string;
  detail?: string;
  /** What a research step found (matched views, stored values, definitions read). */
  findings?: readonly string[];
  status: TrailStepStatus;
  rowCount?: number;
  warnings?: readonly string[];
  error?: string;
  table?: TraceTableEvent;
  chart?: Readonly<{
    event: TraceChartEvent;
    table?: TraceTableEvent;
  }>;
  governed?: Readonly<{
    topic: string;
    metrics: readonly string[];
    dimensions: readonly string[];
    lens: string;
    timeRangeLabel: string;
    /** Albert v3 Cube transparency: the exact governed query and its target. */
    view?: string;
    cubes?: readonly string[];
    queryYaml?: string;
    executionMs?: number;
    /** Which tool the queried view draws its data from. */
    connector?: TrailSource["connector"];
  }>;
}>;

type TraceEntry =
  | Readonly<{ id: string; type: "commentary"; content: string }>
  | Readonly<{ id: string; type: "step"; stepId: string }>;

type TrailCommentaryUpdate = Readonly<{
  id: string;
  text: string;
}>;

type TrailModel = Readonly<{
  steps: readonly TrailStep[];
  /** Provider-authored public summary; never raw reasoning tokens. */
  reasoningSummary: string;
  reasoning: string;
  status: string;
  /** The substance behind `status` — what the current step is actually reading. */
  statusDetail: string;
  /** Progress stage for the current work (steps); not used for generic header copy. */
  statusStage?: TraceProgressStage;
  /** Sticky question-contextual header theme from the analysis plan summary. */
  statusTheme?: string;
  answer?: Readonly<{ state: AnswerState; text: string; followUps: readonly string[]; keyInsights: readonly AnswerKeyInsight[] }>;
  clarification?: Readonly<{ question: string; options: readonly Readonly<{ id: string; label: string }>[] }>;
  error?: Readonly<{ message: string; recoverable: boolean }>;
  /** User or navigation stop; shown discreetly, not as a retry error. */
  stopped?: boolean;
  /** First event timestamp; used for a live Cursor-style elapsed clock while streaming. */
  startedAtMs: number | null;
  /** Unique connectors used in this turn (from table/answer provenance). */
  sources: readonly TrailSource[];
  /** Cubecore YAML models + governance flag from answer provenance (test mode). */
  cubecoreMeta?: Readonly<{
    yamlFiles: readonly string[];
    governed: boolean;
    governedNote: string;
  }>;
  stats: Readonly<{
    stepCount: number;
    tableCount: number;
    durationMs: number;
    runtimeLabel: string;
  }>;
  /** Sparse, owner-facing plan and finding updates shown only while work runs. */
  commentaryUpdates: readonly TrailCommentaryUpdate[];
  /** Pre-evidence response rendered in its own slot above the planning shimmer. */
  initialAcknowledgement?: TrailCommentaryUpdate;
  /** Latest visible working plan; steps tick off as the agent progresses. */
  plan?: TracePlanEvent;
  trace: readonly TraceEntry[];
  governedQueries: readonly NonNullable<TrailStep["governed"]>[];
  charts: readonly Readonly<{
    event: TraceChartEvent;
    table?: TraceTableEvent;
  }>[];
  /** Structured, replayable tables intentionally composed for the final answer. */
  answerTables: readonly TraceTableEvent[];
}>;

function isStopMessage(message: string): boolean {
  return message === "Stopped."
    || message === "Stopped"
    || message === "This analysis was interrupted.";
}

const answerStateDescriptions = {
  Verified: "Checked against governed evidence",
  Derived: "Calculated deterministically from governed results",
  Qualified: "Useful answer, with a limitation noted below",
  Exploratory: "From your live Lightspeed or Xero data",
  Clarification: "Albert needs one quick choice before continuing",
  "No data": "The valid question returned no matching records",
  Unavailable: "The required data is not available yet",
} as const;

const answerStateLabels = {
  Verified: "Checked",
  Derived: "Calculated",
  Qualified: "With a note",
  Exploratory: "From your live data",
  Clarification: "Needs a choice",
  "No data": "No matching data",
  Unavailable: "Can't answer yet",
} as const;

function cleanReasoningSummary(value: string): string {
  return value
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .trim();
}

function conciseReasoningSummary(value: string): string {
  let concise = cleanReasoningSummary(value).replace(/\s+/g, " ").trim();
  if (!concise) return "";
  const firstSentence = concise.match(/^.*?[.!?](?=\s|$)/)?.[0];
  if (firstSentence) concise = firstSentence.trim();
  concise = concise
    .replace(/^The (?:user|store owner) (?:is asking|asked|wants)(?: us)? to\s+/i, "")
    .replace(/^(?:We|I)\s+(?:now\s+)?(?:need|have|want|plan|should|will|can)\s+to\s+/i, "")
    .replace(/^(?:We|I)(?:'m| am|'re| are)\s+/i, "")
    .trim();
  return concise ? concise.charAt(0).toUpperCase() + concise.slice(1) : "";
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

/**
 * Specific step-line copy for the expanded trail.
 * Prefers concrete purpose detail over the generic stage label.
 */
export function laymanProgressStatus(label: string, detail = ""): string {
  const stage = label.trim();
  const purpose = detail.trim().replace(/\.+$/u, "");
  const softStage = stage
    .replace(/^Understanding the question$/iu, "Working out what you're asking")
    .replace(/^Running SQL(?: with governed claims)?$/iu, "Looking up your numbers")
    .replace(/^Running an exploratory query$/iu, "Looking up your numbers")
    .replace(/^SQL query failed$/iu, "That lookup did not work")
    .replace(/^Analysing\b/iu, "Looking at")
    .replace(/^Querying\b/iu, "Looking up")
    .replace(/^Exploring\b/iu, "Looking through");

  // Member lists ("sales_analytics.gross_takings, …") and snake_case view names
  // are audit detail, not owner copy: keep the softened label instead.
  const looksTechnical = /SQL|governed|allowlisted|intent to available|tenant|staging|lint/iu.test(purpose)
    || /\b[a-z][a-z0-9]*_[a-z0-9_]*\.[a-z][a-z0-9_]*\b/u.test(purpose)
    || /^[a-z0-9_]+(?:,\s*[a-z0-9_]+)+$/u.test(purpose);
  if (purpose && !looksTechnical && (/^Looking up your numbers$/iu.test(softStage) || purpose.length >= softStage.length)) {
    return purpose.charAt(0).toUpperCase() + purpose.slice(1);
  }
  return softStage || "Working on it";
}

const GENERIC_OWNER_THEMES = /^(Working out what you need|Working on it|Thinking|Planning your answer|Looking up your numbers|Looking up your people|Reading your setup|Checking your (?:catalogue|data)|Matching names|Understanding your question|Planning the governed analysis)$/iu;

/** Owner-facing theme candidates from plan summaries / narrative. */
function cleanOwnerTheme(value: string): string {
  const trimmed = value.trim().replace(/\.+$/u, "");
  if (!trimmed || trimmed.length > 72) return "";
  if (GENERIC_OWNER_THEMES.test(trimmed)) return "";
  if (/SQL|governed|allowlisted|tenant|staging|schema|CTE|GROUP BY/iu.test(trimmed)) return "";
  if (/^Answer ready$|^Waiting for one detail$|^Stopped$|^Loaded \d+/iu.test(trimmed)) return "";
  if (/^Running (?:SQL|an exploratory)/iu.test(trimmed)) return "";
  if (/^Analysing\b|^Querying\b|^Exploring\b/iu.test(trimmed)) return "";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * Latest owner-facing header line. Prefers the newest clean progress copy so
 * the shimmer can move with the work; the plan theme is the fallback.
 */
export function highLevelProgressTheme(input: {
  theme?: string;
  stage?: TraceProgressStage;
  label: string;
  detail?: string;
}): string {
  const label = input.label.trim();
  if (/Waiting for one detail/iu.test(label)) return "Needs one detail";
  if (/Stopped|Albert can retry|Analysis stopped/iu.test(label)) return label;

  const fromLabel = cleanOwnerTheme(label);
  if (fromLabel) return fromLabel;

  const fromDetail = cleanOwnerTheme(input.detail ?? "");
  if (fromDetail) return fromDetail;

  if (input.theme) return input.theme;

  return "Working on it";
}

const SHIMMER_FILLERS = [
  "Working through this",
  "Checking the figures",
  "Looking through your data",
  "Narrowing this down",
  "Cross-checking the numbers",
  "Following the strongest signal",
  "Making sense of the movement",
  "Pulling the latest figures",
  "Seeing what stands out",
  "Checking another angle",
] as const;

const CONNECTOR_HINTS: readonly Readonly<{
  connector: TraceConnectorId;
  pattern: RegExp;
}>[] = [
  { connector: "lightspeed-x", pattern: /\blightspeed[\s_-]*x(?:[\s_-]*series)?\b|\bx-series\b|\blightspeed_x\b/iu },
  { connector: "lightspeed", pattern: /\blightspeed\b/iu },
  { connector: "meta-ads", pattern: /\bmeta(?:[\s_-]*ads)?\b/iu },
  { connector: "google-ads", pattern: /\bgoogle[\s_-]*ads\b/iu },
  { connector: "shopify", pattern: /\bshopify\b/iu },
  { connector: "xero", pattern: /\bxero\b/iu },
  { connector: "deputy", pattern: /\bdeputy\b/iu },
  { connector: "square", pattern: /\bsquare\b/iu },
  { connector: "stripe", pattern: /\bstripe\b/iu },
  { connector: "momence", pattern: /\bmomence\b/iu },
];

const VIEW_PREFIXES: readonly (readonly [string, TraceConnectorId])[] = [
  ["lightspeed_x_", "lightspeed-x"],
  ["lightspeed_r_", "lightspeed"],
  ["lightspeed_", "lightspeed"],
  ["xero_", "xero"],
  ["shopify_", "shopify"],
  ["square_", "square"],
  ["deputy_", "deputy"],
  ["stripe_", "stripe"],
  ["momence_", "momence"],
  ["meta_ads_", "meta-ads"],
  ["google_ads_", "google-ads"],
];

export type ProgressShimmerActivity = "query" | "catalogue" | "research" | "planning";

export type ProgressShimmerLine = Readonly<{
  id: string;
  text: string;
  connectors: readonly TraceConnectorId[];
}>;

const SHIMMER_HOLD_MS: Readonly<Record<ProgressShimmerActivity, readonly [number, number]>> = {
  query: [1000, 1700],
  catalogue: [1800, 2500],
  research: [1800, 2500],
  planning: [2600, 3400],
};

/** Keep rotation candidates short and owner-facing, including soft working lines. */
function acceptShimmerPhrase(value: string): string {
  const trimmed = value.trim().replace(/\.+$/u, "");
  if (!trimmed || trimmed.length > 72) return "";
  if (/SQL|governed|allowlisted|tenant|staging|schema|CTE|GROUP BY/iu.test(trimmed)) return "";
  if (/^Answer ready$|^Waiting for one detail$|^Stopped$|^Loaded \d+/iu.test(trimmed)) return "";
  if (/^Running (?:SQL|an exploratory)/iu.test(trimmed)) return "";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function pickShimmerFillers(count = 3, random = Math.random): string[] {
  const pool = [...SHIMMER_FILLERS];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const current = pool[index]!;
    pool[index] = pool[swap]!;
    pool[swap] = current;
  }
  return pool.slice(0, Math.max(1, Math.min(count, pool.length)));
}

export function inferConnectorsFromText(value: string): TraceConnectorId[] {
  const found: TraceConnectorId[] = [];
  const add = (connector: TraceConnectorId) => {
    if (!found.includes(connector)) found.push(connector);
  };
  const text = value.trim();
  if (!text) return found;
  const lower = text.toLocaleLowerCase("en-AU");
  for (const [prefix, connector] of VIEW_PREFIXES) {
    if (lower.includes(prefix)) add(connector);
  }
  for (const hint of CONNECTOR_HINTS) {
    if (hint.connector === "lightspeed" && found.includes("lightspeed-x")) continue;
    if (hint.pattern.test(text)) add(hint.connector);
  }
  return found;
}

export function formatToolNames(connectors: readonly TraceConnectorId[]): string {
  const names = connectors.map((connector) => CONNECTOR_NAMES[connector]);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function formatCheckingTools(connectors: readonly TraceConnectorId[]): string {
  const names = formatToolNames(connectors);
  return names ? `Checking ${names}` : "Checking your tools";
}

function textShimmerLine(text: string): ProgressShimmerLine | null {
  const phrase = acceptShimmerPhrase(text);
  if (!phrase) return null;
  return { id: `text:${phrase.toLocaleLowerCase("en-AU")}`, text: phrase, connectors: [] };
}

function toolsShimmerLine(connectors: readonly TraceConnectorId[]): ProgressShimmerLine | null {
  if (connectors.length === 0) return null;
  return {
    id: `tools:${connectors.join(",")}`,
    text: formatCheckingTools(connectors),
    connectors,
  };
}

export function collectShimmerConnectors(input: {
  status: string;
  statusDetail?: string;
  sources?: readonly TrailSource[];
  steps: readonly Pick<TrailStep, "title" | "detail" | "status" | "governed">[];
}): TraceConnectorId[] {
  const found: TraceConnectorId[] = [];
  const add = (connector: TraceConnectorId | undefined) => {
    if (!connector || found.includes(connector)) return;
    found.push(connector);
  };
  for (const source of input.sources ?? []) add(source.connector);
  for (const step of input.steps) {
    add(step.governed?.connector);
    for (const connector of inferConnectorsFromText(
      `${step.title} ${step.detail ?? ""} ${step.governed?.view ?? ""} ${(step.governed?.cubes ?? []).join(" ")}`,
    )) {
      add(connector);
    }
  }
  for (const connector of inferConnectorsFromText(`${input.status} ${input.statusDetail ?? ""}`)) {
    add(connector);
  }
  return found;
}

export function shimmerActivityFor(input: {
  statusStage?: TraceProgressStage;
  steps: readonly Pick<TrailStep, "status" | "stage" | "kind">[];
}): ProgressShimmerActivity {
  const running = input.steps.filter((step) => step.status === "running");
  if (running.some((step) => step.kind === "sql" || step.stage === "query" || step.stage === "source_query")) {
    return "query";
  }
  if (input.statusStage === "query" || input.statusStage === "source_query") return "query";
  if (input.statusStage === "research") return "research";
  if (input.statusStage === "catalogue" || input.statusStage === "definition") return "catalogue";
  if (running.some((step) => step.stage === "research")) return "research";
  if (running.length > 0) return "catalogue";
  return "planning";
}

/** Hold time follows the work: lookups stay short, thinking can sit for ~3s. */
export function nextProgressShimmerDelayMs(
  activity: ProgressShimmerActivity = "planning",
  random = Math.random,
): number {
  const [min, max] = SHIMMER_HOLD_MS[activity];
  return Math.round(min + random() * (max - min));
}

export function pickNextProgressShimmerLine(
  pool: readonly ProgressShimmerLine[],
  currentId: string,
  random = Math.random,
): ProgressShimmerLine {
  const options = pool.filter((line) => line.id !== currentId);
  if (options.length === 0) {
    return pool[0] ?? { id: "text:working on it", text: "Working on it", connectors: [] };
  }
  return options[Math.floor(random() * options.length)] ?? options[0]!;
}

export function liveProgressShimmerLine(input: {
  status: string;
  statusDetail?: string;
  statusStage?: TraceProgressStage;
  sources?: readonly TrailSource[];
  steps: readonly Pick<TrailStep, "title" | "detail" | "status" | "stage" | "kind" | "governed">[];
}): ProgressShimmerLine {
  const running = input.steps.filter((step) => step.status === "running");
  const runningConnectors = collectShimmerConnectors({
    status: input.status,
    statusDetail: input.statusDetail,
    sources: input.sources,
    steps: running,
  });
  const tools = toolsShimmerLine(runningConnectors);
  if (tools) return tools;

  const allConnectors = collectShimmerConnectors(input);
  if (
    allConnectors.length > 0
    && (input.statusStage === "query" || input.statusStage === "source_query")
  ) {
    return toolsShimmerLine(allConnectors) ?? textShimmerLine(input.status) ?? {
      id: "text:working on it",
      text: "Working on it",
      connectors: [],
    };
  }

  return textShimmerLine(input.status) ?? {
    id: "text:working on it",
    text: "Working on it",
    connectors: [],
  };
}

export function collectProgressShimmerLines(input: {
  theme?: string;
  status: string;
  statusDetail?: string;
  statusStage?: TraceProgressStage;
  sources?: readonly TrailSource[];
  steps: readonly Pick<TrailStep, "title" | "detail" | "status" | "stage" | "kind" | "governed">[];
  commentary: readonly string[];
  planLabels?: readonly string[];
  fillers?: readonly string[];
}): ProgressShimmerLine[] {
  const lines: ProgressShimmerLine[] = [];
  const seen = new Set<string>();
  const push = (line: ProgressShimmerLine | null) => {
    if (!line || seen.has(line.id)) return;
    seen.add(line.id);
    lines.push(line);
  };

  push(liveProgressShimmerLine(input));
  push(toolsShimmerLine(collectShimmerConnectors(input)));
  push(textShimmerLine(input.status));
  push(textShimmerLine(input.statusDetail ?? ""));
  push(textShimmerLine(input.theme ?? ""));
  for (const step of input.steps.slice(-5)) {
    push(textShimmerLine(laymanProgressStatus(step.title, step.detail ?? "")));
    push(textShimmerLine(step.title));
    push(textShimmerLine(step.detail ?? ""));
  }
  for (const text of input.commentary.slice(-3)) {
    push(textShimmerLine(conciseReasoningSummary(text)));
  }
  for (const label of (input.planLabels ?? []).slice(-4)) {
    push(textShimmerLine(label));
  }
  if (lines.length < 3) {
    for (const filler of input.fillers ?? []) {
      push(textShimmerLine(filler));
    }
  }
  return lines;
}

export function buildTrailModel(
  events: readonly TraceEvent[],
  streaming: boolean,
  runtime: "fixture" | "openai" | "anthropic" | "cubecore" | "v3" | "xero_mcp" | "codex" | "omni" | "compare",
): TrailModel {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const visibleResultIds = responseVisibleResultIds(ordered);
  const steps: TrailStep[] = [];
  const commentary: string[] = [];
  let reasoningSummary = cleanReasoningSummary(latestReasoningSummary(ordered));
  const commentaryUpdates: TrailCommentaryUpdate[] = [];
  const trace: TraceEntry[] = [];
  const answerTables: TraceTableEvent[] = [];
  const tablesByResultId = new Map<string, TraceTableEvent>();
  const warningsByStep = new Map<string, string[]>();
  let answer: TrailModel["answer"];
  let clarification: TrailModel["clarification"];
  let error: TrailModel["error"];
  let cubecoreMeta: TrailModel["cubecoreMeta"];
  let plan: TracePlanEvent | undefined;
  let initialAcknowledgement: TrailCommentaryUpdate | undefined;
  let stopped = false;
  let status = streaming ? "Thinking" : "How this was worked out";
  let statusDetail = "";
  let statusStage: TraceProgressStage | undefined;
  /** Sticky question theme from update_analysis_plan / intent summary. */
  let statusTheme = "";
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  const sourcesByConnector = new Map<TrailSource["connector"], TrailSource>();

  const rememberSources = (provenance: TraceProvenance | undefined) => {
    for (const source of provenance?.sources ?? []) {
      sourcesByConnector.set(source.connector, source);
    }
  };

  const pushStep = (step: TrailStep) => {
    steps.push(step);
    trace.push({ id: `step_${step.id}`, type: "step", stepId: step.id });
  };

  /** Finds the step a later event should settle, newest first. */
  const lastStepIndex = (match: (step: TrailStep) => boolean): number => {
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index];
      if (step && match(step)) return index;
    }
    return -1;
  };

  for (const event of ordered) {
    const occurred = Date.parse(event.occurredAt);
    if (Number.isFinite(occurred)) {
      startedAt ??= occurred;
      endedAt = occurred;
    }

    if (event.type === "progress") {
      status = event.label;
      statusDetail = event.detail ?? "";
      statusStage = event.stage;
      {
        // Prefer plan summaries; otherwise first concrete purpose (never generics).
        const theme = cleanOwnerTheme(event.label) || cleanOwnerTheme(event.detail ?? "");
        if (theme && (event.stage === "planning" || !statusTheme)) {
          statusTheme = theme;
        }
      }
      const running = streaming && event.status !== "complete";
      const nextStatus: TrailStepStatus = event.status === "error" ? "error" : running ? "running" : "done";
      // A settling step reports the outcome of work already on screen, so it
      // replaces its own opening step instead of listing a second row. Only a
      // step that is still running can be settled: a completed lookup must
      // never be overwritten by the next one, or the trail under-reports work
      // ("Found views for B" silently replacing "Found views for A").
      const settles = event.status === "complete" || event.status === "error";
      const openIndex = settles && event.stage
        ? lastStepIndex((step) => step.stage === event.stage && step.status === "running")
        : -1;
      const open = openIndex >= 0 ? steps[openIndex] : undefined;
      if (open) {
        steps[openIndex] = {
          ...open,
          title: event.label,
          detail: event.detail ?? open.detail,
          ...(event.findings ? { findings: event.findings } : {}),
          status: nextStatus,
        };
        continue;
      }
      pushStep({
        id: event.id,
        kind: "tool",
        stage: event.stage,
        title: event.label,
        ...(event.detail ? { detail: event.detail } : {}),
        ...(event.findings ? { findings: event.findings } : {}),
        status: nextStatus,
      });
      continue;
    }

    if (event.type === "plan") {
      // Each plan event carries the full current list; the latest wins.
      plan = event;
      continue;
    }

    if (event.type === "narrative") {
      const cleaned = cleanReasoningSummary(event.text);
      if (event.purpose === "acknowledgement") {
        if (cleaned && !initialAcknowledgement) {
          initialAcknowledgement = { id: event.id, text: cleaned };
        }
        continue;
      }
      if (event.purpose === "reasoning_summary") {
        if (cleaned) reasoningSummary = cleaned;
        continue;
      }
      if (cleaned) {
        commentary.push(cleaned);
        commentaryUpdates.push({ id: event.id, text: cleaned });
      }
      const summary = conciseReasoningSummary(event.text);
      if (summary) {
        status = summary;
        statusDetail = "";
        if (!statusTheme) {
          const theme = cleanOwnerTheme(summary);
          if (theme) statusTheme = theme;
        }
      }
      trace.push({ id: `commentary_${event.id}`, type: "commentary", content: event.text });
      continue;
    }

    if (event.type === "query") {
      const governed = {
        topic: event.topic,
        metrics: event.metrics,
        dimensions: event.dimensions,
        lens: event.lens,
        timeRangeLabel: event.timeRange.label,
        ...(event.view ? { view: event.view } : {}),
        ...(event.cubesUsed?.length ? { cubes: event.cubesUsed } : {}),
        ...(event.queryYaml ? { queryYaml: event.queryYaml } : {}),
        ...(typeof event.executionMs === "number" ? { executionMs: event.executionMs } : {}),
        ...(event.connector ? { connector: event.connector } : {}),
      };
      const queryStatus: TrailStepStatus = streaming && event.status !== "complete" ? "running" : "done";
      const fallbackDetail = [event.lens, event.timeRange.label].filter(Boolean).join(" · ");
      // The step that announced this query already carries its metrics,
      // dimensions, and period; upgrade it in place rather than duplicating it.
      // Parallel queries can complete out of announcement order, so match on
      // shared member names first and only fall back to the most recent open step.
      const members = [...event.metrics, ...event.dimensions].map((name) => name.toLowerCase());
      let openIndex = -1;
      let bestOverlap = 0;
      for (let index = steps.length - 1; index >= 0; index -= 1) {
        const step = steps[index];
        if (!step || (step.stage !== "query" && step.stage !== "source_query") || step.governed) continue;
        if (openIndex === -1) openIndex = index;
        const detail = (step.detail ?? "").toLowerCase();
        const overlap = members.filter((member) => detail.includes(member)).length;
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          openIndex = index;
        }
      }
      const open = openIndex >= 0 ? steps[openIndex] : undefined;
      status = `Analysing ${humanize(event.topic)}`;
      statusDetail = open?.detail ?? fallbackDetail;
      statusStage = "query";
      if (open) {
        steps[openIndex] = {
          ...open,
          kind: "sql",
          title: humanize(event.topic),
          detail: open.detail ?? fallbackDetail,
          status: queryStatus,
          governed,
        };
        continue;
      }
      pushStep({
        id: event.id,
        kind: "sql",
        title: humanize(event.topic),
        detail: fallbackDetail,
        status: queryStatus,
        governed,
      });
      continue;
    }

    if (event.type === "table") {
      tablesByResultId.set(event.resultId, event);
      status = event.caption;
      statusDetail = `${event.rows.length.toLocaleString()} governed row${event.rows.length === 1 ? "" : "s"} · ${event.columns.length} column${event.columns.length === 1 ? "" : "s"}`;
      statusStage = statusStage ?? "query";
      rememberSources(event.provenance);
      const exposeTable = !visibleResultIds || visibleResultIds.has(event.resultId);
      if (event.presentation === "answer") {
        if (exposeTable) answerTables.push(event);
        continue;
      }
      // Parallel queries can interleave events, so pair the table with the sql
      // step for the same topic before falling back to the most recent one.
      const unsettled = [...steps].reverse().filter((step) =>
        step.kind === "sql" && typeof step.rowCount !== "number");
      const previous = unsettled.find((step) => step.governed?.topic === event.caption) ?? unsettled[0];
      if (previous) {
        const index = steps.findIndex((step) => step.id === previous.id);
        steps[index] = {
          ...previous,
          status: "done",
          rowCount: event.rows.length,
          ...(exposeTable ? { table: event } : {}),
          title: previous.title || event.caption,
        };
      } else {
        pushStep({
          id: event.id,
          kind: "sql",
          title: event.caption,
          status: "done",
          rowCount: event.rows.length,
          ...(exposeTable ? { table: event } : {}),
        });
      }
      continue;
    }

    if (event.type === "chart") {
      const table = tablesByResultId.get(event.dataRef)
        ?? [...steps]
          .reverse()
          .find((step) => step.table?.resultId === event.dataRef)
          ?.table;
      status = event.caption;
      statusDetail = `${event.chartType} chart`;
      statusStage = undefined;
      pushStep({
        id: event.id,
        kind: "tool",
        title: event.caption,
        status: "done",
        detail: `${event.chartType} chart`,
        chart: { event, ...(table ? { table } : {}) },
      });
      continue;
    }

    if (event.type === "validation") {
      // Passed lint/RLS and soft presentation repairs stay off the owner trail.
      if (event.outcome === "passed") continue;
      const target = steps.at(-1);
      if (target) {
        if (event.outcome === "failed") {
          const index = steps.findIndex((step) => step.id === target.id);
          steps[index] = { ...target, status: "error", error: event.detail };
        } else if (event.name === "numeric_grounding") {
          const list = warningsByStep.get(target.id) ?? [];
          list.push(event.detail);
          warningsByStep.set(target.id, list);
        }
      }
      continue;
    }

    if (event.type === "answer") {
      answer = {
        state: event.state,
        text: event.text,
        followUps: event.followUps,
        keyInsights: event.keyInsights ?? [],
      };
      rememberSources(event.provenance);
      const yamlFiles = event.provenance.definitions
        .filter((definition) => definition.metric.startsWith("cube.yaml:"))
        .map((definition) => definition.label || definition.metric.replace(/^cube\.yaml:/u, "").split("/").pop() || definition.metric);
      const governance = event.provenance.definitions.find((definition) =>
        definition.metric === "cubecore.governance"
        || /^Governed|Ungoverned/iu.test(definition.label));
      if (yamlFiles.length > 0 || governance) {
        const governed = Boolean(
          governance
            ? !/ungoverned/iu.test(`${governance.label} ${governance.definition}`)
            : false,
        );
        cubecoreMeta = {
          yamlFiles,
          governed,
          governedNote: governance?.definition
            || event.provenance.definitions.find((definition) => definition.metric.startsWith("cube.yaml:"))?.definition
            || "Cubecore test model.",
        };
      }
      status = "Answer ready";
      statusDetail = "";
      statusStage = undefined;
      continue;
    }

    if (event.type === "clarification") {
      clarification = { question: event.question, options: event.options };
      status = "Waiting for one detail";
      statusDetail = event.question;
      statusStage = undefined;
      continue;
    }

    if (event.type === "error") {
      if (isStopMessage(event.message)) {
        stopped = true;
        status = "Stopped";
        statusDetail = "";
        const target = steps.at(-1);
        if (target && target.status === "running") {
          const index = steps.findIndex((step) => step.id === target.id);
          steps[index] = { ...target, status: "incomplete" };
        }
        continue;
      }
      error = { message: event.message, recoverable: event.recoverable };
      status = "Chat failed";
      statusDetail = event.message;
      const target = steps.at(-1);
      if (target && target.status === "running") {
        const index = steps.findIndex((step) => step.id === target.id);
        steps[index] = { ...target, status: "error", error: event.message };
      }
    }
  }

  const withWarnings = steps.map((step) => {
    const warnings = warningsByStep.get(step.id);
    return warnings?.length ? { ...step, warnings } : step;
  });

  // Mark earlier running steps complete once a later event arrives.
  const normalised: TrailStep[] = withWarnings.map((step, index) => {
    if (step.status !== "running") return step;
    const laterDone = withWarnings.slice(index + 1).some((candidate) => candidate.status !== "running");
    if (!streaming || laterDone || answer || clarification || error || stopped) {
      const nextStatus: TrailStepStatus = step.error ? "error" : stopped ? "incomplete" : "done";
      return { ...step, status: nextStatus };
    }
    return step;
  });

  const durationMs = startedAt !== undefined && endedAt !== undefined
    ? Math.max(0, endedAt - startedAt)
    : 0;
  const displayPlan = plan && !streaming && (stopped || error)
    ? {
        ...plan,
        status: "warning" as const,
        steps: plan.steps.map((step) => (
          step.status === "active" || step.status === "pending"
            ? {
                ...step,
                status: "incomplete" as const,
                statusDetail: stopped
                  ? "This step stopped before completion."
                  : "This step ended before completion.",
              }
            : step
        )),
      }
    : plan;

  return {
    steps: normalised,
    reasoningSummary,
    reasoning: commentary.join("\n\n"),
    status,
    statusDetail,
    statusStage,
    statusTheme: statusTheme || undefined,
    answer,
    clarification,
    error,
    stopped,
    startedAtMs: startedAt ?? null,
    sources: [...sourcesByConnector.values()],
    cubecoreMeta,
    stats: {
      stepCount: normalised.length,
      tableCount: normalised.filter((step) => step.table).length,
      durationMs,
      runtimeLabel: runtime === "fixture"
        ? "Fixture"
        : runtime === "codex"
          ? "Codex"
        : runtime === "omni"
          ? "Omni"
        : runtime === "compare"
          ? "Compare"
        : runtime === "anthropic"
          ? "Claude Opus 5"
          : runtime === "cubecore"
            ? "Cubecore"
            : runtime === "v3"
              ? "Albert v3"
              : runtime === "xero_mcp"
                ? "Xero MCP"
                : "OpenAI",
    },
    commentaryUpdates,
    initialAcknowledgement,
    plan: displayPlan,
    trace,
    governedQueries: normalised
      .map((step) => step.governed)
      .filter((query): query is NonNullable<TrailStep["governed"]> => Boolean(query)),
    charts: normalised.flatMap((step) => step.chart?.table ? [step.chart] : []),
    answerTables,
  };
}

/** Codex-style visible plan: short steps that tick off as work completes. */
function PlanChecklist({
  plan,
  animateIn = false,
  reduceMotion = false,
}: {
  plan: TracePlanEvent;
  animateIn?: boolean;
  reduceMotion?: boolean;
}) {
  const [open, setOpen] = useState(() => reduceMotion || !animateIn);
  const done = plan.steps.filter((step) => step.status === "done").length;

  useLayoutEffect(() => {
    if (open) return;
    const frame = window.requestAnimationFrame(() => setOpen(true));
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  return (
    <div
      className={styles.expandPanel}
      style={{
        gridTemplateRows: open ? "1fr" : "0fr",
        opacity: open ? 1 : 0,
      }}
      data-duration="640"
    >
      <div className={styles.expandInner}>
        <div className={styles.planCard} aria-label="Plan">
          <div className={styles.planHeader}>
            Plan
            <span className={styles.planCount}>{done}/{plan.steps.length}</span>
          </div>
          {plan.steps.map((step, index) => (
            <div key={step.id || `legacy_plan_step_${index}`} className={styles.planStep} data-status={step.status}>
              <span className={styles.planStepIcon}>
                {step.status === "done"
                  ? <CheckIcon size={12} />
                  : step.status === "active"
                    ? <span className={styles.spinner} />
                    : step.status === "blocked"
                      ? <CrossIcon size={11} />
                      : step.status === "incomplete"
                        ? <span className={styles.planStepDash}>–</span>
                    : <span className={styles.planStepDot} />}
              </span>
              <span className={styles.planStepCopy}>
                <span className={styles.planStepLabel}>{step.label}</span>
                {(step.status === "blocked" || step.status === "incomplete") && step.statusDetail
                  ? <span className={styles.planStepDetail}>{step.statusDetail}</span>
                  : null}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Compact elapsed label used by the Codex-style working trail. */
function formatForDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `for ${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return seconds > 0 ? `for ${minutes}m ${seconds}s` : `for ${minutes}m`;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={styles.chevron}
      style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CheckIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function CrossIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" aria-hidden>
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

function SparklesIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.stepGlyph} aria-hidden>
      <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" />
      <path d="M19 13l.8 2.2L22 16l-2.2.8L19 19l-.8-2.2L16 16l2.2-.8L19 13z" />
    </svg>
  );
}

/**
 * A governed table "contains data" when at least one row carries a real value.
 * Empty result sets and all-null / all-zero aggregate rows (e.g. a payroll
 * total over a period with no pay runs) render as blank tables, so the
 * compact query list hides them rather than showing "No data" cards.
 */
function tableHasData(table: TraceTableEvent | undefined): boolean {
  if (!table || table.rows.length === 0) return false;
  return table.rows.some((row) =>
    Object.values(row).some((cell) => {
      if (cell === null || cell === undefined) return false;
      if (typeof cell === "string") return cell.trim().length > 0;
      if (typeof cell === "number") return cell !== 0 && Number.isFinite(cell);
      return true;
    }),
  );
}

function CompactQueries({
  tables,
  collapsedByDefault,
  reduceMotion,
  onAddToDashboard,
}: {
  tables: readonly TrailStep[];
  collapsedByDefault: boolean;
  reduceMotion: boolean;
  onAddToDashboard?: (table: TraceTableEvent) => Promise<void>;
}) {
  const [open, setOpen] = useState(!collapsedByDefault);

  useEffect(() => {
    if (collapsedByDefault) setOpen(false);
  }, [collapsedByDefault]);

  if (tables.length === 0) return null;

  const label = tables.length === 1 ? "Query" : "Queries";

  return (
    <div className={styles.compactQueries}>
      <button
        type="button"
        className={styles.compactQueriesHeader}
        aria-expanded={open}
        aria-label={`${label}, ${tables.length}`}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.compactQueriesLabel}>{label}</span>
        <span className={styles.compactQueriesCount}>{tables.length}</span>
        <span className={styles.compactQueriesChevron}>
          <Chevron open={open} />
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            className={styles.compactQueriesBody}
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              duration: reduceMotion ? 0 : 0.4,
              ease: [0.04, 0.62, 0.23, 0.98],
            }}
          >
            <div className={styles.compactQueriesInner}>
              {tables.map((step) => (
                <div className={styles.compactResultTable} key={`compact-${step.table!.id}`}>
                  <ResultTable
                    table={step.table!}
                    query={step.governed}
                    maxHeight={280}
                    onAddToDashboard={onAddToDashboard}
                  />
                </div>
              ))}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/**
 * The outcome of a research step (catalogue search, definitions read, stored
 * value lookup) as an expandable list under the step: what matched, with its
 * meaning or weight. An empty list on a finished step is shown as a miss —
 * "nothing matched" explains why the next step happened.
 */
function ResearchFindings({ step }: { step: TrailStep }) {
  const findings = step.findings ?? [];
  const isMiss = findings.length === 0 && step.status !== "running";
  const [open, setOpen] = useState(false);
  const bodyId = `research-findings-${step.id}`;
  return (
    <span className={styles.researchFindings}>
      {isMiss ? (
        <span className={styles.researchMiss}>Nothing matched — trying another way.</span>
      ) : (
        <>
          <button
            type="button"
            className={styles.researchToggle}
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((current) => !current)}
          >
            <Chevron open={open} />
            <span>{findings.length} {step.stage === "field_values" ? (findings.length === 1 ? "value" : "values") : step.stage === "definition" ? "definitions" : findings.length === 1 ? "match" : "matches"}</span>
          </button>
          {open ? (
            <ul id={bodyId} className={styles.researchList}>
              {findings.map((line, index) => {
                const [head, ...rest] = line.split(" — ");
                return (
                  <li key={`${step.id}_${index}`}>
                    <span className={styles.researchHead}>{head}</span>
                    {rest.length > 0 ? <span className={styles.researchMeaning}> — {rest.join(" — ")}</span> : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </>
      )}
    </span>
  );
}

/**
 * Structured "how this was worked out" panel behind a result's info button:
 * the governed view (topic) and its meaning, every field with the semantic
 * model's own description, the filters and time window applied, calculated
 * columns' formulas, and the sources' data-through watermarks. The exact
 * query YAML stays available behind a toggle for people who want it.
 */
function QueryDetails({ id, table, queryYaml }: { id: string; table: TraceTableEvent; queryYaml: string }) {
  const [showYaml, setShowYaml] = useState(false);
  const provenance = table.provenance;
  const definitions = [...new Map(
    provenance.definitions
      .filter((definition) => !definition.metric.includes(":"))
      .map((definition) => [`${definition.metric}:${definition.kind ?? "unknown"}`, definition] as const),
  ).values()];
  const measures = definitions.filter((definition) => definition.kind === "measure");
  const others = definitions.filter((definition) => definition.kind !== "measure");
  const filters = provenance.filters ?? [];
  const calculations = provenance.calculations ?? [];
  const kindLabel = (kind?: string) => kind === "measure" ? "metric" : kind === "time" ? "time" : kind === "segment" ? "segment" : "field";
  const renderField = (definition: TraceProvenance["definitions"][number], index: number) => (
    <li key={`${definition.metric}_${index}`} className={styles.queryDetailsField}>
      <span className={styles.queryDetailsFieldHead}>
        <span className={styles.queryDetailsFieldLabel}>{definition.label}</span>
        <span className={styles.queryDetailsKind}>{kindLabel(definition.kind)}</span>
        <span className={styles.queryDetailsMember}>{definition.metric.split(".").at(-1)}</span>
      </span>
      {definition.definition && !/^Governed member of the /u.test(definition.definition) ? (
        <span className={styles.queryDetailsMuted}>{definition.definition}</span>
      ) : null}
    </li>
  );
  return (
    <div id={id} className={styles.queryDetails}>
      {provenance.view ? (
        <div className={styles.queryDetailsTopic}>
          <span className={styles.queryDetailsEyebrow}>Topic</span>
          <span className={styles.queryDetailsTitle}>{provenance.view.label}</span>
          {provenance.view.description ? <span className={styles.queryDetailsMuted}>{provenance.view.description}</span> : null}
        </div>
      ) : null}
      {measures.length > 0 ? (
        <div className={styles.queryDetailsSection}>
          <span className={styles.queryDetailsEyebrow}>Metrics</span>
          <ul className={styles.queryDetailsList}>{measures.map(renderField)}</ul>
        </div>
      ) : null}
      {others.length > 0 ? (
        <div className={styles.queryDetailsSection}>
          <span className={styles.queryDetailsEyebrow}>Grouped by</span>
          <ul className={styles.queryDetailsList}>{others.map(renderField)}</ul>
        </div>
      ) : null}
      {filters.length > 0 ? (
        <div className={styles.queryDetailsSection}>
          <span className={styles.queryDetailsEyebrow}>Filters</span>
          <ul className={styles.queryDetailsList}>
            {filters.map((filter, index) => <li key={`${filter.member}_${index}`}>{filter.text}</li>)}
          </ul>
        </div>
      ) : null}
      {calculations.length > 0 ? (
        <div className={styles.queryDetailsSection}>
          <span className={styles.queryDetailsEyebrow}>Calculations</span>
          <ul className={styles.queryDetailsList}>
            {calculations.map((calc, index) => (
              <li key={`${calc.column}_${index}`} className={styles.queryDetailsField}>
                <span className={styles.queryDetailsFieldLabel}>{calc.column}</span>
                <span className={styles.queryDetailsFormula}>= {calc.formula}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {provenance.sources.length > 0 ? (
        <div className={styles.queryDetailsSection}>
          <span className={styles.queryDetailsEyebrow}>Source</span>
          <ul className={styles.queryDetailsList}>
            {provenance.sources.map((source) => (
              <li key={`${source.connector}_${source.label}`} className={styles.queryDetailsMuted}>
                {CONNECTOR_NAMES[source.connector]}
                {source.dataThrough && source.dataThrough !== "unknown" ? ` · data through ${formatDataThrough(source.dataThrough)}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {queryYaml ? (
        <>
          <button type="button" className={styles.queryDetailsYamlToggle} aria-expanded={showYaml} onClick={() => setShowYaml((current) => !current)}>
            {showYaml ? "Hide the exact query" : "Show the exact query"}
          </button>
          {showYaml ? <pre className={styles.resultQueryYamlCode}>{queryYaml}</pre> : null}
        </>
      ) : null}
    </div>
  );
}

function formatDataThrough(value: string): string {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(instant);
}

function ResultTable({
  table,
  query,
  maxHeight = 240,
  onAddToDashboard,
}: {
  table: TraceTableEvent;
  query?: TrailStep["governed"];
  maxHeight?: number;
  onAddToDashboard?: (table: TraceTableEvent) => Promise<void>;
}) {
  const reduceMotion = Boolean(useReducedMotion());
  const [open, setOpen] = useState(true);
  const [pinState, setPinState] = useState<"idle" | "adding" | "added" | "error">("idle");
  const [yamlOpen, setYamlOpen] = useState(false);
  const eligible = Boolean(table.dashboardReplay && onAddToDashboard);
  const queryYaml = query?.queryYaml?.trim() || "";
  const bodyId = `result-table-body-${table.id}`;
  const sourceConnectors = table.provenance.sources.length > 0
    ? table.provenance.sources.map((source) => source.connector)
    : query?.connector
      ? [query.connector]
      : [];
  const timeRange = table.provenance.timeRange.label?.trim() || query?.timeRangeLabel?.trim() || "";
  const metaParts = [
    timeRange && !/^(requested period|unknown)$/iu.test(timeRange) ? timeRange : "",
    `${table.rows.length.toLocaleString("en-AU")} row${table.rows.length === 1 ? "" : "s"}`,
    typeof query?.executionMs === "number" ? `${Math.round(query.executionMs)} ms` : "",
  ].filter(Boolean);

  const add = async () => {
    if (!eligible || pinState === "adding" || pinState === "added") return;
    setPinState("adding");
    try {
      await onAddToDashboard?.(table);
      setPinState("added");
    } catch {
      setPinState("error");
    }
  };

  const toggleOpen = () => {
    setOpen((current) => {
      if (current) setYamlOpen(false);
      return !current;
    });
  };

  // Keep every row available. Cap height and scroll instead of truncating the
  // result (weekly/monthly series often exceed a short preview).
  return (
    <div className={styles.resultTableShell} data-collapsed={open ? undefined : "true"}>
      <div className={styles.resultQueryHeader} data-collapsed={open ? undefined : "true"}>
        <button
          type="button"
          className={styles.resultQueryToggle}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggleOpen}
        >
          <span className={styles.resultQueryChevron}>
            <Chevron open={open} />
          </span>
          <span className={styles.resultQueryEyebrow}>
            {table.presentation === "answer" ? "Table" : "Query"}
          </span>
          <span className={styles.resultQueryTitle}>{table.caption}</span>
          {metaParts.length > 0 ? (
            <span className={styles.resultQueryMeta}>
              <span className={styles.resultQueryMetaText}>{metaParts.join(" · ")}</span>
            </span>
          ) : null}
        </button>
        <div className={styles.resultQueryActions}>
          {queryYaml || table.provenance.definitions.length > 0 ? (
            <span className={styles.tablePinTooltipWrap}>
              <button
                className={styles.tablePinButton}
                type="button"
                aria-expanded={yamlOpen}
                aria-controls={`result-yaml-${table.id}`}
                aria-describedby={`result-yaml-tip-${table.id}`}
                aria-label={yamlOpen ? "Hide query details" : "Show query details"}
                onClick={() => {
                  if (!open) setOpen(true);
                  setYamlOpen((current) => !current);
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 11v5M12 8h.01" />
                </svg>
              </button>
              <span className={styles.tablePinTooltip} id={`result-yaml-tip-${table.id}`} role="tooltip">
                {yamlOpen ? "Hide query details" : "How this was worked out"}
              </span>
            </span>
          ) : null}
          {eligible ? (
            <span className={styles.tablePinTooltipWrap}>
              <button
                className={styles.tablePinButton}
                type="button"
                aria-describedby={`dashboard-pin-${table.id}`}
                aria-label={pinState === "added" ? "Added to dashboard" : "Add table to dashboard"}
                disabled={pinState === "adding" || pinState === "added"}
                onClick={() => void add()}
              >
                {pinState === "added" ? (
                  <>
                    <CheckIcon size={12} />
                    <span>Added</span>
                  </>
                ) : pinState === "adding" ? (
                  <span>Adding</span>
                ) : (
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                )}
              </button>
              <span className={styles.tablePinTooltip} id={`dashboard-pin-${table.id}`} role="tooltip">
                {pinState === "error" ? "Could not add. Try again." : pinState === "added" ? "Added to Dashboard" : "Add to Dashboard"}
              </span>
            </span>
          ) : null}
          {sourceConnectors.length > 0 ? (
            <span className={styles.resultQuerySources} aria-label="Data sources">
              {sourceConnectors.map((connector) => (
                <span
                  className={styles.resultQuerySource}
                  key={connector}
                  title={`Data from ${CONNECTOR_NAMES[connector]}`}
                >
                  <Image
                    src={CONNECTOR_LOGOS[connector]}
                    alt={CONNECTOR_NAMES[connector]}
                    width={14}
                    height={14}
                    unoptimized
                  />
                </span>
              ))}
            </span>
          ) : null}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            id={bodyId}
            className={styles.resultTableBody}
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              duration: reduceMotion ? 0 : 0.4,
              ease: [0.04, 0.62, 0.23, 0.98],
            }}
          >
            {yamlOpen ? (
              <QueryDetails id={`result-yaml-${table.id}`} table={table} queryYaml={queryYaml} />
            ) : null}

            <GovernedResultGrid table={table} maxHeight={maxHeight} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function CubeQueryYamlPanel({ queryYaml }: { queryYaml: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.cubeYamlBlock}>
      <button
        type="button"
        className={styles.cubeYamlToggle}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Chevron open={open} />
        Cube query (YAML)
      </button>
      <div
        className={styles.cubeYamlPanel}
        style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
      >
        <div className={styles.cubeYamlInner}>
          <pre className={styles.cubeYamlCode}>{queryYaml}</pre>
        </div>
      </div>
    </div>
  );
}

function GovernedQuerySummary({
  query,
}: {
  query: NonNullable<TrailStep["governed"]>;
}) {
  const yamlModels = [...new Set(query.metrics
    .filter((metric) => metric.startsWith("cube.yaml:"))
    .map((metric) => metric.replace(/^cube\.yaml:/u, "").split("/").pop() || metric))];
  const intentMetrics = [...new Set(query.metrics.filter((metric) => !metric.startsWith("cube.yaml:")))];
  const queryCubes = [...new Set(query.cubes ?? [])];
  const queryDimensions = [...new Set(query.dimensions)];
  const isCubeV3 = Boolean(query.queryYaml || query.view);
  const isCubecore = /cubecore/iu.test(query.lens || "") || yamlModels.length > 0;
  const ungoverned = /ungoverned/iu.test(query.lens || "");
  return (
    <div className={styles.governedQuery}>
      <div className={styles.governedQueryHeader}>
        <p className={styles.governedQueryEyebrow}>
          {isCubeV3
            ? "Cube semantic query"
            : isCubecore
              ? (ungoverned ? "Cubecore plan · ungoverned" : "Cubecore plan")
              : "Governed plan"}
        </p>
        {query.connector ? <ToolChip connector={query.connector} /> : null}
      </div>
      <h4 className={styles.governedQueryTopic}>{humanize(query.topic)}</h4>
      {query.lens && !isCubeV3 ? <p className={styles.governedQueryLens}>{humanize(query.lens)}</p> : null}
      <dl className={styles.governedQueryFields}>
        {query.view ? (
          <div>
            <dt>View</dt>
            <dd><span>{query.view}</span></dd>
          </div>
        ) : null}
        {queryCubes.length > 0 ? (
          <div>
            <dt>Cubes</dt>
            <dd>
              {queryCubes.map((cube, index) => (
                <span key={`${cube}_${index}`}>{cube}</span>
              ))}
            </dd>
          </div>
        ) : null}
        {yamlModels.length > 0 ? (
          <div>
            <dt>YAML models</dt>
            <dd>
              {yamlModels.map((file, index) => (
                <span key={`${file}_${index}`}>{file}</span>
              ))}
            </dd>
          </div>
        ) : null}
        {intentMetrics.length > 0 ? (
          <div>
            <dt>Metrics</dt>
            <dd>
              {intentMetrics.map((metric, index) => (
                <span key={`${metric}_${index}`}>{humanize(metric)}</span>
              ))}
            </dd>
          </div>
        ) : null}
        {queryDimensions.length > 0 ? (
          <div>
            <dt>Dimensions</dt>
            <dd>
              {queryDimensions.map((dimension, index) => (
                <span key={`${dimension}_${index}`}>{humanize(dimension)}</span>
              ))}
            </dd>
          </div>
        ) : null}
        {query.timeRangeLabel ? (
          <div>
            <dt>Time range</dt>
            <dd><span>{query.timeRangeLabel}</span></dd>
          </div>
        ) : null}
        {typeof query.executionMs === "number" ? (
          <div>
            <dt>Run time</dt>
            <dd><span>{query.executionMs < 1000 ? `${query.executionMs}ms` : `${(query.executionMs / 1000).toFixed(1)}s`}</span></dd>
          </div>
        ) : null}
      </dl>
      {query.queryYaml ? <CubeQueryYamlPanel queryYaml={query.queryYaml} /> : null}
    </div>
  );
}

function ShimmerStatusContent({
  line,
  verb,
}: {
  line: ProgressShimmerLine;
  verb: string;
}) {
  if (line.connectors.length === 0) {
    return <span className={styles.agentTrailStatusCopy}>{line.text || verb}</span>;
  }

  const names = formatToolNames(line.connectors);
  return (
    <>
      <span className={styles.agentTrailStatusCopy}>Checking</span>
      <span className={styles.agentTrailStatusTools}>
        {line.connectors.map((connector) => (
          <span
            key={connector}
            className={styles.agentTrailStatusTool}
            title={CONNECTOR_NAMES[connector]}
          >
            <Image
              src={CONNECTOR_LOGOS[connector]}
              alt=""
              width={12}
              height={12}
              unoptimized
            />
          </span>
        ))}
      </span>
      <span className={styles.agentTrailStatusCopy}>{names}</span>
    </>
  );
}

/** The rotating "what is happening" line plus the animation settings it renders with. */
type ProgressShimmer = Readonly<{
  line: ProgressShimmerLine;
  durationMs: number;
  transition: { duration: number; ease?: readonly [number, number, number, number] };
}>;

/** Anything that reads like an internal name is not owner copy. */
const TECHNICAL_COPY = /albert|\bv3\b|cube|semantic|sql|governed|schema|catalogue index|allowlist|tenant|staging|planner|lane\b|\b[a-z][a-z0-9]*_[a-z0-9_]+\b|\b[a-z]+\.[a-z_]+\b/iu;

/**
 * Concise, owner-friendly line for what is happening right now, derived from
 * the running steps: the purpose of the latest lookup ("Looking up margin by
 * department"), the tools being read when several run in parallel ("Checking
 * Lightspeed and Xero"), or a plain stage phrase. Falls back to "Thinking"
 * only when nothing concrete can be said.
 */
export function friendlyActivityLine(
  steps: readonly Pick<TrailStep, "title" | "detail" | "status" | "stage" | "kind" | "governed">[],
): ProgressShimmerLine {
  const running = steps.filter((step) => step.status === "running");
  if (running.length === 0) return { id: "thinking", text: "Thinking", connectors: [] };

  const queries = running.filter((step) => step.kind === "sql" || step.stage === "query" || step.stage === "source_query" || step.governed);
  const connectors = collectShimmerConnectors({ status: "", steps: queries });
  // Several lookups in flight: name the tools rather than one arbitrary topic.
  if (queries.length >= 2 && connectors.length > 0) {
    return { id: `tools:${connectors.join(",")}`, text: formatCheckingTools(connectors), connectors };
  }

  const latest = running[running.length - 1]!;
  const stage = latest.stage;
  if (stage === "catalogue") return { id: "catalogue", text: "Finding the right data…", connectors: [] };
  if (stage === "definition") return { id: "definition", text: "Checking how the figures are defined…", connectors: [] };
  if (stage === "research") return { id: "research", text: "Researching definitions and stored values…", connectors: [] };
  if (stage === "planning") return { id: "planning", text: "Planning", connectors: [] };

  const purpose = laymanProgressStatus(latest.title, latest.detail ?? "").replace(/\.+$/u, "");
  const usable = purpose && purpose.length <= 64 && !TECHNICAL_COPY.test(purpose) && !GENERIC_OWNER_THEMES.test(purpose);
  if (usable) {
    const text = /^(?:Looking|Checking|Reading|Finding|Comparing|Working|Matching|Counting|Pulling)\b/iu.test(purpose)
      ? `${purpose}…`
      : `Looking up ${purpose.charAt(0).toLowerCase()}${purpose.slice(1)}…`;
    return { id: `text:${text.toLocaleLowerCase("en-AU")}`, text, connectors: [] };
  }
  if (connectors.length > 0) {
    return { id: `tools:${connectors.join(",")}`, text: formatCheckingTools(connectors), connectors };
  }
  return { id: "numbers", text: "Looking up your numbers…", connectors: [] };
}

/**
 * The status line shown while a turn runs. Owned by the trace root so the
 * header and the live commentary share it. Before the plan card exists it
 * reads "Planning"; afterwards it names what is actually happening, in the
 * owner's terms, never internal labels.
 */
function useProgressShimmer(
  model: TrailModel,
  streaming: boolean,
  reduceMotion: boolean,
): ProgressShimmer {
  const [durationMs] = useState(() => Math.round(2400 + Math.random() * 600));
  const planning = streaming
    && !model.plan
    && !model.steps.some((step) => step.status === "running" && step.stage !== "planning");
  const line = useMemo<ProgressShimmerLine>(
    () => planning
      ? { id: "planning", text: "Planning", connectors: [] }
      : friendlyActivityLine(model.steps),
    [planning, model.steps],
  );
  return useMemo(() => ({
    line,
    durationMs,
    transition: reduceMotion
      ? { duration: 0 }
      : { duration: 0.72, ease: [0.22, 1, 0.36, 1] as const },
  }), [durationMs, line, reduceMotion]);
}

/** The animated status line: measured ghost copy keeps the width, live copy slides through. */
function ShimmerStatusLine({
  shimmer,
  verb,
  reduceMotion,
}: {
  shimmer: ProgressShimmer;
  verb: string;
  reduceMotion: boolean;
}) {
  return (
    <span className={styles.agentTrailStatus}>
      <span className={styles.agentTrailStatusMeasure} aria-hidden>
        <ShimmerStatusContent line={shimmer.line} verb={verb} />
      </span>
      <AnimatePresence initial={false}>
        <motion.span
          key={shimmer.line.id}
          initial={reduceMotion ? false : { y: "110%", opacity: 0 }}
          animate={{ y: "0%", opacity: 1 }}
          exit={reduceMotion ? undefined : { y: "-110%", opacity: 0 }}
          transition={shimmer.transition}
          className={styles.agentTrailStatusLive}
          style={{ "--insights-shimmer-duration": `${shimmer.durationMs}ms` } as CSSProperties}
        >
          <ShimmerStatusContent line={shimmer.line} verb={verb} />
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/**
 * Codex-style agent progress:
 * - Streaming: shimmering "Working" + live "for Xs"; current status replaces on the header line
 *   (unless live commentary is on screen, in which case the header settles to
 *   a static "Working" and the latest "Ran x queries" line carries the shimmer)
 * - Done: static "Worked" + "for Xs"
 * - Task list always collapsed by default; expand to inspect steps
 */
function ThinkingTrail({
  model,
  streaming,
  shimmer,
  headerShimmer = true,
  reduceMotion = false,
}: {
  model: TrailModel;
  streaming: boolean;
  shimmer: ProgressShimmer;
  /** False while live commentary is showing; the activity line hosts the shimmer. */
  headerShimmer?: boolean;
  reduceMotion?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const hasTrail = model.steps.length > 0 || model.reasoning.trim().length > 0 || streaming;
  const line = shimmer.line;

  useEffect(() => {
    if (!streaming) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [streaming]);

  if (!hasTrail) return null;

  // The clock starts ticking at mount, before any server event exists. When
  // the first event lands its occurredAt is "now", so re-anchoring on it
  // would collapse a visible "Planning 4s" back to 0s — the origin may only
  // ever move backwards (a rehydrated older turn), never forwards.
  const startedAt = model.startedAtMs != null
    ? Math.min(model.startedAtMs, mountedAt)
    : (streaming ? mountedAt : null);
  const elapsedMs = streaming && startedAt != null
    ? Math.max(0, now - startedAt)
    : model.stats.durationMs;
  const durationLabel = elapsedMs > 0 || streaming ? formatForDuration(elapsedMs) : null;
  const verb = streaming
    ? "Working"
    : model.stopped
      ? "Stopped"
      : model.error
        ? "Stopped"
        : "Worked";
  const reasoning = cleanReasoningSummary(model.reasoning);
  const canExpand = model.steps.length > 0 || Boolean(reasoning) || model.governedQueries.length > 0;
  const sourceLabel = model.sources.map((source) => source.label).join(", ");
  const headerLabel = streaming
    ? `${verb}. ${line.text}`
    : `${verb}${durationLabel ? ` ${durationLabel}` : ""}${sourceLabel ? `. Sources: ${sourceLabel}` : ""}`;

  return (
    <motion.div
      className={styles.agentTrail}
      initial={reduceMotion || !streaming ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : { duration: 0.42, ease: [0.22, 1, 0.36, 1] }
      }
    >
      <button
        type="button"
        className={styles.agentTrailHeader}
        aria-expanded={open}
        aria-label={headerLabel}
        onClick={() => {
          if (!canExpand) return;
          setOpen((current) => !current);
        }}
      >
        <span className={styles.agentTrailVerbGroup}>
          {streaming && headerShimmer ? (
            <ShimmerStatusLine shimmer={shimmer} verb={verb} reduceMotion={reduceMotion} />
          ) : (
            <span className={styles.agentTrailVerb}>{verb}</span>
          )}
          {durationLabel ? (
            <span className={styles.agentTrailDuration}>{durationLabel}</span>
          ) : null}
        </span>
        {model.sources.length > 0 ? (
          <span className={styles.agentTrailSources} aria-hidden>
            {model.sources.map((source) => (
              <span
                key={source.connector}
                className={styles.agentTrailSource}
                title={source.label}
                data-connector={source.connector}
              >
                <Image
                  src={CONNECTOR_LOGOS[source.connector]}
                  alt=""
                  width={12}
                  height={12}
                  unoptimized
                />
              </span>
            ))}
          </span>
        ) : null}
        {canExpand ? (
          <span className={styles.agentTrailChevron}>
            <Chevron open={open} />
          </span>
        ) : null}
      </button>

      <div
        className={styles.expandPanel}
        style={{
          gridTemplateRows: open ? "1fr" : "0fr",
          opacity: open ? 1 : 0,
        }}
        data-duration="300"
      >
        <div className={styles.expandInner}>
          <div className={styles.agentTrailBody}>
            {reasoning ? (
              <p className={styles.thinkingReasoning}>{reasoning}</p>
            ) : null}

            {model.steps.length > 0 ? (
              <div className={styles.agentTrailSteps}>
                {model.steps.map((step) => (
                  <div key={step.id} className={styles.agentTrailStep}>
                    {step.status === "running" ? (
                      <span className={styles.spinner} />
                    ) : step.status === "error" ? (
                      <span className={styles.agentTrailStepIcon}><CrossIcon size={14} /></span>
                    ) : step.status === "incomplete" ? (
                      <span className={styles.agentTrailStepIcon}>–</span>
                    ) : (
                      <span className={styles.agentTrailStepIcon}><CheckIcon size={14} /></span>
                    )}
                    <span className={styles.agentTrailStepBody}>
                      <span className={styles.agentTrailStepTitle}>
                        {step.governed?.connector ? (
                          <span
                            className={styles.stepToolLogo}
                            title={`Data from ${CONNECTOR_NAMES[step.governed.connector]}`}
                          >
                            <Image
                              src={CONNECTOR_LOGOS[step.governed.connector]}
                              alt={CONNECTOR_NAMES[step.governed.connector]}
                              width={11}
                              height={11}
                              unoptimized
                            />
                          </span>
                        ) : null}
                        {step.findings ? step.title : laymanProgressStatus(step.title, step.detail ?? "")}
                      </span>
                      {typeof step.rowCount === "number" ? (
                        <span className={styles.stepMeta}>
                          {step.rowCount.toLocaleString()} row{step.rowCount === 1 ? "" : "s"}
                        </span>
                      ) : null}
                      {step.findings ? <ResearchFindings step={step} /> : null}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            {model.governedQueries.length > 0 ? (
              <div className={styles.governedSection}>
                {model.governedQueries.map((query, index) => (
                  <GovernedQuerySummary
                    key={`${query.topic}_${query.lens}_${index}`}
                    query={query}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

type ActivityBlock =
  | Readonly<{ kind: "commentary"; id: string; text: string }>
  | Readonly<{ kind: "activity"; id: string; steps: readonly TrailStep[] }>;

/**
 * Codex-style interleaving: each commentary paragraph is followed by the work
 * that happened after it, grouped into one collapsible line. Groups are built
 * from the trace order, so a query that started before a paragraph stays
 * above it even if it finished later.
 */
function buildActivityBlocks(
  trace: readonly TraceEntry[],
  stepsById: ReadonlyMap<string, TrailStep>,
): ActivityBlock[] {
  const blocks: ActivityBlock[] = [];
  let pending: TrailStep[] = [];
  let pendingId = "lead";
  const flush = () => {
    if (pending.length > 0) blocks.push({ kind: "activity", id: `activity_${pendingId}`, steps: pending });
    pending = [];
  };
  for (const entry of trace) {
    if (entry.type === "commentary") {
      flush();
      blocks.push({ kind: "commentary", id: entry.id, text: entry.content });
      pendingId = entry.id;
      continue;
    }
    const step = stepsById.get(entry.stepId);
    if (step) pending.push(step);
  }
  flush();
  return blocks;
}

function activityKind(step: TrailStep): "query" | "catalogue" | "definition" | "research" | "planning" | "other" {
  if (step.kind === "sql" || step.stage === "query" || step.stage === "source_query" || step.governed) return "query";
  if (step.stage === "catalogue") return "catalogue";
  if (step.stage === "definition") return "definition";
  if (step.stage === "research") return "research";
  if (step.stage === "planning") return "planning";
  return "other";
}

/** Settled-group label: "Ran 3 queries · Read 2 definitions". */
export function summarizeActivity(steps: readonly Pick<TrailStep, "kind" | "stage" | "governed" | "status">[]): string {
  const counts = { query: 0, catalogue: 0, definition: 0, research: 0, planning: 0, other: 0, incomplete: 0 };
  for (const step of steps) {
    if (step.status === "incomplete") {
      counts.incomplete += 1;
      continue;
    }
    counts[activityKind(step as TrailStep)] += 1;
  }
  const parts: string[] = [];
  if (counts.query > 0) parts.push(counts.query === 1 ? "Ran 1 query" : `Ran ${counts.query} queries`);
  if (counts.catalogue > 0) parts.push(counts.catalogue === 1 ? "Searched the catalogue" : `Searched the catalogue ${counts.catalogue} times`);
  if (counts.definition > 0) parts.push(counts.definition === 1 ? "Read 1 definition" : `Read ${counts.definition} definitions`);
  if (counts.research > 0) parts.push("Completed research");
  if (counts.planning > 0) parts.push("Planned the work");
  if (counts.incomplete > 0) parts.push(counts.incomplete === 1 ? "1 step stopped" : `${counts.incomplete} steps stopped`);
  if (parts.length === 0) parts.push(counts.other === 1 ? "1 step" : `${counts.other} steps`);
  return parts.join(" · ");
}

/**
 * Runtime status labels are written for the trail's expanded step rows, where
 * "Codex is composing…" reads fine; the live group line is owner-facing
 * headline copy, so the same phrases are rewritten into plain activity.
 */
const LIVE_ACTIVITY_REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Albert checked the draft\b.*$/iu, "Correcting the draft"],
  [/^(?:Codex|Albert) is composing and verifying the answer$/iu, "Writing up the answer"],
  [/^(?:Codex|Albert) is reviewing the draft against the ask$/iu, "Checking the draft against your question"],
  [/^(?:Codex|Albert) is tightening the answer to the ask$/iu, "Tightening the answer"],
  [/^(?:Codex|Albert) is planning the analysis$/iu, "Planning the analysis"],
  [/^Codex is mapping the question\b.*$/iu, "Choosing the data that answers this"],
  [/^Codex is analysing the evidence$/iu, "Analysing the evidence"],
];

const LIVE_ACTIVITY_VERBS = /^(?:Looking|Checking|Reading|Finding|Comparing|Working|Matching|Counting|Pulling|Writing|Tightening|Correcting|Planning|Searching|Researching|Aligning|Choosing|Analysing)\b/iu;

/**
 * Live-group label: names the work in flight ("Looking up monthly sales and
 * gross profit…", "Writing up the answer…") instead of counting it. Returns
 * null when nothing concrete and owner-safe can be said, so the caller keeps
 * the counted summary.
 */
export function liveActivityLabel(
  steps: readonly Pick<TrailStep, "title" | "detail" | "status" | "stage" | "kind" | "governed">[],
): string | null {
  const running = steps.filter((step) => step.status === "running");
  const latest = running[running.length - 1];
  if (!latest) return null;
  // Runtime status titles are a stable set, so they are rewritten before any
  // softening — otherwise laymanProgressStatus can prefer a wordier detail
  // line ("Cutting anything the question did not ask for…") over the title.
  const rewrite = LIVE_ACTIVITY_REWRITES.find(([pattern]) => pattern.test(latest.title.trim()));
  const purpose = (rewrite?.[1] ?? laymanProgressStatus(latest.title, latest.detail ?? ""))
    .replace(/\.+$/u, "")
    .trim();
  if (!purpose || GENERIC_OWNER_THEMES.test(purpose)) return null;
  // Internal names and member lists are audit detail, never headline copy.
  if (TECHNICAL_COPY.test(purpose)) return null;
  const text = (LIVE_ACTIVITY_VERBS.test(purpose)
    ? purpose
    : `Looking up ${purpose.charAt(0).toLowerCase()}${purpose.slice(1)}`)
    // "Looking up Monthly sales…" reads as a title, not a sentence.
    .replace(/^(Looking (?:up|at|through|into) )([A-Z])(?=[a-z])/u, (_match, verb: string, first: string) => `${verb}${first.toLowerCase()}`);
  const bounded = text.length > 96 ? `${text.slice(0, 95).replace(/\s+\S*$/u, "")}` : text;
  return `${bounded.charAt(0).toUpperCase()}${bounded.slice(1)}…`;
}

function ActivityGroup({
  steps,
  live = false,
}: {
  steps: readonly TrailStep[];
  /**
   * The latest activity line keeps the live shimmer for the whole remaining
   * turn, including quiet gaps between queries. Earlier groups stay settled.
   */
  live?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const running = steps.some((step) => step.status === "running");
  // While work is in flight the line says what is happening; once the group
  // settles it becomes the counted record ("Ran 3 queries · …").
  const label = (running ? liveActivityLabel(steps) : null) ?? summarizeActivity(steps);
  return (
    <div className={styles.activityGroup} data-running={running || live ? "true" : "false"}>
      <button
        type="button"
        className={styles.activityHeader}
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={live ? `${styles.activityLabel} ${styles.activityLabelLive}` : styles.activityLabel}>
          {label}
        </span>
        <span className={styles.activityChevron}><Chevron open={open} /></span>
      </button>
      <div
        className={styles.expandPanel}
        style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
        data-duration="240"
      >
        <div className={styles.expandInner}>
          <div className={styles.agentTrailSteps}>
            {steps.map((step) => (
              <div key={step.id} className={styles.agentTrailStep}>
                {step.status === "running" ? (
                  <span className={styles.spinner} />
                ) : step.status === "error" ? (
                  <span className={styles.agentTrailStepIcon}><CrossIcon size={14} /></span>
                ) : step.status === "incomplete" ? (
                  <span className={styles.agentTrailStepIcon}>–</span>
                ) : (
                  <span className={styles.agentTrailStepIcon}><CheckIcon size={14} /></span>
                )}
                <span className={styles.agentTrailStepBody}>
                  <span className={styles.agentTrailStepTitle}>
                    {step.governed?.connector ? (
                      <span
                        className={styles.stepToolLogo}
                        title={`Data from ${CONNECTOR_NAMES[step.governed.connector]}`}
                      >
                        <Image
                          src={CONNECTOR_LOGOS[step.governed.connector]}
                          alt={CONNECTOR_NAMES[step.governed.connector]}
                          width={11}
                          height={11}
                          unoptimized
                        />
                      </span>
                    ) : null}
                    {step.findings ? step.title : laymanProgressStatus(step.title, step.detail ?? "")}
                  </span>
                  {typeof step.rowCount === "number" ? (
                    <span className={styles.stepMeta}>
                      {step.rowCount.toLocaleString()} row{step.rowCount === 1 ? "" : "s"}
                    </span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Sparse commentary stays visible while a longer turn runs, then folds into
 * the completed "Worked" trail. Routine query/tool events never enter here as
 * prose: they appear as a collapsible activity line under the paragraph they
 * followed, so the reader can click into what was done between findings.
 *
 * Layout: commentary → activity → commentary → activity …. The latest
 * activity line keeps the live shimmer until the turn settles.
 */
function LiveCommentary({
  model,
  reduceMotion,
}: {
  model: TrailModel;
  reduceMotion: boolean;
}) {
  const stepsById = useMemo(
    () => new Map(model.steps.map((step) => [step.id, step] as const)),
    [model.steps],
  );
  const blocks = useMemo(() => buildActivityBlocks(model.trace, stepsById), [model.trace, stepsById]);
  if (blocks.length === 0) return null;
  const commentaryIds = blocks.filter((block) => block.kind === "commentary").map((block) => block.id);
  const latestCommentaryId = commentaryIds.at(-1);
  const lastActivityId = [...blocks].reverse().find((block) => block.kind === "activity")?.id;
  const itemTransition = reduceMotion ? { duration: 0 } : { duration: 0.26, ease: [0.22, 1, 0.36, 1] as const };

  return (
    <motion.div
      className={styles.liveCommentary}
      aria-label="Albert progress updates"
      aria-live="polite"
      aria-relevant="additions text"
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduceMotion ? undefined : { opacity: 0, y: -3 }}
      transition={itemTransition}
    >
      <AnimatePresence initial={false}>
        {blocks.map((block) => block.kind === "commentary" ? (
          <motion.p
            key={block.id}
            className={styles.liveCommentaryItem}
            data-latest={block.id === latestCommentaryId ? "true" : "false"}
            initial={reduceMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={itemTransition}
          >
            {block.text}
          </motion.p>
        ) : (
          <motion.div
            key={block.id}
            initial={reduceMotion ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={itemTransition}
          >
            <ActivityGroup
              steps={block.steps}
              live={block.id === lastActivityId}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </motion.div>
  );
}

function InitialAcknowledgement({
  acknowledgement,
  reduceMotion,
}: {
  acknowledgement: TrailCommentaryUpdate;
  reduceMotion: boolean;
}) {
  return (
    <motion.p
      key={acknowledgement.id}
      className={styles.initialAcknowledgement}
      aria-live="polite"
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduceMotion ? undefined : { opacity: 0, y: -3 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
    >
      {acknowledgement.text}
    </motion.p>
  );
}

function DetailedCommentary({
  content,
  expanded,
  reduceMotion,
}: {
  content: string;
  expanded: boolean;
  reduceMotion: boolean;
}) {
  const cleaned = cleanReasoningSummary(content);
  const concise = conciseReasoningSummary(content);
  if (!cleaned || !concise) return null;
  return (
    <motion.div layout={!reduceMotion} className={styles.detailedCommentary}>
      <span className={styles.detailedSpark}>
        <SparklesIcon />
      </span>
      <AnimatePresence initial={false} mode="wait">
        <motion.p
          key={expanded ? "detailed" : "concise"}
          initial={reduceMotion ? false : { opacity: 0, y: -3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? undefined : { opacity: 0, y: 3 }}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.16 }}
          className={expanded ? styles.detailedCommentaryFull : styles.detailedCommentaryConcise}
        >
          {expanded ? cleaned : concise}
        </motion.p>
      </AnimatePresence>
    </motion.div>
  );
}

function DetailedQueryResult({
  step,
  resultNumber,
  reduceMotion,
  onAddToDashboard,
}: {
  step: TrailStep;
  resultNumber: number;
  reduceMotion: boolean;
  onAddToDashboard?: (table: TraceTableEvent) => Promise<void>;
}) {
  return (
    <motion.div layout={!reduceMotion} className={styles.detailedQueryCard}>
      <div className={styles.detailedQueryHeader}>
        <div>
          <div className={styles.detailedQueryMeta}>
            <span>Table {resultNumber}</span>
            {typeof step.rowCount === "number" ? (
              <span>{step.rowCount.toLocaleString()} row{step.rowCount === 1 ? "" : "s"}</span>
            ) : null}
          </div>
          <p className={styles.detailedQueryTitle}>{step.title}</p>
        </div>
      </div>
      {step.status === "running" ? (
        <div className={styles.detailedQueryLoading}>
          <span className={styles.spinnerLg} />
          Running query…
        </div>
      ) : step.status === "error" ? (
        <p className={styles.detailedQueryError}>{step.error || "This query could not be completed."}</p>
      ) : step.status === "incomplete" ? (
        <p className={styles.detailedQueryEmpty}>This query stopped before completion.</p>
      ) : !step.table ? (
        <p className={styles.detailedQueryEmpty}>
          {typeof step.rowCount === "number" && step.rowCount > 0
            ? "Used to support the answer; detailed rows were not included in the response."
            : "The query completed with no rows."}
        </p>
      ) : (
        <ResultTable
          table={step.table}
          query={step.governed}
          maxHeight={360}
          onAddToDashboard={onAddToDashboard}
        />
      )}
    </motion.div>
  );
}

function ChartLoadingState() {
  return (
    <div className={styles.chartLoadingState} role="status">
      <span className={styles.spinner} aria-hidden="true" />
      Preparing chart…
    </div>
  );
}

function DetailedSupportStep({ step }: { step: TrailStep }) {
  if (step.chart) {
    if (!step.chart.table) return null;
    return (
      <div className={styles.detailedChartArtifact}>
        <Suspense fallback={<ChartLoadingState />}>
          <ResultChart event={step.chart.event} table={step.chart.table} />
        </Suspense>
      </div>
    );
  }
  return (
    <div className={styles.detailedSupport}>
      {step.status === "running" ? <span className={styles.spinner} /> : <CheckIcon size={14} />}
      <div>
        <p className={styles.detailedSupportTitle}>{step.title}</p>
        {step.detail ? <p className={styles.detailedSupportDetail}>{step.detail}</p> : null}
        {step.error ? <p className={styles.stepError}>{step.error}</p> : null}
      </div>
    </div>
  );
}

function DetailedTrail({
  model,
  streaming,
  reduceMotion,
  onAddToDashboard,
}: {
  model: TrailModel;
  streaming: boolean;
  reduceMotion: boolean;
  onAddToDashboard?: (table: TraceTableEvent) => Promise<void>;
}) {
  const [showDetailedCommentary, setShowDetailedCommentary] = useState(false);
  const reasoningSummary = cleanReasoningSummary(model.reasoningSummary);
  const stepsById = useMemo(
    () => new Map(model.steps.map((step) => [step.id, step])),
    [model.steps],
  );
  const hasCommentary = model.trace.some((entry) => entry.type === "commentary");
  const queryNumbers = useMemo(() => {
    const numbers = new Map<string, number>();
    let next = 0;
    for (const entry of model.trace) {
      if (entry.type !== "step") continue;
      const step = stepsById.get(entry.stepId);
      if (step?.kind === "sql" && !numbers.has(step.id)) numbers.set(step.id, ++next);
    }
    return numbers;
  }, [model.trace, stepsById]);

  if (model.trace.length === 0 && !reasoningSummary && !streaming) return null;

  return (
    <div className={styles.detailedTrail}>
      {reasoningSummary ? (
        <motion.div
          className={`${styles.reasoningSummary} ${styles.detailedReasoningSummary}`}
          initial={reduceMotion ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        >
          <span className={styles.reasoningSummaryLabel}>Reasoning summary</span>
          <p className={styles.thinkingReasoning}>{reasoningSummary}</p>
        </motion.div>
      ) : null}
      {hasCommentary ? (
        <div className={styles.detailedTrailControls}>
          <button
            type="button"
            className={styles.detailedCommentaryToggle}
            onClick={() => setShowDetailedCommentary((current) => !current)}
            aria-pressed={showDetailedCommentary}
          >
            {showDetailedCommentary ? "Show concise commentary" : "Show detailed commentary"}
          </button>
        </div>
      ) : null}
      <motion.div layout={!reduceMotion} className={styles.detailedTimeline}>
        <span aria-hidden className={styles.detailedTimelineRail} />
        <AnimatePresence initial={false}>
          {model.trace.map((entry) => {
            const step = entry.type === "step" ? stepsById.get(entry.stepId) : null;
            if (entry.type === "step" && !step) return null;
            return (
              <motion.div
                layout={!reduceMotion}
                key={entry.id}
                initial={reduceMotion ? false : { opacity: 0, y: 8, scale: 0.99 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={
                  reduceMotion
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 520, damping: 34, mass: 0.65 }
                }
                className={styles.detailedTimelineItem}
              >
                {entry.type === "commentary" ? (
                  <DetailedCommentary
                    content={entry.content}
                    expanded={showDetailedCommentary}
                    reduceMotion={reduceMotion}
                  />
                ) : step?.kind === "sql" ? (
                  <div className={styles.detailedIndent}>
                    <DetailedQueryResult
                      step={step}
                      resultNumber={queryNumbers.get(step.id) ?? 1}
                      reduceMotion={reduceMotion}
                      onAddToDashboard={onAddToDashboard}
                    />
                  </div>
                ) : step ? (
                  <div className={styles.detailedIndent}>
                    <DetailedSupportStep step={step} />
                  </div>
                ) : null}
              </motion.div>
            );
          })}
        </AnimatePresence>
        {streaming && model.status ? (
          <div className={styles.detailedStreamingFooter}>
            <span className={styles.detailedStreamingChip}>
              <span className={styles.spinnerSm} />
            </span>
            <span className={styles.runningShimmer}>{model.status}</span>
          </div>
        ) : null}
      </motion.div>
      {!streaming ? (
        <p className={styles.detailedStats}>
          {model.stats.runtimeLabel} · {(model.stats.durationMs / 1000).toFixed(0)}s · {model.stats.tableCount} SQL quer{model.stats.tableCount === 1 ? "y" : "ies"}
        </p>
      ) : null}
    </div>
  );
}

function selectionIsInside(root: HTMLElement, selection: Selection): boolean {
  if (selection.rangeCount === 0) return false;
  const node = selection.getRangeAt(0).commonAncestorContainer;
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;
  return Boolean(element && root.contains(element));
}

function AnswerSelectionToolbar({
  rootRef,
  onAddToChat,
  reduceMotion,
}: {
  rootRef: RefObject<HTMLElement | null>;
  onAddToChat: (text: string) => void;
  reduceMotion: boolean;
}) {
  const [menu, setMenu] = useState<{ text: string; top: number; left: number } | null>(null);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let clearTimer: number | undefined;
    let selecting = false;

    const clearMenu = () => {
      setOpen(false);
      setMenu(null);
    };

    const scheduleClear = () => {
      if (clearTimer !== undefined) window.clearTimeout(clearTimer);
      // Defer so the toolbar click can commit before selection collapses.
      clearTimer = window.setTimeout(() => {
        clearTimer = undefined;
        if (menuRef.current?.matches(":hover")) return;
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed && selectionIsInside(root, selection)) return;
        clearMenu();
      }, 0);
    };

    const showFromSelection = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selectionIsInside(root, selection)) {
        scheduleClear();
        return;
      }
      const text = selection.toString().replace(/\s+/g, " ").trim();
      if (!text) {
        scheduleClear();
        return;
      }
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width < 2 && rect.height < 2) {
        scheduleClear();
        return;
      }
      if (clearTimer !== undefined) {
        window.clearTimeout(clearTimer);
        clearTimer = undefined;
      }
      setMenu({
        text,
        top: rect.top,
        left: rect.left + rect.width / 2,
      });
      setOpen(true);
    };

    const onMouseDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      selecting = true;
      clearMenu();
    };

    const onMouseUp = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      selecting = false;
      // Only reveal after the gesture finishes.
      window.requestAnimationFrame(showFromSelection);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearMenu();
        return;
      }
      // Shift+arrow / keyboard selection settles on keyup.
      if (event.shiftKey || event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") {
        window.requestAnimationFrame(showFromSelection);
      }
    };

    const onSelectionChange = () => {
      // Ignore live drag updates; only clear once a finished selection goes away.
      if (selecting) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selectionIsInside(root, selection)) {
        scheduleClear();
      }
    };

    const onScroll = () => clearMenu();

    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      if (clearTimer !== undefined) window.clearTimeout(clearTimer);
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [rootRef]);

  if (!menu || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={menuRef}
      className={`${styles.selectionToolbar} ${open ? styles.selectionToolbarOpen : ""}`}
      style={{
        top: menu.top,
        left: menu.left,
        ...(reduceMotion ? { transition: "none" } : null),
      }}
      role="tooltip"
    >
      <button
        type="button"
        className={styles.selectionToolbarAction}
        onMouseDown={(event) => {
          // Keep the selection until click commits the text.
          event.preventDefault();
        }}
        onClick={() => {
          onAddToChat(menu.text);
          window.getSelection()?.removeAllRanges();
          setOpen(false);
          setMenu(null);
        }}
      >
        Add to chat
      </button>
    </div>,
    document.body,
  );
}

function answerTableSourceBadgesHtml(sources: readonly TrailSource[]): string {
  if (sources.length === 0) return "";
  const icons = sources.map((source) => {
    const name = escapeHtml(CONNECTOR_NAMES[source.connector]);
    const src = escapeHtml(CONNECTOR_LOGOS[source.connector]);
    return `<img class="answerTableSourceIcon" src="${src}" alt="" title="Data from ${name}" width="14" height="14" />`;
  }).join("");
  const label = escapeHtml(sources.map((source) => CONNECTOR_NAMES[source.connector]).join(", "));
  return `<span class="answerTableSources" aria-label="Data from ${label}">${icons}</span>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function AssistantMarkdown({
  content,
  sources = [],
  onAddToChat,
  reduceMotion,
}: {
  content: string;
  sources?: readonly TrailSource[];
  onAddToChat?: (text: string) => void;
  reduceMotion: boolean;
}) {
  const sourceBadgesHtml = useMemo(() => answerTableSourceBadgesHtml(sources), [sources]);
  const html = useMemo(
    () => renderAssistantMarkdown(content, { tableSourceBadgesHtml: sourceBadgesHtml }),
    [content, sourceBadgesHtml],
  );
  const proseRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <div
        ref={proseRef}
        className={styles.assistantProse}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {onAddToChat ? (
        <AnswerSelectionToolbar
          rootRef={proseRef}
          onAddToChat={onAddToChat}
          reduceMotion={reduceMotion}
        />
      ) : null}
    </>
  );
}

function AnswerAuditReceipt({ reference }: { reference: TurnLineageReference }) {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<AuditReceiptState>({ kind: "idle" });
  const conversationId = reference.conversationId;
  const turnId = reference.turnId;
  const referenceKey = `${conversationId}:${turnId}`;

  useEffect(() => {
    setOpen(false);
    setState({ kind: "idle" });
  }, [referenceKey]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setState({ kind: "loading" });
    void (async () => {
      try {
        const response = await fetch(
          `/api/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/lineage`,
          { cache: "no-store", signal: controller.signal },
        );
        const payload = await response.json().catch(() => null) as {
          lineage?: unknown;
          error?: string;
        } | null;
        if (!response.ok) {
          throw new Error(payload?.error || "The immutable answer record could not be loaded.");
        }
        const lineage = parseSafeAnswerLineage(payload?.lineage, { conversationId, turnId });
        if (!lineage) throw new Error("The immutable answer record returned invalid metadata.");
        if (!controller.signal.aborted) setState({ kind: "ready", lineage });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          kind: "error",
          message: error instanceof Error ? error.message : "The immutable answer record could not be loaded.",
        });
      }
    })();
    return () => controller.abort();
  }, [attempt, conversationId, open, referenceKey, turnId]);

  return (
    <section className={styles.answerAudit} aria-label="Immutable answer record">
      <button
        type="button"
        className={styles.answerAuditToggle}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>Immutable answer record</span>
        <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open ? (
        <div className={styles.answerAuditPanel}>
          {state.kind === "loading" || state.kind === "idle" ? (
            <p role="status">Loading the sealed receipt…</p>
          ) : state.kind === "error" ? (
            <div role="alert">
              <p>{state.message}</p>
              <button type="button" onClick={() => setAttempt((current) => current + 1)}>Retry</button>
            </div>
          ) : (
            <>
              <dl>
                <div><dt>Answer</dt><dd>{state.lineage.answerState}</dd></div>
                <div><dt>Artifact</dt><dd>{state.lineage.answerArtifactId}</dd></div>
                <div><dt>Sealed</dt><dd>{new Date(state.lineage.finalizedAt).toLocaleString()}</dd></div>
                <div><dt>Evidence queries</dt><dd>{state.lineage.queries.length}</dd></div>
              </dl>
              <p className={styles.answerAuditDigest}>
                Receipt digest <code>{state.lineage.artifactDigest.slice(0, 16)}…</code>
              </p>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * "Key insights" — the answer's headline stat cards. Every value was
 * validated against governed result cells by the runtime before it reached
 * the trace; the browser renders, never computes.
 */
function KeyInsightCards({ insights }: Readonly<{ insights: readonly AnswerKeyInsight[] }>) {
  if (insights.length === 0) return null;
  return (
    <section className={styles.keyInsightStrip} aria-label="Key insights">
      <p className={styles.keyInsightStripTitle}>Key insights</p>
      <ol className={styles.keyInsightStripList} data-count={insights.length}>
        {insights.map((insight, index) => (
          <li className={styles.keyInsightStripItem} key={`${insight.label}:${index}`}>
            <p className={styles.keyInsightStripLabel}>{insight.label}</p>
            <p className={styles.keyInsightStripValue}>{insight.value}</p>
            {insight.detail ? <p className={styles.keyInsightStripDetail}>{insight.detail}</p> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function InsightsStyleTrace({
  events,
  streaming = false,
  detailedMode = false,
  runtime = "openai",
  lineageReference,
  onFollowUp,
  onAddToChat,
  onAddToDashboard,
  onClarification,
}: InsightsStyleTraceProps) {
  const reduceMotion = Boolean(useReducedMotion());
  const model = useMemo(
    () => buildTrailModel(events, streaming, runtime),
    [events, streaming, runtime],
  );
  // Only animate the answer reveal for turns that streamed in this mount.
  // Restored / switched conversations must appear instantly.
  const [participatedInStream, setParticipatedInStream] = useState(streaming);
  if (streaming && !participatedInStream) setParticipatedInStream(true);
  const animateAnswerReveal = (participatedInStream || streaming) && !reduceMotion;
  const answerSections = useMemo(
    () => model.answer && model.answerTables.length > 0
      ? splitAssistantMarkdownLead(model.answer.text)
      : null,
    [model.answer, model.answerTables.length],
  );
  const shimmer = useProgressShimmer(model, streaming, reduceMotion);
  // While step summaries are on screen the latest activity line ("Ran x
  // queries") keeps the live shimmer; the header settles to a static "Working"
  // so only one line moves. The initial acknowledgement is intentionally
  // visible before the plan exists.
  const commentaryLive = streaming
    && (runtime === "v3" || runtime === "codex")
    && model.commentaryUpdates.length > 0;
  const acknowledgementLive = streaming
    && (runtime === "v3" || runtime === "codex")
    && Boolean(model.initialAcknowledgement)
    && !model.answer
    && !model.clarification
    && !model.error;
  const swarmLoading = streaming
    && !model.answer
    && !model.clarification
    && !model.error
    && events.some((event) => event.type === "plan" && event.id.startsWith("swarm_"));

  return (
    <div className={styles.root}>
      {swarmLoading ? (
        <AnimatePresence initial={false}>
          {acknowledgementLive && model.initialAcknowledgement ? (
            <InitialAcknowledgement
              key={model.initialAcknowledgement.id}
              acknowledgement={model.initialAcknowledgement}
              reduceMotion={reduceMotion}
            />
          ) : null}
        </AnimatePresence>
      ) : detailedMode ? (
        <DetailedTrail model={model} streaming={streaming} reduceMotion={reduceMotion} onAddToDashboard={onAddToDashboard} />
      ) : (
        <>
          <AnimatePresence initial={false}>
            {acknowledgementLive && model.initialAcknowledgement ? (
              <InitialAcknowledgement
                key={model.initialAcknowledgement.id}
                acknowledgement={model.initialAcknowledgement}
                reduceMotion={reduceMotion}
              />
            ) : null}
          </AnimatePresence>
          <ThinkingTrail
            model={model}
            streaming={streaming}
            shimmer={shimmer}
            headerShimmer={!commentaryLive}
            reduceMotion={reduceMotion}
          />
          {model.plan ? (
            <PlanChecklist
              plan={model.plan}
              animateIn={animateAnswerReveal}
              reduceMotion={reduceMotion}
            />
          ) : null}
          <AnimatePresence initial={false}>
            {commentaryLive ? (
              <LiveCommentary
                key="live-commentary"
                model={model}
                reduceMotion={reduceMotion}
              />
            ) : null}
          </AnimatePresence>
        </>
      )}
      {(detailedMode || swarmLoading) && model.plan ? (
        <PlanChecklist
          plan={model.plan}
          animateIn={animateAnswerReveal}
          reduceMotion={reduceMotion}
        />
      ) : null}
      {swarmLoading ? (
        <AnimatePresence initial={false}>
          {commentaryLive ? (
            <LiveCommentary
              key="swarm-live-commentary"
              model={model}
              reduceMotion={reduceMotion}
            />
          ) : null}
        </AnimatePresence>
      ) : null}

      {!detailedMode ? (
        <CompactQueries
          tables={model.steps.filter((step) => step.table?.dashboardReplay && tableHasData(step.table))}
          collapsedByDefault
          reduceMotion={reduceMotion}
          onAddToDashboard={onAddToDashboard}
        />
      ) : null}

      {!detailedMode && model.charts.length > 0 ? (
        <div className={styles.responseCharts} aria-label="Charts">
          {model.charts.map((chart) => (
            <Suspense key={chart.event.id} fallback={<ChartLoadingState />}>
              <ResultChart
                event={chart.event}
                table={chart.table}
              />
            </Suspense>
          ))}
        </div>
      ) : null}

      {!streaming && model.answer ? (
        <motion.div
          className={styles.answerBlock}
          initial={
            animateAnswerReveal
              ? { opacity: 0, clipPath: "inset(0 0 100% 0)" }
              : false
          }
          animate={{ opacity: 1, clipPath: "inset(0 0 -8% 0)" }}
          transition={{ duration: animateAnswerReveal ? 2.2 : 0, ease: [0.22, 1, 0.36, 1] }}
        >
          {detailedMode && (model.steps.length > 0 || model.reasoningSummary || model.reasoning) ? (
            <div className={styles.answerEyebrow}>
              <span className={styles.answerEyebrowRule} />
              <span>Answer</span>
            </div>
          ) : null}
          {detailedMode && !(model.answer.state === "Verified" && model.sources.length === 0) ? (
            <div className={styles.answerState} title={answerStateDescriptions[model.answer.state]}>
              {answerStateLabels[model.answer.state]}
            </div>
          ) : null}
          <KeyInsightCards insights={model.answer.keyInsights} />
          <AssistantMarkdown
            content={answerSections?.lead || model.answer.text}
            sources={model.sources}
            onAddToChat={onAddToChat}
            reduceMotion={reduceMotion}
          />
          {model.answerTables.length > 0 ? (
            <div className={styles.answerTables} aria-label="Answer tables">
              {model.answerTables.map((table) => (
                <ResultTable
                  key={table.id}
                  table={table}
                  maxHeight={420}
                  onAddToDashboard={onAddToDashboard}
                />
              ))}
            </div>
          ) : null}
          {answerSections?.detail ? (
            <AssistantMarkdown
              content={answerSections.detail}
              sources={model.sources}
              onAddToChat={onAddToChat}
              reduceMotion={reduceMotion}
            />
          ) : null}
          {/* AnswerAuditReceipt ("Immutable answer record") is temporarily hidden. */}
          {model.answer.followUps.length ? (
            <div className={styles.followUps} aria-label="Suggested follow-up questions">
              {model.answer.followUps.map((followUp) => (
                <button
                  key={followUp}
                  type="button"
                  disabled={!onFollowUp}
                  onClick={() => onFollowUp?.(followUp)}
                >
                  <span className={styles.followUpLabel}>{followUp}</span>
                </button>
              ))}
            </div>
          ) : null}
        </motion.div>
      ) : null}

      {model.clarification ? (
        <div className={styles.clarification}>
          <span className={styles.clarificationEyebrow}>One detail needed</span>
          <h4>{model.clarification.question}</h4>
          <div role="group" aria-label={model.clarification.question} className={styles.clarificationOptions}>
            {model.clarification.options.map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={!onClarification}
                onClick={() => onClarification?.(option.label, option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {!streaming && model.error ? (
        <div className={styles.messageError} role="alert">
          <strong>Chat failed</strong>
          <p>{model.error.message}</p>
        </div>
      ) : null}

      {!streaming
        && model.stopped
        && model.steps.length === 0
        && !(detailedMode && model.reasoningSummary.trim())
        && !model.reasoning.trim() ? (
        <p className={styles.stoppedNote}>Stopped</p>
      ) : null}
    </div>
  );
}
