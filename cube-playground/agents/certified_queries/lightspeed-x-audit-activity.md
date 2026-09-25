---
user_request: >
  Summarise X-Series audit activity by action and actor over the last 30 days.
---

```json
{
  "measures": [
    "lightspeed_x_audit_analytics.audit_events",
    "lightspeed_x_audit_analytics.affected_entities",
    "lightspeed_x_audit_analytics.acting_users"
  ],
  "dimensions": [
    "lightspeed_x_audit_analytics.entity_type",
    "lightspeed_x_audit_analytics.action",
    "lightspeed_x_audit_analytics.lightspeed_x_users_display_name"
  ],
  "timeDimensions": [{
    "dimension": "lightspeed_x_audit_analytics.occurred_at",
    "dateRange": "last 30 days"
  }]
}
```

Changed values, prior values, IP addresses and user agents remain private.

