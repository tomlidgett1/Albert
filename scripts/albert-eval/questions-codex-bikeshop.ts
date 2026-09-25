/**
 * Codex-harness eval battery: 50 questions a bike-shop owner (senior business
 * analyst) would actually ask, spanning easy lookups → hard cross-source
 * analysis → open strategy, ambiguity, metadata and theory. Written for
 * Ashburton Cycles (lightspeed-r + xero + deputy), but the questions avoid
 * naming internal views/tables so they generalise to any connected stack.
 *
 * `expect` is grader-only guidance (never shown to Albert). `format` is the
 * grader's expected presentation; "line"/"bar" mean a chart is clearly
 * warranted and its absence should be penalised.
 */

export type CodexTier = "easy" | "medium" | "hard" | "xhard" | "ambiguous" | "meta" | "theory" | "goal";
export type CodexScope = "lightspeed" | "xero" | "deputy" | "multi" | "meta";
export type CodexSurface =
  | "sales" | "products" | "workshop" | "pnl" | "suppliers_inventory"
  | "staff_labour" | "cash_ar_ap" | "cross" | "customers" | "meta";

export type CodexEvalQuestion = Readonly<{
  id: string;
  tier: CodexTier;
  scope: CodexScope;
  surface: CodexSurface;
  pattern: "cold";
  question: string;
  expect?: string;
  format?: "line" | "bar" | "table" | "prose" | "chart_or_table" | "any";
}>;

