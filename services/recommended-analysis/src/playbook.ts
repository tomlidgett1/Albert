/**
 * Deterministic next-question playbook for the homepage recommended analysis
 * (ADR 0117). Reads the owner's longer analysis history, not just the last
 * few chats: neglected surfaces, unfinished work, cross-thread tension,
 * connector close-the-loop, stale weekly looks, and overnight research.
 *
 * Questions are written so they stand alone as a new conversation. Figures in
 * the "why" line come only from the brief or research highlight. The playbook
 * never invents numbers.
 */
import type { TraceConnector } from "../../../packages/shared/src/index.js";
import { toolForDomain } from "./tools.js";

export const ANALYTICAL_MOVES = [
  "decompose",
  "compare",
  "diagnose",
  "close_the_loop",
  "refresh",
  "resolve_tension",
  "act",
] as const;

export type AnalyticalMove = (typeof ANALYTICAL_MOVES)[number];

export const ANALYSIS_DOMAINS = [
  "sales",
  "customers",
  "products",
  "inventory",
  "cash",
  "profit",
  "staff",
  "workshop",
] as const;

export type AnalysisDomain = (typeof ANALYSIS_DOMAINS)[number];

export type AnalysisInsight = Readonly<{
  value: string;
  label: string;
  detail?: string;
  sentiment?: "positive" | "negative" | "neutral";
}>;

export type AnalysisBrief = Readonly<{
  conversationId: string;
  title: string;
  updatedAt: string;
  turnId: string;
  userQuestion: string;
  answerState: string | null;
  completedAt: string | null;
  answerExcerpt: string;
  followUps: readonly string[];
  keyInsights: readonly AnalysisInsight[];
  claims: readonly string[];
  askedQuestions: readonly string[];
}>;

export type RecommendedQuestion = Readonly<{
  id: string;
  /** Short owner-facing headline; the full analytical question is opened on click. */
  title?: string;
  question: string;
  why: string;
  move: AnalyticalMove;
  domain: AnalysisDomain;
  /** The connected tool the question reads (the logo beside it); null when none of them can. */
  tool?: TraceConnector | null;
  fromTitle: string;
  fromConversationId: string | null;
}>;

export type CoverageThread = Readonly<{
  conversationId: string;
  title: string;
  updatedAt: string;
  question: string;
}>;

export type ProactiveHighlight = Readonly<{
  headline: string;
  why: string;
  question: string;
  tone: "good" | "attention" | "opportunity";
}>;

export type ProactiveSignal = Readonly<{
  runId: string;
  completedAt: string | null;
  verdict: string | null;
  highlights: readonly ProactiveHighlight[];
}>;

export type PlaybookExtras = Readonly<{
  coverage?: readonly CoverageThread[];
  proactive?: ProactiveSignal | null;
}>;

export const MOVE_LABELS: Readonly<Record<AnalyticalMove, string>> = Object.freeze({
  decompose: "Break it down",
  compare: "Compare",
  diagnose: "Diagnose",
  close_the_loop: "Close the loop",
  refresh: "Look again",
  resolve_tension: "Resolve",
  act: "Decide",
});

export const MAX_RECOMMENDATIONS = 3;
const MAX_QUESTION_WORDS = 28;
const ANAPHORA = /\b(this|that|it|those|these|them|the drop|the gap|the change|the decline|the increase)\b/iu;
const PROBLEM = /\b(down|drop|dropped|fell|fall|decline|declined|gap|behind|lowest|weaker|weak|slipped|eroded|unpaid|overdue|lapsed|unsold|aged|dead|overrun|below|compress|compressed|short|missed|lost)\b/iu;
const POSITIVE = /\b(up|rose|grew|growth|highest|stronger|strong|ahead|record|recovered)\b/iu;
const COMPARISON = /\b(compar|versus|vs\.?|last (week|month|year)|year[- ]on[- ]year|wow|mom|prior|previous)\b/iu;
const SLICE = /\b(by |per |which |who |where |breakdown|broken down|split)\b/iu;

