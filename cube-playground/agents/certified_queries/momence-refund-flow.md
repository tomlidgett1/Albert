---
user_request: >
  What refunds have gone out through Momence recently, by method and currency?
---

```json
{
  "measures": [
    "momence_refund_analytics.refund_events",
    "momence_refund_analytics.refunded_currency_amount",
    "momence_refund_analytics.refunded_money_credit_units",
    "momence_refund_analytics.refunded_event_credit_units",
    "momence_refund_analytics.average_currency_refund"
  ],
  "dimensions": [
    "momence_refund_analytics.payment_method",
    "momence_refund_analytics.currency_code",
    "momence_refund_analytics.purchase_type"
  ],
  "timeDimensions": [{
    "dimension": "momence_refund_analytics.refund_created_at",
    "dateRange": "last 90 days"
  }],
  "order": {"momence_refund_analytics.refunded_currency_amount": "desc"}
}
```

Refund date is the money/credit reversal date, not the original service date.
Detailed refund coverage is partial under Momence's transaction-list gap.
