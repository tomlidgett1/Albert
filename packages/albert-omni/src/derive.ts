import { createHash } from "node:crypto";
import type {
  TraceCell,
  TraceProvenance,
  TraceTableColumn,
} from "../../shared/src/index.js";
import type { PivotSourceResult } from "./pivot.js";

/**
 * DeriveResult: the governed arithmetic the analyst prompt forbids the model
 * to do by hand. Three operations over results executed this turn — join two
 * results on a label (inner, left, or anti for "in A but not in B"),
 * aggregate one result by a column (sum / avg / min / max / count), and
 * compute ratio / difference / percent-of / sum columns from two numeric
 * columns. Every output is a new result with its own provenance, so its
 * cells are citable evidence exactly like a query's; nothing here reads
 * anything but the rows the turn already holds.
 */

const NUMERIC_COLUMN_TYPES = new Set(["number", "currency", "percent"]);
export const MAX_DERIVED_ROWS = 500;
const MAX_JOIN_INPUT_ROWS = 2_000;

export type DeriveJoinMode = "inner" | "left" | "anti";
export type DeriveAggregateFn = "sum" | "avg" | "min" | "max" | "count";
export type DeriveExpressionKind = "ratio" | "difference" | "percent_of" | "sum";

export type DeriveInput = Readonly<{
  caption: string;
  operation: "join" | "aggregate" | "compute";
  resultId: string;
  secondResultId: string | null;
  leftKey: string | null;
  rightKey: string | null;
  joinMode: DeriveJoinMode | null;
  includeColumns: readonly string[] | null;
  groupBy: string | null;
  metrics: readonly Readonly<{ valueKey: string; fn: DeriveAggregateFn; label: string }>[] | null;
  expressions: readonly Readonly<{ label: string; kind: DeriveExpressionKind; leftKey: string; rightKey: string }>[] | null;
}>;

export type DerivedResult = Readonly<{
  columns: readonly TraceTableColumn[];
  rows: readonly Readonly<Record<string, TraceCell>>[];
  provenance: TraceProvenance;
  notes: readonly string[];
  /** Human-readable recipe shown in the trail. */
  recipe: string;
}>;

export type DeriveOutcome =
  | Readonly<{ ok: true; result: DerivedResult }>
  | Readonly<{ ok: false; error: string; guidance: string }>;

function toNumber(cell: TraceCell | undefined): number | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : null;
  const parsed = Number(String(cell).replace(/,/gu, "").trim());
  return Number.isFinite(parsed) && String(cell).trim() !== "" ? parsed : null;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Exact-label alignment, case- and whitespace-insensitive, as codex derive_result does. */
function labelKey(cell: TraceCell | undefined): string | null {
  if (cell === null || cell === undefined) return null;
  const text = String(cell).trim().toLocaleLowerCase("en-AU");
  return text === "" ? null : text;
}

function columnKey(label: string, taken: Set<string>): string {
  let slug = label
    .toLocaleLowerCase("en-AU")
    .replace(/[^a-z0-9_]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 40);
  if (!/^[a-z_]/u.test(slug)) slug = `d_${slug}`;
  if (!slug) slug = "d_column";
  let candidate = slug;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${slug}_${suffix}`;
    suffix += 1;
  }
  taken.add(candidate);
  return candidate;
}

function failure(error: string, guidance: string): DeriveOutcome {
  return { ok: false, error, guidance };
}

function requireColumn(
  source: PivotSourceResult,
  key: string | null,
  role: string,
  numeric: boolean,
): TraceTableColumn | DeriveOutcome {
  if (!key) return failure(`${role} is required.`, `Columns of ${source.resultId}: ${source.columns.map((column) => column.key).join(", ")}.`);
  const column = source.columns.find((candidate) => candidate.key === key);
  if (!column) return failure(`${role} "${key}" is not a column of ${source.resultId}.`, `Columns: ${source.columns.map((candidate) => candidate.key).join(", ")}.`);
  if (numeric && !NUMERIC_COLUMN_TYPES.has(column.type)) {
    return failure(`${role} "${key}" is ${column.type}; a numeric column is required.`, "Pick a measure column.");
  }
  return column;
}

function isOutcome(value: TraceTableColumn | DeriveOutcome): value is DeriveOutcome {
  return "ok" in value;
}

function mergedProvenance(
  input: DeriveInput,
  primary: PivotSourceResult,
  others: readonly PivotSourceResult[],
  calculations: readonly Readonly<{ column: string; formula: string }>[],
  definitions: TraceProvenance["definitions"],
): TraceProvenance {
  const sources: TraceProvenance["sources"][number][] = [];
  const seen = new Set<string>();
  for (const result of [primary, ...others]) {
    for (const source of result.provenance.sources) {
      const key = `${source.connector}:${source.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push(source);
    }
  }
  return {
    sources,
    timeRange: primary.provenance.timeRange,
    definitions,
    semanticBundleHash: `albert-omni-derive-${createHash("sha256")
      .update(JSON.stringify({ input, sources: [primary.resultId, ...others.map((other) => other.resultId)] }))
      .digest("hex")
      .slice(0, 20)}`,
    identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
    calculations,
  };
}

