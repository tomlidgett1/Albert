import type { CertifiedQuery } from "../agent-config/loader.js";
import type { CubeQuery } from "../cube/types.js";
import {
  sanitizeAnswerText,
  sanitizeTraceText,
  type TraceCell,
  type TraceTableColumn,
} from "../../../shared/src/index.js";

const RELATIVE_RANGE = /^(?:today|yesterday|tomorrow|this (?:week|month|quarter|year)|last (?:week|month|quarter|year)|next (?:week|month)|last \d{1,3} (?:days|weeks|months|quarters|years)|from \d+ (?:days|weeks|months|years) ago to now|\d{4}-\d{2}-\d{2},\d{4}-\d{2}-\d{2}|(?:last |this |in )?[a-z]{3,9}\.?(?: \d{4})?)$/iu;
const WORD_NUMBERS: Readonly<Record<string, string>> = Object.freeze({
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
  seven: "7", eight: "8", nine: "9", ten: "10", twelve: "12",
});

export function normaliseRecipeDateRange(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().replace(/\s+/gu, " ").replace(/\s*,\s*/gu, ",")
    .replace(/^(last|next) (one|two|three|four|five|six|seven|eight|nine|ten|twelve) /iu, (_match, direction: string, word: string) => `${direction} ${WORD_NUMBERS[word.toLowerCase()]} `)
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
  return /^\d{4}-\d{2}-\d{2},/u.test(trimmed) ? trimmed : trimmed.toLowerCase();
}

const MONTH_NUMBER: Readonly<Record<string, number>> = Object.freeze({
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
});
const WEEKDAY_NUMBER: Readonly<Record<string, number>> = Object.freeze({
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
});

function tenantCivilDate(timezone = "Australia/Melbourne", now = new Date()): Readonly<{
  year: number; month: number; day: number; weekday: number;
}> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const year = Number(value("year"));
  const month = Number(value("month"));
  const day = Number(value("day"));
  const weekdayName = value("weekday").toLowerCase();
  const weekday = weekdayName.startsWith("sun") ? 0
    : weekdayName.startsWith("mon") ? 1
    : weekdayName.startsWith("tue") ? 2
    : weekdayName.startsWith("wed") ? 3
    : weekdayName.startsWith("thu") ? 4
    : weekdayName.startsWith("fri") ? 5
    : 6;
  return { year, month, day, weekday };
}

function isoFromCivil(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function resolveNamedWeekday(which: "last" | "this", weekday: string, timezone = "Australia/Melbourne"): string | undefined {
  const wanted = WEEKDAY_NUMBER[weekday];
  if (wanted === undefined) return undefined;
  const today = tenantCivilDate(timezone);
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
  if (which === "last") {
    let delta = wanted - today.weekday;
    if (delta >= 0) delta -= 7;
    const resolved = new Date(todayUtc + delta * 86_400_000);
    return isoFromCivil(resolved.getUTCFullYear(), resolved.getUTCMonth() + 1, resolved.getUTCDate());
  }
  const mondayOffset = (today.weekday + 6) % 7;
  const wantedMondayOffset = (wanted + 6) % 7;
  const targetUtc = todayUtc - mondayOffset * 86_400_000 + wantedMondayOffset * 86_400_000;
  const resolved = new Date(targetUtc);
  return isoFromCivil(resolved.getUTCFullYear(), resolved.getUTCMonth() + 1, resolved.getUTCDate());
}

export function extractRecipeDateRange(message: string): string | undefined {
  const text = message.trim().toLowerCase().replace(/\s+/gu, " ");
  const explicitPair = text.match(/\b(\d{4}-\d{2}-\d{2})\s*(?:,|to|through|until)\s*(\d{4}-\d{2}-\d{2})\b/u);
  if (explicitPair) return normaliseRecipeDateRange(`${explicitPair[1]},${explicitPair[2]}`);
  const singleIso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/u);
  if (singleIso) return `${singleIso[1]},${singleIso[1]}`;
  const namedDate = text.match(/\b([0-3]?\d)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/u);
  if (namedDate) {
    const day = Number(namedDate[1]);
    const month = MONTH_NUMBER[namedDate[2]!]!;
    const year = Number(namedDate[3]);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (day >= 1 && day <= lastDay) {
      const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      return `${iso},${iso}`;
    }
  }
  const fiscal = text.match(/\b(?:this financial year|current financial year|financial year to date|fytd|this fy|last financial year|previous financial year|last fy)\b/u);
  if (fiscal) return normaliseRecipeDateRange(fiscal[0]);
  const rolling = text.match(/\b(?:last|next)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|twelve|\d{1,3})\s+(?:days?|weeks?|months?|quarters?|years?)\b/u);
  if (rolling) return normaliseRecipeDateRange(rolling[0]);
  const relative = text.match(/\b(?:today|yesterday|tomorrow|this week|last week|next week|this month|last month|next month|this quarter|last quarter|this year|last year)\b/u);
  if (relative) return normaliseRecipeDateRange(relative[0]);
  const namedWeekday = text.match(/\b(last|this)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/u);
  if (namedWeekday) {
    const iso = resolveNamedWeekday(namedWeekday[1] as "last" | "this", namedWeekday[2]!);
    return iso ? `${iso},${iso}` : undefined;
  }
  const namedMonth = text.match(/\b(?:(?:last|this|in)\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+\d{4})?\b/u);
  return namedMonth ? normaliseRecipeDateRange(namedMonth[0]) : undefined;
}

