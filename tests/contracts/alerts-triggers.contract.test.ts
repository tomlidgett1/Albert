import assert from "node:assert/strict";
import test from "node:test";

import {
  ALERT_BUBBLES_PER_DELIVERY,
  alertEventText,
  packAlertBubbles,
} from "../../services/alerts/src/contracts.ts";
import { addDays, formatDay, localDate, money, startOfWeek } from "../../services/alerts/src/dates.ts";
import { evaluateAlerts, freshnessDigest } from "../../services/alerts/src/evaluate.ts";
import {
  ALERT_TRIGGER_BY_KEY_IMPL,
  ALERT_TRIGGERS,
  alertContext,
  namedCustomer,
  supplierNamesLookAlike,
  type AlertQueryLoader,
  type AlertRows,
} from "../../services/alerts/src/triggers.ts";

/** 10:30 in Melbourne on Friday 28 Aug 2026: yesterday is Thursday 27 Aug. */
const NOW = new Date("2026-08-28T00:30:00.000Z");
const TZ = "Australia/Melbourne";

function context(overrides: Partial<Parameters<typeof alertContext>[0]> = {}) {
  return alertContext({
    now: NOW,
    timezone: TZ,
    activeConnectors: ["lightspeed-r", "deputy", "xero"],
    freshness: [],
    ...overrides,
  });
}

function loader(fixtures: Readonly<Record<string, AlertRows>>): AlertQueryLoader & { labels: string[] } {
  const labels: string[] = [];
  const load = (async (label: string) => {
    labels.push(label);
    return fixtures[label] ?? [];
  }) as AlertQueryLoader & { labels: string[] };
  load.labels = labels;
  return load;
}

function dailyTakings(entries: ReadonlyArray<readonly [string, number, number]>): AlertRows {
  return entries.map(([date, takings, transactions]) => ({
    "sales_analytics.completed_at.day": `${date}T00:00:00.000`,
    "sales_analytics.completed_at": `${date}T00:00:00.000`,
    "sales_analytics.gross_takings": String(takings),
    "sales_analytics.transactions": String(transactions),
  }));
}

test("calendar helpers speak the tenant's local dates", () => {
  assert.equal(localDate(NOW, TZ), "2026-08-28");
  assert.equal(addDays("2026-08-28", -1), "2026-08-27");
  assert.equal(startOfWeek("2026-08-28"), "2026-08-24");
  assert.equal(formatDay("2026-08-27"), "Thu 27 Aug");
  assert.equal(money(11993.67), "$11,994");
  assert.equal(money(-2400), "-$2,400");
  const ctx = context();
  assert.equal(ctx.today, "2026-08-28");
  assert.equal(ctx.yesterday, "2026-08-27");
  assert.equal(ctx.localHour, 10);
});

test("trading day fires a record when yesterday beat the last twelve months, and a dead day when staffed for nothing", async () => {
  const record = loader({
    "daily takings for 400 days": dailyTakings([
      ["2026-05-09", 8751, 19],
      ["2026-08-26", 462, 5],
      ["2026-08-27", 11993.67, 11],
    ]),
    "staff hours yesterday": [{ "workforce_analytics.hours_worked": "26.5" }],
  });
  const evaluation = await ALERT_TRIGGER_BY_KEY_IMPL.trading_day.run(context(), record);
  assert.equal(evaluation.result.status, "fired");
  assert.equal(evaluation.events.length, 1);
  assert.equal(evaluation.events[0]!.dedupeKey, "record:2026-08-27");
  assert.equal(evaluation.events[0]!.headline, "Biggest day in a year");
  assert.match(evaluation.events[0]!.body, /Thu 27 Aug did \$11,994 from 11 sales/u);
  assert.match(evaluation.events[0]!.body, /\$8,751 on Sat 9 May/u);
  assert.match(evaluation.result.line, /best day in 12 months \$8,751/u);

  const dead = loader({
    "daily takings for 400 days": dailyTakings([["2026-05-09", 8751, 19], ["2026-08-27", 10, 3]]),
    "staff hours yesterday": [{ "workforce_analytics.hours_worked": "9" }],
  });
  const quiet = await ALERT_TRIGGER_BY_KEY_IMPL.trading_day.run(context(), dead);
  assert.deepEqual(quiet.events.map((event) => event.dedupeKey), ["dead:2026-08-27"]);
  assert.match(quiet.events[0]!.body, /9 staff hours on the clock and \$10 from 3 sales/u);

  // Nothing fires until Lightspeed has synced past yesterday.
  const waiting = await ALERT_TRIGGER_BY_KEY_IMPL.trading_day.run(
    context({ freshness: [{ connector: "lightspeed-r", domain: "sales", dataThrough: "2026-08-27T02:00:00.000Z" }] }),
    record,
  );
  assert.equal(waiting.result.status, "waiting");
  assert.equal(waiting.events.length, 0);
});

