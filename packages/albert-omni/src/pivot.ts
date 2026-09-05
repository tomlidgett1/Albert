import { createHash } from "node:crypto";
import {
  derivedTableDigest,
  materializeDerivedTable,
  type DerivedTableSource,
} from "../../albert-v3/src/engine/derived-table.js";
import type {
  TraceCell,
  TraceDerivedIndexedSourceCell,
  TraceProvenance,
  TraceRowFormat,
  TraceTableColumn,
  TraceTableDerivationV1,
  TraceTableEvent,
  ResultSemantics,
} from "../../shared/src/index.js";

/**
 * ComposePivotTable (dashboard mode's cross-source pivot): metrics as rows,
 * one column per label of a chosen source result — "weeks across the top".
 * The output is a deterministic derived-table transform (derived_table_v1)
 * over governed results executed this turn, so the table is pinnable and its
 * dashboard refresh re-runs the sources and re-applies the exact transform
 * without a model in the loop.
 */

const MAX_PIVOT_COLUMNS = 13;
export const MAX_PIVOT_METRICS = 8;
const NUMERIC_COLUMN_TYPES = new Set(["number", "currency", "percent"]);

export type PivotMetricSpec = Readonly<{
  resultId: string;
  valueKey: string;
  /** Label column in the metric's own result; defaults to the pivot labelKey. */
  labelKey: string | null;
  label: string;
}>;

export type PivotComposeInput = Readonly<{
  caption: string;
  columnsFromResultId: string;
  labelKey: string;
  metrics: readonly PivotMetricSpec[];
}>;

export type PivotSourceResult = Readonly<{
  resultId: string;
  topic: string;
  columns: readonly TraceTableColumn[];
  rows: readonly Readonly<Record<string, TraceCell>>[];
  provenance: TraceProvenance;
  semantics?: ResultSemantics;
  /**
   * Present when this result is itself a replayable derivation (a pivot or a
   * derived join/compute): a derivation built over it folds through to the
   * governed leaf results, so the output can still refresh on a dashboard.
   */
  derivation?: TraceTableDerivationV1;
}>;

export type ComposedPivot = Readonly<{
  derivation: TraceTableDerivationV1;
  columns: readonly TraceTableColumn[];
  rows: readonly Readonly<Record<string, TraceCell>>[];
  rowFormats: readonly (TraceRowFormat | null)[] | null;
  provenance: TraceProvenance;
  notes: readonly string[];
}>;

export type ComposePivotOutcome =
  | Readonly<{ ok: true; pivot: ComposedPivot }>
  | Readonly<{ ok: false; error: string; guidance: string }>;

