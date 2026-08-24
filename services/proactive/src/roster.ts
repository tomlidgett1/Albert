/**
 * The Proactive research roster (ADR 0113).
 *
 * Fifteen research agents, each a real codex conversation run at Terra max
 * effort, each studying a different surface of the business for the morning
 * control panel. An agent joins a run when at least one of the connectors it
 * needs is active, so the same roster degrades gracefully for tenants with
 * fewer sources. Prompts are user messages sent through the normal codex
 * pipeline: they must stay well under the 8,000-character message cap and be
 * unmistakably analytical so no conversational fast path intercepts them.
 */

export const PROACTIVE_MODEL = "gpt-5.6-terra";
export const PROACTIVE_REASONING_EFFORT = "max";
export const PROACTIVE_FAST_MODE = true;
/** Codex turns the browser holds in flight at once during a run. */
export const PROACTIVE_CLIENT_CONCURRENCY = 5;

export type ProactiveAgentDefinition = Readonly<{
  /** Stable kebab-case identity persisted with every finding. */
  key: string;
  title: string;
  tagline: string;
  /** Agent runs when ANY of these connectors is active; empty = always runs. */
  connectors: readonly string[];
  prompt: string;
}>;

const POS = Object.freeze(["lightspeed-r", "lightspeed-x", "square", "shopify", "momence"]);
const ACCOUNTING = Object.freeze(["xero"]);
const ROSTER_ONLY = Object.freeze(["deputy"]);

const CARD_FORMAT = [
  "This is scheduled deep research for the owner's morning control panel, not a chat reply, so do not ask clarifying questions — investigate and report.",
  "Structure the answer for a panel card: begin with a single '## ' headline stating the most decision-relevant finding you uncovered, with a real number in it.",
  "Follow with a 'Key numbers' list of 3-5 bullets, each formatted '- **Label:** value — one short line of context'.",
  "Then the analysis itself: what you examined, what stands out, why it matters, all grounded in the evidence you queried. Compare recent periods with earlier ones wherever the data allows. Keep the whole answer under 450 words.",
  "If the connected data genuinely cannot support this area, say precisely what is missing rather than padding.",
  "Always offer follow-up questions: the two or three most valuable next questions the owner should ask about what you found.",
].join(" ");

function prompt(focus: string): string {
  return `${focus}\n\n${CARD_FORMAT}`;
}

