---
user_request: >
  Wage cost (and hours) by month — the labour cost trend.
recipe: true
presentation: line
date_parameter: workforce_analytics.shift_date
answer_hint: >
  Line chart of wage cost by month; one sentence on the trend; note the current month is partial.
matches:
  - "How has our monthly wage cost tracked this year?"
  - "Chart the wage cost per month"
  - "Wages by month"
---

```json
{
  "measures": [
    "workforce_analytics.wage_cost",
    "workforce_analytics.hours_worked"
  ],
  "timeDimensions": [
    {
      "dimension": "workforce_analytics.shift_date",
      "granularity": "month",
      "dateRange": "this year"
    }
  ]
}
```
