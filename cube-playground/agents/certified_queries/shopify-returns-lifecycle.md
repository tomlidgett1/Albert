---
user_request: >
  Show the status and handling time of Shopify returns opened in the last 90 days.
---

```json
{
  "measures": [
    "shopify_returns_analytics.returns",
    "shopify_returns_analytics.open_returns",
    "shopify_returns_analytics.closed_returns",
    "shopify_returns_analytics.returned_quantity",
    "shopify_returns_analytics.exchange_line_items",
    "shopify_returns_analytics.average_hours_to_close_return",
    "shopify_returns_analytics.distinct_protected_subjects"
  ],
  "dimensions": ["shopify_returns_analytics.status"],
  "timeDimensions": [{
    "dimension": "shopify_returns_analytics.created_at",
    "granularity": "day",
    "dateRange": "last 90 days"
  }],
  "order": {"shopify_returns_analytics.returns": "desc"}
}
```
