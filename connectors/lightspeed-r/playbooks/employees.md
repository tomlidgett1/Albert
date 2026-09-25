# Employees & registers dimension — staff, tills, cash control

Primary tables: `ls_employees` (+ roles/rights) · `ls_registers` ·
`ls_register_counts` · `ls_register_count_amounts` · `ls_register_withdraws` ·
`ls_sale_voids`. Performance questions join back to `ls_sales.employee_id`.

## Employee rules

- **Names:** `first_name` + `last_name` (no `full_name` column). Filter
  `archived = false` for the current roster, but keep archived rows for historical
  attribution.
- **"Who sold the most"** is `ls_sales.employee_id` (who rang the ticket). Exclude
  `employee_id = 0` (unattributed), never invent a "House" employee.
- **Wages and pay rates do not exist** in these Lightspeed tables. Hours may exist in
  `ls_employee_hours`; first verify tenant coverage. Even when hours exist, labour cost
  does not. Say so; never approximate it from `ls_shops.service_rate`.
- **Void-abuse check:** `ls_sale_voids` records who voided what — compare its
  `employee_id` against the voided sale's own `employee_id`.

## Register / cash rules

- **Till sessions:** `ls_register_counts` (one row per open/close; `create_time` is the
  close, `open_time` the open — not `closed_at`/`opened_at`).
- **Over/short is `actual - calculated`** on `ls_register_count_amounts` (per tender
  per session). Staff routinely skip counting card tenders, leaving `actual = 0`
  against a large expected figure — a huge apparent card shortage almost always means
  "not counted". Filter `actual <> 0` before ranking variances.
- **Floats and payouts:** `ls_register_withdraws`.
- **`ls_register_calculated`** is a live drawer view. Verify tenant coverage; historical
  drawer questions use the register-count tables.

## Worked shape

"Who sold the most this month":

```sql
WITH pack AS (
  SELECT mapping_version AS mv FROM source_lightspeed.ls_sales
  GROUP BY 1 ORDER BY max(ingested_at) DESC LIMIT 1
)
SELECT e.first_name || ' ' || e.last_name AS employee,
       COUNT(*)          AS tickets,
       SUM(s.calc_total) AS sales_inc_gst
FROM source_lightspeed.ls_sales s
JOIN source_lightspeed.ls_employees e ON e.employee_id = s.employee_id
  AND e.mapping_version = (SELECT mv FROM pack) AND NOT e.tombstone
JOIN source_lightspeed.ls_shops sh ON sh.shop_id = s.shop_id
  AND sh.mapping_version = (SELECT mv FROM pack) AND NOT sh.tombstone
WHERE s.mapping_version = (SELECT mv FROM pack) AND NOT s.tombstone
  AND s.completed AND NOT s.voided
  AND s.employee_id <> 0
  AND s.complete_time AT TIME ZONE sh.time_zone >= date_trunc('month', now() AT TIME ZONE sh.time_zone)
GROUP BY 1
ORDER BY sales_inc_gst DESC;
```

If the owner asks about margin per person or profit per labour hour, that needs a
confirmed preference (`employee.net_sales` / `employee.gross_margin` /
`employee.gross_profit_per_labour_hour`) — and labour-hour variants are unavailable
without time-clock data.
