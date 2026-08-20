---
user_request: >
  Open (unassigned / unfilled) rostered shifts in a period.
recipe: true
presentation: list
date_parameter: workforce_analytics.rostered_date
answer_hint: >
  If rows exist: how many open shifts, their dates/times/areas and total hours; if none, say there are no open shifts in that period.
empty_answer: >
  there are no open (unassigned) shifts on the roster for that period - every rostered shift has someone assigned
matches:
  - "Are there any open shifts this week?"
  - "Any unfilled shifts next week?"
  - "Which shifts still need someone?"
  - "Do we have any unassigned shifts?"
---

```json
{
  "measures": [
    "workforce_analytics.open_shift_count",
    "workforce_analytics.rostered_hours"
  ],
  "dimensions": [
    "workforce_analytics.rostered_date",
    "workforce_analytics.roster_starts_at",
    "workforce_analytics.roster_ends_at",
    "workforce_analytics.rostered_area"
  ],
  "timeDimensions": [
    {
      "dimension": "workforce_analytics.rostered_date",
      "dateRange": "this week"
    }
  ],
  "filters": [
    {
      "member": "workforce_analytics.roster_open_shift",
      "operator": "equals",
      "values": [
        "true"
      ]
    }
  ],
  "order": {
    "workforce_analytics.roster_starts_at": "asc"
  },
  "limit": 200
}
```
