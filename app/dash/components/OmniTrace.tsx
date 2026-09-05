"use client";

import Image from "next/image";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { CONNECTOR_LOGOS, CONNECTOR_NAMES } from "./connectors";
import { containsAnswerTemplate } from "../../../packages/shared/src/agent-runtime";
import type {
  TraceChartEvent,
  TraceEvent,
  TraceQueryEvent,
  TraceResearchEvent,
  TraceTableEvent,
  TraceTasksEvent,
} from "../../../packages/shared/src/agent-runtime";
import { formatTraceCell } from "./analytical-values";
import { TileTable } from "./DashboardTileView";
import { renderAssistantMarkdown } from "../lib/render-assistant-markdown";
import { dashboardActivityLabel } from "../lib/dashboard-build-view";
import styles from "./omni-trace.module.css";

const ResultChart = lazy(() => import("./AnalyticalTrace").then((module) => ({
  default: module.ResultChart,
})));

type OmniResearchEntry =
  | Readonly<{ kind: "step"; id: string; event: TraceResearchEvent }>
  | Readonly<{ kind: "prose"; id: string; text: string }>;

type OmniBlock =
  | Readonly<{ kind: "tasks"; id: string; event: TraceTasksEvent }>
  | Readonly<{ kind: "prose"; id: string; text: string; warning?: boolean }>
  | { kind: "research"; id: string; entries: OmniResearchEntry[]; stepCount: number }
  | { kind: "query"; id: string; query: TraceQueryEvent; table?: TraceTableEvent; pivot?: boolean }
  | Readonly<{ kind: "chart"; id: string; chart: TraceChartEvent; table?: TraceTableEvent }>;

type OmniModel = Readonly<{
  blocks: readonly OmniBlock[];
  answer?: Readonly<{ text: string; followUps: readonly string[] }>;
  clarification?: Readonly<{ question: string; options: readonly Readonly<{ id: string; label: string }>[] }>;
  error?: string;
  thinkingLabel: string;
}>;

const NUMERIC_COLUMN_TYPES = new Set(["number", "currency", "percent"]);

