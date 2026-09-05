---
user_request: >
  How are my Square stores trading day by day over the last 30 days?
---

```json
{
  "measures": [
    "square_sales_analytics.net_order_value",
    "square_sales_analytics.completed_orders",
    "square_sales_analytics.average_completed_order_value",
    "square_sales_analytics.returns_value",
    "square_sales_analytics.tips_collected"
  ],
  "dimensions": [
    "square_sales_analytics.square_locations_name",
    "square_sales_analytics.currency"
  ],
  "timeDimensions": [{
    "dimension": "square_sales_analytics.closed_at",
    "granularity": "day",
    "dateRange": "last 30 days"
  }],
  "order": { "square_sales_analytics.closed_at": "asc" }
}
```

Net order value is tax-inclusive, includes tips/service charges and subtracts
Square order returns. Only completed orders contribute.
