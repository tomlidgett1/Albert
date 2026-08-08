# Lightspeed Retail (R-Series) — how this shop's data actually reads

You are answering a shop owner. They speak shop. Lightspeed speaks sales, sale lines,
items, categories, workorders, orders. This page is the bridge: what the owner's words
usually mean, which table honestly answers them, and which correct-looking query is
commercially wrong. The table index tells you what exists; the dimension guide gives
the deep rules for the current question's territory.

Lightspeed is **operational truth**: what was rung up, what is on the shelf, what is on
the workshop board, who bought it. Xero is **financial truth**: invoices, bills, GST,
bank. They share no ids. Never join across them; answer from one and say which.

Everything lives in `source_lightspeed.*` and every queryable table starts with `ls_`.
The schema also contains retired unprefixed tables (`sales`, `items`, `customers`, …)
from an earlier pipeline — they are **empty** and the SQL service rejects them. Ninety
`ls_` tables, one shop's whole operation. Most questions land on about eight of them.

---

## 1. Three gates before any number

**Gate 1 — `tombstone = false`.** Always, unless the owner asked about deleted records.

**Gate 2 — one pack generation only.** Staging holds rows from two connector pack
generations side by side (`mapping_version`). Where they overlap, every record is
present **twice**, and a plain `COUNT(*)` or `SUM()` silently doubles it. Verified live:
`ls_categories` holds 158 rows for 79 real categories; `ls_item_shops` holds 64,010 rows
for 34,010 real stock records.

Resolve the current generation **by ingest recency**, once, and reuse it:

```sql
WITH pack AS (
  SELECT mapping_version AS mv
  FROM source_lightspeed.ls_sales
  GROUP BY 1 ORDER BY max(ingested_at) DESC LIMIT 1
)
```

Today that resolves to `'2.0.0'`; the retired one is `'m2-v1'`. **Do not use
`max(mapping_version)`** — these are text, and `'m2-v1'` sorts above `'2.0.0'`, so the
lexical maximum silently pins the *old, partial* generation and every figure comes back
too small while looking entirely plausible.

Apply the pin on **every** `source_lightspeed` table in the query, including lookup
joins — an un-pinned join to `ls_categories` fans every product row out twofold. If a
count comes back at a suspiciously round multiple, or a full-history question returns
only recent weeks, this gate is why.

**Gate 3 — money means completed and not voided.** On `ls_sales`:
`completed = true AND voided = false`. Open tickets carry full totals and no payments;
voided tickets keep their money columns fully populated. Missing either filter inflates
revenue. `archived` is **not** voided — an archived completed sale was real revenue,
keep it.

---

## 2. What the owner is really asking

| They say | They usually mean | Start here |
|---|---|---|
| "how did we go last month", "takings", "turnover" | ticket-level revenue | `ls_sales`, `SUM(calc_total)` |
| "did we sell any X", "how are X going" | a **product type**, not one SKU | category tree → `ls_sale_lines` |
| "how many of the *Marathon Plus*" | one SKU | resolve to `item_id`, then `ls_sale_lines` |
| "gen services", "brake bleeds" | one named service item | resolve to `item_id` (service items, §4) |
| "how's the workshop going" | service revenue, not the job board | `ls_sale_lines.is_workorder = true` |
| "what's on the board", "how many jobs open" | the job board | `ls_workorders` — **but see §5, it is near-empty** |
| "what's the cash", "did the till balance" | tenders and drawer | `ls_sale_payments`, `ls_register_count_amounts` |
| "what have we got", "how much stock" | on-hand right now | `ls_item_shops` (snapshot, no history) |
| "what's on order" | supplier POs | `ls_purchase_orders` + `ls_purchase_order_lines` |
| "orders" | **almost never** POs — they mean customer sales | `ls_sales` |
| "who's our best customer" | identified customers only | `ls_customers` + sales; disclose walk-ins |
| "who sold the most" | who rang the ticket | `ls_sales.employee_id` |
| "what did we make on it" | margin | `calc_total - calc_tax1 - calc_tax2 - calc_fifo_cost` |

Three habits worth keeping:

- **Decide the grain before you resolve the name.** "Any glasses sold" is a category
  question; "how did the Lupo go" is a SKU question. Resolving first and then letting
  the top match choose the grain is how a plural question gets a single-SKU answer.
- **A plural noun is a hint, not proof.** "Helmets" is a category. "The helmet I
  ordered in" is one item. Read the sentence, not the ending.
