"use client";

/**
 * One dashboard, editable (ADR 0083, 0129, 0133). The interaction model is
 * Sigma's: an element toolbar in the tile's top-right corner on hover or
 * selection ("Filters", the Albert edit wand, "More"), a caret menu on every
 * table column header ("Sort ascending", "Sort descending", "Filter",
 * "Rename", "Format"), filter cards typed by the column's data (list, text
 * match, number, date range), and "Keep only" / "Exclude" on a right-clicked
 * value. Sort and filters are element-level query overrides: they apply to
 * the rows on screen instantly and the governed query re-runs with them on
 * the next refresh. The Albert wand rebuilds one element from a sentence.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ResponsiveGridLayout,
  useContainerWidth,
  verticalCompactor,
  type Layout,
  type LayoutItem,
  type ResponsiveLayouts,
} from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import type {
  DashboardColumnFormat,
  DashboardColumnPresentation,
  DashboardDocument,
  DashboardLayouts,
  DashboardQueryFilter,
  DashboardQueryOverrides,
  DashboardSnapshot,
  DashboardTile,
  DashboardTileDisplay,
} from "@/services/control-plane/src/dashboard-repository";
import type { TraceTableColumn } from "@/packages/shared/src";
import type { DashboardQueryEdit } from "@/services/dashboard/src/query-edits";
import {
  dashboardBuildSnapshot,
  dismissDashboardBuildResult,
  subscribeDashboardBuild,
} from "../lib/dashboard-build-controller";
import { previewChartConfig, type PreviewTile } from "../lib/dashboard-build-view";
import {
  applyOverridesToRows,
  describeFilter,
  distinctColumnValues,
  filterKindForColumn,
  sortDirectionFor,
  withFilter,
  withSort,
  withoutFilter,
  type DashboardFilterKind,
} from "../lib/dashboard-query-overrides-view";
import {
  firstNumericDashboardColumn,
  formatDashboardCell,
  resolveDashboardColumn,
} from "./dashboard-values";
import { DashPopover } from "./DashPopover";
import { ElementProperties, memberForColumnKey, type ElementFields } from "./ElementProperties";
import { TileChart, TileEmpty, TileKpi, TileTable, tileStyles, type TileData } from "./DashboardTileView";
import styles from "./dashboard-workspace.module.css";

const NUMERIC_COLUMN_TYPES = new Set(["number", "currency", "percent"]);

const resolveSnapshotColumn = resolveDashboardColumn<DashboardSnapshot["columns"][number]>;
const firstNumericColumn = firstNumericDashboardColumn<DashboardSnapshot["columns"][number]>;

type Breakpoint = "desktop" | "tablet" | "mobile";
type ColumnEditorFormat = "auto" | DashboardColumnFormat;
type ColumnRenameDraft = Readonly<{
  key: string;
  label: string;
}>;
type ColumnFormatDraft = Readonly<{
  key: string;
  format: ColumnEditorFormat;
  decimals: "auto" | number;
}>;

/** The element the Albert wand is editing. */
export type DashboardElementRef = Readonly<{ tileId: string; title: string }>;

/** A running element edit, so the tile shows its rework in place. */
export type DashboardElementEdit = Readonly<{
  tileId: string;
  phase: "designing" | "applying" | "failed";
  activity: string;
  draft: PreviewTile | null;
  error: string | null;
}>;

type DashboardWorkspaceProps = Readonly<{
  /** The dashboard this workspace shows (ADR 0134: dashboards, plural). */
  dashboardId: string;
  onOpenSource: (conversationId: string) => void;
  /** Opens dashboard mode in Analysis: the chat drives the build. */
  onStartBuild?: (() => void) | undefined;
  /**
   * Rendered inside dashboard mode's panel: the chat already drives builds,
   * so the build entry points and the build banners stay hidden while every
   * editing affordance (drag, resize, rename, refresh, remove) keeps working.
   */
  embedded?: boolean;
  /** Fires once the first document has loaded and its grid is on screen. */
  onReady?: (() => void) | undefined;
  /** Standalone view: back to the Dashboards list. */
  onBack?: (() => void) | undefined;
  /** The Albert wand: rebuild one element from a sentence. */
  onEditWithAlbert?: ((tile: DashboardElementRef, instruction: string) => void) | undefined;
  /** A running element edit to draw in place of its tile. */
  elementEdit?: DashboardElementEdit | null | undefined;
  /** Every loaded or changed document, for a host that shows its title. */
  onDashboardChange?: ((dashboard: DashboardDocument) => void) | undefined;
}>;

function icon(path: React.ReactNode) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">{path}</svg>;
}

const WAND_ICON = icon(<><path d="m4 20 10.5-10.5M12.5 5.5l1-2.5 1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1Z" /><path d="M18.5 12.5l.6-1.5.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6Z" /></>);
const MORE_ICON = icon(<><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" /></>);
const FILTER_ICON = icon(<path d="M4 5h16l-6.3 7.4V19l-3.4-1.7v-4.9Z" />);
const CARET_ICON = icon(<path d="m7 10 5 5 5-5" />);
const SLIDERS_ICON = icon(<><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>);

function defaultLayout(tileIds: readonly string[], columns: number): LayoutItem[] {
  return tileIds.map((i, index) => ({
    i,
    x: columns === 1 ? 0 : (index * 4) % columns,
    y: columns === 1 ? index * 7 : Math.floor((index * 4) / columns) * 7,
    w: columns === 1 ? 1 : Math.min(4, columns),
    h: 7,
    minW: columns === 1 ? 1 : 3,
    minH: 5,
    maxW: columns === 1 ? 1 : Math.min(12, columns),
    maxH: 16,
  }));
}

function hydrateLayout(
  saved: readonly LayoutItem[],
  tileIds: readonly string[],
  columns: number,
): LayoutItem[] {
  const known = new Set(tileIds);
  const hydrated = saved
    .filter(({ i }) => known.has(i))
    .map((item) => ({
      i: item.i,
      x: Math.min(item.x, Math.max(0, columns - item.w)),
      y: item.y,
      w: Math.min(item.w, columns),
      h: item.h,
      minW: columns === 1 ? 1 : 3,
      minH: 5,
      maxW: columns === 1 ? 1 : columns,
      maxH: 16,
    }));
  const present = new Set(hydrated.map(({ i }) => i));
  const missing = defaultLayout(tileIds.filter((id) => !present.has(id)), columns)
    .map((item, index) => ({ ...item, y: (hydrated.length + index) * 7 }));
  return [...hydrated, ...missing];
}

function serializable(layout: Layout): DashboardLayouts["desktop"] {
  return layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
}

function freshness(snapshot: DashboardSnapshot | null): string {
  if (!snapshot) return "No successful result yet";
  const watermarks = snapshot.sourceWatermarks.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const dataThrough = (value as Record<string, unknown>).dataThrough;
    return typeof dataThrough === "string" && Number.isFinite(Date.parse(dataThrough)) ? [dataThrough] : [];
  });
  if (!watermarks.length) return "Freshness unavailable";
  const oldest = watermarks.reduce((left, right) => Date.parse(left) < Date.parse(right) ? left : right);
  return `Data through ${new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(oldest))}`;
}

function statusLabel(tile: DashboardTile): string {
  if (tile.refreshState === "refreshing") return "Refreshing";
  if (tile.refreshState === "error") return "Failed";
  if (tile.refreshState === "stale") return "Updating";
  if (tile.snapshot?.empty) return "No data";
  return "Current";
}

function statusTooltip(tile: DashboardTile): string {
  const dateDetail = freshness(tile.snapshot);
  if (tile.refreshState === "refreshing") return `Refreshing now. ${dateDetail}.`;
  if (tile.refreshState === "error") {
    return tile.lastErrorCode === "query_overrides_invalid"
      ? `A filter or sort no longer fits this element's query. ${dateDetail}.`
      : `Last refresh failed. ${dateDetail}.`;
  }
  if (tile.refreshState === "stale") return `Re-running with your sort and filters. ${dateDetail}.`;
  return dateDetail;
}

const columnFormatOptions: readonly Readonly<{ value: ColumnEditorFormat; label: string }>[] = [
  { value: "auto", label: "Auto" },
  { value: "number", label: "Number" },
  { value: "currency", label: "Currency" },
  { value: "percent", label: "Percent" },
  { value: "text", label: "Text" },
  { value: "date", label: "Date" },
  { value: "datetime", label: "Date & time" },
];

function supportsDecimals(
  format: ColumnEditorFormat,
  sourceType: DashboardSnapshot["columns"][number]["type"],
): boolean {
  const resolved = format === "auto" ? sourceType : format;
  return resolved === "number" || resolved === "currency" || resolved === "percent";
}

function applyColumnPresentation(
  tile: DashboardTile,
  columnKey: string,
  patch: Readonly<{ label?: string; format?: ColumnEditorFormat; decimals?: "auto" | number }>,
): DashboardColumnPresentation {
  const column = tile.snapshot?.columns.find(({ key }) => key === columnKey);
  const next: DashboardColumnPresentation = { ...tile.columnPresentation };
  if (!column) return next;
  const current = tile.columnPresentation[columnKey];
  const label = patch.label !== undefined ? patch.label.trim() : (current?.label ?? column.label);
  const format = patch.format ?? current?.format ?? "auto";
  const decimals = patch.decimals ?? current?.decimals ?? "auto";
  const presentation = {
    ...(label && label !== column.label ? { label } : {}),
    ...(format !== "auto" ? { format } : {}),
    ...(decimals !== "auto" ? { decimals } : {}),
    ...(current?.hidden ? { hidden: true } : {}),
  };
  if (Object.keys(presentation).length) next[columnKey] = presentation;
  else delete next[columnKey];
  return next;
}

function withColumnHidden(tile: DashboardTile, columnKey: string, hidden: boolean): DashboardColumnPresentation {
  const next: DashboardColumnPresentation = { ...tile.columnPresentation };
  const rest = { ...(next[columnKey] ?? {}) };
  delete rest.hidden;
  const item = { ...rest, ...(hidden ? { hidden: true } : {}) };
  if (Object.keys(item).length) next[columnKey] = item;
  else delete next[columnKey];
  return next;
}

/** Overrides can only sit on a governed query: a composed pivot has none. */
function supportsOverrides(tile: DashboardTile): boolean {
  return tile.replayKind === "cube_v3";
}

function activeFilterCount(tile: DashboardTile): number {
  return tile.queryOverrides.filters?.length ?? 0;
}

