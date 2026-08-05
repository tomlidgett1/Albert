"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type {
  AnswerState,
  TraceEvent,
  TraceProgressStage,
  TraceTableColumn,
  TraceTableEvent,
} from "@/packages/shared/src";
import { formatTraceCell } from "./analytical-values";
import { renderAssistantMarkdown } from "../lib/render-assistant-markdown";
import styles from "./insights-trace.module.css";

type InsightsStyleTraceProps = {
  events: readonly TraceEvent[];
  streaming?: boolean;
  detailedMode?: boolean;
  runtime?: "fixture" | "openai";
  onFollowUp?: (prompt: string) => void;
  onAddToChat?: (text: string) => void;
  onClarification?: (label: string, optionId: string) => void;
};

type TrailStepStatus = "running" | "done" | "error";

type TrailStep = Readonly<{
  id: string;
  kind: "sql" | "tool";
  /** Governed work this step represents; lets a result event settle its own step. */
  stage?: TraceProgressStage;
  title: string;
  detail?: string;
  status: TrailStepStatus;
  rowCount?: number;
  warnings?: readonly string[];
  error?: string;
  table?: TraceTableEvent;
  governed?: Readonly<{
    topic: string;
    metrics: readonly string[];
    dimensions: readonly string[];
    lens: string;
    timeRangeLabel: string;
  }>;
}>;

type TraceEntry =
  | Readonly<{ id: string; type: "commentary"; content: string }>
  | Readonly<{ id: string; type: "step"; stepId: string }>;

type TrailModel = Readonly<{
  steps: readonly TrailStep[];
  reasoning: string;
  status: string;
  /** The substance behind `status` — what the current step is actually reading. */
  statusDetail: string;
  answer?: Readonly<{ state: AnswerState; text: string; followUps: readonly string[] }>;
  clarification?: Readonly<{ question: string; options: readonly Readonly<{ id: string; label: string }>[] }>;
  error?: Readonly<{ message: string; recoverable: boolean }>;
  /** User or navigation stop; shown discreetly, not as a retry error. */
  stopped?: boolean;
  stats: Readonly<{
    stepCount: number;
    tableCount: number;
    durationMs: number;
    runtimeLabel: string;
  }>;
  trace: readonly TraceEntry[];
  governedQueries: readonly NonNullable<TrailStep["governed"]>[];
}>;

function isStopMessage(message: string): boolean {
  return message === "Stopped."
    || message === "Stopped"
    || message === "This analysis was interrupted.";
}

