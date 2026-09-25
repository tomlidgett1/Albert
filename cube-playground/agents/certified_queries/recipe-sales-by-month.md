---
user_request: >
  Show monthly sales for this year / the last 12 months / the last two years — a sales trend by month.
recipe: true
presentation: line
date_parameter: sales_analytics.completed_at
answer_hint: >
  Line chart of takings by month; one sentence on the trend and the best/worst month. Say if the last month is partial.
matches:
  - "Show me monthly sales for this year"
  - "Chart our monthly sales for the last two years"
  - "How are sales trending month by month?"
  - "Sales by month"
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
      "granularity": "month",
      "dateRange": "this year"
    }
  ]
}
```