const DOMAIN_SIGNALS: Readonly<Record<AnalysisDomain, RegExp>> = Object.freeze({
  sales: /\b(sales?|takings|revenue|turnover|till|transactions?|orders?)\b/iu,
  customers: /\b(customers?|repeat|lapsed|cohort|loyalty|rfm|accounts?)\b/iu,
  products: /\b(products?|sku|skus|items?|categor(?:y|ies)|brands?|parts|bikes?|accessories)\b/iu,
  inventory: /\b(stock|inventory|reorder|unsold|on hand|aged|dead stock|units on hand)\b/iu,
  cash: /\b(cash|bank|deposit(?:ed|s)?|receivable|overdue|invoices?|paid|collections?)\b/iu,
  profit: /\b(profit|margin|gross|cogs|expense|p&l|pnl|net profit)\b/iu,
  staff: /\b(staff|employee|labour|labor|roster|hours?|salesperson|sold by|wage)\b/iu,
  workshop: /\b(workshop|jobs?|repairs?|quoted hours|bench fee|service job)\b/iu,
});

type ConnectorHint = "pos" | "xero" | "deputy";

type RankedCandidate = RecommendedQuestion & Readonly<{ score: number }>;

export function normalizeQuestion(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’]/gu, "")
    .replace(/[^a-z0-9\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function fingerprintBriefs(briefs: readonly AnalysisBrief[]): string {
  return briefs
    .map((brief) => `${brief.conversationId}:${brief.turnId}:${brief.updatedAt}`)
    .join("|");
}

export function daysSince(iso: string, now = new Date()): number {
  const at = new Date(iso);
  if (Number.isNaN(at.valueOf())) return 0;
  return Math.max(0, Math.floor((now.valueOf() - at.valueOf()) / 86_400_000));
}

export function detectDomains(...texts: readonly string[]): readonly AnalysisDomain[] {
  const haystack = texts.join(" ");
  return ANALYSIS_DOMAINS.filter((domain) => DOMAIN_SIGNALS[domain].test(haystack));
}

export function connectorHints(connectors: readonly string[]): Readonly<Record<ConnectorHint, boolean>> {
  const keys = connectors.map((value) => value.toLowerCase());
  return Object.freeze({
    pos: keys.some((key) => /lightspeed|square|shopify|stripe|pos/u.test(key)),
    xero: keys.some((key) => /xero/u.test(key)),
    deputy: keys.some((key) => /deputy/u.test(key)),
  });
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/u).filter(Boolean).length;
}

function ensureQuestion(value: string): string {
  const trimmed = value.replace(/\s+/gu, " ").trim().replace(/[.!?]+$/u, "");
  if (!trimmed) return "";
  const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return `${capitalised}?`;
}

function stripMarkdown(value: string): string {
  return value
    .replace(/^#+\s+/gmu, "")
    .replace(/\*\*?|__|`/gu, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function periodFromQuestion(question: string): string {
  if (/\b(this week|last week|week-on-week|wow)\b/iu.test(question)) return "last week";
  if (/\b(this month|last month|month-on-month)\b/iu.test(question)) return "this month";
  if (/\b(this quarter|last quarter|quarter)\b/iu.test(question)) return "this quarter";
  if (/\b(today|yesterday)\b/iu.test(question)) return "yesterday";
  if (/\b(this year|last year|fytd|ytd|year[- ]on[- ]year)\b/iu.test(question)) return "this year";
  return "that period";
}

function periodAsOwner(period: string): string {
  if (period === "that period") return period;
  if (period.endsWith("s")) return `${period}'`;
  return `${period}'s`;
}

function prettyNumbersInText(value: string): string {
  return value.replace(/-?\d+\.\d{3,}/gu, (match) => prettyInsightValue(match));
}

function prettyInsightValue(value: string): string {
  const trimmed = value.trim();
  if (/^-?\$/.test(trimmed) || /%$/.test(trimmed)) return trimmed;
  const numeric = Number(trimmed.replace(/,/gu, ""));
  if (!Number.isFinite(numeric)) return trimmed;
  if (/\d+\.\d{3,}/.test(trimmed) && Math.abs(numeric) >= 20) {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: "AUD",
      maximumFractionDigits: 0,
    }).format(numeric);
  }
  return trimmed;
}

function topicFromBrief(brief: AnalysisBrief): string {
  const insight = brief.keyInsights[0]?.label.trim();
  if (insight && insight.length <= 40) return insight.toLowerCase();
  const title = brief.title.trim();
  if (title && title.length <= 48) return title.toLowerCase();
  const domains = detectDomains(brief.userQuestion, brief.title);
  if (domains[0] === "sales") return "sales";
  if (domains[0]) return domains[0];
  return "that result";
}

function firstFinding(brief: AnalysisBrief): string {
  const insight = brief.keyInsights.find((item) => item.label.trim() && item.value.trim());
  if (insight) {
    const detail = insight.detail?.trim();
    return detail
      ? `${insight.label} was ${prettyInsightValue(insight.value)}, ${detail}`
      : `${insight.label} was ${prettyInsightValue(insight.value)}`;
  }
  const claim = brief.claims.find((item) => item.trim());
  if (claim) return prettyNumbersInText(stripMarkdown(claim)).slice(0, 160);
  const sentence = stripMarkdown(brief.answerExcerpt).split(/(?<=[.?!])\s+/u)[0] ?? "";
  if (sentence.length >= 12) return prettyNumbersInText(sentence).slice(0, 160);
  return `You last looked at ${brief.title.trim() || "this analysis"}`;
}

function clipWhy(value: string): string {
  const clean = value.replace(/\s+/gu, " ").trim();
  if (clean.length <= 140) return clean;
  return `${clean.slice(0, 137).trim()}…`;
}

function hasProblem(brief: AnalysisBrief): boolean {
  if (brief.keyInsights.some((item) => item.sentiment === "negative")) return true;
  const text = [brief.answerExcerpt, ...brief.claims, ...brief.keyInsights.map((item) => `${item.label} ${item.value} ${item.detail ?? ""}`)].join(" ");
  return PROBLEM.test(text);
}

function hasPositive(brief: AnalysisBrief): boolean {
  if (brief.keyInsights.some((item) => item.sentiment === "positive")) return true;
  return POSITIVE.test([brief.answerExcerpt, ...brief.claims].join(" "));
}

function looksLikeTotal(question: string): boolean {
  return !SLICE.test(question);
}

function looksCompared(question: string): boolean {
  return COMPARISON.test(question);
}

function needsAnaphoraRewrite(question: string): boolean {
  const trimmed = question.replace(/\s+/gu, " ").trim();
  if (!ANAPHORA.test(trimmed)) return false;
  const words = trimmed.split(/\s+/u).filter(Boolean);
  if (words.length <= 10) return true;
  return /^(break|show|split|explain|compare)\s+(this|that|it)\b/iu.test(trimmed);
}

export function makeSelfContained(question: string, brief: AnalysisBrief): string {
  const trimmed = question.replace(/\s+/gu, " ").trim();
  if (!trimmed) return "";
  if (!needsAnaphoraRewrite(trimmed)) return ensureQuestion(trimmed);
  const topic = topicFromBrief(brief);
  const rewritten = trimmed
    .replace(/\bthe drop\b/giu, `the ${topic} drop`)
    .replace(/\bthe gap\b/giu, `the ${topic} gap`)
    .replace(/\bthe change\b/giu, `the ${topic} change`)
    .replace(/\bthe decline\b/giu, `the ${topic} decline`)
    .replace(/\bthe increase\b/giu, `the ${topic} increase`)
    .replace(/\bthis\b/giu, topic)
    .replace(/\bthat\b/giu, topic)
    .replace(/\bit\b/giu, topic);
  return ensureQuestion(rewritten);
}

function recommendationId(question: string, index: number): string {
  let hash = 0;
  for (const char of question) hash = (hash * 33 + char.charCodeAt(0)) % 1_000_003;
  return `rec-${index + 1}-${hash.toString(16).padStart(5, "0")}`;
}

function alreadyAsked(question: string, asked: ReadonlySet<string>): boolean {
  const normalised = normalizeQuestion(question);
  if (!normalised || asked.has(normalised)) return true;
  for (const prior of asked) {
    if (!prior) continue;
    if (normalised.includes(prior) || prior.includes(normalised)) return true;
    const left = new Set(normalised.split(" "));
    const right = prior.split(" ");
    const overlap = right.filter((word) => word.length > 3 && left.has(word)).length;
    if (right.length >= 5 && overlap / right.length >= 0.78) return true;
  }
  return false;
}

function pushCandidate(
  into: RankedCandidate[],
  asked: ReadonlySet<string>,
  candidate: Omit<RankedCandidate, "id">,
): void {
  const question = ensureQuestion(candidate.question);
  if (!question.endsWith("?")) return;
  if (wordCount(question) < 5 || wordCount(question) > MAX_QUESTION_WORDS) return;
  if (alreadyAsked(question, asked)) return;
  if (into.some((item) => normalizeQuestion(item.question) === normalizeQuestion(question))) return;
  into.push({
    ...candidate,
    question,
    why: clipWhy(candidate.why),
    id: recommendationId(question, into.length),
  });
}

function problemEntity(brief: AnalysisBrief): string | null {
  const negative = brief.keyInsights.find((item) => item.sentiment === "negative" && item.label.trim());
  if (negative) return negative.label.trim();
  const problemInsight = brief.keyInsights.find((item) => PROBLEM.test(`${item.label} ${item.detail ?? ""}`));
  if (problemInsight?.label.trim()) return problemInsight.label.trim();
  const claim = brief.claims.find((item) => PROBLEM.test(item));
  if (claim) {
    const lead = stripMarkdown(claim).split(/[,:]/u)[0]?.trim() ?? "";
    if (lead.length >= 4 && lead.length <= 48) return lead;
  }
  return null;
}

function addFollowUps(
  into: RankedCandidate[],
  asked: ReadonlySet<string>,
  brief: AnalysisBrief,
  recencyBoost: number,
): void {
  const followUp = brief.followUps[0];
  if (!followUp) return;
  const question = makeSelfContained(followUp, brief);
  pushCandidate(into, asked, {
    question,
    why: firstFinding(brief),
    move: inferMove(question),
    domain: detectDomains(question, brief.userQuestion, brief.title)[0] ?? "sales",
    fromTitle: brief.title,
    fromConversationId: brief.conversationId,
    score: 74 + recencyBoost,
  });
}

export function inferMove(question: string): AnalyticalMove {
  if (/\b(markdown|reorder|keep|chase|roster|clear|discount)\b/iu.test(question)) return "act";
  if (/\b(why|what(?:'s| is) dragging|explain|drove|drive|caused|cause)\b/iu.test(question)) return "diagnose";
  if (/\b(compar|versus|vs|last year|prior|same period)\b/iu.test(question)) return "compare";
  if (/\b(bank|labour|labor|roster|cash|reach the bank)\b/iu.test(question)) return "close_the_loop";
  if (/\b(this week compared|since I last|look again|moved since)\b/iu.test(question)) return "refresh";
  if (SLICE.test(question)) return "decompose";
  return "diagnose";
}

function addDiagnosis(into: RankedCandidate[], asked: ReadonlySet<string>, brief: AnalysisBrief, recencyBoost: number): void {
  if (!hasProblem(brief)) return;
  const entity = problemEntity(brief);
  const period = periodFromQuestion(brief.userQuestion);
  const finding = firstFinding(brief);
  if (entity) {
    pushCandidate(into, asked, {
      question: period === "that period"
        ? `What is dragging ${entity.toLowerCase()}: mix, discounting, or cost?`
        : `What is dragging ${entity.toLowerCase()} in ${periodAsOwner(period)} figures: mix, discounting, or cost?`,
      why: finding,
      move: "diagnose",
      domain: detectDomains(entity, brief.userQuestion, brief.answerExcerpt)[0] ?? "profit",
      fromTitle: brief.title,
      fromConversationId: brief.conversationId,
      score: 86 + recencyBoost,
    });
    return;
  }
  pushCandidate(into, asked, {
      question: `What drove the change in ${topicFromBrief(brief)} for ${periodAsOwner(period)} trading?`,
    why: finding,
    move: "diagnose",
    domain: detectDomains(brief.userQuestion, brief.answerExcerpt)[0] ?? "sales",
    fromTitle: brief.title,
    fromConversationId: brief.conversationId,
    score: 80 + recencyBoost,
  });
}

function addDecompose(into: RankedCandidate[], asked: ReadonlySet<string>, brief: AnalysisBrief): void {
  if (!looksLikeTotal(brief.userQuestion)) return;
  const period = periodFromQuestion(brief.userQuestion);
  const domains = detectDomains(brief.userQuestion, brief.title, brief.answerExcerpt);
  const finding = firstFinding(brief);
  if (domains.includes("sales") || domains.length === 0) {
    pushCandidate(into, asked, {
      question: `Which categories drove ${periodAsOwner(period)} sales, and which dragged them?`,
      why: `${finding} A total hides mix.`,
      move: "decompose",
      domain: "products",
      fromTitle: brief.title,
      fromConversationId: brief.conversationId,
      score: 74,
    });
    pushCandidate(into, asked, {
      question: `Who on the floor sold the most in ${periodAsOwner(period)} trading, and who was quiet?`,
      why: `${finding} Staff mix often explains a headline move.`,
      move: "decompose",
      domain: "staff",
      fromTitle: brief.title,
      fromConversationId: brief.conversationId,
      score: 68,
    });
  }
  if (domains.includes("customers")) {
    pushCandidate(into, asked, {
      question: `Which of ${period}'s top customers have not been back in the last 90 days?`,
      why: `${finding} Rank without recency is only half the story.`,
      move: "diagnose",
      domain: "customers",
      fromTitle: brief.title,
      fromConversationId: brief.conversationId,
      score: 76,
    });
  }
  if (domains.includes("profit") || domains.includes("products")) {
    pushCandidate(into, asked, {
      question: `Which products inside the ${topicFromBrief(brief)} mix are actually earning their margin?`,
      why: finding,
      move: "decompose",
      domain: "products",
      fromTitle: brief.title,
      fromConversationId: brief.conversationId,
      score: 72,
    });
  }
}

function addCompare(into: RankedCandidate[], asked: ReadonlySet<string>, brief: AnalysisBrief): void {
  if (looksCompared(brief.userQuestion)) return;
  const topic = topicFromBrief(brief);
  pushCandidate(into, asked, {
    question: `How does ${topic} compare with the same period last year?`,
    why: `${firstFinding(brief)} A snapshot without last year can mistake season for a trend.`,
    move: "compare",
    domain: detectDomains(brief.userQuestion, brief.title)[0] ?? "sales",
    fromTitle: brief.title,
    fromConversationId: brief.conversationId,
    score: 64,
  });
}

function lastTouchDays(
  domain: AnalysisDomain,
  briefs: readonly AnalysisBrief[],
  coverage: readonly CoverageThread[],
  now: Date,
): number | null {
  let latest: string | null = null;
  const mark = (at: string, texts: readonly string[]) => {
    if (!detectDomains(...texts).includes(domain)) return;
    if (!latest || Date.parse(at) > Date.parse(latest)) latest = at;
  };
  for (const thread of coverage) mark(thread.updatedAt, [thread.title, thread.question]);
  for (const brief of briefs) {
    mark(brief.updatedAt, [brief.title, brief.userQuestion, brief.answerExcerpt, ...brief.askedQuestions]);
  }
  return latest ? daysSince(latest, now) : null;
}

function addCloseTheLoop(
  into: RankedCandidate[],
  asked: ReadonlySet<string>,
  briefs: readonly AnalysisBrief[],
  coverage: readonly CoverageThread[],
  connectors: Readonly<Record<ConnectorHint, boolean>>,
  now: Date,
): void {
  const salesAge = lastTouchDays("sales", briefs, coverage, now);
  const cashAge = lastTouchDays("cash", briefs, coverage, now);
  const staffAge = lastTouchDays("staff", briefs, coverage, now);
  const stockAge = lastTouchDays("inventory", briefs, coverage, now);
  const productsAge = lastTouchDays("products", briefs, coverage, now);
  const salesFresh = salesAge !== null && salesAge < 14;
  const latestSales = briefs.find((brief) => detectDomains(brief.userQuestion, brief.title).includes("sales"))
    ?? coverage.find((thread) => detectDomains(thread.title, thread.question).includes("sales"));
  const period = latestSales && "userQuestion" in latestSales
    ? periodFromQuestion(latestSales.userQuestion)
    : latestSales
      ? periodFromQuestion(latestSales.question)
      : "last week";
  const fromBrief = briefs[0];
  const fromTitle = fromBrief?.title ?? latestSales?.title ?? "Recent analysis";
  const fromId = fromBrief?.conversationId ?? latestSales?.conversationId ?? null;

  if ((salesFresh || cashAge === null || (cashAge !== null && cashAge >= 14)) && (cashAge === null || cashAge >= 14) && connectors.xero) {
    pushCandidate(into, asked, {
      question: `Did takings from ${period} reach the bank, and what is still outstanding?`,
      why: "You reviewed sales, but not whether that cash actually landed.",
      move: "close_the_loop",
      domain: "cash",
      fromTitle,
      fromConversationId: fromId,
      score: 92,
    });
  }
  if ((salesFresh || staffAge === null || staffAge >= 14) && (staffAge === null || staffAge >= 14) && connectors.deputy) {
    pushCandidate(into, asked, {
      question: `What share of ${periodAsOwner(period)} sales did labour cost take?`,
      why: "Sales without roster cost can hide a week that looked busy and paid poorly.",
      move: "close_the_loop",
      domain: "staff",
      fromTitle,
      fromConversationId: fromId,
      score: 91,
    });
  }
  if ((salesFresh || productsAge !== null || stockAge === null || stockAge >= 14) && (stockAge === null || stockAge >= 14) && connectors.pos) {
    pushCandidate(into, asked, {
      question: "Which products have sat more than 90 days and are still being reordered?",
      why: "A sales or margin review that skips stock leaves the cash sitting on the shelf.",
      move: "close_the_loop",
      domain: "inventory",
      fromTitle,
      fromConversationId: fromId,
      score: 88,
    });
  }
}

function addNeglectedSurfaces(
  into: RankedCandidate[],
  asked: ReadonlySet<string>,
  briefs: readonly AnalysisBrief[],
  coverage: readonly CoverageThread[],
  connectors: readonly string[],
  now: Date,
): void {
  const hints = connectorHints(connectors);
  const from = briefs[0];
  const fromTitle = from?.title ?? "Your analyses";
  const fromId = from?.conversationId ?? null;
  const workshopAge = lastTouchDays("workshop", briefs, coverage, now);
  const customerAge = lastTouchDays("customers", briefs, coverage, now);
  const profitAge = lastTouchDays("profit", briefs, coverage, now);
  if ((workshopAge === null || workshopAge >= 14) && hints.pos) {
    pushCandidate(into, asked, {
      question: "Which open workshop jobs are oldest and still not invoiced?",
      why: "Workshop has not come up in your recent analyses.",
      move: "diagnose",
      domain: "workshop",
      fromTitle,
      fromConversationId: fromId,
      score: 87,
    });
  }
  if ((customerAge === null || customerAge >= 14) && hints.pos) {
    pushCandidate(into, asked, {
      question: "Which customers spent the most last year and have not been back in 90 days?",
      why: "Customer recency has gone quiet while other surfaces kept getting asked.",
      move: "act",
      domain: "customers",
      fromTitle,
      fromConversationId: fromId,
      score: 86,
    });
  }
  if ((profitAge === null || profitAge >= 14) && hints.pos) {
    pushCandidate(into, asked, {
      question: "Which categories are earning their margin this month, and which are not?",
      why: "Margin has not been checked against the sales looks you have already run.",
      move: "decompose",
      domain: "profit",
      fromTitle,
      fromConversationId: fromId,
      score: 85,
    });
  }
}

function addProactiveHighlights(
  into: RankedCandidate[],
  asked: ReadonlySet<string>,
  briefs: readonly AnalysisBrief[],
  proactive: ProactiveSignal | null,
): void {
  const highlights = (proactive?.highlights ?? [])
    .filter((item) => item.tone !== "good")
    .slice(0, 3);
  for (const highlight of highlights) {
    const question = makeSelfContained(
      highlight.question,
      briefs[0] ?? {
        conversationId: "01J00000000000000000000000",
        title: highlight.headline,
        updatedAt: proactive?.completedAt ?? new Date().toISOString(),
        turnId: "00000000",
        userQuestion: highlight.question,
        answerState: null,
        completedAt: null,
        answerExcerpt: highlight.why,
        followUps: [],
        keyInsights: [],
        claims: [],
        askedQuestions: [],
      },
    );
    pushCandidate(into, asked, {
      question,
      why: highlight.why || highlight.headline,
      move: inferMove(question),
      domain: detectDomains(question, highlight.headline)[0] ?? "sales",
      fromTitle: highlight.headline,
      fromConversationId: briefs[0]?.conversationId ?? null,
      score: highlight.tone === "attention" ? 90 : 84,
    });
  }
}

function addTension(into: RankedCandidate[], asked: ReadonlySet<string>, briefs: readonly AnalysisBrief[]): void {
  const sales = briefs.find((brief) => detectDomains(brief.userQuestion, brief.title).includes("sales"));
  const profit = briefs.find((brief) => detectDomains(brief.userQuestion, brief.title, brief.answerExcerpt).includes("profit"));
  if (!sales || !profit || sales.conversationId === profit.conversationId) return;
  if (hasPositive(sales) && hasProblem(profit)) {
    pushCandidate(into, asked, {
      question: "Sales looked stronger than profit. Which expenses or margin lines explain the gap?",
      why: `${firstFinding(sales)} ${firstFinding(profit)}`,
      move: "resolve_tension",
      domain: "profit",
      fromTitle: profit.title,
      fromConversationId: profit.conversationId,
      score: 94,
    });
  }
}

function addRefresh(into: RankedCandidate[], asked: ReadonlySet<string>, brief: AnalysisBrief, now: Date): void {
  const age = daysSince(brief.updatedAt, now);
  if (age < 6) return;
  const weekly = /\bweek\b/iu.test(`${brief.title} ${brief.userQuestion}`);
  if (!weekly && age < 10) return;
  pushCandidate(into, asked, {
    question: weekly
      ? "How has this week compared to the week I last reviewed?"
      : `How has ${topicFromBrief(brief)} moved since I last looked?`,
    why: `That review is ${age} days old. The useful question is what changed since.`,
    move: "refresh",
    domain: detectDomains(brief.userQuestion, brief.title)[0] ?? "sales",
    fromTitle: brief.title,
    fromConversationId: brief.conversationId,
    score: 72,
  });
}

function addActions(into: RankedCandidate[], asked: ReadonlySet<string>, brief: AnalysisBrief): void {
  const text = [brief.answerExcerpt, ...brief.claims].join(" ");
  if (/\b(unsold|dead stock|aged|slow mov)/iu.test(text)) {
    pushCandidate(into, asked, {
      question: "Which of those slow movers should I markdown this week versus keep?",
      why: firstFinding(brief),
      move: "act",
      domain: "inventory",
      fromTitle: brief.title,
      fromConversationId: brief.conversationId,
      score: 79,
    });
  }
  if (/\b(overdue|unpaid|receivable)\b/iu.test(text)) {
    pushCandidate(into, asked, {
      question: "Which overdue invoices are largest and oldest, and who do I chase first?",
      why: firstFinding(brief),
      move: "act",
      domain: "cash",
      fromTitle: brief.title,
      fromConversationId: brief.conversationId,
      score: 81,
    });
  }
  if (/\b(lapsed|have not (been back|returned)|not returned)\b/iu.test(text)) {
    pushCandidate(into, asked, {
      question: "Which lapsed customers spent the most with me in the last year?",
      why: firstFinding(brief),
      move: "act",
      domain: "customers",
      fromTitle: brief.title,
      fromConversationId: brief.conversationId,
      score: 77,
    });
  }
}

export function collectAskedQuestions(briefs: readonly AnalysisBrief[]): ReadonlySet<string> {
  const asked = new Set<string>();
  for (const brief of briefs) {
    asked.add(normalizeQuestion(brief.userQuestion));
    asked.add(normalizeQuestion(brief.title));
    for (const question of brief.askedQuestions) asked.add(normalizeQuestion(question));
  }
  asked.delete("");
  return asked;
}

export function buildPlaybookRecommendations(
  briefs: readonly AnalysisBrief[],
  connectors: readonly string[] = [],
  now = new Date(),
  extras: PlaybookExtras = {},
): readonly RecommendedQuestion[] {
  const coverage = extras.coverage ?? briefs.map((brief) => ({
    conversationId: brief.conversationId,
    title: brief.title,
    updatedAt: brief.updatedAt,
    question: brief.userQuestion,
  }));
  if (briefs.length === 0 && !(extras.proactive?.highlights.length)) return [];
  const asked = new Set(collectAskedQuestions(briefs));
  for (const thread of coverage) {
    asked.add(normalizeQuestion(thread.question));
    asked.add(normalizeQuestion(thread.title));
  }
  asked.delete("");
  const hints = connectorHints(connectors);
  const candidates: RankedCandidate[] = [];

  briefs.slice(0, 3).forEach((brief, index) => {
    addFollowUps(candidates, asked, brief, Math.max(0, 2 - index));
  });
  briefs.forEach((brief, index) => {
    addDiagnosis(candidates, asked, brief, Math.max(0, 4 - index));
    addActions(candidates, asked, brief);
    addRefresh(candidates, asked, brief, now);
  });
  briefs.slice(0, 8).forEach((brief) => {
    addDecompose(candidates, asked, brief);
    addCompare(candidates, asked, brief);
  });
  addCloseTheLoop(candidates, asked, briefs, coverage, hints, now);
  addNeglectedSurfaces(candidates, asked, briefs, coverage, connectors, now);
  addProactiveHighlights(candidates, asked, briefs, extras.proactive ?? null);
  addTension(candidates, asked, briefs);

  const ranked = [...candidates].sort((left, right) => right.score - left.score);
  const picked: RankedCandidate[] = [];
  const usedMoves = new Map<AnalyticalMove, number>();
  const usedDomains = new Map<AnalysisDomain, number>();
  for (const candidate of ranked) {
    if (picked.length >= MAX_RECOMMENDATIONS) break;
    const moveCount = usedMoves.get(candidate.move) ?? 0;
    const domainCount = usedDomains.get(candidate.domain) ?? 0;
    const stem = normalizeQuestion(candidate.question).split(" ").slice(0, 4).join(" ");
    if (picked.some((item) => normalizeQuestion(item.question).split(" ").slice(0, 4).join(" ") === stem)) continue;
    if (domainCount >= 1 || moveCount >= 2) continue;
    picked.push(candidate);
    usedMoves.set(candidate.move, moveCount + 1);
    usedDomains.set(candidate.domain, domainCount + 1);
  }
  if (picked.length < Math.min(3, ranked.length)) {
    for (const candidate of ranked) {
      if (picked.length >= MAX_RECOMMENDATIONS) break;
      if (picked.some((item) => item.question === candidate.question)) continue;
      picked.push(candidate);
    }
  }

  return Object.freeze(picked.slice(0, MAX_RECOMMENDATIONS).map((item, index) => Object.freeze({
    id: recommendationId(item.question, index),
    question: item.question,
    why: item.why,
    move: item.move,
    domain: item.domain,
    tool: toolForDomain(item.domain, connectors),
    fromTitle: item.fromTitle,
    fromConversationId: item.fromConversationId,
  })));
}

export const recommendedQuestionSchemaShape = Object.freeze({
  id: true,
  question: true,
  why: true,
  move: true,
  domain: true,
  tool: true,
  fromTitle: true,
  fromConversationId: true,
});
