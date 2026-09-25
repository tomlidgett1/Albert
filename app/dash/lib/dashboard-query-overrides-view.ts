/**
 * Element query overrides on the client (ADR 0134). The server re-runs the
 * governed query with the owner's sort, filters and limit on the next
 * refresh; until that snapshot lands, the same overrides are applied here
 * to the rows already on screen so a sort or a filter feels instant, the
 * way it does in Sigma. Applying them again to a refreshed snapshot is a
 * no-op, so the tile never flips between two truths.
 */

import type { TraceTableColumn } from "@/packages/shared/src";
import type {
  DashboardQueryFilter,
  DashboardQueryOrder,
  DashboardQueryOverrides,
} from "@/services/control-plane/src/dashboard-repository";
import { resolveDashboardColumn } from "../components/dashboard-values";

export type DashboardFilterKind = "list" | "text" | "number" | "date";

const NUMERIC_TYPES = new Set(["number", "currency", "percent"]);
const DATE_TYPES = new Set(["date", "datetime"]);

/** Sigma's default filter type per data type: list for text, range for numbers and dates. */
export function filterKindForColumn(column: Pick<TraceTableColumn, "type">): DashboardFilterKind {
  if (NUMERIC_TYPES.has(column.type)) return "number";
  if (DATE_TYPES.has(column.type)) return "date";
  return "list";
}

export function columnIsNumeric(column: Pick<TraceTableColumn, "type">): boolean {
  return NUMERIC_TYPES.has(column.type);
}