export const CODEX_QUESTIONS: readonly CodexEvalQuestion[] = [
  // ── Easy: single-source lookups ─────────────────────────────────────────
  {
    id: "CE-01", tier: "easy", scope: "lightspeed", surface: "sales", pattern: "cold",
    question: "What were my total sales last week?",
    expect: "A single revenue figure for last calendar week (Mon–Sun, Melbourne time) from the POS sales source, stated with the period. Short prose; no chart needed.",
    format: "prose",
  },
  {
    id: "CE-02", tier: "easy", scope: "lightspeed", surface: "sales", pattern: "cold",
    question: "What were yesterday's takings?",
    expect: "Yesterday's sales total from POS. A one-line answer is ideal; may note if yesterday had no trading.",
    format: "prose",
  },
  {
    id: "CE-03", tier: "easy", scope: "lightspeed", surface: "products", pattern: "cold",
    question: "What were my top 10 products by revenue last month?",
    expect: "A ranked list/table of 10 products with revenue for last calendar month. Table or bar chart both fine.",
    format: "chart_or_table",
  },
  {
    id: "CE-04", tier: "easy", scope: "deputy", surface: "staff_labour", pattern: "cold",
    question: "How many hours did each of my staff work last week?",
    expect: "Per-employee worked hours for last week from Deputy timesheets (the authoritative source). Table format expected.",
    format: "table",
  },
  {
    id: "CE-05", tier: "easy", scope: "xero", surface: "cash_ar_ap", pattern: "cold",
    question: "How much money is owed to me right now, and how much do I owe?",
    expect: "Current accounts receivable and accounts payable totals from Xero, clearly labelled.",
    format: "prose",
  },
  {
    id: "CE-06", tier: "easy", scope: "xero", surface: "pnl", pattern: "cold",
    question: "What was my net profit in July?",
    expect: "July 2026 net profit from the Xero P&L (accrual), with income and expense context welcome but not required.",
    format: "prose",
  },
  {
    id: "CE-07", tier: "easy", scope: "lightspeed", surface: "sales", pattern: "cold",
    question: "How many sales did we ring up last Saturday, and what was the average sale value?",
    expect: "Transaction count and average transaction value for last Saturday. Two numbers, short prose.",
    format: "prose",
  },
  {
    id: "CE-08", tier: "easy", scope: "lightspeed", surface: "sales", pattern: "cold",
    question: "Which day of the week was busiest last month?",
    expect: "Day-of-week with highest revenue (or transactions — should state which) for last calendar month. Bar chart of days is a natural fit but prose is acceptable.",
    format: "any",
  },
  {
    id: "CE-09", tier: "easy", scope: "xero", surface: "pnl", pattern: "cold",
    question: "What did rent cost me last month?",
    expect: "Rent expense line from the Xero P&L for last calendar month.",
    format: "prose",
  },
  {
    id: "CE-10", tier: "easy", scope: "deputy", surface: "staff_labour", pattern: "cold",
    question: "What did wages cost me last week?",
    expect: "Last week's wage cost. Deputy timesheet wage cost is authoritative for operational labour; Xero P&L wages is monthly. Either is defensible if the source and period are stated.",
    format: "prose",
  },

  // ── Medium: trends, comparisons, margins ────────────────────────────────
  {
    id: "CM-01", tier: "medium", scope: "lightspeed", surface: "sales", pattern: "cold",
    question: "Chart my monthly sales for the last six months.",
    expect: "A line (or bar) chart of monthly revenue for the last 6 complete-ish months. Chart explicitly requested — its absence is a failure.",
    format: "line",
  },
  {
    id: "CM-02", tier: "medium", scope: "lightspeed", surface: "sales", pattern: "cold",
    question: "How is this month tracking against the same month last year?",
    expect: "August 2026 month-to-date vs August 2025 (ideally same-days comparison, or clearly state full-month vs partial). Direction and % change.",
    format: "prose",
  },
  {
    id: "CM-03", tier: "medium", scope: "lightspeed", surface: "products", pattern: "cold",
    question: "Which product categories are growing and which are shrinking over the last three months?",
    expect: "Category-level revenue trend over ~3 months with growers and decliners identified. Table or chart plus interpretation.",
    format: "chart_or_table",
  },
  {
    id: "CM-04", tier: "medium", scope: "lightspeed", surface: "products", pattern: "cold",
    question: "Show me gross margin by product category for last month.",
    expect: "Margin % (or margin $) by category for last calendar month from POS cost/revenue data. Bar chart or table.",
    format: "chart_or_table",
  },
  {
    id: "CM-05", tier: "medium", scope: "lightspeed", surface: "workshop", pattern: "cold",
    question: "What share of my revenue comes from the workshop versus retail sales?",
    expect: "Service/workshop revenue share vs retail, for a stated recent period. Should use POS category/type data and state how workshop is identified.",
    format: "any",
  },
  {
    id: "CM-06", tier: "medium", scope: "multi", surface: "cross", pattern: "cold",
    question: "Plot my weekly wage bill against weekly revenue for the past eight weeks.",
    expect: "A chart combining Deputy wage cost and POS revenue by week over 8 weeks (or two aligned series). Chart explicitly requested.",
    format: "line",
  },
  {
    id: "CM-07", tier: "medium", scope: "xero", surface: "suppliers_inventory", pattern: "cold",
    question: "Who are my top suppliers by spend this financial year?",
    expect: "Ranked suppliers by spend since 1 July 2026 (Australian FY) from Xero bills. Should handle the short FY-to-date window sensibly.",
    format: "chart_or_table",
  },
  {
    id: "CM-08", tier: "medium", scope: "xero", surface: "cash_ar_ap", pattern: "cold",
    question: "Which invoices and bills are overdue right now?",
    expect: "Overdue AR invoices and AP bills with amounts and days overdue (or due dates). Note: some historical bills carry junk due dates (1954/1996) — a good answer flags or excludes them rather than reporting absurd ages.",
    format: "table",
  },
  {
    id: "CM-09", tier: "medium", scope: "lightspeed", surface: "sales", pattern: "cold",
    question: "Show me cumulative revenue this month compared to last month as a chart.",
    expect: "A cumulative (running total) line chart with this month and last month as comparable series. Cumulative transform explicitly requested.",
    format: "line",
  },
  {
    id: "CM-10", tier: "medium", scope: "lightspeed", surface: "pnl", pattern: "cold",
    question: "How much GST have I collected this quarter?",
    expect: "GST collected from POS sales tax for the current quarter (Jul–Sep 2026 to date). Must use POS tax data, not Xero's directly-invoiced GST measure which massively understates it.",
    format: "prose",
  },

  // ── Hard: cross-source, multi-step, judgment ────────────────────────────
  {
    id: "CH-01", tier: "hard", scope: "multi", surface: "cross", pattern: "cold",
    question: "What's my revenue per worked hour, week by week, for the last two months — and is it improving?",
    expect: "Weekly POS revenue ÷ Deputy worked hours, ~8 points, with a trend verdict. Division must be computed from evidence (derived result), not invented. Chart is a natural fit.",
    format: "chart_or_table",
  },
  {
    id: "CH-02", tier: "hard", scope: "multi", surface: "staff_labour", pattern: "cold",
    question: "Rank my staff by sales per hour worked last month. Who's most productive, and what caveats should I keep in mind?",
    expect: "Per-employee POS sales attribution ÷ Deputy hours over a common period, ranked, with attribution caveats disclosed (register attribution vs who served, non-selling work like workshop time).",
    format: "table",
  },
  {
    id: "CH-03", tier: "hard", scope: "lightspeed", surface: "suppliers_inventory", pattern: "cold",
    question: "Which products do I appear overstocked on relative to how fast they sell?",
    expect: "Inventory on hand vs sales velocity — slow movers with high stock. If inventory levels aren't available, must say so plainly and offer the nearest supported analysis (e.g. slowest sellers), not fabricate stock counts.",
    format: "table",
  },
  {
    id: "CH-04", tier: "hard", scope: "multi", surface: "cross", pattern: "cold",
    question: "What's my labour cost as a percentage of gross profit, month by month this calendar year?",
    expect: "Monthly wages (Xero P&L wages or Deputy cost — stated) ÷ monthly gross profit, Jan–Aug 2026. Ratios must come from computed evidence. Should note any month where data is partial.",
    format: "chart_or_table",
  },
  {
    id: "CH-05", tier: "hard", scope: "multi", surface: "cross", pattern: "cold",
    question: "If I closed on Sundays, roughly what would I lose in sales versus save in wages, based on the last eight weeks?",
    expect: "Sunday revenue vs Sunday rostered wage cost over ~8 weeks, netted, with honest caveats (demand displacement to other days, fixed costs unaffected). Numbers grounded in both sources.",
    format: "any",
  },
  {
    id: "CH-06", tier: "hard", scope: "xero", surface: "cash_ar_ap", pattern: "cold",
    question: "Show me money in versus money out, month by month for the last six months. What's driving the gap?",
    expect: "Monthly cash in/out from Xero bank activity (or P&L as a stated proxy) over 6 months with a driver analysis. Chart of the two series is a natural fit.",
    format: "chart_or_table",
  },
  {
    id: "CH-07", tier: "hard", scope: "lightspeed", surface: "sales", pattern: "cold",
    question: "Break down my average sale: how do items per sale and price per item differ between weekdays and weekends?",
    expect: "Basket decomposition (items/sale, $/item, $/sale) split weekday vs weekend for a stated period. Derived ratios must be computed from evidence.",
    format: "table",
  },
  {
    id: "CH-08", tier: "hard", scope: "lightspeed", surface: "products", pattern: "cold",
    question: "Are there products that tend to sell together? What should I consider bundling?",
    expect: "Co-occurrence within sales (same-basket analysis) or an honest statement of what the data supports, with concrete bundle candidates. Must not fabricate affinity if line-item/sale linkage isn't queryable.",
    format: "any",
  },

  // ── xhard: strategy grounded in data ────────────────────────────────────
  {
    id: "CX-01", tier: "xhard", scope: "multi", surface: "cross", pattern: "cold",
    question: "It's late August. Based on what happened last spring, what should I be doing now to prepare for the spring season?",
    expect: "Uses Sep–Nov 2025 data: seasonal lift size, which categories/services spiked, staffing levels then vs now, stock implications. Concrete preparation actions tied to those numbers.",
    format: "any",
  },
  {
    id: "CX-02", tier: "xhard", scope: "multi", surface: "cross", pattern: "cold",
    question: "Give me a candid assessment: what are the three biggest problems in this business right now, backed by numbers?",
    expect: "Three distinct, materially important problems, each anchored to queried evidence across sources (margin, labour efficiency, cash, category decline, AR ageing...). Depth and candour matter; generic advice without numbers fails.",
    format: "any",
  },
  {
    id: "CX-03", tier: "xhard", scope: "multi", surface: "staff_labour", pattern: "cold",
    question: "I'm thinking about hiring another mechanic. Can the business afford it, and what would need to be true for it to pay off?",
    expect: "Current workshop revenue and capacity signals, wage cost of a mechanic (inferable from current wage rates), break-even framing (extra service revenue needed). Explicit assumptions, grounded current-state numbers.",
    format: "any",
  },
  {
    id: "CX-04", tier: "xhard", scope: "multi", surface: "cross", pattern: "cold",
    question: "Where am I leaving money on the table? Find one concrete opportunity I could test in the next month.",
    expect: "One specific, testable opportunity with target, intervention, expected outcome, baseline numbers from the data, and a stop/expand rule — evaluated against alternatives (the testable-opportunity brief shape).",
    format: "any",
  },
  {
    id: "CX-05", tier: "xhard", scope: "lightspeed", surface: "sales", pattern: "cold",
    question: "If I'd raised all prices 5% last quarter with no volume loss, what would that have done to revenue and margin — and where is the no-volume-loss assumption most fragile?",
    expect: "5% applied to last quarter's actual revenue (a derived computation), effect on gross margin, then a grounded fragility analysis (price-sensitive categories, competitive items). Arithmetic must be evidence-backed, not prose maths.",
    format: "any",
  },
  {
    id: "CX-06", tier: "xhard", scope: "multi", surface: "cross", pattern: "cold",
    question: "Design my Monday-morning dashboard: the five numbers I should check every week, with their current values and recent trend.",
    expect: "Five well-chosen KPIs (revenue, wage %, workshop bookings/mix, cash position, AR overdue...) each with a current value from the data and a trend. Selection rationale matters. Table fits well.",
    format: "chart_or_table",
  },

  // ── Ambiguous: underspecified prompts ───────────────────────────────────
  {
    id: "CA-01", tier: "ambiguous", scope: "multi", surface: "cross", pattern: "cold",
    question: "How are we doing?",
    expect: "Either a crisp multi-domain health check (sales trend, profit, labour, cash) with a stated period assumption, or a sharp clarification. A rambling dump or a needless clarification when a sensible default exists are both weaker.",
    format: "any",
  },
  {
    id: "CA-02", tier: "ambiguous", scope: "multi", surface: "sales", pattern: "cold",
    question: "Why was last week so quiet?",
    expect: "First verify whether last week WAS quiet vs preceding weeks/seasonal norm (it may not have been — a good answer checks the premise), then decompose: traffic vs basket, category, day pattern, staffing. Premise-checking is the key skill.",
    format: "any",
  },
  {
    id: "CA-03", tier: "ambiguous", scope: "multi", surface: "workshop", pattern: "cold",
    question: "Is the workshop actually worth it?",
    expect: "Defines 'worth it' explicitly (revenue share, margin after labour, pull-through retail sales), computes what the data supports, discloses what it can't measure (e.g. labour hours attributable to workshop).",
    format: "any",
  },
  {
    id: "CA-04", tier: "ambiguous", scope: "multi", surface: "staff_labour", pattern: "cold",
    question: "Are wages too high?",
    expect: "Anchors to a benchmarkable ratio (wages % of revenue or gross profit) with trend, states the benchmark assumption for a bike retailer, avoids a bare yes/no without evidence.",
    format: "any",
  },
  {
    id: "CA-05", tier: "ambiguous", scope: "multi", surface: "cross", pattern: "cold",
    question: "What happened in June?",
    expect: "A sensible interpretation: June 2026 month summary (sales, profit, notable anomalies vs May/July). Should pick the obvious recent June and say so, not stall on which June.",
    format: "any",
  },
  {
    id: "CA-06", tier: "ambiguous", scope: "lightspeed", surface: "products", pattern: "cold",
    question: "Show me the numbers for bikes.",
    expect: "'Bikes' is ambiguous (complete bikes category vs whole shop). Good answers either ask one sharp clarifying question or state an assumption (bike-category sales, recent period) and show revenue/units/trend for it.",
    format: "any",
  },

  // ── Meta: about the data itself ─────────────────────────────────────────
  {
    id: "CD-01", tier: "meta", scope: "meta", surface: "meta", pattern: "cold",
    question: "What data sources are connected for my shop, and how fresh is each one right now?",
    expect: "Lists Lightspeed, Xero, Deputy with an honest freshness statement (latest data timestamps per source, queried not guessed). No invented sync times.",
    format: "any",
  },
  {
    id: "CD-02", tier: "meta", scope: "meta", surface: "meta", pattern: "cold",
    question: "What can't you see about my business? What are your blind spots?",
    expect: "Honest capability boundaries: e.g. no foot traffic, no supplier price lists, no booking pipeline, per-employee payslip detail limits, attribution limits. Specific to the connected stack, not generic AI disclaimers.",
    format: "prose",
  },
  {
    id: "CD-03", tier: "meta", scope: "meta", surface: "meta", pattern: "cold",
    question: "When I ask about revenue, which source do you use — the register or Xero — and why? Do they agree?",
    expect: "Explains POS (Lightspeed) as canonical sales vs Xero P&L as whole-business income, why summing platforms double-counts (Square card-tender subset), ideally with a reconciliation number for a recent month.",
    format: "prose",
  },
  {
    id: "CD-04", tier: "meta", scope: "meta", surface: "meta", pattern: "cold",
    question: "How far back does my sales data go, and are there any gaps or quality issues I should know about?",
    expect: "Queried earliest-sale date, coverage span, and any real gaps/quality caveats (duplicate raw versions deduplicated in governed views, etc.). Honesty over completeness theatre.",
    format: "prose",
  },
  {
    id: "CD-05", tier: "meta", scope: "meta", surface: "meta", pattern: "cold",
    question: "For staff hours, do you trust Deputy or the POS timecards? Why?",
    expect: "Deputy is authoritative; POS/Square timecards run far higher due to unclosed/auto entries (July 2026: ~968h vs ~360h). Should state this clearly, ideally with the magnitude.",
    format: "prose",
  },

  // ── Theory: frameworks applied to this business ─────────────────────────
  {
    id: "CT-01", tier: "theory", scope: "multi", surface: "suppliers_inventory", pattern: "cold",
    question: "How should I think about inventory turns for a bike shop like mine? What's a healthy target, and where am I today?",
    expect: "A clear framework (turns = COGS ÷ avg inventory, seasonal shape, category differences), an industry-sensible target range, and an honest attempt to compute or approximate the shop's own figure — or a plain statement of what's missing to compute it.",
    format: "any",
  },
  {
    id: "CT-02", tier: "theory", scope: "multi", surface: "cross", pattern: "cold",
    question: "What KPIs should a shop my size track weekly, and what are mine right now?",
    expect: "A principled small KPI set with reasoning, then actual current values computed from the data for each (or disclosure where not computable). Both halves matter: framework AND numbers.",
    format: "chart_or_table",
  },
  {
    id: "CT-03", tier: "theory", scope: "multi", surface: "workshop", pattern: "cold",
    question: "How should I price workshop labour? What frameworks apply, and what do my numbers say about where I am?",
    expect: "Cost-plus vs market-rate vs value framing, effective labour recovery rate computed from workshop revenue vs mechanic hours/cost where possible, and a grounded observation about current effective rates.",
    format: "any",
  },
  {
    id: "CT-04", tier: "theory", scope: "multi", surface: "cross", pattern: "cold",
    question: "Is my shop better understood as a retail business with a service arm, or a service business that sells product? Use my numbers.",
    expect: "Revenue/margin mix between service and retail, margin quality, labour absorption — then a reasoned verdict with strategic implications. The verdict must follow from queried numbers.",
    format: "any",
  },
  {
    id: "CT-05", tier: "theory", scope: "multi", surface: "cash_ar_ap", pattern: "cold",
    question: "What's a sensible way to think about seasonality in my cash planning, and what does my own seasonal pattern look like?",
    expect: "A cash-planning framework (build cash before trough, stock build before peak) plus the shop's actual monthly revenue/cash shape across available history, ideally charted.",
    format: "chart_or_table",
  },

  // ── Goal-seek: the owner names a numeric target and wants a concrete path ─
  {
    id: "GS-01", tier: "goal", scope: "multi", surface: "cross", pattern: "cold",
    question: "can we save 1k per month somehow?",
    expect: "A direct verdict against the owner's own $1,000/month target, then a concrete bridge: specific named expense lines (not vague pools) each quantified at a monthly level from the owner's data, with an explicit statement of which named levers together reach or approach $1,000/month. Recurring savings must be distinguished from one-offs (an annual accounting bill is not a monthly saving). Generic advice ('negotiate with suppliers', 'review subscriptions') without the owner's own line-level figures is a failure, as is an answer that never restates or engages with the $1,000 target.",
    format: "chart_or_table",
  },
  {
    id: "GS-02", tier: "goal", scope: "multi", surface: "cross", pattern: "cold",
    question: "How could I make an extra $500 a week?",
    expect: "Revenue-side goal-seek: the answer should size the $500/week target against the owner's current weekly baseline (what % lift it represents), then propose the few most material levers each grounded in the owner's data (e.g. workshop capacity, high-margin categories, quiet days with headroom, aged stock to convert), quantifying what each lever plausibly contributes toward $500/week. A list of untethered ideas with no figures, or figures with no link back to the weekly target, is a failure.",
    format: "any",
  },
  {
    id: "GS-03", tier: "goal", scope: "multi", surface: "cross", pattern: "cold",
    question: "We need to cut costs by 10%. Where should that come from?",
    expect: "The relative target must be converted to dollars first (10% of the owner's actual cost base, stated with the base and period), then allocated across named expense lines ranked by size and controllability, protecting revenue-generating spend. The answer must state which specific cuts add to roughly the dollar target. An answer that never computes what 10% actually is in dollars is a failure.",
    format: "chart_or_table",
  },
  {
    id: "GS-04", tier: "goal", scope: "multi", surface: "staff_labour", pattern: "cold",
    question: "I want to get my wage bill under $10k a month. What would that take?",
    expect: "Current monthly wage bill stated per month over recent months, the gap to the owner's $10k target quantified for the months over it, and what closing the gap means concretely (hours at the observed average hourly cost, which months/rosters drive the excess). Must engage with $10,000 as the yardstick and note any month already under it. Pure trend recital without the target arithmetic is a failure.",
    format: "chart_or_table",
  },
  {
    id: "GS-05", tier: "goal", scope: "multi", surface: "cross", pattern: "cold",
    question: "If I needed to free up $20k of cash in the next two months, where would it come from?",
    expect: "One-off cash levers sized from the owner's data: aged/slow stock value at cost, receivables outstanding, payables timing — each quantified, then combined against the $20k target with honest discounting (aged stock rarely sells at full value). Recurring P&L savings alone cannot reach $20k in two months and should not be presented as the primary path.",
    format: "chart_or_table",
  },
  {
    id: "GS-06", tier: "goal", scope: "multi", surface: "cross", pattern: "cold",
    question: "What's the single biggest saving available to me right now?",
    expect: "One clearly named saving with its size in the owner's data, defended against the runner-up candidates (why this one is biggest/most controllable), with the practical action stated. Hedging across many small candidates without naming a winner is a failure.",
    format: "any",
  },
];
