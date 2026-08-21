/**
 * The recipe lane: the fast path for the head of the question distribution.
 *
 * A certified query flagged `recipe: true` in the agent config is a complete,
 * pre-validated answer plan for a recognised question shape ("sales for a
 * period", "who is rostered", "what do we owe suppliers", ...). When the intent
 * orchestrator recognises one, this lane executes it directly — the period the
 * owner named is substituted into the recipe's date parameter — and a small
 * trusted template can turn a one-row result into the final answer with no
 * model request; recipes without a valid template retain the bounded composer
 * (and its table/chart tools). No catalogue search, schema load, agentic loop,
 * or evidence review is needed on either path.
 *
 * The mechanism is connector-agnostic: recipes are declared next to the views
 * they read (any connector can ship them) and executed through the same
 * governed query path as every other query. Anything the recipe cannot answer
 * (a rejected query, an empty result, an off-shape request) hands back to the
 * regular lanes with the evidence already registered, so the fast path can
 * only save time, never lose the answer.
 */
import { Agent, user } from "@openai/agents";
import type { CertifiedQuery } from "../agent-config/loader.js";
import { ANSWER_CONTRACT, composeFromGatheredEvidence, finalAnswerSchema, laneModelSettings, renderConnectorFreshness, renderSourceFindings, todayLine, v3PromptCacheKey, withV3PromptCacheBoundary, type FinalAnswer, type LaneRunInput } from "./lanes.js";
import { createComposeTableTool, createPresentResultTool, executeGovernedCubeQuery, type CubeQueryToolInput } from "./tools.js";
import { createMakeChartTool } from "./chart-layer.js";
import { createAggregateResultTool } from "./aggregate-layer.js";
import { renderBusinessContextForClassifier } from "../context-layer/render.js";
import type { StoredTableResult, V3TurnContext } from "./context.js";
import { sanitizeAnswerText, sanitizeTraceText, type TraceCell, type TraceTableColumn } from "../../../shared/src/index.js";

const RELATIVE_RANGE = /^(?:today|yesterday|tomorrow|this (?:week|month|quarter|year)|last (?:week|month|quarter|year)|next (?:week|month)|last \d{1,3} (?:days|weeks|months|quarters|years)|from \d+ (?:days|weeks|months|years) ago to now|\d{4}-\d{2}-\d{2},\d{4}-\d{2}-\d{2}|(?:last |this |in )?[a-z]{3,9}\.?(?: \d{4})?)$/iu;

/** Only well-formed period expressions reach Cube; anything else keeps the recipe default. */
const WORD_NUMBERS: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", twelve: "12" };

export function normaliseRecipeDateRange(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().replace(/\s+/gu, " ").replace(/\s*,\s*/gu, ",")
    .replace(/^(last|next) (one|two|three|four|five|six|seven|eight|nine|ten|twelve) /iu, (_m, dir: string, word: string) => `${dir} ${WORD_NUMBERS[word.toLowerCase()]} `)
    .replace(/^(last|next) (\d+) (day|week|month|quarter|year)$/iu, "$1 $2 $3s");
  const fiscal = /^(?:this financial year|current financial year|financial year to date|fytd|this fy)$/iu.test(trimmed)
    ? "current"
    : /^(?:last financial year|previous financial year|last fy)$/iu.test(trimmed)
      ? "last"
      : undefined;
  if (fiscal) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Melbourne",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const part = (type: string) => Number(parts.find((candidate) => candidate.type === type)?.value);
    const year = part("year");
    const month = part("month");
    const day = part("day");
    const currentStartYear = month >= 7 ? year : year - 1;
    if (fiscal === "last") return `${currentStartYear - 1}-07-01,${currentStartYear}-06-30`;
    const today = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return `${currentStartYear}-07-01,${today}`;
  }
  if (!RELATIVE_RANGE.test(trimmed)) return undefined;
  // Relative expressions are case-insensitive to Cube but explicit month names
  // reach the engine's named-month resolver, which lowercases too; normalise once.
  return /^\d{4}-\d{2}-\d{2},/u.test(trimmed) ? trimmed : trimmed.toLowerCase();
}

type RawFilter = { member: string; operator: string; values?: string[] };
type LooseTimeDimension = { dimension: string; granularity?: string; dateRange?: string };

