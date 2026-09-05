/**
 * The daily look (ADR 0133). Once a day the imessage-bridge runs one Luna
 * Max turn on the Omni harness that reads the last 24 hours across the
 * connected tools and names up to three things worth looking at next; the
 * homepage's "What to look at next" panel shows them. This module is the
 * pure, shared half: the cadence rule, the message the turn receives, the
 * parser for the answer it returns, and the labels the web surface reads.
 * No I/O, no model.
 */
import type { TraceConnector } from "../../../packages/shared/src/index.js";
import {
  detectDomains,
  inferMove,
  MAX_RECOMMENDATIONS,
  normalizeQuestion,
  type RecommendedQuestion,
} from "./playbook.js";
import {
  domainForTool,
  normaliseRecommendedTools,
  RECOMMENDED_TOOL_NAMES,
  toolForDomain,
  toolFromLabel,
} from "./tools.js";

/** The standing conversation the daily turns run in; hidden from history like `Alerts ·`. */
export const DAILY_BRIEF_CONVERSATION_TITLE = "Daily look · last 24 hours" as const;
export const DAILY_BRIEF_CONVERSATION_TITLE_PREFIX = "Daily look ·" as const;

/** Luna at max effort on the Omni harness, per the owner. */
export const DAILY_BRIEF_MODEL = "gpt-5.6-luna" as const;
export const DAILY_BRIEF_EFFORT = "max" as const;

/** Local hour from which a new day's look may run, once the overnight syncs have landed. */
export const DAILY_BRIEF_FROM_HOUR = 6;

export const DAILY_BRIEF_MAX_ITEMS = MAX_RECOMMENDATIONS;

/** A stored brief names its generator `omni:<model>`; the chat-history playbook and its Luna pass never do. */
export const DAILY_BRIEF_MODEL_PREFIX = "omni:" as const;

/** The why a row falls back to when the model gave the sentence and nothing more. */
export const DAILY_BRIEF_DEFAULT_WHY = "From this morning's look at the last 24 hours.";

export function dailyBriefModelLabel(model: string): string {
  return `${DAILY_BRIEF_MODEL_PREFIX}${model.trim()}`;
}

export function isDailyBriefModel(model: string | null | undefined): boolean {
  return typeof model === "string" && model.startsWith(DAILY_BRIEF_MODEL_PREFIX);
}

function parts(date: Date, timezone: string, options: Intl.DateTimeFormatOptions): Map<string, string> {
  const formatted = new Map<string, string>();
  try {
    for (const part of new Intl.DateTimeFormat("en-AU", { timeZone: timezone, ...options }).formatToParts(date)) {
      formatted.set(part.type, part.value);
    }
  } catch {
    for (const part of new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", ...options }).formatToParts(date)) {
      formatted.set(part.type, part.value);
    }
  }
  return formatted;
}

/** The calendar day in the tenant's zone, as `YYYY-MM-DD`. */
export function localDateKey(date: Date, timezone: string): string {
  const found = parts(date, timezone, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${found.get("year")}-${found.get("month")}-${found.get("day")}`;
}

export function localHour(date: Date, timezone: string): number {
  const hour = Number(parts(date, timezone, { hour: "numeric", hourCycle: "h23" }).get("hour"));
  return Number.isFinite(hour) ? hour : date.getUTCHours();
}

/** "Wed 2 Sep, 6:05 am" in the tenant's zone. */
export function formatLocalMoment(date: Date, timezone: string): string {
  const found = parts(date, timezone, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const dayPeriod = (found.get("dayPeriod") ?? "").toLowerCase().replace(/\./gu, "");
  return `${found.get("weekday")} ${found.get("day")} ${found.get("month")}, ${found.get("hour")}:${found.get("minute")} ${dayPeriod}`.trim();
}

/** "Wed 2 Sep" in the tenant's zone. */
export function formatLocalDay(date: Date, timezone: string): string {
  const found = parts(date, timezone, { weekday: "short", day: "numeric", month: "short" });
  return `${found.get("weekday")} ${found.get("day")} ${found.get("month")}`;
}

/**
 * True once per local day, from `fromHour`, until that day's look is
 * stored. A bridge that was down at six runs the look as soon as it is
 * back; a look stored today is never repeated today.
 */
export function dailyBriefDue(input: Readonly<{
  now: Date;
  timezone: string;
  lastGeneratedAt: string | null;
  fromHour?: number;
}>): boolean {
  const fromHour = input.fromHour ?? DAILY_BRIEF_FROM_HOUR;
  if (localHour(input.now, input.timezone) < fromHour) return false;
  if (!input.lastGeneratedAt) return true;
  const last = new Date(input.lastGeneratedAt);
  if (Number.isNaN(last.getTime())) return true;
  return localDateKey(last, input.timezone) !== localDateKey(input.now, input.timezone);
}

/** The title a stored row points back to: "Daily look · Wed 2 Sep". */
export function dailyBriefTitle(now: Date, timezone: string): string {
  return `${DAILY_BRIEF_CONVERSATION_TITLE_PREFIX} ${formatLocalDay(now, timezone)}`;
}

function listInEnglish(items: readonly string[], conjunction = "and"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

/** How far a tool's data reaches, as the control plane reports it; `dataThrough` is null while nothing has landed. */
export type DailyBriefFreshness = Readonly<{
  connector: string;
  domain: string;
  dataThrough: string | null;
}>;

function freshnessLine(freshness: readonly DailyBriefFreshness[], timezone: string): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const entry of freshness) {
    const tool = normaliseRecommendedTools([entry.connector])[0];
    if (!tool) continue;
    const key = `${tool} ${entry.domain}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const at = entry.dataThrough ? new Date(entry.dataThrough) : null;
    const label = `${RECOMMENDED_TOOL_NAMES[tool]} ${entry.domain}`.trim();
    parts.push(at && !Number.isNaN(at.getTime())
      ? `${label} to ${formatLocalMoment(at, timezone)}`
      : `${label}: no data yet`);
    if (parts.length >= 10) break;
  }
  return parts.length > 0 ? `Data reaches: ${parts.join("; ")}.` : "";
}

