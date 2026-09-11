import Decimal from "decimal.js";
import { z } from "zod";
import type { TraceCell, TraceTableColumn } from "../../shared/src/index.js";
import type { PivotSourceResult } from "./pivot.js";
import { derivedResultSemantics } from "./evidence.js";

const Exact = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export const MAX_CALCULATIONS_PER_CALL = 32;
const referenceSchema = z.object({ resultId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u), rowIndex: z.number().int().min(0).max(499), columnKey: z.string().min(1).max(160) }).strict();
export const calculateValuesSchema = z.object({
  caption: z.string().min(3).max(160),
  calculations: z.array(z.object({
    key: z.string().regex(/^[a-z][a-z_]{0,39}$/u),
    label: z.string().min(1).max(120),
    kind: z.enum(["sum", "difference", "ratio", "percent_of", "percent_change"]),
    left: referenceSchema,
    right: referenceSchema,
  }).strict()).min(1).max(MAX_CALCULATIONS_PER_CALL, { error: "Send at most 32 calculations in one call. Split additional calculations into another batch." }),
}).strict();
export type CalculateValuesInput = z.infer<typeof calculateValuesSchema>;

export function decimalCell(value: Decimal): TraceCell {
  const rounded = value.toDecimalPlaces(4);
  const numeric = rounded.toNumber();
  return Number.isFinite(numeric) && new Exact(numeric).equals(rounded) ? numeric : rounded.toFixed(4);
}

export function calculateValues(input: CalculateValuesInput, sources: ReadonlyMap<string, PivotSourceResult>):
  | { ok: true; result: Omit<PivotSourceResult, "resultId">; notes: string[] }
  | { ok: false; issues: string[] } {
  const parsed = calculateValuesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((issue) => issue.message) };
  const issues: string[] = [];
  const used = new Map<string, PivotSourceResult>();
  const columns: TraceTableColumn[] = [];
  const row: Record<string, TraceCell> = {};
  const recipes: { column: string; formula: string }[] = [];
  const notes: string[] = [];
  for (const calculation of parsed.data.calculations) {
    if (calculation.key in row) { issues.push(`Duplicate calculation key ${calculation.key}.`); continue; }
    const left = sources.get(calculation.left.resultId), right = sources.get(calculation.right.resultId);
    const lc = left?.columns.find((column) => column.key === calculation.left.columnKey);
    const rc = right?.columns.find((column) => column.key === calculation.right.columnKey);
    const lv = left?.rows[calculation.left.rowIndex]?.[calculation.left.columnKey];
    const rv = right?.rows[calculation.right.rowIndex]?.[calculation.right.columnKey];
    if (!left || !right || !lc || !rc || lv === undefined || rv === undefined) { issues.push(`${calculation.key} has an unknown cell reference.`); continue; }
    if (!["number", "currency", "percent"].includes(lc.type) || !["number", "currency", "percent"].includes(rc.type)) { issues.push(`${calculation.key} requires numeric cells.`); continue; }
    if (lc.currency && rc.currency && lc.currency !== rc.currency) { issues.push(`${calculation.key} mixes currencies.`); continue; }
    if (["sum", "difference", "percent_change"].includes(calculation.kind) && (lc.type !== rc.type || lc.currency !== rc.currency)) { issues.push(`${calculation.key} requires matching units.`); continue; }
    if (["sum", "difference", "percent_change"].includes(calculation.kind) && lc.type === "percent" && (lc.percentScale ?? "percent") !== (rc.percentScale ?? "percent")) { issues.push(`${calculation.key} requires matching percentage scales.`); continue; }
    if (left.semantics?.window !== right.semantics?.window && !(["difference", "percent_change"].includes(calculation.kind) && lc.key === rc.key)) { issues.push(`${calculation.key} mixes incompatible windows. Query the same scope or compare the same metric across explicit periods.`); continue; }
    used.set(left.resultId, left); used.set(right.resultId, right);
    const percentagePoints = calculation.kind === "difference" && lc.type === "percent";
    const type = percentagePoints ? "number" : ["percent_of", "percent_change"].includes(calculation.kind) ? "percent"
      : calculation.kind === "ratio" ? (lc.type === "currency" && rc.type === "number" ? "currency" : "number") : lc.type;
    const label = percentagePoints && !/\b(?:points?|pp)\b/iu.test(calculation.label) ? `${calculation.label} (percentage points)` : calculation.label;
    columns.push({ key: calculation.key, label, type, ...(type === "currency" && lc.currency ? { currency: lc.currency } : {}), ...(type === "percent" ? { percentScale: calculation.kind === "sum" ? lc.percentScale ?? "percent" : "percent" as const } : {}) });
    let value: TraceCell = null;
    try {
      if (lv !== null && rv !== null) {
        const a = new Exact(String(lv)), b = new Exact(String(rv));
        if (!a.isFinite() || !b.isFinite()) throw new Error("Non-finite operand");
        if (calculation.kind === "sum") value = decimalCell(a.plus(b));
        else if (calculation.kind === "difference") value = decimalCell(percentagePoints && lc.percentScale === "ratio" ? a.minus(b).mul(100) : a.minus(b));
        else if (!b.isZero()) value = decimalCell(calculation.kind === "ratio" ? a.div(b) : calculation.kind === "percent_of" ? a.div(b).mul(100) : a.minus(b).div(b.abs()).mul(100));
      }
    } catch { issues.push(`${calculation.key} contains an invalid numeric value.`); }
    if (value === null) notes.push(`${calculation.label} is unavailable because an operand is missing or the divisor is zero.`);
    row[calculation.key] = value;
    recipes.push({ column: calculation.key, formula: `${calculation.kind}(${calculation.left.resultId}[${calculation.left.rowIndex}].${lc.key}, ${calculation.right.resultId}[${calculation.right.rowIndex}].${rc.key})` });
  }
  if (issues.length) return { ok: false, issues };
  const inputs = [...used.values()];
  const first = inputs[0]!;
  const semantics = derivedResultSemantics(inputs, 1, JSON.stringify(parsed.data), {}, []);
  return { ok: true, notes, result: {
    topic: input.caption, columns, rows: [row],
    semantics: { ...semantics, qualifications: [...(semantics.qualifications ?? []), ...notes] },
    provenance: { ...first.provenance, sources: [...new Map(inputs.flatMap((source) => source.provenance.sources).map((source) => [`${source.connector}:${source.label}`, source])).values()], calculations: recipes, definitions: inputs.flatMap((source) => source.provenance.definitions).slice(0, 36) },
  } };
}
