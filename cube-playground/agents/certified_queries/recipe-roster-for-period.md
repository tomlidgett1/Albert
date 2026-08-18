---
user_request: >
  Who is rostered on today / tomorrow / this week / next week? The roster for a period.
recipe: true
presentation: list
date_parameter: workforce_analytics.rostered_date
answer_hint: >
  A table (person, start, end, hours) grouped by day for multi-day periods; a one-line answer for a single day. Never a chart.
matches:
  - "Who's rostered on today?"
  - "Who is working tomorrow?"
  - "What does next week's roster look like day by day?"
  - "Who's on this week?"
---

```json
{
  "measures": [
    "workforce_analytics.rostered_hours"
  ],
  "dimensions": [
    "workforce_analytics.rostered_staff",
    "workforce_analytics.roster_starts_at",
    "workforce_analytics.roster_ends_at",
    "workforce_analytics.rostered_area"
  ],
  "timeDimensions": [
    {
      "dimension": "workforce_analytics.rostered_date",
      "dateRange": "today"
    }
  ],
  "order": {
    "workforce_analytics.roster_starts_at": "asc"
  },
  "limit": 200
}
```
