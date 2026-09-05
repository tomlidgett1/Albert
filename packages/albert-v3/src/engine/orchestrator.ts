import { Agent, type AgentInputItem, type Runner, assistant, user } from "@openai/agents";
import { z } from "zod";
import { isAnthropicModel, isXaiModel, type AgentRunPreferences, type PresentedTableDigest } from "../../../shared/src/index.js";
import { recipesForRoute, type AlbertV3AgentConfig } from "../agent-config/loader.js";
import type { TenantSourceFinding } from "./context.js";
import { normalizeV3Connector } from "./connector-routing.js";
import {
  laneModelSettings,
  todayLine,
  v3PromptCacheKey,
  withV3PromptCacheBoundary,
} from "./lanes.js";
import { specialistAgentFromConfig } from "../specialist-agents/registry.js";

export const LANES = ["quick", "analytical", "deep", "explain", "represent", "meta", "conceptual", "social", "clarification", "off_topic"] as const;
export type Lane = (typeof LANES)[number];

export const intentSchema = z.object({
  lane: z.enum(LANES),
  /** The question restated with references and ambiguity resolved. */
  resolvedQuestion: z.string().min(1).max(600),
  /** One sentence naming the practical goal behind the question; null when purely informational. */
  ownerGoal: z.string().max(300).nullable(),
  /** The shape of a useful answer; gates presentation (charts only fit magnitude shapes). */
  answerShape: z.enum(["fact", "list", "comparison", "trend", "breakdown", "diagnosis"]),
  /** Up to 4 points a genuinely useful answer must cover, from a critical reading of the question. */
  answerMustCover: z.array(z.string().min(3).max(200)).max(4),
  /** Assumptions made instead of asking; must be disclosed in the answer. */
  assumptions: z.array(z.string().max(200)).max(4),
  clarificationQuestion: z.string().max(240).nullable(),
  clarificationOptions: z.array(z.string().min(1).max(80)).max(4),
  /** Name of a certified recipe that answers the question directly (fast path), else null. */
  recipe: z.string().max(80).nullable(),
  /** The period the owner named for the recipe (Cube relative expression or YYYY-MM-DD,YYYY-MM-DD), else null. */
  recipeDateRange: z.string().max(80).nullable(),
  /** A single named entity the recipe should be narrowed to (a supplier, a person, a product), else null. */
  recipeEntity: z.string().max(120).nullable(),
  /** "id:kind" of a native connector capability that answers the question directly, else null. */
  nativeCapability: z.string().max(80).nullable(),
});

export type IntentDecision = z.infer<typeof intentSchema>;

export type ConversationMessage = Readonly<{
  role: "user" | "assistant";
  text: string;
  /** Governed typed queries (Cube YAML or non-executable ShopifyQL IR). */
  governedQueries?: readonly Readonly<{
    view: string;
    topic: string;
    queryYaml: string;
  }>[];
  resolvedSubject?: Readonly<{
    label: string;
    kind: string;
    resolvedQuestion: string;
  }>;
  /** The tables the owner saw with this answer (bounded digest). */
  presentedTables?: readonly PresentedTableDigest[];
}>;

/** Only the most recent assistant answers carry their full query YAML and tables. */
const GOVERNED_QUERY_CONTEXT_TURNS = 2;

function renderCell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return value.replace(/\s*\|\s*/gu, " / ").replace(/\s+/gu, " ").trim();
}

/**
 * The tables the owner is looking at, rendered compactly so the next turn can
 * resolve "what subscriptions do we have?" against the Subscriptions line of
 * the statement on screen. Pipe-separated rows keep it small and unambiguous.
 */
export function renderPresentedTables(tables: readonly PresentedTableDigest[]): string {
  return tables.map((table) => {
    const shown = table.rows.length;
    const header = `### Table shown: ${table.caption} (${table.rowCount} row${table.rowCount === 1 ? "" : "s"}${shown < table.rowCount ? `; first ${shown} listed` : ""})`;
    const columns = table.columns.map(renderCell).join(" | ");
    const rows = table.rows.map((row) => row.map(renderCell).join(" | ")).join("\n");
    return `${header}\n${columns}\n${rows}`;
  }).join("\n");
}