function buildOmniModel(events: readonly TraceEvent[], dashboardMode = false): OmniModel {
  const blocks: OmniBlock[] = [];
  const tablesByResultId = new Map<string, TraceTableEvent>();
  let tasksBlock: { kind: "tasks"; id: string; event: TraceTasksEvent } | undefined;
  let answer: OmniModel["answer"];
  let clarification: OmniModel["clarification"];
  let error: string | undefined;
  let runningLabel = dashboardMode ? "Reading your data model" : "Thinking";

  const openResearch = (): Extract<OmniBlock, { kind: "research" }> => {
    const last = blocks.at(-1);
    if (last && last.kind === "research") return last;
    const block: Extract<OmniBlock, { kind: "research" }> = {
      kind: "research",
      id: `research-${blocks.length}`,
      entries: [],
      stepCount: 0,
    };
    blocks.push(block);
    return block;
  };

  for (const event of events) {
    // Dashboard builds narrate as design work: "Determining the best
    // elements", "Creating element: Revenue trend" — every step that says
    // something about the build updates the live thinking state.
    if (dashboardMode) {
      const activity = dashboardActivityLabel(event);
      if (activity) runningLabel = activity;
    }
    switch (event.type) {
      case "tasks": {
        if (tasksBlock) {
          tasksBlock.event = event;
        } else {
          tasksBlock = { kind: "tasks", id: event.id, event };
          blocks.push(tasksBlock as OmniBlock);
        }
        break;
      }
      case "plan": {
        // Plan events (e.g. a reloaded swarm parent turn) render through the
        // same checklist card; a done step reads as a completed task.
        const asTasks: TraceTasksEvent = {
          id: event.id,
          sequence: event.sequence,
          type: "tasks",
          occurredAt: event.occurredAt,
          items: event.steps.map((step) => ({
            id: step.id,
            label: step.label,
            completed: step.status === "done",
          })),
        };
        if (tasksBlock) {
          tasksBlock.event = asTasks;
        } else {
          tasksBlock = { kind: "tasks", id: event.id, event: asTasks };
          blocks.push(tasksBlock as OmniBlock);
        }
        break;
      }
      case "research": {
        const group = openResearch();
        group.entries.push({ kind: "step", id: event.id, event });
        group.stepCount += 1;
        break;
      }
      case "dashboard_plan": {
        // A build turn's composition reads as one prose line in the trail;
        // the dashboard itself is the product, over in the build panel.
        blocks.push({
          kind: "prose",
          id: event.id,
          text: event.tiles.length === 1
            // An element edit composes exactly the replacement (ADR 0134).
            ? `Reworked the element “${event.tiles[0]!.title}” · ${event.timeframe}.`
            : `Composed the dashboard “${event.dashboardTitle}” — ${event.tiles.length} elements · ${event.timeframe}.`,
        });
        break;
      }
      case "narrative": {
        const text = event.text.trim();
        // Old traces may contain a composition draft emitted as commentary.
        // Apply the same guard on replay as the runtime applies before saving.
        if (!text || containsAnswerTemplate(text)) break;
        const last = blocks.at(-1);
        if (last && last.kind === "research" && event.purpose === undefined) {
          last.entries.push({ kind: "prose", id: event.id, text });
        } else {
          blocks.push({ kind: "prose", id: event.id, text });
        }
        break;
      }
      case "query": {
        // ComposePivotTable reports itself as a derived result: its card is
        // the pivot, open by default, not a collapsed evidence query.
        blocks.push({
          kind: "query",
          id: event.id,
          query: event,
          ...(event.view === "derived_result" ? { pivot: true } : {}),
        });
        break;
      }
      case "table": {
        tablesByResultId.set(event.resultId, event);
        const pending = [...blocks].reverse().find((block): block is Extract<OmniBlock, { kind: "query" }> => (
          block.kind === "query" && block.table === undefined
        ));
        const queryName = pending?.query.name ?? pending?.query.topic;
        if (pending && (event.caption === queryName || event.caption === pending.query.name)) {
          pending.table = event;
        }
        break;
      }
      case "chart": {
        blocks.push({
          kind: "chart",
          id: event.id,
          chart: event,
          table: tablesByResultId.get(event.dataRef),
        });
        break;
      }
      case "progress": {
        if (event.status === "running") {
          // Dashboard mode already mapped this label above.
          if (!dashboardMode) runningLabel = event.label;
        } else if (event.status === "warning") {
          blocks.push({
            kind: "prose",
            id: event.id,
            text: event.detail ? `${event.label} — ${event.detail}` : event.label,
            warning: true,
          });
        }
        break;
      }
      case "answer": {
        answer = { text: event.text, followUps: event.followUps };
        break;
      }
      case "clarification": {
        clarification = { question: event.question, options: event.options };
        break;
      }
      case "error": {
        error = event.message;
        break;
      }
      default:
        break;
    }
  }

  return Object.freeze({
    blocks,
    ...(answer ? { answer } : {}),
    ...(clarification ? { clarification } : {}),
    ...(error ? { error } : {}),
    thinkingLabel: runningLabel,
  });
}

