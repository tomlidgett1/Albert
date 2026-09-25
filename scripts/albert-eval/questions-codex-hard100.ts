import type { EvalQuestion } from "./questions.js";

/**
 * Hard-100 codex battery: 100 extremely hard turns for Ashburton Cycles
 * (lightspeed-r + xero + deputy), built around multi-turn threads — cold
 * opens followed by drilldowns, chart reformats, challenges and memory
 * follow-ups — because production owners interrogate answers, they don't
 * just accept them.
 *
 * 72 turns live in 26 threads; 28 are cold singles. `expect` is grader-only.
 * Question text never names internal views/tables.
 */
export const CODEX_HARD100_QUESTIONS: readonly EvalQuestion[] = [
  // ═══ Lightspeed threads ═════════════════════════════════════════════════
  // TH-LS-YOY: year-over-year decomposition
  {
    id: "H-01", tier: "hard", scope: "lightspeed", surface: "sales", pattern: "cold",
    thread: "TH-LS-YOY", turn: 1,
    question: "Show me monthly sales this calendar year next to the same month last year, with the year-over-year change as a percentage in its own column.",
    expect: "A table with months as rows (Jan–Aug 2026), 2026 revenue, 2025 revenue, and a derived YoY % column. The % must be computed from evidence (derived result), months aligned correctly (Jan with Jan). Partial August should be flagged.",
    format: "table",
  },
  {
    id: "H-02", tier: "hard", scope: "lightspeed", surface: "sales", pattern: "followup",
    thread: "TH-LS-YOY", turn: 2,
    question: "Now do the same for the number of sales instead of dollars. Is it volume or basket size that's moving?",
    expect: "Same YoY table shape for transaction counts, then a verdict decomposing revenue change into volume (count) vs basket (avg sale value) — the verdict must follow from both tables' numbers, not hand-waving.",
    format: "table",
  },
  {
    id: "H-03", tier: "xhard", scope: "lightspeed", surface: "products", pattern: "drilldown",
    thread: "TH-LS-YOY", turn: 3,
    question: "Take the worst year-over-year month from that table and tell me which product categories caused the drop.",
    expect: "Correctly identifies the worst YoY month from the prior turn's own table (memory), then category-level comparison of that month vs same month prior year, ranking categories by dollar decline. Must reference the same month it showed earlier.",
    format: "chart_or_table",
  },
  // TH-LS-BASKET: basket economics
  {
    id: "H-04", tier: "hard", scope: "lightspeed", surface: "sales", pattern: "cold",
    thread: "TH-LS-BASKET", turn: 1,
    question: "Decompose my average sale over the last eight weeks: items per sale, price per item, and dollars per sale — split weekdays versus weekends.",
    expect: "A weekday-vs-weekend table of derived ratios (items/sale, $/item, $/sale) over ~8 weeks. All ratios computed from evidence. Should state which side wins on basket vs volume.",
    format: "table",
  },
  {
    id: "H-05", tier: "hard", scope: "lightspeed", surface: "sales", pattern: "drilldown",
    thread: "TH-LS-BASKET", turn: 2,
    question: "Interesting. Within Saturdays specifically, which hours of the day carry the revenue, and does basket size change late in the day?",
    expect: "Hour-of-day revenue distribution for Saturdays over a stated window, plus avg sale value by hour (or an honest statement if hourly granularity is unsupported — no fabricated hourly figures).",
    format: "chart_or_table",
  },
  {
    id: "H-06", tier: "medium", scope: "lightspeed", surface: "sales", pattern: "chart_reformat",
    thread: "TH-LS-BASKET", turn: 3,
    question: "Chart the weekday-versus-weekend dollars per sale over those eight weeks so I can see if the gap is widening.",
    expect: "A line chart (two series or split) of avg sale value weekday vs weekend by week — an actual chart artefact is required, not a prose description. Verdict on gap direction.",
    format: "line",
  },
  // TH-LS-CAT: category mix shift
  {
    id: "H-07", tier: "hard", scope: "lightspeed", surface: "products", pattern: "cold",
    thread: "TH-LS-CAT", turn: 1,
    question: "How has my revenue mix by product category shifted over the last six months? Show share of revenue, not just dollars.",
    expect: "Category share-of-revenue per month (or start vs end comparison) over ~6 months, with share % derived from evidence. Winners/losers in mix called out.",
    format: "chart_or_table",
  },
  {
    id: "H-08", tier: "xhard", scope: "lightspeed", surface: "products", pattern: "drilldown",
    thread: "TH-LS-CAT", turn: 2,
    question: "Which of those categories is losing margin as well as share? I care about margin dollars, not just percent.",
    expect: "Category margin dollars (and %) trend over the same window, cross-referenced with the share shifts from turn 1. Must distinguish margin-$ decline from share decline.",
    format: "chart_or_table",
  },
  {
    id: "H-09", tier: "xhard", scope: "lightspeed", surface: "products", pattern: "followup",
    thread: "TH-LS-CAT", turn: 3,
    question: "Hang on — I was sure accessories were growing. Are you certain? Double-check and show your working.",
    expect: "A premise-check under challenge: re-verify the accessories trend with explicit figures and period, either confirming the earlier claim with evidence or correcting it. Capitulating to the owner without data is a failure; so is dismissing the challenge without re-checking.",
    format: "any",
  },
  // TH-LS-WORKSHOP: workshop deep dive
  {
    id: "H-10", tier: "hard", scope: "lightspeed", surface: "workshop", pattern: "cold",
    thread: "TH-LS-WORKSHOP", turn: 1,
    question: "Break down my workshop business over the last three months: revenue, job count, and average job value, month by month.",
    expect: "Monthly workshop/service revenue, job (sale) counts and derived avg job value for ~3 months, clearly separated from retail. How 'workshop' is identified (category/type) should be stated.",
    format: "table",
  },
  {
    id: "H-11", tier: "xhard", scope: "multi", surface: "workshop", pattern: "followup",
    thread: "TH-LS-WORKSHOP", turn: 2,
    question: "Against the mechanic hours we're rostering, what does that revenue say about my effective labour recovery rate?",
    expect: "Workshop revenue ÷ mechanic/rostered hours (Deputy) as an effective hourly recovery rate, compared to a stated charge-out or wage-cost anchor. Cross-source derived ratio with caveats about which hours count as workshop.",
    format: "any",
  },
  {
    id: "H-12", tier: "hard", scope: "multi", surface: "workshop", pattern: "followup",
    thread: "TH-LS-WORKSHOP", turn: 3,
    question: "Is August on track to be the workshop's best or worst month of those, given it isn't finished yet?",
    expect: "Partial-month handling: August-to-date workshop revenue, a run-rate or same-days comparison against the prior months, and an explicit on-track verdict with the partial-month caveat.",
    format: "prose",
  },
  // TH-LS-DISC: discounts and refunds
  {
    id: "H-13", tier: "hard", scope: "lightspeed", surface: "sales", pattern: "cold",
    thread: "TH-LS-DISC", turn: 1,
    question: "How much revenue am I giving away in discounts and refunds, month by month this year?",
    expect: "Monthly discount totals and refund totals Jan–Aug 2026 (or honest disclosure of what's measurable), with the combined giveaway as % of gross revenue derived.",
    format: "chart_or_table",
  },
  {
    id: "H-14", tier: "xhard", scope: "lightspeed", surface: "sales", pattern: "drilldown",
    thread: "TH-LS-DISC", turn: 2,
    question: "Where is the discounting concentrated — which categories or which days — and does it actually correlate with moving more units?",
    expect: "Discount concentration by category (or day pattern) plus an honest look at whether discounted periods/categories show higher unit volume. Correlation caution required; no invented elasticity.",
    format: "any",
  },
  // TH-LS-VELOCITY: stock velocity → markdown → cash
  {
    id: "H-15", tier: "hard", scope: "lightspeed", surface: "suppliers_inventory", pattern: "cold",
    thread: "TH-LS-VELOCITY", turn: 1,
    question: "Which products have sold the fewest units in the last 90 days relative to how much stock I'm holding of them?",
    expect: "Slow movers vs stock-on-hand, or a plain statement of inventory-data limits plus the nearest supported analysis (slowest sellers by units with revenue). No fabricated stock counts.",
    format: "table",
  },
  {
    id: "H-16", tier: "xhard", scope: "lightspeed", surface: "suppliers_inventory", pattern: "followup",
    thread: "TH-LS-VELOCITY", turn: 2,
    question: "If I ran a 30% clearance on the ten slowest of those, what revenue would that plausibly bring in, and what's the margin cost?",
    expect: "A sized clearance scenario built from the actual slow-mover list: stated assumptions (sell-through at 30% off), derived revenue estimate and margin give-up. Arithmetic from evidence, assumptions explicit.",
    format: "any",
  },
  {
    id: "H-17", tier: "hard", scope: "multi", surface: "cash_ar_ap", pattern: "followup",
    thread: "TH-LS-VELOCITY", turn: 3,
    question: "And what would that clearance do for my cash position next month, netted against what I'd normally make on those items?",
    expect: "Cash framing of the same scenario: incremental cash next month vs baseline drift of those items at normal velocity. Must reuse the same items/numbers from earlier turns, not restart.",
    format: "prose",
  },
  // TH-LS-CUST: customer concentration
  {
    id: "H-18", tier: "hard", scope: "lightspeed", surface: "customers", pattern: "cold",
    thread: "TH-LS-CUST", turn: 1,
    question: "Who are my top 15 customers by spend over the last 12 months, and how concentrated is my revenue in them?",
    expect: "Top-15 customer table with spend, plus derived concentration (top-15 share of total revenue). Walk-in/unattributed sales must be handled honestly (share of revenue with no customer attached).",
    format: "table",
  },
  {
    id: "H-19", tier: "xhard", scope: "lightspeed", surface: "customers", pattern: "followup",
    thread: "TH-LS-CUST", turn: 2,
    question: "Of those top customers, who hasn't been back in the last two months? Estimate what their absence is costing me.",
    expect: "Cross-references the turn-1 list against recent activity (memory + new query), lists lapsed top customers, and sizes the gap from their historical run-rate. Derived, evidence-grounded.",
    format: "table",
  },
  // TH-LS-SEASON: seasonality → forecast
  {
    id: "H-20", tier: "hard", scope: "lightspeed", surface: "sales", pattern: "cold",
    thread: "TH-LS-SEASON", turn: 1,
    question: "Using all the history you have, what does my seasonal revenue shape look like across the calendar year?",
    expect: "Monthly revenue across available history (ideally >1 year to show the seasonal shape), peak/trough months named, chart natural. Coverage limits of the data stated.",
    format: "line",
  },
  {
    id: "H-21", tier: "xhard", scope: "lightspeed", surface: "sales", pattern: "followup",
    thread: "TH-LS-SEASON", turn: 2,
    question: "Based on that shape and this year's trajectory so far, what should I expect September and October to do in dollars?",
    expect: "A grounded projection: last year's Sep/Oct actuals adjusted by this year's observed YoY trend, with the method and its fragility stated. Numbers must be traceable to evidence; a bare guess or refusal to estimate both fail.",
    format: "any",
  },
  {
    id: "H-22", tier: "medium", scope: "lightspeed", surface: "sales", pattern: "chart_reformat",
    thread: "TH-LS-SEASON", turn: 3,
    question: "Put this year and last year on the same chart by month so I can see the seasonal gap.",
    expect: "A two-series line chart (2025 vs 2026 by month). The chart artefact is the deliverable; absence fails.",
    format: "line",
  },

  // ═══ Deputy threads ═════════════════════════════════════════════════════
  // TH-DP-ROSTER: staffing vs demand
  {
    id: "H-23", tier: "hard", scope: "multi", surface: "staff_labour", pattern: "cold",
    thread: "TH-DP-ROSTER", turn: 1,
    question: "Line up my rostered hours against revenue by day of week over the last six weeks. Where does staffing not match demand?",
    expect: "Day-of-week worked/rostered hours (Deputy) vs day-of-week revenue (POS) over ~6 weeks, with a derived revenue-per-hour by weekday and named mismatch days.",
    format: "chart_or_table",
  },
  {
    id: "H-24", tier: "xhard", scope: "multi", surface: "staff_labour", pattern: "drilldown",
    thread: "TH-DP-ROSTER", turn: 2,
    question: "Take the most overstaffed day you found and tell me what trimming ten hours off it would save per month, and what the risk is.",
    expect: "Uses the same day identified in turn 1 (memory), sizes 10 h/week at observed average hourly wage cost → monthly saving, and gives a demand-coverage risk assessment from that day's revenue pattern.",
    format: "prose",
  },
  {
    id: "H-25", tier: "hard", scope: "deputy", surface: "staff_labour", pattern: "followup",
    thread: "TH-DP-ROSTER", turn: 3,
    question: "Who actually works that day most weeks? I need to know whose hours we'd be discussing.",
    expect: "Per-employee hours concentrated on the named day over recent weeks, from Deputy timesheets. A simple honest table; privacy-safe (owner is allowed to see staff hours).",
    format: "table",
  },
  // TH-DP-STAFF: staff productivity
  {
    id: "H-26", tier: "hard", scope: "deputy", surface: "staff_labour", pattern: "cold",
    thread: "TH-DP-STAFF", turn: 1,
    question: "Show me each staff member's hours and wage cost per month for the last three months. Who's trending up?",
    expect: "Per-employee monthly hours + wage cost for ~3 months from Deputy, with the trend direction per person. Table expected.",
    format: "table",
  },
  {
    id: "H-27", tier: "xhard", scope: "multi", surface: "staff_labour", pattern: "followup",
    thread: "TH-DP-STAFF", turn: 2,
    question: "Now rank them by revenue per hour worked last month. Before you do — what will make this ranking unfair, and how should I read it?",
    expect: "The caveats must come first as requested (attribution limits: register vs server, workshop vs floor, non-selling duties), then the per-employee revenue/hour ranking computed from evidence.",
    format: "table",
  },
  {
    id: "H-28", tier: "hard", scope: "deputy", surface: "staff_labour", pattern: "drilldown",
    thread: "TH-DP-STAFF", turn: 3,
    question: "For the person at the bottom of that ranking, what do their shifts actually look like — days, lengths, times?",
    expect: "Correctly carries the bottom-ranked person from turn 2 (memory), shows their recent shift pattern from Deputy (days of week, shift lengths, start times). No judgement leaps beyond the data.",
    format: "table",
  },
  // TH-DP-OT: overtime and long shifts
  {
    id: "H-29", tier: "hard", scope: "deputy", surface: "staff_labour", pattern: "cold",
    thread: "TH-DP-OT", turn: 1,
    question: "Are long shifts or overtime creeping into my roster? Look at the last two months.",
    expect: "Shift-length distribution / long-shift counts (e.g. >9h) and any overtime signal available in the timesheet data over ~2 months, honestly disclosed if award/overtime flags aren't modelled.",
    format: "any",
  },
  {
    id: "H-30", tier: "xhard", scope: "multi", surface: "staff_labour", pattern: "followup",
    thread: "TH-DP-OT", turn: 2,
    question: "What are those long shifts costing me compared with covering the same hours across two people, and is there a revenue argument for keeping them?",
    expect: "Cost framing of long shifts at observed wage rates vs split coverage (state assumptions about loadings honestly), plus whether long-shift days show revenue that justifies them. Derived numbers, assumptions explicit.",
    format: "any",
  },
  // TH-DP-WAGEPCT: wage percentage discipline
  {
    id: "H-31", tier: "hard", scope: "multi", surface: "staff_labour", pattern: "cold",
    thread: "TH-DP-WAGEPCT", turn: 1,
    question: "Week by week for the last twelve weeks, what were my wages as a percentage of revenue?",
    expect: "Twelve weekly rows: revenue, wage cost, derived wage %. Source for wages stated (Deputy operational cost vs Xero P&L). Chart or table.",
    format: "chart_or_table",
  },
  {
    id: "H-32", tier: "xhard", scope: "multi", surface: "staff_labour", pattern: "drilldown",
    thread: "TH-DP-WAGEPCT", turn: 2,
    question: "Pick the two worst weeks in that series and explain what drove them — was it a revenue problem or an hours problem?",
    expect: "Identifies the two worst wage-% weeks from its own series (memory), decomposes each: revenue vs typical, hours vs typical. The attribution must follow from the numbers.",
    format: "any",
  },
  {
    id: "H-33", tier: "goal", scope: "multi", surface: "staff_labour", pattern: "followup",
    thread: "TH-DP-WAGEPCT", turn: 3,
    question: "I want wages under 30% of revenue consistently. How far off am I, and what combination of hours or sales gets me there?",
    expect: "Goal engagement with the owner's 30% target: current gap per recent week, then the two levers quantified (hours cut at avg wage cost, or revenue lift required at current hours). Must state which weeks already meet 30%.",
    format: "any",
  },

  // ═══ Xero threads ═══════════════════════════════════════════════════════
  // TH-XR-PNL: P&L interrogation
  {
    id: "H-34", tier: "hard", scope: "xero", surface: "pnl", pattern: "cold",
    thread: "TH-XR-PNL", turn: 1,
    question: "Give me my profit and loss by month for this calendar year: income, gross profit, expenses, net profit.",
    expect: "Monthly P&L table Jan–Aug 2026 from Xero (accrual), four measures as columns or rows, partial August flagged.",
    format: "table",
  },
  {
    id: "H-35", tier: "xhard", scope: "xero", surface: "pnl", pattern: "drilldown",
    thread: "TH-XR-PNL", turn: 2,
    question: "Which expense lines have grown the fastest across those months? Name them with numbers, not categories like 'other'.",
    expect: "Account-level expense lines ranked by growth (first→last month or trend), specific named accounts with dollar deltas. Vague pools fail.",
    format: "table",
  },
  {
    id: "H-36", tier: "hard", scope: "xero", surface: "pnl", pattern: "chart_reformat",
    thread: "TH-XR-PNL", turn: 3,
    question: "Re-cut that first table for me: months as columns, and every line as a percentage of that month's income.",
    expect: "A pivoted common-size P&L: months as columns, measures as rows, values as % of income (derived). This is the pivot+percent stress: rowFormats/pivot machinery must produce a real table.",
    format: "table",
  },
  // TH-XR-CASH: cash flow
  {
    id: "H-37", tier: "hard", scope: "xero", surface: "cash_ar_ap", pattern: "cold",
    thread: "TH-XR-CASH", turn: 1,
    question: "Show money in versus money out of the bank, month by month for the last six months, and the net position each month.",
    expect: "Monthly cash in/out from Xero bank activity with derived net per month, 6 months. Chart of the two series + net is natural.",
    format: "chart_or_table",
  },
  {
    id: "H-38", tier: "xhard", scope: "xero", surface: "cash_ar_ap", pattern: "drilldown",
    thread: "TH-XR-CASH", turn: 2,
    question: "Take the worst net month in that window and tell me exactly where the money went.",
    expect: "Identifies its own worst net month (memory), then decomposes that month's outflows (major payment categories/payees available in the data) with dollars. Honest about visibility limits on bank-line categorisation.",
    format: "any",
  },
  {
    id: "H-39", tier: "xhard", scope: "xero", surface: "cash_ar_ap", pattern: "followup",
    thread: "TH-XR-CASH", turn: 3,
    question: "Given what's owed to me and what I owe right now, what does the next eight weeks of cash look like if trading stays at recent levels?",
    expect: "A grounded 8-week cash outlook: current AR (with realistic collection timing), current AP, recent weekly cash-trading run-rate. Assumptions explicit; arithmetic from evidence. A refusal to project or an ungrounded number both fail.",
    format: "any",
  },
  // TH-XR-AR: receivables discipline
  {
    id: "H-40", tier: "hard", scope: "xero", surface: "cash_ar_ap", pattern: "cold",
    thread: "TH-XR-AR", turn: 1,
    question: "Break down who owes me money and how overdue each invoice is.",
    expect: "AR by contact with ageing (current/30/60/90+ or due dates), from Xero invoices. Table expected; totals must reconcile to overall AR.",
    format: "table",
  },
  {
    id: "H-41", tier: "hard", scope: "xero", surface: "cash_ar_ap", pattern: "drilldown",
    thread: "TH-XR-AR", turn: 2,
    question: "Which of those debts should I chase first? Order them by a sensible combination of size and age.",
    expect: "A prioritised chase list derived from the turn-1 data (size × age reasoning stated). Analytical only — must not offer to send emails or contact anyone.",
    format: "table",
  },
  {
    id: "H-42", tier: "medium", scope: "xero", surface: "cash_ar_ap", pattern: "followup",
    thread: "TH-XR-AR", turn: 3,
    question: "If the top three on that chase list paid tomorrow, what would my receivables balance drop to?",
    expect: "Simple derived arithmetic from its own chase list: current AR minus top-3 amounts, both figures stated. Tests memory + derivation, not new investigation.",
    format: "prose",
  },
  // TH-XR-GM: margin reconciliation
  {
    id: "H-43", tier: "xhard", scope: "multi", surface: "pnl", pattern: "cold",
    thread: "TH-XR-GM", turn: 1,
    question: "My register says one gross margin and my accountant's P&L implies another. Compare them for last month and explain the difference.",
    expect: "POS margin (revenue−cost from Lightspeed) vs Xero gross profit for last calendar month, both computed, with a principled reconciliation (timing, freight/COGS policy, workshop labour in COGS, stock adjustments). Must not pretend they should match exactly.",
    format: "any",
  },
  {
    id: "H-44", tier: "xhard", scope: "multi", surface: "pnl", pattern: "followup",
    thread: "TH-XR-GM", turn: 2,
    question: "Which number should I use when I'm setting prices, and which when I'm judging the month? Be decisive.",
    expect: "A decisive, correctly-reasoned assignment: POS item-level margin for pricing decisions, accountant's P&L for whole-month performance — with the why grounded in the turn-1 reconciliation. Fence-sitting fails.",
    format: "prose",
  },
  {
    id: "H-45", tier: "hard", scope: "multi", surface: "pnl", pattern: "followup",
    thread: "TH-XR-GM", turn: 3,
    question: "Has the gap between the two measures been stable over the last four months, or is something drifting?",
    expect: "Four monthly pairs of POS margin vs Xero GP with the derived gap per month and a drift verdict. Consistent methodology across months.",
    format: "chart_or_table",
  },
  // TH-XR-EXP: expense creep
  {
    id: "H-46", tier: "hard", scope: "xero", surface: "pnl", pattern: "cold",
    thread: "TH-XR-EXP", turn: 1,
    question: "Hunt through my expenses for anything that looks like subscription or software creep — recurring charges that have grown or multiplied this year.",
    expect: "Recurring expense lines (software/subscriptions/fees accounts) tracked across 2026 months, named with amounts and growth. Honest about ledger granularity limits.",
    format: "table",
  },
  {
    id: "H-47", tier: "xhard", scope: "xero", surface: "pnl", pattern: "followup",
    thread: "TH-XR-EXP", turn: 2,
    question: "Which two of those would you cancel first, what's the annualised saving, and what am I risking by cutting them?",
    expect: "Two named candidates with monthly→annualised derived savings and a genuine risk note per cut. Decisiveness plus grounded arithmetic; generic 'review your subscriptions' fails.",
    format: "prose",
  },
  // TH-XR-GST: tax position
  {
    id: "H-48", tier: "hard", scope: "multi", surface: "cash_ar_ap", pattern: "cold",
    thread: "TH-XR-GST", turn: 1,
    question: "Where does my GST position stand this quarter compared with last quarter?",
    expect: "GST collected (POS tax is authoritative for register sales) and paid/credits where visible, this quarter-to-date vs last quarter, clearly labelled. Known trap: Xero direct-invoice GST alone understates collections.",
    format: "prose",
  },
  {
    id: "H-49", tier: "hard", scope: "multi", surface: "cash_ar_ap", pattern: "followup",
    thread: "TH-XR-GST", turn: 2,
    question: "How much should I be setting aside each week for the BAS at current trading levels?",
    expect: "A weekly set-aside figure derived from the quarter-to-date GST run rate, method shown, with the accrual-vs-cash caveat and 'confirm with your accountant' framing without hiding behind it.",
    format: "prose",
  },

  // ═══ Cross-source threads ═══════════════════════════════════════════════
  // TH-XS-GPH: gross profit per worked hour
  {
    id: "H-50", tier: "xhard", scope: "multi", surface: "cross", pattern: "cold",
    thread: "TH-XS-GPH", turn: 1,
    question: "Week by week for the last ten weeks, what gross profit did each hour of staff time generate?",
    expect: "Weekly POS gross profit ÷ Deputy worked hours, ~10 points, derived from evidence, charted or tabled with the trend named.",
    format: "chart_or_table",
  },
  {
    id: "H-51", tier: "xhard", scope: "multi", surface: "cross", pattern: "drilldown",
    thread: "TH-XS-GPH", turn: 2,
    question: "There's a dip in that series — find it and tell me whether margin, sales volume, or hours caused it.",
    expect: "Locates the weakest week(s) in its own series (memory), decomposes GP/hour into components (GP: revenue×margin; hours), attributes the dip with numbers. If the series has no meaningful dip, saying so with evidence is correct.",
    format: "any",
  },
  {
    id: "H-52", tier: "goal", scope: "multi", surface: "cross", pattern: "followup",
    thread: "TH-XS-GPH", turn: 3,
    question: "What would it take to hold that number above $80 an hour every week — put real levers on it.",
    expect: "Goal-seek against the owner's $80/hr target: current shortfall weeks quantified, levers (hours trim on weak days, margin points, revenue lift) each converted into $/hr impact. Target arithmetic mandatory.",
    format: "any",
  },
  // TH-XS-UNIT: unit economics
  {
    id: "H-53", tier: "xhard", scope: "multi", surface: "cross", pattern: "cold",
    thread: "TH-XS-UNIT", turn: 1,
    question: "Walk me through the unit economics of an average sale in my shop last month: what I keep after product cost and the labour it takes to make it.",
    expect: "Average sale value, product cost per sale, gross margin per sale, and a labour-per-sale allocation (wages ÷ transactions) — all derived, building to a contribution-per-sale figure with assumptions explicit.",
    format: "any",
  },
  {
    id: "H-54", tier: "xhard", scope: "multi", surface: "cross", pattern: "followup",
    thread: "TH-XS-UNIT", turn: 2,
    question: "Run the same numbers for the same month last year. Am I keeping more or less of each sale now?",
    expect: "Same unit-economics decomposition for the prior-year month, aligned side by side with deltas. Methodological consistency across the two periods is the test.",
    format: "table",
  },
  {
    id: "H-55", tier: "hard", scope: "multi", surface: "cross", pattern: "followup",
    thread: "TH-XS-UNIT", turn: 3,
    question: "Which single component of that per-sale picture moved the most, and what's the first thing you'd do about it?",
    expect: "Names the biggest mover from its own comparison (memory), one concrete action tied to that component with a sized expected effect.",
    format: "prose",
  },
  // TH-XS-BREAKEVEN: break-even discipline
  {
    id: "H-56", tier: "xhard", scope: "multi", surface: "cross", pattern: "cold",
    thread: "TH-XS-BREAKEVEN", turn: 1,
    question: "Work out my monthly break-even point from my actual cost base, and show how you got there.",
    expect: "Fixed costs from Xero P&L (rent, wages base, utilities...), observed gross margin %, derived break-even revenue = fixed ÷ GM%. Method transparent, figures from evidence, classification assumptions stated.",
    format: "any",
  },
  {
    id: "H-57", tier: "xhard", scope: "multi", surface: "cross", pattern: "drilldown",
    thread: "TH-XS-BREAKEVEN", turn: 2,
    question: "For each of the last four months, on what day of the month did I actually cross that break-even line?",
    expect: "Cumulative daily revenue per month vs the turn-1 break-even level, crossing day named per month (or honest granularity limits). Reuses its own break-even figure.",
    format: "table",
  },
  {
    id: "H-58", tier: "hard", scope: "multi", surface: "cross", pattern: "followup",
    thread: "TH-XS-BREAKEVEN", turn: 3,
    question: "So where does August stand against break-even right now, and what daily pace do I need for the rest of the month?",
    expect: "August-to-date revenue vs the break-even figure, remaining gap ÷ remaining trading days = required daily pace, compared to recent daily average. All derived.",
    format: "prose",
  },
  // TH-XS-SCENARIO: trading-hours scenario
  {
    id: "H-59", tier: "xhard", scope: "multi", surface: "cross", pattern: "cold",
    thread: "TH-XS-SCENARIO", turn: 1,
    question: "If I closed on Sundays, what would I actually lose in sales versus save in wages? Use the last ten weeks.",
    expect: "Sunday revenue vs Sunday wage cost over 10 weeks, netted, with the demand-displacement caveat. Both sides from evidence.",
    format: "any",
  },
  {
    id: "H-60", tier: "xhard", scope: "multi", surface: "cross", pattern: "followup",
    thread: "TH-XS-SCENARIO", turn: 2,
    question: "Compare that with just opening two hours later on weekdays instead. Which option costs me less profit?",
    expect: "Early-weekday-hours revenue (if hourly data supports it — honesty required) vs wage savings, compared with the Sunday scenario in one verdict. Consistent methodology across scenarios.",
    format: "any",
  },
  {
    id: "H-61", tier: "hard", scope: "multi", surface: "cross", pattern: "followup",
    thread: "TH-XS-SCENARIO", turn: 3,
    question: "Give me your recommendation as a single short paragraph I could read to my business partner, numbers included.",
    expect: "A tight, decisive paragraph: the recommended option, net dollar effect, the key caveat. Tests compression without losing the grounded figures. A long essay fails the format ask.",
    format: "prose",
  },
  // TH-XS-HIRE: hiring decision
  {
    id: "H-62", tier: "xhard", scope: "multi", surface: "cross", pattern: "cold",
    thread: "TH-XS-HIRE", turn: 1,
    question: "I'm considering a second mechanic. What does the workshop's current demand and my wage structure say about affordability?",
    expect: "Workshop revenue trend/capacity signals, current mechanic-adjacent wage cost from real rates, monthly cost of the hire estimated from observed wages, affordability framed against current profit.",
    format: "any",
  },
  {
    id: "H-63", tier: "xhard", scope: "multi", surface: "cross", pattern: "followup",
    thread: "TH-XS-HIRE", turn: 2,
    question: "What extra weekly workshop revenue would the hire need to generate to break even, and how does that compare with what my current workshop does?",
    expect: "Break-even service revenue = hire cost ÷ workshop margin (labour-heavy margin assumption stated), compared as a ratio to current weekly workshop revenue. Derived and explicit.",
    format: "prose",
  },
  {
    id: "H-64", tier: "hard", scope: "multi", surface: "cross", pattern: "followup",
    thread: "TH-XS-HIRE", turn: 3,
    question: "What early-warning number should I watch in the first eight weeks after hiring, and what threshold says it isn't working?",
    expect: "One well-chosen leading metric (e.g. weekly workshop revenue or jobs vs the break-even bar from turn 2) with a concrete numeric threshold derived from the prior turns, and the check cadence.",
    format: "prose",
  },
  // TH-XS-DASH: owner dashboard
  {
    id: "H-65", tier: "xhard", scope: "multi", surface: "cross", pattern: "cold",
    thread: "TH-XS-DASH", turn: 1,
    question: "Design my Monday-morning dashboard: the five numbers I should check weekly, current value and four-week trend for each.",
    expect: "Five well-chosen KPIs each with a current value and 4-week trend from the data, selection rationale. Table fits.",
    format: "chart_or_table",
  },
  {
    id: "H-66", tier: "hard", scope: "multi", surface: "cross", pattern: "chart_reformat",
    thread: "TH-XS-DASH", turn: 2,
    question: "Collapse that into one single table I could screenshot for the wall: metric, this week, four-week average, direction.",
    expect: "Exactly one combined table, four columns as specified, one row per KPI. Format compliance is the test — multiple tables or prose sprawl fail.",
    format: "table",
  },

  // ═══ Goal-seek threads ══════════════════════════════════════════════════
  // TH-GS-SAVE: cost-out under challenge
  {
    id: "H-67", tier: "goal", scope: "multi", surface: "cross", pattern: "cold",
    thread: "TH-GS-SAVE", turn: 1,
    question: "Find me $1,500 a month of savings without cutting Saturday staff.",
    expect: "Named expense/labour levers each quantified monthly from the owner's data, honouring the Saturday constraint explicitly, summing to ≈$1,500/month with recurring-vs-one-off distinguished. Target arithmetic mandatory.",
    format: "chart_or_table",
  },
  {
    id: "H-68", tier: "goal", scope: "multi", surface: "cross", pattern: "followup",
    thread: "TH-GS-SAVE", turn: 2,
    question: "Rent's locked in a lease and I won't touch insurance. Redo it without those.",
    expect: "Re-plans excluding the two named lines while keeping the $1,500 target: remaining named levers re-summed, shortfall admitted if the target is no longer reachable (honesty over forcing). Must not silently keep excluded lines.",
    format: "any",
  },
  {
    id: "H-69", tier: "goal", scope: "multi", surface: "cross", pattern: "followup",
    thread: "TH-GS-SAVE", turn: 3,
    question: "Lock it in: give me the final savings plan as a table — lever, monthly amount, first action — and tell me the realistic total.",
    expect: "One clean plan table (3 columns as asked) from the constrained turn-2 set, realistic total stated against $1,500. Consistency with the prior turns is the test.",
    format: "table",
  },
  // TH-GS-GROW: revenue growth plan
  {
    id: "H-70", tier: "goal", scope: "multi", surface: "cross", pattern: "cold",
    thread: "TH-GS-GROW", turn: 1,
    question: "I want an extra $750 a week of revenue within six weeks. Where does it come from?",
    expect: "The $750/week sized against current weekly baseline (% lift stated), levers grounded in the data (quiet-day headroom, workshop capacity, category momentum, lapsed customers), each with a plausible weekly contribution.",
    format: "any",
  },
  {
    id: "H-71", tier: "goal", scope: "multi", surface: "cross", pattern: "drilldown",
    thread: "TH-GS-GROW", turn: 2,
    question: "Pick the single most credible lever from those and build me a four-week test: what we do, what we measure, and the number that means it worked.",
    expect: "One lever chosen with a defended reason, a concrete 4-week test design with a measurable success threshold derived from baseline data. The testable-opportunity shape.",
    format: "prose",
  },
  {
    id: "H-72", tier: "hard", scope: "multi", surface: "cross", pattern: "followup",
    thread: "TH-GS-GROW", turn: 3,
    question: "What's the weekly baseline I'm comparing against during the test, exactly, and how will we avoid fooling ourselves with seasonality?",
    expect: "A precise baseline definition (e.g. trailing N-week average with the actual figure) plus a seasonality control (same-weeks-last-year comparison with those figures). Both numbers must be real.",
    format: "prose",
  },

  // ═══ Cold singles: xhard / ambiguous / meta stress ═════════════════════
  {
    id: "H-73", tier: "xhard", scope: "multi", surface: "cross", pattern: "cold",
    question: "Give me a candid assessment: what are the three biggest problems in this business right now, backed by numbers?",
    expect: "Three distinct material problems each anchored to queried evidence across sources. Depth and candour; generic advice fails.",
    format: "any",
  },
  {
    id: "H-74", tier: "xhard", scope: "multi", surface: "cross", pattern: "cold",
    question: "If revenue dropped 20% for the next quarter, how many weeks of cash do I have before I'm in trouble?",
    expect: "A runway computation: current cash proxy (bank/net position), recent weekly outflows re-based for 20% lower inflows, weeks-to-zero derived with assumptions explicit. Refusing to estimate fails; so does an ungrounded number.",
    format: "any",
  },
  {
    id: "H-75", tier: "xhard", scope: "multi", surface: "cross", pattern: "cold",
    question: "What does one hour of being open actually cost me, all-in, and what does the average hour bring in?",
    expect: "All-in hourly operating cost (wages + fixed costs ÷ trading hours, assumptions stated) vs average hourly revenue — both derived. The comparison and its use should be crisp.",
    format: "any",
  },
  {
    id: "H-76", tier: "xhard", scope: "lightspeed", surface: "sales", pattern: "cold",
    question: "If I'd raised all prices 4% at the start of this quarter and lost no volume, what would my quarter look like so far — and where is that assumption most likely wrong?",
    expect: "4% applied to actual QTD revenue (derived), margin effect, then grounded fragility analysis (price-sensitive categories, big-ticket items). Prose maths without evidence fails.",
    format: "any",
  },
  {
    id: "H-77", tier: "xhard", scope: "multi", surface: "cross", pattern: "cold",
    question: "It's spring in a few days. Using last spring as the playbook, what exactly should I stock up on, staff up for, and push?",
    expect: "Sep–Nov 2025 actuals: category lift sizes, staffing levels then vs now, workshop demand shape — converted into specific preparation actions with numbers.",
    format: "any",
  },
  {
    id: "H-78", tier: "xhard", scope: "multi", surface: "cross", pattern: "cold",
    question: "Where am I leaving money on the table? Find one concrete opportunity I could test in the next month.",
    expect: "One specific testable opportunity with baseline numbers, intervention, expected outcome and a stop/expand rule, defended against alternatives.",
    format: "any",
  },
  {
    id: "H-79", tier: "xhard", scope: "multi", surface: "cross", pattern: "cold",
    question: "Should I buy a $12,000 wheel-building machine? Assume it saves four mechanic hours a week and wins me two extra wheel builds a month.",
    expect: "A payback computation from the owner's own numbers: 4h/week at observed wage rates + 2 builds/month at observed wheel/service pricing, honest about which inputs come from data vs the owner's assumption, payback period derived and a verdict.",
    format: "any",
  },
  {
    id: "H-80", tier: "xhard", scope: "multi", surface: "staff_labour", pattern: "cold",
    question: "My best staff member wants a $6-an-hour raise. What does saying yes cost me a year, and what revenue lift would cover it?",
    expect: "Identifies their hours pattern (top performer by hours or revenue attribution, assumption stated), $6 × annual hours derived, then covering revenue at observed gross margin. All arithmetic from evidence.",
    format: "any",
  },
  {
    id: "H-81", tier: "xhard", scope: "multi", surface: "cross", pattern: "cold",
    question: "Rank my three sales channels or revenue streams by profit per dollar of wages spent, however you can best support it.",
    expect: "A defensible stream split (retail vs workshop at minimum), profit per wage-dollar derived per stream with allocation assumptions stated honestly. The ranking must follow from computed ratios.",
    format: "table",
  },
  {
    id: "H-82", tier: "xhard", scope: "xero", surface: "pnl", pattern: "cold",
    question: "Build me a one-page year-to-date financial summary I could hand to a bank manager: revenue, gross margin, operating costs, profit, and the trend story.",
    expect: "YTD 2026 totals with monthly trend, professionally framed, every figure from evidence, one summary table plus tight prose. Sprawl fails the one-page ask.",
    format: "chart_or_table",
  },
  {
    id: "H-83", tier: "xhard", scope: "deputy", surface: "staff_labour", pattern: "cold",
    question: "If my two highest-paid people both took the same week off next month, what would covering their shifts cost versus just running short?",
    expect: "Identifies the two highest wage-cost staff and their typical weekly hours/cost, prices cover at observed casual/other rates vs revenue risk of running short (grounded in their days' revenue). Assumptions explicit.",
    format: "any",
  },
  {
    id: "H-84", tier: "xhard", scope: "multi", surface: "cross", pattern: "cold",
    question: "Am I busier but poorer than this time last year? Check both halves properly before you answer.",
    expect: "Both premises tested: activity (transactions/jobs/hours) YoY and profitability (margin $, net) YoY for comparable periods. The verdict must match the evidence, including rejecting the premise if warranted.",
    format: "any",
  },
  {
    id: "H-85", tier: "ambiguous", scope: "multi", surface: "cross", pattern: "cold",
    question: "Something feels off with the numbers this month. Can you check?",
    expect: "A disciplined anomaly sweep with a stated definition of 'off': August-to-date vs typical (revenue pace, margin, wages, refunds/discounts, big expense items), reporting either concrete anomalies with figures or a clean bill with the checks listed. Vague reassurance fails.",
    format: "any",
  },
  {
    id: "H-86", tier: "ambiguous", scope: "multi", surface: "cross", pattern: "cold",
    question: "Are we wasting money?",
    expect: "Interprets sensibly (expense outliers, discount leakage, labour on quiet days, slow stock), quantifies the top candidates from evidence, states the period assumption. A sharp short list with dollars beats an essay.",
    format: "any",
  },
  {
    id: "H-87", tier: "ambiguous", scope: "multi", surface: "cross", pattern: "cold",
    question: "Is the business actually healthier than it was a year ago?",
    expect: "A multi-dimension YoY health check (revenue, margin, labour efficiency, cash/AR) with a defensible overall verdict. Single-metric answers fail.",
    format: "any",
  },
  {
    id: "H-88", tier: "ambiguous", scope: "multi", surface: "workshop", pattern: "cold",
    question: "The workshop guys reckon they're carrying the shop. Are they right?",
    expect: "A fair test of the claim: workshop vs retail revenue, margin quality, labour absorbed; verdict engages the claim honestly with attribution caveats. Flattery or dismissal without numbers fails.",
    format: "any",
  },
  {
    id: "H-89", tier: "ambiguous", scope: "xero", surface: "pnl", pattern: "cold",
    question: "My accountant says costs look high. Where would you push back or agree?",
    expect: "Expense structure vs revenue with trend, the standout lines named with figures, and a balanced agree/push-back position grounded in benchmarkable ratios (stated as general guidance).",
    format: "any",
  },
  {
    id: "H-90", tier: "meta", scope: "meta", surface: "meta", pattern: "cold",
    question: "Do my register, my accounting file, and my roster system agree with each other about July? Reconcile them and flag anything that doesn't line up.",
    expect: "Cross-source July reconciliation: POS revenue vs Xero income (with the principled gap explanation), Deputy hours/wages vs P&L wages, each pair compared with numbers and honest tolerance. Fabricated agreement fails.",
    format: "any",
  },
  {
    id: "H-91", tier: "meta", scope: "meta", surface: "meta", pattern: "cold",
    question: "How fresh is each of my data sources right now, and what's the most recent transaction you can see in each?",
    expect: "Queried latest-record timestamps per source (Lightspeed sale, Xero transaction/invoice, Deputy timesheet) — actual queried values, not guessed sync times.",
    format: "any",
  },
  {
    id: "H-92", tier: "meta", scope: "meta", surface: "meta", pattern: "cold",
    question: "If I could only keep two of my three data connections, which two keep most of your usefulness to me, and what exactly would I lose?",
    expect: "A reasoned ranking of Lightspeed/Xero/Deputy for this shop with concrete named analyses that die per dropped source (referencing real capabilities used for this tenant). Specificity over generic AI talk.",
    format: "prose",
  },
  {
    id: "H-93", tier: "meta", scope: "meta", surface: "meta", pattern: "cold",
    question: "What questions have I not been asking that my own data says I should be?",
    expect: "3–5 specific overlooked analyses, each motivated by an actual observed pattern in this tenant's data (queried, cited), not a generic checklist.",
    format: "any",
  },
  {
    id: "H-94", tier: "theory", scope: "multi", surface: "suppliers_inventory", pattern: "cold",
    question: "Teach me inventory turns for a shop like mine, then compute or approximate mine and judge it.",
    expect: "Framework (turns = COGS ÷ avg inventory, seasonal/category nuance), a sensible target range attributed as general guidance, and an honest computed approximation from available data or a plain statement of the missing piece.",
    format: "any",
  },
  {
    id: "H-95", tier: "theory", scope: "multi", surface: "cross", pattern: "cold",
    question: "Apply the 'profit levers' framing to my shop: price, volume, mix, costs. Which lever has the most headroom for me right now, using my numbers?",
    expect: "Each lever assessed with the shop's own current figures (margin %, volume trend, mix shift, cost base), then one lever chosen with a quantified headroom argument.",
    format: "any",
  },
  {
    id: "H-96", tier: "theory", scope: "multi", surface: "cash_ar_ap", pattern: "cold",
    question: "Explain working capital in terms of my actual business, and tell me where mine is tied up right now.",
    expect: "Working-capital concepts mapped to this shop (stock, AR, AP) with current actuals for each component where visible and honest gaps where not. The 'where it's tied up' must be quantified.",
    format: "any",
  },
  {
    id: "H-97", tier: "hard", scope: "lightspeed", surface: "sales", pattern: "cold",
    question: "Which weekday has quietly become more important to my revenue this year, and by how much?",
    expect: "Day-of-week revenue share early-2026 vs recent months (or vs 2025), the mover named with the share/dollar delta derived. 'Quietly' implies a shift, not just the biggest day.",
    format: "any",
  },
  {
    id: "H-98", tier: "hard", scope: "deputy", surface: "staff_labour", pattern: "cold",
    question: "What's my true average hourly cost of labour, including everyone, and how has it moved over the last six months?",
    expect: "Total wage cost ÷ total hours per month for ~6 months (blended rate), trend named, spikes explained if visible (mix of staff, loadings). Derived from timesheet data.",
    format: "chart_or_table",
  },
  {
    id: "H-99", tier: "hard", scope: "xero", surface: "cash_ar_ap", pattern: "cold",
    question: "How long do my customers take to pay their invoices on average, and is it getting better or worse?",
    expect: "Invoice issue→payment lag from Xero (average days, ideally by month or quarter for trend), scope stated (invoiced sales only, register sales are instant). Honest if payment-date granularity is limited.",
    format: "any",
  },
  {
    id: "H-100", tier: "xhard", scope: "multi", surface: "cross", pattern: "cold",
    question: "You've got one shot: tell me the single most valuable thing in my data I probably don't know, and prove it.",
    expect: "One surprising, material, specific insight discovered from genuine investigation, with the evidence trail shown. Judged on surprise × materiality × grounding. A restated commonplace fails.",
    format: "any",
  },
];

if (CODEX_HARD100_QUESTIONS.length !== 100) {
  throw new Error(`Hard-100 corpus must contain 100 turns, found ${CODEX_HARD100_QUESTIONS.length}.`);
}
if (new Set(CODEX_HARD100_QUESTIONS.map((question) => question.id)).size !== 100) {
  throw new Error("Hard-100 corpus contains duplicate question ids.");
}
