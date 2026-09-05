import type { DashboardTile } from "@/services/control-plane/src/dashboard-repository";
import type { TraceRowFormat } from "@/packages/shared/src";
import {
  defaultPivot,
  PIVOT_PERIOD,
  type DashboardPivot,
  type PivotField,
  type PivotSource,
} from "@/packages/shared/src/dashboard-pivot";

type PivotMetadata = { rowFormats?: readonly (TraceRowFormat | null)[] | null };

export function composedPivotMetadata(
  tile: DashboardTile,
): PivotMetadata | null {
  const provenance = tile.snapshot?.provenance;
  const metadata = provenance?.dashboardPivot;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata))
    return metadata as PivotMetadata;
  // Compatibility with documents served before 0190. A derived join is not a
  // pivot. Only Omni's explicitly named pivot provenance qualifies here.
  const definitions = provenance?.definitions;
  return tile.replayKind === "derived_v1" &&
    tile.snapshot?.columns.some((column) => column.key === "metric") &&
    Array.isArray(definitions) &&
    definitions.some(
      (definition) =>
        typeof definition?.metric === "string" &&
        definition.metric.startsWith("pivot."),
    )
    ? {}
    : null;
}

export function pivotSourceForTile(tile: DashboardTile): PivotSource {
  const snapshot = tile.snapshot;
  const metadata = composedPivotMetadata(tile);
  if (!snapshot)
    return { fields: [], rows: [], totalRowCount: 0, composed: false };
  if (!metadata)
    return {
      fields: snapshot.columns
        .filter((column) => column.key !== "compareDateRange")
        .map((column) => ({
          ...column,
          label: tile.columnPresentation[column.key]?.label ?? column.label,
        })),
      rows: snapshot.rows,
      totalRowCount: snapshot.totalRowCount,
      composed: false,
    };
  return composedPivotSource(snapshot, metadata.rowFormats);
}

/** Live Omni preview and saved elements normalize through the same path. */
export function composedPivotSource(
  snapshot: Readonly<{
    columns: readonly PivotField[];
    rows: readonly Readonly<Record<string, unknown>>[];
  }>,
  rowFormats?: readonly (TraceRowFormat | null)[] | null,
): PivotSource {
  const periods = snapshot.columns.filter((column) => column.key !== "metric");
  const metrics: PivotField[] = snapshot.rows.map((row, index) => {
    const rowFormat = rowFormats?.[index];
    const first = periods[0];
    return {
      key: `__metric_${index}`,
      label: String(row.metric ?? `Metric ${index + 1}`),
      type:
        rowFormat?.type ??
        (first?.type === "currency" || first?.type === "percent"
          ? first.type
          : "number"),
      ...((rowFormat ?? first)?.currency
        ? { currency: (rowFormat ?? first)?.currency }
        : {}),
      ...((rowFormat ?? first)?.percentScale
        ? { percentScale: (rowFormat ?? first)?.percentScale }
        : {}),
    };
  });
  return {
    fields: [
      { key: PIVOT_PERIOD, label: "Period", type: "string" },
      ...metrics,
    ],
    rows: periods.map((period) =>
      Object.fromEntries([
        [PIVOT_PERIOD, period.label],
        ...snapshot.rows.map((row, index) => [
          `__metric_${index}`,
          row[period.key],
        ]),
      ]),
    ),
    totalRowCount: periods.length,
    composed: true,
  };
}

export function pivotConfigForTile(tile: DashboardTile): DashboardPivot | null {
  if (tile.display.mode !== "table") return null;
  if (tile.display.pivot !== undefined) return tile.display.pivot;
  return composedPivotMetadata(tile)
    ? defaultPivot(pivotSourceForTile(tile))
    : null;
}