/** Cube dateRange plus an owner-facing label that does not invent figures. */
export function extractRecipePeriod(message: string): Readonly<{ dateRange: string; label: string }> | undefined {
  const dateRange = extractRecipeDateRange(message);
  if (!dateRange) return undefined;
  const text = message.trim().toLowerCase().replace(/\s+/gu, " ");
  const weekday = text.match(/\b((?:last|this)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/u);
  if (weekday) {
    const label = weekday[1]!.replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gu, (day) => (
      `${day.charAt(0).toUpperCase()}${day.slice(1)}`
    ));
    return { dateRange, label };
  }
  const fiscal = text.match(/\b(?:this financial year|current financial year|financial year to date|fytd|this fy|last financial year|previous financial year|last fy)\b/u);
  if (fiscal) return { dateRange, label: fiscal[0] };
  const rolling = text.match(/\b(?:last|next)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|twelve|\d{1,3})\s+(?:days?|weeks?|months?|quarters?|years?)\b/u);
  if (rolling) return { dateRange, label: rolling[0] };
  const relative = text.match(/\b(?:today|yesterday|tomorrow|this week|last week|next week|this month|last month|next month|this quarter|last quarter|this year|last year)\b/u);
  if (relative) return { dateRange, label: relative[0] };
  const namedMonth = text.match(/\b((?:(?:last|this|in)\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+\d{4})?)\b/u);
  if (namedMonth) return { dateRange, label: recipePeriodLabel(namedMonth[1]!) ?? namedMonth[1]! };
  return { dateRange, label: recipePeriodLabel(dateRange) ?? dateRange };
}

export function recipePeriodLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const pair = value.match(/^(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})$/u);
  if (pair) return pair[1] === pair[2] ? pair[1] : `${pair[1]} to ${pair[2]}`;
  const namedMonth = value.match(/^(?:in |last |this )?([a-z]{3,9})(?: (\d{4}))?$/iu);
  const monthName = namedMonth?.[1]?.toLowerCase();
  if (monthName && MONTH_NUMBER[monthName]) {
    const pretty = `${monthName.charAt(0).toUpperCase()}${monthName.slice(1)}`;
    return namedMonth?.[2] ? `${pretty} ${namedMonth[2]}` : pretty;
  }
  return value;
}

type RawFilter = { member: string; operator: string; values?: string[] };
type LooseTimeDimension = { dimension: string; granularity?: string; dateRange?: string };

