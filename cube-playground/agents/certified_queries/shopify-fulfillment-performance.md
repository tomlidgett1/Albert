---
user_request: >
  How is Shopify fulfillment performing by service over the last 90 days?
---

```json
{
  "measures": [
    "shopify_fulfillment_analytics.fulfillments",
    "shopify_fulfillment_analytics.delivered_fulfillments",
    "shopify_fulfillment_analytics.late_deliveries",
    "shopify_fulfillment_analytics.average_hours_to_deliver",
    "shopify_fulfillment_analytics.on_time_delivery_rate_pct",
    "shopify_fulfillment_analytics.distinct_protected_subjects"
  ],
  "dimensions": ["shopify_fulfillment_analytics.delivery_timeliness"],
  "timeDimensions": [{
    "dimension": "shopify_fulfillment_analytics.created_at",
    "granularity": "day",
    "dateRange": "last 90 days"
  }],
  "order": {"shopify_fulfillment_analytics.fulfillments": "desc"}
}
```
