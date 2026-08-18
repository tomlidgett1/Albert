---
user_request: >
  Who is on leave in a period (approved leave, leave requests)?
recipe: true
presentation: list
date_parameter: workforce_analytics.leave_starts
answer_hint: >
  List approved leave (person, type, dates); mention pending requests separately; ignore declined/cancelled.
matches:
  - "Who's on leave this month?"
  - "Any leave coming up next month?"
  - "Who has leave booked?"
---

```json
{
  "measures": [
    "workforce_analytics.leave_days",
    "workforce_analytics.leave_hours"
  ],
  "dimensions": [
    "workforce_analytics.leave_staff",
    "workforce_analytics.leave_type",
    "workforce_analytics.leave_status",
    "workforce_analytics.leave_starts",
    "workforce_analytics.leave_ends"
  ],
  "timeDimensions": [
    {
      "dimension": "workforce_analytics.leave_starts",
      "dateRange": "this month"
    }
  ],
  "order": {
    "workforce_analytics.leave_starts": "asc"
  },
  "limit": 100
}
```
