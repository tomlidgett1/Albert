import {
  recipesForRoute,
  scoreCertifiedQueries,
  type AlbertV3AgentConfig,
  type CertifiedQuery,
} from "../../albert-v3/src/agent-config/loader.js";
import { extractRecipePeriod } from "../../albert-v3/src/recipes/runtime.js";
import type { CodexServiceTurn } from "./contracts.js";

const BREAKDOWN_QUESTION = /\b(?:against|bar|break\s*down|breakdown|by|chart|compare|comparison|daily|each|graph|highest|lowest|monthly|per|rank|ranking|top|trend|versus|vs\.?|weekly)\b/iu;
const LIST_ASK = /\b(?:who|which|list)\b/iu;
const REFERENTIAL_REFINEMENT = /^(?:also|and|but|now|same|what about)\b|\b(?:again|above|earlier|instead|previous|same|that|those|too)\b/iu;
const CLAUSE_SPLIT = /\s*(?:,|;|&|\+|\/|\band\b|\bplus\b|\bas well as\b|\balong with\b|\btogether with\b|\balso\b)\s*/iu;
const PERIOD_ONLY_CLAUSE = /^(?:today|yesterday|tomorrow|this week|last week|next week|this month|last month|next month|this quarter|last quarter|this year|last year|this financial year|last financial year|please|thanks)$/iu;
/** Top recipe must beat the runner-up by this margin or the path fail-opens. */
const RECIPE_SCORE_MARGIN = 0.22;

export type CodexDeterministicRecipeMatch = Readonly<{
  recipe: CertifiedQuery;
  dateRange?: string;
  periodLabel?: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A deterministic fact recipe must produce one aggregate row, never a grouped series/list. */
function isDeterministicScalarRecipe(recipe: CertifiedQuery): boolean {
  if (recipe.recipe?.presentation !== "fact" || !recipe.recipe.answerTemplate) return false;
  if (!isRecord(recipe.query)) return false;
  if (Array.isArray(recipe.query.dimensions) && recipe.query.dimensions.length > 0) return false;
  const timeDimensions = Array.isArray(recipe.query.timeDimensions)
    ? recipe.query.timeDimensions.filter(isRecord)
    : [];
  return timeDimensions.every((dimension) => dimension.granularity === undefined);
}

/** A deterministic list recipe answers with a table plus a row-count sentence. */
function isDeterministicListRecipe(recipe: CertifiedQuery): boolean {
  if (recipe.recipe?.presentation !== "list" || !recipe.recipe.answerTemplate) return false;
  if (!isRecord(recipe.query)) return false;
  const timeDimensions = Array.isArray(recipe.query.timeDimensions)
    ? recipe.query.timeDimensions.filter(isRecord)
    : [];
  return timeDimensions.every((dimension) => dimension.granularity === undefined);
}

function isDeterministicFastPathRecipe(recipe: CertifiedQuery): boolean {
  return isDeterministicScalarRecipe(recipe) || isDeterministicListRecipe(recipe);
}

export function activeCubeConnectors(turn: CodexServiceTurn): readonly string[] {
  return [...new Set(turn.activeConnectors.flatMap((connector) => {
    const normalized = connector.trim().toLowerCase().replaceAll("_", "-");
    if (normalized === "lightspeed-r" || normalized === "fivetran-lightspeed") return ["lightspeed"];
    if (normalized === "lightspeed-x-series") return ["lightspeed-x"];
    return /^[a-z][a-z0-9-]{0,39}$/u.test(normalized) ? [normalized] : [];
  }))];
}

function splitAskClauses(message: string): readonly string[] {
  return message
    .split(CLAUSE_SPLIT)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4 && !PERIOD_ONLY_CLAUSE.test(part));
}

function recipeCoverageTokens(recipe: CertifiedQuery): ReadonlySet<string> {
  return new Set(
    `${recipe.name} ${recipe.userRequest} ${(recipe.recipe?.matches ?? []).join(" ")}`
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length > 2)
      .map((token) => (
        token.length > 4 && token.endsWith("s") && !token.endsWith("ss")
          ? token.slice(0, -1)
          : token
      )),
  );
}

function clauseDistinctiveTokens(clause: string): readonly string[] {
  return clause
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 2)
    .map((token) => (
      token.length > 4 && token.endsWith("s") && !token.endsWith("ss")
        ? token.slice(0, -1)
        : token
    ))
    .filter((token) => !PERIOD_ONLY_CLAUSE.test(token) && !/^(?:show|the|this|that|last|next|much|many|did|were|have|total|period|today|yesterday|tomorrow|week|month|year|quarter|value|average|count|number|figure|amount)$/u.test(token));
}

