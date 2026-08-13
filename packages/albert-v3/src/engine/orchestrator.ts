import { Agent, type AgentInputItem, type Runner, assistant, user } from "@openai/agents";
import { z } from "zod";
import { isXaiModel, type AgentRunPreferences } from "../../../shared/src/index.js";
import type { AlbertV3AgentConfig } from "../agent-config/loader.js";
import type { TenantSourceFinding } from "./context.js";
import {
  laneModelSettings,
  todayLine,
  v3PromptCacheKey,
  withV3PromptCacheBoundary,
} from "./lanes.js";

export const LANES = ["quick", "analytical", "deep", "explain", "clarification", "off_topic"] as const;
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
}>;

/** Only the most recent assistant answers carry their full query YAML. */
const GOVERNED_QUERY_CONTEXT_TURNS = 2;

function renderAssistantMessage(
  message: ConversationMessage,
  includeQueries: boolean,
): string {
  if (!includeQueries || !message.governedQueries?.length) return message.text;
  const queries = message.governedQueries
    .map((query) => `### ${query.topic} (view: ${query.view})\n${query.queryYaml}`)
    .join("\n");
  return `${message.text}\n\n[Governed typed queries that produced this answer. Views beginning shopifyql: and shopify-admin: contain safe typed IR and must be rerun only with run_shopifyql_query and run_shopify_admin_query respectively; all other views are Cube YAML. For a follow-up, extend the relevant typed query rather than starting over.]\n${queries}`;
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
  };
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

function classifierInstructions(
  config: AlbertV3AgentConfig,
  sourceFindings: readonly TenantSourceFinding[],
): string {
  const views = config.accessibleViews
    .map((view) => `- ${view.name}: ${view.guidance}`)
    .join("\n");
  const findings = sourceFindings.length > 0
    ? `\nEstablished source facts for THIS business (verified by earlier investigations;
they override generic assumptions and must shape resolvedQuestion and
answerMustCover — for example, if a concept is established to live in one
source, the useful-answer points must direct the work there):
${sourceFindings.map((entry) => `- [${entry.concept}] ${entry.finding}`).join("\n")}\n`
    : "";
  return `You are the intent orchestrator for Albert, an analytics assistant for a small
business. You never answer the question yourself; you route it.

${todayLine(config.timezone)}

The data available (through these semantic views over the business's connected tools):
${views}
${findings}

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

Routing lanes:
- quick: a single fact or list a single governed query can answer ("sales yesterday",
  "top 5 products this month", "how many customers do we have").
- analytical: needs several queries, a comparison, trend, breakdown or reconciliation
  ("how did this month compare to last year", "break down profitability by category
  and customer", "why did sales dip in June").
- deep: open-ended diagnosis or strategy needing a multi-angle investigation
  ("how can I improve profitability", "what should I do about churn",
  "give me a health check of the business").
- explain: the user asks about a previous answer itself: what a term meant, what was
  included or excluded, how a figure was worked out ("what are you considering as
  workshop", "does that include GST", "how did you calculate profit"). The answer
  comes from the conversation and the recorded governed queries behind the earlier
  answer. NEVER route these to clarification: the user is asking Albert to explain
  Albert's own choice, so asking them to pick a definition is backwards.
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
- off_topic: not answerable from the views or the live Shopify reporting plane at all
  (the weather, general knowledge). Website traffic, search, conversion and marketing
  attribution are in scope when they concern a connected Shopify store. Read the view list before
  refusing: sales, products, customers, workshop jobs, stock, purchasing,
  accounting (invoices, bills, P&L, GST, bank activity, transfers), payroll
  (wages, super, pay runs) and staffing are all available when a view above
  covers them. Only route off_topic when no view could plausibly hold the
  answer; when a view says something specific is NOT available, route to a
  working lane so the answer can say so honestly with whatever related data
  exists.

Also produce resolvedQuestion: the user's request restated precisely, resolving
pronouns and follow-up references from the conversation. Assistant messages may end
with the governed Cube queries (YAML) that produced them; when the user refines a
previous result ("now add gross profit", "same but by store", "make it monthly"),
resolvedQuestion must restate the previous request in full with the change applied
(for example "Show a table of monthly sales with gross takings AND gross profit"),
never just the delta. Such refinements route to the same lane the original needed,
usually quick. Record any assumptions you made. If lane is clarification, set
clarificationQuestion and 2-4 short options; otherwise set clarificationQuestion
to null and options to [].

Beyond routing, read the question critically and infer the goal behind it:
- ownerGoal: one sentence naming what the owner is practically trying to decide
  or do (null only when the question has no wider goal).
- answerMustCover: up to 4 short points a genuinely useful answer must cover.
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
  signal?: AbortSignal;
}>): Promise<IntentDecision> {
  const agent = new Agent({
    name: "Albert v3 intent orchestrator",
    instructions: classifierInstructions(input.config, input.sourceFindings ?? []),
    model: input.preferences.model,
    modelSettings: laneModelSettings(
      isXaiModel(input.preferences.model)
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
    return coerceRefinementIntent({
      lane: "analytical",
      resolvedQuestion: input.message,
      ownerGoal: null,
      answerShape: "diagnosis",
      answerMustCover: [],
      assumptions: [],
      clarificationQuestion: null,
      clarificationOptions: [],
    }, input.conversation, input.message);
  }
  return coerceRefinementIntent(decision, input.conversation, input.message);
}
