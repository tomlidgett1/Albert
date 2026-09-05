import { ALBERT_V3_AGENT_CONFIG } from "./generated-agent-config.js";
import { ALBERT_DEFAULT_CURRENCY } from "./defaults.js";

export type AccessibleView = Readonly<{
  name: string;
  guidance: string;
  /** Optional terse purpose used by the compact index instead of long guidance. */
  purpose?: string;
  /** Reviewed business phrases that should route strongly to this view. */
  routingTerms: readonly string[];
  /** Optional reviewed measure names; live metadata validates and supplies fallbacks. */
  keyMetrics: readonly string[];
  /** The tool the view's data comes from (lightspeed, deputy, ...). */
  connector: string;
}>;

export type LaneBudget = Readonly<{
  reasoningEffort: "low" | "medium" | "high";
  maxQueries: number;
  maxBranches?: number;
}>;

export type AgentRequestedRule = Readonly<{
  name: string;
  description: string;
  body: string;
}>;

export type AlwaysRule = Readonly<{
  name: string;
  body: string;
}>;

/**
 * A certified query flagged as a recipe is a complete fast-path answer for a
 * recognised question shape (the head of the question distribution): the
 * intent orchestrator may route straight to it, the engine executes it and
 * composes the answer without the agentic lane. Recipes are declared per view
 * in the agent config; the mechanism is connector-agnostic.
 */
export type CertifiedQueryRecipe = Readonly<{
  presentation: "fact" | "list" | "table" | "line" | "bar";
  /** One or two sentences of guidance for composing the answer. */
  answerHint?: string;
  /** Time member whose dateRange the orchestrator may set from the question. */
  dateParameter?: string;
  /** Extra phrasings that should match this recipe (shown to the orchestrator). */
  matches?: readonly string[];
  /**
   * What an empty result MEANS for this question ("no open shifts", "nobody
   * on leave"). When set, zero rows is a complete answer and the recipe lane
   * composes it directly instead of escalating to the diagnostic lanes.
   */
  emptyAnswer?: string;
  /** Trusted first-row interpolation template compiled from recipe frontmatter. */
  answerTemplate?: string;
  /** Static owner-voice next questions used only with a deterministic template. */
  followUps?: readonly string[];
}>;

export type CertifiedQuery = Readonly<{
  name: string;
  userRequest: string;
  notes: string;
  query: unknown;
  recipe?: CertifiedQueryRecipe;
}>;

export type SkillDefinition = Readonly<{
  name: string;
  title: string;
  description: string;
  body: string;
}>;

/** A tiny query that reveals how far a connector's data actually runs (see freshness.ts). */
export type FreshnessProbe = Readonly<{
  connector: string;
  domain: string;
  /** Fully qualified time dimension, e.g. sales_analytics.completed_at. */
  member: string;
}>;

/**
 * A small governed query the business-context generator runs to learn what a
 * business is (see context-layer/). Declared per connector in config.yml.
 */
export type ContextProbe = Readonly<{
  connector: string;
  key: string;
  purpose: string;
  /** Cube query JSON (measures/dimensions/timeDimensions/filters/order/limit). */
  query: Readonly<Record<string, unknown>>;
  /** Rows kept for the generator (default 24). */
  rows: number;
}>;

