/**
 * The daily look (ADR 0138). Every 24 hours the imessage-bridge runs one Luna
 * Max turn on the Omni harness that reads the last seven days across the
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
export const DAILY_BRIEF_CONVERSATION_TITLE = "Daily look · last 7 days" as const;
export const DAILY_BRIEF_CONVERSATION_TITLE_PREFIX = "Daily look ·" as const;

/** Luna at max effort on the Omni harness, per the owner. */
export const DAILY_BRIEF_MODEL = "gpt-5.6-luna" as const;
export const DAILY_BRIEF_EFFORT = "max" as const;

export const DAILY_BRIEF_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const DAILY_BRIEF_REFRESH_MS = 24 * 60 * 60_000;
/** Bound stale observations even when generation or the network fails. */
export const DAILY_BRIEF_MAX_AGE_MS = DAILY_BRIEF_REFRESH_MS + 2 * 60 * 60_000;
export const DAILY_BRIEF_VERSION_PREFIX = "omni:weekly-v1:";

export const DAILY_BRIEF_MAX_ITEMS = MAX_RECOMMENDATIONS;

/** A stored brief names its generator `omni:<model>`; the chat-history playbook and its Luna pass never do. */
export const DAILY_BRIEF_MODEL_PREFIX = "omni:" as const;

/** The why a row falls back to when the model gave the sentence and nothing more. */
export const DAILY_BRIEF_DEFAULT_WHY = "From the latest review of the last seven days.";

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

/** Refresh every 24 hours; a missing/invalid look recovers at any hour. */
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
  return `${item.title}\n\n${item.question}\n\nInvestigate the seven-day period from ${window.windowStart} to ${window.windowEnd} (${window.timezone}). The daily look found: ${item.why} Verify the change against a comparable period, investigate the drivers, and explain the most useful next action in plain language.`;
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
    `Review the last seven days (${window})${toolList} and identify the most important things the owner should analyse next. These recommendations refresh once every 24 hours.`,
    `Use this exact event-time window: [${from.toISOString()}, ${input.now.toISOString()}). Do not move it backwards to the latest available data. Previous conversations are not evidence for this run.`,
    "",
    "Rank by money at stake, urgency and the usefulness of an investigation: lost sales or margin, growing costs, overdue money to recover, discount/refund leakage, labour out of line with demand, or evidenced stock shortages. Compare the seven-day window with the preceding comparable seven days; use earlier comparable weeks to test whether a change is unusual. Never compare a partial day with whole days. Small percentage changes on tiny bases and standalone transaction-count records rank below material financial issues. A category being largest, or normal stock outflow, is not an investigation. Stock risk requires current stock or cover evidence.",
    "",
    "Choose up to three distinct investigations across the connected business, with the most important first. A record or a high is not enough: identify an unresolved driver, risk, opportunity or decision worth investigating. Do not label four comparable weekdays as an all-time or four-week record. Do not claim an explanation or causal link before investigating it. If nothing material warrants investigation, say so and list nothing.",
    "",
    ...(reaches ? [reaches] : []),
    "Check coverage before comparing. A material finding on completed days within the last seven days is eligible if you name its period and compare matching completed days. Current receivables or stock balances observed within the window may warrant action even when their original invoices or purchases are older. Older data may supply a baseline but never masquerade as this week's activity. Missing data, empty results and sync state are never a finding; unsynced days are not zero activity. Do not pad the list with sources that lack supporting evidence.",
    "",
    "Answer in exactly this shape and nothing else:",
    "",
    "Verdict: one sentence, at most 28 words, on the week's most important issues.",
    "- [Tool] Action to investigate with a key figure | Detailed investigation question? | Evidence, comparison and why it matters.",
    "",
    "The first field is a tap-to-analyse request, not a news headline. Start with 'Analyse why', 'Investigate', 'Review' or 'Check'. Name the specific business issue and include one useful observed amount, percentage or count (at most two). Aim for 6–10 words, with at most 110 characters and 14 words. Avoid AOV, KPI, transaction volume, trailing sales window, event-time window, superlatives and 'should we'. Wording patterns: 'Analyse why [category] sales fell to [amount]', 'Investigate the [percentage] rise in [cost]', 'Review [amount] in overdue invoices'. Replace every bracket with evidence from this run; never copy a pattern as an actual finding. Copy the displayed figures exactly from the evidence field, without extra rounding or abbreviations. Keep the detailed question and evidence under 200 characters each. Separate the three fields with ' | '. Do not split one issue into several rows.",
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
const PLACEHOLDER = /one sentence, at most|a few words on why|<\s*tool\s*>|\bwhat happened with its figure\b|short headline|self-contained question|action to investigate with a key figure|\[(?:category|amount|percentage|cost)\]/iu;

function displayFigures(text: string): readonly string[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?(?:\s?%|\s?[kKmM]\b)?/gu)]
    .map(([value]) => value.replace(/[,\s]/gu, "").toLowerCase());
}

/** Enforce the owner's action-first display contract, including its evidence anchor. */
export function isActionRecommendation(title: unknown, evidence: unknown): title is string {
  if (typeof title !== "string" || typeof evidence !== "string") return false;
  const figures = displayFigures(title);
  const evidenceFigures = new Set(displayFigures(evidence));
  return /^(?:Analyse why|Investigate|Review|Check)\s+\S/iu.test(title)
    && title.length >= 12 && title.length <= 110 && title.split(/\s+/u).length <= 14
    && !/[;]|\b(?:AOV|KPI|GMROI|SKU|should we|transaction volume|trailing sales window|event-time window)\b/iu.test(title)
    && !PLACEHOLDER.test(title) && figures.length >= 1 && figures.length <= 2
    && figures.every((figure) => evidenceFigures.has(figure));
}

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

/** Only a concrete analysis request backed by the supplied evidence can publish. */
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
    if (!isActionRecommendation(title, why)
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
