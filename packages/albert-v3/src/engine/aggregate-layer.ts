/**
 * aggregate_result: a deterministic re-aggregation of a governed result.
 *
 * Semantic layers expose the time buckets they were modelled with; questions
 * about the *shape* of time — "sales by day of the week", "what hour are we
 * busiest", "which day of the month do bills fall due" — need a bucket the
 * view may not have. Without this tool the model either runs one filtered
 * query per weekday (seven queries, and Cube's date filters cannot express
 * "every Saturday") or gives up. With it, one governed query at the finest
 * useful grain (day, hour) plus one deterministic engine-side group-by answers
 * the question, and the derived table is chartable and composable like any
 * other evidence.
 *
 * Connector-agnostic: it works on any result table (any view, any tool) and
 * only reads column values. Date parts are taken from the bucket strings the
 * semantic layer already returned in the tenant timezone, so no timezone
 * arithmetic happens here.
 */
import { tool, type Tool } from "@openai/agents";
import { z } from "zod";
import { ulid } from "ulid";
import { sanitizeTraceText, type TraceCell, type TraceProvenance, type TraceTableColumn } from "../../../shared/src/index.js";
import type { StoredTableResult, V3TurnContext } from "./context.js";
import { resolveTableResult } from "./prior-results.js";

export const aggregateInputSchema = z.object({
  resultId: z.string().min(1).max(64),
  caption: z.string().trim().min(3).max(160),
  /** Column to group on. */
  groupColumn: z.string().min(1).max(160),
  /** value = the column's own values; the date parts apply to a date/datetime column. */
  groupPart: z.enum(["value", "weekday", "hour", "month", "day_of_month", "week", "date"]),
  /** Numeric column keys to aggregate (each keeps its key in the derived table). */
  measures: z.array(z.string().min(1).max(160)).min(1).max(8),
  aggregate: z.enum(["sum", "avg", "min", "max", "count"]),
  /** group = natural order of the group (Mon→Sun, 00→23, chronological); value = by the first measure. */
  sort: z.enum(["group", "value_desc", "value_asc"]),
  limit: z.number().int().min(1).max(200).nullable(),
  /**
   * Keep only rows whose column (or a date part of it) is one of the values —
   * e.g. filterColumn = the hourly bucket, filterPart = weekday, filterValues =
   * ["Saturday"] keeps Saturday rows before grouping them by hour. null = no filter.
   */
  filterColumn: z.string().min(1).max(160).nullable(),
  filterPart: z.enum(["value", "weekday", "hour", "month", "day_of_month", "week", "date"]).nullable(),
  filterValues: z.array(z.string().min(1).max(120)).max(31).nullable(),
}).strict();

export type AggregateInput = z.infer<typeof aggregateInputSchema>;

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/u;

type Bucket = { key: string; label: string; order: number };

/** Parse a bucket string the semantic layer returned ("2026-05-09T00:00:00.000") without timezone shifts. */
export function dateBucket(value: TraceCell, part: AggregateInput["groupPart"]): Bucket | undefined {
  if (part === "value") {
    if (value === null || value === undefined) return { key: "(blank)", label: "(blank)", order: Number.MAX_SAFE_INTEGER };
    const label = String(value);
    return { key: label, label, order: 0 };
  }
  if (typeof value !== "string") return undefined;
  const match = DATE_RE.exec(value);
  if (!match) return undefined;
  const [, y, m, d, hh] = match;
  const year = Number(y); const month = Number(m); const day = Number(d); const hour = Number(hh ?? "0");
  const utc = new Date(Date.UTC(year, month - 1, day, hour));
  if (Number.isNaN(utc.getTime())) return undefined;
  switch (part) {
    case "weekday": {
      const index = (utc.getUTCDay() + 6) % 7; // Monday = 0
      return { key: WEEKDAYS[index]!, label: WEEKDAYS[index]!, order: index };
    }
    case "hour": {
      if (hh === undefined) return undefined;
      const label = `${String(hour).padStart(2, "0")}:00`;
      return { key: label, label, order: hour };
    }
    case "month": {
      const label = `${y}-${m}`;
      return { key: label, label, order: year * 12 + month };
    }
    case "day_of_month":
      return { key: String(day), label: String(day), order: day };
    case "week": {
      // Monday of the week, as a date.
      const monday = new Date(utc.getTime() - ((utc.getUTCDay() + 6) % 7) * 86_400_000);
      const label = monday.toISOString().slice(0, 10);
      return { key: label, label, order: monday.getTime() };
    }
    case "date": {
      const label = `${y}-${m}-${d}`;
      return { key: label, label, order: utc.getTime() };
    }
    default:
      return undefined;
  }
}

