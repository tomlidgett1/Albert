import { z } from "zod";
import type { TraceAnswerEvent, TraceTableColumn, TraceRowFormat } from "../../shared/src/index.js";
import { sanitizeAnswerText, sanitizeTraceText } from "../../shared/src/index.js";
import { findUngroundedNumbersWithEvidence, ownerStatedGroundingValues } from "../../../services/conversation/src/grounding.js";
import type { PivotSourceResult } from "./pivot.js";
import { answerPeriodIssues } from "./answer-scope.js";
import { extractOmniFollowUps } from "./follow-ups.js";

const slotId = z.string().regex(/^[a-z][a-z_]{0,39}$/u);
const resultId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
export const composeAnswerSchema = z.object({
  outcome: z.enum(["answer", "explanation", "clarification", "no_data", "unavailable"]),
  markdown: z.string().min(1).max(100_000),
  values: z.array(z.object({
    id: slotId,
    resultId,
    rowIndex: z.number().int().min(0).max(499),
    columnKey: z.string().min(1).max(160),
    format: z.enum(["auto", "compact"]),
    decimals: z.number().int().min(0).max(4).nullable(),
  }).strict()).max(80),
  tables: z.array(z.object({
    id: slotId,
    resultId,
    columnKeys: z.array(z.string().min(1).max(160)).min(1).max(14),
    limit: z.number().int().min(1).max(50),
  }).strict()).max(12),
  citedResultIds: z.array(resultId).max(30),
  limitations: z.array(z.string().min(1).max(500)).max(12),
  followUps: z.array(z.string().min(4).max(160)).max(3),
}).strict();
export type ComposeAnswerInput = z.infer<typeof composeAnswerSchema>;
export type AnswerEvidence = PivotSourceResult & Readonly<{ rowFormats?: readonly (TraceRowFormat | null)[]; priorTurn?: boolean }>;
export type ComposedAnswer = Readonly<{
  text: string;
  state: Exclude<TraceAnswerEvent["state"], "Derived">;
  claims: NonNullable<TraceAnswerEvent["claims"]>;
  presentedResultIds: readonly string[];
  followUps: readonly string[];
}>;

