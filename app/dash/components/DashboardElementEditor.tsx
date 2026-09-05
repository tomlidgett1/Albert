"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  DashboardColumnPresentation,
  DashboardTile,
  DashboardTileDisplay,
} from "@/services/control-plane/src/dashboard-repository";
import type { DashboardQueryEdit } from "@/services/dashboard/src/query-edits";
import {
  canonicalColumnKey,
  publicColumnKey,
} from "@/packages/albert-v3/src/cube/presentation";
import {
  defaultPivot,
  type PivotField,
} from "@/packages/shared/src/dashboard-pivot";
import {
  pivotConfigForTile,
  pivotSourceForTile,
} from "../lib/dashboard-pivot-view";
import { ElementProperties, type ElementFields } from "./ElementProperties";
import { EditorIcon, PivotEditor } from "./PivotEditor";
import { DashPopover } from "./DashPopover";
import styles from "./element-editor.module.css";

export function DashboardElementEditor({
  tile,
  dashboardId,
  busy,
  modes,
  onClose,
  onDisplayChange,
  onPresentationChange,
  onColumnOrderChange,
  onShowAs,
  onRequery,
}: Readonly<{
  tile: DashboardTile;
  dashboardId: string;
  busy: boolean;
  modes: readonly DashboardTileDisplay["mode"][];
  onClose: () => void;
  onDisplayChange: (display: DashboardTileDisplay) => void;
  onPresentationChange: (presentation: DashboardColumnPresentation) => void;
  onColumnOrderChange: (order: readonly string[]) => void;
  onShowAs: (mode: DashboardTileDisplay["mode"]) => void;
  onRequery: (
    edits: readonly DashboardQueryEdit[],
    display?: DashboardTileDisplay,
  ) => void;
}>) {
  const [fieldsState, setFieldsState] = useState<{
    version: number;
    data: ElementFields | null;
    error: string | null;
  } | null>(null);
  const [typeAnchor, setTypeAnchor] = useState<HTMLElement | null>(null);
  const version = tile.recipeVersion ?? 1;
  useEffect(() => {
    if (tile.replayKind !== "cube_v3") return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `/api/dashboard/tiles/${tile.tileId}/fields?dashboardId=${encodeURIComponent(dashboardId)}`,
          { cache: "no-store", signal: controller.signal },
        );
        const data = (await response.json()) as
          (ElementFields & { error?: string }) | null;
        if (!response.ok || !Array.isArray(data?.members))
          throw new Error(data?.error ?? "The columns could not be loaded.");
        setFieldsState({ version, data: data!, error: null });
      } catch (error) {
        if (!controller.signal.aborted)
          setFieldsState({
            version,
            data: null,
            error:
              error instanceof Error
                ? error.message
                : "The columns could not be loaded.",
          });
      }
    })();
    return () => controller.abort();
  }, [dashboardId, tile.tileId, tile.replayKind, version]);
  const fields = fieldsState?.version === version ? fieldsState.data : null;
  const fieldsError =
    fieldsState?.version === version ? fieldsState.error : null;
  const source = useMemo(() => pivotSourceForTile(tile), [tile]);
  const config = pivotConfigForTile(tile);
  const additionalFields: PivotField[] = (fields?.members ?? [])
    .filter(
      (member) =>
        !source.fields.some(
          (field) =>
            canonicalColumnKey(field.key) === canonicalColumnKey(member.name),
        ),
    )
    .map((member) => ({
      key: publicColumnKey(member.name),
      label: member.shortTitle || member.title,
      type:
        member.type === "time"
          ? "datetime"
          : member.kind === "measure" || member.type === "number"
            ? "number"
            : "string",
    }));
  return (
    <aside
      className={styles.panel}
      role="complementary"
      aria-label={`Element editor for ${tile.title}`}
    >
      <header className={styles.header}>
        <button
          type="button"
          className={styles.headerType}
          aria-label="Change element type"
          aria-haspopup="menu"
          onClick={(event) => setTypeAnchor(event.currentTarget)}
        >
          <EditorIcon name={config ? "pivot" : "table"} />
          <EditorIcon name="caret" />
        </button>
        <span className={styles.headerName}>{tile.title}</span>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Close element editor"
          onClick={onClose}
        >
          <EditorIcon name="close" />
        </button>
      </header>
      {config && tile.display.mode === "table" ? (
        <PivotEditor
          source={source}
          config={config}
          busy={busy}
          sourceName={
            fields?.view.title ??
            (source.composed ? "Combined results" : "Source result")
          }
          onChange={(pivot) =>
            onDisplayChange({ ...tile.display, mode: "table", pivot })
          }
          tableStyle={tile.display.tableStyle}
          onStyleChange={(tableStyle) =>
            onDisplayChange({ ...tile.display, mode: "table", tableStyle })
          }
          additionalFields={additionalFields}
          onAddField={(key, shelf, pivot) => {
            const member = fields?.members.find(
              (member) => publicColumnKey(member.name) === key,
            );
            if (!member) return;
            const edits: DashboardQueryEdit[] = [
              member.kind === "measure"
                ? { op: "add_measure", member: member.name }
                : {
                    op: "add_dimension",
                    member: member.name,
                    ...(member.type === "time"
                      ? { granularity: "month" as const }
                      : {}),
                  },
            ];
            onRequery(edits, { ...tile.display, mode: "table", pivot });
          }}
        />
      ) : (
        <ElementProperties
          tile={tile}
          busy={busy}
          modes={modes}
          fields={fields}
          fieldsError={fieldsError}
          onShowAs={onShowAs}
          onDisplayChange={onDisplayChange}
          onPresentationChange={onPresentationChange}
          onColumnOrderChange={onColumnOrderChange}
          onRequery={onRequery}
        />
      )}
      <DashPopover
        anchor={typeAnchor}
        open={typeAnchor !== null}
        onClose={() => setTypeAnchor(null)}
        role="menu"
        label="Element type"
        width={230}
      >
        <div className={styles.menu}>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={Boolean(config)}
            className={styles.menuItem}
            onClick={() => {
              onDisplayChange({
                mode: "table",
                ...(tile.display.note ? { note: tile.display.note } : {}),
                pivot: config ?? defaultPivot(source),
              });
              setTypeAnchor(null);
            }}
          >
            <EditorIcon name="pivot" />
            Pivot table{config ? <span>✓</span> : null}
          </button>
          {modes.map((mode) => (
            <button
              key={mode}
              type="button"
              role="menuitemradio"
              aria-checked={!config && tile.display.mode === mode}
              className={styles.menuItem}
              onClick={() => {
                if (mode === "table")
                  onDisplayChange({
                    mode: "table",
                    pivot: null,
                    ...(tile.display.note ? { note: tile.display.note } : {}),
                  });
                else onShowAs(mode);
                setTypeAnchor(null);
              }}
            >
              {mode === "table" ? "Table" : mode === "kpi" ? "KPI" : "Chart"}
              {!config && tile.display.mode === mode ? <span>✓</span> : null}
            </button>
          ))}
        </div>
      </DashPopover>
    </aside>
  );
}