function questionCoverageCount(message: string, recipe: CertifiedQuery): number {
  const covered = recipeCoverageTokens(recipe);
  return clauseDistinctiveTokens(message).filter((token) => covered.has(token)).length;
}

/**
 * Two independently recognised recipes joined by "and"/comma is a
 * coordinated ask. Idioms that one recipe already names ("hours and wages",
 * "cash in and out") stay on that recipe.
 */
function hasUncoveredFastPathClause(
  message: string,
  winner: CertifiedQuery,
  config: AlbertV3AgentConfig,
  connectors: readonly string[],
): boolean {
  const clauses = splitAskClauses(message);
  if (clauses.length < 2) return false;
  const covered = recipeCoverageTokens(winner);
  const leftovers = clauses.flatMap((clause) => clauseDistinctiveTokens(clause))
    .filter((token) => !covered.has(token));
  if (leftovers.length === 0) return false;
  const routeRecipes = new Set(recipesForRoute(config, connectors));
  return config.certifiedQueries.some((candidate) => {
    if (candidate.name === winner.name || !routeRecipes.has(candidate) || !isDeterministicFastPathRecipe(candidate)) {
      return false;
    }
    const other = recipeCoverageTokens(candidate);
    return leftovers.some((token) => other.has(token));
  });
}

function uniqueEligibleRecipe(
  message: string,
  config: AlbertV3AgentConfig,
  connectors: readonly string[],
  eligible: (recipe: CertifiedQuery) => boolean,
): CertifiedQuery | undefined {
  const routeRecipes = new Set(recipesForRoute(config, connectors));
  const scored = scoreCertifiedQueries(message, config, 8, connectors)
    .filter((candidate) => routeRecipes.has(candidate.query))
    .filter((candidate) => eligible(candidate.query));
  if (scored.length === 0) return undefined;
  const ranked = [...scored].sort((left, right) => {
    const coverage = questionCoverageCount(message, right.query) - questionCoverageCount(message, left.query);
    if (coverage !== 0) return coverage;
    return right.score - left.score;
  });
  if (ranked.length === 1) return ranked[0]!.query;
  const top = ranked[0]!;
  const second = ranked[1]!;
  if (questionCoverageCount(message, top.query) > questionCoverageCount(message, second.query)) {
    return top.query;
  }
  if (top.score >= second.score + RECIPE_SCORE_MARGIN) return top.query;
  return undefined;
}

/**
 * Certified recipes worth offering as the first Cube query on the model path.
 * Includes list/table recipes the scalar preflight cannot answer.
 */
export function preferredCodexCertifiedQueries(
  turn: CodexServiceTurn,
  config: AlbertV3AgentConfig,
  limit = 2,
): readonly CertifiedQuery[] {
  const connectors = activeCubeConnectors(turn);
  if (connectors.length === 0) return [];
  const routeRecipes = new Set(recipesForRoute(config, connectors));
  return scoreCertifiedQueries(turn.message, config, limit, connectors)
    .filter((candidate) => routeRecipes.has(candidate.query) || !candidate.query.recipe)
    .slice(0, limit)
    .map((candidate) => candidate.query);
}

/**
 * Selects the zero-model Codex recipe lane.
 *
 * It requires one unambiguous, connected, templated certified recipe: a
 * scalar fact, or a list whose answer is the table plus a row-count
 * sentence. Anything broader or referential stays on the full Codex path.
 */
export function matchCodexDeterministicRecipe(
  turn: CodexServiceTurn,
  config: AlbertV3AgentConfig,
): CodexDeterministicRecipeMatch | undefined {
  if (turn.analysisBrief && turn.analysisBrief.id !== "general_analysis_v1") return undefined;
  if (BREAKDOWN_QUESTION.test(turn.message)) return undefined;
  if (turn.priorConversation.length > 0 && REFERENTIAL_REFINEMENT.test(turn.message)) return undefined;

  const connectors = activeCubeConnectors(turn);
  if (connectors.length === 0) return undefined;

  const recipe = LIST_ASK.test(turn.message)
    ? uniqueEligibleRecipe(turn.message, config, connectors, isDeterministicListRecipe)
    : uniqueEligibleRecipe(turn.message, config, connectors, isDeterministicFastPathRecipe);
  if (!recipe) return undefined;
  if (hasUncoveredFastPathClause(turn.message, recipe, config, connectors)) return undefined;

  const period = extractRecipePeriod(turn.message);
  // Never silently substitute a recipe's default period. Explicitly
  // parameterised recipes accelerate only when trusted code resolved the
  // owner's period; the general runtime owns all other wording.
  if (recipe.recipe?.dateParameter && !period) return undefined;
  return Object.freeze({
    recipe,
    ...(period ? { dateRange: period.dateRange, periodLabel: period.label } : {}),
  });
}