/** Converts a certified query (Cube JSON) into the governed tool input shape. */
export function recipeToolInput(recipe: CertifiedQuery, dateRange: string | undefined, entity?: string | null): CubeQueryToolInput {
  const q = recipe.query as Record<string, unknown>;
  const dateParameter = recipe.recipe?.dateParameter;
  const timeDimensions: LooseTimeDimension[] = (Array.isArray(q.timeDimensions) ? q.timeDimensions as Array<Record<string, unknown>> : []).map((td) => {
    const applies = Boolean(dateRange) && (dateParameter ? td.dimension === dateParameter : true);
    const original = Array.isArray(td.dateRange) ? (td.dateRange as string[]).join(",") : td.dateRange ? String(td.dateRange) : undefined;
    const safeOriginal = original ? normaliseRecipeDateRange(original) ?? original : undefined;
    return {
      dimension: String(td.dimension),
      ...(td.granularity ? { granularity: String(td.granularity) } : {}),
      ...(applies ? { dateRange } : safeOriginal ? { dateRange: safeOriginal } : {}),
    };
  });
  // A recipe with a date parameter but no time dimension gains one when the owner named a period.
  if (dateRange && dateParameter && !timeDimensions.some((td) => td.dimension === dateParameter)) {
    timeDimensions.push({ dimension: dateParameter, dateRange });
  }
  const filters: RawFilter[] = (Array.isArray(q.filters) ? q.filters as RawFilter[] : []).map((f) => ({
    member: f.member,
    operator: f.operator,
    ...(f.values ? { values: f.values } : {}),
  }));
  // A named entity (a supplier, a person, a product) narrows the recipe's first name-like dimension.
  if (entity && Array.isArray(q.dimensions) && q.dimensions.length > 0) {
    const dims = q.dimensions as string[];
    const nameDimension = dims.find((d) => /name|contact|staff|customer|supplier|vendor|item/u.test(d)) ?? dims[0]!;
    filters.push({ member: nameDimension, operator: "contains", values: [entity] });
  }
  const order = q.order && typeof q.order === "object" && !Array.isArray(q.order)
    ? Object.entries(q.order as Record<string, "asc" | "desc">).map(([member, direction]) => ({ member, direction }))
    : undefined;
  const loose = {
    topic: sanitizeTraceText(recipe.userRequest.split(/[.?!]/u)[0]!.trim() || recipe.name, 160),
    ...(Array.isArray(q.measures) ? { measures: q.measures as string[] } : {}),
    ...(Array.isArray(q.dimensions) ? { dimensions: q.dimensions as string[] } : {}),
    ...(Array.isArray(q.segments) ? { segments: q.segments as string[] } : {}),
    ...(timeDimensions.length ? { timeDimensions } : {}),
    ...(filters.length ? { filters } : {}),
    ...(order?.length ? { order } : {}),
    ...(typeof q.limit === "number" ? { limit: q.limit } : {}),
  };
  return loose as unknown as CubeQueryToolInput;
}

const PRESENTATION_GUIDANCE: Record<NonNullable<CertifiedQuery["recipe"]>["presentation"], string> = {
  fact: "This is a single-figure answer: one or two sentences, no table, no chart.",
  list: "This is a list (people, documents, dates): present_result with the rows (relabel columns plainly), then one sentence. Never a chart.",
  table: "Show the table with present_result (the owner's asked-for top-N rows, plain column labels), lead with the top row in one sentence, then at most one further observation.",
  line: "Attach a line chart with make_chart (chartType auto, x = the time bucket, y = the main measure; extraYKeys for a second measure the owner would want) and write one or two sentences on the trend. Do not also compose a table unless the owner asked for one.",
  bar: "Attach a bar chart with make_chart (chartType bar, sort=y_desc, limit to the N the owner asked for or 10) and write one sentence naming the leader. Compose a table only if the owner asked for shares or a table.",
};

const RECIPE_TEMPLATE_TOKEN = /\{\{\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,2})\s*\|\s*(integer|number|percent|currency|date|text)\s*\}\}/gu;
const OWNER_FOLLOW_UP = /^(?!\s*(?:i can|i'll|i will|i'd|i would|happy to|want me to|would you like(?: me)? to|shall i|let me|try:)\b).{4,160}$/iu;

type RecipeAnswerFormat = "integer" | "number" | "percent" | "currency" | "date" | "text";
export type RecipeRenderOptions = Readonly<{
  currency: string;
  timezone: string;
  locale?: string;
}>;