export function recipeCubeQuery(
  recipe: CertifiedQuery,
  dateRange: string | undefined,
  entity?: string | null,
): Readonly<{ topic: string; query: CubeQuery }> {
  const source = recipe.query as Record<string, unknown>;
  const dateParameter = recipe.recipe?.dateParameter;
  const timeDimensions: LooseTimeDimension[] = (Array.isArray(source.timeDimensions) ? source.timeDimensions as Array<Record<string, unknown>> : []).map((dimension) => {
    const applies = Boolean(dateRange) && (dateParameter ? dimension.dimension === dateParameter : true);
    const original = Array.isArray(dimension.dateRange)
      ? (dimension.dateRange as string[]).join(",")
      : dimension.dateRange ? String(dimension.dateRange) : undefined;
    const safeOriginal = original ? normaliseRecipeDateRange(original) ?? original : undefined;
    return {
      dimension: String(dimension.dimension),
      ...(dimension.granularity ? { granularity: String(dimension.granularity) } : {}),
      ...(applies ? { dateRange } : safeOriginal ? { dateRange: safeOriginal } : {}),
    };
  });
  if (dateRange && dateParameter && !timeDimensions.some((dimension) => dimension.dimension === dateParameter)) {
    timeDimensions.push({ dimension: dateParameter, dateRange });
  }
  const filters: RawFilter[] = (Array.isArray(source.filters) ? source.filters as RawFilter[] : []).map((filter) => ({
    member: filter.member,
    operator: filter.operator,
    ...(filter.values ? { values: filter.values } : {}),
  }));
  if (entity && Array.isArray(source.dimensions) && source.dimensions.length > 0) {
    const dimensions = source.dimensions as string[];
    const nameDimension = dimensions.find((dimension) => /name|contact|staff|customer|supplier|vendor|item/u.test(dimension))
      ?? dimensions[0]!;
    filters.push({ member: nameDimension, operator: "contains", values: [entity] });
  }
  const order = source.order && typeof source.order === "object" && !Array.isArray(source.order)
    ? source.order as Record<string, "asc" | "desc">
    : undefined;
  return Object.freeze({
    topic: sanitizeTraceText(recipe.userRequest.split(/[.?!]/u)[0]!.trim() || recipe.name, 160),
    query: Object.freeze({
      ...(Array.isArray(source.measures) ? { measures: source.measures as string[] } : {}),
      ...(Array.isArray(source.dimensions) ? { dimensions: source.dimensions as string[] } : {}),
      ...(Array.isArray(source.segments) ? { segments: source.segments as string[] } : {}),
      ...(timeDimensions.length ? { timeDimensions: timeDimensions as CubeQuery["timeDimensions"] } : {}),
      ...(filters.length ? { filters: filters as CubeQuery["filters"] } : {}),
      ...(order && Object.keys(order).length ? { order } : {}),
      ...(typeof source.limit === "number" ? { limit: source.limit } : {}),
    }),
  });
}

const RECIPE_TEMPLATE_TOKEN = /\{\{\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,2})\s*\|\s*(integer|number|percent|currency|date|text)\s*\}\}/gu;
const RECIPE_PERIOD_TOKEN = /\{\{\s*period\s*\}\}/gu;
const HAS_RECIPE_PERIOD_TOKEN = /\{\{\s*period\s*\}\}/u;
export const RECIPE_ROWS_MEMBER = "recipe.rows";
const RECIPE_ROWS_COLUMN: TraceTableColumn = Object.freeze({
  key: RECIPE_ROWS_MEMBER,
  label: "Rows",
  type: "number",
});
const OWNER_FOLLOW_UP = /^(?!\s*(?:i can|i'll|i will|i'd|i would|happy to|want me to|would you like(?: me)? to|shall i|let me|try:)\b).{4,160}$/iu;

