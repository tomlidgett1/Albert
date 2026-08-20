---
user_request: >
  Who is on shift right now (today's roster with each shift's timing: on now, finished, upcoming)?
recipe: true
presentation: list
answer_hint: >
  Lead with the people whose shift timing is 'On now' (name, area, shift end); then say who is still to come today ('Upcoming') and who has finished. If nobody is 'On now', say no one is rostered on at the moment and name the next shift today. Never a chart.
empty_answer: >
  nobody is rostered today at all, so no one is on shift right now
matches:
  - "Who's on shift right now?"
  - "Who is working right now?"
  - "Is anyone on at the moment?"
  - "Who's in the shop now?"
  - "Who is on the floor right now?"
---

```json
{
  "measures": [
    "workforce_analytics.rostered_hours"
  ],
  "dimensions": [
    "workforce_analytics.rostered_staff",
    "workforce_analytics.roster_shift_timing",
    "workforce_analytics.roster_starts_at",
    "workforce_analytics.roster_ends_at",
    "workforce_analytics.rostered_area"
  ],
  "timeDimensions": [
    {
      "dimension": "workforce_analytics.rostered_date",
      "dateRange": "today"
    }
  ],
  "order": {
    "workforce_analytics.roster_starts_at": "asc"
  },
  "limit": 100
}
```
