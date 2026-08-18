/**
 * Statement lane: the deterministic fast path for "give me our P&L / balance
 * sheet / trial balance".
 *
 * Why a separate lane, not a prompt paragraph: a financial statement request
 * has a fully specified correct behaviour — fetch Xero's own report for the
 * period and present it. The general machinery (intent planner → plan card →
 * answerMustCover → quick/analytical lane → evidence reviewer → escalation)
 * exists to reconstruct answers from ledger views, and its structured
 * obligations kept overriding the tool guidance: the planner added "payroll
 * shown separately", the reviewer enforced it, empty Cube views escalated,
 * and the owner never got the statement. This lane owns the request end to
 * end with only the Xero report tools exposed, no plan card and no reviewer.
 * If the owner asked for something the statement cannot give (per-product,
 * per-customer, a POS comparison), the lane returns Escalate and the normal
 * path continues with the statement already registered as evidence.
 */
import { Agent, system, type AgentInputItem } from "@openai/agents";
import { finalAnswerSchema, laneModelSettings, todayLine, v3PromptCacheKey, withV3PromptCacheBoundary, ANSWER_CONTRACT, type FinalAnswer, type LaneRunInput } from "./lanes.js";
import { createComposeTableTool, createPresentResultTool, createV3Tools } from "./tools.js";
import { createMakeChartTool } from "./chart-layer.js";
import type { V3TurnContext } from "./context.js";

export type XeroStatementKind = "profit_and_loss" | "balance_sheet" | "trial_balance";

const PROFIT_AND_LOSS = /\b(?:p\s*&\s*l|p\s+and\s+l|pnl|profit\s+(?:and|&|\/)\s+loss|income\s+statement|profit\s+statement)\b/iu;
/**
 * Questions Xero's P&L answers better than any ledger reconstruction: profit,
 * income and expense totals, expense accounts, "how did we do" for a period.
 * Any of these routes to the statement lane unless OUTSIDE_STATEMENT says the
 * owner wants a grain the statement does not have.
 */
const PROFIT_AND_LOSS_INTENT = new RegExp([
  String.raw`\b(?:net|gross|operating)\s+profit\b`,
  String.raw`\b(?:how\s+much\s+)?profit\b`,
  String.raw`\bprofitab(?:le|ility)\b`,
  String.raw`\b(?:did|do|are)\s+we\s+make\s+(?:a\s+)?(?:profit|money)\b`,
  String.raw`\bhow\s+(?:much|did)\s+(?:did\s+)?we\s+(?:make|do|earn)\b`,
  String.raw`\b(?:total|our|the|business)\s+income\b`,
  String.raw`\bincome\s+(?:this|last|for|in|year|month|quarter|fy)\b`,
  String.raw`\b(?:operating\s+)?expenses?\s+(?:accounts?|lines?|breakdown|by\s+account|ratio|this|last|for|in|grew|growth|as\s+a\s+share)\b`,
  String.raw`\b(?:biggest|largest|top|main)\s+(?:operating\s+)?expenses?\b`,
  String.raw`\bexpense\s+ratio\b`,
  String.raw`\bcost\s+of\s+(?:sales|goods)\b`,
  String.raw`\bhow\s+did\s+we\s+(?:do|go)\s+(?:this|last|in)\b`,
].join("|"), "iu");
const BALANCE_SHEET = /\b(?:balance\s+sheet|statement\s+of\s+financial\s+position|net\s+assets(?:\s+statement)?|(?:total\s+)?(?:assets|liabilities|equity)\b|what\s+do\s+we\s+own\s+and\s+owe|bank\s+balances?)\b/iu;
const TRIAL_BALANCE = /\btrial\s+balance\b/iu;

/**
 * Wording that means the owner wants something a statement cannot answer on
 * its own; those requests keep the general path (which still has the Xero
 * report tools available).
 */
const OUTSIDE_STATEMENT = new RegExp([
  String.raw`\b(?:by|per|for\s+each|split\s+by|broken?\s+down\s+by|breakdown\s+by)\s+(?:product|category|categories|brand|item|sku|customer|client|supplier|vendor|store|location|site|staff|employee|salesperson|channel|day|week|invoice)s?\b`,
  String.raw`\b(?:lightspeed|square|shopify|deputy|momence|stripe|pos|register|till|roster|timesheet|wages?\s+(?:in|from|according)|hours)s?\b`,
  String.raw`\b(?:reconcile|reconciliation|which\s+(?:products|customers|suppliers|invoices)|top\s+\d+\s+(?:products|customers|suppliers|items)|invoice\s+level|line\s+items?|suppliers?|vendors?|bills?|purchase\s+orders?|stock|inventory|sales\s+per|per\s+hour|labour)\b`,
].join("|"), "iu");

export function detectXeroStatementRequest(message: string): XeroStatementKind | undefined {
  const text = message.trim();
  if (!text || text.length > 400) return undefined;
  // Wording that needs a grain the statement lacks keeps the general path,
  // which still carries the live report tools.
  if (OUTSIDE_STATEMENT.test(text)) return undefined;
  if (BALANCE_SHEET.test(text)) return "balance_sheet";
  if (TRIAL_BALANCE.test(text)) return "trial_balance";
  if (PROFIT_AND_LOSS.test(text)) return "profit_and_loss";
  if (PROFIT_AND_LOSS_INTENT.test(text)) return "profit_and_loss";
  return undefined;
}

