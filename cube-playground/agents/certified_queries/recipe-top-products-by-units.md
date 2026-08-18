---
user_request: >
  Best-selling products by units sold for a period (top 10 products, what sells most).
recipe: true
presentation: table
date_parameter: product_sales_analytics.completed_at
answer_hint: >
  Name the top item first, then the table (item, units, revenue). No commentary on unnamed lines unless it is the top row.
matches:
  - "What was our best-selling product last month by units?"
  - "Top 10 products last month"
  - "What sells most?"
  - "What do we sell most on Saturdays?"
---

```json
{
  "measures": [
    "product_sales_analytics.units_sold",
    "product_sales_analytics.line_revenue"
  ],
  "dimensions": [
    "product_sales_analytics.items_name"
  ],
  "filters": [
    {
      "member": "product_sales_analytics.items_name",
      "operator": "set"
    }
  ],
  "timeDimensions": [
    {
      "dimension": "product_sales_analytics.completed_at",
      "dateRange": "last month"
    }
  ],
  "order": {
    "product_sales_analytics.units_sold": "desc"
  },
  "limit": 10
}
```
