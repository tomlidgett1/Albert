---
user_request: >
  Timesheets waiting for approval - which worked shifts still need time approval.
recipe: true
presentation: table
answer_hint: >
  Say how many timesheets are unapproved and across how many people (count distinct names), then the table (person, shift date, start, end, hours). If none, say all timesheets are approved.
empty_answer: >
  every worked timesheet is already approved - nothing is waiting for approval
matches:
  - "Are there any timesheets waiting for approval?"
  - "How many timesheets need approving?"
  - "Which shifts haven't been approved yet?"
  - "Unapproved timesheets"
---

```json
{
  "measures": [
    "workforce_analytics.unapproved_shift_count",
    "workforce_analytics.hours_worked"
  ],
  "dimensions": [
    "workforce_analytics.worked_by",
    "workforce_analytics.shift_date",
    "workforce_analytics.started_at",
    "workforce_analytics.ended_at"
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
  ],
  "order": {
    "workforce_analytics.shift_date": "desc"
  },
  "limit": 200
}
```
