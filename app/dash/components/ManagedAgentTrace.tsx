"use client";

import { lazy, Suspense, useEffect, useId, useMemo, useState } from "react";
import type { TraceEvent, TraceTableEvent } from "../../../packages/shared/src/agent-runtime";
import { formatReportingPeriodLabel } from "../../../packages/shared/src/reporting-dates";
import { renderAssistantMarkdown } from "../lib/render-assistant-markdown";
import { CONNECTOR_NAMES } from "./connectors";
import OmniTrace from "./OmniTrace";
import proseStyles from "./omni-trace.module.css";
import styles from "./managed-agent-trace.module.css";

const ResultChart = lazy(() => import("./AnalyticalTrace").then((module) => ({ default: module.ResultChart })));

function duration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function progressLabel(events: readonly TraceEvent[]): string {
  const event = [...events].reverse().find((entry) => ["progress", "research", "query", "table", "chart", "validation"].includes(entry.type));
  if (event?.type === "validation") return "Checking the answer";
  if (event?.type === "chart") return "Preparing your chart";
  if (event?.type === "query" || event?.type === "table") return "Making sense of the results";
  if (event?.type === "research") return "Finding the right measures";
  if (event?.type === "progress" && event.stage === "query") return "Checking your data";
  if (event?.type === "progress" && event.stage === "field_values") return "Checking names and filters";
  if (event?.type === "progress" && event.stage === "synthesis") return "Preparing the answer";
  return "Understanding your question";
}

export default function ManagedAgentTrace({ events, streaming = false, dashboardMode = false, onFollowUp, onAddToDashboard }: {
  events: readonly TraceEvent[];
  streaming?: boolean;
  dashboardMode?: boolean;
  onFollowUp?: (prompt: string) => void;
  onAddToDashboard?: (table: TraceTableEvent) => void | Promise<void>;
}) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  const evidenceId = useId();
  useEffect(() => {
    if (!streaming) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [streaming]);
  const model = useMemo(() => {
    const answer = events.findLast((event) => event.type === "answer");
    const failure = events.findLast((event) => event.type === "error");
    const error = failure && (!answer || failure.sequence > answer.sequence) ? failure.message : undefined;
    const queries = events.filter((event) => event.type === "query" && event.view !== "derived_result");
    const charts = events.filter((event) => event.type === "chart");
    const tables = new Map(events.filter((event): event is TraceTableEvent => event.type === "table").map((event) => [event.resultId, event]));
    const firstAt = events[0]?.occurredAt ? Date.parse(events[0].occurredAt) : now;
    const endAt = events.at(-1)?.occurredAt ? Date.parse(events.at(-1)!.occurredAt) : now;
    const sources = [...new Set(answer?.provenance.sources.map((source) => (CONNECTOR_NAMES as Record<string, string>)[source.connector] ?? source.label) ?? [])];
    const reused = Boolean(answer?.text.includes("figures have not been refreshed"));
    return { answer, error, queries, charts, tables, firstAt, endAt, sources, reused };
  }, [events, now]);

  if (dashboardMode) return <OmniTrace events={events} streaming={streaming} dashboardMode onFollowUp={onFollowUp} onAddToDashboard={onAddToDashboard} />;

  const working = streaming && !model.answer && !model.error;
  const audit = events.filter((event) => event.type !== "answer" && event.type !== "chart");
  const validations = events.filter((event) => event.type === "validation");
  const evidenceCount = model.queries.length;
  return (
    <section className={styles.root} aria-label="Albert's answer" data-managed-answer-state={model.answer?.state ?? (working ? "working" : "unavailable")}>
      {working ? (
        <div className={styles.progress}>
          <span className={styles.activityDot} aria-hidden="true" />
          <span role="status" aria-live="polite">{progressLabel(events)}</span>
          <span className={styles.elapsed} aria-hidden="true">{duration(now - model.firstAt)}</span>
        </div>
      ) : null}

      {model.error ? <div className={styles.error} role="alert">{model.error}</div> : null}

      {model.answer ? (
        <>
          <div className={styles.context}>
            {model.sources.length ? <span>{model.sources.join(" · ")}</span> : null}
            {model.answer.provenance.timeRange.label ? <span>{formatReportingPeriodLabel(model.answer.provenance.timeRange.label)}</span> : null}
            {model.reused ? <span className={styles.status}>Saved evidence</span>
              : model.answer.state === "Verified" && !model.error ? <span className={`${styles.status} ${styles.verified}`}>Figures checked</span>
                : model.answer.state === "No data" ? <span className={styles.status}>No matching data</span> : null}
          </div>
          <div className={`${proseStyles.prose} ${styles.answerBody}`} data-testid="managed-answer-content"
            dangerouslySetInnerHTML={{ __html: renderAssistantMarkdown(model.answer.text) }} />
          {model.charts.map((chart) => (
            <div className={styles.chart} key={chart.id}>
              <Suspense fallback={<span>Preparing chart…</span>}><ResultChart event={chart} table={model.tables.get(chart.dataRef)} /></Suspense>
            </div>
          ))}
        </>
      ) : null}

      {audit.length > 0 ? (
        <div className={styles.evidence}>
          <button className={styles.evidenceToggle} type="button" aria-expanded={evidenceOpen} aria-controls={evidenceId}
            onClick={() => setEvidenceOpen((open) => !open)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" className={styles.chevron}>
              <path d="m9 5 7 7-7 7" />
            </svg>
            <span>Evidence and checks</span>
            <span className={styles.evidenceMeta}>{evidenceCount > 0 ? `${evidenceCount} ${evidenceCount === 1 ? "query" : "queries"}` : working ? "In progress" : model.reused ? "Saved results" : "Details"}{!working ? ` · ${duration(model.endAt - model.firstAt)}` : ""}</span>
          </button>
          <div id={evidenceId} className={styles.evidencePanel} hidden={!evidenceOpen}>
          {evidenceOpen ? <>
            <p className={styles.auditNote}>Recorded queries, calculations and validation attempts. A retried step remains here for review.</p>
            <OmniTrace events={audit} streaming={false} onAddToDashboard={onAddToDashboard} />
            {validations.length ? <ul className={styles.validationList} aria-label="Validation attempts">
              {validations.map((event) => <li key={event.id}>
                <strong>{event.name}</strong><span>{event.outcome === "passed" ? "Passed" : event.outcome === "failed" ? "Failed attempt" : "Qualified"}</span>
                <p>{event.detail}</p>
              </li>)}
            </ul> : null}
          </> : null}
          </div>
        </div>
      ) : null}

      {model.answer?.followUps?.length && onFollowUp && !model.error ? <div className={styles.followUps}>
        {model.answer.followUps.slice(0, 2).map((prompt) => <button className={styles.followUp} type="button" key={prompt} onClick={() => onFollowUp(prompt)}>{prompt}<span aria-hidden="true">↗</span></button>)}
      </div> : null}
    </section>
  );
}
