---
user_request: >
  Hours worked and wage cost by staff member for a period (who worked the most).
recipe: true
presentation: table
date_parameter: workforce_analytics.shift_date
answer_hint: >
  Name the top person first if 'most' was asked, then the table (person, hours, wage cost).
matches:
  - "Who worked the most hours last month?"
  - "How many hours did each staff member work last month?"
  - "Hours by staff this year"
---

```json
{
  "measures": [
    "workforce_analytics.hours_worked",
    "workforce_analytics.wage_cost",
    "workforce_analytics.worked_shift_count"
  ],
  "dimensions": [
    "workforce_analytics.staff_name"
  ],
  "timeDimensions": [
    {
      "dimension": "workforce_analytics.shift_date",
      "dateRange": "last month"
    }
  ],
  "order": {
    "workforce_analytics.hours_worked": "desc"
  },
  "limit": 50
}
```
