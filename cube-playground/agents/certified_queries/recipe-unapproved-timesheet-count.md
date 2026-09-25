---
user_request: >
  How many worked timesheets are waiting for approval, and how many hours is that?
recipe: true
presentation: fact
answer_hint: >
  One sentence: unapproved shift count and hours. If the owner asks which people or which shifts, use the list recipe.
answer_template: >
  **{{workforce_analytics.unapproved_shift_count|integer}}** worked shifts are waiting for
  time approval, totalling **{{workforce_analytics.hours_worked|number}} hours**.
follow_ups:
  - "Which shifts haven't been approved yet?"
  - "How many hours did staff work last week?"
  - "What will next week's roster cost us in wages?"
matches:
  - "How many timesheets need approving?"
  - "Are there any timesheets waiting for approval?"
  - "How many unapproved timesheets do we have?"
  - "Unapproved timesheet count"
---

Current-state count of finished, non-leave worked shifts that are not yet time-approved.

```json
{
  "measures": [
    "workforce_analytics.unapproved_shift_count",
    "workforce_analytics.hours_worked"
  ],
  "filters": [
    {
      "member": "workforce_analytics.time_approved",
      "operator": "equals",
      "values": [
        "false"
      ]
    },
    {
      "member": "workforce_analytics.in_progress",
      "operator": "equals",
      "values": [
        "false"
      ]
    },
    {
      "member": "workforce_analytics.is_leave",
      "operator": "equals",
      "values": [
        "false"
      ]
    }
  ]
}
```
