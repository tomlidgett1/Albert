---
user_request: >
  Hours worked and wage cost week by week (the weekly labour trend, last week vs the week before).
recipe: true
presentation: table
date_parameter: workforce_analytics.shift_date
answer_hint: >
  Table of week starting, hours, wage cost, shifts; if the owner asked to compare last week with the week before, state both weeks' hours and the change (percent_change). Note the current week is partial.
matches:
  - "How did hours worked last week compare with the week before?"
  - "Hours worked by week for the last two months"
  - "Weekly wage cost trend"
  - "Are our hours going up or down week to week?"
---

```json
{
  "measures": [
    "workforce_analytics.hours_worked",
    "workforce_analytics.wage_cost",
    "workforce_analytics.worked_shift_count"
  ],
  "timeDimensions": [
    {
      "dimension": "workforce_analytics.shift_date",
      "granularity": "week",
      "dateRange": "last 8 weeks"
    }
  ],
  "order": {
    "workforce_analytics.shift_date": "asc"
  }
}
```