const FORMAT_COLUMN_TYPES: Readonly<Record<RecipeAnswerFormat, ReadonlySet<TraceTableColumn["type"]>>> = {
  integer: new Set(["number"]),
  number: new Set(["number"]),
  percent: new Set(["percent"]),
  currency: new Set(["currency"]),
  date: new Set(["date", "datetime"]),
  text: new Set(["string"]),
};

function finiteNumber(value: TraceCell): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function escapeMarkdownText(value: string): string {
  return sanitizeTraceText(value, 300).replace(/[\\`*_[\]<>]/gu, "\\$&");
}

function formatRecipeCell(
  value: TraceCell,
  column: TraceTableColumn,
  format: RecipeAnswerFormat,
  options: RecipeRenderOptions,
): string | undefined {
  if (value === null || !FORMAT_COLUMN_TYPES[format].has(column.type)) return undefined;
  const locale = options.locale ?? "en-AU";
  if (format === "text") return typeof value === "string" && value.trim() ? escapeMarkdownText(value) : undefined;
  if (format === "date") {
    if (typeof value !== "string") return undefined;
    const date = /^\d{4}-\d{2}-\d{2}$/u.test(value)
      ? new Date(`${value}T12:00:00.000Z`)
      : new Date(value);
    if (!Number.isFinite(date.getTime())) return undefined;
    try {
      return new Intl.DateTimeFormat(locale, {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: options.timezone,
      }).format(date);
    } catch {
      return undefined;
    }
  }
  const numeric = finiteNumber(value);
  if (numeric === undefined) return undefined;
  if (format === "integer") {
    if (!Number.isSafeInteger(numeric)) return undefined;
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(numeric);
  }
  if (format === "number") {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(numeric);
  }
  if (format === "percent") {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(numeric)}%`;
  }
  const currency = (column.currency ?? options.currency).trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency)) return undefined;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(numeric);
  } catch {
    return undefined;
  }
}

/**
 * Renders a trusted recipe from exact cells in its first governed result row.
 * Any unknown member, incompatible column type, null, malformed placeholder,
 * or invalid static follow-up returns undefined so the existing composer owns
 * the answer instead. No partial deterministic answer is ever emitted.
 */
export function renderDeterministicRecipeAnswer(
  recipe: CertifiedQuery,
  table: Pick<StoredTableResult, "columns" | "rows">,
  options: RecipeRenderOptions,
): FinalAnswer | undefined {
  const template = recipe.recipe?.answerTemplate;
  const firstRow = table.rows[0];
  if (!template || !firstRow || template.length > 2_000) return undefined;
  const columns = new Map(table.columns.map((column) => [column.key, column]));
  let placeholderCount = 0;
  let failed = false;
  const answer = template.replace(RECIPE_TEMPLATE_TOKEN, (_token, member: string, format: RecipeAnswerFormat) => {
    placeholderCount += 1;
    const column = columns.get(member);
    if (!column || !Object.hasOwn(firstRow, member)) {
      failed = true;
      return "";
    }
    const rendered = formatRecipeCell(firstRow[member] ?? null, column, format, options);
    if (rendered === undefined) failed = true;
    return rendered ?? "";
  });
  if (failed || placeholderCount < 1 || placeholderCount > 12 || answer.includes("{{") || answer.includes("}}")) {
    return undefined;
  }
  const followUps = recipe.recipe?.followUps ?? [];
  if (
    followUps.length > 3
    || followUps.some((followUp) => !OWNER_FOLLOW_UP.test(followUp.trim()))
    || new Set(followUps.map((followUp) => followUp.trim().toLowerCase())).size !== followUps.length
  ) {
    return undefined;
  }
  const parsed = finalAnswerSchema.safeParse({
    answer: sanitizeAnswerText(answer, 8_000),
    state: "Verified",
    followUps: followUps.map((followUp) => followUp.trim()),
    assumptionsDisclosed: [],
  });
  return parsed.success ? parsed.data : undefined;
}

