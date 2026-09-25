---
user_request: >
  Hours worked (and wage cost) by day of the week over a period - which weekday costs the most labour.
recipe: true
presentation: bar
date_parameter: workforce_analytics.shift_date
answer_hint: >
  Name the weekday with the most hours / wage cost; bar chart Monday to Sunday (order by the weekday number).
matches:
  - "Which day of the week do staff work the most hours?"
  - "Hours worked by day of week"
  - "Which day costs us the most in wages?"
---

```json
{
  "measures": [
    "workforce_analytics.hours_worked",
    "workforce_analytics.wage_cost"
  ],
  "dimensions": [
    "workforce_analytics.shift_weekday",
    "workforce_analytics.shift_weekday_number"
  ],
  "timeDimensions": [
    {
      "dimension": "workforce_analytics.shift_date",
      "dateRange": "last 12 months"
    }
  ],
  "order": {
    "workforce_analytics.shift_weekday_number": "asc"
  }
}
```
