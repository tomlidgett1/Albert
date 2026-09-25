# Sales dimension — revenue, refunds, discounts, tenders, staff attribution

Primary tables: `ls_sales` (ticket) · `ls_sale_lines` (line) · `ls_sale_payments`
(tender) · `ls_payment_types` · `ls_discounts` · `ls_sale_voids` · `ls_quotes` ·
`ls_sale_accounts` (gift-card bridge). Category/product lookups join through
`ls_items` → `ls_categories`.

## Grain rules

**Ticket — `ls_sales`.** One register transaction. Revenue, ticket counts, average
basket, margin at sale level, staff attribution, register and shop splits. A refund is
**not** a separate record: it is a sale whose lines and payments are negative, so
`SUM(calc_total)` already nets refunds out. Gross-before-refunds needs an explicit
`calc_total > 0` split.

**Line — `ls_sale_lines`.** One charge on one ticket. Everything per-product: units,
rankings, per-item revenue, sell-through, returns. **This table carries no state of its
own.** Its `completed` / `voided` / `complete_time` columns exist but are NULL in the
current pack generation. Every line-level revenue query must join `ls_sales` on
`sale_id` and apply Gate 3 there, and date-filter on `ls_sales.complete_time`.
The line's own `create_time` is when the item went in the basket — on a layaway that
can be months early.

**Tender — `ls_sale_payments`.** How money moved. This is takings, not revenue: a
layaway instalment or deposit lands on the day cash moved, while the sale is recognised
at `complete_time`. They will never tie for a shop that offers layaway, and that is
correct, not a bug. Filter `archived = false` — archived payments are reversed tenders
and are independent of whether the sale was voided.
Tender names come from `ls_payment_types.name` via `payment_type_id`.

## Money: which column means what

**Revenue at ticket level.** `calc_total` — grand total including GST, after discounts,
what the POS displays. Four total columns exist and they disagree by design: `total` is
an arithmetic restatement, `displayable_total` adds gift-card face value (double
counts), `total_due` subtracts gift-card and store-credit movement. Pick `calc_total`,
stay with it, never mix them in one query.

**Ex-GST.** At line level use `calc_total - calc_tax1 - calc_tax2`. Do **not** divide by
a presumed tax rate and do **not** use the line's `calc_subtotal`: it is gross of the
line discount. At ticket level `ls_sales.calc_subtotal` is the ex-tax figure and is safe.

**Tax.** Money collected is `calc_tax1 + calc_tax2`. `tax1_rate` is a **fraction**
(0.1 = 10%) and is only a default — any line with its own tax class overrides it, so
never reconstruct tax by multiplying. Read the tenant's tax categories and inclusion
settings; they vary by merchant and can vary within one account.

**Margin.** Gross profit = ex-GST revenue − FIFO cost. `calc_fifo_cost` is the basis
Lightspeed's own profit reports use; `calc_avg_cost` is the alternative. Pick one, never
blend, never compare periods across bases. Cost columns are **ex-tax** while
`calc_total` is **tax-inclusive** — pairing them overstates margin by roughly the GST
rate. FIFO cost is 0 on service lines and on some migrated history, which silently
reports 100% margin; fall back to `avg_cost` when FIFO is 0 and revenue is not, and say
so.

**Discounts.** `ls_sales.calc_discount` is total money given away, positive. At line
level the full markdown is `calc_line_discount + calc_transaction_discount` — the first
alone under-reports every whole-sale discount. `discount_percent` is a **fraction**
(0.2 = 20%) everywhere it appears; reading it as a percent is the easiest 100× error in
this data. `ls_discounts.source_id` separates automatic price rules (0) from loyalty
redemptions (1) from named manual rules (2); loyalty is the cost of a loyalty programme,
not a promotional markdown.

**Refunds.** Negative `unit_quantity` at a **positive** `unit_price`. Never flip the
price sign. The reliable marker of a refund line is `parent_sale_line_id` being set, not
the sign alone (rebate lines are also negative).

**Tips.** `tip_amount` sits **inside** `amount`, not on top. Merchandise money taken is
`SUM(amount - tip_amount)`. Tips are not revenue.

**Gift cards and store credit.** A gift card issue is a negative payment plus an
`ls_sale_accounts` row; the later redemption is an ordinary positive payment on a
different sale. Counting both is double counting. On a Credit Account tender the sign
inverts: positive **debits** the account, negative **deposits** to it.

## Staff attribution

"Who sold the most" is `ls_sales.employee_id` (who rang the ticket), joined to
`ls_employees` (`first_name`, `last_name`). `employee_id = 0` means no attribution —
exclude it, do not invent a "House" employee. `ls_sale_lines.employee_id` exists per
line but is sparsely meaningful; ticket-level attribution is the honest default.
Void-abuse check: compare `ls_sale_voids.employee_id` (who voided) against the sale's
`employee_id` (who rang it).

## Quotes

Measure quote conversion from `ls_sales.quote_id`, never from `ls_quotes.sale_id`,
which is reassigned on every edit.

## Sales traps

- **`ls_sale_lines.customer_id`** is populated only on layaway, special-order and
  workorder lines. Grouping revenue by it drops nearly every ordinary sale and returns a
  small, plausible, wrong number. The buyer is on the parent sale.