const KIND_LABEL: Record<XeroStatementKind, string> = {
  profit_and_loss: "Profit and Loss",
  balance_sheet: "Balance Sheet",
  trial_balance: "Trial Balance",
};

const KIND_TOOL: Record<XeroStatementKind, string> = {
  profit_and_loss: "xero_profit_and_loss",
  balance_sheet: "xero_balance_sheet",
  trial_balance: "xero_trial_balance",
};

export function statementLaneInstructions(input: Readonly<{
  kind: XeroStatementKind;
  timezone: string;
}>): string {
  return `You are Albert, presenting the owner's live Xero ${KIND_LABEL[input.kind]} exactly as Xero renders it.

${todayLine(input.timezone)}
The Australian financial year runs 1 July to 30 June. "YTD", "year to date", "this year", "so far this year" or "FY" with no other qualifier means the CURRENT financial year to date (1 July of the current FY through today). "Calendar year" or "since January" means 1 January of the current year through today. "Last month" / a named month means that whole month; "last quarter" the most recent complete quarter. A balance sheet or trial balance is AS AT a date: default to today unless the owner names a date, a month end or a financial year end (30 June).

Procedure — do exactly this, nothing more:
1. Resolve the period from the owner's words using the rules above.
2. Call ${KIND_TOOL[input.kind]} once with that period. For a P&L, use periods+timeframe when the owner asked for a month-by-month, quarterly or year-on-year view or a comparison between periods (e.g. "last quarter vs the quarter before" = toDate at the end of last quarter with periods=1, timeframe=QUARTER; "this FY vs the same period last year" = two calls or periods=1 timeframe=YEAR); use paymentsOnly only when they said cash basis. If Xero returns an error, retry once with the current-financial-year window, then answer Unavailable.
3. The full statement table is attached to your answer automatically (every line, in Xero's order, with totals). Do not rebuild it, do not list every line in prose, and do not write a Markdown table.
4. Write the answer to the owner's actual question from the statement:
   - A request for the statement itself: two or three sentences — the period (and "as at" date or basis) and the headline figures (P&L: total income, gross profit, total operating expenses, net profit or loss; balance sheet: total assets, total liabilities, net assets/equity; trial balance: that debits and credits balance), plus one plain observation.
   - A question about ONE figure (net profit, total income, total expenses, a bank balance): one or two sentences with that figure and its period; do not recite the whole statement.
   - A question about the lines (biggest expense accounts, which lines grew, expenses as a share of income, income vs expenses by period): compose_table with the relevant lines from the statement result (exact source cells; percent_of / percent_change for shares and growth), ranked as asked, then one or two sentences naming the leaders. A chart (make_chart) only for a multi-period comparison of a few lines.
   Say the figures are live from Xero once. No methodology, no caveats about other data sources.

Hard rules:
- The statement is complete: Xero's P&L already includes wages, superannuation and every posted expense account. Never say labour or payroll is missing, never suggest a separate payroll check, never mention Cube views, ledgers, sync or where numbers are stored.
- Never invent, estimate or recompute a figure; every number comes from the tool result.
- Only if the owner's request needs something the statement cannot give (per-product or per-customer detail, a comparison to POS sales, invoice-level lists) return state=Escalate with a one-line answer naming what is needed; otherwise state=Verified.
- state=Unavailable only when Xero itself failed after the retry.

${ANSWER_CONTRACT}`;
}

export async function runStatementLane(
  input: LaneRunInput,
  kind: XeroStatementKind,
): Promise<FinalAnswer | undefined> {
  const agent = new Agent<V3TurnContext, typeof finalAnswerSchema>({
    name: "Albert v3 statement lane",
    instructions: statementLaneInstructions({ kind, timezone: input.config.timezone }),
    model: input.preferences.model,
    modelSettings: laneModelSettings(input.preferences, "low", {
      maxEffort: "medium",
      promptCacheKey: v3PromptCacheKey({
        partition: input.context.promptCachePartition,
        profile: "Albert v3 statement lane",
        route: input.context.toolRoute,
      }),
    }),
    tools: [
      ...createV3Tools({ route: input.context.toolRoute, lane: "statement", purpose: "answer" }),
      createPresentResultTool(),
      createComposeTableTool(),
      createMakeChartTool(),
    ],
    outputType: finalAnswerSchema,
  });
  const conversation: AgentInputItem[] = withV3PromptCacheBoundary(input.preferences.model, [
    system(`Owner request: ${input.intent.resolvedQuestion}`),
    ...input.conversation,
  ]);
  try {
    const run = await input.runner.run(agent, conversation, {
      context: input.context,
      maxTurns: 8,
      signal: input.signal ?? input.context.signal,
    });
    return run.finalOutput;
  } catch (error) {
    if (error instanceof Error && /max turns/iu.test(error.message)) return undefined;
    throw error;
  }
}
