---
user_request: >
  How many staff do we have (active vs on file)?
recipe: true
presentation: fact
answer_hint: >
  One sentence: active staff, and how many are on file in total.
answer_template: >
  There are **{{workforce_analytics.active_staff_count|integer}} active staff** on the books,
  and **{{workforce_analytics.staff_count|integer}}** people on file in total.
follow_ups:
  - "Who is on shift right now?"
  - "How many hours did staff work last week?"
  - "Who is on leave this week?"
matches:
  - "How many staff do we have?"
  - "How many employees are active?"
  - "How many employees do we have?"
  - "What's our headcount?"
---

```json
{
  "measures": [
    "workforce_analytics.active_staff_count",
    "workforce_analytics.staff_count"
  ]
}
```
