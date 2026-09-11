import { z } from "zod";
import { protectReportingDates } from "../../shared/src/reporting-dates.js";
import { composeAnswer, type ComposeAnswerInput, type AnswerEvidence } from "../../albert-omni/src/answer.js";

const reference = z.string().regex(/^r[1-9][0-9]{0,5}$/u);
const bindingName = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/u);

/** The provider constrains its final text to this schema; facts still validate in Albert. */
export const managedAnswerSchema = z.object({
  outcome: z.enum(["answer", "explanation", "clarification", "no_data", "unavailable"]),
  summary: z.string().min(1).max(3_000),
  detail: z.string().max(16_000),
  values: z.array(z.object({
    name: bindingName,
    result: reference,
    column: z.string().min(1).max(160),
    row: z.number().int().min(0).max(499),
  }).strict()).max(60),
  tables: z.array(z.object({
    title: z.string().max(160),
    result: reference,
    columns: z.array(z.string().min(1).max(160)).min(1).max(14),
    limit: z.number().int().min(1).max(50),
  }).strict()).max(6),
  citedResults: z.array(reference).max(30),
  limitations: z.array(z.string().min(1).max(500)).max(8),
  followUps: z.array(z.string().min(4).max(160)).max(3),
}).strict();

export type ManagedAnswer = z.infer<typeof managedAnswerSchema>;
export const MANAGED_ANSWER_JSON_SCHEMA = z.toJSONSchema(managedAnswerSchema);

function letters(index: number): string {
  return index < 26 ? String.fromCharCode(97 + index) : `${letters(Math.floor(index / 26) - 1)}${letters(index % 26)}`;
}

/** Canonical rows supply the tables. The model never writes their Markdown or figures. */
export function composeManagedAnswer(
  value: unknown,
  evidence: ReadonlyMap<string, AnswerEvidence>,
  resolve: (reference: string) => string | undefined,
  options: Parameters<typeof composeAnswer>[2],
): ReturnType<typeof composeAnswer> {
  const parsed = managedAnswerSchema.safeParse(value);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).slice(0, 8) };
  const answer = parsed.data;
  const issues: string[] = [];
  const idFor = (alias: string) => {
    const id = resolve(alias);
    if (!id || !evidence.has(id)) issues.push(`Result ${alias} is unavailable. Read it with SummarizeFullResults or use a result returned by a successful query.`);
    return id ?? alias;
  };
  const names = new Map<string, string>();
  const values: ComposeAnswerInput["values"] = answer.values.map((binding, index) => {
    const id = `value_${letters(index)}`;
    if (names.has(binding.name)) issues.push(`Duplicate value name ${binding.name}.`);
    names.set(binding.name, id);
    return { id, resultId: idFor(binding.result), columnKey: binding.column, rowIndex: binding.row, format: "auto", decimals: null };
  });
  const sourceText = [answer.summary, answer.detail].filter(Boolean).join("\n\n");
  if (/^\s*\|.*\|\s*$/mu.test(sourceText)) issues.push("Put data tables in tables, not in summary or detail. Albert creates their headers and rows.");
  const plainProse = sourceText.replace(/\{\{[^}]+\}\}/gu, "");
  const financialTokens = plainProse.match(/[$£€¥]\s?\d[\d,.]*(?:\s?[kmb])?|\b(?:AUD|USD|EUR|GBP|JPY|CAD|NZD)\s+\d[\d,.]*|\b\d[\d,.]*\s?(?:%|AUD|USD|EUR|GBP|JPY|CAD|NZD)\b/giu) ?? [];
  for (const token of financialTokens) if (!options.question.toLowerCase().includes(token.toLowerCase())) issues.push(`Bind the financial figure ${token} through values instead of typing it in prose.`);
  const markdown = sourceText.replace(/\{\{([a-z][a-z0-9_]{0,39})\}\}/gu, (_match, name: string) => {
    const id = names.get(name);
    if (!id) issues.push(`Value {{${name}}} has no binding.`);
    return `{{${id ?? name}}}`;
  });
  const tables: ComposeAnswerInput["tables"] = answer.tables.map((table, index) => ({
    id: `table_${letters(index)}`, resultId: idFor(table.result), columnKeys: table.columns, limit: table.limit,
  }));
  const tableBlocks = tables.map((table, index) => {
    const title = answer.tables[index]!.title.replace(/[\r\n|{}<>]/gu, " ").replace(/[*`_\[\]\\]/gu, "").trim();
    return `${title ? `**${title}**\n\n` : ""}{{${table.id}}}`;
  });
  const citedResultIds = [...new Set(answer.citedResults.map(idFor))];
  if (issues.length) return { ok: false, issues };
  const dates = protectReportingDates([markdown, ...tableBlocks].filter(Boolean).join("\n\n"), [...evidence.values()]);
  const composed = composeAnswer({
    outcome: answer.outcome,
    markdown: dates.text,
    values, tables, citedResultIds,
    limitations: answer.limitations, followUps: answer.followUps,
  }, evidence, options);
  return composed.ok ? { ok: true, answer: { ...composed.answer, text: dates.restore(composed.answer.text) } } : composed;
}

export const MANAGED_ANSWER_INSTRUCTIONS = `Return the final answer in the configured JSON format.
summary is the direct answer in one or two useful sentences. detail adds new drivers, context or implications only when needed. Use an empty detail when summary and tables already answer the question; never restate the summary in different words.
Every analytical number in summary/detail is a {{named_value}} with a matching values entry. Copy result handles, column keys and zero-based row indexes from tool results. Never type an analytical figure from memory.
Value placeholders already include their currency or percent formatting. Do not add another currency symbol or percent sign around them.
Put each requested data table in tables with its result handle and exact column keys. Albert supplies the complete table; do not write table Markdown or table placeholders in prose.
Use CalculateValues or DeriveResult for arithmetic. Include the resulting value references, not mental calculations.
Address every part of the current question. A store breakdown needs store rows; a comparison needs both periods and the requested difference; a requested chart must be created with the chart tool.
Keep limitations specific to actual missing or incomplete evidence. Never claim completion of checks you did not perform. Use clarification for a blocking ambiguity, no_data only for a successful empty query, and unavailable for a missing capability.
Use clear business language, natural headings only for longer answers, and no discussion of tool schemas, JSON, internal identifiers or validation machinery. Suggest at most two useful follow-ups, or none.`;
