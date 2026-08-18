---
user_request: >
  Sales rung up by each staff member for a period (who sold the most).
recipe: true
presentation: table
date_parameter: sales_analytics.completed_at
answer_hint: >
  Name the top seller first, then the table.
matches:
  - "Which staff member rang up the most sales last month?"
  - "Sales by staff this year"
  - "Who sold the most?"
---

```json
{
  "measures": [
    "sales_analytics.gross_takings",
    "sales_analytics.transactions",
    "sales_analytics.average_sale_value"
  ],
  "dimensions": [
    "sales_analytics.employees_full_name"
  ],
  "timeDimensions": [
    {
      "dimension": "sales_analytics.completed_at",
      "dateRange": "last month"
    }
  ],
  "order": {
    "sales_analytics.gross_takings": "desc"
  },
  "limit": 15
}
```
