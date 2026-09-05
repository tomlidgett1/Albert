import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { materializeDerivedTable } from "../../albert-v3/src/engine/derived-table.js";
import type {
  TraceCell,
  TraceDerivedCellExpression,
  TraceDerivedSourceCell,
  TraceProvenance,
  TraceTableColumn,
  TraceTableDerivationV1,
  ResultSemantics,
} from "../../shared/src/index.js";
import type { PivotSourceResult } from "./pivot.js";
import { derivedResultSemantics } from "./evidence.js";
import { decimalCell } from "./calculate.js";
const Exact = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

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
/**
 * A dashboard refresh replays each governed source as a 50-row snapshot and
 * applies the sealed transform, so a derivation can only promise to refresh
 * when every leaf result it reads fits that snapshot (ADR 0134).
 */
export const MAX_REPLAY_ROWS = 50;

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
  /** A subset total is permitted only when explicitly requested and labelled. */
  aggregateScope?: "population" | "returned_rows";
}>;

export type DerivedResult = Readonly<{
  columns: readonly TraceTableColumn[];
  rows: readonly Readonly<Record<string, TraceCell>>[];
  provenance: TraceProvenance;
  notes: readonly string[];
  /** Human-readable recipe shown in the trail. */
  recipe: string;
  /**
   * The sealed transform a dashboard refresh replays (joins and computes over
   * governed results that fit the refresh snapshot); null when the result
   * cannot refresh — aggregates, anti-joins, unmatched left rows, or sources
   * beyond the snapshot — and `notes` says why.
   */
  derivation: TraceTableDerivationV1 | null;
  semantics: ResultSemantics;
}>;

export type DeriveOutcome =
  | Readonly<{ ok: true; result: DerivedResult }>
  | Readonly<{ ok: false; error: string; guidance: string }>;

function toNumber(cell: TraceCell | undefined): Decimal | null {
  if (cell === null || cell === undefined) return null;
  try { const parsed = new Exact(String(cell).replace(/,/gu, "").trim()); return parsed.isFinite() ? parsed : null; }
  catch { return null; }
}

