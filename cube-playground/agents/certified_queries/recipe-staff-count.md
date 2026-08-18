---
user_request: >
  How many staff do we have (active vs on file)?
recipe: true
presentation: fact
answer_hint: >
  One sentence: active staff, and how many are on file in total.
matches:
  - "How many staff do we have?"
  - "How many employees are active?"
---

```json
{
  "measures": [
    "workforce_analytics.active_staff_count",
    "workforce_analytics.staff_count"
  ]
}
```
