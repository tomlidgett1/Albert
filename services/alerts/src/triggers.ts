/**
 * The ten heads-up triggers (ADR 0132). Each trigger runs a handful of
 * governed Cube queries through the loader it is given and returns a
 * deterministic reading: the card's "now" line plus the events it wants to
 * fire. Events carry a dedupe key that names the condition (a day, a job,
 * an item and its stock cycle, a customer and a date), so a condition that
 * is still true at the next evaluation fires once.
 *
 * Every query stays inside one governed view and uses members that exist
 * in the catalogue; the evaluator validates them against Cube's meta before
 * sending. Nothing here reads the database directly.
 */
import type { CubeQuery } from "../../../packages/albert-v3/src/cube/types.js";
import type { AlertEventDraft, AlertResultSummary, AlertTriggerKey } from "./contracts.js";
import {
  addDays,
  cubeDate,
  daysBetween,
  formatDay,
  formatDayWithYear,
  isoWeekday,
  localDate,
  money,
  monthKey,
  monthName,
  numberOf,
  percent,
  plural,
  startOfWeek,
  textOf,
  weekdayName,
  type IsoDate,
} from "./dates.js";

export type AlertRow = Readonly<Record<string, unknown>>;
export type AlertRows = readonly AlertRow[];

/** Runs one governed query; throws when Cube rejects or fails it. */
export type AlertQueryLoader = (label: string, query: CubeQuery) => Promise<AlertRows>;

export type AlertFreshness = Readonly<{
  connector: string;
  domain: string;
  dataThrough: string | null;
}>;

export type AlertContext = Readonly<{
  now: Date;
  timezone: string;
  /** Local calendar dates in the tenant's zone. */
  today: IsoDate;
  yesterday: IsoDate;
  /** Local hour of day (0-23) when the evaluation started. */
  localHour: number;
  activeConnectors: readonly string[];
  freshness: readonly AlertFreshness[];
  config: Readonly<Record<string, unknown>>;
}>;

export type TriggerEvaluation = Readonly<{
  result: AlertResultSummary;
  events: readonly AlertEventDraft[];
}>;

export type AlertTrigger = Readonly<{
  key: AlertTriggerKey;
  run: (context: AlertContext, load: AlertQueryLoader) => Promise<TriggerEvaluation>;
}>;

/** Digests (monthly and weekly roll-ups) are drafted from this local hour so a text never lands overnight. */
export const ALERT_DIGEST_FROM_HOUR = 7;

export function alertContext(input: Readonly<{
  now: Date;
  timezone: string;
  activeConnectors: readonly string[];
  freshness: readonly AlertFreshness[];
  config?: Readonly<Record<string, unknown>>;
}>): AlertContext {
  const today = localDate(input.now, input.timezone);
  let localHour = 12;
  try {
    localHour = Number(new Intl.DateTimeFormat("en-GB", {
      timeZone: input.timezone,
      hour: "numeric",
      hourCycle: "h23",
    }).format(input.now));
  } catch {
    localHour = input.now.getUTCHours();
  }
  return Object.freeze({
    now: input.now,
    timezone: input.timezone,
    today,
    yesterday: addDays(today, -1),
    localHour: Number.isFinite(localHour) ? localHour : 12,
    activeConnectors: Object.freeze([...input.activeConnectors]),
    freshness: Object.freeze(input.freshness.map((entry) => Object.freeze({ ...entry }))),
    config: Object.freeze({ ...(input.config ?? {}) }),
  });
}

function connected(context: AlertContext, connector: string): boolean {
  return context.activeConnectors.length === 0 || context.activeConnectors.includes(connector);
}

/** The latest instant a connector's data is known to reach, or null when unknown. */
function dataThrough(context: AlertContext, connector: string): string | null {
  let latest: string | null = null;
  for (const entry of context.freshness) {
    if (entry.connector !== connector || !entry.dataThrough) continue;
    if (latest === null || entry.dataThrough > latest) latest = entry.dataThrough;
  }
  return latest;
}

/** True when the connector's data reaches the end of the local day (or its reach is unknown). */
function daySettled(context: AlertContext, connector: string, day: IsoDate): boolean {
  const through = dataThrough(context, connector);
  if (!through) return true;
  const parsed = new Date(through);
  if (Number.isNaN(parsed.getTime())) return true;
  return localDate(parsed, context.timezone) > day;
}

function digestsDue(context: AlertContext): boolean {
  return context.localHour >= ALERT_DIGEST_FROM_HOUR;
}

function num(row: AlertRow, key: string): number {
  return numberOf(row[key]);
}

function str(row: AlertRow, key: string): string {
  return textOf(row[key]);
}

function day(row: AlertRow, key: string): IsoDate | null {
  return cubeDate(row[key]);
}

function idOf(row: AlertRow, key: string): string {
  const value = row[key];
  if (typeof value === "number") return String(Math.trunc(value));
  const text = textOf(value);
  return /^\d+(?:\.0+)?$/u.test(text) ? String(Number.parseInt(text, 10)) : text;
}

/** Lightspeed's placeholder customers ("Unnamed customer", walk-ins) are nobody in particular. */
export function namedCustomer(value: unknown): string {
  const name = textOf(value).replace(/\s+/gu, " ").trim();
  if (!name || /^(unnamed|unknown|walk[- ]?in|cash|counter|anonymous|n\/?a)\b/iu.test(name) || /\bcustomer$/iu.test(name) && /^(unnamed|unknown|walk[- ]?in|cash|counter|anonymous|no)\b/iu.test(name)) {
    return "";
  }
  return name;
}

function article(word: string): string {
  return /^[aeiou]/iu.test(word) ? `an ${word}` : `a ${word}`;
}

/** Bike categories hold a few miscategorised accessories; keep the bikes. */
const NOT_A_BIKE = /\b(computer|gps|helmet|rack|trainer|pump|light|lock|bag|tyre|tire|wheel|saddle|pedal|carrier|stand|cover)\b/iu;

