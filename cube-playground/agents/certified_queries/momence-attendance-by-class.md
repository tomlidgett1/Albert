---
user_request: >
  Which classes or appointments had the strongest attendance in the last 90 days?
---

```json
{
  "measures": [
    "momence_attendance_analytics.eligible_past_reservations",
    "momence_attendance_analytics.checked_in_past_reservations",
    "momence_attendance_analytics.reservation_attendance_rate_pct",
    "momence_attendance_analytics.no_show_proxy_reservations",
    "momence_attendance_analytics.cancelled_reservations"
  ],
  "dimensions": [
    "momence_attendance_analytics.activity_kind",
    "momence_attendance_analytics.activity_name",
    "momence_attendance_analytics.teacher_name",
    "momence_attendance_analytics.location_name"
  ],
  "timeDimensions": [{
    "dimension": "momence_attendance_analytics.starts_at",
    "dateRange": "last 90 days"
  }],
  "order": {"momence_attendance_analytics.reservation_attendance_rate_pct": "desc"},
  "limit": 50
}
```

The rate is reservation-record weighted. No-show is an ended, non-cancelled,
unchecked proxy because Momence does not expose a session no-show flag.