- **`ls_sale_lines.avg_cost` / `fifo_cost` behave as line totals**, not per-unit costs,
  despite the documentation. Multiplying by `unit_quantity` double counts COGS.
- **Item-fee lines.** `item_fee_id` set means the row is a levy, not merchandise.
  Counted as a product it inflates units and drags down average selling price.

## Worked shapes

"Show a line graph of monthly sales" — one aggregate, then chart. Do not probe
with `SELECT 1`, pack-only queries, or raw `complete_time` samples first:

```sql
WITH pack AS (
  SELECT mapping_version AS mv FROM source_lightspeed.ls_sales
  GROUP BY 1 ORDER BY max(ingested_at) DESC LIMIT 1
)
SELECT date_trunc('month', s.complete_time AT TIME ZONE sh.time_zone) AS month,
       SUM(s.calc_total) AS sales_inc_gst
FROM source_lightspeed.ls_sales s
JOIN source_lightspeed.ls_shops sh ON sh.shop_id = s.shop_id
  AND sh.mapping_version = (SELECT mv FROM pack) AND NOT sh.tombstone
WHERE s.mapping_version = (SELECT mv FROM pack)
  AND NOT s.tombstone
  AND s.completed
  AND NOT s.voided
  AND s.complete_time IS NOT NULL
GROUP BY 1
ORDER BY 1;
```

Then `make_chart` with `chartType: "line"`, `xKey: "month"`, `yKey: "sales_inc_gst"`.
Answer in one sentence naming the period covered.

"Any glasses sold this year?" — a product-type question, so resolve the tenant's
category tree first rather than assuming a reference-store path:

```sql
WITH pack AS (
  SELECT mapping_version AS mv FROM source_lightspeed.ls_sales
  GROUP BY 1 ORDER BY max(ingested_at) DESC LIMIT 1
), category_match AS (
  SELECT category_id
  FROM source_lightspeed.ls_categories
  WHERE mapping_version = (SELECT mv FROM pack) AND NOT tombstone
    AND (name ILIKE '%glass%' OR name ILIKE '%eyewear%'
         OR full_path_name ILIKE '%glass%' OR full_path_name ILIKE '%eyewear%')
)
SELECT i.description,
       SUM(l.unit_quantity)                                   AS units,
       SUM(l.calc_total)                                      AS revenue_inc_gst,
       SUM(l.calc_total - l.calc_tax1 - l.calc_tax2)           AS revenue_ex_gst
FROM source_lightspeed.ls_sale_lines l
JOIN source_lightspeed.ls_sales s   ON s.sale_id = l.sale_id  AND s.mapping_version = (SELECT mv FROM pack) AND NOT s.tombstone
JOIN source_lightspeed.ls_items i   ON i.item_id = l.item_id   AND i.mapping_version = (SELECT mv FROM pack) AND NOT i.tombstone
JOIN category_match c ON c.category_id = i.category_id
JOIN source_lightspeed.ls_shops sh ON sh.shop_id = s.shop_id
  AND sh.mapping_version = (SELECT mv FROM pack) AND NOT sh.tombstone
WHERE l.mapping_version = (SELECT mv FROM pack) AND NOT l.tombstone
  AND s.completed AND NOT s.voided
  AND s.complete_time AT TIME ZONE sh.time_zone >= date_trunc('year', now() AT TIME ZONE sh.time_zone)
GROUP BY i.description
ORDER BY revenue_inc_gst DESC;
```

Answer in one sentence with the number and the period, and name the assumption:
*"Treating glasses as the matching catalogue category branches."* If it returns
nothing, widen to a bounded `ILIKE` on `i.description` before concluding there were
none — and say which tenant-derived reading you used.

"What was our tender mix last month" — payments, not sales:

```sql
WITH pack AS (
  SELECT mapping_version AS mv FROM source_lightspeed.ls_sale_payments
  GROUP BY 1 ORDER BY max(ingested_at) DESC LIMIT 1
)
SELECT pt.name AS tender,
       SUM(p.amount - COALESCE(p.tip_amount, 0)) AS taken
FROM source_lightspeed.ls_sale_payments p
JOIN source_lightspeed.ls_sales s ON s.sale_id = p.sale_id
  AND s.mapping_version = (SELECT mv FROM pack) AND NOT s.tombstone
  AND s.completed AND NOT s.voided
JOIN source_lightspeed.ls_shops sh ON sh.shop_id = s.shop_id
  AND sh.mapping_version = (SELECT mv FROM pack) AND NOT sh.tombstone
JOIN source_lightspeed.ls_payment_types pt ON pt.payment_type_id = p.payment_type_id
  AND pt.mapping_version = (SELECT mv FROM pack) AND NOT pt.tombstone
WHERE p.mapping_version = (SELECT mv FROM pack) AND NOT p.tombstone
  AND NOT COALESCE(p.archived, false)
  AND p.create_time AT TIME ZONE sh.time_zone >= date_trunc('month', now() AT TIME ZONE sh.time_zone) - interval '1 month'
  AND p.create_time AT TIME ZONE sh.time_zone <  date_trunc('month', now() AT TIME ZONE sh.time_zone)
GROUP BY 1
ORDER BY taken DESC;
```

Disclose that this is money taken (tender date), which differs from recognised revenue
when layaways are involved.