/** Identifiers and period keys retain their exact spelling; names are not identities. */
function labelKey(cell: TraceCell | undefined): string | null {
  if (cell === null || cell === undefined) return null;
  const text = String(cell);
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

// ---- Replayable derivations (ADR 0134) ------------------------------------

/** The governed leaf results a source reads: itself, or its own derivation's sources. */
function leafResultIds(source: PivotSourceResult): readonly string[] {
  return source.derivation ? source.derivation.sources.map((entry) => entry.resultId) : [source.resultId];
}

/** A cell carried as-is: a direct reference, or a derived source's own expression for that cell. */
function carryCell(source: PivotSourceResult, rowIndex: number, columnKey: string): TraceDerivedCellExpression | null {
  if (!source.derivation) return { kind: "source", sourceResultId: source.resultId, rowIndex, columnKey };
  const cell = source.derivation.rows[rowIndex]?.cells.find((entry) => entry.columnKey === columnKey);
  return cell?.expression ?? null;
}

/** A cell used as an arithmetic operand: a direct or looked-up source reference. */
function operandCell(source: PivotSourceResult, rowIndex: number, columnKey: string): TraceDerivedSourceCell | null {
  const expression = carryCell(source, rowIndex, columnKey);
  return expression && (expression.kind === "source" || expression.kind === "matched_source") ? expression : null;
}

/** A cell used as a join key: only a direct, indexed source reference can anchor a lookup. */
function indexedCell(source: PivotSourceResult, rowIndex: number, columnKey: string): Extract<TraceDerivedSourceCell, { kind: "source" }> | null {
  const expression = carryCell(source, rowIndex, columnKey);
  return expression && expression.kind === "source" ? expression : null;
}

/**
 * Seals a derivation only when a refresh would reproduce it: every leaf
 * result fits the refresh snapshot and the transform materialises over those
 * snapshot rows exactly as the refresh adapter will run it.
 */
function sealDerivation(
  derivation: TraceTableDerivationV1,
  sources: ReadonlyMap<string, PivotSourceResult>,
): Readonly<{
  derivation: TraceTableDerivationV1 | null;
  /** The rows exactly as a refresh materialises them, so the trace never drifts from the tile. */
  rows: readonly Readonly<Record<string, TraceCell>>[];
  note: string | null;
}> {
  for (const { resultId } of derivation.sources) {
    const leaf = sources.get(resultId);
    if (!leaf || leaf.derivation) return { derivation: null, rows: [], note: "Not refreshable on a dashboard: a source is not a governed query result." };
    if (leaf.rows.length > MAX_REPLAY_ROWS) {
      return { derivation: null, rows: [], note: `Not refreshable on a dashboard: ${leaf.topic} holds more than ${MAX_REPLAY_ROWS} rows; narrow that query with a filter or limit to make this tile-able.` };
    }
  }
  try {
    const materialized = materializeDerivedTable(
      derivation,
      derivation.sources.map(({ resultId }) => {
        const leaf = sources.get(resultId)!;
        return { resultId, columns: leaf.columns, rows: leaf.rows.slice(0, MAX_REPLAY_ROWS) };
      }),
      "Australia/Melbourne",
    );
    return { derivation, rows: materialized.rows, note: null };
  } catch (error) {
    return {
      derivation: null,
      rows: [],
      note: `Not refreshable on a dashboard: ${error instanceof Error ? error.message : "the transform could not be replayed"}`,
    };
  }
}

/** A sealed result shows the replayed rows for the sealed prefix, its own beyond it. */
function adoptSealedRows(
  rows: readonly Readonly<Record<string, TraceCell>>[],
  sealed: readonly Readonly<Record<string, TraceCell>>[],
): readonly Readonly<Record<string, TraceCell>>[] {
  return sealed.length > 0 ? [...sealed, ...rows.slice(sealed.length)] : rows;
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
  const leftIdentity = left.semantics?.keys[leftColumn.key];
  const rightIdentity = right.semantics?.keys[rightColumn.key];
  if (!leftIdentity || !rightIdentity || leftIdentity.kind !== rightIdentity.kind || leftIdentity.domain !== rightIdentity.domain) {
    return failure("Join keys do not have a shared, governed identity.", "Use source IDs from the same identity domain or matching time buckets. Display names and independent systems' IDs cannot establish identity.");
  }
  if (left.semantics?.window !== right.semantics?.window) {
    return failure("Join inputs cover different periods or timezones.", "Query both sources over the same explicit window and timezone before aligning them.");
  }
  if ((mode === "anti" || mode === "left") && right.semantics?.completeness !== "complete") {
    return failure("The second result is incomplete; absence of a match cannot be established.", "Query the full matching population with a narrower filter or a governed aggregate. A row-limited result cannot prove that something was never sold or has no matching activity.");
  }
  if (left.rows.length > MAX_JOIN_INPUT_ROWS || right.rows.length > MAX_JOIN_INPUT_ROWS) {
    return failure("A join input is too large.", `Each side must have at most ${MAX_JOIN_INPUT_ROWS} rows; add filters or a limit.`);
  }

  const rightRows = new Map<string, Readonly<Record<string, TraceCell>>>();
  for (const row of right.rows) {
    const key = labelKey(row[rightColumn.key]);
    if (key === null) continue;
    if (rightRows.has(key)) return failure("The second result contains duplicate join keys.", "Aggregate to one row per stable key or select a more specific key. Choosing the first match would change the answer with row order.");
    rightRows.set(key, row);
  }
  if (mode !== "anti") {
    const leftKeys = left.rows.map((row) => labelKey(row[leftColumn.key])).filter((key): key is string => key !== null);
    if (new Set(leftKeys).size !== leftKeys.length) {
      return failure("The first result contains duplicate join keys, so attaching the second result would repeat its measures.", "Aggregate both sides to one row per shared key or choose a more specific key before combining facts.");
    }
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
  const outputLeftRows: { leftRowIndex: number; matched: boolean }[] = [];
  let matched = 0;
  left.rows.forEach((row, leftRowIndex) => {
    const key = labelKey(row[leftColumn.key]);
    const match = key === null ? undefined : rightRows.get(key);
    if (match) matched += 1;
    if (mode === "anti") {
      if (!match) rows.push({ ...row });
      return;
    }
    if (mode === "inner" && !match) return;
    const out: Record<string, TraceCell> = { ...row };
    for (const { source, key: outKey } of rightOutput) out[outKey] = match ? (match[source.key] ?? null) : null;
    rows.push(out);
    outputLeftRows.push({ leftRowIndex, matched: Boolean(match) });
  });
  const notes: string[] = [
    `Matched on exact ${leftColumn.label} = ${rightColumn.label} keys; ${matched} of ${left.rows.length} left rows matched.`,
  ];
  if (mode === "anti") notes.push(`${rows.length} left rows have no match in the second result.`);
  const recipe = `${mode} join of ${input.resultId} on ${leftColumn.key} with ${input.secondResultId} on ${rightColumn.key}`;
  const provenance = mergedProvenance(input, left, [right], [{ column: mode, formula: recipe }], [
    ...left.provenance.definitions,
    ...right.provenance.definitions,
  ].slice(0, 36));

  // The sealed transform: every output row carries its left cells and looks
  // the right cells up by the join key, exactly what a refresh replays.
  let derivation: TraceTableDerivationV1 | null = null;
  if (mode === "anti") {
    notes.push("Not refreshable on a dashboard: an anti-join cannot be replayed; query the missing side directly for a tile.");
  } else if (right.derivation) {
    notes.push("Not refreshable on a dashboard: the second result must be a governed query result.");
  } else if (outputLeftRows.some((entry) => !entry.matched)) {
    notes.push("Not refreshable on a dashboard: some rows had no match; use joinMode inner for a tile.");
  } else {
    const replayRows = outputLeftRows.slice(0, MAX_REPLAY_ROWS);
    const cellsByRow = replayRows.map(({ leftRowIndex }) => {
      const matchValue = indexedCell(left, leftRowIndex, leftColumn.key);
      if (!matchValue) return null;
      const cells: { columnKey: string; expression: TraceDerivedCellExpression }[] = [];
      for (const column of left.columns) {
        const expression = carryCell(left, leftRowIndex, column.key);
        if (!expression) return null;
        cells.push({ columnKey: column.key, expression });
      }
      for (const { source, key } of rightOutput) {
        cells.push({
          columnKey: key,
          expression: {
            kind: "matched_source",
            sourceResultId: right.resultId,
            columnKey: source.key,
            matchColumnKey: rightColumn.key,
            matchValue,
          },
        });
      }
      return { cells };
    });
    if (cellsByRow.every((row) => row !== null)) {
      const leafIds = [...new Set([...leafResultIds(left), right.resultId])];
      const sealed = sealDerivation({
        version: "derived_table_v1",
        sources: leafIds.map((resultId) => ({ tableEventId: "", resultId })),
        columns: outputColumns.map((column) => ({ ...column })),
        rows: cellsByRow as { cells: { columnKey: string; expression: TraceDerivedCellExpression }[] }[],
      }, sources);
      derivation = sealed.derivation;
      if (sealed.note) notes.push(sealed.note);
      else if (rows.length > MAX_REPLAY_ROWS) notes.push(`A dashboard tile of this result refreshes its first ${MAX_REPLAY_ROWS} rows.`);
      if (derivation) rows.splice(0, rows.length, ...adoptSealedRows(rows, sealed.rows));
    } else {
      notes.push("Not refreshable on a dashboard: a join key or source cell is itself a calculation or lookup.");
    }
  }
  const retained = rows.slice(0, MAX_DERIVED_ROWS);
  return { ok: true, result: { columns: outputColumns, rows: retained, provenance, notes, recipe, derivation, semantics: derivedResultSemantics([left, right], retained.length, recipe) } };
}

function deriveAggregate(input: DeriveInput, sources: ReadonlyMap<string, PivotSourceResult>): DeriveOutcome {
  const source = sources.get(input.resultId)!;
  if (source.semantics?.completeness !== "complete" && input.aggregateScope !== "returned_rows") {
    return failure("A population total requires a complete source result.", "Query an aggregate without entity dimensions, or explicitly choose aggregateScope returned_rows for a clearly labelled subtotal of the selected rows.");
  }
  if (!input.metrics?.length) return failure("metrics are required for an aggregate.", "Pass at least one {valueKey, fn, label}.");
  const groupColumn = input.groupBy ? requireColumn(source, input.groupBy, "groupBy", false) : null;
  if (groupColumn && isOutcome(groupColumn)) return groupColumn;
  const metricColumns: TraceTableColumn[] = [];
  for (const metric of input.metrics) {
    const column = requireColumn(source, metric.valueKey, `metric "${metric.label}" valueKey`, metric.fn !== "count");
    if (isOutcome(column)) return column;
    metricColumns.push(column);
  }
  const groups = new Map<string, { label: TraceCell; values: Decimal[][]; counts: number[] }>();
  for (const row of source.rows) {
    const key = groupColumn ? (labelKey(row[groupColumn.key]) ?? "") : "";
    let group = groups.get(key);
    if (!group) {
      group = { label: groupColumn ? (row[groupColumn.key] ?? null) : input.aggregateScope === "returned_rows" ? "Selected rows only" : "All rows", values: input.metrics.map(() => []), counts: input.metrics.map(() => 0) };
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
      let value: TraceCell;
      switch (metric.fn) {
        case "sum": value = values.length ? decimalCell(values.reduce((a, b) => a.plus(b), new Exact(0))) : null; break;
        case "avg": value = values.length ? decimalCell(values.reduce((a, b) => a.plus(b), new Exact(0)).div(values.length)) : null; break;
        case "min": value = values.length ? decimalCell(Exact.min(...values)) : null; break;
        case "max": value = values.length ? decimalCell(Exact.max(...values)) : null; break;
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
  const notes = [
    `Aggregated ${source.rows.length} rows of ${source.topic}${source.rows.length >= MAX_DERIVED_ROWS ? " (the source hit its row limit, so this covers only the rows returned)" : ""}.`,
    "Not refreshable on a dashboard: an aggregate cannot be replayed; for a tile, query the aggregated measure without the entity dimension instead.",
  ];
  if (input.aggregateScope === "returned_rows") notes.push("This is a subtotal of selected rows, not a population total.");
  const retained = rows.slice(0, MAX_DERIVED_ROWS);
  return { ok: true, result: { columns, rows: retained, provenance, notes, recipe, derivation: null, semantics: derivedResultSemantics([source], retained.length, recipe, {}, groupColumn ? [groupColumn.key] : []) } };
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
    if ((expression.kind === "difference" || expression.kind === "sum") && (left.type !== right.type || left.currency !== right.currency)) {
      return failure("Addition and subtraction require matching units and currencies.", "Choose two compatible columns. Ratios may combine different units, but currencies must be converted by a governed measure.");
    }
    if (left.currency && right.currency && left.currency !== right.currency) {
      return failure("Arithmetic cannot combine different currencies.", "Use a modeled currency-converted measure first.");
    }
    const key = columnKey(expression.label, taken);
    const type: TraceTableColumn["type"] = expression.kind === "percent_of" ? "percent" : expression.kind === "ratio" ? "number" : left.type;
    columns.push({ key, label: expression.label, type, ...(type === left.type && left.currency ? { currency: left.currency } : {}), ...(type === "percent" ? { percentScale: "percent" as const } : {}) });
    plans.push({ key, kind: expression.kind, left, right });
  }
  const rows = source.rows.map((row) => {
    const out: Record<string, TraceCell> = { ...row };
    for (const plan of plans) {
      const left = toNumber(row[plan.left.key]);
      const right = toNumber(row[plan.right.key]);
      let value: TraceCell = null;
      if (left !== null && right !== null) {
        switch (plan.kind) {
          case "ratio": value = right.isZero() ? null : decimalCell(left.div(right)); break;
          case "percent_of": value = right.isZero() ? null : decimalCell(left.div(right).mul(100)); break;
          case "difference": value = decimalCell(left.minus(right)); break;
          default: value = decimalCell(left.plus(right));
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

  // The sealed transform: each row carries the source cells and one
  // calculation per expression over its two operands.
  const OPERATORS = { ratio: "divide", percent_of: "percent_of", difference: "subtract", sum: "add" } as const;
  let derivation: TraceTableDerivationV1 | null = null;
  const cellsByRow = source.rows.slice(0, MAX_REPLAY_ROWS).map((_row, rowIndex) => {
    const cells: { columnKey: string; expression: TraceDerivedCellExpression }[] = [];
    for (const column of source.columns) {
      const expression = carryCell(source, rowIndex, column.key);
      if (!expression) return null;
      cells.push({ columnKey: column.key, expression });
    }
    for (const plan of plans) {
      const left = operandCell(source, rowIndex, plan.left.key);
      const right = operandCell(source, rowIndex, plan.right.key);
      if (!left || !right) return null;
      cells.push({ columnKey: plan.key, expression: { kind: "calculation", operator: OPERATORS[plan.kind], left, right } });
    }
    return { cells };
  });
  if (cellsByRow.every((row) => row !== null)) {
    const sealed = sealDerivation({
      version: "derived_table_v1",
      sources: leafResultIds(source).map((resultId) => ({ tableEventId: "", resultId })),
      columns: columns.map((column) => ({ ...column })),
      rows: cellsByRow as { cells: { columnKey: string; expression: TraceDerivedCellExpression }[] }[],
    }, sources);
    derivation = sealed.derivation;
    if (sealed.note) notes.push(sealed.note);
    else if (rows.length > MAX_REPLAY_ROWS) notes.push(`A dashboard tile of this result refreshes its first ${MAX_REPLAY_ROWS} rows.`);
    if (derivation) rows.splice(0, rows.length, ...adoptSealedRows(rows, sealed.rows));
  } else {
    notes.push("Not refreshable on a dashboard: an operand is itself a calculation.");
  }
  const retained = rows.slice(0, MAX_DERIVED_ROWS);
  const semantics = derivedResultSemantics([source], retained.length, recipe);
  if (retained.some((row) => plans.some((plan) => row[plan.key] === null))) {
    return { ok: true, result: { columns, rows: retained, provenance, notes, recipe, derivation, semantics: { ...semantics, qualifications: [...(semantics.qualifications ?? []), "Some calculated cells are undefined because an operand is missing or a divisor is zero."] } } };
  }
  return { ok: true, result: { columns, rows: retained, provenance, notes, recipe, derivation, semantics } };
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
