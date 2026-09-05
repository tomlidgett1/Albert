"use client";

/**
 * Dashboard mode's right-hand card: the dashboard being built, live. While
 * the architect turn streams, every governed result lands here as a tile
 * drawn by the same renderer the saved dashboard uses, on the same grid
 * geometry; the composed plan snaps the drafts into the real layout; and
 * when the plan is applied the editable workspace fades in underneath the
 * preview instead of replacing it — so nothing jumps. An element edit
 * (ADR 0134) keeps the whole dashboard on screen and reworks the one tile
 * in place.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { TraceEvent } from "@/packages/shared/src";
import {
  dashboardBuildSnapshot,
  subscribeDashboardBuild,
} from "../lib/dashboard-build-controller";
import {
  buildDashboardBuildView,
  previewChartConfig,
  type PreviewTile,
} from "../lib/dashboard-build-view";
import DashboardWorkspace, { type DashboardElementEdit, type DashboardElementRef } from "./DashboardWorkspace";
import { TileChart, TileEmpty, TileKpi, TileTable, type TileData } from "./DashboardTileView";
import styles from "./dashboard-build-panel.module.css";

const MAX_PREVIEW_TABLE_ROWS = 12;
/** Charts get a beat to draw before the preview lifts. */
const CROSSFADE_HOLD_MS = 420;

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" />
    </svg>
  );
}

function previewData(tile: PreviewTile): TileData {
  return {
    columns: tile.columns,
    rows: tile.rows,
    ...(tile.pivot ? { pivot: true } : {}),
    ...(tile.rowFormats ? { rowFormats: tile.rowFormats } : {}),
  };
}

function PreviewTileCard({ tile }: Readonly<{ tile: PreviewTile }>) {
  const chart = tile.kind === "chart" ? previewChartConfig(tile) : null;
  const data = previewData(tile);
  return (
    <section
      className={styles.tile}
      data-kind={tile.kind}
      data-span={tile.span}
      data-drafting={tile.drafting ? "true" : undefined}
      style={{ gridRow: `span ${tile.heightRows}` }}
      aria-label={tile.title}
    >
      <header className={styles.tileHeader}>
        <h3 className={styles.tileTitle}>{tile.title}</h3>
        {tile.drafting ? <span className={styles.tileDrafting}>Draft</span> : null}
      </header>
      {tile.kind !== "kpi" && tile.note ? <p className={styles.tileNote}>{tile.note}</p> : null}
      {tile.kind === "kpi" ? (
        <TileKpi data={data} valueKey={tile.valueKey} note={tile.note} />
      ) : tile.kind === "chart" ? (
        chart ? (
          <TileChart data={data} display={chart} title={tile.title} />
        ) : (
          <TileEmpty>This result no longer fits its chart.</TileEmpty>
        )
      ) : (
        <TileTable data={data} maxRows={MAX_PREVIEW_TABLE_ROWS} ariaLabel={tile.title} />
      )}
    </section>
  );
}

function CreatingTileCard({ label }: Readonly<{ label: string }>) {
  return (
    <section
      className={styles.tile}
      data-span={6}
      data-creating="true"
      style={{ gridRow: "span 5" }}
      aria-label={label}
    >
      <header className={styles.tileHeader}>
        <h3 className={`${styles.tileTitle} ${styles.tileTitleCreating}`}>{label}</h3>
      </header>
      <div className={styles.creatingBody} aria-hidden="true">
        <span className={styles.creatingBar} style={{ width: "82%" }} />
        <span className={styles.creatingBar} style={{ width: "64%" }} />
        <span className={styles.creatingBar} style={{ width: "73%" }} />
      </div>
    </section>
  );
}

