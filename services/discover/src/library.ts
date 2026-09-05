/**
 * Discover (ADR 0130): a library of questions worth asking, keyed to the
 * tools a business has connected.
 *
 * The library is the floor. It paints the Discover grid immediately and it is
 * what the model personalises against. Every entry names the capabilities it
 * needs (a point of sale, accounting, labour…) rather than a specific tool,
 * so one entry covers Lightspeed, Square and Shopify alike and shows the
 * logos of whichever of those the tenant actually has. Cards whose
 * capabilities are not connected never appear: Discover shows what is
 * possible with the data Albert holds, not a wish list.
 *
 * Nothing here is a governed number. Titles are imperative and short, the
 * "why" explains what the answer changes, and the prompt is the question the
 * owner would type in their own voice.
 */
import { normalizeV3Connector } from "../../../packages/albert-v3/src/engine/connector-routing.js";
import type { TraceConnector } from "../../../packages/shared/src/index.js";

/** Bump when the library copy changes so tenant caches regenerate. */
export const DISCOVER_LIBRARY_VERSION = "2026-09-01.1";
/** How many cards the grid shows. */
export const DISCOVER_CARD_TARGET = 30;
/** Fewer cards than this and the surface no longer reads as a library. */
export const DISCOVER_CARD_MINIMUM = 12;

export const DISCOVER_DOMAINS = [
  "sales",
  "profit",
  "customers",
  "products",
  "inventory",
  "cash",
  "staff",
  "workshop",
  "payments",
  "memberships",
  "online",
] as const;
export type DiscoverDomain = (typeof DISCOVER_DOMAINS)[number];

export const DISCOVER_DOMAIN_LABELS: Readonly<Record<DiscoverDomain, string>> = Object.freeze({
  sales: "Sales",
  profit: "Profit & margin",
  customers: "Customers",
  products: "Products",
  inventory: "Stock",
  cash: "Cash & accounts",
  staff: "Staff & labour",
  workshop: "Workshop",
  payments: "Payments & fees",
  memberships: "Memberships & classes",
  online: "Online store",
});

/** Public trace identifiers (not control-plane connector keys) the cards name. */
export const DISCOVER_CONNECTORS = [
  "lightspeed",
  "lightspeed-x",
  "xero",
  "deputy",
  "square",
  "shopify",
  "stripe",
  "momence",
  "meta-ads",
  "google-ads",
] as const satisfies readonly TraceConnector[];
export type DiscoverConnector = (typeof DISCOVER_CONNECTORS)[number];

export type DiscoverCard = Readonly<{
  id: string;
  /** Four to eight words, imperative: "Explore gross profit across segments". */
  title: string;
  /** One sentence on what the answer changes for the owner. */
  why: string;
  /** The question sent to chat, in the owner's voice. */
  prompt: string;
  domain: DiscoverDomain;
  /** Tools the analysis will most likely draw on, most important first. */
  tools: readonly DiscoverConnector[];
}>;

/**
 * What a card needs from the connected tools. Capabilities are resolved to
 * the tenant's connectors at selection time.
 */
export type DiscoverCapability =
  | "pos"
  | "instore"
  | "inventory"
  | "purchasing"
  | "workshop"
  | "till"
  | "labour"
  | "payroll"
  | "accounting"
  | "payments"
  | "disputes"
  | "storedValue"
  | "online"
  | "studio"
  | "subscriptions";

/** Connectors that satisfy each capability, in order of preference. */
export const DISCOVER_CAPABILITY_CONNECTORS: Readonly<Record<DiscoverCapability, readonly DiscoverConnector[]>> = Object.freeze({
  pos: ["lightspeed", "lightspeed-x", "square", "shopify"],
  instore: ["lightspeed", "lightspeed-x", "square"],
  inventory: ["lightspeed", "lightspeed-x", "square", "shopify"],
  purchasing: ["lightspeed", "lightspeed-x"],
  workshop: ["lightspeed", "lightspeed-x"],
  till: ["lightspeed", "square"],
  labour: ["deputy", "square"],
  payroll: ["deputy", "xero", "square"],
  accounting: ["xero"],
  payments: ["lightspeed", "lightspeed-x", "square", "shopify", "stripe"],
  disputes: ["square", "stripe"],
  storedValue: ["square", "lightspeed-x"],
  online: ["shopify"],
  studio: ["momence"],
  subscriptions: ["stripe"],
});

