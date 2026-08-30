"use client";

/**
 * Dashboard Master: the daily deep-dive tab. Renders the latest composed
 * five-focus report — big titles, key-figure cards, governed evidence tables
 * and charts — plus the live fleet view while a session runs. A report older
 * than 24 hours auto-refreshes for owners/managers with the tab open, the
 * same browser-orchestrated shape as Proactive and Swarm.
 */
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  dashboardMasterReportSchema,
  type DashboardEvidenceChart,
  type DashboardEvidenceTable,
  type DashboardMasterReport,
} from "@/services/dashboard-master/src/contracts";
import {
  dashboardMasterRunSnapshot,
  startDashboardMasterSession,
  stopDashboardMasterSession,
  subscribeDashboardMasterRun,
} from "../lib/dashboard-master-run-controller";
import { compileGroundedFlint, type TraceTableColumn, type TraceCell } from "@/packages/shared/src";
import { formatTraceCell } from "./analytical-values";
import {
  getServerThemePreference,
  getThemePreference,
  subscribeToThemePreference,
} from "@/app/theme-preference";
import styles from "./dashboard-master-workspace.module.css";

const FlintChartView = dynamic(() => import("./FlintChartView"), { ssr: false });

const NUMERIC_COLUMN_TYPES = new Set(["number", "currency", "percent"]);

type PanelData = Readonly<{
  latest: Readonly<{
    reportId: string;
    completedAt: string | null;
    report: Record<string, unknown> | null;
  }> | null;
  running: Readonly<{ reportId: string }> | null;
  conversationIds: readonly string[];
  refreshDue: boolean;
  canRun: boolean;
}>;

type PanelState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "error"; message: string }>
  | Readonly<{ kind: "ready"; data: PanelData }>;