const answerStateDescriptions = {
  Verified: "Validated against complete, query-ready data",
  Qualified: "Useful with a disclosed data or definition limitation",
  Exploratory: "Directional analysis that should be verified before action",
  Clarification: "Albert needs one answer before the analysis can continue",
  Unavailable: "The required data is not currently queryable",
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

export function buildTrailModel(
  events: readonly TraceEvent[],
  streaming: boolean,
  runtime: "fixture" | "openai",
): TrailModel {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const steps: TrailStep[] = [];
  const commentary: string[] = [];
  const trace: TraceEntry[] = [];
  const warningsByStep = new Map<string, string[]>();
  let answer: TrailModel["answer"];
  let clarification: TrailModel["clarification"];
  let error: TrailModel["error"];
  let stopped = false;
  let status = streaming ? "Thinking" : "How this was worked out";
  let statusDetail = "";
  let startedAt: number | undefined;
  let endedAt: number | undefined;

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
      const running = streaming && event.status !== "complete";
      const nextStatus: TrailStepStatus = event.status === "error" ? "error" : running ? "running" : "done";
      // A settling step reports the outcome of work already on screen, so it
      // replaces its own opening step instead of listing a second row.
      const settles = event.status === "complete" || event.status === "error";
      const openIndex = settles && event.stage
        ? lastStepIndex((step) => step.stage === event.stage)
        : -1;
      const open = openIndex >= 0 ? steps[openIndex] : undefined;
      if (open) {
        steps[openIndex] = {
          ...open,
          title: event.label,
          detail: event.detail ?? open.detail,
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
        status: nextStatus,
      });
      continue;
    }

    if (event.type === "narrative") {
      commentary.push(event.text);
      const summary = conciseReasoningSummary(event.text);
      if (summary) {
        status = summary;
        statusDetail = "";
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
      };
      const queryStatus: TrailStepStatus = streaming && event.status !== "complete" ? "running" : "done";
      const fallbackDetail = [event.lens, event.timeRange.label].filter(Boolean).join(" · ");
      // The step that announced this query already carries its metrics,
      // dimensions, and period; upgrade it in place rather than duplicating it.
      const openIndex = lastStepIndex((step) =>
        (step.stage === "query" || step.stage === "source_query") && !step.governed);
      const open = openIndex >= 0 ? steps[openIndex] : undefined;
      status = `Analysing ${humanize(event.topic)}`;
      statusDetail = open?.detail ?? fallbackDetail;
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
      status = event.caption;
      statusDetail = `${event.rows.length.toLocaleString()} governed row${event.rows.length === 1 ? "" : "s"} · ${event.columns.length} column${event.columns.length === 1 ? "" : "s"}`;
      const previous = [...steps].reverse().find((step) => step.kind === "sql" && !step.table);
      if (previous) {
        const index = steps.findIndex((step) => step.id === previous.id);
        steps[index] = {
          ...previous,
          status: "done",
          rowCount: event.rows.length,
          table: event,
          title: previous.title || event.caption,
        };
      } else {
        pushStep({
          id: event.id,
          kind: "sql",
          title: event.caption,
          status: "done",
          rowCount: event.rows.length,
          table: event,
        });
      }
      continue;
    }

    if (event.type === "chart") {
      pushStep({
        id: event.id,
        kind: "tool",
        title: event.caption,
        status: "done",
        detail: `${event.chartType} chart`,
      });
      continue;
    }

    if (event.type === "validation") {
      const target = steps.at(-1);
      if (target) {
        const list = warningsByStep.get(target.id) ?? [];
        list.push(`${event.name}: ${event.detail}`);
        warningsByStep.set(target.id, list);
        if (event.outcome === "failed") {
          const index = steps.findIndex((step) => step.id === target.id);
          steps[index] = { ...target, status: "error", error: event.detail };
        }
      }
      continue;
    }

    if (event.type === "answer") {
      answer = {
        state: event.state,
        text: event.text,
        followUps: event.followUps,
      };
      status = "Answer ready";
      statusDetail = "";
      continue;
    }

    if (event.type === "clarification") {
      clarification = { question: event.question, options: event.options };
      status = "Waiting for one detail";
      statusDetail = event.question;
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
          steps[index] = { ...target, status: "done" };
        }
        continue;
      }
      error = { message: event.message, recoverable: event.recoverable };
      status = event.recoverable ? "Albert can retry this step" : "Analysis stopped";
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
      const nextStatus: TrailStepStatus = step.error ? "error" : "done";
      return { ...step, status: nextStatus };
    }
    return step;
  });

  const durationMs = startedAt !== undefined && endedAt !== undefined
    ? Math.max(0, endedAt - startedAt)
    : 0;

  return {
    steps: normalised,
    reasoning: commentary.join("\n\n"),
    status,
    statusDetail,
    answer,
    clarification,
    error,
    stopped,
    stats: {
      stepCount: normalised.length,
      tableCount: normalised.filter((step) => step.table).length,
      durationMs,
      runtimeLabel: runtime === "fixture" ? "Fixture" : "OpenAI",
    },
    trace,
    governedQueries: normalised
      .map((step) => step.governed)
      .filter((query): query is NonNullable<TrailStep["governed"]> => Boolean(query)),
  };
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

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.stepGlyph} aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
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

