---
user_request: >
  Show my completed Square refunds by reason and store for the last 30 days.
---

```json
{
  "measures": [
    "square_refunds_analytics.refund_value",
    "square_refunds_analytics.completed_refunds",
    "square_refunds_analytics.unlinked_refunds"
  ],
  "dimensions": [
    "square_refunds_analytics.reason",
    "square_refunds_analytics.square_locations_name",
    "square_refunds_analytics.currency"
  ],
  "timeDimensions": [{
    "dimension": "square_refunds_analytics.completed_at",
    "dateRange": "last 30 days"
  }],
  "order": { "square_refunds_analytics.refund_value": "desc" },
  "limit": 25
}
```

PaymentRefund has no product-line allocation, so this query must not be used to
name the returned product or category.
