/**
 * Semantic memory: deterministic per-tenant vocabulary rules Albert has
 * learned from conversations (ADR 0115).
 *
 * A rule binds a phrase the owner uses ("general service") to what it means in
 * the governed catalogue (the item "Service - General Service" in
 * product_sales_analytics, not the "Services" category). Rules are captured by
 * the runtime's remember_term tool when the owner corrects an interpretation
 * or asks Albert to remember one, stored in the control plane, reviewable in
 * Settings, and injected into any later turn whose message contains the term.
 *
 * Everything in this module is pure: normalisation, matching and rendering.
 * Persistence lives in services/control-plane/src/semantic-memory-repository.
 */

export type SemanticMemoryBinding = Readonly<{
  view: string;
  dimension?: string;
  value?: string;
}>;

export type SemanticMemoryRule = Readonly<{
  ruleId: string;
  kind: "term_binding" | "preference";
  term: string;
  meaning: string;
  counterMeaning?: string;
  binding?: SemanticMemoryBinding;
  status: "proposed" | "confirmed" | "retired";
  source: "albert" | "owner";
  useCount: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string | null;
  sourceConversationId?: string | null;
}>;

/** The bounded subset of a rule that travels inside a runtime turn. */
export type SemanticMemoryTurnRule = Readonly<{
  term: string;
  meaning: string;
  counterMeaning?: string;
  binding?: SemanticMemoryBinding;
  status: "proposed" | "confirmed";
}>;

export const SEMANTIC_MEMORY_TURN_LIMIT = 12;

/** Lowercased, punctuation-free, single-spaced form used for matching and dedupe. */
export function normalizeSemanticTerm(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

/** Light stem so "general services" still matches the rule "general service". */
function stemToken(token: string): string {
  if (token.length > 2 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function containsTokenSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[start + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * The rules whose term appears in the message, strongest first: confirmed
 * before proposed, more specific (longer) terms before shorter, then most
 * used. Bounded so a large rulebook cannot flood a turn.
 */
export function matchSemanticRules<Rule extends Readonly<{
  term: string;
  status: string;
  useCount?: number;
}>>(message: string, rules: readonly Rule[], limit = SEMANTIC_MEMORY_TURN_LIMIT): readonly Rule[] {
  const messageTokens = normalizeSemanticTerm(message).split(" ").filter(Boolean).map(stemToken);
  return rules
    .filter((rule) => rule.status === "confirmed" || rule.status === "proposed")
    .filter((rule) => {
      const termTokens = normalizeSemanticTerm(rule.term).split(" ").filter(Boolean).map(stemToken);
      return containsTokenSequence(messageTokens, termTokens);
    })
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "confirmed" ? -1 : 1;
      const lengthDelta = normalizeSemanticTerm(b.term).length - normalizeSemanticTerm(a.term).length;
      if (lengthDelta !== 0) return lengthDelta;
      return (b.useCount ?? 0) - (a.useCount ?? 0);
    })
    .slice(0, Math.max(0, limit));
}

/** One rule as a compact line for the runtime's turn input. */
export function describeSemanticRule(rule: SemanticMemoryTurnRule): string {
  const bound = rule.binding
    ? ` [${rule.binding.dimension ?? rule.binding.view}${rule.binding.value ? ` = ${JSON.stringify(rule.binding.value)}` : ""}]`
    : "";
  const counter = rule.counterMeaning ? ` — not ${rule.counterMeaning}` : "";
  const provisional = rule.status === "proposed" ? " (unconfirmed — apply it, but note the interpretation)" : "";
  return `"${rule.term}" means ${rule.meaning}${bound}${counter}${provisional}`;
}
