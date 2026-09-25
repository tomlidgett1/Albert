/**
 * Standing analytical corpus for homepage recommendations (ADR 0117).
 *
 * Recency of the last few chats is not the product. Albert should read the
 * owner's longer analysis history, notice which business surfaces have gone
 * quiet, pick up unfinished work, and fold in overnight research when it
 * exists. The playbook and Luna pass both consume this corpus.
 */
import {
  ANALYSIS_DOMAINS,
  connectorHints,
  daysSince,
  detectDomains,
  fingerprintBriefs,
  type AnalysisBrief,
  type AnalysisDomain,
  type CoverageThread,
  type ProactiveSignal,
} from "./playbook.js";

export type { CoverageThread, ProactiveHighlight, ProactiveSignal } from "./playbook.js";

export type VocabularyHint = Readonly<{
  term: string;
  meaning: string;
}>;

export type DomainCoverage = Readonly<{
  domain: AnalysisDomain;
  conversationCount: number;
  lastAskedAt: string | null;
  daysSince: number | null;
}>;

export type AnalysisCorpus = Readonly<{
  briefs: readonly AnalysisBrief[];
  coverage: readonly CoverageThread[];
  proactive: ProactiveSignal | null;
  connectors: readonly string[];
  vocabulary: readonly VocabularyHint[];
}>;

const STALE_DAYS = 14;
const RECENT_DAYS = 7;
const NOISY_TITLE = /^(eval|repro|debug|test)[-:\s]/iu;

export function isNoisyAnalysisTitle(title: string): boolean {
  return NOISY_TITLE.test(title.trim());
}

export function buildAnalysisCorpus(input: Readonly<{
  briefs: readonly AnalysisBrief[];
  coverage?: readonly CoverageThread[];
  proactive?: ProactiveSignal | null;
  connectors?: readonly string[];
  vocabulary?: readonly VocabularyHint[];
}>): AnalysisCorpus {
  const briefs = Object.freeze(
    input.briefs.filter((brief) => !isNoisyAnalysisTitle(brief.title)),
  );
  const coverage = Object.freeze((input.coverage ?? briefs.map((brief) => ({
    conversationId: brief.conversationId,
    title: brief.title,
    updatedAt: brief.updatedAt,
    question: brief.userQuestion,
  }))).filter((thread) => !isNoisyAnalysisTitle(thread.title)));
  return Object.freeze({
    briefs,
    coverage,
    proactive: input.proactive ?? null,
    connectors: Object.freeze([...(input.connectors ?? [])]),
    vocabulary: Object.freeze([...(input.vocabulary ?? [])]),
  });
}

export function fingerprintCorpus(corpus: AnalysisCorpus): string {
  const coveragePart = corpus.coverage
    .map((thread) => `${thread.conversationId}:${thread.updatedAt}`)
    .join("|");
  const proactivePart = corpus.proactive
    ? [
        corpus.proactive.runId,
        corpus.proactive.completedAt ?? "",
        corpus.proactive.highlights.map((item) => item.headline).join(";"),
      ].join(":")
    : "";
  return `${fingerprintBriefs(corpus.briefs)}#${coveragePart}#${proactivePart}`;
}

export function domainCoverage(
  corpus: AnalysisCorpus,
  now = new Date(),
): readonly DomainCoverage[] {
  const latest = new Map<AnalysisDomain, { count: number; lastAskedAt: string | null }>();
  for (const domain of ANALYSIS_DOMAINS) {
    latest.set(domain, { count: 0, lastAskedAt: null });
  }

  const mark = (domain: AnalysisDomain, at: string) => {
    const current = latest.get(domain) ?? { count: 0, lastAskedAt: null };
    const newer = !current.lastAskedAt || Date.parse(at) > Date.parse(current.lastAskedAt);
    latest.set(domain, {
      count: current.count + 1,
      lastAskedAt: newer ? at : current.lastAskedAt,
    });
  };

  for (const thread of corpus.coverage) {
    for (const domain of detectDomains(thread.title, thread.question)) {
      mark(domain, thread.updatedAt);
    }
  }
  for (const brief of corpus.briefs) {
    for (const domain of detectDomains(
      brief.title,
      brief.userQuestion,
      brief.answerExcerpt,
      ...brief.askedQuestions,
    )) {
      mark(domain, brief.updatedAt);
    }
  }

  return Object.freeze(ANALYSIS_DOMAINS.map((domain) => {
    const item = latest.get(domain) ?? { count: 0, lastAskedAt: null };
    return Object.freeze({
      domain,
      conversationCount: item.count,
      lastAskedAt: item.lastAskedAt,
      daysSince: item.lastAskedAt ? daysSince(item.lastAskedAt, now) : null,
    });
  }));
}