function deriveJoin(input: DeriveInput, sources: ReadonlyMap<string, PivotSourceResult>): DeriveOutcome {
  const left = sources.get(input.resultId)!;
  if (!input.secondResultId) return failure("secondResultId is required for a join.", "Pass the result to match against.");
  const right = sources.get(input.secondResultId);
  if (!right) return failure(`Unknown secondResultId ${input.secondResultId}.`, `Available: ${[...sources.keys()].join(", ")}.`);
  const mode = input.joinMode ?? "inner";
  const leftColumn = requireColumn(left, input.leftKey, "leftKey", false);
  if (isOutcome(leftColumn)) return leftColumn;
  const rightColumn = requireColumn(right, input.rightKey ?? input.leftKey, "rightKey", false);
  if (isOutcome(rightColumn)) return rightColumn;
  if (left.rows.length > MAX_JOIN_INPUT_ROWS || right.rows.length > MAX_JOIN_INPUT_ROWS) {
    return failure("A join input is too large.", `Each side must have at most ${MAX_JOIN_INPUT_ROWS} rows; add filters or a limit.`);
  }

  const rightRows = new Map<string, Readonly<Record<string, TraceCell>>>();
  let duplicateRight = 0;
  for (const row of right.rows) {
    const key = labelKey(row[rightColumn.key]);
    if (key === null) continue;
    if (rightRows.has(key)) duplicateRight += 1;
    else rightRows.set(key, row);
  }
  const bringColumns = mode === "anti"
    ? []
    : (input.includeColumns?.length
      ? input.includeColumns.map((key) => {
        const column = right.columns.find((candidate) => candidate.key === key);
        return column ?? null;
      })
      : right.columns.filter((column) => NUMERIC_COLUMN_TYPES.has(column.type) && column.key !== rightColumn.key));
  if (bringColumns.some((column) => column === null)) {
    return failure("includeColumns names a column the second result does not have.", `Columns of ${right.resultId}: ${right.columns.map((column) => column.key).join(", ")}.`);
  }
  const taken = new Set(left.columns.map((column) => column.key));
  const outputColumns: TraceTableColumn[] = [...left.columns];
  const rightOutput: { source: TraceTableColumn; key: string }[] = [];
  for (const column of bringColumns as TraceTableColumn[]) {
    const key = taken.has(column.key) ? columnKey(`matched_${column.key}`, taken) : (taken.add(column.key), column.key);
    rightOutput.push({ source: column, key });
    outputColumns.push({ ...column, key, label: taken.has(column.key) && key !== column.key ? `${column.label} (matched)` : column.label });
  }

  const rows: Record<string, TraceCell>[] = [];
  let matched = 0;
  for (const row of left.rows) {
    const key = labelKey(row[leftColumn.key]);
    const match = key === null ? undefined : rightRows.get(key);
    if (match) matched += 1;
    if (mode === "anti") {
      if (!match) rows.push({ ...row });
      continue;
    }
    if (mode === "inner" && !match) continue;
    const out: Record<string, TraceCell> = { ...row };
    for (const { source, key: outKey } of rightOutput) out[outKey] = match ? (match[source.key] ?? null) : null;
    rows.push(out);
  }
  const notes: string[] = [
    `Matched on exact ${leftColumn.label} = ${rightColumn.label} labels (case-insensitive); ${matched} of ${left.rows.length} left rows matched.`,
  ];
  if (duplicateRight > 0) notes.push(`${duplicateRight} right-hand rows shared a label; the first was used.`);
  if (mode === "anti") notes.push(`${rows.length} left rows have no match in the second result.`);
  const recipe = `${mode} join of ${input.resultId} on ${leftColumn.key} with ${input.secondResultId} on ${rightColumn.key}`;
  const provenance = mergedProvenance(input, left, [right], [{ column: mode, formula: recipe }], [
    ...left.provenance.definitions,
    ...right.provenance.definitions,
  ].slice(0, 36));
  return { ok: true, result: { columns: outputColumns, rows: rows.slice(0, MAX_DERIVED_ROWS), provenance, notes, recipe } };
}