export default function DashboardBuildPanel({
  dashboardId,
  events,
  streaming,
  buildTurn = false,
  onClose,
  onOpenSource,
  onEditWithAlbert,
}: Readonly<{
  /** The dashboard this mode is building (ADR 0134); null until one exists. */
  dashboardId: string | null;
  /** The viewed conversation's latest dashboard-build turn trace. */
  events: readonly TraceEvent[];
  streaming: boolean;
  /** The turn was sent as a dashboard build; drafts show before the plan lands. */
  buildTurn?: boolean;
  onClose: () => void;
  /** Opens a tile's source conversation in the chat. */
  onOpenSource: (conversationId: string) => void;
  /** The Albert wand on a tile: rebuild that one element from a sentence. */
  onEditWithAlbert?: ((tile: DashboardElementRef, instruction: string) => void) | undefined;
}>) {
  const build = useSyncExternalStore(subscribeDashboardBuild, dashboardBuildSnapshot, dashboardBuildSnapshot);
  const view = useMemo(() => buildDashboardBuildView(events, streaming, buildTurn), [events, streaming, buildTurn]);
  const [documentTitle, setDocumentTitle] = useState<string | null>(null);

  const elementEditActive = build.editTileId !== null && build.dashboardId === dashboardId;
  const designing = streaming && (view.isBuildTurn || build.phase === "designing");
  const applying = build.phase === "applying";
  // A whole build previews its drafts over an empty canvas; an element edit
  // keeps the dashboard and reworks one tile inside the workspace itself.
  const showTraceTiles = !elementEditActive
    && (designing || applying)
    && view.tiles.length + (view.pendingQueryName ? 1 : 0) > 0;
  const showWorkspace = elementEditActive || (!designing && !applying);

  // Crossfade on apply: the workspace mounts beneath the plan preview and the
  // preview lifts only once the workspace has its document on screen.
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [previewLifted, setPreviewLifted] = useState(false);
  // A new build (workspace hidden again) re-arms the crossfade; adjusting
  // state during render keeps this out of an effect.
  const [armedFor, setArmedFor] = useState(showWorkspace);
  if (armedFor !== showWorkspace) {
    setArmedFor(showWorkspace);
    if (!showWorkspace) {
      setWorkspaceReady(false);
      setPreviewLifted(false);
    }
  }
  // An element edit reworked its tile inside the workspace, so its one-tile
  // plan never stands in for the dashboard.
  const holdPreview = showWorkspace
    && !elementEditActive
    && build.appliedTileId === null
    && view.plan !== null
    && view.tiles.length > 0
    && !previewLifted;
  useEffect(() => {
    if (!workspaceReady || previewLifted) return;
    const timer = window.setTimeout(() => setPreviewLifted(true), CROSSFADE_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [previewLifted, workspaceReady]);
  const onWorkspaceReady = useCallback(() => setWorkspaceReady(true), []);

  const editTileId = elementEditActive ? build.editTileId : null;
  const editPhase: DashboardElementEdit["phase"] = build.phase === "failed" ? "failed" : applying ? "applying" : "designing";
  const editDraft = view.tiles[0] ?? null;
  // One object per change, so memoised tiles do not re-render on every
  // unrelated streaming event.
  const elementEdit = useMemo<DashboardElementEdit | null>(() => (editTileId
    ? { tileId: editTileId, phase: editPhase, activity: view.activity, draft: editDraft, error: build.error }
    : null), [build.error, editDraft, editPhase, editTileId, view.activity]);

  const badge = designing
    ? { label: elementEditActive ? "Reworking" : "Designing", tone: "working" as const }
    : applying
      ? { label: elementEditActive ? "Placing" : "Placing tiles", tone: "working" as const }
      : build.phase === "failed"
        ? { label: "Needs attention", tone: "failed" as const }
        : build.phase === "applied"
          ? { label: "Live", tone: "live" as const }
          : null;

  const statusLine = designing
    ? (elementEditActive && build.editTileTitle ? `Reworking “${build.editTileTitle}” — ${view.activity}` : view.activity)
    : applying
      ? "Placing the elements…"
      : build.phase === "failed"
        ? build.error ?? "The build did not finish."
        : build.phase === "applied" && build.appliedTimeframe
          ? build.appliedTimeframe
          : "Ask for changes in the chat, or use the wand on any element.";

  const title = (elementEditActive ? documentTitle : null)
    ?? view.plan?.dashboardTitle
    ?? build.appliedTitle
    ?? documentTitle
    ?? "Dashboard";
  // The live workspace carries the editable name itself; the header keeps
  // the title only while the preview grid stands in for it.
  const workspaceLive = showWorkspace && dashboardId !== null;

  const previewGrid = (
    <div className={styles.grid}>
      {view.tiles.map((tile) => (
        <PreviewTileCard tile={tile} key={tile.key} />
      ))}
      {designing && view.pendingQueryName ? (
        <CreatingTileCard label={`Creating: ${view.pendingQueryName}`} />
      ) : null}
      {designing && !showTraceTiles ? (
        <CreatingTileCard label={view.activity} />
      ) : null}
    </div>
  );

  return (
    <div className={styles.panel} aria-label="Dashboard preview">
      <header className={styles.header}>
        <div className={styles.headerTitles}>
          {workspaceLive ? null : <h2 className={styles.headerTitle}>{title}</h2>}
          <p className={styles.headerStatus} role="status" data-working={designing || applying ? "true" : undefined}>
            {(designing || applying) ? (
              <span className={styles.statusPulse} aria-hidden="true" />
            ) : null}
            {statusLine}
          </p>
        </div>
        {badge ? <span className={styles.badge} data-tone={badge.tone}>{badge.label}</span> : null}
        <button className={styles.close} type="button" aria-label="Hide dashboard preview" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      {view.plan && view.plan.timeframe !== statusLine && !showWorkspace ? (
        <p className={styles.timeframe}>{view.plan.timeframe}</p>
      ) : null}
      {showWorkspace && dashboardId ? (
        <div className={styles.workspaceHost} data-settling={holdPreview ? "true" : undefined}>
          {build.phase === "failed" && build.error && !elementEdit ? (
            <p className={styles.failureNote} role="alert">{build.error}</p>
          ) : null}
          {build.phase === "applied" && build.skipped.length > 0 ? (
            <div className={styles.skippedNotes}>
              {build.skipped.map((entry) => <p key={entry}>{entry}</p>)}
            </div>
          ) : null}
          <DashboardWorkspace
            key={dashboardId}
            dashboardId={dashboardId}
            embedded
            onOpenSource={onOpenSource}
            onReady={onWorkspaceReady}
            onEditWithAlbert={onEditWithAlbert}
            elementEdit={elementEdit}
            onDashboardChange={(document) => setDocumentTitle(document.title?.trim() || null)}
          />
          {holdPreview ? (
            <div
              className={styles.previewOverlay}
              data-lifting={workspaceReady ? "true" : undefined}
              aria-hidden="true"
            >
              <div className={styles.body}>{previewGrid}</div>
            </div>
          ) : null}
        </div>
      ) : showWorkspace ? (
        <div className={styles.body}>
          <div className={styles.hero}>
            <h3>Describe what you want to watch</h3>
            <p>Type it in the chat on the left. Albert designs the elements, proves every number, and they stay live.</p>
          </div>
        </div>
      ) : (
        <div className={styles.body}>{previewGrid}</div>
      )}
    </div>
  );
}
