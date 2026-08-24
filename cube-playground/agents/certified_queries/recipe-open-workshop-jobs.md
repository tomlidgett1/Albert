---
user_request: >
  How many workshop / service jobs are open right now, and how many of those are overdue?
recipe: true
presentation: fact
answer_hint: >
  One sentence: open job count and how many of those are overdue.
answer_template: >
  There are **{{workshop_analytics.open_workorders|integer}} open workshop jobs**,
  of which **{{workshop_analytics.overdue_workorders|integer}}** are overdue.
follow_ups:
  - "Which workshop jobs are overdue?"
  - "How much did we sell last week?"
  - "How many customers do we have?"
matches:
  - "How many open workshop jobs do we have?"
  - "How many service jobs are open?"
  - "How many overdue workshop jobs are there?"
  - "Are there any overdue repairs?"
  - "How many jobs are in the workshop?"
---

Open and overdue job counts are current-state measures. Do not add a time grain.

```json
{
  "measures": [
    "workshop_analytics.open_workorders",
    "workshop_analytics.overdue_workorders"
  ]
}
```