export type AlbertV3AgentConfig = Readonly<{
  freshnessProbes: readonly FreshnessProbe[];
  contextProbes: readonly ContextProbe[];
  accessibleViews: readonly AccessibleView[];
  lanes: Readonly<Record<"quick" | "analytical" | "deep", LaneBudget>>;
  timezone: string;
  currency: string;
  alwaysRulesBlock: string;
  /** Structured form used to disclose only deterministic route-relevant packs. */
  alwaysRules: readonly AlwaysRule[];
  agentRequestedRules: readonly AgentRequestedRule[];
  certifiedQueries: readonly CertifiedQuery[];
  skills: readonly SkillDefinition[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function laneBudget(raw: unknown, fallback: LaneBudget): LaneBudget {
  if (!isRecord(raw)) return fallback;
  const effort = raw.reasoning_effort;
  return Object.freeze({
    reasoningEffort: effort === "low" || effort === "medium" || effort === "high"
      ? effort
      : fallback.reasoningEffort,
    maxQueries: typeof raw.max_queries === "number" ? raw.max_queries : fallback.maxQueries,
    ...(typeof raw.max_branches === "number" ? { maxBranches: raw.max_branches } : {}),
  });
}

let cached: AlbertV3AgentConfig | undefined;

const SUPPORTED_VIEW_CONNECTORS = new Set([
  "lightspeed", "lightspeed-x", "xero", "deputy", "square", "shopify", "stripe",
  "momence", "meta-ads", "google-ads",
]);

/** Parses and validates the bundled agents/ configuration once per process. */
export function loadAgentConfig(): AlbertV3AgentConfig {
  if (cached) return cached;
  const { alwaysRules, agentRequestedRules, certifiedQueries, skills } = ALBERT_V3_AGENT_CONFIG;
  // The generated literal narrows unhelpfully; treat it as untrusted input.
  const config = ALBERT_V3_AGENT_CONFIG.config as Record<string, unknown>;

  const rawViews = Array.isArray(config.accessible_views) ? config.accessible_views : [];
  const accessibleViews = rawViews.map((view, index): AccessibleView => {
    if (!isRecord(view) || typeof view.name !== "string" || !/^[a-z][a-z0-9_]*$/u.test(view.name)) {
      throw new Error(`Albert v3 accessible view ${index + 1} has an invalid name.`);
    }
    if (typeof view.connector !== "string" || !SUPPORTED_VIEW_CONNECTORS.has(view.connector)) {
      throw new Error(`Albert v3 accessible view "${view.name}" has no supported connector mapping.`);
    }
    return Object.freeze({
      name: view.name,
      guidance: typeof view.guidance === "string" ? view.guidance.trim() : "",
      ...(typeof view.purpose === "string" && view.purpose.trim()
        ? { purpose: view.purpose.trim() }
        : {}),
      routingTerms: Object.freeze(Array.isArray(view.routing_terms)
        ? view.routing_terms.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : []),
      keyMetrics: Object.freeze(Array.isArray(view.key_metrics)
        ? view.key_metrics.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : []),
      connector: view.connector,
    });
  });
  if (accessibleViews.length === 0) {
    throw new Error("The Albert v3 agent config declares no accessible views.");
  }
  if (new Set(accessibleViews.map(({ name }) => name)).size !== accessibleViews.length) {
    throw new Error("The Albert v3 agent config declares duplicate accessible view names.");
  }

  const lanesRaw = isRecord(config.lanes) ? config.lanes : {};
  const defaults = isRecord(config.defaults) ? config.defaults : {};
  const freshnessProbes: FreshnessProbe[] = (Array.isArray(config.freshness_probes) ? config.freshness_probes : [])
    .flatMap((raw: unknown) => {
      if (!isRecord(raw)) return [];
      const connector = typeof raw.connector === "string" ? raw.connector : "";
      const domain = typeof raw.domain === "string" ? raw.domain : "";
      const member = typeof raw.member === "string" ? raw.member : "";
      if (!connector || !domain || !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u.test(member)) return [];
      return [Object.freeze({ connector, domain, member })];
    });

  const contextProbes: ContextProbe[] = (Array.isArray(config.context_probes) ? config.context_probes : [])
    .flatMap((raw: unknown) => {
      if (!isRecord(raw)) return [];
      const connector = typeof raw.connector === "string" ? raw.connector : "";
      const key = typeof raw.key === "string" ? raw.key : "";
      const purpose = typeof raw.purpose === "string" ? raw.purpose.trim() : "";
      if (!connector || !/^[a-z][a-z0-9_]{1,60}$/u.test(key) || !purpose || !isRecord(raw.query)) return [];
      const rows = typeof raw.rows === "number" && raw.rows >= 1 && raw.rows <= 60 ? Math.floor(raw.rows) : 24;
      return [Object.freeze({ connector, key, purpose, query: Object.freeze({ ...raw.query }), rows })];
    });
  if (new Set(contextProbes.map((probe) => probe.key)).size !== contextProbes.length) {
    throw new Error("The Albert v3 agent config declares duplicate context probe keys.");
  }

  cached = Object.freeze({
    freshnessProbes: Object.freeze(freshnessProbes),
    contextProbes: Object.freeze(contextProbes),
    accessibleViews: Object.freeze(accessibleViews),
    lanes: Object.freeze({
      quick: laneBudget(lanesRaw.quick, { reasoningEffort: "low", maxQueries: 3 }),
      analytical: laneBudget(lanesRaw.analytical, { reasoningEffort: "medium", maxQueries: 8 }),
      deep: laneBudget(lanesRaw.deep, { reasoningEffort: "high", maxQueries: 30, maxBranches: 5 }),
    }),
    timezone: typeof defaults.timezone === "string" ? defaults.timezone : "Australia/Melbourne",
    currency: typeof defaults.currency === "string" ? defaults.currency : ALBERT_DEFAULT_CURRENCY,
    alwaysRulesBlock: alwaysRules.map((rule) => rule.body).join("\n\n"),
    alwaysRules: Object.freeze(alwaysRules.map((rule) => Object.freeze({ ...rule }))),
    agentRequestedRules: Object.freeze(agentRequestedRules.map((rule) => Object.freeze({ ...rule }))),
    certifiedQueries: Object.freeze(certifiedQueries.map((query) => {
      const recipe = "recipe" in query ? query.recipe as CertifiedQueryRecipe | undefined : undefined;
      return Object.freeze({
        name: query.name,
        userRequest: query.userRequest,
        notes: query.notes,
        query: query.query,
        ...(recipe ? {
          recipe: Object.freeze({
            ...recipe,
            ...(recipe.matches ? { matches: Object.freeze([...recipe.matches]) } : {}),
            ...(recipe.followUps ? { followUps: Object.freeze([...recipe.followUps]) } : {}),
          }),
        } : {}),
      });
    })),
    skills: Object.freeze(skills.map((skill) => Object.freeze({ ...skill }))),
  });
  return cached;
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "by", "do", "for", "from", "how", "i", "in", "is",
  "it", "me", "my", "of", "on", "or", "our", "show", "the", "this", "to",
  "we", "what", "which", "who", "with",
]);

/** Temporal and interrogative leftovers that must not decide a recipe on their own. */
const GENERIC_MATCH_TOKENS = new Set([
  ...STOP_WORDS,
  "about", "across", "amount", "average", "coming", "count", "currently",
  "date", "days", "did", "far", "figure", "given", "had", "has", "have",
  "into", "just", "last", "many", "month", "much", "need", "next", "now",
  "number", "onto", "over", "period", "please", "quarter", "recipe",
  "right", "still", "than", "today", "tomorrow", "total", "value", "week",
  "were", "within", "year", "yesterday", "yet",
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
      .map((token) => (
        token.length > 4 && token.endsWith("s") && !token.endsWith("ss")
          ? token.slice(0, -1)
          : token
      )),
  );
}

function distinctiveTokens(text: string): Set<string> {
  return new Set([...tokens(text)].filter((token) => !GENERIC_MATCH_TOKENS.has(token)));
}

function overlapScore(question: Set<string>, candidate: string): number {
  const candidateTokens = tokens(candidate);
  if (candidateTokens.size === 0) return 0;
  let hits = 0;
  for (const token of candidateTokens) {
    if (question.has(token)) hits += 1;
  }
  return hits / Math.sqrt(candidateTokens.size);
}

/** A listed phrasing scores only when its distinctive words appear in the question. */
function matchPhraseScore(question: string, phrase: string): number {
  const questionTokens = tokens(question);
  const phraseDistinct = distinctiveTokens(phrase);
  if (phraseDistinct.size === 0) {
    const phraseTokens = tokens(phrase);
    if (phraseTokens.size === 0) return 0;
    for (const token of phraseTokens) {
      if (!questionTokens.has(token)) return 0;
    }
    return overlapScore(questionTokens, phrase);
  }
  const questionDistinct = distinctiveTokens(question);
  for (const token of phraseDistinct) {
    if (!questionDistinct.has(token) && !questionTokens.has(token)) return 0;
  }
  return overlapScore(questionTokens, phrase);
}

function certifiedQueryScore(question: string, query: CertifiedQuery): number {
  const haystack = `${query.name} ${query.userRequest} ${(query.recipe?.matches ?? []).join(" ")}`;
  const questionDistinct = distinctiveTokens(question);
  if (questionDistinct.size === 0) {
    // "Who is on tomorrow?" is only stop/period words. Score listed
    // phrasings so a who/period roster ask can still match.
    let phraseBest = 0;
    for (const phrase of query.recipe?.matches ?? []) {
      phraseBest = Math.max(phraseBest, matchPhraseScore(question, phrase));
    }
    return phraseBest;
  }
  const recipeDistinct = distinctiveTokens(haystack);
  let shared = 0;
  for (const token of questionDistinct) {
    if (recipeDistinct.has(token)) shared += 1;
  }
  if (shared === 0) return 0;
  const questionTokens = tokens(question);
  let best = Math.max(
    overlapScore(questionTokens, `${query.name} ${query.userRequest}`),
    overlapScore(questionTokens, query.name),
  );
  for (const phrase of query.recipe?.matches ?? []) {
    best = Math.max(best, matchPhraseScore(question, phrase));
  }
  return best;
}

export type ScoredCertifiedQuery = Readonly<{
  query: CertifiedQuery;
  score: number;
}>;

/**
 * Matches agent_requested rules against the question via token overlap on the
 * rule's description, exactly the progressive-disclosure contract Cube uses:
 * the body only enters the prompt when the description matches.
 */
const VIEW_MENTION = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)*_(?:analytics|explorer))\b/gu;