function relativeTimeLabel(iso: string | null): string {
  if (!iso) return "just now";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "just now";
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function paragraphs(text: string): string[] {
  return text.split(/\n{2,}|\n(?=[-•])/u).map((part) => part.trim()).filter(Boolean);
}

function EvidenceTable({ table }: Readonly<{ table: DashboardEvidenceTable }>) {
  return (
    <figure className={styles.evidenceTable}>
      <figcaption className={styles.evidenceCaption}>
        {table.caption}
        {table.timeRangeLabel ? <span className={styles.evidenceRange}> · {table.timeRangeLabel}</span> : null}
      </figcaption>
      <div className={styles.evidenceScroll}>
        <table>
          <thead>
            <tr>
              {table.columns.map((column) => (
                <th key={column.key} data-numeric={NUMERIC_COLUMN_TYPES.has(column.type)}>{column.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {table.columns.map((column) => (
                  <td key={column.key} data-numeric={NUMERIC_COLUMN_TYPES.has(column.type)}>
                    {formatTraceCell((row[column.key] ?? null) as TraceCell, column as TraceTableColumn)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.rowCount > table.rows.length ? (
        <div className={styles.evidenceFooter}>Showing {table.rows.length} of {table.rowCount} rows</div>
      ) : null}
    </figure>
  );
}

function EvidenceChart({ chart }: Readonly<{ chart: DashboardEvidenceChart }>) {
  const theme = useSyncExternalStore(
    subscribeToThemePreference,
    getThemePreference,
    getServerThemePreference,
  );
  const appearance = theme === "dark"
    || (theme === "system" && typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches)
    ? "dark" as const
    : "light" as const;
  const plan = useMemo(() => {
    try {
      return compileGroundedFlint({
        caption: chart.caption,
        chartType: chart.chartType,
        ...(chart.stacked !== undefined ? { stacked: chart.stacked } : {}),
        ...(chart.orientation ? { orientation: chart.orientation } : {}),
        xKey: chart.xKey,
        yKey: chart.yKey,
        ...(chart.series?.length ? { series: chart.series } : {}),
        columns: chart.columns as readonly TraceTableColumn[],
        rows: chart.rows as readonly Readonly<Record<string, TraceCell>>[],
      });
    } catch {
      return null;
    }
  }, [chart]);
  if (!plan) return null;
  return (
    <figure className={styles.evidenceChart}>
      <figcaption className={styles.evidenceCaption}>{chart.caption}</figcaption>
      <FlintChartView plan={plan} appearance={appearance} title={chart.caption} height={300} />
    </figure>
  );
}

function FocusSection({ item }: Readonly<{ item: DashboardMasterReport["focus"][number] }>) {
  return (
    <section className={styles.focusCard} aria-label={`Focus ${item.rank}: ${item.title}`}>
      <div className={styles.focusHeader}>
        <span className={styles.focusRank} aria-hidden>{item.rank}</span>
        <div>
          <h2 className={styles.focusTitle}>{item.title}</h2>
          <p className={styles.focusVerdict}>{item.verdict}</p>
        </div>
      </div>
      <div className={styles.figureGrid}>
        {item.keyFigures.map((figure) => (
          <div className={styles.figureCard} data-sentiment={figure.sentiment} key={figure.label}>
            <div className={styles.figureValue}>{figure.value}</div>
            <div className={styles.figureLabel}>{figure.label}</div>
            {figure.detail ? <div className={styles.figureDetail}>{figure.detail}</div> : null}
          </div>
        ))}
      </div>
      <div className={styles.focusWhy}>
        {paragraphs(item.whyItMatters).map((part, index) => <p key={index}>{part}</p>)}
      </div>
      {item.charts.length > 0 || item.tables.length > 0 ? (
        <div className={styles.evidenceRow}>
          {item.charts.map((chart, index) => <EvidenceChart chart={chart} key={`c${index}`} />)}
          {item.tables.map((table, index) => <EvidenceTable table={table} key={`t${index}`} />)}
        </div>
      ) : null}
      <div className={styles.actionsBlock}>
        <h3 className={styles.actionsTitle}>Do this next</h3>
        <ol className={styles.actionsList}>
          {item.actions.map((action, index) => <li key={index}>{action}</li>)}
        </ol>
      </div>
    </section>
  );
}

export default function DashboardMasterWorkspace({
  onDashboardConversationIds,
}: Readonly<{
  onDashboardConversationIds?: (ids: readonly string[]) => void;
}>) {
  const [panel, setPanel] = useState<PanelState>({ kind: "loading" });
  const live = useSyncExternalStore(
    subscribeDashboardMasterRun,
    dashboardMasterRunSnapshot,
    dashboardMasterRunSnapshot,
  );
  const autoStartedRef = useRef(false);
  const conversationIdsRef = useRef<string>("");

  const fetchPanel = useCallback(() => {
    void (async () => {
      try {
        const response = await fetch("/api/dashboard-master", { cache: "no-store" });
        const payload = await response.json().catch(() => null) as (PanelData & { error?: string }) | null;
        if (!response.ok || !payload) {
          throw new Error(payload?.error || "The dashboard could not be loaded.");
        }
        setPanel({ kind: "ready", data: payload });
        const idsKey = (payload.conversationIds ?? []).join(",");
        if (idsKey !== conversationIdsRef.current) {
          conversationIdsRef.current = idsKey;
          onDashboardConversationIds?.(payload.conversationIds ?? []);
        }
      } catch (error) {
        setPanel({ kind: "error", message: error instanceof Error ? error.message : "The dashboard could not be loaded." });
      }
    })();
  }, [onDashboardConversationIds]);

  useEffect(() => {
    const timer = setTimeout(fetchPanel, 0);
    return () => clearTimeout(timer);
  }, [fetchPanel]);

  useEffect(() => {
    if (live.settledCount === 0) return;
    const timer = setTimeout(fetchPanel, 600);
    return () => clearTimeout(timer);
  }, [live.settledCount, fetchPanel]);

  // The 24-hour refresh: a stale report auto-starts a new session once per
  // tab visit, for members who can run one.
  useEffect(() => {
    if (panel.kind !== "ready" || !panel.data.refreshDue || !panel.data.canRun) return;
    if (live.active || autoStartedRef.current) return;
    autoStartedRef.current = true;
    startDashboardMasterSession();
  }, [panel, live.active]);

  // Elapsed-minutes ticker while a session runs (updated only from timer
  // callbacks so render stays pure).
  const [elapsedMinutes, setElapsedMinutes] = useState(0);
  useEffect(() => {
    if (!live.active || !live.startedAtMs) return;
    const started = live.startedAtMs;
    const update = () => setElapsedMinutes(Math.max(0, Math.round((Date.now() - started) / 60_000)));
    const kickoff = setTimeout(update, 0);
    const timer = setInterval(update, 30_000);
    return () => {
      clearTimeout(kickoff);
      clearInterval(timer);
    };
  }, [live.active, live.startedAtMs]);

  const report = useMemo<DashboardMasterReport | null>(() => {
    if (panel.kind !== "ready" || !panel.data.latest?.report) return null;
    const parsed = dashboardMasterReportSchema.safeParse(panel.data.latest.report);
    return parsed.success ? parsed.data : null;
  }, [panel]);

  if (panel.kind === "loading") {
    return <div className={styles.stateNote}>Loading the dashboard…</div>;
  }
  if (panel.kind === "error") {
    return <div className={styles.stateNote} role="alert">{panel.message}</div>;
  }

  const doneWorkers = live.workers.filter((worker) => worker.phase === "done" || worker.phase === "failed").length;

  return (
    <div className={styles.workspace}>
      {live.active ? (
        <section className={styles.liveCard} aria-live="polite">
          <div className={styles.liveHeader}>
            <div>
              <h2 className={styles.liveTitle}>
                {live.phase === "composing" ? "Writing today's report…" : "Deep-dive session in progress"}
              </h2>
              <p className={styles.liveMeta}>
                {live.roundLabel || "Planning the investigation…"} · {doneWorkers}/{live.workers.length || "…"} complete · {elapsedMinutes} min elapsed · keep this window open
              </p>
            </div>
            <button className={styles.stopButton} type="button" onClick={() => stopDashboardMasterSession()}>
              Stop
            </button>
          </div>
          <div className={styles.liveGrid}>
            {live.workers.map((worker) => (
              <article className={styles.liveWorker} data-phase={worker.phase} key={worker.key}>
                <div className={styles.liveWorkerTitle}>{worker.title}</div>
                <div className={styles.liveWorkerStatus}>{worker.statusLine}</div>
                <div className={styles.liveWorkerMeta}>Round {worker.round}{worker.queries > 0 ? ` · ${worker.queries} queries` : ""}</div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {live.phase === "failed" && live.error ? (
        <div className={styles.stateNote} role="alert">{live.error}</div>
      ) : null}

      {report ? (
        <>
          <header className={styles.hero}>
            <div className={styles.heroKicker}>Daily deep dive · updated {relativeTimeLabel(panel.data.latest?.completedAt ?? report.generatedAt)} · refreshes every 24 hours</div>
            <h1 className={styles.heroHeadline}>{report.headline}</h1>
            <p className={styles.heroOverview}>{report.overview}</p>
            <div className={styles.heroStats}>
              <span className={styles.heroChip}>{Math.round(report.investigationMinutes)} minutes of investigation</span>
              <span className={styles.heroChip}>{report.workerTurns} investigations</span>
              <span className={styles.heroChip}>{report.governedQueries} governed queries</span>
              <span className={styles.heroChip}>{report.periodLabel}</span>
            </div>
            {panel.data.canRun && !live.active ? (
              <button className={styles.refreshButton} type="button" onClick={() => startDashboardMasterSession()}>
                Refresh now
              </button>
            ) : null}
          </header>
          <div className={styles.focusList}>
            {report.focus.map((item) => <FocusSection item={item} key={item.rank} />)}
          </div>
          {report.cautions.length > 0 ? (
            <aside className={styles.cautions}>
              <h3 className={styles.cautionsTitle}>Read with care</h3>
              <ul>
                {report.cautions.map((caution, index) => <li key={index}>{caution}</li>)}
              </ul>
            </aside>
          ) : null}
        </>
      ) : !live.active ? (
        <section className={styles.emptyHero}>
          <h1 className={styles.emptyTitle}>Your daily deep dive</h1>
          <p className={styles.emptyBody}>
            Albert runs an hour-long investigation across everything your connected tools know —
            sales, margins, costs, cash, labour and the workshop — and distils it into the five
            things worth your attention today.
          </p>
          {panel.data.canRun ? (
            <button className={styles.refreshButton} type="button" onClick={() => startDashboardMasterSession()}>
              Run the first deep dive
            </button>
          ) : (
            <p className={styles.emptyBody}>An owner or manager can run the first session.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