function deriveAggregate(input: DeriveInput, sources: ReadonlyMap<string, PivotSourceResult>): DeriveOutcome {
  const source = sources.get(input.resultId)!;
  if (!input.metrics?.length) return failure("metrics are required for an aggregate.", "Pass at least one {valueKey, fn, label}.");
  const groupColumn = input.groupBy ? requireColumn(source, input.groupBy, "groupBy", false) : null;
  if (groupColumn && isOutcome(groupColumn)) return groupColumn;
  const metricColumns: TraceTableColumn[] = [];
  for (const metric of input.metrics) {
    const column = requireColumn(source, metric.valueKey, `metric "${metric.label}" valueKey`, metric.fn !== "count");
    if (isOutcome(column)) return column;
    metricColumns.push(column);
  }
  const groups = new Map<string, { label: TraceCell; values: number[][]; counts: number[] }>();
  for (const row of source.rows) {
    const key = groupColumn ? (labelKey(row[groupColumn.key]) ?? "") : "";
    let group = groups.get(key);
    if (!group) {
      group = { label: groupColumn ? (row[groupColumn.key] ?? null) : "All rows", values: input.metrics.map(() => []), counts: input.metrics.map(() => 0) };
      groups.set(key, group);
    }
    input.metrics.forEach((metric, index) => {
      const value = toNumber(row[metric.valueKey]);
      if (metric.fn === "count") {
        if (row[metric.valueKey] !== null && row[metric.valueKey] !== undefined) group!.counts[index] += 1;
      } else if (value !== null) {
        group!.values[index]!.push(value);
      }
    });
  }
  const taken = new Set<string>();
  const columns: TraceTableColumn[] = [];
  if (groupColumn) {
    taken.add(groupColumn.key);
    columns.push(groupColumn);
  } else {
    columns.push({ key: columnKey("scope", taken), label: "Scope", type: "string" });
  }
  const metricKeys = input.metrics.map((metric, index) => {
    const key = columnKey(metric.label, taken);
    const sourceColumn = metricColumns[index]!;
    columns.push(metric.fn === "count"
      ? { key, label: metric.label, type: "number" }
      : { key, label: metric.label, type: sourceColumn.type, ...(sourceColumn.currency ? { currency: sourceColumn.currency } : {}) });
    return key;
  });
  const rows: Record<string, TraceCell>[] = [];
  for (const group of groups.values()) {
    const row: Record<string, TraceCell> = { [columns[0]!.key]: group.label };
    input.metrics.forEach((metric, index) => {
      const values = group.values[index]!;
      let value: number | null;
      switch (metric.fn) {
        case "sum": value = values.length ? round(values.reduce((a, b) => a + b, 0)) : null; break;
        case "avg": value = values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null; break;
        case "min": value = values.length ? Math.min(...values) : null; break;
        case "max": value = values.length ? Math.max(...values) : null; break;
        default: value = group.counts[index]!;
      }
      row[metricKeys[index]!] = value;
    });
    rows.push(row);
  }
  const recipe = `${input.metrics.map((metric) => `${metric.fn}(${metric.valueKey})`).join(", ")} of ${input.resultId}${groupColumn ? ` by ${groupColumn.key}` : ""}`;
  const calculations = input.metrics.map((metric, index) => ({ column: metricKeys[index]!, formula: `${metric.fn} of ${metric.valueKey} over ${source.rows.length} rows${groupColumn ? ` per ${groupColumn.key}` : ""}` }));
  const provenance = mergedProvenance(input, source, [], calculations, input.metrics.map((metric, index) => ({
    metric: `derive.${metricKeys[index]!}`,
    label: metric.label.slice(0, 160),
    definition: `${metric.fn} of ${metric.valueKey} from ${source.topic}.`,
    view: "derived_result",
    kind: "measure" as const,
  })));
  const notes = [`Aggregated ${source.rows.length} rows of ${source.topic}${source.rows.length >= MAX_DERIVED_ROWS ? " (the source hit its row limit, so this covers only the rows returned)" : ""}.`];
  return { ok: true, result: { columns, rows: rows.slice(0, MAX_DERIVED_ROWS), provenance, notes, recipe } };
}

