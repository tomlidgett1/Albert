---
user_request: >
  How much did Square charge me in processing fees by fee type over the last 30 days?
---

```json
{
  "measures": [
    "square_payments_analytics.square_payment_fees_processing_fees",
    "square_payments_analytics.square_payment_fees_fee_entries"
  ],
  "dimensions": [
    "square_payments_analytics.square_payment_fees_fee_type",
    "square_payments_analytics.square_payment_fees_currency"
  ],
  "timeDimensions": [{
    "dimension": "square_payments_analytics.square_payment_fees_effective_at",
    "dateRange": "last 30 days"
  }],
  "order": { "square_payments_analytics.square_payment_fees_processing_fees": "desc" }
}
```

This stays at processing-fee grain; compare the resulting total to a separate
completed-payment query when calculating an effective fee rate.
