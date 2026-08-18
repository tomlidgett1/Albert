import { createHash } from "node:crypto";

import type {
  TraceCell,
  TraceDerivedCellExpression,
  TraceDerivedNumericOperand,
  TraceDerivedSourceCell,
  TraceTableColumn,
  TraceTableDerivationV1,
} from "../../../shared/src/index.js";

export type DerivedTableSource = Readonly<{
  resultId: string;
  columns: readonly TraceTableColumn[];
  rows: readonly Readonly<Record<string, TraceCell>>[];
}>;

export type MaterializedDerivedTable = Readonly<{
  columns: readonly TraceTableColumn[];
  rows: readonly Readonly<Record<string, TraceCell>>[];
}>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}

export function derivedTableDigest(derivation: TraceTableDerivationV1): string {
  return createHash("sha256").update(canonicalJson(derivation)).digest("hex");
}

function sourceCell(
  reference: TraceDerivedSourceCell,
  sources: ReadonlyMap<string, DerivedTableSource>,
): TraceCell {
  const source = sources.get(reference.sourceResultId);
  if (!source) throw new Error(`Unknown derived-table source ${reference.sourceResultId}.`);
  if (!source.columns.some((column) => column.key === reference.columnKey)) {
    throw new Error(`Unknown derived-table source column ${reference.columnKey}.`);
  }
  let row: Readonly<Record<string, TraceCell>> | undefined;
  if (reference.kind === "source") {
    row = source.rows[reference.rowIndex];
    if (!row) throw new Error(`Derived-table source row ${reference.rowIndex} is unavailable.`);
  } else {
    if (!source.columns.some((column) => column.key === reference.matchColumnKey)) {
      throw new Error(`Unknown derived-table match column ${reference.matchColumnKey}.`);
    }
    const expected = sourceCell(reference.matchValue, sources);
    row = source.rows.find((candidate) => {
      const actual = candidate[reference.matchColumnKey] ?? null;
      return actual === expected || (actual !== null && expected !== null && String(actual) === String(expected));
    });
    if (!row) throw new Error(`No derived-table source row matches ${reference.matchColumnKey}.`);
  }
  return row[reference.columnKey] ?? null;
}

function numericOperand(
  operand: TraceDerivedNumericOperand,
  sources: ReadonlyMap<string, DerivedTableSource>,
): number | null {
  const value = operand.kind === "number" ? operand.value : sourceCell(operand, sources);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value.replaceAll(",", "").replace(/^\$/u, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function expressionValue(
  expression: TraceDerivedCellExpression,
  sources: ReadonlyMap<string, DerivedTableSource>,
): TraceCell {
  if (expression.kind === "literal") return expression.value;
  if (expression.kind === "source" || expression.kind === "matched_source") {
    return sourceCell(expression, sources);
  }
  const left = numericOperand(expression.left, sources);
  const right = numericOperand(expression.right, sources);
  if (left === null || right === null) return null;
  switch (expression.operator) {
    case "add": return left + right;
    case "subtract": return left - right;
    case "multiply": return left * right;
    case "divide": return right === 0 ? null : left / right;
    // 0-100 scale, matching Cube percent measures and the percent column type.
    case "percent_change": return right === 0 ? null : ((left - right) / right) * 100;
    case "percent_of": return right === 0 ? null : (left / right) * 100;
  }
}

function labelValue(
  reference: TraceDerivedSourceCell,
  sources: ReadonlyMap<string, DerivedTableSource>,
  timezone: string,
): string {
  const value = sourceCell(reference, sources);
  if (value === null) return "No value";
  const source = sources.get(reference.sourceResultId);
  const column = source?.columns.find((candidate) => candidate.key === reference.columnKey);
  if ((column?.type === "date" || column?.type === "datetime") && typeof value === "string") {
    const instant = new Date(value.endsWith("Z") || /[+-]\d{2}:?\d{2}$/u.test(value) ? value : `${value}Z`);
    if (Number.isFinite(instant.getTime())) {
      return new Intl.DateTimeFormat("en-AU", {
        timeZone: timezone,
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(instant);
    }
  }
  return String(value).slice(0, 160);
}

export function materializeDerivedTable(
  derivation: TraceTableDerivationV1,
  sourceList: readonly DerivedTableSource[],
  timezone: string,
): MaterializedDerivedTable {
  if (derivation.version !== "derived_table_v1") {
    throw new Error("Unsupported derived-table transform version.");
  }
  if (derivation.columns.length < 1 || derivation.columns.length > 80) {
    throw new Error("A derived table must have between 1 and 80 columns.");
  }
  if (derivation.rows.length > 50) throw new Error("A derived table supports at most 50 rows.");

  const sources = new Map(sourceList.map((source) => [source.resultId, source]));
  const declaredSources = new Set(derivation.sources.map((source) => source.resultId));
  if (declaredSources.size !== derivation.sources.length || declaredSources.size !== sources.size) {
    throw new Error("Derived-table sources must be unique and complete.");
  }
  for (const resultId of sources.keys()) {
    if (!declaredSources.has(resultId)) throw new Error(`Undeclared derived-table source ${resultId}.`);
  }

  const columnKeys = derivation.columns.map((column) => column.key);
  if (new Set(columnKeys).size !== columnKeys.length) {
    throw new Error("Derived-table column keys must be unique.");
  }
  const columns = derivation.columns.map(({ labelSource, ...column }) => ({
    ...column,
    ...(labelSource ? { label: labelValue(labelSource, sources, timezone) } : {}),
  }));
  const rows = derivation.rows.map((row) => {
    if (row.cells.length !== columnKeys.length) {
      throw new Error("Every derived-table row must define every column exactly once.");
    }
    const cells = new Map(row.cells.map((entry) => [entry.columnKey, entry.expression]));
    if (cells.size !== columnKeys.length || [...cells.keys()].some((key) => !columnKeys.includes(key))) {
      throw new Error("A derived-table row contains duplicate or unknown columns.");
    }
    return Object.fromEntries(columnKeys.map((key) => {
      const expression = cells.get(key);
      if (!expression) throw new Error(`Derived-table column ${key} has no expression.`);
      return [key, expressionValue(expression, sources)];
    }));
  });
  return { columns, rows };
}
