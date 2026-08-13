"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  DashboardSnapshot,
  DashboardTile,
} from "@/services/control-plane/src/dashboard-repository";
import { formatDashboardCell } from "./dashboard-values";
import styles from "./dashboard-workspace.module.css";

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

type DashboardWorkspaceProps = Readonly<{
  onOpenSource: (conversationId: string) => void;
}>;

function icon(path: React.ReactNode) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">{path}</svg>;
}

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
  if (tile.snapshot?.empty) return "No data";
  return "Current";
}

function statusTooltip(tile: DashboardTile): string {
  const dateDetail = freshness(tile.snapshot);
  if (tile.refreshState === "refreshing") return `Refreshing now. ${dateDetail}.`;
  if (tile.refreshState === "error") return `Last refresh failed. ${dateDetail}.`;
  if (tile.refreshState === "stale") return `Refresh needed. ${dateDetail}.`;
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
  };
  if (Object.keys(presentation).length) next[columnKey] = presentation;
  else delete next[columnKey];
  return next;
}

function SnapshotTable({
  tile,
  selectedColumnKey,
  onSelectColumn,
  onColumnPresentationChange,
}: Readonly<{
  tile: DashboardTile;
  selectedColumnKey: string | null;
  onSelectColumn: (key: string | null) => void;
  onColumnPresentationChange: (presentation: DashboardColumnPresentation) => void;
}>) {
  const { snapshot } = tile;
  const [rename, setRename] = useState<ColumnRenameDraft | null>(null);
  if (!snapshot) return <div className={styles.tileEmpty}>Run refresh to load this governed result.</div>;
  if (snapshot.empty) return <div className={styles.tileEmpty}>No data for the governed period.</div>;

  const openRename = (column: DashboardSnapshot["columns"][number]) => {
    const presentation = tile.columnPresentation[column.key];
    onSelectColumn(column.key);
    setRename({
      key: column.key,
      label: presentation?.label ?? column.label,
    });
  };

  const closeRename = (save: boolean) => {
    if (!rename) return;
    if (save) {
      const next = applyColumnPresentation(tile, rename.key, { label: rename.label });
      if (JSON.stringify(next) !== JSON.stringify(tile.columnPresentation)) {
        onColumnPresentationChange(next);
      }
    }
    setRename(null);
  };

  return (
    <div className={styles.tableScroll} tabIndex={0} aria-label="Scrollable governed table">
      <table>
        <thead>
          <tr>
            {snapshot.columns.map((column) => {
              const presentation = tile.columnPresentation[column.key];
              const draft = rename?.key === column.key ? rename : null;
              const selected = selectedColumnKey === column.key;
              return (
                <th key={column.key} data-selected={selected ? "true" : undefined}>
                  {draft ? (
                    <div
                      className={styles.columnEditor}
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
                        onChange={(event) => setRename({ ...draft, label: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") closeRename(true);
                          if (event.key === "Escape") closeRename(false);
                        }}
                      />
                    </div>
                  ) : (
                    <button
                      className={styles.columnHeaderButton}
                      type="button"
                      aria-pressed={selected}
                      aria-label={`${presentation?.label ?? column.label} column. Click to select for formatting. Double-click or press Enter to rename.`}
                      onClick={() => onSelectColumn(column.key)}
                      onDoubleClick={() => openRename(column)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === "F2") {
                          event.preventDefault();
                          openRename(column);
                        }
                        if (event.key === "Escape") onSelectColumn(null);
                      }}
                    >
                      {presentation?.label ?? column.label}
                    </button>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {snapshot.rows.map((row, index) => (
            <tr key={index}>
              {snapshot.columns.map((column) => (
                <td
                  key={column.key}
                  data-selected={selectedColumnKey === column.key ? "true" : undefined}
                  onClick={() => onSelectColumn(column.key)}
                >
                  {formatDashboardCell(
                    row[column.key],
                    column,
                    tile.columnPresentation[column.key],
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {snapshot.totalRowCount > snapshot.rows.length ? (
        <div className={styles.rowCount}>Showing {snapshot.rows.length} of {snapshot.totalRowCount.toLocaleString("en-AU")} rows</div>
      ) : null}
    </div>
  );
}

function ColumnFormatMenu({
  tile,
  columnKey,
  open,
  onOpenChange,
  onColumnPresentationChange,
}: Readonly<{
  tile: DashboardTile;
  columnKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onColumnPresentationChange: (presentation: DashboardColumnPresentation) => void;
}>) {
  const areaRef = useRef<HTMLDivElement>(null);
  const column = tile.snapshot?.columns.find(({ key }) => key === columnKey) ?? null;
  const presentation = tile.columnPresentation[columnKey];
  const draft: ColumnFormatDraft = {
    key: columnKey,
    format: presentation?.format ?? "auto",
    decimals: presentation?.decimals ?? "auto",
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!areaRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onOpenChange, open]);

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
    <div className={styles.columnFormatMenu} ref={areaRef}>
      <button
        className={styles.columnFormatTrigger}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        data-active={open ? "true" : undefined}
        onClick={() => onOpenChange(!open)}
      >
        Format
      </button>
      {open ? (
        <div className={styles.columnFormatPanel} role="dialog" aria-label={`Format ${presentation?.label ?? column.label}`}>
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
      ) : null}
    </div>
  );
}

async function dashboardRequest(url: string, init?: RequestInit): Promise<DashboardDocument> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => null) as { dashboard?: DashboardDocument; error?: string } | null;
  if (!response.ok || !payload?.dashboard) throw new Error(payload?.error ?? "Dashboard request failed.");
  return payload.dashboard;
}

function DashboardTileCard({
  tile,
  breakpoint,
  titleDraft,
  onTitleDraftChange,
  onTitleCommit,
  onMoveKeyboard,
  onOpenSource,
  onRefresh,
  onRemove,
  onColumnPresentationChange,
}: Readonly<{
  tile: DashboardTile;
  breakpoint: Breakpoint;
  titleDraft: string;
  onTitleDraftChange: (value: string) => void;
  onTitleCommit: () => void;
  onMoveKeyboard: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  onOpenSource: () => void;
  onRefresh: () => void;
  onRemove: () => void;
  onColumnPresentationChange: (presentation: DashboardColumnPresentation) => void;
}>) {
  const [selectedColumnKey, setSelectedColumnKey] = useState<string | null>(null);
  const [formatOpen, setFormatOpen] = useState(false);
  const selectedStillExists = Boolean(
    selectedColumnKey && tile.snapshot?.columns.some(({ key }) => key === selectedColumnKey),
  );
  const activeColumnKey = selectedStillExists ? selectedColumnKey : null;
  const activeFormatOpen = selectedStillExists && formatOpen;

  return (
    <section className={styles.tile} aria-label={tile.title}>
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
        <div className={styles.tileActions}>
          {activeColumnKey ? (
            <ColumnFormatMenu
              tile={tile}
              columnKey={activeColumnKey}
              open={activeFormatOpen}
              onOpenChange={setFormatOpen}
              onColumnPresentationChange={onColumnPresentationChange}
            />
          ) : null}
          {breakpoint === "mobile" ? (
            <>
              <button type="button" aria-label="Move tile up" onClick={() => onMoveKeyboard({ key: "ArrowUp", preventDefault() {}, shiftKey: false } as React.KeyboardEvent<HTMLButtonElement>)}>↑</button>
              <button type="button" aria-label="Move tile down" onClick={() => onMoveKeyboard({ key: "ArrowDown", preventDefault() {}, shiftKey: false } as React.KeyboardEvent<HTMLButtonElement>)}>↓</button>
            </>
          ) : null}
          <span className={styles.tooltipWrap}>
            <span
              className={styles.statusBadge}
              data-state={tile.refreshState}
              tabIndex={0}
              aria-describedby={`dashboard-status-${tile.tileId}`}
            >
              {statusLabel(tile)}
            </span>
            <span className={styles.tooltip} id={`dashboard-status-${tile.tileId}`} role="tooltip">
              {statusTooltip(tile)}
            </span>
          </span>
          <span className={styles.tooltipWrap}>
            <button
              type="button"
              aria-label={`Open source analysis for ${tile.title}`}
              aria-describedby={`dashboard-source-${tile.tileId}`}
              onClick={onOpenSource}
            >
              {icon(<><path d="M14 5h5v5" /><path d="m10 14 9-9" /><path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></>)}
            </button>
            <span className={styles.tooltip} id={`dashboard-source-${tile.tileId}`} role="tooltip">Open source analysis</span>
          </span>
          <span className={styles.tooltipWrap}>
            <button
              type="button"
              aria-label={`${tile.refreshState === "error" ? "Retry" : "Refresh"} ${tile.title}`}
              aria-describedby={`dashboard-refresh-${tile.tileId}`}
              disabled={tile.refreshState === "refreshing"}
              onClick={onRefresh}
            >
              {icon(<><path d="M20 7v5h-5" /><path d="M18.5 16a8 8 0 1 1 .5-9l1 5" /></>)}
            </button>
            <span className={styles.tooltip} id={`dashboard-refresh-${tile.tileId}`} role="tooltip">
              {tile.refreshState === "error" ? "Retry refresh" : "Refresh table"}
            </span>
          </span>
          <button type="button" aria-label={`Remove ${tile.title}`} onClick={onRemove}>
            {icon(<><path d="M5 7h14M9 7V4h6v3M8 10v8M12 10v8M16 10v8M6.5 7l1 14h9l1-14" /></>)}
          </button>
        </div>
      </header>
      <SnapshotTable
        tile={tile}
        selectedColumnKey={activeColumnKey}
        onSelectColumn={(key) => {
          setSelectedColumnKey(key);
          if (key !== activeColumnKey) setFormatOpen(false);
        }}
        onColumnPresentationChange={onColumnPresentationChange}
      />
    </section>
  );
}

export default function DashboardWorkspace({ onOpenSource }: DashboardWorkspaceProps) {
  const [dashboard, setDashboard] = useState<DashboardDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [layoutState, setLayoutState] = useState<ResponsiveLayouts<Breakpoint>>({});
  const [titleDrafts, setTitleDrafts] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const { width, containerRef, mounted, measureWidth } = useContainerWidth({
    measureBeforeMount: true,
  });
  // ResponsiveGridLayout does not emit onBreakpointChange for its initial
  // breakpoint. Deriving the same value from width keeps stop callbacks from
  // accidentally saving a tablet resize into the desktop layout (or vice versa).
  const breakpoint: Breakpoint = width >= 1100 ? "desktop" : width >= 680 ? "tablet" : "mobile";
  const latestLayouts = useRef<ResponsiveLayouts<Breakpoint>>({});
  const revisionRef = useRef(0);
  const dashboardId = dashboard?.dashboardId;

  const applyDashboard = useCallback((next: DashboardDocument) => {
    setDashboard(next);
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
  }, []);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    try {
      applyDashboard(await dashboardRequest("/api/dashboard", { cache: "no-store" }));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Dashboard unavailable.");
    } finally {
      setLoading(false);
    }
  }, [applyDashboard]);

  const refresh = useCallback(async (tileIds?: readonly string[], force = false) => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const next = await dashboardRequest("/api/dashboard/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(tileIds ? { tileIds } : {}), force }),
      });
      applyDashboard(next);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Refresh failed.");
      await loadDashboard();
    } finally {
      setRefreshing(false);
    }
  }, [applyDashboard, loadDashboard, refreshing]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadDashboard(), 0);
    return () => window.clearTimeout(timer);
  }, [loadDashboard]);
  useEffect(() => {
    if (!dashboardId) return;
    // The first hook measurement happens while the loading state has no grid
    // container. Measuring once after the ref mounts activates its observer so
    // sidebar transitions and viewport changes keep tile pixels responsive.
    const frame = window.requestAnimationFrame(measureWidth);
    return () => window.cancelAnimationFrame(frame);
  }, [dashboardId, measureWidth]);
  useEffect(() => {
    if (!dashboard || dashboard.tiles.length === 0) return;
    const timer = window.setTimeout(() => void refresh(undefined, false), 0);
    return () => window.clearTimeout(timer);
  // Refresh once per dashboard open; the server deduplicates the five-minute window.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardId]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh(undefined, false);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(undefined, false);
    }, 300_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.clearInterval(timer);
    };
  }, [refresh]);

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
        body: JSON.stringify({ layouts: body, expectedRevision: revisionRef.current }),
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Layout could not be saved.");
      await loadDashboard();
    }
  }, [applyDashboard, dashboard, loadDashboard]);

  const mutateTile = useCallback(async (
    tileId: string,
    method: "PATCH" | "DELETE",
    values: Record<string, unknown>,
  ) => {
    try {
      applyDashboard(await dashboardRequest(`/api/dashboard/tiles/${tileId}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, expectedRevision: revisionRef.current }),
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Tile could not be changed.");
      await loadDashboard();
    }
  }, [applyDashboard, loadDashboard]);

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

  if (loading && !dashboard) return <div className={styles.state}>Loading your dashboard…</div>;
  if (!dashboard) return <div className={styles.state}><p>{error ?? "Dashboard unavailable."}</p><button type="button" onClick={() => void loadDashboard()}>Retry</button></div>;

  return (
    <div className={styles.workspace}>
      <div className={styles.toolbar}>
        <div>
          <p>Your pinned governed tables refresh while this page is open.</p>
          {error ? <span className={styles.errorNotice} role="status">{error}</span> : null}
        </div>
        <button className={styles.refreshAll} type="button" disabled={refreshing || dashboard.tiles.length === 0} onClick={() => void refresh(undefined, true)}>
          {icon(<><path d="M20 7v5h-5" /><path d="M18.5 16a8 8 0 1 1 .5-9l1 5" /></>)}
          {refreshing ? "Refreshing" : "Refresh all"}
        </button>
      </div>
      <span className={styles.srOnly} aria-live="polite">{announcement}</span>
      {dashboard.tiles.length === 0 ? (
        <div className={styles.emptyState}>
          <span>{icon(<><rect x="3.5" y="4" width="17" height="16" rx="2.5" /><path d="M3.5 10h17M10 10v10" /></>)}</span>
          <h2>Pin your first governed table</h2>
          <p>Open an analysis and use the + action on an eligible table. Charts, text, and unlinked historical results stay in chat.</p>
        </div>
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
              resizeConfig={{ enabled: breakpoint !== "mobile", handles: ["se"] }}
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
                      breakpoint={breakpoint}
                      titleDraft={titleDrafts[tile.tileId] ?? tile.title}
                      onTitleDraftChange={(value) => setTitleDrafts((current) => ({ ...current, [tile.tileId]: value }))}
                      onTitleCommit={() => {
                        const title = titleDrafts[tile.tileId]?.trim();
                        if (title && title !== tile.title) void mutateTile(tile.tileId, "PATCH", { title });
                        else setTitleDrafts((current) => ({ ...current, [tile.tileId]: tile.title }));
                      }}
                      onMoveKeyboard={(event) => moveWithKeyboard(tile.tileId, event)}
                      onOpenSource={() => onOpenSource(tile.source.conversationId)}
                      onRefresh={() => void refresh([tile.tileId], true)}
                      onRemove={() => void mutateTile(tile.tileId, "DELETE", {})}
                      onColumnPresentationChange={(columnPresentation) => {
                        void mutateTile(tile.tileId, "PATCH", { columnPresentation });
                      }}
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
