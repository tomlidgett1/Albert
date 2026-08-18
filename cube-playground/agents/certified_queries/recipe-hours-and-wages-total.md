---
user_request: >
  Total hours worked and wage cost for a period (what did wages cost, how many hours did staff work).
recipe: true
presentation: fact
date_parameter: workforce_analytics.shift_date
answer_hint: >
  One or two sentences with the figure asked for (hours, wage cost, shifts or average shift length).
matches:
  - "How many hours did staff work last week?"
  - "What did wages cost last month?"
  - "How many shifts were worked in July?"
  - "Average shift length last month"
---

```json
{
  "measures": [
    "workforce_analytics.hours_worked",
    "workforce_analytics.wage_cost",
    "workforce_analytics.worked_shift_count",
    "workforce_analytics.avg_shift_hours"
  ],
  "timeDimensions": [
    {
      "dimension": "workforce_analytics.shift_date",
      "dateRange": "last week"
    }
  ]
}
```