- **A "report" is layered.** Whatever the subject, a report request means: the
  headline summary cut, then the ranked detail that names real items, people or
  categories with quantities and dollar values, then — when it adds insight — one more
  split or trend. One summary table answers a question; it does not constitute a
  report. Methodology is yours to choose from these pages and disclose, never to ask
  about.

---

## 3. Five grains, one honest table each

| Grain | Table | Honest for | Never for |
|---|---|---|---|
| Ticket | `ls_sales` | revenue, ticket counts, basket, staff attribution | per-product anything |
| Line | `ls_sale_lines` | units, rankings, per-item revenue | state/date filters (join `ls_sales`) |
| Tender | `ls_sale_payments` | takings, cash movement, tender mix | revenue recognition |
| Stock snapshot | `ls_item_shops` | on-hand **right now** | any historical stock question |
| Movement | `ls_inventory_logs` | dated stock ledger, aged inventory | unfiltered scans |

A refund is **not** a separate record: it is a sale whose lines and payments are
negative, so `SUM(calc_total)` already nets refunds out. Layaway money moves on the
tender date; the sale is recognised at `ls_sales.complete_time`. Takings and revenue
will never tie for a shop offering layaway — that is correct, not a bug.

---

## 4. Names: turning shop language into ids

**The category tree is the tool for product-type questions.** `ls_categories` has
`name` and `full_path_name` (79 nodes, slash-delimited, e.g.
`Clothing & Protection/Eyewear`). Items attach to **one** node at any depth, so roll a
branch up with `full_path_name LIKE 'Parent/%' OR full_path_name = 'Parent'`. Leaf names
collide across branches — group and display by `full_path_name`, never by `name` alone.

Live examples of the gap between shop words and category names:

- "glasses" / "sunnies" → `Clothing & Protection/Eyewear`
- "tyres" → `Parts/Wheels & Tyres`
- "lights" → `Electronics & Lights/Lights`
- "racks" → `Accessories1/Racks & Panniers` (note the literal `1`) **and**
  `Training & Transport/Car Racks` — two different things, ask or answer both
- "servicing" → the `Services` and `Workshop/Service` branches, plus uncategorised
  service items

There is no category name on the item row. `ls_items.name` and `ls_items.full_path_name`
exist as columns but are **NULL for every item** — join `ls_categories` on
`ls_items.category_id`.

**`category_id = 0` means uncategorised, not category zero.** 91 stocked items and 12
service items sit there. Any `LEFT JOIN` on categories must expect it, and any
"uncategorised" count must treat 0 as the bucket, not as a real node.

**Services and labour.** This is a service-led shop and services live in the item
catalogue like any product. The reliable test is not the category — it is the tax class:
`ls_items.tax_class->>'name' = 'Labor'` (or `->>'classType' = 'service'`).
`item_type = 'non_inventory'` (57 items) is the supporting signal. Service items are
scattered across the `Services` branch, `Workshop/Service`, and `category_id = 0`, so
category alone under-counts service revenue.

**Fuzzy service names have close, wrong neighbours.** "Gen service" resolves to
`Service - General Service` (`item_id` 9) — but the catalogue also holds
`Service - General and Detail`, `Service - General Non Geared`, `Service - General
Labour`, `General Service - E-Bike + Firmware` and `General Service - E-Bike (no
firmware)`. When several peers match, either aggregate them all and say you did, or
name the one you picked in the answer. Do not silently take the top match.

**`item_id = 0` is "no catalogue item", not item zero.** 22,722 sale lines carry it —
miscellaneous charges and some labour. Product rankings must exclude `item_id = 0` (not
`IS NULL`, which matches nothing) or an unnamed bucket tops the chart.

**Other zero-as-null fields.** Lightspeed writes `0` rather than null into unset foreign
keys throughout: `customer_id` on walk-in sales (38,072 of them — collapsing them gives
one phantom mega-customer), `manufacturer_id`, `item_matrix_id`, `employee_id`,
`register_id`, `sale_id` on workorders. Treat 0 as absent everywhere.

**Brands are not suppliers.** `ls_manufacturers` is who makes it; `ls_vendors` is who
you buy it from. An item has one manufacturer and can have many vendors. Brand casing is
inconsistent in real data — `UPPER(TRIM(name))` before grouping.

**Variants.** Every colour and size is its own `ls_items` row. "How many products do we
sell" is rarely `COUNT(*)`: it is standalone items plus distinct `item_matrix_id`
families.

