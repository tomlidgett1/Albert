# Lightspeed Retail (R-Series) — semantic analysis guide

You are answering a shop owner. They speak shop. Lightspeed speaks sales, sale lines,
items, categories, workorders, orders. This page is the bridge: what the owner's words
usually mean, which table honestly answers them, and which correct-looking query is
commercially wrong. The table index tells you what exists; the dimension guide gives
the deep rules for the current question's territory.

Lightspeed is **operational truth**: what was rung up, what is on the shelf, what is on
the workshop board, who bought it. Xero is **financial truth**: invoices, bills, GST,
bank. They share no ids. Never join across them; answer from one and say which.

Everything lives in `source_lightspeed.*` and every queryable table starts with `ls_`.
Use the injected table index and dictionaries as the source of truth for what the
current connector exposes; never assume a merchant's table population, location,
timezone, catalogue, staff, or trading history from an example tenant.

---

## 1. Three gates before any number

**Gate 1 — `tombstone = false`.** Always, unless the owner asked about deleted records.

**Gate 2 — one pack generation only.** Staging can hold more than one connector pack
generation side by side (`mapping_version`). Where generations overlap, a plain
`COUNT(*)` or `SUM()` can silently duplicate records.

Resolve the current generation **by ingest recency**, once, and reuse it:

```sql
WITH pack AS (
  SELECT mapping_version AS mv
  FROM source_lightspeed.ls_sales
  GROUP BY 1 ORDER BY max(ingested_at) DESC LIMIT 1
)
```

**Do not use `max(mapping_version)`** — versions are text, so lexical ordering is not
recency ordering and can silently select an old or partial generation.

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
| "how many of *[named product]*" | one SKU | resolve to `item_id`, then `ls_sale_lines` |
| "gen services", "brake bleeds" | one named service item | resolve to `item_id` (service items, §4) |
| "how's the workshop going" | service revenue, not the job board | `ls_sale_lines.is_workorder = true` |
| "what's on the board", "how many jobs open" | the job board | `ls_workorders`; first verify header coverage |
| "what's the cash", "did the till balance" | tenders and drawer | `ls_sale_payments`, `ls_register_count_amounts` |
| "what have we got", "how much stock" | on-hand right now | `ls_item_shops` (snapshot, no history) |
| "what's on order" | supplier POs | `ls_purchase_orders` + `ls_purchase_order_lines` |
| "orders" | **almost never** POs — they mean customer sales | `ls_sales` |
| "who's our best customer" | identified customers only | `ls_customers` + sales; disclose walk-ins |
| "who sold the most" | who rang the ticket | `ls_sales.employee_id` |
| "what did we make on it" | margin | `calc_total - calc_tax1 - calc_tax2 - calc_fifo_cost` |

Three habits worth keeping:

- **Decide the grain before you resolve the name.** "Any glasses sold" is a category
  question; "how did this named model go" is a SKU question. Resolving first and then letting
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
`name` and `full_path_name` (slash-delimited). Items attach to **one** node at any depth, so roll a
branch up with `full_path_name LIKE 'Parent/%' OR full_path_name = 'Parent'`. Leaf names
collide across branches — group and display by `full_path_name`, never by `name` alone.

Merchant language rarely equals catalogue spelling. Resolve category names from the
current tenant with a bounded `ILIKE` search on both `name` and `full_path_name`.
If multiple branches match, aggregate all defensible matches and name the reading, or
ask when the alternatives materially change the answer.

Do not rely on a category label projected onto the item row. Join `ls_categories` on
`ls_items.category_id` and use its `name` / `full_path_name`.

**`category_id = 0` means uncategorised, not category zero.** Any `LEFT JOIN` on categories must expect it, and any
"uncategorised" count must treat 0 as the bucket, not as a real node.

**Services and labour.** Services can live in the item catalogue like any product. A
useful classification signal is the tax class:
`ls_items.tax_class->>'name' = 'Labor'` (or `->>'classType' = 'service'`).
`item_type = 'non_inventory'` is a supporting signal. Inspect the tenant's actual
category and tax-class values before defining a service population; category alone may
under-count service revenue.

**Fuzzy service names can have close, wrong neighbours.** Search and rank the current
catalogue. When several peers match, either aggregate the defensible set and say you
did, or name the one you picked. Do not silently take the top match.

**`item_id = 0` is "no catalogue item", not item zero.** It may represent miscellaneous
charges or labour. Product rankings must exclude `item_id = 0` (not
`IS NULL`, which matches nothing) or an unnamed bucket tops the chart.

**Other zero-as-null fields.** Lightspeed writes `0` rather than null into unset foreign
keys throughout: `customer_id` on walk-in sales (collapsing them gives one phantom
mega-customer), `manufacturer_id`, `item_matrix_id`, `employee_id`,
`register_id`, `sale_id` on workorders. Treat 0 as absent everywhere.

**Brands are not suppliers.** `ls_manufacturers` is who makes it; `ls_vendors` is who
you buy it from. An item has one manufacturer and can have many vendors. Brand casing is
inconsistent in real data — `UPPER(TRIM(name))` before grouping.

**Variants.** Every colour and size is its own `ls_items` row. "How many products do we
sell" is rarely `COUNT(*)`: it is standalone items plus distinct `item_matrix_id`
families.

---

## 5. Establish tenant coverage from evidence

Answering "zero" when a table was never synced is worse than saying the data is not
available. Population is tenant-specific and must be measured, never injected.

- For a table central to the requested metric, run a bounded coverage check in the
  current pack: row count, relevant non-null count, and min/max business date when useful.
- Distinguish **empty** (no rows), **sparse/partial** (rows exist but do not support the
  requested population), and **observed zero** (the relevant, adequately covered
  population was queried and its measure is zero).
- Cross-check parent/header coverage against child tables where completeness matters,
  such as `ls_workorders` versus its line/item tables, or purchase-order headers versus
  lines. A populated child table does not repair missing header state.
- Prefer raw operational facts when a summary/report table is empty, but only when the
  raw tables carry the same business meaning. Explain the alternate basis.
- Never carry table counts, dates, staff names, categories, payment types, timezone, or
  availability conclusions from one tenant into another.

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
- **Timezone.** Read `ls_shops.time_zone` and bucket each shop in its own IANA timezone.
  Never hardcode a reference tenant's timezone. For multi-shop accounts, join on
  `shop_id`; a single account-wide UTC or server-time bucket is arithmetically wrong.
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

- **Wages and labour cost.** No pay rate or salary exists in these Lightspeed tables.
  `ls_shops.service_rate` is what the shop *charges*, not
  what it pays. Never multiply hours by it.
- **Stock as at a past date.** `ls_item_shops` is a live snapshot. A historical position
  can only be reconstructed by running `ls_inventory_logs` backwards, and it will not
  tie if items were archived or levels bulk-imported.
- **Price history.** Historical charged prices come from sale lines. Do not treat a
  current catalogue price as a historical price; if current price fields are unpopulated
  for the tenant, say so.
- **Workshop board history.** Status is overwritten in place; "how many jobs were open
  at the end of last month" needs a snapshot nobody took.
- **Turnaround time.** There is no completed-at on a job. The defensible proxy is the
  linked sale's completion time.
- **Card brand mix, gateway outcomes, processing fees.** Only claim these when the
  corresponding tenant tables are populated; tender type alone does not prove card brand
  or processing cost.
- **Profit after expenses, BAS, payroll.** That is Xero's half of the business.
