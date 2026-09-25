---
user_request: >
  What is my Shopify payment gateway mix and success rate this month?
---

```json
{
  "measures": [
    "shopify_payments_analytics.transaction_count",
    "shopify_payments_analytics.captured_amount",
    "shopify_payments_analytics.payment_success_rate_pct",
    "shopify_payments_analytics.distinct_protected_subjects"
  ],
  "dimensions": [
    "shopify_payments_analytics.gateway",
    "shopify_payments_analytics.currency_code"
  ],
  "timeDimensions": [{
    "dimension": "shopify_payments_analytics.processed_at",
    "granularity": "day",
    "dateRange": "this month"
  }],
  "order": {"shopify_payments_analytics.captured_amount": "desc"}
}
```