function pivotColumnKey(label: string, taken: Set<string>): string {
  let slug = label
    .toLocaleLowerCase("en-AU")
    .replace(/[^a-z0-9_.]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 40);
  if (!/^[a-z_]/u.test(slug)) slug = `p_${slug}`;
  if (!slug) slug = "p_column";
  let candidate = slug;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${slug}_${suffix}`;
    suffix += 1;
  }
  taken.add(candidate);
  return candidate;
}

export function composePivotTable(
  input: PivotComposeInput,
  sources: ReadonlyMap<string, PivotSourceResult>,
  timezone: string,
): ComposePivotOutcome {
  const primary = sources.get(input.columnsFromResultId);
  if (!primary) {
    return {
      ok: false,
      error: `Unknown columnsFromResultId ${input.columnsFromResultId}.`,
      guidance: `Pivot only over results executed this turn. Available: ${[...sources.keys()].join(", ") || "none yet"}.`,
    };
  }
  const labelColumn = primary.columns.find((column) => column.key === input.labelKey);
  if (!labelColumn) {
    return {
      ok: false,
      error: `labelKey "${input.labelKey}" is not a column of ${input.columnsFromResultId}.`,
      guidance: `Columns: ${primary.columns.map((column) => column.key).join(", ")}.`,
    };
  }

  // One pivot column per distinct label, in row order. Duplicate labels mean
  // the source has more than one row per bucket — a different query is needed.
  const labels: { rowIndex: number; text: string }[] = [];
  const seenLabels = new Set<string>();
  for (let rowIndex = 0; rowIndex < Math.min(primary.rows.length, 50); rowIndex += 1) {
    const raw = primary.rows[rowIndex]![input.labelKey] ?? null;
    if (raw === null || String(raw).trim() === "") continue;
    const text = String(raw);
    if (seenLabels.has(text)) {
      return {
        ok: false,
        error: `The label "${text.slice(0, 60)}" appears more than once in ${input.columnsFromResultId}.`,
        guidance: "Pivot columns need one row per label. Re-query with a single row per period (no extra dimensions), then pivot.",
      };
    }
    seenLabels.add(text);
    labels.push({ rowIndex, text });
  }
  if (labels.length === 0) {
    return { ok: false, error: "The pivot source has no usable labels.", guidance: "Run the period query first and pivot its result." };
  }
  if (labels.length > MAX_PIVOT_COLUMNS) {
    return {
      ok: false,
      error: `A pivot supports at most ${MAX_PIVOT_COLUMNS} columns (got ${labels.length}).`,
      guidance: "Coarsen the granularity or shorten the window so the periods fit across the top.",
    };
  }

  const metricColumns: TraceTableColumn[] = [];
  const notes: string[] = [];
  for (const metric of input.metrics) {
    const source = sources.get(metric.resultId);
    if (!source) {
      return {
        ok: false,
        error: `Unknown metric resultId ${metric.resultId}.`,
        guidance: "Every metric row must come from a query executed this turn.",
      };
    }
    const valueColumn = source.columns.find((column) => column.key === metric.valueKey);
    if (!valueColumn) {
      return {
        ok: false,
        error: `valueKey "${metric.valueKey}" is not a column of ${metric.resultId}.`,
        guidance: `Columns: ${source.columns.map((column) => column.key).join(", ")}.`,
      };
    }
    if (!NUMERIC_COLUMN_TYPES.has(valueColumn.type)) {
      return {
        ok: false,
        error: `valueKey "${metric.valueKey}" is ${valueColumn.type}; a numeric column is required.`,
        guidance: "Pick the measure column of that result.",
      };
    }
    const matchKey = metric.labelKey ?? input.labelKey;
    if (!source.columns.some((column) => column.key === matchKey)) {
      return {
        ok: false,
        error: `labelKey "${matchKey}" is not a column of ${metric.resultId}.`,
        guidance: "Pass the metric's own period column as labelKey when it differs from the pivot source's.",
      };
    }
    metricColumns.push(valueColumn);
  }

  // Shared unit → typed columns; mixed units → number columns with row formats.
  const uniform = metricColumns.every((column) => (
    column.type === metricColumns[0]!.type && column.currency === metricColumns[0]!.currency && column.percentScale === metricColumns[0]!.percentScale
  ))
    ? metricColumns[0]!
    : null;
  const takenKeys = new Set(["metric"]);
  const periodColumns = labels.map((label) => ({
    key: pivotColumnKey(label.text, takenKeys),
    label: label.text.slice(0, 160),
    type: (uniform?.type ?? "number") as TraceTableColumn["type"],
    ...(uniform?.currency ? { currency: uniform.currency } : {}),
    ...(uniform?.percentScale ? { percentScale: uniform.percentScale } : {}),
    labelSource: {
      kind: "source",
      sourceResultId: input.columnsFromResultId,
      rowIndex: label.rowIndex,
      columnKey: input.labelKey,
    } satisfies TraceDerivedIndexedSourceCell,
  }));

  const orderedSourceIds: string[] = [];
  const includeSource = (resultId: string) => {
    if (!orderedSourceIds.includes(resultId)) orderedSourceIds.push(resultId);
  };
  includeSource(input.columnsFromResultId);
  for (const metric of input.metrics) includeSource(metric.resultId);

  const derivation: TraceTableDerivationV1 = {
    version: "derived_table_v1",
    // tableEventIds are stamped by the web relay, which alone knows the
    // persisted event ids; it recomputes the transform digest after pairing.
    sources: orderedSourceIds.map((resultId) => ({ tableEventId: "", resultId })),
    columns: [
      { key: "metric", label: "Metric", type: "string" },
      ...periodColumns,
    ],
    rows: input.metrics.map((metric) => ({
      cells: [
        { columnKey: "metric", expression: { kind: "literal", value: metric.label.slice(0, 160) } },
        ...periodColumns.map((column) => ({
          columnKey: column.key,
          expression: {
            kind: "matched_source" as const,
            sourceResultId: metric.resultId,
            columnKey: metric.valueKey,
            matchColumnKey: metric.labelKey ?? input.labelKey,
            matchValue: column.labelSource,
          },
        })),
      ],
    })),
  };

  let materialized;
  try {
    materialized = materializeDerivedTable(
      derivation,
      orderedSourceIds.map((resultId) => {
        const source = sources.get(resultId)!;
        return { resultId, columns: source.columns, rows: source.rows } satisfies DerivedTableSource;
      }),
      timezone,
    );
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 300) : "The pivot could not be evaluated.",
      guidance: "Every metric result needs one row per pivot label, with labels matching the pivot source's periods exactly (same granularity and window).",
    };
  }

  const rowFormats = uniform
    ? null
    : input.metrics.map((metric, index) => {
      const column = metricColumns[index]!;
      return NUMERIC_COLUMN_TYPES.has(column.type)
        ? {
          type: column.type as TraceRowFormat["type"],
          ...(column.currency ? { currency: column.currency } : {}),
          ...(column.percentScale ? { percentScale: column.percentScale } : {}),
        }
        : null;
    });
  if (!uniform) notes.push("Rows carry mixed units; each row keeps its own measure's format.");

  const provenanceSources: TraceProvenance["sources"][number][] = [];
  const seenProvenance = new Set<string>();
  for (const resultId of orderedSourceIds) {
    for (const source of sources.get(resultId)!.provenance.sources) {
      const key = `${source.connector}:${source.label}`;
      if (seenProvenance.has(key)) continue;
      seenProvenance.add(key);
      provenanceSources.push(source);
    }
  }
  const provenance: TraceProvenance = {
    sources: provenanceSources,
    timeRange: primary.provenance.timeRange,
    definitions: input.metrics.slice(0, 36).map((metric) => ({
      metric: `pivot.${metric.valueKey}`,
      label: metric.label.slice(0, 160),
      definition: `Pivot row from ${sources.get(metric.resultId)!.topic}.`,
      view: "derived_result",
      kind: "measure",
    })) as TraceProvenance["definitions"],
    semanticBundleHash: `albert-omni-pivot-${createHash("sha256")
      .update(JSON.stringify({ input, sources: orderedSourceIds }))
      .digest("hex")
      .slice(0, 20)}`,
    identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
  };

  return {
    ok: true,
    pivot: {
      derivation,
      columns: materialized.columns,
      rows: materialized.rows,
      rowFormats,
      provenance,
      notes,
    },
  };
}

/**
 * Web-relay pairing for a remotely derived table: fill the source table event
 * ids the runtime cannot know, then recompute the transform digest over the
 * completed derivation. Returns null when any source is unpaired — the caller
 * strips the replay reference (and the derivation) so a broken recipe can
 * never persist.
 */
export function pairDerivedTableEvent(
  event: Readonly<{
    dashboardDerivation?: TraceTableDerivationV1;
    dashboardReplay?: TraceTableEvent["dashboardReplay"];
  }>,
  tableEventIdByResultId: ReadonlyMap<string, string>,
): Readonly<{
  dashboardDerivation: TraceTableDerivationV1;
  dashboardReplay: Extract<NonNullable<TraceTableEvent["dashboardReplay"]>, { kind: "derived_v1" }>;
}> | null {
  const derivation = event.dashboardDerivation;
  if (!derivation || event.dashboardReplay?.kind !== "derived_v1") return null;
  const sourceTableEventIds: string[] = [];
  const sources: { tableEventId: string; resultId: string }[] = [];
  for (const source of derivation.sources) {
    const tableEventId = source.tableEventId || tableEventIdByResultId.get(source.resultId);
    if (!tableEventId) return null;
    sourceTableEventIds.push(tableEventId);
    sources.push({ tableEventId, resultId: source.resultId });
  }
  const paired: TraceTableDerivationV1 = { ...derivation, sources };
  return {
    dashboardDerivation: paired,
    dashboardReplay: {
      kind: "derived_v1",
      sourceTableEventIds,
      transformDigest: derivedTableDigest(paired),
    },
  };
}