/**
 * The owner's message for the daily turn. It names the window and the
 * connected tools, says what "interesting" means, rules out missing data
 * as a finding, and fixes the answer's shape so the bridge can read it
 * back without a second model call.
 */
export function dailyBriefMessage(input: Readonly<{
  now: Date;
  timezone: string;
  connectorKeys: readonly string[];
  freshness?: readonly DailyBriefFreshness[];
}>): string {
  const tools = normaliseRecommendedTools(input.connectorKeys);
  const names = tools.map((tool) => RECOMMENDED_TOOL_NAMES[tool]);
  const from = new Date(input.now.getTime() - 24 * 60 * 60 * 1000);
  const window = `from ${formatLocalMoment(from, input.timezone)} to ${formatLocalMoment(input.now, input.timezone)}, ${input.timezone}`;
  const toolList = names.length > 0 ? ` across ${listInEnglish(names)}` : "";
  const toolRule = names.length > 0 ? ` (${listInEnglish(names, "or")})` : "";
  const reaches = freshnessLine(input.freshness ?? [], input.timezone);
  return [
    `Look at the last 24 hours (${window})${toolList} and tell me whether anything interesting happened.`,
    "",
    "Cover what those tools can answer for that window: takings and transaction counts against the same weekday over the previous four weeks; category, product or brand mix that moved; new, returning or big-spending customers; refunds, discounts and till counts; invoices raised and paid, bills and bank movements; hours worked and labour against takings; stock that ran out or came in; workshop jobs opened, finished or overdue. Compare with the usual pattern for that weekday, not just the day before.",
    "",
    "Interesting means a clear move against the usual pattern, a first, a record, an outlier, or something that stopped. An ordinary day is not interesting: if nothing stands out, say so and list nothing.",
    "",
    ...(reaches ? [reaches] : []),
    "Each tool's data only reaches so far: before judging a tool, check the latest date its data reaches and judge it only up to there. A tool with no rows in the window has simply not synced that far yet. Missing data, empty results and sync state are never a finding: do not mention them, and never read a missing tool as something that stopped.",
    "",
    "Answer in exactly this shape and nothing else:",
    "",
    "Verdict: one sentence, at most 28 words, on the last 24 hours as a whole.",
    "- [Tool] One sentence, at most 24 words, that states what happened with its figure and asks the question I should look at next? — a few words on why it matters.",
    "",
    `Up to three lines starting with "- [", fewer if fewer things are interesting; Tool is the tool the figure came from${toolRule}; every figure must come from a query you ran in this turn; no headings, tables, charts, links or follow-up questions.`,
  ].join("\n");
}

export type ParsedDailyBrief = Readonly<{
  verdict: string;
  items: readonly RecommendedQuestion[];
}>;