/** Connectors behind every semantic view a piece of text names; empty when it names none. */
export function connectorsMentionedIn(text: string, config: AlbertV3AgentConfig): ReadonlySet<string> {
  const byView = new Map(config.accessibleViews.map((view) => [view.name, view.connector]));
  const found = new Set<string>();
  for (const match of text.matchAll(VIEW_MENTION)) {
    const connector = byView.get(match[1]!);
    if (connector) found.add(connector);
  }
  return found;
}

/** Connectors a certified query executes against, derived from its member prefixes. */
export function certifiedQueryConnectors(
  query: CertifiedQuery,
  config: AlbertV3AgentConfig,
): ReadonlySet<string> {
  return connectorsMentionedIn(JSON.stringify(query.query), config);
}

/**
 * True when text bound to particular connectors is usable on this route: it
 * names no connector at all, or every connector it names is connected. A
 * certified X-Series query must never be offered as a "trusted starting
 * point" to a tenant that only runs R-Series.
 */
function usableOnRoute(
  mentioned: ReadonlySet<string>,
  allowedConnectors: readonly string[] | undefined,
): boolean {
  if (!allowedConnectors || mentioned.size === 0) return true;
  const allowed = new Set(allowedConnectors);
  return [...mentioned].every((connector) => allowed.has(connector));
}