export type DiscoverLibraryEntry = Readonly<{
  id: string;
  domain: DiscoverDomain;
  title: string;
  why: string;
  prompt: string;
  /** Every capability must be connected for the card to appear. */
  needs: readonly DiscoverCapability[];
  /** 3 = universally valuable, 1 = niche. Drives ordering, never inclusion. */
  weight: 1 | 2 | 3;
}>;

const entry = (value: DiscoverLibraryEntry): DiscoverLibraryEntry => Object.freeze({
  ...value,
  needs: Object.freeze([...value.needs]),
});

export const DISCOVER_LIBRARY: readonly DiscoverLibraryEntry[] = Object.freeze([
  // ---- Sales ---------------------------------------------------------------
  entry({
    id: "sales-momentum-weekly",
    domain: "sales",
    title: "Explore sales momentum by week",
    why: "A 12-week view separates a real trend from a noisy fortnight, so you react to direction rather than one bad week.",
    prompt: "Show my sales by week for the last 12 complete weeks and tell me whether the trend is improving, flat or fading.",
    needs: ["pos"],
    weight: 3,
  }),
  entry({
    id: "sales-year-on-year",
    domain: "sales",
    title: "Compare this month with last year",
    why: "Seasonality hides inside month-on-month numbers. Year-on-year is the honest comparison for a seasonal business.",
    prompt: "Compare this month's sales so far with the same weekday-aligned period last year, week by week.",
    needs: ["pos"],
    weight: 3,
  }),
  entry({
    id: "sales-busiest-hours",
    domain: "sales",
    title: "Find your busiest hours and days",
    why: "Trading patterns decide rostering, opening hours and when a promotion actually lands.",
    prompt: "Which days of the week and hours of the day bring in the most sales over the last 8 weeks, and how does that compare with the 8 weeks before?",
    needs: ["pos"],
    weight: 2,
  }),
  entry({
    id: "sales-store-ranking",
    domain: "sales",
    title: "Rank your stores against each other",
    why: "Store-level comparison shows whether a dip is company-wide or one location's problem.",
    prompt: "Rank my stores by sales, transactions and average sale for the last 30 days against the previous 30 days.",
    needs: ["instore"],
    weight: 1,
  }),
  entry({
    id: "sales-average-basket",
    domain: "sales",
    title: "Measure average sale and basket size",
    why: "Growing the average sale is usually cheaper than finding new customers.",
    prompt: "What is my average sale value and items per sale over the last 90 days, and how has each moved month by month?",
    needs: ["pos"],
    weight: 2,
  }),
  entry({
    id: "sales-discount-cost",
    domain: "sales",
    title: "Quantify what discounting costs",
    why: "Discounting quietly erodes margin. Knowing its cost turns each promotion into a decision rather than a habit.",
    prompt: "How much did discounts cost me in the last 90 days, which products and staff discount the most, and did discounted sales bring larger baskets?",
    needs: ["pos"],
    weight: 2,
  }),
  entry({
    id: "sales-refunds-voids",
    domain: "sales",
    title: "Track refunds and voids",
    why: "Refund and void rates point at product, process or training problems long before they reach the profit line.",
    prompt: "What were my refund and void rates over the last 90 days by month, and which products or staff account for most of them?",
    needs: ["pos"],
    weight: 2,
  }),
  entry({
    id: "sales-quotes-conversion",
    domain: "sales",
    title: "See how quotes convert to sales",
    why: "Unconverted quotes are demand you already found and then lost.",
    prompt: "How many quotes did we raise in the last 90 days, how many converted into sales, and what value is still open?",
    needs: ["workshop"],
    weight: 1,
  }),
  entry({
    id: "sales-weekly-scorecard",
    domain: "sales",
    title: "Build a weekly scorecard",
    why: "One table with sales, margin, refunds and labour side by side is how owners actually run the week.",
    prompt: "Build me a weekly scorecard for the last 8 weeks with sales, gross margin, refunds and transactions as rows and the weeks across the top.",
    needs: ["pos"],
    weight: 3,
  }),
  entry({
    id: "sales-anatomy-of-a-quiet-week",
    domain: "sales",
    title: "Explain your quietest recent week",
    why: "Understanding a bad week's anatomy is how you tell luck from a problem.",
    prompt: "Take my weakest sales week in the last 12 weeks and explain it: which days, categories, stores and staff moved, and whether traffic or basket size drove it.",
    needs: ["pos"],
    weight: 2,
  }),

  // ---- Profit & margin -----------------------------------------------------
  entry({
    id: "profit-gross-profit-segments",
    domain: "profit",
    title: "Explore gross profit across segments",
    why: "Revenue tells you what sold. Gross profit tells you what was worth selling, and segment margins decide where to lean in.",
    prompt: "Break down gross profit and margin by category and store for the last 90 days, and show which segments are dragging margin.",
    needs: ["pos"],
    weight: 3,
  }),
  entry({
    id: "profit-low-margin-lines",
    domain: "profit",
    title: "Find products sold below target margin",
    why: "A handful of low-margin lines often absorbs the profit the rest of the range makes.",
    prompt: "Which products sold with the lowest gross margin over the last 90 days, weighted by units sold, and how much would lifting them to my category average add?",
    needs: ["pos"],
    weight: 2,
  }),
  entry({
    id: "profit-pnl-trend",
    domain: "profit",
    title: "Read your Profit and Loss trend",
    why: "Xero's own P&L is the authoritative view of whether the business makes money after wages and overheads.",
    prompt: "Show my monthly Profit and Loss for the last 12 months: income, cost of sales, gross profit, expenses and net profit, and highlight the months that moved most.",
    needs: ["accounting"],
    weight: 3,
  }),
  entry({
    id: "profit-expense-creep",
    domain: "profit",
    title: "Watch expense lines creeping up",
    why: "Overheads rise in small steps that never feel worth a conversation, until they are.",
    prompt: "Which expense accounts grew the most over the last 6 months compared with the 6 months before, in dollars and as a share of income?",
    needs: ["accounting"],
    weight: 2,
  }),
  entry({
    id: "profit-pos-vs-books",
    domain: "profit",
    title: "Reconcile till margin with the books",
    why: "Your till and your accountant rarely agree on margin. The gap is stock errors, timing or costing.",
    prompt: "Compare gross profit from my point of sale with gross profit in Xero for the last 3 complete months and explain the gap.",
    needs: ["pos", "accounting"],
    weight: 2,
  }),
  entry({
    id: "profit-wages-share-of-sales",
    domain: "profit",
    title: "Check wages as a share of sales",
    why: "Labour is usually the biggest controllable cost. Wages as a percentage of sales is the number good operators watch weekly.",
    prompt: "What were wages as a percentage of sales each week for the last 12 weeks, and which weeks or stores ran hot?",
    needs: ["pos", "payroll"],
    weight: 3,
  }),

  // ---- Customers -----------------------------------------------------------
  entry({
    id: "customers-lapsed-regulars",
    domain: "customers",
    title: "Find customers who have gone quiet",
    why: "A lapsed regular is the cheapest customer to win back and the easiest to miss.",
    prompt: "Which customers spent the most with us over the last 2 years but have not purchased in more than 180 days, and what did they used to buy?",
    needs: ["pos"],
    weight: 3,
  }),
  entry({
    id: "customers-new-vs-returning",
    domain: "customers",
    title: "Measure new versus returning customers",
    why: "Growth from new faces and growth from loyalty need different plays.",
    prompt: "How many of my sales in the last 90 days came from new customers versus returning ones, and how has that mix shifted month by month?",
    needs: ["pos"],
    weight: 2,
  }),
  entry({
    id: "customers-lifetime-value",
    domain: "customers",
    title: "Rank customers by lifetime value",
    why: "Your top 20 customers often carry a surprising share of revenue. Know who they are.",
    prompt: "Who are my top 25 customers by lifetime net spend, how often do they buy, and when did each last purchase?",
    needs: ["pos"],
    weight: 2,
  }),
  entry({
    id: "customers-repeat-rate",
    domain: "customers",
    title: "Check your repeat-purchase rate",
    why: "Repeat rate is the truest measure of whether people liked the experience enough to come back.",
    prompt: "What share of first-time customers came back within 90 days, and how has that rate changed over the last year?",
    needs: ["pos"],
    weight: 2,
  }),
  entry({
    id: "customers-geography",
    domain: "customers",
    title: "See where your customers live",
    why: "Geography shapes marketing spend, delivery zones and where a second location could work.",
    prompt: "Where do my customers come from by suburb or postcode, and which areas bring the highest spend per customer?",
    needs: ["pos"],
    weight: 1,
  }),
  entry({
    id: "customers-loyalty-members",
    domain: "customers",
    title: "Spot loyalty members worth rewarding",
    why: "Loyalty balances are a live view of who is engaged and who is drifting.",
    prompt: "How many loyalty members are active, how many points are outstanding, and which members earned the most in the last 90 days?",
    needs: ["storedValue"],
    weight: 1,
  }),
  entry({
    id: "customers-account-invoices",
    domain: "customers",
    title: "Know your biggest account customers",
    why: "For account customers, invoices tell you who you really depend on and who pays slowly.",
    prompt: "Which customers were invoiced the most in Xero over the last 12 months, and how quickly does each of them pay?",
    needs: ["accounting"],
    weight: 1,
  }),

  // ---- Products ------------------------------------------------------------
  entry({
    id: "products-profit-ranking",
    domain: "products",
    title: "Rank products by profit, not sales",
    why: "Best sellers and best earners are rarely the same list.",
    prompt: "Rank my top 30 products by gross profit over the last 90 days alongside units sold, revenue and margin percentage.",
    needs: ["pos"],
    weight: 3,
  }),
  entry({
    id: "products-brand-concentration",
    domain: "products",
    title: "See which brands carry the range",
    why: "Supplier concentration is both leverage and risk.",
    prompt: "Which brands or suppliers drove the most sales and margin over the last 12 months, and how concentrated is that?",
    needs: ["pos"],
    weight: 2,
  }),
  entry({
    id: "products-seasonality",
    domain: "products",
    title: "Map seasonal patterns by category",
    why: "Knowing when each category peaks decides when to buy stock and when to promote.",
    prompt: "Show monthly sales by category over the last 24 months and identify each category's peak and trough season.",
    needs: ["pos"],
    weight: 2,
  }),
  entry({
    id: "products-fading-lines",
    domain: "products",
    title: "Identify products that are fading",
    why: "A fading line ties up cash and shelf space a rising one could use.",
    prompt: "Which products fell the most in units sold over the last 90 days compared with the 90 days before, and are we still holding stock in them?",
    needs: ["pos", "inventory"],
    weight: 2,
  }),
  entry({
    id: "products-online-vs-instore",
    domain: "products",
    title: "Compare online and in-store mix",
    why: "What sells online and what sells in-store are two businesses wearing the same brand.",
    prompt: "Compare my top products online and in-store for the last 90 days and show which lines sell in only one channel.",
    needs: ["online", "instore"],
    weight: 2,
  }),

  // ---- Stock ---------------------------------------------------------------
  entry({
    id: "inventory-dead-stock",
    domain: "inventory",
    title: "Find dead stock tying up cash",
    why: "Stock that has not moved in months is cash sitting on a shelf.",
    prompt: "Which items have stock on hand but no sales in the last 180 days, what is that stock worth at cost, and which categories hold most of it?",
    needs: ["inventory"],
    weight: 3,
  }),
  entry({
    id: "inventory-about-to-run-out",
    domain: "inventory",
    title: "Check what is about to run out",
    why: "Stockouts on your best sellers cost more than dead stock ever does.",
    prompt: "Which of my top 50 selling products are below their reorder point or have under two weeks of cover based on the last 8 weeks of sales?",
    needs: ["inventory"],
    weight: 3,
  }),
  entry({
    id: "inventory-ageing",
    domain: "inventory",
    title: "Age your inventory",
    why: "An ageing profile shows how healthy your buying has been.",
    prompt: "Show my stock on hand and value by age band, and which categories and suppliers hold the oldest stock.",
    needs: ["inventory"],
    weight: 2,
  }),
  entry({
    id: "inventory-stock-turn",
    domain: "inventory",
    title: "Measure stock turn by category",
    why: "Stock turn tells you whether buying keeps pace with selling.",
    prompt: "What is my stock turn by category over the last 12 months, and which categories are overbought relative to their sales?",
    needs: ["inventory"],
    weight: 2,
  }),
  entry({
    id: "inventory-supplier-lead-times",
    domain: "inventory",
    title: "Review supplier lead times",
    why: "Late suppliers cause the stockouts you get blamed for.",
    prompt: "Which purchase orders are open, how long do each supplier's deliveries take on average, and which suppliers are slipping?",
    needs: ["purchasing"],
    weight: 1,
  }),
  entry({
    id: "inventory-stocktake-variance",
    domain: "inventory",
    title: "Locate shrinkage in stocktakes",
    why: "Shrinkage hides in count variances. Persistent misses in one category point at process or theft.",
    prompt: "What were my stocktake variances over the last 12 months by category and store, and where is shrinkage concentrated?",
    needs: ["inventory"],
    weight: 1,
  }),
  entry({
    id: "inventory-online-out-of-stock",
    domain: "inventory",
    title: "Find online listings out of stock",
    why: "An out-of-stock listing is a customer you paid to acquire walking away.",
    prompt: "Which online products are out of stock or below safety stock right now, and how much did those products sell in the last 60 days?",
    needs: ["online"],
    weight: 2,
  }),

  // ---- Cash & accounts -----------------------------------------------------
  entry({
    id: "cash-receivables",
    domain: "cash",
    title: "See who owes you money",
    why: "Receivables are sales you have not been paid for yet.",
    prompt: "Who owes me money right now, how overdue is each invoice, and how has total receivables moved over the last 6 months?",
    needs: ["accounting"],
    weight: 3,
  }),
  entry({
    id: "cash-bills-due",
    domain: "cash",
    title: "Plan the bills coming due",
    why: "Knowing what falls due this month avoids the overdraft surprise.",
    prompt: "Which supplier bills are due in the next 30 days, what is already overdue, and which suppliers do we owe the most?",
    needs: ["accounting"],
    weight: 2,
  }),
  entry({
    id: "cash-bank-balance-trend",
    domain: "cash",
    title: "Watch your bank balance trend",
    why: "Cash in the bank, tracked monthly, is the simplest health check there is.",
    prompt: "Show my bank account balances at each month end for the last 12 months and the months where cash moved the most.",
    needs: ["accounting"],
    weight: 2,
  }),
  entry({
    id: "cash-takings-to-bank",
    domain: "cash",
    title: "Check takings reached the bank",
    why: "Sales on the till and money in the bank should agree. When they do not, something is leaking.",
    prompt: "Compare my point-of-sale takings with bank deposits in Xero for the last 4 complete weeks and flag any gaps.",
    needs: ["pos", "accounting"],
    weight: 3,
  }),
  entry({
    id: "cash-till-variance",
    domain: "cash",
    title: "Audit till over and short",
    why: "Small daily variances add up, and patterns by register or shift point at the cause.",
    prompt: "What were my cash over and short amounts by register and day for the last 90 days, and which shifts vary the most?",
    needs: ["till"],
    weight: 1,
  }),
  entry({
    id: "cash-balance-sheet",
    domain: "cash",
    title: "Understand your balance sheet",
    why: "Assets, liabilities and equity at month end show whether the business is building strength.",
    prompt: "Summarise my balance sheet at the last month end against 12 months earlier: cash, receivables, stock, payables and equity.",
    needs: ["accounting"],
    weight: 1,
  }),
  entry({
    id: "cash-supplier-spend",
    domain: "cash",
    title: "See what you spend with each supplier",
    why: "Supplier spend concentration is your negotiating position.",
    prompt: "Which suppliers did I pay the most over the last 12 months according to Xero bills, and how has that changed year on year?",
    needs: ["accounting"],
    weight: 2,
  }),

  // ---- Staff & labour ------------------------------------------------------
  entry({
    id: "staff-sales-per-labour-hour",
    domain: "staff",
    title: "Measure sales per labour hour",
    why: "Sales per rostered hour is the cleanest productivity measure in retail and hospitality.",
    prompt: "What were sales per labour hour by store and day of week for the last 8 weeks, and where are we over or under staffed?",
    needs: ["pos", "labour"],
    weight: 3,
  }),
  entry({
    id: "staff-roster-vs-actual",
    domain: "staff",
    title: "Compare rostered hours with hours worked",
    why: "The gap between the plan and reality is overtime, no-shows and unplanned cost.",
    prompt: "Compare rostered hours and wage cost with actual timesheet hours and cost by week for the last 8 weeks, and show the biggest gaps.",
    needs: ["labour"],
    weight: 2,
  }),
  entry({
    id: "staff-labour-cost-trend",
    domain: "staff",
    title: "Follow your labour cost trend",
    why: "Wage cost by week is the fastest way to see whether rosters follow the business.",
    prompt: "Show hours worked and wage cost by week for the last 12 weeks by work area, and the weeks that ran furthest over the average.",
    needs: ["labour"],
    weight: 3,
  }),
  entry({
    id: "staff-top-sellers",
    domain: "staff",
    title: "See who sells the most",
    why: "Individual performance decides coaching, rostering and incentives.",
    prompt: "Rank staff by sales, transactions and average sale over the last 90 days, and show how each compares with the team average.",
    needs: ["pos"],
    weight: 2,
  }),
  entry({
    id: "staff-leave-patterns",
    domain: "staff",
    title: "Review leave patterns",
    why: "Leave clusters and sick-leave spikes show up in service and cost.",
    prompt: "How much leave was taken by type and month over the last 12 months, who has leave coming up, and how many sick days were taken this year?",
    needs: ["labour"],
    weight: 1,
  }),
  entry({
    id: "staff-payroll-vs-pnl",
    domain: "staff",
    title: "Check payroll against the P&L",
    why: "What payroll actually paid and what the P&L shows should agree. Super and PAYG timing often make them differ.",
    prompt: "Show gross wages, super and PAYG from payroll by month for the last 6 months, and compare wages with the wages line in my Profit and Loss.",
    needs: ["accounting"],
    weight: 1,
  }),
  entry({
    id: "staff-roster-to-busy-hours",
    domain: "staff",
    title: "Match staffing to your busiest hours",
    why: "Most rosters are built on habit. Sales by hour against hours rostered shows where the habit costs money.",
    prompt: "Overlay sales by hour of day with rostered hours by hour of day for the last 4 weeks, by store, and show the hours that are over or under covered.",
    needs: ["pos", "labour"],
    weight: 2,
  }),

  // ---- Workshop ------------------------------------------------------------
  entry({
    id: "workshop-throughput",
    domain: "workshop",
    title: "Review workshop throughput",
    why: "Jobs opened, jobs closed and jobs overdue tell you whether the bench is keeping up.",
    prompt: "How many workshop jobs did we open and complete each week over the last 12 weeks, and how many are overdue right now?",
    needs: ["workshop"],
    weight: 3,
  }),
  entry({
    id: "workshop-labour-vs-parts",
    domain: "workshop",
    title: "Split workshop revenue into labour and parts",
    why: "Workshop margin lives in labour. If parts dominate, you are a shop with a bench, not a service business.",
    prompt: "Split workshop revenue into labour and parts by month for the last 12 months and show the margin on each.",
    needs: ["workshop"],
    weight: 2,
  }),
  entry({
    id: "workshop-warranty-rework",
    domain: "workshop",
    title: "Find warranty and rework jobs",
    why: "Warranty jobs cost time twice. Concentrations by product or technician are fixable.",
    prompt: "How many warranty jobs did the workshop handle over the last 6 months, which products or brands drove them, and how many hours did they consume?",
    needs: ["workshop"],
    weight: 1,
  }),

  // ---- Payments & fees -----------------------------------------------------
  entry({
    id: "payments-mix",
    domain: "payments",
    title: "Break down your payment mix",
    why: "Tender mix decides your fee bill and your cash handling.",
    prompt: "What share of sales came through each payment method over the last 90 days, and how has cash versus card shifted month by month?",
    needs: ["payments"],
    weight: 2,
  }),
  entry({
    id: "payments-fees-and-payouts",
    domain: "payments",
    title: "Track processing fees and payouts",
    why: "Card fees are a silent cost, and payout timing shapes your cash flow.",
    prompt: "How much did I pay in card processing fees over the last 90 days, what share of sales was that, and how long do payouts take to land?",
    needs: ["payments"],
    weight: 2,
  }),
  entry({
    id: "payments-disputes",
    domain: "payments",
    title: "Review disputes and chargebacks",
    why: "Open disputes are money at risk with a deadline attached.",
    prompt: "Which card disputes are open right now, what amounts are at risk, when is evidence due, and what have the last 6 months of disputes cost me?",
    needs: ["disputes"],
    weight: 1,
  }),
  entry({
    id: "payments-gift-card-liability",
    domain: "payments",
    title: "Track gift card liability",
    why: "Outstanding gift cards are a liability until redeemed, and breakage is quiet profit.",
    prompt: "What is my outstanding gift card balance, how much was loaded versus redeemed each month over the last 12 months, and how much has gone unredeemed for over a year?",
    needs: ["storedValue"],
    weight: 1,
  }),

  // ---- Memberships & classes ---------------------------------------------
  entry({
    id: "memberships-subscription-churn",
    domain: "memberships",
    title: "Measure subscription churn",
    why: "Recurring revenue only compounds if churn stays below new sign-ups.",
    prompt: "How many subscriptions were active at the start of each of the last 6 months, how many were added and cancelled, and what is the monthly churn rate?",
    needs: ["subscriptions"],
    weight: 3,
  }),
  entry({
    id: "memberships-recurring-revenue",
    domain: "memberships",
    title: "Track recurring revenue by plan",
    why: "Monthly recurring revenue is the heartbeat of a subscription business.",
    prompt: "What is my monthly recurring revenue trend over the last 12 months, split by plan, and which plans are growing?",
    needs: ["subscriptions"],
    weight: 2,
  }),
  entry({
    id: "memberships-unpaid-invoices",
    domain: "memberships",
    title: "Chase unpaid subscription invoices",
    why: "Open and uncollectible invoices are revenue you already earned.",
    prompt: "Which invoices are open or uncollectible, how much is outstanding, and which customers are delinquent?",
    needs: ["subscriptions"],
    weight: 2,
  }),
  entry({
    id: "memberships-class-fill-rates",
    domain: "memberships",
    title: "See which classes fill and which don't",
    why: "An empty spot in a scheduled class is perishable inventory.",
    prompt: "Which classes and time slots had the highest and lowest fill rates over the last 8 weeks, and which instructors draw the biggest attendance?",
    needs: ["studio"],
    weight: 3,
  }),
  entry({
    id: "memberships-health",
    domain: "memberships",
    title: "Review membership health",
    why: "Active memberships, freezes and expiries decide next month's revenue.",
    prompt: "How many memberships are active by plan, how many are frozen or expiring in the next 30 days, and how does that compare with 3 months ago?",
    needs: ["studio"],
    weight: 3,
  }),
  entry({
    id: "memberships-lapse-risk",
    domain: "memberships",
    title: "Find members at risk of lapsing",
    why: "A member who stops attending has usually decided to leave before they cancel.",
    prompt: "Which active members have not attended in the last 30 days, and how does their attendance compare with their previous 3 months?",
    needs: ["studio"],
    weight: 2,
  }),

  // ---- Online store --------------------------------------------------------
  entry({
    id: "online-orders-and-aov",
    domain: "online",
    title: "Track online orders and order value",
    why: "Order count and average order value are the two levers of online growth.",
    prompt: "Show my online orders, sales and average order value by week for the last 12 weeks, and the share of orders that used a discount code.",
    needs: ["online"],
    weight: 3,
  }),
  entry({
    id: "online-fulfilment-speed",
    domain: "online",
    title: "Check fulfilment speed and late deliveries",
    why: "Slow dispatch is the most common reason online customers do not come back.",
    prompt: "How long did it take to fulfil online orders over the last 90 days, how many deliveries were late, and is that improving?",
    needs: ["online"],
    weight: 2,
  }),
  entry({
    id: "online-returns",
    domain: "online",
    title: "Measure online returns by product",
    why: "Return rates by product point at sizing, photography or quality problems.",
    prompt: "What is my online return rate over the last 90 days by product and reason, and what did returns cost in refunds?",
    needs: ["online"],
    weight: 2,
  }),
  entry({
    id: "online-discount-codes",
    domain: "online",
    title: "Evaluate your discount codes",
    why: "Every code should earn its keep in incremental orders.",
    prompt: "Which discount codes were used most in the last 90 days, what did they cost, and did orders using them have higher or lower value?",
    needs: ["online"],
    weight: 1,
  }),
]);

