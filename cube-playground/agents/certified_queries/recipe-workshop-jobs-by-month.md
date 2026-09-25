---
user_request: >
  Workshop jobs checked in per month (workshop volume trend).
recipe: true
presentation: line
date_parameter: workshop_analytics.checked_in_at
answer_hint: >
  Line chart of jobs per month (or the single figure if one month was asked); note the current month is partial. Do not report job statuses.
matches:
  - "How many workshop jobs have we taken in each month this year?"
  - "Workshop jobs per month"
  - "How many jobs came into the workshop last month?"
---

```json
{
  "measures": [
    "workshop_analytics.workorder_count"
  ],
  "timeDimensions": [
    {
      "dimension": "workshop_analytics.checked_in_at",
      "granularity": "month",
      "dateRange": "this year"
    }
  ]
}
```