/**
 * A tile's snapshot as the shared renderer's data shape, with the owner's
 * sort and filters already applied so a change shows before the governed
 * query has re-run (ADR 0134).
 */
function tileData(tile: DashboardTile): TileData | null {
  const { snapshot } = tile;
  if (!snapshot) return null;
  // Sigma's "Hide column": hidden columns stay in the query and the contract
  // and leave only the element.
  const columns = (snapshot.columns as readonly TraceTableColumn[])
    .filter((column) => tile.columnPresentation[column.key]?.hidden !== true);
  const rows = applyOverridesToRows(columns, snapshot.rows, tile.queryOverrides);
  const narrowed = rows.length !== snapshot.rows.length;
  return {
    columns,
    rows,
    totalRowCount: narrowed ? rows.length : snapshot.totalRowCount,
    pivot: tile.replayKind === "derived_v1",
  };
}

// ---- Column header: label + caret menu (Sigma's column menu) -----------------

function ColumnHeader({
  tile,
  column,
  onOpenMenu,
  onRename,
  menuOpen,
}: Readonly<{
  tile: DashboardTile;
  column: TraceTableColumn;
  onOpenMenu: (column: TraceTableColumn, anchor: HTMLElement) => void;
  onRename: (column: TraceTableColumn) => void;
  menuOpen: boolean;
}>) {
  const presentation = tile.columnPresentation[column.key];
  const label = presentation?.label ?? column.label;
  const direction = sortDirectionFor(tile.queryOverrides, tile.snapshot?.columns as readonly TraceTableColumn[] ?? [], column.key);
  const caretRef = useRef<HTMLButtonElement>(null);
  return (
    <span className={styles.columnHeader} data-menu-open={menuOpen ? "true" : undefined}>
      <button
        className={tileStyles.headerButton}
        type="button"
        aria-label={`${label} column. Double-click or press Enter to rename.`}
        onDoubleClick={() => onRename(column)}
        onClick={() => caretRef.current && onOpenMenu(column, caretRef.current)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === "F2") {
            event.preventDefault();
            onRename(column);
          }
        }}
      >
        <span className={styles.columnLabel}>{label}</span>
        {direction ? (
          <span className={styles.sortMark} aria-label={direction === "asc" ? "sorted ascending" : "sorted descending"}>
            {direction === "asc" ? "▲" : "▼"}
          </span>
        ) : null}
      </button>
      <button
        ref={caretRef}
        className={styles.columnCaret}
        type="button"
        aria-label={`Column options for ${label}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(event) => {
          event.stopPropagation();
          onOpenMenu(column, event.currentTarget);
        }}
      >
        {CARET_ICON}
      </button>
    </span>
  );
}

function SnapshotTable({
  tile,
  onColumnPresentationChange,
  onOpenColumnMenu,
  columnMenuKey,
  onKeepOnly,
  onExclude,
  rename,
  onRenameChange,
}: Readonly<{
  tile: DashboardTile;
  onColumnPresentationChange: (presentation: DashboardColumnPresentation) => void;
  onOpenColumnMenu: (column: TraceTableColumn, anchor: HTMLElement) => void;
  columnMenuKey: string | null;
  onKeepOnly: (column: TraceTableColumn, value: unknown, anchor: HTMLElement) => void;
  onExclude: (column: TraceTableColumn, value: unknown, anchor: HTMLElement) => void;
  /** The column being renamed inline (owned by the card so the column menu can start it). */
  rename: ColumnRenameDraft | null;
  onRenameChange: (draft: ColumnRenameDraft | null) => void;
}>) {
  const { snapshot } = tile;
  const [cellMenu, setCellMenu] = useState<Readonly<{ column: TraceTableColumn; value: unknown; anchor: HTMLElement }> | null>(null);
  if (!snapshot) return <TileEmpty>Run refresh to load this governed result.</TileEmpty>;
  if (snapshot.empty) return <TileEmpty>No data for the governed period.</TileEmpty>;
  const data = tileData(tile);
  if (!data) return <TileEmpty>Run refresh to load this governed result.</TileEmpty>;

  const openRename = (column: TraceTableColumn) => {
    const presentation = tile.columnPresentation[column.key];
    onRenameChange({ key: column.key, label: presentation?.label ?? column.label });
  };

  const closeRename = (save: boolean) => {
    if (!rename) return;
    if (save) {
      const next = applyColumnPresentation(tile, rename.key, { label: rename.label });
      if (JSON.stringify(next) !== JSON.stringify(tile.columnPresentation)) {
        onColumnPresentationChange(next);
      }
    }
    onRenameChange(null);
  };

  return (
    <>
      <TileTable
        data={data}
        presentation={tile.columnPresentation}
        ariaLabel={tile.title}
        onCellContextMenu={supportsOverrides(tile) && !data.pivot
          ? (column, value, event) => {
            if (value === null || value === undefined || value === "") return;
            event.preventDefault();
            setCellMenu({ column, value, anchor: event.currentTarget });
          }
          : undefined}
        headerCell={(column) => {
          const draft = rename?.key === column.key ? rename : null;
          return draft ? (
            <div
              className={tileStyles.headerEditor}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeRename(true);
              }}
            >
              <input
                autoFocus
                aria-label="Column name"
                value={draft.label}
                maxLength={160}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => onRenameChange({ ...draft, label: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") closeRename(true);
                  if (event.key === "Escape") closeRename(false);
                }}
              />
            </div>
          ) : (
            <ColumnHeader
              tile={tile}
              column={column}
              onOpenMenu={onOpenColumnMenu}
              onRename={openRename}
              menuOpen={columnMenuKey === column.key}
            />
          );
        }}
      />
      {cellMenu ? (
        <DashPopover
          anchor={cellMenu.anchor}
          open
          onClose={() => setCellMenu(null)}
          align="start"
          role="menu"
          label={`${formatDashboardCell(cellMenu.value, cellMenu.column, tile.columnPresentation[cellMenu.column.key])} options`}
        >
          <button type="button" role="menuitem" className={styles.menuItem} onClick={() => { onKeepOnly(cellMenu.column, cellMenu.value, cellMenu.anchor); setCellMenu(null); }}>
            Keep only
          </button>
          <button type="button" role="menuitem" className={styles.menuItem} onClick={() => { onExclude(cellMenu.column, cellMenu.value, cellMenu.anchor); setCellMenu(null); }}>
            Exclude
          </button>
        </DashPopover>
      ) : null}
    </>
  );
}

function KpiTileBody({ tile }: Readonly<{ tile: DashboardTile }>) {
  const data = tileData(tile);
  if (!data) return <TileEmpty>Run refresh to load this governed result.</TileEmpty>;
  if (tile.snapshot?.empty) return <TileEmpty>No data for the governed period.</TileEmpty>;
  const display = tile.display.mode === "kpi" ? tile.display : null;
  return (
    <TileKpi
      data={data}
      valueKey={display?.valueKey}
      presentation={tile.columnPresentation}
      note={display?.note}
      comparison={display?.comparison}
      betterWhen={display?.betterWhen}
    />
  );
}

function ChartTileBody({ tile }: Readonly<{ tile: DashboardTile }>) {
  const data = tileData(tile);
  const display = tile.display.mode === "chart" ? tile.display : null;
  if (!data || !display) return <TileEmpty>Run refresh to load this governed result.</TileEmpty>;
  if (tile.snapshot?.empty) return <TileEmpty>No data for the governed period.</TileEmpty>;
  return <TileChart data={data} display={display} title={tile.title} />;
}

/** The element being reworked by Albert, drawn in its own slot. */
function ReworkBody({ edit, title }: Readonly<{ edit: DashboardElementEdit; title: string }>) {
  const draft = edit.draft;
  if (edit.phase === "failed") {
    return <TileEmpty>{edit.error ?? "The edit did not finish. The element is unchanged."}</TileEmpty>;
  }
  if (!draft) {
    return (
      <div className={styles.reworkSkeleton} aria-hidden="true">
        <span style={{ width: "82%" }} />
        <span style={{ width: "64%" }} />
        <span style={{ width: "73%" }} />
      </div>
    );
  }
  const data: TileData = {
    columns: draft.columns,
    rows: draft.rows,
    ...(draft.pivot ? { pivot: true } : {}),
    ...(draft.rowFormats ? { rowFormats: draft.rowFormats } : {}),
  };
  if (draft.kind === "kpi") return <TileKpi data={data} valueKey={draft.valueKey} note={draft.note} />;
  if (draft.kind === "chart") {
    const chart = previewChartConfig(draft);
    return chart
      ? <TileChart data={data} display={chart} title={draft.title || title} />
      : <TileEmpty>This result no longer fits its chart.</TileEmpty>;
  }
  return <TileTable data={data} maxRows={12} ariaLabel={draft.title || title} />;
}

/**
 * Which display modes a tile's snapshot can be switched to. A chart needs a
 * category or time column beside a measure; the architect's own charts keep
 * their verified axes.
 */
function availableDisplayModes(tile: DashboardTile): readonly DashboardTileDisplay["mode"][] {
  const modes: DashboardTileDisplay["mode"][] = ["table"];
  const snapshot = tile.snapshot;
  if (!snapshot || snapshot.rows.length === 0) return modes;
  const numeric = firstNumericColumn(snapshot.columns);
  if (numeric && snapshot.rows.length <= 2) modes.push("kpi");
  if (tile.display.mode === "chart" || defaultDisplayForMode(tile, "chart")) modes.push("chart");
  return modes;
}

/** A sensible default config when the owner flips a tile's display mode. */
function defaultDisplayForMode(
  tile: DashboardTile,
  mode: DashboardTileDisplay["mode"],
): DashboardTileDisplay | null {
  const note = tile.display.mode !== "table" || tile.display.note ? tile.display.note : undefined;
  if (mode === "table") return { mode: "table", ...(note ? { note } : {}) };
  const snapshot = tile.snapshot;
  if (!snapshot) return null;
  const numeric = firstNumericColumn(snapshot.columns);
  if (!numeric) return null;
  if (mode === "kpi") {
    const existing = tile.display.mode === "kpi" ? tile.display.valueKey : undefined;
    const valueKey = resolveSnapshotColumn(snapshot.columns, existing)?.key ?? numeric.key;
    return { mode: "kpi", valueKey, ...(note ? { note } : {}) };
  }
  if (tile.replayKind === "derived_v1") return null;
  const xColumn = snapshot.columns.find((column) => !NUMERIC_COLUMN_TYPES.has(column.type) && column.key !== "compareDateRange")
    ?? snapshot.columns[0];
  if (!xColumn || xColumn.key === numeric.key || snapshot.rows.length < 2) return null;
  const timeAxis = xColumn.type === "date" || xColumn.type === "datetime";
  return {
    mode: "chart",
    chartType: timeAxis ? "line" : "bar",
    xKey: xColumn.key,
    yKey: numeric.key,
    ...(note ? { note } : {}),
  };
}

function BuildProgressCard({ onWatch }: Readonly<{ onWatch?: (() => void) | undefined }>) {
  const build = useSyncExternalStore(subscribeDashboardBuild, dashboardBuildSnapshot, dashboardBuildSnapshot);
  if (!build.active) return null;
  return (
    <section className={styles.buildCard} aria-label="Dashboard build in progress">
      <header className={styles.buildCardHeader}>
        <span className={styles.buildPulse} aria-hidden="true" />
        <div className={styles.buildCardTitles}>
          <h2>{build.phase === "applying" ? "Placing the elements" : build.editTileTitle ? `Reworking “${build.editTileTitle}”` : "Designing your dashboard"}</h2>
          <p>“{build.instruction}”</p>
        </div>
        {onWatch ? (
          <button type="button" className={styles.buildStop} onClick={onWatch}>Watch live</button>
        ) : null}
      </header>
      <p className={styles.buildStatusLine} role="status">
        Albert is building this in Analysis — the working and the live preview are there.
      </p>
    </section>
  );
}

function BuildResultBanner() {
  const build = useSyncExternalStore(subscribeDashboardBuild, dashboardBuildSnapshot, dashboardBuildSnapshot);
  if (build.active || (build.phase !== "applied" && build.phase !== "failed")) return null;
  return (
    <section
      className={styles.buildResult}
      data-state={build.phase === "applied" ? "completed" : "failed"}
      aria-label={build.phase === "applied" ? "Dashboard build finished" : "Dashboard build failed"}
    >
      <div className={styles.buildResultBody}>
        {build.phase === "applied" ? (
          <>
            <strong>{build.appliedTitle ?? "Dashboard ready"}</strong>
            {build.appliedTimeframe ? <span className={styles.buildResultTimeframe}>{build.appliedTimeframe}</span> : null}
            {build.skipped.map((entry) => <p key={entry} className={styles.buildResultSkipped}>{entry}</p>)}
          </>
        ) : (
          <>
            <strong>The build did not finish</strong>
            <p>{build.error ?? "Something went wrong while building the dashboard."}</p>
          </>
        )}
      </div>
      <button type="button" aria-label="Dismiss build result" onClick={dismissDashboardBuildResult}>
        {icon(<path d="m6 6 12 12M18 6 6 18" />)}
      </button>
    </section>
  );
}

// ---- Format dialog (a column's label, format, decimals) ----------------------

function ColumnFormatPanel({
  tile,
  columnKey,
  onColumnPresentationChange,
}: Readonly<{
  tile: DashboardTile;
  columnKey: string;
  onColumnPresentationChange: (presentation: DashboardColumnPresentation) => void;
}>) {
  const column = tile.snapshot?.columns.find(({ key }) => key === columnKey) ?? null;
  const presentation = tile.columnPresentation[columnKey];
  const draft: ColumnFormatDraft = {
    key: columnKey,
    format: presentation?.format ?? "auto",
    decimals: presentation?.decimals ?? "auto",
  };
  if (!column) return null;

  const commit = (nextDraft: ColumnFormatDraft) => {
    const next = applyColumnPresentation(tile, columnKey, {
      format: nextDraft.format,
      decimals: nextDraft.decimals,
    });
    if (JSON.stringify(next) !== JSON.stringify(tile.columnPresentation)) {
      onColumnPresentationChange(next);
    }
  };

  return (
    <div className={styles.columnFormatPanel} aria-label={`Format ${presentation?.label ?? column.label}`}>
      <label>
        <span className={styles.srOnly}>Value format</span>
        <select
          aria-label="Value format"
          value={draft.format}
          onChange={(event) => {
            const format = event.target.value as ColumnEditorFormat;
            commit({
              ...draft,
              format,
              decimals: supportsDecimals(format, column.type) ? draft.decimals : "auto",
            });
          }}
        >
          {columnFormatOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      {supportsDecimals(draft.format, column.type) ? (
        <label>
          <span className={styles.srOnly}>Decimal places</span>
          <select
            aria-label="Decimal places"
            value={draft.decimals}
            onChange={(event) => {
              commit({
                ...draft,
                decimals: event.target.value === "auto" ? "auto" : Number(event.target.value),
              });
            }}
          >
            <option value="auto">Auto decimals</option>
            {Array.from({ length: 7 }, (_, decimals) => (
              <option key={decimals} value={decimals}>
                {decimals} {decimals === 1 ? "decimal" : "decimals"}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <button
        className={styles.columnEditorReset}
        type="button"
        onClick={() => commit({ key: columnKey, format: "auto", decimals: "auto" })}
      >
        Reset
      </button>
    </div>
  );
}

// ---- Filter editor (Sigma's filter card, typed by the column) ---------------

type FilterDraft = Readonly<{
  column: TraceTableColumn;
  kind: DashboardFilterKind;
  /** list: include/exclude; text: the operator; number: the operator; date: range. */
  operator: DashboardQueryFilter["operator"];
  values: readonly string[];
  /** Free text for a list filter's "Add a value". */
  extra: string;
}>;

function defaultFilterDraft(column: TraceTableColumn, existing?: DashboardQueryFilter): FilterDraft {
  const kind = existing
    ? (existing.operator === "contains" || existing.operator === "notContains" ? "text" : filterKindForColumn(column))
    : filterKindForColumn(column);
  if (existing) {
    return { column, kind, operator: existing.operator, values: existing.values, extra: "" };
  }
  if (kind === "number") return { column, kind, operator: "gte", values: [""], extra: "" };
  if (kind === "date") return { column, kind, operator: "inDateRange", values: ["", ""], extra: "" };
  return { column, kind, operator: "equals", values: [], extra: "" };
}

function draftToFilter(draft: FilterDraft): DashboardQueryFilter | null {
  const values = draft.kind === "list" && draft.extra.trim()
    ? [...draft.values, draft.extra.trim()]
    : [...draft.values];
  const cleaned = values.map((value) => value.trim()).filter((value) => value.length > 0);
  const needsValues = draft.operator !== "set" && draft.operator !== "notSet";
  if (needsValues && cleaned.length === 0) return null;
  if (draft.kind === "date" && (draft.operator === "inDateRange" || draft.operator === "notInDateRange")) {
    const [from, to] = draft.values.map((value) => value.trim());
    if (!from && !to) return null;
    // A one-sided range still needs both ends for Cube: widen the missing side.
    return { column: draft.column.key, operator: draft.operator, values: [from || "1900-01-01", to || "2999-12-31"] };
  }
  return { column: draft.column.key, operator: draft.operator, values: needsValues ? cleaned.slice(0, 50) : [] };
}

function FilterEditor({
  tile,
  draft,
  onChange,
  onSave,
  onCancel,
}: Readonly<{
  tile: DashboardTile;
  draft: FilterDraft;
  onChange: (draft: FilterDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}>) {
  const snapshot = tile.snapshot;
  const choices = useMemo(() => distinctColumnValues(snapshot?.rows ?? [], draft.column.key), [draft.column.key, snapshot]);
  const label = tile.columnPresentation[draft.column.key]?.label ?? draft.column.label;
  const valid = draftToFilter(draft) !== null;
  const set = (patch: Partial<FilterDraft>) => onChange({ ...draft, ...patch });
  const toggleValue = (value: string) => {
    const present = draft.values.includes(value);
    set({ values: present ? draft.values.filter((entry) => entry !== value) : [...draft.values, value] });
  };
  return (
    <form
      className={styles.filterEditor}
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSave();
      }}
    >
      <div className={styles.filterEditorHead}>
        <strong>{label}</strong>
        {draft.kind === "list" || draft.kind === "text" ? (
          <span className={styles.segmented} role="group" aria-label="Filter type">
            <button type="button" aria-pressed={draft.kind === "list"} onClick={() => set({ kind: "list", operator: draft.operator === "notEquals" || draft.operator === "notContains" ? "notEquals" : "equals", values: [] })}>List</button>
            <button type="button" aria-pressed={draft.kind === "text"} onClick={() => set({ kind: "text", operator: draft.operator === "notEquals" || draft.operator === "notContains" ? "notContains" : "contains", values: [draft.values[0] ?? ""] })}>Text match</button>
          </span>
        ) : null}
      </div>
      {draft.kind === "list" ? (
        <>
          <label className={styles.filterField}>
            <span className={styles.srOnly}>Include or exclude</span>
            <select aria-label="Include or exclude" value={draft.operator} onChange={(event) => set({ operator: event.target.value as DashboardQueryFilter["operator"] })}>
              <option value="equals">Include</option>
              <option value="notEquals">Exclude</option>
              <option value="set">Is set</option>
              <option value="notSet">Is empty</option>
            </select>
          </label>
          {draft.operator === "equals" || draft.operator === "notEquals" ? (
            <>
              <div className={styles.filterChoices} role="group" aria-label={`${label} values`}>
                {[...new Set([...draft.values, ...choices])].map((value) => (
                  <label key={value} className={styles.filterChoice}>
                    <input type="checkbox" checked={draft.values.includes(value)} onChange={() => toggleValue(value)} />
                    <span>{formatDashboardCell(value, draft.column, tile.columnPresentation[draft.column.key])}</span>
                  </label>
                ))}
                {choices.length === 0 && draft.values.length === 0 ? <p className={styles.filterHint}>No values on screen yet — type one below.</p> : null}
              </div>
              <label className={styles.filterField}>
                <span className={styles.srOnly}>Add a value</span>
                <input
                  aria-label="Add a value"
                  placeholder="Add a value…"
                  value={draft.extra}
                  maxLength={200}
                  onChange={(event) => set({ extra: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && draft.extra.trim()) {
                      event.preventDefault();
                      set({ values: [...draft.values, draft.extra.trim()], extra: "" });
                    }
                  }}
                />
              </label>
            </>
          ) : null}
        </>
      ) : draft.kind === "text" ? (
        <>
          <label className={styles.filterField}>
            <span className={styles.srOnly}>Match</span>
            <select aria-label="Match" value={draft.operator} onChange={(event) => set({ operator: event.target.value as DashboardQueryFilter["operator"] })}>
              <option value="contains">Contains</option>
              <option value="notContains">Does not contain</option>
              <option value="equals">Equal to</option>
              <option value="notEquals">Not equal to</option>
              <option value="set">Is set</option>
              <option value="notSet">Is empty</option>
            </select>
          </label>
          {draft.operator !== "set" && draft.operator !== "notSet" ? (
            <label className={styles.filterField}>
              <span className={styles.srOnly}>Text</span>
              <input aria-label="Text" value={draft.values[0] ?? ""} maxLength={200} onChange={(event) => set({ values: [event.target.value] })} />
            </label>
          ) : null}
        </>
      ) : draft.kind === "number" ? (
        <div className={styles.filterInline}>
          <label className={styles.filterField}>
            <span className={styles.srOnly}>Condition</span>
            <select aria-label="Condition" value={draft.operator} onChange={(event) => set({ operator: event.target.value as DashboardQueryFilter["operator"] })}>
              <option value="gte">At least</option>
              <option value="lte">At most</option>
              <option value="gt">Greater than</option>
              <option value="lt">Less than</option>
              <option value="equals">Equal to</option>
              <option value="notEquals">Not equal to</option>
              <option value="set">Is set</option>
              <option value="notSet">Is empty</option>
            </select>
          </label>
          {draft.operator !== "set" && draft.operator !== "notSet" ? (
            <label className={styles.filterField}>
              <span className={styles.srOnly}>Number</span>
              <input aria-label="Number" type="number" step="any" value={draft.values[0] ?? ""} onChange={(event) => set({ values: [event.target.value] })} />
            </label>
          ) : null}
        </div>
      ) : (
        <>
          <label className={styles.filterField}>
            <span className={styles.srOnly}>Range</span>
            <select aria-label="Range" value={draft.operator} onChange={(event) => set({ operator: event.target.value as DashboardQueryFilter["operator"], values: event.target.value === "inDateRange" || event.target.value === "notInDateRange" ? [draft.values[0] ?? "", draft.values[1] ?? ""] : [draft.values[0] ?? ""] })}>
              <option value="inDateRange">Between</option>
              <option value="notInDateRange">Not between</option>
              <option value="beforeDate">Before</option>
              <option value="afterDate">After</option>
              <option value="set">Is set</option>
              <option value="notSet">Is empty</option>
            </select>
          </label>
          {draft.operator === "inDateRange" || draft.operator === "notInDateRange" ? (
            <div className={styles.filterInline}>
              <label className={styles.filterField}>
                <span className={styles.srOnly}>From</span>
                <input aria-label="From" type="date" value={draft.values[0] ?? ""} onChange={(event) => set({ values: [event.target.value, draft.values[1] ?? ""] })} />
              </label>
              <label className={styles.filterField}>
                <span className={styles.srOnly}>To</span>
                <input aria-label="To" type="date" value={draft.values[1] ?? ""} onChange={(event) => set({ values: [draft.values[0] ?? "", event.target.value] })} />
              </label>
            </div>
          ) : draft.operator === "beforeDate" || draft.operator === "afterDate" ? (
            <label className={styles.filterField}>
              <span className={styles.srOnly}>Date</span>
              <input aria-label="Date" type="date" value={draft.values[0] ?? ""} onChange={(event) => set({ values: [event.target.value] })} />
            </label>
          ) : null}
        </>
      )}
      <div className={styles.filterEditorActions}>
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" data-primary="true" disabled={!valid}>Apply</button>
      </div>
    </form>
  );
}

function FiltersPanel({
  tile,
  onOverridesChange,
  editing,
  onEditingChange,
}: Readonly<{
  tile: DashboardTile;
  onOverridesChange: (overrides: DashboardQueryOverrides) => void;
  editing: Readonly<{ index: number | null; draft: FilterDraft }> | null;
  onEditingChange: (editing: Readonly<{ index: number | null; draft: FilterDraft }> | null) => void;
}>) {
  const columns = (tile.snapshot?.columns ?? []) as readonly TraceTableColumn[];
  const filters = tile.queryOverrides.filters ?? [];
  const [choosingColumn, setChoosingColumn] = useState(false);
  const columnChoices = columns.filter((column) => column.key !== "compareDateRange");
  if (editing) {
    return (
      <FilterEditor
        tile={tile}
        draft={editing.draft}
        onChange={(draft) => onEditingChange({ ...editing, draft })}
        onCancel={() => onEditingChange(null)}
        onSave={() => {
          const filter = draftToFilter(editing.draft);
          if (!filter) return;
          onOverridesChange(withFilter(tile.queryOverrides, filter, editing.index ?? undefined));
          onEditingChange(null);
        }}
      />
    );
  }
  return (
    <div className={styles.filtersPanel}>
      {filters.length === 0 ? <p className={styles.filterHint}>No filters on this element.</p> : null}
      {filters.map((filter, index) => {
        const column = resolveDashboardColumn(columns, filter.column);
        return (
          <div key={`${filter.column}-${index}`} className={styles.filterCard}>
            <button
              type="button"
              className={styles.filterCardBody}
              onClick={() => column && onEditingChange({ index, draft: defaultFilterDraft(column, filter) })}
            >
              {describeFilter(filter, column ? { label: tile.columnPresentation[column.key]?.label ?? column.label } : null)}
            </button>
            <button
              type="button"
              className={styles.filterRemove}
              aria-label={`Remove filter on ${column?.label ?? filter.column}`}
              onClick={() => onOverridesChange(withoutFilter(tile.queryOverrides, index))}
            >
              {icon(<path d="m6 6 12 12M18 6 6 18" />)}
            </button>
          </div>
        );
      })}
      {choosingColumn ? (
        <label className={styles.filterField}>
          <span className={styles.srOnly}>Column</span>
          <select
            aria-label="Column"
            autoFocus
            defaultValue=""
            onChange={(event) => {
              const column = columnChoices.find((entry) => entry.key === event.target.value);
              setChoosingColumn(false);
              if (column) onEditingChange({ index: null, draft: defaultFilterDraft(column) });
            }}
          >
            <option value="" disabled>Choose a column…</option>
            {columnChoices.map((column) => (
              <option key={column.key} value={column.key}>{tile.columnPresentation[column.key]?.label ?? column.label}</option>
            ))}
          </select>
        </label>
      ) : (
        <button
          type="button"
          className={styles.menuItem}
          disabled={filters.length >= 8 || columnChoices.length === 0}
          onClick={() => setChoosingColumn(true)}
        >
          {icon(<path d="M12 5v14M5 12h14" />)}
          Add filter…
        </button>
      )}
    </div>
  );
}

// ---- The Albert wand -----------------------------------------------------------

function EditWithAlbertPanel({
  tile,
  onSubmit,
  onCancel,
}: Readonly<{
  tile: DashboardTile;
  onSubmit: (instruction: string) => void;
  onCancel: () => void;
}>) {
  const [draft, setDraft] = useState("");
  const ready = draft.trim().length >= 4;
  return (
    <form
      className={styles.editPanel}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onSubmit(draft.trim());
      }}
    >
      <label className={styles.editLabel} htmlFor={`dashboard-edit-${tile.tileId}`}>
        What should change about “{tile.title}”?
      </label>
      <textarea
        id={`dashboard-edit-${tile.tileId}`}
        rows={3}
        maxLength={2_000}
        placeholder="Make it weekly, only the last 90 days…"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (ready) onSubmit(draft.trim());
          }
        }}
      />
      <div className={styles.filterEditorActions}>
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" data-primary="true" disabled={!ready}>Edit with Albert</button>
      </div>
    </form>
  );
}

async function dashboardRequest(url: string, init?: RequestInit): Promise<DashboardDocument> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => null) as { dashboard?: DashboardDocument; error?: string } | null;
  if (!response.ok || !payload?.dashboard) throw new Error(payload?.error ?? "Dashboard request failed.");
  return payload.dashboard;
}

type OpenSurface =
  | { kind: "more" }
  | { kind: "filters" }
  | { kind: "properties" }
  | { kind: "edit" }
  | { kind: "column"; columnKey: string; anchor: HTMLElement }
  | { kind: "format"; columnKey: string; anchor: HTMLElement }
  | null;

/**
 * Everything a tile can ask the workspace to do, keyed by tile id. One stable
 * object for the whole grid, so a memoised card re-renders only when its own
 * tile, selection or draft changes — not when any other tile refreshes.
 */
type TileHandlers = Readonly<{
  select: (tileId: string) => void;
  titleDraftChange: (tileId: string, value: string) => void;
  titleCommit: (tileId: string) => void;
  moveKeyboard: (tileId: string, event: React.KeyboardEvent<HTMLButtonElement>) => void;
  openSource: (tileId: string) => void;
  refresh: (tileId: string) => void;
  remove: (tileId: string) => void;
  presentation: (tileId: string, presentation: DashboardColumnPresentation) => void;
  display: (tileId: string, display: DashboardTileDisplay) => void;
  overrides: (tileId: string, overrides: DashboardQueryOverrides) => void;
  /** Authored column order: the snapshot's column contract, rewritten (ADR 0134). */
  columnOrder: (tileId: string, order: readonly string[]) => void;
  /** One deterministic query-shape edit, run by the server (migration 0187). */
  requery: (tileId: string, edits: readonly DashboardQueryEdit[]) => void;
  dismissEditError: (tileId: string) => void;
  editWithAlbert: ((tileId: string, instruction: string) => void) | null;
}>;

const DashboardTileCard = memo(function DashboardTileCard({
  tile,
  dashboardId,
  breakpoint,
  selected,
  titleDraft,
  handlers,
  elementEdit,
  justApplied,
  busy,
  editError,
}: Readonly<{
  tile: DashboardTile;
  dashboardId: string;
  breakpoint: Breakpoint;
  selected: boolean;
  titleDraft: string;
  handlers: TileHandlers;
  elementEdit: DashboardElementEdit | null;
  justApplied: boolean;
  /** A requery or forced refresh of this element is in flight: old data stays, a bar shows. */
  busy: boolean;
  /** The last edit's failure, shown inside the element until dismissed. */
  editError: string | null;
}>) {
  const tileId = tile.tileId;
  const onSelect = () => handlers.select(tileId);
  const onTitleDraftChange = (value: string) => handlers.titleDraftChange(tileId, value);
  const onTitleCommit = () => handlers.titleCommit(tileId);
  const onMoveKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>) => handlers.moveKeyboard(tileId, event);
  const onOpenSource = () => handlers.openSource(tileId);
  const onRefresh = () => handlers.refresh(tileId);
  const onRemove = () => handlers.remove(tileId);
  const onColumnPresentationChange = (presentation: DashboardColumnPresentation) => handlers.presentation(tileId, presentation);
  const onDisplayChange = (display: DashboardTileDisplay) => handlers.display(tileId, display);
  const onOverridesChange = (overrides: DashboardQueryOverrides) => handlers.overrides(tileId, overrides);
  const onEditWithAlbert = handlers.editWithAlbert
    ? (instruction: string) => handlers.editWithAlbert!(tileId, instruction)
    : undefined;
  const [open, setOpen] = useState<OpenSurface>(null);
  const [rename, setRename] = useState<ColumnRenameDraft | null>(null);
  const [filterEditing, setFilterEditing] = useState<Readonly<{ index: number | null; draft: FilterDraft }> | null>(null);
  // Popover anchors live in state (callback refs) so render never reads a ref.
  const [moreAnchor, setMoreAnchor] = useState<HTMLButtonElement | null>(null);
  const [filtersAnchor, setFiltersAnchor] = useState<HTMLButtonElement | null>(null);
  const [editAnchor, setEditAnchor] = useState<HTMLButtonElement | null>(null);
  const [propertiesAnchor, setPropertiesAnchor] = useState<HTMLButtonElement | null>(null);
  // The governed view's fields, fetched when the editor or a column menu
  // opens and kept per recipe version (a requery re-mints the recipe).
  const [fields, setFields] = useState<Readonly<{ key: string; data: ElementFields | null; error: string | null }> | null>(null);
  const fieldsKey = `${tileId}:${tile.recipeVersion ?? 0}`;
  const wantsFields = (open?.kind === "properties" || open?.kind === "column") && tile.replayKind === "cube_v3";
  useEffect(() => {
    if (!wantsFields || fields?.key === fieldsKey) return;
    let cancelled = false;
    void (async () => {
      let next: Readonly<{ key: string; data: ElementFields | null; error: string | null }>;
      try {
        const response = await fetch(`/api/dashboard/tiles/${tileId}/fields?dashboardId=${encodeURIComponent(dashboardId)}`, { cache: "no-store" });
        const payload = await response.json().catch(() => null) as (ElementFields & { error?: string }) | null;
        next = !response.ok || !payload?.members
          ? { key: fieldsKey, data: null, error: payload?.error ?? "The element's fields could not be loaded." }
          : { key: fieldsKey, data: payload, error: null };
      } catch {
        next = { key: fieldsKey, data: null, error: "The element's fields could not be loaded." };
      }
      if (!cancelled) setFields(next);
    })();
    return () => { cancelled = true; };
  }, [dashboardId, fields?.key, fieldsKey, tileId, wantsFields]);
  const elementFields = fields?.key === fieldsKey ? fields.data : null;
  const elementFieldsError = fields?.key === fieldsKey ? fields.error : null;
  const close = useCallback(() => {
    setOpen(null);
    setFilterEditing(null);
  }, []);
  const overridable = supportsOverrides(tile);
  const columns = (tile.snapshot?.columns ?? []) as readonly TraceTableColumn[];
  const filterCount = activeFilterCount(tile);
  const reworking = elementEdit !== null && elementEdit.phase !== "failed";
  const tileMode = tile.display.mode;
  const modes = availableDisplayModes(tile);

  const openColumnMenu = (column: TraceTableColumn, anchor: HTMLElement) => {
    onSelect();
    setOpen({ kind: "column", columnKey: column.key, anchor });
  };
  const sortColumn = (columnKey: string, direction: "asc" | "desc" | null) => {
    onOverridesChange(withSort(tile.queryOverrides, columnKey, direction));
    close();
  };
  const startFilter = (column: TraceTableColumn, existing?: DashboardQueryFilter, index?: number) => {
    setFilterEditing({ index: index ?? null, draft: defaultFilterDraft(column, existing) });
    setOpen({ kind: "filters" });
  };
  const quickFilter = (column: TraceTableColumn, value: unknown, operator: "equals" | "notEquals") => {
    onOverridesChange(withFilter(tile.queryOverrides, { column: column.key, operator, values: [String(value)] }));
  };

  const columnMenuColumn = open?.kind === "column" || open?.kind === "format"
    ? columns.find((column) => column.key === open.columnKey) ?? null
    : null;
  const columnMenuAnchor = open?.kind === "column" || open?.kind === "format" ? open.anchor : null;
  const columnSort = columnMenuColumn ? sortDirectionFor(tile.queryOverrides, columns, columnMenuColumn.key) : null;

  return (
    <section
      className={styles.tile}
      aria-label={tile.title}
      data-selected={selected ? "true" : undefined}
      data-reworking={reworking ? "true" : undefined}
      data-just-applied={justApplied ? "true" : undefined}
      data-busy={busy ? "true" : undefined}
      aria-busy={busy || undefined}
      onPointerDownCapture={onSelect}
    >
      <header className={styles.tileHeader}>
        <button
          className={styles.dragHandle}
          type="button"
          aria-label={`Move or resize ${tile.title}. Arrow keys move; Shift plus Arrow keys resize.`}
          onKeyDown={onMoveKeyboard}
        >
          {icon(<><circle cx="8" cy="7" r="1" fill="currentColor" stroke="none" /><circle cx="16" cy="7" r="1" fill="currentColor" stroke="none" /><circle cx="8" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="16" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="8" cy="17" r="1" fill="currentColor" stroke="none" /><circle cx="16" cy="17" r="1" fill="currentColor" stroke="none" /></>)}
        </button>
        <input
          className={styles.titleInput}
          aria-label="Tile title"
          value={titleDraft}
          maxLength={120}
          onChange={(event) => onTitleDraftChange(event.target.value)}
          onBlur={onTitleCommit}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
        />
        {reworking ? (
          <span className={styles.reworkBadge} role="status">
            <span className={styles.buildPulse} aria-hidden="true" />
            {elementEdit.phase === "applying" ? "Placing" : "Reworking"}
          </span>
        ) : (
          <span className={styles.tooltipWrap} data-tile-action="status">
            <span
              className={styles.statusBadge}
              data-state={tile.refreshState}
              tabIndex={0}
              aria-label={statusLabel(tile)}
              aria-describedby={`dashboard-status-${tile.tileId}`}
            >
              <span className={styles.statusDot} aria-hidden="true" />
            </span>
            <span className={styles.tooltip} id={`dashboard-status-${tile.tileId}`} role="tooltip">
              {statusLabel(tile)}. {statusTooltip(tile)}
            </span>
          </span>
        )}
        {breakpoint === "mobile" ? (
          <span className={styles.tileActions}>
            <button type="button" aria-label="Move tile up" onClick={() => onMoveKeyboard({ key: "ArrowUp", preventDefault() {}, shiftKey: false } as React.KeyboardEvent<HTMLButtonElement>)}>↑</button>
            <button type="button" aria-label="Move tile down" onClick={() => onMoveKeyboard({ key: "ArrowDown", preventDefault() {}, shiftKey: false } as React.KeyboardEvent<HTMLButtonElement>)}>↓</button>
          </span>
        ) : null}
        {/* Sigma's element toolbar: top-right, on hover or selection. */}
        <div className={styles.elementToolbar} role="toolbar" aria-label={`${tile.title} element`}>
          {overridable ? (
            <button
              ref={setFiltersAnchor}
              type="button"
              className={styles.toolbarButton}
              aria-label={`Filters for ${tile.title}`}
              aria-haspopup="dialog"
              aria-expanded={open?.kind === "filters"}
              data-active={open?.kind === "filters" || filterCount > 0 ? "true" : undefined}
              onClick={() => setOpen(open?.kind === "filters" ? null : { kind: "filters" })}
            >
              {FILTER_ICON}
              {filterCount > 0 ? <span className={styles.toolbarBadge}>{filterCount}</span> : null}
            </button>
          ) : null}
          <button
            ref={setPropertiesAnchor}
            type="button"
            className={styles.toolbarButton}
            aria-label={`Properties for ${tile.title}`}
            aria-haspopup="dialog"
            aria-expanded={open?.kind === "properties"}
            data-active={open?.kind === "properties" ? "true" : undefined}
            onClick={() => setOpen(open?.kind === "properties" ? null : { kind: "properties" })}
          >
            {SLIDERS_ICON}
          </button>
          {onEditWithAlbert ? (
            <button
              ref={setEditAnchor}
              type="button"
              className={styles.toolbarButton}
              aria-label={`Edit ${tile.title} with Albert`}
              aria-haspopup="dialog"
              aria-expanded={open?.kind === "edit"}
              data-active={open?.kind === "edit" ? "true" : undefined}
              disabled={reworking}
              onClick={() => setOpen(open?.kind === "edit" ? null : { kind: "edit" })}
            >
              {WAND_ICON}
            </button>
          ) : null}
          <button
            ref={setMoreAnchor}
            type="button"
            className={styles.toolbarButton}
            aria-label={`More options for ${tile.title}`}
            aria-haspopup="menu"
            aria-expanded={open?.kind === "more"}
            data-active={open?.kind === "more" ? "true" : undefined}
            onClick={() => setOpen(open?.kind === "more" ? null : { kind: "more" })}
          >
            {MORE_ICON}
          </button>
        </div>
      </header>
      {busy ? <span className={styles.tileProgress} role="progressbar" aria-label={`Updating ${tile.title}`} /> : null}
      {editError ? (
        <p className={styles.tileEditError} role="alert">
          <span>{editError}</span>
          <button type="button" onClick={() => handlers.dismissEditError(tileId)}>Dismiss</button>
        </p>
      ) : null}
      {tile.display.mode !== "kpi" && tile.display.note && !reworking ? (
        <div className={styles.tileNote}>{tile.display.note}</div>
      ) : null}
      {elementEdit && elementEdit.phase !== "failed" ? (
        <ReworkBody edit={elementEdit} title={tile.title} />
      ) : (
        <>
          {elementEdit?.phase === "failed" && elementEdit.error ? (
            <p className={styles.tileFailure} role="alert">{elementEdit.error}</p>
          ) : null}
          {tile.display.mode === "kpi" ? (
            <KpiTileBody tile={tile} />
          ) : tile.display.mode === "chart" ? (
            <ChartTileBody tile={tile} />
          ) : (
            <SnapshotTable
              tile={tile}
              onColumnPresentationChange={onColumnPresentationChange}
              onOpenColumnMenu={openColumnMenu}
              columnMenuKey={open?.kind === "column" ? open.columnKey : null}
              onKeepOnly={(column, value) => quickFilter(column, value, "equals")}
              onExclude={(column, value) => quickFilter(column, value, "notEquals")}
              rename={rename}
              onRenameChange={setRename}
            />
          )}
        </>
      )}

      {/* More menu */}
      <DashPopover anchor={moreAnchor} open={open?.kind === "more"} onClose={close} role="menu" label={`${tile.title} options`}>
        <button type="button" role="menuitem" className={styles.menuItem} disabled={tile.refreshState === "refreshing"} onClick={() => { close(); onRefresh(); }}>
          {tile.refreshState === "error" ? "Retry refresh" : "Refresh data"}
        </button>
        <button
          type="button"
          role="menuitem"
          className={styles.menuItem}
          aria-label={`Open source analysis for ${tile.title}`}
          onClick={() => { close(); onOpenSource(); }}
        >
          Open source analysis
        </button>
        <button type="button" role="menuitem" className={styles.menuItem} data-danger="true" aria-label={`Remove ${tile.title}`} onClick={() => { close(); onRemove(); }}>
          Delete element
        </button>
      </DashPopover>

      {/* Filters */}
      <DashPopover anchor={filtersAnchor} open={open?.kind === "filters"} onClose={close} label={`Filters for ${tile.title}`} width={300}>
        <FiltersPanel
          tile={tile}
          onOverridesChange={onOverridesChange}
          editing={filterEditing}
          onEditingChange={setFilterEditing}
        />
      </DashPopover>

      {/* Properties | Format (Sigma's element editor) */}
      <DashPopover anchor={propertiesAnchor} open={open?.kind === "properties"} onClose={close} label={`Properties for ${tile.title}`} width={320}>
        <ElementProperties
          tile={tile}
          busy={busy}
          modes={modes}
          fields={elementFields}
          fieldsError={elementFieldsError}
          onShowAs={(mode) => {
            if (tile.display.mode === mode) return;
            const next = defaultDisplayForMode(tile, mode);
            if (next) onDisplayChange(next);
          }}
          onDisplayChange={onDisplayChange}
          onPresentationChange={onColumnPresentationChange}
          onColumnOrderChange={(order) => handlers.columnOrder(tileId, order)}
          onRequery={(edits) => handlers.requery(tileId, edits)}
        />
      </DashPopover>

      {/* Edit with Albert */}
      <DashPopover anchor={editAnchor} open={open?.kind === "edit"} onClose={close} label={`Edit ${tile.title} with Albert`} width={320}>
        <EditWithAlbertPanel
          tile={tile}
          onCancel={close}
          onSubmit={(instruction) => {
            close();
            onEditWithAlbert?.(instruction);
          }}
        />
      </DashPopover>

      {/* Column menu (table headers) */}
      <DashPopover
        anchor={columnMenuAnchor}
        open={columnMenuAnchor !== null && columnMenuColumn !== null}
        onClose={close}
        align="start"
        role={open?.kind === "format" ? "dialog" : "menu"}
        label={`${columnMenuColumn ? (tile.columnPresentation[columnMenuColumn.key]?.label ?? columnMenuColumn.label) : "Column"} options`}
      >
        {columnMenuColumn && open?.kind === "format" ? (
          <ColumnFormatPanel tile={tile} columnKey={columnMenuColumn.key} onColumnPresentationChange={onColumnPresentationChange} />
        ) : columnMenuColumn ? (
          <>
            {overridable ? (
              <>
                <button type="button" role="menuitem" className={styles.menuItem} data-active={columnSort === "asc" ? "true" : undefined} onClick={() => sortColumn(columnMenuColumn.key, "asc")}>Sort ascending</button>
                <button type="button" role="menuitem" className={styles.menuItem} data-active={columnSort === "desc" ? "true" : undefined} onClick={() => sortColumn(columnMenuColumn.key, "desc")}>Sort descending</button>
                {columnSort ? (
                  <button type="button" role="menuitem" className={styles.menuItem} onClick={() => sortColumn(columnMenuColumn.key, null)}>Clear sort</button>
                ) : null}
                <button type="button" role="menuitem" className={styles.menuItem} onClick={() => startFilter(columnMenuColumn)}>Filter…</button>
                <span className={styles.menuDivider} aria-hidden="true" />
              </>
            ) : null}
            <button type="button" role="menuitem" className={styles.menuItem} onClick={() => {
              const column = columnMenuColumn;
              close();
              setRename({ key: column.key, label: tile.columnPresentation[column.key]?.label ?? column.label });
            }}>Rename</button>
            <button type="button" role="menuitem" className={styles.menuItem} aria-haspopup="dialog" onClick={() => {
              if (columnMenuAnchor) setOpen({ kind: "format", columnKey: columnMenuColumn.key, anchor: columnMenuAnchor });
            }}>Format…</button>
            {overridable && tileMode === "table" ? (() => {
              const member = memberForColumnKey(elementFields, columnMenuColumn.key);
              return (
                <>
                  <span className={styles.menuDivider} aria-hidden="true" />
                  <button type="button" role="menuitem" className={styles.menuItem} onClick={() => {
                    const column = columnMenuColumn;
                    close();
                    onColumnPresentationChange(withColumnHidden(tile, column.key, true));
                  }}>Hide column</button>
                  {member ? (
                    <button type="button" role="menuitem" className={styles.menuItem} data-danger="true" disabled={busy} onClick={() => {
                      close();
                      handlers.requery(tileId, [member.role === "measure"
                        ? { op: "remove_measure", member: member.member }
                        : { op: "remove_dimension", member: member.member }]);
                    }}>Delete column</button>
                  ) : null}
                </>
              );
            })() : null}
          </>
        ) : null}
      </DashPopover>
    </section>
  );
});

/** A tile is unchanged when everything a card renders from is unchanged. */
function sameTile(previous: DashboardTile, next: DashboardTile): boolean {
  return previous.tileId === next.tileId
    && previous.title === next.title
    && previous.refreshState === next.refreshState
    && previous.lastErrorCode === next.lastErrorCode
    && previous.lastRefreshedAt === next.lastRefreshedAt
    && previous.replayKind === next.replayKind
    && previous.recipeVersion === next.recipeVersion
    && previous.snapshot?.resultDigest === next.snapshot?.resultDigest
    && previous.snapshot?.refreshedAt === next.snapshot?.refreshedAt
    && (previous.snapshot?.columns.map(({ key }) => key).join("\u0000") ?? "") === (next.snapshot?.columns.map(({ key }) => key).join("\u0000") ?? "")
    && (previous.snapshot === null) === (next.snapshot === null)
    && JSON.stringify(previous.display) === JSON.stringify(next.display)
    && JSON.stringify(previous.columnPresentation) === JSON.stringify(next.columnPresentation)
    && JSON.stringify(previous.queryOverrides) === JSON.stringify(next.queryOverrides);
}

/**
 * Every response carries the whole document; adopting it wholesale gave
 * every tile a new object and re-drew every chart on each edit. Unchanged
 * tiles keep their previous object so memoised cards skip the render.
 */
function mergeDashboard(previous: DashboardDocument | null, next: DashboardDocument): DashboardDocument {
  if (!previous || previous.dashboardId !== next.dashboardId) return next;
  const before = new Map(previous.tiles.map((tile) => [tile.tileId, tile]));
  let reused = 0;
  const tiles = next.tiles.map((tile) => {
    const prior = before.get(tile.tileId);
    if (prior && sameTile(prior, tile)) {
      reused += 1;
      return prior;
    }
    return tile;
  });
  return reused === 0 ? next : { ...next, tiles };
}

export default function DashboardWorkspace({
  dashboardId,
  onOpenSource,
  onStartBuild,
  embedded = false,
  onReady,
  onBack,
  onEditWithAlbert,
  elementEdit = null,
  onDashboardChange,
}: DashboardWorkspaceProps) {
  const [dashboard, setDashboard] = useState<DashboardDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [layoutState, setLayoutState] = useState<ResponsiveLayouts<Breakpoint>>({});
  const [titleDrafts, setTitleDrafts] = useState<Record<string, string>>({});
  const [dashboardTitleDraft, setDashboardTitleDraft] = useState<string | null>(null);
  const dashboardTitleCancelRef = useRef(false);
  const [announcement, setAnnouncement] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null);
  // Elements with a requery in flight keep their data and show a bar
  // (stale-while-revalidate); a failed edit shows one line in the element.
  const [busyTiles, setBusyTiles] = useState<ReadonlySet<string>>(() => new Set());
  const [editErrors, setEditErrors] = useState<Readonly<Record<string, string>>>({});
  // Edits to one element run in order: each one starts from the recipe the
  // previous one produced, so two quick changes never race for the version.
  const requeryChainRef = useRef(new Map<string, Promise<void>>());
  // Tile and layout mutations run in order too, so each carries the revision
  // the previous one returned instead of conflicting on it.
  const mutationChainRef = useRef<Promise<unknown>>(Promise.resolve());
  // Per-tile refresh locks: a forced single-tile refresh never waits on, or
  // is dropped by, the whole-dashboard refresh (and vice versa).
  const tilesInFlightRef = useRef(new Set<string>());
  const allInFlightRef = useRef(false);
  const lastRefreshAtRef = useRef(0);
  const dashboardRef = useRef<DashboardDocument | null>(null);
  const titleDraftsRef = useRef<Record<string, string>>({});
  useEffect(() => {
    dashboardRef.current = dashboard;
  }, [dashboard]);
  useEffect(() => {
    titleDraftsRef.current = titleDrafts;
  }, [titleDrafts]);
  const build = useSyncExternalStore(subscribeDashboardBuild, dashboardBuildSnapshot, dashboardBuildSnapshot);
  const { width, containerRef, mounted, measureWidth } = useContainerWidth({
    measureBeforeMount: true,
  });
  // ResponsiveGridLayout does not emit onBreakpointChange for its initial
  // breakpoint. Deriving the same value from width keeps stop callbacks from
  // accidentally saving a tablet resize into the desktop layout (or vice versa).
  // The split panel is narrower than a tablet but is not a phone: it keeps
  // the saved geometry (tablet columns) instead of stacking tiles.
  const breakpoint: Breakpoint = width >= 1100 ? "desktop" : width >= 680 || embedded ? "tablet" : "mobile";
  const latestLayouts = useRef<ResponsiveLayouts<Breakpoint>>({});
  const revisionRef = useRef(0);
  const loadedDashboardId = dashboard?.dashboardId;
  const onDashboardChangeRef = useRef(onDashboardChange);
  useEffect(() => {
    onDashboardChangeRef.current = onDashboardChange;
  }, [onDashboardChange]);

  const applyDashboard = useCallback((next: DashboardDocument) => {
    setDashboard((previous) => mergeDashboard(previous, next));
    revisionRef.current = next.revision;
    setTitleDrafts(Object.fromEntries(next.tiles.map((tile) => [tile.tileId, tile.title])));
    const ids = next.tiles.map(({ tileId }) => tileId);
    const layouts: ResponsiveLayouts<Breakpoint> = {
      desktop: hydrateLayout(next.layouts.desktop, ids, 12),
      tablet: hydrateLayout(next.layouts.tablet, ids, 8),
      mobile: defaultLayout(ids, 1),
    };
    latestLayouts.current = layouts;
    setLayoutState(layouts);
    onDashboardChangeRef.current?.(next);
  }, []);

  const withDashboardId = useCallback((values: Record<string, unknown>) => ({ ...values, dashboardId }), [dashboardId]);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    try {
      applyDashboard(await dashboardRequest(`/api/dashboard?dashboardId=${encodeURIComponent(dashboardId)}`, { cache: "no-store" }));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Dashboard unavailable.");
    } finally {
      setLoading(false);
    }
  }, [applyDashboard, dashboardId]);

  const refresh = useCallback(async (tileIds?: readonly string[], force = false) => {
    const wanted = tileIds?.filter((tileId) => !tilesInFlightRef.current.has(tileId));
    if (tileIds && (!wanted || wanted.length === 0)) return;
    if (!tileIds && allInFlightRef.current) return;
    if (wanted) wanted.forEach((tileId) => tilesInFlightRef.current.add(tileId));
    else {
      allInFlightRef.current = true;
      setRefreshing(true);
    }
    try {
      const next = await dashboardRequest("/api/dashboard/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withDashboardId({ ...(wanted ? { tileIds: wanted } : {}), force })),
      });
      applyDashboard(next);
      lastRefreshAtRef.current = Date.now();
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Refresh failed.");
      await loadDashboard();
    } finally {
      if (wanted) wanted.forEach((tileId) => tilesInFlightRef.current.delete(tileId));
      else {
        allInFlightRef.current = false;
        setRefreshing(false);
      }
    }
  }, [applyDashboard, loadDashboard, withDashboardId]);

  // Hosts key the workspace by dashboard id, so a different dashboard is a
  // fresh mount with a clean document; this only loads it.
  useEffect(() => {
    const timer = window.setTimeout(() => void loadDashboard(), 0);
    return () => window.clearTimeout(timer);
  }, [loadDashboard]);
  useEffect(() => {
    // A settled build (applied, failed, or stopped) may have replaced the
    // tiles; re-read the document so the grid reflects what was applied.
    if (build.settledCount === 0) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        await loadDashboard();
        // A freshly applied element shows its pinned snapshot; run its
        // governed query now rather than at the next focus.
        const settled = dashboardBuildSnapshot();
        if (settled.phase === "applied" && settled.dashboardId === dashboardId && settled.appliedTileId) {
          void refresh([settled.appliedTileId], true);
        }
      })();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [build.settledCount, dashboardId, loadDashboard, refresh]);
  const hasTiles = (dashboard?.tiles.length ?? 0) > 0;
  const readyFiredRef = useRef(false);
  useEffect(() => {
    if (readyFiredRef.current || !dashboard || loading) return;
    if (hasTiles && !mounted) return;
    readyFiredRef.current = true;
    onReady?.();
  }, [dashboard, hasTiles, loading, mounted, onReady]);
  useEffect(() => {
    if (!loadedDashboardId || !hasTiles) return;
    // The first hook measurement happens while the loading or empty state has
    // no grid container. Measuring once after the ref mounts activates its
    // observer so sidebar transitions and viewport changes keep tile pixels
    // responsive — including the empty → filled transition a build causes.
    const frame = window.requestAnimationFrame(measureWidth);
    return () => window.cancelAnimationFrame(frame);
  }, [loadedDashboardId, hasTiles, measureWidth]);
  useEffect(() => {
    if (!dashboard || dashboard.tiles.length === 0) return;
    const timer = window.setTimeout(() => void refresh(undefined, false), 0);
    return () => window.clearTimeout(timer);
  // Refresh once per dashboard open; the server deduplicates the five-minute window.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedDashboardId]);
  useEffect(() => {
    // Coming back to the tab re-checks the five-minute window, but not more
    // than once a minute; the interval covers a tab that stays open.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastRefreshAtRef.current < 60_000) return;
      void refresh(undefined, false);
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(undefined, false);
    }, 300_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [refresh]);
  // Escape clears the element selection, like clicking the canvas.
  useEffect(() => {
    if (!selectedTileId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setSelectedTileId(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedTileId]);

  const persistLayouts = useCallback(async (layouts = latestLayouts.current) => {
    if (!dashboard) return;
    const ids = dashboard.tiles.map(({ tileId }) => tileId);
    const body: DashboardLayouts = {
      desktop: serializable(hydrateLayout(layouts.desktop ?? [], ids, 12)),
      tablet: serializable(hydrateLayout(layouts.tablet ?? [], ids, 8)),
    };
    try {
      applyDashboard(await dashboardRequest("/api/dashboard/layout", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withDashboardId({ layouts: body, expectedRevision: revisionRef.current })),
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Layout could not be saved.");
      await loadDashboard();
    }
  }, [applyDashboard, dashboard, loadDashboard, withDashboardId]);

  const mutateTile = useCallback(async (
    tileId: string,
    method: "PATCH" | "DELETE",
    values: Record<string, unknown>,
    /** Applied to the tile at once; the server's document replaces it when the change lands. */
    optimistic?: (tile: DashboardTile) => DashboardTile,
  ): Promise<boolean> => {
    if (optimistic) {
      setDashboard((previous) => previous
        ? { ...previous, tiles: previous.tiles.map((tile) => (tile.tileId === tileId ? optimistic(tile) : tile)) }
        : previous);
    }
    const run = mutationChainRef.current.then(async () => {
      try {
        applyDashboard(await dashboardRequest(`/api/dashboard/tiles/${tileId}`, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(withDashboardId({ ...values, expectedRevision: revisionRef.current })),
        }));
        return true;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Tile could not be changed.");
        await loadDashboard();
        return false;
      }
    });
    mutationChainRef.current = run.catch(() => undefined);
    return run;
  }, [applyDashboard, loadDashboard, withDashboardId]);

  /**
   * One deterministic edit to an element's governed query (ADR 0134). The
   * server patches the recipe, runs it once and stores the new recipe with
   * its snapshot; the element keeps its data until the new one lands.
   */
  const requery = useCallback((tileId: string, edits: readonly DashboardQueryEdit[]) => {
    const previous = requeryChainRef.current.get(tileId) ?? Promise.resolve();
    const run = previous.then(async () => {
      const tile = dashboardRef.current?.tiles.find((candidate) => candidate.tileId === tileId);
      if (!tile) return;
      setBusyTiles((current) => new Set([...current, tileId]));
      setEditErrors((current) => {
        if (!(tileId in current)) return current;
        const rest = { ...current };
        delete rest[tileId];
        return rest;
      });
      try {
        const response = await fetch(`/api/dashboard/tiles/${tileId}/query`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(withDashboardId({
            edits,
            expectedRevision: revisionRef.current,
            recipeVersion: tile.recipeVersion ?? 1,
          })),
        });
        const payload = await response.json().catch(() => null) as { dashboard?: DashboardDocument; error?: string } | null;
        if (payload?.dashboard) applyDashboard(payload.dashboard);
        if (!response.ok) throw new Error(payload?.error ?? "The element could not be edited.");
      } catch (caught) {
        setEditErrors((current) => ({ ...current, [tileId]: caught instanceof Error ? caught.message : "The element could not be edited." }));
      } finally {
        setBusyTiles((current) => {
          const next = new Set(current);
          next.delete(tileId);
          return next;
        });
      }
    });
    requeryChainRef.current.set(tileId, run.catch(() => undefined));
  }, [applyDashboard, withDashboardId]);

  /**
   * Sort/filter change: save the overrides (the rows on screen re-sort at
   * once through the renderer), then re-run the element's governed query so
   * the snapshot reflects the full result set, not just the 50 rows held.
   */
  const changeOverrides = useCallback(async (tileId: string, overrides: DashboardQueryOverrides) => {
    const saved = await mutateTile(tileId, "PATCH", { queryOverrides: overrides });
    if (saved) void refresh([tileId], true);
  }, [mutateTile, refresh]);

  const commitDashboardTitle = useCallback(async () => {
    if (dashboardTitleCancelRef.current) {
      dashboardTitleCancelRef.current = false;
      setDashboardTitleDraft(null);
      return;
    }
    if (dashboardTitleDraft === null || !dashboard) return;
    const cleaned = dashboardTitleDraft.trim();
    setDashboardTitleDraft(null);
    const current = dashboard.title ?? "";
    if (cleaned === current || (!cleaned && !current)) return;
    try {
      applyDashboard(await dashboardRequest("/api/dashboard/rename", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withDashboardId({ title: cleaned || null, expectedRevision: revisionRef.current })),
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The dashboard could not be renamed.");
      await loadDashboard();
    }
  }, [applyDashboard, dashboard, dashboardTitleDraft, loadDashboard, withDashboardId]);

  const moveWithKeyboard = useCallback((tileId: string, event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!event.key.startsWith("Arrow")) return;
    event.preventDefault();
    const columns = breakpoint === "desktop" ? 12 : breakpoint === "tablet" ? 8 : 1;
    const current = [...(latestLayouts.current[breakpoint] ?? [])];
    const index = current.findIndex(({ i }) => i === tileId);
    if (index < 0) return;
    const original = current[index]!;
    let next = { ...original };
    if (breakpoint === "mobile") {
      const swapIndex = event.key === "ArrowUp" ? Math.max(0, index - 1) : event.key === "ArrowDown" ? Math.min(current.length - 1, index + 1) : index;
      if (swapIndex !== index) [current[index], current[swapIndex]] = [current[swapIndex]!, current[index]!];
      next = { ...next, y: swapIndex * 7 };
    } else if (event.shiftKey) {
      if (event.key === "ArrowRight") next.w = Math.min(columns - next.x, 12, next.w + 1);
      if (event.key === "ArrowLeft") next.w = Math.max(3, next.w - 1);
      if (event.key === "ArrowDown") next.h = Math.min(16, next.h + 1);
      if (event.key === "ArrowUp") next.h = Math.max(5, next.h - 1);
      current[index] = next;
    } else {
      if (event.key === "ArrowRight") next.x = Math.min(columns - next.w, next.x + 1);
      if (event.key === "ArrowLeft") next.x = Math.max(0, next.x - 1);
      if (event.key === "ArrowDown") next.y += 1;
      if (event.key === "ArrowUp") next.y = Math.max(0, next.y - 1);
      current[index] = next;
    }
    const layouts = { ...latestLayouts.current, [breakpoint]: current };
    latestLayouts.current = layouts;
    setLayoutState(layouts);
    setAnnouncement(`${event.shiftKey ? "Resized" : "Moved"} tile to column ${next.x + 1}, row ${next.y + 1}, width ${next.w}, height ${next.h}.`);
    if (breakpoint !== "mobile") void persistLayouts(layouts);
  }, [breakpoint, persistLayouts]);

  const tilesById = useMemo(() => new Map(dashboard?.tiles.map((tile) => [tile.tileId, tile]) ?? []), [dashboard]);
  const handlers = useMemo<TileHandlers>(() => ({
    select: (tileId) => setSelectedTileId(tileId),
    titleDraftChange: (tileId, value) => setTitleDrafts((current) => ({ ...current, [tileId]: value })),
    titleCommit: (tileId) => {
      const tile = dashboardRef.current?.tiles.find((candidate) => candidate.tileId === tileId);
      if (!tile) return;
      const title = titleDraftsRef.current[tileId]?.trim();
      if (title && title !== tile.title) void mutateTile(tileId, "PATCH", { title });
      else setTitleDrafts((current) => ({ ...current, [tileId]: tile.title }));
    },
    moveKeyboard: (tileId, event) => moveWithKeyboard(tileId, event),
    openSource: (tileId) => {
      const tile = dashboardRef.current?.tiles.find((candidate) => candidate.tileId === tileId);
      if (tile) onOpenSource(tile.source.conversationId);
    },
    refresh: (tileId) => void refresh([tileId], true),
    remove: (tileId) => void mutateTile(tileId, "DELETE", {}),
    presentation: (tileId, columnPresentation) => void mutateTile(tileId, "PATCH", { columnPresentation }, (tile) => ({ ...tile, columnPresentation })),
    display: (tileId, display) => void mutateTile(tileId, "PATCH", { display }, (tile) => ({ ...tile, display })),
    overrides: (tileId, overrides) => void changeOverrides(tileId, overrides),
    columnOrder: (tileId, order) => void mutateTile(tileId, "PATCH", { columnOrder: order }, (tile) => {
      if (!tile.snapshot) return tile;
      const rank = new Map(order.map((key, index) => [key, index] as const));
      const columns = [...tile.snapshot.columns].sort((left, right) => (rank.get(left.key) ?? order.length) - (rank.get(right.key) ?? order.length));
      return { ...tile, snapshot: { ...tile.snapshot, columns } };
    }),
    requery: (tileId, edits) => requery(tileId, edits),
    dismissEditError: (tileId) => setEditErrors((current) => {
      if (!(tileId in current)) return current;
      const rest = { ...current };
      delete rest[tileId];
      return rest;
    }),
    editWithAlbert: onEditWithAlbert
      ? (tileId, instruction) => {
        const tile = dashboardRef.current?.tiles.find((candidate) => candidate.tileId === tileId);
        if (tile) onEditWithAlbert({ tileId, title: tile.title }, instruction);
      }
      : null,
  }), [changeOverrides, moveWithKeyboard, mutateTile, onEditWithAlbert, onOpenSource, refresh, requery]);
  const editingThisDashboard = build.dashboardId === dashboardId;
  const justAppliedTileId = build.phase === "applied" && editingThisDashboard ? build.appliedTileId : null;

  if (loading && !dashboard) return <div className={styles.state}>Loading your dashboard…</div>;
  if (!dashboard) return <div className={styles.state}><p>{error ?? "Dashboard unavailable."}</p><button type="button" onClick={() => void loadDashboard()}>Retry</button></div>;

  return (
    <div className={styles.workspace} onPointerDown={(event) => { if (event.target === event.currentTarget) setSelectedTileId(null); }}>
      <div className={styles.toolbar} data-embedded={embedded ? "true" : undefined}>
        <div className={styles.toolbarIdentity}>
          {onBack ? (
            <button type="button" className={styles.backLink} onClick={onBack}>
              {icon(<path d="m14 6-6 6 6 6" />)}
              Dashboards
            </button>
          ) : null}
          <input
            className={styles.dashboardTitleInput}
            aria-label="Dashboard name"
            placeholder="Name this dashboard"
            maxLength={80}
            value={dashboardTitleDraft ?? dashboard.title ?? ""}
            onChange={(event) => setDashboardTitleDraft(event.target.value)}
            onFocus={() => setDashboardTitleDraft(dashboard.title ?? "")}
            onBlur={() => void commitDashboardTitle()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                dashboardTitleCancelRef.current = true;
                event.currentTarget.blur();
              }
            }}
          />
          {error ? <span className={styles.errorNotice} role="status">{error}</span> : null}
        </div>
        <div className={styles.toolbarActions}>
          {!embedded && !build.active && onStartBuild ? (
            <button
              className={styles.buildOpen}
              type="button"
              onClick={onStartBuild}
            >
              {WAND_ICON}
              Build with Albert
            </button>
          ) : null}
          <button className={styles.refreshAll} type="button" aria-label={refreshing ? "Refreshing" : "Refresh data"} title={refreshing ? "Refreshing" : "Refresh data"} disabled={refreshing || dashboard.tiles.length === 0} onClick={() => void refresh(undefined, true)}>
            {icon(<><path d="M20 7v5h-5" /><path d="M18.5 16a8 8 0 1 1 .5-9l1 5" /></>)}
          </button>
        </div>
      </div>
      <span className={styles.srOnly} aria-live="polite">{announcement}</span>
      {embedded ? null : (
        <>
          <BuildProgressCard
            onWatch={build.conversationId ? () => onOpenSource(build.conversationId!) : undefined}
          />
          <BuildResultBanner />
        </>
      )}
      {dashboard.tiles.length === 0 ? (
        build.active && editingThisDashboard ? null : (
          <div className={styles.buildHero}>
            <span className={styles.buildHeroIcon}>
              {icon(<><rect x="3.5" y="4" width="17" height="16" rx="2.5" /><path d="M3.5 10h7v10M10.5 10h10M10.5 15h10" /></>)}
            </span>
            <h2>{embedded ? "Describe what you want to watch" : "Build your dashboard"}</h2>
            <p>Tell Albert what matters. It designs the elements, proves every number with governed queries, and they stay live from then on.</p>
            {!embedded && onStartBuild ? (
              <button className={styles.buildStart} type="button" onClick={onStartBuild}>
                {WAND_ICON}
                Build with Albert
              </button>
            ) : (
              <p className={styles.buildHeroHint}>Type it in the chat on the left to get started.</p>
            )}
          </div>
        )
      ) : (
        <div ref={containerRef} className={styles.gridMeasure}>
          {mounted ? (
            <ResponsiveGridLayout<Breakpoint>
              width={width}
              breakpoint={breakpoint}
              breakpoints={{ desktop: 1100, tablet: 680, mobile: 0 }}
              cols={{ desktop: 12, tablet: 8, mobile: 1 }}
              layouts={layoutState}
              rowHeight={28}
              margin={{ desktop: [10, 10], tablet: [10, 10], mobile: [0, 10] }}
              containerPadding={{ desktop: [0, 0], tablet: [0, 0], mobile: [0, 0] }}
              compactor={verticalCompactor}
              dragConfig={{ enabled: breakpoint !== "mobile", handle: `.${styles.dragHandle}` }}
              resizeConfig={{
                enabled: breakpoint !== "mobile",
                // Sigma-style: resize from any edge or corner; the handle
                // chrome itself stays invisible (cursor change only).
                handles: ["n", "s", "e", "w", "ne", "nw", "se", "sw"],
              }}
              onLayoutChange={(_layout, layouts) => { latestLayouts.current = layouts; setLayoutState(layouts); }}
              onDragStop={(layout, _old, next) => {
                const stoppedBreakpoint = breakpoint;
                setAnnouncement(`Moved tile to column ${(next?.x ?? 0) + 1}, row ${(next?.y ?? 0) + 1}.`);
                // RGL publishes the responsive layout immediately after this
                // callback. Persist on the microtask so that final layout,
                // including compaction, is the one sent to the server.
                window.queueMicrotask(() => {
                  const layouts = {
                    ...latestLayouts.current,
                    [stoppedBreakpoint]: latestLayouts.current[stoppedBreakpoint] ?? layout,
                  };
                  void persistLayouts(layouts);
                });
              }}
              onResizeStop={(layout, _old, next) => {
                const stoppedBreakpoint = breakpoint;
                setAnnouncement(`Resized tile to width ${next?.w ?? 0}, height ${next?.h ?? 0}.`);
                window.queueMicrotask(() => {
                  const layouts = {
                    ...latestLayouts.current,
                    [stoppedBreakpoint]: latestLayouts.current[stoppedBreakpoint] ?? layout,
                  };
                  void persistLayouts(layouts);
                });
              }}
            >
              {(layoutState[breakpoint] ?? []).map(({ i }) => {
                const tile = tilesById.get(i);
                if (!tile) return null;
                return (
                  <div key={tile.tileId} className={styles.gridItem}>
                    <DashboardTileCard
                      tile={tile}
                      dashboardId={dashboardId}
                      breakpoint={breakpoint}
                      selected={selectedTileId === tile.tileId}
                      titleDraft={titleDrafts[tile.tileId] ?? tile.title}
                      handlers={handlers}
                      elementEdit={elementEdit && elementEdit.tileId === tile.tileId ? elementEdit : null}
                      justApplied={justAppliedTileId === tile.tileId}
                      busy={busyTiles.has(tile.tileId)}
                      editError={editErrors[tile.tileId] ?? null}
                    />
                  </div>
                );
              })}
            </ResponsiveGridLayout>
          ) : null}
        </div>
      )}
    </div>
  );
}