function renderAssistantMessage(
  message: ConversationMessage,
  includeQueries: boolean,
): string {
  if (!includeQueries) return message.text;
  const sections: string[] = [message.text];
  if (message.presentedTables?.length) {
    sections.push(
      `[Tables the owner saw with this answer. When the next message names one of these rows, lines, accounts, products, people or suppliers, it refers to THAT entry: resolve it to the exact label below and, for a statement line, to the account and period of the statement.]\n${renderPresentedTables(message.presentedTables)}`,
    );
  }
  if (message.governedQueries?.length) {
    const queries = message.governedQueries
      .map((query) => `### ${query.topic} (view: ${query.view})\n${query.queryYaml}`)
      .join("\n");
    sections.push(`[Governed typed queries that produced this answer. Views beginning shopifyql: and shopify-admin: contain safe typed IR and must be rerun only with run_shopifyql_query and run_shopify_admin_query respectively; views beginning xero-mcp: are live Xero statement tools that cannot be filtered or drilled; all other views are Cube YAML. For a follow-up, extend the relevant typed query rather than starting over.]\n${queries}`);
  }
  return sections.join("\n\n");
}

function lastAssistantMessage(
  messages: readonly ConversationMessage[],
): ConversationMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function priorUserMessage(
  messages: readonly ConversationMessage[],
  currentMessage: string,
): string | undefined {
  const users = messages.filter((message) => message.role === "user");
  if (users.length >= 2) return users.at(-2)?.text;
  if (users.length === 1 && users[0]?.text !== currentMessage) return users[0]?.text;
  return undefined;
}

/** Short refinements ("add GP too", "same but by store") after a prior answer. */
function looksLikeRefinement(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized || normalized.length > 160) return false;
  if (/^(add|include|also|and|plus|now|same)\b/.test(normalized)) return true;
  if (/\b(too|as well|aswell)\b/.test(normalized)) return true;
  if (/\b(gross profit|gp|cogs|margin)\b/.test(normalized) && normalized.length <= 80) return true;
  return false;
}

/** Meta questions about the previous answer ("what are you counting as X"). */
function looksLikeMetaQuestion(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized || normalized.length > 200) return false;
  return /^(what (do|are|did|does|is|was|were) (you|that|this|it)|how (did|do|are) you|what.s (included|counted|considered)|why (did|do) you)\b/.test(normalized)
    || /\b(consider(ing)?|count(ing)?|defin(e|ing|ition)|includ(e|ing|ed)|mean(ing)?|calculat(e|ed|ing))\b.*\bas\b/.test(normalized);
}

/**
 * When lease-release runtimes leave prior turns out of model context, the
 * classifier may still ask for clarification on obvious refinements or meta
 * questions about the previous answer. Override only when conversation history
 * shows a prior exchange to anchor to.
 */
export function coerceRefinementIntent(
  decision: IntentDecision,
  conversation: readonly ConversationMessage[],
  message: string,
): IntentDecision {
  if (decision.lane !== "clarification") return decision;
  const refinement = looksLikeRefinement(message);
  const metaQuestion = !refinement && looksLikeMetaQuestion(message);
  if (!refinement && !metaQuestion) return decision;

  const lastAssistant = lastAssistantMessage(conversation);
  const priorUser = priorUserMessage(conversation, message);
  const userTurnCount = conversation.filter((m) => m.role === "user").length;
  const hasPriorAnswer = Boolean(
    lastAssistant?.governedQueries?.length
    || lastAssistant?.presentedTables?.length
    || lastAssistant?.resolvedSubject
    || (lastAssistant?.text && userTurnCount >= 2),
  );
  if (!hasPriorAnswer || !priorUser) return decision;

  if (metaQuestion) {
    return {
      lane: "explain",
      resolvedQuestion: `Explain, from the previous answer and its recorded queries: ${message.trim()}`.slice(0, 600),
      ownerGoal: decision.ownerGoal,
      answerShape: "fact",
      answerMustCover: decision.answerMustCover,
      assumptions: decision.assumptions,
      clarificationQuestion: null,
      clarificationOptions: [],
      recipe: null,
      recipeDateRange: null,
      recipeEntity: null,
      nativeCapability: null,
    };
  }

  const resolvedQuestion = lastAssistant?.resolvedSubject?.resolvedQuestion
    ?? `${priorUser.trim()} (${message.trim()})`;

  return {
    lane: lastAssistant?.resolvedSubject?.kind === "deep" ? "deep" : "quick",
    resolvedQuestion: resolvedQuestion.slice(0, 600),
    ownerGoal: decision.ownerGoal,
    answerShape: decision.answerShape,
    answerMustCover: decision.answerMustCover,
    assumptions: decision.assumptions,
    clarificationQuestion: null,
    clarificationOptions: [],
    recipe: null,
    recipeDateRange: null,
    recipeEntity: null,
    nativeCapability: null,
  };
}

