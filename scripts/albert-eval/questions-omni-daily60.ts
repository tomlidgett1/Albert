import type { EvalQuestion } from "./questions.js";

/**
 * Omni-harness daily-driver battery: the 20 most commonly asked questions per
 * connected system (Lightspeed, Xero, Deputy), written the way an owner types
 * them. Mostly quick/standard-tier asks — the bar is crisp direct answers,
 * clean tables, honest partial-period handling, and statement-grade formatting
 * for the accounting reports.
 */

const ls = (id: string, question: string, expect: string, surface: EvalQuestion["surface"] = "sales", tier: EvalQuestion["tier"] = "easy"): EvalQuestion => ({
  id, tier, scope: "lightspeed", surface, pattern: "cold", question, expect,
});
const xo = (id: string, question: string, expect: string, surface: EvalQuestion["surface"] = "pnl", tier: EvalQuestion["tier"] = "easy"): EvalQuestion => ({
  id, tier, scope: "xero", surface, pattern: "cold", question, expect,
});
const dp = (id: string, question: string, expect: string, tier: EvalQuestion["tier"] = "easy"): EvalQuestion => ({
  id, tier, scope: "deputy", surface: "staff_labour", pattern: "cold", question, expect,
});

export const OMNI_DAILY60_QUESTIONS: readonly EvalQuestion[] = [
  // --- Lightspeed: the everyday POS questions ----------------------------
  ls("DL-LS-01", "How did we do today?", "Partial-day takings stated as such, with a fair same-span anchor."),
  ls("DL-LS-02", "How were sales yesterday?", "Yesterday's takings with transactions and an anchor."),
  ls("DL-LS-03", "How's this week going compared to last week?", "Partial-week vs same span of last week, stated honestly."),
  ls("DL-LS-04", "What are my sales this month so far?", "Month-to-date takings, framed as partial, with prior-month same-span anchor."),
  ls("DL-LS-05", "What were my top 10 products this month?", "Ranked product table with revenue and units.", "products"),
  ls("DL-LS-06", "What's my best selling category this year?", "Category ranking with the winner named first.", "products"),
  ls("DL-LS-07", "How many bikes have we sold this month?", "Bike-category unit count with revenue.", "products"),
  ls("DL-LS-08", "What's my gross margin been this month?", "Month-to-date margin with prior anchor and definition scope."),
  ls("DL-LS-09", "Any refunds this week? What were they for?", "Refund count/value and what was refunded, or a clean zero."),
  ls("DL-LS-10", "How much discounting have we done this month?", "Discount dollars and share of takings, with anchor."),
  ls("DL-LS-11", "What's my stock worth right now?", "Stock value at cost with units and the as-at date.", "suppliers_inventory"),
  ls("DL-LS-12", "What do I need to reorder?", "Reorder-point list or a clean statement that little needs ordering.", "suppliers_inventory"),
  ls("DL-LS-13", "What's my oldest stock? What should I clear?", "Aged stock by value with concrete clearance candidates.", "suppliers_inventory", "medium"),
  ls("DL-LS-14", "Who are my top customers this year?", "Customer ranking by spend, privacy-safe.", "sales", "medium"),
  ls("DL-LS-15", "How many new customers did we get this month?", "New-customer count with prior-month anchor."),
  ls("DL-LS-16", "What's the workshop backlog looking like?", "Open/overdue job counts with the oldest or most urgent flagged.", "workshop"),
  ls("DL-LS-17", "How much workshop revenue did we do this month?", "Workshop takings month-to-date with anchor.", "workshop"),
  ls("DL-LS-18", "What was our average sale this week?", "Average sale value with transaction count and anchor."),
  ls("DL-LS-19", "What's our busiest day of the week?", "Weekday pattern from recent weeks with the peak named.", "sales", "medium"),
  ls("DL-LS-20", "How are online sales going?", "eCom tender/channel trend or an honest scope note.", "sales", "medium"),
  // --- Xero: the everyday accounting questions ---------------------------
  xo("DL-XO-01", "Show me my P&L for last month.", "A statement-formatted P&L in accounting order with bolded totals and basis note."),
  xo("DL-XO-02", "Show me my P&L for this month vs last month.", "Two-period statement with change column; this month marked partial.", "pnl", "medium"),
  xo("DL-XO-03", "Show me my balance sheet.", "Statement-formatted balance sheet: assets, liabilities, equity with section totals.", "pnl", "medium"),
  xo("DL-XO-04", "How much money do I have in the bank?", "Latest bank total with per-account breakdown and as-at date.", "cash_ar_ap"),
  xo("DL-XO-05", "Who owes me money?", "Receivables list with amounts and overdue flags.", "cash_ar_ap"),
  xo("DL-XO-06", "Who do I owe money to?", "Payables list including drafts caveat.", "cash_ar_ap"),
  xo("DL-XO-07", "What bills are coming due soon?", "Due-soon bills with dates and amounts.", "cash_ar_ap"),
  xo("DL-XO-08", "What did I spend on wages last month?", "Wages + super for last complete month with anchor."),
  xo("DL-XO-09", "What are my biggest expenses this year?", "Expense account ranking for the year.", "pnl", "medium"),
  xo("DL-XO-10", "How much GST do I owe at the moment?", "GST position with honest scope about what the data can show.", "cash_ar_ap", "medium"),
  xo("DL-XO-11", "How's my profit looking this financial year?", "FY-to-date profit with margin and prior-FY anchor.", "pnl", "medium"),
  xo("DL-XO-12", "How's revenue this year compared to last year?", "Year-vs-year revenue comparison, matched spans.", "pnl", "medium"),
  xo("DL-XO-13", "How much have I spent with Pon Bike this year?", "Named-supplier spend via exact value match, with trend.", "pnl", "medium"),
  xo("DL-XO-14", "What are my bank balances across accounts?", "Per-account balances with as-at date.", "cash_ar_ap"),
  xo("DL-XO-15", "What subscriptions and recurring costs am I paying?", "Recurring cost lines identified from the accounts.", "pnl", "medium"),
  xo("DL-XO-16", "How much rent have I paid this year?", "Rent total for the year with monthly rate."),
  xo("DL-XO-17", "What are wages as a share of revenue this year?", "The ratio computed and anchored.", "pnl", "medium"),
  xo("DL-XO-18", "Are there any overdue invoices I should chase?", "Overdue receivables with days overdue, or a clean zero.", "cash_ar_ap"),
  xo("DL-XO-19", "How did last quarter go profit-wise?", "Quarter P&L summary with prior-quarter anchor.", "pnl", "medium"),
  xo("DL-XO-20", "How much super have I paid this year?", "Superannuation paid/accrued for the year."),
  // --- Deputy: the everyday workforce questions --------------------------
  dp("DL-DP-01", "Who's working today?", "Today's roster with names and shift times."),
  dp("DL-DP-02", "Who's rostered on this week?", "This week's roster by day."),
  dp("DL-DP-03", "How many hours did everyone work last week?", "Per-person hours table for last complete week."),
  dp("DL-DP-04", "What's my wage cost this week so far?", "Partial-week wage cost stated as such, with anchor."),
  dp("DL-DP-05", "How did rostered hours compare to actual hours last week?", "Rostered vs worked with the gap explained.", "medium"),
  dp("DL-DP-06", "Are there any timesheets waiting for approval?", "Unapproved timesheet count with names/dates, or clean zero."),
  dp("DL-DP-07", "Who worked the longest shifts last month?", "Longest-shift ranking with dates.", "medium"),
  dp("DL-DP-08", "What's our average shift length?", "Average shift length with recent trend."),
  dp("DL-DP-09", "How many hours has Jack worked this month?", "Named-person hours via exact value match, framed month-to-date."),
  dp("DL-DP-10", "What did weekend staffing cost last month?", "Weekend hours and wage cost for last complete month.", "medium"),
  dp("DL-DP-11", "Is anyone on leave soon?", "Upcoming approved leave with dates, or clean zero."),
  dp("DL-DP-12", "Are there any open shifts that need filling this week?", "Open/unassigned shifts this week, or clean zero."),
  dp("DL-DP-13", "What have my labour costs been month by month this year?", "Monthly wage cost table for the year.", "medium"),
  dp("DL-DP-14", "Which days of the week use the most staff hours?", "Hours by weekday with the peak named.", "medium"),
  dp("DL-DP-15", "Is anyone clocked in right now?", "Current clocked-in staff, or an honest freshness-bounded answer."),
  dp("DL-DP-16", "How much leave has been taken this year?", "Leave hours/days taken with type split if available.", "medium"),
  dp("DL-DP-17", "What's the wage cost per day this week?", "Per-day wage cost for the current week, partial noted."),
  dp("DL-DP-18", "Did anyone not show up for a rostered shift last week?", "Rostered-but-not-worked gaps with the honest caveat on clock-in data.", "medium"),
  dp("DL-DP-19", "How many staff do I have on the books at the moment?", "Active staff count, archived noted."),
  dp("DL-DP-20", "What will next week's roster cost me?", "Rostered hours and cost for next week, framed as planned."),
];