test("stock-outs fire per item only when a stocked item just hit zero, and roll the rest into one digest", async () => {
  const load = loader({
    "items at zero with recent sales": [
      {
        "inventory_analytics.items_name": "Gear Inner Wire",
        "inventory_analytics.categories_full_path_name": "Parts/Drivetrain",
        "inventory_analytics.quantity_on_hand": "0.0000",
        "inventory_analytics.last_sold_at": "2026-08-26T17:05:21.000",
        "inventory_analytics.units_sold_90d": "56.0000",
      },
      {
        "inventory_analytics.items_name": "Old Cassette",
        "inventory_analytics.categories_full_path_name": "Parts/Drivetrain",
        "inventory_analytics.quantity_on_hand": "0.0000",
        "inventory_analytics.last_sold_at": "2026-06-01T10:00:00.000",
        "inventory_analytics.units_sold_90d": "4.0000",
      },
      {
        "inventory_analytics.items_name": "Never Ordered Gel",
        "inventory_analytics.categories_full_path_name": "Nutrition",
        "inventory_analytics.quantity_on_hand": "0.0000",
        "inventory_analytics.last_sold_at": "2026-08-27T10:00:00.000",
        "inventory_analytics.units_sold_90d": "21.0000",
      },
    ],
    "items received on purchase orders in 12 months": [
      { "inventory_analytics.items_name": "Gear Inner Wire", "inventory_analytics.inventory_logs_units_added": "50" },
      { "inventory_analytics.items_name": "Old Cassette", "inventory_analytics.inventory_logs_units_added": "6" },
    ],
  });
  const evaluation = await ALERT_TRIGGER_BY_KEY_IMPL.stockout.run(context(), load);
  assert.deepEqual(evaluation.events.map((event) => event.dedupeKey), [
    "stockout:Gear Inner Wire:2026-08-26",
    "stockout_digest:2026-08",
  ]);
  assert.match(evaluation.events[0]!.body, /sold 56 units in the last 90 days, about 4.3 a week/u);
  assert.match(evaluation.result.line, /^2 stocked items at zero/u);
});

test("supplier bills spot a first bill, a look-alike name and the Monday digests", async () => {
  const load = loader({
    "bills in the last week": [
      {
        "xero_finance_analytics.invoice_contact": "LordGunBicycles",
        "xero_finance_analytics.invoice_number": "4401",
        "xero_finance_analytics.issued_on": "2026-08-27T00:00:00.000",
        "xero_finance_analytics.due_on": "2026-09-10T00:00:00.000",
        "xero_finance_analytics.invoice_status": "AUTHORISED",
        "xero_finance_analytics.total_invoiced": "564.00000000",
        "xero_finance_analytics.total_amount_due": "564.00000000",
      },
      {
        "xero_finance_analytics.invoice_contact": "Pon Bike",
        "xero_finance_analytics.invoice_number": "4402",
        "xero_finance_analytics.issued_on": "2026-08-26T00:00:00.000",
        "xero_finance_analytics.due_on": "2026-09-26T00:00:00.000",
        "xero_finance_analytics.invoice_status": "AUTHORISED",
        "xero_finance_analytics.total_invoiced": "18000.00000000",
        "xero_finance_analytics.total_amount_due": "18000.00000000",
      },
    ],
    "earlier bills from the same suppliers": [
      { "xero_finance_analytics.invoice_contact": "Pon Bike", "xero_finance_analytics.invoice_number": "1", "xero_finance_analytics.total_invoiced": "10823" },
      { "xero_finance_analytics.invoice_contact": "Pon Bike", "xero_finance_analytics.invoice_number": "2", "xero_finance_analytics.total_invoiced": "5000" },
      { "xero_finance_analytics.invoice_contact": "Pon Bike", "xero_finance_analytics.invoice_number": "3", "xero_finance_analytics.total_invoiced": "4000" },
    ],
    "supplier contacts": [
      { "xero_finance_analytics.contact_name": "Lordgun" },
      { "xero_finance_analytics.contact_name": "LordGunBicycles" },
      { "xero_finance_analytics.contact_name": "Pon Bike" },
      { "xero_finance_analytics.contact_name": "Shimano" },
    ],
    "bills outstanding": [
      {
        "xero_finance_analytics.invoice_contact": "Apollo Bicycle",
        "xero_finance_analytics.invoice_number": "4300",
        "xero_finance_analytics.due_on": "2026-08-20T00:00:00.000",
        "xero_finance_analytics.total_amount_due": "3590.00",
      },
      {
        "xero_finance_analytics.invoice_contact": "KWT",
        "xero_finance_analytics.invoice_number": "4301",
        "xero_finance_analytics.due_on": "2026-09-01T00:00:00.000",
        "xero_finance_analytics.total_amount_due": "1032.00",
      },
    ],
  });
  const evaluation = await ALERT_TRIGGER_BY_KEY_IMPL.supplier_bills.run(
    context({ freshness: [{ connector: "xero", domain: "invoices", dataThrough: "2026-08-18T03:27:00.000Z" }] }),
    load,
  );
  const keys = evaluation.events.map((event) => event.dedupeKey);
  assert.deepEqual(keys, [
    "new_supplier:LordGunBicycles",
    "big_bill:Pon Bike:4402",
    "dup_contact:LordGunBicycles|Lordgun",
    "dup_digest:2026-08",
    "overdue_digest:2026-08-24",
    "due_digest:2026-08-24",
  ]);
  assert.match(evaluation.events[1]!.body, /billed \$18,000 on Wed 26 Aug; their largest before that was \$10,823/u);
  assert.match(evaluation.events[4]!.body, /1 bill past due, \$3,590: Apollo Bicycle \$3,590\. Xero synced to Tue 18 Aug\./u);
  assert.ok(supplierNamesLookAlike("Shimano Australia", "Shimano"));
  assert.ok(supplierNamesLookAlike("Bicycle Parts Wholesale", "Bicycle Parts Wholesal8e"));
  assert.ok(!supplierNamesLookAlike("C6", "cSixx"));
  assert.ok(!supplierNamesLookAlike("KASK", "KWT"));
});