/**
 * Language that only makes sense with an earlier exchange: "the previously
 * requested chart", "the preceding request", "that table", "rerun it".
 * Deliberately narrow — "last month's sales result" is a fresh question.
 */
const REFERS_TO_EARLIER_WORK =
  /\b(?:previous(?:ly)?|preceding|earlier)\b.{0,30}\b(?:requested|request|answer|chart|graph|table|query|analysis)\b|\b(?:the same|that)\s+(?:chart|graph|table|answer|query)\b|\bre-?(?:run|do|try)\s+(?:the|that|it|this)\b/iu;

/**
 * A refinement needs something to refine. When the classifier resolves a
 * message like "have dates on x axis" into "present the previously requested
 * chart…" but the conversation holds no earlier owner message at all, the
 * lane would run no query and ship Unavailable (or run something invented).
 * Ask instead — the one case where clarification beats a working lane.
 */
export function guardOrphanRefinement(
  decision: IntentDecision,
  conversation: readonly ConversationMessage[],
  message: string,
): IntentDecision {
  if (decision.lane === "clarification" || decision.lane === "off_topic" || decision.lane === "social") return decision;
  const priorUser = priorUserMessage(conversation, message);
  if (priorUser) return decision;
  // Refinements are short; a long first message is a real question even if
  // it happens to mention "that chart".
  if (message.trim().length > 120) return decision;
  // Not looksLikeRefinement(): its "gross profit / margin" shortcut would
  // catch "what is my gross profit this month?" as a first question.
  const normalized = message.trim().toLowerCase();
  const deltaOnly = /^(?:add|include|also|and|plus|now|same|instead)\b/u.test(normalized)
    || /\b(?:too|as well|aswell)\s*[.!?]*$/u.test(normalized);
  const anchoredToEarlierWork = deltaOnly
    || REFERS_TO_EARLIER_WORK.test(decision.resolvedQuestion)
    || REFERS_TO_EARLIER_WORK.test(message);
  if (!anchoredToEarlierWork) return decision;
  return {
    ...decision,
    lane: "clarification",
    clarificationQuestion: "There isn't an earlier answer in this chat to change. What would you like me to look at?",
    clarificationOptions: [
      "Sales by month this year",
      "Sales yesterday",
      "Top products this month",
    ],
  };
}

