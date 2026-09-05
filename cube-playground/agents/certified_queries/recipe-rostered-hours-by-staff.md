---
user_request: >
  Rostered hours (and planned cost) by staff member for a period - who is scheduled for how many hours.
recipe: true
presentation: table
date_parameter: workforce_analytics.rostered_date
answer_hint: >
  Name the person with the most rostered hours, then the table (person, rostered hours, shifts, planned cost); mention unassigned open shifts if present (blank staff).
matches:
  - "How many hours is each person rostered for next week?"
  - "Who is rostered the most this week?"
  - "Rostered hours by staff member this month"
  - "How many shifts does Leigh have next week?"
---

```json
{
  "measures": [
    "workforce_analytics.rostered_hours",
    "workforce_analytics.rostered_shift_count",
    "workforce_analytics.rostered_cost"
  ],
  "dimensions": [
    "workforce_analytics.rostered_staff"
  ],
  "timeDimensions": [
    {
      "dimension": "workforce_analytics.rostered_date",
      "dateRange": "next week"
    }
  ],
  "order": {
    "workforce_analytics.rostered_hours": "desc"
  },
  "limit": 50
}
```
