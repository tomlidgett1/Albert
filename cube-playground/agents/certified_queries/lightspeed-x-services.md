---
user_request: >
  What X-Series service orders are scheduled and how much work time is booked?
---

```json
{
  "measures": [
    "lightspeed_x_services_analytics.service_orders",
    "lightspeed_x_services_analytics.scheduled_service_minutes",
    "lightspeed_x_services_analytics.average_scheduled_minutes"
  ],
  "dimensions": [
    "lightspeed_x_services_analytics.service_status_name",
    "lightspeed_x_services_analytics.location",
    "lightspeed_x_services_analytics.lightspeed_x_users_display_name"
  ],
  "timeDimensions": [{
    "dimension": "lightspeed_x_services_analytics.scheduled_for",
    "dateRange": "next 30 days"
  }]
}
```

Service-order totals are reference values already represented by the linked
sale and must not be added to revenue.