type RecipeAnswerFormat = "integer" | "number" | "percent" | "currency" | "date" | "text";
export type RecipeRenderOptions = Readonly<{
  currency: string;
  timezone: string;
  locale?: string;
  periodLabel?: string;
}>;
export type DeterministicRecipeAnswer = Readonly<{
  answer: string;
  state: "Verified";
  followUps: readonly string[];
  assumptionsDisclosed: readonly string[];
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
  return sanitizeTraceText(value, 300).replace(/[\\`*_\[\]<>]/gu, "\\$&");
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
        day: "numeric", month: "short", year: "numeric", timeZone: options.timezone,
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
  if (format === "number") return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(numeric);
  if (format === "percent") return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(numeric)}%`;
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

function ownerFollowUps(recipe: CertifiedQuery): readonly string[] | undefined {
  const followUps = recipe.recipe?.followUps ?? [];
  if (
    followUps.length > 3
    || followUps.some((followUp) => !OWNER_FOLLOW_UP.test(followUp.trim()))
    || new Set(followUps.map((followUp) => followUp.trim().toLowerCase())).size !== followUps.length
  ) return undefined;
  return followUps.map((followUp) => followUp.trim());
}

function finishDeterministicAnswer(
  answer: string,
  followUps: readonly string[],
): DeterministicRecipeAnswer | undefined {
  const sanitized = sanitizeAnswerText(answer, 8_000);
  if (!sanitized.trim()) return undefined;
  return Object.freeze({
    answer: sanitized,
    state: "Verified",
    followUps: Object.freeze([...followUps]),
    assumptionsDisclosed: Object.freeze([]),
  });
}

export function renderDeterministicRecipeEmptyAnswer(
  recipe: CertifiedQuery,
  options: RecipeRenderOptions,
): DeterministicRecipeAnswer | undefined {
  const template = recipe.recipe?.emptyAnswer?.trim();
  const followUps = ownerFollowUps(recipe);
  if (!template || !followUps || template.length > 2_000) return undefined;
  if (HAS_RECIPE_PERIOD_TOKEN.test(template) && !options.periodLabel) return undefined;
  const answer = template.replace(RECIPE_PERIOD_TOKEN, () => escapeMarkdownText(options.periodLabel ?? ""));
  if (answer.includes("{{") || answer.includes("}}")) return undefined;
  return finishDeterministicAnswer(answer, followUps);
}

export function renderDeterministicRecipeAnswer(
  recipe: CertifiedQuery,
  table: Readonly<{
    columns: readonly TraceTableColumn[];
    rows: readonly Readonly<Record<string, TraceCell>>[];
  }>,
  options: RecipeRenderOptions,
): DeterministicRecipeAnswer | undefined {
  const template = recipe.recipe?.answerTemplate;
  const firstRow = table.rows[0];
  const followUps = ownerFollowUps(recipe);
  if (!template || !followUps || template.length > 2_000) return undefined;
  if (!firstRow && !template.includes(RECIPE_ROWS_MEMBER)) return undefined;
  const columns = new Map(table.columns.map((column) => [column.key, column]));
  let placeholderCount = 0;
  let failed = false;
  if (HAS_RECIPE_PERIOD_TOKEN.test(template) && !options.periodLabel) return undefined;
  const withPeriod = template.replace(RECIPE_PERIOD_TOKEN, () => escapeMarkdownText(options.periodLabel ?? ""));
  const answer = withPeriod.replace(RECIPE_TEMPLATE_TOKEN, (_token, member: string, format: RecipeAnswerFormat) => {
    placeholderCount += 1;
    if (member === RECIPE_ROWS_MEMBER) {
      if (format !== "integer") {
        failed = true;
        return "";
      }
      const rendered = formatRecipeCell(table.rows.length, RECIPE_ROWS_COLUMN, format, options);
      if (rendered === undefined) failed = true;
      return rendered ?? "";
    }
    const column = columns.get(member);
    if (!firstRow || !column || !Object.hasOwn(firstRow, member)) {
      failed = true;
      return "";
    }
    const rendered = formatRecipeCell(firstRow[member] ?? null, column, format, options);
    if (rendered === undefined) failed = true;
    return rendered ?? "";
  });
  if (failed || placeholderCount < 1 || placeholderCount > 12 || answer.includes("{{") || answer.includes("}}")) return undefined;
  const singular = table.rows.length === 1
    ? answer.replace(/\*\*1 ([^*]+?)s\*\*/u, "**1 $1**")
    : answer;
  return finishDeterministicAnswer(singular, followUps);
}
