import { sanitizeTraceText } from "../../../shared/src/index.js";
import type {
  TraceDerivedCellExpression,
  TraceDerivedNumericOperand,
  TraceProvenance,
  TraceProvenanceDefinition,
  TraceProvenanceFilter,
  TraceTableDerivationV1,
} from "../../../shared/src/index.js";
import type { CubeCatalogue, CubeCatalogueMember, CubeCatalogueView, CubeFilter, CubeQuery } from "../cube/types.js";

/**
 * Owner-readable provenance for a governed Cube result: the view ("topic")
 * it came from, what each member means according to the semantic model, and
 * the filters and time windows that scope the figures. This is what the
 * result card's info button shows — descriptions and scope, not hashes.
 */

const OPERATOR_TEXT: Readonly<Record<string, string>> = Object.freeze({
  equals: "is",
  notEquals: "is not",
  contains: "contains",
  notContains: "does not contain",
  startsWith: "starts with",
  notStartsWith: "does not start with",
  endsWith: "ends with",
  notEndsWith: "does not end with",
  gt: "is more than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  set: "is set",
  notSet: "is not set",
  inDateRange: "is between",
  notInDateRange: "is not between",
  beforeDate: "is before",
  afterDate: "is after",
});

function humanValues(values: readonly string[]): string {
  const shown = values.slice(0, 6).map((value) => value.trim()).filter(Boolean);
  const more = values.length - shown.length;
  if (shown.length === 0) return "";
  if (shown.length === 1) return shown[0]!;
  if (shown.length === 2) return `${shown[0]} or ${shown[1]}`;
  return `${shown.slice(0, -1).join(", ")} or ${shown.at(-1)}${more > 0 ? ` (+${more} more)` : ""}`;
}

function memberIndex(view: CubeCatalogueView | undefined): ReadonlyMap<string, CubeCatalogueMember> {
  return new Map((view?.members ?? []).map((member) => [member.name, member]));
}

/** Cube prefixes view-member titles with the view title ("Sales analytics Store"); the owner wants "Store". */
function stripViewPrefix(title: string, view: CubeCatalogueView | undefined): string {
  const prefix = view?.title?.trim();
  if (prefix && title.length > prefix.length + 1 && title.startsWith(`${prefix} `)) {
    return title.slice(prefix.length + 1);
  }
  return title;
}

function labelFor(memberName: string, members: ReadonlyMap<string, CubeCatalogueMember>, view?: CubeCatalogueView): string {
  const member = members.get(memberName);
  const raw = member?.title || member?.shortTitle || memberName.split(".").at(-1)!.replaceAll("_", " ");
  return stripViewPrefix(raw, view);
}

function flattenFilters(filters: readonly CubeFilter[] | undefined): readonly Readonly<{ member: string; operator: string; values: readonly string[]; group?: "or" }>[] {
  const out: Array<{ member: string; operator: string; values: readonly string[]; group?: "or" }> = [];
  const walk = (filter: CubeFilter, group?: "or") => {
    if ("and" in filter) { for (const child of filter.and) walk(child, group); return; }
    if ("or" in filter) { for (const child of filter.or) walk(child, "or"); return; }
    out.push({ member: filter.member, operator: filter.operator, values: filter.values ?? [], ...(group ? { group } : {}) });
  };
  for (const filter of filters ?? []) walk(filter);
  return out;
}