function toNumber(value: TraceCell | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number(String(value).replace(/,/gu, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function aggregateRows(
  table: Pick<StoredTableResult, "rows" | "allRows" | "columns">,
  input: Pick<AggregateInput, "groupColumn" | "groupPart" | "measures" | "aggregate" | "sort" | "limit"> & Partial<Pick<AggregateInput, "filterColumn" | "filterPart" | "filterValues">>,
): { columns: TraceTableColumn[]; rows: Record<string, TraceCell>[]; skipped: number; kept: number } {
  let source = table.allRows ?? table.rows;
  if (input.filterColumn && input.filterValues && input.filterValues.length > 0) {
    const wanted = new Set(input.filterValues.map((v) => v.trim().toLowerCase()));
    const part = input.filterPart ?? "value";
    source = source.filter((row) => {
      const bucket = dateBucket(row[input.filterColumn!] ?? null, part);
      return bucket ? wanted.has(bucket.label.toLowerCase()) : false;
    });
  }
  const kept = source.length;
  const groups = new Map<string, { bucket: Bucket; values: Map<string, number[]> }>();
  let skipped = 0;
  for (const row of source) {
    const bucket = dateBucket(row[input.groupColumn] ?? null, input.groupPart);
    if (!bucket) { skipped += 1; continue; }
    let group = groups.get(bucket.key);
    if (!group) {
      group = { bucket, values: new Map(input.measures.map((m) => [m, []])) };
      groups.set(bucket.key, group);
    }
    for (const measure of input.measures) {
      const n = toNumber(row[measure]);
      if (n !== null) group.values.get(measure)!.push(n);
    }
  }
  const fold = (values: number[]): number | null => {
    if (input.aggregate === "count") return values.length;
    if (values.length === 0) return null;
    switch (input.aggregate) {
      case "sum": return round(values.reduce((a, b) => a + b, 0));
      case "avg": return round(values.reduce((a, b) => a + b, 0) / values.length);
      case "min": return Math.min(...values);
      case "max": return Math.max(...values);
      default: return null;
    }
  };
  const groupKey = `group_${input.groupPart === "value" ? "value" : input.groupPart}`;
  let rows = [...groups.values()].map((group) => {
    const out: Record<string, TraceCell> = { [groupKey]: group.bucket.label };
    for (const measure of input.measures) out[measure] = fold(group.values.get(measure)!);
    return { row: out, order: group.bucket.order, label: group.bucket.label };
  });
  const first = input.measures[0]!;
  if (input.sort === "group") rows.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  else rows.sort((a, b) => {
    const av = toNumber(a.row[first]) ?? Number.NEGATIVE_INFINITY;
    const bv = toNumber(b.row[first]) ?? Number.NEGATIVE_INFINITY;
    return input.sort === "value_desc" ? bv - av : av - bv;
  });
  if (input.limit) rows = rows.slice(0, input.limit);
  const groupLabel = { value: "Group", weekday: "Weekday", hour: "Hour of day", month: "Month", day_of_month: "Day of month", week: "Week starting", date: "Date" }[input.groupPart];
  const columns: TraceTableColumn[] = [
    { key: groupKey, label: groupLabel, type: "string" },
    ...input.measures.map((measure) => {
      const sourceColumn = table.columns.find((c) => c.key === measure);
      const label = sourceColumn?.label ?? measure;
      const prefix = { sum: "", avg: "Average ", min: "Lowest ", max: "Highest ", count: "Count of " }[input.aggregate];
      return {
        key: measure,
        label: `${prefix}${label}`.trim(),
        type: input.aggregate === "count" ? "number" as const : (sourceColumn?.type === "currency" || sourceColumn?.type === "number" || sourceColumn?.type === "percent" ? sourceColumn.type : "number" as const),
        ...(input.aggregate !== "count" && sourceColumn?.type === "currency" && sourceColumn.currency ? { currency: sourceColumn.currency } : {}),
      } as TraceTableColumn;
    }),
  ];
  return { columns, rows: rows.map((r) => r.row), skipped, kept };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function derivedProvenance(source: StoredTableResult, description: string): TraceProvenance {
  const { calculations: _calculations, ...rest } = source.provenance;
  return {
    ...rest,
    definitions: [
      ...source.provenance.definitions.slice(0, 20),
      { metric: "albert.aggregate", label: "Re-aggregation", definition: description },
    ],
  };
}

export function createAggregateResultTool(): Tool<V3TurnContext> {
  return tool({
    name: "aggregate_result",
    description:
      "Re-aggregate a governed result deterministically into a new evidence table: group its rows by a column's value or by a date part of a date/datetime column (weekday Mon–Sun, hour of day, month, day of month, week, date) and sum/average/min/max/count numeric columns. "
      + "Use it when the view has no member for the bucket the owner asked about (sales by day of the week from a daily result; busiest hour from an hourly result; bills due by day of month). "
      + "filterColumn/filterPart/filterValues keep only matching rows first (Saturdays by hour: filterPart weekday, filterValues [\"Saturday\"], groupPart hour on the same hourly bucket column; mornings: filterPart hour, filterValues [\"09:00\",\"10:00\",\"11:00\"]). "
      + "Query at the finest useful grain first (granularity day for weekday, hour for hour of day, over the whole window), then aggregate here. The derived table can be charted with make_chart and composed with compose_table like any result.",
    parameters: aggregateInputSchema,
    strict: true,
    execute: async (input, runContext) => {
      const context = runContext?.context as V3TurnContext | undefined;
      if (!context) throw new Error("The Albert v3 tool context is missing.");
      const table = await resolveTableResult(context, input.resultId);
      if (!table) return { ok: false, error: "Unknown resultId. Aggregate an existing result (this turn or a listed earlier result)." };
      const missing = [input.groupColumn, ...input.measures, ...(input.filterColumn ? [input.filterColumn] : [])].filter((k) => !table.columnKeys.includes(k));
      if (missing.length > 0) return { ok: false, error: `Unknown column key ${missing.join(", ")}. Columns must be among: ${table.columnKeys.join(", ")}` };
      const nonNumeric = input.measures.filter((m) => !table.numericColumnKeys.includes(m));
      if (nonNumeric.length > 0 && input.aggregate !== "count") return { ok: false, error: `${nonNumeric.join(", ")} is not numeric; only count works on it.` };
      if (table.rowCount > (table.allRows ?? table.rows).length) {
        return { ok: false, error: `This result has ${table.rowCount} rows but only ${(table.allRows ?? table.rows).length} are held in memory, so the aggregate would be partial. Re-run the query with a smaller window or coarser grain.` };
      }
      const aggregated = aggregateRows(table, input);
      if (aggregated.rows.length === 0) {
        if (input.filterColumn && aggregated.kept === 0) return { ok: false, error: `No rows matched the filter ${input.filterPart ?? "value"} of ${input.filterColumn} in [${(input.filterValues ?? []).join(", ")}] (weekday values are Monday…Sunday, hours are "HH:00").` };
        return { ok: false, error: input.groupPart === "value" ? "No rows to aggregate." : `No value in ${input.groupColumn} parsed as a date${input.groupPart === "hour" ? "time with an hour" : ""}; choose a date/datetime column (a time dimension with granularity).` };
      }
      const resultId = ulid();
      const description = `${input.aggregate} of ${input.measures.join(", ")} by ${input.groupPart === "value" ? input.groupColumn : `${input.groupPart} of ${input.groupColumn}`}${input.filterColumn && input.filterValues?.length ? ` where ${input.filterPart ?? "value"} of ${input.filterColumn} in [${input.filterValues.join(", ")}]` : ""} over ${table.rowCount} rows of "${table.caption}"`;
      const provenance = derivedProvenance(table, description);
      const rows = aggregated.rows.slice(0, 200);
      const tableEvent = await context.emit({
        type: "table",
        status: "complete",
        caption: sanitizeTraceText(input.caption, 160),
        columns: aggregated.columns,
        rows: rows.slice(0, 60),
        resultId,
        provenance,
        presentation: "evidence",
      });
      context.tableResults.set(resultId, {
        tableEventId: tableEvent.id,
        resultId,
        caption: input.caption,
        columns: aggregated.columns,
        rows: rows.slice(0, 60),
        allRows: rows,
        columnKeys: aggregated.columns.map((c) => c.key),
        numericColumnKeys: aggregated.columns.filter((c) => c.type === "number" || c.type === "currency" || c.type === "percent").map((c) => c.key),
        rowCount: rows.length,
        provenance,
        presentation: "evidence",
      });
      return {
        ok: true,
        resultId,
        rowCount: rows.length,
        columns: aggregated.columns.map((c) => `${c.key} (${c.type})`),
        rows: rows.slice(0, 40).map((row) => aggregated.columns.map((c) => row[c.key] ?? null)),
        ...(aggregated.skipped > 0 ? { note: `${aggregated.skipped} rows had no usable ${input.groupColumn} value and were skipped.` } : {}),
        guidance: "Chart this resultId with make_chart (bar for weekday/hour) or compose it with compose_table; quote its figures directly.",
      };
    },
  });
}