export function columnIsDate(column: Pick<TraceTableColumn, "type">): boolean {
  return DATE_TYPES.has(column.type);
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(/[,\s]/gu, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asTime(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function compareValues(left: unknown, right: unknown, column: TraceTableColumn): number {
  const leftNull = left === null || left === undefined || left === "";
  const rightNull = right === null || right === undefined || right === "";
  if (leftNull && rightNull) return 0;
  if (leftNull) return 1;
  if (rightNull) return -1;
  if (NUMERIC_TYPES.has(column.type)) {
    const a = asNumber(left);
    const b = asNumber(right);
    if (a !== null && b !== null) return a - b;
  }
  if (DATE_TYPES.has(column.type)) {
    const a = asTime(left);
    const b = asTime(right);
    if (a !== null && b !== null) return a - b;
  }
  return asText(left).localeCompare(asText(right), "en", { numeric: true, sensitivity: "base" });
}

function dayStart(value: string): number | null {
  const time = Date.parse(value.length <= 10 ? `${value}T00:00:00` : value);
  return Number.isFinite(time) ? time : null;
}

function dayEnd(value: string): number | null {
  const start = dayStart(value);
  return start === null ? null : value.length <= 10 ? start + 86_400_000 - 1 : start;
}

function matchesFilter(value: unknown, filter: DashboardQueryFilter, column: TraceTableColumn): boolean {
  const empty = value === null || value === undefined || value === "";
  const values = filter.values.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  switch (filter.operator) {
    case "set": return !empty;
    case "notSet": return empty;
    case "equals":
    case "notEquals": {
      const hit = NUMERIC_TYPES.has(column.type)
        ? values.some((entry) => asNumber(entry) !== null && asNumber(entry) === asNumber(value))
        : values.some((entry) => entry.localeCompare(asText(value), "en", { sensitivity: "base" }) === 0);
      return filter.operator === "equals" ? hit : !hit;
    }
    case "contains":
    case "notContains": {
      const text = asText(value).toLocaleLowerCase("en");
      const hit = values.some((entry) => text.includes(entry.toLocaleLowerCase("en")));
      return filter.operator === "contains" ? hit : !hit;
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const bound = values[0];
      if (bound === undefined) return true;
      const numeric = NUMERIC_TYPES.has(column.type) || asNumber(bound) !== null;
      const left = numeric ? asNumber(value) : asTime(value);
      const right = numeric ? asNumber(bound) : asTime(bound);
      if (left === null || right === null) return false;
      if (filter.operator === "gt") return left > right;
      if (filter.operator === "gte") return left >= right;
      if (filter.operator === "lt") return left < right;
      return left <= right;
    }
    case "inDateRange":
    case "notInDateRange": {
      const [from, to] = values;
      const time = asTime(value);
      const start = from ? dayStart(from) : null;
      const end = to ? dayEnd(to) : null;
      if (time === null) return filter.operator === "notInDateRange";
      const inside = (start === null || time >= start) && (end === null || time <= end);
      return filter.operator === "inDateRange" ? inside : !inside;
    }
    case "beforeDate": {
      const time = asTime(value);
      const bound = values[0] ? dayStart(values[0]) : null;
      return time !== null && bound !== null && time < bound;
    }
    case "afterDate": {
      const time = asTime(value);
      const bound = values[0] ? dayEnd(values[0]) : null;
      return time !== null && bound !== null && time > bound;
    }
    default:
      return true;
  }
}

/**
 * The rows a tile shows: the snapshot narrowed by every filter, ordered by
 * the owner's sort, cut to the limit. Columns that no longer exist are
 * ignored so a stale override can never blank a tile.
 */
export function applyOverridesToRows<Row extends Readonly<Record<string, unknown>>>(
  columns: readonly TraceTableColumn[],
  rows: readonly Row[],
  overrides: DashboardQueryOverrides | undefined,
): readonly Row[] {
  if (!overrides) return rows;
  let next: readonly Row[] = rows;
  for (const filter of overrides.filters ?? []) {
    const column = resolveDashboardColumn(columns, filter.column);
    if (!column) continue;
    next = next.filter((row) => matchesFilter(row[column.key], filter, column));
  }
  const order = (overrides.order ?? []).flatMap((entry) => {
    const column = resolveDashboardColumn(columns, entry.column);
    return column ? [{ column, direction: entry.direction }] : [];
  });
  if (order.length > 0) {
    next = [...next]
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        for (const { column, direction } of order) {
          const delta = compareValues(left.row[column.key], right.row[column.key], column);
          if (delta !== 0) return direction === "asc" ? delta : -delta;
        }
        return left.index - right.index;
      })
      .map(({ row }) => row);
  }
  if (overrides.limit !== undefined) next = next.slice(0, overrides.limit);
  return next;
}

/** The active sort on a column, if any. */
export function sortDirectionFor(
  overrides: DashboardQueryOverrides | undefined,
  columns: readonly TraceTableColumn[],
  columnKey: string,
): DashboardQueryOrder["direction"] | null {
  for (const entry of overrides?.order ?? []) {
    const column = resolveDashboardColumn(columns, entry.column);
    if (column?.key === columnKey) return entry.direction;
  }
  return null;
}

/** A new override set with the column sorted one way (a single-column sort, like Sigma's header menu). */
export function withSort(
  overrides: DashboardQueryOverrides | undefined,
  columnKey: string,
  direction: DashboardQueryOrder["direction"] | null,
): DashboardQueryOverrides {
  const rest: DashboardQueryOverrides = { ...(overrides ?? {}) };
  delete rest.order;
  return direction ? { ...rest, order: [{ column: columnKey, direction }] } : rest;
}

export function withFilter(
  overrides: DashboardQueryOverrides | undefined,
  filter: DashboardQueryFilter,
  replaceIndex?: number,
): DashboardQueryOverrides {
  const filters = [...(overrides?.filters ?? [])];
  if (replaceIndex !== undefined && replaceIndex >= 0 && replaceIndex < filters.length) {
    filters[replaceIndex] = filter;
  } else {
    filters.push(filter);
  }
  return { ...(overrides ?? {}), filters: filters.slice(0, 8) };
}

export function withoutFilter(
  overrides: DashboardQueryOverrides | undefined,
  index: number,
): DashboardQueryOverrides {
  const filters = (overrides?.filters ?? []).filter((_entry, position) => position !== index);
  const rest: DashboardQueryOverrides = { ...(overrides ?? {}) };
  delete rest.filters;
  return filters.length > 0 ? { ...rest, filters } : rest;
}

const OPERATOR_WORDS: Readonly<Record<DashboardQueryFilter["operator"], string>> = Object.freeze({
  equals: "is",
  notEquals: "is not",
  contains: "contains",
  notContains: "does not contain",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  set: "is set",
  notSet: "is empty",
  inDateRange: "between",
  notInDateRange: "not between",
  beforeDate: "before",
  afterDate: "after",
});

/** "Product is Gravel bike hire, Road bike hire" — the chip a filter shows. */
export function describeFilter(filter: DashboardQueryFilter, column: Pick<TraceTableColumn, "label"> | null): string {
  const label = column?.label ?? filter.column;
  const word = OPERATOR_WORDS[filter.operator];
  const values = filter.values.map((value) => value.trim()).filter((value) => value.length > 0);
  if (filter.operator === "set" || filter.operator === "notSet") return `${label} ${word}`;
  if (filter.operator === "inDateRange" || filter.operator === "notInDateRange") {
    const [from, to] = values;
    return `${label} ${word} ${from ?? "…"} and ${to ?? "…"}`;
  }
  const shown = values.slice(0, 3).join(", ") + (values.length > 3 ? ` +${values.length - 3}` : "");
  return `${label} ${word} ${shown}`;
}

/** Distinct values of a column in the snapshot, in first-seen order, for a list filter's checklist. */
export function distinctColumnValues(
  rows: readonly Readonly<Record<string, unknown>>[],
  columnKey: string,
  limit = 50,
): readonly string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = row[columnKey];
    if (value === null || value === undefined || value === "") continue;
    seen.add(String(value));
    if (seen.size >= limit) break;
  }
  return [...seen];
}
