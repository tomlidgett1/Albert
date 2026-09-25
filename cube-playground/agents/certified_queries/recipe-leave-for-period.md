---
user_request: >
  Who is on leave (away) in a period - approved leave and pending requests, by person and day range?
recipe: true
presentation: list
date_parameter: workforce_analytics.leave_day
answer_hint: >
  Name who is away and on which dates (collapse consecutive days into a range per person); list approved leave first, mention 'Awaiting approval' requests separately, ignore declined/cancelled. If no rows, say nobody has leave in that period. A request that started before the period still counts if it covers days in it.
answer_template: >
  **{{recipe.rows|integer}} leave records** cover {{period}}.
empty_answer: >
  Nobody has leave covering {{period}}.
follow_ups:
  - "Who is rostered this week?"
  - "Who is on leave next week?"
  - "How many hours did staff work last week?"
matches:
  - "Who's on leave this month?"
  - "Any leave coming up next month?"
  - "Who has leave booked?"
  - "Who is away this week?"
  - "Is anyone on holiday next week?"
  - "Who's on leave today?"
---

```json
{
  "measures": [
    "workforce_analytics.leave_day_count"
  ],
  "dimensions": [
    "workforce_analytics.leave_day_staff",
    "workforce_analytics.leave_day_type",
    "workforce_analytics.leave_day_status",
    "workforce_analytics.leave_day_request_starts",
    "workforce_analytics.leave_day_request_ends"
  ],
  "timeDimensions": [
    {
      "dimension": "workforce_analytics.leave_day",
      "dateRange": "this month"
    }
  ],
  "filters": [
    {
      "member": "workforce_analytics.leave_day_status",
      "operator": "notEquals",
      "values": [
        "Declined",
        "Cancelled"
      ]
    }
  ],
  "order": {
    "workforce_analytics.leave_day_request_starts": "asc"
  },
  "limit": 200
}
```
