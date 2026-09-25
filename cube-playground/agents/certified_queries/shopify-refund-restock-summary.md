---
user_request: >
  Summarise Shopify refunds by restock treatment in the last 90 days.
---

```json
{
  "measures": [
    "shopify_refunds_analytics.refunded_units",
    "shopify_refunds_analytics.refund_total",
    "shopify_refunds_analytics.restocked_units",
    "shopify_refunds_analytics.distinct_protected_subjects"
  ],
  "dimensions": [
    "shopify_refunds_analytics.restock_type",
    "shopify_refunds_analytics.shopify_orders_currency_code"
  ],
  "timeDimensions": [{
    "dimension": "shopify_refunds_analytics.refunded_at",
    "granularity": "day",
    "dateRange": "last 90 days"
  }],
  "order": {"shopify_refunds_analytics.refund_total": "desc"},
  "limit": 20
}
```

Product/SKU labels and refund/order identities are unavailable on this
replayable surface. Every returned group represents at least five linked orders.
