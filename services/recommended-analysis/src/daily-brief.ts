/**
 * The daily look (ADRs 0133/0137). Every hour the imessage-bridge runs one Luna
 * Max turn on the Omni harness that reads the last 24 hours across the
 * connected tools and names up to three things worth looking at next; the
 * homepage's "What to look at next" panel shows them. This module is the
 * pure, shared half: cadence and freshness, the message the turn receives, the
 * parser for the answer it returns, and the labels the web surface reads.
 * No I/O, no model.
 */
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
  toolFromLabel,
} from "./tools.js";

/** The standing conversation the daily turns run in; hidden from history like `Alerts ·`. */
export const DAILY_BRIEF_CONVERSATION_TITLE = "Daily look · last 24 hours" as const;
export const DAILY_BRIEF_CONVERSATION_TITLE_PREFIX = "Daily look ·" as const;

/** Luna at max effort on the Omni harness, per the owner. */
export const DAILY_BRIEF_MODEL = "gpt-5.6-luna" as const;
export const DAILY_BRIEF_EFFORT = "max" as const;

export const DAILY_BRIEF_WINDOW_MS = 24 * 60 * 60_000;
export const DAILY_BRIEF_REFRESH_MS = 60 * 60_000;
/** Bound stale observations even when generation or the network fails. */
export const DAILY_BRIEF_MAX_AGE_MS = 2 * DAILY_BRIEF_REFRESH_MS;
export const DAILY_BRIEF_VERSION_PREFIX = "omni:daily-v2:";

export const DAILY_BRIEF_MAX_ITEMS = MAX_RECOMMENDATIONS;

/** A stored brief names its generator `omni:<model>`; the chat-history playbook and its Luna pass never do. */
export const DAILY_BRIEF_MODEL_PREFIX = "omni:" as const;

/** The why a row falls back to when the model gave the sentence and nothing more. */
export const DAILY_BRIEF_DEFAULT_WHY = "From the latest look at the last 24 hours.";

