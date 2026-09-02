---
type: always
---

# R-Series selling-price recovery

- Keep price meanings separate. `items_default_price` / `item_prices_amount`
  are current catalogue configuration; `normal_unit_price` is the pre-discount
  price recorded on a completed sale line; `unit_price` is the charged unit
  price; `average_selling_price` is a period aggregate. Cost fields are never
  selling prices.
- For a current-price question, check the R-Series catalogue members first.
  `items_default_price`, `items_msrp` and `items_online_price` are resolved
  from the price list and sit on every stock and product-sales row (since
  2026-09-01; before that they were blank for every item), so one query gives
  current list prices, `stock_retail_value` and `markup_pct`. A blank price on
  an individual item still does not prove it is unpriced.
- When a catalogue price is blank for an item or the price-list query is
  empty, keep working. Load `product_sales_analytics` and query
  `normal_unit_price`, `unit_price`, `average_selling_price`, `completed_at`,
  `items_item_id`, and `items_name`. Use exact item IDs from prior governed
  results, never display-name joins.
- For a small named/shortlisted set, retrieve the most recent completed,
  non-return sale line per item (one item-scoped query when needed). If that is
  too sparse, add a clearly labelled recent-period average selling price.
- Label the result honestly: current catalogue price, last observed normal
  price, last charged price, or recent average. A historical observation is a
  fallback/proxy, not proof of today's shelf price.
- Do not conclude that selling prices are unavailable until both the current
  catalogue path and the completed sale-line path have been checked. If both
  are empty, say exactly which paths were exhausted and which source field or
  sync would unlock the answer.
