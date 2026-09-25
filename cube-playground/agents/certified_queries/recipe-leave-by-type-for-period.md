---
user_request: >
  How much leave was taken by type in a period (sick leave days, annual leave days, leave by person)?
recipe: true
presentation: table
answer_hint: >
  Answer the type asked (e.g. sick leave): approved leave days and person-days; if that type has no rows say zero were recorded. Table: leave type, staff member, approved days, person-days. Declined/cancelled requests are excluded.
empty_answer: >
  no approved leave of any type was recorded in that period, so the answer for the type asked is zero
matches:
  - "How many sick days have been taken this year?"
  - "How much annual leave has been taken this financial year?"
  - "Leave taken by type this year"
  - "Who has taken the most leave this year?"
  - "How many days of leave did Jack take last month?"
---

```json
{
  "measures": [
    "workforce_analytics.approved_leave_days_taken",
    "workforce_analytics.approved_leave_day_count",
    "workforce_analytics.approved_leave_hours_taken"
  ],
  "dimensions": [
    "workforce_analytics.leave_day_type",
    "workforce_analytics.leave_day_staff"
  ],
  "timeDimensions": [
    {
      "dimension": "workforce_analytics.leave_day",
      "dateRange": "this year"
    }
  ],
  "filters": [
    {
      "member": "workforce_analytics.leave_day_status",
      "operator": "equals",
      "values": [
        "Approved"
      ]
    }
  ],
  "order": {
    "workforce_analytics.approved_leave_days_taken": "desc"
  },
  "limit": 100
}
```
