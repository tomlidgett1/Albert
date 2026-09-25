---
user_request: >
  How many open (unassigned) rostered shifts are there in a period, and how many hours is that?
recipe: true
presentation: fact
date_parameter: workforce_analytics.rostered_date
answer_hint: >
  One sentence: open shift count and hours for the period. If the owner asks which shifts, use the list recipe.
answer_template: >
  For {{period}}, there are **{{workforce_analytics.open_shift_count|integer}} unassigned shifts**
  totalling **{{workforce_analytics.rostered_hours|number}} hours**.
follow_ups:
  - "Which shifts still need someone?"
  - "What will next week's roster cost us in wages?"
  - "Who is on shift right now?"
matches:
  - "Are there any open shifts this week?"
  - "How many open shifts do we have this week?"
  - "Any unfilled shifts next week?"
  - "How many unassigned shifts this week?"
---

```json
{
  "measures": [
    "workforce_analytics.open_shift_count",
    "workforce_analytics.rostered_hours"
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
  ]
}
```
