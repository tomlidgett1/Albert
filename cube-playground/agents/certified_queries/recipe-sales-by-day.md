---
user_request: >
  Daily sales for the last N days / a recent period.
recipe: true
presentation: line
date_parameter: sales_analytics.completed_at
answer_hint: >
  Line chart of daily takings; name the best day.
matches:
  - "Chart daily sales for the last 30 days"
  - "Show me sales per day this month"
  - "Daily takings last fortnight"
---

```json
{
  "measures": [
    "sales_analytics.gross_takings",
    "sales_analytics.transactions"
  ],
  "timeDimensions": [
    {
      "dimension": "sales_analytics.completed_at",
      "granularity": "day",
      "dateRange": "last 30 days"
    }
  ]
}
```