function formatWorkDuration(ms: number): string {
  const seconds = Math.max(1, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return restSeconds > 0 ? `${minutes}m ${restSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

/**
 * Codex-style work header: a full-width rule and a live "Working for 12s"
 * timer that settles into "Worked for 3m 24s" once the turn has produced its
 * terminal event. Timing prefers the trace's own timestamps so reloaded
 * history reads the turn's real duration; the mount clock only bridges the
 * first seconds of a live turn before its first event lands.
 */
function WorkHeader({ events, working }: {
  events: readonly TraceEvent[];
  working: boolean;
}) {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(mountedAt);
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [working]);
  const firstAt = events.length > 0 ? Date.parse(events[0]!.occurredAt) : Number.NaN;
  const lastAt = events.length > 0 ? Date.parse(events[events.length - 1]!.occurredAt) : Number.NaN;
  const startedAt = Number.isFinite(firstAt)
    ? (working ? Math.min(firstAt, mountedAt) : firstAt)
    : mountedAt;
  const endedAt = working ? now : (Number.isFinite(lastAt) ? lastAt : now);
  const duration = formatWorkDuration(Math.max(0, endedAt - startedAt));
  return (
    <div className={styles.workHeader} data-working={working}>
      {working ? `Working for ${duration}` : `Worked for ${duration}`}
    </div>
  );
}

function Chevron({ open, className }: { open: boolean; className: string }) {
  return (
    <svg className={className} data-open={open} viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  );
}

function TasksCard({ event }: { event: TraceTasksEvent }) {
  const done = event.items.filter((item) => item.completed).length;
  return (
    <section className={styles.tasksCard} aria-label="Tasks">
      <div className={styles.tasksHeader}>{`Tasks (${done} of ${event.items.length})`}</div>
      <div className={styles.tasksList}>
        {event.items.map((item) => (
          <div className={styles.taskRow} data-completed={item.completed} key={item.id}>
            <span className={styles.taskCheck} data-completed={item.completed} aria-hidden="true">
              <CheckGlyph />
            </span>
            <span>{item.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

const RESEARCH_TOOL_NAMES: Readonly<Record<TraceResearchEvent["tool"], string>> = {
  search_model: "Search model",
  value_lookup: "Value lookup",
  docs: "Docs",
  current_time: "Current time",
};

function StepIcon({ tool }: { tool: TraceResearchEvent["tool"] }) {
  if (tool === "value_lookup") {
    return (
      <svg className={styles.stepIcon} viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="10.5" cy="10.5" r="6.2" />
        <path d="m15.3 15.3 4.6 4.6" />
      </svg>
    );
  }
  return (
    <svg className={styles.stepIcon} viewBox="0 0 24 24" aria-hidden="true">
      <path d="m12 3 9 4.6-9 4.6-9-4.6L12 3Z" />
      <path d="m3.6 12.4 8.4 4.3 8.4-4.3" />
      <path d="m3.6 16.6 8.4 4.3 8.4-4.3" />
    </svg>
  );
}

function ResearchStepCard({ event }: { event: TraceResearchEvent }) {
  const [open, setOpen] = useState(false);
  const hasBody = Boolean(event.document || event.values?.length || event.query);
  return (
    <div className={styles.stepCard}>
      <button
        className={styles.stepHeader}
        type="button"
        aria-expanded={open}
        onClick={() => hasBody && setOpen((current) => !current)}
      >
        <Chevron open={open} className={styles.stepChevron} />
        <StepIcon tool={event.tool} />
        <span className={styles.stepTool}>{RESEARCH_TOOL_NAMES[event.tool]}</span>
        <span className={styles.stepLabel}>{event.label}</span>
        {event.summary ? <span className={styles.stepSummary}>{event.summary}</span> : null}
      </button>
      {hasBody ? (
        <div className={styles.stepBody} data-open={open} aria-hidden={!open} inert={!open}>
          <div className={styles.stepBodyInner}>
            {event.query ? (
              <div className={styles.stepQueryLine}>{`Search: "${event.query}"`}</div>
            ) : null}
            {event.values?.length ? (
              <div className={styles.stepValues}>
                {event.values.map((value, index) => <span key={`${value}-${index}`}>{value}</span>)}
              </div>
            ) : null}
            {event.document ? (
              <div className={styles.stepDocument}>{event.document}</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ResearchGroup({ block }: { block: Extract<OmniBlock, { kind: "research" }> }) {
  const [open, setOpen] = useState(true);
  return (
    <section className={styles.researchGroup} aria-label="Research">
      <button
        className={styles.researchHeader}
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Chevron open={open} className={styles.researchChevron} />
        <span>{`Research · ${block.stepCount} ${block.stepCount === 1 ? "step" : "steps"}`}</span>
      </button>
      <div className={styles.researchBody} data-open={open}>
        <div className={styles.researchBodyInner}>
          <div className={styles.researchRail}>
            {block.entries.map((entry) => entry.kind === "step" ? (
              <ResearchStepCard event={entry.event} key={entry.id} />
            ) : (
              <Prose text={entry.text} key={entry.id} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function describeChipFilter(filter: NonNullable<TraceTableEvent["provenance"]["filters"]>[number]): {
  field: string;
  condition: string;
} {
  const text = filter.text.trim();
  if (text.toLowerCase().startsWith(filter.label.toLowerCase())) {
    return { field: filter.label, condition: text.slice(filter.label.length).trim() };
  }
  return { field: filter.label, condition: text };
}

type AddToDashboard = (table: TraceTableEvent) => void | Promise<void>;

function PinButton({ table, onAddToDashboard }: {
  table: TraceTableEvent | undefined;
  onAddToDashboard: AddToDashboard | undefined;
}) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "failed">("idle");
  if (!table?.dashboardReplay || !onAddToDashboard) return null;
  return (
    <button
      className={styles.pinButton}
      type="button"
      data-state={state}
      disabled={state === "busy"}
      aria-label={state === "done" ? "Added to dashboard" : "Add to dashboard"}
      title={state === "done" ? "Added to dashboard" : "Add to dashboard"}
      onClick={(clickEvent) => {
        clickEvent.stopPropagation();
        setState("busy");
        void Promise.resolve(onAddToDashboard(table)).then(
          () => setState("done"),
          () => setState("failed"),
        );
      }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {state === "done"
          ? <path d="m5 12.5 4.5 4.5L19 7" />
          : <><rect x="3.5" y="4" width="17" height="16" rx="2.5" /><path d="M12 9v6M9 12h6" /></>}
      </svg>
      <span>{state === "done" ? "Added" : state === "failed" ? "Try again" : "Add to dashboard"}</span>
    </button>
  );
}

/**
 * A composed pivot: the product of the turn, so it opens expanded, drawn by
 * the dashboard's own pivot renderer (frozen metric column, right-aligned
 * figures, row units), with a one-click pin to the dashboard.
 */
function PivotCard({ block, onAddToDashboard }: {
  block: Extract<OmniBlock, { kind: "query" }>;
  onAddToDashboard: AddToDashboard | undefined;
}) {
  const [open, setOpen] = useState(true);
  const { query, table } = block;
  const title = query.name ?? query.topic;
  const metricCount = table?.rows.length ?? query.rowCount;
  const periodCount = table ? Math.max(0, table.columns.length - 1) : undefined;
  const summary = [
    metricCount !== undefined ? `${metricCount} ${metricCount === 1 ? "metric" : "metrics"}` : null,
    periodCount !== undefined ? `${periodCount} ${periodCount === 1 ? "period" : "periods"}` : null,
  ].filter(Boolean).join(" × ");
  return (
    <section className={styles.pivotCard} aria-label={`Pivot: ${title}`} data-open={open}>
      <div className={styles.pivotHeader}>
        <button
          className={styles.stepHeader}
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <Chevron open={open} className={styles.stepChevron} />
          <svg className={styles.stepIcon} viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3.5" y="4.5" width="17" height="15" rx="1.6" />
            <path d="M3.5 9.5h17M9.5 4.5v15M3.5 14.5h17" />
          </svg>
          <span className={styles.stepTool}>Pivot</span>
          <span className={styles.stepLabel}>{title}</span>
          {summary ? <span className={styles.stepSummary}>{summary}</span> : null}
        </button>
        <PinButton table={table} onAddToDashboard={onAddToDashboard} />
      </div>
      <div className={styles.stepBody} data-open={open} aria-hidden={!open} inert={!open}>
        <div className={styles.stepBodyInner}>
          {table ? (
            <div className={styles.pivotBody}>
              <TileTable
                data={{
                  columns: table.columns,
                  rows: table.rows,
                  ...(table.rowFormats ? { rowFormats: table.rowFormats } : {}),
                  pivot: true,
                }}
                ariaLabel={title}
              />
            </div>
          ) : (
            <div className={styles.queryFooter}>Composing…</div>
          )}
        </div>
      </div>
    </section>
  );
}

function QueryCard({ block }: {
  block: Extract<OmniBlock, { kind: "query" }>;
}) {
  // Evidence stays a click away: the answer carries the story, so query
  // cards open collapsed with their name, topic and row count on show.
  const [open, setOpen] = useState(false);
  const { query, table } = block;
  const title = query.name ?? query.topic;
  const rowCount = query.rowCount ?? table?.rows.length;
  const summary = `From ${query.topic}${rowCount !== undefined ? ` · ${rowCount} ${rowCount === 1 ? "row" : "rows"}` : ""}`;
  const filters = table?.provenance.filters ?? [];
  const timeLabel = query.timeRange.label;
  const chips: Array<{ field: string; condition: string }> = [];
  if (timeLabel && timeLabel !== "All recorded history") {
    const timeField = table?.provenance.definitions.find((definition) => definition.kind === "time");
    chips.push({ field: timeField?.label ?? "Date", condition: timeLabel });
  }
  for (const filter of filters.slice(0, 6)) chips.push(describeChipFilter(filter));
  return (
    <section className={styles.queryCard} aria-label={`Query: ${title}`}>
      <button
        className={styles.stepHeader}
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Chevron open={open} className={styles.stepChevron} />
        <svg className={styles.stepIcon} viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3.5" y="4.5" width="17" height="15" rx="1.6" />
          <path d="M3.5 9.5h17M9.5 9.5v10" />
        </svg>
        <span className={styles.stepTool}>Query</span>
        <span className={styles.stepLabel}>{title}</span>
        <span className={styles.stepSummary}>{summary}</span>
        {query.connector && CONNECTOR_LOGOS[query.connector] ? (
          <span
            className={styles.stepConnectorLogo}
            title={`Data from ${CONNECTOR_NAMES[query.connector]}`}
          >
            <Image
              src={CONNECTOR_LOGOS[query.connector]}
              alt={CONNECTOR_NAMES[query.connector]}
              width={16}
              height={16}
            />
          </span>
        ) : null}
      </button>
      <div className={styles.stepBody} data-open={open} aria-hidden={!open} inert={!open}>
        <div className={styles.stepBodyInner}>
          {chips.length > 0 ? (
            <div className={styles.queryChips}>
              {chips.map((chip, index) => (
                <span className={styles.queryChip} key={`${chip.field}-${index}`}>
                  <span className={styles.queryChipField}>{chip.field}</span>
                  <span>{chip.condition}</span>
                </span>
              ))}
            </div>
          ) : null}
          {table ? (
            <>
              <div className={styles.queryTableWrap}>
                <table className={styles.queryTable}>
                  <thead>
                    <tr>
                      <th aria-label="Row" />
                      {table.columns.map((column) => (
                        <th key={column.key} data-numeric={NUMERIC_COLUMN_TYPES.has(column.type)}>
                          <span className={styles.queryColTopic}>{query.topic}</span>
                          <span className={styles.queryColLabel}>{column.label}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.slice(0, 50).map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        <td className={styles.queryRowIndex}>{rowIndex + 1}</td>
                        {table.columns.map((column) => (
                          <td key={column.key} data-numeric={NUMERIC_COLUMN_TYPES.has(column.type)}>
                            {formatTraceCell(row[column.key] ?? null, column, table.rowFormats?.[rowIndex])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(rowCount ?? 0) > 50 || table.rows.length > 50 ? (
                <div className={styles.queryFooter}>
                  {`Showing the first ${Math.min(table.rows.length, 50)} of ${rowCount ?? table.rows.length} rows.`}
                </div>
              ) : null}
            </>
          ) : (
            <div className={styles.queryFooter}>Running…</div>
          )}
        </div>
      </div>
    </section>
  );
}

/** True for figure-shaped cells: money, counts, percentages, deltas, hours. */
function isFigureCell(raw: string): boolean {
  const text = raw.trim();
  if (text === "" || text === "—" || text === "-" || text === "n/a") return true;
  if (!/\d/u.test(text)) return false;
  const withoutUnits = text.replace(/\b(?:AUD|USD|EUR|GBP|NZD|hrs?|hours?|pp|wk|mo)\b\.?/giu, "");
  return !/[A-Za-z]{3,}/u.test(withoutUnits);
}

/**
 * Marks figure columns so the stylesheet can right-align them while label
 * and note columns stay left-aligned.
 */
function alignAnswerTables(root: HTMLElement): void {
  for (const table of root.querySelectorAll("table")) {
    const bodyRows = [...table.querySelectorAll("tbody tr")];
    if (bodyRows.length === 0) continue;
    // A bolded first cell marks a statement subtotal/total line; the row is
    // tagged so the stylesheet can draw the accountant's rule above it.
    for (const row of bodyRows) {
      const statement = Boolean(row.children[0]?.querySelector("strong"));
      row.setAttribute("data-statement-row", String(statement));
    }
    const columnCount = Math.max(...bodyRows.map((row) => row.children.length));
    for (let column = 0; column < columnCount; column += 1) {
      const cells = bodyRows
        .map((row) => row.children[column])
        .filter((cell): cell is Element => cell !== undefined);
      const filled = cells.filter((cell) => {
        const text = (cell.textContent ?? "").trim();
        return text !== "" && text !== "—" && text !== "-";
      });
      const numeric = filled.length > 0 && filled.every((cell) =>
        isFigureCell((cell.textContent ?? "").trim()));
      for (const cell of cells) cell.setAttribute("data-numeric", String(numeric));
      const header = table.querySelectorAll("thead th")[column];
      header?.setAttribute("data-numeric", String(numeric));
    }
  }
}

function Prose({ text, warning, onFollowUp }: {
  text: string;
  warning?: boolean;
  onFollowUp?: (prompt: string) => void;
}) {
  const html = useMemo(() => renderAssistantMarkdown(text), [text]);
  const rootRef = useRef<HTMLDivElement>(null);
  // No dependency list: innerHTML only changes on a commit, and re-walking a
  // handful of table cells is cheap, so aligning after every commit is the
  // robust way to survive React swapping the injected markup underneath us.
  useEffect(() => {
    if (rootRef.current) alignAnswerTables(rootRef.current);
  });
  return (
    <div
      ref={rootRef}
      className={styles.prose}
      style={warning ? { color: "light-dark(#92400e, #f0b04e)" } : undefined}
      onClick={(clickEvent) => {
        if (!onFollowUp) return;
        const anchor = (clickEvent.target as HTMLElement).closest("a");
        if (!anchor) return;
        const href = anchor.getAttribute("href") ?? "";
        const match = /[?&]ai-query=([^&]+)/u.exec(href);
        if (!match) return;
        clickEvent.preventDefault();
        try {
          onFollowUp(decodeURIComponent(match[1]!.replaceAll("+", " ")));
        } catch {
          onFollowUp(match[1]!);
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export default function OmniTrace({ events, streaming = false, dashboardMode = false, onFollowUp, onAddToDashboard }: {
  events: readonly TraceEvent[];
  streaming?: boolean;
  /** Dashboard-architect turns narrate as design work ("Creating element: …"). */
  dashboardMode?: boolean;
  onFollowUp?: (prompt: string) => void;
  /** Pins a replayable governed table (a query result or a composed pivot). */
  onAddToDashboard?: AddToDashboard;
}) {
  const model = useMemo(() => buildOmniModel(events, dashboardMode), [events, dashboardMode]);
  const showThinking = streaming && !model.answer && !model.error && !model.clarification;
  return (
    <div className={styles.root}>
      <WorkHeader events={events} working={showThinking} />
      {model.blocks.map((block) => {
        switch (block.kind) {
          case "tasks":
            return <TasksCard event={block.event} key={block.id} />;
          case "prose":
            return <Prose text={block.text} warning={block.warning} onFollowUp={onFollowUp} key={block.id} />;
          case "research":
            return <ResearchGroup block={block} key={block.id} />;
          case "query":
            return block.pivot
              ? <PivotCard block={block} onAddToDashboard={onAddToDashboard} key={block.id} />
              : <QueryCard block={block} key={block.id} />;
          case "chart":
            return (
              <div className={styles.chartCard} key={block.id}>
                <div className={styles.chartCaption}>{block.chart.caption}</div>
                <Suspense fallback={null}>
                  <ResultChart event={block.chart} table={block.table} />
                </Suspense>
              </div>
            );
          default:
            return null;
        }
      })}
      {showThinking ? (
        <div className={styles.thinking} aria-live="polite">
          <span className={styles.thinkingDots} aria-hidden="true">
            <span /><span /><span /><span />
          </span>
          <span className={styles.thinkingLabel}>
            {model.thinkingLabel === "Thinking" ? "Thinking" : model.thinkingLabel}
          </span>
        </div>
      ) : null}
      {model.answer ? (
        <div className={styles.answer}>
          <Prose text={model.answer.text} onFollowUp={onFollowUp} />
          {model.answer.followUps.length > 0 && onFollowUp ? (
            <div className={styles.followUps}>
              {model.answer.followUps.map((followUp) => (
                <button
                  className={styles.followUp}
                  type="button"
                  key={followUp}
                  onClick={() => onFollowUp(followUp)}
                >
                  {followUp}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {model.clarification ? (
        <div className={styles.clarification}>
          <div className={styles.clarificationQuestion}>{model.clarification.question}</div>
          {onFollowUp ? (
            <div className={styles.clarificationOptions}>
              {model.clarification.options.map((option) => (
                <button
                  className={styles.followUp}
                  type="button"
                  key={option.id}
                  onClick={() => onFollowUp(option.label)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {model.error ? (
        <div className={styles.error} role="alert">{model.error}</div>
      ) : null}
    </div>
  );
}
