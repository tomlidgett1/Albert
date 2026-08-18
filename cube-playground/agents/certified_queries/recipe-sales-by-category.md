---
user_request: >
  Sales by product category for a period (top categories, category mix, share of revenue by category).
recipe: true
presentation: bar
date_parameter: product_sales_analytics.completed_at
answer_hint: >
  Bar chart of revenue by category (limit to the top N the owner asked for); one sentence naming the leader and its share. Use compose_table with percent_of when a share is asked.
matches:
  - "What were our top 5 selling categories this year?"
  - "Sales by category this year"
  - "Which categories sell the most?"
  - "Show sales by category as a chart"
---

```json
{
  "measures": [
    "product_sales_analytics.line_revenue",
    "product_sales_analytics.units_sold"
  ],
  "dimensions": [
    "product_sales_analytics.categories_name"
  ],
  "filters": [
    {
      "member": "product_sales_analytics.categories_name",
      "operator": "set"
    }
  ],
  "timeDimensions": [
    {
      "dimension": "product_sales_analytics.completed_at",
      "dateRange": "this year"
    }
  ],
  "order": {
    "product_sales_analytics.line_revenue": "desc"
  },
  "limit": 15
}
```
