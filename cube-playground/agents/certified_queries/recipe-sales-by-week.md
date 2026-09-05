---
user_request: >
  Weekly sales for the last N weeks (Monday-Sunday weeks).
recipe: true
presentation: line
date_parameter: sales_analytics.completed_at
answer_hint: >
  Line chart of weekly takings; one sentence on the peak week and the latest week.
matches:
  - "Show me weekly sales for the last 12 weeks"
  - "Sales by week this quarter"
  - "How did each week go over the last two months?"
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
      "granularity": "week",
      "dateRange": "last 12 weeks"
    }
  ]
}
```