function shortName(value: string, max = 60): string {
  const trimmed = value.replace(/\s+/gu, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function listInEnglish(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

function possessive(name: string): string {
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

function result(status: AlertResultSummary["status"], line: string, metrics?: Record<string, string | number | null>): AlertResultSummary {
  return Object.freeze({ status, line, ...(metrics ? { metrics: Object.freeze({ ...metrics }) } : {}) });
}

function evaluation(events: readonly AlertEventDraft[], line: string, metrics?: Record<string, string | number | null>): TriggerEvaluation {
  return Object.freeze({
    result: result(events.length > 0 ? "fired" : "quiet", line, metrics),
    events: Object.freeze([...events]),
  });
}

function waiting(line: string): TriggerEvaluation {
  return Object.freeze({ result: result("waiting", line), events: Object.freeze([]) });
}

function skipped(line: string): TriggerEvaluation {
  return Object.freeze({ result: result("skipped", line), events: Object.freeze([]) });
}

// ---------------------------------------------------------------------------
// 1. Trading day

const tradingDay: AlertTrigger = {
  key: "trading_day",
  async run(context, load) {
    if (!connected(context, "lightspeed-r")) return skipped("Needs Lightspeed.");
    const { today, yesterday } = context;
    if (!daySettled(context, "lightspeed-r", yesterday)) {
      return waiting(`Waiting for Lightspeed to finish syncing ${formatDay(yesterday)}.`);
    }
    const daily = await load("daily takings for 400 days", {
      measures: ["sales_analytics.gross_takings", "sales_analytics.transactions"],
      timeDimensions: [{
        dimension: "sales_analytics.completed_at",
        granularity: "day",
        dateRange: [addDays(today, -400), yesterday],
      }],
      limit: 500,
    });
    const byDay = new Map<IsoDate, { takings: number; transactions: number }>();
    for (const row of daily) {
      const date = day(row, "sales_analytics.completed_at.day") ?? day(row, "sales_analytics.completed_at");
      if (!date) continue;
      byDay.set(date, { takings: num(row, "sales_analytics.gross_takings"), transactions: num(row, "sales_analytics.transactions") });
    }
    const latest = byDay.get(yesterday) ?? { takings: 0, transactions: 0 };
    let best: { date: IsoDate; takings: number } | null = null;
    for (const [date, entry] of byDay) {
      if (date >= yesterday || date < addDays(yesterday, -365) || entry.takings <= 0) continue;
      if (!best || entry.takings > best.takings) best = { date, takings: entry.takings };
    }
    const events: AlertEventDraft[] = [];
    if (best && latest.takings >= 5_000 && latest.takings > best.takings) {
      events.push({
        dedupeKey: `record:${yesterday}`,
        headline: "Biggest day in a year",
        body: `${formatDay(yesterday)} did ${money(latest.takings)} from ${plural(latest.transactions, "sale")}. `
          + `Your previous best in the last 12 months was ${money(best.takings)} on ${formatDay(best.date)}.`,
        evidence: { date: yesterday, takings: latest.takings, transactions: latest.transactions, previousBest: best.takings, previousBestDate: best.date },
      });
    }
    if (connected(context, "deputy")) {
      const staffed = await load("staff hours yesterday", {
        measures: ["workforce_analytics.hours_worked"],
        timeDimensions: [{
          dimension: "workforce_analytics.shift_date",
          granularity: "day",
          dateRange: [yesterday, yesterday],
        }],
      });
      const hours = staffed.reduce((sum, row) => sum + num(row, "workforce_analytics.hours_worked"), 0);
      if (hours >= 4 && latest.takings < 300) {
        events.push({
          dedupeKey: `dead:${yesterday}`,
          headline: "Staffed, but the till barely moved",
          body: `${formatDay(yesterday)}: ${plural(Math.round(hours), "staff hour")} on the clock and `
            + `${money(latest.takings)} from ${plural(latest.transactions, "sale")}. Check the register synced.`,
          evidence: { date: yesterday, hours, takings: latest.takings, transactions: latest.transactions },
        });
      }
    }
    if (Number(today.slice(8, 10)) <= 3 && digestsDue(context)) {
      const closed = monthKey(addDays(today, -Number(today.slice(8, 10))));
      const monthly = await load("monthly transactions for 37 months", {
        measures: ["sales_analytics.transactions", "sales_analytics.gross_takings"],
        timeDimensions: [{
          dimension: "sales_analytics.completed_at",
          granularity: "month",
          dateRange: [`${monthKey(addDays(today, -1_100))}-01`, addDays(`${closed}-01`, 40)],
        }],
        limit: 60,
      });
      const byMonth = new Map<string, { transactions: number; takings: number }>();
      for (const row of monthly) {
        const date = day(row, "sales_analytics.completed_at.month") ?? day(row, "sales_analytics.completed_at");
        if (!date) continue;
        byMonth.set(monthKey(date), { transactions: num(row, "sales_analytics.transactions"), takings: num(row, "sales_analytics.gross_takings") });
      }
      const current = byMonth.get(closed);
      const sameMonth = [...byMonth.entries()]
        .filter(([key]) => key !== closed && key < closed && key.slice(5) === closed.slice(5))
        .map(([key, entry]) => ({ key, ...entry }));
      const lastYear = sameMonth.find((entry) => entry.key === `${Number(closed.slice(0, 4)) - 1}${closed.slice(4)}`);
      if (current && sameMonth.length >= 2 && lastYear && lastYear.transactions > 0) {
        const minimum = Math.min(...sameMonth.map((entry) => entry.transactions));
        const drop = 1 - current.transactions / lastYear.transactions;
        if (current.transactions < minimum && drop >= 0.2) {
          const takingsChange = lastYear.takings > 0 ? (current.takings / lastYear.takings - 1) * 100 : 0;
          events.push({
            dedupeKey: `lowmonth:${closed}`,
            headline: `Quietest ${monthName(closed)} in ${sameMonth.length + 1} years`,
            body: `${monthName(closed)} closed with ${plural(current.transactions, "transaction")}, the fewest for ${article(monthName(closed))} `
              + `in ${sameMonth.length + 1} years and ${percent(drop * 100)} down on last year. `
              + `Takings ${takingsChange < 0 ? "fell" : "rose"} ${percent(Math.abs(takingsChange))} to ${money(current.takings)}.`,
            evidence: { month: closed, transactions: current.transactions, lastYearTransactions: lastYear.transactions, takings: current.takings },
          });
        }
      }
    }
    const line = latest.transactions > 0
      ? `${formatDay(yesterday)}: ${money(latest.takings)} from ${plural(latest.transactions, "sale")}`
        + (best ? ` · best day in 12 months ${money(best.takings)} (${formatDay(best.date)})` : "")
      : `No sales recorded for ${formatDay(yesterday)}` + (best ? ` · best day in 12 months ${money(best.takings)}` : "");
    return evaluation(events, line, { takings: latest.takings, transactions: latest.transactions, best: best?.takings ?? null });
  },
};

// ---------------------------------------------------------------------------
// 2. Bike sold, then the service chain

type BikeLine = Readonly<{ saleId: string; item: string; customer: string; revenue: number; soldOn: IsoDate }>;

function bikeLinesQuery(from: IsoDate, to: IsoDate): CubeQuery {
  return {
    dimensions: [
      "product_sales_analytics.sale_id",
      "product_sales_analytics.items_name",
      "product_sales_analytics.categories_full_path_name",
      "product_sales_analytics.customers_full_name",
    ],
    measures: ["product_sales_analytics.line_revenue", "product_sales_analytics.units_sold"],
    timeDimensions: [{ dimension: "product_sales_analytics.completed_at", dateRange: [from, to] }],
    filters: [
      { member: "product_sales_analytics.categories_full_path_name", operator: "startsWith", values: ["Bikes"] },
      { member: "product_sales_analytics.line_revenue", operator: "gte", values: ["300"] },
    ],
    limit: 200,
  };
}

function bikeLines(rows: AlertRows, fallbackDate: IsoDate): BikeLine[] {
  return rows
    .map((row) => ({
      saleId: idOf(row, "product_sales_analytics.sale_id"),
      item: shortName(str(row, "product_sales_analytics.items_name")),
      customer: namedCustomer(row["product_sales_analytics.customers_full_name"]),
      revenue: num(row, "product_sales_analytics.line_revenue"),
      soldOn: day(row, "product_sales_analytics.completed_at") ?? fallbackDate,
    }))
    .filter((line) => line.item && !NOT_A_BIKE.test(line.item));
}

async function workshopVisits(load: AlertQueryLoader, names: readonly string[], from: IsoDate, to: IsoDate): Promise<Map<string, IsoDate[]>> {
  const visits = new Map<string, IsoDate[]>();
  if (names.length === 0) return visits;
  const rows = await load("workshop visits for bike buyers", {
    dimensions: ["workshop_analytics.customers_full_name", "workshop_analytics.checked_in_at"],
    measures: ["workshop_analytics.workorder_count"],
    filters: [{ member: "workshop_analytics.customers_full_name", operator: "equals", values: names.slice(0, 100) }],
    timeDimensions: [{ dimension: "workshop_analytics.checked_in_at", dateRange: [from, to] }],
    limit: 1_000,
  });
  for (const row of rows) {
    const name = str(row, "workshop_analytics.customers_full_name");
    const date = day(row, "workshop_analytics.checked_in_at");
    if (!name || !date) continue;
    visits.set(name, [...(visits.get(name) ?? []), date]);
  }
  return visits;
}

const bikeSold: AlertTrigger = {
  key: "bike_sold",
  async run(context, load) {
    if (!connected(context, "lightspeed-r")) return skipped("Needs Lightspeed.");
    const { today, yesterday } = context;
    if (!daySettled(context, "lightspeed-r", yesterday)) {
      return waiting(`Waiting for Lightspeed to finish syncing ${formatDay(yesterday)}.`);
    }
    const sold = bikeLines(await load("bikes sold yesterday", bikeLinesQuery(yesterday, yesterday)), yesterday);
    const buyerNames = [...new Set(sold.map((line) => line.customer).filter(Boolean))];
    const buyers = new Map<string, { firstPurchase: IsoDate | null; purchases: number; lifetime: number }>();
    if (buyerNames.length > 0) {
      const rows = await load("bike buyers", {
        dimensions: [
          "customer_analytics.full_name",
          "customer_analytics.first_purchase_at",
          "customer_analytics.purchase_count",
          "customer_analytics.lifetime_net_spend",
        ],
        filters: [{ member: "customer_analytics.full_name", operator: "equals", values: buyerNames.slice(0, 100) }],
        limit: 200,
      });
      for (const row of rows) {
        buyers.set(str(row, "customer_analytics.full_name"), {
          firstPurchase: day(row, "customer_analytics.first_purchase_at"),
          purchases: num(row, "customer_analytics.purchase_count"),
          lifetime: num(row, "customer_analytics.lifetime_net_spend"),
        });
      }
    }
    const events: AlertEventDraft[] = [];
    for (const line of sold) {
      const buyer = line.customer ? buyers.get(line.customer) : undefined;
      const firstTimer = Boolean(buyer && buyer.firstPurchase === yesterday);
      if (!(line.revenue >= 1_500 || firstTimer)) continue;
      const who = line.customer || "A walk-in customer";
      const history = !line.customer
        ? ""
        : firstTimer
          ? ", their first purchase here"
          : buyer
            ? `, visit number ${buyer.purchases}`
            : "";
      events.push({
        dedupeKey: `bike:${line.saleId}:${line.item.slice(0, 24)}`,
        headline: firstTimer ? "A first-time customer bought a bike" : "A bike went out the door",
        body: `${who} took the ${line.item} for ${money(line.revenue)} on ${formatDay(yesterday)}${history}. `
          + `The free first service falls due around ${formatDay(addDays(yesterday, 42))}.`,
        evidence: { saleId: line.saleId, item: line.item, revenue: line.revenue, firstTimer },
      });
    }
    const firstServiceWindow = bikeLines(await load("bikes sold 5-7 weeks ago", bikeLinesQuery(addDays(today, -49), addDays(today, -35))), addDays(today, -42))
      .filter((line) => line.customer);
    const annualWindow = bikeLines(await load("bikes sold 12 months ago", bikeLinesQuery(addDays(today, -380), addDays(today, -365))), addDays(today, -372))
      .filter((line) => line.customer);
    const dueNames = [...new Set([...firstServiceWindow, ...annualWindow].map((line) => line.customer))];
    const visits = await workshopVisits(load, dueNames, addDays(today, -400), today);
    const visitedAfter = (line: BikeLine) => (visits.get(line.customer) ?? []).some((date) => date > addDays(line.soldOn, 7));
    let dueFirst = 0;
    for (const line of firstServiceWindow) {
      if (visitedAfter(line)) continue;
      dueFirst += 1;
      events.push({
        dedupeKey: `service6w:${line.saleId}:${line.item.slice(0, 24)}`,
        headline: "First service is due",
        body: `${possessive(line.customer)} ${line.item} (${money(line.revenue)}) went out on ${formatDay(line.soldOn)}, `
          + "six weeks ago, and hasn't been back for its first service.",
        evidence: { saleId: line.saleId, item: line.item, soldOn: line.soldOn, customer: line.customer },
      });
    }
    let dueAnnual = 0;
    for (const line of annualWindow) {
      if (visitedAfter(line)) continue;
      dueAnnual += 1;
      events.push({
        dedupeKey: `service12m:${line.saleId}:${line.item.slice(0, 24)}`,
        headline: "Annual service is due",
        body: `${possessive(line.customer)} ${line.item} (${money(line.revenue)}) went out on ${formatDayWithYear(line.soldOn)}, `
          + "a year ago, and hasn't been back to the workshop since.",
        evidence: { saleId: line.saleId, item: line.item, soldOn: line.soldOn, customer: line.customer },
      });
    }
    const takings = sold.reduce((sum, line) => sum + line.revenue, 0);
    const line = `${plural(sold.length, "bike")} sold ${formatDay(yesterday)}${sold.length > 0 ? ` (${money(takings)})` : ""}`
      + ` · ${dueFirst} first services due · ${dueAnnual} annual services due`;
    return evaluation(events, line, { bikesYesterday: sold.length, takings, dueFirst, dueAnnual });
  },
};

// ---------------------------------------------------------------------------
// 3. Big customers

const vipCustomer: AlertTrigger = {
  key: "vip_customer",
  async run(context, load) {
    if (!connected(context, "lightspeed-r")) return skipped("Needs Lightspeed.");
    const { today, yesterday } = context;
    const vipRows = await load("customers over $5k lifetime", {
      dimensions: [
        "customer_analytics.full_name",
        "customer_analytics.last_purchase_at",
        "customer_analytics.purchase_count",
        "customer_analytics.lifetime_net_spend",
        "customer_analytics.days_since_last_purchase",
      ],
      filters: [{ member: "customer_analytics.lifetime_net_spend", operator: "gte", values: ["5000"] }],
      order: { "customer_analytics.lifetime_net_spend": "desc" },
      limit: 500,
    });
    const vips = vipRows.map((row) => ({
      name: namedCustomer(row["customer_analytics.full_name"]),
      lastPurchase: day(row, "customer_analytics.last_purchase_at"),
      purchases: num(row, "customer_analytics.purchase_count"),
      lifetime: num(row, "customer_analytics.lifetime_net_spend"),
      quietDays: num(row, "customer_analytics.days_since_last_purchase"),
    })).filter((vip) => vip.name);
    const events: AlertEventDraft[] = [];
    for (const vip of vips) {
      if (vip.quietDays < 180 || vip.quietDays > 194 || !vip.lastPurchase) continue;
      events.push({
        dedupeKey: `quiet:${vip.name}:${vip.lastPurchase}`,
        headline: `A ${vip.lifetime >= 10_000 ? "$10k" : "$5k"} customer has gone quiet`,
        body: `${vip.name} hasn't bought since ${formatDay(vip.lastPurchase)}, six months ago. `
          + `Lifetime ${money(vip.lifetime)} over ${plural(vip.purchases, "visit")}.`,
        evidence: { customer: vip.name, lifetime: vip.lifetime, lastPurchase: vip.lastPurchase },
      });
    }
    const quiet = vips.filter((vip) => vip.quietDays >= 180).length;
    if (!daySettled(context, "lightspeed-r", yesterday)) {
      return Object.freeze({
        result: result("waiting", `${plural(vips.length, "customer")} over $5k lifetime · ${quiet} quiet for six months or more · waiting for Lightspeed to finish syncing ${formatDay(yesterday)}`),
        events: Object.freeze(events),
      });
    }
    const salesRows = await load("identified sales yesterday", {
      dimensions: [
        "sales_analytics.sale_id",
        "sales_analytics.customers_full_name",
        "sales_analytics.customers_lifetime_net_spend",
        "sales_analytics.customers_purchase_count",
        "sales_analytics.customers_first_purchase_at",
      ],
      measures: ["sales_analytics.gross_takings"],
      segments: ["sales_analytics.customer_attached_sales"],
      timeDimensions: [{ dimension: "sales_analytics.completed_at", dateRange: [yesterday, yesterday] }],
      limit: 300,
    });
    const spentYesterday = new Map<string, { spent: number; lifetime: number; purchases: number }>();
    for (const row of salesRows) {
      const name = namedCustomer(row["sales_analytics.customers_full_name"]);
      if (!name) continue;
      const current = spentYesterday.get(name) ?? { spent: 0, lifetime: num(row, "sales_analytics.customers_lifetime_net_spend"), purchases: num(row, "sales_analytics.customers_purchase_count") };
      current.spent += num(row, "sales_analytics.gross_takings");
      spentYesterday.set(name, current);
    }
    const vipBuyers = [...spentYesterday.entries()].filter(([, entry]) => entry.lifetime >= 5_000);
    const history = new Map<string, IsoDate[]>();
    if (vipBuyers.length > 0) {
      const rows = await load("purchase days for yesterday's big customers", {
        dimensions: ["sales_analytics.customers_full_name"],
        measures: ["sales_analytics.transactions"],
        timeDimensions: [{ dimension: "sales_analytics.completed_at", granularity: "day", dateRange: [addDays(today, -800), yesterday] }],
        filters: [{ member: "sales_analytics.customers_full_name", operator: "equals", values: vipBuyers.map(([name]) => name).slice(0, 100) }],
        limit: 2_000,
      });
      for (const row of rows) {
        const name = str(row, "sales_analytics.customers_full_name");
        const date = day(row, "sales_analytics.completed_at.day") ?? day(row, "sales_analytics.completed_at");
        if (!name || !date) continue;
        history.set(name, [...(history.get(name) ?? []), date]);
      }
    }
    for (const [name, entry] of vipBuyers) {
      const previous = (history.get(name) ?? []).filter((date) => date < yesterday).sort().pop();
      const gap = previous ? daysBetween(previous, yesterday) : null;
      if (gap !== null && gap >= 365) {
        events.push({
          dedupeKey: `winback:${name}:${yesterday}`,
          headline: "A big customer is back",
          body: `${name} (${money(entry.lifetime)} lifetime over ${plural(entry.purchases, "visit")}) walked back in on ${formatDay(yesterday)} `
            + `after ${gap} days away and spent ${money(entry.spent)}.`,
          evidence: { customer: name, lifetime: entry.lifetime, gapDays: gap, spent: entry.spent },
        });
      }
      const before = entry.lifetime - entry.spent;
      const crossed = entry.lifetime >= 10_000 && before < 10_000 ? 10_000 : entry.lifetime >= 5_000 && before < 5_000 ? 5_000 : null;
      if (crossed) {
        events.push({
          dedupeKey: `crossed${crossed / 1000}k:${name}`,
          headline: `A customer just passed ${money(crossed)} lifetime`,
          body: `${name} crossed ${money(crossed)} of lifetime spend with ${formatDay(yesterday)}'s ${money(entry.spent)}, `
            + `over ${plural(entry.purchases, "visit")}.`,
          evidence: { customer: name, lifetime: entry.lifetime, threshold: crossed },
        });
      }
    }
    const line = `${plural(vips.length, "customer")} over $5k lifetime · ${quiet} quiet for six months or more`
      + (vipBuyers.length > 0 ? ` · ${vipBuyers.length} bought ${formatDay(yesterday)}` : "");
    return evaluation(events, line, { vips: vips.length, quiet, boughtYesterday: vipBuyers.length });
  },
};

// ---------------------------------------------------------------------------
// 4. Workshop: waiting on the customer

type OpenJob = Readonly<{
  id: string;
  status: string;
  checkedIn: IsoDate | null;
  promised: IsoDate | null;
  customer: string;
  description: string;
}>;

async function openJobs(load: AlertQueryLoader, from: IsoDate, to: IsoDate): Promise<OpenJob[]> {
  const rows = await load("open workshop jobs", {
    dimensions: [
      "workshop_analytics.workorder_id",
      "workshop_analytics.workorder_statuses_name",
      "workshop_analytics.checked_in_at",
      "workshop_analytics.promised_at",
      "workshop_analytics.customers_full_name",
      "workshop_analytics.serviced_item_description",
    ],
    measures: ["workshop_analytics.workorder_count"],
    segments: ["workshop_analytics.open_jobs"],
    timeDimensions: [{ dimension: "workshop_analytics.checked_in_at", dateRange: [from, to] }],
    order: { "workshop_analytics.checked_in_at": "asc" },
    limit: 500,
  });
  return rows.map((row) => ({
    id: idOf(row, "workshop_analytics.workorder_id"),
    status: str(row, "workshop_analytics.workorder_statuses_name"),
    checkedIn: day(row, "workshop_analytics.checked_in_at"),
    promised: day(row, "workshop_analytics.promised_at"),
    customer: namedCustomer(row["workshop_analytics.customers_full_name"]),
    description: shortName(str(row, "workshop_analytics.serviced_item_description"), 40),
  }));
}

function jobLabel(job: OpenJob): string {
  const who = job.customer ? possessive(job.customer) : "A";
  return `${who} job #${job.id}${job.description ? ` (${job.description})` : ""}`;
}

const workshopUncollected: AlertTrigger = {
  key: "workshop_uncollected",
  async run(context, load) {
    if (!connected(context, "lightspeed-r")) return skipped("Needs Lightspeed.");
    const { today } = context;
    const jobs = await openJobs(load, addDays(today, -400), today);
    const finished = jobs.filter((job) => /finished/iu.test(job.status) && job.checkedIn);
    const overdue = jobs.filter((job) => !/finished|quote/iu.test(job.status) && job.promised && job.promised <= addDays(today, -2));
    const events: AlertEventDraft[] = [];
    const finishedNew = finished.filter((job) => {
      const age = daysBetween(job.checkedIn!, today);
      return age >= 7 && age <= 10;
    });
    for (const job of finishedNew) {
      events.push({
        dedupeKey: `finished:${job.id}`,
        headline: "Finished but not collected",
        body: `${jobLabel(job)} has been Finished since ${formatDay(job.checkedIn!)}, ${daysBetween(job.checkedIn!, today)} days, with nothing charged.`,
        evidence: { workorderId: job.id, checkedIn: job.checkedIn, customer: job.customer },
      });
    }
    const finishedOld = finished.filter((job) => daysBetween(job.checkedIn!, today) > 10);
    if (finishedOld.length > 0 && digestsDue(context)) {
      const ages = finishedOld.map((job) => daysBetween(job.checkedIn!, today));
      const oldest = finishedOld.reduce((a, b) => (a.checkedIn! < b.checkedIn! ? a : b));
      events.push({
        dedupeKey: `finished_digest:${monthKey(today)}`,
        headline: "Finished jobs with nothing charged",
        body: `${plural(finishedOld.length, "job")} ${finishedOld.length === 1 ? "is" : "are"} sitting Finished with nothing charged, `
          + `on average ${Math.round(ages.reduce((a, b) => a + b, 0) / ages.length)} days, the oldest since ${formatDayWithYear(oldest.checkedIn!)}`
          + `${oldest.customer ? ` (${oldest.customer})` : ""}. That is parts and labour you have already paid for.`,
        evidence: { count: finishedOld.length, oldest: oldest.checkedIn, oldestCustomer: oldest.customer },
      });
    }
    const overdueNew = overdue.filter((job) => job.promised! >= addDays(today, -9));
    for (const job of overdueNew) {
      events.push({
        dedupeKey: `overdue:${job.id}`,
        headline: "Past its promised date",
        body: `${jobLabel(job)} was promised for ${formatDay(job.promised!)} and is still open`
          + `${job.status && !/open/iu.test(job.status) ? ` (marked ${job.status})` : ""}.`,
        evidence: { workorderId: job.id, promised: job.promised, customer: job.customer },
      });
    }
    const overdueOld = overdue.filter((job) => job.promised! < addDays(today, -9));
    if (overdueOld.length > 0 && digestsDue(context)) {
      const worst = overdueOld.reduce((a, b) => (a.promised! < b.promised! ? a : b));
      events.push({
        dedupeKey: `overdue_digest:${monthKey(today)}`,
        headline: "Open jobs past their promised date",
        body: `${plural(overdueOld.length, "open job")} ${overdueOld.length === 1 ? "is" : "are"} past the date promised to the customer, `
          + `the worst by ${daysBetween(worst.promised!, today)} days${worst.customer ? ` (${worst.customer})` : ""}.`,
        evidence: { count: overdueOld.length, worst: worst.promised, worstCustomer: worst.customer },
      });
    }
    const line = `${finished.length} finished awaiting collection · ${overdue.length} open past their promised date`;
    return evaluation(events, line, { finished: finished.length, overdue: overdue.length });
  },
};

// ---------------------------------------------------------------------------
// 5. Workshop load

const workshopLoad: AlertTrigger = {
  key: "workshop_load",
  async run(context, load) {
    if (!connected(context, "lightspeed-r")) return skipped("Needs Lightspeed.");
    const { today, yesterday } = context;
    const promisedRows = await load("bikes promised back this week", {
      measures: ["workshop_analytics.workorder_count"],
      segments: ["workshop_analytics.open_jobs"],
      timeDimensions: [{ dimension: "workshop_analytics.promised_at", granularity: "day", dateRange: [today, addDays(today, 7)] }],
    });
    const promised = new Map<IsoDate, number>();
    for (const row of promisedRows) {
      const date = day(row, "workshop_analytics.promised_at.day") ?? day(row, "workshop_analytics.promised_at");
      if (date) promised.set(date, num(row, "workshop_analytics.workorder_count"));
    }
    const roster = new Map<IsoDate, { hours: number; staff: string[] }>();
    if (connected(context, "deputy")) {
      const rosterRows = await load("roster this week", {
        dimensions: ["workforce_analytics.rostered_staff"],
        measures: ["workforce_analytics.rostered_hours"],
        timeDimensions: [{ dimension: "workforce_analytics.rostered_date", granularity: "day", dateRange: [today, addDays(today, 7)] }],
        limit: 300,
      });
      for (const row of rosterRows) {
        const date = day(row, "workforce_analytics.rostered_date.day") ?? day(row, "workforce_analytics.rostered_date");
        if (!date) continue;
        const entry = roster.get(date) ?? { hours: 0, staff: [] };
        entry.hours += num(row, "workforce_analytics.rostered_hours");
        const name = str(row, "workforce_analytics.rostered_staff");
        if (name && !entry.staff.includes(name)) entry.staff.push(name);
        roster.set(date, entry);
      }
    }
    const events: AlertEventDraft[] = [];
    if (connected(context, "deputy")) {
      for (let offset = 1; offset <= 3; offset += 1) {
        const date = addDays(today, offset);
        const jobs = promised.get(date) ?? 0;
        const crew = roster.get(date) ?? { hours: 0, staff: [] };
        if (jobs < 5 || !(crew.staff.length <= 1 || crew.hours < 10)) continue;
        const who = crew.staff.length === 0
          ? "nobody rostered"
          : `${plural(crew.staff.length, "person", "people")} rostered for ${Math.round(crew.hours * 10) / 10} hours (${listInEnglish(crew.staff.map((name) => name.split(" ")[0]!))})`;
        events.push({
          dedupeKey: `load:${date}`,
          headline: "Heavy workshop day ahead",
          body: `${formatDay(date)}: ${plural(jobs, "bike")} promised back and ${who}.`,
          evidence: { date, jobs, hours: crew.hours, staff: crew.staff.length },
        });
      }
    }
    const weekRows = await load("workshop intake by week", {
      measures: ["workshop_analytics.workorder_count"],
      timeDimensions: [{ dimension: "workshop_analytics.checked_in_at", granularity: "week", dateRange: [startOfWeek(addDays(today, -182)), yesterday] }],
      limit: 60,
    });
    const weeks = new Map<IsoDate, number>();
    for (const row of weekRows) {
      const date = day(row, "workshop_analytics.checked_in_at.week") ?? day(row, "workshop_analytics.checked_in_at");
      if (date) weeks.set(date, num(row, "workshop_analytics.workorder_count"));
    }
    const lastWeek = addDays(startOfWeek(today), -7);
    const lastCount = weeks.get(lastWeek) ?? 0;
    const others = [...weeks.entries()].filter(([key]) => key !== lastWeek && key < lastWeek).map(([, count]) => count);
    const average = others.length > 0 ? others.reduce((a, b) => a + b, 0) / others.length : 0;
    if (others.length >= 8 && digestsDue(context)) {
      if (lastCount >= Math.max(...others) && lastCount >= 20) {
        events.push({
          dedupeKey: `intake_record:${lastWeek}`,
          headline: "Busiest workshop week in six months",
          body: `The week of ${formatDay(lastWeek)} took in ${plural(lastCount, "job")}, against an average of ${Math.round(average)} a week.`,
          evidence: { week: lastWeek, jobs: lastCount, average },
        });
      } else if (lastCount <= Math.min(...others) && lastCount < average * 0.6) {
        events.push({
          dedupeKey: `intake_low:${lastWeek}`,
          headline: "Quietest workshop week in six months",
          body: `The week of ${formatDay(lastWeek)} took in ${plural(lastCount, "job")}, against an average of ${Math.round(average)} a week.`,
          evidence: { week: lastWeek, jobs: lastCount, average },
        });
      }
    }
    const jobsNext7 = [...promised.entries()].filter(([date]) => date >= today).reduce((sum, [, count]) => sum + count, 0);
    const hoursNext7 = [...roster.values()].reduce((sum, entry) => sum + entry.hours, 0);
    const line = `${plural(jobsNext7, "bike")} promised back in the next 7 days`
      + (connected(context, "deputy") ? ` · ${Math.round(hoursNext7)} rostered hours` : "")
      + ` · ${plural(lastCount, "job")} in last week (avg ${Math.round(average)})`;
    return evaluation(events, line, { jobsNext7, hoursNext7, lastWeek: lastCount, average: Math.round(average) });
  },
};

// ---------------------------------------------------------------------------
// 6. Consumable hit zero

const stockout: AlertTrigger = {
  key: "stockout",
  async run(context, load) {
    if (!connected(context, "lightspeed-r")) return skipped("Needs Lightspeed.");
    const { today } = context;
    const outRows = await load("items at zero with recent sales", {
      dimensions: [
        "inventory_analytics.items_name",
        "inventory_analytics.categories_full_path_name",
        "inventory_analytics.quantity_on_hand",
        "inventory_analytics.last_sold_at",
      ],
      measures: ["inventory_analytics.units_sold_90d"],
      segments: ["inventory_analytics.store_positions"],
      filters: [
        { member: "inventory_analytics.quantity_on_hand", operator: "lte", values: ["0"] },
        { member: "inventory_analytics.items_item_type", operator: "equals", values: ["default"] },
      ],
      order: { "inventory_analytics.units_sold_90d": "desc" },
      limit: 150,
    });
    const receivedRows = await load("items received on purchase orders in 12 months", {
      dimensions: ["inventory_analytics.items_name"],
      measures: ["inventory_analytics.inventory_logs_units_added"],
      filters: [{ member: "inventory_analytics.inventory_logs_reason", operator: "equals", values: ["checkinPurchaseOrderInventory"] }],
      timeDimensions: [{ dimension: "inventory_analytics.inventory_logs_occurred_at", dateRange: [addDays(today, -365), today] }],
      limit: 2_000,
    });
    const received = new Set(receivedRows.map((row) => str(row, "inventory_analytics.items_name")).filter(Boolean));
    const out = outRows
      .map((row) => ({
        item: shortName(str(row, "inventory_analytics.items_name")),
        category: str(row, "inventory_analytics.categories_full_path_name"),
        sold90: num(row, "inventory_analytics.units_sold_90d"),
        lastSold: day(row, "inventory_analytics.last_sold_at"),
      }))
      .filter((entry) => entry.item && entry.sold90 >= 3 && received.has(entry.item));
    const events: AlertEventDraft[] = [];
    const recent = out.filter((entry) => entry.lastSold && daysBetween(entry.lastSold, today) <= 14);
    for (const entry of recent) {
      const perWeek = Math.round((entry.sold90 / 13) * 10) / 10;
      events.push({
        dedupeKey: `stockout:${entry.item}:${entry.lastSold}`,
        headline: `Out of stock: ${entry.item}`,
        body: `${entry.item} hit zero on ${formatDay(entry.lastSold!)}. It sold ${plural(Math.round(entry.sold90), "unit")} in the last 90 days, `
          + `about ${perWeek} a week.`,
        evidence: { item: entry.item, category: entry.category, sold90: entry.sold90, lastSold: entry.lastSold },
      });
    }
    const older = out.filter((entry) => !recent.includes(entry));
    if (older.length > 0 && digestsDue(context)) {
      events.push({
        dedupeKey: `stockout_digest:${monthKey(today)}`,
        headline: "Stocked items sitting at zero",
        body: `${plural(older.length, "stocked item")} ${older.length === 1 ? "is" : "are"} at zero with sales in the last 90 days. `
          + `Fastest: ${listInEnglish(older.slice(0, 4).map((entry) => `${entry.item} (${Math.round(entry.sold90)})`))}.`,
        evidence: { count: older.length, top: older.slice(0, 8).map((entry) => ({ item: entry.item, sold90: entry.sold90 })) },
      });
    }
    const line = `${plural(out.length, "stocked item")} at zero with sales in the last 90 days`;
    return evaluation(events, line, { atZero: out.length, recentlyOut: recent.length });
  },
};

// ---------------------------------------------------------------------------
// 7. Bike on the floor a year

const agedBike: AlertTrigger = {
  key: "aged_bike",
  async run(context, load) {
    if (!connected(context, "lightspeed-r")) return skipped("Needs Lightspeed.");
    const { today } = context;
    const rows = await load("bikes in stock over $1,500 cost", {
      dimensions: [
        "inventory_analytics.items_name",
        "inventory_analytics.manufacturers_name",
        "inventory_analytics.quantity_on_hand",
        "inventory_analytics.average_unit_cost",
        "inventory_analytics.days_since_last_receipt",
        "inventory_analytics.last_received_at",
      ],
      measures: ["inventory_analytics.stock_value"],
      segments: ["inventory_analytics.store_positions", "inventory_analytics.in_stock"],
      filters: [
        { member: "inventory_analytics.categories_full_path_name", operator: "startsWith", values: ["Bikes"] },
        { member: "inventory_analytics.average_unit_cost", operator: "gte", values: ["1500"] },
      ],
      order: { "inventory_analytics.days_since_last_receipt": "desc" },
      limit: 300,
    });
    const bikes = rows.map((row) => ({
      item: shortName(str(row, "inventory_analytics.items_name")),
      brand: str(row, "inventory_analytics.manufacturers_name"),
      units: num(row, "inventory_analytics.quantity_on_hand"),
      cost: num(row, "inventory_analytics.average_unit_cost"),
      age: num(row, "inventory_analytics.days_since_last_receipt"),
      received: day(row, "inventory_analytics.last_received_at"),
      value: num(row, "inventory_analytics.stock_value"),
    })).filter((bike) => bike.item);
    const events: AlertEventDraft[] = [];
    for (const bike of bikes) {
      if (bike.age < 365 || bike.age % 365 > 14) continue;
      const years = Math.floor(bike.age / 365);
      events.push({
        dedupeKey: `aged:${bike.item}:${years}`,
        headline: `A bike just passed ${years === 1 ? "a year" : `${years} years`} on the floor`,
        body: `${bike.item}${bike.brand && !/generic/iu.test(bike.brand) ? ` (${bike.brand})` : ""} landed ${bike.received ? formatDayWithYear(bike.received) : `${bike.age} days ago`} `
          + `and has now been on the floor ${years === 1 ? "a year" : `${years} years`}, ${money(bike.cost)} at cost.`,
        evidence: { item: bike.item, brand: bike.brand, cost: bike.cost, ageDays: bike.age, years },
      });
    }
    const aged = bikes.filter((bike) => bike.age >= 365);
    const agedValue = aged.reduce((sum, bike) => sum + bike.value, 0);
    if (aged.length > 0 && digestsDue(context)) {
      const oldest = aged[0]!;
      events.push({
        dedupeKey: `aged_digest:${monthKey(today)}`,
        headline: "Bikes over a year on the floor",
        body: `${plural(aged.length, "bike")} ${aged.length === 1 ? "has" : "have"} been in stock over a year, ${money(agedValue)} at cost. `
          + `Oldest: ${oldest.item} (${(oldest.age / 365).toFixed(1)} years).`,
        evidence: { count: aged.length, value: agedValue, oldest: oldest.item, oldestAgeDays: oldest.age },
      });
    }
    // A brand is "new and unsold" when its whole range sold nothing in a
    // year, not merely the positions received lately: brands with units
    // landing in the last six months, then their sales across every position.
    const brandRows = await load("brands received in six months", {
      dimensions: ["inventory_analytics.manufacturers_name"],
      measures: ["inventory_analytics.units_on_hand"],
      segments: ["inventory_analytics.store_positions", "inventory_analytics.in_stock"],
      filters: [{ member: "inventory_analytics.last_received_at", operator: "inDateRange", values: [addDays(today, -180), today] }],
      limit: 300,
    });
    const candidates = brandRows
      .map((row) => ({ brand: str(row, "inventory_analytics.manufacturers_name"), units: num(row, "inventory_analytics.units_on_hand") }))
      .filter((entry) => entry.brand && !/generic/iu.test(entry.brand) && entry.units >= 3);
    const soldByBrand = new Map<string, number>();
    if (candidates.length > 0) {
      const soldRows = await load("brand sales in 12 months", {
        dimensions: ["inventory_analytics.manufacturers_name"],
        measures: ["inventory_analytics.units_sold_365d"],
        segments: ["inventory_analytics.store_positions"],
        filters: [{ member: "inventory_analytics.manufacturers_name", operator: "equals", values: candidates.map((entry) => entry.brand).slice(0, 100) }],
        limit: 300,
      });
      for (const row of soldRows) {
        soldByBrand.set(str(row, "inventory_analytics.manufacturers_name"), num(row, "inventory_analytics.units_sold_365d"));
      }
    }
    let unsoldBrands = 0;
    for (const { brand, units } of candidates) {
      const sold = soldByBrand.get(brand) ?? 0;
      if (sold > 0) continue;
      unsoldBrands += 1;
      events.push({
        dedupeKey: `brand_unsold:${brand}`,
        headline: "A new brand hasn't sold",
        body: `${brand}: ${plural(Math.round(units), "unit")} on hand from the last six months and nothing sold yet.`,
        evidence: { brand, units, sold365: sold },
      });
    }
    const line = `${plural(aged.length, "bike")} over a year old, ${money(agedValue)} at cost`
      + (unsoldBrands > 0 ? ` · ${plural(unsoldBrands, "new brand")} unsold` : "");
    return evaluation(events, line, { aged: aged.length, agedValue, unsoldBrands });
  },
};

// ---------------------------------------------------------------------------
// 8. Labour and roster

const labourRoster: AlertTrigger = {
  key: "labour_roster",
  async run(context, load) {
    if (!connected(context, "deputy")) return skipped("Needs Deputy.");
    const { today, yesterday } = context;
    const events: AlertEventDraft[] = [];
    let labourLine = "";
    const metrics: Record<string, string | number | null> = {};
    if (connected(context, "lightspeed-r")) {
      const weekRows = await load("labour against takings by week", {
        measures: [
          "workforce_analytics.labour_sales_gross_takings",
          "workforce_analytics.labour_sales_wage_cost",
          "workforce_analytics.labour_sales_hours_worked",
        ],
        timeDimensions: [{ dimension: "workforce_analytics.labour_sales_date", granularity: "week", dateRange: [startOfWeek(addDays(today, -98)), yesterday] }],
        limit: 30,
      });
      const weeks = new Map<IsoDate, { takings: number; wages: number; hours: number }>();
      for (const row of weekRows) {
        const date = day(row, "workforce_analytics.labour_sales_date.week") ?? day(row, "workforce_analytics.labour_sales_date");
        if (!date) continue;
        weeks.set(date, {
          takings: num(row, "workforce_analytics.labour_sales_gross_takings"),
          wages: num(row, "workforce_analytics.labour_sales_wage_cost"),
          hours: num(row, "workforce_analytics.labour_sales_hours_worked"),
        });
      }
      const lastWeek = addDays(startOfWeek(today), -7);
      const latest = weeks.get(lastWeek);
      const others = [...weeks.entries()]
        .filter(([key, entry]) => key !== lastWeek && key < lastWeek && entry.takings >= 3_000 && entry.wages > 0)
        .map(([, entry]) => (entry.wages / entry.takings) * 100);
      const usual = others.length > 0 ? others.reduce((a, b) => a + b, 0) / others.length : null;
      if (latest && latest.takings >= 3_000 && latest.wages > 0) {
        const share = (latest.wages / latest.takings) * 100;
        labourLine = `Labour ${percent(share)} of takings last week${usual !== null ? ` (usual ${percent(usual)})` : ""}`;
        metrics.labourShare = Math.round(share * 10) / 10;
        metrics.usualShare = usual !== null ? Math.round(usual * 10) / 10 : null;
        if (share >= 30 && digestsDue(context)) {
          events.push({
            dedupeKey: `labour:${lastWeek}`,
            headline: "Labour ran heavy last week",
            body: `Week of ${formatDay(lastWeek)}: wages were ${percent(share)} of takings (${money(latest.wages)} on ${money(latest.takings)})`
              + `${usual !== null ? ` against your usual ${percent(usual)}` : ""}. ${Math.round(latest.hours)} hours worked.`,
            evidence: { week: lastWeek, share, usual, wages: latest.wages, takings: latest.takings, hours: latest.hours },
          });
        }
      } else if (latest) {
        labourLine = `Last week's labour not yet costed`;
      }
    }
    const leaveRows = await load("leave requests", {
      dimensions: [
        "workforce_analytics.leave_staff",
        "workforce_analytics.leave_starts",
        "workforce_analytics.leave_ends",
        "workforce_analytics.leave_status",
      ],
      measures: ["workforce_analytics.leave_request_count"],
      timeDimensions: [{ dimension: "workforce_analytics.leave_starts", dateRange: [addDays(today, -7), addDays(today, 120)] }],
      limit: 100,
    });
    let pending = 0;
    for (const row of leaveRows) {
      const staff = str(row, "workforce_analytics.leave_staff");
      const starts = day(row, "workforce_analytics.leave_starts");
      const ends = day(row, "workforce_analytics.leave_ends") ?? starts;
      const status = str(row, "workforce_analytics.leave_status");
      if (!staff || !starts || !ends) continue;
      const span = `${formatDay(starts)} to ${formatDay(ends)}`;
      if (/await|pending/iu.test(status)) {
        pending += 1;
        events.push({
          dedupeKey: `leave_pending:${staff}:${starts}`,
          headline: "A leave request is waiting",
          body: `${staff} has asked for ${span} (${plural(daysBetween(starts, ends) + 1, "day")}). It's awaiting approval in Deputy.`,
          evidence: { staff, starts, ends, status },
        });
      } else if (/approved/iu.test(status)) {
        const year = starts.slice(0, 4);
        const peakStart = `${year}-11-01`;
        const peakEnd = `${year}-12-24`;
        if (starts <= peakEnd && ends >= peakStart) {
          events.push({
            dedupeKey: `leave_peak:${staff}:${starts}`,
            headline: "Leave approved in the peak",
            body: `${staff} has leave approved ${span}, in the run-up to Christmas, your busiest weeks.`,
            evidence: { staff, starts, ends, status },
          });
        }
      }
    }
    let gaps = 0;
    if (connected(context, "lightspeed-r")) {
      const tradingRows = await load("trading days by weekday", {
        measures: ["sales_analytics.transactions"],
        timeDimensions: [{ dimension: "sales_analytics.completed_at", granularity: "day", dateRange: [addDays(today, -56), yesterday] }],
        limit: 100,
      });
      const tradedDays = new Set<IsoDate>();
      for (const row of tradingRows) {
        const date = day(row, "sales_analytics.completed_at.day") ?? day(row, "sales_analytics.completed_at");
        if (date && num(row, "sales_analytics.transactions") > 0) tradedDays.add(date);
      }
      const tradesOn = new Map<number, number>();
      for (let offset = 1; offset <= 56; offset += 1) {
        const date = addDays(today, -offset);
        const weekday = isoWeekday(date);
        if (tradedDays.has(date)) tradesOn.set(weekday, (tradesOn.get(weekday) ?? 0) + 1);
      }
      const rosterRows = await load("roster for the next fortnight", {
        measures: ["workforce_analytics.rostered_shift_count"],
        timeDimensions: [{ dimension: "workforce_analytics.rostered_date", granularity: "day", dateRange: [addDays(today, 1), addDays(today, 14)] }],
        limit: 30,
      });
      const rostered = new Set<IsoDate>();
      for (const row of rosterRows) {
        const date = day(row, "workforce_analytics.rostered_date.day") ?? day(row, "workforce_analytics.rostered_date");
        if (date && num(row, "workforce_analytics.rostered_shift_count") > 0) rostered.add(date);
      }
      for (let offset = 1; offset <= 14; offset += 1) {
        const date = addDays(today, offset);
        if ((tradesOn.get(isoWeekday(date)) ?? 0) < 4 || rostered.has(date)) continue;
        gaps += 1;
        if (gaps > 3) continue;
        events.push({
          dedupeKey: `roster_gap:${date}`,
          headline: "Nobody rostered",
          body: `${formatDay(date)} has nobody rostered yet, and the shop usually trades on ${weekdayName(date)}s.`,
          evidence: { date },
        });
      }
    }
    const line = [labourLine, `${plural(pending, "leave request")} waiting`, gaps > 0 ? `${plural(gaps, "unrostered trading day")} in the next fortnight` : ""]
      .filter(Boolean).join(" · ");
    return evaluation(events, line || "Roster and leave look in order", { ...metrics, pendingLeave: pending, rosterGaps: gaps });
  },
};

// ---------------------------------------------------------------------------
// 9. Supplier bills

const SUPPLIER_NOISE = /(bicycles|bicycle|bikes|bike|cycles|cycle|cycling|australia|aust|sports|sport|distribution|trading|imports|import|wholesale|limited|pty|ltd|au|nz)$/u;

function normaliseSupplier(name: string): string {
  let compact = name
    .toLowerCase()
    .replace(/\b(pty|ltd|p\/l|limited|australia|aust|au|nz|bicycles?|bikes?|cycles?|cycling|sports?|distribution|trading|imports?|wholesale)\b/gu, " ")
    .replace(/[^a-z0-9]/gu, "");
  // "LordGunBicycles" carries its noise without a word boundary: peel it off the end.
  for (;;) {
    const stripped = compact.replace(SUPPLIER_NOISE, "");
    if (stripped === compact || stripped.length < 3) break;
    compact = stripped;
  }
  return compact;
}

function editDistanceAtMost(a: string, b: string, limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit) return false;
  const previous = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;
    let rowMin = previous[0]!;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = previous[j]!;
      previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = temp;
      rowMin = Math.min(rowMin, previous[j]!);
    }
    if (rowMin > limit) return false;
  }
  return previous[b.length]! <= limit;
}

function lookAlike(a: string, b: string): boolean {
  const left = normaliseSupplier(a);
  const right = normaliseSupplier(b);
  if (left.length < 3 || right.length < 3) return false;
  if (left === right) return true;
  if (left.length >= 8 && right.length >= 8 && editDistanceAtMost(left, right, 2)) return true;
  // A typo inside a noise word ("Wholesal8e") survives normalisation; compare the raw spellings too.
  const rawLeft = a.toLowerCase().replace(/[^a-z0-9]/gu, "");
  const rawRight = b.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return rawLeft.length >= 8 && rawRight.length >= 8 && editDistanceAtMost(rawLeft, rawRight, 2);
}

const supplierBills: AlertTrigger = {
  key: "supplier_bills",
  async run(context, load) {
    if (!connected(context, "xero")) return skipped("Needs Xero.");
    const { today } = context;
    const xeroThrough = dataThrough(context, "xero");
    const xeroNote = xeroThrough ? ` Xero synced to ${formatDay(localDate(new Date(xeroThrough), context.timezone))}.` : "";
    const recentRows = await load("bills in the last week", {
      dimensions: [
        "xero_finance_analytics.invoice_contact",
        "xero_finance_analytics.invoice_number",
        "xero_finance_analytics.issued_on",
        "xero_finance_analytics.due_on",
        "xero_finance_analytics.invoice_status",
      ],
      measures: ["xero_finance_analytics.total_invoiced", "xero_finance_analytics.total_amount_due"],
      segments: ["xero_finance_analytics.bills", "xero_finance_analytics.financially_real"],
      timeDimensions: [{ dimension: "xero_finance_analytics.issued_on", dateRange: [addDays(today, -7), today] }],
      limit: 300,
    });
    const recent = recentRows.map((row) => ({
      contact: str(row, "xero_finance_analytics.invoice_contact"),
      number: str(row, "xero_finance_analytics.invoice_number"),
      issued: day(row, "xero_finance_analytics.issued_on"),
      total: num(row, "xero_finance_analytics.total_invoiced"),
    })).filter((bill) => bill.contact);
    const contacts = [...new Set(recent.map((bill) => bill.contact))];
    const prior = new Map<string, { count: number; max: number }>();
    if (contacts.length > 0) {
      const priorRows = await load("earlier bills from the same suppliers", {
        dimensions: ["xero_finance_analytics.invoice_contact", "xero_finance_analytics.invoice_number"],
        measures: ["xero_finance_analytics.total_invoiced"],
        segments: ["xero_finance_analytics.bills", "xero_finance_analytics.financially_real"],
        filters: [{ member: "xero_finance_analytics.invoice_contact", operator: "equals", values: contacts.slice(0, 100) }],
        timeDimensions: [{ dimension: "xero_finance_analytics.issued_on", dateRange: [addDays(today, -1_460), addDays(today, -8)] }],
        limit: 2_000,
      });
      for (const row of priorRows) {
        const contact = str(row, "xero_finance_analytics.invoice_contact");
        const total = num(row, "xero_finance_analytics.total_invoiced");
        const entry = prior.get(contact) ?? { count: 0, max: 0 };
        entry.count += 1;
        entry.max = Math.max(entry.max, total);
        prior.set(contact, entry);
      }
    }
    const events: AlertEventDraft[] = [];
    const seenNew = new Set<string>();
    for (const bill of recent) {
      const history = prior.get(bill.contact);
      if (!history && !seenNew.has(bill.contact)) {
        seenNew.add(bill.contact);
        events.push({
          dedupeKey: `new_supplier:${bill.contact}`,
          headline: "First bill from a new supplier",
          body: `${bill.contact}: ${money(bill.total)}${bill.issued ? ` on ${formatDay(bill.issued)}` : ""}${bill.number ? ` (bill ${bill.number})` : ""}. `
            + "No earlier bills in Xero.",
          evidence: { contact: bill.contact, total: bill.total, number: bill.number, issued: bill.issued },
        });
      } else if (history && history.count >= 3 && bill.total >= 2_000 && bill.total > history.max * 1.5) {
        events.push({
          dedupeKey: `big_bill:${bill.contact}:${bill.number || bill.issued}`,
          headline: `Biggest bill from ${bill.contact} in years`,
          body: `${bill.contact} billed ${money(bill.total)}${bill.issued ? ` on ${formatDay(bill.issued)}` : ""}; `
            + `their largest before that was ${money(history.max)}.`,
          evidence: { contact: bill.contact, total: bill.total, previousMax: history.max },
        });
      }
    }
    const supplierRows = await load("supplier contacts", {
      dimensions: ["xero_finance_analytics.contact_name"],
      measures: ["xero_finance_analytics.contact_count"],
      segments: ["xero_finance_analytics.suppliers"],
      limit: 1_000,
    });
    const suppliers = supplierRows.map((row) => str(row, "xero_finance_analytics.contact_name")).filter(Boolean);
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < suppliers.length; i += 1) {
      for (let j = i + 1; j < suppliers.length; j += 1) {
        if (lookAlike(suppliers[i]!, suppliers[j]!)) pairs.push([suppliers[i]!, suppliers[j]!]);
      }
    }
    for (const [a, b] of pairs) {
      if (!contacts.includes(a) && !contacts.includes(b)) continue;
      events.push({
        dedupeKey: `dup_contact:${[a, b].sort().join("|")}`,
        headline: "Two supplier names look the same",
        body: `A bill just landed under '${contacts.includes(a) ? a : b}' but you also have '${contacts.includes(a) ? b : a}'. `
          + "Merge them in Xero or the supplier spend splits.",
        evidence: { pair: [a, b] },
      });
    }
    if (pairs.length > 0 && digestsDue(context)) {
      events.push({
        dedupeKey: `dup_digest:${monthKey(today)}`,
        headline: "Supplier names that look like duplicates",
        body: `${plural(pairs.length, "pair")} of supplier contacts look like the same business: `
          + `${listInEnglish(pairs.slice(0, 6).map(([a, b]) => `'${a}' and '${b}'`))}. Merging them keeps supplier spend whole.`,
        evidence: { pairs: pairs.slice(0, 12) },
      });
    }
    const outstandingRows = await load("bills outstanding", {
      dimensions: ["xero_finance_analytics.invoice_contact", "xero_finance_analytics.invoice_number", "xero_finance_analytics.due_on"],
      measures: ["xero_finance_analytics.total_amount_due"],
      segments: ["xero_finance_analytics.bills", "xero_finance_analytics.outstanding", "xero_finance_analytics.financially_real"],
      limit: 400,
    });
    const outstanding = outstandingRows.map((row) => ({
      contact: str(row, "xero_finance_analytics.invoice_contact"),
      number: str(row, "xero_finance_analytics.invoice_number"),
      due: day(row, "xero_finance_analytics.due_on"),
      amount: num(row, "xero_finance_analytics.total_amount_due"),
    })).filter((bill) => bill.amount > 0);
    const overdue = outstanding.filter((bill) => bill.due && bill.due < today);
    const dueSoon = outstanding.filter((bill) => bill.due && bill.due >= today && bill.due <= addDays(today, 7));
    const overdueTotal = overdue.reduce((sum, bill) => sum + bill.amount, 0);
    const dueSoonTotal = dueSoon.reduce((sum, bill) => sum + bill.amount, 0);
    const week = startOfWeek(today);
    if (digestsDue(context)) {
      if (overdue.length > 0) {
        const byContact = new Map<string, number>();
        for (const bill of overdue) byContact.set(bill.contact, (byContact.get(bill.contact) ?? 0) + bill.amount);
        const top = [...byContact.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
        events.push({
          dedupeKey: `overdue_digest:${week}`,
          headline: "Bills past due",
          body: `${plural(overdue.length, "bill")} past due, ${money(overdueTotal)}: `
            + `${listInEnglish(top.map(([contact, amount]) => `${contact} ${money(amount)}`))}.${xeroNote}`,
          evidence: { count: overdue.length, total: overdueTotal, top },
        });
      }
      if (dueSoon.length > 0) {
        events.push({
          dedupeKey: `due_digest:${week}`,
          headline: "Bills due this week",
          body: `${plural(dueSoon.length, "bill")} due in the next 7 days, ${money(dueSoonTotal)}: `
            + `${listInEnglish(dueSoon.slice(0, 4).map((bill) => `${bill.contact} ${money(bill.amount)}${bill.due ? ` ${formatDay(bill.due)}` : ""}`))}.${xeroNote}`,
          evidence: { count: dueSoon.length, total: dueSoonTotal },
        });
      }
    }
    const openTotal = outstanding.reduce((sum, bill) => sum + bill.amount, 0);
    const line = `${plural(recent.length, "bill")} in the last week · ${plural(outstanding.length, "bill")} open (${money(openTotal)}) · ${overdue.length} past due (${money(overdueTotal)})`
      + (xeroNote ? ` ·${xeroNote.replace(/\.$/u, "")}` : "");
    return evaluation(events, line, { recentBills: recent.length, open: outstanding.length, openTotal, overdue: overdue.length, overdueTotal, lookAlikes: pairs.length });
  },
};

// ---------------------------------------------------------------------------
// 10. Till and refunds

const cashIntegrity: AlertTrigger = {
  key: "cash_integrity",
  async run(context, load) {
    if (!connected(context, "lightspeed-r")) return skipped("Needs Lightspeed.");
    const { today, yesterday } = context;
    const events: AlertEventDraft[] = [];
    const countRows = await load("register counts in 45 days", {
      dimensions: [
        "cash_management_analytics.register_count_id",
        "cash_management_analytics.counted_at",
        "cash_management_analytics.amounts_tender_type",
        "cash_management_analytics.amounts_variance_amount",
        "cash_management_analytics.amounts_expected_amount",
        "cash_management_analytics.amounts_counted_amount",
      ],
      timeDimensions: [{ dimension: "cash_management_analytics.counted_at", dateRange: [addDays(today, -45), today] }],
      order: { "cash_management_analytics.counted_at": "desc" },
      limit: 600,
    });
    const counts = new Map<string, { date: IsoDate; cashVariance: number | null; expected: number; counted: number }>();
    for (const row of countRows) {
      const id = idOf(row, "cash_management_analytics.register_count_id");
      const date = day(row, "cash_management_analytics.counted_at");
      if (!id || !date) continue;
      const entry = counts.get(id) ?? { date, cashVariance: null, expected: 0, counted: 0 };
      if (/cash/iu.test(str(row, "cash_management_analytics.amounts_tender_type"))) {
        entry.cashVariance = num(row, "cash_management_analytics.amounts_variance_amount");
        entry.expected = num(row, "cash_management_analytics.amounts_expected_amount");
        entry.counted = num(row, "cash_management_analytics.amounts_counted_amount");
      }
      counts.set(id, entry);
    }
    const tradingRows = await load("trading days in 45 days", {
      measures: ["sales_analytics.transactions"],
      timeDimensions: [{ dimension: "sales_analytics.completed_at", granularity: "day", dateRange: [addDays(today, -45), yesterday] }],
      limit: 60,
    });
    const tradingDays: IsoDate[] = [];
    for (const row of tradingRows) {
      const date = day(row, "sales_analytics.completed_at.day") ?? day(row, "sales_analytics.completed_at");
      if (date && num(row, "sales_analytics.transactions") > 0) tradingDays.push(date);
    }
    const lastCount = [...counts.values()].map((entry) => entry.date).sort().pop() ?? null;
    const sinceCount = lastCount ? tradingDays.filter((date) => date > lastCount).length : tradingDays.length;
    if (lastCount && sinceCount >= 3 && digestsDue(context)) {
      const perMonth = Math.round(counts.size / 1.5);
      events.push({
        dedupeKey: `till_uncounted:${lastCount}`,
        headline: "The till hasn't been counted",
        body: `The till was last counted ${formatDay(lastCount)}; ${plural(sinceCount, "trading day")} since. `
          + `Before that it was counted about ${plural(perMonth, "time")} a month.`,
        evidence: { lastCount, tradingDaysSince: sinceCount, countsIn45Days: counts.size },
      });
    }
    let variances = 0;
    for (const [id, entry] of counts) {
      if (entry.cashVariance === null || Math.abs(entry.cashVariance) < 50) continue;
      variances += 1;
      if (daysBetween(entry.date, today) > 3) continue;
      events.push({
        dedupeKey: `till_variance:${id}`,
        headline: `Cash count ${entry.cashVariance > 0 ? "over" : "short"} by ${money(Math.abs(entry.cashVariance))}`,
        body: `The ${formatDay(entry.date)} count was ${entry.cashVariance > 0 ? "over" : "short"} by ${money(Math.abs(entry.cashVariance))} `
          + `(expected ${money(entry.expected)}, counted ${money(entry.counted)}).`,
        evidence: { registerCountId: id, date: entry.date, variance: entry.cashVariance },
      });
    }
    if (daySettled(context, "lightspeed-r", yesterday)) {
      const refundRows = await load("refunds yesterday", {
        dimensions: ["sales_analytics.sale_id", "sales_analytics.customers_full_name", "sales_analytics.employees_full_name"],
        measures: ["sales_analytics.refund_value"],
        segments: ["sales_analytics.refunds"],
        timeDimensions: [{ dimension: "sales_analytics.completed_at", dateRange: [yesterday, yesterday] }],
        limit: 100,
      });
      for (const row of refundRows) {
        const value = num(row, "sales_analytics.refund_value");
        if (value > -500) continue;
        const customer = str(row, "sales_analytics.customers_full_name");
        const employee = str(row, "sales_analytics.employees_full_name");
        events.push({
          dedupeKey: `refund:${idOf(row, "sales_analytics.sale_id")}`,
          headline: `A ${money(Math.abs(value))} refund went through`,
          body: `${employee || "Someone"} processed a ${money(Math.abs(value))} refund${customer ? ` for ${customer}` : ""} on ${formatDay(yesterday)}.`,
          evidence: { saleId: idOf(row, "sales_analytics.sale_id"), value, customer, employee },
        });
      }
      const lineRows = await load("stock lines sold yesterday", {
        dimensions: ["product_sales_analytics.sale_line_id", "product_sales_analytics.items_name", "product_sales_analytics.unit_quantity"],
        measures: ["product_sales_analytics.line_net_revenue", "product_sales_analytics.line_cost_of_goods"],
        filters: [{ member: "product_sales_analytics.items_item_type", operator: "equals", values: ["default"] }],
        timeDimensions: [{ dimension: "product_sales_analytics.completed_at", dateRange: [yesterday, yesterday] }],
        limit: 500,
      });
      const belowCost = lineRows
        .map((row) => ({
          item: shortName(str(row, "product_sales_analytics.items_name"), 40),
          net: num(row, "product_sales_analytics.line_net_revenue"),
          cost: num(row, "product_sales_analytics.line_cost_of_goods"),
          quantity: num(row, "product_sales_analytics.unit_quantity"),
        }))
        .filter((line) => line.quantity > 0 && line.cost > 0 && line.net < line.cost * 0.98);
      if (belowCost.length > 0) {
        events.push({
          dedupeKey: `below_cost:${yesterday}`,
          headline: `${plural(belowCost.length, "item")} sold below cost`,
          body: `On ${formatDay(yesterday)}: ${listInEnglish(belowCost.slice(0, 4).map((line) => `${line.item} (${money(line.net)} against ${money(line.cost)} cost)`))}.`,
          evidence: { date: yesterday, count: belowCost.length, lines: belowCost.slice(0, 8) },
        });
      }
      const adjustmentRows = await load("stock adjustments yesterday", {
        dimensions: ["inventory_analytics.inventory_logs_reason"],
        measures: [
          "inventory_analytics.inventory_logs_units_added",
          "inventory_analytics.inventory_logs_units_removed",
          "inventory_analytics.inventory_logs_value_change_estimate",
        ],
        timeDimensions: [{ dimension: "inventory_analytics.inventory_logs_occurred_at", dateRange: [yesterday, yesterday] }],
        limit: 50,
      });
      let added = 0;
      let removed = 0;
      let value = 0;
      for (const row of adjustmentRows) {
        if (!/count|manualadjust/iu.test(str(row, "inventory_analytics.inventory_logs_reason"))) continue;
        added += num(row, "inventory_analytics.inventory_logs_units_added");
        removed += num(row, "inventory_analytics.inventory_logs_units_removed");
        value += num(row, "inventory_analytics.inventory_logs_value_change_estimate");
      }
      if (added + removed >= 100 || Math.abs(value) >= 2_000) {
        events.push({
          dedupeKey: `stocktake:${yesterday}`,
          headline: "A big stock adjustment landed",
          body: `Stock counts and manual adjustments on ${formatDay(yesterday)} removed ${plural(Math.round(removed), "unit")} and added ${Math.round(added)}, `
            + `about ${money(value)} at cost.`,
          evidence: { date: yesterday, added, removed, value },
        });
      }
    }
    const weekRows = await load("discounts by week", {
      measures: ["sales_analytics.discounts_given", "sales_analytics.gross_takings"],
      timeDimensions: [{ dimension: "sales_analytics.completed_at", granularity: "week", dateRange: [startOfWeek(addDays(today, -70)), yesterday] }],
      limit: 20,
    });
    const weeks = new Map<IsoDate, { discounts: number; takings: number }>();
    for (const row of weekRows) {
      const date = day(row, "sales_analytics.completed_at.week") ?? day(row, "sales_analytics.completed_at");
      if (date) weeks.set(date, { discounts: num(row, "sales_analytics.discounts_given"), takings: num(row, "sales_analytics.gross_takings") });
    }
    const lastWeek = addDays(startOfWeek(today), -7);
    const latest = weeks.get(lastWeek);
    const usualShares = [...weeks.entries()].filter(([key, entry]) => key < lastWeek && entry.takings >= 3_000).map(([, entry]) => (entry.discounts / entry.takings) * 100);
    const usual = usualShares.length > 0 ? usualShares.reduce((a, b) => a + b, 0) / usualShares.length : null;
    if (latest && latest.takings >= 3_000 && digestsDue(context)) {
      const share = (latest.discounts / latest.takings) * 100;
      if (share >= 8) {
        events.push({
          dedupeKey: `discounts:${lastWeek}`,
          headline: "Heavy discounting last week",
          body: `Week of ${formatDay(lastWeek)}: discounts were ${percent(share, 1)} of takings (${money(latest.discounts)} on ${money(latest.takings)})`
            + `${usual !== null ? ` against your usual ${percent(usual, 1)}` : ""}.`,
          evidence: { week: lastWeek, share, usual, discounts: latest.discounts, takings: latest.takings },
        });
      }
    }
    const line = `Till last counted ${lastCount ? formatDay(lastCount) : "over 45 days ago"} · ${plural(variances, "count")} out by $50+ in 45 days`;
    return evaluation(events, line, { lastCount, tradingDaysSinceCount: sinceCount, variances });
  },
};

export const ALERT_TRIGGERS: readonly AlertTrigger[] = Object.freeze([
  tradingDay,
  bikeSold,
  vipCustomer,
  workshopUncollected,
  workshopLoad,
  stockout,
  agedBike,
  labourRoster,
  supplierBills,
  cashIntegrity,
]);

export const ALERT_TRIGGER_BY_KEY_IMPL: Readonly<Record<AlertTriggerKey, AlertTrigger>> = Object.freeze(
  Object.fromEntries(ALERT_TRIGGERS.map((trigger) => [trigger.key, trigger])) as Record<AlertTriggerKey, AlertTrigger>,
);

export { lookAlike as supplierNamesLookAlike, normaliseSupplier };
