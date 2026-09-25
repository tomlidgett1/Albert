---
user_request: >
  Which Square cash drawers were over or short during the last 30 days?
---

```json
{
  "measures": [
    "square_cash_management_analytics.expected_cash",
    "square_cash_management_analytics.counted_cash",
    "square_cash_management_analytics.cash_variance",
    "square_cash_management_analytics.closed_drawer_shifts"
  ],
  "dimensions": [
    "square_cash_management_analytics.square_locations_name",
    "square_cash_management_analytics.device_name",
    "square_cash_management_analytics.currency"
  ],
  "timeDimensions": [{
    "dimension": "square_cash_management_analytics.closed_at",
    "granularity": "day",
    "dateRange": "last 30 days"
  }],
  "order": { "square_cash_management_analytics.cash_variance": "asc" }
}
```

Variance is counted minus expected cash on closed shifts. Negative is short;
positive is over.