export function pressedDomains(coverage: readonly DomainCoverage[]): readonly AnalysisDomain[] {
  return coverage
    .filter((item) => item.conversationCount >= 2 || (item.daysSince !== null && item.daysSince <= RECENT_DAYS))
    .sort((left, right) => (left.daysSince ?? 99) - (right.daysSince ?? 99))
    .map((item) => item.domain);
}

export function neglectedDomains(coverage: readonly DomainCoverage[]): readonly AnalysisDomain[] {
  return coverage
    .filter((item) => item.conversationCount === 0 || (item.daysSince !== null && item.daysSince >= STALE_DAYS))
    .sort((left, right) => (right.daysSince ?? 999) - (left.daysSince ?? 999))
    .map((item) => item.domain);
}

export function domainAvailable(
  domain: AnalysisDomain,
  connectors: readonly string[],
): boolean {
  const hints = connectorHints(connectors);
  if (domain === "cash") return hints.xero;
  if (domain === "staff") return hints.deputy;
  if (domain === "inventory" || domain === "workshop") return hints.pos;
  return true;
}

const DOMAIN_LABEL: Readonly<Record<AnalysisDomain, string>> = Object.freeze({
  sales: "sales",
  customers: "customers",
  products: "products",
  inventory: "stock",
  cash: "cash",
  profit: "margin",
  staff: "labour",
  workshop: "workshop",
});

function listInEnglish(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

export function buildPlaybookVerdict(corpus: AnalysisCorpus, now = new Date()): string {
  const coverage = domainCoverage(corpus, now);
  const pressed = pressedDomains(coverage)
    .filter((domain) => domainAvailable(domain, corpus.connectors))
    .slice(0, 2)
    .map((domain) => DOMAIN_LABEL[domain]);
  const quiet = neglectedDomains(coverage)
    .filter((domain) => domainAvailable(domain, corpus.connectors))
    .slice(0, 2)
    .map((domain) => DOMAIN_LABEL[domain]);
  const stale = corpus.briefs.find((brief) => {
    const age = daysSince(brief.updatedAt, now);
    return /\bweek\b/iu.test(`${brief.title} ${brief.userQuestion}`) && age >= 6;
  });
  const research = corpus.proactive?.highlights.find((item) => item.tone !== "good")
    ?? corpus.proactive?.highlights[0];

  const parts: string[] = [];
  if (pressed.length > 0) {
    parts.push(`You've looked at ${listInEnglish(pressed)} recently.`);
  }
  if (quiet.length > 0) {
    parts.push(`${listInEnglish(quiet).replace(/^\w/u, (letter) => letter.toUpperCase())} ${quiet.length === 1 ? "has" : "have"} gone quiet.`);
  }
  if (stale) {
    parts.push(`The last weekly look is ${daysSince(stale.updatedAt, now)} days old.`);
  }
  if (research) {
    parts.push(`Overnight research flagged ${research.headline.replace(/\.$/u, "")}.`);
  }
  if (parts.length === 0) {
    return corpus.briefs.length > 0
      ? "The next useful move is the question you have not asked yet, not another recap."
      : "Albert will start recommending once there is an analysis to continue.";
  }
  return parts.join(" ").slice(0, 280);
}

export function compactCorpusForModel(corpus: AnalysisCorpus, now = new Date()) {
  const coverage = domainCoverage(corpus, now);
  return {
    coverage: coverage.map((item) => ({
      domain: item.domain,
      conversations: item.conversationCount,
      daysSinceLastAsk: item.daysSince,
      available: domainAvailable(item.domain, corpus.connectors),
    })),
    neglected: neglectedDomains(coverage).filter((domain) => domainAvailable(domain, corpus.connectors)),
    pressed: pressedDomains(coverage),
    conversations: corpus.briefs.map((brief) => ({
      conversationId: brief.conversationId,
      title: brief.title,
      asked: brief.userQuestion,
      alsoAsked: brief.askedQuestions.slice(0, 8),
      answer: brief.answerExcerpt.slice(0, 700),
      insights: brief.keyInsights.slice(0, 6),
      claims: brief.claims.slice(0, 6),
      unusedFollowUps: brief.followUps.slice(0, 4),
      daysAgo: daysSince(brief.updatedAt, now),
    })),
    history: corpus.coverage.slice(0, 40).map((thread) => ({
      title: thread.title,
      asked: thread.question,
      daysAgo: daysSince(thread.updatedAt, now),
    })),
    overnightResearch: corpus.proactive
      ? {
          verdict: corpus.proactive.verdict,
          highlights: corpus.proactive.highlights.slice(0, 5),
        }
      : null,
    vocabulary: corpus.vocabulary.slice(0, 16),
    connectedTools: corpus.connectors,
  };
}