export async function runRecipeLane(
  input: LaneRunInput,
  recipe: CertifiedQuery,
  dateRange: string | undefined,
  entity: string | null | undefined,
): Promise<FinalAnswer | undefined> {
  const context = input.context;
  const spec = recipe.recipe;
  if (!spec) return undefined;
  await context.emit({
    type: "progress",
    status: "running",
    stage: "query",
    label: sanitizeTraceText(`Recognised question · ${recipe.name.replace(/^recipe-/u, "").replace(/-/gu, " ")}`, 160),
    detail: dateRange ? sanitizeTraceText(`Period: ${dateRange}`, 120) : undefined,
    progress: 0.2,
  });
  let result: Record<string, unknown>;
  try {
    result = await executeGovernedCubeQuery(context, recipeToolInput(recipe, dateRange, entity));
  } catch {
    return undefined;
  }
  if (result.ok !== true) return undefined;
  const rowCount = typeof result.rowCount === "number" ? result.rowCount : 0;
  // An empty period is a lead for the regular lanes (they own the diagnostics)
  // — unless the recipe declares that zero rows IS the answer (no open
  // shifts, nobody on leave): then the 80-second "why is this empty"
  // investigation would only manufacture doubt about a true negative.
  const emptyIsAnswer = rowCount === 0 && Boolean(spec.emptyAnswer);
  if (rowCount === 0 && !emptyIsAnswer) return undefined;
  if (emptyIsAnswer) context.emptyResultIsAnswer = true;

  const table = [...context.tableResults.values()].find((t) => t.resultId === result.resultId);
  if (!table) return undefined;
  const deterministicAnswer = !emptyIsAnswer
    ? renderDeterministicRecipeAnswer(recipe, table, {
      currency: input.config.currency,
      timezone: input.config.timezone,
    })
    : undefined;
  if (deterministicAnswer) return deterministicAnswer;
  const emptyGuidance = emptyIsAnswer
    ? `The result has NO rows, and for this question that is the answer: ${spec.emptyAnswer}. State it plainly for the period asked (one or two sentences), no table, no chart, no speculation about missing data or sync gaps.`
    : "";
  const composer = new Agent<V3TurnContext, typeof finalAnswerSchema>({
    name: "Albert v3 recipe composer",
    instructions: `${context.businessContext ? `${renderBusinessContextForClassifier(context.businessContext.document)}

` : ""}You are Albert. The owner asked a recognised question and the figures are already retrieved.
Compose the answer from the result below. Do not run data queries (you have none).

${todayLine(input.config.timezone)}

${emptyIsAnswer ? emptyGuidance : PRESENTATION_GUIDANCE[spec.presentation]}
${spec.answerHint && !emptyIsAnswer ? `Guidance for this question: ${spec.answerHint}` : ""}
The result's period is what was asked for; say it in the answer in plain words (e.g. "yesterday (Monday 17 August)", "July"). Numbers must come from the result cells; percentages and differences only via compose_table calculations.
state=Verified. followUps: zero to three short owner-voice questions; use [] for a self-contained answer.

${ANSWER_CONTRACT}

${renderSourceFindings(context.sourceFindings)}

${renderConnectorFreshness(context.connectorFreshness)}

# The result (resultId ${table.resultId}; use these exact column keys and zero-based row indexes)
${JSON.stringify({ caption: table.caption, columns: table.columns, rowCount: table.rowCount, rows: table.rows.slice(0, 60) })}`,
    model: input.preferences.model,
    modelSettings: laneModelSettings(input.preferences, "medium", {
      maxEffort: "medium",
      promptCacheKey: v3PromptCacheKey({
        partition: context.promptCachePartition,
        profile: "recipe-composer",
        route: context.toolRoute,
      }),
    }),
    tools: [createPresentResultTool(), createComposeTableTool(), createMakeChartTool(), createAggregateResultTool()],
    outputType: finalAnswerSchema,
  });
  try {
    const run = await input.runner.run(composer, withV3PromptCacheBoundary(input.preferences.model, [
      user(`Question: ${sanitizeTraceText(input.intent.resolvedQuestion, 600)}`),
    ]), {
      context,
      maxTurns: 6,
      signal: input.signal ?? context.signal,
    });
    // The evidence is in; if the composer ran out of turns, compose plainly
    // from it rather than re-running the pipeline.
    const answer = run.finalOutput ?? await composeFromGatheredEvidence(input);
    // A declared empty answer is a verified true negative, not "no data".
    if (answer && emptyIsAnswer && answer.state !== "Verified") return { ...answer, state: "Verified" };
    return answer;
  } catch (error) {
    if (error instanceof Error && /max turns/iu.test(error.message)) return composeFromGatheredEvidence(input);
    throw error;
  }
}
