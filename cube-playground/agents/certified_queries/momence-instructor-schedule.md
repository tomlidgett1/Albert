---
user_request: >
  Which instructors have the most upcoming yoga classes or appointments?
---

```json
{
  "measures": [
    "momence_instructor_analytics.instructors",
    "momence_instructor_analytics.upcoming_instructor_assignments",
    "momence_instructor_analytics.scheduled_session_instructor_assignments",
    "momence_instructor_analytics.scheduled_appointment_instructor_assignments"
  ],
  "dimensions": [
    "momence_instructor_analytics.instructor_name",
    "momence_instructor_analytics.upcoming_assignment_count",
    "momence_instructor_analytics.assigned_location_count"
  ],
  "order": {"momence_instructor_analytics.upcoming_assignment_count": "desc"},
  "limit": 50
}
```

These are service schedule assignments, not employment, worked hours or payroll.