function escapeCell(value: string): string {
  return value.replace(/([\\`*_{}[\]()<>|])/gu, "\\$1").replace(/[\r\n]+/gu, " ");
}

function displayCell(value: unknown, column: TraceTableColumn, format: "auto" | "compact" = "auto", decimals: number | null = null): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" && ["date", "datetime"].includes(column.type)
    && /^\d{4}-\d{2}-\d{2}(?:[T ]00:00(?::00)?(?:\.0+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/u.test(value)) {
    const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
    if (!Number.isNaN(date.getTime())) return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
  }
  if (!["number", "currency", "percent"].includes(column.type)) return escapeCell(String(value));
  const exact = typeof value === "number" ? value : String(value).replaceAll(",", "");
  const numeric = Number(exact);
  if (!Number.isFinite(numeric)) throw new Error(`Non-numeric cell in ${column.key}.`);
  const places = decimals ?? (column.type === "currency" ? 2 : Number.isInteger(numeric) ? 0 : 2);
  const formatter = new Intl.NumberFormat("en-AU", {
    maximumFractionDigits: places,
    minimumFractionDigits: column.type === "currency" && format !== "compact" ? places : 0,
    ...(format === "compact" ? { notation: "compact" as const } : {}),
    ...(column.type === "currency" ? { style: "currency" as const, currency: column.currency ?? "AUD" } : {}),
  });
  // Node 22's Intl accepts exact decimal strings; TS's signature still lists
  // only number | bigint. Keep this compatibility cast at the formatting edge.
  const formatExact = formatter.format as unknown as (value: string | number) => string;
  const text = formatExact(column.type === "percent" && column.percentScale === "ratio" ? numeric * 100 : exact);
  return column.type === "percent" ? `${text}%` : text;
}

/** Resolves every analytical figure from governed cells; the model supplies prose and references. */
export function composeAnswer(
  input: ComposeAnswerInput,
  evidence: ReadonlyMap<string, AnswerEvidence>,
  options: Readonly<{ question: string; today: string; hadQueryFailures?: boolean; imessage?: boolean }>,
): Readonly<{ ok: true; answer: ComposedAnswer }> | Readonly<{ ok: false; issues: readonly string[] }> {
  const parsed = composeAnswerSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
  input = parsed.data;
  const issues: string[] = [];
  const selected = new Set(input.citedResultIds);
  const slots = new Map<string, string>();
  const claims: NonNullable<TraceAnswerEvent["claims"]>[number][] = [];
  const put = (id: string, value: string) => {
    if (slots.has(id)) issues.push(`Duplicate placeholder ${id}.`);
    slots.set(id, value);
  };
  for (const value of input.values) {
    const source = evidence.get(value.resultId);
    const column = source?.columns.find((column) => column.key === value.columnKey);
    const row = source?.rows[value.rowIndex];
    if (!source || !column || !row || !(value.columnKey in row)) {
      issues.push(`Value ${value.id} references an unknown result, row or column.`);
      continue;
    }
    selected.add(source.resultId);
    try {
      const text = displayCell(row[column.key], source.rowFormats?.[value.rowIndex] ? { ...column, ...source.rowFormats[value.rowIndex] } : column, value.format, value.decimals);
      put(value.id, text);
      claims.push({ statement: `${column.label}: ${text} (${source.provenance.timeRange.label})`, assertion: "value", refs: [{ resultId: source.resultId, rowIndex: value.rowIndex, columnKey: column.key }] });
    } catch (error) { issues.push(error instanceof Error ? error.message : "Invalid value."); }
  }
  for (const table of input.tables) {
    const placeholder = `{{${table.id}}}`;
    const lines = input.markdown.replace(/\r\n?/gu, "\n").split("\n");
    for (const [index, line] of lines.entries()) {
      if (!line.includes(placeholder)) continue;
      if (line.trim() !== placeholder || lines[index - 1]?.trim() || lines[index + 1]?.trim()) {
        issues.push(`Table ${table.id} must be a standalone paragraph: put ${placeholder} alone on a line with a blank line before and after it. Do not wrap it in a hand-written table header, row, or formatting.`);
      }
    }
    const source = evidence.get(table.resultId);
    if (!source) { issues.push(`Table ${table.id} references an unknown result.`); continue; }
    if (options.imessage) { issues.push("iMessage answers use value placeholders and short paragraphs, not tables."); continue; }
    const columns = table.columnKeys.map((key) => source.columns.find((column) => column.key === key));
    if (columns.some((column) => !column)) { issues.push(`Table ${table.id} names an unknown column.`); continue; }
    if (new Set(table.columnKeys).size !== table.columnKeys.length) { issues.push(`Table ${table.id} repeats a column.`); continue; }
    selected.add(source.resultId);
    const typed = columns as TraceTableColumn[];
    const rows = source.rows.slice(0, table.limit);
    try {
      put(table.id, [
        `| ${typed.map((column) => escapeCell(column.label)).join(" | ")} |`,
        `| ${typed.map((column) => ["number", "currency", "percent"].includes(column.type) ? "---:" : "---").join(" | ")} |`,
        ...rows.map((row, rowIndex) => `| ${typed.map((column) => {
          const text = displayCell(row[column.key], source.rowFormats?.[rowIndex] && column.type !== "string" ? { ...column, ...source.rowFormats[rowIndex] } : column);
          claims.push({ statement: `${column.label}: ${text}`, assertion: "value", refs: [{ resultId: source.resultId, rowIndex, columnKey: column.key }] });
          return text;
        }).join(" | ")} |`),
      ].join("\n"));
    } catch (error) { issues.push(error instanceof Error ? error.message : "Invalid table."); }
  }
  for (const id of selected) if (!evidence.has(id)) issues.push(`Unknown cited result ${id}.`);
  const sources = [...selected].flatMap((id) => evidence.get(id) ? [evidence.get(id)!] : []);
  if (input.outcome === "answer" || input.outcome === "no_data") issues.push(...answerPeriodIssues(options.question, sources));
  const placeholders = [...input.markdown.matchAll(/\{\{([a-z][a-z_]{0,39})\}\}/gu)].map((match) => match[1]!);
  for (const id of placeholders) if (!slots.has(id)) issues.push(`Unknown placeholder {{${id}}}.`);
  for (const id of slots.keys()) if (!placeholders.includes(id)) issues.push(`Placeholder {{${id}}} was defined but not used.`);

  // Values from result cells must travel through a reference, never borrow
  // support from an unrelated equal number somewhere in the evidence pool.
  const plain = [input.markdown.replace(/\{\{[^}]+\}\}/gu, ""), ...input.limitations].join("\n");
  const dateLabels = [options.today, ...sources.flatMap((source) => [source.provenance.timeRange.label, source.provenance.timeRange.start, source.provenance.timeRange.end])];
  const allowed = [...ownerStatedGroundingValues(options.question), ...dateLabels.flatMap((label) => [...label.matchAll(/\b(?:19|20)\d{2}\b/gu)].map((match) => Number(match[0])))];
  const labels = [...dateLabels, ...sources.flatMap((source) => source.rows.flatMap((row) => source.columns.filter((column) => ["string", "date", "datetime"].includes(column.type)).map((column) => String(row[column.key] ?? ""))))];
  const unsupported = findUngroundedNumbersWithEvidence(plain, allowed, labels);
  if (unsupported.length) issues.push(`Unbound figures: ${unsupported.slice(0, 12).join(", ")}. Use {{value_name}} references or {{table_name}}; calculate new figures with DeriveResult first.`);
  if (/\{\{|\}\}/u.test(plain)) issues.push("Malformed answer placeholder.");
  if (input.outcome === "answer" && (!sources.length || claims.length === 0)) issues.push("An analytical answer requires cited evidence and at least one value or table reference.");
  if (input.outcome === "no_data" && (!sources.length || sources.some((source) => source.rows.length > 0))) issues.push("No data requires an executed empty query for the requested scope.");
  if (input.outcome === "explanation" && (input.values.length || input.tables.length)) issues.push("Use outcome answer when presenting data values.");
  if (issues.length) return { ok: false, issues };

  const extracted = extractOmniFollowUps(input.markdown.replace(/\{\{([a-z][a-z_]{0,39})\}\}/gu, (_match, id: string) => slots.get(id)!));
  let text = extracted.text;
  const limitations = [...input.limitations, ...sources.flatMap((source) => source.semantics?.qualifications ?? [])];
  if (sources.some((source) => source.semantics?.completeness !== "complete")) limitations.push("Some evidence contains only the rows returned by the query; it does not establish a total for the full population.");
  if (sources.some((source) => source.priorTurn)) limitations.push("This uses the earlier results in this conversation; the figures have not been refreshed.");
  if (options.hadQueryFailures && input.outcome === "answer") limitations.push("Some query attempts failed during this analysis; the displayed figures come from successful results.");
  if (limitations.length) text += `\n\n${[...new Set(limitations)].join(" ")}`;
  if (text.length > 120_000 || Buffer.byteLength(JSON.stringify({ text, claims })) > 1_200_000) return { ok: false, issues: ["The composed answer exceeds the artifact size limit. Select fewer rows or columns; the answer will not be silently truncated."] };
  const state: ComposedAnswer["state"] = input.outcome === "clarification" ? "Clarification"
    : input.outcome === "unavailable" ? "Unavailable"
      : input.outcome === "explanation" ? "Exploratory"
        : limitations.length ? "Qualified"
          : input.outcome === "no_data" ? "No data" : "Verified";
  return { ok: true, answer: {
    text: sanitizeAnswerText(text, 120_000), state, claims,
    presentedResultIds: [...selected],
    followUps: options.imessage ? [] : [...new Set([...input.followUps, ...extracted.followUps])].slice(0, 3).map((text) => sanitizeTraceText(text, 160)),
  } };
}

export const COMPOSE_ANSWER_INSTRUCTIONS = `# Composing the final answer

Use ComposeAnswer to deliver the answer. Its accepted content is exactly what the owner receives.
Write normal polished markdown in markdown, replacing EVERY analytical figure with a named placeholder like {{sales}}. Define it in values using the resultId, zero-based rowIndex and exact columnKey returned by a tool; format auto (or compact for texting), decimals null unless a precision matters. Do not type the value yourself.
For tables, put {{weekly_table}} in its own paragraph, alone on a line with a blank line before and after, and define it in tables with resultId, columnKeys and limit. Do not wrap that placeholder in a Markdown table or add your own header or separator row. The server supplies the complete table, including headers, separators and actual result rows. Never hand-copy or transpose a numerical table. ComposePivotTable and DeriveResult prepare new shapes and arithmetic before composition. CalculateValues computes exact arithmetic between any two result cells, including period-on-period change across two rows of a comparison query.
Use citedResultIds for every result that supports the conclusion. State any missing source, proxy, incompatible period or uncertainty in limitations. These disclosures are appended to the answer. The harness decides the answer state; you cannot promote an answer to Verified.
outcome answer presents query evidence; explanation answers a definition question without figures; clarification asks the one blocking question; no_data cites the executed empty result; unavailable names the missing capability. Do not use explanation to avoid retrieving business figures.
If composition reports issues, repair the references or run the necessary query or derivation, then compose again. After acceptance, finish with a brief hand-over; do not rewrite the accepted answer.`;
