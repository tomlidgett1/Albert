---
user_request: >
  Rostered (planned) hours, shifts and wage cost for a period - what will the roster cost.
recipe: true
presentation: fact
date_parameter: workforce_analytics.rostered_date
answer_hint: >
  One or two sentences: planned wage cost, rostered hours and shift count for the period; mention open (unassigned) shifts if any.
answer_template: >
  For {{period}}, the roster is **{{workforce_analytics.rostered_hours|number}} hours**
  across **{{workforce_analytics.rostered_shift_count|integer}} shifts**, at a planned wage cost of
  **{{workforce_analytics.rostered_cost|currency}}**.
  **{{workforce_analytics.open_shift_count|integer}}** shifts are still unassigned.
follow_ups:
  - "Are there any open shifts this week?"
  - "How many hours did staff work last week?"
  - "Who is on shift right now?"
matches:
  - "What will next week's roster cost us in wages?"
  - "How many hours are rostered next week?"
  - "Planned labour cost this week"
  - "How many shifts are rostered this week?"
  - "What is the rostered wage cost for this month?"
---

```json
{
  "measures": [
    "workforce_analytics.rostered_cost",
    "workforce_analytics.rostered_hours",
    "workforce_analytics.rostered_shift_count",
    "workforce_analytics.open_shift_count"
  ],
  "timeDimensions": [
    {
      "dimension": "workforce_analytics.rostered_date",
      "dateRange": "next week"
    }
  ]
}
```
