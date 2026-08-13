---
user_request: >
  Which products make the most money? Top items by gross profit with units and
  margin.
---

```json
{
  "measures": [
    "product_sales_analytics.units_sold",
    "product_sales_analytics.line_revenue",
    "product_sales_analytics.line_gross_profit",
    "product_sales_analytics.line_gross_margin_pct"
  ],
  "dimensions": [
    "product_sales_analytics.items_name",
    "product_sales_analytics.manufacturers_name"
  ],
  "order": { "product_sales_analytics.line_gross_profit": "desc" },
  "limit": 20
}
```
