---
user_request: >
  What is my Square payment mix for the last 30 days, including tips and failures?
---

```json
{
  "measures": [
    "square_payments_analytics.collected_amount",
    "square_payments_analytics.completed_payments",
    "square_payments_analytics.payment_tips",
    "square_payments_analytics.failed_payments",
    "square_payments_analytics.average_payment"
  ],
  "dimensions": [
    "square_payments_analytics.source_type",
    "square_payments_analytics.currency"
  ],
  "timeDimensions": [{
    "dimension": "square_payments_analytics.created_at",
    "dateRange": "last 30 days"
  }],
  "order": { "square_payments_analytics.collected_amount": "desc" }
}
```

Collected amount includes only completed Payment objects and includes payment tips.