export function matchAgentRequestedRules(
  question: string,
  config: AlbertV3AgentConfig,
  limit = 2,
  allowedConnectors?: readonly string[],
): readonly AgentRequestedRule[] {
  const questionTokens = tokens(question);
  return config.agentRequestedRules
    .filter((rule) => usableOnRoute(connectorsMentionedIn(rule.body, config), allowedConnectors))
    .map((rule) => ({ rule, score: overlapScore(questionTokens, `${rule.name} ${rule.description}`) }))
    .filter(({ score }) => score >= 0.55)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ rule }) => rule);
}

/** Certified Cube queries scored against the question, highest first. */
export function scoreCertifiedQueries(
  question: string,
  config: AlbertV3AgentConfig,
  limit = 3,
  allowedConnectors?: readonly string[],
): readonly ScoredCertifiedQuery[] {
  return config.certifiedQueries
    .filter((query) => usableOnRoute(certifiedQueryConnectors(query, config), allowedConnectors))
    .map((query) => ({ query, score: certifiedQueryScore(question, query) }))
    .filter(({ score }) => score >= 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Certified Cube queries whose name, request, or listed matches resemble the question. */
export function matchCertifiedQueries(
  question: string,
  config: AlbertV3AgentConfig,
  limit = 3,
  allowedConnectors?: readonly string[],
): readonly CertifiedQuery[] {
  return scoreCertifiedQueries(question, config, limit, allowedConnectors)
    .map(({ query }) => query);
}

/** Certified recipes usable on this route (every connector they touch is connected). */
export function recipesForRoute(
  config: AlbertV3AgentConfig,
  allowedConnectors?: readonly string[],
): readonly CertifiedQuery[] {
  return config.certifiedQueries
    .filter((query) => query.recipe)
    .filter((query) => usableOnRoute(certifiedQueryConnectors(query, config), allowedConnectors));
}

export function findCertifiedQuery(name: string, config: AlbertV3AgentConfig): CertifiedQuery | undefined {
  const wanted = name.trim().toLowerCase();
  return config.certifiedQueries.find((query) => query.name.toLowerCase() === wanted);
}

/** The compact skills catalogue the agent sees before any skill is loaded. */
export function renderSkillsCatalogue(config: AlbertV3AgentConfig): string {
  if (config.skills.length === 0) return "(no skills installed)";
  return config.skills
    .map((skill) => `- ${skill.name}: ${skill.title}. ${skill.description}`)
    .join("\n");
}

export function findSkill(name: string, config: AlbertV3AgentConfig): SkillDefinition | undefined {
  return config.skills.find((skill) => skill.name === name);
}