test("placeholder customers are nobody, and the till trigger notices an uncounted register", async () => {
  assert.equal(namedCustomer("Unnamed customer"), "");
  assert.equal(namedCustomer("Walk-in"), "");
  assert.equal(namedCustomer("  Max  Figgins "), "Max Figgins");
  const load = loader({
    "register counts in 45 days": [
      {
        "cash_management_analytics.register_count_id": "2127.0000",
        "cash_management_analytics.counted_at": "2026-08-09T15:48:16.000",
        "cash_management_analytics.amounts_tender_type": "cash",
        "cash_management_analytics.amounts_variance_amount": "0.0000",
        "cash_management_analytics.amounts_expected_amount": "404.7",
        "cash_management_analytics.amounts_counted_amount": "404.7",
      },
    ],
    "trading days in 45 days": dailyTakings([
      ["2026-08-10", 300, 3], ["2026-08-11", 800, 9], ["2026-08-12", 1200, 12], ["2026-08-27", 11993, 11],
    ]),
    "discounts by week": [],
  });
  const evaluation = await ALERT_TRIGGER_BY_KEY_IMPL.cash_integrity.run(context(), load);
  assert.deepEqual(evaluation.events.map((event) => event.dedupeKey), ["till_uncounted:2026-08-09"]);
  assert.match(evaluation.events[0]!.body, /last counted Sun 9 Aug; 4 trading days since/u);
});

test("the evaluator isolates a failing trigger and reports every other reading", async () => {
  const throwing: AlertQueryLoader = async (label) => {
    if (label === "open workshop jobs") throw new Error("Cube is down");
    return [];
  };
  const report = await evaluateAlerts({ triggers: ALERT_TRIGGERS, context: context(), load: throwing });
  assert.equal(Object.keys(report.results).length, 10);
  assert.equal(report.results.workshop_uncollected?.result.status, "error");
  assert.match(report.results.workshop_uncollected?.result.error ?? "", /Cube is down/u);
  assert.equal(report.errors, 1);
  assert.equal(report.failedQueries, 1);
  assert.ok(report.queries > 10);
  for (const [key, evaluation] of Object.entries(report.results)) {
    if (key === "workshop_uncollected") continue;
    assert.notEqual(evaluation.result.status, "error", key);
  }
  assert.equal(freshnessDigest([{ connector: "xero", domain: "a", dataThrough: "x" }]), freshnessDigest([{ connector: "xero", domain: "a", dataThrough: "x" }]));
  assert.notEqual(freshnessDigest([]), freshnessDigest([{ connector: "xero", domain: "a", dataThrough: "x" }]));
});

test("texts read as a bold Heads up headline and pack into a bounded number of bubbles", () => {
  const text = alertEventText({ headline: "Biggest day in a year.", body: "Thu 27 Aug did $11,994 from 11 sales." });
  assert.equal(text.text, "Heads up: Biggest day in a year\nThu 27 Aug did $11,994 from 11 sales.");
  assert.deepEqual(text.bold, [0, "Heads up: Biggest day in a year".length]);
  const events = Array.from({ length: 14 }, (_, index) => ({ headline: `Event ${index + 1}`, body: `Body ${index + 1}` }));
  const bubbles = packAlertBubbles(events);
  assert.equal(bubbles.length, ALERT_BUBBLES_PER_DELIVERY);
  assert.equal(bubbles[0]!.bold.length, 4);
  assert.match(bubbles[bubbles.length - 1]!.text, /…and 2 more in the Alerts tab\.$/u);
  for (const bubble of bubbles) {
    for (const [start, end] of bubble.bold) {
      assert.match(bubble.text.slice(start, end), /^Heads up: Event \d+$/u);
    }
  }
});
