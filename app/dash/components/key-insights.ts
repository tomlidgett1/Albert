import type {
  TraceEvent,
  TraceProvenance,
  TraceTableColumn,
  TraceTableEvent,
} from "@/packages/shared/src";
import { formatTraceCell } from "./analytical-values";

export type KeyInsightTurn = Readonly<{
  id: number;
  events: readonly TraceEvent[];
  streaming: boolean;
}>;

export type KeyInsightValue = Readonly<{
  column: TraceTableColumn;
  value: TraceTableEvent["rows"][number][string];
}>;

export type KeyInsightRow = Readonly<{
  label?: string;
  values: readonly KeyInsightValue[];
}>;

export type KeyInsight = Readonly<{
  id: string;
  title: string;
  rows: readonly KeyInsightRow[];
  sources: TraceProvenance["sources"];
  timeRangeLabel: string;
  resultId: string;
}>;

const numericColumnTypes = new Set<TraceTableColumn["type"]>([
  "number",
  "currency",
  "percent",
]);

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function rowLabel(
  row: TraceTableEvent["rows"][number],
  columns: readonly TraceTableColumn[],
): string | undefined {
  const labels = columns
    .filter((column) => !numericColumnTypes.has(column.type) && hasValue(row[column.key]))
    .slice(0, 2)
    .map((column) => formatTraceCell(row[column.key] ?? null, column));
  return labels.length > 0 ? labels.join(" · ") : undefined;
}

function insightColumnScore(column: TraceTableColumn, title: string): number {
  const description = `${column.key} ${column.label}`.toLowerCase().replace(/[^a-z0-9]+/gu, " ");
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/gu, " ");
  if (/\b(id|identifier|reference|ref)\b/u.test(description)) return -100;

  let score = column.type === "currency" ? 40 : column.type === "percent" ? 35 : 10;
  const priorities: readonly [RegExp, number][] = [
    [/\bgross profit\b/u, 80],
    [/\bmargin\b/u, 72],
    [/\bdiscount/u, 68],
    [/\brefund/u, 66],
    [/\bfee/u, 64],
    [/\bnet (sales|revenue)\b/u, 62],
    [/\b(revenue|sales|takings|tender)\b/u, 58],
    [/\b(cost|cogs)\b/u, 54],
    [/\b(amount|total|value)\b/u, 48],
    [/\b(units|count|transactions|payments)\b/u, 20],
  ];
  for (const [pattern, weight] of priorities) {
    if (pattern.test(description)) score += weight;
  }

  const meaningfulWords = description
    .split(" ")
    .filter((word) => word.length >= 5 && !["analytics", "measure"].includes(word));
  if (meaningfulWords.some((word) => normalizedTitle.includes(word))) score += 18;
  return score;
}

function insightNumericColumns(table: TraceTableEvent): readonly TraceTableColumn[] {
  return table.columns
    .filter((column) => numericColumnTypes.has(column.type))
    .map((column, index) => ({ column, index, score: insightColumnScore(column, table.caption) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ column }) => column);
}

function conciseInsightTitle(title: string): string {
  const cleaned = title.replace(/\s+/gu, " ").trim();
  const topic = cleaned.split(/\s+(?:for|during|over|across|in|with|by|to)\s+/iu, 1)[0] ?? cleaned;
  if (topic.length <= 68) return topic.replace(/[.:;,]+$/u, "");
  const shortened = topic.slice(0, 65).replace(/\s+\S*$/u, "").trim();
  return `${shortened || topic.slice(0, 65)}…`;
}

function selectedRows(table: TraceTableEvent): readonly TraceTableEvent["rows"][number][] {
  const dateColumn = table.columns.find((column) => (
    column.type === "date" || column.type === "datetime"
  ));
  if (!dateColumn || table.rows.length <= 3) return table.rows.slice(0, 3);

  // Time-series evidence is most useful at its most recent edge. Preserve the
  // governed row order and only select from the bounded result already sent.
  return table.rows.slice(-3).reverse();
}

function insightRows(table: TraceTableEvent): readonly KeyInsightRow[] {
  const numericColumns = insightNumericColumns(table);
  const fallbackColumns = table.columns.slice(0, 3);

  return selectedRows(table).map((row) => {
    const populatedNumeric = numericColumns
      .filter((column) => hasValue(row[column.key]))
      .slice(0, table.rows.length === 1 ? 3 : 2);
    const valueColumns = populatedNumeric.length > 0
      ? populatedNumeric
      : fallbackColumns.filter((column) => hasValue(row[column.key])).slice(0, 3);
    return {
      ...(populatedNumeric.length > 0 ? { label: rowLabel(row, table.columns) } : {}),
      values: valueColumns.map((column) => ({
        column,
        value: row[column.key] ?? null,
      })),
    };
  }).filter((row) => row.values.length > 0);
}

/**
 * Build the right-rail evidence feed strictly from governed table payloads.
 * No prose or arithmetic is invented in the browser: every displayed value is
 * an exact cell already present in the immutable trace.
 */
export function deriveKeyInsights(
  turns: readonly KeyInsightTurn[],
  limit = 8,
): readonly KeyInsight[] {
  const seenResults = new Set<string>();
  const insights: KeyInsight[] = [];

  for (const turn of turns) {
    for (const event of turn.events) {
      if (event.type !== "table" || event.rows.length === 0 || seenResults.has(event.resultId)) {
        continue;
      }
      const rows = insightRows(event);
      if (rows.length === 0) continue;
      seenResults.add(event.resultId);
      insights.push({
        id: `${turn.id}:${event.id}`,
        title: conciseInsightTitle(event.caption),
        rows,
        sources: event.provenance.sources.filter((source, index, all) => (
          all.findIndex((candidate) => candidate.connector === source.connector) === index
        )),
        timeRangeLabel: event.provenance.timeRange.label,
        resultId: event.resultId,
      });
    }
  }

  return insights.reverse().slice(0, Math.max(0, limit));
}

export function latestInsightActivity(turns: readonly KeyInsightTurn[]): string | undefined {
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex];
    if (!turn?.streaming) continue;
    for (let eventIndex = turn.events.length - 1; eventIndex >= 0; eventIndex -= 1) {
      const event = turn.events[eventIndex];
      if (event?.type === "progress" && event.label.trim()) return event.label.trim();
    }
  }
  return undefined;
}