/** Control-plane connector keys → the public trace identifiers cards name. */
export function normaliseDiscoverConnectors(connectorKeys: readonly string[]): readonly DiscoverConnector[] {
  const known = new Set<string>(DISCOVER_CONNECTORS);
  const found = new Set<DiscoverConnector>();
  for (const key of connectorKeys) {
    const normalised = normalizeV3Connector(key);
    if (normalised && known.has(normalised)) found.add(normalised as DiscoverConnector);
  }
  return Object.freeze(DISCOVER_CONNECTORS.filter((connector) => found.has(connector)));
}

/** Titles compared for duplicates: case, punctuation and filler words removed. */
export function normaliseDiscoverTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’]/gu, "")
    .replace(/[^a-z0-9\s]/gu, " ")
    .replace(/\b(?:the|your|my|our|a|an|and|of|by|in|to|for|with|at|on)\b/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function resolveTools(
  needs: readonly DiscoverCapability[],
  connected: ReadonlySet<DiscoverConnector>,
): readonly DiscoverConnector[] | null {
  const tools: DiscoverConnector[] = [];
  for (const capability of needs) {
    const match = DISCOVER_CAPABILITY_CONNECTORS[capability].find((connector) => connected.has(connector));
    if (!match) return null;
    if (!tools.includes(match)) tools.push(match);
  }
  return Object.freeze(tools);
}

type ResolvedEntry = Readonly<{ card: DiscoverCard; score: number }>;

/** Library entries the connected tools can answer, resolved to real logos. */
export function resolveDiscoverLibrary(connectorKeys: readonly string[]): readonly DiscoverCard[] {
  const connected = new Set(normaliseDiscoverConnectors(connectorKeys));
  if (connected.size === 0) return Object.freeze([]);
  const resolved: DiscoverCard[] = [];
  for (const item of DISCOVER_LIBRARY) {
    const tools = resolveTools(item.needs, connected);
    if (!tools) continue;
    resolved.push(Object.freeze({
      id: item.id,
      title: item.title,
      why: item.why,
      prompt: item.prompt,
      domain: item.domain,
      tools,
    }));
  }
  return Object.freeze(resolved);
}

/**
 * The cards the grid shows before (or without) the model pass: up to
 * `limit` cards, most valuable first within each domain, domains
 * interleaved so the grid reads as a tour of the business rather than a
 * run of sales questions followed by a run of stock questions. Cross-tool
 * cards rank slightly higher because they show what connecting tools
 * unlocks.
 */
export function selectDiscoverCards(
  connectorKeys: readonly string[],
  options: Readonly<{ limit?: number }> = {},
): readonly DiscoverCard[] {
  const limit = Math.max(1, Math.min(options.limit ?? DISCOVER_CARD_TARGET, DISCOVER_LIBRARY.length));
  const connected = new Set(normaliseDiscoverConnectors(connectorKeys));
  if (connected.size === 0) return Object.freeze([]);

  const byDomain = new Map<DiscoverDomain, ResolvedEntry[]>();
  DISCOVER_LIBRARY.forEach((item, index) => {
    const tools = resolveTools(item.needs, connected);
    if (!tools) return;
    const crossTool = item.needs.length > 1 ? 1 : 0;
    const bucket = byDomain.get(item.domain) ?? [];
    bucket.push({
      card: Object.freeze({
        id: item.id,
        title: item.title,
        why: item.why,
        prompt: item.prompt,
        domain: item.domain,
        tools,
      }),
      // Library order breaks ties so selection is stable.
      score: item.weight * 10 + crossTool * 3 - index / 1_000,
    });
    byDomain.set(item.domain, bucket);
  });
  for (const bucket of byDomain.values()) bucket.sort((a, b) => b.score - a.score);

  const selected: DiscoverCard[] = [];
  const domains = DISCOVER_DOMAINS.filter((domain) => (byDomain.get(domain)?.length ?? 0) > 0);
  let round = 0;
  while (selected.length < limit) {
    let added = false;
    for (const domain of domains) {
      const next = byDomain.get(domain)?.[round];
      if (!next) continue;
      selected.push(next.card);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
    round += 1;
  }
  return Object.freeze(selected);
}
