---
user_request: >
  Rostered hours by day of the week over a period - which weekday we roster the most.
recipe: true
presentation: bar
date_parameter: workforce_analytics.rostered_date
answer_hint: >
  Name the busiest and quietest weekday by rostered hours; bar chart Monday to Sunday (order by the weekday number).
matches:
  - "Which day of the week do we roster the most hours?"
  - "Rostered hours by day of week"
  - "What's our busiest day for staffing?"
---

```json
{
  "measures": [
    "workforce_analytics.rostered_hours",
    "workforce_analytics.rostered_shift_count"
  ],
  "dimensions": [
    "workforce_analytics.rostered_weekday",
    "workforce_analytics.rostered_weekday_number"
  ],
  "timeDimensions": [
    {
      "dimension": "workforce_analytics.rostered_date",
      "dateRange": "last 12 months"
    }
  ],
  "order": {
    "workforce_analytics.rostered_weekday_number": "asc"
  }
}
```