export const PROACTIVE_AGENT_ROSTER: readonly ProactiveAgentDefinition[] = Object.freeze([
  {
    key: "revenue-momentum",
    title: "Revenue momentum",
    tagline: "Where sales are heading and why",
    connectors: POS,
    prompt: prompt(
      "Research this business's revenue momentum in depth. Establish total sales revenue for the last full week and the last 4, 13 and 52 weeks, and how each compares with the equivalent earlier period. Identify whether momentum is accelerating or fading, which weeks broke the pattern, and the single biggest driver of the change (volume, basket size, or price). Quantify average transaction value and transaction counts over the same windows.",
    ),
  },
  {
    key: "product-performance",
    title: "Product winners & losers",
    tagline: "What is selling, what has stalled",
    connectors: POS,
    prompt: prompt(
      "Research product and category performance in depth. Rank the categories and standout individual products by revenue over the last 13 weeks versus the prior 13 weeks; find the fastest growers and the sharpest decliners in dollar terms. Look for products whose sales stopped abruptly, category mix shifts, and where the revenue concentration risk sits (how much of revenue the top products carry).",
    ),
  },
  {
    key: "inventory-health",
    title: "Inventory health",
    tagline: "Dead stock, stockouts and cash tied up",
    connectors: POS,
    prompt: prompt(
      "Research inventory health in depth. Estimate the value of stock on hand and how it is distributed across categories. Identify slow-moving or dead stock (on hand with little or no recent sales), likely stockout risks among strong sellers, and how inventory value compares with recent sales rates (weeks of cover). Call out the categories where cash is tied up with least return.",
    ),
  },
  {
    key: "customer-loyalty",
    title: "Customer base",
    tagline: "New, returning and lapsed customers",
    connectors: POS,
    prompt: prompt(
      "Research the customer base in depth. Quantify new versus returning customer revenue over the last 13 weeks and how that mix is trending. Identify high-value customers who have lapsed (no recent purchases after regular spending), the size and spend of the repeat-customer core, and how average spend per customer is moving. Estimate what recovering the lapsed high-value group would be worth.",
    ),
  },
  {
    key: "workshop-service",
    title: "Workshop & service",
    tagline: "Service jobs, throughput and revenue",
    connectors: POS,
    prompt: prompt(
      "Research workshop and service performance in depth, if this business has service or workshop activity in its data. Quantify service revenue and job counts over recent months versus earlier periods, throughput patterns (jobs checked in versus completed), and how service revenue compares with retail revenue. Identify bottleneck signs such as growing backlogs or slowing completion rates.",
    ),
  },
  {
    key: "pricing-margins",
    title: "Margins & discounting",
    tagline: "Where profit leaks through price",
    connectors: POS,
    prompt: prompt(
      "Research margins and discounting in depth. Using whatever cost and price data the sources carry, quantify gross margin overall and by category for recent months, and how it is trending. Measure how much revenue is being given away through discounting, which categories or staff discount most, and where margin compression is worst. Identify the single biggest margin leak in dollar terms.",
    ),
  },
  {
    key: "seasonality-trading",
    title: "Trading patterns",
    tagline: "Days, hours and seasonal rhythm",
    connectors: POS,
    prompt: prompt(
      "Research trading patterns in depth. Establish revenue by day of week and how weekday versus weekend trade compares, the strongest and weakest recent trading days and what drove them, and the seasonal shape of the year from the full history available. State where the business is in its seasonal cycle right now and what the pattern implies for the coming weeks, quantified against the same period last year where possible.",
    ),
  },
  {
    key: "staff-performance",
    title: "Staff sales performance",
    tagline: "Who sells what, and how it spreads",
    connectors: POS,
    prompt: prompt(
      "Research staff sales performance in depth, using whatever per-staff sales attribution the point-of-sale data carries. Quantify revenue and transaction counts per staff member over the last 13 weeks, average sale value by person, and how the spread between the strongest and weakest performers is changing. Look for patterns worth acting on — training gaps, scheduling mismatches with busy periods, or standout techniques implied by basket sizes.",
    ),
  },
  {
    key: "cash-position",
    title: "Cash position",
    tagline: "Bank balances and cash flow direction",
    connectors: ACCOUNTING,
    prompt: prompt(
      "Research the cash position in depth from the accounting data. Establish current bank balances, cash in versus cash out for recent months, and the direction and speed of net cash movement. Compare the last three months with the prior three. Identify the biggest recent cash outflows, whether cash cover is growing or shrinking relative to the monthly outflow rate, and any months that broke the pattern.",
    ),
  },
  {
    key: "profitability",
    title: "Profit & loss shape",
    tagline: "What the P&L says about the business",
    connectors: ACCOUNTING,
    prompt: prompt(
      "Research profitability in depth from the profit and loss data. Establish revenue, gross profit and net profit for recent months and the year to date, versus the same period last year. Identify which lines moved most — income growth, cost of sales creep, or operating expense growth — and quantify each contribution. State plainly whether the business is becoming more or less profitable and the single line most responsible.",
    ),
  },
  {
    key: "receivables-payables",
    title: "Money owed & owing",
    tagline: "Receivables, payables and overdue risk",
    connectors: ACCOUNTING,
    prompt: prompt(
      "Research accounts receivable and payable in depth. Quantify total outstanding receivables and payables, how much of each is overdue, and the largest individual outstanding invoices and bills. Compare the current position with recent months to show whether collection is improving or slipping, and identify specific overdue amounts worth chasing this week, in order of value.",
    ),
  },
  {
    key: "expense-control",
    title: "Expense patterns",
    tagline: "Cost creep and unusual spending",
    connectors: ACCOUNTING,
    prompt: prompt(
      "Research operating expenses in depth. Rank expense accounts by spend over recent months and identify which are growing fastest versus their earlier run rate. Find unusual spikes, new recurring costs that appeared recently, and categories quietly creeping upward. Quantify what the fastest-growing expense lines add up to annually if the current rate holds, versus a year ago.",
    ),
  },
  {
    key: "payroll-labour",
    title: "Payroll & labour cost",
    tagline: "What the team costs against what it earns",
    connectors: Object.freeze([...ACCOUNTING, ...ROSTER_ONLY]),
    prompt: prompt(
      "Research payroll and labour cost in depth. Quantify total payroll cost for recent months from whatever payroll or timesheet data is connected, its trend against earlier months, and labour cost as a share of revenue where both sides exist. Identify overtime or leave patterns, growth in hours worked versus growth in sales, and whether labour productivity (revenue per rostered or worked hour) is rising or falling.",
    ),
  },
  {
    key: "roster-efficiency",
    title: "Rostering vs demand",
    tagline: "Are the right hours rostered at the right times",
    connectors: ROSTER_ONLY,
    prompt: prompt(
      "Research rostering against demand in depth. From the workforce data, quantify rostered versus actually worked hours over recent weeks, unapproved or missing timesheets, and leave taken. Where sales data is also connected, compare staffing levels by day of week against revenue by day of week to find over- and under-rostered days, and quantify the mismatch in hours.",
    ),
  },
  {
    key: "growth-opportunities",
    title: "Opportunity scan",
    tagline: "One testable idea backed by evidence",
    connectors: Object.freeze([]),
    prompt: prompt(
      "Conduct an open opportunity scan across every connected source. Look for one high-confidence, testable opportunity the owner could act on within a month — an underexploited category, a pricing gap, a recoverable customer segment, a cost with an obvious lever, or a timing pattern worth exploiting. Quantify the current baseline, the evidence that the opportunity is real, and the realistic dollar upside of a successful test.",
    ),
  },
]);

/** The subset of the roster that can run for a tenant's active connectors. */
export function rosterForConnectors(
  activeConnectors: readonly string[],
): readonly ProactiveAgentDefinition[] {
  const active = new Set(activeConnectors);
  return PROACTIVE_AGENT_ROSTER.filter((agent) =>
    agent.connectors.length === 0 || agent.connectors.some((key) => active.has(key)),
  );
}

export function proactiveAgentByKey(key: string): ProactiveAgentDefinition | undefined {
  return PROACTIVE_AGENT_ROSTER.find((agent) => agent.key === key);
}