const STRONG_DEFINITION_ONLY = /\b(?:define|explain|(?:can|could|would) you explain|definition of|meaning of|what does .{1,160}? mean|how (?:is|are|do|does) .{1,160}? (?:calculated|defined|work)|formula for|difference between|does .{1,160}? (?:include|exclude))\b/iu;
const WEAK_WHAT_IS = /^\s*(?:what (?:is|are)|what['’]s) .{2,120}\??\s*$/iu;
const COMMON_GOVERNED_CONCEPT = /\b(?:margin|profit|revenue|sales?|takings?|turnover|cogs|cost of goods|average order value|aov|refund rate|return on investment|roi|return on ad spend|roas|repeat purchase|retention|customer acquisition|cac|cash flow|payables?|receivables?|labour cost|wages?|inventory|stock|sell.?through|gross|net|gst|tax|ebitda)\b/iu;
const POSSESSIVE_BUSINESS_VALUE = /\b(?:my|our|we|us|this business(?:'s)?)\b/iu;
const NAMED_MONTH = /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/iu;
const ACTUAL_DATA_ACTION = /\b(?:show(?: me)?|give me|look up|pull|run|compare|versus|vs\.?|trend|rank|top|bottom|highest|lowest|break(?: it| that)? down|up|down|increase|decrease|how much|how many|what (?:is|was|are|were) (?:my|our)|calculate (?:my|our|the business))\b/iu;
const ACTUAL_TIME_SCOPE = /\b(?:today|yesterday|tomorrow|this (?:week|month|quarter|year|financial year)|last (?:week|month|quarter|year|financial year)|next (?:week|month|quarter|year)|current|actual|mtd|qtd|ytd|fytd|20\d{2}|\d{4}-\d{2}(?:-\d{2})?)\b/iu;
const ACTUAL_BREAKDOWN = /\bby (?:store|location|product|category|customer|employee|staff|supplier|channel|month|week|day)\b/iu;

function hasActualScope(message: string): boolean {
  if (ACTUAL_DATA_ACTION.test(message) || ACTUAL_TIME_SCOPE.test(message) || NAMED_MONTH.test(message) || ACTUAL_BREAKDOWN.test(message)) return true;
  // Entity scopes are data requests, but "return on investment/ad spend" are
  // concept names. Preserve those phrases and generic "for a retailer" while
  // catching concrete "at Fitzroy" / "on Trek Marlin" scopes.
  const withoutConceptPhrases = message
    .replace(/\breturn on (?:investment|ad spend)\b/giu, "")
    .replace(/\b(?:formula|definition|meaning|calculation)\s+for\b/giu, "");
  return /\b(?:at|on)\s+[A-Z][\w&'’-]*/u.test(withoutConceptPhrases);
}

/** High-precision definition intent used before any live-data capability runs. */
export function isDefinitionOnlyQuestion(message: string): boolean {
  const text = message.replace(/\s+/gu, " ").trim();
  if (!text) return false;
  if (hasActualScope(text)) return false;
  if (STRONG_DEFINITION_ONLY.test(text)) return true;
  return WEAK_WHAT_IS.test(text)
    && !POSSESSIVE_BUSINESS_VALUE.test(text)
    && COMMON_GOVERNED_CONCEPT.test(text);
}

/**
 * Keeps abstract definitions load-free while refusing to let a classifier send
 * a request for the owner's actual value down the no-query conceptual lane.
 */
export function normaliseConceptualIntent(
  decision: IntentDecision,
  message: string,
  hasPriorAnswer = false,
): IntentDecision {
  if (decision.lane === "conceptual") {
    const actualValue = hasActualScope(message)
      || (WEAK_WHAT_IS.test(message) && POSSESSIVE_BUSINESS_VALUE.test(message));
    if (!actualValue) return decision;
    const analytical = decision.answerShape === "comparison"
      || decision.answerShape === "trend"
      || decision.answerShape === "diagnosis";
    return {
      ...decision,
      lane: analytical ? "analytical" : "quick",
      recipe: null,
      recipeDateRange: null,
      recipeEntity: null,
      nativeCapability: null,
    };
  }
  const definitionOnly = isDefinitionOnlyQuestion(message);
  if (definitionOnly) {
    const eligible = ["quick", "analytical", "deep"].includes(decision.lane)
      || (decision.lane === "explain" && !hasPriorAnswer);
    if (!eligible) return decision;
    return {
      ...decision,
      lane: "conceptual",
      answerShape: "fact",
      ownerGoal: null,
      answerMustCover: [],
      assumptions: [],
      clarificationQuestion: null,
      clarificationOptions: [],
      recipe: null,
      recipeDateRange: null,
      recipeEntity: null,
      nativeCapability: null,
    };
  }
  return decision;
}

export function buildConversationInput(
  messages: readonly ConversationMessage[],
  currentMessage: string,
): AgentInputItem[] {
  // Attach query YAML only to the last few assistant answers so long
  // conversations don't accumulate unbounded query context.
  const assistantIndexes = messages
    .map((message, index) => (message.role === "assistant" ? index : -1))
    .filter((index) => index >= 0)
    .slice(-GOVERNED_QUERY_CONTEXT_TURNS);
  const items = messages.map((message, index) =>
    message.role === "user"
      ? user(message.text)
      : assistant(renderAssistantMessage(message, assistantIndexes.includes(index))));
  const latest = messages.at(-1);
  if (!latest || latest.role !== "user" || latest.text !== currentMessage) {
    return [...items, user(currentMessage)];
  }
  return items;
}

/**
 * The tenant's connected tools, normalised to the connector keys the view
 * descriptors use. Unknown connection state — undefined (the control-plane
 * read failed) or a non-empty list whose keys no longer normalise (stale
 * metadata) — widens to every configured connector (a cost optimisation,
 * never an authorisation gate — the same fail-open stance as tool routing).
 * A present-but-EMPTY list is not unknown: the tenant has no connections,
 * and widening would present the configured catalogue as this business's
 * data sources.
 */
export function scopedClassifierConnectors(
  config: AlbertV3AgentConfig,
  activeConnectors: readonly string[] | undefined,
): readonly string[] {
  const configured = new Set(config.accessibleViews.map(({ connector }) => connector));
  const active = [...new Set((activeConnectors ?? [])
    .flatMap((connector) => {
      const normalized = normalizeV3Connector(connector);
      return normalized && configured.has(normalized) ? [normalized] : [];
    }))].sort();
  if (active.length > 0) return active;
  if (activeConnectors !== undefined && activeConnectors.length === 0) return [];
  return [...configured].sort();
}

/** True when the tenant's connection state is known and holds no connections. */
export function noConnectionsKnown(activeConnectors: readonly string[] | undefined): boolean {
  return activeConnectors !== undefined && activeConnectors.length === 0;
}

export const CONNECTOR_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "lightspeed": "Lightspeed Retail (R-Series) point of sale",
  "lightspeed-x": "Lightspeed Retail (X-Series) point of sale",
  "xero": "Xero accounting and payroll",
  "deputy": "Deputy rostering and timesheets",
  "square": "Square point of sale and staff",
  "shopify": "Shopify online store",
  "stripe": "Stripe payments",
  "momence": "Momence studio management",
  "meta-ads": "Meta Ads",
  "google-ads": "Google Ads",
});

export function classifierInstructions(
  config: AlbertV3AgentConfig,
  sourceFindings: readonly TenantSourceFinding[],
  activeConnectors?: readonly string[],
  nativeCapabilities = "",
  /** Compact business context digest (context-layer/render.ts renderBusinessContextForClassifier). */
  businessContext = "",
): string {
  const specialistAgent = specialistAgentFromConfig(config);
  const connectors = scopedClassifierConnectors(config, activeConnectors);
  const connected = new Set(connectors);
  const connectionKnown = (activeConnectors ?? []).length > 0;
  const noneConnected = noConnectionsKnown(activeConnectors);
  const shopifyConnected = connected.has("shopify");
  const views = config.accessibleViews
    .filter((view) => connected.has(view.connector))
    .map((view) => `- ${view.name} [${view.connector}]: ${view.guidance}`)
    .join("\n");
  const connectedTools = connectors
    .map((connector) => `- ${connector}: ${CONNECTOR_LABELS[connector] ?? connector}`)
    .join("\n");
  const connectionsBlock = noneConnected
    ? `NO tools are connected to Albert for THIS business yet — Albert holds no business data
at all. Route questions about what is connected or what data exists to meta. Route every
other data question (sales, payroll, accounting, staff) to meta as well, so the owner is
told plainly that nothing is connected yet; never route them off_topic, and never invent
figures.`
    : connectionKnown
    ? `Tools connected to Albert for THIS business (the only sources of data):
${connectedTools}
Reason only about these. If the owner names a tool that is not listed (for example
asks about Shopify when only a POS and accounting are connected), do NOT route
off_topic and do NOT clarify: route to a working lane, which will say plainly that the
tool is not connected and offer the closest connected figures.`
    : `Tools that may be connected to this business (connection state was unavailable, so
every configured tool is listed):
${connectedTools}`;
  const recipes = recipesForRoute(config, connectors);
  const recipeBlock = recipes.length > 0
    ? `
Certified recipes — complete, pre-built answers for common questions (fast path). Each line
is name [presentation]: what it answers (other phrasings). When the owner's question IS one of
these — one period, no comparison with another period, no extra filter or breakdown the recipe
lacks, no join with another tool — set recipe to its exact name and lane to quick. Exception: a
comparison of CONSECUTIVE periods (last week vs the week before, this month vs last month) IS a
recipe when a "by week" / "by month" trend recipe exists — use it with recipeDateRange null so its
default span covers both periods. Set
recipeDateRange to the period the owner named as one of: today, yesterday, tomorrow, this week,
last week, next week, this month, last month, this quarter, last quarter, this year, last year,
"last N days/weeks/months", a month name ("July", "July 2025"), or an explicit
YYYY-MM-DD,YYYY-MM-DD pair; null keeps the recipe's default period (always null for a
by-week / by-month trend recipe unless the owner named a longer span). Australian financial year:
"this financial year" = 1 July of the current FY to today as an explicit pair. Set recipeEntity
only when the owner named one specific supplier, person, product or category to narrow to; else
null. Otherwise recipe=null. A recipe is never used for a message that re-presents an earlier
answer (a subset of its rows or points, a different chart type, a sort, a flip, a table instead
of a chart): those route to represent with recipe=null, because the rows are already on screen.
${recipes.map((r) => `- ${r.name} [${r.recipe!.presentation}]: ${r.userRequest.replace(/\s+/gu, " ").trim()}${r.recipe!.matches?.length ? ` (e.g. ${r.recipe!.matches.slice(0, 4).map((m) => `"${m}"`).join(", ")})` : ""}`).join("\n")}
`
    : "";
  const findings = sourceFindings.length > 0
    ? `\nEstablished source facts for THIS business (verified by earlier investigations;
they override generic assumptions and must shape resolvedQuestion and
answerMustCover — for example, if a concept is established to live in one
source, the useful-answer points must direct the work there):
${sourceFindings.map((entry) => `- [${entry.concept}] ${entry.finding}`).join("\n")}\n`
    : "";
  const shopifyPlanes = shopifyConnected
    ? `
An additional governed live Shopify reporting plane can answer Shopify-native traffic,
sessions, conversion funnels, storefront/search behaviour, marketing attribution,
customer cohorts and Shopify-calculated profitability questions from the official
ShopifyQL 2026-07 reporting schemas. These are in scope even when no Cube view lists
them. Route a single live report to quick, comparisons/trends to analytical, and an
open-ended multi-angle Shopify investigation to deep.

A second governed live Shopify Admin 2026-07 read plane can answer exact merchant-object
and long-tail field lookups not represented by Cube or ShopifyQL. It exposes only registry
search plus typed selections/arguments; no raw GraphQL or mutation surface. Shopify store
object and field questions are in scope even when no Cube view lists them.
`
    : "";
  const shopifyOffTopicNote = shopifyConnected
    ? ` Website traffic, search, conversion and marketing
  attribution are in scope when they concern a connected Shopify store.`
    : "";
  const specialistBlock = specialistAgent.id === "general"
    ? ""
    : `# Explicitly selected specialist: ${specialistAgent.ui.title}
The owner selected this profile for the whole conversation. Bias ambiguous wording toward
its domain and prefer these semantic views first: ${specialistAgent.primaryViews.join(", ")}.
All other connected business data remains available when it materially answers the question;
the profile is a focused starting point, not a restriction or a separate runtime.
${specialistAgent.alwaysRule?.body ?? ""}

`;
  return `You are the intent orchestrator for Albert, an analytics assistant for a small
business. You never answer the question yourself; you route it.

${todayLine(config.timezone)}

${businessContext ? `${businessContext}

` : ""}${specialistBlock}${connectionsBlock}

The data available (semantic views over those connected tools; the [tag] names the tool):
${views}
${findings}${shopifyPlanes}${recipeBlock}${nativeCapabilities}
Routing lanes:
- quick: a single fact or list a single governed query can answer ("sales yesterday",
  "top 5 products this month", "how many customers do we have").
- analytical: needs several queries, a comparison, trend, breakdown or reconciliation
  ("how did this month compare to last year", "break down profitability by category
  and customer", "why did sales dip in June").
- deep: open-ended diagnosis or strategy needing a multi-angle investigation
  ("how can I improve profitability", "what should I do about churn",
  "give me a health check of the business"). Only when the owner explicitly asks
  for a wide review, a health check, a diagnosis or a strategy. A short vague
  question ("How are we doing?", "Sales?", "How busy were we?", "How did last week
  go?") is NOT deep: pick the most natural reading (recent sales versus the period
  before, on the quick lane — a recipe if one fits), record it as an assumption,
  and answer briefly; the owner can widen it. When a business context block is
  present, its revenue streams, vocabulary and tools decide the natural reading:
  "how's the workshop going" is that business's service department (jobs, labour,
  parts) in the tool the context names, not a clarification. "How's X going / how
  did X go / how is X doing / how are we tracking / what are X looking like" always means the current period
  AGAINST the previous comparable one (this month vs last month, last week vs the
  week before): a comparison, so recipe=null (recipes cover one period) and quick
  or analytical with the comparison in answerMustCover. When the metric is left
  unsaid ("compare the last two periods", "how are we doing"), it is the business's
  headline measure — sales/takings — never a clarification about which metric.
- explain: the user asks about a previous answer itself: what a term meant, what was
  included or excluded, how a figure was worked out ("what are you considering as
  workshop", "does that include GST", "how did you calculate profit"). The answer
  comes from the conversation and the recorded governed queries behind the earlier
  answer. NEVER route these to clarification: the user is asking Albert to explain
  Albert's own choice, so asking them to pick a definition is backwards.
- conceptual: the user asks for the abstract meaning, formula, inclusion rules or
  difference between governed business concepts ("How does gross margin work?",
  "What is gross margin?", "Does gross margin include wages?"). This lane reads
  published semantic definitions and never queries business rows. A request for
  the owner's actual value ("What is my gross margin?", any named period, comparison,
  trend, ranking or breakdown) is NOT conceptual: route quick/analytical/deep. A
  question about a term Albert used in a previous answer remains explain.
- represent: the owner asks to change how the PREVIOUS answer is shown, not what it
  shows: bar instead of line (or the reverse), flip the axes / put dates on the y axis,
  sort it, show only the top N or the last N points, show it as a table instead of a
  chart, drop or reorder columns. The rows are already on screen (see the tables the
  earlier answer lists), so nothing new is retrieved. Route represent for these even
  when the message is terse ("make it a bar chart", "top 5 only", "flip it"). If the
  change needs data that was NOT retrieved — a different or longer period, finer or
  coarser time buckets that need re-aggregation (weekly → monthly), another measure or
  dimension, a comparison year — route quick instead (it will still reuse what it can).
  resolvedQuestion for represent names the change and the earlier result it applies to.
- meta: a question about Albert's data itself rather than the business figures: what tools
  are connected, whether a named tool (Shopify, Square, payroll) is connected, how fresh or
  up to date the data is, what date range exists, what kinds of questions can be answered,
  what data is missing. Albert answers these from its own registry (connected tools,
  freshness watermarks, coverage) without running data queries. A question that needs an
  actual figure (a count of products, staff who appear in two systems, the latest transaction
  amount) is NOT meta — route quick.
- social: a greeting, thanks, acknowledgement or sign-off that carries no question
  ("thanks", "great, cheers Albert", "hi", "ok bye", "that's all for now"). Nothing is
  queried; Albert replies in a sentence. A message that thanks AND asks ("thanks, now
  by store", "great — what about last year?") is NOT social: route it by the question.
  Bare agreement ("yes", "ok", "sure") right after Albert asked something is an answer
  to that question, not social.
- clarification: a last resort, almost never used. Only when an instruction is so
  contradictory it cannot be executed. Ambiguity alone is NOT a reason to clarify,
  and neither is an unfamiliar name: the working lanes can search the stored data
  for whatever the user is naming (products, categories, brands, customers,
  suppliers), including misspellings, so unknown or garbled names always route to
  a working lane. Pick the most natural reading a business owner would mean,
  record it as an assumption, and route to a working lane; the answer will
  disclose the interpretation and the user can correct it.
  Vague scope ("how are sales?"), fuzzy terms ("workshop", "regulars"), missing
  time ranges (default to a sensible recent period) and multiple plausible
  readings must all be resolved with assumptions, not questions. Never ask the
  user to define a term that Albert itself introduced in a previous answer or
  that appears in the recorded queries; that is the explain lane. When torn
  between clarification and any other lane, always choose the other lane.
- off_topic: not answerable from the connected tools at all (the weather, general
  knowledge).${shopifyOffTopicNote} Read the view list before
  refusing: sales, products, customers, workshop jobs, stock, purchasing,
  accounting (invoices, bills, P&L, GST, bank activity, transfers), payroll
  (wages, super, pay runs) and staffing are all available when a view above
  covers them. Only route off_topic when no view could plausibly hold the
  answer; when a view says something specific is NOT available, or the owner
  names a tool that is not connected, route to a working lane so the answer
  can say so honestly with whatever related data exists.

Also produce resolvedQuestion: the user's request restated precisely, resolving
pronouns and follow-up references from the conversation. Assistant messages may end
with the governed Cube queries (YAML) that produced them; when the user refines a
previous result ("now add gross profit", "same but by store", "make it monthly"),
resolvedQuestion must restate the previous request in full with the change applied
(for example "Show a table of monthly sales with gross takings AND gross profit"),
never just the delta. Such refinements route to the same lane the original needed,
usually quick. Assistant messages may also list the tables the owner saw ("Table
shown: …"). When the new message names an entry from one of those tables — a
statement line or account ("what subscriptions do we have", "break down rent",
"what's in repairs and maintenance"), a product, a supplier, a person — it is a
DRILL into that entry, not a new topic: resolvedQuestion must name the entry
exactly as the table labels it, carry the table's period, and ask for the
breakdown behind it (for a P&L or expense line: the transactions coded to that
account, by supplier/contact, description and month, reconciling to the line's
total). Statement drills route to quick or analytical using the governed Xero
ledger views (the pnl_* members filtered by account name); the live statement
tools cannot filter or drill and must not be re-run for this. Record any
assumptions you made. If lane is clarification, set
clarificationQuestion and 2-4 short options; otherwise set clarificationQuestion
to null and options to [].

Beyond routing, read the question critically and infer the goal behind it:
- ownerGoal: one sentence naming what the owner is practically trying to decide
  or do (null only when the question has no wider goal).
- answerMustCover: up to 4 short points a genuinely useful answer must cover.
  When the owner asks for a Xero financial statement (P&L, balance sheet, trial
  balance, aged report), the statement itself is the deliverable: keep the
  points to the statement's own sections, period/basis and a one-line read of
  it; do not add separate payroll, expense-account or ledger breakdowns.
  Think about the practical meaning, not the literal wording. A question scoped
  to a period, category or state usually implies the neighbouring reality the
  owner cares about: someone asking what is due in a period is planning
  payments, so anything already overdue and unpaid is part of the answer;
  someone asking for the "top" product is judging performance, so how far ahead
  it is matters. Reason it out for THIS question rather than copying these
  examples. The answering lane is required to cover every point or say plainly
  why the data cannot.
resolvedQuestion stays faithful to the owner's wording; answerMustCover is where
the practical reading lives. When covering the points clearly needs several
queries, route analytical rather than quick.

Also set answerShape - the shape of a genuinely useful answer:
- fact: one figure or yes/no ("how much did we sell yesterday").
- list: named things with their details - rosters, schedules, documents due,
  directories ("who's working today" is a list of people and times).
- comparison: two or more magnitudes weighed against each other.
- trend: change over time.
- breakdown: how a total splits or ranks across categories ("top products").
- diagnosis: open-ended why/how-are-we-doing investigation.
This gates presentation: facts and lists are answered in prose and tables and
never charted; only magnitude shapes (comparison, trend, breakdown, diagnosis)
may carry a chart.`;
}

export async function classifyIntent(input: Readonly<{
  runner: Runner;
  preferences: AgentRunPreferences;
  config: AlbertV3AgentConfig;
  cachePartition: string;
  conversation: readonly ConversationMessage[];
  message: string;
  sourceFindings?: readonly TenantSourceFinding[];
  /** Authenticated control-plane connector keys; scopes the view list to this tenant. */
  activeConnectors?: readonly string[];
  /** Rendered native-capability block (see native-capabilities.ts). */
  nativeCapabilities?: string;
  /** Compact business context digest for this tenant. */
  businessContext?: string;
  signal?: AbortSignal;
}>): Promise<IntentDecision> {
  const agent = new Agent({
    name: "Albert v3 intent orchestrator",
    instructions: classifierInstructions(
      input.config,
      input.sourceFindings ?? [],
      input.activeConnectors,
      input.nativeCapabilities ?? "",
      input.businessContext ?? "",
    ),
    model: input.preferences.model,
    modelSettings: laneModelSettings(
      isAnthropicModel(input.preferences.model)
        ? { ...input.preferences, reasoningEffort: "none" }
        : isXaiModel(input.preferences.model)
        ? { ...input.preferences, reasoningEffort: "low" }
        : input.preferences,
      // Goal inference needs real thought; routing alone was fine at low.
      "medium",
      {
        maxEffort: "medium",
        promptCacheKey: v3PromptCacheKey({
          partition: input.cachePartition,
          profile: "intent-orchestrator",
        }),
      },
    ),
    outputType: intentSchema,
  });
  const run = await input.runner.run(
    agent,
    withV3PromptCacheBoundary(
      input.preferences.model,
      buildConversationInput(input.conversation, input.message),
    ),
    { maxTurns: 2, signal: input.signal },
  );
  const decision = run.finalOutput;
  if (!decision) {
    // A failed classification must not kill the turn; the analytical lane can
    // handle anything the quick lane could.
    return normaliseConceptualIntent(coerceRefinementIntent({
      lane: "analytical",
      resolvedQuestion: input.message,
      ownerGoal: null,
      answerShape: "diagnosis",
      answerMustCover: [],
      assumptions: [],
      clarificationQuestion: null,
      clarificationOptions: [],
      recipe: null,
      recipeDateRange: null,
      recipeEntity: null,
      nativeCapability: null,
    }, input.conversation, input.message), input.message, input.conversation.some(({ role }) => role === "assistant"));
  }
  return normaliseConceptualIntent(guardOrphanRefinement(
    coerceRefinementIntent(decision, input.conversation, input.message),
    input.conversation,
    input.message,
  ), input.message, input.conversation.some(({ role }) => role === "assistant"));
}
