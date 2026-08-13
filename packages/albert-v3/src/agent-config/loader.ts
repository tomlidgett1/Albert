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

export type CertifiedQuery = Readonly<{
  name: string;
  userRequest: string;
  notes: string;
  query: unknown;
}>;

export type SkillDefinition = Readonly<{
  name: string;
  title: string;
  description: string;
  body: string;
}>;

export type AlbertV3AgentConfig = Readonly<{
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

  cached = Object.freeze({
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
    certifiedQueries: Object.freeze(certifiedQueries.map((query) => Object.freeze({
      name: query.name,
      userRequest: query.userRequest,
      notes: query.notes,
      query: query.query,
    }))),
    skills: Object.freeze(skills.map((skill) => Object.freeze({ ...skill }))),
  });
  return cached;
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "by", "do", "for", "from", "how", "i", "in", "is",
  "it", "me", "my", "of", "on", "or", "our", "show", "the", "this", "to",
  "we", "what", "which", "who", "with",
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
  );
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

/**
 * Matches agent_requested rules against the question via token overlap on the
 * rule's description, exactly the progressive-disclosure contract Cube uses:
 * the body only enters the prompt when the description matches.
 */
export function matchAgentRequestedRules(
  question: string,
  config: AlbertV3AgentConfig,
  limit = 2,
): readonly AgentRequestedRule[] {
  const questionTokens = tokens(question);
  return config.agentRequestedRules
    .map((rule) => ({ rule, score: overlapScore(questionTokens, `${rule.name} ${rule.description}`) }))
    .filter(({ score }) => score >= 0.55)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ rule }) => rule);
}

/** Certified Cube queries whose user_request resembles the incoming question. */
export function matchCertifiedQueries(
  question: string,
  config: AlbertV3AgentConfig,
  limit = 3,
): readonly CertifiedQuery[] {
  const questionTokens = tokens(question);
  return config.certifiedQueries
    .map((query) => ({ query, score: overlapScore(questionTokens, `${query.name} ${query.userRequest}`) }))
    .filter(({ score }) => score >= 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ query }) => query);
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