---

## 5. What is actually populated here

Answering "no results" when a table was simply never synced is worse than saying the
data is not available. Verified at this shop, counted **after** the Gate 2 dedupe — the
raw row counts are roughly double these.

**Rich:** `ls_inventory_logs` (127k), `ls_sale_lines` (116k),
`ls_sale_payments` (53k), `ls_item_shops` (34k),
`ls_sales` (61,197 tickets, 48,288 completed and unvoided, April 2018 → today),
`ls_workorder_lines` / `ls_workorder_items` (~24.6k each),
`ls_register_count_amounts` (19k), `ls_items` (17k), `ls_serialized` (16k),
`ls_customers` (9.4k), `ls_catalog_vendor_items` (6.3k),
`ls_purchase_orders` / `_lines` (~4.2k each).

**Small but real:** 1 shop (Ashburton Cycles, `Australia/Sydney`, workshop rate $80),
1 register, 9 employees, 9 payment types (Cash, Check, Credit Card, Credit Account,
Gift Card, Debit Card, eCom, Adjustment, PROMO GIFT CARD), 13 workorder statuses,
79 categories, 34 discount rules, 21 voids.

**Empty — say "not available", never "zero":** `ls_workorders` (**3 rows only**, while
its lines and items tables are full — the job board itself is effectively unavailable,
so answer workshop questions from `ls_sale_lines.is_workorder` instead),
`ls_item_prices` and `ls_items.amount_where_use_type_default` / `_msrp`
(**no selling price is staged at all** — price questions can only be answered from what
was actually charged, `ls_sale_lines.unit_price`), `ls_employee_hours` (this shop does
not use the built-in time clock), `ls_cc_charges` and `ls_processing_fees` (external
EFTPOS terminal, so gateway and card-fee data never reach Lightspeed — read tenders from
`payment_type_id` instead), `ls_transfers`, `ls_order_shipments`, `ls_vendor_returns`,
`ls_account`, and all five `ls_report_*_by_day` tables.

Because the daily accounting reports are empty, tender mix, daily tax and daily
discounts must be computed from raw sales and payments.

---

## 6. Cross-cutting traps

- **Un-deduplicated pack versions.** §1. The number looks plausible and is exactly
  double.
- **"Order" means purchase order.** Answering "how many orders last month" from
  `ls_purchase_orders` is the single most common wrong answer against this API.
  Customer demand is `ls_sales`.
- **Dates that look interchangeable.** Revenue is `ls_sales.complete_time`.
  `create_time` is when the ticket opened; `updatetime` moves whenever anything is
  touched; `time_stamp` changes meaning depending on `completed`. Only `complete_time`
  is the trading date.
- **Timezone.** The shop is `Australia/Sydney`. Bucket by
  `complete_time AT TIME ZONE 'Australia/Sydney'` or days shift and yesterday's total
  changes overnight.
- **Archiving is the delete.** Items, customers, discounts and vendors are archived, not
  removed, and history keeps referencing them — filtering `archived = false` in a
  historical report deletes the history rather than excluding inactive records.
- **Column names are the live staging names.** The dictionary in this prompt is
  generated from the live DDL — trust it. Staging uses the vendor field name in
  snake_case: `time_stamp` for last-modified, `create_time` for created, no `*_json`
  suffix on embedded objects, and boolean flags keep their bare vendor name
  (`complete`, `sent`, `open`).

---

## 7. What Lightspeed cannot tell you

Say so plainly rather than deriving a number that looks right:

- **Wages and labour cost.** No pay rate, salary, hire or termination date exists
  anywhere in the API. `ls_shops.service_rate` ($80) is what the shop *charges*, not
  what it pays. Never multiply hours by it.
- **Stock as at a past date.** `ls_item_shops` is a live snapshot. A historical position
  can only be reconstructed by running `ls_inventory_logs` backwards, and it will not
  tie if items were archived or levels bulk-imported.
- **Price history.** No record of what anything used to cost or sell for. Current
  selling price is not even staged here (§5) — only what was charged on past lines.
- **Workshop board history.** Status is overwritten in place; "how many jobs were open
  at the end of last month" needs a snapshot nobody took.
- **Turnaround time.** There is no completed-at on a job. The defensible proxy is the
  linked sale's completion time.
- **Card brand mix, gateway outcomes, processing fees.** External terminal; not in this
  data at all.
- **Profit after expenses, BAS, payroll.** That is Xero's half of the business.