export function dailyBriefModelLabel(model: string): string {
  return `${DAILY_BRIEF_VERSION_PREFIX}${model.trim()}`;
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

/** Refresh the rolling window hourly; a missing/invalid look recovers at any hour. */
export function dailyBriefDue(input: Readonly<{
  now: Date;
  lastGeneratedAt: string | null;
  refreshMs?: number;
}>): boolean {
  if (!input.lastGeneratedAt) return true;
  const age = input.now.getTime() - Date.parse(input.lastGeneratedAt);
  return !Number.isFinite(age) || age < 0 || age >= (input.refreshMs ?? DAILY_BRIEF_REFRESH_MS);
}

export function dailyBriefWindow(now: Date): Readonly<{ windowStart: string; windowEnd: string }> {
  return { windowStart: new Date(now.getTime() - DAILY_BRIEF_WINDOW_MS).toISOString(), windowEnd: now.toISOString() };
}

export function isFreshDailyBrief(input: Readonly<{
  model: string;
  generatedAt: string;
  windowStart?: string | null;
  windowEnd?: string | null;
}>, now = new Date()): boolean {
  if (!input.model.startsWith(DAILY_BRIEF_VERSION_PREFIX)) return false;
  const start = Date.parse(input.windowStart ?? "");
  const end = Date.parse(input.windowEnd ?? "");
  const generated = Date.parse(input.generatedAt);
  const age = now.getTime() - end;
  return end - start === DAILY_BRIEF_WINDOW_MS && age >= 0 && age < DAILY_BRIEF_MAX_AGE_MS
    && generated >= end && generated <= now.getTime();
}

export function dailyBriefAsk(item: RecommendedQuestion, window: Readonly<{ windowStart: string; windowEnd: string; timezone: string }>): string {
  return `${item.question}\n\nInvestigate the 24-hour period from ${window.windowStart} to ${window.windowEnd} (${window.timezone}). The daily look found: ${item.why} Verify this against the source data and explain what needs attention in plain language.`;
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
  const from = new Date(input.now.getTime() - DAILY_BRIEF_WINDOW_MS);
  const window = `from ${formatLocalMoment(from, input.timezone)} to ${formatLocalMoment(input.now, input.timezone)}, ${input.timezone}`;
  const toolList = names.length > 0 ? ` across ${listInEnglish(names)}` : "";
  const toolRule = names.length > 0 ? ` (${listInEnglish(names, "or")})` : "";
  const reaches = freshnessLine(input.freshness ?? [], input.timezone);
  return [
    `Look at the last 24 hours (${window})${toolList} and tell me whether anything interesting happened.`,
    `Use this exact event-time window: [${from.toISOString()}, ${input.now.toISOString()}). Do not move it backwards to the latest available data. Previous conversations are not evidence for this run.`,
    "",
    "Prioritise what could change the owner's next decision: a material sales change, overdue money that changed in this window, unusual refunds or discounts, labour out of line with trading, or evidenced stock shortages. Compare like-for-like 24-hour windows at the same local times and weekdays over the previous four weeks. Never compare a partial day with whole days. A category being the largest, or stock moving out during normal sales, is not by itself unusual or a shortage. Stock risk requires current stock or cover evidence.",
    "",
    "Interesting means a clear move against the usual pattern, a first, a record, an outlier, or something that stopped. An ordinary day is not interesting: if nothing stands out, say so and list nothing.",
    "",
    ...(reaches ? [reaches] : []),
    "Before judging a tool, verify coverage of the requested window. Older data may supply a comparable baseline but never the current finding. Missing data, empty results and sync state are never a finding. Empty results alone cannot distinguish no activity from an incomplete sync; omit unsupported comparisons. Never turn a source freshness gap into falling sales, a stockout or stopped activity.",
    "",
    "Answer in exactly this shape and nothing else:",
    "",
    "Verdict: one sentence, at most 28 words, on the last 24 hours as a whole.",
    "- [Tool] Short headline | Self-contained question? | Evidence and why it matters.",
    "",
    "The headline is the homepage display: 4–10 plain-language words, at most 90 characters, with no figures, acronyms, semicolons or 'should we'. State the main issue at a business level. Keep the detailed question under 200 characters and the evidence under 200 characters. Put the measured current value and comparable baseline in the evidence only. Separate the three fields with ' | '. Use one row per distinct issue; do not split one sales change into three rows. Rank by material impact, fewer than three when appropriate.",
    "",
    `Up to three lines starting with "- [", fewer if fewer things are interesting; Tool is the tool the evidence came from${toolRule}; every figure must come from a query you ran in this turn; no headings, tables, charts, links or extra follow-up questions.`,
  ].join("\n");
}

export type ParsedDailyBrief = Readonly<{
  verdict: string;
  items: readonly RecommendedQuestion[];
  valid: boolean;
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

/** Only the explicit headline/question/evidence shape can publish a current look. */
export function parseDailyBriefAnswer(input: Readonly<{
  text: string;
  followUps?: readonly string[];
  connectorKeys: readonly string[];
  source: Readonly<{ conversationId: string | null; title: string }>;
}>): ParsedDailyBrief {
  const items: RecommendedQuestion[] = [];
  const seen = new Set<string>();
  let verdict = "";
  let candidateCount = 0;
  for (const line of input.text.split("\n")) {
    const asVerdict = VERDICT_LINE.exec(line);
    if (asVerdict && !verdict) {
      const candidate = stripInlineMarkdown(asVerdict[1] ?? "");
      if (candidate && !PLACEHOLDER.test(candidate) && candidate.length <= 280) verdict = candidate;
      continue;
    }
    const asItem = ITEM_LINE.exec(line);
    if (!asItem) continue;
    candidateCount += 1;
    if (items.length >= DAILY_BRIEF_MAX_ITEMS) continue;
    const tool = toolFromLabel(asItem[1] ?? "", input.connectorKeys);
    const fields = (asItem[2] ?? "").split(/\s+\|\s+/u).map(stripInlineMarkdown);
    if (!tool || fields.length !== 3) continue;
    const [title, question, why] = fields as [string, string, string];
    if (title.length < 8 || title.length > 90 || title.split(/\s+/u).length > 12
      || /[\d$%€£;]|\b(?:AOV|KPI|GMROI|SKU|should we)\b/iu.test(title)
      || question.length < 12 || question.length > 200 || !question.endsWith("?")
      || why.length < 8 || why.length > 200
      || fields.some((field) => PLACEHOLDER.test(field))) continue;
    const key = normalizeQuestion(question);
    const titleKey = normalizeQuestion(title);
    if (seen.has(key) || seen.has(titleKey)) continue;
    seen.add(key);
    seen.add(titleKey);
    const detected = detectDomains(title, question, why);
    const natural = domainForTool(tool);
    const domain = detected.length === 0 || detected.includes(natural) ? natural : detected[0]!;
    items.push(Object.freeze({
      id: dailyBriefId(question, items.length),
      title,
      question,
      why,
      move: inferMove(question),
      domain,
      tool,
      fromTitle: input.source.title.slice(0, 120),
      fromConversationId: input.source.conversationId,
    }));
  }
  // Follow-ups are not observations. In particular, a quiet day cannot be
  // repopulated with generic questions from the harness or past chats.
  return Object.freeze({ verdict, items: Object.freeze(items), valid: Boolean(verdict) && (candidateCount === 0 || items.length > 0) });
}