const ITEM_LINE = /^\s*(?:[-*•]|\d{1,2}[.)])\s*(?:\*\*)?\s*\[\s*([^\]\n]{2,40}?)\s*\]\s*(?:\*\*)?\s*[:–—-]?\s*(.+?)\s*$/u;
const VERDICT_LINE = /^\s*(?:\*\*)?\s*verdict\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.+?)\s*$/iu;
const PLACEHOLDER = /one sentence, at most|a few words on why|<\s*tool\s*>|\bwhat happened with its figure\b/iu;

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\[([^\]\n]+)\]\((?:[^)\s]+)\)/gu, "$1")
    .replace(/[*_`~]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function dailyBriefId(question: string, index: number): string {
  let hash = 0;
  for (const char of question) hash = (hash * 33 + char.charCodeAt(0)) % 1_000_003;
  return `daily-${index + 1}-${hash.toString(16).padStart(5, "0")}`;
}

function endSentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

function splitSentence(rest: string): Readonly<{ question: string; why: string }> {
  const cleaned = stripInlineMarkdown(rest);
  const mark = cleaned.indexOf("?");
  if (mark >= 0) {
    return Object.freeze({
      question: cleaned.slice(0, mark + 1).trim(),
      why: cleaned.slice(mark + 1).replace(/^[\s:–—-]+/u, "").trim(),
    });
  }
  const dash = cleaned.search(/\s+[–—]\s+|\s+-\s+/u);
  if (dash >= 0) {
    return Object.freeze({
      question: endSentence(cleaned.slice(0, dash)),
      why: cleaned.slice(dash).replace(/^[\s:–—-]+/u, "").trim(),
    });
  }
  return Object.freeze({ question: endSentence(cleaned), why: "" });
}

function fallbackVerdict(text: string): string {
  for (const raw of text.split("\n")) {
    const line = stripInlineMarkdown(raw);
    if (!line || /^(?:[-*•]|\d{1,2}[.)])\s/u.test(raw.trim()) || /^[#>|]/u.test(raw.trim())) continue;
    if (VERDICT_LINE.test(raw) || PLACEHOLDER.test(line)) continue;
    if (line.length > 280) continue;
    return line;
  }
  return "";
}

/**
 * Reads the daily answer back into the panel's rows. The mandated shape is
 * read first (a `Verdict:` line and `- [Tool] sentence — why` lines); when
 * the model ignored it, the harness's own follow-ups become the rows and
 * the first plain line becomes the verdict. Anything the model echoed from
 * the template is dropped. At most three rows, one per question.
 */
export function parseDailyBriefAnswer(input: Readonly<{
  text: string;
  followUps?: readonly string[];
  connectorKeys: readonly string[];
  source: Readonly<{ conversationId: string | null; title: string }>;
}>): ParsedDailyBrief {
  const items: RecommendedQuestion[] = [];
  const seen = new Set<string>();
  let verdict = "";
  const push = (question: string, why: string, tool: TraceConnector | null) => {
    if (items.length >= DAILY_BRIEF_MAX_ITEMS) return;
    const key = normalizeQuestion(question);
    if (!key || question.length < 12 || seen.has(key) || PLACEHOLDER.test(question)) return;
    seen.add(key);
    // The named tool leads when the sentence agrees with it or names no domain at all.
    const detected = detectDomains(question, why);
    const natural = tool ? domainForTool(tool) : null;
    const domain = natural && (detected.length === 0 || detected.includes(natural)) ? natural : detected[0] ?? "sales";
    const resolvedWhy = why.length >= 8 ? why.slice(0, 200) : DAILY_BRIEF_DEFAULT_WHY;
    items.push(Object.freeze({
      id: dailyBriefId(question, items.length),
      question: question.slice(0, 200),
      why: resolvedWhy,
      move: inferMove(question),
      domain,
      tool: tool ?? toolForDomain(domain, input.connectorKeys),
      fromTitle: input.source.title.slice(0, 120),
      fromConversationId: input.source.conversationId,
    }));
  };

  for (const line of input.text.split("\n")) {
    const asVerdict = VERDICT_LINE.exec(line);
    if (asVerdict && !verdict) {
      const candidate = stripInlineMarkdown(asVerdict[1] ?? "");
      if (candidate && !PLACEHOLDER.test(candidate)) verdict = candidate.slice(0, 280);
      continue;
    }
    const asItem = ITEM_LINE.exec(line);
    if (!asItem) continue;
    const label = (asItem[1] ?? "").trim();
    if (/^tool$/iu.test(label)) continue;
    const { question, why } = splitSentence(asItem[2] ?? "");
    if (PLACEHOLDER.test(why)) continue;
    push(question, why, toolFromLabel(label, input.connectorKeys));
  }

  if (items.length === 0) {
    for (const followUp of input.followUps ?? []) {
      const question = stripInlineMarkdown(followUp);
      push(/[.!?]$/u.test(question) ? question : `${question}?`, "", null);
    }
  }
  if (!verdict) verdict = fallbackVerdict(input.text);

  return Object.freeze({ verdict, items: Object.freeze(items) });
}
