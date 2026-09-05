---
user_request: >
  Who are my most engaged Momence members and who has never visited?
---

```json
{
  "measures": [
    "momence_member_analytics.member_count",
    "momence_member_analytics.observed_visits",
    "momence_member_analytics.observed_session_visits",
    "momence_member_analytics.observed_appointment_visits"
  ],
  "dimensions": [
    "momence_member_analytics.full_name",
    "momence_member_analytics.engagement_band",
    "momence_member_analytics.last_seen",
    "momence_member_analytics.observed_visit_count"
  ],
  "order": {"momence_member_analytics.observed_visit_count": "desc"},
  "limit": 100
}
```

Visit fields are current lifetime-style source counters and can be bounded by
available API history. Last seen is not a cancellation or churn date.