function deriveCompute(input: DeriveInput, sources: ReadonlyMap<string, PivotSourceResult>): DeriveOutcome {
  const source = sources.get(input.resultId)!;
  if (!input.expressions?.length) return failure("expressions are required for a compute.", "Pass at least one {label, kind, leftKey, rightKey}.");
  const taken = new Set(source.columns.map((column) => column.key));
  const columns: TraceTableColumn[] = [...source.columns];
  const plans: { key: string; kind: DeriveExpressionKind; left: TraceTableColumn; right: TraceTableColumn }[] = [];
  for (const expression of input.expressions) {
    const left = requireColumn(source, expression.leftKey, `"${expression.label}" leftKey`, true);
    if (isOutcome(left)) return left;
    const right = requireColumn(source, expression.rightKey, `"${expression.label}" rightKey`, true);
    if (isOutcome(right)) return right;
    const key = columnKey(expression.label, taken);
    const type: TraceTableColumn["type"] = expression.kind === "percent_of" ? "percent" : expression.kind === "ratio" ? "number" : left.type;
    columns.push({ key, label: expression.label, type, ...(type === left.type && left.currency ? { currency: left.currency } : {}) });
    plans.push({ key, kind: expression.kind, left, right });
  }
  const rows = source.rows.map((row) => {
    const out: Record<string, TraceCell> = { ...row };
    for (const plan of plans) {
      const left = toNumber(row[plan.left.key]);
      const right = toNumber(row[plan.right.key]);
      let value: number | null = null;
      if (left !== null && right !== null) {
        switch (plan.kind) {
          case "ratio": value = right === 0 ? null : round(left / right); break;
          case "percent_of": value = right === 0 ? null : round((left / right) * 100); break;
          case "difference": value = round(left - right); break;
          default: value = round(left + right);
        }
      }
      out[plan.key] = value;
    }
    return out;
  });
  const formula = (plan: (typeof plans)[number]) => plan.kind === "ratio"
    ? `${plan.left.key} ÷ ${plan.right.key}`
    : plan.kind === "percent_of"
      ? `${plan.left.key} ÷ ${plan.right.key} × 100`
      : plan.kind === "difference" ? `${plan.left.key} − ${plan.right.key}` : `${plan.left.key} + ${plan.right.key}`;
  const recipe = plans.map((plan) => `${plan.key} = ${formula(plan)}`).join("; ");
  const provenance = mergedProvenance(input, source, [], plans.map((plan) => ({ column: plan.key, formula: formula(plan) })), [
    ...source.provenance.definitions,
    ...plans.map((plan) => ({
      metric: `derive.${plan.key}`,
      label: plan.key,
      definition: `${formula(plan)} per row of ${source.topic}.`,
      view: "derived_result",
      kind: "measure" as const,
    })),
  ].slice(0, 36));
  const notes = ["Computed per row from the source's own cells; blank where a divisor is zero or a cell is empty."];
  return { ok: true, result: { columns, rows: rows.slice(0, MAX_DERIVED_ROWS), provenance, notes, recipe } };
}

export function deriveResult(
  input: DeriveInput,
  sources: ReadonlyMap<string, PivotSourceResult>,
): DeriveOutcome {
  if (!sources.has(input.resultId)) {
    return failure(`Unknown resultId ${input.resultId}.`, `Derive only over results executed this turn. Available: ${[...sources.keys()].join(", ") || "none yet"}.`);
  }
  switch (input.operation) {
    case "join": return deriveJoin(input, sources);
    case "aggregate": return deriveAggregate(input, sources);
    default: return deriveCompute(input, sources);
  }
}
