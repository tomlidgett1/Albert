# Workshop dimension — service revenue, the job board, labour

Primary tables: `ls_sale_lines` (with `is_workorder`) for **revenue** ·
`ls_workorders` / `ls_workorder_lines` / `ls_workorder_items` /
`ls_workorder_statuses` for the **job board** · `ls_serialized` for the bikes.

## Establish board coverage first

The workorder header can be materially sparser than its line and item children on some
connections. Before answering "how many jobs are open", compare coverage and relevant
dates across `ls_workorders`, `ls_workorder_lines`, and `ls_workorder_items`. If headers
are missing or partial, say the board is unavailable for that tenant rather than
presenting the sparse count as the operational total.

**Recognised workshop revenue lives on sales**, not on workorders:
`ls_sale_lines.is_workorder = true`, joined to `ls_sales` for Gate 3 state and
`complete_time`. That is the honest default for "how's the workshop going", "service
revenue", "how busy is the workshop".

## Workshop traps

- **Workorder charges are quotes, not revenue.** Prices on `ls_workorder_lines` and
  `ls_workorder_items` are job-sheet figures. Recognised workshop revenue is on the sale
  created at checkout. Adding both double counts every completed job.
- **Joining a workorder to both its lines and its items** multiplies rows (parts ×
  labour). Aggregate each side in its own subquery.
- **`ls_workorder_lines` has no total column.** Value is
  `unit_price_override * unit_quantity`; where the override is 0 the charge was meant to
  be hours × shop rate, and the rate is not in the data.
- **Statuses are merchant-defined.** Never filter on a guessed status name; read
  `ls_workorder_statuses` first and use its actual values.
- **No turnaround time exists.** There is no completed-at on a job. The defensible
  proxy is the linked sale's completion time, and say it is a proxy.
- **Labour cost is not in the data.** `ls_shops.service_rate` is what the shop
  charges, not what it pays.

## Worked shape

"How is the workshop going this month vs last month":

```sql
WITH pack AS (
  SELECT mapping_version AS mv FROM source_lightspeed.ls_sales
  GROUP BY 1 ORDER BY max(ingested_at) DESC LIMIT 1
)
SELECT date_trunc('month', s.complete_time AT TIME ZONE sh.time_zone) AS month,
       SUM(l.calc_total)     AS workshop_revenue_inc_gst,
       COUNT(DISTINCT s.sale_id) AS tickets_with_workshop
FROM source_lightspeed.ls_sale_lines l
JOIN source_lightspeed.ls_sales s ON s.sale_id = l.sale_id
  AND s.mapping_version = (SELECT mv FROM pack) AND NOT s.tombstone
  AND s.completed AND NOT s.voided
JOIN source_lightspeed.ls_shops sh ON sh.shop_id = s.shop_id
  AND sh.mapping_version = (SELECT mv FROM pack) AND NOT sh.tombstone
WHERE l.mapping_version = (SELECT mv FROM pack) AND NOT l.tombstone
  AND l.is_workorder = true
  AND s.complete_time AT TIME ZONE sh.time_zone >= date_trunc('month', now() AT TIME ZONE sh.time_zone) - interval '1 month'
GROUP BY 1
ORDER BY 1;
```

Disclose the reading: *"Counting items and labour rung up through workshop jobs."*
