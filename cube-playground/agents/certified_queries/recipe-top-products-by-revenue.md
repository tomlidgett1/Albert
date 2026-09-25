---
user_request: >
  Products that brought in the most revenue for a period (top products by sales dollars).
recipe: true
presentation: table
date_parameter: product_sales_analytics.completed_at
answer_hint: >
  Name the top item first, then the table (item, revenue, units).
matches:
  - "Which product brought in the most revenue in July?"
  - "Top products by revenue this year"
  - "Highest earning products"
---

```json
{
  "measures": [
    "product_sales_analytics.line_revenue",
    "product_sales_analytics.units_sold"
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
    "product_sales_analytics.line_revenue": "desc"
  },
  "limit": 10
}
```
