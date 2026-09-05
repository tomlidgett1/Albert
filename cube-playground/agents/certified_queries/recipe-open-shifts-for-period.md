---
user_request: >
  Open (unassigned / unfilled) rostered shifts in a period.
recipe: true
presentation: list
date_parameter: workforce_analytics.rostered_date
answer_hint: >
  If rows exist: how many open shifts, their dates/times/areas and total hours; if none, say there are no open shifts in that period.
answer_template: >
  There are **{{recipe.rows|integer}} open shifts** on the roster for {{period}}.
empty_answer: >
  There are no open shifts on the roster for {{period}}.
follow_ups:
  - "Who is rostered this week?"
  - "What will this week's roster cost?"
  - "Who is on shift right now?"
matches:
  - "Which shifts still need someone this week?"
  - "Which shifts are unassigned this week?"
  - "Show me the unfilled shifts next week"
  - "Which open shifts still need someone?"
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