export function describeCubeQueryProvenance(input: Readonly<{
  query: CubeQuery;
  view: string;
  members: readonly string[];
  catalogue: CubeCatalogue;
  /** Cube result annotation titles, used when the catalogue lacks a member. */
  annotationTitles?: Readonly<Record<string, string | undefined>>;
}>): Pick<TraceProvenance, "view" | "definitions" | "filters"> {
  const view = input.catalogue.views.find((candidate) => candidate.name === input.view);
  const members = memberIndex(view);
  const timeMembers = new Set((input.query.timeDimensions ?? []).map((td) => td.dimension));

  const definitions: TraceProvenanceDefinition[] = [];
  const seen = new Set<string>();
  for (const name of input.members) {
    if (seen.has(name)) continue;
    seen.add(name);
    const member = members.get(name);
    const kind: TraceProvenanceDefinition["kind"] = timeMembers.has(name)
      ? "time"
      : member?.kind ?? (name.split(".").at(-1)?.endsWith("_at") ? "time" : "dimension");
    const meaning = member?.description?.trim()
      || member?.aiContext?.trim()
      || `${kind === "measure" ? "Measure" : "Field"} from the ${view?.title ?? input.view} view.`;
    definitions.push({
      metric: name,
      label: sanitizeTraceText(
        stripViewPrefix(member?.title || input.annotationTitles?.[name] || labelFor(name, members, view), view),
        120,
      ),
      definition: sanitizeTraceText(meaning, 400),
      view: input.view,
      kind,
    });
  }

  const filters: TraceProvenanceFilter[] = [];
  for (const filter of flattenFilters(input.query.filters)) {
    const label = labelFor(filter.member, members, view);
    const operator = OPERATOR_TEXT[filter.operator] ?? filter.operator;
    const values = filter.values.map((value) => sanitizeTraceText(value, 80));
    const text = values.length > 0 ? `${label} ${operator} ${humanValues(values)}` : `${label} ${operator}`;
    filters.push({
      member: filter.member,
      label: sanitizeTraceText(label, 120),
      operator: filter.operator,
      values,
      text: sanitizeTraceText(filter.group === "or" ? `${text} (any of)` : text, 240),
    });
  }
  for (const td of input.query.timeDimensions ?? []) {
    const label = labelFor(td.dimension, members, view);
    const range = td.compareDateRange
      ? `comparing ${td.compareDateRange.map((entry) => Array.isArray(entry) ? entry.join(" to ") : String(entry)).join(" vs ")}`
      : td.dateRange
        ? Array.isArray(td.dateRange) ? `${td.dateRange[0]} to ${td.dateRange[1]}` : String(td.dateRange)
        : "";
    const grain = td.granularity ? `by ${td.granularity}` : "";
    const parts = [label, range ? (td.compareDateRange ? range : `in ${range}`) : "", grain].filter(Boolean);
    filters.push({
      member: td.dimension,
      label: sanitizeTraceText(label, 120),
      operator: td.compareDateRange ? "compareDateRange" : "inDateRange",
      values: td.compareDateRange
        ? td.compareDateRange.map((entry) => Array.isArray(entry) ? entry.join(",") : String(entry))
        : td.dateRange
          ? [Array.isArray(td.dateRange) ? td.dateRange.join(",") : String(td.dateRange)]
          : [],
      text: sanitizeTraceText(parts.join(" "), 240),
    });
  }

  return {
    ...(view
      ? {
          view: {
            name: view.name,
            label: sanitizeTraceText(view.title || view.name, 120),
            description: sanitizeTraceText(view.description?.trim() || view.aiContext?.trim() || "", 400),
          },
        }
      : {}),
    definitions,
    filters,
  };
}

/** Plain-words formulas for a composed table's calculated columns. */
export function describeDerivedCalculations(
  derivation: TraceTableDerivationV1,
  sources: ReadonlyMap<string, Readonly<{ caption: string; columns: readonly Readonly<{ key: string; label: string }>[]; rows: readonly Readonly<Record<string, unknown>>[] }>>,
): readonly Readonly<{ column: string; formula: string }>[] {
  const columnLabel = new Map(derivation.columns.map((column) => [column.key, column.label]));
  const operandText = (operand: TraceDerivedNumericOperand): string => {
    if (operand.kind === "number") return String(operand.value);
    const source = sources.get(operand.sourceResultId);
    const label = source?.columns.find((column) => column.key === operand.columnKey)?.label ?? operand.columnKey;
    if (operand.kind === "source") {
      const row = source?.rows[operand.rowIndex];
      // Name the row by its first text-like cell (period, store, category);
      // a numeric cell would just repeat a figure.
      const nameKey = row
        ? source?.columns.find((column) => {
            const value = row[column.key];
            return column.key !== operand.columnKey
              && typeof value === "string"
              && value.trim() !== ""
              && !Number.isFinite(Number(value.replaceAll(",", "")));
          })?.key
        : undefined;
      const rowName = row && nameKey ? String(row[nameKey]).slice(0, 60) : `row ${operand.rowIndex + 1}`;
      return `${label} (${rowName})`;
    }
    return `${label} matched on ${operand.matchColumnKey}`;
  };
  const expressionText = (expression: TraceDerivedCellExpression): string | undefined => {
    if (expression.kind !== "calculation") return undefined;
    const left = operandText(expression.left);
    const right = operandText(expression.right);
    switch (expression.operator) {
      case "add": return `${left} + ${right}`;
      case "subtract": return `${left} − ${right}`;
      case "multiply": return `${left} × ${right}`;
      case "divide": return `${left} ÷ ${right}`;
      case "percent_change": return `(${left} − ${right}) ÷ ${right} × 100`;
      case "percent_of": return `${left} ÷ ${right} × 100`;
    }
  };
  const seen = new Map<string, string>();
  for (const row of derivation.rows) {
    for (const cell of row.cells) {
      if (seen.has(cell.columnKey)) continue;
      const formula = expressionText(cell.expression);
      if (formula) seen.set(cell.columnKey, formula);
    }
  }
  return [...seen.entries()].map(([key, formula]) => ({
    column: sanitizeTraceText(columnLabel.get(key) ?? key, 120),
    formula: sanitizeTraceText(formula, 300),
  }));
}