function ResultTable({
  table,
  maxRows = 20,
  maxHeight = 192,
}: {
  table: TraceTableEvent;
  maxRows?: number;
  maxHeight?: number;
}) {
  const rows = table.rows.slice(0, maxRows);
  return (
    <div className={styles.resultTableWrap} style={{ maxHeight }}>
      <table className={styles.resultTable}>
        <thead>
          <tr>
            {table.columns.map((column) => (
              <th key={column.key}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`${table.resultId}_${rowIndex}`}>
              {table.columns.map((column: TraceTableColumn) => (
                <td key={column.key}>{formatTraceCell(row[column.key] ?? null, column)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.rows.length > rows.length ? (
        <p className={styles.resultTableFooter}>
          Showing the first {rows.length.toLocaleString()} of {table.rows.length.toLocaleString()} rows
        </p>
      ) : null}
    </div>
  );
}

function StepRow({ step }: { step: TrailStep }) {
  const [showPreview, setShowPreview] = useState(false);
  return (
    <div className={styles.stepRow}>
      <span className={styles.stepRowIcon}>
        {step.kind === "sql" ? <SearchIcon /> : <SparklesIcon size={14} />}
      </span>
      <div className={styles.stepRowBody}>
        <div className={styles.stepRowTitleLine}>
          <span className={step.status === "error" ? styles.stepTitleError : styles.stepTitle}>
            {step.title}
          </span>
          {typeof step.rowCount === "number" ? (
            <span className={styles.stepMeta}>
              {step.rowCount.toLocaleString()} row{step.rowCount === 1 ? "" : "s"}
            </span>
          ) : null}
          {step.status === "running" ? (
            <span className={styles.runningShimmer}>running</span>
          ) : null}
        </div>
        {step.detail ? <div className={styles.stepDetail}>{step.detail}</div> : null}
        {step.error ? <div className={styles.stepError}>{step.error}</div> : null}
        {step.warnings?.map((warning) => (
          <div key={warning} className={styles.stepWarning}>{warning}</div>
        ))}
        {step.table && step.table.rows.length > 0 ? (
          <>
            <button
              type="button"
              className={styles.sqlToggle}
              onClick={() => setShowPreview((current) => !current)}
            >
              {showPreview ? "Hide preview" : "Show preview"}
            </button>
            {showPreview ? <ResultTable table={step.table} /> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function GovernedQuerySummary({
  query,
}: {
  query: NonNullable<TrailStep["governed"]>;
}) {
  return (
    <div className={styles.governedQuery}>
      <p className={styles.governedQueryEyebrow}>Governed plan</p>
      <h4 className={styles.governedQueryTopic}>{humanize(query.topic)}</h4>
      {query.lens ? <p className={styles.governedQueryLens}>{humanize(query.lens)}</p> : null}
      <dl className={styles.governedQueryFields}>
        {query.metrics.length > 0 ? (
          <div>
            <dt>Metrics</dt>
            <dd>
              {query.metrics.map((metric) => (
                <span key={metric}>{humanize(metric)}</span>
              ))}
            </dd>
          </div>
        ) : null}
        {query.dimensions.length > 0 ? (
          <div>
            <dt>Dimensions</dt>
            <dd>
              {query.dimensions.map((dimension) => (
                <span key={dimension}>{humanize(dimension)}</span>
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
      </dl>
    </div>
  );
}

function StreamingTrace({
  steps,
  headline,
  detail,
  reduceMotion = false,
}: {
  steps: readonly TrailStep[];
  headline: string;
  detail: string;
  reduceMotion?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const lineTransition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.45, ease: [0.22, 1, 0.36, 1] as const };
  const sublineTransition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.45, ease: [0.22, 1, 0.36, 1] as const, delay: 0.08 };

  return (
    <motion.div
      className={styles.streamingTrace}
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : { duration: 0.42, ease: [0.22, 1, 0.36, 1] }
      }
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className={styles.streamingToggle}
      >
        <span className={styles.streamingHeadlineGroup}>
          <span className={styles.streamingHeadline}>
            <span aria-hidden className={styles.streamingMeasure}>{headline}</span>
            <AnimatePresence>
              <motion.span
                key={headline}
                initial={reduceMotion ? false : { y: "110%", opacity: 0 }}
                animate={{ y: "0%", opacity: 1 }}
                exit={reduceMotion ? undefined : { y: "-110%", opacity: 0 }}
                transition={lineTransition}
                className={styles.streamingLive}
              >
                {headline}
              </motion.span>
            </AnimatePresence>
          </span>
          {detail ? (
            <span className={styles.streamingSubline}>
              <span aria-hidden className={styles.streamingSublineMeasure}>{detail}</span>
              <AnimatePresence>
                <motion.span
                  key={detail}
                  initial={reduceMotion ? false : { y: "110%", opacity: 0 }}
                  animate={{ y: "0%", opacity: 1 }}
                  exit={reduceMotion ? undefined : { y: "-110%", opacity: 0 }}
                  transition={sublineTransition}
                  className={styles.streamingSublineLive}
                >
                  {detail}
                </motion.span>
              </AnimatePresence>
            </span>
          ) : null}
        </span>
        {steps.length > 0 ? (
          <span className={styles.streamingChevron}>
            <Chevron open={expanded} />
          </span>
        ) : null}
      </button>

      <div
        className={styles.expandPanel}
        style={{
          gridTemplateRows: expanded ? "1fr" : "0fr",
          opacity: expanded ? 1 : 0,
        }}
        data-duration="400"
      >
        <div className={styles.expandInner}>
          <div className={styles.streamingSteps}>
            {steps.map((step, index) => (
              <div
                key={step.id}
                className={styles.streamingStep}
                style={{ animationDelay: `${Math.min(index, 6) * 120}ms` }}
              >
                {step.status === "running" ? (
                  <span className={styles.spinner} />
                ) : step.status === "error" ? (
                  <span className={styles.streamingStepIcon}><CrossIcon size={14} /></span>
                ) : (
                  <span className={styles.streamingStepIcon}><CheckIcon size={14} /></span>
                )}
                <span className={styles.streamingStepBody}>
                  <span className={styles.streamingStepTitleLine}>
                    <span className={styles.streamingStepTitle}>{step.title}</span>
                    {typeof step.rowCount === "number" ? (
                      <span className={styles.stepMeta}>
                        {step.rowCount.toLocaleString()} row{step.rowCount === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </span>
                  {step.detail ? (
                    <span className={styles.streamingStepDetail}>{step.detail}</span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function ThinkingTrail({
  model,
  streaming,
  reduceMotion = false,
}: {
  model: TrailModel;
  streaming: boolean;
  reduceMotion?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasTrail = model.steps.length > 0 || model.reasoning.trim().length > 0 || streaming;
  if (!hasTrail) return null;

  if (streaming) {
    return (
      <StreamingTrace
        steps={model.steps}
        headline={model.status || "Thinking"}
        detail={model.statusDetail}
        reduceMotion={reduceMotion}
      />
    );
  }

  const failed = Boolean(model.error);
  const answerState = model.answer?.state;
  const label = model.stats.stepCount > 0
    ? `Worked through ${model.stats.stepCount} step${model.stats.stepCount === 1 ? "" : "s"}`
    : "How this was worked out";
  const meta = model.stats.durationMs > 0
    ? `${(model.stats.durationMs / 1000).toFixed(0)}s · ${model.stats.tableCount} quer${model.stats.tableCount === 1 ? "y" : "ies"}`
    : null;
  const reasoning = cleanReasoningSummary(model.reasoning);
  const stateClass = answerState === "Verified" ? styles.thinkingStateVerified
    : answerState === "Qualified" ? styles.thinkingStateQualified
      : answerState === "Exploratory" ? styles.thinkingStateExploratory
        : answerState === "Clarification" ? styles.thinkingStateClarification
          : answerState === "Unavailable" ? styles.thinkingStateUnavailable
            : failed ? styles.thinkingStateUnavailable
              : "";

  return (
    <div
      className={styles.thinkingCard}
      style={{ borderRadius: open ? 12 : 14 }}
    >
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className={`${styles.thinkingHeader} ${stateClass}`}
        aria-expanded={open}
        title={answerState ? answerStateDescriptions[answerState] : undefined}
      >
        <span className={styles.thinkingTitle}>
          <span className={styles.thinkingLabel}>{label}</span>
          <span className={styles.thinkingChevron}><Chevron open={open} /></span>
        </span>
        {answerState ? (
          <span className={styles.thinkingStateBadge}>{answerState}</span>
        ) : null}
        {model.stopped ? <span className={styles.thinkingStopped}>Stopped</span> : null}
        {meta ? <span className={styles.thinkingMeta}>{meta}</span> : null}
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
          <div className={styles.thinkingBody}>
            <div className={styles.thinkingBodyContent}>
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
              {reasoning ? (
                <p
                  className={styles.thinkingReasoning}
                  style={open ? { animationDelay: "120ms" } : undefined}
                >
                  {reasoning}
                </p>
              ) : null}
              {model.steps.map((step, index) => (
                <div
                  key={step.id}
                  style={open ? { animationDelay: `${120 + Math.min(index, 6) * 70}ms` } : undefined}
                  className={styles.rowIn}
                >
                  <StepRow step={step} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
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
}: {
  step: TrailStep;
  resultNumber: number;
  reduceMotion: boolean;
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
      ) : !step.table || step.table.rows.length === 0 ? (
        <p className={styles.detailedQueryEmpty}>The query completed with no rows.</p>
      ) : (
        <ResultTable table={step.table} maxRows={80} maxHeight={360} />
      )}
    </motion.div>
  );
}

function DetailedSupportStep({ step }: { step: TrailStep }) {
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
}: {
  model: TrailModel;
  streaming: boolean;
  reduceMotion: boolean;
}) {
  const [showDetailedCommentary, setShowDetailedCommentary] = useState(false);
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

  if (model.trace.length === 0 && !streaming) return null;

  return (
    <div className={styles.detailedTrail}>
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

function AssistantMarkdown({
  content,
  onAddToChat,
  reduceMotion,
}: {
  content: string;
  onAddToChat?: (text: string) => void;
  reduceMotion: boolean;
}) {
  const html = useMemo(() => renderAssistantMarkdown(content), [content]);
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

export default function InsightsStyleTrace({
  events,
  streaming = false,
  detailedMode = false,
  runtime = "openai",
  onFollowUp,
  onAddToChat,
  onClarification,
}: InsightsStyleTraceProps) {
  const reduceMotion = Boolean(useReducedMotion());
  const model = useMemo(
    () => buildTrailModel(events, streaming, runtime),
    [events, streaming, runtime],
  );
  // Only animate the answer reveal for turns that streamed in this mount.
  // Restored / switched conversations must appear instantly.
  const participatedInStreamRef = useRef(streaming);
  if (streaming) participatedInStreamRef.current = true;
  const animateAnswerReveal = participatedInStreamRef.current && !reduceMotion;

  return (
    <div className={styles.root}>
      {detailedMode ? (
        <DetailedTrail model={model} streaming={streaming} reduceMotion={reduceMotion} />
      ) : (
        <ThinkingTrail model={model} streaming={streaming} reduceMotion={reduceMotion} />
      )}

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
          {detailedMode && (model.steps.length > 0 || model.reasoning) ? (
            <div className={styles.answerEyebrow}>
              <span className={styles.answerEyebrowRule} />
              <span>Answer</span>
            </div>
          ) : null}
          {detailedMode || !(model.steps.length > 0 || model.reasoning.trim().length > 0) ? (
            <div className={styles.answerState} title={answerStateDescriptions[model.answer.state]}>
              {model.answer.state}
            </div>
          ) : null}
          <AssistantMarkdown
            content={model.answer.text}
            onAddToChat={onAddToChat}
            reduceMotion={reduceMotion}
          />
          {model.answer.followUps.length ? (
            <div className={styles.followUps} aria-label="Suggested follow-up questions">
              {model.answer.followUps.map((followUp) => (
                <button
                  key={followUp}
                  type="button"
                  disabled={!onFollowUp}
                  onClick={() => onFollowUp?.(followUp)}
                >
                  <svg className={styles.followUpIcon} viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M5.5 3.5h7v7M12.5 3.5 3.5 12.5"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span>{followUp}</span>
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
        <p className={styles.messageError} role="alert">
          <strong>{model.error.recoverable ? "Albert can retry this step" : "Analysis stopped"}</strong>
          {" "}
          {model.error.message}
        </p>
      ) : null}

      {!streaming && model.stopped && model.steps.length === 0 && !model.reasoning.trim() ? (
        <p className={styles.stoppedNote}>Stopped</p>
      ) : null}
    </div>
  );
}
