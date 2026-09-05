---
user_request: >
  What yoga classes and appointments are coming up, and how full are they?
---

```json
{
  "measures": [
    "momence_schedule_analytics.scheduled_occurrences",
    "momence_schedule_analytics.booked_places",
    "momence_schedule_analytics.capacity_places",
    "momence_schedule_analytics.available_places",
    "momence_schedule_analytics.waitlist_booking_count",
    "momence_schedule_analytics.capacity_utilization_pct"
  ],
  "dimensions": [
    "momence_schedule_analytics.activity_kind",
    "momence_schedule_analytics.activity_name",
    "momence_schedule_analytics.teacher_name",
    "momence_schedule_analytics.location_name"
  ],
  "timeDimensions": [{
    "dimension": "momence_schedule_analytics.starts_at",
    "dateRange": "next 30 days"
  }],
  "order": {"momence_schedule_analytics.starts_at": "asc"},
  "limit": 100
}
```

Booked-place utilization is reservation demand, not attendance or guaranteed
remaining bookability. Cancelled and draft activities are excluded by the measures.

